// Background service worker entry point. Routes:
//  - content-script messages (context updates, API responses) → SnBridge / context registry
//  - side-panel port (commands in, agent events out) → AgentSession
//
// Panels are viewers. Opening, closing or reconnecting one never starts,
// restarts or cancels a run — the session owns it.

import type { AgentEvent, PanelCommand, ProviderId, SettingsPatch, SnContext } from "../shared/types";
import { PANEL_PORT_NAME, PROVIDER_IDS, sanitizeCost } from "../shared/types";
import { eligibleServiceNowUrl, parseInstanceHost, serviceNowHost } from "../shared/connection";
import { AgentSession } from "./agent";
import { decideFollow, pickContext } from "./instanceFollow";
import { getModelCatalog, pickDefaultModel } from "./modelCatalog";
import { recordRunEvent } from "./runDiagnostics";
import { getSettings, patchSettings, removeRetiredSettings, setDefaultModel, toPublicSettings } from "./settings";
import { getCalibration, runCalibration } from "./snCatalog";
import { SnBridge } from "./snBridge";
import { pageContext } from "./pageContext";

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
// Keys and settings are for the extension's own pages and this worker, never
// for the content scripts that run inside ServiceNow pages.
try { void chrome.storage.local.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" as chrome.storage.AccessLevel })?.catch(() => {}); } catch { /* unsupported */ }
void removeRetiredSettings();

const sn = new SnBridge();

// Per-tab ServiceNow page context. Never cleared on panel open — the latest
// known context is always available; refresh just asks the tab to re-send.
const tabContexts = new Map<number, SnContext>();

/** The tab the user is looking at: the active tab of the last focused window. */
let viewedTabId: number | null = null;

/** Mirror of settings.pinnedInstanceId — currentContext() is synchronous. */
let chatPinnedId: string | null = null;

/** The last ServiceNow host the user looked at: where Auto works, whether or
 * not the instance was added in Settings (one never added accepts changes). It
 * is noted even while pinned, and kept in session storage so a worker that
 * Chrome restarts resumes where the user was. */
let viewedHost: string | null = null;
/** The ServiceNow host of the tab on screen right now — null on any other page. */
let screenHost: string | null = null;
const VIEWED_HOST_KEY = "snViewedHost";
const viewedHostRestored = chrome.storage.session.get(VIEWED_HOST_KEY)
  .then((r) => { if (viewedHost === null && typeof r[VIEWED_HOST_KEY] === "string") viewedHost = r[VIEWED_HOST_KEY]; })
  .catch(() => {});

function noteViewed(host: string | null) {
  if (host !== screenHost) {
    screenHost = host;
    broadcast({ type: "viewed", host });
  }
  if (host && host !== viewedHost) {
    viewedHost = host;
    void chrome.storage.session.set({ [VIEWED_HOST_KEY]: host }).catch(() => {});
  }
}

function currentContext(): SnContext | null {
  const host = sn.getPreferredHost();
  // The page on screen wins when it belongs to the selected instance: "this
  // record" means the record the user can see.
  const viewed = viewedTabId !== null ? tabContexts.get(viewedTabId) ?? null : null;
  if (viewed && host && viewed.hostname?.toLowerCase() === host) return viewed;
  const boundId = sn.getBoundTabId();
  const bound = boundId !== null ? (tabContexts.get(boundId) ?? null) : null;
  return pickContext(tabContexts.values(), bound, host, chatPinnedId !== null || host !== null);
}

const session = new AgentSession(sn, currentContext, (tabId) => tabContexts.get(tabId) ?? null);
// Settle anything a previous worker left running as soon as this one starts,
// whatever woke it — not only when a panel happens to connect.
void session.ready();

/** Point the bridge at the selected instance so tab binding prefers it —
 * strictly so while pinned, so a turn can never bind across instances. In
 * Auto that is the instance on screen, else the last one selected. */
async function syncPreferredHost(): Promise<void> {
  await viewedHostRestored;
  const s = await getSettings();
  chatPinnedId = s.pinnedInstanceId;
  const pinned = s.instances.find((i) => i.id === s.pinnedInstanceId) ?? null;
  const active = s.instances.find((i) => i.id === s.activeInstanceId) ?? null;
  sn.setPreferredHost(pinned?.host ?? viewedHost ?? active?.host ?? null, pinned !== null);
}
void syncPreferredHost();

/** Auto follows only the ServiceNow tab the user is viewing. */
async function follow(hostname: string | null | undefined, senderTabActive: boolean): Promise<void> {
  const host = senderTabActive && hostname ? parseInstanceHost(hostname) : null;
  if (!host) return;
  noteViewed(host);
  const s = await getSettings();
  const next = decideFollow({ pinnedInstanceId: s.pinnedInstanceId, senderTabActive, hostname: host, instances: s.instances });
  // Pinned: the host is noted for a later Auto, but the pin decides where the agent works.
  if (!next) return;
  sn.setPreferredHost(next.host);
  if (next.instance && next.instance.id !== s.activeInstanceId) {
    await patchSettings({ activeInstanceId: next.instance.id });
    broadcast({ type: "settings", settings: await toPublicSettings(await getSettings()) });
  }
}

async function inFocusedWindow(windowId: number | undefined): Promise<boolean> {
  if (windowId === undefined) return true;
  try { return (await chrome.windows.getLastFocused()).id === windowId; } catch { return false; }
}

async function followActiveTab(host: string | null, senderTabActive: boolean, windowId?: number): Promise<void> {
  if (await inFocusedWindow(windowId)) await follow(host, senderTabActive);
}

async function trackViewedTab(windowId?: number): Promise<void> {
  try {
    // A tab activated in a window the user isn't in doesn't move anything.
    if (!(await inFocusedWindow(windowId))) return;
    const [tab] = windowId === undefined
      ? await chrome.tabs.query({ active: true, lastFocusedWindow: true })
      : await chrome.tabs.query({ active: true, windowId });
    const next = tab?.id ?? null;
    if (next === viewedTabId) return;
    viewedTabId = next;
    // Switching to a ServiceNow tab moves Auto there at once, without waiting
    // for the page to report its context.
    const host = eligibleServiceNowUrl(tab?.url) ? serviceNowHost(tab!.url) : null;
    if (host) await follow(host, true);
    else noteViewed(null);
    broadcast({ type: "context", ctx: currentContext() });
  } catch { /* no window */ }
}
void trackViewedTab();
chrome.tabs.onActivated.addListener(({ windowId }) => { void trackViewedTab(windowId); });
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) void trackViewedTab(windowId);
});

