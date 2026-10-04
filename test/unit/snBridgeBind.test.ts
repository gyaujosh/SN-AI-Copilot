import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SnBridge } from "../../src/background/snBridge";
import { chromeStub } from "../setup";
const DEV = "exampledev.service-now.com";
/** A well-formed record id: the bridge refuses anything else before sending. */
const REC = "a".repeat(32);
const PROD = "example.service-now.com";
type Tab = { id: number; url: string; active?: boolean; windowId?: number; lastAccessed?: number; discarded?: boolean; frozen?: boolean; status?: string; ready?: boolean; token?: string; version?: number };
let tabs: Tab[];
let sn: SnBridge;
let attempts: Array<{ tabId: number; message: any }>;
let perform: (tabId: number, message: any) => Promise<any>;
let create: ReturnType<typeof vi.fn<(props: Record<string, unknown>) => Promise<Tab>>>;
let inject: ReturnType<typeof vi.fn>;
function tab(id: number, patch: Partial<Tab> = {}): Tab {
  return { id, url: `https://${DEV}/now/nav`, windowId: 1, ready: true, token: `doc-${id}`, status: "complete", ...patch };
}
function answer(id: number, msg: any, response: Record<string, any> = {}) {
  const t = tabs.find(t => t.id === id)!;
  sn.handleResponse({ requestId: msg.request.requestId, documentToken: t.token, data: { result: [] }, error: null, ...response },
    { tab: { id } as chrome.tabs.Tab, frameId: 0, url: t.url });
}
beforeEach(() => {
  vi.useFakeTimers();
  tabs = [tab(1)]; attempts = [];
  sn = new SnBridge(); sn.setPreferredHost(DEV, true);
  chromeStub.tabs.query = async (q?: any) => tabs.filter(t => !q?.url || q.url.includes("*.") || t.url.startsWith(q.url.replace(/\*$/, "")));
  chromeStub.tabs.get = vi.fn(async (id?: number) => { const t = tabs.find(t => t.id === id); if (!t) throw new Error("closed"); return t; }) as any;
  Object.assign(chrome.windows, { getLastFocused: vi.fn(async () => ({ id: 1 })) });
  create = vi.fn(async (props: any) => { const t = tab(99, { ...props, status: "loading" }); tabs.push(t); return t; });
  chromeStub.tabs.create = create;
  inject = vi.fn(async () => []);
  Object.assign(chrome, { scripting: { executeScript: inject } });
  perform = async (id, msg) => { answer(id, msg); return { sent: true }; };
  chromeStub.tabs.sendMessage = vi.fn(async (id: number, message: any) => {
    const t = tabs.find(t => t.id === id);
    if (!t) throw new Error("Could not establish connection. Receiving end does not exist.");
    if (message.action === "bridgeHealth") {
      if (t.ready === false) throw new Error("Could not establish connection. Receiving end does not exist.");
      return { version: t.version ?? 1, ready: true, hostname: new URL(t.url).hostname, documentToken: t.token };
    }
    if (message.action === "bridgePing") {
      if (t.ready === false) throw new Error("Could not establish connection. Receiving end does not exist.");
      return { version: t.version ?? 1, hostname: new URL(t.url).hostname, documentToken: t.token };
    }
    // Like the real content script: a request addressed to another document
    // is refused, and the page never sees it.
    if (message.request?.expectedDocumentToken !== t.token) return { sent: false };
    attempts.push({ tabId: id, message });
    return perform(id, message);
  }) as any;
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); });
/** Let retries' backoff and liveness timers run while awaiting a result. */
async function settle<T>(promise: Promise<T>): Promise<T> {
  let done = false;
  void promise.then(() => { done = true; }, () => { done = true; });
  for (let i = 0; i < 800 && !done; i++) await vi.advanceTimersByTimeAsync(50);
  return promise;
}

