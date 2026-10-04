// What an image attachment is allowed to be, and the arithmetic behind it.
//
// Deliberately free of the DOM: every decision here is a pure function over
// numbers and bytes, so the rules can be tested without a canvas. The browser
// half — decoding, resizing, encoding — lives in
// sidepanel/lib/optimizeImage.ts and calls into this.
//
// The budgets fit what the providers' APIs accept (5 MB per image; longer
// edges are downscaled server-side anyway). They are enforced here, on the way
// in, because a payload refused at the far end has already cost the user the
// upload and tells them nothing useful.

export const IMAGE_LIMITS = {
  /** Longest edge after resize. Anything larger buys no accuracy. */
  MAX_EDGE: 1568,
  MAX_IMAGES: 10,
  /** Per image, DECODED bytes — not base64 characters. */
  MAX_IMAGE_BYTES: 5_000_000,
  /** All images in one message, decoded. */
  MAX_TOTAL_IMAGE_BYTES: 15_000_000,
} as const;

export const SUPPORTED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
export type SupportedImageType = (typeof SUPPORTED_IMAGE_TYPES)[number];

/** Descending: the first attempt that fits wins, so quality is only spent down. */
export const QUALITY_LADDER = [0.85, 0.75, 0.65, 0.55] as const;

export const EXTENSION_FOR_TYPE: Record<SupportedImageType, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
};

export function isSupportedImageType(type: string): type is SupportedImageType {
  return (SUPPORTED_IMAGE_TYPES as readonly string[]).includes(type);
}

/**
 * Proportional fit inside a square of `maxEdge`. Never upscales — an image
 * already inside the box comes back with its own dimensions, so a small
 * screenshot is passed through at native resolution rather than blown up and
 * re-encoded into something bigger and blurrier.
 */
export function fitWithin(
  width: number,
  height: number,
  maxEdge: number = IMAGE_LIMITS.MAX_EDGE
): { width: number; height: number } {
  if (!(width > 0) || !(height > 0)) return { width: 0, height: 0 };
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width: Math.round(width), height: Math.round(height) };
  const scale = maxEdge / longest;
  // Never round a dimension down to zero — a 4000×1 strip is still an image.
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * Decoded byte length of a base64 string, without decoding it.
 *
 * The limits are expressed in decoded bytes; base64 runs about 1.37× longer,
 * so measuring the string would reject images that actually fit.
 */
export function base64Bytes(b64: string): number {
  const clean = b64.replace(/[^A-Za-z0-9+/=]/g, "");
  if (!clean) return 0;
  const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
}

export interface CandidateSizes {
  /** Best WebP attempt off the ladder, or null when none was produced. */
  webpBytes: number | null;
  /** Lossless PNG re-encode at target dimensions, or null when not attempted. */
  pngBytes: number | null;
  /** The untouched source, so optimization can decline to make things worse. */
  originalBytes: number;
}

export type CandidateChoice = "webp" | "png" | "original";

/**
 * Which encoding to ship, decided by measurement rather than by guessing what
 * kind of picture this is.
 *
 * PNG wins only when it is genuinely smaller, which in practice means flat
 * interface screenshots — exactly the images whose text we least want run
 * through a lossy encoder. Photographs never trip that branch. And if every
 * candidate came out larger than the file we started with, the original ships
 * untouched.
 */
export function pickCandidate(sizes: CandidateSizes): CandidateChoice {
  const { webpBytes, pngBytes, originalBytes } = sizes;
  const best = [
    pngBytes !== null ? { choice: "png" as const, bytes: pngBytes } : null,
    webpBytes !== null ? { choice: "webp" as const, bytes: webpBytes } : null,
  ].filter((c): c is { choice: "png" | "webp"; bytes: number } => c !== null);

  if (!best.length) return "original";
  // WebP first on a tie: same size, smaller decode cost downstream.
  best.sort((a, b) => a.bytes - b.bytes || (a.choice === "webp" ? -1 : 1));
  const winner = best[0];
  return winner.bytes < originalBytes ? winner.choice : "original";
}

