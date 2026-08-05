import { describe, expect, it } from "vitest";
import { interpretWithRules } from "@mercury/ai";
import { FleetIntentProposal } from "@mercury/contracts";
import type { InterpreterContext } from "@mercury/ai";

const ctx: InterpreterContext = {
  fleetOrganizationId: "org-1",
  rfqRecipientId: "rr-1",
  rfqRevision: 1,
  orderVersion: 1,
  bookingId: null,
  shipmentId: null,
  shipmentStatus: null,
  hasActiveBooking: false,
  rfqSummary: "RFQ-1001 PSA → Jurong",
};

const interpret = (text: string, c: Partial<InterpreterContext> = {}) =>
  Promise.resolve(interpretWithRules(text, { ...ctx, ...c }));

/** Every proposal must validate against the shared schema (§10.3). */
async function validated(text: string, c: Partial<InterpreterContext> = {}) {
  const p = await interpret(text, c);
  expect(() => FleetIntentProposal.parse(p)).not.toThrow();
  return p;
}

describe("agent contract fixtures (§23.3)", () => {
  it("`220` → quote draft, no currency", async () => {
    const p = await validated("220");
    expect(p.intent).toBe("SUBMIT_QUOTE_DRAFT");
    if (p.intent === "SUBMIT_QUOTE_DRAFT") {
      expect(p.quote.amount).toBe("220.00");
      expect(p.quote.currencyMention).toBe("ABSENT");
    }
  });

  it("`220全包` → all-in quote draft", async () => {
    const p = await validated("220全包");
    if (p.intent === "SUBMIT_QUOTE_DRAFT") {
      expect(p.quote.isAllIn).toBe(true);
      expect(p.quote.currencyMention).toBe("ABSENT");
    } else expect.fail("expected SUBMIT_QUOTE_DRAFT");
  });

  it("`USD 220` / `S$220` → explicit currency", async () => {
    const p1 = await validated("USD 220");
    const p2 = await validated("S$220");
    if (p1.intent === "SUBMIT_QUOTE_DRAFT") expect(p1.quote.currency).toBe("USD");
    if (p2.intent === "SUBMIT_QUOTE_DRAFT") expect(p2.quote.currency).toBe("SGD");
  });

  it("`$220` → ambiguous currency with clarification question (§3.5)", async () => {
    const p = await validated("$220");
    if (p.intent === "SUBMIT_QUOTE_DRAFT") {
      expect(p.quote.currencyMention).toBe("AMBIGUOUS");
      expect(p.quote.currency).toBeNull();
      expect(p.clarificationQuestion).toContain("USD");
      expect(p.clarificationQuestion).toContain("SGD");
    } else expect.fail("expected SUBMIT_QUOTE_DRAFT");
  });

  it("`价格不变` → PRICE_UNCHANGED marker, no amount", async () => {
    const p = await validated("价格不变");
    if (p.intent === "SUBMIT_QUOTE_DRAFT") {
      expect(p.quote.terms).toBe("PRICE_UNCHANGED");
      expect(p.quote.amount).toBeNull();
    } else expect.fail("expected SUBMIT_QUOTE_DRAFT");
  });

  it("declines: 不能做 / 做不了 / 无法承运", async () => {
    for (const t of ["不能做", "做不了", "无法承运", "这个我们跑不了"]) {
      const p = await validated(t);
      expect(p.intent).toBe("DECLINE_RFQ");
    }
  });

  it("`稍后回复` → ACK_REPLY_LATER", async () => {
    const p = await validated("稍后回复");
    expect(p.intent).toBe("ACK_REPLY_LATER");
  });

  it("`转人工` → REQUEST_HUMAN", async () => {
    for (const t of ["转人工", "找运营", "人工客服"]) {
      const p = await validated(t);
      expect(p.intent).toBe("REQUEST_HUMAN");
    }
  });

  it("`司机陈师傅，车牌 SGB1234A` → ASSIGN_RESOURCES with extraction", async () => {
    const p = await validated("司机陈师傅，车牌 SGB1234A", { hasActiveBooking: true, bookingId: "b-1" });
    expect(p.intent).toBe("ASSIGN_RESOURCES");
    if (p.intent === "ASSIGN_RESOURCES") {
      expect(p.extracted.driverName).toBe("陈师傅");
      expect(p.extracted.plateNumber).toBe("SGB1234A");
    }
  });

  it("shipment phrases map to statuses (§11.11)", async () => {
    const cases: Array<[string, string]> = [
      ["全部空箱已提取", "EMPTY_CONTAINER_PICKED_UP"],
      ["已到装货工厂", "AT_LOADING_LOCATION"],
      ["装货完成", "LOADED"],
      ["前往码头", "EN_ROUTE_TO_TERMINAL"],
      ["全部重箱已还码头", "LADEN_CONTAINERS_RETURNED_TO_TERMINAL"],
      ["全部重箱已提取", "CONTAINER_PICKED_UP"],
      ["前往送货地点", "IN_TRANSIT_TO_DELIVERY"],
      ["送到了", "DELIVERED"],
      ["等待归还空箱", "EMPTY_RETURN_PENDING"],
      ["全部空箱已还", "EMPTY_RETURNED"],
    ];
    for (const [text, status] of cases) {
      const p = await validated(text, { hasActiveBooking: true, shipmentId: "s-1", shipmentStatus: "WAITING_PORT_RELEASE" });
      expect(p.intent, text).toBe("UPDATE_SHIPMENT_STATUS");
      if (p.intent === "UPDATE_SHIPMENT_STATUS") expect(p.extracted.toStatus, text).toBe(status);
    }
  });

  it("gibberish → UNKNOWN with a clarification question", async () => {
    const p = await validated("asdfgh qwerty");
    expect(p.intent).toBe("UNKNOWN");
    if (p.intent === "UNKNOWN") expect(p.clarificationQuestion).toBeTruthy();
  });

  it("all outputs conform to the FleetIntentProposal schema", async () => {
    for (const t of ["220", "价格不变", "不能做", "转人工", "全部重箱已提取", "???"]) {
      const p = await interpret(t);
      expect(() => FleetIntentProposal.parse(p)).not.toThrow();
    }
  });
});
