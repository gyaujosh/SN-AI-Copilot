// optimizeImage orchestration, driven by fake browser calls.
//
// jsdom has neither createImageBitmap nor a canvas encoder, so the three
// effects are injected. What is under test is the sequencing — which encodings
// get attempted, in what order, at what dimensions, and which one ships.

import { describe, expect, it, vi } from "vitest";
import { IMAGE_LIMITS, base64Bytes } from "../../src/shared/imagePolicy";
import {
  optimizeImage,
  renameForType,
  type DecodedImage,
  type OptimizeOutcome,
} from "../../src/sidepanel/lib/optimizeImage";

type Accepted = Extract<OptimizeOutcome, { ok: true }>;
type Rejected = Extract<OptimizeOutcome, { ok: false }>;

// These throw rather than return, so a test can never pass by quietly skipping
// its assertions when the outcome flips.
function accepted(r: OptimizeOutcome): Accepted {
  if (!r.ok) throw new Error(`expected an accepted image, got: ${(r as Rejected).reason}`);
  return r as Accepted;
}
function rejected(r: OptimizeOutcome): Rejected {
  if (r.ok) throw new Error(`expected a rejection, got: ${(r as Accepted).file.name}`);
  return r as Rejected;
}

function file(name: string, type: string): File {
  return { name, type } as File;
}

function decoder(width: number, height: number) {
  const close = vi.fn();
  const decode = vi.fn(
    async (): Promise<DecodedImage> => ({ width, height, source: {} as CanvasImageSource, close })
  );
  return { decode, close };
}

interface EncodeCall {
  type: string;
  quality?: number;
  width: number;
  height: number;
}

/** `sizes` maps "type@quality" (or just "type") to the byte length produced. */
function encoder(sizes: Record<string, number | null>) {
  const calls: EncodeCall[] = [];
  const encode = vi.fn(
    async (_img: DecodedImage, width: number, height: number, type: string, quality?: number) => {
      calls.push({ type, quality, width, height });
      const key = quality === undefined ? type : `${type}@${quality}`;
      const size = sizes[key] ?? sizes[type];
      return size == null ? null : new Uint8Array(size);
    }
  );
  return { encode, calls };
}

const bytesOf = (n: number) => async () => new Uint8Array(n);

const GIF_HEAD = [...[..."GIF89a"].map((c) => c.charCodeAt(0)), 1, 0, 1, 0, 0, 0, 0];
const GIF_FRAME = [0x21, 0xf9, 0x04, 0, 0, 0, 0, 0, 0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00];

