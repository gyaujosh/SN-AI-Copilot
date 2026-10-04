// Settings: AI Access leads with the providers' API keys (official marks, live
// key status, never shown back); Instances are the user's own, each with an
// environment that decides whether the agent may change anything there.

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppView } from "../../src/sidepanel/App";
import { DEV_HOST, INSTANCES, fakeAgent, publicSettings } from "../fixtures/chat";
import type { AgentApi } from "../../src/sidepanel/hooks/useAgent";

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
const buttons = () => Array.from(container.querySelectorAll("button"));
const button = (label: string) => {
  const match = buttons().find((b) => b.getAttribute("aria-label") === label || b.textContent?.trim() === label);
  expect(match, `Button: ${label}`).toBeTruthy();
  return match!;
};
const type = (el: HTMLInputElement, text: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, text);
  el.dispatchEvent(new Event("input", { bubbles: true }));
});
const choose = (select: HTMLSelectElement, value: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, value);
  select.dispatchEvent(new Event("change", { bubbles: true }));
});
/** The environment chosen in the Add form, by its label's role id. */
const environmentChip = (label: string) => Array.from(container.querySelectorAll<HTMLButtonElement>('.env-options [role="radio"]')).find((b) => b.textContent === label)!;
const environment = () => {
  const label = container.querySelector('.env-options [aria-checked="true"]')?.textContent;
  return ({ Sandbox: "sand", Development: "dev", Test: "test", Stage: "stage", Production: "prod" } as Record<string, string>)[label ?? ""];
};
const lastPatch = () => (agent.patchSettings as any).mock.calls.at(-1)[0];
function mount(overrides: Partial<AgentApi> = {}, section: string | null = null) {
  agent = fakeAgent({ patchSettings: vi.fn(), switchInstance: vi.fn(), listModels: vi.fn(), ...overrides });
  act(() => root.render(<AppView agent={agent} initialView="settings" initialSection={section} />));
}
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  HTMLElement.prototype.scrollTo = vi.fn();
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks(); });

