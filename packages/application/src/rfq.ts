import type { Db, Tx } from "@mercury/db";
import { err, type CommandResult } from "@mercury/contracts";
import { formatMoney, FLEET_VISIBLE_ORDER_FIELDS, type FleetVisibleOrderField, CANCELLED_BOOKING_STATUSES } from "@mercury/domain";
import { type Actor, audit, CommandFailure, emitOutbox, lockOrderMutex, runCommand } from "./kernel.ts";
import { getOrCreateConversation, invalidateStaleRfqActions, sendOutbound } from "./messaging.ts";
import { orderChangeCard, rfqCard, type OrderRow } from "./cards.ts";

export async function lockOrder(tx: Tx, orderId: string): Promise<OrderRow & Record<string, any>> {
  await lockOrderMutex(tx, orderId);
  const r = await tx.query(`SELECT * FROM orders WHERE id=$1 FOR UPDATE`, [orderId]);
  if (!r.rowCount) throw new CommandFailure(err("NOT_FOUND", "Order not found"));
  return r.rows[0];
}

function rfqRefFor(orderRef: string): string {
  return `RFQ-${orderRef.replace(/^[A-Z]+-/, "")}`;
}

/** SendRfqToFleet (§14) — dev simulator / future operator flow. */
export async function sendRfqToFleet(
  db: Db,
  actor: Actor,
  input: { orderId: string; fleetOrganizationId: string },
  idempotencyKey: string,
): Promise<CommandResult<{ rfqId: string; rfqRecipientId: string; messageId: string }>> {
  return runCommand(db, { key: idempotencyKey, type: "SendRfqToFleet" }, async (tx) => {
    const order = await lockOrder(tx, input.orderId);
    if (!["DRAFT", "QUOTING"].includes(order.status)) {
      throw new CommandFailure(err("INVALID_TRANSITION", `订单当前为 ${order.status}，不能再发送询价。`));
    }
    const fleet = (
      await tx.query(
        `SELECT o.status, p.accepting_orders
           FROM organizations o
           JOIN fleet_profiles p ON p.fleet_organization_id=o.id
          WHERE o.id=$1 AND o.type='FLEET'`,
        [input.fleetOrganizationId],
      )
    ).rows[0];
    if (!fleet) {
      throw new CommandFailure(err("VALIDATION", "车队尚未建立接单档案，不能发送询价。"));
    }
    if (fleet.status !== "ACTIVE" || !fleet.accepting_orders) {
      throw new CommandFailure(err("INVALID_TRANSITION", "车队账号已停用或当前暂停接单，不能发送询价。"));
    }

    // Exactly one RFQ row per order (§3.2/§7.2).
    let rfq = (await tx.query(`SELECT * FROM rfqs WHERE order_id=$1 FOR UPDATE`, [order.id])).rows[0];
    if (!rfq) {
      rfq = (
        await tx.query(
          `INSERT INTO rfqs (order_id, public_reference, status, sent_at) VALUES ($1,$2,'ACTIVE',now()) RETURNING *`,
          [order.id, rfqRefFor(order.public_reference)],
        )
      ).rows[0];
      await audit(tx, { actor, action: "rfq.created", objectType: "RFQ", objectId: rfq.id, after: { revision: rfq.revision } });
    } else if (rfq.status === "CREATED") {
      await tx.query(`UPDATE rfqs SET status='ACTIVE', sent_at=now(), updated_at=now() WHERE id=$1`, [rfq.id]);
      rfq.status = "ACTIVE";
    }
    if (rfq.status !== "ACTIVE") throw new CommandFailure(err("INVALID_TRANSITION", `RFQ is ${rfq.status}`));
    if (order.status === "DRAFT") {
      await tx.query(`UPDATE orders SET status='QUOTING', updated_at=now() WHERE id=$1`, [order.id]);
    }

    const existingRecipient = (
      await tx.query(
        `SELECT * FROM rfq_recipients WHERE rfq_id=$1 AND fleet_organization_id=$2`,
        [rfq.id, input.fleetOrganizationId],
      )
    ).rows[0];
    if (
      existingRecipient &&
      ["PENDING", "SENT", "VIEWED", "AWAITING_QUOTE", "AWAITING_RECONFIRMATION", "QUOTED"].includes(existingRecipient.status) &&
      existingRecipient.notified_revision === rfq.revision
    ) {
      const priorMessage = (
        await tx.query(
          `SELECT message_id FROM message_context_links
            WHERE rfq_recipient_id=$1 AND rfq_revision=$2
            ORDER BY created_at DESC LIMIT 1`,
          [existingRecipient.id, rfq.revision],
        )
      ).rows[0];
      return {
        rfqId: rfq.id,
        rfqRecipientId: existingRecipient.id,
        messageId: priorMessage?.message_id ?? "",
      };
    }

    const rec = await tx.query(
      `INSERT INTO rfq_recipients (rfq_id, fleet_organization_id, status, notified_revision, sent_at)
       VALUES ($1,$2,'SENT',$3,now())
       ON CONFLICT (rfq_id, fleet_organization_id)
       DO UPDATE SET status='SENT', notified_revision=$3, acknowledged_revision=NULL,
                     sent_at=now(), responded_at=NULL, decline_reason=NULL,
                     reminder_count=0, last_reminded_at=NULL, updated_at=now()
       RETURNING *`,
      [rfq.id, input.fleetOrganizationId, rfq.revision],
    );
    const recipient = rec.rows[0];

    const conv = await getOrCreateConversation(tx, input.fleetOrganizationId);
    const card = rfqCard(order, rfq.public_reference, rfq.revision);
    const { messageId } = await sendOutbound(tx, {
      conversationId: conv.id,
      messageType: "BUSINESS_CARD",
      text: card.text,
      structured: card.structured,
      context: { orderId: order.id, rfqId: rfq.id, rfqRecipientId: recipient.id, rfqRevision: rfq.revision },
      actions: [
        {
          actionType: "MODIFY_QUOTE", label: "我要报价", objectType: "RFQ_RECIPIENT", objectId: recipient.id,
          expectedOrderVersion: order.version, expectedRfqRevision: rfq.revision,
        },
        {
          actionType: "DECLINE_RFQ", label: "无法承运", objectType: "RFQ_RECIPIENT", objectId: recipient.id,
          expectedOrderVersion: order.version, expectedRfqRevision: rfq.revision,
        },
        {
          actionType: "ACK_REPLY_LATER", label: "稍后回复", objectType: "RFQ_RECIPIENT", objectId: recipient.id,
          expectedOrderVersion: order.version, expectedRfqRevision: rfq.revision,
        },
      ],
    });

    await audit(tx, {
      actor, action: "rfq.sent", objectType: "RFQ_RECIPIENT", objectId: recipient.id,
      after: { fleetOrganizationId: input.fleetOrganizationId, revision: rfq.revision },
    });
    await emitOutbox(tx, "rfq.sent", "RFQ", rfq.id, { rfqRecipientId: recipient.id, revision: rfq.revision });
    return { rfqId: rfq.id, rfqRecipientId: recipient.id, messageId };
  });
}

