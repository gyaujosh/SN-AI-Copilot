// The pinnable bottom navigation: pinned by default; set to auto-hide, it
// opens while hovered or keyboard-focused. Its pin is one preference shared
// with Appearance — stored on its own, never touching the instance pin.

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppView } from "../../src/sidepanel/App";
import { fakeAgent } from "../fixtures/chat";
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
const nav = () => container.querySelector<HTMLElement>("nav.bottom-nav")!;
const open = () => nav().classList.contains("bottom-nav-open");
const pin = () => container.querySelector<HTMLButtonElement>(".nav-pin")!;
const click = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
const pointer = (type: "pointerover" | "pointerout", el: Element, relatedTarget: Element | null = null) =>
  act(() => { el.dispatchEvent(new MouseEvent(type, { bubbles: true, relatedTarget })); });
async function mount(overrides: Partial<AgentApi> = {}) {
  agent = fakeAgent({ patchSettings: vi.fn(), ...overrides });
  act(() => root.render(<AppView agent={agent} />));
  await act(async () => { await Promise.resolve(); });
}
beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  HTMLElement.prototype.scrollTo = vi.fn();
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe("bottom navigation", () => {
  it("sits in the layout below the views, so retracting it gives the composer its space", async () => {
    await mount();
    const shell = container.querySelector(".app-shell")!;
    expect(shell.lastElementChild).toBe(nav());
    expect(nav().previousElementSibling?.classList.contains("app-main")).toBe(true);
    expect(container.querySelector(".app-main .composer")).not.toBeNull();
  });

  it("is pinned by default, and stays open without hover", async () => {
    await mount();
    expect(open()).toBe(true);
    expect(pin().getAttribute("aria-pressed")).toBe("true");
    pointer("pointerout", nav(), document.body);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(open()).toBe(true);
  });

  it("set to auto-hide, opens on hover and retracts after the pointer leaves", async () => {
    await chrome.storage.local.set({ navPinned: false });
    await mount();
    expect(open()).toBe(false);
    expect(pin().getAttribute("aria-pressed")).toBe("false");
    pointer("pointerover", nav(), document.body);
    expect(open()).toBe(true);
    pointer("pointerout", nav(), document.body);
    expect(open()).toBe(true); // grace period: no flicker at the edge
    act(() => { vi.advanceTimersByTime(500); });
    expect(open()).toBe(false);
  });

  it("set to auto-hide, opens for keyboard focus and keeps its buttons in the tab order while retracted", async () => {
    await chrome.storage.local.set({ navPinned: false });
    await mount();
    const history = Array.from(nav().querySelectorAll("button")).find((b) => b.textContent === "History")!;
    expect(history.tabIndex).toBe(0);
    act(() => history.focus());
    expect(open()).toBe(true);
    act(() => (container.querySelector("textarea") as HTMLTextAreaElement).focus());
    act(() => { vi.advanceTimersByTime(300); });
    expect(open()).toBe(false);
  });

  it("stores the pin on its own, without touching the instance pin, and mirrors it in Appearance", async () => {
    await chrome.storage.local.set({ navPinned: false });
    await mount();
    click(pin());
    expect(open()).toBe(true);
    expect(pin().getAttribute("aria-label")).toBe("Pin navigation");
    expect(pin().getAttribute("aria-pressed")).toBe("true");
    expect((await chrome.storage.local.get("navPinned")).navPinned).toBe(true);
    expect(agent.patchSettings).not.toHaveBeenCalled();
    // Pinned stays open without hover.
    pointer("pointerout", nav(), document.body);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(open()).toBe(true);

    click(Array.from(nav().querySelectorAll("button")).find((b) => b.textContent === "Settings")!);
    click(Array.from(container.querySelectorAll('[role="tab"]')).find((t) => t.textContent === "Appearance")!);
    const group = container.querySelector('[role="radiogroup"][aria-label="Bottom navigation"]')!;
    const pinned = Array.from(group.querySelectorAll('[role="radio"]')).find((r) => r.textContent === "Pinned")!;
    expect(pinned.getAttribute("aria-checked")).toBe("true");
    click(Array.from(group.querySelectorAll('[role="radio"]')).find((r) => r.textContent === "Auto-hide")!);
    expect(pin().getAttribute("aria-pressed")).toBe("false");
    expect((await chrome.storage.local.get("navPinned")).navPinned).toBe(false);
  });

  it("honours a saved auto-hide preference", async () => {
    await chrome.storage.local.set({ navPinned: false });
    await mount();
    expect(open()).toBe(false);
    expect(pin().getAttribute("aria-pressed")).toBe("false");
  });
});
