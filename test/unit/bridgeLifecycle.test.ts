// The relay under ordinary browser lifecycle: in-page navigation, reloads,
// unloads, stalled tabs, stale session tokens, health checks and Stop — each
// while a request is already in flight.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SnBridge } from "../../src/background/snBridge";
import { chromeStub } from "../setup";

const DEV = "exampledev.service-now.com";
/** A well-formed record id: the bridge refuses anything else before sending. */
const REC = "a".repeat(32);
type Tab = { id: number; url: string; windowId?: number; lastAccessed?: number; status?: string; token: string; hung?: boolean };
let tabs: Tab[];
let sn: SnBridge;
let received: Array<{ tabId: number; message: any }>;
let answerWith: (tabId: number, message: any) => void;
const tab = (id: number, patch: Partial<Tab> = {}): Tab => ({ id, url: `https://${DEV}/now/nav/ui/home`, windowId: 1, status: "complete", token: `doc-${id}`, ...patch });
const healthProbes = () => vi.mocked(chrome.tabs.sendMessage).mock.calls.filter((c) => (c[1] as any).action === "bridgeHealth").length;
function reply(tabId: number, message: any, body: Record<string, any> = {}) {
  const t = tabs.find((x) => x.id === tabId)!;
  sn.handleResponse({ requestId: message.request.requestId, documentToken: t.token, data: { result: [{ tab: tabId }] }, error: null, ...body },
    { tab: { id: tabId } as chrome.tabs.Tab, frameId: 0, url: t.url });
}
async function settle<T>(promise: Promise<T>, maxMs = 40000): Promise<T> {
  let done = false;
  void promise.then(() => { done = true; }, () => { done = true; });
  for (let waited = 0; waited < maxMs && !done; waited += 50) await vi.advanceTimersByTimeAsync(50);
  return promise;
}

