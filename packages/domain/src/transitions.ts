/** Deterministic state machines (spec §7.4, §7.5, §7.7, §23.1). */

export const QUOTE_STATUSES = [
  "DRAFT", "PENDING_CONFIRMATION", "SUBMITTED", "INVALIDATED",
  "ACCEPTED", "REJECTED", "WITHDRAWN", "EXPIRED",
] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

const QUOTE_TRANSITIONS: Record<QuoteStatus, QuoteStatus[]> = {
  DRAFT: ["PENDING_CONFIRMATION", "SUBMITTED", "WITHDRAWN", "INVALIDATED", "EXPIRED"],
  PENDING_CONFIRMATION: ["SUBMITTED", "WITHDRAWN", "INVALIDATED", "EXPIRED"],
  SUBMITTED: ["ACCEPTED", "REJECTED", "INVALIDATED", "WITHDRAWN", "EXPIRED"],
  INVALIDATED: [], // immutable except superseded_by link (§7.4)
  ACCEPTED: ["REJECTED"], // operator-mediated only
  REJECTED: [],
  WITHDRAWN: [],
  EXPIRED: [],
};

export function canQuoteTransition(from: QuoteStatus, to: QuoteStatus): boolean {
  return QUOTE_TRANSITIONS[from]?.includes(to) ?? false;
}

export const ORDER_TYPES = ["EXPORT_DRAYAGE", "IMPORT_DRAYAGE"] as const;
export type OrderType = (typeof ORDER_TYPES)[number];

export const EXPORT_SHIPMENT_STATUSES = [
  "WAITING_EMPTY_CONTAINER_RELEASE",
  "EMPTY_CONTAINER_PICKED_UP",
  "AT_LOADING_LOCATION",
  "LOADED",
  "EN_ROUTE_TO_TERMINAL",
  "LADEN_CONTAINERS_RETURNED_TO_TERMINAL",
  "DOCUMENTS_SUBMITTED",
  "REVIEW_PENDING",
  "COMPLETED",
  "EXCEPTION",
] as const;

export const IMPORT_SHIPMENT_STATUSES = [
  "WAITING_PORT_RELEASE",
  "CONTAINER_PICKED_UP",
  "IN_TRANSIT_TO_DELIVERY",
  "DELIVERED",
  "EMPTY_RETURN_PENDING",
  "EMPTY_RETURNED",
  "DOCUMENTS_SUBMITTED",
  "REVIEW_PENDING",
  "COMPLETED",
  "EXCEPTION",
] as const;

/** Legacy values remain accepted for old databases, but v1.1 never creates them. */
export const LEGACY_SHIPMENT_STATUSES = [
  "WAITING_ASSIGNMENT", "DRIVER_ASSIGNED", "EN_ROUTE_TO_PICKUP", "AT_PICKUP",
  "PICKED_UP", "IN_TRANSIT", "AT_DELIVERY", "POD_SUBMITTED",
] as const;

export const SHIPMENT_STATUSES = [
  ...EXPORT_SHIPMENT_STATUSES,
  ...IMPORT_SHIPMENT_STATUSES,
  ...LEGACY_SHIPMENT_STATUSES,
] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

/**
 * Forward transitions a fleet may report. Adjacent skips that reflect real
 * reporting behavior are allowed (e.g. dispatch straight to "picked up"),
 * but backward moves and jumps past delivery milestones are not (§11.11).
 */
