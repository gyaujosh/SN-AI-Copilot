// Images riding conversation history: names and byte budgets.
//
// Two failure modes live here. Unlabeled image blocks give the model no way
// to tell this turn's screenshot from last turn's, so it anchors on whichever
// has more discussion around it — usually the old one. And history that never
// sheds image bytes re-ships every screenshot on every request until the
// transport (or the wallet) gives out. Every adapter labels through labelFor;
// the agent caps through capHistoryImages before each completion.

import type { NeutralImage, NeutralMessage } from "./types";

/** Total decoded image bytes allowed across the history of one request.
 * The newest user message's images are exempt — they are the point. */
export const HISTORY_IMAGE_BYTE_CAP = 8_000_000;

/** The text block that precedes an image block, naming it for the model.
 * `ordinal` is the image's 1-based position across the whole history. */
export function labelFor(img: NeutralImage, ordinal: number): string {
  return `[Attached image: ${img.name || `image ${ordinal}`}]`;
}

/** Decoded size of a base64 payload — the string is 4/3 the real bytes. */
export function decodedBytes(img: NeutralImage): number {
  return Math.floor((img.data.length * 3) / 4);
}

/**
 * Fit history images into `maxBytes`, newest first.
 *
 * The newest user message that carries images always keeps them, even alone
 * over the cap — dropping what the user just attached is never right. Older
 * images are kept while budget remains and otherwise removed, each leaving a
 * named marker in its message text so the model knows something was there.
 * Non-destructive: returns fresh message objects, the input is untouched.
 */
export function capHistoryImages(
  history: NeutralMessage[],
  maxBytes: number = HISTORY_IMAGE_BYTE_CAP
): NeutralMessage[] {
  let budget = maxBytes;
  let newestKept = false;
  const out: NeutralMessage[] = new Array(history.length);
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role !== "user" || !m.images?.length) {
      out[i] = m;
      continue;
    }
    if (!newestKept) {
      newestKept = true;
      budget -= m.images.reduce((n, img) => n + decodedBytes(img), 0);
      out[i] = m;
      continue;
    }
    const kept: NeutralImage[] = [];
    const markers: string[] = [];
    for (const img of m.images) {
      const bytes = decodedBytes(img);
      if (bytes <= budget) {
        budget -= bytes;
        kept.push(img);
      } else {
        markers.push(`[Image ${img.name || "attachment"} was attached here; dropped from context to save space.]`);
      }
    }
    if (!markers.length) {
      out[i] = m;
      continue;
    }
    out[i] = {
      ...m,
      text: `${m.text}\n\n${markers.join("\n")}`,
      images: kept.length ? kept : undefined,
    };
  }
  return out;
}
