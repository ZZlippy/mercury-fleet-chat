import type { Db, Tx } from "@mercury/db";
import { withTx } from "@mercury/db";
import { err, type CommandResult } from "@mercury/contracts";
import { parseQuoteText, resolveCurrency, type ShipmentStatus } from "@mercury/domain";
import { getInterpreter } from "@mercury/ai";
import { type Actor, audit, CommandFailure, fmtTs, runCommand } from "./kernel.ts";
import {
  findTaskPendingInteraction,
  linkInbound,
  resolveTaskPendingInteraction,
  sendOutbound,
  setTaskPendingInteraction,
} from "./messaging.ts";
import { proposeQuoteDraft, declineRfq, ackReplyLater, confirmPriceUnchanged } from "./quotes.ts";
import { proposeShipmentStatus } from "./shipment.ts";
import { requestHumanHandoff } from "./handoff.ts";

// ---------------------------------------------------------------- persistence first (§8.2)

/** Persist the inbound message before any interpretation. Deduped on clientMessageId. */
export async function recordInbound(
  db: Db,
  actor: Actor,
  input: { conversationId: string; clientMessageId: string; text: string; replyToMessageId?: string | null },
): Promise<{ messageId: string; duplicate: boolean }> {
  return withTx(db, async (tx) => {
    const conv = await tx.query(`SELECT fleet_organization_id FROM conversations WHERE id=$1`, [input.conversationId]);
    if (!conv.rowCount) throw new CommandFailure(err("NOT_FOUND", "Conversation not found"));
    if (conv.rows[0].fleet_organization_id !== actor.organizationId) {
      throw new CommandFailure(err("FORBIDDEN", "Not your conversation"));
    }
    const ins = await tx.query(
      `INSERT INTO messages (conversation_id, direction, sender_type, sender_user_id, message_type, text_content, external_message_id, reply_to_message_id, delivery_status)
       VALUES ($1,'INBOUND','FLEET_USER',$2,'TEXT',$3,$4,$5,'DELIVERED')
       ON CONFLICT (conversation_id, external_message_id) WHERE external_message_id IS NOT NULL DO NOTHING
       RETURNING id`,
      [input.conversationId, actor.userId, input.text, input.clientMessageId, input.replyToMessageId ?? null],
    );
    if (ins.rowCount) {
      if (input.replyToMessageId) {
        await tx.query(
          `INSERT INTO message_context_links (
             message_id, order_id, rfq_id, rfq_recipient_id, quote_id,
             booking_id, shipment_id, rfq_revision
           )
           SELECT $1, order_id, rfq_id, rfq_recipient_id, quote_id,
                  booking_id, shipment_id, rfq_revision
             FROM message_context_links
            WHERE message_id=$2
            ORDER BY created_at, id
            LIMIT 1
           ON CONFLICT (message_id) DO NOTHING`,
          [ins.rows[0].id, input.replyToMessageId],
        );
      }
      await tx.query(`UPDATE conversations SET last_message_at=now(), updated_at=now() WHERE id=$1`, [input.conversationId]);
      return { messageId: ins.rows[0].id, duplicate: false };
    }
    const existing = await tx.query(
      `SELECT id FROM messages WHERE conversation_id=$1 AND external_message_id=$2`,
      [input.conversationId, input.clientMessageId],
    );
    return { messageId: existing.rows[0].id, duplicate: true };
  });
}

// ---------------------------------------------------------------- context resolution (§8.3)

interface CandidateRecipient {
  id: string;
  status: string;
  fleet_organization_id: string;
  rfq_id: string;
  rfq_ref: string;
  rfq_status: string;
  revision: number;
  order_id: string;
  order_ref: string;
  order_version: number;
  pickup_at: string;
  route: string;
}

async function pendingRecipients(tx: Tx, fleetOrgId: string): Promise<CandidateRecipient[]> {
  const r = await tx.query(
    `SELECT rr.id, rr.status, rr.fleet_organization_id,
            f.id AS rfq_id, f.public_reference AS rfq_ref, f.status AS rfq_status, f.revision,
            o.id AS order_id, o.public_reference AS order_ref, o.version AS order_version, o.pickup_at,
            (o.pickup_location_text || ' → ' || o.delivery_location_text) AS route
       FROM rfq_recipients rr
       JOIN rfqs f ON f.id=rr.rfq_id AND f.status='ACTIVE'
       JOIN orders o ON o.id=f.order_id
      WHERE rr.fleet_organization_id=$1
        AND rr.status IN ('SENT','VIEWED','AWAITING_QUOTE','AWAITING_RECONFIRMATION','QUOTED')
      ORDER BY rr.updated_at DESC`,
    [fleetOrgId],
  );
  return r.rows;
}

