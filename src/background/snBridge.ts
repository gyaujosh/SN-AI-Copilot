// Verified, document-bound transport through a ServiceNow page.
import { BRIDGE_VERSION, INITIAL_CONNECTION, eligibleServiceNowUrl, serviceNowHost } from "../shared/connection";
import type { BridgeHealth, ConnectionFailure, ConnectionState } from "../shared/connection";

export interface SnResponse {
  data: any;
  error: string | null;
  requestId?: string;
  status?: number;
  failure?: ConnectionFailure;
  outcome?: "unknown";
}
interface Binding { tabId: number; host: string; documentToken: string; generation: number; verifiedAt: number }
interface PendingRequest {
  binding: Binding;
  resolve: (r: SnResponse) => void;
  timer: ReturnType<typeof setTimeout>;
  live?: ReturnType<typeof setTimeout>;
}
interface Diagnostic {
  at: number; event: string; host: string | null; tabId?: number; windowId?: number;
  generation?: number; discarded?: boolean; frozen?: boolean; loading?: boolean;
}
const PROBE_MS = 2000;
const RECOVERY_MS = 8000;
/** A binding verified this recently is reused without a new probe. The page
 * still refuses any request addressed to a different document. */
const FRESH_MS = 30000;
/** While a request is outstanding the tab is pinged this often, so a slow
 * ServiceNow answer can be told apart from a page that is gone or frozen. */
const LIVENESS_MS = 4000;
const PING_MS = 1500;
const READ_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = [0, 250, 1000];
const RETRYABLE_READ = new Set<ConnectionFailure | undefined>(["transport", "timeout", "network", "not_sent", "document_changed", "no_tab"]);
const RECEIVER_MISSING = /Receiving end does not exist|Could not establish connection|no receiver/i;
const failure = (kind: ConnectionFailure, error: string): SnResponse => ({ data: null, error, failure: kind });
const cancelled = (): SnResponse => failure("cancelled", "Stopped before ServiceNow answered.");
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function bounded<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("deadline")), Math.max(1, ms));
    })]);
  } finally { clearTimeout(timer); }
}
function abortableDelay(ms: number, signal?: AbortSignal | null): Promise<void> {
  if (!signal) return delay(ms);
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() { clearTimeout(timer); signal!.removeEventListener("abort", done); resolve(); }
    signal.addEventListener("abort", done, { once: true });
  });
}
/** A promise that settles early (as null) when the signal aborts. */
function unlessAborted<T>(promise: Promise<T>, signal: AbortSignal | null): Promise<T | null> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.resolve(null);
  return new Promise<T | null>((resolve, reject) => {
    const stop = () => resolve(null);
    signal.addEventListener("abort", stop, { once: true });
    promise.then((v) => { signal.removeEventListener("abort", stop); resolve(v); },
      (e) => { signal.removeEventListener("abort", stop); reject(e); });
  });
}
const sameDocument = (a: Binding, b: Binding) => a.tabId === b.tabId && a.documentToken === b.documentToken && a.generation === b.generation;

// Table names and record ids arrive from the model. They become URL path
// segments, so anything but a plain name or a 32-hex sys_id is refused before
// a request is built — a crafted name could otherwise walk the path to any
// endpoint on the instance, read-only or not.
const TABLE_NAME = /^[a-z0-9_]+$/;
const SYS_ID = /^[0-9a-f]{32}$/;
const refused = (what: string, value: unknown): SnResponse =>
  ({ data: null, error: `Invalid ${what}: ${JSON.stringify(String(value)).slice(0, 80)}. Nothing was sent.` });
function badTable(table: unknown): SnResponse | null {
  return typeof table === "string" && TABLE_NAME.test(table) ? null : refused("table name", table);
}
function badRecord(table: unknown, sysId: unknown): SnResponse | null {
  return badTable(table) ?? (typeof sysId === "string" && SYS_ID.test(sysId) ? null : refused("sys_id", sysId));
}
/** A sort field, as order_by takes it: a name, dot-walked or not. */
const ORDER_FIELD = /^[a-z0-9_.]+$/i;

