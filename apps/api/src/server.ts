import Fastify from "fastify";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "@mercury/db";
import { withTx } from "@mercury/db";
import { ConsumeActionRequest, LoginRequest, SendMessageRequest } from "@mercury/contracts";
import {
  actorFromSession, canMutate, consumeMessageAction, eventBus, getOrCreateConversation,
  handleInbound, login, logout, newId, recordInbound, resolveSession,
  resolveNumberedChoice, submitShipmentDocument, runCommand,
  getFleetProfile, setFleetAcceptingOrders, submitFleetProfile,
  CommandFailure,
  type SessionInfo,
} from "@mercury/application";
import { z } from "zod";
import { registerOperatorRoutes } from "./operator.ts";

const FLEET_COOKIE = "mercury_fleet_session";
const OPERATOR_COOKIE = "mercury_operator_session";
const FleetProfileInput = z.object({
  fleetName: z.string().trim().min(1).max(200),
  acceptingOrders: z.boolean(),
  operatingCountries: z.array(z.string().trim().length(2)).min(1),
  supportsHazardous: z.boolean(),
  supportsReefer: z.boolean(),
  contactName: z.string().trim().min(1).max(200),
  contactPhone: z.string().trim().min(1).max(100),
  notes: z.string().trim().max(2000).nullable().optional(),
});

// Simple fixed-window rate limiter (login + message spam protection, §16.1/§18).
const buckets = new Map<string, { count: number; resetAt: number }>();
function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  b.count += 1;
  return b.count <= limit;
}

declare module "fastify" {
  interface FastifyRequest {
    session: SessionInfo | null;
  }
}

