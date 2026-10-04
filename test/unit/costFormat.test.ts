// How spend reads: dollars that never round a real cost down to $0.00, token
// counts short enough for a toolbar, and a plain sentence on how the total
// was worked out.
import { describe, expect, it } from "vitest";
import { EMPTY_COST } from "../../src/shared/types";
import { costBasis, formatTokens, formatUsd, sessionSpend } from "../../src/sidepanel/utils/cost";

describe("dollars", () => {
  it.each([
    [0, false, "$0.00"],
    [0.0042, false, "$0.0042"],
    [0.0421, false, "$0.04"],
    [0.0421, true, "$0.0421"],
    [12.5, true, "$12.50"],
    [1234.567, false, "$1,234.57"],
    [Number.NaN, false, "$0.00"],
  ])("formats %s (precise: %s) as %s", (value, precise, expected) => {
    expect(formatUsd(value, precise)).toBe(expected);
  });
});

describe("tokens", () => {
  it.each([
    [0, "0"],
    [842, "842"],
    [18_240, "18.2k"],
    [20_000, "20k"],
    [182_400, "182k"],
    [1_240_000, "1.24M"],
  ])("formats %d as %s", (count, expected) => {
    expect(formatTokens(count)).toBe(expected);
  });
});

describe("how the total was worked out", () => {
  const cost = { ...EMPTY_COST, usd: 0.04, requests: 3 };

  it("calls OpenRouter's figures exact", () => {
    expect(costBasis({ ...cost, reportedRequests: 3 })).toBe("Exact cost, as reported by OpenRouter.");
  });

  it("says list prices are an estimate, and when they were checked", () => {
    expect(costBasis(cost)).toMatch(/^Estimated from list prices checked [A-Z][a-z]{2} 20\d\d; your provider's bill is final\.$/);
  });

  it("counts the calls that are rough estimates", () => {
    expect(costBasis({ ...cost, estimatedRequests: 2 })).toContain("2 calls are rough estimates");
    expect(costBasis({ ...cost, estimatedRequests: 1 })).toContain("1 call is a rough estimate");
  });

  it("sums up a saved chat in one line", () => {
    expect(sessionSpend({ usd: 0.1284, cost: { ...cost, usd: 0.1284, inputTokens: 38_120, outputTokens: 5_210, cacheReadTokens: 96_400 } })).toBe("$0.13 · 140k tokens");
    expect(sessionSpend({ cost: { ...cost, estimatedRequests: 1 } })).toBe("≈ $0.04 · 0 tokens");
    expect(sessionSpend({ usd: 0.0316 })).toBe("$0.03");
    expect(sessionSpend({})).toBeNull();
  });
});
