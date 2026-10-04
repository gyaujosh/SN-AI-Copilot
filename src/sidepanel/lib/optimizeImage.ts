// Shrink an image in the browser before it is ever attached to a message.
//
// Everything here is an effect — decode, resize, encode — over the rules in
// shared/imagePolicy.ts. The three browser calls are injectable so the
// orchestration can be tested under jsdom, which has neither createImageBitmap
// nor a canvas encoder.
//
// No image library: Chrome's own decoder handles EXIF orientation, and its
// canvas encoder produces WebP. Pulling in a wasm codec to do what the browser
// already does would cost more than it saves.

import type { PlanFile } from "../../shared/types";
import {
  EXTENSION_FOR_TYPE,
  IMAGE_LIMITS,
  QUALITY_LADDER,
  base64Bytes,
  fitWithin,
  isAnimatedGif,
  isSupportedImageType,
  pickCandidate,
  type SupportedImageType,
} from "../../shared/imagePolicy";

export interface DecodedImage {
  width: number;
  height: number;
  source: CanvasImageSource;
  close(): void;
}

export interface OptimizeDeps {
  readBytes(blob: Blob): Promise<Uint8Array>;
  decode(blob: Blob): Promise<DecodedImage>;
  /** Resolves null when this encoding could not be produced. */
  encode(image: DecodedImage, width: number, height: number, type: string, quality?: number): Promise<Uint8Array | null>;
}

export type OptimizeOutcome =
  | { ok: true; file: PlanFile; type: SupportedImageType }
  | { ok: false; name: string; reason: string };

/** `shot.png` carrying WebP bytes gets rejected by the API — keep them in step. */
export function renameForType(name: string, type: SupportedImageType): string {
  const ext = EXTENSION_FOR_TYPE[type];
  const base = name.replace(/\.(jpe?g|png|gif|webp|bmp|tiff?|heic|avif)$/i, "");
  return `${base || "image"}.${ext}`;
}

function toBase64(bytes: Uint8Array): string {
  // Chunked: spreading a multi-megabyte array into fromCharCode blows the stack.
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

async function defaultReadBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

async function defaultDecode(blob: Blob): Promise<DecodedImage> {
  // "from-image" is the browser-native EXIF fix: a phone photo taken sideways
  // is handed back already rotated, so the canvas never bakes in the wrong one.
  const bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
  return {
    width: bitmap.width,
    height: bitmap.height,
    source: bitmap,
    close: () => bitmap.close(),
  };
}

async function defaultEncode(
  image: DecodedImage,
  width: number,
  height: number,
  type: string,
  quality?: number
): Promise<Uint8Array | null> {
  let blob: Blob | null;
  if (typeof OffscreenCanvas !== "undefined") {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(image.source, 0, 0, width, height);
    blob = await canvas.convertToBlob({ type, quality });
  } else {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(image.source, 0, 0, width, height);
    blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
  }
  // An encoder that doesn't know the format silently hands back PNG. Treat that
  // as "couldn't produce this one" rather than mislabelling the bytes.
  if (!blob || blob.type !== type) return null;
  return new Uint8Array(await blob.arrayBuffer());
}

function planFile(name: string, type: SupportedImageType, bytes: Uint8Array): PlanFile {
  const content = toBase64(bytes);
  return { name: renameForType(name, type), type, content, isImage: true, bytes: base64Bytes(content) };
}

/**
 * One image in, one attachment (or one refusal) out.
 *
 * The shape of the work: decode once, resize to at most MAX_EDGE, then encode
 * candidates and ship whichever measured smallest. Animated GIFs skip all of it
 * — a canvas round-trip would silently drop every frame but the first.
 */
export async function optimizeImage(file: File, deps: Partial<OptimizeDeps> = {}): Promise<OptimizeOutcome> {
  const readBytes = deps.readBytes ?? defaultReadBytes;
  const decode = deps.decode ?? defaultDecode;
  const encode = deps.encode ?? defaultEncode;

  const sourceType = file.type;
  if (!isSupportedImageType(sourceType)) {
    return { ok: false, name: file.name, reason: `${sourceType || "that file type"} isn't a supported image format` };
  }

  let original: Uint8Array;
  try {
    original = await readBytes(file);
  } catch {
    return { ok: false, name: file.name, reason: "couldn't be read" };
  }

  if (sourceType === "image/gif" && isAnimatedGif(original)) {
    if (original.byteLength > IMAGE_LIMITS.MAX_IMAGE_BYTES) {
      return {
        ok: false,
        name: file.name,
        reason: "is an animated GIF over the size limit, and resizing it would drop the animation",
      };
    }
    return { ok: true, file: planFile(file.name, "image/gif", original), type: "image/gif" };
  }

  let decoded: DecodedImage;
  try {
    decoded = await decode(file);
  } catch {
    return { ok: false, name: file.name, reason: "couldn't be decoded as an image" };
  }

  try {
    const { width, height } = fitWithin(decoded.width, decoded.height);
    if (!width || !height) return { ok: false, name: file.name, reason: "has no usable dimensions" };

    // WebP down the ladder: stop at the first quality that fits, keep the
    // smallest attempt otherwise so the failure message can be honest about it.
    let webp: Uint8Array | null = null;
    for (const quality of QUALITY_LADDER) {
      const attempt = await encode(decoded, width, height, "image/webp", quality);
      if (!attempt) break;
      if (!webp || attempt.byteLength < webp.byteLength) webp = attempt;
      if (attempt.byteLength <= IMAGE_LIMITS.MAX_IMAGE_BYTES) {
        webp = attempt;
        break;
      }
    }

    // PNG is only worth encoding where it can plausibly win: flat-colour
    // sources — screenshots and graphics — where lossless often beats lossy and
    // the text stays sharp. Photographs never come close, so don't spend the
    // time on them.
    const pngWorthTrying = sourceType === "image/png" || sourceType === "image/gif";
    const png = pngWorthTrying ? await encode(decoded, width, height, "image/png") : null;

    const choice = pickCandidate({
      webpBytes: webp?.byteLength ?? null,
      pngBytes: png?.byteLength ?? null,
      originalBytes: original.byteLength,
    });

    const chosen: { type: SupportedImageType; bytes: Uint8Array } =
      choice === "webp" && webp
        ? { type: "image/webp", bytes: webp }
        : choice === "png" && png
          ? { type: "image/png", bytes: png }
          : { type: sourceType, bytes: original };

    if (chosen.bytes.byteLength > IMAGE_LIMITS.MAX_IMAGE_BYTES) {
      return {
        ok: false,
        name: file.name,
        reason: "couldn't be brought under the size limit without becoming unusable",
      };
    }
    return { ok: true, file: planFile(file.name, chosen.type, chosen.bytes), type: chosen.type };
  } finally {
    decoded.close();
  }
}
