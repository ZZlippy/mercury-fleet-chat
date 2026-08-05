import { demoApi } from "./demo/api";

export interface SessionUser {
  user: { id: string; username: string; email: string | null; displayName: string };
  organization: { id: string; name: string; type: string };
  role: "FLEET_ADMIN" | "DISPATCHER" | "VIEWER" | "OPERATOR";
}

export interface MessageAction {
  id: string;
  actionType: string;
  label: string;
  status: "AVAILABLE" | "CONSUMED" | "EXPIRED" | "INVALIDATED";
}

export interface ChatMessage {
  id: string;
  direction: "INBOUND" | "OUTBOUND";
  sender_type: string;
  message_type: string;
  text_content: string | null;
  structured_content: Record<string, unknown> | null;
  reply_to_message_id: string | null;
  created_at: string;
  external_message_id: string | null;
  actions: MessageAction[];
  optimistic?: boolean;
}

export interface FleetTask {
  order_id: string;
  order_reference: string;
  order_status: string;
  pickup_location_text: string;
  delivery_location_text: string;
  pickup_at: string;
  order_type: "EXPORT_DRAYAGE" | "IMPORT_DRAYAGE";
  service_country: string;
  container_type: string;
  container_quantity: number;
  requested_start_at: string;
  requested_complete_at: string | null;
  rfq_id: string;
  rfq_reference: string;
  rfq_revision: number;
  rfq_recipient_id: string;
  recipient_status: string;
  quote_id: string | null;
  quote_status: string | null;
  amount: string | null;
  currency: string | null;
  booking_id: string | null;
  booking_reference: string | null;
  booking_status: string | null;
  shipment_id: string | null;
  shipment_status: string | null;
  anchor_message_id: string | null;
  last_message_text: string | null;
  last_message_at: string | null;
  open_exception_count: number;
  unread_count: number;
}

export interface FleetProfileView {
  accepting_orders?: boolean;
  approved?: Record<string, any> | null;
  pending?: Record<string, any> | null;
  latest_rejected?: Record<string, any> | null;
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: init?.body instanceof FormData ? undefined : { "content-type": "application/json" },
    ...init,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = (body && (body.error || body.message)) || `HTTP ${res.status}`;
    throw Object.assign(new Error(String(message)), { status: res.status, body });
  }
  return body as T;
}

/**
 * DEMO_MODE is true only for the GitHub Pages static build (see
 * package.json's build:demo script). It replaces every network call below
 * with an in-memory simulation backed by fixtures captured from a real,
 * fully working instance of this app — see apps/web/src/demo/README.md.
 */
export const DEMO_MODE = import.meta.env.VITE_DEMO_MODE === "true";

