import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type SessionUser } from "../api";
import { asset, MercuryBrand } from "../App";

const LABELS: Record<string, string> = {
  DRAFT: "草稿",
  QUOTING: "询价中",
  BOOKED: "已选定车队",
  IN_PROGRESS: "运输中",
  COMPLETED: "已完成",
  CANCELLED: "已取消",
  PENDING: "待发送",
  SENT: "等待回复",
  VIEWED: "车队已查看",
  AWAITING_QUOTE: "稍后报价",
  AWAITING_RECONFIRMATION: "等待重新确认",
  QUOTED: "已报价",
  DECLINED: "已拒绝",
  WITHDRAWN: "已撤回",
  PENDING_CONFIRMATION: "车队确认中",
  SUBMITTED: "有效报价",
  INVALIDATED: "已失效",
  ACCEPTED: "已接受",
  REJECTED: "未中选",
  OFFERED: "等待接单",
  REVIEW_PENDING: "等待运营审核",
  WAITING_EMPTY_CONTAINER_RELEASE: "等待提取空箱",
  EMPTY_CONTAINER_PICKED_UP: "全部空箱已提取",
  AT_LOADING_LOCATION: "已到装货地点",
  LOADED: "全部集装箱已装货",
  EN_ROUTE_TO_TERMINAL: "前往码头",
  LADEN_CONTAINERS_RETURNED_TO_TERMINAL: "全部重箱已还至码头",
  WAITING_PORT_RELEASE: "等待码头放箱",
  CONTAINER_PICKED_UP: "全部重箱已提取",
  IN_TRANSIT_TO_DELIVERY: "前往送货地点",
  EMPTY_RETURN_PENDING: "等待归还空箱",
  EMPTY_RETURNED: "全部空箱已归还",
  DOCUMENTS_SUBMITTED: "文件已提交",
  WAITING_ASSIGNMENT: "等待司机车辆",
  DRIVER_ASSIGNED: "司机车辆已安排",
  EN_ROUTE_TO_PICKUP: "前往提货",
  AT_PICKUP: "已到提货点",
  PICKED_UP: "已提柜",
  IN_TRANSIT: "运输途中",
  AT_DELIVERY: "已到送达点",
  DELIVERED: "已送达",
  POD_SUBMITTED: "回单待审核",
  EXCEPTION: "异常处理中",
  CANCELLED_BY_FLEET: "车队取消",
  CANCELLED_BY_CUSTOMER: "客户取消",
  CANCELLED_BY_OPERATOR: "运营取消",
  OPEN: "待处理",
  RESOLVED: "已解决",
  DISMISSED: "已关闭",
};

const EXCEPTION_LABELS: Record<string, string> = {
  AMBIGUOUS_CONTEXT: "任务信息不明确",
  AMBIGUOUS_CURRENCY: "币种需要确认",
  LOW_CONFIDENCE: "消息需要人工判断",
  STALE_MESSAGE: "旧消息回复",
  NO_FLEET_RESPONSE: "没有可用车队",
  ORDER_CHANGED_AFTER_BOOKING: "接单后订单发生修改",
  FLEET_CANCELLED: "车队取消任务",
  INVALID_STATE_TRANSITION: "运输状态异常",
  POD_REVIEW_REQUIRED: "回单需要审核",
  DOCUMENT_REVIEW_REQUIRED: "运输文件需要审核",
  DELIVERY_FAILURE: "消息发送失败",
  OTHER: "车队联系运营",
};

const EVENT_LABELS: Record<string, string> = {
  "order.created": "创建订单并通知车队",
  "order.deleted_draft": "删除订单草稿",
  "order.cancelled": "取消订单",
  "order.fleet_visible_change": "修改订单信息",
  "rfq.created": "建立询价",
  "rfq.sent": "向车队发送询价",
  "rfq.revision_changed": "生成新的订单条件版本",
  "rfq_recipient.declined": "车队拒绝承运",
  "rfq_recipient.reply_later": "车队选择稍后回复",
  "quote.drafted": "车队填写报价",
  "quote.submitted": "车队提交报价",
  "quote.invalidated": "旧报价因条件修改失效",
  "quote.reconfirmed_price_unchanged": "车队确认价格不变",
  "quote.accepted": "选定报价",
  "quote.rejected": "关闭其他报价",
  "booking.offered": "向车队发出任务",
  "booking.accepted": "车队接受任务",
  "shipment.created": "创建运输任务",
  "shipment.status_changed": "运输状态更新",
  "document.shipment_uploaded": "车队上传运输文件",
  "shipment.documents_approved": "运输文件审核通过",
  "shipment.documents_rejected": "运输文件要求补充",
  "fleet_profile.submitted": "车队提交档案",
  "fleet_profile.approved": "运营批准车队档案",
  "fleet_profile.rejected": "运营退回车队档案",
  "exception.created": "产生待处理异常",
  "exception.operator_replied": "运营回复车队",
  "exception.status_changed": "更新异常处理状态",
};

type OrderForm = {
  orderType: "EXPORT_DRAYAGE" | "IMPORT_DRAYAGE";
  serviceCountry: string;
  requestedStartAt: string;
  requestedCompleteAt: string;
  loadingLocation: string;
  originTerminal: string;
  destinationTerminal: string;
  deliveryLocation: string;
  emptyContainerPickupAt: string;
  terminalCutoffAt: string;
  customerReference: string;
  pickupLocationText: string;
  deliveryLocationText: string;
  pickupAt: string;
  deliveryAt: string;
  pickupContactName: string;
  pickupContactPhone: string;
  deliveryContactName: string;
  deliveryContactPhone: string;
  containerType: string;
  containerQuantity: number;
  containerNumber: string;
  sealNumber: string;
  cargoDescription: string;
  grossWeightKg: string;
  isHazardous: boolean;
  unNumber: string;
  isReefer: boolean;
  reeferTemperatureC: string;
  shippingLine: string;
  carrierBookingReference: string;
  billOfLadingReference: string;
  vesselName: string;
  voyageNumber: string;
  emptyContainerPickupLocation: string;
  emptyContainerReturnLocation: string;
  emptyContainerReturnDeadline: string;
  specialRequirements: string;
};

const localDateTime = (value?: string | null) => {
  if (!value) return "";
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};