describe("verified tab selection", () => {
  it("rejects another instance even when Auto previously allowed fallback", async () => {
    sn.setPreferredHost(DEV, false); tabs = [tab(7, { url: `https://${PROD}/now/nav` })];
    expect(await sn.bindTab()).toBeNull(); expect(create).not.toHaveBeenCalled();
  });
  it("skips XML, WSDL, discarded and frozen tabs", async () => {
    tabs = [tab(2, { url: `https://${DEV}/x.do?XML`, active: true }), tab(3, { url: `https://${DEV}/x.do?x=1&WSDL` }), tab(4, { discarded: true }), tab(5, { frozen: true }), tab(1)];
    expect(await sn.bindTab()).toBe(1);
    expect(vi.mocked(chrome.tabs.sendMessage).mock.calls.map(c => c[0])).toEqual([1]);
  });
  it("prefers the focused window over a more recent active tab elsewhere", async () => {
    tabs = [tab(2, { windowId: 2, active: true, lastAccessed: 200 }), tab(1, { lastAccessed: 100 })];
    expect(await sn.bindTab()).toBe(1);
  });
  it("skips an unavailable tab, reinjects once, and uses another healthy tab", async () => {
    tabs = [tab(2, { ready: false, lastAccessed: 200 }), tab(1)];
    expect(await sn.bindTab()).toBe(1);
    expect(inject).toHaveBeenCalledTimes(1);
    expect(await sn.bindTab()).toBe(1);
    expect(inject).toHaveBeenCalledTimes(1);
  });
  it("never treats an old helper or acknowledgment alone as ready", async () => {
    tabs = [tab(1, { version: 0 })];
    expect(await sn.bindTab()).toBeNull();
  });
  it("retains a healthy binding when tabs, focus or selected instance change during a turn", async () => {
    tabs.push(tab(2, { url: `https://${PROD}/now/nav` }));
    await sn.beginTurn(DEV);
    sn.setPreferredHost(PROD, true);
    tabs[0].active = false; tabs[1].active = true;
    await sn.query({ table: "wf_activity" });
    expect(attempts.map(a => a.tabId)).toEqual([1]);
    expect(sn.getPreferredHost()).toBe(DEV);
    sn.endTurn(); expect(sn.getPreferredHost()).toBe(PROD);
  });
  it("shares concurrent readiness probes", async () => {
    await Promise.all([sn.bindTab(), sn.bindTab(), sn.bindTab()]);
    expect(chrome.tabs.sendMessage).toHaveBeenCalledTimes(1);
  });
  it("bounds a hung health probe and uses the working candidate", async () => {
    tabs = [tab(2, { lastAccessed: 200 }), tab(1)];
    const send = vi.mocked(chrome.tabs.sendMessage).getMockImplementation()!;
    vi.mocked(chrome.tabs.sendMessage).mockImplementation(((id: number, msg: any, opts: any) => id === 2 ? new Promise(() => {}) : (send as any)(id, msg, opts)) as any);
    const pending = sn.bindTab();
    await vi.advanceTimersByTimeAsync(2000);
    expect(await pending).toBe(1);
  });
});

describe("recovery and request safety", () => {
  it("retries a read once with a new id after a transport failure", async () => {
    let first: any;
    perform = async (id, msg) => {
      if (!first) { first = msg; throw new Error("missing receiver"); }
      answer(id, first, { data: { result: ["stale"] } });
      answer(id, msg, { data: { result: ["fresh"] } }); return { sent: true };
    };
    const r = await settle(sn.query({ table: "wf_activity" }));
    expect(r.data.result).toEqual(["fresh"]);
    expect(attempts).toHaveLength(2);
    expect(attempts[0].message.request.requestId).not.toBe(attempts[1].message.request.requestId);
  });
  it("does not replay writes after a missing acknowledgment", async () => {
    perform = async () => { throw new Error("connection lost"); };
    const r = await sn.update("incident", REC, { short_description: "test" });
    expect(r.outcome).toBe("unknown"); expect(r.error).toContain("Verify the record"); expect(attempts).toHaveLength(1);
  });
  it("bounds a write with a hung acknowledgment and does not replay it", async () => {
    perform = async () => new Promise(() => {});
    const pending = sn.rest("/api/now/table/incident", "POST", {}, 3000);
    await vi.advanceTimersByTimeAsync(3000);
    expect((await pending).outcome).toBe("unknown"); expect(attempts).toHaveLength(1);
  });
  it("ignores responses from another tab or document", async () => {
    perform = async (id, msg) => {
      sn.handleResponse({ requestId: msg.request.requestId, documentToken: "wrong", data: { result: ["wrong"] } }, { tab: { id } as chrome.tabs.Tab, frameId: 0, url: tabs[0].url });
      answer(id, msg, { data: { result: ["right"] } }); return { sent: true };
    };
    expect((await sn.query({ table: "x" })).data.result).toEqual(["right"]);
  });
  it("waits for navigation and retries a read on the fresh document", async () => {
    let first = true;
    perform = async (id, msg) => {
      if (first) {
        first = false; sn.invalidateTab(id); tabs[0].token = "new-document";
        return { sent: true };
      }
      answer(id, msg); return { sent: true };
    };
    expect((await settle(sn.query({ table: "x" }))).error).toBeNull(); expect(attempts).toHaveLength(2);
  });
  it("never relocates a form operation when its original document disappears", async () => {
    await sn.bindTab(); tabs[0].token = "new-document"; tabs.push(tab(2));
    const r = await settle(sn.formFillGeneric("x", "id", "field", "value"));
    expect(r.error).toBeTruthy(); expect(attempts).toHaveLength(0); expect(create).not.toHaveBeenCalled();
  });
  it("opens a single background recovery tab and continues a read", async () => {
    tabs = [];
    const pending = sn.query({ table: "x" });
    await vi.advanceTimersByTimeAsync(300);
    const result = await pending;
    expect(result.error).toBeNull();
    expect(create).toHaveBeenCalledExactlyOnceWith({ url: `https://${DEV}/`, active: false });
    expect(attempts[0].tabId).toBe(99);
  });
  it("does not keep opening recovery tabs after failures or worker recreation", async () => {
    tabs = [];
    create.mockImplementation(async (props: any) => { const t = tab(99, { ...props, ready: false }); tabs.push(t); return t; });
    const first = sn.query({ table: "x" }); await vi.advanceTimersByTimeAsync(8000); expect((await first).error).toBeTruthy();
    sn = new SnBridge(); sn.setPreferredHost(DEV, true);
    const second = sn.query({ table: "x" }); await vi.advanceTimersByTimeAsync(8000); await second;
    expect(create).toHaveBeenCalledTimes(1);
  });
  it.each([[401, "authentication"], [403, "access_denied"], [500, "http"]])("distinguishes HTTP %s without retrying", async (status, kind) => {
    perform = async (id, msg) => { answer(id, msg, { status, data: { error: { message: "denied" } } }); return { sent: true }; };
    const r = await settle(sn.query({ table: "x" })); expect(r.failure).toBe(kind); expect(attempts).toHaveLength(1);
    if (status === 401) expect(sn.getConnection().phase).toBe("sign_in_required");
  });
  it("classifies non-JSON login responses and network failures separately", async () => {
    perform = async (id, msg) => { answer(id, msg, { status: 200, data: { _parseError: true } }); return { sent: true }; };
    expect((await settle(sn.query({ table: "x" }))).failure).toBe("authentication");
    perform = async (id, msg) => { answer(id, msg, { error: "Failed to fetch" }); return { sent: true }; };
    expect((await settle(sn.query({ table: "x" }))).failure).toBe("network");
  });
  it("keeps diagnostics bounded and excludes record data and URL queries", async () => {
    tabs[0].url += "?sysparm_query=secret";
    for (let i = 0; i < 60; i++) await sn.query({ table: "sensitive", query: "secret", fields: "token" });
    const log = JSON.stringify(sn.getDiagnostics());
    expect(sn.getDiagnostics().length).toBeLessThanOrEqual(100);
    expect(log).not.toMatch(/secret|sensitive|token|sysparm_query/);
  });
});


