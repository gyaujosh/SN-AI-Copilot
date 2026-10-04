// Panels are viewers. Closing one mid-run must not cancel, restart or
// duplicate the run; a reopened panel picks up the same live run.
import { afterEach, expect, it, vi } from "vitest";
import { PANEL_PORT_NAME, type AgentEvent } from "../../src/shared/types";
import { DEV_HOST, INSTANCES } from "../fixtures/chat";

const { complete, script } = vi.hoisted(() => {
  const script: Array<(params: any) => any> = [];
  const complete = vi.fn(async (_key: string, params: any) => script.shift()!(params));
  return { complete, script };
});
vi.mock("../../src/background/providers", async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, getAdapter: () => ({ id: "openrouter", complete }) };
});

const DEV = DEV_HOST;
const reply = (text: string, toolCalls: any[] = []) => () => ({ text, toolCalls, stopReason: toolCalls.length ? "tool_use" : "end_turn", raw: { provider: "openrouter", content: null } });
afterEach(() => { vi.restoreAllMocks(); });

it("keeps a run alive through a closed panel and hands the reopened panel the same run", async () => {
  vi.resetModules();
  await chrome.storage.local.set({ provider: "openrouter", providerKeys: { openrouter: "k" }, providerModels: { openrouter: "vendor/test-model" }, snInstances: INSTANCES, activeInstanceId: "dev" });
  const accept: Array<(port: chrome.runtime.Port) => void> = [];
  vi.spyOn(chrome.runtime.onConnect, "addListener").mockImplementation((fn) => { accept.push(fn); });
  const { SnBridge } = await import("../../src/background/snBridge");
  vi.spyOn(SnBridge.prototype, "checkHealth").mockResolvedValue();
  vi.spyOn(SnBridge.prototype, "beginTurn").mockResolvedValue(1);
  vi.spyOn(SnBridge.prototype, "getBoundTabHost").mockResolvedValue(DEV);
  vi.spyOn(SnBridge.prototype, "requestContextRefresh").mockResolvedValue();
  let answer: ((value: any) => void) | null = null;
  const query = vi.spyOn(SnBridge.prototype, "query").mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
  script.push(reply("Checking.", [{ id: "call_q", name: "query_records", input: { table: "incident" } }]), reply("Found 3 incidents."));
  await import("../../src/background/index");

  function open() {
    const events: AgentEvent[] = [];
    let command: (cmd: any) => void = () => {};
    let closed: () => void = () => {};
    accept[0]({
      name: PANEL_PORT_NAME,
      postMessage: (event: AgentEvent) => events.push(event),
      onMessage: { addListener: (fn: typeof command) => { command = fn; } },
      onDisconnect: { addListener: (fn: typeof closed) => { closed = fn; } },
    } as unknown as chrome.runtime.Port);
    return { events, send: (cmd: any) => command(cmd), close: () => closed() };
  }

  const first = open();
  await vi.waitFor(() => expect(first.events.some((e) => e.type === "state")).toBe(true));
  first.send({ type: "chat", text: "Find incidents" });
  await vi.waitFor(() => expect(answer).not.toBeNull(), { timeout: 3000 });
  first.close(); // the side panel is closed while ServiceNow is still answering

  const second = open();
  await vi.waitFor(() => expect(second.events.some((e) => e.type === "state")).toBe(true));
  const state = second.events.find((e) => e.type === "state") as Extract<AgentEvent, { type: "state" }>;
  expect(state.running).toBe(true);
  expect(state.run).toMatchObject({ status: "running", host: DEV });
  expect(state.feed.filter((f) => f.kind === "user")).toHaveLength(1);

  answer!({ data: { result: [{ number: "INC0010001" }] }, error: null });
  await vi.waitFor(() => expect(second.events.some((e) => e.type === "turn_state" && !e.running)).toBe(true), { timeout: 3000 });
  expect(second.events.some((e) => e.type === "feed_patch" && e.item.kind === "assistant" && e.item.text === "Found 3 incidents.")).toBe(true);
  expect(complete).toHaveBeenCalledTimes(2);
  expect(query).toHaveBeenCalledTimes(1);
  const diagnostics = (await chrome.storage.session.get("copilotRunDiagnostics")).copilotRunDiagnostics as any[];
  expect(diagnostics.some((d) => d.event === "panel_detach" && d.running === true)).toBe(true);
});