// An encoded query is not only data: ServiceNow evaluates a `javascript:` value
// as server-side script, so a "read" could run code with the user's rights —
// on an instance without the script sandbox, code that changes things. Only
// the standard date and current-user helpers are let through.
const QUERY_SCRIPT = /javascript\s*:/gi;
const SAFE_QUERY_SCRIPT = new RegExp(
  "^javascript:(?:" +
    "gs\\.getUserID\\(\\)|gs\\.getUser\\(\\)\\.getMyGroups\\(\\)|getMyGroups\\(\\)|" +
    "gs\\.(?:beginningOf|endOf)[A-Za-z0-9]+\\(\\)|" +
    "gs\\.(?:minutes|hours|days|months|quarters|years)Ago(?:Start|End)?\\(\\s*-?\\d+\\s*\\)|" +
    "gs\\.dateGenerate\\('\\d{4}-\\d{2}-\\d{2}',\\s*'(?:\\d{2}:\\d{2}:\\d{2}|start|end)'\\)" +
    ")(?=$|[\\^@])"
);
/** The script in a query that isn't one of the allowed helpers, or null. */
export function scriptInQuery(query: string): string | null {
  for (const match of query.matchAll(QUERY_SCRIPT)) {
    const rest = query.slice(match.index);
    if (!SAFE_QUERY_SCRIPT.test(rest)) return rest.split("^")[0].slice(0, 80);
  }
  return null;
}
/** Why the model's query is refused before anything is sent, or null. */
export function refusedQuery(query: unknown): SnResponse | null {
  const script = typeof query === "string" && query ? scriptInQuery(query) : null;
  return script === null ? null : {
    data: null,
    error: `Queries can't run script: ${JSON.stringify(script)} was refused, and nothing was sent. ` +
      "javascript: is accepted only for the standard helpers (gs.getUserID(), gs.getUser().getMyGroups(), gs.beginningOf…()/gs.endOf…(), gs.daysAgo(n) and the other …Ago(n) forms). " +
      "Filter on plain values instead.",
  };
}
/** A whole number in [min, max], or the fallback. */
function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= min ? Math.min(n, max) : fallback;
}

export class SnBridge {
  private pending = new Map<string, PendingRequest>();
  private binding: Binding | null = null;
  private preferredHost: string | null = null;
  private turnHost: string | null = null;
  private turnActive = false;
  private turnSignal: AbortSignal | null = null;
  private epoch = 0;
  private generations = new Map<number, number>();
  private injected = new Map<number, number>();
  private verifyTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private recovery: { key: string; promise: Promise<Binding | null> } | null = null;
  private recoveryTabs = new Map<string, { id: number; createdAt: number }>();
  private connection: ConnectionState = { ...INITIAL_CONNECTION };
  private onConnection: (state: ConnectionState) => void = () => {};
  private diagnostics: Diagnostic[] = [];
  private diagnosticWrite: Promise<void> = Promise.resolve();
  private authHost: string | null = null;
  private probeReasons = new Map<number, ConnectionFailure>();
  private uncertainWrites = new Set<string>();

  setConnectionListener(listener: (state: ConnectionState) => void) { this.onConnection = listener; }
  getConnection(): ConnectionState { return { ...this.connection }; }
  getDiagnostics(): Diagnostic[] { return this.diagnostics.map((entry) => ({ ...entry })); }
  isTurnActive(): boolean { return this.turnActive; }
  private state(phase: ConnectionState["phase"], reason?: ConnectionFailure) {
    const host = this.getPreferredHost();
    const changed = phase !== this.connection.phase || reason !== this.connection.reason || host !== this.connection.host;
    this.connection = { phase, host, checkedAt: Date.now(), reason };
    if (changed) this.onConnection(this.getConnection());
  }
  private log(event: string, tab?: chrome.tabs.Tab) {
    this.diagnostics.push({ at: Date.now(), event, host: this.getPreferredHost(),
      ...(tab ? { tabId: tab.id, windowId: tab.windowId, generation: this.generations.get(tab.id!) || 0,
        discarded: !!tab.discarded, frozen: !!(tab as chrome.tabs.Tab & { frozen?: boolean }).frozen,
        loading: tab.status === "loading" } : {}) });
    this.diagnostics = this.diagnostics.slice(-100);
    const snapshot = this.getDiagnostics();
    // Serialize writes; only sanitized metadata is retained, never request payloads.
    this.diagnosticWrite = this.diagnosticWrite.then(() => chrome.storage.session.set({ snConnectionDiagnostics: snapshot })).catch(() => {});
  }
  setPreferredHost(host: string | null, _strict = false) {
    const next = host ? serviceNowHost(`https://${host}/`) : null;
    if (next === this.preferredHost) return;
    this.preferredHost = next;
    if (!this.turnActive) { this.epoch++; this.binding = null; this.state("checking"); }
  }
  getPreferredHost(): string | null { return this.turnActive ? this.turnHost : this.preferredHost; }
  /** Freeze the host for a run. `signal` cancels waits and read retries when the run stops. */
  async beginTurn(host: string | null, signal?: AbortSignal): Promise<number | null> {
    this.epoch++;
    this.turnActive = true;
    this.turnSignal = signal ?? null;
    this.uncertainWrites.clear();
    this.turnHost = host ? serviceNowHost(`https://${host}/`) : null;
    if (this.binding?.host !== this.turnHost) this.binding = null;
    return this.bindTab(true);
  }
  endTurn() {
    this.turnActive = false;
    this.turnHost = null;
    this.turnSignal = null;
    this.epoch++;
    if (this.binding?.host !== this.preferredHost) { this.binding = null; this.state("checking"); }
  }
  getBoundTabId(): number | null { return this.binding?.tabId ?? null; }
  async getBoundTabHost(): Promise<string | null> {
    if (!this.binding) return null;
    try { return serviceNowHost((await chrome.tabs.get(this.binding.tabId)).url); } catch { return null; }
  }
  releaseBinding() { this.binding = null; this.epoch++; }