function blankForm(): OrderForm {
  const pickup = new Date(Date.now() + 24 * 60 * 60 * 1000);
  pickup.setHours(9, 0, 0, 0);
  return {
    orderType: "IMPORT_DRAYAGE",
    serviceCountry: "SG",
    requestedStartAt: localDateTime(pickup.toISOString()),
    requestedCompleteAt: "",
    loadingLocation: "",
    originTerminal: "",
    destinationTerminal: "",
    deliveryLocation: "",
    emptyContainerPickupAt: "",
    terminalCutoffAt: "",
    customerReference: "",
    pickupLocationText: "",
    deliveryLocationText: "",
    pickupAt: localDateTime(pickup.toISOString()),
    deliveryAt: "",
    pickupContactName: "",
    pickupContactPhone: "",
    deliveryContactName: "",
    deliveryContactPhone: "",
    containerType: "40HQ",
    containerQuantity: 1,
    containerNumber: "",
    sealNumber: "",
    cargoDescription: "",
    grossWeightKg: "",
    isHazardous: false,
    unNumber: "",
    isReefer: false,
    reeferTemperatureC: "",
    shippingLine: "",
    carrierBookingReference: "",
    billOfLadingReference: "",
    vesselName: "",
    voyageNumber: "",
    emptyContainerPickupLocation: "",
    emptyContainerReturnLocation: "",
    emptyContainerReturnDeadline: "",
    specialRequirements: "",
  };
}

function formFromOrder(order: any): OrderForm {
  return {
    orderType: order.order_type ?? "IMPORT_DRAYAGE",
    serviceCountry: order.service_country ?? "SG",
    requestedStartAt: localDateTime(order.requested_start_at ?? order.pickup_at),
    requestedCompleteAt: localDateTime(order.requested_complete_at ?? order.delivery_at),
    loadingLocation: order.loading_location ?? "",
    originTerminal: order.origin_terminal ?? "",
    destinationTerminal: order.destination_terminal ?? "",
    deliveryLocation: order.delivery_location ?? "",
    emptyContainerPickupAt: localDateTime(order.empty_container_pickup_at),
    terminalCutoffAt: localDateTime(order.terminal_cutoff_at),
    customerReference: order.customer_reference ?? "",
    pickupLocationText: order.pickup_location_text ?? "",
    deliveryLocationText: order.delivery_location_text ?? "",
    pickupAt: localDateTime(order.pickup_at),
    deliveryAt: localDateTime(order.delivery_at),
    pickupContactName: order.pickup_contact_name ?? "",
    pickupContactPhone: order.pickup_contact_phone ?? "",
    deliveryContactName: order.delivery_contact_name ?? "",
    deliveryContactPhone: order.delivery_contact_phone ?? "",
    containerType: order.container_type ?? "",
    containerQuantity: Number(order.container_quantity ?? 1),
    containerNumber: order.container_number ?? "",
    sealNumber: order.seal_number ?? "",
    cargoDescription: order.cargo_description ?? "",
    grossWeightKg: order.gross_weight_kg ?? "",
    isHazardous: Boolean(order.is_hazardous),
    unNumber: order.un_number ?? "",
    isReefer: Boolean(order.is_reefer),
    reeferTemperatureC: order.reefer_temperature_c ?? "",
    shippingLine: order.shipping_line ?? "",
    carrierBookingReference: order.carrier_booking_reference ?? "",
    billOfLadingReference: order.bill_of_lading_reference ?? "",
    vesselName: order.vessel_name ?? "",
    voyageNumber: order.voyage_number ?? "",
    emptyContainerPickupLocation: order.empty_container_pickup_location ?? "",
    emptyContainerReturnLocation: order.empty_container_return_location ?? "",
    emptyContainerReturnDeadline: localDateTime(order.empty_container_return_deadline),
    specialRequirements: order.special_requirements ?? "",
  };
}

const payloadFromForm = (form: OrderForm) => ({
  ...form,
  pickupLocationText:
    form.orderType === "EXPORT_DRAYAGE"
      ? form.emptyContainerPickupLocation
      : form.destinationTerminal,
  deliveryLocationText:
    form.orderType === "EXPORT_DRAYAGE"
      ? form.originTerminal
      : form.deliveryLocation,
  pickupAt: new Date(form.requestedStartAt).toISOString(),
  deliveryAt: form.requestedCompleteAt
    ? new Date(form.requestedCompleteAt).toISOString()
    : null,
  requestedStartAt: new Date(form.requestedStartAt).toISOString(),
  requestedCompleteAt: form.requestedCompleteAt
    ? new Date(form.requestedCompleteAt).toISOString()
    : null,
  emptyContainerPickupAt: form.emptyContainerPickupAt
    ? new Date(form.emptyContainerPickupAt).toISOString()
    : null,
  terminalCutoffAt: form.terminalCutoffAt
    ? new Date(form.terminalCutoffAt).toISOString()
    : null,
  loadingLocation: form.loadingLocation || null,
  originTerminal: form.originTerminal || null,
  destinationTerminal: form.destinationTerminal || null,
  deliveryLocation: form.deliveryLocation || null,
  emptyContainerReturnDeadline: form.emptyContainerReturnDeadline
    ? new Date(form.emptyContainerReturnDeadline).toISOString()
    : null,
  grossWeightKg: form.grossWeightKg ? Number(form.grossWeightKg) : null,
  reeferTemperatureC: form.reeferTemperatureC ? Number(form.reeferTemperatureC) : null,
  customerReference: form.customerReference || null,
  pickupContactName: form.pickupContactName || null,
  pickupContactPhone: form.pickupContactPhone || null,
  deliveryContactName: form.deliveryContactName || null,
  deliveryContactPhone: form.deliveryContactPhone || null,
  containerNumber: form.containerNumber || null,
  sealNumber: form.sealNumber || null,
  cargoDescription: form.cargoDescription || null,
  unNumber: form.unNumber || null,
  shippingLine: form.shippingLine || null,
  carrierBookingReference: form.carrierBookingReference || null,
  billOfLadingReference: form.billOfLadingReference || null,
  vesselName: form.vesselName || null,
  voyageNumber: form.voyageNumber || null,
  emptyContainerPickupLocation: form.emptyContainerPickupLocation || null,
  emptyContainerReturnLocation: form.emptyContainerReturnLocation || null,
  specialRequirements: form.specialRequirements || null,
});

const display = (value: unknown, fallback = "—") =>
  value === null || value === undefined || value === "" ? fallback : String(value);

function Field({ label, value, wide = false }: { label: string; value: unknown; wide?: boolean }) {
  return (
    <div className={`data-field${wide ? " wide" : ""}`}>
      <dt>{label}</dt>
      <dd>{display(value)}</dd>
    </div>
  );
}

