import type { FastifyInstance } from "fastify";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import type { Db } from "@mercury/db";
import { withTx } from "@mercury/db";
import {
  applyOrderFleetVisibleChange, audit, newId, selectQuoteAndOfferBooking, sendRfqToFleet,
  actorFromSession, buildFleetCandidates, cancelOrder, deleteUnsentOrder,
  reviewFleetProfile, reviewShipmentDocuments, sendOutbound, type SessionInfo,
} from "@mercury/application";

const CreateOrder = z.object({
  publicReference: z.string().optional(),
  customerReference: z.string().nullable().optional(),
  orderType: z.enum(["EXPORT_DRAYAGE", "IMPORT_DRAYAGE"]),
  serviceCountry: z.string().trim().length(2).transform((value) => value.toUpperCase()),
  containerType: z.string().min(1),
  containerQuantity: z.number().int().positive(),
  requestedStartAt: z.string().datetime(),
  requestedCompleteAt: z.string().datetime().nullable().optional(),
  loadingLocation: z.string().trim().nullable().optional(),
  originTerminal: z.string().trim().nullable().optional(),
  destinationTerminal: z.string().trim().nullable().optional(),
  deliveryLocation: z.string().trim().nullable().optional(),
  emptyContainerPickupLocation: z.string().trim().nullable().optional(),
  emptyContainerPickupAt: z.string().datetime().nullable().optional(),
  emptyContainerReturnLocation: z.string().trim().nullable().optional(),
  emptyContainerReturnDeadline: z.string().datetime().nullable().optional(),
  terminalCutoffAt: z.string().datetime().nullable().optional(),
  specialRequirements: z.string().nullable().optional(),
  carrierBookingReference: z.string().nullable().optional(),
  billOfLadingReference: z.string().nullable().optional(),
  shippingLine: z.string().nullable().optional(),
  vesselName: z.string().nullable().optional(),
  voyageNumber: z.string().nullable().optional(),
  pickupContactName: z.string().nullable().optional(),
  pickupContactPhone: z.string().nullable().optional(),
  deliveryContactName: z.string().nullable().optional(),
  deliveryContactPhone: z.string().nullable().optional(),
  containerNumber: z.string().nullable().optional(),
  sealNumber: z.string().nullable().optional(),
  cargoDescription: z.string().nullable().optional(),
  grossWeightKg: z.number().nonnegative().nullable().optional(),
  isHazardous: z.boolean().optional(),
  unNumber: z.string().nullable().optional(),
  isReefer: z.boolean().optional(),
  reeferTemperatureC: z.number().nullable().optional(),
}).superRefine((value, context) => {
  const require = (field: keyof typeof value, label: string) => {
    if (!value[field]) {
      context.addIssue({ code: "custom", path: [field], message: `${label}为必填项` });
    }
  };
  if (value.orderType === "EXPORT_DRAYAGE") {
    require("loadingLocation", "装货地点");
    require("originTerminal", "起运码头");
    require("emptyContainerPickupLocation", "空箱提取地点");
    require("emptyContainerPickupAt", "计划提空箱时间");
  } else {
    require("destinationTerminal", "目的码头");
    require("deliveryLocation", "送货地点");
    require("emptyContainerReturnLocation", "空箱归还地点");
  }
  if (value.isHazardous) require("unNumber", "UN 编号");
  if (value.isReefer && value.reeferTemperatureC == null) {
    context.addIssue({ code: "custom", path: ["reeferTemperatureC"], message: "冷藏温度为必填项" });
  }
});

// Fleet targeting is optional: omitting it broadcasts to every eligible
// enabled fleet, which is the documented default for a new order.
const SendRfq = z.object({
  fleetOrganizationIds: z.array(z.string().uuid()).min(1).optional(),
});

