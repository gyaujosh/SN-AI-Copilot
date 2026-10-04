// The two invariants that keep image turns honest: every image the model gets
// is named, and old image bytes age out of requests instead of riding forever
// — but never the newest message's, which are the reason the turn exists.

import { describe, expect, it } from "vitest";
import { capHistoryImages, decodedBytes, labelFor } from "../../src/background/providers/imageContent";
import type { NeutralImage, NeutralMessage } from "../../src/background/providers/types";

// base64 string of `bytes` decoded bytes (4 chars per 3 bytes, unpadded sizes
// are fine for this math).
function b64(bytes: number, fill = "A"): string {
  return fill.repeat(Math.ceil((bytes * 4) / 3));
}

function img(name: string | undefined, bytes: number): NeutralImage {
  return { mediaType: "image/webp", data: b64(bytes), name };
}

const user = (text: string, images?: NeutralImage[]): NeutralMessage =>
  images ? { role: "user", text, images } : { role: "user", text };
const assistant = (text: string): NeutralMessage => ({ role: "assistant", text, toolCalls: [] });

describe("labelFor", () => {
  it("names the image, falling back to its ordinal", () => {
    expect(labelFor(img("screenshot.webp", 10), 3)).toBe("[Attached image: screenshot.webp]");
    expect(labelFor(img(undefined, 10), 3)).toBe("[Attached image: image 3]");
  });
});

describe("decodedBytes", () => {
  it("reads real bytes through the base64 inflation", () => {
    expect(decodedBytes(img("x", 3000))).toBe(3000);
  });
});

describe("capHistoryImages", () => {
  it("keeps everything while the budget holds, untouched", () => {
    const history = [user("a", [img("one.webp", 100)]), assistant("ok"), user("b", [img("two.webp", 100)])];
    expect(capHistoryImages(history, 1000)).toEqual(history);
  });

  it("the newest message's images survive even alone over the cap", () => {
    const history = [user("b", [img("huge.webp", 5000)])];
    expect(capHistoryImages(history, 1000)).toEqual(history);
  });

  it("drops the oldest first and leaves a named marker where each stood", () => {
    const history = [
      user("first", [img("old.webp", 600)]),
      assistant("ok"),
      user("second", [img("new.webp", 600)]),
    ];
    const capped = capHistoryImages(history, 1000);
    expect(capped[2]).toEqual(history[2]);
    expect(capped[0]).toEqual({
      role: "user",
      text: "first\n\n[Image old.webp was attached here; dropped from context to save space.]",
      images: undefined,
    });
    // Non-destructive: the input still has its image.
    expect((history[0] as { images?: NeutralImage[] }).images).toHaveLength(1);
  });

  it("can drop some of a message's images and keep the rest", () => {
    const history = [
      user("first", [img("keep.webp", 300), img("drop.webp", 600)]),
      user("second", [img("new.webp", 500)]),
    ];
    const capped = capHistoryImages(history, 1000);
    const older = capped[0] as { text: string; images?: NeutralImage[] };
    expect(older.images?.map((i) => i.name)).toEqual(["keep.webp"]);
    expect(older.text).toContain("[Image drop.webp was attached here; dropped from context to save space.]");
    expect(older.text).not.toContain("keep.webp was attached");
  });

  it("assistant and tool messages pass through by reference", () => {
    const history = [assistant("ok"), { role: "tool_results" as const, results: [] }];
    const capped = capHistoryImages(history, 0);
    expect(capped[0]).toBe(history[0]);
    expect(capped[1]).toBe(history[1]);
  });

  it("a history with no images is returned as-is regardless of cap", () => {
    const history = [user("plain"), assistant("ok")];
    expect(capHistoryImages(history, 0)).toEqual(history);
  });
});
