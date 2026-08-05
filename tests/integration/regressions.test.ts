import { beforeEach, describe, expect, it } from "vitest";
import {
  applyOrderFleetVisibleChange,
  cancelOrder,
  consumeMessageAction,
  deleteUnsentOrder,
  handleInbound,
  processOutboxOnce,
  recordInbound,
  selectQuoteAndOfferBooking,
  sendRfqToFleet,
} from "@mercury/application";
import { cid, findActions, setupFixtures, type Fixtures } from "./helpers.ts";

let f: Fixtures;

async function say(text: string) {
  const rec = await recordInbound(f.db, f.dispatcherA, {
    conversationId: f.convA,
    clientMessageId: cid(),
    text,
    replyToMessageId: null,
  });
  const handled = await handleInbound(f.db, f.dispatcherA, {
    conversationId: f.convA,
    messageId: rec.messageId,
  });
  return { ...rec, handled };
}

async function submitQuote(amount = "USD 220") {
  await say(amount);
  const [confirm] = await findActions(f.db, f.convA, "CONFIRM_QUOTE");
  await consumeMessageAction(f.db, f.dispatcherA, {
    actionId: confirm.id,
    clientIdempotencyKey: cid(),
  });
  return (await f.db.query(`SELECT * FROM quotes WHERE status='SUBMITTED' ORDER BY created_at DESC LIMIT 1`)).rows[0];
}

