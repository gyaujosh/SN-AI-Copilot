// In-memory Chrome API fake, reset between tests.

import { beforeEach } from "vitest";

type StoreArea = {
  data: Map<string, unknown>;
  get: (keys?: string | string[] | Record<string, unknown> | null, callback?: (value: Record<string, unknown>) => void) => Promise<Record<string, unknown>>;
  set: (items: Record<string, unknown>) => Promise<void>;
  remove: (keys: string | string[]) => Promise<void>;
};

function makeArea(): StoreArea {
  const data = new Map<string, unknown>();
  return {
    data,
    async get(keys, callback) {
      const out: Record<string, unknown> = {};
      if (keys == null) {
        for (const [k, v] of data) out[k] = v;
      } else if (typeof keys === "string") {
        if (data.has(keys)) out[keys] = data.get(keys);
      } else if (Array.isArray(keys)) {
        for (const k of keys) if (data.has(k)) out[k] = data.get(k);
      } else {
        for (const [k, dflt] of Object.entries(keys)) out[k] = data.has(k) ? data.get(k) : dflt;
      }
      callback?.(out);
      return out;
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) data.set(k, v);
    },
    async remove(keys) {
      for (const k of Array.isArray(keys) ? keys : [keys]) data.delete(k);
    },
  };
}

export const chromeStub = {
  storage: { local: makeArea(), session: makeArea() },
  tabs: {
    query: async () => [] as unknown[],
    get: async () => { throw new Error("no such tab"); },
    create: async (props: Record<string, unknown>) => ({ id: 1, ...props }),
    update: async (tabId: number, props: Record<string, unknown>) => ({ id: tabId, windowId: 1, ...props }),
    remove: async () => {},
    sendMessage: async () => { throw new Error("no receiver"); },
    onUpdated: { addListener: () => {}, removeListener: () => {} },
    onRemoved: { addListener: () => {}, removeListener: () => {} },
    onActivated: { addListener: () => {}, removeListener: () => {} },
  },
  windows: {
    WINDOW_ID_NONE: -1,
    update: async () => ({}),
    getLastFocused: async () => ({ id: 1 }),
    onFocusChanged: { addListener: () => {}, removeListener: () => {} },
  },
  runtime: {
    id: "test-extension-id",
    getPlatformInfo: async () => ({ os: "mac" }),
    onConnect: { addListener: () => {} },
    onMessage: { addListener: () => {} },
    onInstalled: { addListener: () => {} },
    onStartup: { addListener: () => {} },
  },
  alarms: {
    create: () => {},
    clear: async () => true,
    onAlarm: { addListener: () => {} },
  },
  sidePanel: { setPanelBehavior: async () => {} },
  action: { onClicked: { addListener: () => {} } },
};

(globalThis as Record<string, unknown>).chrome = chromeStub;

beforeEach(() => {
  chromeStub.storage.local.data.clear();
  chromeStub.storage.session.data.clear();
  chromeStub.tabs.query = async () => [];
});
