// OpenAI adapter — the Responses API, streamed. Chat Completions refuses
// function tools on OpenAI's newer reasoning models unless reasoning is
// switched off ("Function tools with reasoning_effort are not supported"),
// and those models reason by default; Responses takes tools at every effort.
// Requests are stateless (store: false) and carry the whole conversation. A
// reasoning model's encrypted reasoning rides along between tool calls, so it
// keeps its train of thought through a run.

import type Anthropic from "@anthropic-ai/sdk";
import { openAiReasoning } from "../../shared/effort";
import { labelFor } from "./imageContent";
import { estimatedUsage, postStream, readLines, sseData, stallLimit } from "./http";
import { withPartialUsage } from "./types";
import type { CompletionParams, CompletionResult, NeutralMessage, NeutralToolCall, ProviderAdapter, UsageInfo } from "./types";

const RESPONSES_URL = "https://api.openai.com/v1/responses";

function toTools(tools: Anthropic.Tool[]): any[] {
  // Responses makes function schemas strict unless told otherwise, and strict
  // schemas must list every property as required — these don't.
  return tools.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.input_schema, strict: false }));
}

/** A reply's own output items, replayed as they came — only to the model that
 * produced them, since its reasoning is encrypted for it alone. Reasoning
 * without its encrypted content, or with nothing after it, can't be replayed. */
function nativeItems(raw: Extract<NeutralMessage, { role: "assistant" }>["raw"], modelId: string): any[] | null {
  const content = raw?.provider === "openai" ? raw.content : null;
  if (content?.model !== modelId || !Array.isArray(content.items)) return null;
  const items = content.items.filter((item: any) => item?.type !== "reasoning" || typeof item.encrypted_content === "string");
  while (items.length && items[items.length - 1]?.type === "reasoning") items.pop();
  return items.length ? items : null;
}

function toInput(history: NeutralMessage[], modelId: string): any[] {
  const input: any[] = [];
  let imageOrdinal = 0;
  for (const m of history) {
    if (m.role === "user") {
      const content: any[] = [];
      for (const img of m.images ?? []) {
        content.push({ type: "input_text", text: labelFor(img, ++imageOrdinal) });
        content.push({ type: "input_image", image_url: `data:${img.mediaType};base64,${img.data}` });
      }
      content.push({ type: "input_text", text: m.text });
      input.push({ role: "user", content });
    } else if (m.role === "assistant") {
      const native = nativeItems(m.raw, modelId);
      if (native) {
        input.push(...native);
        continue;
      }
      if (m.text) input.push({ role: "assistant", content: m.text });
      for (const tc of m.toolCalls) {
        input.push({ type: "function_call", call_id: tc.id, name: tc.name, arguments: JSON.stringify(tc.input || {}) });
      }
    } else {
      for (const r of m.results) input.push({ type: "function_call_output", call_id: r.toolCallId, output: r.content });
    }
  }
  return input;
}

interface ResponsesUsage {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
}

function parseArguments(args: unknown): any {
  if (typeof args !== "string" || !args) return {};
  try {
    return JSON.parse(args);
  } catch {
    return {};
  }
}

async function streamResponse(apiKey: string, params: CompletionParams): Promise<CompletionResult> {
  const reasons = openAiReasoning(params.modelId) !== null;
  const body: any = {
    model: params.modelId,
    instructions: params.system,
    input: toInput(params.history, params.modelId),
    tools: toTools(params.tools),
    stream: true,
    store: false,
  };
  if (reasons) body.include = ["reasoning.encrypted_content"];
  if (params.effort) body.reasoning = { effort: params.effort };

  const reader = await postStream("OpenAI", RESPONSES_URL, { Authorization: `Bearer ${apiKey}` }, body, params.signal);

  let streamed = "";
  /** Finished output items by position, for a stream that ends without its summary. */
  const done = new Map<number, any>();
  /** Tool-call arguments so far, for estimating a cut-off call. */
  const args = new Map<number, string>();
  let response: any = null;
  let failure: string | null = null;

  const onLine = (line: string) => {
    const event = sseData(line);
    switch (event?.type) {
      case "response.output_text.delta":
        if (typeof event.delta === "string" && event.delta) {
          streamed += event.delta;
          params.onTextDelta(event.delta);
        }
        break;
      case "response.function_call_arguments.delta":
        args.set(event.output_index ?? 0, (args.get(event.output_index ?? 0) ?? "") + (event.delta ?? ""));
        break;
      case "response.output_item.done":
        if (event.item) done.set(event.output_index ?? done.size, event.item);
        break;
      case "response.completed":
      case "response.incomplete":
        response = event.response ?? null;
        break;
      case "response.failed":
        response = event.response ?? null;
        failure = event.response?.error?.message || "the response failed";
        break;
      case "error":
        failure = event.message || event.error?.message || "the stream reported an error";
        break;
    }
  };

  const requestChars = JSON.stringify(body.input).length + params.system.length;
  const usageSoFar = (): UsageInfo => {
    const argChars = [...args.values()].reduce((n, a) => n + a.length, 0);
    return toUsageInfo(response?.usage, requestChars, streamed.length + argChars);
  };

  try {
    await readLines(reader, stallLimit(params.effort), onLine);
  } catch (err) {
    // Accepted and cut off (Stop, a dropped connection): what the provider
    // processed is billed, estimated here since usage comes only at the end.
    throw withPartialUsage(err, usageSoFar());
  }
  if (failure) throw withPartialUsage(new Error(`OpenAI API error: ${failure}`), response?.usage ? usageSoFar() : undefined);

  const output: any[] = Array.isArray(response?.output) && response.output.length
    ? response.output
    : [...done.entries()].sort((a, b) => a[0] - b[0]).map(([, item]) => item);

  const text = output
    .filter((item) => item?.type === "message")
    .flatMap((item) => (Array.isArray(item.content) ? item.content : []))
    .map((part: any) => (part?.type === "output_text" ? part.text ?? "" : part?.type === "refusal" ? part.refusal ?? "" : ""))
    .join("") || streamed;

  const toolCalls: NeutralToolCall[] = output
    .filter((item) => item?.type === "function_call" && item.name)
    .map((item, i) => ({ id: item.call_id || item.id || `call_${Date.now()}_${i}`, name: item.name, input: parseArguments(item.arguments) }));

  // Cut short (out of tokens): calls it had started aren't whole, so none run.
  const complete = response?.status !== "incomplete";
  return {
    text,
    toolCalls,
    stopReason: toolCalls.length > 0 && complete ? "tool_use" : "end_turn",
    raw: { provider: "openai", content: { model: params.modelId, items: output } },
    usage: toUsageInfo(response?.usage, requestChars, text.length + [...args.values()].reduce((n, a) => n + a.length, 0)),
  };
}

function toUsageInfo(u: ResponsesUsage | undefined, requestChars: number, responseChars: number): UsageInfo {
  if (u && typeof u.input_tokens === "number") {
    // Cached prompt tokens are billed at a discount — split them out so
    // pricing can apply the cache-read multiplier instead of full price.
    const cached = u.input_tokens_details?.cached_tokens ?? 0;
    return {
      inputTokens: Math.max(0, u.input_tokens - cached),
      outputTokens: u.output_tokens ?? 0,
      cacheReadTokens: cached,
      cacheWriteTokens: 0,
    };
  }
  return estimatedUsage(requestChars, responseChars);
}

export const openaiAdapter: ProviderAdapter = {
  id: "openai",
  complete: streamResponse,
};