/** Unpinned — by the user, or because the pinned instance was removed: snap
 * back to the tab actually being viewed, so Auto means the page on screen. */
async function snapToViewedTab(): Promise<void> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (eligibleServiceNowUrl(tab?.url)) await follow(serviceNowHost(tab!.url), true);
  } catch { /* no window */ }
}

// ─── Auto-calibration ────────────────────────────────────────────────────────
// Discovers the instance's variable types / categories / catalogs silently in
// the background — no manual button. Re-runs when the instance changes or the
// data is older than a day. Only instances the user added are calibrated: the
// results are shown to the model in later prompts, so a page the user merely
// visited must not be able to supply them.

const CALIBRATION_TTL_MS = 24 * 60 * 60 * 1000;
const calibrationInFlight = new Set<string>();

async function ensureCalibration(host: string | null | undefined): Promise<void> {
  if (!host || session.running || calibrationInFlight.has(host)) return;
  if (!(await getSettings()).instances.some((i) => i.host === host)) return;

  const cal = await getCalibration(host);
  if (cal && Date.now() - (cal.calibratedAt || 0) < CALIBRATION_TTL_MS) return;

  // Calibration queries relay through the bound tab — only run when it's on
  // this host, so results always describe the instance they claim to.
  const boundHost = await sn.getBoundTabHost();
  if (boundHost !== host) return;

  calibrationInFlight.add(host);
  try {
    await runCalibration(sn.forHost(host), host, () => {});
  } catch {
    /* silent — the agent degrades gracefully without calibration data */
  } finally {
    calibrationInFlight.delete(host);
  }
}

