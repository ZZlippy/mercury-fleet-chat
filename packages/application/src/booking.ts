import type { Db, Tx } from "@mercury/db";
import { err, type CommandResult } from "@mercury/contracts";
import {
  canBookingTransition, formatMoney, CANCELLED_BOOKING_STATUSES,
  initialShipmentStatus, type OrderType,
} from "@mercury/domain";
import { type Actor, audit, CommandFailure, emitOutbox, runCommand } from "./kernel.ts";
import { getOrCreateConversation, sendOutbound } from "./messaging.ts";
import { bookingOfferCard } from "./cards.ts";
import { lockRecipientCtx } from "./quotes.ts";

/** Operator/dev flow: select a submitted quote and offer the booking (§11.9). */
export async function selectQuoteAndOfferBooking(
  db: Db,
  actor: Actor,
  input: { quoteId: string },
  idempotencyKey: string,
): Promise<CommandResult<{ bookingId: string; bookingRef: string }>> {
  return runCommand(db, { key: idempotencyKey, type: "SelectQuoteAndOfferBooking" }, async (tx) => {
    const candidate = (await tx.query(`SELECT rfq_recipient_id FROM quotes WHERE id=$1`, [input.quoteId])).rows[0];
    if (!candidate) throw new CommandFailure(err("NOT_FOUND", "Quote not found"));
    const { recipient, rfq, order } = await lockRecipientCtx(tx, candidate.rfq_recipient_id);
    const q = (await tx.query(`SELECT * FROM quotes WHERE id=$1 FOR UPDATE`, [input.quoteId])).rows[0];

    if (q.status !== "SUBMITTED") throw new CommandFailure(err("INVALID_TRANSITION", `Quote is ${q.status}, not SUBMITTED`));
    if (recipient.status !== "QUOTED") {
      throw new CommandFailure(err("INVALID_TRANSITION", `Fleet response is ${recipient.status}, not QUOTED`));
    }
    if (q.based_on_order_version !== order.version || q.based_on_rfq_revision !== rfq.revision) {
      throw new CommandFailure(err("STALE_REVISION", "Quote does not match current order/RFQ versions"));
    }
    const existing = await tx.query(
      `SELECT id FROM bookings WHERE order_id=$1 AND status != ALL($2::booking_status[])`,
      [order.id, CANCELLED_BOOKING_STATUSES],
    );
    if (existing.rowCount) throw new CommandFailure(err("CONFLICT", "Order already has an active booking"));

    await tx.query(`UPDATE quotes SET status='ACCEPTED', version=version+1, updated_at=now() WHERE id=$1`, [q.id]);
    const rejected = await tx.query(
      `UPDATE quotes qq SET status='REJECTED', version=qq.version+1, updated_at=now()
        FROM rfq_recipients r
       WHERE qq.rfq_recipient_id=r.id AND r.rfq_id=$1 AND qq.status='SUBMITTED' AND qq.id<>$2
       RETURNING qq.id`,
      [rfq.id, q.id],
    );
    await tx.query(`UPDATE rfqs SET status='CLOSED', updated_at=now() WHERE id=$1`, [rfq.id]);
    await tx.query(`UPDATE orders SET status='BOOKED', updated_at=now() WHERE id=$1`, [order.id]);

    // Booking snapshot is independent of later RFQ history (§7.5).
    const seq = (await tx.query(`SELECT count(*)::int AS n FROM bookings WHERE order_id=$1`, [order.id])).rows[0].n;
    const bookingRef = `B-${order.public_reference.replace(/^[A-Z]+-/, "")}${seq > 0 ? `-${seq + 1}` : ""}`;
    const booking = (
      await tx.query(
        `INSERT INTO bookings (
           public_reference, order_id, selected_quote_id, fleet_organization_id,
           confirmed_amount, confirmed_currency, confirmed_terms, confirmed_order_version,
           confirmed_order_type, container_type_snapshot, container_quantity_snapshot,
           scheduled_pickup_at, scheduled_start_at
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12) RETURNING *`,
        [
          bookingRef, order.id, q.id, recipient.fleet_organization_id,
          q.amount, q.currency, q.terms, order.version,
          order.order_type, order.container_type, order.container_quantity,
          order.requested_start_at ?? order.pickup_at,
        ],
      )
    ).rows[0];

    await audit(tx, { actor, action: "quote.accepted", objectType: "QUOTE", objectId: q.id, metadata: { bookingId: booking.id } });
    for (const rj of rejected.rows) await audit(tx, { actor, action: "quote.rejected", objectType: "QUOTE", objectId: rj.id });
    await audit(tx, {
      actor, action: "booking.offered", objectType: "BOOKING", objectId: booking.id,
      after: { amount: q.amount, currency: q.currency, orderVersion: order.version },
    });
    await emitOutbox(tx, "booking.offered", "BOOKING", booking.id, { fleetOrganizationId: recipient.fleet_organization_id });

    const conv = await getOrCreateConversation(tx, recipient.fleet_organization_id);
    const card = bookingOfferCard({ bookingRef, order, money: formatMoney(q.currency, q.amount) });
    await sendOutbound(tx, {
      conversationId: conv.id,
      messageType: "BUSINESS_CARD",
      text: card.text,
      structured: card.structured,
      context: { orderId: order.id, bookingId: booking.id },
      actions: [
        { actionType: "ACCEPT_BOOKING", label: "接受任务", objectType: "BOOKING", objectId: booking.id, expectedObjectVersion: booking.version, payload: { bookingId: booking.id } },
        { actionType: "DECLINE_BOOKING", label: "无法承运", objectType: "BOOKING", objectId: booking.id, expectedObjectVersion: booking.version, payload: { bookingId: booking.id } },
        { actionType: "REQUEST_HUMAN", label: "联系运营", objectType: "BOOKING", objectId: booking.id, payload: { bookingId: booking.id } },
      ],
    });
    return { bookingId: booking.id, bookingRef };
  });
}