async function replyContext(tx: Tx, replyToMessageId: string | null | undefined) {
  if (!replyToMessageId) return null;
  const r = await tx.query(
    `SELECT mcl.*, f.revision AS current_revision, f.public_reference AS rfq_ref
       FROM message_context_links mcl
       LEFT JOIN rfqs f ON f.id=mcl.rfq_id
      WHERE mcl.message_id=$1
      ORDER BY mcl.created_at, mcl.id
      LIMIT 1`,
    [replyToMessageId],
  );
  return r.rows[0] ?? null;
}

function referencedRef(text: string): string | null {
  const m = text.match(/\b(RFQ-\w+|[A-Z]{1,3}-\d{3,})\b/);
  return m ? m[1] : null;
}

// ---------------------------------------------------------------- quote text handling

/**
 * Turn free-form quote text into a PENDING_CONFIRMATION quote for a specific
 * recipient — or ask the mandatory currency question when a bare `$` appears.
 */
export async function handleQuoteTextForRecipient(
  tx: Tx,
  actor: Actor,
  input: { conversationId: string; rfqRecipientId: string; text: string; sourceMessageId: string | null },
): Promise<{ kind: string; quoteId?: string }> {
  const parsed = parseQuoteText(input.text);
  if (!parsed) {
    await sendOutbound(tx, {
      conversationId: input.conversationId, messageType: "TEXT",
      text: "请回复报价金额，例如：220全包 或 USD 220。",
      context: { rfqRecipientId: input.rfqRecipientId },
    });
    return { kind: "CLARIFY_AMOUNT" };
  }
  const resolved = resolveCurrency(parsed);
  if (!resolved) {
    // Bare $: never infer (§3.5). One question, then wait.
    await setTaskPendingInteraction(tx, {
      conversationId: input.conversationId,
      fleetUserId: actor.userId!,
      rfqRecipientId: input.rfqRecipientId,
      sourceMessageId: input.sourceMessageId,
      interactionType: "AWAIT_CURRENCY",
      payload: {
        amount: parsed.amount,
        isAllIn: parsed.isAllIn,
        terms: parsed.terms,
        attempts: 0,
      },
    });
    await sendOutbound(tx, {
      conversationId: input.conversationId, messageType: "TEXT",
      text: `请确认币种：USD ${parsed.amount} 还是 SGD ${parsed.amount}？`,
      replyToMessageId: input.sourceMessageId,
      context: { rfqRecipientId: input.rfqRecipientId },
    });
    return { kind: "AWAIT_CURRENCY" };
  }
  await resolveTaskPendingInteraction(tx, {
    conversationId: input.conversationId,
    fleetUserId: actor.userId!,
    rfqRecipientId: input.rfqRecipientId,
  });
  const { quoteId } = await proposeQuoteDraft(tx, actor, {
    conversationId: input.conversationId,
    rfqRecipientId: input.rfqRecipientId,
    amount: parsed.amount,
    currency: resolved.currency,
    currencySource: resolved.source,
    isAllIn: parsed.isAllIn || null,
    terms: parsed.terms,
    sourceMessageId: input.sourceMessageId,
  });
  return { kind: "DRAFT_CREATED", quoteId };
}

// ---------------------------------------------------------------- main pipeline