// ─── Side panel ports ────────────────────────────────────────────────────────

const panelPorts = new Set<chrome.runtime.Port>();

function broadcast(event: AgentEvent) {
  for (const port of panelPorts) {
    try {
      port.postMessage(event);
    } catch {
      panelPorts.delete(port);
      updateHealthTimer();
    }
  }
  // A finished run hands the connection back to the panel's health checks.
  if (event.type === "turn_state" && !event.running && panelPorts.size) void sn.checkHealth();
}

session.setEmitter(broadcast);
sn.setConnectionListener((connection) => broadcast({ type: "connection", connection }));
let healthTimer: ReturnType<typeof setInterval> | null = null;
function updateHealthTimer() {
  if (panelPorts.size && !healthTimer) healthTimer = setInterval(() => { void sn.checkHealth(); }, 15000);
  if (!panelPorts.size && healthTimer) { clearInterval(healthTimer); healthTimer = null; }
}

async function sendFullState(port: chrome.runtime.Port) {
  await session.ready();
  const settings = await toPublicSettings(await getSettings());
  const event: AgentEvent = {
    type: "state",
    feed: session.feed,
    running: session.running,
    ctx: currentContext(),
    catalog: session.catalog,
    settings,
    cost: session.cost,
    connection: sn.getConnection(),
    run: session.publicRun(),
    viewedHost: screenHost,
  };
  try {
    port.postMessage(event);
  } catch {
    /* port closed */
  }
}

/** Only the extension's own pages drive the agent — never a content script
 * running inside a web page, which connects from that page's tab. */
function fromExtensionPage(port: chrome.runtime.Port): boolean {
  const sender = port.sender;
  return !sender?.tab || !!sender.url?.startsWith(`chrome-extension://${chrome.runtime.id}/`);
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PANEL_PORT_NAME) return;
  if (!fromExtensionPage(port)) {
    port.disconnect();
    return;
  }
  panelPorts.add(port);
  updateHealthTimer();
  void recordRunEvent("panel_attach", { running: session.running });
  void sendFullState(port);
  // Proactively ask the best SN tab for fresh context when the panel opens.
  // A running turn keeps its binding: the health check stands aside while it works.
  void syncPreferredHost()
    .then(() => sn.checkHealth())
    .then(() => sn.requestContextRefresh())
    .then(() => ensureCalibration(currentContext()?.hostname));

  port.onDisconnect.addListener(() => {
    panelPorts.delete(port);
    updateHealthTimer();
    // Only a view went away; a run in progress continues.
    void recordRunEvent("panel_detach", { running: session.running });
  });
  port.onMessage.addListener((raw: PanelCommand) => {
    void handleCommand(raw, port);
  });
});

/**
 * Load a provider's live catalog for the picker. It doubles as the key check
 * (a rejected key comes back as the error), and the first catalog loaded for a
 * provider with no model chosen yet names its default.
 */
async function refreshModels(provider: ProviderId, force = false): Promise<void> {
  const key = (await getSettings()).apiKeys[provider];
  if (!key) {
    broadcast({ type: "model_list", provider, models: [], error: "no_key" });
    return;
  }
  // A list (or an error) that arrives after the key changed belongs to the old key.
  const stale = async () => (await getSettings()).apiKeys[provider] !== key;
  broadcast({ type: "model_list", provider, models: [], loading: true });
  try {
    const models = await getModelCatalog(provider, key, force);
    if (await stale()) return;
    broadcast({ type: "model_list", provider, models });
    const pick = pickDefaultModel(provider, models);
    if (pick && !(await getSettings()).models[provider]) {
      await setDefaultModel(provider, pick);
      broadcast({ type: "settings", settings: await toPublicSettings(await getSettings()) });
    }
  } catch (e: any) {
    if (await stale()) return;
    broadcast({ type: "model_list", provider, models: [], error: e?.message || String(e) });
  }
}

