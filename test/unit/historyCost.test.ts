// History lists each saved chat with what it cost, read back from storage
// without trusting it: chats saved before costs were recorded, and values
// that aren't sensible numbers, never reach the panel as anything but zero.
import { afterEach, expect, it, vi } from "vitest";
import { PANEL_PORT_NAME, type AgentEvent } from "../../src/shared/types";

afterEach(() => { vi.restoreAllMocks(); });

it("lists saved chats with their cost, sanitized", async () => {
  vi.resetModules();
  await chrome.storage.local.set({
    copilotSessions: [
      { id: "s1", at: 2, title: "Recent", usd: 0.12, feed: [{}, {}], cost: { usd: 0.12, inputTokens: 900, outputTokens: 80, cacheReadTokens: 400, requests: 3, estimatedRequests: 0, reportedRequests: 3 } },
      { id: "s2", at: 1, title: "Older", usd: 0.03, feed: [{}] },
      { id: "s3", at: 0, title: "Tampered", feed: [], cost: { usd: "lots", inputTokens: -5, outputTokens: Infinity, requests: 2 } },
    ],
  });
  const accept: Array<(port: chrome.runtime.Port) => void> = [];
  vi.spyOn(chrome.runtime.onConnect, "addListener").mockImplementation((fn) => { accept.push(fn); });
  const { SnBridge } = await import("../../src/background/snBridge");
  vi.spyOn(SnBridge.prototype, "checkHealth").mockResolvedValue();
  await import("../../src/background/index");

  const events: AgentEvent[] = [];
  let command: (cmd: any) => void = () => {};
  accept[0]({
    name: PANEL_PORT_NAME,
    postMessage: (event: AgentEvent) => events.push(event),
    onMessage: { addListener: (fn: typeof command) => { command = fn; } },
    onDisconnect: { addListener: () => {} },
  } as unknown as chrome.runtime.Port);
  command({ type: "list_sessions" });

  await vi.waitFor(() => expect(events.some((e) => e.type === "session_list")).toBe(true));
  const list = events.find((e): e is Extract<AgentEvent, { type: "session_list" }> => e.type === "session_list")!.sessions;
  expect(list).toEqual([
    { id: "s1", at: 2, title: "Recent", items: 2, usd: 0.12, cost: { usd: 0.12, inputTokens: 900, outputTokens: 80, cacheReadTokens: 400, requests: 3, estimatedRequests: 0, reportedRequests: 3 } },
    { id: "s2", at: 1, title: "Older", items: 1, usd: 0.03, cost: undefined },
    { id: "s3", at: 0, title: "Tampered", items: 0, usd: undefined, cost: { usd: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, requests: 2, estimatedRequests: 0, reportedRequests: 0 } },
  ]);
});