  /** The relay document is gone: closed, discarded, replaced or unloaded. */
  invalidateTab(tabId: number, removed = false) {
    this.generations.set(tabId, (this.generations.get(tabId) || 0) + 1);
    this.injected.delete(tabId);
    this.probeReasons.delete(tabId);
    clearTimeout(this.verifyTimers.get(tabId));
    this.verifyTimers.delete(tabId);
    if (this.binding?.tabId === tabId) { this.binding = null; this.state("reconnecting", "document_changed"); }
    for (const [id, entry] of this.pending) {
      if (entry.binding.tabId === tabId) this.finish(id, failure("transport", "The ServiceNow page changed before the response arrived."));
    }
    if (removed) {
      // Keep the recovery cooldown even if the user closes the tab.
      for (const entry of this.recoveryTabs.values()) if (entry.id === tabId) entry.id = -1;
    }
    this.log(removed ? "tab_closed" : "document_changed", { id: tabId } as chrome.tabs.Tab);
  }

  /**
   * tabs.onUpdated reports "loading" for in-page navigation too: History API
   * and hash changes, and every iframe load (ServiceNow's classic content
   * frame). None of those replace the document that relays requests, so an
   * in-flight request is not failed on that signal alone — the tab is asked
   * which document it is running, and only a different one invalidates it.
   */
  noteNavigation(tabId: number, complete = false) {
    if (!this.inUse(tabId)) return;
    clearTimeout(this.verifyTimers.get(tabId));
    this.verifyTimers.set(tabId, setTimeout(() => {
      this.verifyTimers.delete(tabId);
      void this.verifyDocument(tabId);
    }, complete ? 300 : 1200));
  }
  /** The content script reports its own unload (pagehide). */
  documentGone(tabId: number, documentToken: string) {
    if (this.dropDocument(tabId, documentToken)) this.log("document_unloaded", { id: tabId } as chrome.tabs.Tab);
  }
  /**
   * One document is gone. Only what was addressed to that document fails —
   * a verdict about an old page must never fail a request already sent to
   * its replacement in the same tab. Returns whether anything used it.
   */
  private dropDocument(tabId: number, documentToken: string): boolean {
    const match = (b: Binding) => b.tabId === tabId && b.documentToken === documentToken;
    let used = false;
    if (this.binding && match(this.binding)) {
      used = true;
      this.binding = null;
      this.state("reconnecting", "document_changed");
    }
    for (const [id, entry] of this.pending) {
      if (!match(entry.binding)) continue;
      used = true;
      this.finish(id, failure("transport", "The ServiceNow page changed before the response arrived."));
    }
    if (used) this.log("document_changed", { id: tabId } as chrome.tabs.Tab);
    return used;
  }
  private inUse(tabId: number): boolean {
    return this.binding?.tabId === tabId || [...this.pending.values()].some((e) => e.binding.tabId === tabId);
  }
  private async verifyDocument(tabId: number): Promise<void> {
    const expected = this.binding?.tabId === tabId ? this.binding : [...this.pending.values()].find((e) => e.binding.tabId === tabId)?.binding;
    if (!expected) return;
    const verdict = await this.ping(expected);
    if (verdict === "gone") this.dropDocument(tabId, expected.documentToken);
    else if (verdict === "same") this.log("document_kept", { id: tabId } as chrome.tabs.Tab);
  }
  /** Cheap liveness check against one document; never sent to a frozen tab. */
  private async ping(binding: Binding): Promise<"same" | "gone" | "unknown"> {
    let tab: chrome.tabs.Tab;
    try { tab = await chrome.tabs.get(binding.tabId); } catch { return "gone"; }
    if (tab.discarded || serviceNowHost(tab.url) !== binding.host) return "gone";
    if ((tab as chrome.tabs.Tab & { frozen?: boolean }).frozen) return "unknown";
    try {
      const reply = await bounded<{ documentToken?: string } | undefined>(
        chrome.tabs.sendMessage(binding.tabId, { action: "bridgePing" }, { frameId: 0 }), PING_MS);
      if (reply?.documentToken !== binding.documentToken) return "gone";
      binding.verifiedAt = Date.now();
      return "same";
    } catch (error: any) {
      return RECEIVER_MISSING.test(error?.message || "") ? "gone" : "unknown";
    }
  }

