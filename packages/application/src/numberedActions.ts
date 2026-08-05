import type { Db } from "@mercury/db";
import { withTx } from "@mercury/db";
import type { Actor } from "./kernel.ts";
import { sendOutbound } from "./messaging.ts";

export type NumberedChoiceResolution =
  | { kind: "NOT_NUMBERED" }
  | { kind: "NO_ACTIVE_MENU"; message: string }
  | { kind: "OUT_OF_RANGE"; message: string }
  | { kind: "RESOLVED"; actionId: string; number: number };

/**
 * Resolve a plain numeric reply against the newest active Action set in the
 * same task. Reply anchors and copied message context keep physical channel
 * conversations from leaking one task's menu into another task.
 */
export async function resolveNumberedChoice(
  db: Db,
  actor: Actor,
  input: { conversationId: string; sourceMessageId: string; text: string },
): Promise<NumberedChoiceResolution> {
  const normalized = input.text.trim();
  if (!/^\d{1,2}$/.test(normalized)) return { kind: "NOT_NUMBERED" };
  const choice = Number(normalized);

  return withTx(db, async (tx) => {
    const context = (
      await tx.query(
        `SELECT mcl.*
           FROM messages m
           LEFT JOIN message_context_links mcl ON mcl.message_id=m.id
          WHERE m.id=$1 AND m.conversation_id=$2 AND m.sender_user_id=$3
          LIMIT 1`,
        [input.sourceMessageId, input.conversationId, actor.userId],
      )
    ).rows[0];

    // A number can also be a quote amount. Once the user has chosen
    // “我要报价”, the task-scoped pending interaction takes precedence over
    // menu parsing, so “220” reaches the quote parser rather than becoming an
    // out-of-range option.
    const pending = await tx.query(
      `SELECT interaction_type
         FROM pending_interactions
        WHERE conversation_id=$1 AND fleet_user_id=$2 AND status='ACTIVE'
          AND (
            ($3::uuid IS NOT NULL AND shipment_id=$3)
            OR ($4::uuid IS NOT NULL AND booking_id=$4)
            OR ($5::uuid IS NOT NULL AND rfq_recipient_id=$5)
            OR ($6::uuid IS NOT NULL AND order_id=$6)
          )
        ORDER BY created_at DESC
        LIMIT 1`,
      [
        input.conversationId,
        actor.userId,
        context?.shipment_id ?? null,
        context?.booking_id ?? null,
        context?.rfq_recipient_id ?? null,
        context?.order_id ?? null,
      ],
    );
    if (
      ["AWAIT_QUOTE_AMOUNT", "AWAIT_CURRENCY"].includes(
        pending.rows[0]?.interaction_type,
      )
    ) {
      return { kind: "NOT_NUMBERED" };
    }

    const menu = (
      await tx.query(
        `SELECT m.id AS message_id
           FROM messages m
           JOIN message_context_links menu_ctx ON menu_ctx.message_id=m.id
          WHERE m.conversation_id=$1 AND m.direction='OUTBOUND'
            AND EXISTS (
              SELECT 1 FROM message_actions ma
               WHERE ma.message_id=m.id AND ma.status='AVAILABLE'
                 AND (ma.expires_at IS NULL OR ma.expires_at > now())
            )
            AND (
              ($2::uuid IS NOT NULL AND menu_ctx.shipment_id=$2)
              OR ($3::uuid IS NOT NULL AND menu_ctx.booking_id=$3)
              OR ($4::uuid IS NOT NULL AND menu_ctx.rfq_recipient_id=$4)
              OR ($5::uuid IS NOT NULL AND menu_ctx.order_id=$5)
            )
          ORDER BY m.created_at DESC
          LIMIT 1`,
        [
          input.conversationId,
          context?.shipment_id ?? null,
          context?.booking_id ?? null,
          context?.rfq_recipient_id ?? null,
          context?.order_id ?? null,
        ],
      )
    ).rows[0];

    if (!menu) {
      const message = "当前任务没有等待选择的编号问题。请查看该任务的最新消息。";
      await sendOutbound(tx, {
        conversationId: input.conversationId,
        messageType: "SYSTEM_NOTICE",
        text: message,
        replyToMessageId: input.sourceMessageId,
      });
      return { kind: "NO_ACTIVE_MENU", message };
    }

    const actions = await tx.query(
      `SELECT id
         FROM message_actions
        WHERE message_id=$1 AND status='AVAILABLE'
          AND (expires_at IS NULL OR expires_at > now())
        ORDER BY created_at, id`,
      [menu.message_id],
    );
    const action = actions.rows[choice - 1];
    if (!action) {
      const message = `编号超出范围。请回复 1 至 ${actions.rows.length}。`;
      await sendOutbound(tx, {
        conversationId: input.conversationId,
        messageType: "SYSTEM_NOTICE",
        text: message,
        replyToMessageId: menu.message_id,
      });
      return { kind: "OUT_OF_RANGE", message };
    }
    return { kind: "RESOLVED", actionId: action.id, number: choice };
  });
}
