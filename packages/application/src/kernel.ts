import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { Db, Tx } from "@mercury/db";
import { withTx } from "@mercury/db";
import { type CommandErr, type CommandResult, ok } from "@mercury/contracts";

/** Authenticated actor resolved from a session — never from client/model input. */
export interface Actor {
  actorType: "USER" | "AGENT" | "OPERATOR" | "SYSTEM";
  userId: string | null;
  organizationId: string | null;
  role: "FLEET_ADMIN" | "DISPATCHER" | "VIEWER" | "OPERATOR" | "SYSTEM";
}

export const SYSTEM_ACTOR: Actor = { actorType: "SYSTEM", userId: null, organizationId: null, role: "SYSTEM" };

/** Thrown inside a command to roll back everything and surface a typed error. */
export class CommandFailure extends Error {
  constructor(public readonly failure: CommandErr) {
    super(failure.message);
  }
}

const log = (obj: Record<string, unknown>) =>
  process.env.NODE_ENV !== "test" && console.log(JSON.stringify({ ts: new Date().toISOString(), ...obj }));

/**
 * Run a business command exactly once (§9.2).
 * - The idempotency key row is inserted inside the same transaction as the
 *   business change; duplicates return the original stored result.
 * - Typed business failures (CommandFailure) roll the transaction back and do
 *   not consume the key, so a corrected retry with the same key can succeed.
 */
export async function runCommand<T>(
  db: Db,
  meta: { key: string; type: string; requestId?: string },
  fn: (tx: Tx) => Promise<T>,
): Promise<CommandResult<T>> {
  const started = Date.now();
  try {
    const result = await withTx(db, async (tx) => {
      const inserted = await tx.query(
        `INSERT INTO processed_commands (idempotency_key, command_type)
         VALUES ($1,$2) ON CONFLICT (idempotency_key) DO NOTHING RETURNING idempotency_key`,
        [meta.key, meta.type],
      );
      if (inserted.rowCount === 0) {
        // Duplicate delivery: another transaction committed this key.
        const prev = await tx.query(`SELECT result_reference FROM processed_commands WHERE idempotency_key=$1`, [meta.key]);
        throw new DuplicateCommand(prev.rows[0]?.result_reference ?? null);
      }
      const value = await fn(tx);
      await tx.query(`UPDATE processed_commands SET result_reference=$2 WHERE idempotency_key=$1`, [
        meta.key,
        JSON.stringify(value ?? null),
      ]);
      return value;
    });
    log({ level: "info", command_type: meta.type, idempotency_key: meta.key, request_id: meta.requestId, duration_ms: Date.now() - started, result: "ok" });
    return ok(result);
  } catch (e) {
    if (e instanceof DuplicateCommand) {
      log({ level: "info", command_type: meta.type, idempotency_key: meta.key, duration_ms: Date.now() - started, result: "duplicate" });
      return ok(e.stored as T, true);
    }
    if (e instanceof CommandFailure) {
      log({ level: "warn", command_type: meta.type, idempotency_key: meta.key, duration_ms: Date.now() - started, error_code: e.failure.code });
      return e.failure;
    }
    log({ level: "error", command_type: meta.type, idempotency_key: meta.key, duration_ms: Date.now() - started, error: String(e) });
    throw e;
  }
}

class DuplicateCommand extends Error {
  constructor(public readonly stored: unknown) {
    super("duplicate");
  }
}

// ---------------------------------------------------------------- audit (§9.1)
export async function audit(
  tx: Tx,
  entry: {
    actor: Actor;
    action: string;
    objectType: string;
    objectId: string;
    sourceMessageId?: string | null;
    before?: unknown;
    after?: unknown;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await tx.query(
    `INSERT INTO audit_logs (actor_type, actor_user_id, organization_id, action, object_type, object_id,
                             source_message_id, before_data, after_data, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      entry.actor.actorType,
      entry.actor.userId,
      entry.actor.organizationId,
      entry.action,
      entry.objectType,
      entry.objectId,
      entry.sourceMessageId ?? null,
      entry.before === undefined ? null : JSON.stringify(entry.before),
      entry.after === undefined ? null : JSON.stringify(entry.after),
      JSON.stringify(entry.metadata ?? {}),
    ],
  );
}

// ---------------------------------------------------------------- outbox (§9.3)
export async function emitOutbox(
  tx: Tx,
  topic: string,
  aggregateType: string,
  aggregateId: string,
  payload: Record<string, unknown> = {},
): Promise<void> {
  await tx.query(
    `INSERT INTO outbox_events (topic, aggregate_type, aggregate_id, payload) VALUES ($1,$2,$3,$4)`,
    [topic, aggregateType, aggregateId, JSON.stringify(payload)],
  );
}

// ---------------------------------------------------------------- realtime bus
/** In-process event bus used by SSE; fed by the outbox processor. */
export const eventBus = new EventEmitter();
eventBus.setMaxListeners(1000);

export const newId = (): string => randomUUID();

/**
 * Serialize every mutation that can change an order's RFQ/quote/booking graph.
 * Row-lock order alone is not enough because some entry points begin from a
 * quote while others begin from the order. A transaction-scoped advisory lock
 * gives all of them the same first lock and prevents opposite-order deadlocks.
 */
export async function lockOrderMutex(tx: Tx, orderId: string): Promise<void> {
  await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))`, [orderId]);
}

// ---------------------------------------------------------------- display helpers
const sgtFmt = new Intl.DateTimeFormat("sv-SE", {
  timeZone: process.env.DISPLAY_TZ ?? "Asia/Singapore",
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
});
/** UTC in storage, Asia/Singapore for display (§21). */
export function fmtTs(ts: string | Date | null): string {
  if (!ts) return "-";
  return sgtFmt.format(new Date(ts)).replace(",", "");
}
