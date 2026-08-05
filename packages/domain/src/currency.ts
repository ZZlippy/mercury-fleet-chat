/**
 * Deterministic quote-text parsing (spec §3.5, §10.1).
 * Monetary amounts are handled as decimal strings — never floats.
 */

export type CurrencyMention = "EXPLICIT" | "ABSENT" | "AMBIGUOUS";

export interface ParsedQuoteText {
  amount: string; // normalized decimal string, 2dp
  currency: "USD" | "SGD" | null; // null when ABSENT or AMBIGUOUS
  currencyMention: CurrencyMention;
  isAllIn: boolean;
  terms: string | null; // extra conditions (waiting charges etc.)
}

const ALL_IN_PATTERNS = [/all[\s-]?in/i, /全包/, /包干/];

/** Normalize an amount string like "220" / "220.5" to 2dp decimal string. */
export function normalizeAmount(raw: string): string | null {
  const cleaned = raw.replace(/,/g, "").trim();
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return null;
  const [int, frac = ""] = cleaned.split(".");
  if (frac.length > 2) return null; // reject sub-cent precision
  const fracPadded = (frac + "00").slice(0, 2);
  if (BigInt(int) === 0n && fracPadded === "00") return null; // zero is not a quote
  return `${BigInt(int)}.${fracPadded}`;
}

export function formatMoney(currency: string, amount: string): string {
  const norm = normalizeAmount(amount) ?? amount;
  const [int, frac = "00"] = norm.split(".");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${currency} ${grouped}.${frac}`;
}

/**
 * Parse a free-form fleet message for a price quote.
 * Returns null when no leading/primary amount is found.
 *
 * Rules:
 *  - `USD 220`, `US$220`      → USD, EXPLICIT
 *  - `SGD 220`, `S$220`, `新币` → SGD, EXPLICIT
 *  - bare `$220`              → AMBIGUOUS (never infer USD)
 *  - `220`, `220全包`          → ABSENT (application layer defaults to USD)
 */
export function parseQuoteText(text: string): ParsedQuoteText | null {
  const t = text.trim();

  // Explicit USD: "USD 220", "US$ 220", "美金220", "美元220", "220 USD", "220美金"
  let m =
    t.match(/(?:USD|US\$|U\$|美金|美元)\s*([\d,]+(?:\.\d+)?)/i) ??
    t.match(/([\d,]+(?:\.\d+)?)\s*(?:USD|美金|美元)/i);
  if (m) return build(m[1], "USD", "EXPLICIT", t);

  // Explicit SGD: "SGD 220", "S$220", "新币220", "坡币220", "220 SGD", "220新币"
  m =
    t.match(/(?:SGD|S\$|新币|坡币|新元)\s*([\d,]+(?:\.\d+)?)/i) ??
    t.match(/([\d,]+(?:\.\d+)?)\s*(?:SGD|新币|坡币|新元)/i);
  if (m) return build(m[1], "SGD", "EXPLICIT", t);

  // Bare $ — ambiguous, requires clarification. Must be checked before ABSENT.
  m = t.match(/(?<![A-Za-z])\$\s*([\d,]+(?:\.\d+)?)/);
  if (m) return build(m[1], null, "AMBIGUOUS", t);

  // No currency at all: leading number, e.g. "220", "220全包", "220，等候超过两小时每小时50"
  m = t.match(/^([\d,]+(?:\.\d+)?)(?![\d.%/])/);
  if (m) return build(m[1], null, "ABSENT", t);

  return null;
}

function build(
  rawAmount: string,
  currency: "USD" | "SGD" | null,
  mention: CurrencyMention,
  fullText: string,
): ParsedQuoteText | null {
  const amount = normalizeAmount(rawAmount);
  if (amount === null) return null;
  const isAllIn = ALL_IN_PATTERNS.some((p) => p.test(fullText));
  // Anything beyond the bare amount/currency/all-in marker is preserved as terms
  // for the mandatory human confirmation step (§10.1 waiting-charge example).
  let terms: string | null = null;
  const remainder = fullText
    .replace(/(?:USD|US\$|U\$|美金|美元|SGD|S\$|新币|坡币|新元|\$)/gi, " ")
    .replace(rawAmount, " ")
    .replace(/all[\s-]?in/gi, " ")
    .replace(/全包|包干/g, " ")
    .replace(/[，,。.\s]+/g, " ")
    .trim();
  if (remainder.length > 0) terms = remainder;
  return { amount, currency, currencyMention: mention, isAllIn, terms };
}

/** Apply the USD default rule (§3.5). Only for ABSENT — never for AMBIGUOUS. */
export function resolveCurrency(parsed: ParsedQuoteText): {
  currency: "USD" | "SGD";
  source: "EXPLICIT" | "DEFAULTED";
} | null {
  if (parsed.currencyMention === "EXPLICIT" && parsed.currency) {
    return { currency: parsed.currency, source: "EXPLICIT" };
  }
  if (parsed.currencyMention === "ABSENT") {
    return { currency: "USD", source: "DEFAULTED" };
  }
  return null; // AMBIGUOUS → caller must ask for clarification
}
