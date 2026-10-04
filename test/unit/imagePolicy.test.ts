// The rules an image attachment has to satisfy, tested without a browser.
//
// The GIF fixtures are assembled byte-wise on purpose: frame counting walks the
// block structure, and the only honest way to prove the walk is to hand it real
// structure — including a global colour table, which a naive scanner steps into
// and miscounts.

import { describe, expect, it } from "vitest";
import {
  IMAGE_LIMITS,
  QUALITY_LADDER,
  admit,
  base64Bytes,
  fitWithin,
  isAnimatedGif,
  isSupportedImageType,
  pickCandidate,
} from "../../src/shared/imagePolicy";

describe("fitWithin", () => {
  it("scales the longest edge down to the limit, keeping the ratio", () => {
    expect(fitWithin(4000, 3000)).toEqual({ width: 1568, height: 1176 });
    expect(fitWithin(3000, 4000)).toEqual({ width: 1176, height: 1568 });
    expect(fitWithin(2000, 2000)).toEqual({ width: 1568, height: 1568 });
  });

  it("never upscales — a small screenshot keeps its own resolution", () => {
    expect(fitWithin(800, 600)).toEqual({ width: 800, height: 600 });
    expect(fitWithin(1568, 900)).toEqual({ width: 1568, height: 900 });
  });

  it("never rounds a dimension away entirely", () => {
    // A 4000×1 strip scales to 0.39px tall; zero would be an unencodable canvas.
    expect(fitWithin(4000, 1)).toEqual({ width: 1568, height: 1 });
  });

  it("reports nothing usable for a zero-dimension image", () => {
    expect(fitWithin(0, 500)).toEqual({ width: 0, height: 0 });
  });
});

describe("base64Bytes", () => {
  it("matches the real decoded length, padding included", () => {
    for (const text of ["a", "ab", "abc", "abcd", "hello world"]) {
      expect(base64Bytes(btoa(text))).toBe(text.length);
    }
  });

  it("measures decoded bytes, not the longer base64 string", () => {
    const encoded = btoa("x".repeat(3000));
    expect(encoded.length).toBeGreaterThan(3000); // ~1.37×
    expect(base64Bytes(encoded)).toBe(3000);
  });

  it("is zero for an empty string", () => {
    expect(base64Bytes("")).toBe(0);
  });
});

describe("QUALITY_LADDER", () => {
  it("only ever steps down", () => {
    for (let i = 1; i < QUALITY_LADDER.length; i++) {
      expect(QUALITY_LADDER[i]).toBeLessThan(QUALITY_LADDER[i - 1]);
    }
    expect(QUALITY_LADDER[0]).toBe(0.85);
  });
});

describe("pickCandidate", () => {
  it("takes PNG only when it is genuinely smaller — the flat-screenshot case", () => {
    expect(pickCandidate({ webpBytes: 900, pngBytes: 400, originalBytes: 5000 })).toBe("png");
  });

  it("takes WebP for a photograph, where PNG loses badly", () => {
    expect(pickCandidate({ webpBytes: 400, pngBytes: 9000, originalBytes: 5000 })).toBe("webp");
  });

  it("prefers WebP on an exact tie", () => {
    expect(pickCandidate({ webpBytes: 400, pngBytes: 400, originalBytes: 5000 })).toBe("webp");
  });

  it("keeps the original when every candidate came out bigger", () => {
    expect(pickCandidate({ webpBytes: 6000, pngBytes: 7000, originalBytes: 5000 })).toBe("original");
  });

  it("keeps the original when nothing could be encoded at all", () => {
    expect(pickCandidate({ webpBytes: null, pngBytes: null, originalBytes: 5000 })).toBe("original");
  });

  it("works with only one candidate available", () => {
    expect(pickCandidate({ webpBytes: 100, pngBytes: null, originalBytes: 5000 })).toBe("webp");
    expect(pickCandidate({ webpBytes: null, pngBytes: 100, originalBytes: 5000 })).toBe("png");
  });
});

