// Model pricing → USD cost per model call.
// List prices checked against Anthropic's and OpenAI's published rates on
// PRICES_CHECKED (src/shared/types.ts); update both when a provider changes
// them. OpenRouter calls carry an exact cost straight from the API
// (usage.cost), which always wins over this table.
//
// Never silently $0: model ids are normalized and prefix-matched against the
// table (dated ids like claude-sonnet-5-20250929 and vendor/ ids both hit),
// and anything still unknown is priced with a deliberately HIGH per-provider
// fallback and flagged `estimated` — underpricing costs real money.

import type { ProviderId } from "../shared/types";
import type { UsageInfo } from "./providers/types";

interface ModelPrice {
  inPerMTok: number; // USD per 1M input tokens
  outPerMTok: number; // USD per 1M output tokens
  cacheWriteMultiplier?: number; // × input price (Anthropic: 1.25)
  cacheReadMultiplier?: number; // × input price (Anthropic: 0.1)
  /** Requests whose prompt exceeds `overInputTokens` bill every token at the higher tier. */
  longContext?: { overInputTokens: number; inMultiplier: number; outMultiplier: number };
}

const ANTHROPIC_CACHE = { cacheWriteMultiplier: 1.25, cacheReadMultiplier: 0.1 };
/** OpenAI's long-context tier: above 272K prompt tokens, input ×2 and output ×1.5. */
const OPENAI_LONG = { longContext: { overInputTokens: 272_000, inMultiplier: 2, outMultiplier: 1.5 } };