const realApi = {
  login: (portal: "fleet" | "operator", username: string, password: string) =>
    req<SessionUser>(`/api/auth/${portal}/login`, { method: "POST", body: JSON.stringify({ username, password }) }),
  logout: (portal: "fleet" | "operator") => req(`/api/auth/${portal}/logout`, { method: "POST" }),
  session: (portal: "fleet" | "operator") => req<SessionUser>(`/api/auth/${portal}/session`),
  conversation: () => req<{ conversationId: string }>("/api/fleet/conversation"),
  messages: (before?: string) =>
    req<{ conversationId: string; messages: ChatMessage[] }>(
      `/api/fleet/conversation/messages${before ? `?before=${before}` : ""}`,
    ),
  taskMessages: (rfqRecipientId: string) =>
    req<{ conversationId: string; taskId: string; messages: ChatMessage[] }>(
      `/api/fleet/tasks/${rfqRecipientId}/messages`,
    ),
  tasks: () => req<{ tasks: FleetTask[] }>("/api/fleet/tasks"),
  fleetProfile: () => req<{ profile: FleetProfileView | null }>("/api/fleet/profile"),
  submitFleetProfile: (payload: Record<string, unknown>) =>
    req("/api/fleet/profile", { method: "POST", body: JSON.stringify(payload) }),
  setAcceptingOrders: (acceptingOrders: boolean) =>
    req("/api/fleet/profile/accepting-orders", {
      method: "PATCH",
      body: JSON.stringify({ acceptingOrders }),
    }),
  /** clientMessageId is generated once per send and reused on retry (§16.2). */
  sendMessage: (clientMessageId: string, text: string, replyToMessageId?: string | null) =>
    req<{ messageId: string; duplicate: boolean }>("/api/fleet/conversation/messages", {
      method: "POST",
      body: JSON.stringify({ clientMessageId, text, replyToMessageId: replyToMessageId ?? null }),
    }),
  consumeAction: (actionId: string, idempotencyKey: string) =>
    req<{ ok: boolean; result?: { outcome: string; message?: string } }>(
      `/api/fleet/conversation/actions/${actionId}/consume`,
      { method: "POST", body: JSON.stringify({ idempotencyKey }) },
    ),
  uploadDocument: (
    file: File,
    clientMessageId: string,
    shipmentId?: string | null,
    documentType?: string | null,
  ) => {
    const fd = new FormData();
    fd.append("clientMessageId", clientMessageId);
    if (shipmentId) fd.append("shipmentId", shipmentId);
    if (documentType) fd.append("documentType", documentType);
    fd.append("file", file);
    return req("/api/fleet/conversation/attachments", { method: "POST", body: fd });
  },
  operator: {
    state: () => req<Record<string, any[]>>("/api/operator/state"),
    audit: () => req<{ audit: any[] }>("/api/operator/audit"),
    createOrder: (payload: Record<string, unknown>) =>
      req<{
        order: any;
        dispatchedFleetCount: number;
        candidates: Array<{ id: string; name: string; eligible: boolean; reasons: string[] }>;
      }>("/api/operator/orders", { method: "POST", body: JSON.stringify(payload) }),
    /** Omit fleetOrganizationIds to broadcast to every eligible enabled fleet. */
    sendRfq: (orderId: string, fleetOrganizationIds?: string[]) =>
      req<{
        targeting: "EXPLICIT" | "MATCHED_FLEETS";
        intendedRecipients: { id: string; name: string }[];
        deliveredTo: { id: string; name: string }[];
        failedFor: { id: string; name: string }[];
      }>(`/api/operator/orders/${orderId}/send-rfq`, {
        method: "POST",
        body: JSON.stringify(fleetOrganizationIds ? { fleetOrganizationIds } : {}),
      }),
    candidates: (orderId: string) =>
      req<{ candidates: Array<{ id: string; name: string; eligible: boolean; reasons: string[] }> }>(
        `/api/operator/orders/${orderId}/candidates`,
      ),
    pendingProfiles: () => req<{ profiles: any[]; fleets: any[] }>("/api/operator/fleet-profiles/pending"),
    reviewProfile: (versionId: string, approved: boolean, note?: string | null) =>
      req(`/api/operator/fleet-profiles/${versionId}/review`, {
        method: "POST",
        body: JSON.stringify({ approved, note: note ?? null }),
      }),
    setFleetStatus: (fleetId: string, status: "ACTIVE" | "SUSPENDED") =>
      req(`/api/operator/fleets/${fleetId}/status`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      }),
    shipmentDocuments: (shipmentId: string) =>
      req<{ documents: any[] }>(`/api/operator/shipments/${shipmentId}/documents`),
    reviewShipmentDocuments: (shipmentId: string, approved: boolean, note?: string | null) =>
      req(`/api/operator/shipments/${shipmentId}/documents/review`, {
        method: "POST",
        body: JSON.stringify({ approved, note: note ?? null }),
      }),
    patchOrder: (orderId: string, changes: Record<string, unknown>) =>
      req(`/api/operator/orders/${orderId}/fleet-visible-fields`, { method: "PATCH", body: JSON.stringify(changes) }),
    selectQuote: (quoteId: string) => req(`/api/operator/quotes/${quoteId}/select`, { method: "POST", body: "{}" }),
    cancelBooking: (bookingId: string) => req(`/api/operator/bookings/${bookingId}/cancel`, { method: "POST", body: "{}" }),
    cancelOrder: (orderId: string, reason = "Cancelled in operator workspace") =>
      req(`/api/operator/orders/${orderId}/cancel`, { method: "POST", body: JSON.stringify({ reason }) }),
    deleteOrder: (orderId: string) => req(`/api/operator/orders/${orderId}`, { method: "DELETE" }),
    rebroadcastOrder: (orderId: string) =>
      req(`/api/operator/orders/${orderId}/rebroadcast`, { method: "POST", body: "{}" }),
    replyException: (exceptionId: string, text: string) =>
      req(`/api/operator/exceptions/${exceptionId}/reply`, { method: "POST", body: JSON.stringify({ text }) }),
    updateException: (exceptionId: string, status: "OPEN" | "IN_PROGRESS" | "RESOLVED" | "DISMISSED") =>
      req(`/api/operator/exceptions/${exceptionId}`, { method: "PATCH", body: JSON.stringify({ status }) }),
  },
};

// The demo module is only side-effect-free data + pure functions, so bundling
// it into the real (non-demo) build costs a little code size but no behavior
// change — it's never invoked unless DEMO_MODE is true. import.meta.env is
// statically replaced by Vite at build time, so the unused branch (and the
// fixtures.json it pulls in) is dropped entirely from the real production build.
// Cast to realApi's shape: demoApi's fixtures-derived types are loosely `any`
// internally, which would otherwise widen every call site's inference here.
export const api: typeof realApi = DEMO_MODE ? (demoApi as typeof realApi) : realApi;

export const uuid = (): string =>
  crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