export async function acceptBooking(
  tx: Tx,
  actor: Actor,
  input: { conversationId: string; bookingId: string },
): Promise<{ bookingId: string; shipmentId: string }> {
  const b = (
    await tx.query(
      `SELECT b.*, o.order_type
         FROM bookings b JOIN orders o ON o.id=b.order_id
        WHERE b.id=$1 FOR UPDATE OF b`,
      [input.bookingId],
    )
  ).rows[0];
  if (!b) throw new CommandFailure(err("NOT_FOUND", "Booking not found"));
  if (b.fleet_organization_id !== actor.organizationId) throw new CommandFailure(err("FORBIDDEN", "Not your booking"));
  if (!canBookingTransition(b.status, "ACCEPTED")) {
    throw new CommandFailure(err("INVALID_TRANSITION", `任务状态为 ${b.status}，无法接受。`));
  }
  await tx.query(`UPDATE bookings SET status='ACCEPTED', accepted_at=now(), version=version+1, updated_at=now() WHERE id=$1`, [b.id]);
  const initialStatus = initialShipmentStatus(b.order_type as OrderType);
  const shipment = (
    await tx.query(
      `INSERT INTO shipments (booking_id, current_status) VALUES ($1,$2) RETURNING *`,
      [b.id, initialStatus],
    )
  ).rows[0];
  await tx.query(`UPDATE orders SET status='IN_PROGRESS', updated_at=now() WHERE id=$1 AND status='BOOKED'`, [b.order_id]);
  await audit(tx, { actor, action: "booking.accepted", objectType: "BOOKING", objectId: b.id });
  await audit(tx, {
    actor,
    action: "shipment.created",
    objectType: "SHIPMENT",
    objectId: shipment.id,
    after: { status: initialStatus, orderType: b.order_type },
  });
  await emitOutbox(tx, "booking.accepted", "BOOKING", b.id, {});

  await sendOutbound(tx, {
    conversationId: input.conversationId,
    messageType: "SYSTEM_NOTICE",
    text:
      b.order_type === "EXPORT_DRAYAGE"
        ? `已确认接受任务 ${b.public_reference}。下一步是提取全部空箱；完成后请回复“全部空箱已提取”。`
        : `已确认接受任务 ${b.public_reference}。下一步是从码头提取全部重箱；完成后请回复“全部重箱已提取”。`,
    context: { bookingId: b.id, shipmentId: shipment.id },
  });
  return { bookingId: b.id, shipmentId: shipment.id };
}

