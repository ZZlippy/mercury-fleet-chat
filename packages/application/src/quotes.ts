import type { Tx } from "@mercury/db";
import { err } from "@mercury/contracts";
import { canQuoteTransition, formatMoney } from "@mercury/domain";
import { type Actor, audit, CommandFailure, emitOutbox, fmtTs, lockOrderMutex } from "./kernel.ts";
import { sendOutbound } from "./messaging.ts";
import { quoteConfirmationCard, type OrderRow } from "./cards.ts";

export interface RecipientCtx {
  recipient: Record<string, any>;
  rfq: Record<string, any>;
  order: OrderRow & Record<string, any>;
}

/** Resolve the graph, then lock order → RFQ → recipient in one consistent order. */
export async function lockRecipientCtx(tx: Tx, rfqRecipientId: string): Promise<RecipientCtx> {
  const graph = await tx.query(
    `SELECT r.rfq_id, f.order_id
       FROM rfq_recipients r JOIN rfqs f ON f.id=r.rfq_id
      WHERE r.id=$1`,
    [rfqRecipientId],
  );
  if (!graph.rowCount) throw new CommandFailure(err("NOT_FOUND", "RFQ recipient not found"));
  await lockOrderMutex(tx, graph.rows[0].order_id);
  const order = (await tx.query(`SELECT * FROM orders WHERE id=$1 FOR UPDATE`, [graph.rows[0].order_id])).rows[0];
  const rfq = (await tx.query(`SELECT * FROM rfqs WHERE id=$1 FOR UPDATE`, [graph.rows[0].rfq_id])).rows[0];
  const recipient = (await tx.query(`SELECT * FROM rfq_recipients WHERE id=$1 FOR UPDATE`, [rfqRecipientId])).rows[0];
  return { recipient, rfq, order };
}

export function assertRecipientBelongsTo(recipient: Record<string, any>, fleetOrganizationId: string): void {
  if (recipient.fleet_organization_id !== fleetOrganizationId) {
    throw new CommandFailure(err("FORBIDDEN", "RFQ does not belong to your organization"));
  }
}

/**
 * Create a quote awaiting explicit human confirmation (§10.2, §11.2).
 * Currency must already be resolved by the caller (EXPLICIT or DEFAULTED) —
 * ambiguous input never reaches this function.
 */