describe("admit", () => {
  const img = (name: string, bytes: number) => ({ name, bytes });

  it("stops at the image ceiling and names what was dropped", () => {
    const incoming = Array.from({ length: 12 }, (_, i) => img(`shot-${i}.webp`, 1000));
    const r = admit([], incoming);
    expect(r.accepted).toHaveLength(IMAGE_LIMITS.MAX_IMAGES);
    expect(r.rejected).toHaveLength(2);
    expect(r.rejected[0].name).toBe("shot-10.webp");
    expect(r.rejected[0].reason).toContain("10 images");
  });

  it("counts against images already attached, not just this batch", () => {
    const existing = Array.from({ length: 9 }, (_, i) => img(`old-${i}.webp`, 1000));
    const r = admit(existing, [img("new-a.webp", 1000), img("new-b.webp", 1000)]);
    expect(r.accepted.map((a) => a.name)).toEqual(["new-a.webp"]);
    expect(r.rejected.map((x) => x.name)).toEqual(["new-b.webp"]);
  });

  it("refuses a single image over the per-image limit", () => {
    const r = admit([], [img("huge.png", IMAGE_LIMITS.MAX_IMAGE_BYTES + 1)]);
    expect(r.accepted).toHaveLength(0);
    expect(r.rejected[0].reason).toContain("5.0 MB");
  });

  it("refuses the image that would push the message over the total budget", () => {
    const r = admit(
      [img("a.webp", 7_000_000), img("b.webp", 7_000_000)],
      [img("c.webp", 2_000_000), img("d.webp", 500_000)]
    );
    // 14 MB used: the 2 MB file breaks 15 MB, the 500 KB one still fits.
    expect(r.accepted.map((a) => a.name)).toEqual(["d.webp"]);
    expect(r.rejected.map((x) => x.name)).toEqual(["c.webp"]);
    expect(r.rejected[0].reason).toContain("15.0 MB");
  });

  it("passes everything through when it all fits", () => {
    const r = admit([], [img("a.webp", 10), img("b.webp", 20)]);
    expect(r.accepted).toHaveLength(2);
    expect(r.rejected).toEqual([]);
  });
});

// ── GIF fixtures ─────────────────────────────────────────────────────────────

const GCE = [0x21, 0xf9, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00];
/** Image descriptor (10 bytes), LZW code size, one sub-block, terminator. */
const FRAME = [0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0x00, 0x02, 0x02, 0x44, 0x01, 0x00];

function gif({ frames, globalTable = false }: { frames: number; globalTable?: boolean }): Uint8Array {
  const flags = globalTable ? 0x81 : 0x00; // 0x80 = table present, size 2^(1+1)
  const bytes: number[] = [
    ...[..."GIF89a"].map((c) => c.charCodeAt(0)),
    1, 0, 1, 0, flags, 0, 0, // logical screen descriptor
  ];
  if (globalTable) bytes.push(...new Array(3 * 4).fill(0xff));
  for (let i = 0; i < frames; i++) bytes.push(...GCE, ...FRAME);
  bytes.push(0x3b);
  return new Uint8Array(bytes);
}

describe("isAnimatedGif", () => {
  it("is true for a multi-frame GIF", () => {
    expect(isAnimatedGif(gif({ frames: 3 }))).toBe(true);
  });

  it("is false for a single-frame GIF", () => {
    expect(isAnimatedGif(gif({ frames: 1 }))).toBe(false);
  });

  it("steps over a global colour table instead of reading it as blocks", () => {
    expect(isAnimatedGif(gif({ frames: 2, globalTable: true }))).toBe(true);
    expect(isAnimatedGif(gif({ frames: 1, globalTable: true }))).toBe(false);
  });

  it("is false for something that isn't a GIF at all", () => {
    expect(isAnimatedGif(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe(false);
    expect(isAnimatedGif(new Uint8Array([1, 2, 3]))).toBe(false);
  });
});

describe("isSupportedImageType", () => {
  it("accepts exactly the four formats every provider takes", () => {
    for (const t of ["image/jpeg", "image/png", "image/gif", "image/webp"]) {
      expect(isSupportedImageType(t)).toBe(true);
    }
    for (const t of ["image/heic", "image/avif", "image/svg+xml", "", "application/pdf"]) {
      expect(isSupportedImageType(t)).toBe(false);
    }
  });
});