/** Fleet declines an offered booking — operator exception, no automatic re-RFQ (§11.9). */
export async function declineBooking(
  tx: Tx,
  actor: Actor,
  input: { conversationId: string; bookingId: string },
): Promise<{ bookingId: string; status: string }> {
  const b = (await tx.query(`SELECT * FROM bookings WHERE id=$1 FOR UPDATE`, [input.bookingId])).rows[0];
  if (!b) throw new CommandFailure(err("NOT_FOUND", "Booking not found"));
  if (b.fleet_organization_id !== actor.organizationId) throw new CommandFailure(err("FORBIDDEN", "Not your booking"));
  if (!canBookingTransition(b.status, "CANCELLED_BY_FLEET")) {
    throw new CommandFailure(err("INVALID_TRANSITION", `任务状态为 ${b.status}，无法取消。`));
  }
  await tx.query(
    `UPDATE bookings SET status='CANCELLED_BY_FLEET', cancelled_at=now(), cancellation_reason='Declined in chat', version=version+1, updated_at=now() WHERE id=$1`,
    [b.id],
  );
  const exc = await tx.query(
    `INSERT INTO exception_cases (type, order_id, fleet_organization_id, summary, details)
     VALUES ('FLEET_CANCELLED',$1,$2,$3,$4) RETURNING id`,
    [b.order_id, b.fleet_organization_id, `Fleet declined booking ${b.public_reference}`, JSON.stringify({ bookingId: b.id })],
  );
  await audit(tx, { actor, action: "booking.cancelled_by_fleet", objectType: "BOOKING", objectId: b.id });
  await emitOutbox(tx, "booking.cancelled", "BOOKING", b.id, { by: "FLEET" });
  await emitOutbox(tx, "exception.created", "EXCEPTION", exc.rows[0].id, { type: "FLEET_CANCELLED" });
  await sendOutbound(tx, {
    conversationId: input.conversationId,
    messageType: "SYSTEM_NOTICE",
    text: `已记录：无法承运任务 ${b.public_reference}。运营人员将跟进处理。`,
    context: { bookingId: b.id },
  });
  return { bookingId: b.id, status: "CANCELLED_BY_FLEET" };
}

/** Build the assignment confirmation card from an ASSIGN_RESOURCES proposal (§11.10). */
export async function proposeAssignment(
  tx: Tx,
  actor: Actor,
  input: { conversationId: string; bookingId: string; driverName: string | null; plateNumber: string | null; sourceMessageId: string },
): Promise<{ messageId: string } | { clarification: string }> {
  const b = (await tx.query(`SELECT * FROM bookings WHERE id=$1`, [input.bookingId])).rows[0];
  if (!b) throw new CommandFailure(err("NOT_FOUND", "Booking not found"));
  if (b.fleet_organization_id !== actor.organizationId) throw new CommandFailure(err("FORBIDDEN", "Not your booking"));
  if (!input.driverName || !input.plateNumber) {
    return { clarification: "请同时提供司机姓名和车牌号，例如：司机陈师傅，车牌 SGB1234A" };
  }
  const driver = (
    await tx.query(
      `SELECT * FROM drivers WHERE fleet_organization_id=$1 AND status='ACTIVE' AND name ILIKE $2 LIMIT 1`,
      [actor.organizationId, `%${input.driverName}%`],
    )
  ).rows[0];
  const vehicle = (
    await tx.query(
      `SELECT * FROM vehicles WHERE fleet_organization_id=$1 AND status='ACTIVE' AND upper(plate_number)=upper($2) LIMIT 1`,
      [actor.organizationId, input.plateNumber],
    )
  ).rows[0];

  const lines = [
    `请确认司机与车辆安排（${b.public_reference}）：`,
    ``,
    `司机：${driver ? driver.name : `${input.driverName}（将新建档案）`}`,
    `车牌：${vehicle ? vehicle.plate_number : `${input.plateNumber.toUpperCase()}（将新建档案）`}`,
  ];
  const { messageId } = await sendOutbound(tx, {
    conversationId: input.conversationId,
    messageType: "BUSINESS_CARD",
    text: lines.join("\n"),
    structured: {
      kind: "ASSIGNMENT_CONFIRMATION",
      reference: b.public_reference,
      driver: driver?.name ?? input.driverName,
      plate: vehicle?.plate_number ?? input.plateNumber.toUpperCase(),
      driverIsNew: !driver,
      vehicleIsNew: !vehicle,
    },
    replyToMessageId: input.sourceMessageId,
    context: { bookingId: b.id },
    actions: [
      {
        actionType: "CONFIRM_ASSIGNMENT", label: "确认安排", objectType: "BOOKING", objectId: b.id,
        expectedObjectVersion: b.version,
        payload: {
          bookingId: b.id,
          driverId: driver?.id ?? null,
          vehicleId: vehicle?.id ?? null,
          createDriverName: driver ? null : input.driverName,
          createVehiclePlate: vehicle ? null : input.plateNumber.toUpperCase(),
        },
      },
    ],
  });
  return { messageId };
}

