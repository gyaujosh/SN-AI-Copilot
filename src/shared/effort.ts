// Reasoning effort: how hard a model thinks before it answers. It is offered
// only for models that take it, with only the levels each one accepts. Claude
// and OpenRouter list both in their model catalogs; OpenAI's catalog doesn't,
// so its levels come from the table below, checked against OpenAI's model
// pages on EFFORTS_CHECKED. A model with no effort chosen is sent none and
// runs at its own default.

import type { EffortLevel, ModelListEntry, ProviderId } from "./types";

/** Lowest to highest, the order the picker shows them in. */
export const EFFORT_LEVELS: EffortLevel[] = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

export const EFFORT_LABELS: Record<EffortLevel, string> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

export const EFFORTS_CHECKED = "2026-09-26";

export function isEffortLevel(value: unknown): value is EffortLevel {
  return typeof value === "string" && (EFFORT_LEVELS as string[]).includes(value);
}

/** The known levels among `levels`, lowest first. */
export function orderEfforts(levels: readonly unknown[]): EffortLevel[] {
  return EFFORT_LEVELS.filter((level) => levels.includes(level));
}

export interface ModelEfforts {
  /** Empty: the model has no effort to choose. */
  efforts: EffortLevel[];
  defaultEffort?: EffortLevel;
}

/** OpenAI reasoning models by family, newest first; the first match wins. */
const OPENAI_EFFORTS: Array<[RegExp, EffortLevel[], EffortLevel]> = [
  [/^gpt-6-astra/, ["low", "medium", "high", "xhigh", "max"], "medium"],
  [/^gpt-6(?!\d)/, ["none", "low", "medium", "high", "xhigh", "max"], "medium"],
  [/^gpt-5\.6(?!\d)/, ["none", "low", "medium", "high", "xhigh", "max"], "medium"],
  [/^gpt-5\.5(?!\d)/, ["none", "low", "medium", "high", "xhigh"], "medium"],
  [/^gpt-5\.[234](?!\d)/, ["none", "low", "medium", "high", "xhigh"], "none"],
  [/^gpt-5\.1(?!\d)/, ["none", "low", "medium", "high"], "none"],
  [/^gpt-5(?![.\d])/, ["minimal", "low", "medium", "high"], "medium"],
  [/^o[134](?!\d)/, ["low", "medium", "high"], "medium"],
];

/**
 * Whether an OpenAI model reasons, and the levels it takes: null for models
 * that don't reason (GPT-4 and earlier, chat snapshots, retired o1 previews).
 * Pro, codex and deep-research models reason at levels that vary by model,
 * so they run at their own. A newer family than the table knows is offered
 * the levels every reasoning model accepts.
 */
export function openAiReasoning(modelId: string): ModelEfforts | null {
  const id = modelId.trim().toLowerCase();
  if (/^gpt-[1-4](?!\d)|-chat\b|^o1-(?:mini|preview)/.test(id)) return null;
  if (/-pro\b|codex|deep-research/.test(id)) return { efforts: [] };
  for (const [family, efforts, defaultEffort] of OPENAI_EFFORTS) {
    if (family.test(id)) return { efforts, defaultEffort };
  }
  if (/^(?:gpt-\d|o\d)/.test(id)) return { efforts: ["low", "medium", "high"] };
  return null;
}

/** The effort levels a model offers: from its catalog entry, or OpenAI's table. */
export function modelEfforts(provider: ProviderId, modelId: string, entry?: ModelListEntry): ModelEfforts {
  if (provider === "openai") return openAiReasoning(modelId) ?? { efforts: [] };
  return entry?.efforts?.length ? { efforts: entry.efforts, defaultEffort: entry.defaultEffort } : { efforts: [] };
}

export function effortKey(provider: ProviderId, modelId: string): string {
  return `${provider}:${modelId}`;
}

/** The effort to send: the one chosen for this model, if the model still takes it. */
export function chosenEffort(
  efforts: Record<string, EffortLevel> | undefined,
  provider: ProviderId,
  modelId: string,
  offered: EffortLevel[]
): EffortLevel | undefined {
  const level = efforts?.[effortKey(provider, modelId)];
  return level && offered.includes(level) ? level : undefined;
}