export async function proposeQuoteDraft(
  tx: Tx,
  actor: Actor,
  input: {
    conversationId: string;
    rfqRecipientId: string;
    amount: string;
    currency: string;
    currencySource: "EXPLICIT" | "DEFAULTED";
    isAllIn: boolean | null;
    terms: string | null;
    sourceMessageId: string | null;
  },
): Promise<{ quoteId: string; messageId: string }> {
  const { recipient, rfq, order } = await lockRecipientCtx(tx, input.rfqRecipientId);
  assertRecipientBelongsTo(recipient, actor.organizationId!);
  if (rfq.status !== "ACTIVE") throw new CommandFailure(err("INVALID_TRANSITION", "询价已关闭，无法报价。"));
  if (["DECLINED", "WITHDRAWN", "EXPIRED"].includes(recipient.status)) {
    throw new CommandFailure(err("INVALID_TRANSITION", "该询价已结束，无法报价。"));
  }

  // Replace any unconfirmed draft the dispatcher already has for this revision.
  await tx.query(
    `UPDATE quotes SET status='WITHDRAWN', updated_at=now()
      WHERE rfq_recipient_id=$1 AND based_on_rfq_revision=$2 AND status IN ('DRAFT','PENDING_CONFIRMATION')`,
    [recipient.id, rfq.revision],
  );
  // If a SUBMITTED quote is active for this revision, the new one starts as
  // DRAFT (outside the active-uniqueness index); confirming it atomically
  // withdraws the old quote (see confirmQuote).
  const hasActiveSubmitted = (
    await tx.query(
      `SELECT id FROM quotes WHERE rfq_recipient_id=$1 AND based_on_rfq_revision=$2 AND status='SUBMITTED'`,
      [recipient.id, rfq.revision],
    )
  ).rowCount;

  const quote = (
    await tx.query(
      `INSERT INTO quotes (
         rfq_recipient_id, based_on_order_version, based_on_rfq_revision, status,
         amount, currency, currency_source, is_all_in, vehicle_available,
         available_from, valid_until, terms, source_message_id, created_by_user_id
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true,$9,$10,$11,$12,$13)
       RETURNING *`,
      [
        recipient.id, order.version, rfq.revision,
        hasActiveSubmitted ? "DRAFT" : "PENDING_CONFIRMATION",
        input.amount, input.currency, input.currencySource, input.isAllIn,
        order.requested_start_at ?? order.pickup_at,
        rfq.expires_at ?? null,
        input.terms,
        input.sourceMessageId,
        actor.userId,
      ],
    )
  ).rows[0];
  await audit(tx, {
    actor, action: "quote.drafted", objectType: "QUOTE", objectId: quote.id,
    sourceMessageId: input.sourceMessageId,
    after: { amount: input.amount, currency: input.currency, currencySource: input.currencySource, rfqRevision: rfq.revision },
  });

  const card = quoteConfirmationCard({
    rfqRef: rfq.public_reference,
    amount: input.amount,
    currency: input.currency,
    currencySource: input.currencySource,
    isAllIn: input.isAllIn,
    terms: input.terms,
    pickupAt: order.pickup_at,
  });
  const { messageId } = await sendOutbound(tx, {
    conversationId: input.conversationId,
    messageType: "BUSINESS_CARD",
    text: card.text,
    structured: card.structured,
    replyToMessageId: input.sourceMessageId,
    context: { orderId: order.id, rfqId: rfq.id, rfqRecipientId: recipient.id, quoteId: quote.id, rfqRevision: rfq.revision },
    actions: [
      {
        actionType: "CONFIRM_QUOTE", label: "确认提交", objectType: "QUOTE", objectId: quote.id,
        expectedOrderVersion: order.version, expectedRfqRevision: rfq.revision,
        payload: { quoteId: quote.id, rfqRecipientId: recipient.id },
      },
      {
        actionType: "MODIFY_QUOTE", label: "修改报价", objectType: "RFQ_RECIPIENT", objectId: recipient.id,
        expectedOrderVersion: order.version, expectedRfqRevision: rfq.revision,
      },
      {
        actionType: "CANCEL_QUOTE_DRAFT", label: "取消报价", objectType: "QUOTE", objectId: quote.id,
        expectedOrderVersion: order.version, expectedRfqRevision: rfq.revision,
        payload: { quoteId: quote.id, rfqRecipientId: recipient.id },
      },
    ],
  });
  return { quoteId: quote.id, messageId };
}

/** CONFIRM_QUOTE action handler — the only path from draft to SUBMITTED (§11.2). */
export async function confirmQuote(
  tx: Tx,
  actor: Actor,
  input: { conversationId: string; quoteId: string; sourceActionId: string },
): Promise<{ quoteId: string; status: string }> {
  const candidate = (await tx.query(`SELECT rfq_recipient_id FROM quotes WHERE id=$1`, [input.quoteId])).rows[0];
  if (!candidate) throw new CommandFailure(err("NOT_FOUND", "Quote not found"));
  const { recipient, rfq, order } = await lockRecipientCtx(tx, candidate.rfq_recipient_id);
  const q = (await tx.query(`SELECT * FROM quotes WHERE id=$1 FOR UPDATE`, [input.quoteId])).rows[0];
  assertRecipientBelongsTo(recipient, actor.organizationId!);

  if (!["DRAFT", "PENDING_CONFIRMATION"].includes(q.status)) {
    throw new CommandFailure(err("INVALID_TRANSITION", `报价状态为 ${q.status}，无法提交。`));
  }
  // Version guard (defense in depth; action-level guard runs first).
  if (q.based_on_order_version !== order.version || q.based_on_rfq_revision !== rfq.revision) {
    throw new CommandFailure(err("STALE_REVISION", "订单条件已更新，该报价草稿已失效。"));
  }
  if (!canQuoteTransition(q.status, "SUBMITTED")) {
    throw new CommandFailure(err("INVALID_TRANSITION", `Cannot submit from ${q.status}`));
  }

  // Replace flow: withdrawing the previously SUBMITTED quote and submitting
  // the new one is a single transaction (uniqueness index stays satisfied).
  const prev = (
    await tx.query(
      `UPDATE quotes SET status='WITHDRAWN', updated_at=now()
        WHERE rfq_recipient_id=$1 AND based_on_rfq_revision=$2 AND status='SUBMITTED' AND id<>$3
        RETURNING id`,
      [recipient.id, rfq.revision, q.id],
    )
  ).rows[0];
  if (prev) {
    await tx.query(`UPDATE quotes SET supersedes_quote_id=$2, updated_at=now() WHERE id=$1`, [q.id, prev.id]);
    await tx.query(`UPDATE quotes SET superseded_by_quote_id=$2, updated_at=now() WHERE id=$1`, [prev.id, q.id]);
    await audit(tx, { actor, action: "quote.withdrawn_replaced", objectType: "QUOTE", objectId: prev.id, metadata: { replacedBy: q.id } });
  }

  await tx.query(
    `UPDATE quotes SET status='SUBMITTED', submitted_at=now(), currency_confirmed_at=now(), version=version+1, updated_at=now()
      WHERE id=$1`,
    [q.id],
  );
  // Confirming a card that displays the latest revision's conditions is the
  // explicit acknowledgment required by §7.3 (documented interpretation).
  await tx.query(
    `UPDATE rfq_recipients SET status='QUOTED', acknowledged_revision=$2, responded_at=COALESCE(responded_at, now()), updated_at=now()
      WHERE id=$1`,
    [recipient.id, rfq.revision],
  );
  await audit(tx, {
    actor, action: "quote.submitted", objectType: "QUOTE", objectId: q.id,
    after: { amount: q.amount, currency: q.currency, orderVersion: order.version, rfqRevision: rfq.revision },
    metadata: { viaActionId: input.sourceActionId },
  });
  await emitOutbox(tx, "quote.submitted", "QUOTE", q.id, { rfqId: rfq.id, amount: q.amount, currency: q.currency });

  await sendOutbound(tx, {
    conversationId: input.conversationId,
    messageType: "SYSTEM_NOTICE",
    text: `报价已提交：${formatMoney(q.currency, q.amount)}（${rfq.public_reference}）。我们会在选定后通知你。`,
    context: { rfqId: rfq.id, rfqRecipientId: recipient.id, quoteId: q.id, rfqRevision: rfq.revision },
  });
  return { quoteId: q.id, status: "SUBMITTED" };
}