describe("regressions for fleet-chat safety fixes", () => {
  beforeEach(async () => {
    f = await setupFixtures();
  });

  it("keeps the original inbound UUID when the fleet selects one of multiple RFQs", async () => {
    const order2 = (
      await f.db.query(
        `INSERT INTO orders (
           public_reference, customer_organization_id, status,
           pickup_location_text, delivery_location_text,
           container_type, container_quantity, pickup_at
         ) VALUES ('M-1002',$1,'QUOTING','Tuas','Woodlands','20GP',1,'2026-08-06T01:00:00Z')
         RETURNING id`,
        [f.customer],
      )
    ).rows[0];
    await sendRfqToFleet(f.db, f.operator, { orderId: f.orderId, fleetOrganizationId: f.fleetA }, cid());
    await sendRfqToFleet(f.db, f.operator, { orderId: order2.id, fleetOrganizationId: f.fleetA }, cid());

    const inbound = await say("220 全包");
    const [select] = await findActions(f.db, f.convA, "SELECT_RFQ_CONTEXT");
    expect(select.payload.sourceMessageId).toBe(inbound.messageId);

    const result = await consumeMessageAction(f.db, f.dispatcherA, {
      actionId: select.id,
      clientIdempotencyKey: cid(),
    });
    expect(result.ok).toBe(true);
    const quote = (await f.db.query(`SELECT * FROM quotes`)).rows[0];
    expect(quote.source_message_id).toBe(inbound.messageId);
  });

  it("withdraws a submitted quote when the fleet later declines the RFQ", async () => {
    const sent = await sendRfqToFleet(f.db, f.operator, { orderId: f.orderId, fleetOrganizationId: f.fleetA }, cid());
    if (!sent.ok) throw new Error("RFQ send failed");
    const rfqId = sent.result.rfqId;
    const quote = await submitQuote();
    const [decline] = await findActions(f.db, f.convA, "DECLINE_RFQ");
    await consumeMessageAction(f.db, f.dispatcherA, {
      actionId: decline.id,
      clientIdempotencyKey: cid(),
    });

    const stored = (await f.db.query(`SELECT status FROM quotes WHERE id=$1`, [quote.id])).rows[0];
    expect(stored.status).toBe("WITHDRAWN");
    const noFleet = await f.db.query(
      `SELECT * FROM exception_cases WHERE rfq_id=$1 AND type='NO_FLEET_RESPONSE'`,
      [rfqId],
    );
    expect(noFleet.rowCount).toBe(1);
    const selection = await selectQuoteAndOfferBooking(f.db, f.operator, { quoteId: quote.id }, cid());
    expect(selection).toMatchObject({ ok: false, code: "INVALID_TRANSITION" });
  });

  it("links a fleet request for an operator to its order", async () => {
    const sent = await sendRfqToFleet(
      f.db,
      f.operator,
      { orderId: f.orderId, fleetOrganizationId: f.fleetA },
      cid(),
    );
    if (!sent.ok) throw new Error("RFQ send failed");
    const rec = await recordInbound(f.db, f.dispatcherA, {
      conversationId: f.convA,
      clientMessageId: cid(),
      text: "联系运营",
      replyToMessageId: sent.result.messageId,
    });
    await handleInbound(f.db, f.dispatcherA, {
      conversationId: f.convA,
      messageId: rec.messageId,
    });
    const exception = (
      await f.db.query(`SELECT * FROM exception_cases WHERE source_message_id=$1`, [rec.messageId])
    ).rows[0];
    expect(exception.order_id).toBe(f.orderId);
    expect(exception.rfq_id).toBe(sent.result.rfqId);
  });

  it("resets response and reminder state after an order revision", async () => {
    await sendRfqToFleet(f.db, f.operator, { orderId: f.orderId, fleetOrganizationId: f.fleetA }, cid());
    await submitQuote();
    await f.db.query(
      `UPDATE rfq_recipients SET reminder_count=2, last_reminded_at=now(), sent_at=now() - interval '1 day'`,
    );

    await applyOrderFleetVisibleChange(
      f.db,
      f.operator,
      { orderId: f.orderId, changes: { pickup_at: "2026-08-04T06:00:00Z" } },
      cid(),
    );
    const recipient = (await f.db.query(`SELECT * FROM rfq_recipients`)).rows[0];
    expect(recipient.status).toBe("AWAITING_RECONFIRMATION");
    expect(recipient.responded_at).toBeNull();
    expect(recipient.reminder_count).toBe(0);
    expect(recipient.last_reminded_at).toBeNull();
    expect(new Date(recipient.sent_at).getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it("rejects a stale booking button using expected_object_version", async () => {
    await sendRfqToFleet(f.db, f.operator, { orderId: f.orderId, fleetOrganizationId: f.fleetA }, cid());
    const quote = await submitQuote();
    await selectQuoteAndOfferBooking(f.db, f.operator, { quoteId: quote.id }, cid());
    const [accept] = await findActions(f.db, f.convA, "ACCEPT_BOOKING");
    await f.db.query(`UPDATE bookings SET version=version+1`);

    const result = await consumeMessageAction(f.db, f.dispatcherA, {
      actionId: accept.id,
      clientIdempotencyKey: cid(),
    });
    expect(result.ok).toBe(true);
    expect(result.ok && result.result).toMatchObject({ outcome: "STALE_REVISION" });
    const booking = (await f.db.query(`SELECT status FROM bookings`)).rows[0];
    expect(booking.status).toBe("OFFERED");
  });

  it("reclaims an outbox event left PROCESSING by a crashed worker", async () => {
    await sendRfqToFleet(f.db, f.operator, { orderId: f.orderId, fleetOrganizationId: f.fleetA }, cid());
    const event = (await f.db.query(`SELECT * FROM outbox_events ORDER BY created_at LIMIT 1`)).rows[0];
    await f.db.query(
      `UPDATE outbox_events
          SET status='PROCESSING', processing_started_at=now() - interval '10 minutes'
        WHERE id=$1`,
      [event.id],
    );

    await processOutboxOnce(f.db);
    const recovered = (await f.db.query(`SELECT * FROM outbox_events WHERE id=$1`, [event.id])).rows[0];
    expect(recovered.status).toBe("SENT");
    expect(recovered.processing_started_at).toBeNull();
  });

  it("invalidates every sibling button after one option is selected", async () => {
    await sendRfqToFleet(f.db, f.operator, { orderId: f.orderId, fleetOrganizationId: f.fleetA }, cid());
    const [replyLater] = await findActions(f.db, f.convA, "ACK_REPLY_LATER");

    const result = await consumeMessageAction(f.db, f.dispatcherA, {
      actionId: replyLater.id,
      clientIdempotencyKey: cid(),
    });
    expect(result.ok).toBe(true);

    const actions = await f.db.query(
      // action_type is a Postgres enum, so a bare ORDER BY sorts by enum
      // declaration order. Cast to text for a stable alphabetical order.
      `SELECT action_type, status FROM message_actions WHERE message_id=$1 ORDER BY action_type::text`,
      [replyLater.message_id],
    );
    expect(actions.rows).toEqual([
      { action_type: "ACK_REPLY_LATER", status: "CONSUMED" },
      { action_type: "DECLINE_RFQ", status: "INVALIDATED" },
      { action_type: "MODIFY_QUOTE", status: "INVALIDATED" },
    ]);
  });

  it("deletes an unsent order while retaining its audit record", async () => {
    const result = await deleteUnsentOrder(f.db, f.operator, { orderId: f.orderId }, cid());
    expect(result).toMatchObject({ ok: true, result: { orderId: f.orderId, deleted: true } });
    expect((await f.db.query(`SELECT id FROM orders WHERE id=$1`, [f.orderId])).rowCount).toBe(0);
    expect(
      (await f.db.query(`SELECT action FROM audit_logs WHERE object_id=$1 AND action='order.deleted_draft'`, [f.orderId])).rowCount,
    ).toBe(1);
  });

  it("cancels a sent order and retains the invalidated quote", async () => {
    await sendRfqToFleet(f.db, f.operator, { orderId: f.orderId, fleetOrganizationId: f.fleetA }, cid());
    const quote = await submitQuote();

    const result = await cancelOrder(f.db, f.operator, { orderId: f.orderId, reason: "Customer cancelled" }, cid());
    expect(result).toMatchObject({ ok: true, result: { orderId: f.orderId, status: "CANCELLED" } });
    expect((await f.db.query(`SELECT status FROM orders WHERE id=$1`, [f.orderId])).rows[0].status).toBe("CANCELLED");
    expect((await f.db.query(`SELECT status FROM quotes WHERE id=$1`, [quote.id])).rows[0].status).toBe("INVALIDATED");
    expect((await f.db.query(`SELECT id FROM quotes WHERE id=$1`, [quote.id])).rowCount).toBe(1);
  });
});
