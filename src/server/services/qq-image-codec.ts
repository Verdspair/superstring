// T07/T14: preparing QQ images for a vision endpoint — scaling, original preservation,
// GIF sampling (spec §7.4/§11, plan T07, T14 Step4).
//
// The input spec table (§7.4) decides what a caller gets back:
//
//   * an ordinary still with a `null` max dimension is the ORIGINAL bytes — no re-encode, no
//     metadata rewrite, so "原图" stays literally the file that arrived;
//   * a still with an explicit max dimension (expression, or an ordinary still with a set
//     value) is scaled DOWN only, aspect ratio and alpha preserved, re-encoded as PNG;
//   * a GIF is sampled through the same disposal-aware compositor the media path has used
//     since P4d — frames are whole pictures, not partial patches. The composition runs on
//     the worker (T14), so a slow or hostile GIF cannot stall the main thread;
//   * an animated WebP or APNG is refused as `unsupported animation`. The decoder behind
//     `@napi-rs/image` decodes stills only; handing a model its first frame while reporting
//     three frames would be exactly the fake reading §7.4 forbids ("不能把某静态帧冒充已按
//     3帧理解"), and adding a second animation decoder is not authorized.
//
// The decode work itself runs on the worker in `qq-image-worker.ts`; this module owns the
// input contract, the format verdicts and the byte-level decisions. The AbortSignal is
// checked before any work starts and carried through the worker, where the parent's
// terminate() is the real stop — the native calls inside cannot take a signal (§11).
//
// Validation ranges are NOT re-invented here: frame counts 1–10 and dimensions 64–2048 are
// the same numbers the scheme contract already stores (`QqMediaInputSettingsSchema` /
// `QqSchemeRhythmSchema`); a still max dimension may additionally be `null` (original).

import type { QqImageCategory } from "../../shared/contracts/qq-media-input";
import { QQ_STICKER_CONTENT_TYPES, readQqImageHeader } from "./qq-image-header";
import { type QqImagePreparationRequest, runQqImagePreparation } from "./qq-image-worker";

/** The contract for one prepared picture handed to the model wire. */
export interface QqPreparedImage {
  readonly mimeType: string;
  readonly bytes: Uint8Array;
  readonly width: number;
  readonly height: number;
  /** The frame's index in the source animation; `null` for a still. */
  readonly frameIndex: number | null;
  /**
   * Finite-frame facts (§7.4 "明确有限帧"): a still is 1/false; a sampled GIF carries the
   * source's total frame count and whether fewer frames were sampled than exist. Reading
   * these is how a caller reports "sampled N of M" instead of claiming the whole animation.
   */
  readonly sourceFrameCount: number;
  readonly truncated: boolean;
}

/** Still-image max dimension: 64–2048 like the stored settings, or `null` = original. */
const stillDimension = { type: "int" as const, min: 64, max: 2048 };

function validateRequest(
  bytes: Uint8Array,
  input: {
    category: QqImageCategory;
    detail: boolean;
    stillMaxDimension: number | null;
    frameCount: number;
    frameMaxDimension: number;
    signal: AbortSignal;
  },
): void {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("Invalid QQ image codec input");
  const isInt = (value: number) => Number.isSafeInteger(value);
  const { stillMaxDimension, frameCount, frameMaxDimension } = input;
  if (stillMaxDimension !== null) {
    if (
      !isInt(stillMaxDimension) ||
      stillMaxDimension < stillDimension.min ||
      stillMaxDimension > stillDimension.max
    ) {
      throw new TypeError("Invalid QQ image still max dimension");
    }
  }
  // Frame rules mirror the animation contract: 1–10 frames, 64–2048 per-frame edge.
  if (!isInt(frameCount) || frameCount < 1 || frameCount > 10) {
    throw new TypeError("Invalid QQ image frame count");
  }
  if (!isInt(frameMaxDimension) || frameMaxDimension < 64 || frameMaxDimension > 2048) {
    throw new TypeError("Invalid QQ image frame max dimension");
  }
  input.signal.throwIfAborted();
}

/** APNG: an `acTL` chunk between the IHDR and the first IDAT makes a PNG animated. */
function isApng(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 8 || bytes.byteLength > 512 * 1024 * 1024) return false;
  let at = 8;
  let seenIHDR = false;
  while (at + 8 <= bytes.byteLength) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const length = view.getUint32(at);
    const type = String.fromCharCode(
      bytes[at + 4] ?? 0,
      bytes[at + 5] ?? 0,
      bytes[at + 6] ?? 0,
      bytes[at + 7] ?? 0,
    );
    if (!Number.isSafeInteger(length) || at + 12 + length > bytes.byteLength) return false;
    if (type === "IHDR") seenIHDR = true;
    if (type === "acTL" && seenIHDR) return true;
    if (type === "IDAT") return false;
    at += 12 + length;
    if (type === "IEND") return false;
  }
  return false;
}

