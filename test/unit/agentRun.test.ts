// A run's lifetime: it survives without a viewer, is reported truthfully when
// the worker restarts under it, resumes only from a safe checkpoint on the
// instance it started on, and never turns Stop, silence or a lost answer into
// an approval or a repeated write.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FeedItem } from "../../src/shared/types";

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
import { patchSettings } from "../../src/background/settings";
import { HELPER_SCRIPT } from "../../src/background/snCatalog";
import { DEV_HOST, INSTANCES, PROD_HOST, TEST_HOST } from "../fixtures/chat";

const DEV = DEV_HOST;
const reply = (text: string, toolCalls: any[] = []) => () => ({
  text, toolCalls, stopReason: toolCalls.length ? "tool_use" : "end_turn", raw: { provider: "openrouter", content: null },
});
const call = (name: string, input: any, id = `call_${name}_${Math.random().toString(36).slice(2, 7)}`) => ({ id, name, input });
const hang = () => new Promise<never>(() => {});
const ok = (result: any = [{ number: "INC0010001" }]) => ({ data: { result }, error: null });

function fakeBridge(overrides: Record<string, any> = {}) {
  let host: string | null = null;
  return {
    // The selection mirrored by the real bridge when the command arrives.
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
    glideAjaxCreate: vi.fn(async () => ({ sys_id: "a".repeat(32), error: null })),
    formFillCatalogVariable: vi.fn(async () => ({})),
    ...overrides,
  };
}
const ctx = { hostname: DEV, instance: "exampledev", url: `https://${DEV}/incident.do`, table: "incident", tabId: 7 };
function newSession(bridge: any, events: any[] = []) {
  const session = new AgentSession(bridge, () => ctx, () => ctx);
  session.setEmitter((event) => events.push(event));
  return session;
}
const notices = (feed: FeedItem[]) => feed.filter((f): f is Extract<FeedItem, { kind: "notice" }> => f.kind === "notice" && f.tone === "warning");
const chips = (feed: FeedItem[]) => feed.flatMap((f) => (f.kind === "tools" ? f.tools : []));
const lastHistory = (params: any) => params.history[params.history.length - 1];

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

/** Drive the run's timers (context settle delay, keepalive) until it ends. */
async function finish(promise: Promise<unknown>) {
  let done = false;
  void promise.then(() => { done = true; });
  for (let i = 0; i < 400 && !done; i++) await vi.advanceTimersByTimeAsync(100);
  await promise;
}

describe("a run without a viewer", () => {
  it("completes and leaves its checkpoints and final status in storage", async () => {
    script.push(reply("Checking.", [call("query_records", { table: "incident" })]), reply("Found 1 incident."));
    const session = newSession(fakeBridge());
    await finish(session.sendChat("Find incidents"));
    expect(session.feed.map((f) => f.kind)).toEqual(["user", "assistant", "tools", "assistant"]);
    expect(session.publicRun()).toMatchObject({ status: "completed", host: DEV, resumable: false });
    const stored = await chrome.storage.local.get(["copilotRun", "copilotHistory_v2"]);
    expect(stored.copilotRun).toMatchObject({ status: "completed", host: DEV });
    expect((stored.copilotHistory_v2 as any[]).map((m) => m.role)).toEqual(["user", "assistant", "tool_results", "assistant"]);
  });

  it("persists a long run from the message that started it, never from the middle of a tool exchange", async () => {
    for (let i = 0; i < 35; i++) script.push(reply("", [call("query_records", { table: `t${i}` })]));
    script.push(reply("Done."));
    const session = newSession(fakeBridge());
    await finish(session.sendChat("Survey every table"));
    const history = (await chrome.storage.local.get("copilotHistory_v2")).copilotHistory_v2 as any[];
    expect(history.length).toBeGreaterThan(60);
    expect(history[0]).toMatchObject({ role: "user" });
    expect(history[0].text).toContain("Survey every table");
  });

  it("binds the run to the instance selected at submission, whatever is selected later", async () => {
    script.push(reply("Checking.", [call("query_records", { table: "incident" })]), reply("Done."));
    const bridge = fakeBridge();
    const session = newSession(bridge);
    const run = session.sendChat("Find incidents");
    // The user (or Auto following another tab) selects Test right after sending.
    bridge.getPreferredHost.mockReturnValue(TEST_HOST);
    await chrome.storage.local.set({ activeInstanceId: "test" });
    await finish(run);
    expect(bridge.beginTurn).toHaveBeenCalledTimes(1);
    expect(bridge.beginTurn.mock.calls[0][0]).toBe(DEV);
    expect(session.publicRun()?.host).toBe(DEV);
  });

  it("does not lose a message sent while persisted state is still loading", async () => {
    await chrome.storage.local.set({ copilotFeed: [{ kind: "user", id: "old", text: "Earlier" }, { kind: "assistant", id: "old-a", text: "Earlier answer" }] });
    script.push(reply("Hello."));
    const session = newSession(fakeBridge());
    await finish(session.sendChat("New question"));
    expect(session.feed.map((f) => f.id.startsWith("old") ? f.id : f.kind)).toEqual(["old", "old-a", "user", "assistant"]);
  });

  it("starts one run when two sends arrive together", async () => {
    script.push(() => new Promise((resolve) => setTimeout(() => resolve(reply("One.")()), 2000)));
    const session = newSession(fakeBridge());
    const first = session.sendChat("First");
    const second = session.sendChat("Second");
    await finish(Promise.all([first, second]));
    expect(complete).toHaveBeenCalledTimes(1);
    expect(session.feed.some((f) => f.kind === "notice" && /wasn't sent/.test(f.text))).toBe(true);
  });
});

describe("worker restarts", () => {
  async function leaveRunningMidWrite() {
    script.push(reply("Updating.", [call("update_record", { table: "incident", sys_id: "abc", data: { priority: "2" } }, "call_w")]));
    const bridge = fakeBridge({ update: vi.fn(hang) });
    const events: any[] = [];
    const session = newSession(bridge, events);
    session.setEmitter((event) => {
      events.push(event);
      if (event.type === "feed_patch" && event.item.kind === "approval" && event.item.status === "pending") {
        queueMicrotask(() => session.resolveApproval(event.item.id, true));
      }
    });
    void session.sendChat("Lower the priority");
    await vi.waitFor(() => expect(bridge.update).toHaveBeenCalled());
    return session.publicRun()!.id;
  }

  it("reports a run the previous worker left mid-write once, with the write marked unverified", async () => {
    const runId = await leaveRunningMidWrite();
    const restarted = newSession(fakeBridge());
    await restarted.ready();
    expect(restarted.publicRun()).toMatchObject({ id: runId, status: "interrupted", failure: "worker_restarted", resumable: true });
    const [notice] = notices(restarted.feed);
    expect(notice).toMatchObject({ runId });
    expect(notice.text).toMatch(/background worker/);
    expect(chips(restarted.feed)[0]).toMatchObject({ status: "unknown", summary: expect.stringMatching(/verify/) });
    expect(restarted.feed.some((f) => f.kind === "approval" && f.status === "pending")).toBe(false);
    // Another restart does not report it again.
    const again = newSession(fakeBridge());
    await again.ready();
    expect(notices(again.feed)).toHaveLength(1);
  });

  it("names a browser or extension restart differently from a worker restart", async () => {
    await leaveRunningMidWrite();
    await chrome.storage.session.remove("copilotBrowserSession");
    const restarted = newSession(fakeBridge());
    await restarted.ready();
    expect(restarted.publicRun()?.failure).toBe("extension_restarted");
  });

  it("resumes on the original instance from the checkpoint and never repeats the unverified write", async () => {
    const runId = await leaveRunningMidWrite();
    await chrome.storage.local.set({ activeInstanceId: "test" });
    const bridge = fakeBridge();
    const events: any[] = [];
    const restarted = newSession(bridge, events);
    await restarted.ready();
    let seen: any;
    script.push(
      (params) => { seen = lastHistory(params); return reply("Checking.", [call("update_record", { table: "incident", sys_id: "abc", data: { priority: "2" } })])(); },
      reply("I could not confirm the change; please check INC0010001."),
    );
    await finish(restarted.resumeRun(runId));
    expect(bridge.beginTurn.mock.calls[0][0]).toBe(DEV);
    expect(seen.role).toBe("tool_results");
    expect(seen.results[0].content).toContain('"outcome":"unknown"');
    expect(bridge.update).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === "feed_patch" && e.item.kind === "approval")).toBe(false);
    expect(chips(restarted.feed).at(-1)).toMatchObject({ status: "unknown", summary: "not repeated — verify first" });
    expect(restarted.publicRun()).toMatchObject({ id: runId, status: "completed" });
  });
});

