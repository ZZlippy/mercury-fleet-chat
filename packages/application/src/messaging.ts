import type { Tx } from "@mercury/db";
import { emitOutbox, newId } from "./kernel.ts";

export interface ContextLinks {
  orderId?: string | null;
  rfqId?: string | null;
  rfqRecipientId?: string | null;
  quoteId?: string | null;
  bookingId?: string | null;
  shipmentId?: string | null;
  rfqRevision?: number | null;
}

export interface OutboundActionSpec {
  actionType: string;
  label: string;
  objectType: string;
  objectId: string;
  expectedOrderVersion?: number | null;
  expectedRfqRevision?: number | null;
  expectedObjectVersion?: number | null;
  payload?: Record<string, unknown>;
  expiresAt?: string | null;
}

export interface PendingInteractionSpec extends ContextLinks {
  conversationId: string;
  fleetUserId: string;
  sourceMessageId?: string | null;
  interactionType: string;
  expectedOrderVersion?: number | null;
  expectedRfqRevision?: number | null;
  expectedObjectVersion?: number | null;
  payload?: Record<string, unknown>;
  expiresAt?: string | null;
}

export async function getOrCreateConversation(tx: Tx, fleetOrganizationId: string): Promise<{ id: string }> {
  const found = await tx.query(
    `SELECT id FROM conversations WHERE fleet_organization_id=$1 AND channel='WEB' AND status='ACTIVE'`,
    [fleetOrganizationId],
  );
  if (found.rowCount) return found.rows[0];
  const created = await tx.query(
    `INSERT INTO conversations (fleet_organization_id, channel) VALUES ($1,'WEB')
     ON CONFLICT (fleet_organization_id, channel) WHERE status='ACTIVE' DO UPDATE SET updated_at=now()
     RETURNING id`,
    [fleetOrganizationId],
  );
  return created.rows[0];
}

/**
 * Insert a context link for a message, but never twice for the same message.
 *
 * A message needs at most one context link: it belongs to exactly one task.
 * Two independent paths used to write links for the same inbound message
 * (`recordInbound` copies the parent's link, and the §11.8 stale-reply branch
 * added its own), which produced duplicate rows. That mattered because context
 * resolution reads a single row, so duplicates made the resolved task and
 * revision depend on physical row order. Merging into one row keeps delayed
 * WhatsApp/WeChat replies deterministic.
 */
async function insertContextLinks(tx: Tx, messageId: string, links?: ContextLinks): Promise<void> {
  if (!links) return;
  const { orderId, rfqId, rfqRecipientId, quoteId, bookingId, shipmentId, rfqRevision } = links;
  if (!orderId && !rfqId && !rfqRecipientId && !quoteId && !bookingId && !shipmentId) return;
  await tx.query(
    `INSERT INTO message_context_links
       (message_id, order_id, rfq_id, rfq_recipient_id, quote_id, booking_id, shipment_id, rfq_revision)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (message_id) DO UPDATE SET
       order_id         = COALESCE(message_context_links.order_id,         EXCLUDED.order_id),
       rfq_id           = COALESCE(message_context_links.rfq_id,           EXCLUDED.rfq_id),
       rfq_recipient_id = COALESCE(message_context_links.rfq_recipient_id, EXCLUDED.rfq_recipient_id),
       quote_id         = COALESCE(message_context_links.quote_id,         EXCLUDED.quote_id),
       booking_id       = COALESCE(message_context_links.booking_id,       EXCLUDED.booking_id),
       shipment_id      = COALESCE(message_context_links.shipment_id,      EXCLUDED.shipment_id),
       rfq_revision     = COALESCE(message_context_links.rfq_revision,     EXCLUDED.rfq_revision)`,
    [messageId, orderId ?? null, rfqId ?? null, rfqRecipientId ?? null, quoteId ?? null, bookingId ?? null, shipmentId ?? null, rfqRevision ?? null],
  );
}

/**
 * Create an outbound Mercury message through the outbox-backed delivery path
 * (§8.2): the row is written PENDING inside the business transaction together
 * with a `message.outbound` outbox event; the worker marks it SENT and pushes
 * it over SSE. Actions are versioned, contextual, and individually idempotent.
 */
