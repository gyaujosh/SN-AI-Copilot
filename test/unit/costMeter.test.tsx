// Spend while working and after: the composer shows what this chat has cost
// so far — dollars and tokens — from its first model call, with a breakdown
// one click away; History shows what each saved chat cost.

import React, { act, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CostMeter } from "../../src/sidepanel/components/CostMeter";
import { HistoryPanel } from "../../src/sidepanel/components/HistoryPanel";
import { EMPTY_COST, type SessionCost, type SessionMeta } from "../../src/shared/types";
import { chatFeed, fakeAgent } from "../fixtures/chat";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SPENT: SessionCost = {
  usd: 0.0421, turnUsd: 0.0187, inputTokens: 14_210, outputTokens: 1_830, cacheReadTokens: 22_400,
  requests: 4, estimatedRequests: 0, reportedRequests: 0,
};

let root: Root | null = null;
let container: HTMLDivElement;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container?.remove();
});

function mountMeter(cost: SessionCost, running = false) {
  container = document.createElement("div");
  document.body.appendChild(container);
  const anchor = createRef<HTMLDivElement>();
  root = createRoot(container);
  const render = (next: SessionCost, busy = running) =>
    act(() => {
      root!.render(<div ref={anchor}><CostMeter cost={next} running={busy} anchorRef={anchor} /></div>);
    });
  render(cost);
  const q = (sel: string) => container.querySelector<HTMLElement>(sel);
  return { render, q, click: (el: Element) => act(() => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); }) };
}

describe("the cost meter", () => {
  it("stays out of the way until the first model call", () => {
    const { q, render } = mountMeter({ ...EMPTY_COST });
    expect(q(".cost-meter")).toBeNull();
    render(SPENT);
    expect(q(".cost-meter")).not.toBeNull();
  });

  it("shows this chat's dollars and tokens at a glance", () => {
    const { q } = mountMeter(SPENT);
    expect(q(".cost-meter-usd")!.textContent).toBe("$0.04");
    expect(q(".cost-meter-tokens")!.textContent).toBe("38.4k tokens");
    expect(q(".cost-meter")!.getAttribute("aria-label")).toBe("This chat so far: $0.04, 38,440 tokens. Show cost details");
  });

  it("follows the spend live as calls come in", () => {
    const { q, render } = mountMeter(SPENT, true);
    render({ ...SPENT, usd: 0.3187, outputTokens: 9_000, requests: 5 }, true);
    expect(q(".cost-meter-usd")!.textContent).toBe("$0.32");
    expect(q(".cost-meter-tokens")!.textContent).toBe("45.6k tokens");
  });

  it("breaks the total down, and closes on Escape with focus back on the meter", () => {
    const { q, click } = mountMeter(SPENT);
    click(q(".cost-meter")!);
    const pop = q('[role="dialog"]')!;
    expect(pop.getAttribute("aria-label")).toBe("Cost of this chat");
    expect(q(".cost-total-usd")!.textContent).toBe("$0.0421");
    const rows = Array.from(pop.querySelectorAll(".cost-rows > div")).map((r) => [r.querySelector("dt")!.textContent, r.querySelector("dd")!.textContent]);
    expect(rows).toEqual([
      ["Latest answer", "$0.0187"],
      ["Input tokens", "14,210"],
      ["Cached input tokens", "22,400"],
      ["Output tokens", "1,830"],
      ["Total tokens", "38,440"],
      ["Model calls", "4"],
    ]);
    expect(pop.textContent).toContain("A new chat starts again at $0. Each chat's total is saved with it in History.");

    act(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(q('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(q(".cost-meter"));
  });

  it("names the answer in progress while one is running", () => {
    const { q, click } = mountMeter(SPENT, true);
    click(q(".cost-meter")!);
    expect(q(".cost-rows dt")!.textContent).toBe("This answer so far");
  });

  it("marks a total that includes estimates, and says OpenRouter's figures are exact", () => {
    const rough = mountMeter({ ...SPENT, estimatedRequests: 1 });
    expect(rough.q(".cost-meter-usd")!.textContent).toBe("≈ $0.04");
    rough.click(rough.q(".cost-meter")!);
    expect(rough.q(".cost-pop")!.textContent).toContain("1 call is a rough estimate");
    act(() => root?.unmount());
    root = null;
    container.remove();

    const exact = mountMeter({ ...SPENT, reportedRequests: 4 });
    exact.click(exact.q(".cost-meter")!);
    expect(exact.q(".cost-pop")!.textContent).toContain("Exact cost, as reported by OpenRouter.");
  });

  it("goes away with the chat when a new one starts", () => {
    const { q, click, render } = mountMeter(SPENT);
    click(q(".cost-meter")!);
    render({ ...EMPTY_COST });
    expect(q(".cost-meter")).toBeNull();
    render({ ...SPENT, usd: 0.001, requests: 1 });
    expect(q('[role="dialog"]')).toBeNull();
  });
});

describe("History", () => {
  const sessions: SessionMeta[] = [
    {
      id: "a", title: "Find incidents", at: Date.now(), items: 3, usd: 0.1284,
      cost: { usd: 0.1284, inputTokens: 38_120, outputTokens: 5_210, cacheReadTokens: 96_400, requests: 9, estimatedRequests: 0, reportedRequests: 0 },
    },
    { id: "b", title: "Saved before tokens were counted", at: Date.now(), items: 6, usd: 0.0316 },
    { id: "c", title: "Saved before costs were counted", at: Date.now(), items: 2 },
  ];

  function mountHistory(detail: { id: string; feed: typeof chatFeed } | null = null) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const agent = fakeAgent({ sessions, sessionDetail: detail, listSessions: vi.fn(), clearSessionDetail: vi.fn() });
    act(() => { root!.render(<HistoryPanel open onClose={() => {}} agent={agent} />); });
    return container;
  }

  it("shows what each saved chat cost", () => {
    const meta = Array.from(mountHistory().querySelectorAll(".hist-meta")).map((m) => m.querySelector(".hist-spend")?.textContent ?? null);
    expect(meta).toEqual(["$0.13 · 140k tokens", "$0.03", null]);
  });

  it("breaks down an opened chat's cost", () => {
    const line = mountHistory({ id: "a", feed: chatFeed }).querySelector(".hist-cost")!;
    expect(Array.from(line.querySelectorAll("p")).map((p) => p.textContent)).toEqual([
      "$0.1284 spent · 140k tokens · 9 model calls",
      "38.1k in · 96.4k cached · 5.2k out",
    ]);
    expect(line.getAttribute("title")).toMatch(/^Estimated from list prices/);
  });

  it("shows only the dollars for a chat saved before tokens were counted", () => {
    expect(mountHistory({ id: "b", feed: chatFeed }).querySelector(".hist-cost")!.textContent).toBe("$0.0316 spent");
    act(() => root?.unmount());
    root = null;
    container.remove();
    expect(mountHistory({ id: "c", feed: chatFeed }).querySelector(".hist-cost")).toBeNull();
  });
});