describe("optimizeImage", () => {
  it("walks the quality ladder until an attempt fits, then stops", async () => {
    const { decode } = decoder(4000, 3000);
    const { encode, calls } = encoder({
      "image/webp@0.85": IMAGE_LIMITS.MAX_IMAGE_BYTES + 1_000_000,
      "image/webp@0.75": 4_000_000,
      "image/webp@0.65": 100,
    });

    const r = accepted(
      await optimizeImage(file("photo.jpg", "image/jpeg"), { readBytes: bytesOf(9_000_000), decode, encode })
    );

    expect(r.type).toBe("image/webp");
    expect(r.file.name).toBe("photo.webp");
    expect(r.file.bytes).toBe(4_000_000);
    // Resized once, to the fitted dimensions — and 0.65 was never reached.
    expect(calls.map((c) => c.quality)).toEqual([0.85, 0.75]);
    expect(calls.every((c) => c.width === 1568 && c.height === 1176)).toBe(true);
  });

  it("does not try PNG for a photograph — it could never win", async () => {
    const { decode } = decoder(2000, 1500);
    const { encode, calls } = encoder({ "image/webp@0.85": 500 });

    await optimizeImage(file("photo.jpg", "image/jpeg"), { readBytes: bytesOf(900_000), decode, encode });

    expect(calls.some((c) => c.type === "image/png")).toBe(false);
  });

  it("ships PNG for a screenshot when PNG actually measures smaller", async () => {
    const { decode } = decoder(1800, 1000);
    const { encode } = encoder({ "image/webp@0.85": 900_000, "image/png": 400_000 });

    const r = accepted(
      await optimizeImage(file("shot.png", "image/png"), { readBytes: bytesOf(3_000_000), decode, encode })
    );

    expect(r.type).toBe("image/png");
    expect(r.file.name).toBe("shot.png");
    expect(r.file.bytes).toBe(400_000);
  });

  it("passes an animated GIF through untouched and never encodes it", async () => {
    const animated = new Uint8Array([...GIF_HEAD, ...GIF_FRAME, ...GIF_FRAME, 0x3b]);
    const { decode } = decoder(100, 100);
    const { encode } = encoder({});

    const r = accepted(
      await optimizeImage(file("spinner.gif", "image/gif"), { readBytes: async () => animated, decode, encode })
    );

    expect(r.type).toBe("image/gif");
    expect(r.file.bytes).toBe(animated.byteLength);
    expect(encode).not.toHaveBeenCalled();
    expect(decode).not.toHaveBeenCalled();
  });

  it("refuses an oversized animated GIF rather than silently dropping frames", async () => {
    const big = new Uint8Array(IMAGE_LIMITS.MAX_IMAGE_BYTES + 1);
    big.set([...GIF_HEAD, ...GIF_FRAME, ...GIF_FRAME], 0);
    const { encode } = encoder({});

    const r = rejected(await optimizeImage(file("big.gif", "image/gif"), { readBytes: async () => big, encode }));

    expect(r.name).toBe("big.gif");
    expect(r.reason).toContain("animation");
    expect(encode).not.toHaveBeenCalled();
  });

  it("still optimizes a single-frame GIF", async () => {
    const still = new Uint8Array([...GIF_HEAD, ...GIF_FRAME, 0x3b]);
    const { decode } = decoder(3000, 3000);
    const { encode, calls } = encoder({ "image/webp@0.85": 20, "image/png": 5000 });

    const r = accepted(
      await optimizeImage(file("still.gif", "image/gif"), { readBytes: async () => still, decode, encode })
    );

    expect(r.type).toBe("image/webp");
    expect(r.file.name).toBe("still.webp");
    expect(calls[0]).toMatchObject({ width: 1568, height: 1568 });
  });

  it("keeps the original when re-encoding would only make it bigger", async () => {
    const { decode } = decoder(600, 400);
    const { encode, calls } = encoder({ "image/webp@0.85": 4000 });

    const r = accepted(
      await optimizeImage(file("tiny.jpg", "image/jpeg"), { readBytes: bytesOf(900), decode, encode })
    );

    expect(r.type).toBe("image/jpeg");
    expect(r.file.name).toBe("tiny.jpg");
    expect(r.file.bytes).toBe(900);
    // And it was never upscaled on the way through.
    expect(calls[0]).toMatchObject({ width: 600, height: 400 });
  });

  it("refuses an image that cannot be brought under the limit", async () => {
    const { decode } = decoder(4000, 4000);
    const oversized = IMAGE_LIMITS.MAX_IMAGE_BYTES + 500;
    const { encode } = encoder({
      "image/webp@0.85": oversized,
      "image/webp@0.75": oversized,
      "image/webp@0.65": oversized,
      "image/webp@0.55": oversized,
    });

    const r = rejected(
      await optimizeImage(file("wall.jpg", "image/jpeg"), { readBytes: bytesOf(40_000_000), decode, encode })
    );

    expect(r.reason).toContain("size limit");
  });

  it("refuses a format the providers do not accept", async () => {
    const r = rejected(await optimizeImage(file("photo.heic", "image/heic"), { readBytes: bytesOf(10) }));
    expect(r.reason).toContain("supported image format");
  });

  it("reports an undecodable file instead of throwing", async () => {
    const { encode } = encoder({});
    const r = rejected(
      await optimizeImage(file("broken.png", "image/png"), {
        readBytes: bytesOf(50),
        decode: async () => {
          throw new Error("decode failed");
        },
        encode,
      })
    );
    expect(r.reason).toContain("decoded");
  });

  it("releases the decoded bitmap even when encoding fails", async () => {
    const { decode, close } = decoder(2000, 2000);
    const { encode } = encoder({}); // every encoding unavailable
    await optimizeImage(file("shot.png", "image/png"), { readBytes: bytesOf(100), decode, encode });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("emits base64 whose decoded length matches the reported byte count", async () => {
    const { decode } = decoder(2000, 2000);
    const { encode } = encoder({ "image/webp@0.85": 1234 });
    const r = accepted(
      await optimizeImage(file("x.jpg", "image/jpeg"), { readBytes: bytesOf(99_999), decode, encode })
    );
    expect(base64Bytes(r.file.content)).toBe(1234);
    expect(r.file.bytes).toBe(1234);
  });
});

describe("renameForType", () => {
  it("swaps the extension to match the bytes actually produced", () => {
    expect(renameForType("shot.png", "image/webp")).toBe("shot.webp");
    expect(renameForType("photo.JPEG", "image/webp")).toBe("photo.webp");
    expect(renameForType("screenshot-123", "image/webp")).toBe("screenshot-123.webp");
    expect(renameForType("diagram.png", "image/png")).toBe("diagram.png");
  });

  it("leaves an inner dot alone", () => {
    expect(renameForType("v1.2.final.png", "image/webp")).toBe("v1.2.final.webp");
  });
});
