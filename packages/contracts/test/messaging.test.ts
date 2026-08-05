import { describe, expect, it } from "vitest";
import { SendMessageRequest } from "../src/index.ts";

const base = {
  clientMessageId: "00000000-0000-4000-8000-000000000001",
  text: "220全包",
};

describe("SendMessageRequest", () => {
  it("accepts an omitted reply target", () => {
    expect(SendMessageRequest.safeParse(base).success).toBe(true);
  });

  it("accepts a null reply target from JSON clients", () => {
    expect(SendMessageRequest.safeParse({ ...base, replyToMessageId: null }).success).toBe(true);
  });

  it("still rejects a non-UUID reply target", () => {
    expect(SendMessageRequest.safeParse({ ...base, replyToMessageId: "not-a-uuid" }).success).toBe(false);
  });
});