describe("AI Access", () => {
  it("lists every provider's API key with its own mark, and checks the saved ones", () => {
    mount({ settings: publicSettings({ keysPresent: { anthropic: true, openai: true, openrouter: false } }) });
    const section = container.querySelector('[data-section="keys"]')!;
    expect(Array.from(section.querySelectorAll(".key-row .card-row-title")).map((t) => t.textContent)).toEqual(["Claude APIIn use", "OpenAI API", "OpenRouter API"]);
    expect(section.querySelector('[data-provider="claude"] img')).not.toBeNull();
    expect(section.querySelector('[data-provider="openai"] img')).not.toBeNull();
    // Loading a saved key's catalog is how the key is checked — including a
    // provider that isn't in use (the chat's model picker only loads its own).
    expect(agent.listModels).toHaveBeenCalledWith("openai");
    expect(agent.listModels).not.toHaveBeenCalledWith("openrouter");
  });

  it("says what is known about each key", () => {
    mount({
      settings: publicSettings({ keysPresent: { anthropic: true, openai: true, openrouter: false } }),
      modelLists: { anthropic: { models: [{ id: "a", name: "A" }, { id: "b", name: "B" }], loading: false }, openai: { models: [], loading: false, error: "API key was rejected" } },
    });
    const status = Array.from(container.querySelectorAll(".key-row .card-row-sub")).map((s) => s.textContent);
    expect(status).toEqual(["Key saved · 2 models", "Key rejected — paste a new one", "Not set"]);
  });

  it("never shows a stored key, and saves what was typed on leaving", () => {
    mount();
    expect(container.querySelector('input[type="password"]')).toBeNull();
    click(buttons().find((b) => b.textContent?.startsWith("OpenAI API"))!);
    const input = container.querySelector<HTMLInputElement>('input[type="password"]')!;
    expect(input.value).toBe("");
    expect(container.querySelector('.key-row-edit a')?.getAttribute("href")).toBe("https://platform.openai.com/api-keys");
    type(input, "sk-test-value");
    act(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(agent.patchSettings).toHaveBeenCalledWith({ apiKeys: { openai: "sk-test-value" } });
  });

  it("removes a saved key, keeps focus in the row, and offers removal only where a key is saved", () => {
    mount();
    click(buttons().find((b) => b.textContent?.startsWith("OpenRouter API"))!);
    expect(buttons().some((b) => b.textContent?.includes("Remove key"))).toBe(false);
    click(buttons().find((b) => b.textContent?.startsWith("Claude API"))!);
    click(button("Remove key"));
    expect(lastPatch()).toEqual({ apiKeys: { anthropic: "" } });
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Claude API key");
  });

  it("saves a typed key even when the whole panel closes", () => {
    mount();
    click(buttons().find((b) => b.textContent?.startsWith("OpenAI API"))!);
    type(container.querySelector<HTMLInputElement>('input[type="password"]')!, "sk-closing");
    act(() => { window.dispatchEvent(new Event("pagehide")); });
    expect(agent.patchSettings).toHaveBeenCalledWith({ apiKeys: { openai: "sk-closing" } });
  });
});

describe("Instances", () => {
  it("lists the user's instances with an environment each, and one Add action", () => {
    mount({}, "instances");
    const section = container.querySelector('[data-section="instances"]')!;
    const adds = Array.from(section.querySelectorAll("button")).filter((b) => /^\s*Add/.test(b.textContent || ""));
    expect(adds).toHaveLength(1);
    const rows = Array.from(section.querySelectorAll(".inst-row"));
    expect(rows.map((r) => r.querySelector(".card-row-title")?.textContent)).toEqual(["Dev", "Test", "Prod"]);
    expect(rows[0].textContent).toContain("Active");
    expect(rows[0].textContent).toContain("Changes allowed");
    expect(rows[1].textContent).toContain("Changes allowed");
    expect(rows[2].textContent).toContain("Read-only");
    click(button("Use Test"));
    expect(agent.switchInstance).toHaveBeenCalledWith("test");
  });

  it("changes an instance's environment and removes an instance, as edits to the stored list", () => {
    mount({}, "instances");
    choose(container.querySelector<HTMLSelectElement>('select[aria-label="Environment for Prod"]')!, "dev");
    expect(lastPatch()).toEqual({ instanceOps: [{ op: "role", id: "prod", role: "dev" }] });
    click(button("Remove Test"));
    expect(lastPatch()).toEqual({ instanceOps: [{ op: "remove", id: "test" }] });
  });

  it("validates a new instance and suggests its environment from the host", () => {
    mount({}, "instances");
    click(buttons().find((b) => b.textContent?.includes("Add instance"))!);
    const host = container.querySelector<HTMLInputElement>('input[aria-label="Instance host"]')!;
    expect(environment()).toBe("dev");
    expect(container.querySelector(".env-effect")?.textContent).toMatch(/Changes allowed/);
    type(host, "not a host");
    click(button("Add"));
    expect(container.querySelector('[role="alert"]')?.textContent).toMatch(/ServiceNow host/);
    type(host, "acme.service-now.com");
    expect(environment()).toBe("prod");
    expect(container.querySelector(".env-effect")?.textContent).toMatch(/Read-only/);
    type(host, "https://mypdi-dev.service-now.com/nav");
    expect(environment()).toBe("dev");
    click(button("Add"));
    expect(lastPatch().instanceOps).toEqual([{ op: "add", instance: expect.objectContaining({ host: "mypdi-dev.service-now.com", label: "mypdi-dev", role: "dev" }) }]);
  });

  it("keeps the environment the user chose over the suggestion", () => {
    mount({}, "instances");
    click(buttons().find((b) => b.textContent?.includes("Add instance"))!);
    click(environmentChip("Test"));
    type(container.querySelector<HTMLInputElement>('input[aria-label="Instance host"]')!, "acmedev.service-now.com");
    click(button("Add"));
    expect(lastPatch().instanceOps[0].instance).toMatchObject({ host: "acmedev.service-now.com", role: "test" });
  });

  it("offers the tab in view when it isn't added yet, prefilled — even while another instance is pinned", () => {
    const host = "dev12345.service-now.com";
    mount({ viewedHost: host, settings: publicSettings({ pinnedInstanceId: "prod", activeInstanceId: "prod" }) }, "instances");
    expect(container.querySelector(".inst-suggest")?.textContent).toContain("not added · changes allowed");
    click(button(`Add ${host}`));
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Instance host"]')!.value).toBe(host);
    expect(environment()).toBe("dev");
    click(button("Add"));
    expect(lastPatch().instanceOps[0].instance).toMatchObject({ host, label: "dev12345", role: "dev" });
  });

  it("explains what to do when there are no instances yet", () => {
    mount({ settings: publicSettings({ instances: [], activeInstanceId: null }), connection: { phase: "unavailable", host: null, checkedAt: Date.now(), reason: "no_tab" }, ctx: null, viewedHost: null }, "instances");
    expect(container.querySelector(".inst-empty")?.textContent).toMatch(/Open any ServiceNow tab/);
    expect(container.querySelector(".inst-row")).toBeNull();
  });

  it("marks the instance the agent works on as active", () => {
    mount({ settings: publicSettings({ instances: INSTANCES, pinnedInstanceId: "prod", activeInstanceId: "prod" }) }, "instances");
    const active = Array.from(container.querySelectorAll(".inst-row")).find((r) => r.textContent?.includes("Active"));
    expect(active?.querySelector(".card-row-sub")?.textContent).toBe("example.service-now.com");
    expect(active?.textContent).not.toContain(DEV_HOST);
  });
});

describe("keyboard", () => {
  it("moves between sections and options with arrow keys, one tab stop per group", () => {
    mount();
    const tabs = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    expect(tabs.map((t) => t.tabIndex)).toEqual([0, -1, -1]);
    act(() => tabs[0].focus());
    act(() => { tabs[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); });
    expect(container.querySelector('[role="tabpanel"]')?.getAttribute("data-section")).toBe("instances");
    expect(document.activeElement?.textContent).toBe("Instances");
    act(() => { (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })); });
    expect(container.querySelector('[role="tabpanel"]')?.getAttribute("aria-labelledby")).toBe("settings-tab-appearance");
    const size = container.querySelector('[role="radiogroup"][aria-label="Text size"]')!;
    const checked = size.querySelector<HTMLButtonElement>('[aria-checked="true"]')!;
    expect(Array.from(size.querySelectorAll<HTMLButtonElement>('[role="radio"]')).filter((r) => r.tabIndex === 0)).toEqual([checked]);
    act(() => { checked.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })); });
    expect(size.querySelector('[aria-checked="true"]')?.textContent).not.toBe(checked.textContent);
  });
});

describe("Appearance", () => {
  it("switches theme and text size, with a preview of chat text", async () => {
    mount({}, "appearance");
    click(container.querySelector('[role="radio"].theme-card-dark')!);
    expect(document.documentElement.dataset.theme).toBe("dark");
    const size = container.querySelector('[role="radiogroup"][aria-label="Text size"]')!;
    click(Array.from(size.querySelectorAll('[role="radio"]')).find((r) => r.textContent === "Small")!);
    expect(document.documentElement.dataset.textsize).toBe("sm");
    expect(container.querySelector(".text-preview")?.textContent).toBe("This is how your chat text will look.");
    expect((await chrome.storage.local.get(["theme", "textSize"]))).toEqual({ theme: "dark", textSize: "sm" });
  });
});
