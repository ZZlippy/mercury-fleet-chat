import { beforeAll, describe, expect, it } from "vitest";
import {
  consumeMessageAction, handleInbound, recordInbound, sendRfqToFleet,
} from "@mercury/application";
import { cid, findActions, lastOutbound, setupFixtures, type Fixtures } from "./helpers.ts";

let f: Fixtures;

async function say(actor: Fixtures["dispatcherA"], conv: string, text: string) {
  const rec = await recordInbound(f.db, actor, { conversationId: conv, clientMessageId: cid(), text, replyToMessageId: null });
  const handled = await handleInbound(f.db, actor, { conversationId: conv, messageId: rec.messageId });
  return { ...rec, handled };
}

describe("cross-fleet isolation (§17, §23.2)", () => {
  beforeAll(async () => {
    f = await setupFixtures();
    const r = await sendRfqToFleet(f.db, f.operator, { orderId: f.orderId, fleetOrganizationId: f.fleetA }, cid());
    expect(r.ok).toBe(true);
  });

  it("Fleet B cannot consume Fleet A's action", async () => {
    const [action] = await findActions(f.db, f.convA, "MODIFY_QUOTE");
    const res = await consumeMessageAction(f.db, f.dispatcherB, { actionId: action.id, clientIdempotencyKey: cid() });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("FORBIDDEN");
    const a = (await f.db.query(`SELECT status FROM message_actions WHERE id=$1`, [action.id])).rows[0];
    expect(a.status).toBe("AVAILABLE"); // untouched
  });

  it("Fleet B's quote text does not attach to Fleet A's RFQ", async () => {
    await say(f.dispatcherB, f.convB, "300全包");
    const quotes = await f.db.query(`SELECT count(*)::int AS n FROM quotes`);
    expect(quotes.rows[0].n).toBe(0); // B has no RFQ — nothing to quote
    const [reply] = await lastOutbound(f.db, f.convB);
    expect(reply.text_content).toContain("没有进行中的询价");
  });

  it("Fleet B cannot post into Fleet A's conversation", async () => {
    const before = (await f.db.query(`SELECT count(*)::int AS n FROM messages WHERE conversation_id=$1`, [f.convA])).rows[0].n;
    await expect(
      recordInbound(f.db, f.dispatcherB, { conversationId: f.convA, clientMessageId: cid(), text: "hi" }),
    ).rejects.toMatchObject({ failure: { code: "FORBIDDEN" } });
    const after = (await f.db.query(`SELECT count(*)::int AS n FROM messages WHERE conversation_id=$1`, [f.convA])).rows[0].n;
    expect(after).toBe(before); // nothing persisted into the foreign conversation
  });

  it("Fleet B cannot dispatch a Fleet A message id", async () => {
    const rec = await recordInbound(f.db, f.dispatcherA, { conversationId: f.convA, clientMessageId: cid(), text: "test" });
    const res = await handleInbound(f.db, f.dispatcherB, { conversationId: f.convA, messageId: rec.messageId });
    expect(res).toMatchObject({ ok: false, code: "FORBIDDEN" });
  });
});

describe("inbound dedupe and idempotency (§9.2)", () => {
  beforeAll(async () => {
    f = await setupFixtures();
    await sendRfqToFleet(f.db, f.operator, { orderId: f.orderId, fleetOrganizationId: f.fleetA }, cid());
  });

  it("same clientMessageId → one message row, one dispatch, one quote", async () => {
    const clientMessageId = cid();
    const send = async () => {
      const rec = await recordInbound(f.db, f.dispatcherA, {
        conversationId: f.convA, clientMessageId, text: "USD 250", replyToMessageId: null,
      });
      const handled = await handleInbound(f.db, f.dispatcherA, { conversationId: f.convA, messageId: rec.messageId });
      return { rec, handled };
    };
    const first = await send();
    const second = await send(); // client retry
    expect(first.rec.duplicate).toBe(false);
    expect(second.rec.duplicate).toBe(true);
    expect(second.rec.messageId).toBe(first.rec.messageId);
    expect(second.handled.ok && second.handled.duplicate).toBe(true);

    const msgs = await f.db.query(
      `SELECT count(*)::int AS n FROM messages WHERE direction='INBOUND' AND conversation_id=$1`, [f.convA],
    );
    expect(msgs.rows[0].n).toBe(1);
    const quotes = await f.db.query(`SELECT count(*)::int AS n FROM quotes`);
    expect(quotes.rows[0].n).toBe(1); // dispatched exactly once
  });

  it("same RFQ send command key is idempotent", async () => {
    const key = cid();
    const a = await sendRfqToFleet(f.db, f.operator, { orderId: f.orderId, fleetOrganizationId: f.fleetB }, key);
    const b = await sendRfqToFleet(f.db, f.operator, { orderId: f.orderId, fleetOrganizationId: f.fleetB }, key);
    expect(a.ok && b.ok).toBe(true);
    expect(b.ok && b.duplicate).toBe(true);
    const recipients = await f.db.query(`SELECT count(*)::int AS n FROM rfq_recipients WHERE fleet_organization_id=$1`, [f.fleetB]);
    expect(recipients.rows[0].n).toBe(1);
  });
});

describe("ambiguous currency conversation (§3.5, §23.1)", () => {
  beforeAll(async () => {
    f = await setupFixtures();
    await sendRfqToFleet(f.db, f.operator, { orderId: f.orderId, fleetOrganizationId: f.fleetA }, cid());
  });

  it("bare $220 → clarification question, no quote", async () => {
    await say(f.dispatcherA, f.convA, "$220");
    const quotes = await f.db.query(`SELECT count(*)::int AS n FROM quotes`);
    expect(quotes.rows[0].n).toBe(0);
    const [q] = await lastOutbound(f.db, f.convA);
    expect(q.text_content).toContain("请确认币种");
    expect(q.text_content).toContain("USD 220");
    expect(q.text_content).toContain("SGD 220");
  });

  it("answering SGD → EXPLICIT SGD draft awaiting confirmation", async () => {
    await say(f.dispatcherA, f.convA, "SGD");
    const q = (await f.db.query(`SELECT * FROM quotes`)).rows[0];
    expect(q.status).toBe("PENDING_CONFIRMATION");
    expect(q.currency).toBe("SGD");
    expect(q.currency_source).toBe("EXPLICIT");
    expect(q.amount).toBe("220.00");
  });

  it("cancel button withdraws the draft", async () => {
    const [cancel] = await findActions(f.db, f.convA, "CANCEL_QUOTE_DRAFT");
    const res = await consumeMessageAction(f.db, f.dispatcherA, { actionId: cancel.id, clientIdempotencyKey: cid() });
    expect(res.ok).toBe(true);
    const q = (await f.db.query(`SELECT * FROM quotes`)).rows[0];
    expect(q.status).toBe("WITHDRAWN");
  });
});
