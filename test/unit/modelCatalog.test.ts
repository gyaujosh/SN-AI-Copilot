// Model lists come from the providers, never from a hard-coded list: fetched
// with the user's key, filtered to models that can chat with tools, cached for
// a day, and the default model is chosen from what the provider returns.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cachedModelEntry, clearModelCatalog, getModelCatalog, pickDefaultModel } from "../../src/background/modelCatalog";

const respond = (rows: any[], status = 200) => vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ data: rows }), { status }));
afterEach(() => { vi.unstubAllGlobals(); });

describe("fetching a catalog", () => {
  it("asks Anthropic with the key and lists newest first by display name", async () => {
    const fetch = respond([
      { id: "claude-older", display_name: "Claude Older", created_at: "2025-01-01T00:00:00Z" },
      { id: "claude-newer", display_name: "Claude Newer", created_at: "2026-01-01T00:00:00Z" },
    ]);
    vi.stubGlobal("fetch", fetch);
    expect(await getModelCatalog("anthropic", "sk-ant-test")).toEqual([
      { id: "claude-newer", name: "Claude Newer", created: 1767225600 },
      { id: "claude-older", name: "Claude Older", created: 1735689600 },
    ]);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/models?limit=100");
    expect((init!.headers as Record<string, string>)["x-api-key"]).toBe("sk-ant-test");
  });

  it("keeps only OpenAI models the chat adapter can use", async () => {
    const ids = [
      "gpt-5.5", "o4-mini", "text-embedding-3-large", "whisper-1", "gpt-image-1", "tts-1", "dall-e-3",
      // Responses-only, legacy completions, or no tool support:
      "gpt-5.5-pro", "o3-pro-2025-06-10", "gpt-5-codex", "gpt-3.5-turbo-instruct", "gpt-4o-search-preview", "o3-deep-research",
    ];
    vi.stubGlobal("fetch", respond(ids.map((id, i) => ({ id, created: i }))));
    expect((await getModelCatalog("openai", "sk-test")).map((m) => m.id)).toEqual(["o4-mini", "gpt-5.5"]);
  });

  it("keeps only OpenRouter models that can call tools, when OpenRouter says which", async () => {
    vi.stubGlobal("fetch", respond([
      { id: "a/tools", name: "Tools", created: 2, supported_parameters: ["tools", "temperature"] },
      { id: "b/chat-only", name: "Chat only", created: 3, supported_parameters: ["temperature"] },
      { id: "c/unknown", name: "Unknown", created: 1 },
    ]));
    expect((await getModelCatalog("openrouter", "sk-or-test")).map((m) => m.id)).toEqual(["a/tools", "c/unknown"]);
  });

  it("records the effort levels and thinking each Claude model reports", async () => {
    const level = (supported: boolean) => ({ supported });
    vi.stubGlobal("fetch", respond([
      {
        id: "claude-sonnet-5", display_name: "Claude Sonnet 5", created_at: "2026-02-01T00:00:00Z",
        capabilities: {
          effort: { supported: true, low: level(true), medium: level(true), high: level(true), xhigh: level(true), max: level(true) },
          thinking: { supported: true, types: { adaptive: level(true), enabled: level(false) } },
        },
      },
      {
        id: "claude-haiku-4-5", display_name: "Claude Haiku 4.5", created_at: "2025-10-01T00:00:00Z",
        capabilities: { effort: { supported: false, low: level(false), medium: level(false), high: level(false), xhigh: null, max: level(false) }, thinking: { supported: true, types: { adaptive: level(false), enabled: level(true) } } },
      },
    ]));
    const [sonnet, haiku] = await getModelCatalog("anthropic", "sk-ant-test");
    expect(sonnet).toMatchObject({ efforts: ["low", "medium", "high", "xhigh", "max"], adaptiveThinking: true });
    expect(haiku).toMatchObject({ adaptiveThinking: false });
    expect(haiku).not.toHaveProperty("efforts");
  });

  it("records the effort levels and default each OpenRouter reasoning model reports", async () => {
    vi.stubGlobal("fetch", respond([
      { id: "openai/gpt-6-sol", created: 4, supported_parameters: ["tools", "reasoning"], reasoning: { mandatory: false, supported_efforts: ["max", "xhigh", "high", "medium", "low", "none"], default_effort: "medium" } },
      // Reasoning that can't be switched off is never offered as "none".
      { id: "openai/gpt-6-astra", created: 3, supported_parameters: ["tools"], reasoning: { mandatory: true, supported_efforts: ["none", "low", "high"], default_effort: "high" } },
      // No list: any gateway level works; the three every model maps are offered.
      { id: "anthropic/claude-haiku-4.5", created: 2, supported_parameters: ["tools"], reasoning: { mandatory: false } },
      { id: "openai/gpt-4.1", created: 1, supported_parameters: ["tools"] },
    ]));
    const models = await getModelCatalog("openrouter", "sk-or-test");
    expect(models.map(({ id, efforts, defaultEffort }) => ({ id, efforts, defaultEffort }))).toEqual([
      { id: "openai/gpt-6-sol", efforts: ["none", "low", "medium", "high", "xhigh", "max"], defaultEffort: "medium" },
      { id: "openai/gpt-6-astra", efforts: ["low", "high"], defaultEffort: "high" },
      { id: "anthropic/claude-haiku-4.5", efforts: ["low", "medium", "high"], defaultEffort: undefined },
      { id: "openai/gpt-4.1", efforts: undefined, defaultEffort: undefined },
    ]);
  });

  it("reports a rejected key as such — and a key that merely can't list models as that", async () => {
    vi.stubGlobal("fetch", respond([], 401));
    await expect(getModelCatalog("openai", "bad")).rejects.toThrow("API key was rejected");
    vi.stubGlobal("fetch", respond([], 403));
    await expect(getModelCatalog("openai", "restricted")).rejects.toThrow("this key can't list models (403)");
  });

  it("checks an OpenRouter key on its own, since the catalog answers any key", async () => {
    const fetch = vi.fn(async (url: string) => url.endsWith("/auth/key")
      ? new Response("{}", { status: 401 })
      : new Response(JSON.stringify({ data: [{ id: "a/tools", supported_parameters: ["tools"] }] })));
    vi.stubGlobal("fetch", fetch);
    await expect(getModelCatalog("openrouter", "sk-or-typo")).rejects.toThrow("API key was rejected");
    // Anything short of a definite refusal leaves the list usable.
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/auth/key")
      ? new Response("{}", { status: 500 })
      : new Response(JSON.stringify({ data: [{ id: "a/tools", supported_parameters: ["tools"] }] }))));
    expect((await getModelCatalog("openrouter", "sk-or-ok", true)).map((m) => m.id)).toEqual(["a/tools"]);
  });
});

