import { beforeAll, describe, expect, it } from "vitest";
import {
  consumeMessageAction, handleInbound, processOutboxOnce, recordInbound, runReminders,
  selectQuoteAndOfferBooking, sendRfqToFleet, submitShipmentDocument,
  reviewShipmentDocuments,
} from "@mercury/application";
import { withTx } from "@mercury/db";
import { cid, findActions, lastOutbound, setupFixtures, type Fixtures } from "./helpers.ts";

let f: Fixtures;

async function say(actor: Fixtures["dispatcherA"], conv: string, text: string) {
  const rec = await recordInbound(f.db, actor, { conversationId: conv, clientMessageId: cid(), text, replyToMessageId: null });
  const handled = await handleInbound(f.db, actor, { conversationId: conv, messageId: rec.messageId });
  return { ...rec, handled };
}

describe("IMPORT booking → shipment → document review lifecycle (v1.1)", () => {
  let bookingId: string;
  let shipmentId: string;

  beforeAll(async () => {
    f = await setupFixtures();
    await sendRfqToFleet(f.db, f.operator, { orderId: f.orderId, fleetOrganizationId: f.fleetA }, cid());
    await say(f.dispatcherA, f.convA, "USD 220 全包");
    const [confirm] = await findActions(f.db, f.convA, "CONFIRM_QUOTE");
    await consumeMessageAction(f.db, f.dispatcherA, { actionId: confirm.id, clientIdempotencyKey: cid() });
  });

  it("operator selects quote → booking OFFERED with snapshot, RFQ closed, competitors rejected", async () => {
    const q = (await f.db.query(`SELECT * FROM quotes WHERE status='SUBMITTED'`)).rows[0];
    const res = await selectQuoteAndOfferBooking(f.db, f.operator, { quoteId: q.id }, cid());
    expect(res.ok).toBe(true);
    const b = (await f.db.query(`SELECT * FROM bookings`)).rows[0];
    bookingId = b.id;
    expect(b.status).toBe("OFFERED");
    expect(b.confirmed_amount).toBe("220.00");
    expect(b.confirmed_currency).toBe("USD");
    const rfq = (await f.db.query(`SELECT status FROM rfqs`)).rows[0];
    expect(rfq.status).toBe("CLOSED");
    const [offer] = await lastOutbound(f.db, f.convA);
    expect(offer.text_content).toContain("任务确认");
  });

  it("接受任务 → booking ACCEPTED, shipment WAITING_PORT_RELEASE，且不要求司机车辆", async () => {
    const [accept] = await findActions(f.db, f.convA, "ACCEPT_BOOKING");
    const res = await consumeMessageAction(f.db, f.dispatcherA, { actionId: accept.id, clientIdempotencyKey: cid() });
    expect(res.ok).toBe(true);
    const b = (await f.db.query(`SELECT * FROM bookings WHERE id=$1`, [bookingId])).rows[0];
    expect(b.status).toBe("ACCEPTED");
    const s = (await f.db.query(`SELECT * FROM shipments`)).rows[0];
    shipmentId = s.id;
    expect(s.current_status).toBe("WAITING_PORT_RELEASE");
    const assignments = await f.db.query(
      `SELECT count(*)::int AS n FROM booking_assignments WHERE booking_id=$1`,
      [bookingId],
    );
    expect(assignments.rows[0].n).toBe(0);
  });

  it("严格按提重箱、送货、还空箱顺序推进整票状态", async () => {
    for (const [text, expected] of [
      ["全部重箱已提取", "CONTAINER_PICKED_UP"],
      ["前往送货地点", "IN_TRANSIT_TO_DELIVERY"],
      ["送到了", "DELIVERED"],
      ["等待归还空箱", "EMPTY_RETURN_PENDING"],
      ["全部空箱已还", "EMPTY_RETURNED"],
    ] as const) {
      await say(f.dispatcherA, f.convA, text);
      const [confirm] = await findActions(f.db, f.convA, "CONFIRM_SHIPMENT_STATUS");
      expect(confirm.payload.toStatus).toBe(expected);
      await consumeMessageAction(f.db, f.dispatcherA, {
        actionId: confirm.id,
        clientIdempotencyKey: cid(),
      });
    }
    const shipment = (
      await f.db.query(`SELECT * FROM shipments WHERE id=$1`, [shipmentId])
    ).rows[0];
    expect(shipment.current_status).toBe("EMPTY_RETURNED");
  });

  it("POD 与还空箱证明齐全后等待审核；运营审核使三对象一起完成", async () => {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64",
    );
    await withTx(f.db, (tx) =>
      submitShipmentDocument(tx, f.dispatcherA, {
        conversationId: f.convA, shipmentId, documentType: "POD",
        fileName: "pod.png", mimeType: "image/png", data: png,
      }));
    const res = await withTx(f.db, (tx) =>
      submitShipmentDocument(tx, f.dispatcherA, {
        conversationId: f.convA, shipmentId, documentType: "EMPTY_CONTAINER_RETURN",
        fileName: "empty-return.png", mimeType: "image/png", data: png,
      }));
    expect(res.shipmentStatus).toBe("REVIEW_PENDING");

    const docs = await f.db.query(`SELECT * FROM documents ORDER BY created_at`);
    expect(docs.rows.map((doc) => doc.type)).toEqual(["POD", "EMPTY_CONTAINER_RETURN"]);
    expect(docs.rows.every((doc) => doc.checksum_sha256.length === 64)).toBe(true);
    const exc = await f.db.query(
      `SELECT * FROM exception_cases WHERE type='DOCUMENT_REVIEW_REQUIRED' AND status='OPEN'`,
    );
    expect(exc.rowCount).toBe(1);
    const s = (await f.db.query(`SELECT current_status FROM shipments WHERE id=$1`, [shipmentId])).rows[0];
    expect(s.current_status).toBe("REVIEW_PENDING");
    expect(s.current_status).not.toBe("COMPLETED");

    await withTx(f.db, (tx) =>
      reviewShipmentDocuments(tx, f.operator, { shipmentId, approved: true }),
    );
    const [shipment, booking, order] = await Promise.all([
      f.db.query(`SELECT current_status FROM shipments WHERE id=$1`, [shipmentId]),
      f.db.query(`SELECT status FROM bookings WHERE id=$1`, [bookingId]),
      f.db.query(`SELECT status FROM orders WHERE id=$1`, [f.orderId]),
    ]);
    expect(shipment.rows[0].current_status).toBe("COMPLETED");
    expect(booking.rows[0].status).toBe("COMPLETED");
    expect(order.rows[0].status).toBe("COMPLETED");
  });
});

