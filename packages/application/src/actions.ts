import type { Db, Tx } from "@mercury/db";
import {
  AckPriceUnchangedPayload, BookingActionPayload,
  ConfirmQuotePayload, ConfirmShipmentStatusPayload, SelectRfqContextPayload,
  err, type CommandResult,
} from "@mercury/contracts";
import type { ShipmentStatus } from "@mercury/domain";
import { type Actor, audit, CommandFailure, lockOrderMutex, runCommand } from "./kernel.ts";
import { sendOutbound } from "./messaging.ts";
import { confirmPriceUnchanged, confirmQuote, cancelQuoteDraft, declineRfq, ackReplyLater } from "./quotes.ts";
import { acceptBooking, declineBooking } from "./booking.ts";
import { updateShipmentStatus } from "./shipment.ts";
import { requestHumanHandoff } from "./handoff.ts";
import { setTaskPendingInteraction } from "./messaging.ts";
import { handleQuoteTextForRecipient } from "./inbound.ts";

export type ConsumeOutcome =
  | { outcome: "CONSUMED"; actionType: string; result: unknown }
  | { outcome: "ALREADY_CONSUMED"; actionType: string }
  | { outcome: "STALE_REVISION"; actionType: string; message: string }
  | { outcome: "ACTION_UNAVAILABLE"; actionType: string; message: string };

interface LoadedAction {
  action: Record<string, any>;
  conversation: Record<string, any>;
}

/**
 * Action consumption used to lock the button row before the related order,
 * while an order revision locked the order before invalidating buttons. That
 * opposite order can deadlock. Resolve the action graph without row locks,
 * then take the shared order mutex before locking the button.
 */
async function lockActionOrderMutex(tx: Tx, actionId: string): Promise<void> {
  const action = (await tx.query(`SELECT object_type, object_id FROM message_actions WHERE id=$1`, [actionId])).rows[0];
  if (!action) return;

  let orderId: string | null = null;
  if (action.object_type === "RFQ_RECIPIENT") {
    orderId = (
      await tx.query(
        `SELECT f.order_id
           FROM rfq_recipients r JOIN rfqs f ON f.id=r.rfq_id
          WHERE r.id=$1`,
        [action.object_id],
      )
    ).rows[0]?.order_id ?? null;
  } else if (action.object_type === "QUOTE") {
    orderId = (
      await tx.query(
        `SELECT f.order_id
           FROM quotes q
           JOIN rfq_recipients r ON r.id=q.rfq_recipient_id
           JOIN rfqs f ON f.id=r.rfq_id
          WHERE q.id=$1`,
        [action.object_id],
      )
    ).rows[0]?.order_id ?? null;
  } else if (action.object_type === "BOOKING") {
    orderId = (await tx.query(`SELECT order_id FROM bookings WHERE id=$1`, [action.object_id])).rows[0]?.order_id ?? null;
  } else if (action.object_type === "SHIPMENT") {
    orderId = (
      await tx.query(
        `SELECT b.order_id FROM shipments s JOIN bookings b ON b.id=s.booking_id WHERE s.id=$1`,
        [action.object_id],
      )
    ).rows[0]?.order_id ?? null;
  }
  if (orderId) await lockOrderMutex(tx, orderId);
}

async function loadActionForUpdate(tx: Tx, actionId: string, actor: Actor): Promise<LoadedAction> {
  const r = await tx.query(
    `SELECT ma.*, m.conversation_id, m.reply_to_message_id AS prompt_reply_to_message_id,
            c.fleet_organization_id, c.id AS conv_id
       FROM message_actions ma
       JOIN messages m ON m.id=ma.message_id
       JOIN conversations c ON c.id=m.conversation_id
      WHERE ma.id=$1
      FOR UPDATE OF ma`,
    [actionId],
  );
  if (!r.rowCount) throw new CommandFailure(err("NOT_FOUND", "Action not found"));
  const row = r.rows[0];
  // Cross-org isolation: the conversation's fleet must match the session org (§17).
  if (row.fleet_organization_id !== actor.organizationId) {
    throw new CommandFailure(err("FORBIDDEN", "Action does not belong to your organization"));
  }
  return { action: row, conversation: { id: row.conv_id, fleet_organization_id: row.fleet_organization_id } };
}

