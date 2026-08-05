import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  DEMO_MODE,
  uuid,
  type ChatMessage,
  type FleetTask,
  type SessionUser,
} from "../api";
import { asset, MercuryBrand } from "../App";
import { StructuredCard } from "./Cards";
import { FleetProfilePanel } from "./FleetProfile";

/**
 * Human-readable status wording. Internal enums must never be the primary copy,
 * so anything unmapped falls back to a neutral Chinese phrase and keeps the raw
 * value only in a title attribute for support.
 */
const TASK_STATUS: Record<string, string> = {
  SENT: "等待报价",
  VIEWED: "已查看",
  AWAITING_QUOTE: "稍后报价",
  AWAITING_RECONFIRMATION: "需要重新确认",
  QUOTED: "报价已提交",
  DECLINED: "已拒绝",
  OFFERED: "待接单",
  ACCEPTED: "车队已接单",
  REVIEW_PENDING: "等待运营审核",
  WAITING_EMPTY_CONTAINER_RELEASE: "等待提取空箱",
  EMPTY_CONTAINER_PICKED_UP: "全部空箱已提取",
  AT_LOADING_LOCATION: "已到装货地点",
  LOADED: "全部集装箱已装货",
  EN_ROUTE_TO_TERMINAL: "前往码头",
  LADEN_CONTAINERS_RETURNED_TO_TERMINAL: "全部重箱已还至码头",
  WAITING_PORT_RELEASE: "等待码头放箱",
  CONTAINER_PICKED_UP: "全部重箱已从码头提取",
  IN_TRANSIT_TO_DELIVERY: "前往送货地点",
  EMPTY_RETURN_PENDING: "等待归还空箱",
  EMPTY_RETURNED: "全部空箱已归还",
  DOCUMENTS_SUBMITTED: "必需文件已提交",
  IN_PROGRESS: "运输中",
  WAITING_ASSIGNMENT: "待安排车辆",
  DRIVER_ASSIGNED: "已安排司机车辆",
  EN_ROUTE_TO_PICKUP: "前往提货",
  AT_PICKUP: "已到提货点",
  PICKED_UP: "已提货",
  IN_TRANSIT: "运输途中",
  AT_DELIVERY: "已到送达点",
  DELIVERED: "已送达",
  POD_SUBMITTED: "签收证明（POD）待运营审核",
  COMPLETED: "已完成",
  CANCELLED: "已取消",
  EXCEPTION: "有异常事项",
};

const statusText = (raw: string) => TASK_STATUS[raw] ?? "状态待更新";

const statusOf = (task: FleetTask) =>
  task.shipment_status ?? task.booking_status ?? task.recipient_status ?? task.order_status;

/** Categories the dispatcher actually thinks in. */
type Category = "all" | "needs_action" | "waiting" | "shipping" | "exception" | "done";

const CATEGORY_LABEL: Record<Category, string> = {
  all: "全部",
  needs_action: "需要我处理",
  waiting: "等待 Mercury",
  shipping: "执行中",
  exception: "有异常",
  done: "已完成",
};

const DONE = new Set(["COMPLETED", "CANCELLED", "DECLINED"]);
const SHIPPING = new Set([
  "IN_PROGRESS", "ACCEPTED", "WAITING_EMPTY_CONTAINER_RELEASE", "EMPTY_CONTAINER_PICKED_UP",
  "AT_LOADING_LOCATION", "LOADED", "EN_ROUTE_TO_TERMINAL",
  "LADEN_CONTAINERS_RETURNED_TO_TERMINAL", "WAITING_PORT_RELEASE",
  "CONTAINER_PICKED_UP", "IN_TRANSIT_TO_DELIVERY", "DELIVERED",
  "EMPTY_RETURN_PENDING", "EMPTY_RETURNED",
]);
const QUOTING = new Set(["SENT", "VIEWED", "AWAITING_QUOTE"]);
const NEEDS_ACTION = new Set(["SENT", "VIEWED", "AWAITING_RECONFIRMATION", "OFFERED"]);
const WAITING = new Set(["AWAITING_QUOTE", "QUOTED", "REVIEW_PENDING", "DOCUMENTS_SUBMITTED"]);