describe("stop and approval safety", () => {
  it("stopping during an approval expires it, runs nothing, and keeps the conversation valid", async () => {
    script.push(reply("Updating.", [call("update_record", { table: "incident", sys_id: "abc", data: { state: "2" } })]));
    const bridge = fakeBridge();
    const session = newSession(bridge);
    const run = session.sendChat("Close it");
    await vi.waitFor(() => expect(session.feed.some((f) => f.kind === "approval")).toBe(true));
    session.stop();
    await finish(run);
    expect(bridge.update).not.toHaveBeenCalled();
    expect(session.feed.find((f) => f.kind === "approval")).toMatchObject({ status: "expired" });
    expect(session.publicRun()?.status).toBe("stopped");
    let history: any[] = [];
    script.push((params) => { history = params.history; return reply("OK.")(); });
    await finish(session.sendChat("Never mind"));
    expect(history.map((m) => m.role)).toEqual(["user", "assistant", "tool_results", "user"]);
    expect(history[2].results[0].content).toContain("stopped");
  });

  it("tells the model an unanswered approval expired rather than that it was declined", async () => {
    script.push(reply("Updating.", [call("update_record", { table: "incident", sys_id: "abc", data: { state: "2" } })]));
    let result = "";
    script.push((params) => { result = lastHistory(params).results[0].content; return reply("The approval expired.")(); });
    const bridge = fakeBridge();
    const session = newSession(bridge);
    const run = session.sendChat("Close it");
    await vi.waitFor(() => expect(session.feed.some((f) => f.kind === "approval")).toBe(true));
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    await finish(run);
    expect(result).toContain('"expired":true');
    expect(bridge.update).not.toHaveBeenCalled();
    expect(chips(session.feed)[0]).toMatchObject({ status: "error", summary: "approval expired" });
  });
});

