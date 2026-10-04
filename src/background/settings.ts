// Settings. Raw API keys never leave the background worker — the side panel
// only sees which providers have keys configured.

import type { EffortLevel, InstanceOp, ProviderId, PublicSettings, SettingsPatch, SnInstance } from "../shared/types";
import { NO_MODELS, PROVIDER_IDS, isInstanceRole } from "../shared/types";
import { parseInstanceHost } from "../shared/connection";
import { effortKey, isEffortLevel } from "../shared/effort";
import { clearModelCatalog } from "./modelCatalog";
import { presetInstances } from "./presets";

export interface StoredSettings {
  provider: ProviderId;
  /** "" until the provider's catalog has named a default or the user picked one. */
  models: Record<ProviderId, string>;
  /** Effort chosen per model, keyed "provider:model id". */
  efforts: Record<string, EffortLevel>;
  apiKeys: Record<ProviderId, string>;
  instances: SnInstance[];
  activeInstanceId: string | null;
  /** Chat-mode pin. null = Auto: follow the tab the user is viewing. */
  pinnedInstanceId: string | null;
}

const MAX_LABEL_CHARS = 40;
/** Effort choices kept, most recent last — enough for every model anyone switches between. */
const MAX_EFFORTS = 60;

/** Stored effort choices, each a known level under a "provider:model" key. */
function sanitizeEfforts(raw: unknown): Record<string, EffortLevel> {
  const out: Record<string, EffortLevel> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [key, level] of Object.entries(raw as Record<string, unknown>)) {
    const provider = key.slice(0, key.indexOf(":"));
    if (isProvider(provider) && key.length > provider.length + 1 && isEffortLevel(level)) out[key] = level;
  }
  return out;
}

function isProvider(value: unknown): value is ProviderId {
  return typeof value === "string" && (PROVIDER_IDS as string[]).includes(value);
}

/**
 * Instances as stored, preset or patched: valid ServiceNow hosts, one entry
 * per host, unique ids, and always a role. An entry without a valid role is
 * Production — read-only — so a malformed preset can never grant write access.
 */
export function sanitizeInstances(raw: unknown): SnInstance[] {
  if (!Array.isArray(raw)) return [];
  const out: SnInstance[] = [];
  const taken = (id: string) => out.some((i) => i.id === id);
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const { id, label, host, role } = item as Partial<SnInstance>;
    const clean = typeof host === "string" ? parseInstanceHost(host) : null;
    if (!clean || out.some((i) => i.host === clean)) continue;
    let ownId = typeof id === "string" && id.trim() && !taken(id) ? id : `inst_${clean}`;
    for (let n = 2; taken(ownId); n++) ownId = `inst_${clean}_${n}`;
    out.push({
      id: ownId,
      label: typeof label === "string" && label.trim() ? label.trim().slice(0, MAX_LABEL_CHARS) : clean.split(".")[0],
      host: clean,
      role: isInstanceRole(role) ? role : "prod",
    });
  }
  return out;
}

function applyInstanceOps(list: SnInstance[], ops: InstanceOp[]): SnInstance[] {
  let next = [...list];
  for (const change of ops) {
    if (!change || typeof change !== "object") continue;
    if (change.op === "add") next = [...next, change.instance];
    else if (change.op === "remove") next = next.filter((i) => i.id !== change.id);
    else if (change.op === "role" && isInstanceRole(change.role)) next = next.map((i) => (i.id === change.id ? { ...i, role: change.role } : i));
  }
  return next;
}

export async function getSettings(): Promise<StoredSettings> {
  const r = await chrome.storage.local.get([
    "provider",
    "providerModels",
    "providerKeys",
    "snInstances",
    "activeInstanceId",
    "chatPinnedInstanceId",
    "modelEfforts",
  ]);

  const apiKeys = { ...NO_MODELS };
  const models = { ...NO_MODELS };
  for (const p of PROVIDER_IDS) {
    const key = r.providerKeys?.[p];
    const model = r.providerModels?.[p];
    if (typeof key === "string") apiKeys[p] = key;
    if (typeof model === "string") models[p] = model.trim();
  }

  // Team presets seed the list until the user first changes it; after that
  // the stored list is the whole truth, so a removed preset stays removed.
  const instances = sanitizeInstances(r.snInstances === undefined ? presetInstances() : r.snInstances);
  const known = (id: unknown): id is string => typeof id === "string" && instances.some((i) => i.id === id);

  return {
    provider: isProvider(r.provider) ? r.provider : PROVIDER_IDS.find((p) => apiKeys[p]) ?? "anthropic",
    models,
    efforts: sanitizeEfforts(r.modelEfforts),
    apiKeys,
    instances,
    // Never chosen: the first instance, so there is something to open. Chosen
    // but since removed: nothing — Auto then works where the user is looking,
    // not on whichever instance happens to be listed first.
    activeInstanceId: known(r.activeInstanceId) ? r.activeInstanceId
      : r.activeInstanceId === undefined ? instances[0]?.id ?? null : null,
    // A pin naming an instance that no longer exists resolves to Auto — the
    // honest default — rather than pinning the agent to nothing.
    pinnedInstanceId: known(r.chatPinnedInstanceId) ? r.chatPinnedInstanceId : null,
  };
}

