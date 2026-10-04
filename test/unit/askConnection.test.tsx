import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAgent, type AgentApi } from "../../src/sidepanel/hooks/useAgent";
import { EMPTY_COST, PANEL_PORT_NAME, type AgentEvent } from "../../src/shared/types";
import { DEV_HOST, INSTANCES, chatFeed, publicSettings } from "../fixtures/chat";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it("mirrors streaming chat and settings without polling the background", () => {
  vi.useFakeTimers();
  let receive: (event: AgentEvent) => void;
  let disconnected: () => void;
  const postMessage = vi.fn();
  const disconnect = vi.fn(() => disconnected());
  const connect = vi.fn(() => ({
    postMessage, disconnect,
    onMessage: { addListener: (fn: typeof receive) => { receive = fn; } },
    onDisconnect: { addListener: (fn: typeof disconnected) => { disconnected = fn; } },
  }));
  Object.assign(chrome.runtime, { connect });
  let agent: AgentApi;
  function Probe() { agent = useAgent(); return null; }
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() => root.render(<Probe />));
  expect(connect).toHaveBeenCalledWith({ name: PANEL_PORT_NAME });
  act(() => receive({ type: "state", feed: chatFeed, running: false, ctx: null, catalog: null, settings: publicSettings(), cost: EMPTY_COST }));
  act(() => vi.advanceTimersByTime(10 * 60 * 1000));
  expect(postMessage).not.toHaveBeenCalled();
  const file = { name: "notes.txt", content: "Example", type: "text/plain", isImage: false };
  act(() => agent.sendChat("Read this", [file]));
  // No page context was shown, so none is claimed for the message.
  expect(postMessage).toHaveBeenLastCalledWith({ type: "chat", text: "Read this", files: [file], contextTabId: null });
  act(() => {
    receive({ type: "turn_state", running: true });
    receive({ type: "feed_patch", item: { kind: "assistant", id: "stream", text: "First", streaming: true } });
  });
  expect(agent.running).toBe(true);
  act(() => receive({ type: "feed_patch", item: { kind: "assistant", id: "stream", text: "First and second", streaming: false } }));
  expect(agent.feed.filter((item) => item.id === "stream")).toHaveLength(1);
  expect(agent.feed.at(-1)).toMatchObject({ text: "First and second", streaming: false });
  act(() => agent.stop());
  expect(postMessage).toHaveBeenLastCalledWith({ type: "stop" });
  act(() => root.unmount());
  expect(disconnect).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("delivers a Stop or a message issued while reconnecting, once and in order", () => {
  vi.useFakeTimers();
  const ports: Array<{ postMessage: ReturnType<typeof vi.fn>; receive: (event: AgentEvent) => void; drop: () => void }> = [];
  const connect = vi.fn(() => {
    const port: any = { postMessage: vi.fn(), disconnect: vi.fn() };
    port.onMessage = { addListener: (fn: (event: AgentEvent) => void) => { port.receive = fn; } };
    port.onDisconnect = { addListener: (fn: () => void) => { port.drop = fn; } };
    ports.push(port);
    return port;
  });
  Object.assign(chrome.runtime, { connect });
  let agent: AgentApi;
  function Probe() { agent = useAgent(); return null; }
  const root = createRoot(document.createElement("div"));
  act(() => root.render(<Probe />));
  act(() => ports[0].receive({ type: "state", feed: [], running: true, ctx: { hostname: DEV_HOST, tabId: 42 }, catalog: null, settings: publicSettings(), cost: EMPTY_COST }));
  act(() => ports[0].drop()); // the worker restarted; the panel is between ports
  act(() => agent.stop());
  act(() => agent.sendChat("Are you still there?"));
  expect(ports[0].postMessage).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(300));
  expect(connect).toHaveBeenCalledTimes(2);
  expect(ports[1].postMessage.mock.calls.map((c) => c[0])).toEqual([
    { type: "stop" },
    { type: "chat", text: "Are you still there?", files: undefined, contextTabId: 42 },
  ]);
  act(() => root.unmount());
});

/** Loads a fresh background worker with a panel attached; returns its hooks. */
async function startBackground(saved: Record<string, unknown> = {}, tabs: Partial<chrome.tabs.Tab>[] = []) {
  vi.resetModules();
  await chrome.storage.local.set(saved);
  chrome.tabs.query = (async () => tabs) as any;
  let onConnect!: (port: chrome.runtime.Port) => void;
  let onMessage!: (message: any, sender: chrome.runtime.MessageSender, respond: (r: unknown) => void) => void;
  let onCommand!: (cmd: any) => void;
  let disconnectPort!: () => void;
  vi.spyOn(chrome.runtime.onConnect, "addListener").mockImplementation((fn) => { onConnect = fn; });
  vi.spyOn(chrome.runtime.onMessage, "addListener").mockImplementation((fn: any) => { onMessage = fn; });
  const { SnBridge } = await import("../../src/background/snBridge");
  const prefer = vi.spyOn(SnBridge.prototype, "setPreferredHost");
  const health = vi.spyOn(SnBridge.prototype, "checkHealth").mockResolvedValue();
  vi.spyOn(SnBridge.prototype, "requestContextRefresh").mockResolvedValue();
  vi.useFakeTimers();
  await import("../../src/background/index");
  const events: AgentEvent[] = [];
  const port = { name: PANEL_PORT_NAME, postMessage: (event: AgentEvent) => events.push(event), onMessage: { addListener: (fn: typeof onCommand) => { onCommand = fn; } }, onDisconnect: { addListener: (fn: () => void) => { disconnectPort = fn; } } };
  onConnect(port as unknown as chrome.runtime.Port);
  await vi.waitFor(() => expect(events.some((event) => event.type === "state")).toBe(true));
  return { events, prefer, health, onConnect, onMessage, command: (cmd: any) => onCommand(cmd), disconnect: () => disconnectPort() };
}

