// Isolated-world receiver. Health checks make a round trip through the page
// helper; receiving a Chrome message alone never means the relay is ready.
import { BRIDGE_VERSION } from "../shared/connection";

(function () {
  const runtime = chrome.runtime;
  const extId = runtime.id;
  const guardKey = `__snaiContent_${extId}`;
  const scope = window as unknown as Record<string, any>;
  const previous = scope[guardKey];
  try { if (previous?.version === BRIDGE_VERSION && previous.runtime?.id === extId) return; } catch { /* invalidated extension */ }
  previous?.dispose?.();
  const documentToken = crypto.randomUUID();
  let injected = false;
  let injecting: Promise<boolean> | null = null;
  let lastContext: any = null;
  const listeners: Array<[string, EventListener]> = [];
  const healthChecks = new Map<string, (detail: any) => void>();

  function listen(name: string, fn: EventListener) { document.addEventListener(name, fn); listeners.push([name, fn]); }
  function toPage(name: string, detail: Record<string, any> = {}) {
    document.dispatchEvent(new CustomEvent(name, { detail: { ...detail, extId } }));
  }
  function ours(detail: any) { return detail?.extId === extId; }
  function toBackground(message: Record<string, any>) {
    try { void runtime.sendMessage(message).catch(() => {}); } catch { /* extension updated */ }
  }
  function requestContext() { toPage("snai2-context-request"); }
  function checkInstance(): Promise<boolean | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 500);
      try {
        runtime.sendMessage({ action: "checkInstance", origin: location.origin }, (response) => {
          clearTimeout(timer);
          resolve(runtime.lastError ? null : response?.isInstance === true);
        });
      } catch { clearTimeout(timer); resolve(null); }
    });
  }
  function injectPageScript(): Promise<boolean> {
    if (injected) return Promise.resolve(true);
    if (injecting) return injecting;
    injecting = new Promise<boolean>((resolve) => {
      const script = document.createElement("script");
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        script.onload = script.onerror = null;
        script.remove();
        injected = ok;
        resolve(ok);
      };
      const timer = setTimeout(() => finish(false), 600);
      script.src = runtime.getURL("inject.js");
      script.dataset.snaiExt = extId;
      script.onload = () => { finish(true); requestContext(); };
      script.onerror = () => finish(false);
      (document.head || document.documentElement).appendChild(script);
    }).finally(() => { injecting = null; });
    return injecting;
  }
  async function health() {
    const base = { version: BRIDGE_VERSION, hostname: location.hostname, documentToken, ready: false };
    const instance = await checkInstance();
    if (instance === false) return { ...base, reason: "authentication" };
    if (instance === null || !await injectPageScript()) return base;
    const nonce = crypto.randomUUID();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        healthChecks.delete(nonce);
        resolve({ ...base, reason: "incompatible" });
      }, 600);
      healthChecks.set(nonce, (detail) => {
        clearTimeout(timer);
        healthChecks.delete(nonce);
        resolve({ ...base, ready: detail.version === BRIDGE_VERSION,
          ...(detail.version !== BRIDGE_VERSION ? { reason: "incompatible" } : {}) });
      });
      toPage("snai2-health-request", { nonce, version: BRIDGE_VERSION });
    });
  }
  listen("snai2-health-response", (e) => {
    const detail = (e as CustomEvent).detail;
    if (ours(detail)) healthChecks.get(detail.nonce)?.(detail);
  });
  listen("snai2-context-response", (e) => {
    const detail = (e as CustomEvent).detail;
    if (!ours(detail)) return;
    lastContext = detail.context;
    toBackground({ action: "contextUpdate", context: lastContext, documentToken });
  });
  for (const [event, action] of [["snai2-api-response", "apiResponse"], ["snai2-glideajax-response", "glideAjaxResponse"]]) {
    listen(event, (e) => {
      const detail = (e as CustomEvent).detail;
      if (ours(detail)) toBackground({ action, response: { ...detail, documentToken } });
    });
  }
  const actions: Record<string, string> = {
    apiCall: "snai2-api-request", formFillCatalogVariable: "snai2-form-fill",
    formFillGeneric: "snai2-form-fill-generic", glideAjaxCreate: "snai2-glideajax-create",
  };
  const onMessage = (request: any, _sender: chrome.runtime.MessageSender, sendResponse: (r: any) => void) => {
    // Which document is answering — nothing else. In-page navigation (History
    // API, hash, iframe loads) keeps this token; only a new document changes it.
    if (request.action === "bridgePing") {
      sendResponse({ version: BRIDGE_VERSION, documentToken, hostname: location.hostname });
      return false;
    }
    if (request.action === "bridgeHealth") {
      void health().then(sendResponse).catch(() => sendResponse({ ready: false, version: BRIDGE_VERSION, documentToken, hostname: location.hostname }));
      return true;
    }
    if (request.action === "getContext") {
      requestContext(); sendResponse({ context: lastContext }); return false;
    }
    if (request.action === "refreshContext") { requestContext(); sendResponse({ refreshing: true }); return false; }
    if (actions[request.action]) {
      if (request.request?.expectedDocumentToken !== documentToken || request.request?.expectedHost !== location.hostname || !injected) {
        sendResponse({ sent: false }); return false;
      }
      toPage(actions[request.action], request.request);
      sendResponse({ sent: true });
    }
    return false;
  };
  runtime.onMessage.addListener(onMessage);
  listen("visibilitychange", () => { if (!document.hidden) void health(); });
  // The document is going away (navigation, reload, close, back/forward
  // cache): requests addressed to it will never be answered.
  const onPageHide = () => toBackground({ action: "bridgeUnload", documentToken });
  window.addEventListener("pagehide", onPageHide);
  scope[guardKey] = { version: BRIDGE_VERSION, runtime, dispose: () => {
    for (const [name, fn] of listeners) document.removeEventListener(name, fn);
    window.removeEventListener("pagehide", onPageHide);
    try { runtime.onMessage.removeListener(onMessage); } catch { /* stale runtime */ }
  } };
  void health();
})();
export {};