async function handleCommand(cmd: PanelCommand, port: chrome.runtime.Port) {
  switch (cmd.type) {
    case "get_state":
      await sendFullState(port);
      break;

    case "chat":
      void session.sendChat(cmd.text, cmd.files || [], cmd.contextTabId);
      break;

    case "resume_run":
      void session.resumeRun(cmd.runId);
      break;

    case "approval":
      session.resolveApproval(cmd.id, cmd.approved);
      break;

    case "stop":
      session.stop();
      break;

    case "clear":
      void session.clear();
      break;

    case "clear_catalog":
      session.clearCatalog();
      break;

    case "refresh_context":
      await sn.checkHealth();
      await sn.requestContextRefresh();
      setTimeout(() => broadcast({ type: "context", ctx: currentContext() }), 800);
      break;

    case "set_settings": {
      // Pinning an instance also selects it — the pin IS the active instance.
      const patch: SettingsPatch =
        typeof cmd.patch.pinnedInstanceId === "string"
          ? { ...cmd.patch, activeInstanceId: cmd.patch.pinnedInstanceId }
          : cmd.patch;
      const pinnedBefore = (await getSettings()).pinnedInstanceId;
      await patchSettings(patch);
      // Unpinned → Auto, whether the user chose Auto or removed the pinned
      // instance: snap back to the tab actually being viewed, so the badge
      // immediately reflects reality instead of the last pin.
      if (pinnedBefore !== null && (await getSettings()).pinnedInstanceId === null) await snapToViewedTab();
      if (
        patch.instances !== undefined ||
        patch.instanceOps?.length ||
        patch.activeInstanceId !== undefined ||
        patch.pinnedInstanceId !== undefined
      ) {
        await syncPreferredHost();
      }
      const settings = await toPublicSettings(await getSettings());
      broadcast({ type: "settings", settings });
      // A saved key is checked straight away by loading its catalog; a
      // deleted one clears the list the picker shows.
      for (const provider of PROVIDER_IDS) {
        if (typeof patch.apiKeys?.[provider] === "string") void refreshModels(provider, true);
      }
      break;
    }

    case "switch_instance": {
      // Selects which instance the agent binds to — and pins it: an explicit
      // pick anywhere means "stop following tabs", one rule everywhere. It
      // deliberately does not rewrite the URL of every open ServiceNow tab —
      // that discarded whatever was half-filled in on each of them.
      await patchSettings({ activeInstanceId: cmd.id, pinnedInstanceId: cmd.id });
      await syncPreferredHost();
      broadcast({ type: "settings", settings: await toPublicSettings(await getSettings()) });
      break;
    }

    case "list_models":
      if ((PROVIDER_IDS as string[]).includes(cmd.provider)) void refreshModels(cmd.provider, cmd.force);
      break;

    case "open_host_tab": {
      const host = parseInstanceHost(cmd.host);
      if (host) {
        // Focus an existing tab if one is open AND reload it — an expired
        // session needs the reload to actually land on the login page.
        // Content-script context updates refresh the panel after login.
        void (async () => {
          const tabId = await sn.findTabForHost(host);
          if (tabId !== null) {
            const tab = await chrome.tabs.update(tabId, { active: true });
            if (tab?.windowId !== undefined) void chrome.windows.update(tab.windowId, { focused: true });
            void chrome.tabs.reload(tabId);
          } else {
            await chrome.tabs.create({ url: `https://${host}/`, active: true });
          }
        })();
      }
      break;
    }

    case "list_sessions":
      void (async () => {
        try {
          port.postMessage({ type: "session_list", sessions: await loadSessionMetas() });
        } catch {
          /* port closed */
        }
      })();
      break;

    case "get_session":
      void (async () => {
        const r = await chrome.storage.local.get("copilotSessions");
        const sessions: any[] = Array.isArray(r.copilotSessions) ? r.copilotSessions : [];
        const s = sessions.find((x) => x?.id === cmd.id);
        if (!s) return;
        try {
          port.postMessage({ type: "session_detail", id: s.id, feed: Array.isArray(s.feed) ? s.feed : [] });
        } catch {
          /* port closed */
        }
      })();
      break;

    case "delete_session":
      void (async () => {
        const r = await chrome.storage.local.get("copilotSessions");
        const sessions: any[] = Array.isArray(r.copilotSessions) ? r.copilotSessions : [];
        await chrome.storage.local.set({ copilotSessions: sessions.filter((x) => x?.id !== cmd.id) });
        try {
          port.postMessage({ type: "session_list", sessions: await loadSessionMetas() });
        } catch {
          /* port closed */
        }
      })();
      break;
  }
}