export async function sendOutbound(
  tx: Tx,
  input: {
    conversationId: string;
    senderType?: "MERCURY_AI" | "MERCURY_SYSTEM" | "OPERATOR";
    messageType: "TEXT" | "BUSINESS_CARD" | "ACTION_PROMPT" | "FILE" | "SYSTEM_NOTICE" | "HANDOFF_NOTICE";
    text: string;
    structured?: Record<string, unknown>;
    replyToMessageId?: string | null;
    context?: ContextLinks;
    actions?: OutboundActionSpec[];
  },
): Promise<{ messageId: string; actionIds: string[] }> {
  const res = await tx.query(
    `INSERT INTO messages (conversation_id, direction, sender_type, message_type, text_content, structured_content, reply_to_message_id)
     VALUES ($1,'OUTBOUND',$2,$3,$4,$5,$6) RETURNING id`,
    [
      input.conversationId,
      input.senderType ?? "MERCURY_AI",
      input.messageType,
      input.text,
      JSON.stringify(input.structured ?? {}),
      input.replyToMessageId ?? null,
    ],
  );
  const messageId: string = res.rows[0].id;
  let inheritedContext: ContextLinks | undefined;
  if (input.replyToMessageId) {
    const parent = (
      await tx.query(
        `SELECT order_id, rfq_id, rfq_recipient_id, quote_id, booking_id, shipment_id, rfq_revision
           FROM message_context_links
          WHERE message_id=$1
          ORDER BY created_at DESC LIMIT 1`,
        [input.replyToMessageId],
      )
    ).rows[0];
    if (parent) {
      inheritedContext = {
        orderId: parent.order_id,
        rfqId: parent.rfq_id,
        rfqRecipientId: parent.rfq_recipient_id,
        quoteId: parent.quote_id,
        bookingId: parent.booking_id,
        shipmentId: parent.shipment_id,
        rfqRevision: parent.rfq_revision,
      };
    }
  }
  await insertContextLinks(tx, messageId, { ...inheritedContext, ...input.context });

  const actionIds: string[] = [];
  for (const a of input.actions ?? []) {
    const r = await tx.query(
      `INSERT INTO message_actions
         (message_id, action_type, label, object_type, object_id,
          expected_order_version, expected_rfq_revision, expected_object_version, payload, expires_at, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [
        messageId, a.actionType, a.label, a.objectType, a.objectId,
        a.expectedOrderVersion ?? null, a.expectedRfqRevision ?? null, a.expectedObjectVersion ?? null,
        JSON.stringify(a.payload ?? {}), a.expiresAt ?? null, newId(),
      ],
    );
    actionIds.push(r.rows[0].id);
  }

  // Fleet business actions are rendered as numbered text in v1.1. The
  // underlying versioned Action rows remain authoritative and idempotent.
  if ((input.actions?.length ?? 0) > 0) {
    const numbered = input.actions!.map((action, index) => `${index + 1}. ${action.label}`);
    const fullText = `${input.text.trimEnd()}\n\n${numbered.join("\n")}\n\n请回复 ${numbered
      .map((_, index) => index + 1)
      .join(" / ")} 选择。`;
    await tx.query(
      `UPDATE messages
          SET text_content=$2,
              structured_content=structured_content || $3::jsonb
        WHERE id=$1`,
      [
        messageId,
        fullText,
        JSON.stringify({
          interaction: "NUMBERED_CHOICES",
          choices: input.actions!.map((action, index) => ({
            number: index + 1,
            label: action.label,
          })),
        }),
      ],
    );
  }

  await tx.query(`UPDATE conversations SET last_message_at=now(), updated_at=now() WHERE id=$1`, [input.conversationId]);
  await emitOutbox(tx, "message.outbound", "MESSAGE", messageId, { conversationId: input.conversationId });
  return { messageId, actionIds };
}

/** Record an inbound message context link (delayed replies keep old-revision linkage, §11.8). */
export async function linkInbound(tx: Tx, messageId: string, links: ContextLinks): Promise<void> {
  await insertContextLinks(tx, messageId, links);
}

/**
 * Invalidate all AVAILABLE actions bound to an RFQ's recipients/quotes whose
 * expected revision is older than the new one (§8.4, §11.5 step 7).
 */
export async function invalidateStaleRfqActions(tx: Tx, rfqId: string, newRevision: number): Promise<number> {
  const res = await tx.query(
    `UPDATE message_actions ma SET status='INVALIDATED'
     WHERE ma.status='AVAILABLE'
       AND (ma.expected_rfq_revision IS NULL OR ma.expected_rfq_revision < $2)
       AND (
         (ma.object_type='RFQ_RECIPIENT' AND ma.object_id IN (SELECT id FROM rfq_recipients WHERE rfq_id=$1))
         OR
         (ma.object_type='QUOTE' AND ma.object_id IN (
            SELECT q.id FROM quotes q JOIN rfq_recipients r ON q.rfq_recipient_id=r.id WHERE r.rfq_id=$1))
       )`,
    [rfqId, newRevision],
  );
  return res.rowCount ?? 0;
}

/** Create or replace the active pending interaction for one user and one task. */
export async function setTaskPendingInteraction(
  tx: Tx,
  input: PendingInteractionSpec,
): Promise<{ id: string }> {
  const context = {
    orderId: input.orderId ?? null,
    rfqRecipientId: input.rfqRecipientId ?? null,
    bookingId: input.bookingId ?? null,
    shipmentId: input.shipmentId ?? null,
  };
  await tx.query(
    `UPDATE pending_interactions
        SET status='INVALIDATED', resolved_at=now()
      WHERE conversation_id=$1 AND fleet_user_id=$2 AND status='ACTIVE'
        AND order_id IS NOT DISTINCT FROM $3::uuid
        AND rfq_recipient_id IS NOT DISTINCT FROM $4::uuid
        AND booking_id IS NOT DISTINCT FROM $5::uuid
        AND shipment_id IS NOT DISTINCT FROM $6::uuid`,
    [
      input.conversationId,
      input.fleetUserId,
      context.orderId,
      context.rfqRecipientId,
      context.bookingId,
      context.shipmentId,
    ],
  );
  const result = await tx.query(
    `INSERT INTO pending_interactions (
       conversation_id, order_id, rfq_recipient_id, booking_id, shipment_id,
       fleet_user_id, source_message_id, interaction_type,
       expected_order_version, expected_rfq_revision, expected_object_version,
       payload, expires_at
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     RETURNING id`,
    [
      input.conversationId,
      context.orderId,
      context.rfqRecipientId,
      context.bookingId,
      context.shipmentId,
      input.fleetUserId,
      input.sourceMessageId ?? null,
      input.interactionType,
      input.expectedOrderVersion ?? null,
      input.expectedRfqRevision ?? null,
      input.expectedObjectVersion ?? null,
      JSON.stringify(input.payload ?? {}),
      input.expiresAt ?? null,
    ],
  );
  return result.rows[0];
}

export async function resolveTaskPendingInteraction(
  tx: Tx,
  input: {
    interactionId?: string | null;
    conversationId: string;
    fleetUserId: string;
    rfqRecipientId?: string | null;
    bookingId?: string | null;
    shipmentId?: string | null;
  },
): Promise<void> {
  await tx.query(
    `UPDATE pending_interactions
        SET status='RESOLVED', resolved_at=now()
      WHERE status='ACTIVE'
        AND conversation_id=$1
        AND fleet_user_id=$2
        AND ($3::uuid IS NULL OR id=$3)
        AND ($4::uuid IS NULL OR rfq_recipient_id=$4)
        AND ($5::uuid IS NULL OR booking_id=$5)
        AND ($6::uuid IS NULL OR shipment_id=$6)`,
    [
      input.conversationId,
      input.fleetUserId,
      input.interactionId ?? null,
      input.rfqRecipientId ?? null,
      input.bookingId ?? null,
      input.shipmentId ?? null,
    ],
  );
}

/** Resolve the pending interaction using the explicit inbound task context first. */
export async function findTaskPendingInteraction(
  tx: Tx,
  input: {
    conversationId: string;
    fleetUserId: string;
    orderId?: string | null;
    rfqRecipientId?: string | null;
    bookingId?: string | null;
    shipmentId?: string | null;
  },
): Promise<Record<string, any> | null> {
  await tx.query(
    `UPDATE pending_interactions
        SET status='EXPIRED', resolved_at=now()
      WHERE status='ACTIVE' AND expires_at IS NOT NULL AND expires_at < now()`,
  );
  const hasExplicitTask = Boolean(
    input.orderId || input.rfqRecipientId || input.bookingId || input.shipmentId,
  );
  const result = await tx.query(
    `SELECT *
       FROM pending_interactions
      WHERE conversation_id=$1 AND fleet_user_id=$2 AND status='ACTIVE'
        AND (
          $3::boolean=false
          OR ($4::uuid IS NOT NULL AND order_id=$4)
          OR ($5::uuid IS NOT NULL AND rfq_recipient_id=$5)
          OR ($6::uuid IS NOT NULL AND booking_id=$6)
          OR ($7::uuid IS NOT NULL AND shipment_id=$7)
        )
      ORDER BY
        CASE
          WHEN $7::uuid IS NOT NULL AND shipment_id=$7 THEN 4
          WHEN $6::uuid IS NOT NULL AND booking_id=$6 THEN 3
          WHEN $5::uuid IS NOT NULL AND rfq_recipient_id=$5 THEN 2
          WHEN $4::uuid IS NOT NULL AND order_id=$4 THEN 1
          ELSE 0
        END DESC,
        created_at DESC
      LIMIT 2`,
    [
      input.conversationId,
      input.fleetUserId,
      hasExplicitTask,
      input.orderId ?? null,
      input.rfqRecipientId ?? null,
      input.bookingId ?? null,
      input.shipmentId ?? null,
    ],
  );
  if (result.rows.length !== 1 && !hasExplicitTask) return null;
  return result.rows[0] ?? null;
}
