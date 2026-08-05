/**
 * Mercury Fleet MVP v1.1 live HTTP acceptance run.
 *
 * Requires DATABASE_URL and a PostgreSQL 15+ server. The script resets that
 * database, migrates, seeds, starts the API, and exercises an IMPORT order from
 * candidate selection through numbered chat, empty return, two documents, and
 * operator completion.
 */
import "dotenv/config";
import { spawn } from "node:child_process";
import { migrate } from "@mercury/db";

const PORT = Number(process.env.E2E_PORT ?? 4100);
const BASE = `http://localhost:${PORT}`;

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
    return { status: response.status, json: json as any };
  }
  get = (path: string) => this.req("GET", path);
  post = (path: string, body?: unknown) => this.req("POST", path, body);
}

let assertions = 0;
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERT FAILED: ${message}`);
  assertions += 1;
  console.log(`  ✓ ${message}`);
}

const uuid = () => crypto.randomUUID();
const wait = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitForServer() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${BASE}/api/auth/session`);
      if ([200, 401].includes(response.status)) return;
    } catch {
      // Retry while the server boots.
    }
    await wait(500);
  }
  throw new Error("API did not start");
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
    const seed = spawn("npx", ["tsx", "scripts/seed.ts"], {
      env: process.env,
      stdio: "ignore",
    });
    seed.on("exit", (code) =>
      code === 0 ? resolve() : reject(new Error("seed failed")));
  });

  const server = spawn("npx", ["tsx", "apps/api/src/main.ts"], {
    env: { ...process.env, PORT: String(PORT), INTERPRETER: "rule" },
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    await waitForServer();
    const operator = new Client();
    const fleet = new Client();

    let response = await operator.post("/api/auth/operator/login", {
      username: "operator1",
      password: "mercury",
    });
    assert(response.status === 200 && response.json.role === "OPERATOR", "operator1 登录");
    response = await fleet.post("/api/auth/fleet/login", {
      username: "fleet1",
      password: "mercury",
    });
    assert(response.status === 200 && response.json.role === "FLEET_ADMIN", "fleet1 登录");

    const reference = `M-${Date.now().toString(36).toUpperCase()}`;
    response = await operator.post("/api/operator/orders", {
      publicReference: reference,
      orderType: "IMPORT_DRAYAGE",
      serviceCountry: "SG",
      destinationTerminal: "PSA Pasir Panjang Terminal",
      deliveryLocation: "Jurong Industrial Estate",
      emptyContainerReturnLocation: "Tuas Empty Container Depot",
      containerType: "40HQ",
      containerQuantity: 2,
      requestedStartAt: "2026-08-04T01:00:00.000Z",
    });
    assert(response.status === 200, "创建 IMPORT_DRAYAGE 多箱订单");
    const orderId = response.json.order.id as string;
    const defaultFleet = response.json.candidates.find((candidate: any) => candidate.eligible);
    assert(defaultFleet, "按已审核档案生成默认候选");
    response = await operator.post(`/api/operator/orders/${orderId}/send-rfq`, {
      fleetOrganizationIds: [defaultFleet.id],
    });
    assert(response.status === 200, "operator 确认收件人后发送 RFQ");

    await wait(800);
    let tasks = (await fleet.get("/api/fleet/tasks")).json.tasks as any[];
    const task = tasks.find((item) => item.order_reference === reference);
    assert(task?.container_quantity === 2, "车队任务显示整票两箱");

    const sendTaskText = async (text: string, replyTo?: string) =>
      fleet.post("/api/fleet/conversation/messages", {
        clientMessageId: uuid(),
        text,
        replyToMessageId: replyTo ?? task.anchor_message_id,
      });
    const taskMessages = async () =>
      (await fleet.get(`/api/fleet/tasks/${task.rfq_recipient_id}/messages`)).json.messages as any[];

    let messages = await taskMessages();
    let latest = messages.at(-1);
    assert(latest.text_content.includes("1. 我要报价"), "RFQ 使用编号文本");
    await sendTaskText("1", latest.id);
    await sendTaskText("220全包", latest.id);
    await wait(400);
    messages = await taskMessages();
    latest = messages.findLast((message) =>
      message.structured_content?.kind === "QUOTE_CONFIRMATION");
    assert(latest.text_content.includes("1. 确认提交"), "报价确认使用编号文本");
    await sendTaskText("1", latest.id);

    let state = (await operator.get("/api/operator/state")).json;
    const quote = state.quotes.find((item: any) => item.status === "SUBMITTED");
    assert(quote?.vehicle_available === true, "报价保存整票车辆可用性");
    await operator.post(`/api/operator/quotes/${quote.id}/select`, {});
    await wait(400);
    messages = await taskMessages();
    latest = messages.findLast((message) =>
      message.structured_content?.kind === "BOOKING_OFFER");
    await sendTaskText("1", latest.id);

    const milestones = [
      "全部重箱已提取",
      "前往送货地点",
      "送到了",
      "等待归还空箱",
      "全部空箱已还",
    ];
    for (const phrase of milestones) {
      tasks = (await fleet.get("/api/fleet/tasks")).json.tasks;
      const currentTask = tasks.find((item: any) => item.order_reference === reference);
      await sendTaskText(phrase, currentTask.anchor_message_id);
      await wait(200);
      messages = await taskMessages();
      latest = messages.findLast((message) =>
        message.structured_content?.kind === "SHIPMENT_STATUS_CONFIRMATION" &&
        message.actions.some((action: any) => action.status === "AVAILABLE"));
      await sendTaskText("1", latest.id);
    }

    state = (await operator.get("/api/operator/state")).json;
    const shipment = state.shipments.find((item: any) =>
      state.bookings.some((booking: any) =>
        booking.id === item.booking_id && booking.order_id === orderId));
    assert(shipment.current_status === "EMPTY_RETURNED", "送达后仍完成还空箱节点");

    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    for (const [documentType, fileName] of [
      ["POD", "pod.png"],
      ["EMPTY_CONTAINER_RETURN", "empty-return.png"],
    ]) {
      const form = new FormData();
      form.append("clientMessageId", uuid());
      form.append("shipmentId", shipment.id);
      form.append("documentType", documentType);
      form.append("file", new Blob([png], { type: "image/png" }), fileName);
      response = await fleet.req(
        "POST",
        "/api/fleet/conversation/attachments",
        undefined,
        form,
      );
      assert(response.status === 200, `上传 ${documentType}`);
    }

    state = (await operator.get("/api/operator/state")).json;
    assert(
      state.shipments.find((item: any) => item.id === shipment.id).current_status === "REVIEW_PENDING",
      "文件齐全后等待运营审核",
    );
    await operator.post(`/api/operator/shipments/${shipment.id}/documents/review`, {
      approved: true,
    });
    state = (await operator.get("/api/operator/state")).json;
    assert(
      state.orders.find((item: any) => item.id === orderId).status === "COMPLETED",
      "审核通过后 Order、Booking、Shipment 确定性完成",
    );

    console.log(`\nE2E PASS — ${assertions} assertions`);
  } finally {
    server.kill("SIGTERM");
  }
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(`\nE2E FAIL: ${error.message}`);
    process.exit(1);
  },
);
