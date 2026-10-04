// Streaming HTTP for the adapters that don't use an SDK (OpenAI and
// OpenRouter): a deadline for the first response and between chunks, retry
// with backoff for 429/5xx, and SSE line reading.

import type { EffortLevel } from "../../shared/types";
import type { UsageInfo } from "./types";

/** A stream that goes silent this long is treated as dead rather than waited on forever. */
const STALL_MS = 180_000;
/** At the top efforts a model can reason for minutes before it sends anything. */
const DEEP_STALL_MS = 600_000;
/** Likewise for the first response: headers must arrive within this. */
const RESPONSE_MS = 180_000;

export function stallLimit(effort: EffortLevel | undefined): number {
  return effort === "xhigh" || effort === "max" ? DEEP_STALL_MS : STALL_MS;
}

async function fetchWithDeadline(url: string, init: RequestInit, signal: AbortSignal, ms: number): Promise<Response> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, ms);
  // Stays attached for the body too, so Stop still ends a stream in progress.
  if (signal.aborted) controller.abort(signal.reason);
  else signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true });
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (cause) {
    if (timedOut && !signal.aborted) throw Object.assign(new Error("The provider did not start answering in time."), { code: "PROVIDER_TIMEOUT" });
    throw cause;
  } finally {
    clearTimeout(timer);
  }
}

async function readOrStall(reader: ReadableStreamDefaultReader<Uint8Array>, ms: number): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          void reader.cancel().catch(() => {});
          reject(Object.assign(new Error("The provider stopped sending data."), { code: "PROVIDER_STALLED" }));
        }, ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * POST a streaming request and hand back its body. 429 and 5xx are retried
 * with backoff; any other refusal throws "<name> API error <status>: <the
 * provider's message>".
 */
export async function postStream(
  name: string,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal
): Promise<ReadableStreamDefaultReader<Uint8Array>> {
  const maxAttempts = 3;
  let lastError = "";
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 1500 * Math.pow(2, attempt - 1)));
      if (signal.aborted) throw new DOMException("aborted", "AbortError");
    }
    const response = await fetchWithDeadline(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    }, signal, RESPONSE_MS);
    if (response.ok) {
      if (!response.body) throw new Error(`${name} returned no response body`);
      return response.body.getReader();
    }
    const errBody = await response.json().catch(() => ({}));
    lastError = errBody?.error?.message || `HTTP ${response.status}`;
    if (response.status === 429 || response.status >= 500) continue;
    throw new Error(`${name} API error ${response.status}: ${lastError}`);
  }
  throw new Error(`${name} API error after retries: ${lastError}`);
}

/** Hands each complete line of an SSE stream to `onLine` as it arrives. */
export async function readLines(reader: ReadableStreamDefaultReader<Uint8Array>, stallMs: number, onLine: (line: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await readOrStall(reader, stallMs);
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      onLine(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
    }
  }
  buffer += decoder.decode();
  if (buffer) onLine(buffer);
}

/** The JSON on an SSE `data:` line; undefined for anything else. */
export function sseData(line: string): any {
  const trimmed = line.trim();
  if (!trimmed.startsWith("data:")) return undefined;
  const payload = trimmed.slice(5).trim();
  if (!payload || payload === "[DONE]") return undefined;
  try {
    return JSON.parse(payload);
  } catch {
    return undefined;
  }
}

/** When the provider never reported usage (a dropped stream, proxy quirks),
 * estimate it from character counts (~4 chars/token) rather than billing $0. */
export function estimatedUsage(requestChars: number, responseChars: number): UsageInfo {
  return {
    inputTokens: Math.ceil(requestChars / 4),
    outputTokens: Math.ceil(responseChars / 4),
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    approximate: true,
  };
}
