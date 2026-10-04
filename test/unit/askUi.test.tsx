import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppView } from "../../src/sidepanel/App";
import { DEV_HOST, PROD_HOST, TEST_HOST, chatFeed, fakeAgent, publicSettings } from "../fixtures/chat";
import type { AgentApi } from "../../src/sidepanel/hooks/useAgent";
import type { FeedItem } from "../../src/shared/types";

// Animation is presentation; remove exit delays to test settled navigation.
vi.mock("framer-motion", async () => {
  const React = await import("react");
  return {
    AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
    motion: { div: React.forwardRef<HTMLDivElement, any>(({ initial: _i, animate: _a, exit: _e, transition: _t, ...props }, ref) => <div ref={ref} {...props} />) },
  };
});
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
let agent: AgentApi;
const click = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
const button = (label: string, scope: ParentNode = container) => {
  const match = Array.from(scope.querySelectorAll("button")).find((b) => b.getAttribute("aria-label") === label || b.textContent?.trim() === label);
  expect(match, `Button: ${label}`).toBeTruthy();
  return match!;
};
const type = (el: HTMLInputElement | HTMLTextAreaElement, text: string) => act(() => {
  const prototype = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(el, text);
  el.dispatchEvent(new Event("input", { bubbles: true }));
});
const key = (key: string, options = {}) => act(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...options })); });
const render = (overrides: Partial<AgentApi> = {}) => {
  agent = fakeAgent({ patchSettings: vi.fn(), sendChat: vi.fn(), stop: vi.fn(), approve: vi.fn(), resume: vi.fn(), listSessions: vi.fn(), openHostTab: vi.fn(), ...overrides });
  act(() => root.render(<AppView agent={agent} />));
};
const header = () => container.querySelector(".chat-header")!;
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  HTMLElement.prototype.scrollTo = vi.fn();
  document.documentElement.dataset.theme = "light";
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); });