describe("findings from review", () => {
  const W = { table: "incident", sys_id: "abc", data: { state: "2" } };
  function approving(session: AgentSession, events: any[] = [], when: () => boolean = () => true) {
    session.setEmitter((event) => {
      events.push(event);
      if (when() && event.type === "feed_patch" && event.item.kind === "approval" && event.item.status === "pending") {
        queueMicrotask(() => session.resolveApproval(event.item.id, true));
      }
    });
  }
  async function nextHistory(session: AgentSession) {
    let history: any[] = [];
    script.push((params) => { history = params.history; return reply("OK.")(); });
    await finish(session.sendChat("And now?"));
    return history;
  }

  it("never reports a stopped write as applied because an earlier turn reused its call id", async () => {
    const bridge = fakeBridge();
    const session = newSession(bridge);
    let approve = true;
    approving(session, [], () => approve);
    script.push(reply("Updating.", [call("update_record", W, "call_1")]), reply("Updated."));
    await finish(session.sendChat("Update it"));
    approve = false;
    script.push(reply("Deleting.", [call("delete_record", { table: "incident", sys_id: "dup" }, "call_1")]));
    const second = session.sendChat("Delete the duplicate");
    await vi.waitFor(() => expect(session.feed.filter((f) => f.kind === "approval")).toHaveLength(2));
    session.stop();
    await finish(second);
    const history = await nextHistory(session);
    const ids = history.filter((m) => m.role === "assistant").flatMap((m) => m.toolCalls.map((c: any) => c.id));
    expect(new Set(ids).size).toBe(ids.length);
    const stopped = history.find((m) => m.role === "tool_results" && m.results[0].content.includes("stopped"));
    expect(stopped.results[0].content).toContain('"outcome":"not_run"');
    expect(bridge.remove).not.toHaveBeenCalled();
  });

  it("keeps no write input in storage — only a fingerprint — while a write is in flight", async () => {
    const bridge = fakeBridge({ update: vi.fn(hang) });
    const session = newSession(bridge);
    approving(session);
    script.push(reply("Resetting.", [call("update_record", { table: "sys_user", sys_id: "u1", data: { user_password: "Hunter2!Secret" } })]));
    void session.sendChat("Reset the password");
    await vi.waitFor(() => expect(bridge.update).toHaveBeenCalled());
    expect(JSON.stringify(await chrome.storage.local.get(null))).not.toContain("Hunter2");
    const run = (await chrome.storage.local.get("copilotRun")).copilotRun as any;
    expect(run.inflightWrite).toMatchObject({ name: "update_record", digest: expect.stringMatching(/^[0-9a-f]{64}$/) });
  });

  it("keeps the message of a run that stops before its first step, and says to send it again", async () => {
    const session = newSession(fakeBridge({ beginTurn: vi.fn(hang) }));
    void session.sendChat("Close INC0010001 as a duplicate");
    await vi.advanceTimersByTimeAsync(50);
    const restarted = newSession(fakeBridge());
    await restarted.ready();
    expect(restarted.feed.some((f) => f.kind === "user" && f.text === "Close INC0010001 as a duplicate")).toBe(true);
    expect(restarted.publicRun()).toMatchObject({ status: "interrupted", resumable: false });
    expect(notices(restarted.feed).at(-1)?.text).toMatch(/send it again/);
  });

  it("after a restart, still refuses a write whose outcome became unknown earlier in the run", async () => {
    const unknown = { data: null, error: "ServiceNow request timed out. The change may already have succeeded.", failure: "timeout", outcome: "unknown" };
    const bridge = fakeBridge({ update: vi.fn(async () => unknown), query: vi.fn(hang) });
    const session = newSession(bridge);
    approving(session);
    script.push(reply("Updating.", [call("update_record", W)]), reply("Checking.", [call("query_records", { table: "incident" })]));
    void session.sendChat("Update, then check");
    await vi.waitFor(() => expect(bridge.query).toHaveBeenCalled());
    const runId = session.publicRun()!.id;
    const after = fakeBridge();
    const events: any[] = [];
    const restarted = newSession(after, events);
    await restarted.ready();
    script.push(reply("Trying again.", [call("update_record", { ...W, step_label: "Retry the state change" })]), reply("Please verify INC0010001."));
    await finish(restarted.resumeRun(runId));
    expect(after.update).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === "feed_patch" && e.item.kind === "approval")).toBe(false);
    expect(chips(restarted.feed).at(-1)).toMatchObject({ status: "unknown", summary: "not repeated — verify first" });
  });

  it("shows steps that never started as not run when a batch is stopped", async () => {
    const bridge = fakeBridge({ query: vi.fn(() => new Promise((resolve) => setTimeout(() => resolve(ok()), 1000))) });
    const session = newSession(bridge);
    approving(session);
    script.push(reply("Checking, then updating.", [call("query_records", { table: "incident" }), call("update_record", W)]));
    const run = session.sendChat("Do both");
    await vi.waitFor(() => expect(bridge.query).toHaveBeenCalled());
    session.stop();
    await finish(run);
    const [read, write] = chips(session.feed);
    expect(read.status).toBe("ok");
    expect(write).toMatchObject({ status: "skipped", summary: "not run" });
    expect(bridge.update).not.toHaveBeenCalled();
    const history = await nextHistory(session);
    const results = history.find((m) => m.role === "tool_results").results;
    expect(results[1].content).toContain('"outcome":"not_run"');
  });

  it("closes tool calls a model left behind when it stopped early", async () => {
    const session = newSession(fakeBridge());
    script.push(() => ({ text: "Partial answer", toolCalls: [call("query_records", { table: "incident" })], stopReason: "end_turn", raw: { provider: "openrouter", content: null } }));
    await finish(session.sendChat("Go"));
    const history = await nextHistory(session);
    expect(history.map((m) => m.role)).toEqual(["user", "assistant", "tool_results", "user"]);
    expect(history[2].results[0].content).toContain("not_run");
  });

  it("ends as stopped, with no approval request, when Stop lands while a write is being prepared", async () => {
    const bridge = fakeBridge();
    const session = newSession(bridge);
    const events: any[] = [];
    session.setEmitter((event) => {
      events.push(event);
      // Stop arrives as the model's answer lands, before the approval step.
      if (event.type === "feed_patch" && event.item.kind === "assistant" && event.item.text === "Updating.") session.stop();
    });
    script.push(reply("Updating.", [call("update_record", W)]));
    await finish(session.sendChat("Update it"));
    expect(events.some((e) => e.type === "feed_patch" && e.item.kind === "approval")).toBe(false);
    expect(session.publicRun()?.status).toBe("stopped");
    expect(bridge.update).not.toHaveBeenCalled();
    const history = await nextHistory(session);
    expect(history.find((m) => m.role === "tool_results").results[0].content).toContain('"outcome":"not_run"');
  });

  it("keeps a write cut off by a restart unrepeatable after later writes and another restart", async () => {
    // First worker: the change is approved and cut off mid-call.
    const first = fakeBridge({ update: vi.fn(hang) });
    const s1 = newSession(first);
    approving(s1);
    script.push(reply("Updating.", [call("update_record", W)]));
    void s1.sendChat("Update both incidents");
    await vi.waitFor(() => expect(first.update).toHaveBeenCalled());
    const runId = s1.publicRun()!.id;

    // Second worker: resumes, makes a different change, and is cut off mid-read.
    const second = fakeBridge({ query: vi.fn(hang) });
    const s2 = newSession(second);
    approving(s2);
    await s2.ready();
    script.push(
      reply("Updating the other one.", [call("update_record", { table: "incident", sys_id: "def", data: { state: "3" } })]),
      reply("Checking.", [call("query_records", { table: "incident" })]),
    );
    void s2.resumeRun(runId);
    await vi.waitFor(() => expect(second.query).toHaveBeenCalled());
    expect(second.update).toHaveBeenCalledTimes(1);

    // Third worker: the model proposes the first change again.
    const third = fakeBridge();
    const events: any[] = [];
    const s3 = newSession(third, events);
    await s3.ready();
    script.push(reply("Trying again.", [call("update_record", W)]), reply("Please verify INC0010001."));
    await finish(s3.resumeRun(runId));
    expect(third.update).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === "feed_patch" && e.item.kind === "approval")).toBe(false);
    expect(chips(s3.feed).at(-1)).toMatchObject({ status: "unknown", summary: "not repeated — verify first" });
  });

  it("does not send a write whose in-flight marker could not be saved", async () => {
    const bridge = fakeBridge();
    const session = newSession(bridge);
    approving(session);
    const area = chrome.storage.local as any;
    const save = area.set.bind(area);
    const spy = vi.spyOn(area, "set").mockImplementation(async (items: any) => {
      if (items.copilotRun?.inflightWrite) throw new Error("QUOTA_BYTES quota exceeded");
      return save(items);
    });
    try {
      let result = "";
      script.push(
        reply("Updating.", [call("update_record", W)]),
        (params) => { result = lastHistory(params).results[0].content; return reply("It was not sent.")(); },
      );
      await finish(session.sendChat("Update it"));
      expect(bridge.update).not.toHaveBeenCalled();
      expect(result).toContain('"not_sent":true');
      expect(result).toContain("Do not retry changes in this run");
      expect(chips(session.feed)[0]).toMatchObject({ status: "error", summary: "not sent — couldn't save progress" });
    } finally {
      spy.mockRestore();
    }
  });
});