export async function cancelQuoteDraft(
  tx: Tx,
  actor: Actor,
  input: { conversationId: string; quoteId: string },
): Promise<{ quoteId: string; status: string }> {
  const candidate = (await tx.query(`SELECT rfq_recipient_id FROM quotes WHERE id=$1`, [input.quoteId])).rows[0];
  if (!candidate) throw new CommandFailure(err("NOT_FOUND", "Quote not found"));
  const { recipient, rfq } = await lockRecipientCtx(tx, candidate.rfq_recipient_id);
  const q = (await tx.query(`SELECT * FROM quotes WHERE id=$1 FOR UPDATE`, [input.quoteId])).rows[0];
  assertRecipientBelongsTo(recipient, actor.organizationId!);
  if (!["DRAFT", "PENDING_CONFIRMATION"].includes(q.status)) {
    throw new CommandFailure(err("INVALID_TRANSITION", `报价状态为 ${q.status}，无法取消。`));
  }
  await tx.query(`UPDATE quotes SET status='WITHDRAWN', updated_at=now() WHERE id=$1`, [q.id]);
  await audit(tx, { actor, action: "quote.draft_cancelled", objectType: "QUOTE", objectId: q.id });
  await sendOutbound(tx, {
    conversationId: input.conversationId,
    messageType: "SYSTEM_NOTICE",
    text: `已取消报价草稿。如需重新报价，直接回复价格即可（${rfq.public_reference}）。`,
    context: { rfqId: rfq.id, rfqRecipientId: recipient.id, rfqRevision: rfq.revision },
  });
  return { quoteId: q.id, status: "WITHDRAWN" };
}

