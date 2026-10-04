// Provider failures reach the user as themselves: a limit to wait out, a key
// to fix, a connection to check, or the provider's own message.
import { describe, expect, it } from "vitest";
import { classifyProviderFailure, friendlyProviderError } from "../../src/background/providers";

describe("provider failure kinds", () => {
  it("explains an unreachable API provider in plain words", () => {
    expect(friendlyProviderError("openrouter", new TypeError("Failed to fetch"))).toBe("Couldn't reach OpenRouter (network error). Check your connection, then resume.");
    expect(friendlyProviderError("openai", new TypeError("Failed to fetch"))).toBe("Couldn't reach OpenAI (network error). Check your connection, then resume.");
  });

  it("names the provider whose key was rejected", () => {
    expect(friendlyProviderError("openai", new Error("OpenAI API error 401: Incorrect API key provided"))).toBe("Your OpenAI API key was rejected. Check it in Settings.");
  });

  it("says an OpenRouter balance is too low, and what it would still cover", () => {
    const err = new Error("OpenRouter API error 402: This request requires more credits, or fewer max_tokens. You requested up to 65536 tokens, but can only afford 800. To increase, visit https://openrouter.ai/settings/credits and add more credits");
    expect(friendlyProviderError("openrouter", err)).toBe(
      "Your OpenRouter balance is too low for this request (it covers about 800 tokens of answer on this model). Add credits at openrouter.ai/settings/credits, or choose a cheaper model, then resume."
    );
    expect(friendlyProviderError("openrouter", new Error("OpenRouter API error 402: Insufficient credits"))).toBe(
      "Your OpenRouter balance is too low for this request. Add credits at openrouter.ai/settings/credits, or choose a cheaper model, then resume."
    );
  });

  it.each([
    [{ status: 401, message: "Unauthorized" }, "provider_auth"],
    [{ status: 429, message: "Too many requests" }, "provider_rate_limited"],
    [{ name: "TypeError", message: "Failed to fetch" }, "provider_network"],
    [{ code: "PROVIDER_STALLED", message: "The provider stopped sending data." }, "provider_network"],
    [{ code: "PROVIDER_TIMEOUT", message: "The provider did not start answering in time." }, "provider_network"],
    [{ message: "Something else" }, "provider_error"],
  ])("classifies %o as %s", (error, kind) => {
    expect(classifyProviderFailure("openrouter", error)).toBe(kind);
  });
});