export function categoryOf(task: FleetTask): Exclude<Category, "all"> {
  const status = statusOf(task);
  if (task.open_exception_count > 0) return "exception";
  if (DONE.has(status)) return "done";
  if (SHIPPING.has(status)) return "shipping";
  if (NEEDS_ACTION.has(status)) return "needs_action";
  if (WAITING.has(status)) return "waiting";
  if (QUOTING.has(status)) return "needs_action";
  return "waiting";
}

/**
 * The single most useful line on a task row: what this task now needs from the
 * dispatcher. With many similar routes on screen, "what do I do next" separates
 * tasks far better than a status badge does.
 */
export function nextAction(task: FleetTask): string {
  const status = statusOf(task);
  if (task.open_exception_count > 0) return "有异常事项待处理";
  switch (status) {
    case "SENT":
    case "VIEWED":
      return "需要你回价格";
    case "AWAITING_QUOTE":
      return "你说稍后报价";
    case "AWAITING_RECONFIRMATION":
      return "条件已变，需要你确认价格";
    case "QUOTED":
      return "已报价，等运营选择";
    case "OFFERED":
      return "需要你接单";
    case "ACCEPTED":
    case "WAITING_EMPTY_CONTAINER_RELEASE":
    case "WAITING_PORT_RELEASE":
      return "按计划开始整票运输";
    case "EMPTY_CONTAINER_PICKED_UP":
    case "AT_LOADING_LOCATION":
    case "LOADED":
    case "EN_ROUTE_TO_TERMINAL":
    case "CONTAINER_PICKED_UP":
    case "IN_TRANSIT_TO_DELIVERY":
    case "EMPTY_RETURN_PENDING":
      return "全部箱达到下一节点后更新状态";
    case "LADEN_CONTAINERS_RETURNED_TO_TERMINAL":
      return "上传提空箱及还重箱证明";
    case "DELIVERED":
      return "卸货后归还全部空箱";
    case "EMPTY_RETURNED":
      return "上传 POD 及还空箱证明";
    case "REVIEW_PENDING":
    case "DOCUMENTS_SUBMITTED":
      return "等待运营审核文件";
    case "COMPLETED":
      return "已结束";
    case "CANCELLED":
      return "已取消";
    case "DECLINED":
      return "你已拒绝这单";
    default:
      return "等待更新";
  }
}

const dateLabel = (iso: string) =>
  new Date(iso).toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "short" });
const timeLabel = (iso: string) =>
  new Date(iso).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });

/** Pickup deadline, phrased relative to now so urgency is obvious at a glance. */
export function deadlineLabel(iso: string | null, now = Date.now()): { text: string; urgent: boolean } {
  if (!iso) return { text: "提货时间待定", urgent: false };
  const at = new Date(iso).getTime();
  const hours = (at - now) / 3_600_000;
  const clock = `${new Date(iso).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" })} ${timeLabel(iso)}`;
  if (hours < 0) return { text: `提货时间已过 · ${clock}`, urgent: true };
  if (hours < 24) return { text: `${Math.max(1, Math.round(hours))} 小时后提货 · ${clock}`, urgent: true };
  return { text: `${Math.round(hours / 24)} 天后提货 · ${clock}`, urgent: false };
}

/** A message the dispatcher tried to send; retryable without creating duplicates. */
interface Outgoing {
  clientMessageId: string;
  text: string;
  state: "sending" | "failed";
  createdAt: string;
}

