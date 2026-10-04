// Settings: API keys stay in the background, a key saved for a keyless setup
// selects its provider (deleting one never re-routes data), instances always
// carry a role (read-only when the user chose Production), team
// presets only seed a list the user has never edited, and concurrent changes
// never overwrite each other.

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/background/presets", () => ({ presetInstances: vi.fn(() => []) }));

import { presetInstances } from "../../src/background/presets";
import { getSettings, patchSettings, removeRetiredSettings, sanitizeInstances, setDefaultModel, toPublicSettings } from "../../src/background/settings";
import { DEV_HOST, INSTANCES, PROD_HOST } from "../fixtures/chat";

beforeEach(() => {
  vi.mocked(presetInstances).mockReturnValue([]);
});

describe("a fresh install", () => {
  it("starts on Claude with no keys, models or instances, following the tab", async () => {
    const s = await getSettings();
    expect(s).toEqual({
      provider: "anthropic",
      models: { anthropic: "", openai: "", openrouter: "" },
      efforts: {},
      apiKeys: { anthropic: "", openai: "", openrouter: "" },
      instances: [],
      activeInstanceId: null,
      pinnedInstanceId: null,
    });
  });

  it("stores nothing until something is changed", async () => {
    await getSettings();
    expect(await chrome.storage.local.get(null)).toEqual({});
  });
});

describe("effort", () => {
  it("is kept per model, and Default forgets the choice", async () => {
    await patchSettings({ effort: { provider: "openai", model: "gpt-6-sol", level: "high" } });
    await patchSettings({ effort: { provider: "anthropic", model: "claude-sonnet-5", level: "low" } });
    expect((await getSettings()).efforts).toEqual({ "openai:gpt-6-sol": "high", "anthropic:claude-sonnet-5": "low" });
    expect((await toPublicSettings(await getSettings())).efforts).toEqual({ "openai:gpt-6-sol": "high", "anthropic:claude-sonnet-5": "low" });
    await patchSettings({ effort: { provider: "openai", model: "gpt-6-sol", level: null } });
    expect((await getSettings()).efforts).toEqual({ "anthropic:claude-sonnet-5": "low" });
  });

  it("ignores levels and providers it doesn't know, stored or sent", async () => {
    await patchSettings({ effort: { provider: "openai", model: "gpt-6-sol", level: "extreme" as never } });
    await patchSettings({ effort: { provider: "elsewhere" as never, model: "m", level: "high" } });
    expect((await getSettings()).efforts).toEqual({});
    await chrome.storage.local.set({ modelEfforts: { "openai:gpt-5.5": "medium", "openai:gpt-6-sol": 7, "nowhere:m": "high", "openai:": "low", junk: "high" } });
    expect((await getSettings()).efforts).toEqual({ "openai:gpt-5.5": "medium" });
  });
});

