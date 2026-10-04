// Anthropic adapter — streaming via the official SDK with adaptive thinking
// (on the models that take it), the chosen effort, and a cached static
// system prompt.

import Anthropic from "@anthropic-ai/sdk";
import { labelFor } from "./imageContent";
import { withPartialUsage } from "./types";
import type { CompletionParams, CompletionResult, NeutralMessage, ProviderAdapter, UsageInfo } from "./types";

/** Usage of a stream that ended early. The prompt's counts arrive with
 * message_start; output is reported only at the end, so it is estimated from
 * what was generated (~4 chars/token) — thinking that was never shown is
 * missed, hence `approximate`. Nothing is billed before message_start. */
function partialUsage(snapshot: Anthropic.Message | undefined): UsageInfo | undefined {
  if (!snapshot) return undefined;
  const u = snapshot.usage as any;
  const generatedChars = snapshot.content.reduce((n, block: any) =>
    n + (block.type === "text" ? block.text.length
    : block.type === "thinking" ? (block.thinking ?? "").length
    : block.type === "tool_use" ? JSON.stringify(block.input ?? {}).length
    : 0), 0);
  return {
    inputTokens: u?.input_tokens ?? 0,
    outputTokens: Math.max(u?.output_tokens ?? 0, Math.ceil(generatedChars / 4)),
    cacheReadTokens: u?.cache_read_input_tokens ?? 0,
    cacheWriteTokens: u?.cache_creation_input_tokens ?? 0,
    approximate: true,
  };
}

/** Before its models list says, whether a model takes adaptive thinking:
 * Claude 4.6 and later do; Claude 3, the 4.5 generation and earlier 4.x
 * models reject it. */
function takesAdaptiveThinking(modelId: string): boolean {
  return !/^claude-(?:3|haiku-4|(?:opus|sonnet)-4(?:-[0-5])?(?:-\d{8})?$)/.test(modelId);
}

function toAnthropicMessages(history: NeutralMessage[]): Anthropic.MessageParam[] {
  const messages: Anthropic.MessageParam[] = [];
  let imageOrdinal = 0;
  for (const m of history) {
    if (m.role === "user") {
      const content: Anthropic.ContentBlockParam[] = [];
      for (const img of m.images || []) {
        content.push({ type: "text", text: labelFor(img, ++imageOrdinal) });
        content.push({
          type: "image",
          source: { type: "base64", media_type: img.mediaType as any, data: img.data },
        });
      }
      content.push({ type: "text", text: m.text });
      messages.push({ role: "user", content });
    } else if (m.role === "assistant") {
      if (m.raw?.provider === "anthropic" && Array.isArray(m.raw.content)) {
        // Native content (preserves thinking blocks / signatures).
        messages.push({ role: "assistant", content: m.raw.content });
      } else {
        const content: Anthropic.ContentBlockParam[] = [];
        if (m.text.trim()) content.push({ type: "text", text: m.text });
        for (const tc of m.toolCalls) {
          content.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input || {} });
        }
        if (content.length === 0) content.push({ type: "text", text: "(continuing)" });
        messages.push({ role: "assistant", content });
      }
    } else {
      messages.push({
        role: "user",
        content: m.results.map((r) => ({
          type: "tool_result" as const,
          tool_use_id: r.toolCallId,
          content: r.content,
          is_error: !!r.isError,
        })),
      });
    }
  }
  return messages;
}

export const anthropicAdapter: ProviderAdapter = {
  id: "anthropic",

  async complete(apiKey: string, params: CompletionParams): Promise<CompletionResult> {
    const client = new Anthropic({
      apiKey,
      dangerouslyAllowBrowser: true,
      maxRetries: 4,
      defaultHeaders: { "anthropic-dangerous-direct-browser-access": "true" },
    });

    const adaptive = params.model?.adaptiveThinking ?? takesAdaptiveThinking(params.modelId);
    // The top efforts think and act at length; give them room to finish.
    const deep = params.effort === "xhigh" || params.effort === "max";
    const stream = client.messages.stream(
      {
        model: params.modelId,
        max_tokens: deep ? 64000 : 16000,
        ...(adaptive ? { thinking: { type: "adaptive" as const } } : {}),
        ...(params.effort ? { output_config: { effort: params.effort as Anthropic.OutputConfig["effort"] } } : {}),
        system: [{ type: "text", text: params.system, cache_control: { type: "ephemeral" } } as any],
        tools: params.tools,
        messages: toAnthropicMessages(params.history),
      },
      { signal: params.signal }
    );

    stream.on("text", params.onTextDelta);
    let message: Anthropic.Message;
    try {
      message = await stream.finalMessage();
    } catch (err) {
      throw withPartialUsage(err, partialUsage(stream.currentMessage));
    }

    let text = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    // Fable-class models can decline via safety classifiers: HTTP 200,
    // stop_reason "refusal", empty content. Surface it instead of a blank turn.
    if ((message.stop_reason as string) === "refusal" && !text.trim()) {
      text = "The model declined this request (safety refusal). Try rephrasing, or switch to Opus in the model picker.";
    }
    const toolCalls = message.content
      .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
      .map((b) => ({ id: b.id, name: b.name, input: b.input || {} }));

    const usage = message.usage as any;

    return {
      text,
      toolCalls,
      stopReason: message.stop_reason === "tool_use" && toolCalls.length > 0 ? "tool_use" : "end_turn",
      raw: { provider: "anthropic", content: message.content },
      usage: {
        inputTokens: usage?.input_tokens ?? 0,
        outputTokens: usage?.output_tokens ?? 0,
        cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
        cacheWriteTokens: usage?.cache_creation_input_tokens ?? 0,
      },
    };
  },
};

export function describeAnthropicError(err: any): string | null {
  if (err instanceof Anthropic.AuthenticationError) return "Your Anthropic API key was rejected (401). Check it in Settings.";
  if (err instanceof Anthropic.RateLimitError) return "Rate limited by the Anthropic API (429). Wait a moment and try again.";
  if (err instanceof Anthropic.APIError) return `Anthropic API error ${err.status ?? ""}: ${err.message}`;
  return null;
}
