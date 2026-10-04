// Live model catalogs — fetched from each provider's models API so the picker
// always shows the provider's current models without hand-maintained lists.
// Cached per provider in chrome.storage for 24h and tied to the key that
// fetched it; a forced refresh bypasses the cache, and changing a provider's
// key clears its entry. Claude and OpenRouter also say which effort levels
// each model takes; those ride along in the entries.

import type { EffortLevel, ModelListEntry, ProviderId } from "../shared/types";
import { EFFORT_LEVELS, isEffortLevel, orderEfforts } from "../shared/effort";

const CACHE_KEY = "modelCatalog";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** Bumped when entries gain fields, so older cached lists are fetched again. */
const CACHE_VERSION = 2;
/** A models API that hasn't answered by now won't; the caller gets an error it can show. */
const FETCH_DEADLINE_MS = 15_000;

interface CatalogCache {
  [provider: string]: { fetchedAt: number; models: ModelListEntry[]; keyHash?: string; v?: number };
}

/** A short fingerprint of an API key, so a cache entry can be matched to the
 * key that loaded it without the key itself ever being stored twice. */
async function keyFingerprint(apiKey: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(apiKey));
  return Array.from(new Uint8Array(digest).slice(0, 8), (b) => b.toString(16).padStart(2, "0")).join("");
}

function toUnixSeconds(v: unknown): number | undefined {
  if (typeof v === "number" && v > 0) return v;
  if (typeof v === "string") {
    const t = Date.parse(v);
    if (!Number.isNaN(t)) return Math.floor(t / 1000);
  }
  return undefined;
}

/** OpenAI's /v1/models mixes in embeddings, audio, image and video models, and
 * models that don't fit an agent that works through tools: pro (minutes and
 * dollars per answer), deep research and codex (built for their own tools),
 * legacy completions (instruct) and search previews (no tools). They can
 * still be typed in as a model id. */
const OPENAI_EXCLUDE = /embedding|whisper|tts|audio|realtime|dall-e|image|moderation|transcribe|sora|davinci|babbage|-pro\b|deep-research|codex|instruct|search/i;

function statusError(status: number): Error {
  if (status === 401) return new Error("API key was rejected");
  if (status === 403) return new Error("this key can't list models (403)");
  return new Error(`HTTP ${status}`);
}

/** Claude's models API lists each model's effort levels and thinking modes. */
function anthropicTraits(caps: any): Partial<ModelListEntry> {
  const traits: Partial<ModelListEntry> = {};
  if (caps?.effort?.supported) {
    const efforts = EFFORT_LEVELS.filter((level) => caps.effort[level]?.supported === true);
    if (efforts.length) traits.efforts = efforts;
  }
  const adaptive = caps?.thinking?.types?.adaptive?.supported;
  if (typeof adaptive === "boolean") traits.adaptiveThinking = adaptive;
  return traits;
}

/** OpenRouter lists a reasoning model's efforts and default; no list means any
 * of its gateway levels, of which the three every model maps are offered. */
function openRouterTraits(reasoning: any): Partial<ModelListEntry> {
  if (!reasoning || typeof reasoning !== "object") return {};
  let efforts: EffortLevel[] = Array.isArray(reasoning.supported_efforts)
    ? orderEfforts(reasoning.supported_efforts)
    : ["low", "medium", "high"];
  // Reasoning a model can't switch off is never offered as "none".
  if (reasoning.mandatory === true) efforts = efforts.filter((level) => level !== "none");
  const traits: Partial<ModelListEntry> = {};
  if (efforts.length) traits.efforts = efforts;
  if (isEffortLevel(reasoning.default_effort) && efforts.includes(reasoning.default_effort)) traits.defaultEffort = reasoning.default_effort;
  return traits;
}