const PRICE_TABLE: Record<string, ModelPrice> = {
  // Anthropic
  "claude-fable-5-1": { inPerMTok: 10, outPerMTok: 50, cacheWriteMultiplier: 1.25, cacheReadMultiplier: 0.025 },
  "claude-fable-5": { inPerMTok: 10, outPerMTok: 50, ...ANTHROPIC_CACHE },
  "claude-opus-5-5": { inPerMTok: 4, outPerMTok: 20, cacheWriteMultiplier: 1.25, cacheReadMultiplier: 0.05 },
  "claude-opus-5": { inPerMTok: 5, outPerMTok: 25, ...ANTHROPIC_CACHE },
  "claude-opus-4-8": { inPerMTok: 5, outPerMTok: 25, ...ANTHROPIC_CACHE },
  "claude-opus-4-7": { inPerMTok: 5, outPerMTok: 25, ...ANTHROPIC_CACHE },
  "claude-opus-4-6": { inPerMTok: 5, outPerMTok: 25, ...ANTHROPIC_CACHE },
  "claude-opus-4-5": { inPerMTok: 5, outPerMTok: 25, ...ANTHROPIC_CACHE },
  "claude-opus-4-1": { inPerMTok: 15, outPerMTok: 75, ...ANTHROPIC_CACHE },
  "claude-opus-4": { inPerMTok: 15, outPerMTok: 75, ...ANTHROPIC_CACHE },
  "claude-sonnet-5": { inPerMTok: 2, outPerMTok: 10, ...ANTHROPIC_CACHE },
  "claude-sonnet-4-6": { inPerMTok: 3, outPerMTok: 15, ...ANTHROPIC_CACHE },
  "claude-sonnet-4-5": { inPerMTok: 3, outPerMTok: 15, ...ANTHROPIC_CACHE },
  "claude-sonnet-4": { inPerMTok: 3, outPerMTok: 15, ...ANTHROPIC_CACHE },
  "claude-3-7-sonnet": { inPerMTok: 3, outPerMTok: 15, ...ANTHROPIC_CACHE },
  "claude-haiku-4-5": { inPerMTok: 1, outPerMTok: 5, ...ANTHROPIC_CACHE },
  "claude-3-5-haiku": { inPerMTok: 0.8, outPerMTok: 4, ...ANTHROPIC_CACHE },
  // OpenAI (standard tier). Cache writes, where OpenAI charges them, are not
  // reported in the usage chunk, so they count at the plain input price.
  "gpt-6-astra": { inPerMTok: 10, outPerMTok: 50, cacheReadMultiplier: 0.1, ...OPENAI_LONG },
  "gpt-6-sol": { inPerMTok: 2, outPerMTok: 10, cacheReadMultiplier: 0.1, ...OPENAI_LONG },
  "gpt-6-luna": { inPerMTok: 0.1, outPerMTok: 0.5, cacheReadMultiplier: 0.1, ...OPENAI_LONG },
  "gpt-5.6-sol": { inPerMTok: 4, outPerMTok: 20, cacheReadMultiplier: 0.1, ...OPENAI_LONG },
  "gpt-5.6-terra": { inPerMTok: 2, outPerMTok: 12, cacheReadMultiplier: 0.1, ...OPENAI_LONG },
  "gpt-5.6-luna": { inPerMTok: 0.2, outPerMTok: 1.2, cacheReadMultiplier: 0.1, ...OPENAI_LONG },
  "gpt-5.5-pro": { inPerMTok: 30, outPerMTok: 180, ...OPENAI_LONG },
  "gpt-5.5": { inPerMTok: 5, outPerMTok: 30, cacheReadMultiplier: 0.1, ...OPENAI_LONG },
  "gpt-5.4-pro": { inPerMTok: 30, outPerMTok: 180, ...OPENAI_LONG },
  "gpt-5.4-mini": { inPerMTok: 0.75, outPerMTok: 4.5, cacheReadMultiplier: 0.1 },
  "gpt-5.4-nano": { inPerMTok: 0.2, outPerMTok: 1.25, cacheReadMultiplier: 0.1 },
  "gpt-5.4": { inPerMTok: 2.5, outPerMTok: 15, cacheReadMultiplier: 0.1, ...OPENAI_LONG },
  "gpt-5.3-codex": { inPerMTok: 1.75, outPerMTok: 14, cacheReadMultiplier: 0.1 },
  "gpt-5.2-pro": { inPerMTok: 21, outPerMTok: 168 },
  "gpt-5.2": { inPerMTok: 1.75, outPerMTok: 14, cacheReadMultiplier: 0.1 },
  "gpt-5.1": { inPerMTok: 1.25, outPerMTok: 10, cacheReadMultiplier: 0.1 },
  "gpt-5-pro": { inPerMTok: 15, outPerMTok: 120 },
  "gpt-5-mini": { inPerMTok: 0.25, outPerMTok: 2, cacheReadMultiplier: 0.1 },
  "gpt-5-nano": { inPerMTok: 0.05, outPerMTok: 0.4, cacheReadMultiplier: 0.1 },
  "gpt-5": { inPerMTok: 1.25, outPerMTok: 10, cacheReadMultiplier: 0.1 },
  "o1-pro": { inPerMTok: 150, outPerMTok: 600 },
  o1: { inPerMTok: 15, outPerMTok: 60, cacheReadMultiplier: 0.5 },
  "o3-pro": { inPerMTok: 20, outPerMTok: 80 },
  "o3-mini": { inPerMTok: 1.1, outPerMTok: 4.4, cacheReadMultiplier: 0.5 },
  o3: { inPerMTok: 2, outPerMTok: 8, cacheReadMultiplier: 0.25 },
  "o4-mini": { inPerMTok: 1.1, outPerMTok: 4.4, cacheReadMultiplier: 0.25 },
  "gpt-4.1-mini": { inPerMTok: 0.4, outPerMTok: 1.6, cacheReadMultiplier: 0.25 },
  "gpt-4.1-nano": { inPerMTok: 0.1, outPerMTok: 0.4, cacheReadMultiplier: 0.25 },
  "gpt-4.1": { inPerMTok: 2, outPerMTok: 8, cacheReadMultiplier: 0.25 },
  "gpt-4o-2024-05-13": { inPerMTok: 5, outPerMTok: 15 },
  "gpt-4o-mini": { inPerMTok: 0.15, outPerMTok: 0.6, cacheReadMultiplier: 0.5 },
  "gpt-4o": { inPerMTok: 2.5, outPerMTok: 10, cacheReadMultiplier: 0.5 },
  "gpt-4-turbo": { inPerMTok: 10, outPerMTok: 30 },
  "gpt-4": { inPerMTok: 30, outPerMTok: 60 },
  "gpt-3.5-turbo": { inPerMTok: 0.5, outPerMTok: 1.5 },
};