/** Every change runs to completion before the next one reads the settings, so
 * concurrent callers (panel commands, catalog loads, tab following) never
 * overwrite each other's keys, models or instance edits. */
let writes: Promise<unknown> = Promise.resolve();
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = writes.then(task, task);
  writes = run.catch(() => {});
  return run;
}

export function patchSettings(patch: SettingsPatch): Promise<void> {
  return serialized(() => applyPatch(patch));
}

async function applyPatch(patch: SettingsPatch): Promise<void> {
  const current = await getSettings();
  const toSet: Record<string, unknown> = {};
  let provider = isProvider(patch.provider) ? patch.provider : undefined;

  if (patch.models) {
    const models = { ...current.models };
    for (const p of PROVIDER_IDS) {
      const v = patch.models[p];
      if (typeof v === "string" && v.trim()) models[p] = v.trim();
    }
    toSet.providerModels = models;
  }

  if (patch.effort && isProvider(patch.effort.provider) && typeof patch.effort.model === "string" && patch.effort.model.trim()) {
    const key = effortKey(patch.effort.provider, patch.effort.model.trim());
    const efforts = { ...current.efforts };
    delete efforts[key];
    if (isEffortLevel(patch.effort.level)) efforts[key] = patch.effort.level;
    const keys = Object.keys(efforts);
    for (const stale of keys.slice(0, Math.max(0, keys.length - MAX_EFFORTS))) delete efforts[stale];
    toSet.modelEfforts = efforts;
  }

  if (patch.apiKeys) {
    const keys = { ...current.apiKeys };
    const added: ProviderId[] = [];
    for (const p of PROVIDER_IDS) {
      const v = patch.apiKeys[p];
      if (typeof v !== "string" || v.trim() === keys[p]) continue;
      keys[p] = v.trim();
      if (keys[p]) added.push(p);
      // A different key can see a different catalog; never serve the old one.
      await clearModelCatalog(p);
    }
    toSet.providerKeys = keys;
    // A key saved while the provider in use has none selects its provider —
    // that is what the user is setting up. Deleting a key never moves the
    // conversation to another provider: where data goes stays the user's call.
    if (!provider && added.length && !keys[current.provider]) provider = added[0];
  }
  // The provider in use is always stored explicitly once anything changes, so
  // adding a key later can't silently re-derive it.
  toSet.provider = provider ?? current.provider;

  let instances = current.instances;
  if (patch.instances !== undefined) instances = sanitizeInstances(patch.instances);
  if (patch.instanceOps?.length) instances = sanitizeInstances(applyInstanceOps(instances, patch.instanceOps));
  if (patch.instances !== undefined || patch.instanceOps?.length) toSet.snInstances = instances;

  const known = (id: string) => instances.some((i) => i.id === id);
  if (patch.activeInstanceId !== undefined && (patch.activeInstanceId === null || known(patch.activeInstanceId))) {
    toSet.activeInstanceId = patch.activeInstanceId;
  }
  if (patch.pinnedInstanceId !== undefined && (patch.pinnedInstanceId === null || known(patch.pinnedInstanceId))) {
    toSet.chatPinnedInstanceId = patch.pinnedInstanceId;
  }
  await chrome.storage.local.set(toSet);
}

/**
 * Store `model` as the provider's model only if none is chosen yet, and say
 * which model is in effect. The check and the write happen in one step, so a
 * model the user picks while a catalog is loading is never overwritten.
 */
export function setDefaultModel(provider: ProviderId, model: string): Promise<string> {
  return serialized(async () => {
    const current = await getSettings();
    if (current.models[provider]) return current.models[provider];
    await applyPatch({ models: { [provider]: model } });
    return model;
  });
}

/** Storage keys earlier builds used for secrets or personal data. */
const RETIRED_KEYS = ["claudeApiKey", "openaiApiKey", "userNameCache"];

export async function removeRetiredSettings(): Promise<void> {
  await chrome.storage.local.remove(RETIRED_KEYS).catch(() => {});
}

export async function toPublicSettings(s: StoredSettings): Promise<PublicSettings> {
  return {
    provider: s.provider,
    models: s.models,
    efforts: s.efforts,
    keysPresent: {
      anthropic: !!s.apiKeys.anthropic,
      openai: !!s.apiKeys.openai,
      openrouter: !!s.apiKeys.openrouter,
    },
    instances: s.instances,
    activeInstanceId: s.activeInstanceId,
    pinnedInstanceId: s.pinnedInstanceId,
  };
}
