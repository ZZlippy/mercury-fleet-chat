import { FleetIntentProposal } from "@mercury/contracts";
import { parseQuoteText, SHIPMENT_PHRASES } from "@mercury/domain";
import type { InterpreterContext } from "./types.ts";

/**
 * Deterministic rule-based interpreter. It implements the full agent contract
 * (§10.3, §23.3) and is the default in development/tests. The Anthropic-backed
 * interpreter (anthropicInterpreter.ts) produces the same typed proposal and
 * falls back to this one when no API key is configured or the call fails.
 */
export function interpretWithRules(text: string, ctx: InterpreterContext): FleetIntentProposal {
  const t = text.trim();

  // Human handoff request
  if (/(转人工|找运营|联系运营|人工客服|human|operator)/i.test(t)) {
    return {
      intent: "REQUEST_HUMAN",
      confidence: 0.95,
      context: { rfqRecipientId: ctx.rfqRecipientId ?? null, rfqRevision: ctx.rfqRevision ?? null },
      reason: t,
    };
  }

  // Decline: 不能做 / 无法承运 / 没车 / can't do
  if (/(不能做|做不了|无法承运|接不了|跑不了|没车|没有车|cannot|can'?t\s+do|decline)/i.test(t)) {
    return {
      intent: "DECLINE_RFQ",
      confidence: 0.9,
      context: { rfqRecipientId: ctx.rfqRecipientId ?? null, rfqRevision: ctx.rfqRevision ?? null },
      reason: t,
    };
  }

  // Reply later
  if (/(稍后回复|晚点回|等下回|later|回头说)/i.test(t)) {
    return {
      intent: "ACK_REPLY_LATER",
      confidence: 0.9,
      context: { rfqRecipientId: ctx.rfqRecipientId ?? null, rfqRevision: ctx.rfqRevision ?? null },
      reason: null,
    };
  }

  // "价格不变" free-text — only meaningful against a pending reconfirmation.
  // The application layer maps this onto the current contextual action; the
  // interpreter only classifies it as a quote intent carrying no new amount.
  if (/价格不变|price\s*unchanged|same\s*price/i.test(t)) {
    return {
      intent: "SUBMIT_QUOTE_DRAFT",
      confidence: 0.85,
      context: {
        rfqRecipientId: ctx.rfqRecipientId ?? null,
        orderVersion: ctx.orderVersion ?? null,
        rfqRevision: ctx.rfqRevision ?? null,
      },
      quote: {
        amount: null,
        currency: null,
        currencyMention: "ABSENT",
        isAllIn: null,
        availableFrom: null,
        validUntil: null,
        terms: "PRICE_UNCHANGED",
      },
      missingFields: [],
      clarificationQuestion: null,
    };
  }

  // Driver/vehicle assignment: 司机陈师傅，车牌 SGB1234A
  const driverMatch = t.match(/司机[:：\s]*([^\s，,。;；]+)/);
  const plateMatch = t.match(/车牌[:：\s]*([A-Za-z0-9]+)/) ?? t.match(/\b([A-Z]{2,3}\d{3,4}[A-Z]?)\b/);
  if (driverMatch || (plateMatch && ctx.hasActiveBooking)) {
    return {
      intent: "ASSIGN_RESOURCES",
      confidence: driverMatch && plateMatch ? 0.9 : 0.6,
      context: { bookingId: ctx.bookingId ?? null },
      extracted: {
        driverName: driverMatch?.[1] ?? null,
        plateNumber: plateMatch?.[1]?.toUpperCase() ?? null,
      },
      clarificationQuestion:
        driverMatch && plateMatch ? null : "请同时提供司机姓名和车牌号，例如：司机陈师傅，车牌 SGB1234A",
    };
  }

  // Shipment status phrases
  for (const { pattern, to } of SHIPMENT_PHRASES) {
    if (pattern.test(t)) {
      return {
        intent: "UPDATE_SHIPMENT_STATUS",
        confidence: 0.85,
        context: { shipmentId: ctx.shipmentId ?? null },
        extracted: { toStatus: to },
        clarificationQuestion: null,
      };
    }
  }

  // POD statement (text-only; actual files arrive via upload endpoint)
  if (/(POD|回单|签收单|水单)/i.test(t)) {
    return {
      intent: "UPLOAD_POD",
      confidence: 0.8,
      context: { shipmentId: ctx.shipmentId ?? null },
      extracted: {},
      clarificationQuestion: null,
    };
  }

  // Price quote
  const parsed = parseQuoteText(t);
  if (parsed) {
    return {
      intent: "SUBMIT_QUOTE_DRAFT",
      confidence: parsed.currencyMention === "AMBIGUOUS" ? 0.7 : 0.9,
      context: {
        rfqRecipientId: ctx.rfqRecipientId ?? null,
        orderVersion: ctx.orderVersion ?? null,
        rfqRevision: ctx.rfqRevision ?? null,
      },
      quote: {
        amount: parsed.amount,
        currency: parsed.currency,
        currencyMention: parsed.currencyMention,
        isAllIn: parsed.isAllIn || null,
        availableFrom: null,
        validUntil: null,
        terms: parsed.terms,
      },
      missingFields: [],
      clarificationQuestion:
        parsed.currencyMention === "AMBIGUOUS" ? `请确认币种：USD ${parsed.amount} 还是 SGD ${parsed.amount}？` : null,
    };
  }

  return {
    intent: "UNKNOWN",
    confidence: 0.3,
    clarificationQuestion: "抱歉，我没有理解。请回复价格（如 220 或 USD 220）、无法承运、或需要人工协助。",
  };
}