/**
 * ApplyOrderFleetVisibleChange (§11.5, §12): one transaction that updates the
 * Order, bumps the RFQ revision (same row — never a new RFQ), invalidates and
 * retains active Quotes, invalidates stale actions, moves recipients to
 * AWAITING_RECONFIRMATION, and emits per-fleet change notifications.
 */
export async function applyOrderFleetVisibleChange(
  db: Db,
  actor: Actor,
  input: {
    orderId: string;
    changes: Partial<Record<FleetVisibleOrderField, unknown>>;
    /**
     * Why the operator made this change. Recorded in the audit trail so history
     * can answer who / when / what / before-after / **why**, which a
     * before-after diff alone cannot.
     */
    reason?: string | null;
  },
  idempotencyKey: string,
): Promise<CommandResult<{ orderVersion: number; rfqRevision: number | null; invalidatedQuotes: number; exceptionId?: string }>> {
  return runCommand(db, { key: idempotencyKey, type: "ApplyOrderFleetVisibleChange" }, async (tx) => {
    const order = await lockOrder(tx, input.orderId);

    const diffs: Array<{ field: FleetVisibleOrderField; from: unknown; to: unknown }> = [];
    for (const field of FLEET_VISIBLE_ORDER_FIELDS) {
      if (!(field in input.changes)) continue;
      const to = input.changes[field];
      const from = order[field];
      const norm = (v: unknown) => {
        if (v instanceof Date) return v.toISOString();
        if (field.endsWith("_at") && v) return new Date(v as string).toISOString();
        if (["gross_weight_kg", "reefer_temperature_c"].includes(field) && v !== null && v !== undefined && v !== "") {
          return Number(v);
        }
        return v ?? null;
      };
      if (norm(from) !== norm(to)) diffs.push({ field, from, to });
    }
    if (diffs.length === 0) throw new CommandFailure(err("VALIDATION", "No fleet-visible changes supplied"));

    // §12.3 — after a Booking exists, this is an operator-mediated exception,
    // never ordinary reconfirmation; confirmed Booking terms are preserved.
    const activeBooking = (
      await tx.query(
        `SELECT * FROM bookings WHERE order_id=$1 AND status != ALL($2::booking_status[]) FOR UPDATE`,
        [order.id, CANCELLED_BOOKING_STATUSES],
      )
    ).rows[0];

    const newVersion = order.version + 1;
    const sets = diffs.map((d, i) => `${d.field}=$${i + 2}`).join(", ");
    await tx.query(
      `UPDATE orders SET ${sets}, version=$${diffs.length + 2}, updated_at=now() WHERE id=$1`,
      [order.id, ...diffs.map((d) => d.to), newVersion],
    );
    await audit(tx, {
      actor, action: "order.fleet_visible_change", objectType: "ORDER", objectId: order.id,
      before: Object.fromEntries(diffs.map((d) => [d.field, d.from])),
      after: Object.fromEntries(diffs.map((d) => [d.field, d.to])),
      metadata: { orderVersion: newVersion, reason: input.reason ?? null },
    });

    if (activeBooking) {
      const exc = await tx.query(
        `INSERT INTO exception_cases (type, order_id, fleet_organization_id, summary, details)
         VALUES ('ORDER_CHANGED_AFTER_BOOKING',$1,$2,$3,$4) RETURNING id`,
        [
          order.id, activeBooking.fleet_organization_id,
          `Order ${order.public_reference} changed after booking ${activeBooking.public_reference}; operator reconfirmation required`,
          JSON.stringify({ changes: diffs, bookingId: activeBooking.id }),
        ],
      );
      const conv = await getOrCreateConversation(tx, activeBooking.fleet_organization_id);
      await sendOutbound(tx, {
        conversationId: conv.id,
        senderType: "MERCURY_SYSTEM",
        messageType: "SYSTEM_NOTICE",
        text: `订单 ${order.public_reference} 在任务确认后发生变更。已确认的任务条款保持不变，运营人员将与你确认后续安排。`,
        context: { orderId: order.id, bookingId: activeBooking.id },
      });
      await emitOutbox(tx, "exception.created", "EXCEPTION", exc.rows[0].id, { type: "ORDER_CHANGED_AFTER_BOOKING" });
      await audit(tx, { actor, action: "exception.created", objectType: "EXCEPTION", objectId: exc.rows[0].id, metadata: { type: "ORDER_CHANGED_AFTER_BOOKING" } });
      return { orderVersion: newVersion, rfqRevision: null, invalidatedQuotes: 0, exceptionId: exc.rows[0].id };
    }

    const rfq = (await tx.query(`SELECT * FROM rfqs WHERE order_id=$1 FOR UPDATE`, [order.id])).rows[0];
    // §12.1 — before an RFQ is sent, no fleet notification or invalidation.
    if (!rfq || rfq.status !== "ACTIVE" || !rfq.sent_at) {
      return { orderVersion: newVersion, rfqRevision: rfq?.revision ?? null, invalidatedQuotes: 0 };
    }

    const newRevision = rfq.revision + 1;
    await tx.query(`UPDATE rfqs SET revision=$2, updated_at=now() WHERE id=$1`, [rfq.id, newRevision]);
    await audit(tx, {
      actor, action: "rfq.revision_changed", objectType: "RFQ", objectId: rfq.id,
      before: { revision: rfq.revision }, after: { revision: newRevision },
    });

    // Invalidate-and-retain every active Quote from older revisions (§3.3, §11.5 step 4).
    const invalidated = await tx.query(
      `UPDATE quotes q
         SET status='INVALIDATED', invalidated_at=now(), invalidated_reason='ORDER_CHANGED',
             version=q.version+1, updated_at=now()
        FROM rfq_recipients r
       WHERE q.rfq_recipient_id=r.id AND r.rfq_id=$1
         AND q.status IN ('DRAFT','PENDING_CONFIRMATION','SUBMITTED')
       RETURNING q.id, q.status, q.amount, q.currency, q.rfq_recipient_id,
                 (q.submitted_at IS NOT NULL) AS was_submitted`,
      [rfq.id],
    );
    for (const q of invalidated.rows) {
      await audit(tx, {
        actor, action: "quote.invalidated", objectType: "QUOTE", objectId: q.id,
        after: { reason: "ORDER_CHANGED", rfqRevision: newRevision },
      });
      await emitOutbox(tx, "quote.invalidated", "QUOTE", q.id, { reason: "ORDER_CHANGED" });
    }

    // Recipients that were active must reconfirm (§11.5 steps 5–6).
    const recipients = await tx.query(
      `UPDATE rfq_recipients
          SET status='AWAITING_RECONFIRMATION',
              acknowledged_revision=NULL,
              notified_revision=$2,
              responded_at=NULL,
              reminder_count=0,
              last_reminded_at=NULL,
              sent_at=now(),
              updated_at=now()
        WHERE rfq_id=$1 AND status IN ('SENT','VIEWED','AWAITING_QUOTE','AWAITING_RECONFIRMATION','QUOTED')
        RETURNING *`,
      [rfq.id, newRevision],
    );

    await invalidateStaleRfqActions(tx, rfq.id, newRevision);

    // Per-fleet notification describing changed fields (§3.4).
    for (const recipient of recipients.rows) {
      const lastInvalidated = invalidated.rows.find((q) => q.rfq_recipient_id === recipient.id && q.was_submitted);
      const conv = await getOrCreateConversation(tx, recipient.fleet_organization_id);
      const card = orderChangeCard({
        rfqRef: rfq.public_reference,
        revision: newRevision,
        changes: diffs,
        invalidatedMoney: lastInvalidated ? formatMoney(lastInvalidated.currency, lastInvalidated.amount) : null,
      });
      const actions: Parameters<typeof sendOutbound>[1]["actions"] = [];
      if (lastInvalidated) {
        actions.push({
          actionType: "ACK_PRICE_UNCHANGED", label: "价格不变", objectType: "RFQ_RECIPIENT", objectId: recipient.id,
          expectedOrderVersion: newVersion, expectedRfqRevision: newRevision,
          payload: { invalidatedQuoteId: lastInvalidated.id, rfqRecipientId: recipient.id },
        });
      }
      actions.push(
        {
          actionType: "MODIFY_QUOTE", label: "修改报价", objectType: "RFQ_RECIPIENT", objectId: recipient.id,
          expectedOrderVersion: newVersion, expectedRfqRevision: newRevision,
        },
        {
          actionType: "DECLINE_RFQ", label: "无法承运", objectType: "RFQ_RECIPIENT", objectId: recipient.id,
          expectedOrderVersion: newVersion, expectedRfqRevision: newRevision,
        },
        {
          actionType: "ACK_REPLY_LATER", label: "已收到，稍后回复", objectType: "RFQ_RECIPIENT", objectId: recipient.id,
          expectedOrderVersion: newVersion, expectedRfqRevision: newRevision,
        },
      );
      await sendOutbound(tx, {
        conversationId: conv.id,
        messageType: "BUSINESS_CARD",
        text: card.text,
        structured: card.structured,
        context: { orderId: order.id, rfqId: rfq.id, rfqRecipientId: recipient.id, rfqRevision: newRevision },
        actions,
      });
      await emitOutbox(tx, "rfq.change_notified", "RFQ_RECIPIENT", recipient.id, { revision: newRevision });
    }

    return { orderVersion: newVersion, rfqRevision: newRevision, invalidatedQuotes: invalidated.rowCount ?? 0 };
  });
}