function MessageBubble({
  message,
}: {
  message: ChatMessage;
}) {
  const mine = message.direction === "INBOUND";
  const system = ["SYSTEM_NOTICE", "HANDOFF_NOTICE"].includes(message.message_type);
  if (system) {
    return (
      <div className={`system-message${message.message_type === "HANDOFF_NOTICE" ? " handoff" : ""}`}>
        <span>{message.text_content}</span>
      </div>
    );
  }
  const structured = message.structured_content as { kind?: string } | null;
  return (
    <article className={`chat-message ${mine ? "from-fleet" : "from-mercury"}`}>
      {!mine ? (
        <div className="message-sender">
          {message.sender_type === "OPERATOR" ? "Mercury 运营" : "Mercury 助手"}
        </div>
      ) : null}
      {structured && structured.kind ? (
        <>
          <StructuredCard data={structured as never} />
          {message.text_content ? <div className="message-bubble numbered-choice-text">{message.text_content}</div> : null}
        </>
      ) : (
        <div className="message-bubble">{message.text_content}</div>
      )}
      <time dateTime={message.created_at}>{timeLabel(message.created_at)}</time>
    </article>
  );
}

/** A queued or failed message rendered in place, with its own retry control. */
function OutgoingBubble({
  item,
  onRetry,
  onDiscard,
}: {
  item: Outgoing;
  onRetry: () => void;
  onDiscard: () => void;
}) {
  return (
    <article className={`chat-message from-fleet ${item.state === "failed" ? "is-failed" : "is-sending"}`}>
      <div className="message-bubble">{item.text}</div>
      {item.state === "sending" ? (
        <time>发送中…</time>
      ) : (
        <div className="send-failed" role="status">
          <span>没能发出去</span>
          <button type="button" className="text-button" onClick={onRetry}>重试</button>
          <button type="button" className="text-button" onClick={onDiscard}>删除</button>
        </div>
      )}
    </article>
  );
}

function TaskRow({
  task,
  selected,
  unread,
  onSelect,
}: {
  task: FleetTask;
  selected: boolean;
  unread: boolean;
  onSelect: () => void;
}) {
  const status = statusOf(task);
  const deadline = deadlineLabel(task.pickup_at);
  return (
    <button
      type="button"
      className={`conversation-item${selected ? " selected" : ""}${unread ? " is-unread" : ""}`}
      aria-current={selected ? "true" : undefined}
      onClick={onSelect}
    >
      <span className="conversation-title">
        <strong>{task.booking_reference ?? task.rfq_reference}</strong>
        <time>{task.last_message_at ? timeLabel(task.last_message_at) : ""}</time>
      </span>
      <span className="conversation-route">
        {task.pickup_location_text} → {task.delivery_location_text}
      </span>
      <span className="conversation-deadline">
        {task.order_type === "EXPORT_DRAYAGE" ? "送港" : "提港"} · {task.service_country} ·
        {" "}{task.container_type} × {task.container_quantity}
      </span>
      <span className={`conversation-deadline${deadline.urgent ? " urgent" : ""}`}>
        {deadline.urgent ? <b aria-hidden="true">!</b> : null}
        {deadline.text}
      </span>
      <span className="conversation-next">{nextAction(task)}</span>
      <span className="conversation-meta">
        <span className="status-dot" title={status}>{statusText(status)}</span>
        {task.open_exception_count > 0 ? (
          <b className="exception-flag">异常 {task.open_exception_count}</b>
        ) : null}
        {unread ? <i className="unread-dot" aria-label="有新消息" /> : null}
      </span>
    </button>
  );
}