describe("the cache", () => {
  it("serves a fresh catalog without asking again, and refetches when forced or cleared", async () => {
    const fetch = respond([{ id: "gpt-5.5", created: 1 }]);
    vi.stubGlobal("fetch", fetch);
    await getModelCatalog("openai", "k");
    await vi.waitFor(async () => expect((await chrome.storage.local.get("modelCatalog")).modelCatalog).toHaveProperty("openai"));
    await getModelCatalog("openai", "k");
    expect(fetch).toHaveBeenCalledTimes(1);
    await getModelCatalog("openai", "k", true);
    expect(fetch).toHaveBeenCalledTimes(2);
    await clearModelCatalog("openai");
    await getModelCatalog("openai", "k");
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("never serves a list loaded with a different key", async () => {
    const fetch = respond([{ id: "gpt-5.5", created: 1 }]);
    vi.stubGlobal("fetch", fetch);
    await getModelCatalog("openai", "old-key");
    await vi.waitFor(async () => expect((await chrome.storage.local.get("modelCatalog")).modelCatalog).toHaveProperty("openai"));
    const cached = JSON.stringify(await chrome.storage.local.get("modelCatalog"));
    expect(cached).not.toContain("old-key");
    await getModelCatalog("openai", "new-key");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps every provider's entry when catalogs load at the same time", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify({ data: [{ id: url.includes("openai") ? "gpt-5.5" : url.includes("anthropic") ? "claude-x" : "v/x", created: 1 }] }))));
    await Promise.all([getModelCatalog("anthropic", "a"), getModelCatalog("openai", "o"), getModelCatalog("openrouter", "r")]);
    await vi.waitFor(async () => {
      const cache = (await chrome.storage.local.get("modelCatalog")).modelCatalog as Record<string, unknown>;
      expect(Object.keys(cache).sort()).toEqual(["anthropic", "openai", "openrouter"]);
    });
  });
});

describe("a model's cached entry", () => {
  it("is read without asking the provider, only for the key that loaded it", async () => {
    const fetch = respond([{ id: "claude-sonnet-5", display_name: "Claude Sonnet 5", capabilities: { thinking: { types: { adaptive: { supported: true } } } } }]);
    vi.stubGlobal("fetch", fetch);
    await getModelCatalog("anthropic", "key-a", true);
    await vi.waitFor(async () => expect(await cachedModelEntry("anthropic", "key-a", "claude-sonnet-5")).toMatchObject({ adaptiveThinking: true }));
    expect(await cachedModelEntry("anthropic", "key-b", "claude-sonnet-5")).toBeUndefined();
    expect(await cachedModelEntry("anthropic", "key-a", "claude-other")).toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("comes from a fresh fetch when the cached list predates effort levels", async () => {
    const fetch = respond([{ id: "gpt-5.5", created: 1 }]);
    vi.stubGlobal("fetch", fetch);
    await getModelCatalog("openai", "k", true);
    await vi.waitFor(async () => expect((await chrome.storage.local.get("modelCatalog")).modelCatalog).toHaveProperty("openai"));
    const cache = (await chrome.storage.local.get("modelCatalog")).modelCatalog as Record<string, any>;
    delete cache.openai.v;
    await chrome.storage.local.set({ modelCatalog: cache });
    await getModelCatalog("openai", "k");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe("pickDefaultModel", () => {
  const list = (...ids: string[]) => ids.map((id) => ({ id, name: id }));

  it("prefers the newest Sonnet on Claude", () => {
    expect(pickDefaultModel("anthropic", list("claude-opus-9", "claude-sonnet-9", "claude-sonnet-8", "claude-haiku-9"))).toBe("claude-sonnet-9");
  });

  it("prefers the newest flagship GPT on OpenAI, skipping minis, pros and dated snapshots", () => {
    expect(pickDefaultModel("openai", list("gpt-9-mini", "gpt-9-pro", "gpt-9-2026-01-01", "gpt-9", "gpt-8.5"))).toBe("gpt-9");
  });

  it("prefers a Claude Sonnet, then a flagship GPT, on OpenRouter", () => {
    expect(pickDefaultModel("openrouter", list("x/newest", "openai/gpt-9", "anthropic/claude-sonnet-9"))).toBe("anthropic/claude-sonnet-9");
    expect(pickDefaultModel("openrouter", list("x/newest", "openai/gpt-9"))).toBe("openai/gpt-9");
  });

  it("falls back to the newest listed model, and to nothing for an empty catalog", () => {
    expect(pickDefaultModel("anthropic", list("claude-future-1", "claude-future-0"))).toBe("claude-future-1");
    expect(pickDefaultModel("openai", [])).toBeNull();
  });
});
