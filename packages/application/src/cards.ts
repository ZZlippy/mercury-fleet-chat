import { formatMoney, FIELD_LABELS, type FleetVisibleOrderField } from "@mercury/domain";
import { fmtTs } from "./kernel.ts";

export interface OrderRow {
  id: string;
  public_reference: string;
  pickup_location_text: string;
  delivery_location_text: string;
  container_type: string;
  container_quantity: number;
  pickup_at: string;
  delivery_at: string | null;
  special_requirements: string | null;
  carrier_booking_reference?: string | null;
  bill_of_lading_reference?: string | null;
  shipping_line?: string | null;
  vessel_name?: string | null;
  voyage_number?: string | null;
  pickup_contact_name?: string | null;
  pickup_contact_phone?: string | null;
  delivery_contact_name?: string | null;
  delivery_contact_phone?: string | null;
  empty_container_pickup_location?: string | null;
  empty_container_return_location?: string | null;
  empty_container_return_deadline?: string | null;
  container_number?: string | null;
  seal_number?: string | null;
  cargo_description?: string | null;
  gross_weight_kg?: string | null;
  is_hazardous?: boolean;
  un_number?: string | null;
  is_reefer?: boolean;
  reefer_temperature_c?: string | null;
  version: number;
  order_type?: "EXPORT_DRAYAGE" | "IMPORT_DRAYAGE";
  service_country?: string;
  requested_start_at?: string;
  requested_complete_at?: string | null;
  loading_location?: string | null;
  origin_terminal?: string | null;
  destination_terminal?: string | null;
  delivery_location?: string | null;
  empty_container_pickup_at?: string | null;
  terminal_cutoff_at?: string | null;
}

export function rfqCard(order: OrderRow, rfqRef: string, revision: number) {
  const text = [
    `新询价 ${rfqRef}`,
    ``,
    `订单类型：${order.order_type === "EXPORT_DRAYAGE" ? "送港" : "提港"}（${order.service_country ?? "—"}）`,
    `路线：${order.pickup_location_text} → ${order.delivery_location_text}`,
    `箱型/数量：${order.container_type} × ${order.container_quantity}`,
    `计划开始：${fmtTs(order.requested_start_at ?? order.pickup_at)}`,
    `特殊要求：${order.special_requirements ?? "无"}`,
  ];
  if (order.shipping_line) text.push(`船公司：${order.shipping_line}`);
  if (order.order_type === "EXPORT_DRAYAGE") {
    text.push(
      `空箱提取：${order.empty_container_pickup_location ?? "待确认"}${order.empty_container_pickup_at ? ` · ${fmtTs(order.empty_container_pickup_at)}` : ""}`,
      `装货地点：${order.loading_location ?? "待确认"}`,
      `还重箱码头：${order.origin_terminal ?? "待确认"}`,
    );
  } else {
    text.push(
      `提重箱码头：${order.destination_terminal ?? "待确认"}`,
      `送货地点：${order.delivery_location ?? "待确认"}`,
      `还空箱地点：${order.empty_container_return_location ?? "待确认"}`,
    );
  }
  if (order.carrier_booking_reference) text.push(`订舱号：${order.carrier_booking_reference}`);
  if (order.container_number) text.push(`箱号：${order.container_number}`);
  if (order.cargo_description) text.push(`货物：${order.cargo_description}`);
  if (order.gross_weight_kg) text.push(`毛重：${order.gross_weight_kg} kg`);
  if (order.is_hazardous) text.push(`危险品：是${order.un_number ? `（${order.un_number}）` : ""}`);
  if (order.is_reefer) text.push(`冷藏要求：${order.reefer_temperature_c ?? "待确认"} °C`);
  text.push("", `请选择下一步。`);
  return {
    text: text.join("\n"),
    structured: {
      kind: "RFQ",
      reference: rfqRef,
      order: {
        pickup: order.pickup_location_text,
        delivery: order.delivery_location_text,
        container: `${order.container_type} × ${order.container_quantity}`,
        pickupAt: fmtTs(order.pickup_at),
        deliveryAt: order.delivery_at ? fmtTs(order.delivery_at) : null,
        special: order.special_requirements ?? "无",
        shippingLine: order.shipping_line ?? null,
        bookingReference: order.carrier_booking_reference ?? null,
        billOfLading: order.bill_of_lading_reference ?? null,
        vesselVoyage: [order.vessel_name, order.voyage_number].filter(Boolean).join(" / ") || null,
        pickupContact: [order.pickup_contact_name, order.pickup_contact_phone].filter(Boolean).join(" · ") || null,
        deliveryContact: [order.delivery_contact_name, order.delivery_contact_phone].filter(Boolean).join(" · ") || null,
        emptyPickup: order.empty_container_pickup_location ?? null,
        emptyReturn: order.empty_container_return_location ?? null,
        emptyReturnDeadline: order.empty_container_return_deadline ? fmtTs(order.empty_container_return_deadline) : null,
        containerNumber: order.container_number ?? null,
        sealNumber: order.seal_number ?? null,
        cargo: order.cargo_description ?? null,
        grossWeightKg: order.gross_weight_kg ?? null,
        hazardous: order.is_hazardous ?? false,
        unNumber: order.un_number ?? null,
        reefer: order.is_reefer ?? false,
        reeferTemperatureC: order.reefer_temperature_c ?? null,
        orderType: order.order_type ?? null,
        serviceCountry: order.service_country ?? null,
        loadingLocation: order.loading_location ?? null,
        originTerminal: order.origin_terminal ?? null,
        destinationTerminal: order.destination_terminal ?? null,
        deliveryLocation: order.delivery_location ?? null,
      },
      revision,
      orderVersion: order.version,
    },
  };
}