it("blocks a repeated uncertain write within the same turn", async () => {
  await sn.beginTurn(DEV);
  perform = async () => { throw new Error("lost"); };
  await sn.update("incident", REC, { active: false });
  const repeated = await sn.update("incident", REC, { active: false });
  expect(repeated.outcome).toBe("unknown");
  expect(repeated.error).toContain("start a new turn");
  expect(attempts).toHaveLength(1);
});
it("shares a single background recovery tab across concurrent requests", async () => {
  tabs = [];
  const pending = Promise.all([sn.query({ table: "x" }), sn.query({ table: "y" }), sn.query({ table: "z" })]);
  await vi.advanceTimersByTimeAsync(300);
  expect((await pending).every(r => !r.error)).toBe(true);
  expect(create).toHaveBeenCalledTimes(1);
});
it("recovers on the same instance after a tab closes mid-read", async () => {
  tabs = [tab(1), tab(2), tab(3, { url: `https://${PROD}/now/nav` })];
  let first = true;
  perform = async (id, msg) => {
    if (first) { first = false; tabs = tabs.filter(t => t.id !== id); sn.invalidateTab(id, true); return { sent: true }; }
    answer(id, msg); return { sent: true };
  };
  expect((await settle(sn.query({ table: "x" }))).error).toBeNull();
  expect(attempts.map(a => a.tabId)).toEqual([1, 2]);
});
it("rejects a form request after navigation even when it shares a health check", async () => {
  await sn.bindTab();
  const start = sn.formFillGeneric("x", "id", "field", "value");
  sn.invalidateTab(1);
  tabs[0].token = "fresh";
  await sn.checkHealth();
  expect((await settle(start)).error).toBeTruthy();
  expect(attempts).toHaveLength(0);
});
it("keeps background lookups from crossing onto a newly selected instance", async () => {
  const background = sn.forHost(DEV);
  sn.setPreferredHost(PROD);
  expect((await background.query({ table: "x" })).error).toContain("cancelled");
  expect(attempts).toHaveLength(0);
});
it("retains the original request deadline while waiting for page readiness", async () => {
  tabs = [];
  create.mockImplementation(async (props: any) => { const t = tab(99, { ...props, ready: false }); tabs.push(t); return t; });
  const pending = sn.rest("/api/now/table/x", "GET", undefined, 1000);
  await vi.advanceTimersByTimeAsync(1000);
  expect((await pending).error).toBeTruthy();
  expect(attempts).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(8000);
  expect(attempts).toHaveLength(0);
});