describe("failures are distinguished", () => {
  it("pauses with a resumable sign-in reason when every ServiceNow call is refused", async () => {
    const refused = { data: null, error: "ServiceNow requires sign-in.", failure: "authentication" };
    script.push(reply("Checking.", [call("query_records", { table: "incident" }), call("count_records", { table: "incident" })]));
    const session = newSession(fakeBridge({ query: vi.fn(async () => refused), count: vi.fn(async () => refused) }));
    await finish(session.sendChat("Find incidents"));
    expect(session.publicRun()).toMatchObject({ status: "interrupted", failure: "sign_in_required", resumable: true });
    expect(notices(session.feed).at(-1)?.text).toMatch(/sign-in/);
  });

  it("keeps going when only some calls fail", async () => {
    script.push(reply("Checking.", [call("query_records", { table: "incident" }), call("count_records", { table: "incident" })]), reply("Partial answer."));
    const session = newSession(fakeBridge({ count: vi.fn(async () => ({ data: null, error: "denied", failure: "access_denied" })) }));
    await finish(session.sendChat("Find incidents"));
    expect(session.publicRun()?.status).toBe("completed");
  });

  it.each([
    [{ status: 429, message: "Too many requests" }, "provider_rate_limited"],
    [{ status: 401, message: "Unauthorized" }, "provider_auth"],
    [{ code: "PROVIDER_STALLED", message: "The provider stopped sending data." }, "provider_network"],
    [{ message: "Something else" }, "provider_error"],
  ])("reports %o as a resumable %s failure", async (failure, kind) => {
    script.push(() => { throw Object.assign(new Error(failure.message), failure); });
    const session = newSession(fakeBridge());
    await finish(session.sendChat("Hello"));
    expect(session.publicRun()).toMatchObject({ status: "failed", failure: kind, resumable: true });
    const error = session.feed.find((f) => f.kind === "error");
    expect(error).toMatchObject({ runId: session.publicRun()!.id });
  });
});

describe("environment guard", () => {
  const W = { table: "incident", sys_id: "abc", data: { state: "2" } };
  const ctxOn = (host: string) => ({ hostname: host, instance: host.split(".")[0], url: `https://${host}/incident.do`, table: "incident", tabId: 7 });
  function sessionOn(host: string | null, bridgeOverrides: Record<string, any> = {}, context: any = host ? ctxOn(host) : null) {
    const bridge = fakeBridge({ getPreferredHost: vi.fn(() => host), ...bridgeOverrides });
    const session = new AgentSession(bridge as any, () => context, () => context);
    const approvals: Extract<FeedItem, { kind: "approval" }>[] = [];
    session.setEmitter((event) => {
      if (event.type === "feed_patch" && event.item.kind === "approval" && event.item.status === "pending") {
        approvals.push(event.item);
        queueMicrotask(() => session.resolveApproval(event.item.id, true));
      }
    });
    return { bridge, session, approvals };
  }
  async function writeOn(host: string) {
    let context = "";
    let result = "";
    script.push(
      (params) => { context = params.history[0].text; return reply("Updating.", [call("query_records", { table: "incident" }), call("update_record", W)])(); },
      (params) => { result = lastHistory(params).results[1].content; return reply("That instance is read-only.")(); },
    );
    const { bridge, session, approvals } = sessionOn(host);
    await finish(session.sendChat("Close it"));
    return { bridge, session, approvals, context, result };
  }

  it("asks before writing on an instance that was never added, and says on the card that it isn't added", async () => {
    const host = "dev12345.service-now.com";
    const { bridge, session, approvals, context } = await writeOn(host);
    expect(context).toContain("Instance: dev12345");
    expect(context).toMatch(/Environment: dev12345\.service-now\.com is not added .* changes allowed; each one asks the user for approval/);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ where: `dev12345 · ${host} · not added in Settings`, ops: ['Update incident record abc: state = "2"'] });
    expect(bridge.update).toHaveBeenCalledTimes(1);
    expect(chips(session.feed)[1]).toMatchObject({ status: "ok", summary: "updated" });
  });

  it("stops later writes on an instance never added once the user adds it as Production", async () => {
    const host = "dev12345.service-now.com";
    script.push(
      reply("First change.", [call("update_record", W)]),
      async () => {
        await chrome.storage.local.set({ snInstances: [...INSTANCES, { id: "pdi", label: "PDI", host, role: "prod" }] });
        return reply("Second change.", [call("update_record", { ...W, data: { state: "3" } })])();
      },
      reply("Done."),
    );
    const { bridge, session } = sessionOn(host);
    await finish(session.sendChat("Make both changes"));
    expect(bridge.update).toHaveBeenCalledTimes(1);
    expect(chips(session.feed).at(-1)).toMatchObject({ status: "error", summary: "blocked — Production is read-only" });
  });

  it("writes nothing on an instance added as Production", async () => {
    const { bridge, approvals, context, result } = await writeOn(PROD_HOST);
    expect(context).toContain('Environment: Production ("Prod") — read-only');
    expect(result).toContain("marked Production");
    expect(bridge.update).not.toHaveBeenCalled();
    expect(approvals).toHaveLength(0);
  });

  it.each([["Development", DEV_HOST, "Dev"], ["Sandbox", "examplesand.service-now.com", "Sand"], ["Test", TEST_HOST, "Test"]])(
    "asks before writing on %s, naming the instance and what will change",
    async (role, host, label) => {
      await chrome.storage.local.set({ snInstances: [...INSTANCES, { id: "sand", label: "Sand", host: "examplesand.service-now.com", role: "sand" }] });
      script.push(
        (params) => { expect(params.history[0].text).toContain(`Environment: ${role} ("${label}") — changes allowed`); return reply("Updating.", [call("update_record", { ...W, step_label: "Harmless-looking label" })])(); },
        reply("Updated."),
      );
      const { bridge, session, approvals } = sessionOn(host);
      await finish(session.sendChat("Close it"));
      expect(bridge.update).toHaveBeenCalledTimes(1);
      // The card is built from the call itself — table, record, fields — never the model's label.
      expect(approvals[0]).toMatchObject({ where: `${label} · ${host}`, ops: ['Update incident record abc: state = "2"'] });
      expect(session.feed.find((f) => f.kind === "approval")).toMatchObject({ status: "approved" });
    },
  );

  it("still states the environment when the page gave no context", async () => {
    let context = "";
    script.push((params) => { context = params.history[0].text; return reply("OK.")(); });
    const { session } = sessionOn("dev12345.service-now.com", {}, null);
    await finish(session.sendChat("What is this instance?"));
    expect(context).toContain("No ServiceNow page context");
    expect(context).toContain("Instance: dev12345.service-now.com");
    expect(context).toMatch(/Environment: dev12345\.service-now\.com is not added/);
  });

  it("stops later writes when the instance is made read-only mid-run", async () => {
    script.push(
      reply("First change.", [call("update_record", W)]),
      async () => {
        // The user switches Dev to Production while the run works.
        await chrome.storage.local.set({ snInstances: INSTANCES.map((i) => (i.id === "dev" ? { ...i, role: "prod" } : i)) });
        return reply("Second change.", [call("update_record", { ...W, data: { state: "3" } })])();
      },
      reply("Done."),
    );
    const { bridge, session } = sessionOn(DEV_HOST);
    await finish(session.sendChat("Make both changes"));
    expect(bridge.update).toHaveBeenCalledTimes(1);
    expect(chips(session.feed).at(-1)).toMatchObject({ status: "error", summary: "blocked — Production is read-only" });
  });

  it("stops a write when the instance is marked Production while its card waits", async () => {
    script.push(reply("Updating.", [call("update_record", W)]), reply("Done."));
    const bridge = fakeBridge({ getPreferredHost: vi.fn(() => DEV_HOST) });
    const session = new AgentSession(bridge as any, () => ctxOn(DEV_HOST), () => ctxOn(DEV_HOST));
    session.setEmitter((event) => {
      if (event.type === "feed_patch" && event.item.kind === "approval" && event.item.status === "pending") {
        const id = event.item.id;
        // The user marks Dev as Production, then approves the card that was already showing.
        void chrome.storage.local.set({ snInstances: INSTANCES.map((i) => (i.id === "dev" ? { ...i, role: "prod" } : i)) })
          .then(() => session.resolveApproval(id, true));
      }
    });
    await finish(session.sendChat("Close it"));
    expect(bridge.update).not.toHaveBeenCalled();
    expect(chips(session.feed).at(-1)).toMatchObject({ status: "error", summary: "blocked — Production is read-only" });
  });

  it("stops the rest of a batch when the instance is marked Production partway through it", async () => {
    script.push(reply("Updating both.", [call("update_record", W), call("update_record", { ...W, data: { state: "3" } })]), reply("Done."));
    const update = vi.fn(async () => {
      await chrome.storage.local.set({ snInstances: INSTANCES.map((i) => (i.id === "dev" ? { ...i, role: "prod" } : i)) });
      return ok({});
    });
    const { bridge, session } = sessionOn(DEV_HOST, { update });
    await finish(session.sendChat("Make both changes"));
    expect(bridge.update).toHaveBeenCalledTimes(1);
    expect(chips(session.feed).at(-1)).toMatchObject({ status: "error", summary: "blocked — Production is read-only" });
  });

  it("shows no plan card on an instance marked Production, and says why", async () => {
    let told = "";
    script.push(
      reply("Plan.", [call("propose_plan", { details: "Close INC0010001.", steps: ["Close the incident"] })]),
      (params) => { told = lastHistory(params).results[0].content; return reply("That instance is read-only.")(); },
    );
    const { session, approvals } = sessionOn(PROD_HOST);
    await finish(session.sendChat("Close it"));
    expect(approvals).toHaveLength(0);
    expect(session.feed.some((f) => f.kind === "assistant" && f.text === "Close INC0010001.")).toBe(false);
    expect(told).toContain("marked Production");
  });

  it("pins a run sent with no instance to the one the bridge bound, and guards writes by it", async () => {
    await chrome.storage.local.set({ activeInstanceId: "ghost" });
    const getPreferredHost = vi.fn<() => string | null>().mockReturnValueOnce(null).mockReturnValue(DEV_HOST);
    script.push(reply("Updating.", [call("update_record", W)]), reply("Done."));
    // The real bridge reports the bound tab's host; the stand-in echoes beginTurn's argument.
    const { bridge, session, approvals } = sessionOn(DEV_HOST, { getPreferredHost, getBoundTabHost: vi.fn(async () => DEV_HOST) });
    await finish(session.sendChat("Close it"));
    expect(bridge.beginTurn.mock.calls[0][0]).toBeNull();
    expect(session.publicRun()?.host).toBe(DEV_HOST);
    expect(approvals[0].where).toBe(`Dev · ${DEV_HOST}`);
    expect(bridge.update).toHaveBeenCalledTimes(1);
  });
});