describe("chat header", () => {
  it("names the instance, host and page without a product title, logo, or permanent status text", () => {
    render({ feed: chatFeed });
    const text = header().textContent!;
    expect(text).toContain("Dev");
    expect(text).toContain(DEV_HOST);
    expect(text).toContain("Incident · INC0010001");
    expect(text).not.toMatch(/SN AI Copilot|Tab ready|Following tab/);
    expect(header().querySelector("img, svg.lucide-orbit")).toBeNull();
    expect(button("New chat", header())).toBeTruthy();
  });

  it("gives the readiness dot an accessible name that claims only what was checked", () => {
    render();
    const trigger = header().querySelector(".instance-trigger")!;
    expect(trigger.getAttribute("aria-label")).toMatch(/Browser helper ready on exampledev\.service-now\.com/);
    expect(trigger.getAttribute("aria-label")).toMatch(/Development · changes allowed/);
    expect(trigger.getAttribute("aria-label")).toMatch(/Following your tab/);
    expect(trigger.getAttribute("aria-label")).not.toMatch(/permission|verified|connected/i);
    expect(trigger.querySelector(".status-dot-ok")).not.toBeNull();
  });

  it("stays quiet when ready and says what to do when attention is needed", () => {
    render();
    expect(header().querySelector('[role="status"]')).toBeNull();
    render({ connection: { phase: "sign_in_required", host: "exampledev.service-now.com", checkedAt: Date.now(), reason: "authentication" } });
    expect(header().querySelector('[role="status"]')?.textContent).toContain("Sign-in required");
    click(button("Sign in", header()));
    expect(agent.openHostTab).toHaveBeenCalledWith("exampledev.service-now.com");
    expect(header().querySelector(".status-dot-ok")).toBeNull();
    render({ ctx: null, connection: { phase: "unavailable", host: "exampledev.service-now.com", checkedAt: Date.now(), reason: "no_tab" } });
    expect(header().textContent).toContain("No ServiceNow tab");
    click(button("Open Dev", header()));
    expect(agent.openHostTab).toHaveBeenCalledWith("exampledev.service-now.com");
    // A tab that exists but stopped answering is not "no tab", and fixing it reloads it.
    render({ connection: { phase: "unavailable", host: "exampledev.service-now.com", checkedAt: Date.now(), reason: "transport" } });
    expect(header().textContent).toContain("ServiceNow tab not responding");
    expect(button("Reload it", header())).toBeTruthy();
  });

  it("shows the run's instance while it works and explains that a new selection waits", () => {
    render({ running: true, run: { id: "r", status: "running", host: "exampledev.service-now.com", startedAt: 1, resumable: false }, settings: publicSettings({ pinnedInstanceId: "test", activeInstanceId: "test" }) });
    const trigger = header().querySelector(".instance-trigger")!;
    expect(trigger.textContent).toContain("Dev");
    expect(trigger.getAttribute("aria-label")).toMatch(/new selection applies to the next message/);
    expect(button("New chat", header()).disabled).toBe(true);
  });

  // Auto follows the page on screen even when it was never added; the header
  // says so rather than naming some other instance.
  it("names a tab that was never added by its host, and says changes are allowed there", () => {
    const host = "dev12345.service-now.com";
    render({ connection: { phase: "ready", host, checkedAt: Date.now() }, viewedHost: host, ctx: { hostname: host, instance: "dev12345", tabId: 4 } });
    const trigger = header().querySelector(".instance-trigger")!;
    expect(trigger.textContent).toContain("dev12345");
    expect(trigger.classList.contains("instance-unadded")).toBe(true);
    expect(trigger.getAttribute("aria-label")).toMatch(/Not added · changes allowed/);
    click(trigger);
    expect(container.querySelector(".instance-menu")?.textContent).toContain("Now on dev12345 · not added");
  });

  it("while pinned, names the pin in the header but the tab on screen under Auto", () => {
    render({ viewedHost: "dev12345.service-now.com", connection: { phase: "ready", host: PROD_HOST, checkedAt: Date.now() }, settings: publicSettings({ pinnedInstanceId: "prod", activeInstanceId: "prod" }) });
    const trigger = header().querySelector(".instance-trigger")!;
    expect(trigger.textContent).toContain("Prod");
    click(trigger);
    expect(container.querySelector(".instance-menu")?.textContent).toContain("Now on dev12345 · not added");
  });

  it("has no standing approval reminder", () => {
    render({ feed: chatFeed, cost: { usd: 0.02, turnUsd: 0.01, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, requests: 1, estimatedRequests: 0, reportedRequests: 0 } });
    expect(container.textContent).not.toMatch(/Changes require approval|changes require approval/);
  });
});

describe("views and navigation", () => {
  it("preserves draft, feed and scroll through History and Settings, and hands focus back", () => {
    render({ feed: chatFeed });
    const draft = container.querySelector("textarea")!;
    type(draft, "Keep my unfinished question");
    const scroll = container.querySelector<HTMLDivElement>(".console-scroll")!;
    scroll.scrollTop = 123;
    const opener = button("Settings");
    act(() => opener.focus());
    click(opener);
    expect(document.activeElement).toBe(button("Back to chat"));
    expect(container.querySelector(".chat-surface")?.getAttribute("aria-hidden")).toBe("true");
    key("Escape");
    expect(container.querySelector('[role="region"][aria-label="Settings"]')).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(draft.value).toBe("Keep my unfinished question");
    expect(scroll.scrollTop).toBe(123);
    click(button("History"));
    expect(agent.listSessions).toHaveBeenCalledOnce();
    expect(container.querySelector('[role="region"][aria-label="History"]')).not.toBeNull();
    expect(container.querySelector('[role="region"][aria-label="Settings"]')).toBeNull();
    click(button("Chat"));
    expect(draft.value).toBe("Keep my unfinished question");
    expect(container.textContent).toContain("Service Desk");
  });

  it("keeps the navigation reachable from Settings: the view is not a modal trap", () => {
    render();
    click(button("Settings"));
    const view = container.querySelector('[role="region"][aria-label="Settings"]')!;
    expect(view.getAttribute("aria-modal")).toBeNull();
    const nav = container.querySelector('nav[aria-label="Panel navigation"]')!;
    expect(nav.closest('[aria-hidden="true"]')).toBeNull();
    expect(button("Settings", nav).getAttribute("aria-current")).toBe("page");
    click(button("Chat", nav));
    expect(container.querySelector('[role="region"][aria-label="Settings"]')).toBeNull();
  });

  it("offers AI Access for a missing key and opens the selected instance when no tab is open", () => {
    render({ ctx: null, settings: publicSettings({ keysPresent: { anthropic: false, openai: false, openrouter: false }, pinnedInstanceId: "test" }) });
    expect(container.textContent).toContain("Connect an AI provider");
    click(button("Open Test"));
    expect(agent.openHostTab).toHaveBeenCalledWith(TEST_HOST);
    click(container.querySelector(".setup-banner")!);
    expect(container.querySelector('[data-section="keys"]')).not.toBeNull();
    // Straight to the API keys.
    expect(container.textContent).toContain("Claude API");
  });
});