const PatchOrder = z.object({
  /** Why the operator made this change; recorded in the audit trail. */
  reason: z.string().trim().min(1).max(500).optional(),
  customerReference: z.string().nullable().optional(),
  orderType: z.enum(["EXPORT_DRAYAGE", "IMPORT_DRAYAGE"]).optional(),
  serviceCountry: z.string().trim().length(2).transform((value) => value.toUpperCase()).optional(),
  requestedStartAt: z.string().datetime().optional(),
  requestedCompleteAt: z.string().datetime().nullable().optional(),
  loadingLocation: z.string().nullable().optional(),
  originTerminal: z.string().nullable().optional(),
  destinationTerminal: z.string().nullable().optional(),
  deliveryLocation: z.string().nullable().optional(),
  emptyContainerPickupAt: z.string().datetime().nullable().optional(),
  terminalCutoffAt: z.string().datetime().nullable().optional(),
  pickupLocationText: z.string().optional(),
  deliveryLocationText: z.string().optional(),
  containerType: z.string().optional(),
  containerQuantity: z.number().int().positive().optional(),
  pickupAt: z.string().optional(),
  deliveryAt: z.string().nullable().optional(),
  specialRequirements: z.string().nullable().optional(),
  carrierBookingReference: z.string().nullable().optional(),
  billOfLadingReference: z.string().nullable().optional(),
  shippingLine: z.string().nullable().optional(),
  vesselName: z.string().nullable().optional(),
  voyageNumber: z.string().nullable().optional(),
  pickupContactName: z.string().nullable().optional(),
  pickupContactPhone: z.string().nullable().optional(),
  deliveryContactName: z.string().nullable().optional(),
  deliveryContactPhone: z.string().nullable().optional(),
  emptyContainerPickupLocation: z.string().nullable().optional(),
  emptyContainerReturnLocation: z.string().nullable().optional(),
  emptyContainerReturnDeadline: z.string().nullable().optional(),
  containerNumber: z.string().nullable().optional(),
  sealNumber: z.string().nullable().optional(),
  cargoDescription: z.string().nullable().optional(),
  grossWeightKg: z.number().nonnegative().nullable().optional(),
  isHazardous: z.boolean().optional(),
  unNumber: z.string().nullable().optional(),
  isReefer: z.boolean().optional(),
  reeferTemperatureC: z.number().nullable().optional(),
});

const ExceptionReply = z.object({ text: z.string().trim().min(1).max(2000) });
const ExceptionStatus = z.object({
  status: z.enum(["OPEN", "IN_PROGRESS", "RESOLVED", "DISMISSED"]),
});
const ProfileReview = z.object({
  approved: z.boolean(),
  note: z.string().trim().max(1000).nullable().optional(),
});
const DocumentReview = z.object({
  approved: z.boolean(),
  note: z.string().trim().max(1000).nullable().optional(),
});

const FIELD_MAP: Record<string, string> = {
  customerReference: "customer_reference",
  orderType: "order_type",
  serviceCountry: "service_country",
  requestedStartAt: "requested_start_at",
  requestedCompleteAt: "requested_complete_at",
  loadingLocation: "loading_location",
  originTerminal: "origin_terminal",
  destinationTerminal: "destination_terminal",
  deliveryLocation: "delivery_location",
  emptyContainerPickupAt: "empty_container_pickup_at",
  terminalCutoffAt: "terminal_cutoff_at",
  pickupLocationText: "pickup_location_text",
  deliveryLocationText: "delivery_location_text",
  containerType: "container_type",
  containerQuantity: "container_quantity",
  pickupAt: "pickup_at",
  deliveryAt: "delivery_at",
  specialRequirements: "special_requirements",
  carrierBookingReference: "carrier_booking_reference",
  billOfLadingReference: "bill_of_lading_reference",
  shippingLine: "shipping_line",
  vesselName: "vessel_name",
  voyageNumber: "voyage_number",
  pickupContactName: "pickup_contact_name",
  pickupContactPhone: "pickup_contact_phone",
  deliveryContactName: "delivery_contact_name",
  deliveryContactPhone: "delivery_contact_phone",
  emptyContainerPickupLocation: "empty_container_pickup_location",
  emptyContainerReturnLocation: "empty_container_return_location",
  emptyContainerReturnDeadline: "empty_container_return_deadline",
  containerNumber: "container_number",
  sealNumber: "seal_number",
  cargoDescription: "cargo_description",
  grossWeightKg: "gross_weight_kg",
  isHazardous: "is_hazardous",
  unNumber: "un_number",
  isReefer: "is_reefer",
  reeferTemperatureC: "reefer_temperature_c",
};

/**
 * Operator portal API.
 *
 * These routes back the Operator workspace, which is a real product surface —
 * not a simulator. They were previously registered under `/api/operator/*` behind a
 * `NODE_ENV === "production"` kill-switch, which meant the whole Operator portal
 * stopped working in production. Every route authorizes from the server-side
 * session and requires the OPERATOR role.
 */