export async function buildServer(db: Db) {
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof CommandFailure) {
      const status =
        error.failure.code === "FORBIDDEN" ? 403 :
        error.failure.code === "NOT_FOUND" ? 404 :
        error.failure.code === "CONFLICT" || error.failure.code === "STALE_REVISION" ? 409 :
        422;
      return reply.code(status).send(error.failure);
    }
    return reply.send(error);
  });
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024, files: 1 } });

  const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../web/dist");
  if (fs.existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, prefix: "/" });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/")) return reply.code(404).send({ error: "Not found" });
      return reply.sendFile("index.html"); // SPA fallback
    });
  }

  app.decorateRequest("session", null);
  app.addHook("preHandler", async (req) => {
    const operatorRoute =
      req.url.startsWith("/api/operator/") ||
      req.url.startsWith("/api/auth/operator/");
    req.session = await resolveSession(
      db,
      req.cookies[operatorRoute ? OPERATOR_COOKIE : FLEET_COOKIE],
    );
  });

  const requireFleet = (req: any, reply: any): SessionInfo | null => {
    if (!req.session) {
      reply.code(401).send({ error: "Not authenticated" });
      return null;
    }
    if (req.session.organization.type !== "FLEET") {
      reply.code(403).send({ error: "Fleet account required" });
      return null;
    }
    return req.session;
  };
  const requireDispatcher = (req: any, reply: any): SessionInfo | null => {
    const s = requireFleet(req, reply);
    if (!s) return null;
    if (!canMutate(s.role)) {
      reply.code(403).send({ error: "Read-only role", code: "FORBIDDEN" });
      return null;
    }
    return s;
  };

  // ---------------------------------------------------------------- auth
  const writeSessionCookie = (
    reply: any,
    name: typeof FLEET_COOKIE | typeof OPERATOR_COOKIE,
    sessionId: string,
  ) => {
    reply.setCookie(name, sessionId, {
      path: "/", httpOnly: true, sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: Number(process.env.SESSION_TTL_HOURS ?? 72) * 3600,
    });
  };

  const portalLogin = (portal: "fleet" | "operator") => async (req: any, reply: any) => {
    if (!rateLimit(`login:${req.ip}`, 10, 60_000)) return reply.code(429).send({ error: "Too many attempts" });
    const body = LoginRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Invalid request" });
    const session = await login(db, body.data.username, body.data.password);
    if (!session) return reply.code(401).send({ error: "用户名或密码不正确" });
    const isOperator = session.role === "OPERATOR";
    if ((portal === "operator") !== isOperator) {
      await logout(db, session.sessionId);
      return reply.code(403).send({
        error: portal === "operator" ? "请使用运营账号登录。" : "请使用车队账号登录。",
        code: "WRONG_PORTAL",
      });
    }
    writeSessionCookie(reply, portal === "operator" ? OPERATOR_COOKIE : FLEET_COOKIE, session.sessionId);
    return { user: session.user, organization: session.organization, role: session.role };
  };

  app.post("/api/auth/fleet/login", portalLogin("fleet"));
  app.post("/api/auth/operator/login", portalLogin("operator"));

  const portalLogout = (cookieName: typeof FLEET_COOKIE | typeof OPERATOR_COOKIE) =>
    async (req: any, reply: any) => {
    if (req.session) await logout(db, req.session.sessionId);
    reply.clearCookie(cookieName, { path: "/" });
    return { ok: true };
  };
  app.post("/api/auth/fleet/logout", portalLogout(FLEET_COOKIE));
  app.post("/api/auth/operator/logout", portalLogout(OPERATOR_COOKIE));

  const portalSession = async (req: any, reply: any) => {
    if (!req.session) return reply.code(401).send({ error: "Not authenticated" });
    const { user, organization, role } = req.session;
    return { user, organization, role };
  };
  app.get("/api/auth/fleet/session", portalSession);
  app.get("/api/auth/operator/session", portalSession);
  app.get("/api/auth/session", portalSession);

  // Backwards-compatible login for API acceptance scripts. The returned
  // account still receives the role-specific cookie, so both sessions can
  // coexist in one browser.
  app.post("/api/auth/login", async (req, reply) => {
    if (!rateLimit(`login:${req.ip}`, 10, 60_000)) return reply.code(429).send({ error: "Too many attempts" });
    const body = LoginRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Invalid request" });
    const session = await login(db, body.data.username, body.data.password);
    if (!session) return reply.code(401).send({ error: "用户名或密码不正确" });
    writeSessionCookie(reply, session.role === "OPERATOR" ? OPERATOR_COOKIE : FLEET_COOKIE, session.sessionId);
    return { user: session.user, organization: session.organization, role: session.role };
  });

  // ---------------------------------------------------------------- conversation
  app.get("/api/fleet/conversation", async (req, reply) => {
    const s = requireFleet(req, reply);
    if (!s) return;
    const conv = await withTx(db, (tx) => getOrCreateConversation(tx, s.organization.id));
    return { conversationId: conv.id, organization: s.organization };
  });

  app.get("/api/fleet/conversation/messages", async (req, reply) => {
    const s = requireFleet(req, reply);
    if (!s) return;
    const q = req.query as { before?: string; limit?: string };
    const limit = Math.min(Number(q.limit ?? 50), 100);
    const conv = await withTx(db, (tx) => getOrCreateConversation(tx, s.organization.id));
    const params: unknown[] = [conv.id, limit];
    let where = `m.conversation_id=$1 AND (m.direction='INBOUND' OR m.delivery_status IN ('SENT','DELIVERED','READ'))`;
    if (q.before) {
      params.push(q.before);
      where += ` AND m.created_at < (SELECT created_at FROM messages WHERE id=$3)`;
    }
    const rows = await db.query(
      `SELECT m.id, m.direction, m.sender_type, m.message_type, m.text_content, m.structured_content,
              m.reply_to_message_id, m.created_at, m.external_message_id,
              COALESCE(json_agg(json_build_object(
                'id', ma.id, 'actionType', ma.action_type, 'label', ma.label, 'status', ma.status
              ) ORDER BY ma.created_at) FILTER (WHERE ma.id IS NOT NULL), '[]') AS actions
         FROM messages m
         LEFT JOIN message_actions ma ON ma.message_id=m.id
        WHERE ${where}
        GROUP BY m.id
        ORDER BY m.created_at DESC
        LIMIT $2`,
      params,
    );
    return { conversationId: conv.id, messages: rows.rows.reverse() };
  });

  app.get("/api/fleet/tasks", async (req, reply) => {
    const s = requireFleet(req, reply);
    if (!s) return;
    const rows = await db.query(
      `SELECT
         o.id AS order_id, o.public_reference AS order_reference, o.status AS order_status,
         o.pickup_location_text, o.delivery_location_text, o.pickup_at,
         o.order_type, o.service_country, o.container_type, o.container_quantity,
         o.requested_start_at, o.requested_complete_at,
         f.id AS rfq_id, f.public_reference AS rfq_reference, f.revision AS rfq_revision,
         rr.id AS rfq_recipient_id, rr.status AS recipient_status,
         q.id AS quote_id, q.status AS quote_status, q.amount, q.currency,
         b.id AS booking_id, b.public_reference AS booking_reference, b.status AS booking_status,
         sh.id AS shipment_id, sh.current_status AS shipment_status,
         anchor.message_id AS anchor_message_id,
         anchor.text_content AS last_message_text,
         anchor.created_at AS last_message_at,
         (
           SELECT count(*)::int FROM exception_cases e
            WHERE e.status IN ('OPEN','IN_PROGRESS')
              AND (e.order_id=o.id OR e.rfq_id=f.id)
         ) AS open_exception_count
         ,
         (
           SELECT count(*)::int
             FROM messages unread_message
             JOIN message_context_links unread_context
               ON unread_context.message_id=unread_message.id
            WHERE unread_message.direction='OUTBOUND'
              AND (
                unread_context.rfq_recipient_id=rr.id
                OR unread_context.rfq_id=f.id
                OR unread_context.order_id=o.id
                OR (b.id IS NOT NULL AND unread_context.booking_id=b.id)
                OR (sh.id IS NOT NULL AND unread_context.shipment_id=sh.id)
              )
              AND unread_message.created_at > COALESCE(
                (SELECT read_state.last_read_at
                   FROM task_read_states read_state
                  WHERE read_state.rfq_recipient_id=rr.id
                    AND read_state.user_id=$2),
                '-infinity'::timestamptz
              )
         ) AS unread_count
       FROM rfq_recipients rr
       JOIN rfqs f ON f.id=rr.rfq_id
       JOIN orders o ON o.id=f.order_id
       LEFT JOIN LATERAL (
         SELECT * FROM quotes
          WHERE rfq_recipient_id=rr.id
          ORDER BY created_at DESC LIMIT 1
       ) q ON true
       LEFT JOIN LATERAL (
         SELECT * FROM bookings
          WHERE order_id=o.id AND fleet_organization_id=rr.fleet_organization_id
          ORDER BY created_at DESC LIMIT 1
       ) b ON true
       LEFT JOIN shipments sh ON sh.booking_id=b.id
       LEFT JOIN LATERAL (
         SELECT mcl.message_id, m.text_content, m.created_at
           FROM message_context_links mcl
           JOIN messages m ON m.id=mcl.message_id
          WHERE mcl.rfq_recipient_id=rr.id
             OR (b.id IS NOT NULL AND mcl.booking_id=b.id)
             OR (sh.id IS NOT NULL AND mcl.shipment_id=sh.id)
          ORDER BY m.created_at DESC LIMIT 1
       ) anchor ON true
      WHERE rr.fleet_organization_id=$1
      ORDER BY COALESCE(anchor.created_at, o.updated_at) DESC`,
      [s.organization.id, s.user.id],
    );
    return { tasks: rows.rows };
  });

  app.get("/api/fleet/tasks/:rfqRecipientId/messages", async (req, reply) => {
    const s = requireFleet(req, reply);
    if (!s) return;
    const { rfqRecipientId } = req.params as { rfqRecipientId: string };
    const { before } = req.query as { before?: string };
    if (!/^[0-9a-f-]{36}$/i.test(rfqRecipientId)) {
      return reply.code(400).send({ error: "Invalid task id" });
    }
    const task = (
      await db.query(
        `SELECT rr.id, rr.rfq_id, f.order_id, b.id AS booking_id, sh.id AS shipment_id
           FROM rfq_recipients rr
           JOIN rfqs f ON f.id=rr.rfq_id
           LEFT JOIN LATERAL (
             SELECT id FROM bookings
              WHERE order_id=f.order_id AND fleet_organization_id=rr.fleet_organization_id
              ORDER BY created_at DESC LIMIT 1
           ) b ON true
           LEFT JOIN shipments sh ON sh.booking_id=b.id
          WHERE rr.id=$1 AND rr.fleet_organization_id=$2`,
        [rfqRecipientId, s.organization.id],
      )
    ).rows[0];
    if (!task) return reply.code(404).send({ error: "Task not found" });
    const conv = await withTx(db, (tx) => getOrCreateConversation(tx, s.organization.id));
    const rows = await db.query(
      `SELECT m.id, m.direction, m.sender_type, m.message_type, m.text_content, m.structured_content,
              m.reply_to_message_id, m.created_at, m.external_message_id,
              COALESCE(json_agg(json_build_object(
                'id', ma.id, 'actionType', ma.action_type, 'label', ma.label, 'status', ma.status
              ) ORDER BY ma.created_at) FILTER (WHERE ma.id IS NOT NULL), '[]') AS actions
         FROM messages m
         LEFT JOIN message_actions ma ON ma.message_id=m.id
        WHERE m.conversation_id=$1
          AND (m.direction='INBOUND' OR m.delivery_status IN ('SENT','DELIVERED','READ'))
          AND ($7::uuid IS NULL OR m.created_at < (
            SELECT cursor_message.created_at FROM messages cursor_message WHERE cursor_message.id=$7
          ))
          AND EXISTS (
            SELECT 1 FROM message_context_links mcl
             WHERE mcl.message_id=m.id
               AND (
                 mcl.rfq_recipient_id=$2
                 OR mcl.rfq_id=$3
                 OR mcl.order_id=$4
                 OR ($5::uuid IS NOT NULL AND mcl.booking_id=$5)
                 OR ($6::uuid IS NOT NULL AND mcl.shipment_id=$6)
               )
          )
        GROUP BY m.id
        ORDER BY m.created_at DESC
        LIMIT 200`,
      [
        conv.id,
        task.id,
        task.rfq_id,
        task.order_id,
        task.booking_id ?? null,
        task.shipment_id ?? null,
        before ?? null,
      ],
    );
    await db.query(
      `INSERT INTO task_read_states (rfq_recipient_id, user_id, last_read_at)
       VALUES ($1,$2,now())
       ON CONFLICT (rfq_recipient_id, user_id)
       DO UPDATE SET last_read_at=EXCLUDED.last_read_at`,
      [task.id, s.user.id],
    );
    return {
      conversationId: conv.id,
      taskId: task.id,
      messages: rows.rows.reverse(),
      nextCursor: rows.rows.length === 200 ? rows.rows[0]?.id ?? null : null,
    };
  });

  // ---------------------------------------------------------------- fleet profile
  app.get("/api/fleet/profile", async (req, reply) => {
    const s = requireFleet(req, reply);
    if (!s) return;
    return { profile: await getFleetProfile(db, s.organization.id) };
  });

  app.post("/api/fleet/profile", async (req, reply) => {
    const s = requireDispatcher(req, reply);
    if (!s) return;
    const parsed = FleetProfileInput.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const result = await withTx(db, (tx) =>
      submitFleetProfile(tx, actorFromSession(s), parsed.data),
    );
    return { profile: result };
  });

  app.patch("/api/fleet/profile/accepting-orders", async (req, reply) => {
    const s = requireDispatcher(req, reply);
    if (!s) return;
    const parsed = z.object({ acceptingOrders: z.boolean() }).safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.flatten() });
    const result = await withTx(db, (tx) =>
      setFleetAcceptingOrders(tx, actorFromSession(s), parsed.data.acceptingOrders),
    );
    return result;
  });

  app.post("/api/fleet/conversation/messages", async (req, reply) => {
    const s = requireDispatcher(req, reply);
    if (!s) return;
    if (!rateLimit(`msg:${s.user.id}`, 30, 60_000)) return reply.code(429).send({ error: "Too many messages" });
    const body = SendMessageRequest.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: "Invalid request", detail: body.error.flatten() });
    const actor = actorFromSession(s);
    const conv = await withTx(db, (tx) => getOrCreateConversation(tx, s.organization.id));
    const recorded = await recordInbound(db, actor, {
      conversationId: conv.id,
      clientMessageId: body.data.clientMessageId,
      text: body.data.text,
      replyToMessageId: body.data.replyToMessageId ?? null,
    });
    const numbered = await resolveNumberedChoice(db, actor, {
      conversationId: conv.id,
      sourceMessageId: recorded.messageId,
      text: body.data.text,
    });
    const handled =
      numbered.kind === "RESOLVED"
        ? await consumeMessageAction(db, actor, {
            actionId: numbered.actionId,
            clientIdempotencyKey: body.data.clientMessageId,
          })
        : numbered.kind === "NOT_NUMBERED"
          ? await handleInbound(db, actor, {
              conversationId: conv.id,
              messageId: recorded.messageId,
            })
          : { ok: true as const, result: { handled: numbered.kind } };
    // Message-level HTTP path stays 200 even for business clarifications; typed
    // errors surface conversationally (§15). Hard failures are still HTTP errors.
    if (!handled.ok && !["STALE_REVISION"].includes(handled.code)) {
      return reply.code(handled.code === "FORBIDDEN" ? 403 : 422).send(handled);
    }
    eventBus.emit(`fleet:${s.organization.id}`, { type: "message", messageId: recorded.messageId });
    return { messageId: recorded.messageId, duplicate: recorded.duplicate, handled };
  });

  // ---------------------------------------------------------------- actions (§16.2)
  app.post("/api/fleet/conversation/actions/:actionId/consume", async (req, reply) => {
    const s = requireDispatcher(req, reply);
    if (!s) return;
    const { actionId } = req.params as { actionId: string };
    if (!/^[0-9a-f-]{36}$/i.test(actionId)) return reply.code(400).send({ error: "Invalid action id" });
    const body = ConsumeActionRequest.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "idempotencyKey (uuid) required" });
    const result = await consumeMessageAction(db, actorFromSession(s), {
      actionId, clientIdempotencyKey: body.data.idempotencyKey,
    });
    if (!result.ok) {
      const status = result.code === "FORBIDDEN" ? 403 : result.code === "NOT_FOUND" ? 404 : 409;
      return reply.code(status).send(result);
    }
    // Typed outcome: CONSUMED / ALREADY_CONSUMED / STALE_REVISION / ACTION_UNAVAILABLE.
    const outcome = result.result as { outcome: string };
    const httpStatus = outcome.outcome === "STALE_REVISION" ? 409 : 200;
    return reply.code(httpStatus).send(result);
  });

  // ---------------------------------------------------------------- shipment documents
  app.post("/api/fleet/conversation/attachments", async (req, reply) => {
    const s = requireDispatcher(req, reply);
    if (!s) return;
    const file = await req.file();
    if (!file) return reply.code(400).send({ error: "No file uploaded" });
    const data = await file.toBuffer();
    const actor = actorFromSession(s);
    const conv = await withTx(db, (tx) => getOrCreateConversation(tx, s.organization.id));

    // Resolve the selected shipment. With multiple tasks we never guess when
    // more than one active shipment exists.
    const requestedShipmentId = (file.fields.shipmentId as any)?.value as string | undefined;
    const shipments = await db.query(
      `SELECT s.id FROM shipments s JOIN bookings b ON b.id=s.booking_id
        WHERE b.fleet_organization_id=$1 AND s.current_status NOT IN ('COMPLETED')
          AND ($2::uuid IS NULL OR s.id=$2)
        ORDER BY s.updated_at DESC`,
      [s.organization.id, requestedShipmentId ?? null],
    );
    if (!shipments.rowCount) return reply.code(422).send({ error: "当前没有进行中的运输任务，无法上传回单。" });
    if (!requestedShipmentId && shipments.rowCount > 1) {
      return reply.code(422).send({ error: "你有多个进行中的任务。请先从“任务”中选择对应任务，再上传回单。" });
    }

    const clientMessageId = (file.fields.clientMessageId as any)?.value ?? newId();
    const result = await runCommand(db, { key: `pod:${clientMessageId}`, type: "SubmitPod" }, async (tx) => {
      const msg = await tx.query(
        `INSERT INTO messages (conversation_id, direction, sender_type, sender_user_id, message_type, text_content, external_message_id, delivery_status)
         VALUES ($1,'INBOUND','FLEET_USER',$2,'FILE',$3,$4,'DELIVERED')
         ON CONFLICT (conversation_id, external_message_id) WHERE external_message_id IS NOT NULL DO NOTHING
         RETURNING id`,
        [conv.id, s.user.id, `POD: ${file.filename}`, clientMessageId],
      );
      const messageId = msg.rows[0]?.id;
      const requestedType = (file.fields.documentType as any)?.value as
        | "EMPTY_CONTAINER_RELEASE"
        | "TERMINAL_HANDOVER"
        | "POD"
        | "EMPTY_CONTAINER_RETURN"
        | undefined;
      return submitShipmentDocument(tx, actor, {
        conversationId: conv.id,
        shipmentId: shipments.rows[0].id,
        documentType: requestedType ?? null,
        fileName: file.filename,
        mimeType: file.mimetype,
        data,
        sourceMessageId: messageId,
      });
    });
    if (!result.ok) return reply.code(422).send(result);
    eventBus.emit(`fleet:${s.organization.id}`, { type: "message" });
    return result;
  });

  app.get("/api/fleet/files/:storageKey", async (req, reply) => {
    const s = requireFleet(req, reply);
    if (!s) return;
    const { storageKey } = req.params as { storageKey: string };
    const doc = await db.query(
      `SELECT * FROM documents WHERE storage_key=$1 AND organization_id=$2`,
      [path.basename(storageKey), s.organization.id],
    );
    if (!doc.rowCount) return reply.code(404).send({ error: "Not found" });
    const filePath = path.join(process.env.STORAGE_DIR ?? "./var/storage", doc.rows[0].storage_key);
    if (!fs.existsSync(filePath)) return reply.code(404).send({ error: "File missing" });
    reply.header("content-type", doc.rows[0].mime_type);
    return reply.send(fs.createReadStream(filePath));
  });

  // ---------------------------------------------------------------- SSE (§16.3)
  app.get("/api/fleet/conversation/stream", async (req, reply) => {
    const s = requireFleet(req, reply);
    if (!s) return;
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    reply.raw.write(`event: hello\ndata: {}\n\n`);
    const listener = (payload: unknown) => {
      reply.raw.write(`event: update\ndata: ${JSON.stringify(payload)}\n\n`);
    };
    eventBus.on(`fleet:${s.organization.id}`, listener);
    const heartbeat = setInterval(() => reply.raw.write(`: ping\n\n`), 15_000);
    req.raw.on("close", () => {
      clearInterval(heartbeat);
      eventBus.off(`fleet:${s.organization.id}`, listener);
    });
  });

  registerOperatorRoutes(app, db);
  return app;
}
