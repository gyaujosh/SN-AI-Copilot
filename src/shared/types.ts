import type { ConnectionState } from "./connection";
// Shared types — the single source of truth for the protocol between
// the side panel, the background service worker, and the content scripts.

// ─── ServiceNow page context ─────────────────────────────────────────────────

export interface SnField {
  name: string;
  label: string;
  type: string;
  mandatory?: boolean;
  visible?: boolean;
}

export interface SnContext {
  url?: string;
  hostname?: string;
  pathname?: string;
  instance?: string;
  table?: string | null;
  sysId?: string | null;
  fields?: SnField[];
  values?: Record<string, string>;
  isForm?: boolean;
  isList?: boolean;
  isScriptEditor?: boolean;
  uiType?: string;
  scope?: string | null;
  tabId?: number;
  updatedAt?: number;
}

export type InstanceRole = "sand" | "dev" | "test" | "stage" | "prod";

/** Environments in promotion order — the order every role list renders in. */
export const INSTANCE_ROLES: InstanceRole[] = ["sand", "dev", "test", "stage", "prod"];

/** Roles the agent may write to. Production is read-only, always. */
export const WRITABLE_ROLES: InstanceRole[] = ["sand", "dev", "test", "stage"];

export const ROLE_LABELS: Record<InstanceRole, string> = {
  sand: "Sandbox",
  dev: "Development",
  test: "Test",
  stage: "Stage",
  prod: "Production",
};

export function isInstanceRole(value: unknown): value is InstanceRole {
  return typeof value === "string" && (INSTANCE_ROLES as string[]).includes(value);
}

/** Every environment but Production accepts changes. */
export function isWritableRole(role: InstanceRole | null | undefined): boolean {
  return !!role && WRITABLE_ROLES.includes(role);
}

/** Whether the agent may change an instance: yes, each change approved, unless
 * the user marked it Production — an instance they never added included. */
export function allowsChanges(instance: SnInstance | null | undefined): boolean {
  return !instance || isWritableRole(instance.role);
}

/**
 * A first guess at an instance's environment from its hostname, offered when
 * the user adds it — never applied without them seeing it. A name that says
 * production anywhere is Production. The other roles need clear evidence —
 * a "dev12345" developer instance, a "-dev" or "-sand" part, or a name ending
 * in "dev", "sandbox" or "sbx" — not just the letters inside some word, and
 * anything unrecognised is guessed Production, since a company's production
 * instance is usually its bare name ("acme"): a wrong guess withholds write
 * access rather than granting it.
 */
export function suggestRole(host: string): InstanceRole {
  const name = host.toLowerCase().split(".")[0];
  const parts = name.split(/[-_]/);
  const says = (words: string, suffixToo: boolean) =>
    parts.some((p) => new RegExp(`^(?:${words})\\d*$`).test(p)) || (suffixToo && new RegExp(`(?:${words})\\d*$`).test(name));
  if (says("prod|prd|production|live", false) || says("prod|prd|production", true)) return "prod";
  if (says("sandbox|sbx|sand", false) || says("sandbox|sbx", true)) return "sand";
  if (says("dev|development", true)) return "dev";
  if (says("test|uat|qa|tst", true)) return "test";
  if (says("stage|staging|stg|preprod", true)) return "stage";
  return "prod";
}

/** A ServiceNow instance the user added (or a team preset seeded on first run). */
export interface SnInstance {
  id: string;
  /** Short name shown in the header, e.g. "Acme dev" or "dev12345". */
  label: string;
  /** Bare hostname, e.g. "dev12345.service-now.com". */
  host: string;
  /** Environment. Every role but Production accepts agent writes. */
  role: InstanceRole;
}

export interface CatalogContext {
  name: string;
  sys_id: string;
  category?: string;
}

export interface CalibrationData {
  instanceUrl: string;
  calibratedAt: number;
  variableTypeMap: Record<string, string>;
  categories: Record<string, string>;
  defaultCatalog: { sys_id: string; title: string } | null;
  scriptTriggerTypes: string[];
  conditionalRules: {
    referenceTypes: string[];
    lookupTypes: string[];
  };
}

// ─── Providers & models ──────────────────────────────────────────────────────

export type ProviderId = "anthropic" | "openai" | "openrouter";

export const PROVIDER_IDS: ProviderId[] = ["anthropic", "openai", "openrouter"];

export interface ProviderInfo {
  id: ProviderId;
  /** The name users know the models by — picker tab, trigger and settings row. */
  label: string;
  keyPlaceholder: string;
  /** Where to create a key. */
  keyUrl: string;
}

export const PROVIDERS: Record<ProviderId, ProviderInfo> = {
  anthropic: { id: "anthropic", label: "Claude", keyPlaceholder: "sk-ant-…", keyUrl: "https://console.anthropic.com/" },
  openai: { id: "openai", label: "OpenAI", keyPlaceholder: "sk-…", keyUrl: "https://platform.openai.com/api-keys" },
  openrouter: { id: "openrouter", label: "OpenRouter", keyPlaceholder: "sk-or-…", keyUrl: "https://openrouter.ai/keys" },
};