export function registerOperatorRoutes(app: FastifyInstance, db: Db): void {

  const requireOperator = (req: any, reply: any): SessionInfo | null => {
    const s: SessionInfo | null = req.session;
    if (!s) {
      reply.code(401).send({ error: "Not authenticated" });
      return null;
    }
    if (s.role !== "OPERATOR") {
      reply.code(403).send({ error: "需要运营账号权限" });
      return null;
    }
    return s;
  };
  const idem = (req: any): string => (req.headers["x-idempotency-key"] as string) ?? newId();

  app.post("/api/operator/orders", async (req, reply) => {
    const s = requireOperator(req, reply);
    if (!s) return;
    const body = CreateOrder.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    const d = body.data;
    const customer = await db.query(`SELECT id FROM organizations WHERE type='CUSTOMER' ORDER BY created_at LIMIT 1`);
    if (!customer.rowCount) return reply.code(422).send({ error: "No customer organization seeded" });
    const ref = d.publicReference ?? `M-${Date.now().toString(36).toUpperCase()}`;
    const row = await withTx(db, async (tx) => {
      const r = await tx.query(
        `INSERT INTO orders (
           public_reference, customer_organization_id, status, customer_reference,
           pickup_location_text, delivery_location_text, container_type, container_quantity,
           pickup_at, delivery_at, special_requirements, carrier_booking_reference,
           bill_of_lading_reference, shipping_line, vessel_name, voyage_number,
           pickup_contact_name, pickup_contact_phone, delivery_contact_name, delivery_contact_phone,
           empty_container_pickup_location, empty_container_return_location, empty_container_return_deadline,
           container_number, seal_number, cargo_description, gross_weight_kg,
           is_hazardous, un_number, is_reefer, reefer_temperature_c,
           order_type, service_country, requested_start_at, requested_complete_at,
           loading_location, origin_terminal, destination_terminal, delivery_location,
           empty_container_pickup_at, terminal_cutoff_at
         ) VALUES (
           $1,$2,'DRAFT',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
           $20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,
           $31,$32,$33,$34,$35,$36,$37,$38,$39,$40
         ) RETURNING *`,
        [
          ref, customer.rows[0].id, d.customerReference ?? null,
          d.orderType === "EXPORT_DRAYAGE" ? d.emptyContainerPickupLocation : d.destinationTerminal,
          d.orderType === "EXPORT_DRAYAGE" ? d.originTerminal : d.deliveryLocation,
          d.containerType, d.containerQuantity,
          d.requestedStartAt, d.requestedCompleteAt ?? null, d.specialRequirements ?? null,
          d.carrierBookingReference ?? null, d.billOfLadingReference ?? null,
          d.shippingLine ?? null, d.vesselName ?? null, d.voyageNumber ?? null,
          d.pickupContactName ?? null, d.pickupContactPhone ?? null,
          d.deliveryContactName ?? null, d.deliveryContactPhone ?? null,
          d.emptyContainerPickupLocation ?? null, d.emptyContainerReturnLocation ?? null,
          d.emptyContainerReturnDeadline ?? null, d.containerNumber ?? null, d.sealNumber ?? null,
          d.cargoDescription ?? null, d.grossWeightKg ?? null, d.isHazardous ?? false,
          d.unNumber ?? null, d.isReefer ?? false, d.reeferTemperatureC ?? null,
          d.orderType, d.serviceCountry, d.requestedStartAt, d.requestedCompleteAt ?? null,
          d.loadingLocation ?? null, d.originTerminal ?? null,
          d.destinationTerminal ?? null, d.deliveryLocation ?? null,
          d.emptyContainerPickupAt ?? null, d.terminalCutoffAt ?? null,
        ],
      );
      await audit(tx, {
        actor: actorFromSession(s), action: "order.created", objectType: "ORDER", objectId: r.rows[0].id,
        after: { publicReference: ref },
      });
      return r.rows[0];
    });
    const candidates = await buildFleetCandidates(db, row.id);
    return {
      order: row,
      dispatchedFleetCount: 0,
      candidates,
    };
  });

  app.get("/api/operator/orders/:orderId/candidates", async (req, reply) => {
    const s = requireOperator(req, reply);
    if (!s) return;
    const { orderId } = req.params as { orderId: string };
    return { candidates: await buildFleetCandidates(db, orderId) };
  });

  app.post("/api/operator/orders/:orderId/send-rfq", async (req, reply) => {
    const s = requireOperator(req, reply);
    if (!s) return;
    const body = SendRfq.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    const { orderId } = req.params as { orderId: string };

    // Default behaviour: send to every eligible enabled fleet. Explicit
    // targeting is honoured when supplied, but the operator is always told
    // which fleets were intended and which actually received the RFQ.
    const candidateRows = await buildFleetCandidates(db, orderId);
    const sendable = (
      await db.query(
        `SELECT o.id, o.name
           FROM organizations o
           JOIN fleet_profiles p ON p.fleet_organization_id=o.id
          WHERE o.type='FLEET' AND o.status='ACTIVE' AND p.accepting_orders=true
          ORDER BY name`,
      )
    ).rows as { id: string; name: string }[];

    const requested = body.data.fleetOrganizationIds;
    const targets = requested
      ? sendable.filter((f) => requested.includes(f.id))
      : sendable.filter((f) => candidateRows.some((candidate) => candidate.id === f.id && candidate.eligible));

    const unknown = requested ? requested.filter((id) => !sendable.some((f) => f.id === id)) : [];
    if (!targets.length) {
      return reply.code(422).send({
        error: "没有可发送的车队",
        detail: requested
          ? "指定的车队不存在或已停用。"
          : "当前没有符合档案条件且正在接单的车队。",
      });
    }

    await withTx(db, (tx) =>
      audit(tx, {
        actor: actorFromSession(s),
        action: "rfq.recipients_confirmed",
        objectType: "ORDER",
        objectId: orderId,
        metadata: {
          mode: requested ? "EXPLICIT" : "MATCHED_DEFAULT",
          selectedFleetOrganizationIds: targets.map((fleet) => fleet.id),
          defaultEligibleFleetOrganizationIds: candidateRows
            .filter((candidate) => candidate.eligible)
            .map((candidate) => candidate.id),
        },
      }),
    );

    const results = [];
    for (const fleet of targets) {
      results.push({
        fleetOrganizationId: fleet.id,
        fleetName: fleet.name,
        outcome: await sendRfqToFleet(
          db,
          actorFromSession(s),
          { orderId, fleetOrganizationId: fleet.id },
          `${idem(req)}:${fleet.id}`,
        ),
      });
    }

    const failures = results.filter((r) => !r.outcome.ok);
    return reply.code(failures.length && failures.length === results.length ? 422 : 200).send({
      targeting: requested ? "EXPLICIT" : "MATCHED_FLEETS",
      intendedRecipients: targets.map((f) => ({ id: f.id, name: f.name })),
      deliveredTo: results.filter((r) => r.outcome.ok).map((r) => ({ id: r.fleetOrganizationId, name: r.fleetName })),
      failedFor: failures.map((r) => ({ id: r.fleetOrganizationId, name: r.fleetName, outcome: r.outcome })),
      unknownFleetIds: unknown,
      results,
    });
  });

  app.get("/api/operator/fleet-profiles/pending", async (req, reply) => {
    const s = requireOperator(req, reply);
    if (!s) return;
    const rows = await db.query(
      `SELECT v.*, p.fleet_organization_id, o.name AS organization_name,
              COALESCE(
                (SELECT json_agg(c.country_code ORDER BY c.country_code)
                   FROM fleet_profile_version_countries c
                  WHERE c.fleet_profile_version_id=v.id),
                '[]'::json
              ) AS operating_countries,
              previous.fleet_name AS previous_fleet_name,
              previous.supports_hazardous AS previous_supports_hazardous,
              previous.supports_reefer AS previous_supports_reefer,
              previous.contact_name AS previous_contact_name,
              previous.contact_phone AS previous_contact_phone,
              previous.notes AS previous_notes
         FROM fleet_profile_versions v
         JOIN fleet_profiles p ON p.id=v.fleet_profile_id
         JOIN organizations o ON o.id=p.fleet_organization_id
         LEFT JOIN fleet_profile_versions previous ON previous.id=p.approved_version_id
        WHERE v.status='PENDING_REVIEW'
        ORDER BY v.submitted_at`,
    );
    const fleets = await db.query(
      `SELECT o.id, o.name, o.status, p.accepting_orders
         FROM organizations o
         LEFT JOIN fleet_profiles p ON p.fleet_organization_id=o.id
        WHERE o.type='FLEET'
        ORDER BY o.name`,
    );
    return { profiles: rows.rows, fleets: fleets.rows };
  });

  app.patch("/api/operator/fleets/:fleetId/status", async (req, reply) => {
    const s = requireOperator(req, reply);
    if (!s) return;
    const parsed = z.object({ status: z.enum(["ACTIVE", "SUSPENDED"]) }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const { fleetId } = req.params as { fleetId: string };
    const result = await withTx(db, async (tx) => {
      const before = (
        await tx.query(
          `SELECT id, status FROM organizations WHERE id=$1 AND type='FLEET' FOR UPDATE`,
          [fleetId],
        )
      ).rows[0];
      if (!before) return null;
      await tx.query(
        `UPDATE organizations SET status=$2, updated_at=now() WHERE id=$1`,
        [fleetId, parsed.data.status],
      );
      await audit(tx, {
        actor: actorFromSession(s),
        action: "fleet.account_status_changed",
        objectType: "ORGANIZATION",
        objectId: fleetId,
        before: { status: before.status },
        after: { status: parsed.data.status },
      });
      return { id: fleetId, status: parsed.data.status };
    });
    if (!result) return reply.code(404).send({ error: "Fleet not found" });
    return { fleet: result };
  });

  app.post("/api/operator/fleet-profiles/:versionId/review", async (req, reply) => {
    const s = requireOperator(req, reply);
    if (!s) return;
    const parsed = ProfileReview.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const { versionId } = req.params as { versionId: string };
    const result = await withTx(db, (tx) =>
      reviewFleetProfile(tx, actorFromSession(s), {
        versionId,
        approved: parsed.data.approved,
        note: parsed.data.note,
      }),
    );
    return { profile: result };
  });

  app.post("/api/operator/shipments/:shipmentId/documents/review", async (req, reply) => {
    const s = requireOperator(req, reply);
    if (!s) return;
    const parsed = DocumentReview.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const { shipmentId } = req.params as { shipmentId: string };
    const result = await withTx(db, (tx) =>
      reviewShipmentDocuments(tx, actorFromSession(s), {
        shipmentId,
        approved: parsed.data.approved,
        note: parsed.data.note,
      }),
    );
    return { shipment: result };
  });

  app.get("/api/operator/shipments/:shipmentId/documents", async (req, reply) => {
    const s = requireOperator(req, reply);
    if (!s) return;
    const { shipmentId } = req.params as { shipmentId: string };
    const rows = await db.query(
      `SELECT d.id, d.type, d.file_name, d.mime_type, d.size_bytes,
              d.review_status, d.reviewed_at, d.review_note, d.created_at
         FROM documents d
         JOIN document_links dl ON dl.document_id=d.id
        WHERE dl.shipment_id=$1
        ORDER BY d.created_at`,
      [shipmentId],
    );
    return { documents: rows.rows };
  });

  app.get("/api/operator/documents/:documentId/download", async (req, reply) => {
    const s = requireOperator(req, reply);
    if (!s) return;
    const { documentId } = req.params as { documentId: string };
    const document = (
      await db.query(
        `SELECT id, file_name, mime_type, storage_key FROM documents WHERE id=$1`,
        [documentId],
      )
    ).rows[0];
    if (!document) return reply.code(404).send({ error: "Document not found" });
    const filePath = path.join(
      process.env.STORAGE_DIR ?? "./var/storage",
      path.basename(document.storage_key),
    );
    if (!fs.existsSync(filePath)) return reply.code(404).send({ error: "File missing" });
    reply.header("content-type", document.mime_type);
    reply.header(
      "content-disposition",
      `inline; filename*=UTF-8''${encodeURIComponent(document.file_name)}`,
    );
    return reply.send(fs.createReadStream(filePath));
  });

  app.delete("/api/operator/orders/:orderId", async (req, reply) => {
    const s = requireOperator(req, reply);
    if (!s) return;
    const { orderId } = req.params as { orderId: string };
    const result = await deleteUnsentOrder(db, actorFromSession(s), { orderId }, idem(req));
    if (!result.ok) return reply.code(422).send(result);
    return result;
  });

  app.post("/api/operator/orders/:orderId/cancel", async (req, reply) => {
    const s = requireOperator(req, reply);
    if (!s) return;
    const { orderId } = req.params as { orderId: string };
    const body = (req.body ?? {}) as { reason?: string };
    const result = await cancelOrder(db, actorFromSession(s), { orderId, reason: body.reason ?? null }, idem(req));
    if (!result.ok) return reply.code(422).send(result);
    return result;
  });

  app.post("/api/operator/orders/:orderId/rebroadcast", async (req, reply) => {
    const s = requireOperator(req, reply);
    if (!s) return;
    const { orderId } = req.params as { orderId: string };
    const fleets = await db.query(`SELECT id, name FROM organizations WHERE type='FLEET' ORDER BY name`);
    const results = [];
    for (const fleet of fleets.rows) {
      results.push({
        fleet: fleet.name,
        result: await sendRfqToFleet(
          db,
          actorFromSession(s),
          { orderId, fleetOrganizationId: fleet.id },
          `${idem(req)}:rebroadcast:${fleet.id}`,
        ),
      });
    }
    return { results };
  });

  app.patch("/api/operator/orders/:orderId/fleet-visible-fields", async (req, reply) => {
    const s = requireOperator(req, reply);
    if (!s) return;
    const body = PatchOrder.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    const { orderId } = req.params as { orderId: string };
    const { reason, ...fields } = body.data;
    const changes: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(fields)) {
      // reason is metadata about the edit, never an editable order column.
      if (v !== undefined && FIELD_MAP[k]) changes[FIELD_MAP[k]] = v;
    }
    const result = await applyOrderFleetVisibleChange(
      db,
      actorFromSession(s),
      { orderId, changes, reason: reason ?? null },
      idem(req),
    );
    if (!result.ok) return reply.code(422).send(result);
    return result;
  });

  app.post("/api/operator/quotes/:quoteId/select", async (req, reply) => {
    const s = requireOperator(req, reply);
    if (!s) return;
    const { quoteId } = req.params as { quoteId: string };
    const result = await selectQuoteAndOfferBooking(db, actorFromSession(s), { quoteId }, idem(req));
    if (!result.ok) return reply.code(422).send(result);
    return result;
  });

  app.post("/api/operator/bookings/:bookingId/cancel", async (req, reply) => {
    const s = requireOperator(req, reply);
    if (!s) return;
    const { bookingId } = req.params as { bookingId: string };
    const result = await withTx(db, async (tx) => {
      const b = (await tx.query(`SELECT * FROM bookings WHERE id=$1 FOR UPDATE`, [bookingId])).rows[0];
      if (!b) return { ok: false as const, error: "Not found" };
      if (["COMPLETED", "CANCELLED_BY_FLEET", "CANCELLED_BY_CUSTOMER", "CANCELLED_BY_OPERATOR"].includes(b.status)) {
        return { ok: false as const, error: `Booking is ${b.status}` };
      }
      await tx.query(
        `UPDATE bookings SET status='CANCELLED_BY_OPERATOR', cancelled_at=now(), cancellation_reason='Cancelled via simulator', version=version+1, updated_at=now() WHERE id=$1`,
        [bookingId],
      );
      await audit(tx, { actor: actorFromSession(s), action: "booking.cancelled_by_operator", objectType: "BOOKING", objectId: bookingId });
      return { ok: true as const };
    });
    if (!result.ok) return reply.code(422).send(result);
    return result;
  });

  app.post("/api/operator/exceptions/:exceptionId/reply", async (req, reply) => {
    const s = requireOperator(req, reply);
    if (!s) return;
    const body = ExceptionReply.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    const { exceptionId } = req.params as { exceptionId: string };
    const result = await withTx(db, async (tx) => {
      const exception = (
        await tx.query(`SELECT * FROM exception_cases WHERE id=$1 FOR UPDATE`, [exceptionId])
      ).rows[0];
      if (!exception) return null;
      if (!exception.conversation_id) return { error: "该异常没有可回复的车队会话。" };
      const recipient = exception.rfq_id && exception.fleet_organization_id
        ? (
            await tx.query(
              `SELECT rr.id, f.revision
                 FROM rfq_recipients rr JOIN rfqs f ON f.id=rr.rfq_id
                WHERE rr.rfq_id=$1 AND rr.fleet_organization_id=$2`,
              [exception.rfq_id, exception.fleet_organization_id],
            )
          ).rows[0]
        : null;
      const sent = await sendOutbound(tx, {
        conversationId: exception.conversation_id,
        senderType: "OPERATOR",
        messageType: "TEXT",
        text: body.data.text,
        context: {
          orderId: exception.order_id,
          rfqId: exception.rfq_id,
          rfqRecipientId: recipient?.id ?? null,
          rfqRevision: recipient?.revision ?? null,
        },
      });
      await tx.query(
        `UPDATE exception_cases
            SET status='IN_PROGRESS', assigned_operator_user_id=$2
          WHERE id=$1`,
        [exception.id, s.user.id],
      );
      await audit(tx, {
        actor: actorFromSession(s),
        action: "exception.operator_replied",
        objectType: "EXCEPTION",
        objectId: exception.id,
        after: { messageId: sent.messageId },
      });
      return { messageId: sent.messageId };
    });
    if (!result) return reply.code(404).send({ error: "Exception not found" });
    if ("error" in result) return reply.code(422).send(result);
    return { ok: true, ...result };
  });

  app.patch("/api/operator/exceptions/:exceptionId", async (req, reply) => {
    const s = requireOperator(req, reply);
    if (!s) return;
    const body = ExceptionStatus.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.flatten() });
    const { exceptionId } = req.params as { exceptionId: string };
    const row = await withTx(db, async (tx) => {
      const before = (
        await tx.query(`SELECT * FROM exception_cases WHERE id=$1 FOR UPDATE`, [exceptionId])
      ).rows[0];
      if (!before) return null;
      const updated = (
        await tx.query(
          `UPDATE exception_cases
              SET status=$2,
                  assigned_operator_user_id=COALESCE(assigned_operator_user_id,$3),
                  resolved_at=CASE WHEN $2 IN ('RESOLVED','DISMISSED') THEN now() ELSE NULL END
            WHERE id=$1 RETURNING *`,
          [exceptionId, body.data.status, s.user.id],
        )
      ).rows[0];
      await audit(tx, {
        actor: actorFromSession(s),
        action: "exception.status_changed",
        objectType: "EXCEPTION",
        objectId: exceptionId,
        before: { status: before.status },
        after: { status: updated.status },
      });
      return updated;
    });
    if (!row) return reply.code(404).send({ error: "Exception not found" });
    return { exception: row };
  });

  /** Inspection helpers for the demo/dev panel. */
  app.get("/api/operator/state", async (req, reply) => {
    const s = requireOperator(req, reply);
    if (!s) return;
    const [orders, rfqs, recipients, quotes, bookings, shipments, exceptions, fleets] = await Promise.all([
      db.query(`SELECT * FROM orders ORDER BY created_at DESC LIMIT 20`),
      db.query(`SELECT * FROM rfqs ORDER BY created_at DESC LIMIT 20`),
      db.query(`SELECT rr.*, o.name AS fleet_name FROM rfq_recipients rr JOIN organizations o ON o.id=rr.fleet_organization_id ORDER BY rr.created_at DESC LIMIT 40`),
      db.query(`SELECT * FROM quotes ORDER BY created_at DESC LIMIT 40`),
      db.query(`SELECT * FROM bookings ORDER BY created_at DESC LIMIT 20`),
      db.query(`SELECT * FROM shipments ORDER BY created_at DESC LIMIT 20`),
      db.query(`SELECT * FROM exception_cases WHERE status IN ('OPEN','IN_PROGRESS') ORDER BY created_at DESC LIMIT 100`),
      db.query(`SELECT id, name FROM organizations WHERE type='FLEET' ORDER BY name`),
    ]);
    return {
      orders: orders.rows, rfqs: rfqs.rows, recipients: recipients.rows, quotes: quotes.rows,
      bookings: bookings.rows, shipments: shipments.rows, exceptions: exceptions.rows, fleets: fleets.rows,
    };
  });

  app.get("/api/operator/audit", async (req, reply) => {
    const s = requireOperator(req, reply);
    if (!s) return;
    const rows = await db.query(`SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 100`);
    return { audit: rows.rows };
  });
}
