import { describe, expect, it } from "vitest";
import {
  canBookingTransition, canQuoteTransition, canShipmentTransition, diffFleetVisibleFields,
} from "@mercury/domain";

describe("quote transitions (§7.4)", () => {
  it("allows the confirmation path", () => {
    expect(canQuoteTransition("PENDING_CONFIRMATION", "SUBMITTED")).toBe(true);
    expect(canQuoteTransition("DRAFT", "SUBMITTED")).toBe(true);
  });
  it("INVALIDATED is immutable — no transitions out", () => {
    for (const to of ["SUBMITTED", "DRAFT", "ACCEPTED", "WITHDRAWN", "EXPIRED"] as const) {
      expect(canQuoteTransition("INVALIDATED", to)).toBe(false);
    }
  });
  it("terminal states stay terminal", () => {
    expect(canQuoteTransition("ACCEPTED", "SUBMITTED")).toBe(false);
    expect(canQuoteTransition("REJECTED", "SUBMITTED")).toBe(false);
    expect(canQuoteTransition("WITHDRAWN", "SUBMITTED")).toBe(false);
  });
});

describe("shipment transitions (§11.11)", () => {
  it("allows only the next EXPORT milestone", () => {
    expect(canShipmentTransition("WAITING_EMPTY_CONTAINER_RELEASE", "EMPTY_CONTAINER_PICKED_UP", "EXPORT_DRAYAGE")).toBe(true);
    expect(canShipmentTransition("EMPTY_CONTAINER_PICKED_UP", "AT_LOADING_LOCATION", "EXPORT_DRAYAGE")).toBe(true);
    expect(canShipmentTransition("LOADED", "LADEN_CONTAINERS_RETURNED_TO_TERMINAL", "EXPORT_DRAYAGE")).toBe(false);
  });
  it("IMPORT delivery is not completion and empty return is mandatory", () => {
    expect(canShipmentTransition("IN_TRANSIT_TO_DELIVERY", "DELIVERED", "IMPORT_DRAYAGE")).toBe(true);
    expect(canShipmentTransition("DELIVERED", "COMPLETED", "IMPORT_DRAYAGE")).toBe(false);
    expect(canShipmentTransition("DELIVERED", "EMPTY_RETURN_PENDING", "IMPORT_DRAYAGE")).toBe(true);
    expect(canShipmentTransition("EMPTY_RETURN_PENDING", "EMPTY_RETURNED", "IMPORT_DRAYAGE")).toBe(true);
  });
  it("rejects cross-type and backwards movement", () => {
    expect(canShipmentTransition("WAITING_PORT_RELEASE", "EMPTY_CONTAINER_PICKED_UP", "IMPORT_DRAYAGE")).toBe(false);
    expect(canShipmentTransition("EMPTY_RETURNED", "DELIVERED", "IMPORT_DRAYAGE")).toBe(false);
  });
  it("COMPLETED is terminal and operator-only elsewhere", () => {
    expect(canShipmentTransition("COMPLETED", "REVIEW_PENDING", "IMPORT_DRAYAGE")).toBe(false);
  });
});

describe("booking transitions", () => {
  it("OFFERED → ACCEPTED / CANCELLED_BY_FLEET", () => {
    expect(canBookingTransition("OFFERED", "ACCEPTED")).toBe(true);
    expect(canBookingTransition("OFFERED", "CANCELLED_BY_FLEET")).toBe(true);
  });
  it("no resurrection of cancelled bookings", () => {
    expect(canBookingTransition("CANCELLED_BY_FLEET", "ACCEPTED")).toBe(false);
  });
});

describe("diffFleetVisibleFields (§12.1)", () => {
  it("detects fleet-visible changes only", () => {
    const before = { pickup_at: "2026-08-04T01:00:00Z", internal_notes: "a", container_type: "40HQ" };
    const after = { pickup_at: "2026-08-04T06:00:00Z", internal_notes: "b", container_type: "40HQ" };
    const diff = diffFleetVisibleFields(before, after);
    expect(Object.keys(diff)).toEqual(["pickup_at"]);
  });
  it("returns empty diff when nothing fleet-visible changed", () => {
    const before = { pickup_at: "x", internal_notes: "a" };
    const after = { pickup_at: "x", internal_notes: "zzz" };
    expect(Object.keys(diffFleetVisibleFields(before, after))).toHaveLength(0);
  });
});