export async function declineRfq(
  tx: Tx,
  actor: Actor,
  input: { conversationId: string; rfqRecipientId: string; reason: string | null; sourceMessageId?: string | null },
): Promise<{ rfqRecipientId: string; status: string }> {
  const { recipient, rfq } = await lockRecipientCtx(tx, input.rfqRecipientId);
  assertRecipientBelongsTo(recipient, actor.organizationId!);
  if (["DECLINED", "WITHDRAWN"].includes(recipient.status)) {
    return { rfqRecipientId: recipient.id, status: recipient.status };
  }
  await tx.query(
    `UPDATE rfq_recipients SET status='DECLINED', decline_reason=$2, responded_at=now(), updated_at=now() WHERE id=$1`,
    [recipient.id, input.reason],
  );
  // Retain every quote as history, but make all active quotes unselectable.
  const withdrawn = await tx.query(
    `UPDATE quotes SET status='WITHDRAWN', updated_at=now()
      WHERE rfq_recipient_id=$1 AND status IN ('DRAFT','PENDING_CONFIRMATION','SUBMITTED')
      RETURNING id`,
    [recipient.id],
  );
  for (const quote of withdrawn.rows) {
    await audit(tx, {
      actor,
      action: "quote.withdrawn_fleet_declined",
      objectType: "QUOTE",
      objectId: quote.id,
      sourceMessageId: input.sourceMessageId ?? null,
      metadata: { rfqRecipientId: recipient.id },
    });
  }
  await tx.query(
    `UPDATE message_actions SET status='INVALIDATED'
      WHERE status='AVAILABLE' AND object_type='RFQ_RECIPIENT' AND object_id=$1`,
    [recipient.id],
  );
  await audit(tx, {
    actor, action: "rfq_recipient.declined", objectType: "RFQ_RECIPIENT", objectId: recipient.id,
    sourceMessageId: input.sourceMessageId ?? null, after: { reason: input.reason },
  });
  await emitOutbox(tx, "rfq.declined", "RFQ_RECIPIENT", recipient.id, {});
  const remaining = await tx.query(
    `SELECT 1 FROM rfq_recipients
      WHERE rfq_id=$1
        AND status IN ('PENDING','SENT','VIEWED','AWAITING_QUOTE','AWAITING_RECONFIRMATION','QUOTED')
      LIMIT 1`,
    [rfq.id],
  );
  if (!remaining.rowCount) {
    const exception = await tx.query(
      `INSERT INTO exception_cases (
         type, order_id, rfq_id, fleet_organization_id, conversation_id,
         source_message_id, summary, details
       )
       SELECT 'NO_FLEET_RESPONSE', f.order_id, f.id, $2, $3, $4,
              '所有受邀车队均已拒绝承运，需要运营人员处理。',
              jsonb_build_object('reason','ALL_FLEETS_DECLINED')
         FROM rfqs f
        WHERE f.id=$1
          AND NOT EXISTS (
            SELECT 1 FROM exception_cases e
             WHERE e.rfq_id=f.id AND e.type='NO_FLEET_RESPONSE' AND e.status IN ('OPEN','IN_PROGRESS')
          )
       RETURNING id`,
      [rfq.id, actor.organizationId, input.conversationId, input.sourceMessageId ?? null],
    );
    if (exception.rowCount) {
      await audit(tx, {
        actor,
        action: "exception.created",
        objectType: "EXCEPTION",
        objectId: exception.rows[0].id,
        sourceMessageId: input.sourceMessageId ?? null,
        metadata: { type: "NO_FLEET_RESPONSE", reason: "ALL_FLEETS_DECLINED" },
      });
      await emitOutbox(tx, "exception.created", "EXCEPTION", exception.rows[0].id, {
        type: "NO_FLEET_RESPONSE",
        reason: "ALL_FLEETS_DECLINED",
      });
    }
  }
  await sendOutbound(tx, {
    conversationId: input.conversationId,
    messageType: "SYSTEM_NOTICE",
    text: `已记录：${rfq.public_reference} 无法承运。感谢回复。`,
    context: { rfqId: rfq.id, rfqRecipientId: recipient.id, rfqRevision: rfq.revision },
  });
  return { rfqRecipientId: recipient.id, status: "DECLINED" };
}

export async function ackReplyLater(
  tx: Tx,
  actor: Actor,
  input: { conversationId: string; rfqRecipientId: string; sourceMessageId?: string | null },
): Promise<{ rfqRecipientId: string; status: string }> {
  const { recipient, rfq } = await lockRecipientCtx(tx, input.rfqRecipientId);
  assertRecipientBelongsTo(recipient, actor.organizationId!);
  if (["SENT", "VIEWED"].includes(recipient.status)) {
    await tx.query(`UPDATE rfq_recipients SET status='AWAITING_QUOTE', updated_at=now() WHERE id=$1`, [recipient.id]);
  }
  await audit(tx, {
    actor, action: "rfq_recipient.reply_later", objectType: "RFQ_RECIPIENT", objectId: recipient.id,
    sourceMessageId: input.sourceMessageId ?? null,
  });
  await sendOutbound(tx, {
    conversationId: input.conversationId,
    messageType: "SYSTEM_NOTICE",
    text: `好的，等你回复（${rfq.public_reference}）。`,
    context: { rfqId: rfq.id, rfqRecipientId: recipient.id, rfqRevision: rfq.revision },
  });
  return { rfqRecipientId: recipient.id, status: "AWAITING_QUOTE" };
}

