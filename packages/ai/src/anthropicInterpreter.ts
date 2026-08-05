import { FleetIntentProposal } from "@mercury/contracts";
import { interpretWithRules } from "./ruleInterpreter.ts";
import type { InterpreterContext } from "./types.ts";

const SYSTEM_PROMPT = `You are Mercury's Fleet Agent intent extractor for a container-trucking logistics platform.
You receive one inbound fleet message plus trusted business context. Return ONLY a JSON object matching the FleetIntentProposal schema — no prose, no markdown fences.

Rules (mandatory):
- Never infer that a bare "$" means USD: set currencyMention "AMBIGUOUS".
- If no currency is mentioned at all, set currencyMention "ABSENT" and currency null (the application defaults to USD, not you).
- "USD 220" / "US$220" => currency "USD", currencyMention "EXPLICIT". "SGD 220" / "S$220" => "SGD", "EXPLICIT".
- Amounts are decimal strings, e.g. "220.00".
- Intents: SUBMIT_QUOTE_DRAFT, DECLINE_RFQ, ACK_REPLY_LATER, REQUEST_HUMAN, ASSIGN_RESOURCES, UPDATE_SHIPMENT_STATUS, UPLOAD_POD, UNKNOWN.
- For ASSIGN_RESOURCES put driverName/plateNumber in "extracted". For UPDATE_SHIPMENT_STATUS put toStatus (one of WAITING_ASSIGNMENT, DRIVER_ASSIGNED, EN_ROUTE_TO_PICKUP, AT_PICKUP, PICKED_UP, IN_TRANSIT, AT_DELIVERY, DELIVERED, POD_SUBMITTED, COMPLETED) in "extracted".
- When unsure, use UNKNOWN with a clarificationQuestion. Never invent business IDs; copy them from context or use null.
Schema per intent:
SUBMIT_QUOTE_DRAFT: {intent, confidence, context:{rfqRecipientId,orderVersion,rfqRevision}, quote:{amount,currency,currencyMention,isAllIn,availableFrom,validUntil,terms}, missingFields:[], clarificationQuestion}
DECLINE_RFQ|ACK_REPLY_LATER|REQUEST_HUMAN: {intent, confidence, context:{rfqRecipientId,rfqRevision}, reason}
ASSIGN_RESOURCES|UPDATE_SHIPMENT_STATUS|UPLOAD_POD: {intent, confidence, context:{...}, extracted:{...}, clarificationQuestion}
UNKNOWN: {intent, confidence, clarificationQuestion}`;

/**
 * Anthropic-API-backed interpreter. Output is Zod-validated; on any failure
 * (no key, network, invalid JSON, schema violation) it falls back to the
 * deterministic rule interpreter so the pipeline never depends on the LLM
 * being available — and the LLM can never emit an unvalidated proposal.
 */
export function createAnthropicInterpreter(apiKey = process.env.ANTHROPIC_API_KEY) {
  return {
    name: "anthropic",
    async interpret(text: string, ctx: InterpreterContext): Promise<FleetIntentProposal> {
      if (!apiKey) return interpretWithRules(text, ctx);
      try {
        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          signal: AbortSignal.timeout(Number(process.env.MODEL_TIMEOUT_MS ?? 10_000)),
          headers: {
            "content-type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model: process.env.ANTHROPIC_MODEL ?? "claude-sonnet-4-6",
            max_tokens: 800,
            system: SYSTEM_PROMPT,
            messages: [
              {
                role: "user",
                content: `Context (trusted, do not modify IDs):\n${JSON.stringify({
                  rfqRecipientId: ctx.rfqRecipientId ?? null,
                  rfqRevision: ctx.rfqRevision ?? null,
                  orderVersion: ctx.orderVersion ?? null,
                  bookingId: ctx.bookingId ?? null,
                  shipmentId: ctx.shipmentId ?? null,
                  shipmentStatus: ctx.shipmentStatus ?? null,
                  rfqSummary: ctx.rfqSummary ?? null,
                })}\n\nInbound fleet message:\n${text}`,
              },
            ],
          }),
        });
        if (!res.ok) throw new Error(`anthropic http ${res.status}`);
        const data = (await res.json()) as { content: Array<{ type: string; text?: string }> };
        const raw = data.content.find((c) => c.type === "text")?.text ?? "";
        const json = JSON.parse(raw.replace(/```json|```/g, "").trim());
        return FleetIntentProposal.parse(json); // schema-validated (§3.6)
      } catch (error) {
        if (process.env.NODE_ENV !== "test") {
          console.warn(JSON.stringify({
            level: "warn",
            component: "fleet_interpreter",
            provider: "anthropic",
            fallback: "rule",
            error: error instanceof Error ? error.message : String(error),
          }));
        }
        // The deterministic interpreter is the safe floor.
        return interpretWithRules(text, ctx);
      }
    },
  };
}
