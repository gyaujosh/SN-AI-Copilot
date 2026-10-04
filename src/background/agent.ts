// Agent core. Owns the conversation (provider-neutral history + UI transcript),
// runs the streaming tool-use loop through the selected provider adapter, and
// gates write tools behind a structured approval handshake with the side panel.
//
// A run belongs to the background worker, never to a panel: panels subscribe
// and may close or reconnect at any time without affecting it. Chrome can still
// terminate the worker, so run identity, progress and safe checkpoints are
// persisted — a restart is reported as an interruption, never as silence, and
// the run can be resumed from its last completed step on the original instance.

import type {
  AgentEvent,
  ApprovalExplain,
  CatalogContext,
  FeedItem,
  PlanFile,
  PublicRun,
  RunFailureKind,
  RunStatus,
  SessionCost,
  SnContext,
  SnInstance,
  ToolChip,
} from "../shared/types";
import { EMPTY_COST, PROVIDERS, ROLE_LABELS, allowsChanges, displayUrl } from "../shared/types";
import type { StoredSettings } from "./settings";
import { cachedModelEntry, getModelCatalog, pickDefaultModel } from "./modelCatalog";
import { chosenEffort, modelEfforts } from "../shared/effort";
import { computeCost } from "./pricing";
import { buildContextBlock, STATIC_SYSTEM_PROMPT } from "./prompts";
import { classifyProviderFailure, friendlyProviderError, getAdapter } from "./providers";
import { capHistoryImages } from "./providers/imageContent";
import type { CompletionResult, NeutralMessage, NeutralToolCall, NeutralToolResult } from "./providers";
import { partialUsageOf } from "./providers/types";
import { recordRunEvent } from "./runDiagnostics";
import { getCalibration, helperExplanation, helperStatus } from "./snCatalog";
import { getSettings, setDefaultModel, toPublicSettings } from "./settings";
import { redactSecrets } from "../shared/redaction";
import type { SnBridge } from "./snBridge";
import { DESTRUCTIVE_TOOLS, PLAN_TOOL, TOOL_DEFINITIONS, WRITE_TOOLS, describeWriteOp, executeTool, toolLabel, usesHelper } from "./tools";

const MAX_ITERATIONS = 60;
const MAX_TOOL_RESULT_CHARS = 24000;
const MAX_HISTORY_MESSAGES = 60;
const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000;
/** Streamed text is checkpointed at most this often; a restart loses at most about a second of it. */
const FEED_CHECKPOINT_MS = 1000;
const STORAGE_KEYS = { feed: "copilotFeed", history: "copilotHistory_v2", cost: "copilotCost", run: "copilotRun" };
/** Lives in chrome.storage.session, which survives a worker restart but not a
 * browser exit or an extension reload — that difference names the cause. */
const BROWSER_SESSION_KEY = "copilotBrowserSession";

type Emit = (event: AgentEvent) => void;
type ApprovalOutcome = "approved" | "denied" | "expired";
type RunEnd = { status: RunStatus; failure?: RunFailureKind; resumable?: boolean };

interface RunRecord {
  id: string;
  status: RunStatus;
  /** Frozen at submission. Resuming never moves a run to another instance. */
  host: string | null;
  startedAt: number;
  updatedAt: number;
  endedAt?: number;
  failure?: RunFailureKind;
  resumable: boolean;
  session: string;
  /** The write handed to ServiceNow whose result has not come back yet: its
   * call id and a digest of its input. The input itself (which may hold
   * credentials) is never stored. */
  inflightWrite?: { id: string; name: string; digest: string };
  /** Digests of this run's writes whose outcome is unknown — never repeated blindly, even after a restart. */
  unknownWrites?: string[];
  /** Step group of the tool batch in progress, so Stop or a restart settles only its calls. */
  batch?: string | null;
  resumes: number;
}

interface RunPlan {
  settings: StoredSettings;
  host: string | null;
  resume?: RunRecord;
  prompt?: { text: string; files: PlanFile[]; submitted: SnContext | null };
}

/** Why writes are refused for a run segment: the model's tool result and the step's summary. */
interface WriteLock { message: string; summary: string }

/** Where a run works: its host, and the instance the user added for it (null if they haven't). */
interface RunTarget { host: string | null; instance: SnInstance | null }

/** Writes need an instance, and are refused only where the user marked it
 * Production. An instance they never added accepts changes, each approved. */
function writeLockFor(host: string | null, instance: SnInstance | null): WriteLock | null {
  if (!host) {
    return {
      message: "This response has no ServiceNow instance, so nothing can be changed. Do not retry. " +
        "Tell the user to open the instance in a tab and ask again.",
      summary: "blocked — no instance",
    };
  }
  if (!instance || allowsChanges(instance)) return null;
  const role = ROLE_LABELS[instance.role];
  return {
    message: `This instance (${instance.host}) is marked ${role}, and Production instances are read-only. Do not retry. ` +
      "Reads are fine; suggest making the change on a non-Production instance instead, or give the user the steps to make it themselves.",
    summary: `blocked — ${role} is read-only`,
  };
}

/** The write lock as Settings say now: an instance can be marked Production while a run is going. */
async function currentWriteLock(host: string | null): Promise<WriteLock | null> {
  const fresh = await getSettings();
  return writeLockFor(host, host ? fresh.instances.find((i) => i.host === host) ?? null : null);
}

/** Ends a run early with a cause the user can fix and then resume from. */
class RunInterruption extends Error {
  constructor(readonly kind: RunFailureKind, readonly notice: string) { super(notice); }
}