async function loadSessionMetas(): Promise<import("../shared/types").SessionMeta[]> {
  const r = await chrome.storage.local.get("copilotSessions");
  const sessions: any[] = Array.isArray(r.copilotSessions) ? r.copilotSessions : [];
  return sessions.map((s) => ({
    id: String(s?.id || ""),
    at: Number(s?.at || 0),
    title: String(s?.title || "Untitled session"),
    items: Array.isArray(s?.feed) ? s.feed.length : 0,
    usd: typeof s?.usd === "number" ? s.usd : undefined,
    cost: sanitizeCost(s?.cost),
  }));
}

// ─── Content script messages ─────────────────────────────────────────────────

function isServiceNowInstance(origin: string): Promise<boolean> {
  return new Promise((resolve) => {
    chrome.cookies.get({ name: "glide_user_route", url: origin }, (cookie) => resolve(!!cookie));
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id;

  switch (message?.action) {
    case "checkInstance":
      void isServiceNowInstance(message.origin).then((isInstance) => sendResponse({ isInstance }));
      return true;

    case "contextUpdate": {
      // Which host a page is on comes from Chrome, not from the page: a page
      // can report anything about itself except where it was served from.
      const url = sender.url ?? sender.tab?.url;
      const host = serviceNowHost(url);
      if (tabId !== undefined && message.context && typeof message.context === "object" && host) {
        // Only the fields the extension reads, checked and bounded: whatever
        // runs on the page can write this. (Older page helpers still in open
        // tabs also sent the session token; it is never among them.)
        const ctx: SnContext = { ...pageContext(message.context), hostname: host, instance: host.replace(/\.service-now\.com$/, ""), url, tabId, updatedAt: Date.now() };
        const prev = tabContexts.get(tabId);
        if (prev?.uiType && !ctx.uiType) ctx.uiType = prev.uiType;
        tabContexts.set(tabId, ctx);
        void ensureCalibration(host);
        // Follow first, so the context shown is already the followed instance's.
        void followActiveTab(host, sender.tab?.active === true, sender.tab?.windowId)
          .finally(() => broadcast({ type: "context", ctx: currentContext() }));
      }
      break;
    }

    case "bridgeUnload":
      if (tabId !== undefined && typeof message.documentToken === "string") sn.documentGone(tabId, message.documentToken);
      break;

    case "apiResponse":
      sn.handleResponse(message.response, sender);
      break;

    case "glideAjaxResponse":
      sn.handleResponse(message.response, sender);
      break;
  }

  return undefined;
});

chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
  if (change.discarded === true) {
    tabContexts.delete(tabId);
    sn.invalidateTab(tabId);
    broadcast({ type: "context", ctx: currentContext() });
    return;
  }
  // "loading" also fires for in-page navigation — History API, hash changes
  // and every iframe load (ServiceNow's classic content frame). Treating that
  // as a new document used to fail requests the page was about to answer.
  // The bridge asks the tab which document it runs before invalidating.
  if (change.status === "loading" || change.url) sn.noteNavigation(tabId);
  if (change.status === "complete") {
    sn.noteNavigation(tabId, true);
    if (!eligibleServiceNowUrl(tab?.url)) {
      if (tabContexts.delete(tabId)) broadcast({ type: "context", ctx: currentContext() });
    } else {
      void sn.requestContextRefresh(tabId);
    }
    if (panelPorts.size) void sn.checkHealth();
  }
});
chrome.tabs.onRemoved.addListener((tabId) => {
  tabContexts.delete(tabId);
  sn.invalidateTab(tabId, true);
  if (viewedTabId === tabId) viewedTabId = null;
  broadcast({ type: "context", ctx: currentContext() });
});

export {};
