import { INITIAL_CONNECTION } from "../../shared/connection";
import type { ConnectionState } from "../../shared/connection";
// Side-panel ⇄ background connection. The background owns all state, including
// any run in progress; this hook mirrors it over a long-lived port and exposes
// typed commands. The panel is only a viewer: closing or reconnecting it never
// starts, restarts or cancels a run.

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AgentEvent,
  CatalogContext,
  FeedItem,
  ModelListEntry,
  PanelCommand,
  PlanFile,
  ProviderId,
  PublicRun,
  PublicSettings,
  SessionCost,
  SessionMeta,
  SettingsPatch,
  SnContext,
} from "../../shared/types";
import { EMPTY_COST, NO_MODELS, PANEL_PORT_NAME } from "../../shared/types";

/** Shown only until the background's first state snapshot arrives. */
const DEFAULT_SETTINGS: PublicSettings = {
  provider: "anthropic",
  models: { ...NO_MODELS },
  efforts: {},
  keysPresent: { anthropic: false, openai: false, openrouter: false },
  instances: [],
  activeInstanceId: null,
  pinnedInstanceId: null,
};

export function useAgent() {
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [running, setRunning] = useState(false);
  const [run, setRun] = useState<PublicRun | null>(null);
  const [ctx, setCtx] = useState<SnContext | null>(null);
  const [catalog, setCatalog] = useState<CatalogContext | null>(null);
  const [settings, setSettings] = useState<PublicSettings>(DEFAULT_SETTINGS);
  const [cost, setCost] = useState<SessionCost>({ ...EMPTY_COST });
  const [connected, setConnected] = useState(false);
  const [connection, setConnection] = useState<ConnectionState>({ ...INITIAL_CONNECTION });
  /** The ServiceNow host of the tab on screen, or null when it isn't a ServiceNow page. */
  const [viewedHost, setViewedHost] = useState<string | null>(null);
  const [modelLists, setModelLists] = useState<
    Partial<Record<ProviderId, { models: ModelListEntry[]; loading: boolean; error?: string }>>
  >({});
  // View-only archived sessions — never part of the model context.
  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [sessionDetail, setSessionDetail] = useState<{ id: string; feed: FeedItem[] } | null>(null);

  const portRef = useRef<chrome.runtime.Port | null>(null);
  /** Commands issued while the port was down, delivered in order on reconnect. */
  const queueRef = useRef<PanelCommand[]>([]);
  const ctxRef = useRef<SnContext | null>(null);
  ctxRef.current = ctx;

  useEffect(() => {
    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    function connect() {
      if (disposed) return;
      const port = chrome.runtime.connect({ name: PANEL_PORT_NAME });
      portRef.current = port;
      setConnected(true);

      port.onMessage.addListener((event: AgentEvent) => {
        switch (event.type) {
          case "state":
            setFeed(event.feed);
            setRunning(event.running);
            setRun(event.run ?? null);
            setCtx(event.ctx);
            setCatalog(event.catalog);
            setSettings(event.settings);
            setCost(event.cost || { ...EMPTY_COST });
            setConnection(event.connection || { ...INITIAL_CONNECTION });
            setViewedHost(event.viewedHost ?? null);
            break;
          case "viewed":
            setViewedHost(event.host);
            break;
          case "run":
            setRun(event.run);
            break;
          case "connection":
            setConnection(event.connection);
            break;
          case "model_list":
            // A refresh keeps the list it is refreshing on screen until the
            // new one arrives, rather than blanking it.
            setModelLists((prev) => ({
              ...prev,
              [event.provider]: {
                models: event.loading ? prev[event.provider]?.models ?? [] : event.models,
                loading: !!event.loading,
                error: event.error,
              },
            }));
            break;
          case "cost":
            setCost(event.cost);
            break;
          case "feed_patch":
            setFeed((prev) => {
              const idx = prev.findIndex((f) => f.id === event.item.id);
              if (idx >= 0) {
                const next = [...prev];
                next[idx] = event.item;
                return next;
              }
              return [...prev, event.item];
            });
            break;
          case "feed_reset":
            setFeed([]);
            break;
          case "turn_state":
            setRunning(event.running);
            break;
          case "context":
            setCtx(event.ctx);
            break;
          case "catalog":
            setCatalog(event.catalog);
            break;
          case "settings":
            setSettings(event.settings);
            break;
          case "session_list":
            setSessions(event.sessions);
            break;
          case "session_detail":
            setSessionDetail({ id: event.id, feed: event.feed });
            break;
        }
      });

      port.onDisconnect.addListener(() => {
        if (disposed) return;
        portRef.current = null;
        setConnected(false);
        setConnection({ ...INITIAL_CONNECTION });
        // A list that was loading when the worker went away isn't loading anymore.
        setModelLists((prev) => Object.fromEntries(Object.entries(prev).map(([p, list]) => [p, list && { ...list, loading: false }])));
        // The worker restarted or the port dropped — reconnect and resync.
        // The state snapshot that follows replaces the feed, so nothing is
        // shown twice.
        reconnectTimer = setTimeout(connect, 300);
      });

      // Deliver anything issued while disconnected — once, in order.
      const queued = queueRef.current.splice(0);
      for (const cmd of queued) {
        try {
          port.postMessage(cmd);
        } catch {
          queueRef.current.push(cmd);
        }
      }
    }

    connect();
    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      portRef.current?.disconnect();
    };
  }, []);

  const send = useCallback((cmd: PanelCommand) => {
    const port = portRef.current;
    if (!port) {
      queueRef.current.push(cmd);
      return;
    }
    try {
      port.postMessage(cmd);
    } catch {
      // A port can die before its disconnect event arrives.
      queueRef.current.push(cmd);
    }
  }, []);

  return {
    feed,
    running,
    run,
    ctx,
    catalog,
    settings,
    cost,
    connected,
    connection,
    viewedHost,
    modelLists,
    sessions,
    sessionDetail,
    clearSessionDetail: useCallback(() => setSessionDetail(null), []),

    /** Sends with the page context the panel showed, so "this record" means what the user saw. */
    sendChat: useCallback(
      (text: string, files?: PlanFile[]) => send({ type: "chat", text, files, contextTabId: ctxRef.current?.tabId ?? null }),
      [send]
    ),
    resume: useCallback((runId: string) => send({ type: "resume_run", runId }), [send]),
    approve: useCallback((id: string, approved: boolean) => send({ type: "approval", id, approved }), [send]),
    stop: useCallback(() => send({ type: "stop" }), [send]),
    clear: useCallback(() => send({ type: "clear" }), [send]),
    clearCatalog: useCallback(() => send({ type: "clear_catalog" }), [send]),
    refreshContext: useCallback(() => send({ type: "refresh_context" }), [send]),
    patchSettings: useCallback((patch: SettingsPatch) => send({ type: "set_settings", patch }), [send]),
    switchInstance: useCallback((id: string) => send({ type: "switch_instance", id }), [send]),
    listModels: useCallback((provider: ProviderId, force?: boolean) => send({ type: "list_models", provider, force }), [send]),
    listSessions: useCallback(() => send({ type: "list_sessions" }), [send]),
    getSession: useCallback((id: string) => send({ type: "get_session", id }), [send]),
    deleteSession: useCallback((id: string) => send({ type: "delete_session", id }), [send]),
    openHostTab: useCallback((host: string) => send({ type: "open_host_tab", host }), [send]),
  };
}

export type AgentApi = ReturnType<typeof useAgent>;