export interface AdmittableImage {
  name: string;
  /** Decoded size, already optimized. */
  bytes: number;
}

export interface AdmitResult<T extends AdmittableImage> {
  accepted: T[];
  rejected: { name: string; reason: string }[];
}

function mb(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/**
 * Fit incoming images into what is left of the per-message budget.
 *
 * Counts against images ALREADY attached, so the ceiling holds whether ten
 * images arrive in one drop or one paste at a time. Order is preserved and the
 * first images win — a later oversized file cannot displace an accepted one.
 */
export function admit<T extends AdmittableImage>(existing: AdmittableImage[], incoming: T[]): AdmitResult<T> {
  const accepted: T[] = [];
  const rejected: { name: string; reason: string }[] = [];
  let count = existing.length;
  let total = existing.reduce((sum, img) => sum + img.bytes, 0);

  for (const image of incoming) {
    if (count >= IMAGE_LIMITS.MAX_IMAGES) {
      rejected.push({ name: image.name, reason: `only ${IMAGE_LIMITS.MAX_IMAGES} images fit in one message` });
      continue;
    }
    if (image.bytes > IMAGE_LIMITS.MAX_IMAGE_BYTES) {
      rejected.push({
        name: image.name,
        reason: `${mb(image.bytes)} is over the ${mb(IMAGE_LIMITS.MAX_IMAGE_BYTES)} limit for one image`,
      });
      continue;
    }
    if (total + image.bytes > IMAGE_LIMITS.MAX_TOTAL_IMAGE_BYTES) {
      rejected.push({
        name: image.name,
        reason: `would put the message over ${mb(IMAGE_LIMITS.MAX_TOTAL_IMAGE_BYTES)} of images`,
      });
      continue;
    }
    accepted.push(image);
    count++;
    total += image.bytes;
  }
  return { accepted, rejected };
}

/**
 * Does this GIF have more than one frame?
 *
 * Animated GIFs cannot survive a canvas round-trip — drawing one to a canvas
 * keeps a single frame — so they are passed through untouched, and that
 * decision needs this answer. Frames are counted by walking the block
 * structure: an animated file carries a Graphic Control Extension per frame.
 * Walking (rather than searching for the 0x21F9 byte pair) avoids counting
 * pixel data that happens to contain those bytes.
 */
export function isAnimatedGif(bytes: Uint8Array): boolean {
  if (bytes.length < 13) return false;
  const header = String.fromCharCode(bytes[0], bytes[1], bytes[2]);
  if (header !== "GIF") return false;

  let pos = 13; // header (6) + logical screen descriptor (7)
  const flags = bytes[10];
  if (flags & 0x80) {
    // Global colour table: 3 bytes per entry, 2^(N+1) entries.
    pos += 3 * (1 << ((flags & 0x07) + 1));
  }

  let frames = 0;
  while (pos < bytes.length) {
    const block = bytes[pos];
    if (block === 0x3b) break; // trailer
    if (block === 0x21) {
      // Extension: label, then sub-blocks until a zero-length terminator.
      pos += 2;
      while (pos < bytes.length && bytes[pos] !== 0x00) pos += bytes[pos] + 1;
      pos++;
    } else if (block === 0x2c) {
      frames++;
      if (frames > 1) return true;
      // Image descriptor is 10 bytes; a local colour table may follow.
      const localFlags = bytes[pos + 9];
      pos += 10;
      if (localFlags & 0x80) pos += 3 * (1 << ((localFlags & 0x07) + 1));
      pos++; // LZW minimum code size
      while (pos < bytes.length && bytes[pos] !== 0x00) pos += bytes[pos] + 1;
      pos++;
    } else {
      // Unrecognised block — stop rather than walk off into pixel data and
      // report a still image as animated.
      break;
    }
  }
  return frames > 1;
}