export function Chat({
  session,
  onLogout,
}: {
  session: SessionUser;
  onLogout: () => Promise<void>;
}) {
  const [tasks, setTasks] = useState<FleetTask[]>([]);
  // Selection is held as an id, never as a task object, so a refreshed list can
  // never resurrect a stale copy of the selected task.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // All per-task state is keyed by task id. This is what stops drafts and
  // messages leaking between tasks when the dispatcher switches quickly.
  const [messagesByTask, setMessagesByTask] = useState<Record<string, ChatMessage[]>>({});
  const [draftsByTask, setDraftsByTask] = useState<Record<string, string>>({});
  const [outgoingByTask, setOutgoingByTask] = useState<Record<string, Outgoing[]>>({});
  const [readAt, setReadAt] = useState<Record<string, number>>({});
  const [category, setCategory] = useState<Category>("all");
  const [query, setQuery] = useState("");
  const [connection, setConnection] = useState<"connecting" | "online" | "offline">("connecting");
  const [notice, setNotice] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [documentType, setDocumentType] = useState<string>("");

  const listRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // Monotonic request ids per task. A response is applied only if it is still
  // the newest request for that task, which prevents a slow reply for task A
  // from overwriting task B's messages.
  const reqSeq = useRef<Record<string, number>>({});
  const selectedIdRef = useRef<string | null>(null);
  selectedIdRef.current = selectedId;

  const canMutate = session.role !== "VIEWER";
  const selected = useMemo(
    () => tasks.find((t) => t.rfq_recipient_id === selectedId) ?? null,
    [tasks, selectedId],
  );

  const refreshTasks = useCallback(async () => {
    try {
      const result = await api.tasks();
      setTasks(result.tasks);
      setSelectedId((current) => {
        if (current && result.tasks.some((t) => t.rfq_recipient_id === current)) return current;
        const firstOpen = result.tasks.find((t) => categoryOf(t) !== "done");
        return firstOpen?.rfq_recipient_id ?? result.tasks[0]?.rfq_recipient_id ?? null;
      });
    } catch {
      /* connection state is surfaced by the SSE handler */
    }
  }, []);

  const refreshMessages = useCallback(async (taskId: string) => {
    const seq = (reqSeq.current[taskId] ?? 0) + 1;
    reqSeq.current[taskId] = seq;
    try {
      const result = await api.taskMessages(taskId);
      // Discard a response that has been superseded by a newer request for the
      // same task, so a slow reply can never overwrite fresher messages.
      if (reqSeq.current[taskId] !== seq) return;
      setMessagesByTask((current) => ({ ...current, [taskId]: result.messages }));
    } catch {
      /* keep whatever was last shown for this task */
    }
  }, []);

  useEffect(() => {
    void refreshTasks();
  }, [refreshTasks]);

  useEffect(() => {
    if (selectedId) void refreshMessages(selectedId);
  }, [selectedId, refreshMessages]);

  // Mark the open task read whenever its messages change while it is on screen.
  useEffect(() => {
    if (selectedId) setReadAt((current) => ({ ...current, [selectedId]: Date.now() }));
  }, [selectedId, messagesByTask]);

  useEffect(() => {
    // The static demo build has no backend to open a real-time stream against;
    // updates already flow through the direct refreshTasks/refreshMessages
    // calls that follow every demo action, so just report "online" and skip.
    if (DEMO_MODE) {
      setConnection("online");
      return;
    }
    let stream: EventSource | null = null;
    let closed = false;
    let retry = 1000;
    const connect = () => {
      if (closed) return;
      stream = new EventSource("/api/fleet/conversation/stream");
      stream.addEventListener("hello", () => {
        setConnection("online");
        retry = 1000;
      });
      stream.addEventListener("update", () => {
        void refreshTasks();
        const open = selectedIdRef.current;
        if (open) void refreshMessages(open);
      });
      stream.onerror = () => {
        // One comprehensible offline state with backoff, rather than a stream of
        // visible errors when the server goes away.
        setConnection("offline");
        stream?.close();
        if (!closed) window.setTimeout(connect, (retry = Math.min(retry * 2, 15_000)));
      };
    };
    connect();
    return () => {
      closed = true;
      stream?.close();
    };
  }, [refreshMessages, refreshTasks]);

  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [messagesByTask, selectedId, outgoingByTask]);

  const setDraft = (taskId: string, value: string) =>
    setDraftsByTask((current) => ({ ...current, [taskId]: value }));

  const patchOutgoing = (taskId: string, fn: (list: Outgoing[]) => Outgoing[]) =>
    setOutgoingByTask((current) => ({ ...current, [taskId]: fn(current[taskId] ?? []) }));

  /** Send or retry one message. The clientMessageId is stable across retries. */
  const deliver = useCallback(
    async (taskId: string, item: Outgoing, replyTo: string | null) => {
      patchOutgoing(taskId, (list) =>
        list.map((o) => (o.clientMessageId === item.clientMessageId ? { ...o, state: "sending" as const } : o)),
      );
      try {
        await api.sendMessage(item.clientMessageId, item.text, replyTo);
        patchOutgoing(taskId, (list) => list.filter((o) => o.clientMessageId !== item.clientMessageId));
        void refreshTasks();
        void refreshMessages(taskId);
      } catch (error) {
        const e = error as { status?: number; body?: { error?: string; message?: string } };
        patchOutgoing(taskId, (list) =>
          list.map((o) => (o.clientMessageId === item.clientMessageId ? { ...o, state: "failed" as const } : o)),
        );
        if (e.status === 403) setNotice("你当前为只读账号，不能发送消息。");
        else if (e.status === 429) setNotice("发送太频繁了，请稍后再试。");
      }
    },
    [refreshMessages, refreshTasks],
  );

  const sendText = (value?: string) => {
    if (!selected || !canMutate) return;
    const taskId = selected.rfq_recipient_id;
    const text = (value ?? draftsByTask[taskId] ?? "").trim();
    if (!text) return;
    const item: Outgoing = {
      clientMessageId: uuid(),
      text,
      state: "sending",
      createdAt: new Date().toISOString(),
    };
    patchOutgoing(taskId, (list) => [...list, item]);
    if (value === undefined) setDraft(taskId, "");
    void deliver(taskId, item, selected.anchor_message_id);
  };

  const upload = async (file: File) => {
    if (!selected) return;
    const taskId = selected.rfq_recipient_id;
    try {
      await api.uploadDocument(file, uuid(), selected.shipment_id, documentType || null);
      setNotice(null);
      void refreshMessages(taskId);
    } catch (error) {
      const e = error as { body?: { error?: string } };
      setNotice(e.body?.error ?? "文件没有上传成功，请确认格式和大小后重试。");
    }
  };

  const counts = useMemo(() => {
    const base: Record<Category, number> = {
      all: tasks.length, needs_action: 0, waiting: 0, shipping: 0, exception: 0, done: 0,
    };
    for (const t of tasks) base[categoryOf(t)] += 1;
    return base;
  }, [tasks]);

  const isUnread = useCallback(
    (task: FleetTask) => {
      if (!task.last_message_at) return false;
      if (task.rfq_recipient_id === selectedId) return false;
      if (Number(task.unread_count ?? 0) > 0) return true;
      const seen = readAt[task.rfq_recipient_id];
      return !seen || new Date(task.last_message_at).getTime() > seen;
    },
    [readAt, selectedId],
  );

  const visibleTasks = useMemo(() => {
    const q = query.trim().toLowerCase();
    return tasks.filter((task) => {
      if (category !== "all" && categoryOf(task) !== category) return false;
      if (!q) return true;
      return `${task.order_reference} ${task.rfq_reference} ${task.booking_reference ?? ""} ${task.pickup_location_text} ${task.delivery_location_text}`
        .toLowerCase()
        .includes(q);
    });
  }, [tasks, category, query]);

  const openMessages = selectedId ? messagesByTask[selectedId] ?? null : null;
  const openOutgoing = selectedId ? outgoingByTask[selectedId] ?? [] : [];
  const taskTitle = selected?.booking_reference ?? selected?.rfq_reference ?? "任务对话";
  const deadline = selected ? deadlineLabel(selected.pickup_at) : null;
  let previousDay = "";

  return (
    <main className="fleet-app">
      <aside className={`fleet-sidebar${drawerOpen ? " drawer-open" : ""}`} aria-label="任务列表">
        <header className="sidebar-header">
          <MercuryBrand compact />
          <button
            type="button"
            className="icon-button mobile-only"
            aria-label="关闭任务列表"
            onClick={() => setDrawerOpen(false)}
          >
            ×
          </button>
        </header>

        <div className="task-search">
          <button className="button button-full" type="button" onClick={() => setProfileOpen(true)}>
            车队档案
          </button>
          <input
            value={query}
            placeholder="搜索编号、路线"
            aria-label="搜索任务"
            onChange={(event) => setQuery(event.target.value)}
          />
          {query ? (
            <button type="button" className="text-button" onClick={() => setQuery("")}>清空</button>
          ) : null}
        </div>

        <div className="category-tabs" role="tablist" aria-label="任务分类">
          {(["all", "needs_action", "waiting", "shipping", "exception", "done"] as Category[]).map((key) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={category === key}
              className={`category-tab${category === key ? " active" : ""}${key === "exception" && counts.exception > 0 ? " has-exception" : ""}`}
              onClick={() => setCategory(key)}
            >
              {CATEGORY_LABEL[key]}
              <span>{counts[key]}</span>
            </button>
          ))}
        </div>

        <div className="task-groups">
          {visibleTasks.map((task) => (
            <TaskRow
              key={task.rfq_recipient_id}
              task={task}
              selected={task.rfq_recipient_id === selectedId}
              unread={isUnread(task)}
              onSelect={() => {
                setSelectedId(task.rfq_recipient_id);
                setDrawerOpen(false);
              }}
            />
          ))}
          {!visibleTasks.length ? (
            <div className="sidebar-empty">
              {tasks.length
                ? `「${CATEGORY_LABEL[category]}」里暂时没有任务`
                : "还没有任务。运营发出询价后会出现在这里。"}
            </div>
          ) : null}
        </div>

        <footer className="sidebar-account">
          <span className="account-avatar" aria-hidden="true">
            {session.user.displayName.slice(0, 1).toUpperCase()}
          </span>
          <span className="account-copy">
            <strong>{session.user.displayName}</strong>
            <small>{session.organization.name}{session.role === "VIEWER" ? " · 仅可查看" : ""}</small>
          </span>
          <button type="button" className="text-button" onClick={() => void onLogout()}>退出</button>
        </footer>
      </aside>

      {profileOpen ? (
        <FleetProfilePanel
          organizationName={session.organization.name}
          onBack={() => setProfileOpen(false)}
        />
      ) : <section className="conversation-pane">
        <header className="conversation-header">
          <button
            type="button"
            className="icon-button mobile-only"
            aria-label="打开任务列表"
            onClick={() => setDrawerOpen(true)}
          >
            ☰
          </button>
          <div className="conversation-heading">
            <h1>{taskTitle}</h1>
            {selected ? (
              <p>
                {selected.order_type === "EXPORT_DRAYAGE" ? "送港" : "提港"} ·
                {" "}{selected.service_country} · {selected.pickup_location_text} → {selected.delivery_location_text}
              </p>
            ) : (
              <p>选择左侧任务查看消息</p>
            )}
          </div>
          {selected ? (
            <div className="conversation-status">
              <span className="status-dot" title={statusOf(selected)}>
                {statusText(statusOf(selected))}
              </span>
              {deadline ? (
                <span className={`header-deadline${deadline.urgent ? " urgent" : ""}`}>{deadline.text}</span>
              ) : null}
              {selected.amount ? <strong>{selected.currency} {selected.amount}</strong> : null}
            </div>
          ) : null}
        </header>

        {/* Read-only role is stated before any action is attempted. */}
        {!canMutate ? (
          <div className="role-banner" role="note">
            你当前为只读账号，可以查看任务，但不能提交报价或更新状态。
          </div>
        ) : null}
        {selected?.shipment_id ? (
          <div className="role-banner" role="note">
            当前状态适用于本订单全部 {selected.container_quantity} 个集装箱。如只完成部分箱，请联系运营，不要更新整票状态。
          </div>
        ) : null}

        {connection === "offline" ? (
          <div className="connection-banner" role="status">
            连接已断开，正在重新连接。这段时间的消息可能会延迟。
          </div>
        ) : null}

        {notice ? (
          <div className="inline-notice" role="alert">
            <span>{notice}</span>
            <button type="button" className="text-button" onClick={() => setNotice(null)}>知道了</button>
          </div>
        ) : null}

        <div className="message-list" ref={listRef}>
          {!selected ? (
            <div className="conversation-empty">
              <img src={asset("/brand/mercury-mark-256.png")} alt="" width={48} height={48} />
              <h2>选择一个任务</h2>
              <p>每个任务都有独立的消息记录。</p>
            </div>
          ) : null}
          {selected && openMessages === null ? (
            <div className="message-loading">正在加载消息…</div>
          ) : null}
          {selected && openMessages !== null && openMessages.length === 0 ? (
            <div className="conversation-empty">
              <h2>还没有消息</h2>
              <p>这个任务的新消息会出现在这里。</p>
            </div>
          ) : null}
          {(openMessages ?? []).map((message) => {
            const day = dateLabel(message.created_at);
            const divider = day !== previousDay;
            previousDay = day;
            return (
              <div key={message.id}>
                {divider ? <div className="date-divider"><span>{day}</span></div> : null}
                <MessageBubble
                  message={message}
                />
              </div>
            );
          })}
          {openOutgoing.map((item) => (
            <OutgoingBubble
              key={item.clientMessageId}
              item={item}
              onRetry={() => {
                if (selected) void deliver(selected.rfq_recipient_id, item, selected.anchor_message_id);
              }}
              onDiscard={() => {
                if (selected) {
                  patchOutgoing(selected.rfq_recipient_id, (list) =>
                    list.filter((o) => o.clientMessageId !== item.clientMessageId),
                  );
                }
              }}
            />
          ))}
        </div>

        <footer className="conversation-composer">
          {selected && canMutate ? (
            <div className="composer-shortcuts">
              <button type="button" onClick={() => sendText("联系运营")}>联系运营</button>
              {selected.shipment_id ? (
                <>
                  <select
                    aria-label="文件类型"
                    value={documentType}
                    onChange={(event) => setDocumentType(event.target.value)}
                  >
                    <option value="">自动判断文件类型</option>
                    {selected.order_type === "EXPORT_DRAYAGE" ? (
                      <>
                        <option value="EMPTY_CONTAINER_RELEASE">提空箱证明</option>
                        <option value="TERMINAL_HANDOVER">还重箱证明</option>
                      </>
                    ) : (
                      <>
                        <option value="POD">送货签收证明（POD）</option>
                        <option value="EMPTY_CONTAINER_RETURN">还空箱证明</option>
                      </>
                    )}
                  </select>
                  <button type="button" onClick={() => fileRef.current?.click()}>上传运输文件</button>
                </>
              ) : null}
            </div>
          ) : null}

          {/* The recipient is always visible, so a reply cannot go to the wrong task. */}
          {selected ? (
            <div className="composer-target">
              正在回复：<strong>{taskTitle}</strong>
              <span> · {selected.pickup_location_text} → {selected.delivery_location_text}</span>
            </div>
          ) : null}

          <div className="composer-box">
            <button
              type="button"
              className="composer-attach"
              aria-label="上传文件"
              disabled={!canMutate || !selected}
              onClick={() => fileRef.current?.click()}
            >
              ＋
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/heic,application/pdf"
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void upload(file);
                event.target.value = "";
              }}
            />
            <textarea
              value={selectedId ? draftsByTask[selectedId] ?? "" : ""}
              rows={1}
              disabled={!canMutate || !selected}
              aria-label="消息内容"
              placeholder={
                !selected
                  ? "请先选择任务"
                  : canMutate
                    ? "直接输入价格或说明，例如：220全包"
                    : "只读账号不能发送消息"
              }
              onChange={(event) => {
                if (selectedId) setDraft(selectedId, event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  sendText();
                }
              }}
            />
            <button
              type="button"
              className="composer-send"
              aria-label="发送"
              disabled={
                !canMutate || !selected || !(selectedId && (draftsByTask[selectedId] ?? "").trim())
              }
              onClick={() => sendText()}
            >
              发送
            </button>
          </div>

          <span className={`connection-state ${connection}`}>
            {connection === "online"
              ? "实时连接正常"
              : connection === "connecting"
                ? "正在连接…"
                : "连接已断开，正在重新连接"}
          </span>
        </footer>
      </section>}

      {drawerOpen ? (
        <button
          type="button"
          className="mobile-sidebar-backdrop"
          aria-label="关闭任务列表"
          onClick={() => setDrawerOpen(false)}
        />
      ) : null}
    </main>
  );
}