  private finish(requestId: string, response: SnResponse) {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    clearTimeout(entry.timer);
    clearTimeout(entry.live);
    this.pending.delete(requestId);
    entry.resolve(response);
  }
  handleResponse(resp: { requestId?: string } & Record<string, any>, sender?: chrome.runtime.MessageSender) {
    if (!resp?.requestId) return;
    const entry = this.pending.get(resp.requestId);
    if (!entry || sender?.tab?.id !== entry.binding.tabId || sender.frameId !== 0 ||
        resp.documentToken !== entry.binding.documentToken ||
        (this.generations.get(entry.binding.tabId) || 0) !== entry.binding.generation ||
        serviceNowHost(sender.url) !== entry.binding.host) return;
    entry.binding.verifiedAt = Date.now();
    this.finish(resp.requestId, { ...resp, data: resp.data ?? null, error: resp.error ?? null });
  }

  private async candidates(host: string | null, locked?: Binding): Promise<chrome.tabs.Tab[]> {
    const tabs = await chrome.tabs.query({ url: host ? `https://${host}/*` : "https://*.service-now.com/*" });
    let focusedId: number | undefined;
    try { focusedId = (await chrome.windows.getLastFocused()).id; } catch { /* no focused window */ }
    return tabs.filter((t) => t.id !== undefined && eligibleServiceNowUrl(t.url) &&
      (!host || serviceNowHost(t.url) === host) && (!locked || t.id === locked.tabId) &&
      !t.discarded && !(t as chrome.tabs.Tab & { frozen?: boolean }).frozen)
      .sort((a, b) => Number(b.id === this.binding?.tabId) - Number(a.id === this.binding?.tabId) ||
        Number(b.windowId === focusedId) - Number(a.windowId === focusedId) ||
        ((b as any).lastAccessed || 0) - ((a as any).lastAccessed || 0));
  }

