/**
 * End-to-end acceptance scenario (§25) against a real Postgres database,
 * exercising the application layer exactly as the HTTP handlers do.
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  applyOrderFleetVisibleChange, consumeMessageAction, handleInbound, recordInbound, sendRfqToFleet,
} from "@mercury/application";
import { cid, findActions, lastOutbound, setupFixtures, type Fixtures } from "./helpers.ts";

let f: Fixtures;

async function say(actor: Fixtures["dispatcherA"], conv: string, text: string, replyTo?: string) {
  const rec = await recordInbound(f.db, actor, { conversationId: conv, clientMessageId: cid(), text, replyToMessageId: replyTo ?? null });
  const handled = await handleInbound(f.db, actor, { conversationId: conv, messageId: rec.messageId });
  return { ...rec, handled };
}

describe("§25 acceptance scenario", () => {
  beforeAll(async () => {
    f = await setupFixtures();
  });

  let rfqId: string;
  let q1: string; // first submitted quote
  let q2: string; // 价格不变 replacement

  it("1. operator creates order and sends RFQ to Fleet A (rev 1)", async () => {
    const res = await sendRfqToFleet(f.db, f.operator, { orderId: f.orderId, fleetOrganizationId: f.fleetA }, cid());
    expect(res.ok).toBe(true);
    const rfq = (await f.db.query(`SELECT * FROM rfqs WHERE order_id=$1`, [f.orderId])).rows[0];
    rfqId = rfq.id;
    expect(rfq.revision).toBe(1);
    const [card] = await lastOutbound(f.db, f.convA);
    expect(card.message_type).toBe("BUSINESS_CARD");
    expect(card.text_content).toContain("RFQ-1001");
    expect(card.text_content).toContain("PSA Pasir Panjang");
    // RFQ buttons carry version binding
    const modify = await findActions(f.db, f.convA, "MODIFY_QUOTE");
    expect(modify).toHaveLength(1);
    expect(modify[0].expected_rfq_revision).toBe(1);
  });

  it("2. fleet replies 220全包 → PENDING_CONFIRMATION quote, USD DEFAULTED", async () => {
    await say(f.dispatcherA, f.convA, "220全包");
    const q = (await f.db.query(`SELECT * FROM quotes`)).rows[0];
    expect(q.status).toBe("PENDING_CONFIRMATION");
    expect(q.amount).toBe("220.00");
    expect(q.currency).toBe("USD");
    expect(q.currency_source).toBe("DEFAULTED");
    expect(q.is_all_in).toBe(true);
    expect(q.based_on_order_version).toBe(1);
    expect(q.based_on_rfq_revision).toBe(1);
    const [card] = await lastOutbound(f.db, f.convA);
    expect(card.text_content).toContain("USD 220.00");
    expect(card.text_content).toContain("默认");
  });

  it("3. 确认提交 → SUBMITTED, recipient QUOTED with acknowledged revision", async () => {
    const [confirm] = await findActions(f.db, f.convA, "CONFIRM_QUOTE");
    const res = await consumeMessageAction(f.db, f.dispatcherA, { actionId: confirm.id, clientIdempotencyKey: cid() });
    expect(res.ok).toBe(true);
    const q = (await f.db.query(`SELECT * FROM quotes WHERE status='SUBMITTED'`)).rows[0];
    expect(q).toBeTruthy();
    expect(q.currency_confirmed_at).toBeTruthy();
    q1 = q.id;
    const rec = (await f.db.query(`SELECT * FROM rfq_recipients`)).rows[0];
    expect(rec.status).toBe("QUOTED");
    expect(rec.acknowledged_revision).toBe(1);
  });

  it("3b. double-click on the consumed button is a no-op duplicate", async () => {
    const [consumed] = await findActions(f.db, f.convA, "CONFIRM_QUOTE", "CONSUMED");
    const res = await consumeMessageAction(f.db, f.dispatcherA, { actionId: consumed.id, clientIdempotencyKey: cid() });
    expect(res.ok).toBe(true);
    expect(res.ok && res.duplicate).toBe(true); // returned from processed_commands
    const count = await f.db.query(`SELECT count(*)::int AS n FROM quotes`);
    expect(count.rows[0].n).toBe(1); // still exactly one quote
  });

  it("4. operator changes pickup 09:00 → 14:00: v2/rev2, quote invalidated+retained, actions invalidated", async () => {
    const res = await applyOrderFleetVisibleChange(
      f.db, f.operator, { orderId: f.orderId, changes: { pickup_at: "2026-08-04T06:00:00Z" } }, cid(),
    );
    expect(res.ok).toBe(true);

    const order = (await f.db.query(`SELECT * FROM orders WHERE id=$1`, [f.orderId])).rows[0];
    expect(order.version).toBe(2);
    const rfq = (await f.db.query(`SELECT * FROM rfqs WHERE id=$1`, [rfqId])).rows[0];
    expect(rfq.revision).toBe(2); // same RFQ row — revision bump, never a new RFQ (§7.3)

    const old = (await f.db.query(`SELECT * FROM quotes WHERE id=$1`, [q1])).rows[0];
    expect(old.status).toBe("INVALIDATED");
    expect(old.invalidated_reason).toBe("ORDER_CHANGED");
    expect(old.amount).toBe("220.00"); // retained, not deleted (§7.4)

    const rec = (await f.db.query(`SELECT * FROM rfq_recipients`)).rows[0];
    expect(rec.status).toBe("AWAITING_RECONFIRMATION");
    expect(rec.acknowledged_revision).toBeNull();

    // all rev-1 actions invalidated
    const staleAvailable = await f.db.query(
      `SELECT count(*)::int AS n FROM message_actions WHERE expected_rfq_revision=1 AND status='AVAILABLE'`,
    );
    expect(staleAvailable.rows[0].n).toBe(0);

    // per-fleet diff message with 价格不变 present (invalidated SUBMITTED quote existed)
    const [msg] = await lastOutbound(f.db, f.convA);
    expect(msg.text_content).toContain("已更新");
    const ack = await findActions(f.db, f.convA, "ACK_PRICE_UNCHANGED");
    expect(ack).toHaveLength(1);
    expect(ack[0].expected_rfq_revision).toBe(2);
    expect(ack[0].payload.invalidatedQuoteId).toBe(q1);
  });

  it("5. 价格不变 (typed) → NEW SUBMITTED quote, INHERITED currency, supersession links, action consumed", async () => {
    await say(f.dispatcherA, f.convA, "价格不变");
    const nq = (await f.db.query(`SELECT * FROM quotes WHERE status='SUBMITTED'`)).rows[0];
    expect(nq).toBeTruthy();
    expect(nq.id).not.toBe(q1);
    q2 = nq.id;
    expect(nq.amount).toBe("220.00");
    expect(nq.currency).toBe("USD");
    expect(nq.currency_source).toBe("INHERITED");
    expect(nq.based_on_order_version).toBe(2);
    expect(nq.based_on_rfq_revision).toBe(2);
    expect(nq.supersedes_quote_id).toBe(q1);
    const old = (await f.db.query(`SELECT * FROM quotes WHERE id=$1`, [q1])).rows[0];
    expect(old.superseded_by_quote_id).toBe(q2);
    const rec = (await f.db.query(`SELECT * FROM rfq_recipients`)).rows[0];
    expect(rec.status).toBe("QUOTED");
    expect(rec.acknowledged_revision).toBe(2);
    // the button was consumed by the text path — shared idempotency (§9.2)
    const ack = await findActions(f.db, f.convA, "ACK_PRICE_UNCHANGED", "CONSUMED");
    expect(ack).toHaveLength(1);
  });

  it("5b. repeating 价格不变 does not create another quote", async () => {
    await say(f.dispatcherA, f.convA, "价格不变");
    const n = await f.db.query(`SELECT count(*)::int AS n FROM quotes`);
    expect(n.rows[0].n).toBe(2);
    const [msg] = await lastOutbound(f.db, f.convA);
    expect(msg.text_content).toMatch(/重新确认过|没有等待/);
  });

  it("6. operator changes pickup again (rev 3); clicking a leftover rev-2 button → typed STALE_REVISION, no writes", async () => {
    const res = await applyOrderFleetVisibleChange(
      f.db, f.operator, { orderId: f.orderId, changes: { pickup_at: "2026-08-04T08:00:00Z" } }, cid(),
    );
    expect(res.ok).toBe(true);
    const rfq = (await f.db.query(`SELECT * FROM rfqs WHERE id=$1`, [rfqId])).rows[0];
    expect(rfq.revision).toBe(3);
    // q2 invalidated now, new ACK action at rev 3 exists
    const q2row = (await f.db.query(`SELECT * FROM quotes WHERE id=$1`, [q2])).rows[0];
    expect(q2row.status).toBe("INVALIDATED");

    // Manufacture the §25 race: an action bound to rev 2 that survived (e.g.
    // rendered in an old client tab). Insert one exactly as rev-2 would have.
    const anyMsg = (await lastOutbound(f.db, f.convA))[0];
    const staleAction = (
      await f.db.query(
        `INSERT INTO message_actions (message_id, action_type, label, object_type, object_id, expected_order_version, expected_rfq_revision, payload, idempotency_key)
         SELECT $1,'ACK_PRICE_UNCHANGED','价格不变','QUOTE',$2,2,2,$3::jsonb, gen_random_uuid()::text RETURNING *`,
        [anyMsg.id, q2, JSON.stringify({ invalidatedQuoteId: q2, rfqRecipientId: (await f.db.query(`SELECT id FROM rfq_recipients`)).rows[0].id })],
      )
    ).rows[0];

    const quotesBefore = (await f.db.query(`SELECT count(*)::int AS n FROM quotes`)).rows[0].n;
    const res2 = await consumeMessageAction(f.db, f.dispatcherA, { actionId: staleAction.id, clientIdempotencyKey: cid() });
    expect(res2.ok).toBe(true);
    const outcome = res2.ok ? (res2.result as { outcome: string; message: string }) : null;
    expect(outcome!.outcome).toBe("STALE_REVISION"); // typed result, not an exception (§15)
    const quotesAfter = (await f.db.query(`SELECT count(*)::int AS n FROM quotes`)).rows[0].n;
    expect(quotesAfter).toBe(quotesBefore); // zero business writes
    const a = (await f.db.query(`SELECT status FROM message_actions WHERE id=$1`, [staleAction.id])).rows[0];
    expect(a.status).toBe("INVALIDATED");
    const [notice] = await lastOutbound(f.db, f.convA);
    // Copy follows the brief's required stale-action wording ("订单条件已更新 …
    // 此操作不再有效"). It must also say that nothing was changed.
    expect(notice.text_content).toContain("不再有效");
    expect(notice.text_content).toContain("没有改动");
    // …and it must be reachable from the task, not only from the raw feed: a
    // notice with no context link is invisible in every task conversation.
    const linked = await f.db.query(
      `SELECT count(*)::int AS n FROM message_context_links WHERE message_id=$1`,
      [notice.id],
    );
    expect(linked.rows[0].n).toBe(1);
  });

  it("7. delayed reply to the rev-1 RFQ message → persisted + linked, no quote, reconfirm prompt (§11.8)", async () => {
    const rev1Card = (
      await f.db.query(
        `SELECT m.* FROM messages m JOIN message_context_links l ON l.message_id=m.id
          WHERE m.conversation_id=$1 AND l.rfq_revision=1 AND m.message_type='BUSINESS_CARD'
          ORDER BY m.created_at LIMIT 1`,
        [f.convA],
      )
    ).rows[0];
    const quotesBefore = (await f.db.query(`SELECT count(*)::int AS n FROM quotes`)).rows[0].n;
    const { messageId } = await say(f.dispatcherA, f.convA, "220可以", rev1Card.id);

    const quotesAfter = (await f.db.query(`SELECT count(*)::int AS n FROM quotes`)).rows[0].n;
    expect(quotesAfter).toBe(quotesBefore); // no quote created
    const link = await f.db.query(`SELECT * FROM message_context_links WHERE message_id=$1`, [messageId]);
    expect(link.rowCount).toBe(1);
    expect(link.rows[0].rfq_revision).toBe(1); // linked to the OLD revision
    const [reply] = await lastOutbound(f.db, f.convA);
    expect(reply.text_content).toContain("旧版本");
    expect(reply.text_content).toContain("未做任何修改");
  });

  it("8. transactional evidence: audit rows and outbox events exist for every mutation", async () => {
    const audits = await f.db.query(`SELECT action, count(*) FROM audit_logs GROUP BY action`);
    const names = audits.rows.map((r) => r.action);
    for (const expected of [
      "rfq.sent", "quote.drafted", "quote.submitted", "order.fleet_visible_change",
      "quote.invalidated", "quote.reconfirmed_price_unchanged", "action.consumed", "action.stale_rejected", "message.stale_reply",
    ]) {
      expect(names, expected).toContain(expected);
    }
    const outbox = await f.db.query(`SELECT count(*)::int AS n FROM outbox_events`);
    expect(outbox.rows[0].n).toBeGreaterThan(5);
  });
});
