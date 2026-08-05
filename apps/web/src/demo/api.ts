import { getFleetStore, getOperatorStore, newId, nowIso } from "./store";

/**
 * Demo-mode implementation of the `api` object in ../api.ts, used for the
 * GitHub Pages static build (no backend). Matches the real api's method
 * signatures exactly so components never need to know which one is active.
 *
 * Data comes from fixtures.json (real captured backend responses — see
 * scripts/build-demo-fixtures.ts). GET-shaped calls just read the in-memory
 * store; mutations apply a best-effort, simplified update to that same store
 * so the UI reacts, but nothing is persisted past a page reload and nothing
 * is sent anywhere.
 */

let fleetSession: { username: string } | null = null;
let operatorSession: boolean = false;
let demoNoticeShownForTask = new Set<string>();

const delay = <T>(value: T, ms = 220): Promise<T> =>
  new Promise((resolve) => setTimeout(() => resolve(value), ms));

const unauthorized = () => Object.assign(new Error("未登录"), { status: 401, body: { error: "未登录" } });

function findTaskIdForMessage(messagesByTask: Record<string, any[]>, messageId: string | null | undefined) {
  if (!messageId) return null;
  for (const [taskId, list] of Object.entries(messagesByTask)) {
    if ((list as any[]).some((m) => m.id === messageId)) return taskId;
  }
  return null;
}