/** "https://platform.openai.com/api-keys" → "platform.openai.com/api-keys", for prose. */
export function displayUrl(url: string): string {
  return url.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

/**
 * No model ids are hard-coded: each provider's live catalog supplies them, and
 * the first catalog loaded for a provider picks its default (modelCatalog.ts).
 * An empty string means "not chosen yet".
 */
export const NO_MODELS: Record<ProviderId, string> = { anthropic: "", openai: "", openrouter: "" };

/** How hard a model reasons before it answers (src/shared/effort.ts). */
export type EffortLevel = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** One entry in a provider's live model catalog (fetched from its models API). */
export interface ModelListEntry {
  id: string;
  name: string;
  /** Unix seconds, when the provider reports it — lists are sorted newest first. */
  created?: number;
  /** Effort levels the model accepts, lowest first, as its provider lists them. */
  efforts?: EffortLevel[];
  /** The level the model uses when none is chosen, when the provider says. */
  defaultEffort?: EffortLevel;
  /** Claude: whether the model takes adaptive thinking (older ones reject it). */
  adaptiveThinking?: boolean;
}

export interface PublicSettings {
  provider: ProviderId;
  models: Record<ProviderId, string>;
  /** Effort chosen per model, keyed "provider:model id"; a model not listed uses its own default. */
  efforts: Record<string, EffortLevel>;
  keysPresent: Record<ProviderId, boolean>;
  instances: SnInstance[];
  activeInstanceId: string | null;
  /** Chat-mode pin. null = Auto: follow the tab the user is viewing. */
  pinnedInstanceId: string | null;
}

/** One edit to the instance list, applied to the stored list as it is when
 * the edit arrives — so quick successive edits never undo each other. */
export type InstanceOp =
  | { op: "add"; instance: SnInstance }
  | { op: "remove"; id: string }
  | { op: "role"; id: string; role: InstanceRole };

export interface SettingsPatch {
  provider?: ProviderId;
  models?: Partial<Record<ProviderId, string>>;
  /** The effort for one model; null goes back to the model's own default. */
  effort?: { provider: ProviderId; model: string; level: EffortLevel | null };
  /** A key to store, or "" to delete the stored one. */
  apiKeys?: Partial<Record<ProviderId, string>>;
  /** The complete instance list, replacing the stored one. */
  instances?: SnInstance[];
  /** Edits to the stored instance list, applied in order (after `instances`). */
  instanceOps?: InstanceOp[];
  activeInstanceId?: string | null;
  /** null pins nothing (Auto); an id pins the chat agent to that instance. */
  pinnedInstanceId?: string | null;
}

/** Short display name for a model id that no loaded catalog has named. */
export function modelDisplayName(_provider: ProviderId, modelId: string): string {
  if (!modelId) return "Choose a model";
  const tail = modelId.includes("/") ? modelId.split("/").pop()! : modelId;
  return tail.length > 22 ? tail.slice(0, 20) + "…" : tail;
}

// ─── Session cost ────────────────────────────────────────────────────────────

export interface SessionCost {
  /** Session total in USD (priced calls only). */
  usd: number;
  /** Cost of the most recent run (turn). */
  turnUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  requests: number;
  /** Calls priced by estimate (unknown model / missing usage) — counted HIGH, never $0. */
  estimatedRequests: number;
  /** Calls whose cost the provider reported itself (OpenRouter) rather than list prices. */
  reportedRequests: number;
}

export const EMPTY_COST: SessionCost = {
  usd: 0,
  turnUsd: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  requests: 0,
  estimatedRequests: 0,
  reportedRequests: 0,
};

/** When the model list prices in src/background/pricing.ts were last checked. */
export const PRICES_CHECKED = "2026-09-25";

/** What a finished chat cost, as saved with it in History. */
export type ArchivedCost = Omit<SessionCost, "turnUsd">;

/** Every count as a finite, non-negative number — stored data is never trusted. */
export function sanitizeCost(raw: unknown): ArchivedCost | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
  return {
    usd: n(r.usd),
    inputTokens: n(r.inputTokens),
    outputTokens: n(r.outputTokens),
    cacheReadTokens: n(r.cacheReadTokens),
    requests: n(r.requests),
    estimatedRequests: n(r.estimatedRequests),
    reportedRequests: n(r.reportedRequests),
  };
}

// ─── Attachments ─────────────────────────────────────────────────────────────

export interface PlanFile {
  name: string;
  type: string;
  content: string; // base64 for images, plain text otherwise
  isImage: boolean;
  /** Decoded size of an optimized image, so budget checks don't re-decode it. */
  bytes?: number;
}

// ─── Transcript (the feed) ───────────────────────────────────────────────────

export interface ToolChip {
  id: string;
  name: string;
  label: string;
  detail?: string;
  /** queued: not started yet. skipped: never ran (stopped or interrupted first).
   * unknown: may or may not have taken effect (interrupted mid-call or an
   * ambiguous transport failure) — a write in this state must be verified. */
  status: "queued" | "running" | "ok" | "error" | "unknown" | "skipped";
  summary?: string;
}