export function quoteConfirmationCard(input: {
  rfqRef: string;
  amount: string;
  currency: string;
  currencySource: string;
  isAllIn: boolean | null;
  terms: string | null;
  pickupAt: string;
}) {
  const money = formatMoney(input.currency, input.amount);
  const lines = [
    `我理解的报价如下：`,
    ``,
    `询价：${input.rfqRef}`,
    `价格：${money}${input.currencySource === "DEFAULTED" ? "（未注明币种，默认美元）" : ""}`,
  ];
  if (input.isAllIn) lines.push(`条件：全包`);
  if (input.terms) lines.push(`其他条件：${input.terms}`);
  lines.push(`适用提货时间：${fmtTs(input.pickupAt)}`, ``, `请确认提交，或告诉我需要修改的内容。`);
  return {
    text: lines.join("\n"),
    structured: {
      kind: "QUOTE_CONFIRMATION",
      reference: input.rfqRef,
      money,
      currency: input.currency,
      currencySource: input.currencySource,
      defaulted: input.currencySource === "DEFAULTED",
      isAllIn: input.isAllIn,
      terms: input.terms,
      pickupAt: fmtTs(input.pickupAt),
    },
  };
}

export function orderChangeCard(input: {
  rfqRef: string;
  revision: number;
  changes: Array<{ field: FleetVisibleOrderField; from: unknown; to: unknown }>;
  invalidatedMoney: string | null;
}) {
  const lines = [`询价 ${input.rfqRef} 已更新`, ``];
  const formatChangeValue = (field: FleetVisibleOrderField, value: unknown) => {
    if (field.endsWith("_at") || field.endsWith("_deadline")) return value ? fmtTs(value as string) : "无";
    if (typeof value === "boolean") return value ? "是" : "否";
    return String(value ?? "无");
  };
  for (const c of input.changes) {
    const from = formatChangeValue(c.field, c.from);
    const to = formatChangeValue(c.field, c.to);
    lines.push(`${FIELD_LABELS[c.field]}：`, `${from} → ${to}`, ``);
  }
  lines.push(
    input.invalidatedMoney
      ? `你之前的报价 ${input.invalidatedMoney} 已失效。请选择下一步。`
      : `条件已变更，请确认最新条件后回复。`,
  );
  return {
    text: lines.join("\n"),
    structured: {
      kind: "ORDER_CHANGE",
      reference: input.rfqRef,
      revision: input.revision,
      changes: input.changes.map((c) => ({
        label: FIELD_LABELS[c.field],
        from: formatChangeValue(c.field, c.from),
        to: formatChangeValue(c.field, c.to),
      })),
      invalidatedMoney: input.invalidatedMoney,
    },
  };
}

export function bookingOfferCard(input: {
  bookingRef: string;
  order: OrderRow;
  money: string;
}) {
  const text = [
    `任务确认 ${input.bookingRef}`,
    ``,
    `路线：${input.order.pickup_location_text} → ${input.order.delivery_location_text}`,
    `箱型/数量：${input.order.container_type} × ${input.order.container_quantity}`,
    `提货时间：${fmtTs(input.order.pickup_at)}`,
    `确认价格：${input.money}`,
    ``,
    `你的报价已被选中，请确认接受任务。`,
  ].join("\n");
  return {
    text,
    structured: {
      kind: "BOOKING_OFFER",
      reference: input.bookingRef,
      order: {
        pickup: input.order.pickup_location_text,
        delivery: input.order.delivery_location_text,
        container: `${input.order.container_type} × ${input.order.container_quantity}`,
        pickupAt: fmtTs(input.order.pickup_at),
        deliveryAt: input.order.delivery_at ? fmtTs(input.order.delivery_at) : null,
        special: input.order.special_requirements ?? "无",
      },
      money: input.money,
    },
  };
}

export const HANDOFF_TEXT = "这个情况需要运营人员确认。我已经转交处理，当前不会自动修改报价或运输状态。";
