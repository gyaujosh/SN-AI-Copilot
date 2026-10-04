// A stream cut off after the provider accepted the request is still billed,
// so each adapter hands the agent what it can tell of the usage: the prompt's
// real counts when the provider sent them, and an estimate of the rest.
import { afterEach, describe, expect, it, vi } from "vitest";
import { anthropicAdapter } from "../../src/background/providers/anthropic";
import { openrouterAdapter } from "../../src/background/providers/openaiCompat";
import { openaiAdapter } from "../../src/background/providers/openaiResponses";
import { partialUsageOf } from "../../src/background/providers/types";

afterEach(() => { vi.unstubAllGlobals(); });

/** A 200 response that sends `chunks`, then drops the connection. One chunk
 * per read: erroring a stream discards whatever is still queued. */
function droppingStream(chunks: string[], contentType = "text/event-stream") {
  const encoder = new TextEncoder();
  return vi.fn(async () => {
    const pending = [...chunks];
    return new Response(new ReadableStream({
      pull(controller) {
        const next = pending.shift();
        if (next === undefined) controller.error(new TypeError("network error"));
        else controller.enqueue(encoder.encode(next));
      },
    }), { status: 200, headers: { "content-type": contentType } });
  });
}

const params = () => ({
  modelId: "test-model",
  system: "You help.",
  tools: [],
  history: [{ role: "user" as const, text: "Explain this record" }],
  signal: new AbortController().signal,
  onTextDelta: () => {},
});

async function failure(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new Error("expected the call to fail");
}

describe("usage of a stream cut off mid-answer", () => {
  it("Anthropic: the prompt's reported counts, and output estimated from what arrived", async () => {
    const text = "x".repeat(400);
    const sse = (event: string, data: object) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    vi.stubGlobal("fetch", droppingStream([
      sse("message_start", { type: "message_start", message: {
        id: "msg_1", type: "message", role: "assistant", model: "test-model", content: [], stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 1200, output_tokens: 1, cache_read_input_tokens: 800, cache_creation_input_tokens: 50 },
      } }),
      sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
      sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }),
    ]));
    const err = await failure(anthropicAdapter.complete("key", params()));
    expect(partialUsageOf(err)).toEqual({ inputTokens: 1200, outputTokens: 100, cacheReadTokens: 800, cacheWriteTokens: 50, approximate: true });
  });

  it("Anthropic: nothing, when the stream ends before the request was accepted", async () => {
    vi.stubGlobal("fetch", droppingStream([]));
    expect(partialUsageOf(await failure(anthropicAdapter.complete("key", params())))).toBeUndefined();
  });

  it("OpenAI: an estimate from the request and what arrived, since usage comes only at the end", async () => {
    const delta = { type: "response.output_text.delta", output_index: 0, delta: "y".repeat(80) };
    vi.stubGlobal("fetch", droppingStream([`event: ${delta.type}\ndata: ${JSON.stringify(delta)}\n\n`]));
    const usage = partialUsageOf(await failure(openaiAdapter.complete("key", params())));
    expect(usage).toMatchObject({ outputTokens: 20, cacheReadTokens: 0, approximate: true });
    expect(usage!.inputTokens).toBeGreaterThan(0);
  });

  it("OpenRouter: an estimate from the request and what arrived", async () => {
    vi.stubGlobal("fetch", droppingStream([`data: ${JSON.stringify({ choices: [{ delta: { content: "y".repeat(80) } }] })}\n\n`]));
    const usage = partialUsageOf(await failure(openrouterAdapter.complete("key", params())));
    expect(usage).toMatchObject({ outputTokens: 20, cacheReadTokens: 0, approximate: true });
    expect(usage!.inputTokens).toBeGreaterThan(0);
  });

  it("OpenRouter: the provider's own counts when they arrived before the drop", async () => {
    vi.stubGlobal("fetch", droppingStream([`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 900, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 300 } } })}\n\n`]));
    expect(partialUsageOf(await failure(openrouterAdapter.complete("key", params())))).toEqual({
      inputTokens: 600, outputTokens: 40, cacheReadTokens: 300, cacheWriteTokens: 0, costUsd: undefined,
    });
  });
});