describe("API keys", () => {
  it("never reach the panel — only whether each provider has one", async () => {
    await chrome.storage.local.set({ providerKeys: { openai: "test-secret-key" } });
    const settings = await toPublicSettings(await getSettings());
    expect(settings.keysPresent).toEqual({ anthropic: false, openai: true, openrouter: false });
    expect(JSON.stringify(settings)).not.toContain("test-secret-key");
  });

  it("the first key saved selects its provider; later keys leave the choice alone", async () => {
    await patchSettings({ apiKeys: { openrouter: " sk-or-first " } });
    expect((await getSettings()).provider).toBe("openrouter");
    expect((await getSettings()).apiKeys.openrouter).toBe("sk-or-first");
    await patchSettings({ apiKeys: { anthropic: "sk-ant-second" } });
    expect((await getSettings()).provider).toBe("openrouter");
  });

  // Where conversation data goes stays the user's decision: a deleted key
  // leaves the provider selected (the next message says the key is missing)
  // rather than quietly sending it to some other provider.
  it("deleting the key in use never moves the conversation to another provider", async () => {
    await patchSettings({ apiKeys: { anthropic: "a", openrouter: "r" } });
    await patchSettings({ provider: "anthropic" });
    await patchSettings({ apiKeys: { anthropic: "" } });
    const s = await getSettings();
    expect(s.apiKeys.anthropic).toBe("");
    expect(s.provider).toBe("anthropic");
    // Saving a key for the provider in use again changes nothing else either.
    await patchSettings({ apiKeys: { anthropic: "a2" } });
    expect((await getSettings()).provider).toBe("anthropic");
  });

  it("stores the provider in use explicitly, so a later key can't re-derive it", async () => {
    await chrome.storage.local.set({ provider: "retired_provider", providerKeys: { openrouter: "r" } });
    expect((await getSettings()).provider).toBe("openrouter");
    await patchSettings({ pinnedInstanceId: null });
    await patchSettings({ apiKeys: { anthropic: "a" } });
    expect((await getSettings()).provider).toBe("openrouter");
  });

  it("removes retired storage keys that could hold a secret or personal data", async () => {
    await chrome.storage.local.set({ claudeApiKey: "old", openaiApiKey: "old", userNameCache: { "x.service-now.com": "Name" }, theme: "dark" });
    await removeRetiredSettings();
    expect(await chrome.storage.local.get(null)).toEqual({ theme: "dark" });
  });

  it("a changed key forgets the catalog the old key loaded", async () => {
    const entry = { fetchedAt: Date.now(), models: [{ id: "m", name: "M" }] };
    await chrome.storage.local.set({ providerKeys: { openai: "old" }, modelCatalog: { openai: entry, anthropic: entry } });
    await patchSettings({ apiKeys: { openai: "new" } });
    expect((await chrome.storage.local.get("modelCatalog")).modelCatalog).toEqual({ anthropic: entry });
  });
});

describe("models", () => {
  it("stores a trimmed choice per provider and ignores blanks", async () => {
    await patchSettings({ models: { openai: "  gpt-custom  ", anthropic: "   " } });
    expect((await getSettings()).models).toEqual({ anthropic: "", openai: "gpt-custom", openrouter: "" });
  });

  it("keeps both of two changes made at the same moment", async () => {
    await Promise.all([patchSettings({ models: { anthropic: "claude-x" } }), patchSettings({ models: { openai: "gpt-x" } })]);
    expect((await getSettings()).models).toMatchObject({ anthropic: "claude-x", openai: "gpt-x" });
  });

  it("sets a default only where no model is chosen — never over the user's pick", async () => {
    expect(await setDefaultModel("openai", "gpt-default")).toBe("gpt-default");
    await patchSettings({ models: { anthropic: "claude-picked" } });
    expect(await setDefaultModel("anthropic", "claude-default")).toBe("claude-picked");
    // A pick that lands while the default is being decided still wins.
    const [, effective] = await Promise.all([patchSettings({ models: { openrouter: "vendor/picked" } }), setDefaultModel("openrouter", "vendor/default")]);
    expect(effective).toBe("vendor/picked");
    expect((await getSettings()).models).toEqual({ anthropic: "claude-picked", openai: "gpt-default", openrouter: "vendor/picked" });
  });
});

