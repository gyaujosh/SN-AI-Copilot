// A model call's cost: the provider's own figure when it reports one, the
// model's list price otherwise, and a deliberately high rate — flagged as an
// estimate — when the model isn't in the price list. Never silently $0, and
// never a newer model at an older one's cheaper price.
import { describe, expect, it } from "vitest";
import { computeCost } from "../../src/background/pricing";
import type { UsageInfo } from "../../src/background/providers/types";

const M = 1_000_000;
const K100 = 100_000;
const usage = (over: Partial<UsageInfo> = {}): UsageInfo => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, ...over });
const usd = (provider: "anthropic" | "openai" | "openrouter", model: string, u: UsageInfo) => computeCost(provider, model, u).usd;

describe("Claude list prices", () => {
  it.each([
    ["claude-sonnet-5", 2, 10],
    ["claude-opus-5-5", 4, 20],
    ["claude-opus-5", 5, 25],
    ["claude-fable-5-1", 10, 50],
    ["claude-opus-4-8", 5, 25],
    ["claude-haiku-4-5", 1, 5],
  ])("prices %s at $%d in / $%d out per million", (model, inPrice, outPrice) => {
    expect(usd("anthropic", model, usage({ inputTokens: M }))).toBeCloseTo(inPrice);
    expect(usd("anthropic", model, usage({ outputTokens: M }))).toBeCloseTo(outPrice);
    expect(computeCost("anthropic", model, usage({ inputTokens: M }))).toMatchObject({ estimated: false, reported: false });
  });

  it("finds dated, vendor-prefixed and dotted ids", () => {
    const expected = usd("anthropic", "claude-sonnet-5", usage({ inputTokens: M, outputTokens: M }));
    for (const id of ["claude-sonnet-5-20260101", "anthropic/claude-sonnet-5", "Claude-Sonnet-5-latest"]) {
      expect(usd("anthropic", id, usage({ inputTokens: M, outputTokens: M }))).toBeCloseTo(expected);
    }
    expect(usd("anthropic", "claude-haiku-4.5", usage({ inputTokens: M }))).toBeCloseTo(1);
  });

  it("bills cache writes at 1.25× and cache reads at each model's own rate", () => {
    expect(usd("anthropic", "claude-sonnet-5", usage({ cacheWriteTokens: M }))).toBeCloseTo(2.5);
    expect(usd("anthropic", "claude-sonnet-5", usage({ cacheReadTokens: M }))).toBeCloseTo(0.2);
    expect(usd("anthropic", "claude-opus-5-5", usage({ cacheReadTokens: M }))).toBeCloseTo(0.2);
    expect(usd("anthropic", "claude-fable-5-1", usage({ cacheReadTokens: M }))).toBeCloseTo(0.25);
  });

  it("prices an unlisted Claude model high and says it is an estimate", () => {
    expect(computeCost("anthropic", "claude-mystery-9", usage({ inputTokens: M, outputTokens: M }))).toEqual({ usd: 60, estimated: true, reported: false });
  });
});

describe("OpenAI list prices", () => {
  it.each([
    ["gpt-5.5", 5, 30],
    ["gpt-5.5-pro", 30, 180],
    ["gpt-5.4", 2.5, 15],
    ["gpt-5.4-mini", 0.75, 4.5],
    ["gpt-5-mini", 0.25, 2],
    ["o4-mini", 1.1, 4.4],
    ["gpt-4.1-mini", 0.4, 1.6],
  ])("prices %s at $%d in / $%d out per million", (model, inPrice, outPrice) => {
    // A 100K-token prompt: under the long-context threshold.
    expect(usd("openai", model, usage({ inputTokens: K100 }))).toBeCloseTo(inPrice / 10);
    expect(usd("openai", model, usage({ outputTokens: M }))).toBeCloseTo(outPrice);
  });

  it("discounts cached input by each model's own rate", () => {
    expect(usd("openai", "gpt-5.4", usage({ cacheReadTokens: K100 }))).toBeCloseTo(0.025);
    expect(usd("openai", "gpt-4.1", usage({ cacheReadTokens: M }))).toBeCloseTo(0.5);
    expect(usd("openai", "gpt-4o", usage({ cacheReadTokens: M }))).toBeCloseTo(1.25);
  });

  it("never gives a newer version an older one's price", () => {
    // gpt-5.7 is not gpt-5: it takes the high fallback, flagged, rather than gpt-5's $1.25.
    const newer = computeCost("openai", "gpt-5.7", usage({ inputTokens: K100 }));
    expect(newer.estimated).toBe(true);
    expect(newer.usd).toBeGreaterThan(usd("openai", "gpt-5.5", usage({ inputTokens: K100 })));
    // A variant of a listed model still finds it.
    expect(computeCost("openai", "gpt-5-chat-latest", usage({ inputTokens: M }))).toMatchObject({ usd: 1.25, estimated: false });
    expect(usd("openai", "gpt-5.4-2026-03-05", usage({ inputTokens: K100 }))).toBeCloseTo(0.25);
  });

  it("bills a prompt over 272K tokens at the long-context rate", () => {
    const short = usage({ inputTokens: 200_000, outputTokens: 10_000 });
    const long = usage({ inputTokens: 250_000, cacheReadTokens: 50_000, outputTokens: 10_000 });
    expect(usd("openai", "gpt-5.5", short)).toBeCloseTo(0.2 * 5 + 0.01 * 30);
    expect(usd("openai", "gpt-5.5", long)).toBeCloseTo(0.25 * 10 + 0.05 * 1 + 0.01 * 45);
    // Models without a long-context tier keep their one price.
    expect(usd("openai", "gpt-5.4-mini", usage({ inputTokens: 300_000 }))).toBeCloseTo(0.3 * 0.75);
  });
});

describe("reported and approximate costs", () => {
  it("uses the cost OpenRouter reports over any list price", () => {
    expect(computeCost("openrouter", "anthropic/claude-sonnet-5", usage({ inputTokens: M, costUsd: 0.0123 }))).toEqual({ usd: 0.0123, estimated: false, reported: true });
  });

  it("flags a call whose token counts were estimated", () => {
    expect(computeCost("anthropic", "claude-sonnet-5", usage({ inputTokens: M, approximate: true }))).toMatchObject({ usd: 2, estimated: true });
  });
});
