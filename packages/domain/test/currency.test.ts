import { describe, expect, it } from "vitest";
import { formatMoney, normalizeAmount, parseQuoteText, resolveCurrency } from "@mercury/domain";

describe("parseQuoteText (§3.5, §23.1)", () => {
  it("parses bare amount with no currency", () => {
    const p = parseQuoteText("220");
    expect(p).toMatchObject({ amount: "220.00", currencyMention: "ABSENT" });
  });

  it("parses 220全包 as all-in with no currency", () => {
    const p = parseQuoteText("220全包");
    expect(p).toMatchObject({ amount: "220.00", currencyMention: "ABSENT", isAllIn: true });
  });

  it("parses explicit USD forms", () => {
    expect(parseQuoteText("USD 220")).toMatchObject({ amount: "220.00", currency: "USD", currencyMention: "EXPLICIT" });
    expect(parseQuoteText("US$220")).toMatchObject({ amount: "220.00", currency: "USD", currencyMention: "EXPLICIT" });
    expect(parseQuoteText("usd220")).toMatchObject({ amount: "220.00", currency: "USD", currencyMention: "EXPLICIT" });
    expect(parseQuoteText("美金220")).toMatchObject({ amount: "220.00", currency: "USD", currencyMention: "EXPLICIT" });
  });

  it("parses explicit SGD forms", () => {
    expect(parseQuoteText("SGD 220")).toMatchObject({ amount: "220.00", currency: "SGD", currencyMention: "EXPLICIT" });
    expect(parseQuoteText("S$220")).toMatchObject({ amount: "220.00", currency: "SGD", currencyMention: "EXPLICIT" });
    expect(parseQuoteText("新币220")).toMatchObject({ amount: "220.00", currency: "SGD", currencyMention: "EXPLICIT" });
  });

  it("flags bare $ as AMBIGUOUS — never inferred (§3.5)", () => {
    const p = parseQuoteText("$220");
    expect(p).toMatchObject({ amount: "220.00", currencyMention: "AMBIGUOUS" });
    expect(p!.currency).toBeNull();
  });

  it("handles decimals and thousands separators", () => {
    expect(parseQuoteText("USD 1,250.50")).toMatchObject({ amount: "1250.50", currency: "USD" });
    expect(parseQuoteText("220.5")).toMatchObject({ amount: "220.50" });
  });

  it("returns null when no amount is present", () => {
    expect(parseQuoteText("好的")).toBeNull();
    expect(parseQuoteText("无法承运")).toBeNull();
  });

  it("captures surrounding terms text", () => {
    const p = parseQuoteText("220全包，含GST，两小时免费等候");
    expect(p!.isAllIn).toBe(true);
    expect(p!.terms).toContain("GST");
  });
});

describe("normalizeAmount", () => {
  it("normalizes to 2dp strings", () => {
    expect(normalizeAmount("220")).toBe("220.00");
    expect(normalizeAmount("1,250.5")).toBe("1250.50");
  });
  it("rejects more than 2 decimal places and garbage", () => {
    expect(normalizeAmount("220.505")).toBeNull();
    expect(normalizeAmount("abc")).toBeNull();
    expect(normalizeAmount("-5")).toBeNull();
    expect(normalizeAmount("0")).toBeNull();
  });
});

describe("resolveCurrency (§3.5 defaulting)", () => {
  it("defaults absent currency to USD with DEFAULTED source", () => {
    const p = parseQuoteText("220全包")!;
    expect(resolveCurrency(p)).toEqual({ currency: "USD", source: "DEFAULTED" });
  });
  it("keeps explicit currency with EXPLICIT source", () => {
    const p = parseQuoteText("S$220")!;
    expect(resolveCurrency(p)).toEqual({ currency: "SGD", source: "EXPLICIT" });
  });
  it("returns null for ambiguous $ (must ask)", () => {
    const p = parseQuoteText("$220")!;
    expect(resolveCurrency(p)).toBeNull();
  });
});

describe("formatMoney (§3.5 display)", () => {
  it("formats as CODE amount with 2dp", () => {
    expect(formatMoney("USD", "220")).toBe("USD 220.00");
    expect(formatMoney("SGD", "1250.5")).toBe("SGD 1,250.50");
  });
});
