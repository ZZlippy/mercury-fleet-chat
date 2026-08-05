import type { Tx } from "@mercury/db";
import { type Actor, audit, emitOutbox } from "./kernel.ts";
import { sendOutbound } from "./messaging.ts";
import { HANDOFF_TEXT } from "./cards.ts";

/** Human handoff (§13): exception + explicit no-auto-mutation notice. */
export async function requestHumanHandoff(
  tx: Tx,
  actor: Actor,
  input: {
    conversationId: string;
    type?: "AMBIGUOUS_CONTEXT" | "AMBIGUOUS_CURRENCY" | "LOW_CONFIDENCE" | "OTHER";
    summary: string;
    orderId?: string | null;
    rfqId?: string | null;
    sourceMessageId?: string | null;
    details?: Record<string, unknown>;
  },
): Promise<{ exceptionId: string }> {
  let orderId = input.orderId ?? null;
  let rfqId = input.rfqId ?? null;
  if (input.sourceMessageId && (!orderId || !rfqId)) {
    const context = (
      await tx.query(
        `SELECT order_id, rfq_id FROM message_context_links
          WHERE message_id=$1
          ORDER BY created_at DESC LIMIT 1`,
        [input.sourceMessageId],
      )
    ).rows[0];
    orderId ??= context?.order_id ?? null;
    rfqId ??= context?.rfq_id ?? null;
  }
  const exc = await tx.query(
    `INSERT INTO exception_cases (type, order_id, rfq_id, fleet_organization_id, conversation_id, source_message_id, summary, details)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [
      input.type ?? "OTHER", orderId, rfqId,
      actor.organizationId, input.conversationId, input.sourceMessageId ?? null,
      input.summary, JSON.stringify(input.details ?? {}),
    ],
  );
  await audit(tx, {
    actor, action: "exception.created", objectType: "EXCEPTION", objectId: exc.rows[0].id,
    sourceMessageId: input.sourceMessageId ?? null, metadata: { type: input.type ?? "OTHER" },
  });
  await emitOutbox(tx, "exception.created", "EXCEPTION", exc.rows[0].id, { type: input.type ?? "OTHER" });
  await sendOutbound(tx, {
    conversationId: input.conversationId,
    senderType: "MERCURY_SYSTEM",
    messageType: "HANDOFF_NOTICE",
    text: HANDOFF_TEXT,
    replyToMessageId: input.sourceMessageId ?? null,
    context: { orderId, rfqId },
  });
  return { exceptionId: exc.rows[0].id };
}
