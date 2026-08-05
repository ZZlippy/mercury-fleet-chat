/**
 * Structured card renderers. Cards are the "paperwork" of the conversation —
 * styled like waybill extracts: manifest header, dashed rules, mono values.
 */

function Row({ label, value, mono }: { label: string; value: unknown; mono?: boolean }) {
  if (value == null || value === "") return null;
  return (
    <div className="card-row">
      <span className="card-label">{label}</span>
      <span className={mono ? "card-value mono" : "card-value"}>{String(value)}</span>
    </div>
  );
}

function OrderRows({ order }: { order: Record<string, any> }) {
  return (
    <>
      <Row label="提货" value={order.pickup} />
      <Row label="送达" value={order.delivery} />
      <Row label="柜型" value={order.container} mono />
      <Row label="提货时间" value={order.pickupAt} mono />
      {order.deliveryAt ? <Row label="送达时间" value={order.deliveryAt} mono /> : null}
      <Row label="船公司" value={order.shippingLine} />
      <Row label="订舱号" value={order.bookingReference} mono />
      <Row label="船名 / 航次" value={order.vesselVoyage} />
      <Row label="箱号" value={order.containerNumber} mono />
      <Row label="封条号" value={order.sealNumber} mono />
      <Row label="货物" value={order.cargo} />
      {order.grossWeightKg ? <Row label="毛重" value={`${order.grossWeightKg} kg`} mono /> : null}
      {order.hazardous ? <Row label="危险品" value={order.unNumber ? `是 · ${order.unNumber}` : "是"} /> : null}
      {order.reefer ? <Row label="冷藏" value={`${order.reeferTemperatureC ?? "待确认"} °C`} mono /> : null}
      <Row label="提货联系人" value={order.pickupContact} />
      <Row label="送达联系人" value={order.deliveryContact} />
      <Row label="空箱提取" value={order.emptyPickup} />
      <Row label="空箱归还" value={order.emptyReturn} />
      <Row label="归还截止" value={order.emptyReturnDeadline} mono />
      <Row label="特殊要求" value={order.special} />
    </>
  );
}

export function StructuredCard({ data }: { data: Record<string, any> }) {
  switch (data.kind) {
    case "RFQ":
      return (
        <div className="card card-rfq">
          <div className="card-head">
            <span className="card-kind">新询价</span>
            <span className="card-ref mono">{data.reference}</span>
          </div>
          <OrderRows order={data.order ?? {}} />
          {data.revision > 1 ? <div className="card-foot">修订 rev.{data.revision}</div> : null}
        </div>
      );

    case "QUOTE_CONFIRMATION":
      return (
        <div className="card card-quote">
          <div className="card-head">
            <span className="card-kind">报价确认</span>
            <span className="card-ref mono">{data.reference}</span>
          </div>
          <div className="card-amount mono">{data.money}</div>
          {data.isAllIn ? <div className="card-tag">全包</div> : null}
          {data.defaulted ? <div className="card-note">未注明币种，默认美元（USD）</div> : null}
          {data.terms ? <Row label="条款" value={data.terms} /> : null}
          <Row label="提货时间" value={data.pickupAt} mono />
        </div>
      );

    case "ORDER_CHANGE":
      return (
        <div className="card card-change">
          <div className="card-head">
            <span className="card-kind">询价已更新</span>
            <span className="card-ref mono">
              {data.reference} · rev.{data.revision}
            </span>
          </div>
          {(data.changes ?? []).map((c: any, i: number) => (
            <div className="card-row" key={i}>
              <span className="card-label">{c.label}</span>
              <span className="card-value mono">
                <s>{c.from}</s> → <strong>{c.to}</strong>
              </span>
            </div>
          ))}
          {data.invalidatedMoney ? (
            <div className="card-note warn">你之前的报价 {data.invalidatedMoney} 已失效</div>
          ) : null}
        </div>
      );

    case "BOOKING_OFFER":
      return (
        <div className="card card-booking">
          <div className="card-head">
            <span className="card-kind">任务确认</span>
            <span className="card-ref mono">{data.reference}</span>
          </div>
          <div className="card-amount mono">{data.money}</div>
          <OrderRows order={data.order ?? {}} />
        </div>
      );

    case "ASSIGNMENT_CONFIRMATION":
      return (
        <div className="card">
          <div className="card-head">
            <span className="card-kind">安排确认</span>
            <span className="card-ref mono">{data.reference}</span>
          </div>
          <Row label="司机" value={`${data.driver}${data.driverIsNew ? "（新建）" : ""}`} />
          <Row label="车牌" value={`${data.plate}${data.vehicleIsNew ? "（新建）" : ""}`} mono />
        </div>
      );

    case "SHIPMENT_STATUS_CONFIRMATION":
      return (
        <div className="card">
          <div className="card-head">
            <span className="card-kind">状态更新</span>
            <span className="card-ref mono">{data.reference}</span>
          </div>
          <div className="card-row">
            <span className="card-value mono">
              {data.from} → <strong>{data.to}</strong>
            </span>
          </div>
        </div>
      );

    default:
      return null;
  }
}
