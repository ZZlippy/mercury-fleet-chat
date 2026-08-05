/**
 * Builds static fixture data for the GitHub Pages "demo mode" build by driving
 * the REAL API/business logic through several order lifecycles, then dumping
 * the resulting API responses to JSON. This never runs in production — it's a
 * one-time local script whose output (apps/web/src/demo/fixtures.json) is
 * committed and bundled into the static demo build.
 */
import "dotenv/config";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "@mercury/db";

const PORT = Number(process.env.E2E_PORT ?? 4101);
const BASE = `http://localhost:${PORT}`;
const uuid = () => crypto.randomUUID();
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class Client {
  cookie = "";
  async req(method: string, path: string, body?: unknown, form?: FormData) {
    const response = await fetch(BASE + path, {
      method,
      headers: {
        ...(form ? {} : { "content-type": "application/json" }),
        ...(this.cookie ? { cookie: this.cookie } : {}),
      },
      body: form ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) this.cookie = setCookie.split(";")[0];
    const json = await response.json().catch(() => ({}));
    if (response.status >= 400) {
      throw new Error(`${method} ${path} -> ${response.status}: ${JSON.stringify(json)}`);
    }
    return json as any;
  }
  get = (path: string) => this.req("GET", path);
  post = (path: string, body?: unknown) => this.req("POST", path, body);
  patch = (path: string, body?: unknown) => this.req("PATCH", path, body);
}

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${BASE}/api/auth/session`);
      if ([200, 401, 404].includes(response.status)) return;
    } catch {
      // still booting
    }
    await wait(500);
  }
  throw new Error("API did not start");
}

async function loginFleet(username: string) {
  const c = new Client();
  await c.post("/api/auth/fleet/login", { username, password: "mercury" });
  return c;
}

async function sendTaskText(fleet: Client, task: any, text: string, replyTo?: string) {
  return fleet.post("/api/fleet/conversation/messages", {
    clientMessageId: uuid(),
    text,
    replyToMessageId: replyTo ?? task.anchor_message_id,
  });
}
async function taskMessages(fleet: Client, task: any) {
  return (await fleet.get(`/api/fleet/tasks/${task.rfq_recipient_id}/messages`)).messages as any[];
}
/**
 * Consumes an action by its stable actionType (e.g. "CONFIRM_QUOTE") rather
 * than by typed numbered text — the number shown to a human (1/2/3) is
 * resolved server-side against action insertion order, which is not
 * guaranteed to match array position when actions share a created_at, so
 * scripting against the literal digit is unreliable. Calling the consume
 * endpoint directly by actionType is deterministic and exercises the same
 * business logic a real numbered reply would.
 */
async function consumeByType(fleet: Client, message: any, actionType: string) {
  const action = message.actions.find((a: any) => a.actionType === actionType && a.status === "AVAILABLE");
  if (!action) {
    throw new Error(
      `consumeByType: no AVAILABLE ${actionType} action on message ${message.id} (has: ${JSON.stringify(message.actions)})`,
    );
  }
  return fleet.post(`/api/fleet/conversation/actions/${action.id}/consume`, { idempotencyKey: uuid() });
}
async function findTask(fleet: Client, reference: string, tries = 20): Promise<any> {
  for (let i = 0; i < tries; i += 1) {
    const tasks = (await fleet.get("/api/fleet/tasks")).tasks as any[];
    const found = tasks.find((t) => t.order_reference === reference);
    if (found) return found;
    await wait(250);
  }
  throw new Error(`findTask: ${reference} never appeared`);
}
/** Polls task messages until predicate matches (business logic runs slightly async). */
async function waitForMessage(
  fleet: Client,
  task: any,
  predicate: (m: any) => boolean,
  tries = 40,
  delay = 250,
): Promise<any> {
  for (let i = 0; i < tries; i += 1) {
    const msgs = await taskMessages(fleet, task);
    const match = msgs.findLast(predicate);
    if (match) return match;
    await wait(delay);
  }
  throw new Error("waitForMessage: no match found in time");
}
async function waitForState(
  operator: Client,
  predicate: (state: any) => any,
  tries = 40,
  delay = 250,
): Promise<any> {
  for (let i = 0; i < tries; i += 1) {
    const state = await operator.get("/api/operator/state");
    const match = predicate(state);
    if (match) return match;
    await wait(delay);
  }
  throw new Error("waitForState: no match found in time");
}

const isQuoteConfirmation = (m: any) => m.structured_content?.kind === "QUOTE_CONFIRMATION";
const isBookingOffer = (m: any) => m.structured_content?.kind === "BOOKING_OFFER";
const isShipmentConfirmationAvailable = (m: any) =>
  m.structured_content?.kind === "SHIPMENT_STATUS_CONFIRMATION" &&
  m.actions.some((a: any) => a.status === "AVAILABLE");

async function runQuoteAndBooking(
  operator: Client,
  fleet: Client,
  task: any,
  amountText: string,
  matchQuote: (state: any) => any,
) {
  let latest = await waitForMessage(fleet, task, () => true);
  await consumeByType(fleet, latest, "MODIFY_QUOTE"); // "我要报价"
  await sendTaskText(fleet, task, amountText, latest.id);
  latest = await waitForMessage(fleet, task, isQuoteConfirmation);
  await consumeByType(fleet, latest, "CONFIRM_QUOTE"); // "确认提交"

  const quote = await waitForState(operator, matchQuote);
  await operator.post(`/api/operator/quotes/${quote.id}/select`, {});
  latest = await waitForMessage(fleet, task, isBookingOffer);
  await consumeByType(fleet, latest, "ACCEPT_BOOKING"); // "接受任务"
  return quote;
}

async function runMilestones(fleet: Client, reference: string, phrases: string[]) {
  for (const phrase of phrases) {
    const task = await findTask(fleet, reference);
    await sendTaskText(fleet, task, phrase, task.anchor_message_id);
    const latest = await waitForMessage(fleet, task, isShipmentConfirmationAvailable);
    await consumeByType(fleet, latest, "CONFIRM_SHIPMENT_STATUS");
  }
}

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const { getDb, closeDb } = await import("@mercury/db");
  const db = getDb();
  await migrate(db);
  await db.query(`
    TRUNCATE
      processed_commands, outbox_events, audit_logs, exception_cases,
      pending_interactions, task_read_states,
      fleet_profile_version_countries, fleet_profile_versions, fleet_profiles,
      document_links, documents, shipment_events, shipments,
      booking_assignments, bookings, quotes, message_actions,
      message_context_links, messages, rfq_recipients, rfqs,
      conversations, orders, vehicles, drivers, sessions,
      organization_memberships, users, organizations
    RESTART IDENTITY CASCADE
  `);
  await closeDb();
  await new Promise<void>((resolve, reject) => {
    const seed = spawn("npx", ["tsx", "scripts/seed.ts"], { env: process.env, stdio: "ignore" });
    seed.on("exit", (code) => (code === 0 ? resolve() : reject(new Error("seed failed"))));
  });

  const serverLog = fs.openSync("/tmp/demo-fixtures-server.log", "w");
  const server = spawn("npx", ["tsx", "apps/api/src/main.ts"], {
    env: { ...process.env, PORT: String(PORT), INTERPRETER: "rule" },
    stdio: ["ignore", serverLog, serverLog],
    detached: true,
  });

  try {
    await waitForServer();
    const operator = new Client();
    await operator.post("/api/auth/operator/login", { username: "operator1", password: "mercury" });
    console.log("STEP: operator logged in");

    // ---------- Order 1 (fleet1): full lifecycle -> COMPLETED ----------
    const ref1 = "M-DEMO-1001";
    let res = await operator.post("/api/operator/orders", {
      publicReference: ref1,
      orderType: "IMPORT_DRAYAGE",
      serviceCountry: "SG",
      destinationTerminal: "PSA Pasir Panjang Terminal",
      deliveryLocation: "Jurong Industrial Estate",
      emptyContainerReturnLocation: "Tuas Empty Container Depot",
      containerType: "40HQ",
      containerQuantity: 2,
      requestedStartAt: "2026-08-06T01:00:00.000Z",
    });
    const order1Id = res.order.id as string;
    const fleet1OrgCandidate = res.candidates.find((c: any) => c.eligible);
    await operator.post(`/api/operator/orders/${order1Id}/send-rfq`, {
      fleetOrganizationIds: [fleet1OrgCandidate.id],
    });
    const fleet1 = await loginFleet("fleet1");
    let task1 = await findTask(fleet1, ref1);
    console.log("STEP: order1 RFQ sent, fleet1 task visible");

    const quote1 = await runQuoteAndBooking(operator, fleet1, task1, "220全包", (state) =>
      state.quotes.find((q: any) => q.status === "SUBMITTED"));
    console.log("STEP: order1 quote+booking done", quote1.id);

    await runMilestones(fleet1, ref1, ["全部重箱已提取", "前往送货地点", "送到了", "等待归还空箱", "全部空箱已还"]);
    console.log("STEP: order1 milestones done");

    const shipment1 = await waitForState(operator, (state: any) =>
      state.shipments.find((s: any) =>
        state.bookings.some((b: any) => b.id === s.booking_id && b.order_id === order1Id)));

    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    for (const [documentType, fileName] of [["POD", "pod.png"], ["EMPTY_CONTAINER_RETURN", "empty-return.png"]]) {
      const form = new FormData();
      form.append("clientMessageId", uuid());
      form.append("shipmentId", shipment1.id);
      form.append("documentType", documentType);
      form.append("file", new Blob([png], { type: "image/png" }), fileName);
      await fleet1.req("POST", "/api/fleet/conversation/attachments", undefined, form);
    }
    await operator.post(`/api/operator/shipments/${shipment1.id}/documents/review`, { approved: true });
    console.log("STEP: order1 fully completed");

    // ---------- Order 2 (fleet2): EXPORT_DRAYAGE, shipment IN PROGRESS ----------
    const ref2 = "M-DEMO-1002";
    res = await operator.post("/api/operator/orders", {
      publicReference: ref2,
      orderType: "EXPORT_DRAYAGE",
      serviceCountry: "SG",
      loadingLocation: "Tuas Warehouse Hub",
      originTerminal: "PSA Tuas Terminal",
      emptyContainerPickupLocation: "Tuas Empty Container Depot",
      emptyContainerPickupAt: "2026-08-07T01:00:00.000Z",
      containerType: "20GP",
      containerQuantity: 1,
      requestedStartAt: "2026-08-07T01:00:00.000Z",
    });
    const order2Id = res.order.id as string;
    const fleet2Candidate =
      res.candidates.find((c: any) => c.name?.includes("Fleet 2")) ??
      res.candidates.find((c: any) => c.eligible);
    await operator.post(`/api/operator/orders/${order2Id}/send-rfq`, {
      fleetOrganizationIds: [fleet2Candidate.id],
    });
    const fleet2 = await loginFleet("fleet2");
    const task2 = await findTask(fleet2, ref2);
    console.log("STEP: order2 RFQ sent, fleet2 task visible");

    await runQuoteAndBooking(operator, fleet2, task2, "150全包", (state) =>
      state.quotes.find((q: any) => q.status === "SUBMITTED" &&
        state.recipients.some((r: any) => r.id === q.rfq_recipient_id && r.fleet_organization_id === fleet2Candidate.id)));
    console.log("STEP: order2 quote+booking done");

    // Only progress the first 2 of 6 export milestones -> leaves shipment IN_PROGRESS.
    await runMilestones(fleet2, ref2, ["全部空箱已提取", "已到达装货地点"]);
    console.log("STEP: order2 partial milestones done (left in-progress)");

    // ---------- Order 3 (fleet3): quote submitted, awaiting operator decision ----------
    const ref3 = "M-DEMO-1003";
    res = await operator.post("/api/operator/orders", {
      publicReference: ref3,
      orderType: "IMPORT_DRAYAGE",
      serviceCountry: "SG",
      destinationTerminal: "PSA Brani Terminal",
      deliveryLocation: "Woodlands Logistics Park",
      emptyContainerReturnLocation: "Tuas Empty Container Depot",
      containerType: "40HQ",
      containerQuantity: 3,
      requestedStartAt: "2026-08-08T02:00:00.000Z",
    });
    const order3Id = res.order.id as string;
    const fleet3Candidate =
      res.candidates.find((c: any) => c.name?.includes("Fleet 3")) ??
      res.candidates.find((c: any) => c.eligible);
    await operator.post(`/api/operator/orders/${order3Id}/send-rfq`, {
      fleetOrganizationIds: [fleet3Candidate.id],
    });
    const fleet3 = await loginFleet("fleet3");
    const task3 = await findTask(fleet3, ref3);
    let latest = await waitForMessage(fleet3, task3, () => true);
    await consumeByType(fleet3, latest, "MODIFY_QUOTE");
    await sendTaskText(fleet3, task3, "310全包", latest.id);
    latest = await waitForMessage(fleet3, task3, isQuoteConfirmation);
    await consumeByType(fleet3, latest, "CONFIRM_QUOTE");
    // Deliberately NOT selecting a quote here — operator still has a pending decision.
    console.log("STEP: order3 quote submitted, awaiting operator decision");

    // ---------- Order 4: DRAFT, RFQ not sent yet ----------
    const ref4 = "M-DEMO-1004";
    res = await operator.post("/api/operator/orders", {
      publicReference: ref4,
      orderType: "IMPORT_DRAYAGE",
      serviceCountry: "SG",
      destinationTerminal: "PSA Pasir Panjang Terminal",
      deliveryLocation: "Changi Business Park",
      emptyContainerReturnLocation: "Tuas Empty Container Depot",
      containerType: "40HQ",
      containerQuantity: 1,
      requestedStartAt: "2026-08-09T03:00:00.000Z",
      isReefer: true,
      reeferTemperatureC: -18,
    });
    const order4Id = res.order.id as string;
    const order4Candidates = res.candidates;
    console.log("STEP: order4 created as draft (no RFQ sent)");

    // ---------- fleet4 submits a profile edit -> pending operator review ----------
    const fleet4 = await loginFleet("fleet4");
    await fleet4.post("/api/fleet/profile", {
      fleetName: "Fleet 4 (申请更新)",
      acceptingOrders: true,
      operatingCountries: ["SG", "MY"],
      supportsHazardous: true,
      supportsReefer: true,
      contactName: "联系人 4",
      contactPhone: "+65 6000 0004",
      notes: "新增马来西亚跨境能力，申请审核。",
    });
    console.log("STEP: fleet4 profile edit submitted for review");

    // ---------- Capture everything ----------
    const operatorState = await operator.get("/api/operator/state");
    const operatorAudit = await operator.get("/api/operator/audit");
    const pendingProfiles = await operator.get("/api/operator/fleet-profiles/pending");

    const fleets: Record<string, any> = {};
    for (const [username, client] of [
      ["fleet1", fleet1],
      ["fleet2", fleet2],
      ["fleet3", fleet3],
      ["fleet4", fleet4],
    ] as const) {
      const session = await client.get(`/api/auth/fleet/session`);
      const tasksRes = await client.get("/api/fleet/tasks");
      const messagesByTask: Record<string, any[]> = {};
      for (const t of tasksRes.tasks) {
        messagesByTask[t.rfq_recipient_id] = await taskMessages(client, t);
      }
      const profile = await client.get("/api/fleet/profile");
      fleets[username] = { session, tasks: tasksRes.tasks, messagesByTask, profile };
    }

    const fixtures = {
      generatedAt: new Date().toISOString(),
      operator: {
        session: await operator.get("/api/auth/operator/session"),
        state: operatorState,
        audit: operatorAudit,
        pendingProfiles,
        order4Candidates,
        order4Id,
      },
      fleets,
    };

    const outPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../apps/web/src/demo/fixtures.json",
    );
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(fixtures, null, 2));
    console.log(`Wrote fixtures to ${outPath}`);
  } finally {
    try {
      if (server.pid) process.kill(-server.pid, "SIGKILL"); // whole detached process group
    } catch {
      server.kill("SIGKILL");
    }
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error("FAILED:", error);
    process.exit(1);
  },
);