/** Current order/rfq versions for the action's object, if RFQ-scoped. */
async function currentVersions(
  tx: Tx,
  action: Record<string, any>,
): Promise<{ orderVersion: number | null; rfqRevision: number | null; objectVersion: number | null }> {
  let objectVersion: number | null = null;
  if (action.expected_object_version != null) {
    const tables: Record<string, string> = {
      BOOKING: "bookings",
      SHIPMENT: "shipments",
      QUOTE: "quotes",
    };
    const table = tables[action.object_type];
    if (table) {
      const object = await tx.query(`SELECT version FROM ${table} WHERE id=$1`, [action.object_id]);
      objectVersion = object.rows[0]?.version ?? null;
    }
  }

  if (action.expected_rfq_revision == null && action.expected_order_version == null) {
    return { orderVersion: null, rfqRevision: null, objectVersion };
  }
  let recipientId: string | null = null;
  if (action.object_type === "RFQ_RECIPIENT") recipientId = action.object_id;
  if (action.object_type === "QUOTE") {
    const q = await tx.query(`SELECT rfq_recipient_id FROM quotes WHERE id=$1`, [action.object_id]);
    recipientId = q.rows[0]?.rfq_recipient_id ?? null;
  }
  if (!recipientId) return { orderVersion: null, rfqRevision: null, objectVersion };
  const r = await tx.query(
    `SELECT o.version AS order_version, f.revision AS rfq_revision
       FROM rfq_recipients rr JOIN rfqs f ON f.id=rr.rfq_id JOIN orders o ON o.id=f.order_id
      WHERE rr.id=$1`,
    [recipientId],
  );
  if (!r.rowCount) return { orderVersion: null, rfqRevision: null, objectVersion };
  return {
    orderVersion: r.rows[0].order_version,
    rfqRevision: r.rows[0].rfq_revision,
    objectVersion,
  };
}

/**
 * ConsumeMessageAction (§16.2). Key properties:
 * - idempotency key derives from the action ID (§9.2): a double click returns
 *   the original result and never duplicates the business change;
 * - stale actions produce a typed STALE_REVISION result, no business change,
 *   and a friendly conversational explanation (§11.7);
 * - consumption + business change + audit + outbox are one transaction.
 */
export async function consumeMessageAction(
  db: Db,
  actor: Actor,
  input: { actionId: string; clientIdempotencyKey: string },
): Promise<CommandResult<ConsumeOutcome>> {
  return runCommand(
    db,
    { key: `action-consume:${input.actionId}`, type: "ConsumeMessageAction" },
    async (tx): Promise<ConsumeOutcome> => {
      await lockActionOrderMutex(tx, input.actionId);
      const { action, conversation } = await loadActionForUpdate(tx, input.actionId, actor);

      if (action.status === "CONSUMED") {
        return { outcome: "ALREADY_CONSUMED", actionType: action.action_type };
      }
      if (action.status !== "AVAILABLE" || (action.expires_at && new Date(action.expires_at) < new Date())) {
        const msg = "这个选项已经不能用了，请看这条任务里最新的消息再操作。";
        // Reply to the message that carried the button so the explanation
        // inherits that message's task context and lands in the same task
        // conversation the dispatcher is looking at.
        await sendOutbound(tx, {
          conversationId: conversation.id, messageType: "SYSTEM_NOTICE", text: msg,
          replyToMessageId: action.message_id,
        });
        return { outcome: "ACTION_UNAVAILABLE", actionType: action.action_type, message: msg };
      }

      // Version guard (§8.4): expected_* must match current state.
      const versions = await currentVersions(tx, action);
      const stale =
        (action.expected_order_version != null && action.expected_order_version !== versions.orderVersion) ||
        (action.expected_rfq_revision != null && action.expected_rfq_revision !== versions.rfqRevision) ||
        (action.expected_object_version != null && action.expected_object_version !== versions.objectVersion);
      if (stale) {
        await tx.query(`UPDATE message_actions SET status='INVALIDATED' WHERE id=$1`, [action.id]);
        const msg = "订单条件已更新，此操作不再有效，刚才的点击没有改动任何内容。请查看最新消息后重新操作。";
        await sendOutbound(tx, {
          conversationId: conversation.id, messageType: "SYSTEM_NOTICE", text: msg,
          replyToMessageId: action.message_id,
        });
        await audit(tx, {
          actor, action: "action.stale_rejected", objectType: "MESSAGE_ACTION", objectId: action.id,
          metadata: {
            expected: {
              orderVersion: action.expected_order_version,
              rfqRevision: action.expected_rfq_revision,
              objectVersion: action.expected_object_version,
            },
            current: versions,
          },
        });
        return { outcome: "STALE_REVISION", actionType: action.action_type, message: msg };
      }

      const result = await dispatch(tx, actor, conversation.id, action, input.clientIdempotencyKey);

      await tx.query(
        `UPDATE message_actions SET status='CONSUMED', consumed_at=now(), consumed_by_user_id=$2 WHERE id=$1`,
        [action.id, actor.userId],
      );
      // Every action set currently rendered by Mercury is single-choice.
      // Consuming one option atomically invalidates its siblings so a delayed
      // second click cannot execute a contradictory command.
      await tx.query(
        `UPDATE message_actions
            SET status='INVALIDATED'
          WHERE message_id=$1 AND id<>$2 AND status='AVAILABLE'`,
        [action.message_id, action.id],
      );
      await audit(tx, {
        actor, action: "action.consumed", objectType: "MESSAGE_ACTION", objectId: action.id,
        metadata: { actionType: action.action_type, clientIdempotencyKey: input.clientIdempotencyKey },
      });
      return { outcome: "CONSUMED", actionType: action.action_type, result };
    },
  );
}

