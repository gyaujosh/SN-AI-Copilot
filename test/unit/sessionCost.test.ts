// A session's spend: every model call adds to it, including one cut off by
// Stop or a dropped connection (the provider still bills it); it survives a
// worker restart; a new chat starts it again at zero and saves what the
// finished chat cost with it in History.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionCost } from "../../src/shared/types";

const { complete, script } = vi.hoisted(() => {
  const script: Array<(params: any) => any> = [];
  const complete = vi.fn(async (_key: string, params: any) => {
    const step = script.shift();
    if (!step) throw new Error("no scripted response");
    return step(params);
  });
  return { complete, script };
});
vi.mock("../../src/background/providers", async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, getAdapter: () => ({ id: "openrouter", complete }) };
});

import { AgentSession } from "../../src/background/agent";
import { withPartialUsage } from "../../src/background/providers/types";
import { DEV_HOST, INSTANCES } from "../fixtures/chat";

const DEV = DEV_HOST;
/** A reply whose cost OpenRouter reports, so totals are exact. */
const reply = (text: string, costUsd: number, tokens = { in: 1000, out: 200, cached: 0 }, toolCalls: any[] = []) => () => ({
  text, toolCalls, stopReason: toolCalls.length ? "tool_use" : "end_turn", raw: { provider: "openrouter", content: null },
  usage: { inputTokens: tokens.in, outputTokens: tokens.out, cacheReadTokens: tokens.cached, cacheWriteTokens: 0, costUsd },
});
const ok = (result: any = [{ number: "INC0010001" }]) => ({ data: { result }, error: null });

function fakeBridge() {
  let host: string | null = null;
  return {
    getPreferredHost: vi.fn(() => DEV),
    beginTurn: vi.fn(async (h: string | null) => { host = h; return 1; }),
    endTurn: vi.fn(),
    getBoundTabHost: vi.fn(async () => host),
    requestContextRefresh: vi.fn(async () => {}),
    query: vi.fn(async () => ok()),
    getRecord: vi.fn(async () => ok({})),
    count: vi.fn(async () => ({ data: { result: { stats: { count: "3" } } }, error: null })),
    update: vi.fn(async () => ok({})),
    createRaw: vi.fn(async () => ok({ sys_id: "f".repeat(32) })),
    remove: vi.fn(async () => ok({})),
    rest: vi.fn(async () => ok()),
  };
}
const ctx = { hostname: DEV, instance: "exampledev", url: `https://${DEV}/incident.do`, table: "incident", tabId: 7 };
function newSession(events: any[] = []) {
  const session = new AgentSession(fakeBridge() as any, () => ctx, () => ctx);
  session.setEmitter((event) => events.push(event));
  return session;
}

beforeEach(async () => {
  vi.useFakeTimers();
  script.length = 0;
  complete.mockClear();
  await chrome.storage.local.set({
    provider: "openrouter", providerKeys: { openrouter: "k" }, providerModels: { openrouter: "vendor/test-model" },
    snInstances: INSTANCES, activeInstanceId: "dev",
  });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

async function finish(promise: Promise<unknown>) {
  let done = false;
  void promise.then(() => { done = true; });
  for (let i = 0; i < 400 && !done; i++) await vi.advanceTimersByTimeAsync(100);
  await promise;
}

describe("session spend", () => {
  it("adds up every model call, with the latest answer's share on its own", async () => {
    const events: any[] = [];
    const session = newSession(events);
    script.push(
      reply("Checking.", 0.01, { in: 1000, out: 100, cached: 0 }, [{ id: "call_q", name: "query_records", input: { table: "incident" } }]),
      reply("Found 1 incident.", 0.02, { in: 1200, out: 300, cached: 800 }),
    );
    await finish(session.sendChat("Find incidents"));
    expect(session.cost).toMatchObject({ usd: 0.03, turnUsd: 0.03, inputTokens: 2200, outputTokens: 400, cacheReadTokens: 800, requests: 2, reportedRequests: 2, estimatedRequests: 0 });

    script.push(reply("Sure.", 0.005));
    await finish(session.sendChat("Thanks"));
    expect(session.cost.usd).toBeCloseTo(0.035);
    expect(session.cost.turnUsd).toBeCloseTo(0.005);
    expect(session.cost.requests).toBe(3);
    // The panel hears each change as it happens, and the answer's share resets as it starts.
    const turns = events.filter((e) => e.type === "cost").map((e) => +e.cost.turnUsd.toFixed(3));
    expect(turns).toEqual([0, 0.01, 0.03, 0, 0.005]);
  });

  it("counts an answer stopped mid-stream, since the provider bills what it produced", async () => {
    const session = newSession();
    script.push((params: any) => new Promise((_, reject) => {
      params.onTextDelta("Looking into");
      params.signal.addEventListener("abort", () => reject(withPartialUsage(
        new DOMException("aborted", "AbortError"),
        { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0, approximate: true },
      )), { once: true });
    }));
    const run = session.sendChat("Explain this record");
    await vi.waitFor(() => expect(complete).toHaveBeenCalledTimes(1));
    session.stop();
    await finish(run);
    expect(session.publicRun()?.status).toBe("stopped");
    // vendor/test-model isn't in the price list: priced high on purpose, flagged as an estimate.
    expect(session.cost).toMatchObject({ requests: 1, estimatedRequests: 1, inputTokens: 1000, outputTokens: 200 });
    expect(session.cost.usd).toBeGreaterThan(0);
    expect(((await chrome.storage.local.get("copilotCost")).copilotCost as SessionCost).usd).toBe(session.cost.usd);
  });

  it("counts an answer cut off by a failure, and nothing for a call that never started", async () => {
    const session = newSession();
    script.push(() => { throw withPartialUsage(new Error("The provider stopped sending data."), { inputTokens: 500, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.004 }); });
    await finish(session.sendChat("First"));
    expect(session.cost).toMatchObject({ usd: 0.004, requests: 1 });

    script.push(() => { throw Object.assign(new Error("OpenRouter API error 401: bad key"), { status: 401 }); });
    await finish(session.sendChat("Second"));
    expect(session.cost).toMatchObject({ usd: 0.004, requests: 1 });
  });

  it("survives a worker restart", async () => {
    const first = newSession();
    script.push(reply("Hello.", 0.012));
    await finish(first.sendChat("Hi"));
    const restarted = newSession();
    await restarted.ready();
    expect(restarted.cost).toMatchObject({ usd: 0.012, requests: 1, reportedRequests: 1 });
  });

  it("starts again at zero with a new chat, saving the finished chat's cost with it in History", async () => {
    const events: any[] = [];
    const session = newSession(events);
    script.push(reply("Found it.", 0.0421, { in: 14_210, out: 1_830, cached: 22_400 }));
    await finish(session.sendChat("Find the incident"));
    await session.clear();
    expect(session.cost).toMatchObject({ usd: 0, turnUsd: 0, inputTokens: 0, requests: 0 });
    expect(events.filter((e) => e.type === "cost").at(-1).cost.usd).toBe(0);

    await vi.waitFor(async () => expect((await chrome.storage.local.get("copilotSessions")).copilotSessions).toHaveLength(1));
    const [saved] = (await chrome.storage.local.get("copilotSessions")).copilotSessions as any[];
    expect(saved.title).toBe("Find the incident");
    expect(saved.usd).toBe(0.0421);
    expect(saved.cost).toEqual({ usd: 0.0421, inputTokens: 14_210, outputTokens: 1_830, cacheReadTokens: 22_400, requests: 1, estimatedRequests: 0, reportedRequests: 1 });
  });
});
