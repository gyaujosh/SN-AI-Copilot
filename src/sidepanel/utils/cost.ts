// Display helpers for session cost. Amounts are US dollars — every provider
// bills in them — so they always read as "$0.04", whatever the locale.

import { PRICES_CHECKED, type ArchivedCost, type SessionCost } from "../../shared/types";

const usdFormats = new Map<number, Intl.NumberFormat>();
function usd(value: number, digits: number): string {
  let format = usdFormats.get(digits);
  if (!format) {
    format = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits });
    usdFormats.set(digits, format);
  }
  return format.format(value);
}

/** "$0.04" at a glance; `precise` keeps four places under a dollar ("$0.0421").
 * A spend too small for cents still shows as spend, never as "$0.00". */
export function formatUsd(value: number, precise = false): string {
  if (!Number.isFinite(value) || value <= 0) return "$0.00";
  if (precise && value < 1) return usd(value, 4);
  if (value < 0.01) return usd(value, 4);
  return usd(value, 2);
}

/** "842", "18.2k", "182k", "1.24M". */
export function formatTokens(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return "0";
  if (count < 1000) return String(Math.round(count));
  if (count < 100_000) return `${trim((count / 1000).toFixed(1))}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  return `${trim((count / 1_000_000).toFixed(2))}M`;
}

function trim(fixed: string): string {
  return fixed.replace(/\.?0+$/, "");
}

/** Every token the provider processed: new input, cached input and output. */
export function totalTokens(cost: Pick<SessionCost, "inputTokens" | "outputTokens" | "cacheReadTokens">): number {
  return cost.inputTokens + cost.outputTokens + cost.cacheReadTokens;
}

/** A total that includes guesswork reads "≈ $0.04". */
export function isApproximate(cost: ArchivedCost): boolean {
  return cost.estimatedRequests > 0;
}

/** How the total was arrived at, in a sentence or two. */
export function costBasis(cost: ArchivedCost): string {
  if (cost.requests > 0 && cost.reportedRequests === cost.requests) return "Exact cost, as reported by OpenRouter.";
  const listed = `Estimated from list prices checked ${monthYear(PRICES_CHECKED)}; your provider's bill is final.`;
  if (!cost.estimatedRequests) return listed;
  const rough = cost.estimatedRequests === 1 ? "1 call is a rough estimate" : `${cost.estimatedRequests} calls are rough estimates`;
  return `${listed} ${rough} (a stopped answer, or a model missing from the price list, which is priced high on purpose).`;
}

function monthYear(isoDate: string): string {
  const d = new Date(`${isoDate}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? isoDate : d.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

/** One line for a saved chat: "$0.42 · 48.1k tokens". Chats saved before
 * tokens were recorded show their dollars only; older ones, nothing. */
export function sessionSpend(meta: { usd?: number; cost?: ArchivedCost }): string | null {
  if (meta.cost) return `${isApproximate(meta.cost) ? "≈ " : ""}${formatUsd(meta.cost.usd)} · ${formatTokens(totalTokens(meta.cost))} tokens`;
  return typeof meta.usd === "number" ? formatUsd(meta.usd) : null;
}
