import type { ProviderId, RunFailureKind } from "../../shared/types";
import { PROVIDERS } from "../../shared/types";
import { anthropicAdapter, describeAnthropicError } from "./anthropic";
import { openrouterAdapter } from "./openaiCompat";
import { openaiAdapter } from "./openaiResponses";
import type { ProviderAdapter } from "./types";

export type { CompletionParams, CompletionResult, NeutralMessage, NeutralToolCall, NeutralToolResult, ProviderAdapter } from "./types";

const ADAPTERS: Record<ProviderId, ProviderAdapter> = {
  anthropic: anthropicAdapter,
  openai: openaiAdapter,
  openrouter: openrouterAdapter,
};

export function getAdapter(provider: ProviderId): ProviderAdapter {
  return ADAPTERS[provider] || anthropicAdapter;
}

/**
 * Which kind of provider failure ended a run. Each kind is a different fix for
 * the user: wait out a limit, fix a key, check the connection, or retry.
 */
export function classifyProviderFailure(_provider: ProviderId, err: any): RunFailureKind {
  const code = String(err?.code || "");
  const message = String(err?.message || err || "");
  if (err?.status === 429 || /rate.?limit|usage limit|quota/i.test(message)) return "provider_rate_limited";
  if (err?.status === 401 || err?.status === 403 || /\b401\b|unauthorized|invalid.*key|key was rejected/i.test(message)) return "provider_auth";
  if (code === "PROVIDER_STALLED" || code === "PROVIDER_TIMEOUT" || err?.name === "TypeError" || err?.name === "APIConnectionError" || /failed to fetch|network|connection error|ECONN/i.test(message)) {
    return "provider_network";
  }
  return "provider_error";
}

export function friendlyProviderError(provider: ProviderId, err: any): string {
  const name = PROVIDERS[provider]?.label ?? provider;
  if (err?.code === "PROVIDER_STALLED") return "The provider stopped sending data before the answer finished. Check your connection, then resume.";
  if (err?.code === "PROVIDER_TIMEOUT") return "The provider didn't start answering in time. Check your connection, then resume.";
  if ((provider === "openai" || provider === "openrouter") && (err?.name === "TypeError" || /failed to fetch|network/i.test(err?.message || ""))) {
    return `Couldn't reach ${name} (network error). Check your connection, then resume.`;
  }
  if (provider === "anthropic") {
    const known = describeAnthropicError(err);
    if (known) return known;
  }
  const msg = err?.message || String(err);
  // OpenRouter holds back what the longest possible answer could cost, and
  // refuses when the balance can't cover it.
  if (provider === "openrouter" && /API error 402\b/.test(msg)) {
    const affordable = /can only afford (\d+)/i.exec(msg)?.[1];
    const covers = affordable ? ` (it covers about ${Number(affordable).toLocaleString("en-US")} tokens of answer on this model)` : "";
    return `Your OpenRouter balance is too low for this request${covers}. Add credits at openrouter.ai/settings/credits, or choose a cheaper model, then resume.`;
  }
  if (/401|unauthorized|invalid.*key/i.test(msg)) {
    return `Your ${name} API key was rejected. Check it in Settings.`;
  }
  return msg;
}