const LEGACY_SHIPMENT_TRANSITIONS: Partial<Record<ShipmentStatus, ShipmentStatus[]>> = {
  WAITING_ASSIGNMENT: ["DRIVER_ASSIGNED", "EXCEPTION"],
  DRIVER_ASSIGNED: ["EN_ROUTE_TO_PICKUP", "AT_PICKUP", "PICKED_UP", "EXCEPTION"],
  EN_ROUTE_TO_PICKUP: ["AT_PICKUP", "PICKED_UP", "EXCEPTION"],
  AT_PICKUP: ["PICKED_UP", "EXCEPTION"],
  PICKED_UP: ["IN_TRANSIT", "AT_DELIVERY", "DELIVERED", "EXCEPTION"],
  IN_TRANSIT: ["AT_DELIVERY", "DELIVERED", "EXCEPTION"],
  AT_DELIVERY: ["DELIVERED", "EXCEPTION"],
  DELIVERED: ["POD_SUBMITTED", "COMPLETED", "EXCEPTION"],
  POD_SUBMITTED: ["COMPLETED", "EXCEPTION"],
  COMPLETED: [],
  EXCEPTION: [], // recovery is operator-mediated, out of MVP fleet flow
};

const EXPORT_SHIPMENT_TRANSITIONS: Partial<Record<ShipmentStatus, ShipmentStatus[]>> = {
  WAITING_EMPTY_CONTAINER_RELEASE: ["EMPTY_CONTAINER_PICKED_UP", "EXCEPTION"],
  EMPTY_CONTAINER_PICKED_UP: ["AT_LOADING_LOCATION", "EXCEPTION"],
  AT_LOADING_LOCATION: ["LOADED", "EXCEPTION"],
  LOADED: ["EN_ROUTE_TO_TERMINAL", "EXCEPTION"],
  EN_ROUTE_TO_TERMINAL: ["LADEN_CONTAINERS_RETURNED_TO_TERMINAL", "EXCEPTION"],
  LADEN_CONTAINERS_RETURNED_TO_TERMINAL: ["DOCUMENTS_SUBMITTED", "EXCEPTION"],
  DOCUMENTS_SUBMITTED: ["REVIEW_PENDING", "EXCEPTION"],
  REVIEW_PENDING: ["COMPLETED", "EXCEPTION"],
  COMPLETED: [],
  EXCEPTION: [],
};

const IMPORT_SHIPMENT_TRANSITIONS: Partial<Record<ShipmentStatus, ShipmentStatus[]>> = {
  WAITING_PORT_RELEASE: ["CONTAINER_PICKED_UP", "EXCEPTION"],
  CONTAINER_PICKED_UP: ["IN_TRANSIT_TO_DELIVERY", "EXCEPTION"],
  IN_TRANSIT_TO_DELIVERY: ["DELIVERED", "EXCEPTION"],
  DELIVERED: ["EMPTY_RETURN_PENDING", "EXCEPTION"],
  EMPTY_RETURN_PENDING: ["EMPTY_RETURNED", "EXCEPTION"],
  EMPTY_RETURNED: ["DOCUMENTS_SUBMITTED", "EXCEPTION"],
  DOCUMENTS_SUBMITTED: ["REVIEW_PENDING", "EXCEPTION"],
  REVIEW_PENDING: ["COMPLETED", "EXCEPTION"],
  COMPLETED: [],
  EXCEPTION: [],
};

export function initialShipmentStatus(orderType: OrderType): ShipmentStatus {
  return orderType === "EXPORT_DRAYAGE"
    ? "WAITING_EMPTY_CONTAINER_RELEASE"
    : "WAITING_PORT_RELEASE";
}

export function shipmentStatusSequence(orderType: OrderType): readonly ShipmentStatus[] {
  return orderType === "EXPORT_DRAYAGE"
    ? EXPORT_SHIPMENT_STATUSES
    : IMPORT_SHIPMENT_STATUSES;
}

export function nextShipmentStatus(orderType: OrderType, from: ShipmentStatus): ShipmentStatus | null {
  const sequence = shipmentStatusSequence(orderType);
  const index = sequence.indexOf(from);
  if (index < 0 || index >= sequence.length - 2) return null;
  return sequence[index + 1] ?? null;
}