export const demoApi = {
  login: async (portal: "fleet" | "operator", username: string) => {
    if (portal === "operator") {
      operatorSession = true;
      return delay(getOperatorStore().session);
    }
    const { username: resolved, data } = getFleetStore(username);
    fleetSession = { username: resolved };
    return delay(data.session);
  },
  logout: async (portal: "fleet" | "operator") => {
    if (portal === "operator") operatorSession = false;
    else fleetSession = null;
    return delay({});
  },
  session: async (portal: "fleet" | "operator") => {
    if (portal === "operator") {
      if (!operatorSession) throw unauthorized();
      return delay(getOperatorStore().session);
    }
    if (!fleetSession) throw unauthorized();
    return delay(getFleetStore(fleetSession.username).data.session);
  },
  conversation: async () => delay({ conversationId: "demo-conversation" }),
  messages: async () => {
    const { data } = getFleetStore(fleetSession?.username ?? "fleet1");
    const all = Object.values(data.messagesByTask as Record<string, any[]>).flat();
    return delay({ conversationId: "demo-conversation", messages: all });
  },
  taskMessages: async (rfqRecipientId: string) => {
    const { data } = getFleetStore(fleetSession?.username ?? "fleet1");
    return delay({
      conversationId: "demo-conversation",
      taskId: rfqRecipientId,
      messages: data.messagesByTask[rfqRecipientId] ?? [],
    });
  },
  tasks: async () => {
    const { data } = getFleetStore(fleetSession?.username ?? "fleet1");
    return delay({ tasks: data.tasks });
  },
  fleetProfile: async () => {
    const { data } = getFleetStore(fleetSession?.username ?? "fleet1");
    return delay(data.profile);
  },
  submitFleetProfile: async (payload: Record<string, unknown>) => {
    const { data } = getFleetStore(fleetSession?.username ?? "fleet1");
    const approvedVersion = data.profile.profile?.approved?.version ?? 1;
    data.profile.profile.pending = {
      id: newId(),
      version: approvedVersion + 1,
      status: "PENDING_REVIEW",
      fleet_name: payload.fleetName,
      supports_hazardous: payload.supportsHazardous,
      supports_reefer: payload.supportsReefer,
      contact_name: payload.contactName,
      contact_phone: payload.contactPhone,
      notes: payload.notes ?? null,
      operating_countries: payload.operatingCountries ?? ["SG"],
      submitted_at: nowIso(),
    };
    return delay({ ok: true });
  },
  setAcceptingOrders: async (acceptingOrders: boolean) => {
    const { data } = getFleetStore(fleetSession?.username ?? "fleet1");
    data.profile.profile.accepting_orders = acceptingOrders;
    return delay({ ok: true });
  },
  sendMessage: async (clientMessageId: string, text: string, replyToMessageId?: string | null) => {
    const { data } = getFleetStore(fleetSession?.username ?? "fleet1");
    const taskId =
      findTaskIdForMessage(data.messagesByTask, replyToMessageId) ??
      Object.keys(data.messagesByTask)[0];
    if (!taskId) return delay({ messageId: clientMessageId, duplicate: false });
    const list: any[] = data.messagesByTask[taskId] ?? (data.messagesByTask[taskId] = []);
    const messageId = newId();
    list.push({
      id: messageId,
      direction: "INBOUND",
      sender_type: "FLEET",
      message_type: "TEXT",
      text_content: text,
      structured_content: null,
      reply_to_message_id: replyToMessageId ?? null,
      created_at: nowIso(),
      external_message_id: null,
      actions: [],
    });
    if (!demoNoticeShownForTask.has(taskId)) {
      demoNoticeShownForTask.add(taskId);
      list.push({
        id: newId(),
        direction: "OUTBOUND",
        sender_type: "SYSTEM",
        message_type: "SYSTEM_NOTICE",
        text_content: "（演示环境）这是示例数据，你的消息已显示在对话中，但不会触发真实的业务流程。",
        structured_content: null,
        reply_to_message_id: messageId,
        created_at: nowIso(),
        external_message_id: null,
        actions: [],
      });
    }
    return delay({ messageId, duplicate: false });
  },
  consumeAction: async (actionId: string) => {
    const { data } = getFleetStore(fleetSession?.username ?? "fleet1");
    for (const list of Object.values(data.messagesByTask as Record<string, any[]>)) {
      const action = (list as any[]).flatMap((m) => m.actions).find((a: any) => a.id === actionId);
      if (action) {
        action.status = "CONSUMED";
        break;
      }
    }
    return delay({ ok: true, result: { outcome: "演示模式：已在界面上标记为已选择" } });
  },
  uploadDocument: async (
    file: File,
    _clientMessageId: string,
    _shipmentId?: string | null,
    documentType?: string | null,
  ) => {
    const { data } = getFleetStore(fleetSession?.username ?? "fleet1");
    const taskId = Object.keys(data.messagesByTask)[0];
    if (taskId) {
      const list: any[] = data.messagesByTask[taskId];
      list.push({
        id: newId(),
        direction: "INBOUND",
        sender_type: "FLEET",
        message_type: "DOCUMENT",
        text_content: `${documentType ?? "文件"}: ${file.name}`,
        structured_content: null,
        reply_to_message_id: null,
        created_at: nowIso(),
        external_message_id: null,
        actions: [],
      });
    }
    return delay({ ok: true });
  },
  operator: {
    state: async () => {
      if (!operatorSession) throw unauthorized();
      return delay(getOperatorStore().state);
    },
    audit: async () => {
      if (!operatorSession) throw unauthorized();
      return delay(getOperatorStore().audit);
    },
    createOrder: async (payload: Record<string, unknown>) => {
      const store = getOperatorStore();
      const template = store.state.orders[0] ?? {};
      const order = {
        ...template,
        id: newId(),
        public_reference: (payload.publicReference as string) || `M-DEMO-${Math.floor(1000 + Math.random() * 8999)}`,
        customer_reference: payload.customerReference ?? null,
        status: "DRAFT",
        order_type: payload.orderType,
        service_country: payload.serviceCountry,
        container_type: payload.containerType,
        container_quantity: payload.containerQuantity,
        pickup_location_text:
          (payload.destinationTerminal as string) || (payload.loadingLocation as string) || template.pickup_location_text,
        delivery_location_text:
          (payload.deliveryLocation as string) || (payload.originTerminal as string) || template.delivery_location_text,
        pickup_at: payload.requestedStartAt ?? template.pickup_at,
        requested_start_at: payload.requestedStartAt ?? template.requested_start_at,
        requested_complete_at: payload.requestedCompleteAt ?? null,
        special_requirements: payload.specialRequirements ?? null,
        is_hazardous: payload.isHazardous ?? false,
        is_reefer: payload.isReefer ?? false,
        created_at: nowIso(),
        updated_at: nowIso(),
      };
      store.state.orders = [order, ...store.state.orders];
      const candidates = (store.state.fleets as any[]).map((f) => ({
        id: f.id,
        name: f.name,
        eligible: !(payload.isReefer || payload.isHazardous),
        reasons: payload.isReefer || payload.isHazardous ? ["演示环境：候选匹配已简化"] : [],
      }));
      return delay({ order, dispatchedFleetCount: 0, candidates });
    },
    sendRfq: async (orderId: string, fleetOrganizationIds?: string[]) => {
      const store = getOperatorStore();
      const order = (store.state.orders as any[]).find((o) => o.id === orderId);
      if (order) order.status = "QUOTING";
      const ids = fleetOrganizationIds ?? (store.state.fleets as any[]).map((f) => f.id);
      const recipients = ids.map((id) => {
        const fleet = (store.state.fleets as any[]).find((f) => f.id === id);
        return { id, name: fleet?.name ?? "Fleet" };
      });
      return delay({
        targeting: fleetOrganizationIds ? "EXPLICIT" : "MATCHED_FLEETS",
        intendedRecipients: recipients,
        deliveredTo: recipients,
        failedFor: [],
      });
    },
    candidates: async (orderId: string) => {
      const store = getOperatorStore();
      if (orderId === store.order4Id) return delay({ candidates: store.order4Candidates });
      return delay({
        candidates: (store.state.fleets as any[]).map((f) => ({ id: f.id, name: f.name, eligible: true, reasons: [] })),
      });
    },
    pendingProfiles: async () => delay(getOperatorStore().pendingProfiles),
    reviewProfile: async (versionId: string) => {
      const store = getOperatorStore();
      store.pendingProfiles.profiles = (store.pendingProfiles.profiles as any[]).filter((p) => p.id !== versionId);
      return delay({ ok: true });
    },
    setFleetStatus: async () => delay({ ok: true }),
    shipmentDocuments: async () => delay({ documents: [] }),
    reviewShipmentDocuments: async (shipmentId: string, approved: boolean) => {
      const store = getOperatorStore();
      const shipment = (store.state.shipments as any[]).find((s) => s.id === shipmentId);
      if (shipment && approved) shipment.current_status = "COMPLETED";
      return delay({ ok: true });
    },
    patchOrder: async (orderId: string, changes: Record<string, unknown>) => {
      const store = getOperatorStore();
      const order = (store.state.orders as any[]).find((o) => o.id === orderId);
      if (order) Object.assign(order, changes, { updated_at: nowIso() });
      return delay({ ok: true });
    },
    selectQuote: async (quoteId: string) => {
      const store = getOperatorStore();
      const quote = (store.state.quotes as any[]).find((q) => q.id === quoteId);
      if (quote) quote.status = "ACCEPTED";
      return delay({ ok: true });
    },
    cancelBooking: async (bookingId: string) => {
      const store = getOperatorStore();
      const booking = (store.state.bookings as any[]).find((b) => b.id === bookingId);
      if (booking) booking.status = "CANCELLED";
      return delay({ ok: true });
    },
    cancelOrder: async (orderId: string) => {
      const store = getOperatorStore();
      const order = (store.state.orders as any[]).find((o) => o.id === orderId);
      if (order) order.status = "CANCELLED";
      return delay({ ok: true });
    },
    deleteOrder: async (orderId: string) => {
      const store = getOperatorStore();
      store.state.orders = (store.state.orders as any[]).filter((o) => o.id !== orderId);
      return delay({ ok: true });
    },
    rebroadcastOrder: async () => delay({ ok: true }),
    replyException: async () => delay({ ok: true }),
    updateException: async (exceptionId: string, status: string) => {
      const store = getOperatorStore();
      const exception = (store.state.exceptions as any[]).find((e) => e.id === exceptionId);
      if (exception) exception.status = status;
      return delay({ ok: true });
    },
  },
};