// One approval per response: the plan's card, or the first change's if the
// model made no plan. After it, everything in the response builds.
describe("one approval", () => {
  function approving(answer: () => boolean = () => true) {
    const bridge = fakeBridge({ query: vi.fn(async () => ok([])) });
    const session = new AgentSession(bridge as any, () => ctx, () => ctx);
    const cards: Extract<FeedItem, { kind: "approval" }>[] = [];
    session.setEmitter((event) => {
      if (event.type === "feed_patch" && event.item.kind === "approval" && event.item.status === "pending") {
        const card = event.item;
        cards.push(card);
        queueMicrotask(() => session.resolveApproval(card.id, answer()));
      }
    });
    return { bridge, session, cards };
  }
  const GROUP = "f".repeat(32); // what the stand-in returns for every create
  const member = (user: string) => call("create_record", { table: "sys_user_grmember", data: { group: GROUP, user } });
  const STEPS = ['Create group "Network"', "Add Abel Tuter", "Add Amelia Caputo", "Add Bart Hachey", "Delete the old test incident"];

  it("shows the whole plan on one card, then builds all of it — members, roles and deletes included", async () => {
    let told = "";
    script.push(
      reply("Here's the plan.", [call("propose_plan", { steps: STEPS })]),
      (params) => { told = lastHistory(params).results[0].content; return reply("Group.", [call("create_record", { table: "sys_user_group", data: { name: "Network" } })])(); },
      reply("Members.", [member("1".repeat(32)), member("2".repeat(32)), member("3".repeat(32))]),
      reply("Role and cleanup.", [
        call("create_record", { table: "sys_group_has_role", data: { group: GROUP, role: "itil" } }),
        call("delete_record", { table: "incident", sys_id: "9".repeat(32) }),
      ]),
      reply("Done."),
    );
    const { bridge, session, cards } = approving();
    await finish(session.sendChat("Build it"));
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ plan: true, ops: STEPS, status: "pending" });
    expect(told).toContain("approved");
    expect(bridge.createRaw.mock.calls.map((c: any[]) => c[0])).toEqual(["sys_user_group", "sys_user_grmember", "sys_user_grmember", "sys_user_grmember", "sys_group_has_role"]);
    expect(bridge.remove).toHaveBeenCalledTimes(1);
    expect(chips(session.feed)[0]).toMatchObject({ label: "Plan", status: "ok", summary: "approved" });
  });

  it("shows the detailed plan in Markdown right above its card", async () => {
    const DETAILS = "## Plan\n\n| User | sys_id |\n|---|---|\n| Abel Tuter | 1111 |";
    script.push(
      reply("Here's the plan.", [call("propose_plan", { details: `  ${DETAILS}\n`, steps: STEPS })]),
      reply("Done."),
    );
    const { session, cards } = approving(() => false);
    await finish(session.sendChat("Build it"));
    expect(cards).toHaveLength(1);
    const at = session.feed.findIndex((f) => f.kind === "approval");
    expect(session.feed[at - 1]).toMatchObject({ kind: "assistant", text: DETAILS });
    expect(session.feed.filter((f) => f.kind === "assistant" && f.text === DETAILS)).toHaveLength(1);
  });

  it("still shows the card, and builds, when the plan has no details", async () => {
    script.push(
      reply("Plan.", [call("propose_plan", { details: "   ", steps: ['Create group "A"'] })]),
      reply("Group.", [call("create_record", { table: "sys_user_group", data: { name: "A" } })]),
      reply("Done."),
    );
    const { bridge, session, cards } = approving();
    await finish(session.sendChat("Build it"));
    expect(cards).toHaveLength(1);
    const at = session.feed.findIndex((f) => f.kind === "approval");
    expect(session.feed[at - 1]).toMatchObject({ kind: "assistant", text: "Plan." });
    expect(bridge.createRaw).toHaveBeenCalledTimes(1);
  });

  it("changes nothing when the plan is rejected, even writes sent alongside it", async () => {
    let told = "";
    script.push(
      reply("Here's the plan.", [call("propose_plan", { steps: STEPS }), call("create_record", { table: "sys_user_group", data: { name: "Network" } })]),
      (params) => { told = lastHistory(params).results[0].content; return reply("OK, nothing changed.")(); },
    );
    const { bridge, session, cards } = approving(() => false);
    await finish(session.sendChat("Build it"));
    expect(cards).toHaveLength(1);
    expect(told).toContain("rejected the plan");
    expect(bridge.createRaw).not.toHaveBeenCalled();
    expect(chips(session.feed).map((c) => c.summary)).toEqual(["rejected", "declined"]);
  });

  it("asks again after a second plan in the response is rejected", async () => {
    script.push(
      reply("Plan.", [call("propose_plan", { steps: ['Create group "A"'] })]),
      reply("Group.", [call("create_record", { table: "sys_user_group", data: { name: "A" } })]),
      reply("A new plan.", [call("propose_plan", { steps: ['Create group "B"'] })]),
      reply("Anyway.", [call("create_record", { table: "sys_user_group", data: { name: "B" } })]),
      reply("Done."),
    );
    let n = 0;
    const { bridge, session, cards } = approving(() => ++n === 1);
    await finish(session.sendChat("Build it"));
    expect(cards).toHaveLength(3);
    expect(bridge.createRaw).toHaveBeenCalledTimes(1);
  });

  it("shows no card for a plan with no steps", async () => {
    script.push(reply("Plan.", [call("propose_plan", { steps: [] })]), reply("Sorry."));
    const { session, cards } = approving();
    await finish(session.sendChat("Build it"));
    expect(cards).toHaveLength(0);
    expect(chips(session.feed)[0]).toMatchObject({ status: "error", summary: "not shown" });
  });

  it("without a plan, lets the first change's approval cover the rest of the response", async () => {
    script.push(
      reply("Group.", [call("create_record", { table: "sys_user_group", data: { name: "Network" } })]),
      reply("Members.", [member("1".repeat(32)), member("2".repeat(32))]),
      reply("Done."),
    );
    const { bridge, session, cards } = approving();
    await finish(session.sendChat("Make a group"));
    expect(cards).toHaveLength(1);
    expect(bridge.createRaw).toHaveBeenCalledTimes(3);
  });

  it("asks again for the next message", async () => {
    script.push(reply("Group.", [call("create_record", { table: "sys_user_group", data: { name: "A" } })]), reply("Done."));
    script.push(reply("Group.", [call("create_record", { table: "sys_user_group", data: { name: "B" } })]), reply("Done."));
    const { session, cards } = approving();
    await finish(session.sendChat("Make group A"));
    await finish(session.sendChat("Make group B"));
    expect(cards).toHaveLength(2);
  });
});

