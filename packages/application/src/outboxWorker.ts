import type { Db } from "@mercury/db";
import { withTx } from "@mercury/db";
import { eventBus, SYSTEM_ACTOR, audit } from "./kernel.ts";
import { sendOutbound } from "./messaging.ts";

const MAX_ATTEMPTS = 5;

/**
 * Drain a batch of outbox events (§9.3). Postgres-backed with
 * FOR UPDATE SKIP LOCKED claiming, exponential backoff, FAILED after
 * MAX_ATTEMPTS. `message.outbound` delivery = mark SENT + push over the
 * in-process bus to SSE subscribers.
 */
export async function processOutboxOnce(db: Db): Promise<number> {
  const processingTimeoutSec = Number(process.env.OUTBOX_PROCESSING_TIMEOUT_SECONDS ?? 300);
  const claimed = await withTx(db, async (tx) => {
    // A worker can die after claiming an event. Reclaim leases that have been
    // PROCESSING longer than the configured timeout instead of losing them.
    await tx.query(
      `UPDATE outbox_events
          SET status='PENDING',
              processing_started_at=NULL,
              available_at=now(),
              last_error=COALESCE(last_error, 'Recovered after worker lease expired')
        WHERE status='PROCESSING'
          AND processing_started_at <= now() - ($1 || ' seconds')::interval`,
      [String(processingTimeoutSec)],
    );
    const rows = await tx.query(
      `UPDATE outbox_events SET status='PROCESSING', processing_started_at=now()
        WHERE id IN (
          SELECT id FROM outbox_events
           WHERE status='PENDING' AND available_at <= now()
           ORDER BY created_at
           LIMIT 20
           FOR UPDATE SKIP LOCKED)
        RETURNING *`,
    );
    return rows.rows;
  });

  for (const ev of claimed) {
    try {
      if (ev.topic === "message.outbound") {
        const msg = await db.query(
          `UPDATE messages SET delivery_status='SENT' WHERE id=$1
           RETURNING id, conversation_id`,
          [ev.aggregate_id],
        );
        if (msg.rowCount) {
          const conv = await db.query(`SELECT fleet_organization_id FROM conversations WHERE id=$1`, [msg.rows[0].conversation_id]);
          eventBus.emit(`fleet:${conv.rows[0].fleet_organization_id}`, { type: "message", messageId: ev.aggregate_id });
        }
      } else {
        // Integration events: in the MVP they fan out to SSE for live state refresh.
        const payload = typeof ev.payload === "string" ? JSON.parse(ev.payload) : ev.payload;
        if (payload?.fleetOrganizationId) {
          eventBus.emit(`fleet:${payload.fleetOrganizationId}`, { type: ev.topic });
        }
      }
      await db.query(
        `UPDATE outbox_events SET status='SENT', processed_at=now(), processing_started_at=NULL WHERE id=$1`,
        [ev.id],
      );
    } catch (e) {
      const attempts = ev.attempts + 1;
      if (attempts >= MAX_ATTEMPTS) {
        await db.query(
          `UPDATE outbox_events SET status='FAILED', attempts=$2, last_error=$3, processing_started_at=NULL WHERE id=$1`,
          [ev.id, attempts, String(e).slice(0, 500)],
        );
        await db.query(
          `INSERT INTO exception_cases (type, summary, details)
           VALUES ('OTHER',$1,$2)`,
          [`Outbox event ${ev.topic} failed permanently`, JSON.stringify({ outboxEventId: ev.id, error: String(e).slice(0, 500) })],
        );
      } else {
        const backoffSec = Math.pow(2, attempts) * 5;
        await db.query(
          `UPDATE outbox_events
              SET status='PENDING', attempts=$2, last_error=$3,
                  available_at=now() + ($4 || ' seconds')::interval,
                  processing_started_at=NULL
            WHERE id=$1`,
          [ev.id, attempts, String(e).slice(0, 500), String(backoffSec)],
        );
      }
    }
  }
  return claimed.length;
}

/**
 * RFQ reminder ladder (§19.2): configurable intervals, reminder messages
 * never change the RFQ revision; after the configured number of reminders an
 * operator exception opens.
 */
