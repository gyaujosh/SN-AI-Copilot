/** Isolated preview of the real panel; no ServiceNow or AI calls are made. */
import React, { useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { AppView } from "../src/sidepanel/App";
import type { View } from "../src/sidepanel/components/BottomNav";
import { DEV_HOST, SYS_ID, chatFeed, fakeAgent, publicSettings } from "../test/fixtures/chat";
import { EMPTY_COST, NO_MODELS, type FeedItem, type ModelListEntry, type ProviderId, type PublicRun, type PublicSettings, type SessionCost, type SessionMeta, type SettingsPatch } from "../src/shared/types";
import type { ConnectionState } from "../src/shared/connection";
import { helperExplanation } from "../src/background/snCatalog";
import "../src/sidepanel/fonts";
import "../src/sidepanel/index.css";

const params = new URLSearchParams(location.search);
const width = Number(params.get("width")) || 400;
const scenario = params.get("scenario") || "empty";
const view = (["chat", "history", "settings"].includes(params.get("view") || "") ? params.get("view") : "chat") as View;
const section = params.get("section");
const stored: Record<string, unknown> = {
  theme: params.get("theme") === "dark" ? "dark" : "light",
  textSize: params.get("text") || "lg",
  navPinned: params.get("nav") !== "auto",
};
const g = globalThis as unknown as { chrome: { storage: unknown } };
g.chrome ??= { storage: {} };
g.chrome.storage = {
  local: {
    get: (_keys: unknown, callback?: (value: object) => void) => callback ? callback(stored) : Promise.resolve(stored),
    set: (patch: object) => { Object.assign(stored, patch); return Promise.resolve(); },
  },
};

const DEV = DEV_HOST;
/** A personal developer instance the user hasn't added in Settings. */
const PDI = "dev12345.service-now.com";
const now = Date.now();
const connections: Record<string, ConnectionState> = {
  "no-tab": { phase: "unavailable", host: DEV, checkedAt: now, reason: "no_tab" },
  reconnecting: { phase: "reconnecting", host: DEV, checkedAt: now },
  "sign-in": { phase: "sign_in_required", host: DEV, checkedAt: now, reason: "authentication" },
  "first-run": { phase: "ready", host: PDI, checkedAt: now },
  unadded: { phase: "ready", host: PDI, checkedAt: now },
};
const approval: FeedItem = {
  kind: "approval", id: "approval", summary: "Update assignment", destructive: false, status: "pending",
  where: `Dev · ${DEV_HOST}`,
  ops: [`Update incident record ${SYS_ID}: assignment_group = "Service Desk"`],
};
const helperApproval: FeedItem = {
  kind: "approval", id: "approval-helper", summary: "Approving installs only this Script Include.", destructive: false, status: "pending",
  where: `Dev · ${DEV_HOST}`,
  ops: ["Install the SNAICopilotHelper Script Include (sys_script_include), used to create catalog UI policy actions"],
  explain: helperExplanation("install"),
  helper: true,
};
const streaming: FeedItem[] = [
  chatFeed[0],
  { id: "t-stream", kind: "tools", tools: [
    { id: "s1", name: "get_table_schema", label: "Read incident schema", status: "ok", summary: "31 fields" },
    { id: "s2", name: "query_records", label: "Query incident", detail: "active=true^priority<=2", status: "running" },
  ] },
  { id: "a-stream", kind: "assistant", text: "Checking the incident table for high-priority work assigned to", streaming: true },
];
const interrupted: FeedItem[] = [
  chatFeed[0],
  { id: "t-int", kind: "tools", tools: [
    { id: "i1", name: "get_table_schema", label: "Read incident schema", status: "ok", summary: "31 fields" },
    { id: "i2", name: "update_record", label: "Set assignment group on INC0010001", detail: SYS_ID, status: "unknown", summary: "interrupted — verify whether it was applied" },
  ] },
  { id: "n-int", kind: "notice", tone: "warning", runId: "run_1", text: "Chrome restarted the extension's background worker during this run, so it stopped. Completed steps are kept above; resume to continue." },
];
const stopped: FeedItem[] = [
  { id: "u-s", kind: "user", text: "Check the incident, then move it to the Network group.", at: now },
  { id: "t-s", kind: "tools", tools: [
    { id: "s-r", name: "get_record", label: "Read incident record", detail: SYS_ID, status: "ok", summary: "loaded" },
    { id: "s-w", name: "update_record", label: "Set assignment group on INC0010001", detail: SYS_ID, status: "skipped", summary: "not run" },
  ] },
  { id: "n-s", kind: "notice", text: "Stopped." },
];
const tables: FeedItem[] = [
  { id: "u-t", kind: "user", text: "Compare the SLA definitions for P1 and P2 incidents across every assignment group, including the ones with an empty schedule.", at: now },
  { id: "a-t", kind: "assistant", text: "## SLA definitions\n\n| Name | Priority | Duration | Schedule | Group | Condition |\n| --- | --- | --- | --- | --- | --- |\n| P1 resolution | 1 | 4 h | 24x7 | Service Desk | active=true^priority=1^assignment_group.name=Service Desk |\n| P2 resolution | 2 | 8 h |  | Network | active=true^priority=2 |\n| P2 response | 2 |  |  |  | priority=2 |\n\nThe second rule has **no schedule**, so it runs on elapsed time.\n\n```javascript\nvar gr = new GlideRecord('contract_sla'); gr.addQuery('collection', 'incident'); gr.addEncodedQuery('nameSTARTSWITHP1^ORnameSTARTSWITHP2'); gr.query(); while (gr.next()) { gs.info(gr.getValue('name') + ' → ' + gr.getValue('duration')); }\n```" },
];
const unadded: FeedItem[] = [
  { id: "u-r", kind: "user", text: "Create an assignment group called Network Ops.", at: now },
  { id: "a-r", kind: "assistant", text: "I'll create the **Network Ops** group (sys_user_group)." },
  {
    kind: "approval", id: "approval-unadded", summary: "Create group", destructive: false, status: "pending",
    where: `dev12345 · ${PDI} · not added in Settings`,
    ops: ['Create sys_user_group: name = "Network Ops"'],
  },
];
const runs: Record<string, PublicRun> = {
  interrupted: { id: "run_1", status: "interrupted", host: DEV, startedAt: now - 60000, endedAt: now - 5000, failure: "worker_restarted", resumable: true },
  error: { id: "run_2", status: "failed", host: DEV, startedAt: now - 60000, endedAt: now - 5000, failure: "provider_auth", resumable: true },
};
const feeds: Record<string, FeedItem[]> = {
  chat: chatFeed,
  approval: [...chatFeed, approval],
  helper: [...chatFeed, helperApproval],
  approved: [...chatFeed, { ...approval, status: "approved" } as FeedItem, { id: "t-w", kind: "tools", tools: [{ id: "w1", name: "update_record", label: "Set assignment group on INC0010001", detail: SYS_ID, status: "ok", summary: "updated" }] }],
  streaming,
  interrupted,
  stopped,
  tables,
  unadded,
  error: [chatFeed[0], { kind: "error", id: "err", runId: "run_2", text: "Your OpenAI API key was rejected. Check it in Settings." }],
  long: [{ id: "u-l", kind: "user", text: "Explain the record I'm looking at, including every related business rule, client script and UI policy that touches the assignment group field.", fileNames: ["sample-data.xlsx", "screenshot.png"], at: now }, ...chatFeed.slice(1)],
};

/** A few model calls' worth of spend, for any scenario with a conversation. */
const SAMPLE_COST: SessionCost = {
  usd: 0.0421, turnUsd: 0.0187, inputTokens: 14210, outputTokens: 1830, cacheReadTokens: 22400,
  requests: 4, estimatedRequests: 0, reportedRequests: 0,
};

/** What each provider's models API might return — the preview's stand-in for a live catalog. */
const CATALOGS: Record<ProviderId, ModelListEntry[]> = {
  anthropic: [
    { id: "claude-sonnet-5", name: "Claude Sonnet 5", efforts: ["low", "medium", "high", "xhigh", "max"], adaptiveThinking: true },
    { id: "claude-opus-5-5", name: "Claude Opus 5.5", efforts: ["low", "medium", "high", "xhigh", "max"], adaptiveThinking: true },
    { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", adaptiveThinking: false },
  ],
  openai: [{ id: "gpt-6-sol", name: "gpt-6-sol" }, { id: "gpt-5.5", name: "gpt-5.5" }, { id: "gpt-4.1", name: "gpt-4.1" }],
  openrouter: [
    { id: "anthropic/claude-sonnet-5", name: "Anthropic: Claude Sonnet 5", efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "high" },
    { id: "openai/gpt-5.5", name: "OpenAI: GPT-5.5", efforts: ["none", "low", "medium", "high", "xhigh"], defaultEffort: "medium" },
    { id: "google/gemini-3.1-pro-preview", name: "Google: Gemini 3.1 Pro Preview" },
  ],
};

function effortsAfter(efforts: PublicSettings["efforts"], change: NonNullable<SettingsPatch["effort"]>): PublicSettings["efforts"] {
  const next = { ...efforts };
  delete next[`${change.provider}:${change.model}`];
  if (change.level) next[`${change.provider}:${change.model}`] = change.level;
  return next;
}

function Preview() {
  const [settings, setSettings] = useState<PublicSettings>(() => {
    if (scenario === "missing-key") return publicSettings({ keysPresent: { anthropic: false, openai: false, openrouter: false } });
    if (scenario === "first-run") {
      return publicSettings({ keysPresent: { anthropic: false, openai: false, openrouter: false }, models: { ...NO_MODELS }, instances: [], activeInstanceId: null });
    }
    if (scenario === "long") {
      const custom = { id: "inst_long", label: "Example long-named test environment", host: "example-long-environment-name-test-2.service-now.com", role: "test" as const };
      return publicSettings({
        provider: "openrouter", keysPresent: { anthropic: true, openai: true, openrouter: true },
        models: { ...publicSettings().models, openrouter: "meta-llama/llama-4-maverick-instruct-extended-context-preview" },
        instances: [...publicSettings().instances, custom], activeInstanceId: "inst_long", pinnedInstanceId: "inst_long",
      });
    }
    return publicSettings({ keysPresent: { anthropic: true, openai: true, openrouter: false } });
  });
  const [feed, setFeed] = useState<FeedItem[]>(feeds[scenario] ?? []);
  const [running, setRunning] = useState(["approval", "helper", "streaming"].includes(scenario));
  const [run, setRun] = useState<PublicRun | null>(runs[scenario] ?? null);
  const [cost, setCost] = useState<SessionCost>(feeds[scenario]?.length ? SAMPLE_COST : { ...EMPTY_COST });
  const [sessions, setSessions] = useState<SessionMeta[]>([
    {
      id: "past", title: "Find high-priority incidents assigned to Service Desk", at: now - 3600000, items: chatFeed.length, usd: 0.1284,
      cost: { usd: 0.1284, inputTokens: 38120, outputTokens: 5210, cacheReadTokens: 96400, requests: 9, estimatedRequests: 0, reportedRequests: 0 },
    },
    // Saved before tokens were recorded: dollars only.
    { id: "past2", title: "Explain the assignment rule on INC0010003", at: now - 86400000, items: 6, usd: 0.0316 },
  ]);
  const [sessionDetail, setSessionDetail] = useState<{ id: string; feed: FeedItem[] } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const viewedHost = scenario === "long" ? "example-long-environment-name-test-2.service-now.com" : connections[scenario]?.host ?? DEV;
  const modelLists = Object.fromEntries(
    (Object.keys(CATALOGS) as ProviderId[]).filter((p) => settings.keysPresent[p]).map((p) => [p, { models: CATALOGS[p], loading: false }])
  );
  const agent = fakeAgent({
    settings, feed, running, run, sessions, sessionDetail, modelLists, cost,
    connection: connections[scenario] ?? { phase: "ready", host: viewedHost, checkedAt: now },
    viewedHost: scenario === "no-tab" ? null : connections[scenario]?.host ?? viewedHost,
    ...(scenario === "no-tab" ? { ctx: null } : {}),
    ...(scenario === "first-run" || scenario === "unadded" ? { ctx: { hostname: PDI, instance: "dev12345", table: "incident", isList: true, tabId: 5 } } : {}),
    ...(scenario === "long" ? { ctx: { hostname: viewedHost, instance: "example-long-environment-name-test-2", table: "sc_req_item", isForm: true, values: { number: "RITM0123456789" }, sysId: "b".repeat(32), tabId: 3 } } : {}),
    ...(scenario === "streaming" ? { run: { id: "run_s", status: "running", host: DEV, startedAt: now, resumable: false } as PublicRun } : {}),
    patchSettings: (patch) => setSettings((previous) => {
      const keysPresent = { ...previous.keysPresent, ...Object.fromEntries(Object.entries(patch.apiKeys ?? {}).map(([key, value]) => [key, !!value])) };
      let instances = patch.instances ?? previous.instances;
      for (const change of patch.instanceOps ?? []) {
        if (change.op === "add") instances = [...instances, change.instance];
        else if (change.op === "remove") instances = instances.filter((i) => i.id !== change.id);
        else instances = instances.map((i) => (i.id === change.id ? { ...i, role: change.role } : i));
      }
      const next: PublicSettings = {
        ...previous,
        provider: patch.provider ?? (patch.apiKeys && !keysPresent[previous.provider] ? (Object.keys(keysPresent) as ProviderId[]).find((p) => keysPresent[p]) ?? previous.provider : previous.provider),
        models: { ...previous.models, ...patch.models },
        efforts: patch.effort ? effortsAfter(previous.efforts, patch.effort) : previous.efforts,
        keysPresent,
        instances,
        pinnedInstanceId: patch.pinnedInstanceId === undefined ? previous.pinnedInstanceId : patch.pinnedInstanceId,
        activeInstanceId: patch.pinnedInstanceId ?? patch.activeInstanceId ?? previous.activeInstanceId,
      };
      if (!instances.some((i) => i.id === next.pinnedInstanceId)) next.pinnedInstanceId = null;
      return next;
    }),
    sendChat: (text, files) => {
      setFeed((prev) => [...prev, { id: `u${Date.now()}`, kind: "user", text, fileNames: files?.map((f) => f.name), at: Date.now() }]);
      setRunning(true);
      setCost((c) => ({ ...c, turnUsd: 0 }));
      timer.current = setTimeout(() => {
        setFeed((prev) => [...prev, { kind: "assistant", id: `a${Date.now()}`, text: "This is a preview conversation. In the extension, answers come from your selected AI and the ServiceNow page you’re on." }]);
        setCost((c) => ({ ...c, usd: c.usd + 0.0093, turnUsd: 0.0093, inputTokens: c.inputTokens + 2140, outputTokens: c.outputTokens + 186, requests: c.requests + 1 }));
        setRunning(false);
      }, 1200);
    },
    resume: () => { setRun(null); setFeed((prev) => [...prev, { kind: "notice", id: `n${Date.now()}`, text: `Resuming from the last completed step on ${DEV}.` }]); },
    stop: () => { if (timer.current) clearTimeout(timer.current); setRunning(false); setFeed((prev) => [...prev, { kind: "notice", id: `s${Date.now()}`, text: "Stopped." }]); },
    clear: () => { if (timer.current) clearTimeout(timer.current); setRunning(false); setFeed([]); setRun(null); setCost({ ...EMPTY_COST }); },
    approve: (id, approved) => { setFeed((prev) => prev.map((item) => item.kind === "approval" && item.id === id ? { ...item, status: approved ? "approved" : "denied" } : item)); setRunning(false); },
    switchInstance: (id) => setSettings((s) => ({ ...s, activeInstanceId: id, pinnedInstanceId: id })),
    getSession: (id) => setSessionDetail({ id, feed: chatFeed }),
    clearSessionDetail: () => setSessionDetail(null),
    deleteSession: (id) => setSessions((prev) => prev.filter((s) => s.id !== id)),
  });
  return <AppView agent={agent} initialView={view} initialSection={section} />;
}

document.body.style.cssText = "display:flex;justify-content:center;background:#d9dbe8;";
const root = document.getElementById("root")!;
root.style.cssText = `width:${width}px;max-width:100vw;height:100vh;box-shadow:0 0 40px #0002;`;
createRoot(root).render(<Preview />);