function OrderEditor({
  order,
  busy,
  onClose,
  onSubmit,
}: {
  order: any | null;
  busy: boolean;
  onClose: () => void;
  onSubmit: (form: OrderForm) => void;
}) {
  const [form, setForm] = useState<OrderForm>(() => order ? formFromOrder(order) : blankForm());
  const set = <K extends keyof OrderForm>(key: K, value: OrderForm[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <form
        className="order-editor"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit(form);
        }}
      >
        <header className="editor-header">
          <div>
            <span className="section-kicker">{order ? "EDIT ORDER" : "NEW ORDER"}</span>
            <h2>{order ? `编辑 ${order.public_reference}` : "新建运输订单"}</h2>
          </div>
          <button className="icon-button" type="button" aria-label="关闭" onClick={onClose}>×</button>
        </header>
        <div className="editor-body">
          <fieldset>
            <legend>路线与时间</legend>
            <div className="form-grid">
              <label>订单类型*
                <select value={form.orderType} onChange={(e) => set("orderType", e.target.value as OrderForm["orderType"])}>
                  <option value="EXPORT_DRAYAGE">送港：堆场 → 装货地点 → 码头</option>
                  <option value="IMPORT_DRAYAGE">提港：码头 → 送货地点 → 还空箱</option>
                </select>
              </label>
              <label>服务国家*<input required maxLength={2} value={form.serviceCountry} onChange={(e) => set("serviceCountry", e.target.value.toUpperCase())} /></label>
              {form.orderType === "EXPORT_DRAYAGE" ? (
                <>
                  <label className="wide">空箱提取地点*<input required value={form.emptyContainerPickupLocation} onChange={(e) => set("emptyContainerPickupLocation", e.target.value)} /></label>
                  <label className="wide">仓库／工厂装货地点*<input required value={form.loadingLocation} onChange={(e) => set("loadingLocation", e.target.value)} /></label>
                  <label className="wide">起运码头（还重箱）*<input required value={form.originTerminal} onChange={(e) => set("originTerminal", e.target.value)} /></label>
                  <label>计划提空箱时间*<input required type="datetime-local" value={form.emptyContainerPickupAt} onChange={(e) => set("emptyContainerPickupAt", e.target.value)} /></label>
                  <label>码头截关时间<input type="datetime-local" value={form.terminalCutoffAt} onChange={(e) => set("terminalCutoffAt", e.target.value)} /></label>
                </>
              ) : (
                <>
                  <label className="wide">目的码头（提重箱）*<input required value={form.destinationTerminal} onChange={(e) => set("destinationTerminal", e.target.value)} /></label>
                  <label className="wide">仓库／工厂送货地点*<input required value={form.deliveryLocation} onChange={(e) => set("deliveryLocation", e.target.value)} /></label>
                  <label className="wide">空箱归还地点*<input required value={form.emptyContainerReturnLocation} onChange={(e) => set("emptyContainerReturnLocation", e.target.value)} /></label>
                </>
              )}
              <label>计划开始时间*<input required type="datetime-local" value={form.requestedStartAt} onChange={(e) => set("requestedStartAt", e.target.value)} /></label>
              <label>希望完成时间<input type="datetime-local" value={form.requestedCompleteAt} onChange={(e) => set("requestedCompleteAt", e.target.value)} /></label>
              <label>提货联系人<input value={form.pickupContactName} onChange={(e) => set("pickupContactName", e.target.value)} /></label>
              <label>提货联系电话<input value={form.pickupContactPhone} onChange={(e) => set("pickupContactPhone", e.target.value)} /></label>
              <label>送达联系人<input value={form.deliveryContactName} onChange={(e) => set("deliveryContactName", e.target.value)} /></label>
              <label>送达联系电话<input value={form.deliveryContactPhone} onChange={(e) => set("deliveryContactPhone", e.target.value)} /></label>
            </div>
          </fieldset>

          <fieldset>
            <legend>集装箱与货物</legend>
            <div className="form-grid">
              <label>箱型*<input required value={form.containerType} onChange={(e) => set("containerType", e.target.value)} /></label>
              <label>数量*<input required min={1} type="number" value={form.containerQuantity} onChange={(e) => set("containerQuantity", Number(e.target.value))} /></label>
              <label>箱号<input value={form.containerNumber} onChange={(e) => set("containerNumber", e.target.value)} /></label>
              <label>封条号<input value={form.sealNumber} onChange={(e) => set("sealNumber", e.target.value)} /></label>
              <label className="wide">货物描述<input value={form.cargoDescription} onChange={(e) => set("cargoDescription", e.target.value)} /></label>
              <label>毛重（kg）<input min={0} step="0.01" type="number" value={form.grossWeightKg} onChange={(e) => set("grossWeightKg", e.target.value)} /></label>
              <label className="check-label"><input type="checkbox" checked={form.isHazardous} onChange={(e) => set("isHazardous", e.target.checked)} />危险品</label>
              {form.isHazardous ? <label>UN 编号<input value={form.unNumber} onChange={(e) => set("unNumber", e.target.value)} /></label> : null}
              <label className="check-label"><input type="checkbox" checked={form.isReefer} onChange={(e) => set("isReefer", e.target.checked)} />冷藏箱</label>
              {form.isReefer ? <label>温度（°C）<input step="0.1" type="number" value={form.reeferTemperatureC} onChange={(e) => set("reeferTemperatureC", e.target.value)} /></label> : null}
            </div>
          </fieldset>

          <fieldset>
            <legend>业务参考</legend>
            <div className="form-grid">
              <label>客户参考号<input value={form.customerReference} onChange={(e) => set("customerReference", e.target.value)} /></label>
              <label>船公司<input value={form.shippingLine} onChange={(e) => set("shippingLine", e.target.value)} /></label>
              <label>船公司订舱号<input value={form.carrierBookingReference} onChange={(e) => set("carrierBookingReference", e.target.value)} /></label>
              <label>提单号<input value={form.billOfLadingReference} onChange={(e) => set("billOfLadingReference", e.target.value)} /></label>
              <label>船名<input value={form.vesselName} onChange={(e) => set("vesselName", e.target.value)} /></label>
              <label>航次<input value={form.voyageNumber} onChange={(e) => set("voyageNumber", e.target.value)} /></label>
            </div>
          </fieldset>

          <fieldset>
            <legend>空箱安排与要求</legend>
            <div className="form-grid">
              {form.orderType === "IMPORT_DRAYAGE" ? <label>空箱归还截止<input type="datetime-local" value={form.emptyContainerReturnDeadline} onChange={(e) => set("emptyContainerReturnDeadline", e.target.value)} /></label> : null}
              <label className="wide">特殊要求<textarea rows={3} value={form.specialRequirements} onChange={(e) => set("specialRequirements", e.target.value)} /></label>
            </div>
          </fieldset>
        </div>
        <footer className="editor-footer">
          <p>{order ? "修改车队可见内容后，旧报价将保留但失效，并要求车队重新确认。" : "创建后先核对候选车队，再确认发送询价。"}</p>
          <button className="button button-secondary" type="button" onClick={onClose}>取消</button>
          <button className="button button-primary" disabled={busy} type="submit">
            {busy ? "正在保存…" : order ? "保存修改" : "创建订单"}
          </button>
        </footer>
      </form>
    </div>
  );
}

