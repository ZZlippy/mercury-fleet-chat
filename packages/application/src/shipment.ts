import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Tx } from "@mercury/db";
import { err } from "@mercury/contracts";
import {
  canShipmentTransition,
  type OrderType,
  type ShipmentStatus,
} from "@mercury/domain";
import { type Actor, audit, CommandFailure, emitOutbox, newId } from "./kernel.ts";
import { getOrCreateConversation, sendOutbound } from "./messaging.ts";

export type ShipmentDocumentType =
  | "EMPTY_CONTAINER_RELEASE"
  | "TERMINAL_HANDOVER"
  | "POD"
  | "EMPTY_CONTAINER_RETURN";

const STATUS_LABELS: Record<ShipmentStatus, string> = {
  WAITING_EMPTY_CONTAINER_RELEASE: "等待提取空箱",
  EMPTY_CONTAINER_PICKED_UP: "全部空箱已提取",
  AT_LOADING_LOCATION: "已到达装货地点",
  LOADED: "全部集装箱已装货",
  EN_ROUTE_TO_TERMINAL: "前往码头",
  LADEN_CONTAINERS_RETURNED_TO_TERMINAL: "全部重箱已还至码头",
  WAITING_PORT_RELEASE: "等待码头放箱",
  CONTAINER_PICKED_UP: "全部重箱已从码头提取",
  IN_TRANSIT_TO_DELIVERY: "前往送货地点",
  DELIVERED: "全部集装箱已送达",
  EMPTY_RETURN_PENDING: "等待归还空箱",
  EMPTY_RETURNED: "全部空箱已归还",
  DOCUMENTS_SUBMITTED: "必需文件已提交",
  REVIEW_PENDING: "等待运营审核",
  COMPLETED: "已完成",
  EXCEPTION: "异常处理中",
  WAITING_ASSIGNMENT: "旧版：等待安排",
  DRIVER_ASSIGNED: "旧版：已安排司机",
  EN_ROUTE_TO_PICKUP: "旧版：前往提货",
  AT_PICKUP: "旧版：已到提货点",
  PICKED_UP: "旧版：已提货",
  IN_TRANSIT: "旧版：运输途中",
  AT_DELIVERY: "旧版：已到送达点",
  POD_SUBMITTED: "旧版：回单已提交",
};

const REQUIRED_DOCUMENTS: Record<OrderType, ShipmentDocumentType[]> = {
  EXPORT_DRAYAGE: ["EMPTY_CONTAINER_RELEASE", "TERMINAL_HANDOVER"],
  IMPORT_DRAYAGE: ["POD", "EMPTY_CONTAINER_RETURN"],
};

const DOCUMENT_LABELS: Record<ShipmentDocumentType, string> = {
  EMPTY_CONTAINER_RELEASE: "空箱提取或放箱证明",
  TERMINAL_HANDOVER: "重箱交还码头证明",
  POD: "送货签收证明（POD）",
  EMPTY_CONTAINER_RETURN: "空箱归还证明",
};

const ALLOWED_DOCUMENT_MIME = /^(image\/(png|jpe?g|webp|heic)|application\/pdf)$/i;
const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

export async function lockShipmentForFleet(tx: Tx, shipmentId: string, fleetOrganizationId: string) {
  const shipment = (
    await tx.query(
      `SELECT s.*, b.fleet_organization_id, b.id AS booking_id2,
              b.public_reference AS booking_ref, b.order_id,
              b.status AS booking_status, o.order_type, o.public_reference AS order_ref
         FROM shipments s
         JOIN bookings b ON b.id=s.booking_id
         JOIN orders o ON o.id=b.order_id
        WHERE s.id=$1
        FOR UPDATE OF s, b`,
      [shipmentId],
    )
  ).rows[0];
  if (!shipment) throw new CommandFailure(err("NOT_FOUND", "Shipment not found"));
  if (shipment.fleet_organization_id !== fleetOrganizationId) {
    throw new CommandFailure(err("FORBIDDEN", "Not your shipment"));
  }
  return shipment;
}