let idCounter = 0;
function nextId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${(idCounter++).toString(36)}`;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + `\n…[truncated ${s.length - max} chars]` : s;
}

const abortError = () => new DOMException("aborted", "AbortError");

/** Key order and the human step label do not make a different change. */
function canonical(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Fingerprint of a write, so it can be recognised again without keeping its
 * input — which may hold credentials — anywhere. */
async function writeDigest(name: string, input: any): Promise<string> {
  const { step_label: _label, ...change } = input && typeof input === "object" ? input : { value: input };
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical([name, change])));
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
}

function validRun(value: any): RunRecord | null {
  return value && typeof value === "object" && typeof value.id === "string" && typeof value.status === "string" ? value : null;
}

const restartText = (cause: string, resumable: boolean) => resumable
  ? `${cause} during this run, so it stopped. Completed steps are kept above; resume to continue.`
  : `${cause} before this run finished its first step. Your message is kept above; send it again to retry.`;

const NOTICES: Partial<Record<RunFailureKind, (host: string | null, resumable: boolean) => string>> = {
  worker_restarted: (_host, resumable) => restartText("Chrome restarted the extension's background worker", resumable),
  extension_restarted: (_host, resumable) => restartText("The browser or the extension restarted", resumable),
  sign_in_required: (host) => `ServiceNow asked for sign-in on ${host ?? "this instance"}. Sign in there, then resume.`,
  servicenow_unavailable: (host) => `No ${host ?? "ServiceNow"} tab answered, so the run paused. Open or refresh one, then resume.`,
};

/** What the model is told about a tool call that a restart or Stop cut
 * short. `chip` is that call's step in the same batch, if it had one. */
function unfinishedResult(call: NeutralToolCall, chip: ToolChip | undefined, reason: "stopped" | "interrupted"): object {
  const cause = reason === "stopped" ? "The user stopped the run" : "The extension restarted";
  const started = !!chip && chip.status !== "queued" && chip.status !== "skipped";
  if (!WRITE_TOOLS.has(call.name)) {
    if (!started) return { [reason]: true, not_run: true, message: `${cause} before this lookup ran. Run it if you still need it.` };
    return chip!.status === "ok" || chip!.status === "error"
      ? { [reason]: true, message: `${cause} after this lookup finished, but its result was not kept. Run it again if you still need it.` }
      : { [reason]: true, message: `${cause} before this lookup finished. Run it again if you still need it.` };
  }
  if (!started) return { [reason]: true, outcome: "not_run", message: `${cause} before this change ran. Nothing was sent.` };
  if (chip!.status === "ok") return { [reason]: true, outcome: "applied", message: `${cause} after this change reported success. Do not repeat it; query the record if you need its values.` };
  if (chip!.status === "error") return { [reason]: true, outcome: "failed", message: `This change failed before that: ${chip!.summary ?? "error"}.` };
  return { [reason]: true, outcome: "unknown", message: `${cause} while this change was running. Its outcome is unknown — query the record to verify before doing anything else, and never repeat it blindly.` };
}

export class AgentSession {
  feed: FeedItem[] = [];
  running = false;
  catalog: CatalogContext | null = null;
  cost: SessionCost = { ...EMPTY_COST };

  private history: NeutralMessage[] = [];
  private emit: Emit = () => {};
  private abortController: AbortController | null = null;
  private pendingApproval: { id: string; resolve: (outcome: ApprovalOutcome) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private checkpointTimer: ReturnType<typeof setTimeout> | null = null;
  private loading: Promise<void> | null = null;
  private session: Promise<{ id: string; existed: boolean }> | null = null;
  private run: RunRecord | null = null;
  private runDone: Promise<void> = Promise.resolve();
  /** Set synchronously when a send or resume is accepted, before any await, so
   * two commands arriving back to back cannot both start a run. */
  private starting = false;
  /** Writes with an unknown outcome from before an interruption: never repeated blindly. */
  private unverifiedWrites = new Set<string>();
  /** Cancels a send that is still getting ready (loading the model list). */
  private startAbort: AbortController | null = null;
  /** Bumped by clear(): a send still getting ready then belongs to a conversation that is gone. */
  private generation = 0;

  constructor(
    private sn: SnBridge,
    private getContext: () => SnContext | null,
    private getTabContext: (tabId: number) => SnContext | null = () => null,
  ) {}

  setEmitter(emit: Emit) {
    this.emit = emit;
  }

  /** Loads persisted state once per worker lifetime. Every entry point awaits it. */
  ready(): Promise<void> {
    this.loading ??= this.load();
    return this.loading;
  }
  restore(): Promise<void> {
    return this.ready();
  }

  private browserSession(): Promise<{ id: string; existed: boolean }> {
    this.session ??= (async () => {
      const stored = (await chrome.storage.session.get(BROWSER_SESSION_KEY))[BROWSER_SESSION_KEY];
      if (typeof stored === "string") return { id: stored, existed: true };
      const id = nextId("bs");
      await chrome.storage.session.set({ [BROWSER_SESSION_KEY]: id });
      return { id, existed: false };
    })().catch(() => ({ id: "unknown", existed: false }));
    return this.session;
  }

  private async load(): Promise<void> {
    const r = await chrome.storage.local.get([STORAGE_KEYS.feed, STORAGE_KEYS.history, STORAGE_KEYS.cost, STORAGE_KEYS.run, "catalogContext"]);
    if (r[STORAGE_KEYS.cost]) this.cost = { ...EMPTY_COST, ...r[STORAGE_KEYS.cost] };
    if (Array.isArray(r[STORAGE_KEYS.feed])) {
      this.feed = r[STORAGE_KEYS.feed].map((item: FeedItem) =>
        item.kind === "assistant" ? { ...item, streaming: false }
        : item.kind === "approval" && item.status === "pending" ? { ...item, status: "expired" as const }
        : item
      );
    }
    if (Array.isArray(r[STORAGE_KEYS.history])) this.history = r[STORAGE_KEYS.history];
    if (r.catalogContext) this.catalog = r.catalogContext;
    const run = validRun(r[STORAGE_KEYS.run]);
    const session = await this.browserSession();
    const leftRunning = !!run && (run.status === "running" || run.status === "awaiting_approval");
    void recordRunEvent("worker_start", { runId: run?.id, detail: leftRunning ? "run_left_running" : undefined });
    // Only a previous worker can have left a live run behind.
    if (run && leftRunning) this.markInterrupted(run, session.existed && run.session === session.id ? "worker_restarted" : "extension_restarted");
    else this.run = run;
  }

  /** Settle what was in flight when the previous worker stopped, and say so once. */
  private markInterrupted(run: RunRecord, kind: RunFailureKind) {
    // Answer from the batch's own steps before they are relabelled.
    this.closeUnfinishedToolCalls("interrupted", [], run.batch ?? null);
    this.settleUnfinishedSteps(false);
    const resumable = this.canResume();
    // A write cut off mid-call joins the run's unknown writes, so it stays
    // unrepeatable through every later resume, not just the next one.
    const { inflightWrite, ...rest } = run;
    const unknownWrites = inflightWrite && !run.unknownWrites?.includes(inflightWrite.digest)
      ? [...(run.unknownWrites ?? []), inflightWrite.digest]
      : run.unknownWrites;
    this.run = { ...rest, unknownWrites, status: "interrupted", failure: kind, resumable, batch: null, endedAt: Date.now(), updatedAt: Date.now() };
    this.feed.push({ kind: "notice", tone: "warning", id: nextId("n"), runId: run.id, text: NOTICES[kind]!(run.host, resumable) });
    this.persist();
    this.saveRun();
    void recordRunEvent("run_interrupted", { runId: run.id, detail: kind });
  }

  /** Steps that never started are shown as not run; a step cut off mid-call
   * has an unknown outcome — for a write, one the user must verify. */
  private settleUnfinishedSteps(emit: boolean) {
    this.feed = this.feed.map((item) => {
      if (item.kind !== "tools" || !item.tools.some((c) => c.status === "queued" || c.status === "running")) return item;
      const settled: FeedItem = {
        ...item,
        tools: item.tools.map((chip) =>
          chip.status === "queued" ? { ...chip, status: "skipped" as const, summary: "not run" }
          : chip.status === "running" ? { ...chip, status: "unknown" as const, summary: WRITE_TOOLS.has(chip.name) ? "interrupted — verify whether it was applied" : "interrupted" }
          : chip),
      };
      if (emit) this.emit({ type: "feed_patch", item: settled });
      return settled;
    });
  }

  /** Tool calls without results leave the conversation invalid for every
   * provider; answer them from what the batch's own steps show. Steps of other
   * batches never count — a model may reuse a call id from an earlier turn. */
  private closeUnfinishedToolCalls(reason: "stopped" | "interrupted", completed: NeutralToolResult[] = [], batch: string | null = null) {
    const last = this.history[this.history.length - 1];
    if (last?.role !== "assistant" || !last.toolCalls.length) return;
    const done = new Map(completed.map((r) => [r.toolCallId, r]));
    const group = batch ? this.feed.find((f) => f.id === batch) : undefined;
    const chips = new Map(group?.kind === "tools" ? group.tools.map((c) => [c.id, c] as const) : []);
    this.history.push({
      role: "tool_results",
      results: last.toolCalls.map((call) => done.get(call.id) ?? {
        toolCallId: call.id,
        content: JSON.stringify(unfinishedResult(call, chips.get(call.id), reason)),
        isError: true,
      }),
    });
  }

  /** A run can resume only from a point where the model speaks next. */
  private canResume(): boolean {
    const last = this.history[this.history.length - 1];
    return !!last && (last.role === "user" || last.role === "tool_results");
  }

  publicRun(): PublicRun | null {
    const r = this.run;
    if (!r) return null;
    return { id: r.id, status: r.status, host: r.host, startedAt: r.startedAt, endedAt: r.endedAt, failure: r.failure, resumable: r.resumable && !this.running };
  }

  private emitRun() {
    this.emit({ type: "run", run: this.publicRun() });
  }

  private saveRun() {
    const op = this.run ? chrome.storage.local.set({ [STORAGE_KEYS.run]: this.run }) : chrome.storage.local.remove(STORAGE_KEYS.run);
    void op.catch(() => {});
  }

  /** In place: the running loop holds this record and marks writes on it. */
  private setRunStatus(status: RunStatus) {
    if (!this.run || this.run.status === status) return;
    this.run.status = status;
    this.run.updatedAt = Date.now();
    this.saveRun();
    this.emitRun();
  }

  /** The stored conversation never starts mid-exchange: a tool result without
   * its call is rejected by every provider, and a resumed run would send it.
   * A long run keeps everything since the message that started it. */
  private persistableHistory(): NeutralMessage[] {
    let cut = Math.max(0, this.history.length - MAX_HISTORY_MESSAGES);
    while (cut > 0 && this.history[cut].role !== "user") cut--;
    return this.history.slice(cut);
  }

  private persist() {
    this.clearCheckpoint();
    const feed = this.feed.slice(-150);
    // Strip image payloads before persisting — storage quota is small.
    const history = JSON.parse(
      JSON.stringify(this.persistableHistory(), (key, value) => {
        if (key === "images") return undefined;
        if (key === "source" && value?.type === "base64") {
          return { type: "base64", media_type: value.media_type, data: "" };
        }
        return value;
      })
    );
    chrome.storage.local
      // Secrets never land in storage, even when a raw payload slipped into
      // the feed before the tool-result redaction existed.
      .set({ [STORAGE_KEYS.feed]: redactSecrets(feed), [STORAGE_KEYS.history]: redactSecrets(history), [STORAGE_KEYS.cost]: this.cost })
      .catch(() => {});
  }

  /** Feed and run state in one write — used around writes so that, after a
   * restart, a write's chip and its in-flight marker always agree. */
  private async checkpointNow(): Promise<boolean> {
    this.clearCheckpoint();
    return chrome.storage.local
      .set({ [STORAGE_KEYS.feed]: redactSecrets(this.feed.slice(-150)), [STORAGE_KEYS.run]: this.run })
      .then(() => true, () => false);
  }

  private scheduleCheckpoint() {
    if (this.checkpointTimer || !this.running) return;
    this.checkpointTimer = setTimeout(() => {
      this.checkpointTimer = null;
      chrome.storage.local.set({ [STORAGE_KEYS.feed]: redactSecrets(this.feed.slice(-150)) }).catch(() => {});
    }, FEED_CHECKPOINT_MS);
  }

  private clearCheckpoint() {
    if (this.checkpointTimer) clearTimeout(this.checkpointTimer);
    this.checkpointTimer = null;
  }

  /** Record usage from one model call into the session totals. */
  private addUsage(provider: StoredSettings["provider"], modelId: string, usage?: CompletionResult["usage"]) {
    if (!usage) return;
    const { usd, estimated, reported } = computeCost(provider, modelId, usage);
    this.cost = {
      ...this.cost,
      usd: this.cost.usd + usd,
      turnUsd: this.cost.turnUsd + usd,
      inputTokens: this.cost.inputTokens + usage.inputTokens + usage.cacheWriteTokens,
      outputTokens: this.cost.outputTokens + usage.outputTokens,
      cacheReadTokens: this.cost.cacheReadTokens + usage.cacheReadTokens,
      requests: this.cost.requests + 1,
      estimatedRequests: this.cost.estimatedRequests + (estimated ? 1 : 0),
      reportedRequests: this.cost.reportedRequests + (reported ? 1 : 0),
    };
    this.emit({ type: "cost", cost: this.cost });
  }

  private pushFeed(item: FeedItem) {
    this.feed.push(item);
    this.emit({ type: "feed_patch", item });
    this.scheduleCheckpoint();
  }

  private patchFeed(item: FeedItem) {
    const idx = this.feed.findIndex((f) => f.id === item.id);
    if (idx >= 0) this.feed[idx] = item;
    else this.feed.push(item);
    this.emit({ type: "feed_patch", item });
    this.scheduleCheckpoint();
  }

  async clear() {
    await this.ready();
    this.generation++;
    this.startAbort?.abort();
    // A new session never runs underneath an old run.
    if (this.running) {
      this.stop();
      await this.runDone;
    }
    this.archiveSession(this.feed, this.cost);
    this.feed = [];
    this.history = [];
    this.catalog = null;
    this.cost = { ...EMPTY_COST };
    this.run = null;
    this.clearCheckpoint();
    chrome.storage.local
      .remove([STORAGE_KEYS.feed, STORAGE_KEYS.history, STORAGE_KEYS.cost, STORAGE_KEYS.run, "catalogContext", "copilotMessages"])
      .catch(() => {});
    this.emit({ type: "feed_reset" });
    this.emit({ type: "catalog", catalog: null });
    this.emit({ type: "cost", cost: this.cost });
    this.emitRun();
  }

  /** Snapshot the finished transcript into view-only history. Archives hold
   * the FEED only — never the model-facing history — so past sessions can be
   * browsed without a single token entering the next conversation. */
  private archiveSession(feed: FeedItem[], sessionCost: SessionCost) {
    const { turnUsd: _turn, ...cost } = sessionCost;
    if (!feed.some((f) => f.kind === "user" || f.kind === "assistant")) return;
    const settled = feed.map((item) =>
      item.kind === "assistant" ? { ...item, streaming: false }
      : item.kind === "approval" && item.status === "pending" ? { ...item, status: "expired" as const }
      : item
    );
    const firstUser = feed.find((f) => f.kind === "user");
    const rawTitle = (firstUser?.kind === "user" && firstUser.text.trim()) || "Untitled session";
    const title = rawTitle.length > 60 ? rawTitle.slice(0, 58) + "…" : rawTitle;
    void (async () => {
      try {
        const r = await chrome.storage.local.get("copilotSessions");
        const sessions: any[] = Array.isArray(r.copilotSessions) ? r.copilotSessions : [];
        sessions.unshift({
          id: "sess_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
          at: Date.now(),
          title,
          usd: cost.usd,
          cost,
          feed: redactSecrets(settled),
        });
        await chrome.storage.local.set({ copilotSessions: sessions.slice(0, 30) });
      } catch {
        /* archive is best-effort — never blocks starting a new session */
      }
    })();
  }

  clearCatalog() {
    this.catalog = null;
    chrome.storage.local.remove("catalogContext").catch(() => {});
    this.emit({ type: "catalog", catalog: null });
  }

  stop() {
    this.startAbort?.abort();
    this.abortController?.abort();
    if (this.pendingApproval) this.settleApproval(this.pendingApproval.id, "expired");
  }

  resolveApproval(id: string, approved: boolean) {
    if (this.pendingApproval?.id === id) this.settleApproval(id, approved ? "approved" : "denied");
  }

  private settleApproval(id: string, outcome: ApprovalOutcome) {
    const pending = this.pendingApproval;
    if (pending?.id !== id) return;
    clearTimeout(pending.timer);
    this.pendingApproval = null;
    const approval = this.feed.find((f) => f.kind === "approval" && f.id === id);
    if (approval && approval.kind === "approval" && approval.status === "pending") this.patchFeed({ ...approval, status: outcome });
    pending.resolve(outcome);
  }

  private startKeepalive() {
    // Periodic extension API calls reset the MV3 service-worker idle timer
    // during long turns (model latency, approval waits). They do not make the
    // run durable — the checkpoints below exist for the times Chrome stops the
    // worker anyway.
    this.stopKeepalive();
    this.keepaliveTimer = setInterval(() => {
      chrome.runtime.getPlatformInfo().catch(() => {});
    }, 20000);
  }

  private stopKeepalive() {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }

  /** Ask the user to approve pending write operations. Closing the panel never
   * implies an answer: the request stays pending until decided, stopped, or expired. */
  private requestApproval(
    ops: string[],
    destructive: boolean,
    where: string | undefined,
    signal: AbortSignal,
    explain?: ApprovalExplain,
    plan = false,
    helper = false,
  ): Promise<ApprovalOutcome> {
    // A stopped run asks nothing; stop() settles a request already showing.
    if (signal.aborted) return Promise.resolve("expired");
    const id = nextId("appr");
    const summary = helper
      ? "Approving installs only this Script Include."
      : plan
        ? "Approving builds this whole plan without asking again."
        : destructive
          ? "This includes a DELETE — confirm to proceed."
          : ops.length === 1
            ? "Confirm this change to your instance."
            : `Confirm these ${ops.length} changes to your instance.`;
    this.pushFeed({ kind: "approval", id, summary, ops, destructive, where, ...(explain ? { explain } : {}), ...(plan ? { plan } : {}), ...(helper ? { helper } : {}), status: "pending" });
    this.setRunStatus("awaiting_approval");
    return new Promise<ApprovalOutcome>((resolve) => {
      const timer = setTimeout(() => this.settleApproval(id, "expired"), APPROVAL_TIMEOUT_MS);
      this.pendingApproval = { id, resolve, timer };
    }).finally(() => this.setRunStatus("running"));
  }

  async sendChat(text: string, files: PlanFile[] = [], contextTabId?: number | null): Promise<void> {
    // Captured before anything asynchronous: the page the user was looking at,
    // and the instance selected when they sent. Later changes apply to later runs.
    const submitted = (typeof contextTabId === "number" ? this.getTabContext(contextTabId) : null) ?? this.getContext();
    const selectedHost = this.sn.getPreferredHost();
    await this.ready();
    if (this.running || this.starting) {
      // The composer already cleared itself — vanishing silently would read
      // as "sent". Say what actually happened to the message.
      this.pushFeed({
        kind: "notice",
        id: nextId("n"),
        text: "Still working on the previous message — that one wasn't sent. Wait for this turn to finish, then send it again.",
      });
      this.persist();
      return;
    }
    this.starting = true;
    try {
      const settings = await getSettings();
      const provider = settings.provider;

      this.pushFeed({ kind: "user", id: nextId("u"), text, fileNames: files.map((f) => f.name), at: Date.now() });

      if (!settings.apiKeys[provider]) {
        this.pushFeed({
          kind: "error",
          id: nextId("e"),
          text: `No ${PROVIDERS[provider].label} API key configured. Open Settings and paste a key from ${displayUrl(PROVIDERS[provider].keyUrl)}.`,
        });
        this.persist();
        return;
      }
      if (!(await this.readyToRun(settings))) return;
      // The bridge mirrors the selection synchronously; settings are the
      // fallback while a just-started worker is still syncing it.
      const instance = settings.instances.find((i) => i.id === settings.activeInstanceId) || null;
      await this.execute({ settings, host: selectedHost ?? instance?.host ?? null, prompt: { text, files, submitted } });
    } finally {
      this.starting = false;
    }
  }

  /** Continue an interrupted or failed run from its last checkpoint — on the
   * instance it started on, whatever is selected now. */
  async resumeRun(runId: string): Promise<void> {
    await this.ready();
    const run = this.run;
    if (this.running || this.starting || !run || run.id !== runId || !run.resumable || !this.canResume()) return;
    this.starting = true;
    try {
      const settings = await getSettings();
      const provider = settings.provider;
      if (!settings.apiKeys[provider]) {
        this.pushFeed({ kind: "error", id: nextId("e"), text: `No ${PROVIDERS[provider].label} API key configured. Open Settings and paste a key, then resume.` });
        this.persist();
        return;
      }
      if (!(await this.readyToRun(settings))) return;
      this.pushFeed({ kind: "notice", id: nextId("n"), text: `Resuming from the last completed step${run.host ? ` on ${run.host}` : ""}.` });
      await this.execute({ settings, host: run.host, resume: run });
    } finally {
      this.starting = false;
    }
  }

  /** A send may start once it has a model; false when it was stopped, cleared
   * away, or has no model (the feed then says why). */
  private async readyToRun(settings: StoredSettings): Promise<boolean> {
    const generation = this.generation;
    const outcome = await this.ensureModel(settings);
    if (generation !== this.generation) return false;
    if (outcome === "stopped") {
      this.pushFeed({ kind: "notice", id: nextId("n"), text: "Stopped." });
      this.persist();
    }
    return outcome === "ready";
  }

  /**
   * Nothing hard-codes a model id: until the user picks one, the provider's
   * live catalog names the default, which is then kept as their choice — unless
   * they picked one while the list was loading, which wins. Reports a failure
   * in the feed; a stop or a New chat while loading is not a failure.
   */
  private async ensureModel(settings: StoredSettings): Promise<"ready" | "failed" | "stopped"> {
    const provider = settings.provider;
    if (settings.models[provider]) return "ready";
    const label = PROVIDERS[provider].label;
    const stop = new AbortController();
    this.startAbort = stop;
    let reason: string;
    try {
      const pick = pickDefaultModel(provider, await getModelCatalog(provider, settings.apiKeys[provider], false, stop.signal));
      if (stop.signal.aborted) return "stopped";
      if (pick) {
        settings.models = { ...settings.models, [provider]: await setDefaultModel(provider, pick) };
        this.emit({ type: "settings", settings: await toPublicSettings(await getSettings()) });
        return "ready";
      }
      reason = `${label} returned no models for this key`;
    } catch (e: any) {
      if (stop.signal.aborted) return "stopped";
      reason = `Couldn't load ${label} models (${e?.message || e})`;
    } finally {
      if (this.startAbort === stop) this.startAbort = null;
    }
    this.pushFeed({ kind: "error", id: nextId("e"), text: `${reason}. Check the key in Settings, or choose a model in the model picker.` });
    this.persist();
    return "failed";
  }

  private async execute(plan: RunPlan): Promise<void> {
    let settle!: () => void;
    this.runDone = new Promise<void>((resolve) => { settle = resolve; });
    // Stoppable from the first moment, before anything asynchronous.
    this.running = true;
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    const session = (await this.browserSession()).id;
    const now = Date.now();
    const run: RunRecord = plan.resume
      ? { ...plan.resume, status: "running", failure: undefined, resumable: false, endedAt: undefined, updatedAt: now, session, resumes: (plan.resume.resumes || 0) + 1 }
      : { id: nextId("run"), status: "running", host: plan.host, startedAt: now, updatedAt: now, resumable: false, session, resumes: 0 };
    const provider = plan.settings.provider;
    this.run = run;
    this.cost = { ...this.cost, turnUsd: 0 };
    this.emit({ type: "cost", cost: this.cost });
    this.emit({ type: "turn_state", running: true });
    this.emitRun();
    this.startKeepalive();
    // The message and the run marker land together, before any slow step, so
    // a restart from here on can never report a run whose message is lost.
    await this.checkpointNow();
    void recordRunEvent(plan.resume ? "run_resume" : "run_start", { runId: run.id });

    let end: RunEnd = { status: "completed" };
    try {
      end = await this.drive(plan, signal);
    } catch (err: any) {
      if (err?.name === "AbortError" || signal.aborted) {
        this.pushFeed({ kind: "notice", id: nextId("n"), text: "Stopped." });
        end = { status: "stopped" };
      } else if (err instanceof RunInterruption) {
        this.pushFeed({ kind: "notice", tone: "warning", id: nextId("n"), runId: run.id, text: err.notice });
        end = { status: "interrupted", failure: err.kind, resumable: true };
      } else {
        const kind = classifyProviderFailure(provider, err);
        this.pushFeed({ kind: "error", id: nextId("e"), runId: run.id, text: friendlyProviderError(provider, err) });
        end = { status: "failed", failure: kind, resumable: true };
        void recordRunEvent("provider_failure", { runId: run.id, detail: kind });
      }
    } finally {
      this.running = false;
      this.abortController = null;
      this.stopKeepalive();
      this.sn.endTurn();
      this.unverifiedWrites.clear();
      this.run = { ...run, ...end, batch: null, resumable: !!end.resumable && this.canResume(), endedAt: Date.now(), updatedAt: Date.now() };
      this.emit({ type: "turn_state", running: false });
      this.emitRun();
      this.persist();
      this.saveRun();
      void recordRunEvent("run_end", { runId: run.id, detail: end.failure ?? end.status });
      settle();
    }
  }

  private async drive(plan: RunPlan, signal: AbortSignal): Promise<RunEnd> {
    const run = this.run!;
    const { settings } = plan;
    await this.sn.beginTurn(run.host, signal);
    if (signal.aborted) throw abortError();
    // A run sent with no instance selected belongs, from here on, to the one
    // the bridge bound for it: the write guard, every request and any resume
    // then agree on a single host.
    if (!run.host) {
      run.host = this.sn.getPreferredHost();
      if (run.host) { this.saveRun(); this.emitRun(); }
    }
    const boundHost = await this.sn.getBoundTabHost();
    const instance = run.host ? settings.instances.find((i) => i.host === run.host) || null : null;
    if (run.host) {
      const label = instance?.label ?? run.host;
      if (boundHost && boundHost !== run.host) {
        this.pushFeed({
          kind: "notice",
          id: nextId("n"),
          text: `Instance mismatch — the tab I'd work on is ${boundHost}, but this run belongs to ${label} (${run.host}). ` +
            `Open a ${run.host} tab, then try again.`,
        });
        return { status: "failed", failure: "servicenow_unavailable", resumable: !!plan.resume };
      }
      if (!boundHost) {
        // Strict binding refused every open tab — none is ready on this host.
        this.pushFeed({
          kind: "notice",
          id: nextId("n"),
          text:
            `No ready ${label} tab is available. A background recovery tab may need to finish loading. ` +
            `Open the instance, sign in if needed, or refresh the page, then try again.`,
        });
        return { status: "failed", failure: "servicenow_unavailable", resumable: !!plan.resume };
      }
    }

    // Environment guard: every instance accepts writes, each one approved,
    // unless the user marked it Production — that one is read-only, always.
    // An instance never added in Settings accepts them too.
    const target: RunTarget = { host: run.host, instance: run.host ? settings.instances.find((i) => i.host === run.host) ?? null : null };

    if (plan.prompt) {
      await this.sn.requestContextRefresh();
      await new Promise((r) => setTimeout(r, 400));
      if (signal.aborted) throw abortError();
      // Calibration only from the instance itself, and only one the user added.
      const calibration = target.instance ? await getCalibration(target.instance.host) : null;
      const contextBlock = buildContextBlock(this.contextForRun(plan.prompt.submitted, run.host), this.catalog, calibration, target);
      const { text, files } = plan.prompt;
      const textFiles = files.filter((f) => !f.isImage);
      const fileText = textFiles.length
        ? "\n\nAttached files:\n" + textFiles.map((f) => `--- FILE: ${f.name} ---\n${truncate(f.content, 60000)}`).join("\n\n")
        : "";
      const images = files
        .filter((f) => f.isImage && f.content)
        .map((f) => ({ mediaType: f.type || "image/png", data: f.content, name: f.name }));
      this.history.push({
        role: "user",
        text: `${contextBlock}\n\n${text}${fileText}`,
        images: images.length ? images : undefined,
      });
      this.trimHistory();
      // Checkpoint: from here on the run can be resumed.
      this.persist();
    } else {
      // Resuming: every write of this run whose outcome is unknown — including
      // one cut off by a restart — stays unrepeatable.
      for (const digest of run.unknownWrites ?? []) this.unverifiedWrites.add(digest);
      if (run.inflightWrite) this.unverifiedWrites.add(run.inflightWrite.digest);
    }
    return this.loop(plan.settings, signal, target);
  }

  /** The page context the user had on screen when they sent, on the run's instance. */
  private contextForRun(submitted: SnContext | null, host: string | null): SnContext | null {
    if (submitted && (!host || submitted.hostname?.toLowerCase() === host)) {
      const fresh = submitted.tabId !== undefined ? this.getTabContext(submitted.tabId) : null;
      // Fresher values for the same page — never a record other than the one on screen.
      return fresh && fresh.url === submitted.url ? fresh : submitted;
    }
    return this.getContext();
  }

  private async loop(settings: StoredSettings, signal: AbortSignal, target: RunTarget): Promise<RunEnd> {
    const run = this.run!;
    const provider = settings.provider;
    const apiKey = settings.apiKeys[provider];
    const modelId = settings.models[provider];
    const adapter = getAdapter(provider);
    // What the model's list says about it (never a fetch), and the effort
    // chosen for it — only if it still takes that level.
    const model = await cachedModelEntry(provider, apiKey, modelId).catch(() => undefined);
    const effort = chosenEffort(settings.efforts, provider, modelId, modelEfforts(provider, modelId, model).efforts);

    // One approval per response: the plan's card (propose_plan), or the first
    // write batch's card if the model made no plan. Once approved, every
    // change in the response runs without asking again. A new message, a new
    // plan or a resumed run asks again.
    let approved = false;
    /** The user approved installing or updating the helper Script Include, on its own card. */
    let helperApproved = false;
    /** The helper card's answer: it is asked at most once a response. */
    let helperVerdict: ApprovalOutcome | null = null;
    let lock = writeLockFor(target.host, target.instance);
    // An instance never added says so on the card: marking it Production in
    // Settings is how the user makes it read-only.
    const where = target.host
      ? `${target.instance?.label ?? target.host.split(".")[0]} · ${target.host}${target.instance ? "" : " · not added in Settings"}`
      : undefined;
    // Turn-scoped ledger of attempted creates — a repeated create for the same
    // logical record re-verifies against the instance instead of duplicating.
    const createLedger = new Map<string, number>();

    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      if (signal.aborted) throw abortError();

      const assistantId = nextId("a");
      let streamedText = "";
      let lastFlush = 0;

      let result: CompletionResult;
      try {
        result = await adapter.complete(apiKey, {
          modelId,
          effort,
          model,
          system: STATIC_SYSTEM_PROMPT,
          tools: TOOL_DEFINITIONS,
          // Byte-capped copy: old screenshots age out of requests (named markers
          // stay behind); this.history itself keeps the originals.
          history: capHistoryImages(this.history),
          signal,
          onTextDelta: (delta) => {
            streamedText += delta;
            const now = Date.now();
            if (streamedText.trim() && now - lastFlush > 80) {
              lastFlush = now;
              this.patchFeed({ kind: "assistant", id: assistantId, text: streamedText, streaming: true });
            }
          },
        });
      } catch (err) {
        // Stopped or cut off mid-answer: the provider still bills what it
        // processed, so the session total counts it too.
        this.addUsage(provider, modelId, partialUsageOf(err));
        throw err;
      }

      this.addUsage(provider, modelId, result.usage);

      const finalText = result.text || streamedText;
      if (finalText.trim()) {
        this.patchFeed({ kind: "assistant", id: assistantId, text: finalText, streaming: false });
      } else {
        this.feed = this.feed.filter((f) => f.id !== assistantId);
      }

      const toolUses = this.uniqueCalls(result.toolCalls);
      const renamed = toolUses.some((call, i) => call.id !== result.toolCalls[i].id);
      this.history.push({
        role: "assistant",
        text: finalText,
        toolCalls: toolUses,
        // Provider-native content carries the original ids; drop it if any changed.
        raw: result.raw?.content && !renamed ? result.raw : undefined,
      });

      if (result.stopReason !== "tool_use" || toolUses.length === 0) {
        // A model can stop early (e.g. out of tokens) with calls it never
        // finished asking for. They were not run; say so, so the
        // conversation stays valid for the next message.
        if (toolUses.length) {
          this.history.push({
            role: "tool_results",
            results: toolUses.map((call) => ({
              toolCallId: call.id,
              content: JSON.stringify({ not_run: true, message: "The response ended before this tool call could run. Nothing was executed." }),
              isError: true,
            })),
          });
        }
        this.persist();
        return { status: "completed" };
      }
      this.persist();

      const toolResults: NeutralToolResult[] = [];
      let chipGroupId: string | null = null;
      try {
        const digests = new Map<string, string>();
        for (const t of toolUses) if (WRITE_TOOLS.has(t.name)) digests.set(t.id, await writeDigest(t.name, t.input));
        // Stop may have landed while the fingerprints were computed.
        if (signal.aborted) throw abortError();
        const unverified = (t: NeutralToolCall) => digests.has(t.id) && this.unverifiedWrites.has(digests.get(t.id)!);

        // ── Approval gate ──
        // A repeat of a write whose outcome is unknown is refused below, so it
        // is never put in front of the user for approval.
        const writeOps = toolUses.filter((t) => WRITE_TOOLS.has(t.name) && !unverified(t));
        const destructiveOps = writeOps.filter((t) => DESTRUCTIVE_TOOLS.has(t.name));
        const planCall = toolUses.find((t) => t.name === PLAN_TOOL);
        const planSteps: string[] = Array.isArray(planCall?.input?.steps)
          ? planCall!.input.steps.map((s: unknown) => String(s ?? "").trim()).filter(Boolean)
          : [];
        let planVerdict: ApprovalOutcome | null = null;
        let verdict: ApprovalOutcome | null = null;

        // The instance's environment is read again before every batch of
        // writes: made read-only mid-run, it stops them. It only ever tightens.
        if ((writeOps.length > 0 || planCall) && !lock) lock = await currentWriteLock(target.host);

        // The plan: one card listing every change. Approved, the rest of the
        // response builds without asking again.
        if (planCall && planSteps.length && !lock) {
          // The detailed plan, in Markdown, sits right above its card.
          const details = typeof planCall.input?.details === "string" ? planCall.input.details.trim() : "";
          if (details) this.pushFeed({ kind: "assistant", id: nextId("a"), text: details });
          planVerdict = await this.requestApproval(planSteps, false, where, signal, undefined, true);
          if (signal.aborted) throw abortError();
          if (planVerdict === "approved") {
            approved = true;
          } else {
            // A rejected plan ends the approval: anything after it asks again.
            verdict = planVerdict;
            approved = false;
          }
        }

        // No plan: the first batch of changes is the one approval instead.
        if (writeOps.length > 0 && !lock && !verdict && !approved) {
          const ops = writeOps.map((t) => describeWriteOp(t.name, t.input));
          const outcome = await this.requestApproval(ops, destructiveOps.length > 0, where, signal);
          if (signal.aborted) throw abortError();
          if (outcome === "approved") approved = true;
          else verdict = outcome;
        }

        // A catalog UI policy action goes through the helper Script Include.
        // Installing or replacing it is never part of another approval: once
        // the changes are approved, it gets its own card — why it's needed,
        // what it does — right after a plan that says it creates UI policy
        // actions, or before the first batch that creates one. Asked once a
        // response; rejected, the actions aren't created and the rest goes ahead.
        const needsHelper = writeOps.some((t) => usesHelper(t.name, t.input)) ||
          (planVerdict === "approved" && planCall?.input?.ui_policy_actions === true);
        if (needsHelper && approved && !lock && !verdict && !helperApproved && !helperVerdict) {
          const helper = await helperStatus(this.sn);
          if (signal.aborted) throw abortError();
          if (helper === "install" || helper === "update") {
            const line = `${helper === "install" ? "Install" : "Update"} the SNAICopilotHelper Script Include (sys_script_include), used to create catalog UI policy actions`;
            helperVerdict = await this.requestApproval([line], false, where, signal, helperExplanation(helper), false, true);
            if (signal.aborted) throw abortError();
            helperApproved = helperVerdict === "approved";
          }
        }

        // ── Execute tools ──
        const groupId = nextId("tg");
        chipGroupId = groupId;
        const chips: ToolChip[] = toolUses.map((t) => {
          const { label, detail } = toolLabel(t.name, t.input);
          return { id: t.id, name: t.name, label, detail, status: "queued" as const };
        });
        this.pushFeed({ kind: "tools", id: groupId, tools: chips });
        run.batch = groupId;
        this.saveRun();

        const updateChip = (toolId: string, patch: Partial<ToolChip>) => {
          const group = this.feed.find((f) => f.id === groupId);
          if (group && group.kind === "tools") {
            this.patchFeed({
              ...group,
              tools: group.tools.map((c) => (c.id === toolId ? { ...c, ...patch } : c)),
            });
          }
        };

        const failures: (string | undefined)[] = [];
        for (const tool of toolUses) {
          if (signal.aborted) throw abortError();

          let resultPayload: any;
          const isWrite = WRITE_TOOLS.has(tool.name);

          // And again right before each write: marked Production while a card
          // waited, or partway through a batch, every write not yet sent stops.
          if (isWrite && !lock) {
            lock = await currentWriteLock(target.host);
            if (signal.aborted) throw abortError();
          }

          if (isWrite && lock) {
            resultPayload = { success: false, message: lock.message };
            updateChip(tool.id, { status: "error", summary: lock.summary });
          } else if (isWrite && verdict) {
            resultPayload = verdict === "expired"
              ? { declined: true, expired: true, message: "The approval request expired before the user answered. Nothing was changed. Do not retry automatically; ask whether they still want this change." }
              : { declined: true, message: "The user declined this operation. Do not retry it. Ask what they'd like to change, or stop." };
            updateChip(tool.id, { status: "error", summary: verdict === "expired" ? "approval expired" : "declined" });
          } else if (usesHelper(tool.name, tool.input) && helperVerdict && helperVerdict !== "approved") {
            resultPayload = {
              declined: true,
              message: (helperVerdict === "expired"
                ? "The approval to install the SNAICopilotHelper Script Include expired before the user answered"
                : "The user declined installing the SNAICopilotHelper Script Include") +
                ", so this catalog UI policy action was not created. Nothing was changed. Don't retry it in this response: " +
                "tell the user which actions are missing, that they can add them on the UI policy's form, or approve the helper next time.",
            };
            updateChip(tool.id, { status: "error", summary: helperVerdict === "expired" ? "helper approval expired" : "helper declined" });
          } else if (isWrite && unverified(tool)) {
            resultPayload = {
              success: false,
              outcome: "unknown",
              error: "This exact change already has an unknown outcome in this run, so it was not sent again. Query the record to verify; do not repeat it in this run.",
            };
            updateChip(tool.id, { status: "unknown", summary: "not repeated — verify first" });
          } else if (tool.name === PLAN_TOOL) {
            const plan = planResult(tool === planCall ? planVerdict : null, lock, tool === planCall ? planSteps : []);
            resultPayload = plan.payload;
            updateChip(tool.id, { status: plan.status, summary: plan.summary });
          } else {
            updateChip(tool.id, { status: "running" });
            let saved = true;
            if (isWrite) {
              // Marker and step land together before the write is sent. If they
              // can't be saved, a restart mid-write could not be reported
              // truthfully, so the write is not sent.
              run.inflightWrite = { id: tool.id, name: tool.name, digest: digests.get(tool.id)! };
              saved = await this.checkpointNow();
              if (!saved) delete run.inflightWrite;
            }
            if (!saved) {
              resultPayload = {
                success: false,
                not_sent: true,
                error: "Progress couldn't be saved before this change, so it was not sent. Nothing was changed. " +
                  "Do not retry changes in this run; tell the user the extension couldn't save its progress (browser storage may be full).",
              };
            } else {
              try {
                resultPayload = await executeTool(tool.name, tool.input, {
                  sn: this.sn,
                  createLedger,
                  helperApproved,
                  onProgress: (step) => updateChip(tool.id, { summary: step }),
                  trackCreated: (table, rec, data) => {
                    if (table === "sc_cat_item" && rec.sys_id) {
                      this.catalog = { name: data?.name || "Catalog Item", sys_id: rec.sys_id, category: data?.category };
                      chrome.storage.local.set({ catalogContext: this.catalog }).catch(() => {});
                      this.emit({ type: "catalog", catalog: this.catalog });
                    }
                  },
                });
              } catch (e: any) {
                resultPayload = { error: e?.message || String(e) };
              }
            }
            const uncertain = resultPayload?.outcome === "unknown";
            const failed = !!(resultPayload?.error || resultPayload?.success === false);
            updateChip(tool.id, {
              status: uncertain ? "unknown" : failed ? "error" : "ok",
              summary: uncertain ? "outcome unknown — verify" : !saved ? "not sent — couldn't save progress" : summarizeResult(tool.name, resultPayload),
            });
            if (isWrite && saved) {
              if (uncertain) {
                run.unknownWrites = [...(run.unknownWrites ?? []), digests.get(tool.id)!];
                this.unverifiedWrites.add(digests.get(tool.id)!);
              }
              delete run.inflightWrite;
              await this.checkpointNow();
            }
            failures.push(resultPayload?.failure);
            if (resultPayload?.failure) void recordRunEvent("servicenow_failure", { runId: run.id, detail: resultPayload.failure });
          }

          toolResults.push({
            toolCallId: tool.id,
            // Redacted before the model and history ever see it: instance data
            // (sys_properties, script fields) routinely embeds credentials.
            content: truncate(JSON.stringify(redactSecrets(resultPayload)), MAX_TOOL_RESULT_CHARS),
            isError: !!(resultPayload?.error && !resultPayload?.declined),
          });
        }

        this.history.push({ role: "tool_results", results: toolResults });
        run.batch = null;
        this.persist();
        this.saveRun();

        // Every ServiceNow call in the batch failed for the same reason the
        // user has to fix: pause with that reason instead of letting the model
        // flail. The results are kept, so resuming continues from here.
        if (failures.length && failures.every((f) => f === "authentication")) {
          throw new RunInterruption("sign_in_required", NOTICES.sign_in_required!(run.host, true));
        }
        if (failures.length && failures.every((f) => f === "no_tab" || f === "incompatible")) {
          throw new RunInterruption("servicenow_unavailable", NOTICES.servicenow_unavailable!(run.host, true));
        }
      } catch (err) {
        // Stopped mid-batch: answer every call so the conversation stays
        // valid for the next message, keeping the results that did finish,
        // and show the steps that never started as not run.
        if (!(err instanceof RunInterruption)) {
          this.closeUnfinishedToolCalls("stopped", toolResults, chipGroupId);
          this.settleUnfinishedSteps(true);
          run.batch = null;
        }
        throw err;
      }
    }

    this.pushFeed({
      kind: "error",
      id: nextId("e"),
      text: `Stopped after ${MAX_ITERATIONS} tool rounds. Ask me to continue if the task isn't finished.`,
    });
    return { status: "completed" };
  }

  /** Tool-call ids tie a call to its result. Some providers and models invent
   * them and may repeat one from an earlier turn, which would let one call's
   * record answer for another — so repeats are renamed. */
  private uniqueCalls(calls: NeutralToolCall[]): NeutralToolCall[] {
    const seen = new Set<string>();
    for (const message of this.history) if (message.role === "assistant") for (const call of message.toolCalls) seen.add(call.id);
    return calls.map((call, index) => {
      const base = call.id || `call_${index}`;
      let id = base;
      for (let n = 2; seen.has(id); n++) id = `${base}_${n}`;
      seen.add(id);
      return id === call.id ? call : { ...call, id };
    });
  }

  /** Trim history at plain-user-message boundaries so tool-call pairs stay intact. */
  private trimHistory() {
    if (this.history.length <= MAX_HISTORY_MESSAGES) return;
    let cut = this.history.length - MAX_HISTORY_MESSAGES;
    while (cut < this.history.length && this.history[cut].role !== "user") cut++;
    this.history = this.history.slice(cut);
  }
}