describe("model selection", () => {
  afterEach(() => { vi.unstubAllGlobals(); });
  const catalog = (rows: any[], status = 200) => vi.fn(async () => new Response(JSON.stringify({ data: rows }), { status }));

  it("starts on the catalog's default when no model has been chosen, and keeps it", async () => {
    await chrome.storage.local.set({ providerModels: {} });
    vi.stubGlobal("fetch", catalog([
      { id: "openai/gpt-5.5", name: "GPT-5.5", created: 30, supported_parameters: ["tools"] },
      { id: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5", created: 20, supported_parameters: ["tools"] },
      { id: "vendor/chat-only", name: "Chat only", created: 40, supported_parameters: ["temperature"] },
    ]));
    let used = "";
    script.push((params) => { used = params.modelId; return reply("Hello.")(); });
    const session = newSession(fakeBridge());
    await finish(session.sendChat("Hi"));
    expect(used).toBe("anthropic/claude-sonnet-5");
    expect(((await chrome.storage.local.get("providerModels")).providerModels as any).openrouter).toBe("anthropic/claude-sonnet-5");
  });

  it("explains instead of running when the catalog can't name a model", async () => {
    await chrome.storage.local.set({ providerModels: {} });
    vi.stubGlobal("fetch", catalog([], 401));
    const session = newSession(fakeBridge());
    await finish(session.sendChat("Hi"));
    expect(complete).not.toHaveBeenCalled();
    expect(session.feed.at(-1)).toMatchObject({ kind: "error", text: expect.stringMatching(/Couldn't load OpenRouter models \(API key was rejected\)/) });
  });

  it("keeps a model the user picks while the default is still loading", async () => {
    await chrome.storage.local.set({ providerModels: {} });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.endsWith("/models")) await gate;
      return new Response(JSON.stringify({ data: [{ id: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5", created: 1, supported_parameters: ["tools"] }] }));
    }));
    let used = "";
    script.push((params) => { used = params.modelId; return reply("Hello.")(); });
    const session = newSession(fakeBridge());
    const run = session.sendChat("Hi");
    await vi.advanceTimersByTimeAsync(10);
    await patchSettings({ models: { openrouter: "vendor/picked" } });
    release();
    await finish(run);
    expect(used).toBe("vendor/picked");
    expect(((await chrome.storage.local.get("providerModels")).providerModels as any).openrouter).toBe("vendor/picked");
  });

  it("stops cleanly when Stop is pressed while the model list loads", async () => {
    await chrome.storage.local.set({ providerModels: {} });
    const fetch = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    }));
    vi.stubGlobal("fetch", fetch);
    const session = newSession(fakeBridge());
    const run = session.sendChat("Hi");
    // Stop once the list is actually loading, however long starting up takes.
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    session.stop();
    await finish(run);
    expect(complete).not.toHaveBeenCalled();
    expect(session.feed.at(-1)).toMatchObject({ kind: "notice", text: "Stopped." });
  });
});

describe("the effort a run asks for", () => {
  /** The model's catalog entry, as the picker would have loaded it. */
  async function listModel(efforts: string[]) {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [
      { id: "vendor/test-model", name: "Test", supported_parameters: ["tools"], reasoning: { supported_efforts: efforts } },
    ] }))));
    const { getModelCatalog } = await import("../../src/background/modelCatalog");
    await getModelCatalog("openrouter", "k", true);
    vi.unstubAllGlobals();
    await vi.waitFor(async () => expect((await chrome.storage.local.get("modelCatalog")).modelCatalog).toHaveProperty("openrouter"));
  }

  it("is the one chosen for the model, if its list says the model takes it", async () => {
    await listModel(["low", "high"]);
    await patchSettings({ effort: { provider: "openrouter", model: "vendor/test-model", level: "high" } });
    script.push(reply("Done."));
    await finish(newSession(fakeBridge()).sendChat("Find incidents"));
    expect(complete.mock.calls[0][1]).toMatchObject({ effort: "high", model: { id: "vendor/test-model", efforts: ["low", "high"] } });
  });

  it("is none — the model's own default — when the model doesn't take the level chosen", async () => {
    await listModel(["low", "high"]);
    await patchSettings({ effort: { provider: "openrouter", model: "vendor/test-model", level: "max" } });
    script.push(reply("Done."));
    await finish(newSession(fakeBridge()).sendChat("Find incidents"));
    expect(complete.mock.calls[0][1].effort).toBeUndefined();
  });
});