/** The request's own deadline, joined with the caller's stop signal. */
function deadline(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(FETCH_DEADLINE_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function fetchProviderModels(provider: ProviderId, apiKey: string, signal?: AbortSignal): Promise<ModelListEntry[]> {
  let url: string;
  const headers: Record<string, string> = {};

  if (provider === "anthropic") {
    url = "https://api.anthropic.com/v1/models?limit=100";
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = "2023-06-01";
    headers["anthropic-dangerous-direct-browser-access"] = "true";
  } else if (provider === "openai") {
    url = "https://api.openai.com/v1/models";
    headers["Authorization"] = `Bearer ${apiKey}`;
  } else {
    // OpenRouter's catalog is public; the key is optional.
    url = "https://openrouter.ai/api/v1/models";
    if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  }

  const request = deadline(signal);
  const resp = await fetch(url, { headers, signal: request }).catch((cause) => {
    if (request.aborted && !signal?.aborted) throw new Error("the models API didn't answer in time");
    throw cause;
  });
  if (!resp.ok) throw statusError(resp.status);
  // OpenRouter's catalog answers any key, so the key is checked on its own —
  // only a definite refusal counts; anything else leaves the list usable.
  if (provider === "openrouter" && apiKey) {
    const check = await fetch("https://openrouter.ai/api/v1/auth/key", { headers, signal: deadline(signal) }).catch(() => null);
    if (check && (check.status === 401 || check.status === 403)) throw new Error("API key was rejected");
  }
  const body = await resp.json();
  let rows: any[] = Array.isArray(body?.data) ? body.data : [];

  // The agent works through tools; an OpenRouter model that can't call them
  // can only chat. (Listed only when OpenRouter reports its parameters.)
  if (provider === "openrouter") {
    rows = rows.filter((m) => !Array.isArray(m?.supported_parameters) || m.supported_parameters.includes("tools"));
  }

  let models: ModelListEntry[] = rows
    .filter((m) => typeof m?.id === "string")
    .map((m) => ({
      id: m.id as string,
      name:
        typeof m.display_name === "string" && m.display_name
          ? m.display_name
          : typeof m.name === "string" && m.name
            ? m.name
            : (m.id as string),
      created: toUnixSeconds(m.created ?? m.created_at),
      ...(provider === "anthropic" ? anthropicTraits(m.capabilities) : provider === "openrouter" ? openRouterTraits(m.reasoning) : {}),
    }));

  if (provider === "openai") {
    models = models.filter((m) => /^(gpt-|o\d)/i.test(m.id) && !OPENAI_EXCLUDE.test(m.id));
  }

  models.sort((a, b) => (b.created ?? 0) - (a.created ?? 0) || a.id.localeCompare(b.id));
  return models;
}

/**
 * The model a provider starts on, chosen from its live catalog (newest first)
 * instead of a hard-coded id that goes stale: the newest Sonnet for Claude,
 * the newest flagship GPT for OpenAI (no mini/nano/pro or dated snapshot), and
 * on OpenRouter the newest Claude Sonnet, else the newest flagship GPT. Falls
 * back to the newest model listed; null only for an empty catalog.
 */
export function pickDefaultModel(provider: ProviderId, models: ModelListEntry[]): string | null {
  const first = (pattern: RegExp) => models.find((m) => pattern.test(m.id))?.id;
  const choice =
    provider === "anthropic" ? first(/sonnet/i)
    : provider === "openai" ? first(/^gpt-\d+(?:\.\d+)?$/i)
    : first(/^anthropic\/claude-sonnet/i) ?? first(/^openai\/gpt-\d+(?:\.\d+)?$/i);
  return choice ?? models[0]?.id ?? null;
}

async function readCache(): Promise<CatalogCache> {
  const r = await chrome.storage.local.get(CACHE_KEY);
  return r[CACHE_KEY] && typeof r[CACHE_KEY] === "object" ? { ...r[CACHE_KEY] } : {};
}

/** Read-modify-writes of the cache run one at a time: the picker loads every
 * catalog at once, and interleaved writes would drop each other's entries. */
let cacheWrites: Promise<void> = Promise.resolve();
function updateCache(change: (cache: CatalogCache) => boolean): Promise<void> {
  cacheWrites = cacheWrites
    .then(async () => {
      const cache = await readCache();
      if (change(cache)) await chrome.storage.local.set({ [CACHE_KEY]: cache });
    })
    .catch(() => {});
  return cacheWrites;
}

/** Cached catalog lookup; hits the provider API when stale, missing, forced,
 * or cached for a different key. */
export async function getModelCatalog(
  provider: ProviderId,
  apiKey: string,
  force = false,
  signal?: AbortSignal
): Promise<ModelListEntry[]> {
  const keyHash = await keyFingerprint(apiKey);
  const hit = (await readCache())[provider];
  if (!force && hit && hit.keyHash === keyHash && hit.v === CACHE_VERSION && Date.now() - hit.fetchedAt < CACHE_TTL_MS && Array.isArray(hit.models) && hit.models.length) {
    return hit.models;
  }

  const models = await fetchProviderModels(provider, apiKey, signal);
  void updateCache((cache) => {
    cache[provider] = { fetchedAt: Date.now(), models, keyHash, v: CACHE_VERSION };
    return true;
  });
  return models;
}

/** A model's entry as last listed for this key, however old — never a
 * request to the provider. Undefined when it isn't cached. */
export async function cachedModelEntry(provider: ProviderId, apiKey: string, modelId: string): Promise<ModelListEntry | undefined> {
  const hit = (await readCache())[provider];
  if (!hit || hit.v !== CACHE_VERSION || !Array.isArray(hit.models) || hit.keyHash !== (await keyFingerprint(apiKey))) return undefined;
  return hit.models.find((m) => m.id === modelId);
}

/** Forget one provider's cached catalog (its key changed or was removed). */
export function clearModelCatalog(provider: ProviderId): Promise<void> {
  return updateCache((cache) => provider in cache && delete cache[provider]);
}