export function canShipmentTransition(
  from: ShipmentStatus,
  to: ShipmentStatus,
  orderType?: OrderType,
): boolean {
  const map = orderType === "EXPORT_DRAYAGE"
    ? EXPORT_SHIPMENT_TRANSITIONS
    : orderType === "IMPORT_DRAYAGE"
      ? IMPORT_SHIPMENT_TRANSITIONS
      : LEGACY_SHIPMENT_TRANSITIONS;
  return map[from]?.includes(to) ?? false;
}

export const BOOKING_STATUSES = [
  "OFFERED", "ACCEPTED", "RESOURCE_PENDING", "READY", "IN_PROGRESS", "REVIEW_PENDING", "COMPLETED",
  "CANCELLED_BY_FLEET", "CANCELLED_BY_CUSTOMER", "CANCELLED_BY_OPERATOR",
] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

export const CANCELLED_BOOKING_STATUSES: BookingStatus[] = [
  "CANCELLED_BY_FLEET", "CANCELLED_BY_CUSTOMER", "CANCELLED_BY_OPERATOR",
];

const BOOKING_TRANSITIONS: Record<BookingStatus, BookingStatus[]> = {
  OFFERED: ["ACCEPTED", "RESOURCE_PENDING", "CANCELLED_BY_FLEET", "CANCELLED_BY_CUSTOMER", "CANCELLED_BY_OPERATOR"],
  ACCEPTED: ["RESOURCE_PENDING", "READY", "IN_PROGRESS", "CANCELLED_BY_FLEET", "CANCELLED_BY_CUSTOMER", "CANCELLED_BY_OPERATOR"],
  RESOURCE_PENDING: ["READY", "CANCELLED_BY_FLEET", "CANCELLED_BY_CUSTOMER", "CANCELLED_BY_OPERATOR"],
  READY: ["IN_PROGRESS", "CANCELLED_BY_FLEET", "CANCELLED_BY_CUSTOMER", "CANCELLED_BY_OPERATOR"],
  IN_PROGRESS: ["REVIEW_PENDING", "COMPLETED", "CANCELLED_BY_OPERATOR"],
  REVIEW_PENDING: ["COMPLETED", "CANCELLED_BY_OPERATOR"],
  COMPLETED: [],
  CANCELLED_BY_FLEET: [],
  CANCELLED_BY_CUSTOMER: [],
  CANCELLED_BY_OPERATOR: [],
};

export function canBookingTransition(from: BookingStatus, to: BookingStatus): boolean {
  return BOOKING_TRANSITIONS[from]?.includes(to) ?? false;
}

export const ACTIVE_QUOTE_STATUSES: QuoteStatus[] = ["DRAFT", "PENDING_CONFIRMATION", "SUBMITTED"];

export const RFQ_RECIPIENT_ACTIVE_STATUSES = [
  "SENT", "VIEWED", "AWAITING_QUOTE", "AWAITING_RECONFIRMATION", "QUOTED",
] as const;

/** Fleet-visible order fields whose change triggers §12 workflow. */
export const FLEET_VISIBLE_ORDER_FIELDS = [
  "customer_reference", "order_type", "service_country",
  "pickup_location_text", "delivery_location_text", "container_type",
  "container_quantity", "pickup_at", "delivery_at", "special_requirements",
  "requested_start_at", "requested_complete_at",
  "loading_location", "origin_terminal", "destination_terminal", "delivery_location",
  "carrier_booking_reference", "bill_of_lading_reference", "shipping_line",
  "vessel_name", "voyage_number", "pickup_contact_name", "pickup_contact_phone",
  "delivery_contact_name", "delivery_contact_phone",
  "empty_container_pickup_location", "empty_container_pickup_at", "terminal_cutoff_at",
  "empty_container_return_location",
  "empty_container_return_deadline", "container_number", "seal_number",
  "cargo_description", "gross_weight_kg", "is_hazardous", "un_number",
  "is_reefer", "reefer_temperature_c",
] as const;
export type FleetVisibleOrderField = (typeof FLEET_VISIBLE_ORDER_FIELDS)[number];