const POLICY = "b".repeat(32);
const ITEM = "c".repeat(32);
const VARIABLE = "d".repeat(32);
const ACTION_ID = "a".repeat(32);
const ACTION = { table: "catalog_ui_policy_action", data: { ui_policy: POLICY, catalog_variable: "needs_monitor", visible: "true" } };
const helperCopies = (helper: "missing" | "old" | "current") =>
  helper === "missing" ? [] : [{ sys_id: "h".repeat(32), script: helper === "current" ? HELPER_SCRIPT : "// v1" }];

/** The reads a policy action's create makes: the helper's copies, its policy
 * and variable, any existing action for that variable, and the action read back. */
function actionReads(opts: { helper?: "missing" | "old" | "current"; policy?: any[]; existing?: any[]; saved?: any } = {}) {
  return vi.fn(async (q: any) => {
    switch (q.table) {
      case "sys_script_include": return ok(helperCopies(opts.helper ?? "current"));
      case "catalog_ui_policy": return ok(opts.policy ?? [{ sys_id: POLICY, catalog_item: ITEM }]);
      case "item_option_new": return ok([{ sys_id: VARIABLE, name: "needs_monitor" }]);
      case "catalog_ui_policy_action":
        return String(q.query).startsWith("sys_id=")
          ? ok([opts.saved ?? { ui_policy: POLICY, catalog_variable: `IO:${VARIABLE}` }])
          : ok(opts.existing ?? []);
      default: return ok([]);
    }
  });
}

