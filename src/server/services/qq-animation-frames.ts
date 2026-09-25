// Sampling frames out of an animated image (ADR0018 P4d, §7.1).
//
// §7.1 allows animated images ("动图可以原文件发送；理解通过有限抽帧"), and the request shape for
// how many frames, how large and with what budget was already frozen in
// `qq-media-contract.ts`. Nothing turned those numbers into pictures, because the project
// had no way to decode a GIF at all: Bun compiles no image codec and no dependency provided
// one. That was checked rather than assumed — the whole dependency list was read — and the
// user then approved exactly one permissively licensed decoder.
//
// What this module is: bytes in, PNG frames out. It fetches nothing (§7.1's references are
// still only references), calls no model, and announces nothing to a conversation. Undecoded
// or malformed input is reported as unreadable so a caller leaves the media unread — the same
// honest outcome the rest of the media path uses.
//
// Frames are composited the way a viewer shows them, not the way the file stores them: a GIF
// frame is often a small rectangle plus a disposal instruction, so reading every frame on its
// own (which the decoder's blit does) would hand the model a fragment instead of the picture.
// Disposal 0/1 leaves the canvas, 2 clears the frame's rectangle, and 3 restores what was
// there before — the three cases §7.1's "有限抽帧" has to survive.
//
// Encoding to PNG is deliberate: a vision endpoint accepts a picture format, and a raw RGBA
// buffer is not one. PNG needs a deflate stream, which the runtime already provides, so this
// costs no second dependency.
//
// `budgetTokens` from the frozen request shape is NOT interpreted here. Nothing in the
// project knows how a given vision model prices a picture, and inventing a conversion would
// be exactly the silent budget shrinking the plan forbids; the sample reports its total pixel
// count so the capacity gate has a real number to refuse against.

import { deflateSync } from "node:zlib";
import upstream from "omggif";
import { z } from "zod";

// The upstream surface this module uses, typed here rather than in an ambient declaration:
// see `src/types/omggif.d.ts` for why the declaration is only `declare module "omggif";` and
// what that costs. Keeping these two interfaces beside the calls is the trade — it is the only
// thing between a renamed upstream method and a runtime failure.
interface UpstreamFrameInfo {
  x: number;
  y: number;
  width: number;
  height: number;
  transparent_index: number | null;
  interlaced: boolean;
  delay: number;
  /** 0 unspecified, 1 leave in place, 2 restore background, 3 restore previous. */
  disposal: number;
}

interface UpstreamGifReader {
  readonly width: number;
  readonly height: number;
  numFrames(): number;
  loopCount(): number | null;
  frameInfo(frameNumber: number): UpstreamFrameInfo;
  decodeAndBlitFrameRGBA(frameNumber: number, pixels: Uint8Array): void;
}

const omggif = upstream as {
  GifReader: new (buffer: Uint8Array) => UpstreamGifReader;
};

const RequestSchema = z.strictObject({
  /** How many frames to sample. */
  frames: z.number().int().min(1),
  /** Longest edge of a sampled frame, in pixels; larger frames are scaled down. */
  maxDimension: z.number().int().min(1),
  /** Carried through from the request shape; see the module note — it is not read here. */
  budgetTokens: z.number().int().min(1),
});

export interface QqSampledFrame {
  /** The frame's own index in the source file, so a caller can say which moment it saw. */
  readonly index: number;
  readonly width: number;
  readonly height: number;
  /** PNG bytes, ready to be carried to a vision endpoint. */
  readonly png: Uint8Array;
}

export type QqAnimationSample =
  | {
      readonly kind: "sampled";
      readonly sourceWidth: number;
      readonly sourceHeight: number;
      /** Frames in the source file, whether or not they were sampled. */
      readonly frameCount: number;
      readonly frames: readonly QqSampledFrame[];
      readonly totalPixels: number;
      /** True when the source had more frames than the caller asked for. */
      readonly truncated: boolean;
    }
  | {
      readonly kind: "unreadable";
      readonly reason: "invalid_animation" | "empty_animation";
    };

function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) throw new TypeError("Invalid QQ animation request input");
  return result.data;
}

/**
 * Which source frames to look at, evenly spread across the animation and always including
 * both ends: the first frame usually carries the composition and the last one the punchline,
 * which is exactly what "有限抽帧" must not drop on the floor.
 */
function frameIndices(frameCount: number, wanted: number): number[] {
  if (frameCount <= wanted) return Array.from({ length: frameCount }, (_, index) => index);
  // One frame has no even spacing to compute — `(i * (n - 1)) / (wanted - 1)` divides by zero and
  // yields NaN, which then fails the decode as an invalid index. The first frame is the answer the
  // callers want for a single sample (the preview's still, a one-picture reading).
  if (wanted === 1) return [0];
  const chosen = new Set<number>();
  for (let i = 0; i < wanted; i += 1) {
    chosen.add(Math.round((i * (frameCount - 1)) / (wanted - 1)));
  }
  return [...chosen].sort((left, right) => left - right);
}

