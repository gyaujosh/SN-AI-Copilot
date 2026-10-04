// OpenRouter adapter — the OpenAI-compatible Chat Completions API with SSE
// streaming, function-calling tool use and basic retry-with-backoff for
// 429/5xx (no SDK on this path). OpenRouter takes one `reasoning` setting for
// every vendor's models and reports the exact cost of each call.

import type Anthropic from "@anthropic-ai/sdk";
import { labelFor } from "./imageContent";
import { estimatedUsage, postStream, readLines, sseData, stallLimit } from "./http";
import { withPartialUsage } from "./types";
import type { CompletionParams, CompletionResult, NeutralMessage, ProviderAdapter, UsageInfo } from "./types";

function toOpenAiTools(tools: Anthropic.Tool[]): any[] {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
}

/** The reasoning a model returned with a message, handed back only to that
 * same model: it has to see its own reasoning unchanged to carry it across
 * tool calls, and no other model can read it. */
function reasoningFor(raw: Extract<NeutralMessage, { role: "assistant" }>["raw"], modelId: string): any[] | undefined {
  const content = raw?.provider === "openrouter" ? raw.content : null;
  return content?.model === modelId && Array.isArray(content.reasoningDetails) && content.reasoningDetails.length ? content.reasoningDetails : undefined;
}

function toOpenAiMessages(system: string, history: NeutralMessage[], modelId: string): any[] {
  const messages: any[] = [{ role: "system", content: system }];
  let imageOrdinal = 0;
  for (const m of history) {
    if (m.role === "user") {
      if (m.images?.length) {
        const content: any[] = m.images.flatMap((img) => [
          { type: "text", text: labelFor(img, ++imageOrdinal) },
          { type: "image_url", image_url: { url: `data:${img.mediaType};base64,${img.data}` } },
        ]);
        content.push({ type: "text", text: m.text });
        messages.push({ role: "user", content });
      } else {
        messages.push({ role: "user", content: m.text });
      }
    } else if (m.role === "assistant") {
      const msg: any = { role: "assistant", content: m.text || null };
      if (m.toolCalls.length) {
        msg.tool_calls = m.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: JSON.stringify(tc.input || {}) },
        }));
      }
      const reasoning = reasoningFor(m.raw, modelId);
      if (reasoning) msg.reasoning_details = reasoning;
      messages.push(msg);
    } else {
      for (const r of m.results) {
        messages.push({ role: "tool", tool_call_id: r.toolCallId, content: r.content });
      }
    }
  }
  return messages;
}

interface PendingToolCall {
  id: string;
  name: string;
  args: string;
}

/** Reasoning arrives in pieces, each naming the block it belongs to by
 * `index`: text, summaries and encrypted data are appended, the rest set. */
function mergeReasoning(blocks: Map<number, any>, pieces: unknown): void {
  if (!Array.isArray(pieces)) return;
  for (const piece of pieces) {
    if (!piece || typeof piece !== "object") continue;
    const index = typeof piece.index === "number" ? piece.index : blocks.size;
    const block = blocks.get(index) ?? {};
    for (const [field, value] of Object.entries(piece)) {
      if ((field === "text" || field === "summary" || field === "data") && typeof value === "string") block[field] = (block[field] ?? "") + value;
      else if (value !== undefined && value !== null) block[field] = value;
    }
    blocks.set(index, block);
  }
}

async function streamChatCompletion(apiKey: string, params: CompletionParams): Promise<CompletionResult> {
  const body: any = {
    model: params.modelId,
    stream: true,
    stream_options: { include_usage: true },
    messages: toOpenAiMessages(params.system, params.history, params.modelId),
    tools: toOpenAiTools(params.tools),
    // The exact cost of the call, reported with its usage.
    usage: { include: true },
  };
  if (params.effort) body.reasoning = { effort: params.effort };

  const reader = await postStream("OpenRouter", "https://openrouter.ai/api/v1/chat/completions", { Authorization: `Bearer ${apiKey}` }, body, params.signal);

  let text = "";
  let finishReason: string | null = null;
  let usage: StreamUsage | null = null;
  const toolCalls = new Map<number, PendingToolCall>();
  const reasoning = new Map<number, any>();

  const processLine = (line: string) => {
    const json = sseData(line);
    if (!json) return;
    // Usage arrives on the final chunk (often with an empty choices array).
    if (json.usage) usage = json.usage;
    const choice = json.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta || {};
    if (typeof delta.content === "string" && delta.content) {
      text += delta.content;
      params.onTextDelta(delta.content);
    }
    mergeReasoning(reasoning, delta.reasoning_details);
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const index = tc.index ?? 0;
        const existing = toolCalls.get(index) || { id: "", name: "", args: "" };
        if (tc.id) existing.id = tc.id;
        if (tc.function?.name) existing.name += tc.function.name;
        if (tc.function?.arguments) existing.args += tc.function.arguments;
        toolCalls.set(index, existing);
      }
    }
  };

  try {
    await readLines(reader, stallLimit(params.effort), processLine);
  } catch (err) {
    // The provider accepted the request, so what it processed is billed:
    // its own counts if they arrived before the drop, an estimate otherwise.
    throw withPartialUsage(err, toUsageInfo(usage, body.messages, text, toolCalls));
  }

  const neutralCalls = [...toolCalls.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, tc]) => {
      let input: any;
      try {
        input = tc.args ? JSON.parse(tc.args) : {};
      } catch {
        input = {};
      }
      return { id: tc.id || `call_${Date.now()}_${index}`, name: tc.name, input };
    })
    .filter((tc) => tc.name);

  const reasoningDetails = [...reasoning.entries()].sort((a, b) => a[0] - b[0]).map(([, block]) => block);
  return {
    text,
    toolCalls: neutralCalls,
    stopReason: neutralCalls.length > 0 || finishReason === "tool_calls" ? "tool_use" : "end_turn",
    raw: { provider: "openrouter", content: reasoningDetails.length ? { model: params.modelId, reasoningDetails } : null },
    usage: toUsageInfo(usage, body.messages, text, toolCalls),
  };
}

interface StreamUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  cost?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

function toUsageInfo(u: StreamUsage | null, messages: unknown, text: string, toolCalls: Map<number, PendingToolCall>): UsageInfo {
  if (u) {
    // Cached prompt tokens are billed at a discount — split them out so
    // pricing can apply the cache-read multiplier instead of full price.
    const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
    const prompt = u.prompt_tokens ?? 0;
    return {
      inputTokens: Math.max(0, prompt - cached),
      outputTokens: u.completion_tokens ?? 0,
      cacheReadTokens: cached,
      cacheWriteTokens: 0,
      costUsd: typeof u.cost === "number" ? u.cost : undefined,
    };
  }
  const responseChars = text.length + [...toolCalls.values()].reduce((n, tc) => n + tc.args.length, 0);
  return estimatedUsage(JSON.stringify(messages).length, responseChars);
}

export const openrouterAdapter: ProviderAdapter = {
  id: "openrouter",
  complete: streamChatCompletion,
};
