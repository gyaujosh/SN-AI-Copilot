// Reasoning effort, end to end at the wire: each provider is sent the effort
// chosen for the model (and nothing when none is), OpenAI's reasoning models
// get their tools through the Responses API, and a model's own reasoning is
// handed back to it — never to another model — between tool calls.
import { afterEach, describe, expect, it, vi } from "vitest";
import { anthropicAdapter } from "../../src/background/providers/anthropic";
import { getAdapter } from "../../src/background/providers";
import { openrouterAdapter } from "../../src/background/providers/openaiCompat";
import { openaiAdapter } from "../../src/background/providers/openaiResponses";
import type { CompletionParams, NeutralMessage } from "../../src/background/providers/types";
import { modelEfforts, openAiReasoning } from "../../src/shared/effort";

afterEach(() => { vi.unstubAllGlobals(); });

const TOOL = { name: "query_records", description: "Query a table", input_schema: { type: "object" as const, properties: { table: { type: "string" } } } };

function params(over: Partial<CompletionParams> = {}): CompletionParams {
  return {
    modelId: "gpt-6-sol",
    system: "You help.",
    tools: [TOOL],
    history: [{ role: "user", text: "Find incidents" }],
    signal: new AbortController().signal,
    onTextDelta: () => {},
    ...over,
  };
}

