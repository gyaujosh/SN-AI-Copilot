import { afterEach, beforeEach, expect, it, vi } from "vitest";

let receiver: (request: any, sender: any, respond: (response: any) => void) => boolean;
let cookie: boolean;
let helperVersion: number | null;
let failLoad: boolean;
let loads: number;
let onHealth: EventListener;
const key = "__snaiContent_test-extension-id";
const scope = window as unknown as Record<string, any>;
beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers();
  cookie = true; helperVersion = 1; failLoad = false; loads = 0;
  scope[key]?.dispose(); delete scope[key];
  const runtime = {
    id: "test-extension-id", lastError: undefined,
    getURL: (path: string) => `chrome-extension://test-extension-id/${path}`,
    sendMessage: vi.fn((message: any, callback?: (response: any) => void) => {
      if (message.action === "checkInstance") callback?.({ isInstance: cookie });
      return Promise.resolve();
    }),
    onMessage: { addListener: vi.fn((fn: typeof receiver) => { receiver = fn; }), removeListener: vi.fn() },
  };
  vi.stubGlobal("chrome", { runtime });
  const append = document.head.appendChild.bind(document.head);
  vi.spyOn(document.head, "appendChild").mockImplementation((node) => {
    const result = append(node);
    if (node instanceof HTMLScriptElement) {
      loads++;
      Promise.resolve().then(() => node.dispatchEvent(new Event(failLoad ? "error" : "load")));
    }
    return result;
  });
  onHealth = (event) => {
    if (helperVersion === null) return;
    const detail = (event as CustomEvent).detail;
    document.dispatchEvent(new CustomEvent("snai2-health-response", { detail: { extId: detail.extId, nonce: detail.nonce, version: helperVersion } }));
  };
  document.addEventListener("snai2-health-request", onHealth);
});
afterEach(() => {
  scope[key]?.dispose(); delete scope[key];
  document.removeEventListener("snai2-health-request", onHealth);
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
async function load() { await import("../../src/content/content_script"); await vi.advanceTimersByTimeAsync(0); }
function health(): Promise<any> { return new Promise(resolve => receiver({ action: "bridgeHealth", version: 1 }, {}, resolve)); }
it("requires a page-helper round trip and accepts only the checked document", async () => {
  await load(); const ready = await health();
  expect(ready).toMatchObject({ ready: true, version: 1, hostname: location.hostname });
  expect(ready.documentToken).toBeTruthy();
  const page = vi.fn(); document.addEventListener("snai2-api-request", page);
  const answer = vi.fn();
  receiver({ action: "apiCall", request: { expectedDocumentToken: "old", expectedHost: location.hostname } }, {}, answer);
  expect(answer).toHaveBeenLastCalledWith({ sent: false }); expect(page).not.toHaveBeenCalled();
  receiver({ action: "apiCall", request: { expectedDocumentToken: ready.documentToken, expectedHost: location.hostname } }, {}, answer);
  expect(answer).toHaveBeenLastCalledWith({ sent: true }); expect(page).toHaveBeenCalledOnce();
  document.removeEventListener("snai2-api-request", page);
  expect(vi.getTimerCount()).toBe(0);
});
it("rechecks the cookie after login without requiring a fresh receiver", async () => {
  cookie = false; await load(); expect((await health()).reason).toBe("authentication"); expect(loads).toBe(0);
  cookie = true; expect((await health()).ready).toBe(true); expect(loads).toBe(1);
});
it("retries a failed page-script load instead of leaving initialization stuck", async () => {
  failLoad = true; await load(); expect(loads).toBe(1);
  failLoad = false; expect((await health()).ready).toBe(true); expect(loads).toBe(2);
});
it("reports incompatible helpers and never accepts a receiver-only acknowledgment", async () => {
  helperVersion = null; await load(); await vi.advanceTimersByTimeAsync(600);
  const check = health(); await vi.advanceTimersByTimeAsync(600);
  expect(await check).toMatchObject({ ready: false, reason: "incompatible" });
  expect(loads).toBe(1);
});
it("guarded reinjection does not install a second receiver or page helper", async () => {
  await load(); const token = (await health()).documentToken;
  vi.resetModules(); await load();
  expect(chrome.runtime.onMessage.addListener).toHaveBeenCalledTimes(1);
  expect(loads).toBe(1); expect((await health()).documentToken).toBe(token);
});
it("does not claim messages intended for the parent-frame receiver", async () => {
  await load(); const respond = vi.fn();
  expect(receiver({ action: "getSelection" }, {}, respond)).toBe(false);
  expect(respond).not.toHaveBeenCalled();
});