describe("background startup", () => {
  it("restores the conversation, and moves Auto to no instance — not the first listed — when the pinned one is removed", async () => {
    const createAlarm = vi.spyOn(chrome.alarms, "create");
    const bg = await startBackground({ snInstances: INSTANCES, activeInstanceId: "test", chatPinnedInstanceId: "test", copilotFeed: chatFeed });
    const state = bg.events.find((event) => event.type === "state")!;
    expect(state).toMatchObject({ feed: chatFeed, settings: { pinnedInstanceId: "test" } });
    expect(createAlarm).not.toHaveBeenCalled();
    bg.command({ type: "set_settings", patch: { instanceOps: [{ op: "remove", id: "test" }] } });
    await vi.waitFor(() => expect(bg.events.filter((event) => event.type === "settings").at(-1)).toMatchObject({ settings: { pinnedInstanceId: null, activeInstanceId: null } }));
    expect(bg.prefer).toHaveBeenLastCalledWith(null, false);
    expect(state).toHaveProperty("connection");
    // One check when the panel attaches, then one per interval while it stays.
    const atConnect = bg.health.mock.calls.length;
    await vi.advanceTimersByTimeAsync(15000);
    expect(bg.health).toHaveBeenCalledTimes(atConnect + 1);
    bg.disconnect();
    await vi.advanceTimersByTimeAsync(30000);
    expect(bg.health).toHaveBeenCalledTimes(atConnect + 1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("snaps Auto to the ServiceNow tab on screen when the pinned instance is removed", async () => {
    const viewed = "dev12345.service-now.com";
    const bg = await startBackground(
      { snInstances: INSTANCES, activeInstanceId: "test", chatPinnedInstanceId: "test" },
      [{ id: 5, windowId: 1, active: true, url: `https://${viewed}/incident_list.do` }],
    );
    bg.command({ type: "set_settings", patch: { instanceOps: [{ op: "remove", id: "test" }] } });
    await vi.waitFor(() => expect(bg.prefer).toHaveBeenLastCalledWith(viewed, false));
    // The panel learns which tab is on screen from its first snapshot or a later update.
    const latest = [...bg.events].reverse().find((e) => e.type === "viewed" || (e.type === "state" && e.viewedHost));
    expect(latest?.type === "viewed" ? latest.host : latest?.type === "state" ? latest.viewedHost : null).toBe(viewed);
  });
});

describe("what the background trusts", () => {
  it("takes a page's host from Chrome, not from what the page reports, and drops a leaked session token", async () => {
    const bg = await startBackground({ snInstances: INSTANCES });
    const pageUrl = "https://visited.service-now.com/incident.do";
    bg.onMessage(
      { action: "contextUpdate", context: { hostname: DEV_HOST, instance: "exampledev", url: `https://${DEV_HOST}/x`, table: "incident", g_ck: "session-token" } },
      { tab: { id: 9, active: true, windowId: 1, url: pageUrl } as chrome.tabs.Tab, url: pageUrl, frameId: 0 },
      () => {},
    );
    await vi.waitFor(() => expect(bg.events.some((e) => e.type === "context" && e.ctx?.tabId === 9)).toBe(true));
    const ctx = [...bg.events].reverse().find((e) => e.type === "context" && e.ctx?.tabId === 9) as Extract<AgentEvent, { type: "context" }>;
    expect(ctx.ctx).toMatchObject({ hostname: "visited.service-now.com", instance: "visited", url: pageUrl });
    expect(ctx.ctx).not.toHaveProperty("g_ck");
    // Auto follows the host Chrome reported — never the one the page claimed.
    await vi.waitFor(() => expect(bg.prefer).toHaveBeenLastCalledWith("visited.service-now.com"));
  });

  it("ignores context from pages that aren't ServiceNow", async () => {
    const bg = await startBackground();
    const before = bg.events.length;
    bg.onMessage({ action: "contextUpdate", context: { hostname: DEV_HOST } }, { tab: { id: 3, active: true } as chrome.tabs.Tab, url: "https://example.com/" }, () => {});
    await vi.advanceTimersByTimeAsync(50);
    expect(bg.events.slice(before).some((e) => e.type === "context")).toBe(false);
  });

  it("lets only the extension's own pages drive the agent, never a content script", async () => {
    const bg = await startBackground();
    const disconnect = vi.fn();
    const fromPage = {
      name: PANEL_PORT_NAME, sender: { tab: { id: 4 }, url: "https://visited.service-now.com/" },
      postMessage: vi.fn(), disconnect, onMessage: { addListener: vi.fn() }, onDisconnect: { addListener: vi.fn() },
    };
    bg.onConnect(fromPage as unknown as chrome.runtime.Port);
    expect(disconnect).toHaveBeenCalledOnce();
    expect(fromPage.onMessage.addListener).not.toHaveBeenCalled();
    expect(fromPage.postMessage).not.toHaveBeenCalled();
  });
});
