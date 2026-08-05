import type { Db } from "@mercury/db";
import { err, type CommandResult } from "@mercury/contracts";
import { type Actor, audit, CommandFailure, emitOutbox, runCommand } from "./kernel.ts";
import { getOrCreateConversation, sendOutbound } from "./messaging.ts";
import { lockOrder } from "./rfq.ts";

export async function deleteUnsentOrder(
  db: Db,
  actor: Actor,
  input: { orderId: string },
  idempotencyKey: string,
): Promise<CommandResult<{ orderId: string; deleted: true }>> {
  return runCommand(db, { key: idempotencyKey, type: "DeleteUnsentOrder" }, async (tx) => {
    const order = await lockOrder(tx, input.orderId);
    const rfq = await tx.query(`SELECT id FROM rfqs WHERE order_id=$1`, [order.id]);
    if (rfq.rowCount) {
      throw new CommandFailure(err("INVALID_TRANSITION", "询价已经建立，订单不能删除；请改为取消订单。"));
    }
    await audit(tx, {
      actor,
      action: "order.deleted_draft",
      objectType: "ORDER",
      objectId: order.id,
      before: { publicReference: order.public_reference, status: order.status },
    });
    await tx.query(`DELETE FROM orders WHERE id=$1`, [order.id]);
    return { orderId: order.id, deleted: true };
  });
}

export async function cancelOrder(
  db: Db,
  actor: Actor,
  input: { orderId: string; reason?: string | null },
  idempotencyKey: string,
): Promise<CommandResult<{ orderId: string; status: "CANCELLED" }>> {
  return runCommand(db, { key: idempotencyKey, type: "CancelOrder" }, async (tx) => {
    const order = await lockOrder(tx, input.orderId);
    if (order.status === "COMPLETED") {
      throw new CommandFailure(err("INVALID_TRANSITION", "已完成订单不能取消。"));
    }
    if (order.status === "CANCELLED") return { orderId: order.id, status: "CANCELLED" };

    const rfq = (await tx.query(`SELECT * FROM rfqs WHERE order_id=$1 FOR UPDATE`, [order.id])).rows[0];
    const recipients = rfq
      ? await tx.query(`SELECT * FROM rfq_recipients WHERE rfq_id=$1 FOR UPDATE`, [rfq.id])
      : { rows: [] as Record<string, any>[] };

    if (rfq) {
      await tx.query(`UPDATE rfqs SET status='CANCELLED', updated_at=now() WHERE id=$1`, [rfq.id]);
      await tx.query(
        `UPDATE rfq_recipients
            SET status='WITHDRAWN', updated_at=now()
          WHERE rfq_id=$1
            AND status IN ('PENDING','SENT','VIEWED','AWAITING_QUOTE','AWAITING_RECONFIRMATION','QUOTED')`,
        [rfq.id],
      );
      await tx.query(
        `UPDATE quotes q
            SET status=CASE WHEN q.status='SUBMITTED' THEN 'INVALIDATED'::quote_status ELSE 'WITHDRAWN'::quote_status END,
                invalidated_at=CASE WHEN q.status='SUBMITTED' THEN now() ELSE q.invalidated_at END,
                invalidated_reason=CASE WHEN q.status='SUBMITTED' THEN 'OPERATOR_ACTION'::quote_invalidated_reason ELSE q.invalidated_reason END,
                version=q.version+1,
                updated_at=now()
           FROM rfq_recipients r
          WHERE q.rfq_recipient_id=r.id AND r.rfq_id=$1
            AND q.status IN ('DRAFT','PENDING_CONFIRMATION','SUBMITTED')`,
        [rfq.id],
      );
      await tx.query(
        `UPDATE message_actions ma SET status='INVALIDATED'
          WHERE ma.status='AVAILABLE' AND (
            (ma.object_type='RFQ_RECIPIENT' AND ma.object_id IN (SELECT id FROM rfq_recipients WHERE rfq_id=$1))
            OR
            (ma.object_type='QUOTE' AND ma.object_id IN (
              SELECT q.id FROM quotes q JOIN rfq_recipients r ON r.id=q.rfq_recipient_id WHERE r.rfq_id=$1
            ))
          )`,
        [rfq.id],
      );
    }

    const cancelledBookings = await tx.query(
      `UPDATE bookings
          SET status='CANCELLED_BY_OPERATOR', cancelled_at=now(),
              cancellation_reason=$2, version=version+1, updated_at=now()
        WHERE order_id=$1
          AND status NOT IN ('COMPLETED','CANCELLED_BY_FLEET','CANCELLED_BY_CUSTOMER','CANCELLED_BY_OPERATOR')
        RETURNING id`,
      [order.id, input.reason ?? "Order cancelled by operator"],
    );
    for (const booking of cancelledBookings.rows) {
      await tx.query(
        `UPDATE shipments SET current_status='EXCEPTION', version=version+1, updated_at=now()
          WHERE booking_id=$1 AND current_status NOT IN ('COMPLETED','EXCEPTION')`,
        [booking.id],
      );
    }

    await tx.query(`UPDATE orders SET status='CANCELLED', version=version+1, updated_at=now() WHERE id=$1`, [order.id]);
    await audit(tx, {
      actor,
      action: "order.cancelled",
      objectType: "ORDER",
      objectId: order.id,
      before: { status: order.status },
      after: { status: "CANCELLED" },
      metadata: { reason: input.reason ?? null },
    });
    await emitOutbox(tx, "order.cancelled", "ORDER", order.id, {});

    for (const recipient of recipients.rows) {
      const conv = await getOrCreateConversation(tx, recipient.fleet_organization_id);
      await sendOutbound(tx, {
        conversationId: conv.id,
        senderType: "MERCURY_SYSTEM",
        messageType: "SYSTEM_NOTICE",
        text: `订单 ${order.public_reference} 已由运营人员取消。此前的询价、报价或任务操作均已停止。`,
        context: { orderId: order.id, rfqId: rfq?.id, rfqRecipientId: recipient.id, rfqRevision: rfq?.revision },
      });
    }
    return { orderId: order.id, status: "CANCELLED" };
  });
}