/** A heading and a few plain sentences, shown on an approval card above its changes. */
export interface ApprovalExplain {
  title: string;
  lines: string[];
}

export type FeedItem =
  | { kind: "user"; id: string; text: string; fileNames?: string[]; at?: number }
  | { kind: "assistant"; id: string; text: string; streaming?: boolean }
  | { kind: "tools"; id: string; tools: ToolChip[] }
  | {
      kind: "approval";
      id: string;
      summary: string;
      ops: string[];
      destructive?: boolean;
      /** The instance the changes go to, e.g. "Dev · acmedev.service-now.com". */
      where?: string;
      /** Something the user should understand before approving, set out on the card. */
      explain?: ApprovalExplain;
      /** The response's whole plan, in the agent's words; approving it covers the response. */
      plan?: boolean;
      /** Installing or updating the helper Script Include: always its own card. */
      helper?: boolean;
      status: "pending" | "approved" | "denied" | "expired";
    }
  | { kind: "error"; id: string; text: string; runId?: string }
  | {
      kind: "notice";
      id: string;
      text: string;
      /** warning: an interruption or recovery the user should act on. */
      tone?: "warning";
      /** The run this notice reports on — Resume is offered while it is resumable. */
      runId?: string;
    };

// ─── Runs ────────────────────────────────────────────────────────────────────
// A run is one submitted request and everything the agent does for it. It is
// owned by the background worker, never by the panel: the panel only watches.

export type RunStatus = "running" | "awaiting_approval" | "completed" | "stopped" | "failed" | "interrupted";

/** Why a run ended early. Each maps to a distinct cause the user can act on. */
export type RunFailureKind =
  | "worker_restarted"        // Chrome terminated the extension's background worker mid-run
  | "extension_restarted"     // the browser exited, or the extension reloaded, mid-run
  | "sign_in_required"        // the ServiceNow session on the run's instance expired
  | "servicenow_unavailable"  // no usable tab on the run's instance
  | "provider_rate_limited"
  | "provider_auth"
  | "provider_network"
  | "provider_error";

export interface PublicRun {
  id: string;
  status: RunStatus;
  /** Instance host frozen at submission; resuming never moves it. */
  host: string | null;
  startedAt: number;
  endedAt?: number;
  failure?: RunFailureKind;
  resumable: boolean;
}

// ─── Archived sessions (view-only history — NEVER sent to the model) ─────────

export interface SessionMeta {
  id: string;
  /** Archived-at timestamp (ms). */
  at: number;
  /** First user message, trimmed. */
  title: string;
  /** Feed item count. */
  items: number;
  /** Session spend at archive time. */
  usd?: number;
  /** Tokens and spend at archive time (sessions saved before this was recorded have only `usd`). */
  cost?: ArchivedCost;
}

// ─── Port protocol: background → side panel ──────────────────────────────────

export type AgentEvent =
  | { type: "state"; feed: FeedItem[]; running: boolean; ctx: SnContext | null; catalog: CatalogContext | null; settings: PublicSettings; cost: SessionCost; connection?: ConnectionState; run?: PublicRun | null; viewedHost?: string | null }
  | { type: "run"; run: PublicRun | null }
  | { type: "connection"; connection: ConnectionState }
  /** The ServiceNow host of the tab on screen, or null when it isn't a ServiceNow page. */
  | { type: "viewed"; host: string | null }
  | { type: "cost"; cost: SessionCost }
  | { type: "feed_patch"; item: FeedItem }
  | { type: "feed_reset" }
  | { type: "turn_state"; running: boolean }
  | { type: "context"; ctx: SnContext | null }
  | { type: "catalog"; catalog: CatalogContext | null }
  | { type: "settings"; settings: PublicSettings }
  | { type: "model_list"; provider: ProviderId; models: ModelListEntry[]; loading?: boolean; error?: string }
  | { type: "session_list"; sessions: SessionMeta[] }
  | { type: "session_detail"; id: string; feed: FeedItem[] };

// ─── Port protocol: side panel → background ──────────────────────────────────

export type PanelCommand =
  /** contextTabId: the tab whose page context the panel showed when the user sent. */
  | { type: "chat"; text: string; files?: PlanFile[]; contextTabId?: number | null }
  | { type: "approval"; id: string; approved: boolean }
  | { type: "stop" }
  | { type: "resume_run"; runId: string }
  | { type: "clear" }
  | { type: "refresh_context" }
  | { type: "get_state" }
  | { type: "set_settings"; patch: SettingsPatch }
  | { type: "switch_instance"; id: string }
  | { type: "list_models"; provider: ProviderId; force?: boolean }
  | { type: "open_host_tab"; host: string }
  | { type: "list_sessions" }
  | { type: "get_session"; id: string }
  | { type: "delete_session"; id: string }
  | { type: "clear_catalog" };

export const PANEL_PORT_NAME = "sn-copilot-panel";
