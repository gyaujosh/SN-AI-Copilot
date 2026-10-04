// Provider abstraction. The agent stores conversation history in a
// provider-neutral format and converts per request, so the user can switch
// providers mid-conversation without losing context. Assistant messages keep
// the provider-native content in `raw` so provider-specific blocks (e.g.
// Anthropic thinking blocks) round-trip losslessly while that provider is
// still selected.

import type Anthropic from "@anthropic-ai/sdk";
import type { EffortLevel, ModelListEntry, ProviderId } from "../../shared/types";

export interface NeutralImage {
  mediaType: string;
  data: string; // base64
  /** Original attachment filename — the only handle the user and the model
   * share for telling this turn's screenshot from last turn's. */
  name?: string;
}

export interface NeutralToolCall {
  id: string;
  name: string;
  input: any;
}

export interface NeutralToolResult {
  toolCallId: string;
  content: string;
  isError?: boolean;
}

export type NeutralMessage =
  | { role: "user"; text: string; images?: NeutralImage[] }
  | { role: "assistant"; text: string; toolCalls: NeutralToolCall[]; raw?: { provider: ProviderId; content: any } }
  | { role: "tool_results"; results: NeutralToolResult[] };

export interface CompletionParams {
  modelId: string;
  system: string;
  /** Canonical tool definitions (Anthropic shape); adapters convert as needed. */
  tools: Anthropic.Tool[];
  history: NeutralMessage[];
  signal: AbortSignal;
  onTextDelta: (text: string) => void;
  /** The effort chosen for this model, already checked against the levels it
   * takes. Absent: none is sent and the model runs at its own default. */
  effort?: EffortLevel;
  /** The model's catalog entry, when its list has been loaded. */
  model?: ModelListEntry;
}

export interface UsageInfo {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Exact cost in USD when the provider reports it (OpenRouter). */
  costUsd?: number;
  /** Token counts were estimated (provider omitted the usage chunk). */
  approximate?: boolean;
}

/** A call cut off mid-stream (Stop, a dropped connection) is still billed
 * for what the provider processed, so its usage rides on the error. */
export function withPartialUsage<E>(err: E, usage: UsageInfo | undefined): E {
  if (usage && err && typeof err === "object") {
    try {
      (err as { partialUsage?: UsageInfo }).partialUsage = usage;
    } catch {
      /* a frozen error just goes uncounted */
    }
  }
  return err;
}

export function partialUsageOf(err: unknown): UsageInfo | undefined {
  return err && typeof err === "object" ? (err as { partialUsage?: UsageInfo }).partialUsage : undefined;
}

export interface CompletionResult {
  text: string;
  toolCalls: NeutralToolCall[];
  stopReason: "tool_use" | "end_turn";
  raw: { provider: ProviderId; content: any };
  usage?: UsageInfo;
}

export interface ProviderAdapter {
  id: ProviderId;
  complete(apiKey: string, params: CompletionParams): Promise<CompletionResult>;
}
