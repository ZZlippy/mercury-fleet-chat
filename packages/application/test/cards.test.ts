import { describe, expect, it } from "vitest";
import { bookingOfferCard, orderChangeCard, rfqCard, type OrderRow } from "../src/cards.ts";

const order: OrderRow = {
  id: "order-1",
  public_reference: "M-1001",
  pickup_location_text: "PSA",
  delivery_location_text: "Jurong",
  container_type: "40HQ",
  container_quantity: 2,
  pickup_at: "2026-08-04T01:00:00Z",
  delivery_at: null,
  special_requirements: "需要尾板",
  version: 3,
};

describe("structured card contracts", () => {
  it("RFQ card uses the nested order shape consumed by the web renderer", () => {
    const card = rfqCard(order, "RFQ-1001", 3);
    expect(card.structured).toMatchObject({
      kind: "RFQ",
      reference: "RFQ-1001",
      revision: 3,
      orderVersion: 3,
      order: {
        pickup: "PSA",
        delivery: "Jurong",
        container: "40HQ × 2",
        special: "需要尾板",
      },
    });
  });

  it("booking card uses the same nested order shape", () => {
    const card = bookingOfferCard({ bookingRef: "B-1001", order, money: "USD 220.00" });
    expect(card.structured).toMatchObject({
      kind: "BOOKING_OFFER",
      reference: "B-1001",
      money: "USD 220.00",
      order: {
        pickup: "PSA",
        delivery: "Jurong",
        container: "40HQ × 2",
      },
    });
  });

  it("order-change card includes the revision displayed by the web renderer", () => {
    const card = orderChangeCard({
      rfqRef: "RFQ-1001",
      revision: 4,
      changes: [{ field: "container_quantity", from: 1, to: 2 }],
      invalidatedMoney: "USD 220.00",
    });
    expect(card.structured).toMatchObject({
      kind: "ORDER_CHANGE",
      reference: "RFQ-1001",
      revision: 4,
      invalidatedMoney: "USD 220.00",
    });
  });
});
