import type { FleetIntentProposal } from "@mercury/contracts";

/**
 * Trusted runtime context assembled by the application layer (§15): the model
 * never supplies identity or business IDs — they come from resolved context.
 */
export interface InterpreterContext {
  fleetOrganizationId: string;
  rfqRecipientId?: string | null;
  rfqRevision?: number | null;
  orderVersion?: number | null;
  bookingId?: string | null;
  shipmentId?: string | null;
  shipmentStatus?: string | null;
  hasActiveBooking?: boolean;
  rfqSummary?: string | null;
}

export interface FleetInterpreter {
  name: string;
  interpret(text: string, ctx: InterpreterContext): Promise<FleetIntentProposal>;
}
