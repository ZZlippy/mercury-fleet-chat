/**
 * Component tests for the Fleet workspace.
 *
 * These exist because the Playwright specs cannot run in this environment
 * (Chromium is not downloadable here). They cover the behaviours that broke
 * before: per-task draft isolation, the stale-response race, the read-only
 * banner, and retry after a failed send.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { FleetTask, SessionUser } from "../src/api";
import { api } from "../src/api";
import { Chat, categoryOf, deadlineLabel } from "../src/components/Chat";

const task = (over: Partial<FleetTask> & { rfq_recipient_id: string }): FleetTask => ({
  order_id: `o-${over.rfq_recipient_id}`,
  order_reference: `M-${over.rfq_recipient_id}`,
  order_status: "QUOTING",
  pickup_location_text: "PSA Brani",
  delivery_location_text: "Tuas South",
  pickup_at: new Date(Date.now() + 5 * 86_400_000).toISOString(),
  rfq_id: `f-${over.rfq_recipient_id}`,
  rfq_reference: `RFQ-${over.rfq_recipient_id}`,
  rfq_revision: 1,
  recipient_status: "SENT",
  quote_id: null,
  quote_status: null,
  amount: null,
  currency: null,
  booking_id: null,
  booking_reference: null,
  booking_status: null,
  shipment_id: null,
  shipment_status: null,
  anchor_message_id: `anchor-${over.rfq_recipient_id}`,
  last_message_text: null,
  last_message_at: null,
  open_exception_count: 0,
  ...over,
});

const session = (role: SessionUser["role"] = "DISPATCHER"): SessionUser => ({
  user: { id: "u1", username: "fleet_test", email: null, displayName: "陈调度" },
  organization: { id: "org1", name: "ABC Logistics", type: "FLEET" },
  role,
});

const TASK_A = task({ rfq_recipient_id: "aaa", rfq_reference: "RFQ-AAA" });
const TASK_B = task({ rfq_recipient_id: "bbb", rfq_reference: "RFQ-BBB" });

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(api, "tasks").mockResolvedValue({ tasks: [TASK_A, TASK_B] });
  vi.spyOn(api, "taskMessages").mockImplementation(async (id: string) => ({
    conversationId: "c1",
    taskId: id,
    messages: [],
  }));
});

const openTask = async (label: string) => {
  const user = userEvent.setup();
  const row = await screen.findByRole("button", { name: new RegExp(label) });
  await user.click(row);
  return user;
};

describe("Fleet workspace — per-task isolation", () => {
  it("keeps drafts separate per task and does not carry text across a switch", async () => {
    render(<Chat session={session()} onLogout={async () => {}} />);
    const user = await openTask("RFQ-AAA");

    const composer = () => screen.getByLabelText("消息内容") as HTMLTextAreaElement;
    await user.type(composer(), "220全包");
    expect(composer().value).toBe("220全包");

    // Switch to the other task: its draft must be empty, not inherited.
    await user.click(screen.getByRole("button", { name: /RFQ-BBB/ }));
    await waitFor(() => expect(composer().value).toBe(""));

    // Switching back restores the original draft.
    await user.click(screen.getByRole("button", { name: /RFQ-AAA/ }));
    await waitFor(() => expect(composer().value).toBe("220全包"));
  });

  it("ignores a slow message response for a task the user already left", async () => {
    // Task A resolves slowly with its own messages; task B resolves instantly.
    vi.spyOn(api, "taskMessages").mockImplementation((id: string) => {
      if (id === "aaa") {
        return new Promise((resolve) =>
          setTimeout(
            () => resolve({ conversationId: "c1", taskId: "aaa", messages: [
              { id: "m-a", direction: "OUTBOUND", sender_type: "MERCURY_AI", message_type: "TEXT",
                text_content: "A 的消息不应出现在 B", structured_content: null,
                reply_to_message_id: null, created_at: new Date().toISOString(),
                external_message_id: null, actions: [] },
            ] }),
            80,
          ),
        );
      }
      return Promise.resolve({ conversationId: "c1", taskId: id, messages: [
        { id: "m-b", direction: "OUTBOUND", sender_type: "MERCURY_AI", message_type: "TEXT",
          text_content: "B 的消息", structured_content: null, reply_to_message_id: null,
          created_at: new Date().toISOString(), external_message_id: null, actions: [] },
      ] });
    });

    render(<Chat session={session()} onLogout={async () => {}} />);
    const user = await openTask("RFQ-AAA");
    await user.click(screen.getByRole("button", { name: /RFQ-BBB/ }));

    await screen.findByText("B 的消息");
    // Wait past task A's latency; its payload must not replace B's.
    await new Promise((r) => setTimeout(r, 160));
    expect(screen.queryByText("A 的消息不应出现在 B")).toBeNull();
    expect(screen.getByText("B 的消息")).toBeTruthy();
  });
});

describe("Fleet workspace — send failures and roles", () => {
  it("offers retry after a failed send and reuses the same client message id", async () => {
    const send = vi.spyOn(api, "sendMessage").mockRejectedValue(
      Object.assign(new Error("offline"), { status: 500, body: {} }),
    );
    render(<Chat session={session()} onLogout={async () => {}} />);
    const user = await openTask("RFQ-AAA");

    await user.type(screen.getByLabelText("消息内容"), "USD 220");
    await user.click(screen.getByRole("button", { name: "发送" }));

    // The failure is shown inline with a retry control (never a browser alert).
    const failure = await screen.findByRole("status");
    expect(within(failure).getByText("没能发出去")).toBeTruthy();
    const firstId = send.mock.calls[0][0];

    send.mockResolvedValue({ messageId: "server-1", duplicate: false });
    await user.click(within(failure).getByRole("button", { name: "重试" }));

    // Retrying must reuse the original id so the server dedupes it.
    await waitFor(() => expect(send.mock.calls.length).toBe(2));
    expect(send.mock.calls[1][0]).toBe(firstId);
  });

  it("tells a viewer they are read-only before they try anything", async () => {
    render(<Chat session={session("VIEWER")} onLogout={async () => {}} />);
    expect(
      await screen.findByText(/你当前为只读账号，可以查看任务，但不能提交报价或更新状态。/),
    ).toBeTruthy();
    await waitFor(() =>
      expect((screen.getByLabelText("消息内容") as HTMLTextAreaElement).disabled).toBe(true),
    );
  });
});

describe("Fleet workspace — task triage helpers", () => {
  it("routes tasks into the categories a dispatcher thinks in", () => {
    expect(categoryOf(task({ rfq_recipient_id: "1", recipient_status: "SENT" }))).toBe("needs_action");
    expect(categoryOf(task({ rfq_recipient_id: "2", recipient_status: "AWAITING_RECONFIRMATION" }))).toBe("needs_action");
    expect(categoryOf(task({ rfq_recipient_id: "3", shipment_status: "IN_TRANSIT_TO_DELIVERY" }))).toBe("shipping");
    expect(categoryOf(task({ rfq_recipient_id: "4", shipment_status: "COMPLETED" }))).toBe("done");
    // An open exception outranks whatever else the task is doing.
    expect(categoryOf(task({ rfq_recipient_id: "5", shipment_status: "IN_TRANSIT_TO_DELIVERY", open_exception_count: 2 }))).toBe("exception");
  });

  it("flags a pickup deadline as urgent inside 24 hours and when overdue", () => {
    const now = Date.UTC(2026, 0, 10, 0, 0, 0);
    expect(deadlineLabel(new Date(now + 3 * 3_600_000).toISOString(), now).urgent).toBe(true);
    expect(deadlineLabel(new Date(now - 3_600_000).toISOString(), now).urgent).toBe(true);
    expect(deadlineLabel(new Date(now + 5 * 86_400_000).toISOString(), now).urgent).toBe(false);
    expect(deadlineLabel(null, now).text).toBe("提货时间待定");
  });
});