async function appendShipmentEvent(
  tx: Tx,
  input: {
    shipmentId: string;
    from: ShipmentStatus;
    to: ShipmentStatus;
    actor: Actor;
    sourceMessageId?: string | null;
    eventKey: string;
    eventType?: string;
    payload?: Record<string, unknown>;
  },
): Promise<void> {
  await tx.query(
    `INSERT INTO shipment_events (
       shipment_id, event_type, from_status, to_status, reported_by_user_id,
       source, source_message_id, payload, idempotency_key
     )
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [
      input.shipmentId,
      input.eventType ?? "STATUS_CHANGE",
      input.from,
      input.to,
      input.actor.userId,
      input.actor.actorType === "OPERATOR" ? "OPERATOR" : "WEB",
      input.sourceMessageId ?? null,
      JSON.stringify(input.payload ?? {}),
      input.eventKey,
    ],
  );
}

export async function updateShipmentStatus(
  tx: Tx,
  actor: Actor,
  input: {
    conversationId: string;
    shipmentId: string;
    toStatus: ShipmentStatus;
    sourceMessageId?: string | null;
    eventKey: string;
  },
): Promise<{ shipmentId: string; from: string; to: string }> {
  const shipment = await lockShipmentForFleet(tx, input.shipmentId, actor.organizationId!);
  const from = shipment.current_status as ShipmentStatus;
  const orderType = shipment.order_type as OrderType;
  if (from === input.toStatus) return { shipmentId: shipment.id, from, to: from };
  if (!canShipmentTransition(from, input.toStatus, orderType)) {
    throw new CommandFailure(
      err(
        "INVALID_TRANSITION",
        `当前状态为「${STATUS_LABELS[from]}」，无法直接更新为「${STATUS_LABELS[input.toStatus]}」。`,
      ),
    );
  }
  if (["DOCUMENTS_SUBMITTED", "REVIEW_PENDING", "COMPLETED"].includes(input.toStatus)) {
    throw new CommandFailure(err("FORBIDDEN", "文件与完成状态只能由确定性的文件审核流程更新。"));
  }

  await tx.query(
    `UPDATE shipments SET current_status=$2, version=version+1, updated_at=now() WHERE id=$1`,
    [shipment.id, input.toStatus],
  );
  await appendShipmentEvent(tx, {
    shipmentId: shipment.id,
    from,
    to: input.toStatus,
    actor,
    sourceMessageId: input.sourceMessageId,
    eventKey: input.eventKey,
  });
  if (shipment.booking_status === "ACCEPTED") {
    await tx.query(
      `UPDATE bookings SET status='IN_PROGRESS', version=version+1, updated_at=now()
        WHERE id=$1 AND status='ACCEPTED'`,
      [shipment.booking_id],
    );
  }
  await audit(tx, {
    actor,
    action: "shipment.status_changed",
    objectType: "SHIPMENT",
    objectId: shipment.id,
    sourceMessageId: input.sourceMessageId ?? null,
    before: { status: from },
    after: { status: input.toStatus },
    metadata: { orderType },
  });
  await emitOutbox(tx, "shipment.status_changed", "SHIPMENT", shipment.id, {
    from,
    to: input.toStatus,
    orderType,
  });
  await sendOutbound(tx, {
    conversationId: input.conversationId,
    messageType: "SYSTEM_NOTICE",
    text: `已更新整票运输状态：${STATUS_LABELS[input.toStatus]}（${shipment.booking_ref}）。`,
    context: {
      orderId: shipment.order_id,
      bookingId: shipment.booking_id,
      shipmentId: shipment.id,
    },
  });
  const terminalMilestone =
    (orderType === "EXPORT_DRAYAGE" &&
      input.toStatus === "LADEN_CONTAINERS_RETURNED_TO_TERMINAL") ||
    (orderType === "IMPORT_DRAYAGE" && input.toStatus === "EMPTY_RETURNED");
  if (
    terminalMilestone &&
    (await requiredDocumentsPresent(tx, shipment.id, orderType))
  ) {
    await moveShipmentToReviewPending(tx, actor, {
      shipment: { ...shipment, current_status: input.toStatus },
      conversationId: input.conversationId,
      sourceMessageId: input.sourceMessageId,
      eventSuffix: input.eventKey,
    });
  }
  return { shipmentId: shipment.id, from, to: input.toStatus };
}

/** Material status updates are still versioned Actions, but the fleet sees numbered text. */
export async function proposeShipmentStatus(
  tx: Tx,
  actor: Actor,
  input: {
    conversationId: string;
    shipmentId: string;
    toStatus: ShipmentStatus;
    sourceMessageId: string;
  },
): Promise<{ messageId: string } | { invalid: string }> {
  const shipment = await lockShipmentForFleet(tx, input.shipmentId, actor.organizationId!);
  const from = shipment.current_status as ShipmentStatus;
  const orderType = shipment.order_type as OrderType;
  if (!canShipmentTransition(from, input.toStatus, orderType)) {
    return {
      invalid: `当前状态为「${STATUS_LABELS[from]}」，无法更新为「${STATUS_LABELS[input.toStatus]}」。如有特殊情况请联系运营。`,
    };
  }
  const { messageId } = await sendOutbound(tx, {
    conversationId: input.conversationId,
    messageType: "ACTION_PROMPT",
    text: `确认将整票状态更新为「${STATUS_LABELS[input.toStatus]}」？（${shipment.booking_ref}）`,
    structured: {
      kind: "SHIPMENT_STATUS_CONFIRMATION",
      reference: shipment.booking_ref,
      from: STATUS_LABELS[from],
      to: STATUS_LABELS[input.toStatus],
    },
    replyToMessageId: input.sourceMessageId,
    context: {
      orderId: shipment.order_id,
      bookingId: shipment.booking_id,
      shipmentId: shipment.id,
    },
    actions: [
      {
        actionType: "CONFIRM_SHIPMENT_STATUS",
        label: "确认更新",
        objectType: "SHIPMENT",
        objectId: shipment.id,
        expectedObjectVersion: shipment.version,
        payload: { shipmentId: shipment.id, toStatus: input.toStatus },
      },
      {
        actionType: "REQUEST_HUMAN",
        label: "状态不符，联系运营",
        objectType: "SHIPMENT",
        objectId: shipment.id,
        expectedObjectVersion: shipment.version,
        payload: { shipmentId: shipment.id },
      },
    ],
  });
  return { messageId };
}

async function chooseDocumentType(
  tx: Tx,
  shipment: Record<string, any>,
  requested?: ShipmentDocumentType | null,
): Promise<ShipmentDocumentType> {
  const orderType = shipment.order_type as OrderType;
  const allowed = REQUIRED_DOCUMENTS[orderType];
  if (requested) {
    if (!allowed.includes(requested)) {
      throw new CommandFailure(err("VALIDATION", `${DOCUMENT_LABELS[requested]} 不适用于该订单类型。`));
    }
    return requested;
  }
  const existing = await tx.query(
    `SELECT d.type
       FROM documents d JOIN document_links dl ON dl.document_id=d.id
      WHERE dl.shipment_id=$1 AND d.type = ANY($2::document_type[])
        AND d.review_status != 'REJECTED'`,
    [shipment.id, allowed],
  );
  const seen = new Set(existing.rows.map((row) => row.type));
  return allowed.find((type) => !seen.has(type)) ?? allowed[allowed.length - 1];
}

async function requiredDocumentsPresent(
  tx: Tx,
  shipmentId: string,
  orderType: OrderType,
): Promise<boolean> {
  const rows = await tx.query(
    `SELECT DISTINCT d.type
       FROM documents d JOIN document_links dl ON dl.document_id=d.id
      WHERE dl.shipment_id=$1
        AND d.type = ANY($2::document_type[])
        AND d.review_status != 'REJECTED'`,
    [shipmentId, REQUIRED_DOCUMENTS[orderType]],
  );
  const present = new Set(rows.rows.map((row) => row.type));
  return REQUIRED_DOCUMENTS[orderType].every((type) => present.has(type));
}

async function moveShipmentToReviewPending(
  tx: Tx,
  actor: Actor,
  input: {
    shipment: Record<string, any>;
    conversationId: string;
    sourceMessageId?: string | null;
    eventSuffix: string;
  },
): Promise<void> {
  const shipment = input.shipment;
  const from = shipment.current_status as ShipmentStatus;
  if (from === "REVIEW_PENDING") return;
  await tx.query(
    `UPDATE shipments SET current_status='REVIEW_PENDING', version=version+2, updated_at=now()
      WHERE id=$1`,
    [shipment.id],
  );
  await appendShipmentEvent(tx, {
    shipmentId: shipment.id,
    from,
    to: "DOCUMENTS_SUBMITTED",
    actor,
    sourceMessageId: input.sourceMessageId,
    eventKey: `documents-submitted:${input.eventSuffix}`,
    eventType: "DOCUMENTS_SUBMITTED",
  });
  await appendShipmentEvent(tx, {
    shipmentId: shipment.id,
    from: "DOCUMENTS_SUBMITTED",
    to: "REVIEW_PENDING",
    actor,
    sourceMessageId: input.sourceMessageId,
    eventKey: `review-pending:${input.eventSuffix}`,
    eventType: "REVIEW_PENDING",
  });
  await tx.query(
    `UPDATE bookings SET status='REVIEW_PENDING', version=version+1, updated_at=now()
      WHERE id=$1`,
    [shipment.booking_id],
  );
  const open = await tx.query(
    `SELECT id FROM exception_cases
      WHERE order_id=$1 AND type='DOCUMENT_REVIEW_REQUIRED'
        AND status IN ('OPEN','IN_PROGRESS')
      LIMIT 1`,
    [shipment.order_id],
  );
  if (!open.rowCount) {
    await tx.query(
      `INSERT INTO exception_cases (
         type, order_id, fleet_organization_id, conversation_id, summary, details
       )
       VALUES ('DOCUMENT_REVIEW_REQUIRED',$1,$2,$3,$4,$5)`,
      [
        shipment.order_id,
        actor.organizationId,
        input.conversationId,
        `Documents ready for review: ${shipment.order_ref}`,
        JSON.stringify({ shipmentId: shipment.id }),
      ],
    );
  }
}

export async function submitShipmentDocument(
  tx: Tx,
  actor: Actor,
  input: {
    conversationId: string;
    shipmentId: string;
    documentType?: ShipmentDocumentType | null;
    fileName: string;
    mimeType: string;
    data: Buffer;
    sourceMessageId?: string | null;
  },
): Promise<{ documentId: string; documentType: ShipmentDocumentType; shipmentStatus: string }> {
  if (!ALLOWED_DOCUMENT_MIME.test(input.mimeType)) {
    throw new CommandFailure(err("VALIDATION", "仅支持图片（PNG/JPG/WEBP/HEIC）或 PDF。"));
  }
  if (input.data.length > MAX_DOCUMENT_BYTES) {
    throw new CommandFailure(err("VALIDATION", "文件超过 10MB 限制。"));
  }
  const shipment = await lockShipmentForFleet(tx, input.shipmentId, actor.organizationId!);
  const orderType = shipment.order_type as OrderType;
  const documentType = await chooseDocumentType(tx, shipment, input.documentType);

  if (input.sourceMessageId) {
    await tx.query(
      `INSERT INTO message_context_links (message_id, order_id, booking_id, shipment_id)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (message_id) DO UPDATE SET
         order_id=EXCLUDED.order_id,
         booking_id=EXCLUDED.booking_id,
         shipment_id=EXCLUDED.shipment_id`,
      [input.sourceMessageId, shipment.order_id, shipment.booking_id, shipment.id],
    );
  }

  const safeName =
    path.basename(input.fileName).replace(/[^\w.\-\u4e00-\u9fff]+/g, "_").slice(0, 120) ||
    "document";
  const storageDir = process.env.STORAGE_DIR ?? "./var/storage";
  fs.mkdirSync(storageDir, { recursive: true });
  const storageKey = `${newId()}-${safeName}`;
  fs.writeFileSync(path.join(storageDir, storageKey), input.data);
  const checksum = createHash("sha256").update(input.data).digest("hex");

  const document = (
    await tx.query(
      `INSERT INTO documents (
         organization_id, type, file_name, mime_type, size_bytes, storage_key,
         checksum_sha256, uploaded_by_user_id, source_message_id
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id`,
      [
        actor.organizationId,
        documentType,
        safeName,
        input.mimeType,
        input.data.length,
        storageKey,
        checksum,
        actor.userId,
        input.sourceMessageId ?? null,
      ],
    )
  ).rows[0];
  await tx.query(
    `INSERT INTO document_links (document_id, order_id, booking_id, shipment_id)
     VALUES ($1,$2,$3,$4)`,
    [document.id, shipment.order_id, shipment.booking_id, shipment.id],
  );

  let finalStatus = shipment.current_status as ShipmentStatus;
  const completeSet = await requiredDocumentsPresent(tx, shipment.id, orderType);
  const operationallyComplete =
    (orderType === "EXPORT_DRAYAGE" &&
      shipment.current_status === "LADEN_CONTAINERS_RETURNED_TO_TERMINAL") ||
    (orderType === "IMPORT_DRAYAGE" && shipment.current_status === "EMPTY_RETURNED") ||
    shipment.current_status === "REVIEW_PENDING";

  if (completeSet && operationallyComplete && shipment.current_status !== "REVIEW_PENDING") {
    await moveShipmentToReviewPending(tx, actor, {
      shipment,
      conversationId: input.conversationId,
      sourceMessageId: input.sourceMessageId,
      eventSuffix: document.id,
    });
    finalStatus = "REVIEW_PENDING";
  }

  await audit(tx, {
    actor,
    action: "document.shipment_uploaded",
    objectType: "DOCUMENT",
    objectId: document.id,
    sourceMessageId: input.sourceMessageId ?? null,
    after: { shipmentId: shipment.id, type: documentType, checksum },
  });
  await emitOutbox(tx, "shipment.document_submitted", "SHIPMENT", shipment.id, {
    documentId: document.id,
    documentType,
  });
  await sendOutbound(tx, {
    conversationId: input.conversationId,
    messageType: "SYSTEM_NOTICE",
    text: completeSet
      ? `${DOCUMENT_LABELS[documentType]}已收到。必需文件已齐全，正在等待运营审核。`
      : `${DOCUMENT_LABELS[documentType]}已收到。还需要上传：${REQUIRED_DOCUMENTS[orderType]
          .filter((type) => type !== documentType)
          .map((type) => DOCUMENT_LABELS[type])
          .join("、")}。`,
    context: {
      orderId: shipment.order_id,
      bookingId: shipment.booking_id,
      shipmentId: shipment.id,
    },
  });
  return { documentId: document.id, documentType, shipmentStatus: finalStatus };
}

/** Compatibility name retained for old callers; v1.1 accepts all required document types. */
export async function submitPod(
  tx: Tx,
  actor: Actor,
  input: {
    conversationId: string;
    shipmentId: string;
    fileName: string;
    mimeType: string;
    data: Buffer;
    sourceMessageId?: string | null;
  },
) {
  return submitShipmentDocument(tx, actor, input);
}

export async function reviewShipmentDocuments(
  tx: Tx,
  actor: Actor,
  input: { shipmentId: string; approved: boolean; note?: string | null },
): Promise<{ shipmentId: string; status: ShipmentStatus }> {
  if (actor.actorType !== "OPERATOR") {
    throw new CommandFailure(err("FORBIDDEN", "Operator review required"));
  }
  const shipment = (
    await tx.query(
      `SELECT s.*, b.id AS booking_id2, b.order_id, b.fleet_organization_id,
              b.public_reference AS booking_ref, o.order_type, o.public_reference AS order_ref
         FROM shipments s
         JOIN bookings b ON b.id=s.booking_id
         JOIN orders o ON o.id=b.order_id
        WHERE s.id=$1
        FOR UPDATE OF s, b, o`,
      [input.shipmentId],
    )
  ).rows[0];
  if (!shipment) throw new CommandFailure(err("NOT_FOUND", "Shipment not found"));
  const orderType = shipment.order_type as OrderType;
  if (shipment.current_status !== "REVIEW_PENDING") {
    throw new CommandFailure(err("INVALID_TRANSITION", "该任务当前不在文件审核阶段。"));
  }
  if (!(await requiredDocumentsPresent(tx, shipment.id, orderType))) {
    throw new CommandFailure(err("VALIDATION", "必需文件尚未齐全。"));
  }

  if (!input.approved) {
    await tx.query(
      `UPDATE documents d
          SET review_status='REJECTED', reviewed_by_user_id=$2,
              reviewed_at=now(), review_note=$3
        FROM document_links dl
       WHERE dl.document_id=d.id AND dl.shipment_id=$1
         AND d.review_status='PENDING'`,
      [shipment.id, actor.userId, input.note ?? "请补充或重新上传文件"],
    );
    const conversation = await getOrCreateConversation(tx, shipment.fleet_organization_id);
    await sendOutbound(tx, {
      conversationId: conversation.id,
      senderType: "OPERATOR",
      messageType: "SYSTEM_NOTICE",
      text: `任务 ${shipment.booking_ref} 的文件需要补充：${input.note ?? "请重新检查并上传清晰、完整的证明。"}`,
      context: {
        orderId: shipment.order_id,
        bookingId: shipment.booking_id,
        shipmentId: shipment.id,
      },
    });
    await audit(tx, {
      actor,
      action: "shipment.documents_rejected",
      objectType: "SHIPMENT",
      objectId: shipment.id,
      metadata: { note: input.note ?? null },
    });
    return { shipmentId: shipment.id, status: "REVIEW_PENDING" };
  }

  await tx.query(
    `UPDATE documents d
        SET review_status='APPROVED', reviewed_by_user_id=$2,
            reviewed_at=now(), review_note=$3
      FROM document_links dl
     WHERE dl.document_id=d.id AND dl.shipment_id=$1
       AND d.review_status='PENDING'`,
    [shipment.id, actor.userId, input.note ?? null],
  );
  await tx.query(
    `UPDATE shipments SET current_status='COMPLETED', version=version+1, updated_at=now()
      WHERE id=$1`,
    [shipment.id],
  );
  await tx.query(
    `UPDATE bookings SET status='COMPLETED', version=version+1, updated_at=now()
      WHERE id=$1`,
    [shipment.booking_id],
  );
  await tx.query(
    `UPDATE orders SET status='COMPLETED', version=version+1, updated_at=now()
      WHERE id=$1`,
    [shipment.order_id],
  );
  await tx.query(
    `UPDATE exception_cases
        SET status='RESOLVED', resolved_at=now(), assigned_operator_user_id=$2
      WHERE order_id=$1 AND type='DOCUMENT_REVIEW_REQUIRED'
        AND status IN ('OPEN','IN_PROGRESS')`,
    [shipment.order_id, actor.userId],
  );
  await appendShipmentEvent(tx, {
    shipmentId: shipment.id,
    from: "REVIEW_PENDING",
    to: "COMPLETED",
    actor,
    eventKey: `document-review:${shipment.id}:${shipment.version}`,
    eventType: "DOCUMENT_REVIEW_APPROVED",
    payload: { note: input.note ?? null },
  });
  await audit(tx, {
    actor,
    action: "shipment.documents_approved",
    objectType: "SHIPMENT",
    objectId: shipment.id,
    before: { status: "REVIEW_PENDING" },
    after: { status: "COMPLETED" },
    metadata: { note: input.note ?? null },
  });
  await emitOutbox(tx, "shipment.completed", "SHIPMENT", shipment.id, {});
  const conversation = await getOrCreateConversation(tx, shipment.fleet_organization_id);
  await sendOutbound(tx, {
    conversationId: conversation.id,
    senderType: "OPERATOR",
    messageType: "SYSTEM_NOTICE",
    text: `任务 ${shipment.booking_ref} 的文件已审核通过，订单已完成。`,
    context: {
      orderId: shipment.order_id,
      bookingId: shipment.booking_id,
      shipmentId: shipment.id,
    },
  });
  return { shipmentId: shipment.id, status: "COMPLETED" };
}