/** What the model is told about its plan, and what the plan's step shows. */
function planResult(verdict: ApprovalOutcome | null, lock: WriteLock | null, steps: string[]): { payload: any; status: ToolChip["status"]; summary: string } {
  if (lock) return { payload: { success: false, message: lock.message }, status: "error", summary: lock.summary };
  if (!steps.length) {
    return { payload: { error: "steps is required: one line per change, and only one plan per batch of calls. Nothing was shown to the user." }, status: "error", summary: "not shown" };
  }
  if (verdict === "approved") {
    return {
      payload: { approved: true, message: "The user approved the plan. Make every change in it now, in this response, without stopping: no other approval will be asked." },
      status: "ok",
      summary: "approved",
    };
  }
  return verdict === "expired"
    ? { payload: { declined: true, expired: true, message: "The plan's approval expired before the user answered. Make no changes; ask whether they still want it." }, status: "error", summary: "approval expired" }
    : { payload: { declined: true, message: "The user rejected the plan. Make no changes. Ask what they'd like to change." }, status: "error", summary: "rejected" };
}

function summarizeResult(name: string, payload: any): string {
  if (payload?.declined) return "declined";
  if (payload?.error) return String(payload.error).slice(0, 120);
  switch (name) {
    case "query_records":
      return `${payload?.count ?? 0} record${payload?.count === 1 ? "" : "s"}`;
    case "count_records":
      return `count: ${payload?.count ?? 0}`;
    case "get_table_schema":
      return `${payload?.field_count ?? 0} fields`;
    case "get_field_choices":
      return `${payload?.choices?.length ?? 0} choices`;
    case "search_code":
      return `${payload?.match_count ?? 0} matches` + (payload?.failed_tables?.length ? ` · ${payload.failed_tables.length} tables unreadable` : "");
    case "get_record":
      return "loaded";
    case "create_record":
      if (payload?.skipped) return "exists (skipped)";
      return payload?.not_saved?.length ? `created · not saved: ${payload.not_saved.join(", ")}` : payload?.sys_id ? "created" : "done";
    case "update_record":
      return payload?.not_saved?.length ? `updated · not saved: ${payload.not_saved.join(", ")}` : "updated";
    case "delete_record":
      return "deleted";
    default:
      return "done";
  }
}