/**
 * "价格不变" reconfirmation (§11.6): creates a NEW SUBMITTED quote copying the
 * invalidated quote's commercial terms, bound to the current versions, linked
 * both ways via supersession. Skips the confirmation card — the prior quote's
 * terms were already explicitly confirmed and are restated in the reply.
 */
export async function confirmPriceUnchanged(
  tx: Tx,
  actor: Actor,
  input: { conversationId: string; invalidatedQuoteId: string; rfqRecipientId: string; sourceMessageId?: string | null; viaActionId?: string },
): Promise<{ newQuoteId: string; amount: string; currency: string }> {
  const candidate = (await tx.query(`SELECT rfq_recipient_id FROM quotes WHERE id=$1`, [input.invalidatedQuoteId])).rows[0];
  if (!candidate) throw new CommandFailure(err("NOT_FOUND", "Previous quote not found"));
  if (candidate.rfq_recipient_id !== input.rfqRecipientId) {
    throw new CommandFailure(err("VALIDATION", "Quote does not belong to this RFQ recipient"));
  }
  const { recipient, rfq, order } = await lockRecipientCtx(tx, input.rfqRecipientId);
  const old = (await tx.query(`SELECT * FROM quotes WHERE id=$1 FOR UPDATE`, [input.invalidatedQuoteId])).rows[0];
  if (old.status !== "INVALIDATED" || old.invalidated_reason !== "ORDER_CHANGED") {
    throw new CommandFailure(err("INVALID_TRANSITION", "价格不变 仅适用于因订单变更而失效的报价。"));
  }
  if (old.superseded_by_quote_id) {
    throw new CommandFailure(err("CONFLICT", "该报价已重新确认过。"));
  }
  assertRecipientBelongsTo(recipient, actor.organizationId!);
  if (rfq.status !== "ACTIVE") throw new CommandFailure(err("INVALID_TRANSITION", "询价已关闭。"));

  const created = (
    await tx.query(
      `INSERT INTO quotes (rfq_recipient_id, based_on_order_version, based_on_rfq_revision, status,
                           amount, currency, currency_source, currency_confirmed_at, is_all_in, terms,
                           source_message_id, submitted_at, supersedes_quote_id, created_by_user_id)
       VALUES ($1,$2,$3,'SUBMITTED',$4,$5,'INHERITED',now(),$6,$7,$8,now(),$9,$10) RETURNING *`,
      [
        recipient.id, order.version, rfq.revision,
        old.amount, old.currency, old.is_all_in, old.terms,
        input.sourceMessageId ?? null, old.id, actor.userId,
      ],
    )
  ).rows[0];
  // The only permitted mutation of an INVALIDATED quote: the supersession link (§7.4).
  await tx.query(`UPDATE quotes SET superseded_by_quote_id=$2, updated_at=now() WHERE id=$1`, [old.id, created.id]);
  await tx.query(
    `UPDATE rfq_recipients SET status='QUOTED', acknowledged_revision=$2, responded_at=now(), updated_at=now() WHERE id=$1`,
    [recipient.id, rfq.revision],
  );
  await audit(tx, {
    actor, action: "quote.reconfirmed_price_unchanged", objectType: "QUOTE", objectId: created.id,
    sourceMessageId: input.sourceMessageId ?? null,
    after: { amount: created.amount, currency: created.currency, supersedes: old.id, orderVersion: order.version, rfqRevision: rfq.revision },
    metadata: { viaActionId: input.viaActionId ?? null },
  });
  await emitOutbox(tx, "quote.submitted", "QUOTE", created.id, { rfqId: rfq.id, reconfirmation: true });

  await sendOutbound(tx, {
    conversationId: input.conversationId,
    messageType: "SYSTEM_NOTICE",
    text: `已确认新报价 ${formatMoney(created.currency, created.amount)}，该报价适用于更新后的条件（提货时间：${fmtTs(order.pickup_at)}）。`,
    context: { rfqId: rfq.id, rfqRecipientId: recipient.id, quoteId: created.id, rfqRevision: rfq.revision },
  });
  return { newQuoteId: created.id, amount: created.amount, currency: created.currency };
}