/** Animated WebP: a VP8X chunk with the animation flag (bit 1) set. */
function isAnimatedWebp(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 21) return false;
  if (!(bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46)) {
    return false;
  }
  if (!(bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50)) {
    return false;
  }
  if (!(bytes[12] === 0x56 && bytes[13] === 0x50 && bytes[14] === 0x38 && bytes[15] === 0x58)) {
    return false;
  }
  return ((bytes[20] ?? 0) & 0x02) !== 0;
}

/** Why an image could not be prepared, as an error the caller can show or log. */
export class QqImagePrepareError extends Error {
  readonly reason: "unreadable_image" | "unsupported_animation" | "cancelled" | "decode_failed";

  constructor(reason: QqImagePrepareError["reason"], detail?: string) {
    super(detail ?? reason);
    this.name = "QqImagePrepareError";
    this.reason = reason;
  }
}

function failUnreadable(reason: "invalid_animation" | "empty_animation"): never {
  throw new QqImagePrepareError("unreadable_image", `QQ animation unreadable: ${reason}`);
}

/**
 * Prepare one QQ image for the model wire: verdict by container, scale or sample per the
 * category's spec, and report frames with their order and source index.
 *
 * Throws `QqImagePrepareError` (`reason: "unsupported_animation"` for animated WebP/APNG,
 * `"unreadable_image"` for broken bytes, `"cancelled"`/`"decode_failed"` for worker
 * outcomes) or `TypeError` for a contract violation — a caller never receives a
 * static-frame stand-in for animation it asked to have sampled.
 */
export async function prepareQqImage(
  bytes: Uint8Array,
  input: {
    category: QqImageCategory;
    detail: boolean;
    stillMaxDimension: number | null;
    frameCount: number;
    frameMaxDimension: number;
    signal: AbortSignal;
  },
): Promise<QqPreparedImage[]> {
  validateRequest(bytes, input);
  const header = readQqImageHeader(bytes);
  if (header.kind !== "read") {
    throw new QqImagePrepareError(
      "unreadable_image",
      `QQ image header unreadable: ${header.reason}`,
    );
  }

  // Animation verdicts first: a GIF is sampled on the worker, an animated WebP or APNG is
  // refused — a still decoder cannot honestly produce the requested frames.
  if (header.format === "gif") {
    const sample = await runQqImagePreparation({
      kind: "sample",
      bytes,
      frames: input.frameCount,
      maxDimension: input.frameMaxDimension,
      signal: input.signal,
    });
    if (sample.kind !== "sampled") failUnreadable("invalid_animation");
    input.signal.throwIfAborted();
    return sample.frames.map((frame) => ({
      mimeType: "image/png",
      bytes: frame.png,
      width: frame.width,
      height: frame.height,
      frameIndex: frame.index,
      sourceFrameCount: sample.sourceFrameCount,
      truncated: sample.truncated,
    }));
  }
  if (isAnimatedWebp(bytes) || isApng(bytes)) {
    throw new QqImagePrepareError(
      "unsupported_animation",
      `Animated ${header.format === "webp" ? "WebP" : "APNG"} cannot be sampled into ${input.frameCount} frames`,
    );
  }

  // Still image. `null` max dimension = the original file, byte for byte.
  const longest = Math.max(header.width, header.height);
  const maxDimension = input.stillMaxDimension;
  if (maxDimension === null || longest <= maxDimension) {
    return [
      {
        mimeType: QQ_STICKER_CONTENT_TYPES[header.format],
        bytes,
        width: header.width,
        height: header.height,
        frameIndex: null,
        sourceFrameCount: 1,
        truncated: false,
      },
    ];
  }
  const ratio = maxDimension / longest;
  const width = Math.max(1, Math.round(header.width * ratio));
  const height = Math.max(1, Math.round(header.height * ratio));
  const request: QqImagePreparationRequest = {
    kind: "scale",
    bytes,
    width,
    height,
    signal: input.signal,
  };
  const scaled = await runQqImagePreparation(request);
  input.signal.throwIfAborted();
  if (scaled.kind !== "scale") {
    throw new QqImagePrepareError(
      "decode_failed",
      "QQ image scale returned an unexpected job kind",
    );
  }
  return [
    {
      mimeType: "image/png",
      bytes: scaled.png,
      width: scaled.width,
      height: scaled.height,
      frameIndex: null,
      sourceFrameCount: 1,
      truncated: false,
    },
  ];
}