beforeEach(() => {
  vi.useFakeTimers();
  tabs = [tab(1)];
  received = [];
  answerWith = () => {};
  sn = new SnBridge();
  sn.setPreferredHost(DEV, true);
  chromeStub.tabs.query = async () => tabs as any;
  chromeStub.tabs.get = vi.fn(async (id?: number) => { const t = tabs.find((x) => x.id === id); if (!t) throw new Error("No tab with id"); return t; }) as any;
  Object.assign(chrome.windows, { getLastFocused: vi.fn(async () => ({ id: 1 })) });
  Object.assign(chrome, { scripting: { executeScript: vi.fn(async () => []) } });
  chromeStub.tabs.sendMessage = vi.fn(async (id: number, message: any) => {
    const t = tabs.find((x) => x.id === id);
    if (!t) throw new Error("Could not establish connection. Receiving end does not exist.");
    if (t.hung) return new Promise(() => {});
    if (message.action === "bridgeHealth") return { version: 1, ready: true, hostname: DEV, documentToken: t.token };
    if (message.action === "bridgePing") return { version: 1, hostname: DEV, documentToken: t.token };
    if (message.request?.expectedDocumentToken !== t.token) return { sent: false };
    received.push({ tabId: id, message });
    answerWith(id, message);
    return { sent: true };
  }) as any;
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("in-page navigation", () => {
  it("keeps an in-flight read when the tab reports loading for a same-document navigation", async () => {
    const pending = sn.query({ table: "incident" });
    await vi.advanceTimersByTimeAsync(10);
    expect(received).toHaveLength(1);
    // History API / iframe navigation: onUpdated says "loading", the document stays.
    sn.noteNavigation(1);
    await vi.advanceTimersByTimeAsync(1500);
    sn.noteNavigation(1, true);
    await vi.advanceTimersByTimeAsync(500);
    reply(1, received[0].message);
    const result = await pending;
    expect(result.error).toBeNull();
    expect(received).toHaveLength(1);
    expect(sn.getDiagnostics().map((d) => d.event)).toContain("document_kept");
  });

  it("fails fast and re-reads on the new document after a real reload", async () => {
    answerWith = (id, message) => { if (tabs[0].token === "doc-reloaded") reply(id, message); };
    const pending = sn.query({ table: "incident" });
    await vi.advanceTimersByTimeAsync(10);
    tabs[0].token = "doc-reloaded";
    sn.noteNavigation(1);
    const result = await settle(pending);
    expect(result.error).toBeNull();
    expect(received.map((r) => r.message.request.expectedDocumentToken)).toEqual(["doc-1", "doc-reloaded"]);
  });

  it("treats a write in flight during a real reload as uncertain and never resends it", async () => {
    const pending = sn.update("incident", REC, { state: "2" });
    await vi.advanceTimersByTimeAsync(10);
    tabs[0].token = "doc-reloaded";
    sn.noteNavigation(1, true);
    const result = await settle(pending);
    expect(result.outcome).toBe("unknown");
    expect(result.error).toContain("Verify the record");
    expect(received).toHaveLength(1);
  });

  it("invalidates at once when the page reports its own unload", async () => {
    answerWith = (id, message) => { if (tabs[0].token === "doc-next") reply(id, message); };
    const pending = sn.query({ table: "incident" });
    await vi.advanceTimersByTimeAsync(10);
    sn.documentGone(1, "doc-1");
    tabs[0].token = "doc-next";
    const result = await settle(pending);
    expect(result.error).toBeNull();
    expect(received).toHaveLength(2);
    expect(sn.getDiagnostics().map((d) => d.event)).toContain("document_unloaded");
  });
});

describe("a running turn owns its binding", () => {
  it("does not let panel health checks probe underneath it", async () => {
    await sn.beginTurn(DEV);
    const probes = healthProbes();
    await sn.checkHealth();
    await sn.checkHealth();
    expect(healthProbes()).toBe(probes);
    expect(sn.getBoundTabId()).toBe(1);
  });

  it("reuses a recently verified binding instead of re-probing every request", async () => {
    answerWith = (id, message) => reply(id, message);
    await sn.query({ table: "a" });
    await sn.query({ table: "b" });
    await sn.query({ table: "c" });
    expect(healthProbes()).toBe(1);
    expect(received).toHaveLength(3);
  });

  it("abandons a read on a tab that stops answering and finishes it on another tab of the same instance", async () => {
    tabs = [tab(1, { lastAccessed: 5 }), tab(2, { lastAccessed: 1 })];
    answerWith = (id, message) => { if (id === 2) reply(id, message); };
    const pending = sn.query({ table: "incident" });
    await vi.advanceTimersByTimeAsync(10);
    expect(received[0].tabId).toBe(1);
    tabs[0].hung = true; // frozen or wedged: pings go unanswered
    const result = await settle(pending);
    expect(result.error).toBeNull();
    expect(result.data.result[0].tab).toBe(2);
    expect(sn.getDiagnostics().map((d) => d.event)).toContain("liveness_failed");
  });

  it("stops waiting for a read as soon as the run is stopped", async () => {
    const controller = new AbortController();
    await sn.beginTurn(DEV, controller.signal);
    const pending = sn.query({ table: "incident" });
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    const result = await pending;
    expect(result.failure).toBe("cancelled");
    expect(received).toHaveLength(1);
  });
});

describe("races found in review", () => {
  it("stops looking for a tab as soon as the run is stopped, and opens no recovery tab", async () => {
    tabs = [tab(1, { hung: true })];
    const create = vi.fn(async (props: any) => ({ id: 99, ...props }));
    chromeStub.tabs.create = create as any;
    const controller = new AbortController();
    const started = Date.now();
    const binding = sn.beginTurn(DEV, controller.signal);
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    await vi.advanceTimersByTimeAsync(50);
    expect(await binding).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
    await vi.advanceTimersByTimeAsync(10000);
    expect(create).not.toHaveBeenCalled();
    expect(sn.getConnection().phase).not.toBe("unavailable");
  });

  it("never lets a late verdict about an old page fail a write sent to its replacement", async () => {
    await sn.bindTab();
    let pingDelay = 1000;
    const base = vi.mocked(chrome.tabs.sendMessage).getMockImplementation()!;
    vi.mocked(chrome.tabs.sendMessage).mockImplementation((async (id: number, message: any, options: any) => {
      if (message.action === "bridgePing") await new Promise((r) => setTimeout(r, pingDelay));
      return (base as any)(id, message, options);
    }) as any);
    let answer: (() => void) | null = null;
    answerWith = (id, message) => { answer = () => reply(id, message); };
    sn.noteNavigation(1);                       // verification of doc-1 starts at 1.2 s, answers at 2.2 s
    await vi.advanceTimersByTimeAsync(1300);
    sn.documentGone(1, "doc-1");                // the page reloads
    tabs[0].token = "doc-2";
    pingDelay = 0;
    const write = sn.update("incident", REC, { state: "2" });
    await vi.advanceTimersByTimeAsync(300);     // bound to doc-2 and sent
    expect(received.at(-1)?.message.request.expectedDocumentToken).toBe("doc-2");
    await vi.advanceTimersByTimeAsync(1500);    // the stale verdict about doc-1 arrives
    answer!();
    const result = await write;
    expect(result.error).toBeNull();
    expect(result.outcome).toBeUndefined();
  });

  it("abandons a health-check read when a run starts underneath it, without re-binding or flagging the run", async () => {
    tabs = [tab(1, { lastAccessed: 5 }), tab(2, { lastAccessed: 1 })];
    answerWith = (id, message) => reply(id, message, { status: 401, data: {} });
    await settle(sn.query({ table: "x" }));
    expect(sn.getConnection().phase).toBe("sign_in_required");
    const staleTab = sn.getBoundTabId();
    answerWith = (id, message) => (id === staleTab ? reply(id, message, { status: 401, data: {} }) : reply(id, message));
    received.length = 0;
    const health = sn.checkHealth();           // its sign-in read gets 401 and backs off
    await vi.advanceTimersByTimeAsync(20);
    answerWith = (id, message) => reply(id, message);
    await sn.beginTurn(DEV);
    const boundAtStart = sn.getBoundTabId();
    await settle(health);
    expect(sn.getBoundTabId()).toBe(boundAtStart);
    expect(sn.isTurnActive()).toBe(true);
    // Only the first attempt went out; the retry was abandoned, not moved to another tab.
    expect(received.map((r) => r.tabId)).toEqual([staleTab]);
  });
});

describe("session problems", () => {
  it("answers a stale page token's 401 from another tab on the same instance", async () => {
    tabs = [tab(1, { lastAccessed: 5 }), tab(2, { lastAccessed: 1 })];
    answerWith = (id, message) => reply(id, message, id === 1 ? { status: 401, data: { error: { message: "User Not Authenticated" } } } : {});
    const result = await settle(sn.query({ table: "incident" }));
    expect(result.error).toBeNull();
    expect(result.data.result[0].tab).toBe(2);
    expect(sn.getConnection().phase).toBe("ready");
  });

  it("reports sign-in required only when no tab on the instance is authenticated", async () => {
    tabs = [tab(1), tab(2, { lastAccessed: 1 })];
    answerWith = (id, message) => reply(id, message, { status: 401, data: { error: { message: "User Not Authenticated" } } });
    const result = await settle(sn.query({ table: "incident" }));
    expect(result.failure).toBe("authentication");
    expect(received.map((r) => r.tabId).sort()).toEqual([1, 2]);
    expect(sn.getConnection().phase).toBe("sign_in_required");
  });

  it("clears sign-in required once a health check read succeeds after the user signs in", async () => {
    answerWith = (id, message) => reply(id, message, { status: 401, data: {} });
    await settle(sn.query({ table: "incident" }));
    expect(sn.getConnection().phase).toBe("sign_in_required");
    answerWith = (id, message) => reply(id, message);
    await vi.advanceTimersByTimeAsync(31000);
    await settle(sn.checkHealth());
    expect(sn.getConnection().phase).toBe("ready");
  });

  it("resends a write only when the page provably never received it", async () => {
    let first = true;
    chromeStub.tabs.sendMessage = vi.fn(async (id: number, message: any) => {
      const t = tabs.find((x) => x.id === id)!;
      if (message.action === "bridgeHealth") return { version: 1, ready: true, hostname: DEV, documentToken: t.token };
      if (message.action === "bridgePing") return { version: 1, hostname: DEV, documentToken: t.token };
      if (first) { first = false; throw new Error("Could not establish connection. Receiving end does not exist."); }
      received.push({ tabId: id, message });
      reply(id, message);
      return { sent: true };
    }) as any;
    const result = await settle(sn.update("incident", REC, { state: "2" }));
    expect(result.error).toBeNull();
    expect(received).toHaveLength(1);
  });
});