describe("outbox worker + reminders (§9.3, §19.2)", () => {
  beforeAll(async () => {
    f = await setupFixtures();
    await sendRfqToFleet(f.db, f.operator, { orderId: f.orderId, fleetOrganizationId: f.fleetA }, cid());
  });

  it("processOutboxOnce delivers pending events and marks messages SENT", async () => {
    const pendingBefore = (await f.db.query(`SELECT count(*)::int AS n FROM outbox_events WHERE status='PENDING'`)).rows[0].n;
    expect(pendingBefore).toBeGreaterThan(0);
    let total = 0;
    for (let i = 0; i < 5; i++) total += await processOutboxOnce(f.db);
    expect(total).toBeGreaterThanOrEqual(pendingBefore);
    const pendingAfter = (await f.db.query(`SELECT count(*)::int AS n FROM outbox_events WHERE status='PENDING'`)).rows[0].n;
    expect(pendingAfter).toBe(0);
    const unsent = (await f.db.query(
      `SELECT count(*)::int AS n FROM messages WHERE direction='OUTBOUND' AND delivery_status='PENDING'`,
    )).rows[0].n;
    expect(unsent).toBe(0);
  });

  it("reminder ladder: two reminders (no revision bump), then NO_FLEET_RESPONSE exception", async () => {
    // Backdate the RFQ send to trip reminder 1.
    await f.db.query(`UPDATE rfq_recipients SET sent_at = now() - interval '2 hours'`);
    const sent1 = await runReminders(f.db);
    expect(sent1).toBe(1);
    let rec = (await f.db.query(`SELECT * FROM rfq_recipients`)).rows[0];
    expect(rec.reminder_count).toBe(1);

    await f.db.query(`UPDATE rfq_recipients SET last_reminded_at = now() - interval '3 hours'`);
    const sent2 = await runReminders(f.db);
    expect(sent2).toBe(1);
    rec = (await f.db.query(`SELECT * FROM rfq_recipients`)).rows[0];
    expect(rec.reminder_count).toBe(2);

    const rfq = (await f.db.query(`SELECT revision FROM rfqs`)).rows[0];
    expect(rfq.revision).toBe(1); // reminders never bump revision (§19.2)
    const exc = await f.db.query(`SELECT count(*)::int AS n FROM exception_cases WHERE type='NO_FLEET_RESPONSE' AND status='OPEN'`);
    expect(exc.rows[0].n).toBe(1);

    // Third run: nothing more due, no duplicate exception.
    await f.db.query(`UPDATE rfq_recipients SET last_reminded_at = now() - interval '3 hours'`);
    const sent3 = await runReminders(f.db);
    expect(sent3).toBe(0);
  });
});
