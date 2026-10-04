import { EMPTY_COST, NO_MODELS, type FeedItem, type PublicSettings, type SnInstance } from "../../src/shared/types";
import type { AgentApi } from "../../src/sidepanel/hooks/useAgent";

/** Placeholder hosts — no real instance is ever contacted by the tests. */
export const DEV_HOST = "exampledev.service-now.com";
export const TEST_HOST = "exampletest.service-now.com";
export const PROD_HOST = "example.service-now.com";
/** A synthetic record id. */
export const SYS_ID = "0123456789abcdef0123456789abcdef";

export const INSTANCES: SnInstance[] = [
  { id: "dev", label: "Dev", host: DEV_HOST, role: "dev" },
  { id: "test", label: "Test", host: TEST_HOST, role: "test" },
  { id: "prod", label: "Prod", host: PROD_HOST, role: "prod" },
];

export function publicSettings(overrides: Partial<PublicSettings> = {}): PublicSettings {
  return {
    provider: "anthropic",
    models: { ...NO_MODELS, anthropic: "claude-sonnet-5" },
    efforts: {},
    keysPresent: { anthropic: true, openai: false, openrouter: false },
    instances: INSTANCES,
    activeInstanceId: "dev",
    pinnedInstanceId: null,
    ...overrides,
  };
}

/** A research exchange: question, compact trace, prose with a table and code. */
export const chatFeed: FeedItem[] = [
  { id: "u1", kind: "user", text: "Find high-priority incidents assigned to Service Desk.", at: 1788602400000 },
  {
    id: "t1", kind: "tools", tools: [
      { id: "c1", name: "get_table_schema", label: "Read incident schema", status: "ok", summary: "31 fields" },
      { id: "c2", name: "query_records", label: "Query incident", detail: "active=true^priority<=2^assignment_group.name=Service Desk", status: "ok", summary: "3 records" },
    ],
  },
  {
    id: "a1", kind: "assistant",
    text: "**Found 3 active incidents assigned to Service Desk.**\n\n| Number | Priority | State |\n| --- | --- | --- |\n| INC0010001 | 1 – Critical | In progress |\n| INC0010002 | 2 – High | New |\n| INC0010003 | 2 – High |  |\n\n`INC0010001` is critical and has no assignee. The business rule that routes it runs before insert:\n\n```javascript\nif (current.assignment_group.nil()) {\n  current.assignment_group = serviceDeskId;\n}\n```\nWould you like me to check its assignment rules?",
  },
];

export function fakeAgent(overrides: Partial<AgentApi> = {}): AgentApi {
  const noop = () => {};
  return {
    feed: [], running: false, run: null, connected: true, catalog: null,
    connection: { phase: "ready", host: DEV_HOST, checkedAt: Date.now() },
    viewedHost: DEV_HOST,
    ctx: {
      hostname: DEV_HOST, instance: "exampledev", table: "incident", isForm: true,
      sysId: SYS_ID, values: { number: "INC0010001" }, tabId: 11,
      url: `https://${DEV_HOST}/incident.do?sys_id=${SYS_ID}`, updatedAt: Date.now(),
    },
    settings: publicSettings(), cost: { ...EMPTY_COST }, modelLists: {}, sessions: [], sessionDetail: null,
    clearSessionDetail: noop, sendChat: noop, resume: noop, approve: noop, stop: noop, clear: noop,
    clearCatalog: noop, refreshContext: noop, patchSettings: noop, switchInstance: noop,
    listModels: noop, listSessions: noop, getSession: noop, deleteSession: noop, openHostTab: noop,
    ...overrides,
  };
}