export function OperatorDashboard({
  session,
  onLogout,
}: {
  session: SessionUser;
  onLogout: () => Promise<void>;
}) {
  const [state, setState] = useState<Record<string, any[]>>({});
  const [audit, setAudit] = useState<any[]>([]);
  const [pendingProfiles, setPendingProfiles] = useState<any[]>([]);
  const [fleetAccounts, setFleetAccounts] = useState<any[]>([]);
  const [reviewDocuments, setReviewDocuments] = useState<any[]>([]);
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
  const [selectedExceptionId, setSelectedExceptionId] = useState<string | null>(null);
  const [view, setView] = useState<"orders" | "profiles" | "exceptions">("orders");
  const [tab, setTab] = useState<"overview" | "quotes" | "activity">("overview");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"ALL" | "DRAFT" | "QUOTING" | "BOOKED" | "IN_PROGRESS" | "COMPLETED" | "CANCELLED" | "EXCEPTION">("ALL");
  const [sortBy, setSortBy] = useState<"pickup_asc" | "pickup_desc" | "updated_desc" | "reference_asc">("pickup_asc");
  const [editorOrder, setEditorOrder] = useState<any | "new" | null>(null);
  const [exceptionReply, setExceptionReply] = useState("");
  const [busy, setBusy] = useState(false);
  const [offline, setOffline] = useState(false);
  const [notice, setNotice] = useState("");
  const [recipientPicker, setRecipientPicker] = useState<{
    orderId: string;
    candidates: Array<{ id: string; name: string; eligible: boolean; reasons: string[] }>;
    selected: string[];
  } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [nextState, nextAudit, nextProfiles] = await Promise.all([
        api.operator.state(),
        api.operator.audit(),
        api.operator.pendingProfiles(),
      ]);
      setState(nextState);
      setAudit(nextAudit.audit);
      setPendingProfiles(nextProfiles.profiles);
      setFleetAccounts(nextProfiles.fleets);
      setOffline(false);
      setSelectedOrderId((current) => current ?? nextState.orders?.[0]?.id ?? null);
      setSelectedExceptionId((current) => current ?? nextState.exceptions?.[0]?.id ?? null);
    } catch {
      setOffline(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const run = async (success: string, action: () => Promise<unknown>) => {
    setBusy(true);
    setNotice("");
    try {
      await action();
      setNotice(success);
      await refresh();
    } catch (error: any) {
      setNotice(`操作失败：${error.body?.message ?? error.body?.error ?? error.message}`);
    } finally {
      setBusy(false);
    }
  };

  const orders = state.orders ?? [];
  // Orders with at least one open exception, so the operator can isolate them.
  const orderIdsWithException = useMemo(() => {
    const rfqToOrder = new Map((state.rfqs ?? []).map((r) => [r.id, r.order_id]));
    const ids = new Set<string>();
    for (const x of state.exceptions ?? []) {
      if (!["OPEN", "IN_PROGRESS"].includes(x.status)) continue;
      if (x.order_id) ids.add(x.order_id);
      else if (x.rfq_id && rfqToOrder.has(x.rfq_id)) ids.add(rfqToOrder.get(x.rfq_id) as string);
    }
    return ids;
  }, [state.exceptions, state.rfqs]);

  const filteredOrders = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = orders.filter((order) => {
      if (statusFilter === "EXCEPTION") {
        if (!orderIdsWithException.has(order.id)) return false;
      } else if (statusFilter !== "ALL" && order.status !== statusFilter) {
        return false;
      }
      if (!q) return true;
      return `${order.public_reference} ${order.customer_reference ?? ""} ${order.container_number ?? ""} ${order.pickup_location_text} ${order.delivery_location_text}`
        .toLowerCase()
        .includes(q);
    });
    const time = (v: string | null) => (v ? new Date(v).getTime() : 0);
    return [...matched].sort((a, b) => {
      switch (sortBy) {
        case "pickup_desc": return time(b.pickup_at) - time(a.pickup_at);
        case "updated_desc": return time(b.updated_at) - time(a.updated_at);
        case "reference_asc": return String(a.public_reference).localeCompare(String(b.public_reference));
        default: return time(a.pickup_at) - time(b.pickup_at);
      }
    });
  }, [orders, query, statusFilter, sortBy, orderIdsWithException]);
  const selectedOrder = orders.find((order) => order.id === selectedOrderId) ?? orders[0] ?? null;

  const detail = useMemo(() => {
    if (!selectedOrder) return { recipients: [], quotes: [], bookings: [], shipments: [], exceptions: [] };
    const rfq = (state.rfqs ?? []).find((item) => item.order_id === selectedOrder.id);
    const recipients = (state.recipients ?? []).filter((item) => item.rfq_id === rfq?.id);
    const recipientIds = new Set(recipients.map((item) => item.id));
    const quotes = (state.quotes ?? []).filter((item) => recipientIds.has(item.rfq_recipient_id));
    const bookings = (state.bookings ?? []).filter((item) => item.order_id === selectedOrder.id);
    const bookingIds = new Set(bookings.map((item) => item.id));
    const shipments = (state.shipments ?? []).filter((item) => bookingIds.has(item.booking_id));
    const exceptions = (state.exceptions ?? []).filter((item) => item.order_id === selectedOrder.id || item.rfq_id === rfq?.id);
    return { rfq, recipients, quotes, bookings, shipments, exceptions, booking: bookings[0], shipment: shipments[0] };
  }, [selectedOrder, state]);

  const relatedIds = useMemo(() => {
    const ids = new Set<string>();
    if (selectedOrder) ids.add(selectedOrder.id);
    if (detail.rfq) ids.add(detail.rfq.id);
    for (const collection of [detail.recipients, detail.quotes, detail.bookings, detail.shipments, detail.exceptions]) {
      for (const item of collection) ids.add(item.id);
    }
    return ids;
  }, [selectedOrder, detail]);

  const timeline = audit
    .filter((entry) => relatedIds.has(entry.object_id))
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  const openExceptions = (state.exceptions ?? []).filter((item) => ["OPEN", "IN_PROGRESS"].includes(item.status));
  const selectedException =
    (state.exceptions ?? []).find((item) => item.id === selectedExceptionId) ?? openExceptions[0] ?? null;
  const currentStatus = detail.exceptions.some((item) => ["OPEN", "IN_PROGRESS"].includes(item.status))
    ? "EXCEPTION"
    : detail.shipment?.current_status ?? detail.booking?.status ?? selectedOrder?.status;

  useEffect(() => {
    const shipmentId = selectedException?.details?.shipmentId as string | undefined;
    if (selectedException?.type !== "DOCUMENT_REVIEW_REQUIRED" || !shipmentId) {
      setReviewDocuments([]);
      return;
    }
    api.operator.shipmentDocuments(shipmentId)
      .then((result) => setReviewDocuments(result.documents))
      .catch(() => setReviewDocuments([]));
  }, [selectedException?.id]);

  const saveOrder = (form: OrderForm) => {
    if (editorOrder === "new") {
      void run("订单已创建。请确认询价收件车队。", async () => {
        const result = await api.operator.createOrder(payloadFromForm(form));
        setSelectedOrderId(result.order.id);
        setEditorOrder(null);
        setView("orders");
        setRecipientPicker({
          orderId: result.order.id,
          candidates: result.candidates,
          selected: result.candidates.filter((candidate) => candidate.eligible).map((candidate) => candidate.id),
        });
      });
    } else if (editorOrder) {
      void run("订单信息已更新，相关车队已收到变更通知。", async () => {
        await api.operator.patchOrder(editorOrder.id, payloadFromForm(form));
        setEditorOrder(null);
      });
    }
  };

  return (
    <main className="operator-app">
      <aside className="operator-nav">
        <MercuryBrand compact />
        <nav>
          <button className={view === "orders" ? "active" : ""} onClick={() => setView("orders")}>
            <span>订单</span><b>{orders.length}</b>
          </button>
          <button className={view === "exceptions" ? "active" : ""} onClick={() => setView("exceptions")}>
            <span>待处理</span>{openExceptions.length ? <b className="alert-count">{openExceptions.length}</b> : <b>0</b>}
          </button>
          <button className={view === "profiles" ? "active" : ""} onClick={() => setView("profiles")}>
            <span>车队档案</span>{pendingProfiles.length ? <b className="alert-count">{pendingProfiles.length}</b> : <b>0</b>}
          </button>
        </nav>
        <footer className="nav-account">
          <span className="account-avatar">{session.user.displayName.slice(0, 1).toUpperCase()}</span>
          <span><strong>{session.user.displayName}</strong><small>{session.organization.name}</small></span>
          <button className="text-button" onClick={() => void onLogout()}>退出</button>
        </footer>
      </aside>

      {view === "orders" ? (
        <>
          <aside className="operator-list-pane">
            <header className="list-pane-header">
              <div><span className="section-kicker">OPERATIONS</span><h1>运输订单</h1></div>
              <button className="button button-primary button-small" onClick={() => setEditorOrder("new")}>新建</button>
            </header>
            <div className="task-search">
              <span aria-hidden="true">⌕</span>
              <input value={query} placeholder="搜索订单号、箱号、路线或客户号" onChange={(event) => setQuery(event.target.value)} />
            </div>
            <div className="operator-filters">
              <label>
                <span>状态</span>
                <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}>
                  <option value="ALL">全部状态</option>
                  <option value="EXCEPTION">有异常</option>
                  <option value="DRAFT">草稿（未询价）</option>
                  <option value="QUOTING">询价中</option>
                  <option value="BOOKED">已定车队</option>
                  <option value="IN_PROGRESS">运输中</option>
                  <option value="COMPLETED">已完成</option>
                  <option value="CANCELLED">已取消</option>
                </select>
              </label>
              <label>
                <span>排序</span>
                <select value={sortBy} onChange={(event) => setSortBy(event.target.value as typeof sortBy)}>
                  <option value="pickup_asc">提货时间（近到远）</option>
                  <option value="pickup_desc">提货时间（远到近）</option>
                  <option value="updated_desc">最近更新</option>
                  <option value="reference_asc">订单号</option>
                </select>
              </label>
              <span className="filter-count">{filteredOrders.length} / {orders.length}</span>
            </div>
            <div className="operator-order-list">
              {!filteredOrders.length ? (
                <div className="sidebar-empty">
                  {orders.length ? "没有符合当前筛选条件的订单" : "还没有订单，点右上角「新建」开始。"}
                </div>
              ) : null}
              {filteredOrders.map((order) => (
                <button
                  key={order.id}
                  className={`operator-order-row${selectedOrder?.id === order.id ? " selected" : ""}`}
                  onClick={() => {
                    setSelectedOrderId(order.id);
                    setTab("overview");
                  }}
                >
                  <span><strong>{order.public_reference}</strong><time>{new Date(order.pickup_at).toLocaleDateString("zh-CN")}</time></span>
                  <p>{order.pickup_location_text} → {order.delivery_location_text}</p>
                  <span>
                    <small>{order.customer_reference || `${order.container_type} × ${order.container_quantity}`}</small>
                    <i className={`status-dot status-${order.status.toLowerCase()}`}>{LABELS[order.status] ?? order.status}</i>
                  </span>
                </button>
              ))}
              {!filteredOrders.length ? <div className="sidebar-empty">暂无订单</div> : null}
            </div>
          </aside>

          <section className="operator-detail">
            {offline ? <div className="offline-banner">服务暂时离线，页面会自动重试。</div> : null}
            {notice ? <div className="toast-notice">{notice}<button onClick={() => setNotice("")}>×</button></div> : null}
            {!selectedOrder ? (
              <div className="operator-empty">
                <img src={asset("/brand/mercury-mark-256.png")} alt="" width={48} height={48} /><h2>创建第一张运输订单</h2>
                <p>订单创建后会自动向所有启用的车队发出询价。</p>
                <button className="button button-primary" onClick={() => setEditorOrder("new")}>新建订单</button>
              </div>
            ) : (
              <>
                <header className="order-detail-header">
                  <div>
                    <span className="section-kicker">ORDER</span>
                    <div className="order-title-line">
                      <h1>{selectedOrder.public_reference}</h1>
                      <span className={`status-pill status-${String(currentStatus).toLowerCase()}`}>
                        {LABELS[String(currentStatus)] ?? currentStatus}
                      </span>
                    </div>
                    <p>{selectedOrder.pickup_location_text} <span>→</span> {selectedOrder.delivery_location_text}</p>
                  </div>
                  <div className="header-actions">
                    <button className="button button-secondary" onClick={() => setEditorOrder(selectedOrder)}>编辑订单</button>
                    {detail.recipients.some((item) => item.status === "DECLINED") && !detail.booking ? (
                      <button className="button button-secondary" disabled={busy} onClick={() => void run("已重新通知可用车队。", () => api.operator.rebroadcastOrder(selectedOrder.id))}>
                        重新询价
                      </button>
                    ) : null}
                    {!detail.rfq ? (
                      <>
                        <button
                          className="button button-primary"
                          disabled={busy}
                          onClick={() => void run("", async () => {
                            const result = await api.operator.candidates(selectedOrder.id);
                            setRecipientPicker({
                              orderId: selectedOrder.id,
                              candidates: result.candidates,
                              selected: result.candidates.filter((candidate) => candidate.eligible).map((candidate) => candidate.id),
                            });
                          })}
                        >
                          选择车队并发送询价
                        </button>
                        <button
                          className="text-button danger"
                          disabled={busy}
                          onClick={() => window.confirm("确定永久删除这张尚未询价的草稿吗？") && void run("草稿已删除。", async () => {
                            await api.operator.deleteOrder(selectedOrder.id);
                            setSelectedOrderId(null);
                          })}
                        >
                          删除草稿
                        </button>
                      </>
                    ) : !["CANCELLED", "COMPLETED"].includes(selectedOrder.status) ? (
                      <button
                        className="text-button danger"
                        disabled={busy}
                        onClick={() => window.confirm("确定取消该订单吗？历史记录会保留。") && void run("订单已取消。", () => api.operator.cancelOrder(selectedOrder.id))}
                      >
                        取消订单
                      </button>
                    ) : null}
                  </div>
                </header>

                {detail.exceptions.filter((item) => ["OPEN", "IN_PROGRESS"].includes(item.status)).map((exception) => (
                  <button
                    key={exception.id}
                    className="exception-banner"
                    onClick={() => {
                      setSelectedExceptionId(exception.id);
                      setView("exceptions");
                    }}
                  >
                    <span>需要处理</span>
                    <strong>{EXCEPTION_LABELS[exception.type] ?? exception.summary}</strong>
                    <b>查看 →</b>
                  </button>
                ))}

                <nav className="detail-tabs">
                  <button className={tab === "overview" ? "active" : ""} onClick={() => setTab("overview")}>订单信息</button>
                  <button className={tab === "quotes" ? "active" : ""} onClick={() => setTab("quotes")}>车队报价 <span>{detail.quotes.length}</span></button>
                  <button className={tab === "activity" ? "active" : ""} onClick={() => setTab("activity")}>活动记录</button>
                </nav>

                {tab === "overview" ? (
                  <div className="detail-content">
                    <section className="information-section">
                      <header><h2>路线与时间</h2></header>
                      <dl className="data-grid">
                        <Field label="提货地点" value={selectedOrder.pickup_location_text} wide />
                        <Field label="送达地点" value={selectedOrder.delivery_location_text} wide />
                        <Field label="提货时间" value={new Date(selectedOrder.pickup_at).toLocaleString("zh-CN", { hour12: false })} />
                        <Field label="预计送达" value={selectedOrder.delivery_at ? new Date(selectedOrder.delivery_at).toLocaleString("zh-CN", { hour12: false }) : null} />
                        <Field label="提货联系人" value={[selectedOrder.pickup_contact_name, selectedOrder.pickup_contact_phone].filter(Boolean).join(" · ")} />
                        <Field label="送达联系人" value={[selectedOrder.delivery_contact_name, selectedOrder.delivery_contact_phone].filter(Boolean).join(" · ")} />
                      </dl>
                    </section>

                    <section className="information-section">
                      <header><h2>集装箱与货物</h2></header>
                      <dl className="data-grid">
                        <Field label="箱型 / 数量" value={`${selectedOrder.container_type} × ${selectedOrder.container_quantity}`} />
                        <Field label="箱号" value={selectedOrder.container_number} />
                        <Field label="封条号" value={selectedOrder.seal_number} />
                        <Field label="毛重" value={selectedOrder.gross_weight_kg ? `${selectedOrder.gross_weight_kg} kg` : null} />
                        <Field label="货物描述" value={selectedOrder.cargo_description} wide />
                        <Field label="危险品" value={selectedOrder.is_hazardous ? `是${selectedOrder.un_number ? ` · ${selectedOrder.un_number}` : ""}` : "否"} />
                        <Field label="冷藏要求" value={selectedOrder.is_reefer ? `${selectedOrder.reefer_temperature_c ?? "待确认"} °C` : "否"} />
                      </dl>
                    </section>

                    <section className="information-section">
                      <header><h2>业务参考与空箱安排</h2></header>
                      <dl className="data-grid">
                        <Field label="客户参考号" value={selectedOrder.customer_reference} />
                        <Field label="船公司" value={selectedOrder.shipping_line} />
                        <Field label="订舱号" value={selectedOrder.carrier_booking_reference} />
                        <Field label="提单号" value={selectedOrder.bill_of_lading_reference} />
                        <Field label="船名 / 航次" value={[selectedOrder.vessel_name, selectedOrder.voyage_number].filter(Boolean).join(" / ")} />
                        <Field label="空箱提取地点" value={selectedOrder.empty_container_pickup_location} />
                        <Field label="空箱归还地点" value={selectedOrder.empty_container_return_location} />
                        <Field label="空箱归还截止" value={selectedOrder.empty_container_return_deadline ? new Date(selectedOrder.empty_container_return_deadline).toLocaleString("zh-CN", { hour12: false }) : null} />
                        <Field label="特殊要求" value={selectedOrder.special_requirements} wide />
                      </dl>
                    </section>
                  </div>
                ) : null}

                {tab === "quotes" ? (
                  <div className="detail-content">
                    <section className="information-section quote-section">
                      <header>
                        <div><h2>车队响应</h2><p>订单创建后系统会自动通知全部启用车队。</p></div>
                      </header>
                      <div className="data-table">
                        <div className="table-head"><span>车队 / 响应</span><span>价格 / 全包</span><span>可用性 / 有效期 / 条款</span><span>操作</span></div>
                        {detail.recipients.map((recipient) => {
                          const quotes = detail.quotes.filter((quote) => quote.rfq_recipient_id === recipient.id);
                          const latest = quotes[0];
                          return (
                            <div className="table-row" key={recipient.id}>
                              <span><strong>{recipient.fleet_name}</strong><br /><small>{LABELS[recipient.status] ?? recipient.status}</small></span>
                              <span>{latest ? `${latest.currency} ${latest.amount} · ${latest.is_all_in === true ? "全包" : latest.is_all_in === false ? "非全包" : "全包待确认"}` : "—"}</span>
                              <span>
                                {latest
                                  ? `${latest.vehicle_available ? "可承接整票" : "可用性待确认"} · ${latest.available_from ? `最早 ${new Date(latest.available_from).toLocaleString("zh-CN", { hour12: false })}` : "最早时间待确认"} · ${latest.valid_until ? `有效至 ${new Date(latest.valid_until).toLocaleString("zh-CN", { hour12: false })}` : "有效期未限制"}${latest.terms ? ` · ${latest.terms}` : ""}`
                                  : "—"}
                              </span>
                              <span>
                                {latest?.status === "SUBMITTED" ? (
                                  <button className="button button-primary button-small" disabled={busy} onClick={() => void run("已选择该报价并向车队发出任务。", () => api.operator.selectQuote(latest.id))}>
                                    选择报价
                                  </button>
                                ) : null}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </section>
                  </div>
                ) : null}

                {tab === "activity" ? (
                  <div className="detail-content">
                    <section className="information-section">
                      <header><div><h2>活动记录</h2><p>记录来自数据库，刷新或重启后不会消失。</p></div></header>
                      <div className="activity-feed">
                        {timeline.map((entry) => (
                          <article key={entry.id}>
                            <span className="activity-dot" />
                            <div><strong>{EVENT_LABELS[entry.action] ?? entry.action}</strong><time>{new Date(entry.created_at).toLocaleString("zh-CN", { hour12: false })}</time></div>
                          </article>
                        ))}
                        {!timeline.length ? <p className="muted">暂无活动记录</p> : null}
                      </div>
                    </section>
                  </div>
                ) : null}
              </>
            )}
          </section>
        </>
      ) : view === "profiles" ? (
        <>
          <aside className="operator-list-pane">
            <header className="list-pane-header">
              <div><span className="section-kicker">FLEET PROFILES</span><h1>档案审核</h1></div>
            </header>
            <div className="operator-order-list">
              {pendingProfiles.map((profile) => (
                <article className="exception-list-row" key={profile.id}>
                  <span><strong>{profile.fleet_name}</strong><i className="status-dot">待审核</i></span>
                  <p>版本 {profile.version} · {(profile.operating_countries ?? []).join(", ")}</p>
                  <time>{profile.submitted_at ? new Date(profile.submitted_at).toLocaleString("zh-CN", { hour12: false }) : ""}</time>
                </article>
              ))}
              {!pendingProfiles.length ? <div className="sidebar-empty">目前没有待审核档案</div> : null}
            </div>
          </aside>
          <section className="operator-detail">
            {notice ? <div className="toast-notice">{notice}<button onClick={() => setNotice("")}>×</button></div> : null}
            <div className="detail-content">
              {pendingProfiles.map((profile) => (
                <section className="information-section" key={profile.id}>
                  <header>
                    <div><h2>{profile.fleet_name}</h2><p>{profile.organization_name} · 档案版本 {profile.version}</p></div>
                  </header>
                  <dl className="data-grid">
                    <Field label="营运国家" value={(profile.operating_countries ?? []).join(", ")} />
                    <Field label="危险品能力" value={profile.supports_hazardous ? "满足" : "不满足"} />
                    <Field label="冷藏箱能力" value={profile.supports_reefer ? "满足" : "不满足"} />
                    <Field label="联系人" value={`${profile.contact_name} · ${profile.contact_phone}`} />
                    <Field label="备注" value={profile.notes} wide />
                    <Field label="上一版车队名称" value={profile.previous_fleet_name} />
                    <Field label="上一版能力" value={`危险品：${profile.previous_supports_hazardous ? "是" : "否"}；冷藏：${profile.previous_supports_reefer ? "是" : "否"}`} />
                  </dl>
                  <footer className="exception-actions">
                    <button
                      className="button button-secondary"
                      disabled={busy}
                      onClick={() => {
                        const note = window.prompt("请输入退回原因：");
                        if (note) void run("档案已退回。", () => api.operator.reviewProfile(profile.id, false, note));
                      }}
                    >
                      退回修改
                    </button>
                    <button
                      className="button button-primary"
                      disabled={busy}
                      onClick={() => void run("档案已批准。", () => api.operator.reviewProfile(profile.id, true))}
                    >
                      批准档案
                    </button>
                  </footer>
                </section>
              ))}
              <section className="information-section">
                <header><div><h2>车队账号状态</h2><p>系统停用后，该车队不能登录，也不会收到询价。</p></div></header>
                <div className="data-table">
                  <div className="table-head"><span>车队</span><span>接单状态</span><span>系统状态</span><span>操作</span></div>
                  {fleetAccounts.map((fleet) => (
                    <div className="table-row" key={fleet.id}>
                      <strong>{fleet.name}</strong>
                      <span>{fleet.accepting_orders ? "正在接单" : "暂停接单"}</span>
                      <span>{fleet.status === "ACTIVE" ? "启用" : "已停用"}</span>
                      <span>
                        <button
                          className="button button-secondary button-small"
                          disabled={busy}
                          onClick={() => void run(
                            fleet.status === "ACTIVE" ? "车队账号已停用。" : "车队账号已启用。",
                            () => api.operator.setFleetStatus(
                              fleet.id,
                              fleet.status === "ACTIVE" ? "SUSPENDED" : "ACTIVE",
                            ),
                          )}
                        >
                          {fleet.status === "ACTIVE" ? "停用" : "启用"}
                        </button>
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            </div>
          </section>
        </>
      ) : (
        <>
          <aside className="operator-list-pane">
            <header className="list-pane-header"><div><span className="section-kicker">EXCEPTIONS</span><h1>待处理事项</h1></div></header>
            <div className="operator-order-list">
              {openExceptions.map((exception) => (
                <button
                  key={exception.id}
                  className={`exception-list-row${selectedException?.id === exception.id ? " selected" : ""}`}
                  onClick={() => setSelectedExceptionId(exception.id)}
                >
                  <span><strong>{EXCEPTION_LABELS[exception.type] ?? exception.type}</strong><i className={`status-dot status-${exception.status.toLowerCase()}`}>{LABELS[exception.status] ?? exception.status}</i></span>
                  <p>{exception.summary}</p>
                  <time>{new Date(exception.created_at).toLocaleString("zh-CN", { hour12: false })}</time>
                </button>
              ))}
              {!openExceptions.length ? <div className="sidebar-empty">目前没有待处理事项</div> : null}
            </div>
          </aside>

          <section className="operator-detail">
            {notice ? <div className="toast-notice">{notice}<button onClick={() => setNotice("")}>×</button></div> : null}
            {!selectedException ? (
              <div className="operator-empty"><span>✓</span><h2>没有待处理事项</h2><p>新的车队求助或运输异常会显示在这里。</p></div>
            ) : (
              <div className="exception-detail">
                <header>
                  <span className="section-kicker">EXCEPTION</span>
                  <h1>{EXCEPTION_LABELS[selectedException.type] ?? selectedException.type}</h1>
                  <p>{selectedException.summary}</p>
                  <span className={`status-pill status-${selectedException.status.toLowerCase()}`}>{LABELS[selectedException.status] ?? selectedException.status}</span>
                </header>
                <section className="exception-context">
                  <h2>处理信息</h2>
                  <dl className="data-grid">
                    <Field label="关联订单" value={orders.find((order) => order.id === selectedException.order_id)?.public_reference} />
                    <Field label="创建时间" value={new Date(selectedException.created_at).toLocaleString("zh-CN", { hour12: false })} />
                    <Field label="详细信息" value={JSON.stringify(selectedException.details ?? {})} wide />
                  </dl>
                </section>
                {selectedException.type === "DOCUMENT_REVIEW_REQUIRED" && selectedException.details?.shipmentId ? (
                  <section className="exception-context">
                    <h2>运输文件审核</h2>
                    <div className="data-table">
                      <div className="table-head"><span>类型</span><span>文件</span><span>状态</span><span>查看</span></div>
                      {reviewDocuments.map((document) => (
                        <div className="table-row" key={document.id}>
                          <strong>{document.type}</strong>
                          <span>{document.file_name}</span>
                          <span>{document.review_status}</span>
                          <span>
                            <a
                              className="text-button"
                              href={`/api/operator/documents/${document.id}/download`}
                              target="_blank"
                              rel="noreferrer"
                            >
                              预览／下载
                            </a>
                          </span>
                        </div>
                      ))}
                    </div>
                    <footer className="exception-actions">
                      <button
                        className="button button-secondary"
                        disabled={busy}
                        onClick={() => {
                          const note = window.prompt("请说明需要补充的内容：");
                          if (note) void run("已要求车队补充文件。", () =>
                            api.operator.reviewShipmentDocuments(selectedException.details.shipmentId, false, note));
                        }}
                      >
                        要求补充
                      </button>
                      <button
                        className="button button-primary"
                        disabled={busy}
                        onClick={() => window.confirm("确认全部必需文件合格并完成订单？") && void run(
                          "文件审核通过，订单已完成。",
                          () => api.operator.reviewShipmentDocuments(selectedException.details.shipmentId, true),
                        )}
                      >
                        审核通过并完成
                      </button>
                    </footer>
                  </section>
                ) : null}
                {selectedException.conversation_id ? (
                  <section className="operator-reply">
                    <h2>回复车队</h2>
                    <p>回复会直接出现在该任务的车队对话中。</p>
                    <textarea rows={4} value={exceptionReply} placeholder="输入处理说明或需要车队补充的信息…" onChange={(event) => setExceptionReply(event.target.value)} />
                    <button
                      className="button button-primary"
                      disabled={busy || !exceptionReply.trim()}
                      onClick={() => void run("回复已发送给车队。", async () => {
                        await api.operator.replyException(selectedException.id, exceptionReply);
                        setExceptionReply("");
                      })}
                    >
                      发送回复
                    </button>
                  </section>
                ) : null}
                <footer className="exception-actions">
                  {selectedException.status === "OPEN" ? (
                    <button className="button button-secondary" disabled={busy} onClick={() => void run("已开始处理。", () => api.operator.updateException(selectedException.id, "IN_PROGRESS"))}>标记处理中</button>
                  ) : null}
                  {selectedException.type !== "DOCUMENT_REVIEW_REQUIRED" ? <button className="button button-primary" disabled={busy} onClick={() => void run("事项已解决。", async () => {
                    await api.operator.updateException(selectedException.id, "RESOLVED");
                    setSelectedExceptionId(null);
                  })}>标记已解决</button> : null}
                </footer>
              </div>
            )}
          </section>
        </>
      )}

      {editorOrder ? (
        <OrderEditor
          order={editorOrder === "new" ? null : editorOrder}
          busy={busy}
          onClose={() => setEditorOrder(null)}
          onSubmit={saveOrder}
        />
      ) : null}
      {recipientPicker ? (
        <div className="modal-backdrop">
          <section className="order-editor recipient-picker">
            <header className="editor-header">
              <div>
                <span className="section-kicker">RFQ RECIPIENTS</span>
                <h2>确认询价车队</h2>
                <p>系统已按国家、危险品和冷藏能力完成基础匹配；你可以手动增减仍在接单的车队。</p>
              </div>
              <button className="icon-button" type="button" onClick={() => setRecipientPicker(null)}>×</button>
            </header>
            <div className="editor-body">
              {recipientPicker.candidates.map((candidate) => {
                const blocked = candidate.reasons.some((reason) =>
                  reason.includes("暂停接单") || reason.includes("系统账号已停用"),
                );
                return (
                  <label className="profile-status-card" key={candidate.id}>
                    <input
                      type="checkbox"
                      disabled={blocked}
                      checked={recipientPicker.selected.includes(candidate.id)}
                      onChange={(event) =>
                        setRecipientPicker((current) => current ? {
                          ...current,
                          selected: event.target.checked
                            ? [...current.selected, candidate.id]
                            : current.selected.filter((id) => id !== candidate.id),
                        } : current)
                      }
                    />
                    <strong>{candidate.name}</strong>
                    <span>
                      {candidate.eligible
                        ? "默认匹配"
                        : candidate.reasons.join("；") || "可由运营手动加入"}
                    </span>
                  </label>
                );
              })}
            </div>
            <footer className="editor-footer">
              <p>最终将发送给 {recipientPicker.selected.length} 家车队。</p>
              <button className="button button-secondary" type="button" onClick={() => setRecipientPicker(null)}>取消</button>
              <button
                className="button button-primary"
                type="button"
                disabled={busy || !recipientPicker.selected.length}
                onClick={() => void run("询价已发送。", async () => {
                  await api.operator.sendRfq(recipientPicker.orderId, recipientPicker.selected);
                  setRecipientPicker(null);
                })}
              >
                确认发送
              </button>
            </footer>
          </section>
        </div>
      ) : null}
    </main>
  );
}
