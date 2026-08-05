import { z } from "zod";

// ---------------------------------------------------------------- auth
export const LoginRequest = z.object({
  username: z.string().trim().min(1).max(80),
  password: z.string().min(1),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

// ---------------------------------------------------------------- messaging
export const SendMessageRequest = z.object({
  clientMessageId: z.string().uuid(),
  text: z.string().min(1).max(4000),
  // JSON clients commonly send null for an empty optional reply target.
  replyToMessageId: z.string().uuid().nullish(),
});
export type SendMessageRequest = z.infer<typeof SendMessageRequest>;

export const ConsumeActionRequest = z.object({
  idempotencyKey: z.string().uuid(),
});
export type ConsumeActionRequest = z.infer<typeof ConsumeActionRequest>;

// ---------------------------------------------------------------- agent proposal (§10.3)
export const QuoteExtraction = z.object({
  amount: z.string().nullable(),
  currency: z.string().nullable(),
  currencyMention: z.enum(["EXPLICIT", "ABSENT", "AMBIGUOUS"]),
  isAllIn: z.boolean().nullable(),
  availableFrom: z.string().nullable(),
  validUntil: z.string().nullable(),
  terms: z.string().nullable(),
});

export const FleetIntentProposal = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal("SUBMIT_QUOTE_DRAFT"),
    confidence: z.number().min(0).max(1),
    context: z.object({
      rfqRecipientId: z.string().nullable(),
      orderVersion: z.number().nullable(),
      rfqRevision: z.number().nullable(),
    }),
    quote: QuoteExtraction,
    missingFields: z.array(z.string()),
    clarificationQuestion: z.string().nullable(),
  }),
  z.object({
    intent: z.enum(["DECLINE_RFQ", "ACK_REPLY_LATER", "REQUEST_HUMAN"]),
    confidence: z.number().min(0).max(1),
    context: z.object({
      rfqRecipientId: z.string().nullable(),
      rfqRevision: z.number().nullable(),
    }),
    reason: z.string().nullable(),
  }),
  z.object({
    intent: z.enum(["ASSIGN_RESOURCES", "UPDATE_SHIPMENT_STATUS", "UPLOAD_POD"]),
    confidence: z.number().min(0).max(1),
    context: z.record(z.string().nullable()),
    extracted: z.record(z.unknown()),
    clarificationQuestion: z.string().nullable(),
  }),
  z.object({
    intent: z.literal("UNKNOWN"),
    confidence: z.number().min(0).max(1),
    clarificationQuestion: z.string(),
  }),
]);
export type FleetIntentProposal = z.infer<typeof FleetIntentProposal>;

// ---------------------------------------------------------------- action payloads
export const AckPriceUnchangedPayload = z.object({
  invalidatedQuoteId: z.string().uuid(),
  rfqRecipientId: z.string().uuid(),
});
export const ConfirmQuotePayload = z.object({
  quoteId: z.string().uuid(),
  rfqRecipientId: z.string().uuid(),
});
export const BookingActionPayload = z.object({ bookingId: z.string().uuid() });
export const ConfirmAssignmentPayload = z.object({
  bookingId: z.string().uuid(),
  driverId: z.string().uuid().nullable(),
  vehicleId: z.string().uuid().nullable(),
  createDriverName: z.string().nullable(),
  createVehiclePlate: z.string().nullable(),
});
export const ConfirmShipmentStatusPayload = z.object({
  shipmentId: z.string().uuid(),
  toStatus: z.string(),
});
export const SelectRfqContextPayload = z.object({
  rfqRecipientId: z.string().uuid(),
  pendingText: z.string(),
  sourceMessageId: z.string().uuid().optional(),
});

// ---------------------------------------------------------------- typed command results (§15)
export const CommandErrorCode = z.enum([
  "STALE_REVISION",
  "AMBIGUOUS_CONTEXT",
  "AMBIGUOUS_CURRENCY",
  "FORBIDDEN",
  "INVALID_TRANSITION",
  "ACTION_ALREADY_CONSUMED",
  "ACTION_UNAVAILABLE",
  "NOT_FOUND",
  "VALIDATION",
  "CONFLICT",
]);
export type CommandErrorCode = z.infer<typeof CommandErrorCode>;

export interface CommandOk<T = unknown> {
  ok: true;
  duplicate?: boolean;
  result: T;
}
export interface CommandErr {
  ok: false;
  code: CommandErrorCode;
  message: string;
  detail?: unknown;
}
export type CommandResult<T = unknown> = CommandOk<T> | CommandErr;

export const err = (code: CommandErrorCode, message: string, detail?: unknown): CommandErr => ({
  ok: false,
  code,
  message,
  detail,
});
export const ok = <T>(result: T, duplicate = false): CommandOk<T> => ({ ok: true, duplicate, result });