/** Flagship-level fallback per provider — deliberately high so an unknown
 * model is over-counted rather than silently under-counted. */
const FALLBACK_PRICE: Record<ProviderId, ModelPrice> = {
  anthropic: { inPerMTok: 10, outPerMTok: 50, ...ANTHROPIC_CACHE },
  openai: { inPerMTok: 30, outPerMTok: 180 },
  openrouter: { inPerMTok: 10, outPerMTok: 50 },
};

/** "anthropic/Claude-Opus-4.8-20260115:free" → "claude-opus-4-8" */
function normalizeModelId(modelId: string): string {
  let id = modelId.trim().toLowerCase();
  if (id.includes("/")) id = id.split("/").pop()!; // strip vendor prefix
  id = id.split(":")[0]; // strip openrouter variant tags (:free, :extended…)
  id = id.replace(/(claude|opus|sonnet|haiku|fable)-(\d+)\.(\d+)/g, "$1-$2-$3"); // 4.8 → 4-8 (claude ids only)
  id = id.replace(/-20\d{6,7}$/, ""); // -20250929 date stamps
  id = id.replace(/-\d{4}-\d{2}-\d{2}$/, ""); // -2025-09-29
  id = id.replace(/-latest$/, "");
  return id;
}

function findPrice(modelId: string): ModelPrice | null {
  const raw = modelId.trim().toLowerCase();
  if (PRICE_TABLE[raw]) return PRICE_TABLE[raw];
  const norm = normalizeModelId(modelId);
  if (PRICE_TABLE[norm]) return PRICE_TABLE[norm];
  // Longest table key that prefixes the normalized id at a "-" boundary
  // (sonnet-5-x → sonnet-5). The boundary keeps a newer version from taking
  // an older one's price: gpt-5.7 is not gpt-5.
  let best: ModelPrice | null = null;
  let bestLen = 0;
  for (const [key, price] of Object.entries(PRICE_TABLE)) {
    if (norm.startsWith(key + "-") && key.length > bestLen) {
      best = price;
      bestLen = key.length;
    }
  }
  return best;
}

function priceUsage(price: ModelPrice, usage: UsageInfo): number {
  const promptTokens = usage.inputTokens + usage.cacheWriteTokens + usage.cacheReadTokens;
  const long = price.longContext && promptTokens > price.longContext.overInputTokens ? price.longContext : null;
  const inPrice = price.inPerMTok * (long?.inMultiplier ?? 1);
  const outPrice = price.outPerMTok * (long?.outMultiplier ?? 1);
  const inUsd = (usage.inputTokens / 1e6) * inPrice;
  const outUsd = (usage.outputTokens / 1e6) * outPrice;
  const cacheWriteUsd = (usage.cacheWriteTokens / 1e6) * inPrice * (price.cacheWriteMultiplier ?? 1);
  const cacheReadUsd = (usage.cacheReadTokens / 1e6) * inPrice * (price.cacheReadMultiplier ?? 1);
  return inUsd + outUsd + cacheWriteUsd + cacheReadUsd;
}

/** Cost of one model call in USD. Always a number — `estimated` marks calls
 * priced by fallback or from approximate token counts; `reported` marks a
 * cost the provider itself returned. */
export function computeCost(
  provider: ProviderId,
  modelId: string,
  usage: UsageInfo
): { usd: number; estimated: boolean; reported: boolean } {
  // Exact provider-reported cost (OpenRouter) always wins.
  if (typeof usage.costUsd === "number") return { usd: usage.costUsd, estimated: !!usage.approximate, reported: true };

  const price = findPrice(modelId);
  if (price) return { usd: priceUsage(price, usage), estimated: !!usage.approximate, reported: false };
  return { usd: priceUsage(FALLBACK_PRICE[provider], usage), estimated: true, reported: false };
}