describe("instances", () => {
  it("keep valid ServiceNow hosts once each, and a role — Production when none is valid", () => {
    expect(sanitizeInstances([
      { id: "a", label: "  My PDI  ", host: "https://dev12345.service-now.com/nav_to.do", role: "dev" },
      { id: "b", label: "Copy", host: "DEV12345.service-now.com", role: "prod" },
      { id: "c", label: "Elsewhere", host: "example.com", role: "dev" },
      { id: "d", host: "acme.service-now.com", role: "admin" },
      { id: "e", host: "acmeqa.service-now.com" },
      "junk",
    ])).toEqual([
      { id: "a", label: "My PDI", host: "dev12345.service-now.com", role: "dev" },
      { id: "d", label: "acme", host: "acme.service-now.com", role: "prod" },
      { id: "e", label: "acmeqa", host: "acmeqa.service-now.com", role: "prod" },
    ]);
  });

  it("round-trip with their roles, and resolve stale selections to something real", async () => {
    await patchSettings({ instances: INSTANCES, activeInstanceId: "test", pinnedInstanceId: "prod" });
    let s = await getSettings();
    expect(s.instances.map((i) => [i.host, i.role])).toEqual(INSTANCES.map((i) => [i.host, i.role]));
    expect(s).toMatchObject({ activeInstanceId: "test", pinnedInstanceId: "prod" });
    // Removing the pinned and active instances leaves Auto with no selection —
    // it then works where the user is looking, never on whatever is listed first.
    await patchSettings({ instances: INSTANCES.filter((i) => i.id === "dev") });
    s = await getSettings();
    expect(s).toMatchObject({ activeInstanceId: null, pinnedInstanceId: null });
    expect(s.instances.map((i) => i.host)).toEqual([DEV_HOST]);
  });

  it("apply edits to the stored list, so quick successive edits never undo each other", async () => {
    await patchSettings({ instances: INSTANCES });
    // Two edits sent from the same (soon stale) view of the list.
    await Promise.all([
      patchSettings({ instanceOps: [{ op: "role", id: "dev", role: "prod" }] }),
      patchSettings({ instanceOps: [{ op: "remove", id: "test" }] }),
    ]);
    await patchSettings({ instanceOps: [{ op: "add", instance: { id: "pdi", label: "PDI", host: "dev12345.service-now.com", role: "dev" } }] });
    expect((await getSettings()).instances.map((i) => [i.id, i.role])).toEqual([["dev", "prod"], ["prod", "prod"], ["pdi", "dev"]]);
    // An edit that would break the rules is cleaned like any other input.
    await patchSettings({ instanceOps: [{ op: "add", instance: { id: "dup", label: "Dup", host: "DEV12345.service-now.com", role: "dev" } }, { op: "role", id: "pdi", role: "admin" as never }] });
    expect((await getSettings()).instances.map((i) => [i.id, i.role])).toEqual([["dev", "prod"], ["prod", "prod"], ["pdi", "dev"]]);
  });

  it("give every instance its own id, even in a crafted list", () => {
    const ids = sanitizeInstances([
      { id: "inst_b.service-now.com", host: "a.service-now.com", role: "dev" },
      { host: "b.service-now.com", role: "dev" },
      { id: "inst_b.service-now.com", host: "c.service-now.com", role: "dev" },
    ]).map((i) => i.id);
    expect(new Set(ids).size).toBe(3);
  });

  it("refuse a pin or selection that names no instance", async () => {
    await patchSettings({ instances: INSTANCES });
    await patchSettings({ pinnedInstanceId: "ghost", activeInstanceId: "ghost" });
    expect(await getSettings()).toMatchObject({ pinnedInstanceId: null, activeInstanceId: "dev" });
  });
});

describe("team presets", () => {
  it("seed the list, validated like any instance, until the user edits it", async () => {
    vi.mocked(presetInstances).mockReturnValue([
      { label: "Team prod", host: PROD_HOST, role: "prod" },
      { label: "Team dev", host: DEV_HOST, role: "dev" },
      { label: "No role", host: "examplesand.service-now.com" },
    ]);
    const seeded = await getSettings();
    expect(seeded.instances.map((i) => [i.label, i.role])).toEqual([["Team prod", "prod"], ["Team dev", "dev"], ["No role", "prod"]]);
    expect(seeded.activeInstanceId).toBe(seeded.instances[0].id);

    // Once edited, the stored list is the whole truth: a removed preset stays removed.
    await patchSettings({ instances: seeded.instances.filter((i) => i.label !== "Team prod") });
    expect((await getSettings()).instances.map((i) => i.label)).toEqual(["Team dev", "No role"]);
    await patchSettings({ instances: [] });
    expect((await getSettings()).instances).toEqual([]);
  });
});