  private async probe(tab: chrome.tabs.Tab, deadline: number): Promise<Binding | null> {
    const tabId = tab.id!;
    const generation = this.generations.get(tabId) || 0;
    const host = serviceNowHost(tab.url)!;
    this.log("probe", tab);
    this.probeReasons.set(tabId, "transport");
    const ping = () => bounded<BridgeHealth>(chrome.tabs.sendMessage(tabId, { action: "bridgeHealth", version: BRIDGE_VERSION }, { frameId: 0 }), Math.min(PROBE_MS, deadline - Date.now()));
    let health: BridgeHealth;
    try { health = await ping(); }
    catch (error: any) {
      // Only a missing receiver authorizes reinjection; timeouts/frozen pages do not.
      if (!RECEIVER_MISSING.test(error?.message || "") ||
          this.injected.get(tabId) === generation || Date.now() >= deadline || tab.status === "loading") return null;
      this.injected.set(tabId, generation);
      try {
        const current = await chrome.tabs.get(tabId);
        if (serviceNowHost(current.url) !== host || !eligibleServiceNowUrl(current.url) || current.discarded) return null;
        await bounded(chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ["src/content/content_script.js"] }), deadline - Date.now());
        this.log("reinjected", tab);
        health = await ping();
      } catch { return null; }
    }
    if (generation !== (this.generations.get(tabId) || 0)) return null;
    if (!health || health.version !== BRIDGE_VERSION || health.reason === "incompatible") {
      this.probeReasons.set(tabId, "incompatible"); this.log("incompatible", tab); return null;
    }
    if (health.reason === "authentication") { this.authHost = host; this.probeReasons.set(tabId, "authentication"); this.log("sign_in_required", tab); return null; }
    if (!health.ready || health.hostname !== host || !health.documentToken) return null;
    this.probeReasons.delete(tabId);
    this.log("ready", tab);
    return { tabId, host, documentToken: health.documentToken, generation, verifiedAt: Date.now() };
  }

  private async createRecoveryTab(host: string): Promise<void> {
    // Persist identity/cooldown across service-worker restarts. Concurrent callers
    // share recover(), so a single failure cannot create a fan-out of tabs.
    const key = `snRecoveryTab:${host}`;
    let entry = this.recoveryTabs.get(host);
    if (!entry) {
      const stored = (await chrome.storage.session.get(key))[key];
      if (stored && typeof stored.id === "number" && typeof stored.createdAt === "number") entry = stored;
    }
    if (entry) {
      this.recoveryTabs.set(host, entry);
      try { await chrome.tabs.get(entry.id); return; } catch { /* closed */ }
      if (Date.now() - entry.createdAt < 60000) return;
    }
    const tab = await chrome.tabs.create({ url: `https://${host}/`, active: false });
    if (tab.id !== undefined) {
      entry = { id: tab.id, createdAt: Date.now() };
      this.recoveryTabs.set(host, entry);
      await chrome.storage.session.set({ [key]: entry });
      this.log("recovery_tab_opened", tab);
    }
  }

  private async recover(host: string | null, epoch: number, deadline: number, wait: boolean, allowCreate: boolean, locked?: Binding, avoid?: Set<string>): Promise<Binding | null> {
    // A stopped run stops looking: no more probing, and no recovery tab.
    const signal = this.turnActive ? this.turnSignal : null;
    // Re-verifying a binding we already hold is quiet; only a lost one says so.
    if (!this.binding) this.state("reconnecting");
    let opened = false;
    let first = true;
    let lastReason: ConnectionFailure = "no_tab";
    while (Date.now() < deadline && epoch === this.epoch && !signal?.aborted) {
      let tabs: chrome.tabs.Tab[];
      try { tabs = await bounded(this.candidates(host, locked), deadline - Date.now()); }
      catch { break; }
      const results = await Promise.allSettled(tabs.map((tab) => this.probe(tab, deadline)));
      if (epoch !== this.epoch || signal?.aborted) return null;
      const reasons = tabs.map(t => this.probeReasons.get(t.id!));
      lastReason = reasons.includes("authentication") ? "authentication" : reasons.includes("incompatible") ? "incompatible" : tabs.length ? "transport" : "no_tab";
      const match = results.flatMap((r) => r.status === "fulfilled" && r.value ? [r.value] : [])
        .find((b) => (!locked || (b.documentToken === locked.documentToken && b.generation === locked.generation)) && !avoid?.has(b.documentToken));
      if (match) {
        this.binding = match;
        if (this.turnActive && !this.turnHost) this.turnHost = match.host;
        this.state(this.authHost === match.host ? "sign_in_required" : "ready", this.authHost === match.host ? "authentication" : undefined);
        return match;
      }
      if (first && allowCreate && host && !locked && !opened && Date.now() < deadline && !signal?.aborted) {
        try { await bounded(this.createRecoveryTab(host), deadline - Date.now()); } catch { this.log("recovery_tab_failed"); }
        opened = true;
      }
      first = false;
      if (!wait || locked || Date.now() >= deadline) break;
      await abortableDelay(Math.min(300, Math.max(0, deadline - Date.now())), signal);
    }
    // Looking for an alternative to a document we are avoiding, or giving up
    // because the run was stopped, is not a verdict on the connection itself.
    if (epoch === this.epoch && !avoid?.size && !signal?.aborted) {
      this.binding = null;
      this.state(this.authHost === host ? "sign_in_required" : "unavailable", this.authHost === host ? "authentication" : lastReason);
    }
    return null;
  }

  private async ensureReady(deadline: number, wait: boolean, allowCreate: boolean, locked?: Binding, opts: { fresh?: boolean; avoid?: Set<string> } = {}): Promise<Binding | null> {
    const host = this.getPreferredHost();
    const current = this.binding;
    if (!opts.fresh && current && current.host === host && Date.now() - current.verifiedAt < FRESH_MS &&
        (!locked || sameDocument(current, locked)) && !opts.avoid?.has(current.documentToken)) return current;
    const epoch = this.epoch;
    const key = `${epoch}:${host || ""}`;
    const signal = this.turnActive ? this.turnSignal : null;
    if (signal?.aborted) return null;
    if (this.recovery && !opts.avoid?.size) {
      const previous = this.recovery;
      try {
        const shared = await bounded(unlessAborted(previous.promise, signal), deadline - Date.now());
        if (previous.key === key && shared && (!locked || sameDocument(shared, locked))) return shared;
      } catch { return null; }
      if (Date.now() >= deadline || epoch !== this.epoch || signal?.aborted) return null;
    }
    const task = { key, promise: this.recover(host, epoch, Math.min(deadline, Date.now() + RECOVERY_MS), wait, allowCreate, locked, opts.avoid) };
    this.recovery = task;
    try { return await bounded(unlessAborted(task.promise, signal), deadline - Date.now()); }
    catch { return null; }
    finally { if (this.recovery === task) this.recovery = null; }
  }

  async bindTab(allowCreate = false): Promise<number | null> {
    return (await this.ensureReady(Date.now() + RECOVERY_MS, allowCreate, allowCreate))?.tabId ?? null;
  }
  /**
   * Panel-driven health check. A running turn maintains its own binding, so a
   * check never runs underneath it — a slow probe must not drop the binding a
   * turn (or a form operation) is using.
   */
  async checkHealth(): Promise<void> {
    if (this.turnActive) return;
    const host = this.getPreferredHost();
    const tabId = await this.bindTab(false);
    // A probe proves the helper answers, not that the session works. While a
    // sign-in is pending, one tiny read tells us when it has been resolved.
    if (tabId !== null && host && this.authHost === host && !this.turnActive) {
      await this.rest("/api/now/table/sys_user?sysparm_limit=1&sysparm_fields=sys_id&sysparm_query=sys_idDYNAMIC90d1921e5f510100a9ad2572f2b477fe", "GET", undefined, 8000);
    }
  }
  /** Background lookups share recovery but may never drift onto another host. */
  forHost(host: string): SnBridge {
    return new Proxy(this, { get: (target, key) => {
      const value = Reflect.get(target, key);
      if (typeof value !== "function") return value;
      return (...args: any[]) => target.getPreferredHost() === host
        ? value.apply(target, args)
        : Promise.resolve(failure("transport", "The selected instance changed; background lookup cancelled."));
    } });
  }
  async findTabForHost(host: string): Promise<number | null> { return (await this.candidates(host))[0]?.id ?? null; }

  private dispatch(binding: Binding, action: string, request: Record<string, any>, deadline: number, read: boolean, signal: AbortSignal | null): Promise<SnResponse> {
    if (signal?.aborted) return Promise.resolve(cancelled());
    // The document was replaced between choosing it and sending.
    if ((this.generations.get(binding.tabId) || 0) !== binding.generation) {
      return Promise.resolve(failure("not_sent", "The ServiceNow page changed before the request was sent; nothing was sent."));
    }
    const requestId = crypto.randomUUID();
    let misses = 0;
    const onAbort = () => this.finish(requestId, cancelled());
    const result = new Promise<SnResponse>((resolve) => {
      const timer = setTimeout(() => this.finish(requestId, failure("timeout", "ServiceNow request timed out.")), Math.max(1, deadline - Date.now()));
      this.pending.set(requestId, { binding, timer, resolve: (r) => { signal?.removeEventListener("abort", onAbort); resolve(r); } });
    });
    // Stopping abandons a read at once. A write already handed to the page is
    // waited out, so its real outcome is reported rather than guessed.
    if (read) signal?.addEventListener("abort", onAbort, { once: true });
    const watch = () => {
      const entry = this.pending.get(requestId);
      if (!entry) return;
      entry.live = setTimeout(async () => {
        if (!this.pending.has(requestId)) return;
        const verdict = await this.ping(binding);
        if (!this.pending.has(requestId)) return;
        if (verdict === "gone") return void this.dropDocument(binding.tabId, binding.documentToken);
        if (verdict === "same") misses = 0;
        else if (++misses >= 2 && read) {
          this.log("liveness_failed", { id: binding.tabId } as chrome.tabs.Tab);
          return this.finish(requestId, failure("transport", "The ServiceNow tab stopped responding."));
        }
        watch();
      }, LIVENESS_MS);
    };
    // Do not await the acknowledgment before awaiting the response: both are
    // bounded by the same deadline, including when Chrome never settles sendMessage.
    void Promise.resolve().then(() => chrome.tabs.sendMessage(binding.tabId, {
      action, request: { ...request, requestId, expectedDocumentToken: binding.documentToken, expectedHost: binding.host },
    }, { frameId: 0 })).then((ack) => {
      if (ack?.sent) watch();
      else this.finish(requestId, failure("not_sent", "The ServiceNow page was not ready for the request; nothing was sent."));
    }).catch((error: any) => this.finish(requestId, RECEIVER_MISSING.test(error?.message || "")
      ? failure("not_sent", "The ServiceNow page was not ready for the request; nothing was sent.")
      : failure("transport", "The ServiceNow tab stopped responding.")));
    return result;
  }

  private classify(response: SnResponse, host: string): SnResponse {
    const current = host === this.getPreferredHost();
    const status = response.status ?? response.data?._status;
    if (status === 401 || response.data?._parseError) {
      return { ...response, error: "ServiceNow requires sign-in. Open the instance and sign in, then retry.", failure: "authentication" };
    }
    if (status === 403) {
      if (current) this.state("ready", "access_denied");
      return { ...response, error: "ServiceNow denied access to this operation (403).", failure: "access_denied" };
    }
    if (status >= 400) return { ...response, error: `ServiceNow returned HTTP ${status}.`, failure: "http" };
    if (response.error) return { ...response, failure: response.failure || "network" };
    if (current) { this.authHost = null; this.state("ready"); }
    return response;
  }
  private noteSignIn(host: string) {
    if (host !== this.getPreferredHost()) return;
    this.authHost = host;
    this.state("sign_in_required", "authentication");
  }
  private dropBinding(binding: Binding) {
    if (this.binding?.documentToken === binding.documentToken) { this.binding = null; this.state("reconnecting", "transport"); }
  }

  private async send(action: string, request: Record<string, any>, timeoutMs: number): Promise<SnResponse> {
    const deadline = Date.now() + timeoutMs;
    const epoch = this.epoch;
    const signal = this.turnSignal;
    const read = action === "apiCall" && /^(GET|HEAD)$/i.test(request.method || "GET");
    const form = action === "formFillGeneric" || action === "formFillCatalogVariable";
    const original = form ? this.binding : undefined;
    // The agent may propose the same tool again after an ambiguous result.
    // Block that repeat for this turn as well as transport-level retries.
    const writeKey = read ? "" : JSON.stringify([this.getPreferredHost(), action, request]);
    if (!read && this.uncertainWrites.has(writeKey)) return { ...failure("transport", "This change has an uncertain result from an earlier attempt. Verify it and start a new turn before repeating it."), outcome: "unknown" };
    if (form && !original) return failure("document_changed", "The original form tab is unavailable. Reopen the target record before retrying.");
    // A read may try again (bounded). A write is resent only when the page
    // provably never received it; a form operation never moves.
    const avoid = new Set<string>();
    let last: { response: SnResponse; host: string } | null = null;
    for (let attempt = 0; attempt < (read ? READ_ATTEMPTS : 2); attempt++) {
      if (signal?.aborted) return cancelled();
      if (attempt > 0) {
        const pause = RETRY_BACKOFF_MS[attempt] ?? 1000;
        if (Date.now() + pause >= deadline) break;
        await abortableDelay(pause, signal);
        if (signal?.aborted) return cancelled();
        this.log(avoid.size ? "retry_other_document" : "retry");
      }
      // A run started or ended underneath this request (checked after any
      // wait, right before choosing a tab): its binding and host are no
      // longer this request's to use.
      if (epoch !== this.epoch) break;
      const binding = await this.ensureReady(deadline, !avoid.size, !form && !avoid.size, original || undefined, { fresh: attempt > 0, avoid });
      if (signal?.aborted) return cancelled();
      if (!binding || epoch !== this.epoch || Date.now() >= deadline) {
        if (last) break;
        if (this.connection.phase === "sign_in_required") return failure("authentication", "ServiceNow requires sign-in. Open the instance and sign in, then retry.");
        if (this.connection.reason === "incompatible") return failure("incompatible", "The ServiceNow page has an older helper. Refresh the page to load the updated extension, then retry.");
        return failure("no_tab", "No ready ServiceNow tab is available. A recovery tab may need to finish loading or be refreshed.");
      }
      const response = this.classify(await this.dispatch(binding, action, request, deadline, read, signal), binding.host);
      if (!response.error) return response;
      last = { response, host: binding.host };
      this.log(`request_${response.failure || "failed"}`, { id: binding.tabId } as chrome.tabs.Tab);
      if (response.failure === "cancelled") return response;
      if (!read) {
        if (response.failure === "not_sent") {
          if (form) return failure("document_changed", "The form page changed before the request was sent; nothing was changed. Reopen the target record before retrying.");
          this.dropBinding(binding);
          continue;
        }
        if (["transport", "timeout", "network"].includes(response.failure || "")) {
          this.uncertainWrites.add(writeKey);
          return { ...response, outcome: "unknown", error: `${response.error} The change may already have succeeded. Verify the record before retrying; do not repeat this operation blindly.` };
        }
        if (response.failure === "authentication") this.noteSignIn(binding.host);
        return response;
      }
      if (response.failure === "authentication") {
        // A page whose session token went stale answers 401 while another tab
        // on the same instance is fine. Try one other document, never another host.
        if (avoid.size) break;
        avoid.add(binding.documentToken);
        continue;
      }
      if (!RETRYABLE_READ.has(response.failure)) return response;
      this.dropBinding(binding);
    }
    if (last?.response.failure === "authentication" && epoch === this.epoch) this.noteSignIn(last.host);
    if (!last && epoch !== this.epoch) return failure("transport", "The ServiceNow request was cancelled because the active run or instance changed.");
    return last?.response ?? failure("transport", "ServiceNow connection recovery failed.");
  }
  /** Raw REST call relayed through the page (authenticated by the user's session). */
  async rest(url: string, method: string, body?: any, timeoutMs = 30000): Promise<SnResponse> {
    return this.send("apiCall", { url, method, body }, timeoutMs);
  }

  async query(opts: {
    table: string;
    query?: string;
    fields?: string;
    limit?: number;
    offset?: number;
    order_by?: string;
    display_value?: boolean;
  }): Promise<SnResponse> {
    const invalid = badTable(opts.table);
    if (invalid) return invalid;
    const limit = clampInt(opts.limit, 20, 1, 200);
    const offset = clampInt(opts.offset, 0, 0, 1_000_000);
    let query = opts.query || "";
    if (opts.order_by) {
      const dir = opts.order_by.startsWith("-") ? "ORDERBYDESC" : "ORDERBY";
      const field = opts.order_by.replace(/^-/, "");
      if (!ORDER_FIELD.test(field)) return refused("order_by field", opts.order_by);
      query = query ? `${query}^${dir}${field}` : `${dir}${field}`;
    }
    let url =
      `/api/now/table/${opts.table}?sysparm_limit=${limit}` +
      `&sysparm_display_value=${opts.display_value !== false}` +
      `&sysparm_exclude_reference_link=true`;
    if (offset) url += `&sysparm_offset=${offset}`;
    if (query) url += `&sysparm_query=${encodeURIComponent(query)}`;
    if (opts.fields) url += `&sysparm_fields=${encodeURIComponent(opts.fields)}`;
    return this.rest(url, "GET", undefined, 20000);
  }

  async getRecord(table: string, sysId: string, fields?: string): Promise<SnResponse> {
    const invalid = badRecord(table, sysId);
    if (invalid) return invalid;
    let url = `/api/now/table/${table}/${sysId}?sysparm_display_value=true&sysparm_exclude_reference_link=true`;
    if (fields) url += `&sysparm_fields=${encodeURIComponent(fields)}`;
    return this.rest(url, "GET", undefined, 20000);
  }

  async count(table: string, query?: string): Promise<SnResponse> {
    const invalid = badTable(table);
    if (invalid) return invalid;
    let url = `/api/now/stats/${table}?sysparm_count=true`;
    if (query) url += `&sysparm_query=${encodeURIComponent(query)}`;
    return this.rest(url, "GET", undefined, 20000);
  }

  async createRaw(table: string, data: Record<string, any>): Promise<SnResponse> {
    return badTable(table) ?? this.rest(`/api/now/table/${table}`, "POST", data);
  }

  async update(table: string, sysId: string, data: Record<string, any>): Promise<SnResponse> {
    return badRecord(table, sysId) ?? this.rest(`/api/now/table/${table}/${sysId}`, "PATCH", data);
  }

  async remove(table: string, sysId: string): Promise<SnResponse> {
    return badRecord(table, sysId) ?? this.rest(`/api/now/table/${table}/${sysId}`, "DELETE");
  }

  /** Create a record server-side via the SNAICopilotHelper Script Include. */
  async glideAjaxCreate(table: string, fields: Record<string, any>): Promise<any> {
    return this.send("glideAjaxCreate", { table, fields }, 30000);
  }

  /** Set catalog_variable on a catalog_ui_policy_action via hidden-iframe form fill. */
  async formFillCatalogVariable(sysId: string, variableName: string): Promise<any> {
    return badRecord("catalog_ui_policy_action", sysId) ?? this.send("formFillCatalogVariable", { sysId, variableName }, 30000);
  }

  /** Generic hidden-iframe form fill: set one field on any record and save.
   * The table and sys_id become the form's URL, so they are checked like any other. */
  async formFillGeneric(tableName: string, sysId: string, fieldName: string, value: string): Promise<any> {
    return badRecord(tableName, sysId) ?? (TABLE_NAME.test(String(fieldName)) ? null : refused("field name", fieldName)) ??
      this.send("formFillGeneric", { tableName, sysId, fieldName, value }, 30000);
  }

  async requestContextRefresh(tabId = this.binding?.tabId): Promise<void> {
    if (tabId === undefined) return;
    try { await bounded(chrome.tabs.sendMessage(tabId, { action: "refreshContext" }, { frameId: 0 }), PROBE_MS); }
    catch { /* health checks report availability separately */ }
  }
}