async function dispatch(
  tx: Tx,
  actor: Actor,
  conversationId: string,
  action: Record<string, any>,
  _clientKey: string,
): Promise<unknown> {
  const payload = action.payload ?? {};
  switch (action.action_type) {
    case "CONFIRM_QUOTE": {
      const p = ConfirmQuotePayload.parse(payload);
      return confirmQuote(tx, actor, { conversationId, quoteId: p.quoteId, sourceActionId: action.id });
    }
    case "CANCEL_QUOTE_DRAFT": {
      const p = ConfirmQuotePayload.parse(payload);
      return cancelQuoteDraft(tx, actor, { conversationId, quoteId: p.quoteId });
    }
    case "ACK_PRICE_UNCHANGED": {
      const p = AckPriceUnchangedPayload.parse(payload);
      return confirmPriceUnchanged(tx, actor, {
        conversationId, invalidatedQuoteId: p.invalidatedQuoteId, rfqRecipientId: p.rfqRecipientId, viaActionId: action.id,
      });
    }
    case "MODIFY_QUOTE": {
      // Starts the free-form quote flow: remember which RFQ the next price applies to.
      await setTaskPendingInteraction(tx, {
        conversationId,
        fleetUserId: actor.userId!,
        rfqRecipientId: action.object_id,
        sourceMessageId: action.message_id,
        interactionType: "AWAIT_QUOTE_AMOUNT",
        expectedOrderVersion: action.expected_order_version,
        expectedRfqRevision: action.expected_rfq_revision,
        payload: {},
      });
      await sendOutbound(tx, {
        conversationId, messageType: "TEXT",
        text: "请回复报价金额，例如：220全包 或 USD 220。",
        context: { rfqRecipientId: action.object_id },
      });
      return { awaiting: "QUOTE_AMOUNT" };
    }
    case "DECLINE_RFQ":
      return declineRfq(tx, actor, { conversationId, rfqRecipientId: action.object_id, reason: "车队通过编号选项选择无法承运" });
    case "ACK_REPLY_LATER":
      return ackReplyLater(tx, actor, { conversationId, rfqRecipientId: action.object_id });
    case "ACCEPT_BOOKING": {
      const p = BookingActionPayload.parse(payload);
      return acceptBooking(tx, actor, { conversationId, bookingId: p.bookingId });
    }
    case "DECLINE_BOOKING": {
      const p = BookingActionPayload.parse(payload);
      return declineBooking(tx, actor, { conversationId, bookingId: p.bookingId });
    }
    case "CONFIRM_SHIPMENT_STATUS": {
      const p = ConfirmShipmentStatusPayload.parse(payload);
      return updateShipmentStatus(tx, actor, {
        conversationId, shipmentId: p.shipmentId, toStatus: p.toStatus as ShipmentStatus,
        eventKey: `action:${action.id}`,
      });
    }
    case "REQUEST_HUMAN":
      return requestHumanHandoff(tx, actor, {
        conversationId,
        sourceMessageId: action.message_id,
        summary: "Fleet requested operator via numbered choice",
        details: { actionId: action.id },
      });
    case "SELECT_RFQ_CONTEXT": {
      const p = SelectRfqContextPayload.parse(payload);
      // Re-run the deferred quote text against the chosen RFQ context.
      return handleQuoteTextForRecipient(tx, actor, {
        conversationId,
        rfqRecipientId: p.rfqRecipientId,
        text: p.pendingText,
        sourceMessageId: p.sourceMessageId ?? action.prompt_reply_to_message_id ?? null,
      });
    }
    default:
      throw new CommandFailure(err("VALIDATION", `Unsupported action type ${action.action_type}`));
  }
}