describe("the helper Script Include", () => {
  const INCIDENT = { table: "incident", sys_id: "abc", data: { state: "2" } };
  /** A bridge on an instance where the helper is installed (current or old) or not. */
  function onInstance(helper: "missing" | "old" | "current", answer: (card: Extract<FeedItem, { kind: "approval" }>) => boolean = () => true) {
    const bridge = fakeBridge({ query: actionReads({ helper }) });
    const session = new AgentSession(bridge as any, () => ctx, () => ctx);
    const cards: Extract<FeedItem, { kind: "approval" }>[] = [];
    session.setEmitter((event) => {
      if (event.type === "feed_patch" && event.item.kind === "approval" && event.item.status === "pending") {
        const card = event.item;
        cards.push(card);
        queueMicrotask(() => session.resolveApproval(card.id, answer(card)));
      }
    });
    return { bridge, session, cards };
  }
  const installs = (bridge: any) => bridge.createRaw.mock.calls.filter((c: any[]) => c[0] === "sys_script_include");

  const INSTALL_LINE = /^Install the SNAICopilotHelper Script Include/;
  /** The model's tool results, in the order it saw them. */
  const toolResults = () => JSON.stringify(complete.mock.calls.at(-1)?.[1] ?? {});

  it("asks for the install on its own card right after the plan, explained", async () => {
    const steps = ['Add UI policy "Monitor"', "Make needs_monitor visible"];
    script.push(
      reply("Plan.", [call("propose_plan", { details: "The plan.", steps, ui_policy_actions: true })]),
      reply("Updating the incident first.", [call("update_record", INCIDENT)]),
      reply("Now the policy action.", [call("create_record", ACTION)]),
      reply("Done."),
    );
    const { bridge, session, cards } = onInstance("missing");
    await finish(session.sendChat("Build it"));
    expect(cards).toHaveLength(2);
    // The plan's card lists the plan and nothing about the helper.
    expect(cards[0]).toMatchObject({ plan: true, ops: steps });
    expect(cards[0].helper).toBeUndefined();
    expect(cards[0].explain).toBeUndefined();
    // The helper's card is its own, before anything is built.
    expect(cards[1]).toMatchObject({ helper: true, ops: [expect.stringMatching(INSTALL_LINE)] });
    expect(cards[1].plan).toBeUndefined();
    expect(cards[1].explain?.title).toContain("One-time setup");
    expect(cards[1].explain?.lines.join(" ")).toMatch(/REST API can't set the variable.*catalog_admin.*sys_script_include/);
    expect(installs(bridge)).toHaveLength(1);
    expect(bridge.glideAjaxCreate).toHaveBeenCalledTimes(1);
  });

  it("asks before the first change that needs it when the plan didn't say so", async () => {
    script.push(
      reply("Plan.", [call("propose_plan", { details: "The plan.", steps: ["Update the incident", "Add the action"] })]),
      reply("Updating the incident first.", [call("update_record", INCIDENT)]),
      reply("Now the policy action.", [call("create_record", ACTION)]),
      reply("Done."),
    );
    const { bridge, session, cards } = onInstance("missing");
    await finish(session.sendChat("Build it"));
    expect(cards.map((c) => (c.helper ? "helper" : c.plan ? "plan" : "change"))).toEqual(["plan", "helper"]);
    // The incident was updated before the helper was asked about.
    const helperRead = bridge.query.mock.calls.findIndex((c: any[]) => c[0].table === "sys_script_include");
    expect(bridge.update.mock.invocationCallOrder[0]).toBeLessThan(bridge.query.mock.invocationCallOrder[helperRead]);
    expect(installs(bridge)).toHaveLength(1);
  });

  it("without a plan, asks for the change first and then, on its own card, for the install", async () => {
    script.push(reply("Now the policy action.", [call("create_record", ACTION)]), reply("Done."));
    const { bridge, session, cards } = onInstance("missing");
    await finish(session.sendChat("Build it"));
    expect(cards).toHaveLength(2);
    expect(cards[0].helper).toBeUndefined();
    expect(cards[0].ops.some((op) => INSTALL_LINE.test(op))).toBe(false);
    expect(cards[1]).toMatchObject({ helper: true, ops: [expect.stringMatching(INSTALL_LINE)] });
    expect(installs(bridge)).toHaveLength(1);
  });

  it("installs nothing, and creates no action, when the user rejects the helper; the rest still builds", async () => {
    script.push(
      reply("Plan.", [call("propose_plan", { details: "The plan.", steps: ["Update the incident", "Add the action"], ui_policy_actions: true })]),
      reply("Building.", [call("update_record", INCIDENT), call("create_record", ACTION)]),
      reply("Another action.", [call("create_record", ACTION)]),
      reply("Done."),
    );
    const { bridge, session, cards } = onInstance("missing", (card) => !card.helper);
    await finish(session.sendChat("Build it"));
    // Asked once; rejected, it isn't asked again in the response.
    expect(cards.filter((c) => c.helper)).toHaveLength(1);
    expect(installs(bridge)).toHaveLength(0);
    expect(bridge.glideAjaxCreate).not.toHaveBeenCalled();
    expect(bridge.update).toHaveBeenCalledWith("incident", "abc", { state: "2" });
    expect(toolResults()).toMatch(/declined installing the SNAICopilotHelper Script Include, so this catalog UI policy action was not created/);
  });

  it("never asks about the helper when the changes themselves are rejected", async () => {
    script.push(reply("Creating the action.", [call("create_record", ACTION)]), reply("Rejected."));
    const { bridge, session, cards } = onInstance("missing", () => false);
    await finish(session.sendChat("Build it"));
    expect(cards).toHaveLength(1);
    expect(cards[0].helper).toBeUndefined();
    expect(installs(bridge)).toHaveLength(0);
    expect(bridge.glideAjaxCreate).not.toHaveBeenCalled();
  });

  it("asks before replacing an older copy, on its own card", async () => {
    script.push(reply("Creating the action.", [call("create_record", ACTION)]), reply("Done."));
    const { bridge, session, cards } = onInstance("old");
    await finish(session.sendChat("Build it"));
    expect(cards[1]).toMatchObject({ helper: true, ops: [expect.stringMatching(/^Update the SNAICopilotHelper/)] });
    expect(cards[1].explain?.title).toMatch(/^Update/);
    expect(bridge.update).toHaveBeenCalledWith("sys_script_include", "h".repeat(32), expect.objectContaining({ script: HELPER_SCRIPT }));
  });

  it("says nothing more once the current helper is installed", async () => {
    script.push(
      reply("Plan.", [call("propose_plan", { details: "The plan.", steps: ["Update the incident", "Add the action"], ui_policy_actions: true })]),
      reply("Updating the incident first.", [call("update_record", INCIDENT)]),
      reply("Now the policy action.", [call("create_record", ACTION)]),
      reply("Done."),
    );
    const { bridge, session, cards } = onInstance("current");
    await finish(session.sendChat("Build it"));
    expect(cards).toHaveLength(1);
    expect(cards[0].helper).toBeUndefined();
    expect(installs(bridge)).toHaveLength(0);
    expect(bridge.glideAjaxCreate).toHaveBeenCalledTimes(1);
  });

  it("refuses to install a helper that went missing after the check, without asking", async () => {
    const { createRecordSmart } = await import("../../src/background/snCatalog");
    const bridge = fakeBridge({ query: actionReads({ helper: "missing" }), glideAjaxCreate: vi.fn() });
    const result = await createRecordSmart(bridge as any, { table: ACTION.table, data: { ...ACTION.data } });
    expect(result.error).toMatch(/must be installed first, and the user has not approved that/);
    expect(bridge.createRaw).not.toHaveBeenCalled();
    expect(bridge.glideAjaxCreate).not.toHaveBeenCalled();
  });
});

describe("creating a catalog UI policy action", () => {
  async function create(bridgeOverrides: Record<string, any>, data: Record<string, any> = ACTION.data) {
    const { createRecordSmart } = await import("../../src/background/snCatalog");
    const bridge = fakeBridge({ query: actionReads(), ...bridgeOverrides });
    const pending = createRecordSmart(bridge as any, { table: ACTION.table, data: { ...data }, helperApproved: true });
    await finish(pending);
    return { bridge, result: await pending };
  }

  it("creates it under its policy, sends read only as disabled, and checks it saved", async () => {
    const { bridge, result } = await create({}, { ...ACTION.data, mandatory: false, read_only: true });
    expect(bridge.glideAjaxCreate).toHaveBeenCalledWith("catalog_ui_policy_action", {
      ui_policy: POLICY, catalog_variable: "needs_monitor", visible: "true", mandatory: "false", disabled: "true",
    });
    expect(bridge.formFillCatalogVariable).toHaveBeenCalledWith(ACTION_ID, `IO:${VARIABLE}`);
    expect(result).toEqual({ data: { result: { sys_id: ACTION_ID } }, error: null });
    expect(bridge.remove).not.toHaveBeenCalled();
  });

  // The failure this guards against: an action saved without its policy runs
  // for no policy, yet was reported as created.
  it("deletes an action that didn't keep its policy link, and says nothing changed", async () => {
    const { bridge, result } = await create({ query: actionReads({ saved: { ui_policy: "", catalog_variable: `IO:${VARIABLE}` } }) });
    expect(result.error).toMatch(/UI policy link did not save, so it was deleted again\. Nothing was changed\./);
    expect(bridge.remove).toHaveBeenCalledWith("catalog_ui_policy_action", ACTION_ID);
  });

  it("deletes an action whose variable didn't save, with the form's reason", async () => {
    const { bridge, result } = await create({
      query: actionReads({ saved: { ui_policy: POLICY, catalog_variable: "" } }),
      formFillCatalogVariable: vi.fn(async () => ({ error: "catalog_variable dropdown never populated (1 options)" })),
    });
    expect(result.error).toMatch(/variable did not save \(catalog_variable dropdown never populated.*deleted again/);
    expect(bridge.remove).toHaveBeenCalledWith("catalog_ui_policy_action", ACTION_ID);
  });

  it("says so, and never reports success, when a half-made action can't be deleted", async () => {
    const { result } = await create({
      query: actionReads({ saved: { ui_policy: "", catalog_variable: `IO:${VARIABLE}` } }),
      remove: vi.fn(async () => ({ data: null, error: "ACL" })),
    });
    expect(result.data).toBeNull();
    expect(result.error).toMatch(/Created catalog_ui_policy_action a{32}.*could not be deleted again \(ACL\).*Do not create it again/);
  });

  it("returns the existing action for that variable instead of making a second", async () => {
    const existing = { sys_id: "e".repeat(32) };
    const { bridge, result } = await create({ query: actionReads({ existing: [existing] }) });
    expect(bridge.query).toHaveBeenCalledWith(expect.objectContaining({ table: ACTION.table, query: `ui_policy=${POLICY}^catalog_variable=IO:${VARIABLE}` }));
    expect(result).toMatchObject({ skipped: true, data: { result: existing } });
    expect(bridge.glideAjaxCreate).not.toHaveBeenCalled();
  });

  it("creates nothing, and installs nothing, for a policy that doesn't exist", async () => {
    const { bridge, result } = await create({ query: actionReads({ policy: [], helper: "missing" }) });
    expect(result.error).toMatch(/no catalog_ui_policy with sys_id b{32}\. Nothing was changed/);
    expect(bridge.glideAjaxCreate).not.toHaveBeenCalled();
    expect(bridge.createRaw).not.toHaveBeenCalled();
  });
});