/** Answers every request with `events` as one SSE stream, and records what was sent. */
function sse(events: object[], format: (e: any) => string = (e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`) {
  const sent: Array<{ url: string; body: any }> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    sent.push({ url, body: JSON.parse(String(init.body)) });
    return new Response(events.map(format).join(""), { status: 200, headers: { "content-type": "text/event-stream" } });
  }));
  return sent;
}

describe("which OpenAI models reason, and at which levels", () => {
  it.each([
    ["gpt-6-sol", ["none", "low", "medium", "high", "xhigh", "max"]],
    ["gpt-6-luna", ["none", "low", "medium", "high", "xhigh", "max"]],
    ["gpt-6-astra", ["low", "medium", "high", "xhigh", "max"]],
    ["gpt-5.6-terra", ["none", "low", "medium", "high", "xhigh", "max"]],
    ["gpt-5.5", ["none", "low", "medium", "high", "xhigh"]],
    ["gpt-5.4-mini", ["none", "low", "medium", "high", "xhigh"]],
    ["gpt-5.1", ["none", "low", "medium", "high"]],
    ["gpt-5-mini", ["minimal", "low", "medium", "high"]],
    ["o4-mini", ["low", "medium", "high"]],
    // A family newer than the table: the levels every reasoning model takes.
    ["gpt-7", ["low", "medium", "high"]],
    // Reasoning at levels that vary by model: run at their own.
    ["gpt-5.5-pro", []],
  ])("%s → %j", (id, efforts) => {
    expect(openAiReasoning(id)?.efforts).toEqual(efforts);
  });

  it.each(["gpt-4.1", "gpt-4o-mini", "gpt-5-chat-latest", "gpt-3.5-turbo"])("%s doesn't reason, so offers no effort", (id) => {
    expect(openAiReasoning(id)).toBeNull();
    expect(modelEfforts("openai", id).efforts).toEqual([]);
  });

  it("takes Claude's and OpenRouter's levels from their catalog entries", () => {
    expect(modelEfforts("anthropic", "claude-sonnet-5", { id: "claude-sonnet-5", name: "Claude Sonnet 5", efforts: ["low", "high"] }).efforts).toEqual(["low", "high"]);
    expect(modelEfforts("anthropic", "claude-sonnet-5").efforts).toEqual([]);
    expect(modelEfforts("openrouter", "x/y", { id: "x/y", name: "Y", efforts: ["medium"], defaultEffort: "medium" })).toEqual({ efforts: ["medium"], defaultEffort: "medium" });
  });
});

describe("OpenAI, through the Responses API", () => {
  const reasoning = { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "sealed" };
  const message = { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Checking.", annotations: [] }] };
  const fnCall = { type: "function_call", id: "fc_1", call_id: "call_1", name: "query_records", arguments: '{"table":"incident"}', status: "completed" };
  const answer = (status = "completed") => [
    { type: "response.output_item.done", output_index: 0, item: reasoning },
    { type: "response.output_text.delta", output_index: 1, delta: "Checking." },
    { type: "response.output_item.done", output_index: 1, item: message },
    { type: "response.function_call_arguments.delta", output_index: 2, delta: '{"table":"incident"}' },
    { type: "response.output_item.done", output_index: 2, item: fnCall },
    { type: `response.${status}`, response: { status, output: [reasoning, message, fnCall], usage: { input_tokens: 1200, input_tokens_details: { cached_tokens: 200 }, output_tokens: 90 } } },
  ];

  it("is the adapter every OpenAI request goes through", () => {
    expect(getAdapter("openai")).toBe(openaiAdapter);
  });

  it("sends tools to a reasoning model without switching its reasoning off", async () => {
    const sent = sse(answer());
    const deltas: string[] = [];
    const result = await openaiAdapter.complete("sk-test", params({ onTextDelta: (d) => deltas.push(d) }));

    expect(sent[0].url).toBe("https://api.openai.com/v1/responses");
    expect(sent[0].body).toMatchObject({ model: "gpt-6-sol", instructions: "You help.", stream: true, store: false, include: ["reasoning.encrypted_content"] });
    expect(sent[0].body.tools).toEqual([{ type: "function", name: "query_records", description: "Query a table", parameters: TOOL.input_schema, strict: false }]);
    // No effort chosen: none sent, so the model runs at its own default.
    expect(sent[0].body.reasoning).toBeUndefined();
    expect(sent[0].body).not.toHaveProperty("reasoning_effort");

    expect(deltas).toEqual(["Checking."]);
    expect(result).toMatchObject({
      text: "Checking.",
      toolCalls: [{ id: "call_1", name: "query_records", input: { table: "incident" } }],
      stopReason: "tool_use",
      usage: { inputTokens: 1000, cacheReadTokens: 200, outputTokens: 90, cacheWriteTokens: 0 },
      raw: { provider: "openai", content: { model: "gpt-6-sol", items: [reasoning, message, fnCall] } },
    });
  });

  it("sends the chosen effort", async () => {
    const sent = sse(answer());
    await openaiAdapter.complete("sk-test", params({ effort: "high" }));
    expect(sent[0].body.reasoning).toEqual({ effort: "high" });
  });

  it("asks a model that doesn't reason for no reasoning at all", async () => {
    const sent = sse(answer());
    await openaiAdapter.complete("sk-test", params({ modelId: "gpt-4.1" }));
    expect(sent[0].body).not.toHaveProperty("include");
    expect(sent[0].body).not.toHaveProperty("reasoning");
  });

  it("hands a model its own reasoning back between tool calls — and no other model", async () => {
    const first = sse(answer());
    const turn = await openaiAdapter.complete("sk-test", params());
    const history: NeutralMessage[] = [
      { role: "user", text: "Find incidents" },
      { role: "assistant", text: turn.text, toolCalls: turn.toolCalls, raw: turn.raw },
      { role: "tool_results", results: [{ toolCallId: "call_1", content: "[3 records]" }] },
    ];
    first.length = 0;
    await openaiAdapter.complete("sk-test", params({ history }));
    expect(first[0].body.input.slice(1)).toEqual([reasoning, message, fnCall, { type: "function_call_output", call_id: "call_1", output: "[3 records]" }]);

    first.length = 0;
    await openaiAdapter.complete("sk-test", params({ modelId: "gpt-5.5", history }));
    expect(first[0].body.input.slice(1)).toEqual([
      { role: "assistant", content: "Checking." },
      { type: "function_call", call_id: "call_1", name: "query_records", arguments: '{"table":"incident"}' },
      { type: "function_call_output", call_id: "call_1", output: "[3 records]" },
    ]);
  });

  it("never replays reasoning it can't: without its encrypted content, or with nothing after it", async () => {
    const sent = sse(answer());
    const bare = { type: "reasoning", id: "rs_2", summary: [] };
    const history: NeutralMessage[] = [
      { role: "user", text: "Hi" },
      { role: "assistant", text: "Checking.", toolCalls: [], raw: { provider: "openai", content: { model: "gpt-6-sol", items: [bare, message, reasoning] } } },
      { role: "user", text: "And now?" },
    ];
    await openaiAdapter.complete("sk-test", params({ history }));
    expect(sent[0].body.input[1]).toEqual(message);
    expect(sent[0].body.input[2]).toEqual({ role: "user", content: [{ type: "input_text", text: "And now?" }] });
  });

  it("runs no tool call from an answer cut short", async () => {
    sse(answer("incomplete"));
    expect((await openaiAdapter.complete("sk-test", params())).stopReason).toBe("end_turn");
  });

  it("reports a failed response as the provider's error", async () => {
    sse([{ type: "response.failed", response: { status: "failed", error: { code: "server_error", message: "The model failed." } } }]);
    await expect(openaiAdapter.complete("sk-test", params())).rejects.toThrow("OpenAI API error: The model failed.");
  });

  it("names OpenAI's own refusal, as before", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { message: "Invalid model" } }), { status: 400 })));
    await expect(openaiAdapter.complete("sk-test", params())).rejects.toThrow("OpenAI API error 400: Invalid model");
  });
});

describe("OpenRouter", () => {
  const chunk = (delta: object, extra: object = {}) => ({ choices: [{ delta, ...extra }] });
  const data = (e: any) => `data: ${JSON.stringify(e)}\n\n`;

  it("sends the chosen effort in its one reasoning setting, and none when none is chosen", async () => {
    const sent = sse([chunk({ content: "Hi" }, { finish_reason: "stop" })], data);
    await openrouterAdapter.complete("sk-or", params({ modelId: "openai/gpt-6-sol", effort: "xhigh" }));
    expect(sent[0].url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(sent[0].body.reasoning).toEqual({ effort: "xhigh" });
    await openrouterAdapter.complete("sk-or", params({ modelId: "openai/gpt-6-sol" }));
    expect(sent[1].body).not.toHaveProperty("reasoning");
  });

  it("gathers reasoning streamed in pieces and hands it back only to the model that wrote it", async () => {
    sse([
      chunk({ reasoning_details: [{ type: "reasoning.text", text: "Let me ", index: 0, format: "anthropic-claude-v1" }] }),
      chunk({ reasoning_details: [{ type: "reasoning.text", text: "check.", index: 0, signature: "sig" }] }),
      chunk({ tool_calls: [{ index: 0, id: "call_1", function: { name: "query_records", arguments: '{"table":"incident"}' } }] }, { finish_reason: "tool_calls" }),
    ], data);
    const model = "anthropic/claude-sonnet-5";
    const turn = await openrouterAdapter.complete("sk-or", params({ modelId: model }));
    const details = [{ type: "reasoning.text", text: "Let me check.", index: 0, format: "anthropic-claude-v1", signature: "sig" }];
    expect(turn.raw).toEqual({ provider: "openrouter", content: { model, reasoningDetails: details } });

    const history: NeutralMessage[] = [
      { role: "user", text: "Find incidents" },
      { role: "assistant", text: "", toolCalls: turn.toolCalls, raw: turn.raw },
      { role: "tool_results", results: [{ toolCallId: "call_1", content: "[]" }] },
    ];
    const sent = sse([chunk({ content: "None." }, { finish_reason: "stop" })], data);
    await openrouterAdapter.complete("sk-or", params({ modelId: model, history }));
    expect(sent[0].body.messages[2].reasoning_details).toEqual(details);
    await openrouterAdapter.complete("sk-or", params({ modelId: "openai/gpt-6-sol", history }));
    expect(sent[1].body.messages[2]).not.toHaveProperty("reasoning_details");
  });
});

describe("Claude", () => {
  /** The request the SDK sent; the API is made to refuse it so nothing streams. */
  async function requestFor(over: Partial<CompletionParams>) {
    const sent: any[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "stop here" } }), { status: 400, headers: { "content-type": "application/json" } });
    }));
    await anthropicAdapter.complete("sk-ant", params({ modelId: "claude-sonnet-5", ...over })).catch(() => {});
    return sent[0];
  }

  it("thinks adaptively at the model's own effort unless one is chosen", async () => {
    const body = await requestFor({});
    expect(body.thinking).toEqual({ type: "adaptive" });
    expect(body).not.toHaveProperty("output_config");
    expect(body.max_tokens).toBe(16000);
  });

  it("sends the chosen effort, with room to finish at the top levels", async () => {
    expect((await requestFor({ effort: "low" })).output_config).toEqual({ effort: "low" });
    const max = await requestFor({ effort: "max" });
    expect(max.output_config).toEqual({ effort: "max" });
    expect(max.max_tokens).toBe(64000);
  });

  it("leaves adaptive thinking off the models that reject it", async () => {
    expect(await requestFor({ modelId: "claude-haiku-4-5-20251001" })).not.toHaveProperty("thinking");
    expect(await requestFor({ modelId: "claude-sonnet-4-5" })).not.toHaveProperty("thinking");
    expect((await requestFor({ modelId: "claude-opus-4-6" })).thinking).toEqual({ type: "adaptive" });
    // The models list has the last word.
    expect(await requestFor({ modelId: "claude-next", model: { id: "claude-next", name: "Next", adaptiveThinking: false } })).not.toHaveProperty("thinking");
  });
});