/** CONFIRM_ASSIGNMENT handler: create resources if needed, assign, advance shipment. */
export async function confirmAssignment(
  tx: Tx,
  actor: Actor,
  input: {
    conversationId: string;
    bookingId: string;
    driverId: string | null;
    vehicleId: string | null;
    createDriverName: string | null;
    createVehiclePlate: string | null;
  },
): Promise<{ bookingId: string; shipmentStatus: string }> {
  const b = (await tx.query(`SELECT * FROM bookings WHERE id=$1 FOR UPDATE`, [input.bookingId])).rows[0];
  if (!b) throw new CommandFailure(err("NOT_FOUND", "Booking not found"));
  if (b.fleet_organization_id !== actor.organizationId) throw new CommandFailure(err("FORBIDDEN", "Not your booking"));
  if (!["ACCEPTED", "RESOURCE_PENDING"].includes(b.status)) {
    throw new CommandFailure(err("INVALID_TRANSITION", `任务状态为 ${b.status}，无法安排资源。`));
  }

  let driverId = input.driverId;
  if (!driverId) {
    if (!input.createDriverName) throw new CommandFailure(err("VALIDATION", "Driver missing"));
    driverId = (
      await tx.query(`INSERT INTO drivers (fleet_organization_id, name) VALUES ($1,$2) RETURNING id`, [
        actor.organizationId, input.createDriverName,
      ])
    ).rows[0].id;
    await audit(tx, { actor, action: "driver.created", objectType: "DRIVER", objectId: driverId!, after: { name: input.createDriverName } });
  } else {
    const own = await tx.query(`SELECT 1 FROM drivers WHERE id=$1 AND fleet_organization_id=$2`, [driverId, actor.organizationId]);
    if (!own.rowCount) throw new CommandFailure(err("FORBIDDEN", "Driver belongs to another organization"));
  }
  let vehicleId = input.vehicleId;
  if (!vehicleId) {
    if (!input.createVehiclePlate) throw new CommandFailure(err("VALIDATION", "Vehicle missing"));
    vehicleId = (
      await tx.query(
        `INSERT INTO vehicles (fleet_organization_id, plate_number) VALUES ($1,$2)
         ON CONFLICT (fleet_organization_id, plate_number) DO UPDATE SET updated_at=now() RETURNING id`,
        [actor.organizationId, input.createVehiclePlate],
      )
    ).rows[0].id;
    await audit(tx, { actor, action: "vehicle.created", objectType: "VEHICLE", objectId: vehicleId!, after: { plate: input.createVehiclePlate } });
  } else {
    const own = await tx.query(`SELECT 1 FROM vehicles WHERE id=$1 AND fleet_organization_id=$2`, [vehicleId, actor.organizationId]);
    if (!own.rowCount) throw new CommandFailure(err("FORBIDDEN", "Vehicle belongs to another organization"));
  }

  const assignment = (
    await tx.query(
      `INSERT INTO booking_assignments (booking_id, driver_id, vehicle_id, created_by_user_id) VALUES ($1,$2,$3,$4) RETURNING id`,
      [b.id, driverId, vehicleId, actor.userId],
    )
  ).rows[0];
  await tx.query(`UPDATE bookings SET status='READY', version=version+1, updated_at=now() WHERE id=$1`, [b.id]);

  const shipment = (await tx.query(`SELECT * FROM shipments WHERE booking_id=$1 FOR UPDATE`, [b.id])).rows[0];
  if (shipment && shipment.current_status === "WAITING_ASSIGNMENT") {
    await tx.query(`UPDATE shipments SET current_status='DRIVER_ASSIGNED', version=version+1, updated_at=now() WHERE id=$1`, [shipment.id]);
    await tx.query(
      `INSERT INTO shipment_events (shipment_id, event_type, from_status, to_status, reported_by_user_id, source, idempotency_key)
       VALUES ($1,'STATUS_CHANGE','WAITING_ASSIGNMENT','DRIVER_ASSIGNED',$2,'WEB',$3)`,
      [shipment.id, actor.userId, `assign:${assignment.id}`],
    );
  }
  await audit(tx, {
    actor, action: "booking.resources_assigned", objectType: "BOOKING", objectId: b.id,
    after: { driverId, vehicleId, assignmentId: assignment.id },
  });
  await emitOutbox(tx, "booking.resources_assigned", "BOOKING", b.id, { driverId, vehicleId });
  await sendOutbound(tx, {
    conversationId: input.conversationId,
    messageType: "SYSTEM_NOTICE",
    text: `已确认安排（${b.public_reference}）。运输开始后请随时更新状态，例如：已出发提货 / 提到柜 / 送到了。`,
    context: { bookingId: b.id, shipmentId: shipment?.id },
  });
  return { bookingId: b.id, shipmentStatus: "DRIVER_ASSIGNED" };
}