describe("conversation actions", () => {
  it("sends, stops, and asks for approval without calling approval a completed write", () => {
    render();
    type(container.querySelector("textarea")!, "Explain this rule");
    click(button("Send"));
    expect(agent.sendChat).toHaveBeenCalledWith("Explain this rule", undefined);
    expect(container.querySelector("textarea")!.value).toBe("");
    const pending: FeedItem = { kind: "approval", id: "approve", summary: "Update", ops: ["Update a record"], status: "pending" };
    render({ running: true, feed: [pending] });
    click(button("Approve"));
    expect(agent.approve).toHaveBeenCalledWith("approve", true);
    click(button("Reject"));
    expect(agent.approve).toHaveBeenCalledWith("approve", false);
    click(button("Stop"));
    expect(agent.stop).toHaveBeenCalledOnce();
    render({ feed: [{ ...pending, status: "approved" } as FeedItem] });
    expect(container.textContent).toContain("Approved");
    expect(container.textContent).not.toContain("Applied");
  });

  it("marks a step whose outcome is unknown instead of showing it as done or failed", () => {
    render({ feed: [{ kind: "tools", id: "t", tools: [{ id: "w", name: "update_record", label: "Update incident", status: "unknown", summary: "outcome unknown — verify" }] }] });
    const step = container.querySelector(".trace-step-unknown")!;
    expect(step.querySelector('[role="img"]')?.getAttribute("aria-label")).toBe("Outcome unknown");
    expect(step.textContent).toContain("verify");
  });

  it("offers Resume only on the latest resumable run, and not while one is running", () => {
    const notice: FeedItem = { kind: "notice", id: "n", tone: "warning", runId: "run_1", text: "Chrome restarted the extension's background worker during this run, so it stopped." };
    const run = { id: "run_1", status: "interrupted" as const, host: "exampledev.service-now.com", startedAt: 1, failure: "worker_restarted" as const, resumable: true };
    render({ feed: [notice], run });
    click(button("Resume"));
    expect(agent.resume).toHaveBeenCalledWith("run_1");
    render({ feed: [notice], run, running: true });
    expect(container.textContent).not.toContain("Resume");
    render({ feed: [notice], run: { ...run, id: "run_2" } });
    expect(container.textContent).not.toContain("Resume");
  });

  it("renders commands in error text as code, and never as markup", () => {
    render({ feed: [{ kind: "error", id: "e", text: "The extension was updated. Reload it from `chrome://extensions` <b>now</b>." }] });
    const callout = container.querySelector(".callout-danger")!;
    expect(callout.querySelector("code")?.textContent).toBe("chrome://extensions");
    expect(callout.querySelector("b")).toBeNull();
    expect(callout.textContent).toContain("<b>now</b>");
  });
});