export async function runReminders(db: Db, now = new Date()): Promise<number> {
  const r1min = Number(process.env.RFQ_REMINDER_1_MINUTES ?? 30);
  const r2min = Number(process.env.RFQ_REMINDER_2_MINUTES ?? 120);
  const handoffAfter = Number(process.env.RFQ_HANDOFF_AFTER_REMINDERS ?? 2);

  const due = await db.query(
    `SELECT rr.*, f.public_reference AS rfq_ref, f.revision, f.id AS rfq_id, f.order_id
       FROM rfq_recipients rr
       JOIN rfqs f ON f.id=rr.rfq_id AND f.status='ACTIVE'
      WHERE rr.status IN ('SENT','VIEWED','AWAITING_QUOTE','AWAITING_RECONFIRMATION')
        AND rr.responded_at IS NULL
        AND (
          (rr.reminder_count = 0 AND rr.sent_at IS NOT NULL AND rr.sent_at <= $1::timestamptz - ($2 || ' minutes')::interval)
          OR
          (rr.reminder_count = 1 AND rr.last_reminded_at <= $1::timestamptz - ($3 || ' minutes')::interval)
        )`,
    [now.toISOString(), String(r1min), String(r2min - r1min > 0 ? r2min - r1min : r2min)],
  );

  let sent = 0;
  for (const rec of due.rows) {
    await withTx(db, async (tx) => {
      const locked = (await tx.query(`SELECT * FROM rfq_recipients WHERE id=$1 FOR UPDATE`, [rec.id])).rows[0];
      if (locked.responded_at || locked.reminder_count !== rec.reminder_count) return; // raced
      const conv = await tx.query(
        `SELECT id FROM conversations WHERE fleet_organization_id=$1 AND channel='WEB' AND status='ACTIVE'`,
        [rec.fleet_organization_id],
      );
      if (!conv.rowCount) return;
      const newCount = locked.reminder_count + 1;
      await tx.query(
        `UPDATE rfq_recipients SET reminder_count=$2, last_reminded_at=now(), updated_at=now() WHERE id=$1`,
        [rec.id, newCount],
      );
      // Reminders never bump the revision (§19.2).
      await sendOutbound(tx, {
        conversationId: conv.rows[0].id,
        senderType: "MERCURY_SYSTEM",
        messageType: "SYSTEM_NOTICE",
        text: `提醒：询价 ${rec.rfq_ref} 还在等待你的回复。回复价格即可报价，或回复"无法承运"。`,
        context: { rfqId: rec.rfq_id, rfqRecipientId: rec.id, rfqRevision: rec.revision },
      });
      await audit(tx, {
        actor: SYSTEM_ACTOR, action: "rfq_recipient.reminded", objectType: "RFQ_RECIPIENT", objectId: rec.id,
        metadata: { reminderCount: newCount },
      });
      if (newCount >= handoffAfter) {
        await tx.query(
          `INSERT INTO exception_cases (type, order_id, rfq_id, fleet_organization_id, summary, details)
           SELECT 'NO_FLEET_RESPONSE', $1, $2, $3, $4, $5
           WHERE NOT EXISTS (
             SELECT 1 FROM exception_cases
              WHERE type='NO_FLEET_RESPONSE' AND rfq_id=$2 AND fleet_organization_id=$3 AND status='OPEN')`,
          [rec.order_id, rec.rfq_id, rec.fleet_organization_id,
           `No response to ${rec.rfq_ref} after ${newCount} reminders`, JSON.stringify({ rfqRecipientId: rec.id })],
        );
      }
      sent++;
    });
  }
  return sent;
}

/** Long-running loop for the worker process / in-process dev worker. */
export function startWorkerLoop(db: Db, opts: { pollMs?: number; remindersEveryMs?: number } = {}): () => void {
  const pollMs = opts.pollMs ?? Number(process.env.OUTBOX_POLL_MS ?? 500);
  let stopped = false;
  let lastReminderRun = 0;
  const tick = async () => {
    if (stopped) return;
    try {
      await processOutboxOnce(db);
      const every = opts.remindersEveryMs ?? 30_000;
      if (Date.now() - lastReminderRun > every) {
        lastReminderRun = Date.now();
        await runReminders(db);
      }
    } catch (e) {
      console.error(JSON.stringify({ level: "error", worker: true, error: String(e) }));
    } finally {
      if (!stopped) setTimeout(tick, pollMs);
    }
  };
  void tick();
  return () => {
    stopped = true;
  };
}