function scaleDown(
  pixels: Uint8Array,
  width: number,
  height: number,
  maxDimension: number,
): { pixels: Uint8Array; width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxDimension) return { pixels, width, height };
  const ratio = maxDimension / longest;
  // At least one pixel per axis, so a very thin image cannot collapse to nothing.
  const targetWidth = Math.max(1, Math.round(width * ratio));
  const targetHeight = Math.max(1, Math.round(height * ratio));
  const out = new Uint8Array(targetWidth * targetHeight * 4);
  // Box average: a frame handed to a vision model should not be aliased noise, and averaging
  // is what keeps a one-pixel-wide detail from being sampled away entirely.
  for (let y = 0; y < targetHeight; y += 1) {
    const yStart = Math.floor((y * height) / targetHeight);
    const yEnd = Math.max(yStart + 1, Math.floor(((y + 1) * height) / targetHeight));
    for (let x = 0; x < targetWidth; x += 1) {
      const xStart = Math.floor((x * width) / targetWidth);
      const xEnd = Math.max(xStart + 1, Math.floor(((x + 1) * width) / targetWidth));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let count = 0;
      for (let sy = yStart; sy < yEnd; sy += 1) {
        for (let sx = xStart; sx < xEnd; sx += 1) {
          const at = (sy * width + sx) * 4;
          r += pixels[at] ?? 0;
          g += pixels[at + 1] ?? 0;
          b += pixels[at + 2] ?? 0;
          a += pixels[at + 3] ?? 0;
          count += 1;
        }
      }
      const to = (y * targetWidth + x) * 4;
      out[to] = Math.round(r / count);
      out[to + 1] = Math.round(g / count);
      out[to + 2] = Math.round(b / count);
      out[to + 3] = Math.round(a / count);
    }
  }
  return { pixels: out, width: targetWidth, height: targetHeight };
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + payload.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, payload.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(payload, 8);
  const body = out.subarray(4, 8 + payload.length);
  view.setUint32(8 + payload.length, crc32(body));
  return out;
}

/** Minimal 8-bit RGBA PNG: one IHDR, one deflated IDAT of unfiltered scanlines, one IEND. */
export function encodeQqFramePng(pixels: Uint8Array, width: number, height: number): Uint8Array {
  if (pixels.length !== width * height * 4) throw new TypeError("Invalid PNG frame input");
  const raw = new Uint8Array(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1) {
    raw[y * (1 + width * 4)] = 0; // Filter type 0: no filtering.
    raw.set(pixels.subarray(y * width * 4, (y + 1) * width * 4), y * (1 + width * 4) + 1);
  }
  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width);
  ihdrView.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", new Uint8Array(deflateSync(raw))),
    chunk("IEND", new Uint8Array(0)),
  ];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * Sample the requested frames out of an animated image.
 *
 * Malformed input is `unreadable`, never an exception the caller has to translate: the media
 * path's whole point is that a picture we cannot read is left unread (§7.2), not turned into
 * an error the assistant then has to explain in the group.
 */
export function sampleQqAnimationFrames(bytes: unknown, request: unknown): QqAnimationSample {
  const wanted = parse(RequestSchema, request);
  if (!(bytes instanceof Uint8Array)) throw new TypeError("Invalid QQ animation request input");
  let reader: UpstreamGifReader;
  try {
    reader = new omggif.GifReader(bytes);
  } catch {
    return Object.freeze({ kind: "unreadable", reason: "invalid_animation" });
  }
  const frameCount = reader.numFrames();
  if (!Number.isSafeInteger(frameCount) || frameCount <= 0) {
    return Object.freeze({ kind: "unreadable", reason: "empty_animation" });
  }
  const width = reader.width;
  const height = reader.height;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0) {
    return Object.freeze({ kind: "unreadable", reason: "invalid_animation" });
  }
  const selected = new Set(frameIndices(frameCount, wanted.frames));
  const canvas = new Uint8Array(width * height * 4);
  const frames: QqSampledFrame[] = [];
  let totalPixels = 0;
  let previous: Uint8Array | null = null;
  for (let index = 0; index < frameCount; index += 1) {
    let info: UpstreamFrameInfo;
    try {
      info = reader.frameInfo(index);
    } catch {
      return Object.freeze({ kind: "unreadable", reason: "invalid_animation" });
    }
    // Disposal 3 ("restore to previous") needs the canvas as it was before this frame, so it
    // has to be captured before the frame is drawn rather than reconstructed afterwards.
    if (info.disposal === 3) previous = canvas.slice();
    try {
      reader.decodeAndBlitFrameRGBA(index, canvas);
    } catch {
      return Object.freeze({ kind: "unreadable", reason: "invalid_animation" });
    }
    if (selected.has(index)) {
      // Encoded before the next frame touches the canvas: when nothing is scaled down, the
      // pixels handed over are the live canvas itself.
      const scaled = scaleDown(canvas, width, height, wanted.maxDimension);
      frames.push(
        Object.freeze({
          index,
          width: scaled.width,
          height: scaled.height,
          png: encodeQqFramePng(scaled.pixels, scaled.width, scaled.height),
        }),
      );
      totalPixels += scaled.width * scaled.height;
    }
    if (info.disposal === 2) {
      for (let y = info.y; y < info.y + info.height; y += 1) {
        const from = (y * width + info.x) * 4;
        canvas.fill(0, from, from + info.width * 4);
      }
    } else if (info.disposal === 3 && previous !== null) {
      canvas.set(previous, 0);
      previous = null;
    }
  }
  if (frames.length === 0) return Object.freeze({ kind: "unreadable", reason: "empty_animation" });
  return Object.freeze({
    kind: "sampled",
    sourceWidth: width,
    sourceHeight: height,
    frameCount,
    frames: Object.freeze(frames),
    totalPixels,
    truncated: frameCount > frames.length,
  });
}
