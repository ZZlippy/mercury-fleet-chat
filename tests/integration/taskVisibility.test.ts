import { beforeEach, describe, expect, it } from "vitest";
import {
  applyOrderFleetVisibleChange,
  consumeMessageAction,
  handleInbound,
  recordInbound,
  sendRfqToFleet,
} from "@mercury/application";
import { cid, findActions, setupFixtures, type Fixtures } from "./helpers.ts";

let f: Fixtures;

/**
 * Messages the dispatcher actually sees.
 *
 * The Fleet UI never renders the whole conversation: it renders one task at a
 * time, and a message only belongs to a task through message_context_links.
 * A message with no link exists in the database but is invisible in every task,
 * so asserting against the raw conversation feed can pass while the dispatcher
 * sees nothing. These helpers deliberately mirror the task-scoped query the API
 * uses, so a regression here fails the test instead of silently reaching users.
 */
async function taskMessages(rfqRecipientId: string) {
  const task = (
    await f.db.query(
      `SELECT rr.id, rr.rfq_id, r.order_id
         FROM rfq_recipients rr JOIN rfqs r ON r.id = rr.rfq_id
        WHERE rr.id = $1`,
      [rfqRecipientId],
    )
  ).rows[0];
  const rows = await f.db.query(
    `SELECT m.text_content, m.message_type, m.direction
       FROM messages m
      WHERE EXISTS (
        SELECT 1 FROM message_context_links l
         WHERE l.message_id = m.id
           AND (l.rfq_recipient_id = $1 OR l.rfq_id = $2 OR l.order_id = $3)
      )
      ORDER BY m.created_at`,
    [task.id, task.rfq_id, task.order_id],
  );
  return rows.rows as { text_content: string | null; message_type: string; direction: string }[];
}

const visibleText = (rows: Awaited<ReturnType<typeof taskMessages>>) =>
  rows.map((r) => r.text_content ?? "").join("\n");

async function sendRfq() {
  const sent = await sendRfqToFleet(
    f.db,
    f.operator,
    { orderId: f.orderId, fleetOrganizationId: f.fleetA },
    cid(),
  );
  if (!sent.ok) throw new Error("RFQ send failed");
  return sent.result;
}

async function quoteAndGetConfirmAction() {
  const rec = await recordInbound(f.db, f.dispatcherA, {
    conversationId: f.convA,
    clientMessageId: cid(),
    text: "USD 220 全包",
    replyToMessageId: null,
  });
  await handleInbound(f.db, f.dispatcherA, { conversationId: f.convA, messageId: rec.messageId });
  const [confirm] = await findActions(f.db, f.convA, "CONFIRM_QUOTE");
  return confirm;
}

describe("refusals and notices are visible inside the task conversation", () => {
  beforeEach(async () => {
    f = await setupFixtures();
  });

  it("explains a stale-revision click inside the task, not only in the raw feed", async () => {
    const { rfqRecipientId } = await sendRfq();
    const confirm = await quoteAndGetConfirmAction();

    // Operator changes a fleet-visible field: the RFQ revision moves on and the
    // button the dispatcher is holding becomes stale.
    const changed = await applyOrderFleetVisibleChange(
      f.db,
      f.operator,
      { orderId: f.orderId, changes: { container_type: "20GP" } },
      cid(),
    );
    expect(changed.ok).toBe(true);

    const before = await taskMessages(rfqRecipientId);
    const res = await consumeMessageAction(f.db, f.dispatcherA, {
      actionId: confirm.id,
      clientIdempotencyKey: cid(),
    });
    expect(res.ok).toBe(true);

    const after = await taskMessages(rfqRecipientId);
    expect(after.length).toBeGreaterThan(before.length);

    // A revision bump invalidates sibling buttons up front, so this click can
    // legitimately land on either refusal branch (already-unavailable, or
    // stale-version). Both must reach the dispatcher inside this task, and both
    // must say plainly that nothing changed.
    const text = visibleText(after);
    expect(text).toMatch(/不能用|不再有效/);

    // The typed result must carry the same explanation (no exception thrown).
    if (!res.ok) throw new Error("expected a typed refusal, not a failure");
    const outcome = res.result;
    expect(outcome.outcome === "ACTION_UNAVAILABLE" || outcome.outcome === "STALE_REVISION").toBe(true);
    if (outcome.outcome === "ACTION_UNAVAILABLE" || outcome.outcome === "STALE_REVISION") {
      expect(outcome.message).toMatch(/不能用|不再有效/);
    }

    // And the refusal must not have written any business state.
    const quotes = await f.db.query(
      `SELECT status FROM quotes WHERE rfq_recipient_id=$1 AND status='SUBMITTED'`,
      [rfqRecipientId],
    );
    expect(quotes.rowCount).toBe(0);
  });

  it("keeps exactly one context link per message so task routing is deterministic", async () => {
    const { rfqRecipientId, messageId } = await sendRfq();

    // A delayed reply to the pre-change card: recordInbound copies the parent
    // link and the stale-reply branch also links it. Only one row may exist.
    const rec = await recordInbound(f.db, f.dispatcherA, {
      conversationId: f.convA,
      clientMessageId: cid(),
      text: "220可以",
      replyToMessageId: messageId,
    });
    await applyOrderFleetVisibleChange(
      f.db,
      f.operator,
      { orderId: f.orderId, changes: { container_type: "20GP" } },
      cid(),
    );
    await handleInbound(f.db, f.dispatcherA, { conversationId: f.convA, messageId: rec.messageId });

    const links = await f.db.query(
      `SELECT count(*)::int AS n FROM message_context_links WHERE message_id=$1`,
      [rec.messageId],
    );
    expect(links.rows[0].n).toBe(1);

    // No message anywhere may carry duplicate links.
    const dupes = await f.db.query(
      `SELECT count(*)::int AS n FROM (
         SELECT message_id FROM message_context_links
          GROUP BY message_id HAVING count(*) > 1
       ) d`,
    );
    expect(dupes.rows[0].n).toBe(0);
    expect(rfqRecipientId).toBeTruthy();
  });
});