export const FIELD_LABELS: Record<FleetVisibleOrderField, string> = {
  customer_reference: "客户参考号",
  order_type: "订单类型",
  service_country: "服务国家",
  pickup_location_text: "提货地点",
  delivery_location_text: "送货地点",
  container_type: "箱型",
  container_quantity: "数量",
  pickup_at: "提货时间",
  delivery_at: "送达时间",
  requested_start_at: "计划开始时间",
  requested_complete_at: "计划完成时间",
  loading_location: "装货地点",
  origin_terminal: "起运码头",
  destination_terminal: "目的码头",
  delivery_location: "送货地点",
  special_requirements: "特殊要求",
  carrier_booking_reference: "船公司订舱号",
  bill_of_lading_reference: "提单号",
  shipping_line: "船公司",
  vessel_name: "船名",
  voyage_number: "航次",
  pickup_contact_name: "提货联系人",
  pickup_contact_phone: "提货联系电话",
  delivery_contact_name: "送达联系人",
  delivery_contact_phone: "送达联系电话",
  empty_container_pickup_location: "空箱提取地点",
  empty_container_pickup_at: "空箱提取时间",
  terminal_cutoff_at: "码头截关时间",
  empty_container_return_location: "空箱归还地点",
  empty_container_return_deadline: "空箱归还截止",
  container_number: "箱号",
  seal_number: "封条号",
  cargo_description: "货物描述",
  gross_weight_kg: "毛重（kg）",
  is_hazardous: "危险品",
  un_number: "UN 编号",
  is_reefer: "冷藏箱",
  reefer_temperature_c: "冷藏温度（°C）",
};

/** Natural-language phrases the fleet uses to report shipment progress. */
export const SHIPMENT_PHRASES: Array<{ pattern: RegExp; to: ShipmentStatus }> = [
  { pattern: /空箱.*(已)?提|提(到|完).*空箱|empty.*picked/i, to: "EMPTY_CONTAINER_PICKED_UP" },
  { pattern: /到(达)?.*(装货|工厂|仓库)|arrived.*loading/i, to: "AT_LOADING_LOCATION" },
  { pattern: /装货.*(完成|完了)|已装(好|货)|loaded/i, to: "LOADED" },
  { pattern: /前往.*码头|去.*码头|en\s*route.*terminal/i, to: "EN_ROUTE_TO_TERMINAL" },
  { pattern: /(重箱|柜).*(已)?(还|交).*码头|terminal.*handover/i, to: "LADEN_CONTAINERS_RETURNED_TO_TERMINAL" },
  { pattern: /重箱.*(已)?提|提(到|完).*(重箱|柜)|picked.*container/i, to: "CONTAINER_PICKED_UP" },
  { pattern: /运输途中|前往.*(送货|仓库|工厂)|在路上|in\s*transit/i, to: "IN_TRANSIT_TO_DELIVERY" },
  { pattern: /送到了|已(经)?送到|卸(货|柜)?完(成|了)|delivered/i, to: "DELIVERED" },
  { pattern: /准备.*还空|等待.*还空|empty.*return.*pending/i, to: "EMPTY_RETURN_PENDING" },
  { pattern: /空箱.*(已)?还|还空.*完成|empty.*returned/i, to: "EMPTY_RETURNED" },
];

/** Diff two order rows over the fleet-visible field list (§12.1). */
export function diffFleetVisibleFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, { from: unknown; to: unknown }> {
  const diff: Record<string, { from: unknown; to: unknown }> = {};
  for (const field of FLEET_VISIBLE_ORDER_FIELDS) {
    const a = before[field] instanceof Date ? (before[field] as Date).toISOString() : before[field];
    const b = after[field] instanceof Date ? (after[field] as Date).toISOString() : after[field];
    if (String(a ?? "") !== String(b ?? "")) diff[field] = { from: before[field], to: after[field] };
  }
  return diff;
}
