// The model picker: provider tabs, the provider's live catalog (no hard-coded
// model list), search within the provider, one list with a clear selection,
// and a model id typed in for anything the catalog doesn't list. Choosing
// writes the provider and model in one patch. A model that takes a reasoning
// effort offers exactly its levels; one that doesn't offers nothing.

import React, { act, createRef } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { ModelPicker } from "../../src/sidepanel/components/ModelPicker";
import { EMPTY_COST, type ModelListEntry, type PublicSettings } from "../../src/shared/types";
import type { AgentApi } from "../../src/sidepanel/hooks/useAgent";
import { fakeAgent, publicSettings } from "../fixtures/chat";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CLAUDE: ModelListEntry[] = [
  { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
  { id: "claude-opus-5", name: "Claude Opus 5" },
  { id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
];
const OPENAI: ModelListEntry[] = [{ id: "gpt-5.5", name: "gpt-5.5" }, { id: "gpt-5.4-mini", name: "gpt-5.4-mini" }, { id: "gpt-4.1", name: "gpt-4.1" }];
const lists = { anthropic: { models: CLAUDE, loading: false }, openai: { models: OPENAI, loading: false } };
const bothKeys = { anthropic: true, openai: true, openrouter: false };

function mount(over: Partial<PublicSettings> = {}, agentOver: Partial<AgentApi> = {}) {
  const patchSettings = vi.fn();
  const listModels = vi.fn();
  const onAddKey = vi.fn();
  const agent = fakeAgent({ patchSettings, listModels, modelLists: lists, cost: { ...EMPTY_COST }, ...agentOver });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const anchor = createRef<HTMLDivElement>();
  act(() => {
    createRoot(container).render(
      <div ref={anchor}>
        <ModelPicker settings={publicSettings(over)} agent={agent} anchorRef={anchor} onAddKey={onAddKey} />
      </div>
    );
  });
  const click = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  const q = <T extends Element = HTMLElement>(sel: string) => container.querySelector<T>(sel);
  const all = (sel: string) => Array.from(container.querySelectorAll<HTMLElement>(sel));
  return {
    container, patchSettings, listModels, onAddKey, click, q, all,
    open: () => click(q(".model-trigger")!),
    tab: (label: string) => all('[role="tab"]').find((t) => t.textContent === label)!,
    item: (name: string) => all(".picker-item").find((b) => b.querySelector(".picker-item-name")?.textContent === name)!,
    names: () => all(".picker-item-name").map((n) => n.textContent),
    type: (text: string, selector = ".picker-search input") => act(() => {
      const input = container.querySelector<HTMLInputElement>(selector)!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }),
  };
}

describe("model picker", () => {
  it("names the provider and the model by the catalog's name on the trigger", () => {
    expect(mount().q(".model-trigger")!.textContent).toBe("Claude·Claude Sonnet 5");
    // Before any catalog has loaded, the id itself; with nothing chosen, an invitation.
    expect(mount({}, { modelLists: {} }).q(".model-trigger")!.textContent).toBe("Claude·claude-sonnet-5");
    expect(mount({ models: { anthropic: "", openai: "", openrouter: "" } }, { modelLists: {} }).q(".model-trigger")!.textContent).toBe("Claude·Choose a model");
  });

  it("loads the catalog of the provider in use as soon as it has a key", () => {
    expect(mount().listModels).toHaveBeenCalledWith("anthropic");
    expect(mount({ keysPresent: { anthropic: false, openai: false, openrouter: false } }).listModels).not.toHaveBeenCalled();
  });

  it("opens on the provider in use, with tabs, search and a selected row", () => {
    const p = mount();
    p.open();
    expect(p.q('[role="dialog"]')?.getAttribute("aria-label")).toBe("Choose a model");
    expect(p.all('[role="tab"]').map((t) => t.textContent)).toEqual(["Claude", "OpenAI", "OpenRouter"]);
    expect(p.tab("Claude").getAttribute("aria-selected")).toBe("true");
    expect(p.item("Claude Sonnet 5").getAttribute("aria-pressed")).toBe("true");
    expect(p.item("Claude Sonnet 5").querySelector(".picker-item-hint")?.textContent).toBe("claude-sonnet-5");
    expect(document.activeElement).toBe(p.q(".picker-search input"));
  });

  it("lists only what the provider returned, loading every catalog it holds a key for", () => {
    const p = mount({ keysPresent: bothKeys });
    p.open();
    expect(p.names()).toEqual(["Claude Sonnet 5", "Claude Opus 5", "Claude Haiku 4.5"]);
    expect(p.listModels).toHaveBeenCalledWith("anthropic");
    expect(p.listModels).toHaveBeenCalledWith("openai");
    expect(p.listModels).not.toHaveBeenCalledWith("openrouter");
  });

  it("shows loading and errors honestly, with a way to try again", () => {
    const loading = mount({}, { modelLists: { anthropic: { models: [], loading: true } } });
    loading.open();
    expect(loading.container.textContent).toContain("Loading Claude models…");
    expect(loading.q('[aria-label="Loading models"]')).not.toBeNull();

    const failed = mount({}, { modelLists: { anthropic: { models: [], loading: false, error: "API key was rejected" } } });
    failed.open();
    expect(failed.q('[role="alert"]')?.textContent).toContain("Couldn’t load Claude models (API key was rejected).");
    failed.click(Array.from(failed.container.querySelectorAll("button")).find((b) => b.textContent === "Try again")!);
    expect(failed.listModels).toHaveBeenLastCalledWith("anthropic", true);
    // The model in use stays visible and selected even when the list failed.
    expect(failed.names()).toEqual(["claude-sonnet-5"]);
  });

  it("searches within the selected provider only", () => {
    const p = mount({ keysPresent: bothKeys });
    p.open();
    p.type("haiku");
    expect(p.names()).toEqual(["Claude Haiku 4.5"]);
    p.click(p.tab("OpenAI"));
    expect(p.names()).toEqual(["gpt-5.5", "gpt-5.4-mini", "gpt-4.1"]);
  });

  it("explains a provider without a key instead of pretending it is connected", () => {
    const p = mount();
    p.open();
    p.click(p.tab("OpenRouter"));
    expect(p.container.textContent).toContain("OpenRouter needs an API key");
    expect(p.all(".picker-item")).toHaveLength(0);
    p.click(Array.from(p.container.querySelectorAll("button")).find((b) => b.textContent === "Add a key in Settings")!);
    expect(p.onAddKey).toHaveBeenCalledOnce();
  });

  it("commits provider and model in one patch, switching provider from another tab", () => {
    const p = mount({ keysPresent: bothKeys });
    p.open();
    p.click(p.item("Claude Opus 5"));
    expect(p.patchSettings).toHaveBeenCalledWith({ provider: "anthropic", models: { anthropic: "claude-opus-5" } });
    expect(p.q('[role="dialog"]')).toBeNull();
    p.open();
    p.click(p.tab("OpenAI"));
    p.click(p.item("gpt-5.5"));
    expect(p.patchSettings).toHaveBeenLastCalledWith({ provider: "openai", models: { openai: "gpt-5.5" } });
  });

  it("takes a model id the catalog doesn't list, and keeps it visible and selected", () => {
    const p = mount();
    p.open();
    p.click(Array.from(p.container.querySelectorAll("button")).find((b) => b.textContent === "Use a model id…")!);
    p.type("claude-preview-x", ".picker-custom input");
    p.click(Array.from(p.container.querySelectorAll("button")).find((b) => b.textContent === "Use")!);
    expect(p.patchSettings).toHaveBeenCalledWith({ provider: "anthropic", models: { anthropic: "claude-preview-x" } });

    const custom = mount({ provider: "openrouter", keysPresent: { anthropic: false, openai: false, openrouter: true }, models: { anthropic: "", openai: "", openrouter: "vendor/custom-model" } }, { modelLists: {} });
    custom.open();
    expect(custom.tab("OpenRouter").getAttribute("aria-selected")).toBe("true");
    const selected = custom.all(".picker-item").find((b) => b.getAttribute("aria-pressed") === "true")!;
    expect(selected.textContent).toContain("custom-model");
  });

  describe("effort", () => {
    const onOpenAi = (over: Partial<PublicSettings> = {}) =>
      mount({ provider: "openai", keysPresent: bothKeys, models: { anthropic: "claude-sonnet-5", openai: "gpt-5.5", openrouter: "" }, ...over });
    const chips = (p: ReturnType<typeof mount>) => p.all(".effort-chip").map((c) => [c.textContent, c.getAttribute("aria-pressed")]);
    const chip = (p: ReturnType<typeof mount>, label: string) => p.all(".effort-chip").find((c) => c.textContent === label)!;

    it("offers exactly the levels the model in use takes, with its own default in effect", () => {
      const p = onOpenAi();
      p.open();
      expect(p.q(".picker-effort-label")!.textContent).toBe("Effort for gpt-5.5");
      expect(chips(p)).toEqual([
        ["Default", "true"], ["None", "false"], ["Low", "false"], ["Medium", "false"], ["High", "false"], ["Extra high", "false"],
      ]);
      expect(chip(p, "Default").title).toBe("The model's own setting (Medium)");
    });

    it("isn't there for a model that takes none", () => {
      const noEffort = onOpenAi({ models: { anthropic: "", openai: "gpt-4.1", openrouter: "" } });
      noEffort.open();
      expect(noEffort.q(".picker-effort")).toBeNull();
      // Claude's catalog says which models take one; these entries list none.
      const claude = mount();
      claude.open();
      expect(claude.q(".picker-effort")).toBeNull();
    });

    it("comes from the catalog for Claude", () => {
      const p = mount({}, { modelLists: { anthropic: { models: [{ id: "claude-sonnet-5", name: "Claude Sonnet 5", efforts: ["low", "medium", "high", "xhigh", "max"] }], loading: false } } });
      p.open();
      expect(chips(p).map(([label]) => label)).toEqual(["Default", "Low", "Medium", "High", "Extra high", "Max"]);
      expect(chip(p, "Default").title).toBe("The model's own setting");
    });

    it("shows up when a model that takes one is picked, and choosing a level saves it and closes", () => {
      const p = mount({ keysPresent: bothKeys });
      p.open();
      p.click(p.tab("OpenAI"));
      p.click(p.item("gpt-5.4-mini"));
      expect(p.patchSettings).toHaveBeenCalledWith({ provider: "openai", models: { openai: "gpt-5.4-mini" } });
      expect(p.q('[role="dialog"]')).not.toBeNull();
      expect(p.q(".picker-effort-label")!.textContent).toBe("Effort for gpt-5.4-mini");
      expect(document.activeElement).toBe(chip(p, "Default"));
      p.click(chip(p, "High"));
      expect(p.patchSettings).toHaveBeenLastCalledWith({ effort: { provider: "openai", model: "gpt-5.4-mini", level: "high" } });
      expect(p.q('[role="dialog"]')).toBeNull();
    });

    it("picking a model that takes none closes as before", () => {
      const p = onOpenAi();
      p.open();
      p.click(p.item("gpt-4.1"));
      expect(p.q('[role="dialog"]')).toBeNull();
    });

    it("shows a saved level as chosen and names it on the trigger; Default clears it", () => {
      const p = onOpenAi({ efforts: { "openai:gpt-5.5": "high" } });
      expect(p.q(".model-trigger")!.title).toBe("OpenAI · gpt-5.5 · High effort");
      p.open();
      expect(chip(p, "High").getAttribute("aria-pressed")).toBe("true");
      p.click(chip(p, "Default"));
      expect(p.patchSettings).toHaveBeenLastCalledWith({ effort: { provider: "openai", model: "gpt-5.5", level: null } });
    });

    it("falls back to Default when the saved level isn't one the model takes", () => {
      const p = onOpenAi({ efforts: { "openai:gpt-5.5": "max" } });
      expect(p.q(".model-trigger")!.title).toBe("OpenAI · gpt-5.5");
      p.open();
      expect(chip(p, "Default").getAttribute("aria-pressed")).toBe("true");
    });
  });

  it("closes on Escape and returns focus to the trigger", () => {
    const p = mount();
    p.open();
    act(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(p.q('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(p.q(".model-trigger"));
  });
});