export async function handleInbound(
  db: Db,
  actor: Actor,
  input: { conversationId: string; messageId: string },
): Promise<CommandResult<{ handled: string }>> {
  // Read phase (no writes): message, conversation state, candidate contexts.
  let pre;
  try {
    pre = await withTx(db, async (tx) => {
    const msg = (
      await tx.query(
        `SELECT m.*, c.fleet_organization_id
           FROM messages m JOIN conversations c ON c.id=m.conversation_id
          WHERE m.id=$1 AND m.conversation_id=$2`,
        [input.messageId, input.conversationId],
      )
    ).rows[0];
    if (!msg) throw new CommandFailure(err("NOT_FOUND", "Message not found"));
    if (msg.fleet_organization_id !== actor.organizationId) throw new CommandFailure(err("FORBIDDEN", "Not your conversation"));
    const candidates = await pendingRecipients(tx, actor.organizationId!);
    const reply = await replyContext(tx, msg.reply_to_message_id);
    const pending = await findTaskPendingInteraction(tx, {
      conversationId: input.conversationId,
      fleetUserId: actor.userId!,
      orderId: reply?.order_id ?? null,
      rfqRecipientId: reply?.rfq_recipient_id ?? null,
      bookingId: reply?.booking_id ?? null,
      shipmentId: reply?.shipment_id ?? null,
    });
    const booking = (
      await tx.query(
        `SELECT b.*, s.id AS shipment_id, s.current_status AS shipment_status, s.version AS shipment_version
           FROM bookings b LEFT JOIN shipments s ON s.booking_id=b.id
          WHERE b.fleet_organization_id=$1 AND b.status IN ('OFFERED','ACCEPTED','RESOURCE_PENDING','READY','IN_PROGRESS')
          ORDER BY b.updated_at DESC`,
        [actor.organizationId],
      )
    ).rows;
      return { msg, candidates, reply, bookings: booking, pending };
    });
  } catch (e) {
    if (e instanceof CommandFailure) return e.failure as CommandResult<{ handled: string }>;
    throw e;
  }

  const text: string = pre.msg.text_content ?? "";
  const pendingIntent = pre.pending
    ? {
        ...(pre.pending.payload ?? {}),
        id: pre.pending.id,
        kind: pre.pending.interaction_type,
        rfqRecipientId: pre.pending.rfq_recipient_id,
        bookingId: pre.pending.booking_id,
        shipmentId: pre.pending.shipment_id,
      }
    : null;

  // Interpretation happens OUTSIDE the write transaction; the proposal is data.
  const replyBooking = pre.reply?.booking_id
    ? pre.bookings.find((b) => b.id === pre.reply.booking_id)
    : null;
  const replyShipment = pre.reply?.shipment_id
    ? pre.bookings.find((b) => b.shipment_id === pre.reply.shipment_id)
    : null;
  const activeShipment = replyShipment ?? pre.bookings.find((b) => b.shipment_id);
  const proposal = await getInterpreter().interpret(text, {
    fleetOrganizationId: actor.organizationId!,
    rfqRecipientId:
      (pendingIntent?.kind === "AWAIT_QUOTE_AMOUNT" || pendingIntent?.kind === "AWAIT_CURRENCY"
        ? pendingIntent.rfqRecipientId
        : null) ??
      pre.reply?.rfq_recipient_id ??
      (pre.candidates.length === 1 ? pre.candidates[0].id : null),
    rfqRevision: pre.candidates.length === 1 ? pre.candidates[0].revision : null,
    orderVersion: pre.candidates.length === 1 ? pre.candidates[0].order_version : null,
    bookingId: replyBooking?.id ?? replyShipment?.id ?? pre.bookings[0]?.id ?? null,
    shipmentId: activeShipment?.shipment_id ?? null,
    shipmentStatus: activeShipment?.shipment_status ?? null,
    hasActiveBooking: pre.bookings.length > 0,
    rfqSummary: pre.candidates.map((c) => `${c.rfq_ref} ${c.route}`).join("; ") || null,
  });

  // Write phase: one command transaction, idempotent per inbound message (§9.2).
  return runCommand(db, { key: `inbound:${input.messageId}:dispatch`, type: "HandleInboundMessage" }, async (tx) => {
    const conversationId = input.conversationId;
    const sourceMessageId = input.messageId;

    const clarify = async (question: string, opts?: { escalateType?: "AMBIGUOUS_CONTEXT" | "AMBIGUOUS_CURRENCY" | "LOW_CONFIDENCE" }) => {
      const count = (pre.pending?.clarification_count ?? 0) + 1;
      if (count > 2 && opts?.escalateType) {
        if (pre.pending?.id) {
          await tx.query(
            `UPDATE pending_interactions SET clarification_count=0 WHERE id=$1`,
            [pre.pending.id],
          );
        }
        await requestHumanHandoff(tx, actor, {
          conversationId, type: opts.escalateType, sourceMessageId,
          summary: `Repeated clarification failure (${opts.escalateType}) for inbound: ${text.slice(0, 200)}`,
        });
        return { handled: "HANDOFF" };
      }
      if (pre.pending?.id) {
        await tx.query(
          `UPDATE pending_interactions SET clarification_count=$2 WHERE id=$1`,
          [pre.pending.id, count],
        );
      }
      await sendOutbound(tx, { conversationId, messageType: "TEXT", text: question, replyToMessageId: sourceMessageId });
      return { handled: "CLARIFY" };
    };
    const resetClarifications = () =>
      pre.pending?.id
        ? tx.query(`UPDATE pending_interactions SET clarification_count=0 WHERE id=$1`, [pre.pending.id])
        : Promise.resolve();

    // §11.8 — delayed reply to an old-revision message: persist + link, never mutate.
    if (pre.reply?.rfq_id && pre.reply.rfq_revision != null && pre.reply.rfq_revision < pre.reply.current_revision) {
      await linkInbound(tx, sourceMessageId, {
        rfqId: pre.reply.rfq_id, rfqRecipientId: pre.reply.rfq_recipient_id, rfqRevision: pre.reply.rfq_revision,
      });
      const current = pre.candidates.find((c) => c.rfq_id === pre.reply.rfq_id);
      await audit(tx, {
        actor, action: "message.stale_reply", objectType: "MESSAGE", objectId: sourceMessageId,
        metadata: { rfqId: pre.reply.rfq_id, repliedRevision: pre.reply.rfq_revision, currentRevision: pre.reply.current_revision },
      });
      await sendOutbound(tx, {
        conversationId, messageType: "TEXT",
        text: `你回复的是 ${pre.reply.rfq_ref} 的旧版本条件，条件已更新${current ? `（当前提货时间：${fmtTs(current.pickup_at)}）` : ""}，未做任何修改。请在最新的询价消息中确认，或直接回复按新条件的报价。`,
        replyToMessageId: sourceMessageId,
      });
      return { handled: "STALE_REPLY" };
    }

    // Link inbound to its resolved context when unambiguous (traceability).
    const linkTo = (recipient: CandidateRecipient) =>
      linkInbound(tx, sourceMessageId, {
        orderId: recipient.order_id, rfqId: recipient.rfq_id, rfqRecipientId: recipient.id, rfqRevision: recipient.revision,
      });

    // Pending currency clarification takes precedence over fresh interpretation.
    if (pendingIntent?.kind === "AWAIT_CURRENCY") {
      const full = parseQuoteText(text);
      let currency: "USD" | "SGD" | null = null;
      if (full && full.currencyMention === "EXPLICIT") currency = full.currency;
      else if (/\b(usd|us\$)\b|美金|美元/i.test(text)) currency = "USD";
      else if (/\b(sgd|s\$)\b|新币|坡币|新元/i.test(text)) currency = "SGD";
      if (!currency) {
        return clarify(`请确认币种：USD ${pendingIntent.amount} 还是 SGD ${pendingIntent.amount}？`, { escalateType: "AMBIGUOUS_CURRENCY" });
      }
      await resetClarifications();
      await resolveTaskPendingInteraction(tx, {
        conversationId,
        fleetUserId: actor.userId!,
        interactionId: pendingIntent.id,
      });
      const amount = full && full.currencyMention === "EXPLICIT" ? full.amount : pendingIntent.amount;
      await proposeQuoteDraft(tx, actor, {
        conversationId,
        rfqRecipientId: pendingIntent.rfqRecipientId,
        amount,
        currency,
        currencySource: "EXPLICIT",
        isAllIn: pendingIntent.isAllIn || null,
        terms: pendingIntent.terms ?? null,
        sourceMessageId,
      });
      return { handled: "QUOTE_DRAFTED" };
    }

    const resolveRecipient = (): CandidateRecipient | "MULTIPLE" | null => {
      if (pendingIntent?.kind === "AWAIT_QUOTE_AMOUNT") {
        const hit = pre.candidates.find((c) => c.id === pendingIntent.rfqRecipientId);
        if (hit) return hit;
      }
      if (pre.reply?.rfq_recipient_id) {
        const hit = pre.candidates.find((c) => c.id === pre.reply.rfq_recipient_id);
        if (hit) return hit;
      }
      const ref = referencedRef(text);
      if (ref) {
        const hit = pre.candidates.find((c) => c.rfq_ref === ref || c.order_ref === ref);
        if (hit) return hit;
      }
      if (pre.candidates.length === 1) return pre.candidates[0];
      if (pre.candidates.length > 1) return "MULTIPLE";
      return null;
    };

    const askWhichRfq = async (pendingText: string) => {
      await sendOutbound(tx, {
        conversationId, messageType: "ACTION_PROMPT",
        text: "你有多个进行中的询价，请选择这条回复对应哪一个：",
        replyToMessageId: sourceMessageId,
        actions: pre.candidates.slice(0, 6).map((c) => ({
          actionType: "SELECT_RFQ_CONTEXT",
          label: `${c.rfq_ref}（${c.route}）`,
          objectType: "RFQ_RECIPIENT",
          objectId: c.id,
          expectedOrderVersion: c.order_version,
          expectedRfqRevision: c.revision,
          payload: { rfqRecipientId: c.id, pendingText, sourceMessageId },
        })),
      });
      return { handled: "CONTEXT_SELECTION" };
    };

    switch (proposal.intent) {
      case "SUBMIT_QUOTE_DRAFT": {
        // "价格不变" text — route to the pending reconfirmation (§10.1, §11.6).
        if (proposal.quote.terms === "PRICE_UNCHANGED" && proposal.quote.amount === null) {
          const acts = await tx.query(
            `SELECT ma.*, rr.fleet_organization_id
               FROM message_actions ma JOIN rfq_recipients rr ON rr.id=ma.object_id
              WHERE ma.action_type='ACK_PRICE_UNCHANGED' AND ma.status='AVAILABLE' AND rr.fleet_organization_id=$1
              ORDER BY ma.created_at DESC`,
            [actor.organizationId],
          );
          if (acts.rowCount === 0) {
            return clarify("当前没有等待重新确认的报价。如需修改报价，请直接回复新的价格。", { escalateType: "AMBIGUOUS_CONTEXT" });
          }
          if ((acts.rowCount ?? 0) > 1) return askWhichRfq(text);
          const act = acts.rows[0];
          // Exactly-once across both paths (text and button) via the shared
          // per-action idempotency key.
          const claimed = await tx.query(
            `INSERT INTO processed_commands (idempotency_key, command_type)
             VALUES ($1,'ConsumeMessageAction') ON CONFLICT DO NOTHING RETURNING idempotency_key`,
            [`action-consume:${act.id}`],
          );
          if (claimed.rowCount === 0) {
            await sendOutbound(tx, {
            conversationId, messageType: "SYSTEM_NOTICE",
            text: "这个报价已经确认过了，不用再操作一次。",
            replyToMessageId: sourceMessageId,
          });
            return { handled: "ALREADY_CONFIRMED" };
          }
          await tx.query(`UPDATE message_actions SET status='CONSUMED', consumed_at=now(), consumed_by_user_id=$2 WHERE id=$1`, [act.id, actor.userId]);
          await tx.query(
            `UPDATE message_actions
                SET status='INVALIDATED'
              WHERE message_id=$1 AND id<>$2 AND status='AVAILABLE'`,
            [act.message_id, act.id],
          );
          const payload = act.payload as { invalidatedQuoteId: string; rfqRecipientId: string };
          await resetClarifications();
          await confirmPriceUnchanged(tx, actor, {
            conversationId, invalidatedQuoteId: payload.invalidatedQuoteId, rfqRecipientId: payload.rfqRecipientId,
            sourceMessageId, viaActionId: act.id,
          });
          return { handled: "PRICE_UNCHANGED_CONFIRMED" };
        }

        const recipient = resolveRecipient();
        if (recipient === "MULTIPLE") return askWhichRfq(text);
        if (!recipient) return clarify("目前没有进行中的询价。收到新询价时我会第一时间通知你。", { escalateType: "AMBIGUOUS_CONTEXT" });
        await linkTo(recipient);
        await resetClarifications();
        await handleQuoteTextForRecipient(tx, actor, { conversationId, rfqRecipientId: recipient.id, text, sourceMessageId });
        return { handled: "QUOTE_FLOW" };
      }

      case "DECLINE_RFQ": {
        const recipient = resolveRecipient();
        if (recipient === "MULTIPLE") return askWhichRfq(text);
        if (!recipient) return clarify("目前没有进行中的询价需要回复。", { escalateType: "AMBIGUOUS_CONTEXT" });
        await linkTo(recipient);
        await resetClarifications();
        await declineRfq(tx, actor, { conversationId, rfqRecipientId: recipient.id, reason: proposal.reason ?? text, sourceMessageId });
        return { handled: "DECLINED" };
      }

      case "ACK_REPLY_LATER": {
        const recipient = resolveRecipient();
        if (recipient === "MULTIPLE" || !recipient) {
          await sendOutbound(tx, { conversationId, messageType: "TEXT", text: "好的，等你回复。", replyToMessageId: sourceMessageId });
          return { handled: "ACK" };
        }
        await linkTo(recipient);
        await resetClarifications();
        await ackReplyLater(tx, actor, { conversationId, rfqRecipientId: recipient.id, sourceMessageId });
        return { handled: "REPLY_LATER" };
      }

      case "REQUEST_HUMAN": {
        await resetClarifications();
        if (pre.reply?.rfq_recipient_id) {
          const recipient = pre.candidates.find((candidate) => candidate.id === pre.reply.rfq_recipient_id);
          if (recipient) await linkTo(recipient);
        }
        await requestHumanHandoff(tx, actor, {
          conversationId, type: "OTHER", sourceMessageId,
          orderId: pre.reply?.order_id ?? null,
          rfqId: pre.reply?.rfq_id ?? null,
          summary: `Fleet requested operator: ${text.slice(0, 200)}`,
        });
        return { handled: "HANDOFF" };
      }

      case "ASSIGN_RESOURCES": {
        await sendOutbound(tx, {
          conversationId,
          messageType: "TEXT",
          text: "v1.1 暂不记录司机、车牌或车辆安排；接单后可直接按整票运输节点更新状态。",
          replyToMessageId: sourceMessageId,
          context: {
            orderId: pre.reply?.order_id ?? null,
            bookingId: pre.reply?.booking_id ?? null,
            shipmentId: pre.reply?.shipment_id ?? null,
          },
        });
        return { handled: "ASSIGNMENT_NOT_REQUIRED" };
      }

      case "UPDATE_SHIPMENT_STATUS": {
        const withShipment = pre.bookings.filter((b) => b.shipment_id && !["COMPLETED"].includes(b.shipment_status));
        if (withShipment.length === 0) return clarify("当前没有进行中的运输任务。", { escalateType: "AMBIGUOUS_CONTEXT" });
        if (withShipment.length > 1) return clarify("你有多个进行中的运输任务，请注明任务编号（例如 B-1001）。", { escalateType: "AMBIGUOUS_CONTEXT" });
        const toStatus = (proposal.extracted as { toStatus?: string }).toStatus as ShipmentStatus | undefined;
        if (!toStatus) return clarify("请告诉我最新的运输状态，例如：已出发提货 / 提到柜 / 送到了。");
        const res = await proposeShipmentStatus(tx, actor, {
          conversationId, shipmentId: withShipment[0].shipment_id, toStatus, sourceMessageId,
        });
        if ("invalid" in res) {
          await sendOutbound(tx, { conversationId, messageType: "TEXT", text: res.invalid, replyToMessageId: sourceMessageId });
          return { handled: "INVALID_TRANSITION_CLARIFIED" };
        }
        await resetClarifications();
        return { handled: "SHIPMENT_STATUS_PROPOSED" };
      }

      case "UPLOAD_POD": {
        await sendOutbound(tx, {
          conversationId, messageType: "TEXT",
          text: "请直接在对话中上传回单照片或 PDF（点击输入框旁的附件按钮）。",
          replyToMessageId: sourceMessageId,
        });
        return { handled: "POD_HINT" };
      }

      case "UNKNOWN":
      default:
        return clarify(proposal.clarificationQuestion ?? "抱歉，我没有理解。可以换个说法吗？", { escalateType: "LOW_CONFIDENCE" });
    }
  });
}
