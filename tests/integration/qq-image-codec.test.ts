// T07: prepareQqImage — still-image scaling, original preservation, GIF sampling (§7.4/§11).
//
// Everything here is synthetic: stills come from `encodeQqFramePng`, GIFs from the upstream
// omggif encoder used by the existing animation tests. No real image, no network, no model.

import { describe, expect, it } from "bun:test";
import { inflateSync } from "node:zlib";
import upstream from "omggif";
import { encodeQqFramePng } from "../../src/server/services/qq-animation-frames";
import { prepareQqImage, QqImagePrepareError } from "../../src/server/services/qq-image-codec";

const RED = 0;
const GREEN = 1;
const BLUE = 2;
const PALETTE = [0xff0000, 0x00ff00, 0x0000ff, 0xffffff];

interface FrameSpec {
  readonly indices: number[];
  disposal?: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

function makeGif(width: number, height: number, frames: readonly FrameSpec[]): Uint8Array {
  const buffer = new Uint8Array(width * height * frames.length * 4 + 4096 + 768);
  const writer = new upstream.GifWriter(buffer, width, height, { palette: PALETTE, loop: 0 });
  for (const frame of frames) {
    writer.addFrame(
      frame.x ?? 0,
      frame.y ?? 0,
      frame.width ?? width,
      frame.height ?? height,
      frame.indices,
      { delay: 10, disposal: frame.disposal ?? 1 },
    );
  }
  const length = writer.end();
  if (!Number.isSafeInteger(length) || length <= 0) throw new Error("fixture GIF not written");
  return buffer.slice(0, length);
}

const u32 = (bytes: Uint8Array, at: number): number =>
  ((bytes[at] ?? 0) * 0x1000000 +
    ((bytes[at + 1] ?? 0) << 16) +
    ((bytes[at + 2] ?? 0) << 8) +
    (bytes[at + 3] ?? 0)) >>>
  0;

interface DecodedPng {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
}

/** Decode a produced PNG: 8-bit RGBA output of @napi-rs/image or our own encoder. */
function decodePng(png: Uint8Array): DecodedPng {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  expect([...png.subarray(0, 8)]).toEqual(signature);
  let at = 8;
  let width = 0;
  let height = 0;
  let colorType = 6;
  const idat: Uint8Array[] = [];
  while (at + 12 <= png.length) {
    const length = u32(png, at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    const payload = png.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = u32(payload, 0);
      height = u32(payload, 4);
      expect(payload[8]).toBe(8);
      colorType = payload[9] ?? 6;
    } else if (type === "IDAT") {
      idat.push(payload);
    }
    at += 12 + length;
    if (type === "IEND") break;
  }
  expect(at).toBe(png.length);
  const joined = new Uint8Array(idat.reduce((sum, part) => sum + part.length, 0));
  let cursor = 0;
  for (const part of idat) {
    joined.set(part, cursor);
    cursor += part.length;
  }
  const raw = new Uint8Array(inflateSync(joined));
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 1;
  const stride = 1 + width * channels;
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * stride] ?? 0;
    expect(filter).toBe(0);
    const row = raw.subarray(y * stride + 1, y * stride + 1 + width * channels);
    for (let x = 0; x < width; x += 1) {
      const to = (y * width + x) * 4;
      const from = x * channels;
      rgba[to] = row[from] ?? 0;
      rgba[to + 1] = row[from + 1] ?? (channels >= 3 ? 0 : rgba[to]);
      rgba[to + 2] = row[from + 2] ?? (channels >= 3 ? 0 : rgba[to]);
      rgba[to + 3] = channels === 4 ? (row[from + 3] ?? 0) : 255;
    }
  }
  return { width, height, rgba };
}

function pixel(png: Uint8Array, x: number, y: number): number[] {
  const decoded = decodePng(png);
  const at = (y * decoded.width + x) * 4;
  return [...decoded.rgba.subarray(at, at + 4)];
}

const input = (overrides: Partial<Parameters<typeof prepareQqImage>[1]> = {}) => ({
  category: "expression" as const,
  detail: false,
  stillMaxDimension: 512 as number | null,
  frameCount: 3,
  frameMaxDimension: 512,
  signal: new AbortController().signal,
  ...overrides,
});

describe("still images", () => {
  it("shrinks an expression image to the requested longest edge", async () => {
    const image = encodeQqFramePng(new Uint8Array(640 * 320 * 4).fill(64), 640, 320);
    const result = await prepareQqImage(image, input());
    expect(result).toHaveLength(1);
    const still = result[0];
    expect(still).toMatchObject({ width: 512, height: 256, frameIndex: null });
    expect(still?.mimeType).toBe("image/png");
    // A single flat colour (and its alpha) survives scaling as itself.
    expect(pixel(still?.bytes as Uint8Array, 0, 0)).toEqual([64, 64, 64, 64]);
  });

  it("keeps an ordinary still at its original bytes when the max dimension is null", async () => {
    const image = encodeQqFramePng(new Uint8Array(640 * 320 * 4).fill(64), 640, 320);
    const result = await prepareQqImage(
      image,
      input({ category: "ordinary", stillMaxDimension: null }),
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ width: 640, height: 320, frameIndex: null });
    expect(result[0]?.mimeType).toBe("image/png");
    expect(result[0]?.bytes).toEqual(image);
  });

  it("never enlarges a still that is already small enough", async () => {
    const image = encodeQqFramePng(new Uint8Array(8 * 8 * 4).fill(64), 8, 8);
    const result = await prepareQqImage(image, input({ stillMaxDimension: 512 }));
    expect(result[0]).toMatchObject({ width: 8, height: 8 });
    expect(result[0]?.bytes).toEqual(image);
  });

  it("applies an explicit max dimension to an ordinary still without enlarging", async () => {
    const image = encodeQqFramePng(new Uint8Array(640 * 320 * 4).fill(64), 640, 320);
    const result = await prepareQqImage(
      image,
      input({ category: "ordinary", stillMaxDimension: 256 }),
    );
    expect(result[0]).toMatchObject({ width: 256, height: 128 });
    // Small expression image with an explicit ordinary max: the smaller side stays untouched.
    const small = encodeQqFramePng(new Uint8Array(8 * 8 * 4).fill(64), 8, 8);
    const kept = await prepareQqImage(
      small,
      input({ category: "ordinary", stillMaxDimension: 256 }),
    );
    expect(kept[0]?.bytes).toEqual(small);
  });

  it("keeps the aspect ratio of a taller image", async () => {
    const image = encodeQqFramePng(new Uint8Array(200 * 400 * 4).fill(200), 200, 400);
    const result = await prepareQqImage(image, input({ stillMaxDimension: 100 }));
    expect(result[0]).toMatchObject({ width: 50, height: 100 });
  });

  it("scales a 1000×333 still to fit inside the box without refusing the size", async () => {
    // 512/1000 is not an integer ratio: `Inside` can land a pixel under the requested edge
    // (real 512×170). The honest contract is the PNG's own header — real, positive, no axis
    // above the 512 target, never enlarged, never the request's numbers echoed back.
    const image = encodeQqFramePng(new Uint8Array(1000 * 333 * 4).fill(64), 1000, 333);
    const result = await prepareQqImage(image, input());
    expect(result).toHaveLength(1);
    const still = result[0];
    expect(still?.width).toBeGreaterThan(0);
    expect(still?.height).toBeGreaterThan(0);
    expect(still?.width).toBeLessThanOrEqual(512);
    expect(still?.height).toBeLessThanOrEqual(512);
    const decoded = decodePng(still?.bytes as Uint8Array);
    expect(decoded.width).toBe(still?.width);
    expect(decoded.height).toBe(still?.height);
    expect(decoded.width).toBeLessThanOrEqual(512);
    expect(decoded.height).toBeLessThanOrEqual(512);
    expect(decoded.width).toBeLessThanOrEqual(1000);
    expect(decoded.height).toBeLessThanOrEqual(333);
  });

  it("scales an 800×299 still to fit inside the box without refusing the size", async () => {
    // Same non-integer ratio family (512×191 requested, 511×191 actually produced).
    const image = encodeQqFramePng(new Uint8Array(800 * 299 * 4).fill(64), 800, 299);
    const result = await prepareQqImage(image, input());
    expect(result).toHaveLength(1);
    const still = result[0];
    expect(still?.width).toBeGreaterThan(0);
    expect(still?.height).toBeGreaterThan(0);
    expect(still?.width).toBeLessThanOrEqual(512);
    expect(still?.height).toBeLessThanOrEqual(512);
    const decoded = decodePng(still?.bytes as Uint8Array);
    expect(decoded.width).toBe(still?.width);
    expect(decoded.height).toBe(still?.height);
    expect(decoded.width).toBeLessThanOrEqual(512);
    expect(decoded.height).toBeLessThanOrEqual(512);
    expect(decoded.width).toBeLessThanOrEqual(800);
    expect(decoded.height).toBeLessThanOrEqual(299);
  });

  it("preserves transparency through the scale", async () => {
    const pixels = new Uint8Array(16 * 16 * 4);
    for (let i = 0; i < pixels.length; i += 4) {
      pixels[i] = 255;
      pixels[i + 3] = i % 8 === 0 ? 0 : 255;
    }
    const image = encodeQqFramePng(pixels, 16, 16);
    const result = await prepareQqImage(image, input({ stillMaxDimension: 64 }));
    const decoded = decodePng(result[0]?.bytes as Uint8Array);
    // Scaled rows must not invent opaque alpha for originally transparent columns.
    const seen = new Set<number>();
    for (let x = 0; x < decoded.width; x += 1) seen.add(decoded.rgba[x * 4 + 3] ?? 255);
    expect(seen.has(0)).toBe(true);
  });

  it("reports bytes that are not an image as unreadable", async () => {
    await expect(prepareQqImage(new Uint8Array([1, 2, 3, 4]), input())).rejects.toThrow();
    await expect(prepareQqImage(new Uint8Array(0), input())).rejects.toThrow();
  });

  it("stops before doing work when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const image = encodeQqFramePng(new Uint8Array(64 * 64 * 4).fill(64), 64, 64);
    await expect(prepareQqImage(image, input({ signal: controller.signal }))).rejects.toThrow();
  });

  it("rejects request shapes outside the contract", async () => {
    const image = encodeQqFramePng(new Uint8Array(8 * 8 * 4).fill(64), 8, 8);
    await expect(prepareQqImage(image, input({ stillMaxDimension: 32 }))).rejects.toThrow();
    await expect(prepareQqImage(image, input({ frameCount: 0 }))).rejects.toThrow();
    await expect(prepareQqImage(image, input({ frameMaxDimension: 4096 }))).rejects.toThrow();
  });
});

describe("animated GIFs", () => {
  it("samples composited frames with order and source indices", async () => {
    const gif = makeGif(3, 2, [{ indices: Array(6).fill(RED) }, { indices: Array(6).fill(BLUE) }]);
    const result = await prepareQqImage(gif, input({ category: "expression" }));
    expect(result).toHaveLength(2);
    expect(result.map((frame) => frame.frameIndex)).toEqual([0, 1]);
    expect(result.every((frame) => frame.mimeType === "image/png")).toBe(true);
    expect(pixel(result[0]?.bytes as Uint8Array, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(pixel(result[1]?.bytes as Uint8Array, 2, 1)).toEqual([0, 0, 255, 255]);
  });

  it("samples an ordinary animation with the same frame rules", async () => {
    const gif = makeGif(3, 2, [
      { indices: Array(6).fill(RED) },
      { indices: Array(6).fill(GREEN) },
      { indices: Array(6).fill(BLUE) },
    ]);
    const result = await prepareQqImage(
      gif,
      input({ category: "ordinary", frameCount: 2, frameMaxDimension: 128 }),
    );
    expect(result.map((frame) => frame.frameIndex)).toEqual([0, 2]);
  });

  it("scales frames down to the requested longest edge and composes disposal correctly", async () => {
    // Frame 0 paints the whole canvas red; frame 1 is a small blue patch with restore-to-
    // background, so frame 2 must show red again after the patch is disposed.
    const gif = makeGif(128, 64, [
      { indices: Array(128 * 64).fill(RED) },
      { indices: Array(16).fill(BLUE), x: 32, y: 16, width: 16, height: 1, disposal: 2 },
      { indices: Array(128 * 64).fill(RED) },
    ]);
    const result = await prepareQqImage(gif, input({ frameCount: 3, frameMaxDimension: 64 }));
    expect(result).toHaveLength(3);
    const first = result[0];
    expect([first?.width, first?.height]).toEqual([64, 32]);
    expect(pixel(first?.bytes as Uint8Array, 63, 31)).toEqual([255, 0, 0, 255]);
    expect(pixel(result[2]?.bytes as Uint8Array, 0, 0)).toEqual([255, 0, 0, 255]);
  });

  it("does not enlarge frames that are already small enough", async () => {
    const gif = makeGif(3, 2, [{ indices: Array(6).fill(RED) }]);
    const result = await prepareQqImage(gif, input({ frameCount: 3, frameMaxDimension: 512 }));
    expect(result[0]).toMatchObject({ width: 3, height: 2 });
  });

  it("reports a broken GIF as unreadable animation instead of throwing pictures", async () => {
    await expect(
      prepareQqImage(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39]), input()),
    ).rejects.toThrow();
    await expect(prepareQqImage(new Uint8Array([1, 2, 3, 4]), input())).rejects.toThrow();
  });

  it("marks animated WebP as unsupported animation instead of a fake still frame", async () => {
    // A real animated WebP container (VP8X with the animation flag) must not be answered
    // with a single static frame pretending to be the 3 requested ones.
    // A real animated WebP container (VP8X with the animation flag 0x02 set).
    const animatedWebp = new Uint8Array([
      0x52,
      0x49,
      0x46,
      0x46,
      0x2c,
      0x00,
      0x00,
      0x00,
      0x57,
      0x45,
      0x42,
      0x50, // RIFF....WEBP
      0x56,
      0x50,
      0x38,
      0x58,
      0x0e,
      0x00,
      0x00,
      0x00, // "VP8X" chunk, 14 bytes
      0x02,
      0x00,
      0x00,
      0x00, // flags: animation bit set, reserved
      0x01,
      0x00,
      0x00,
      0x00,
      0x01,
      0x00,
      0x00,
      0x00, // canvas 1x1 (width-1/height-1, 24-bit LE)
      0x41,
      0x4e,
      0x49,
      0x4d,
      0x06,
      0x00,
      0x00,
      0x00, // "ANIM" chunk, 6 bytes
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
    ]);
    await expect(prepareQqImage(animatedWebp, input({ frameCount: 3 }))).rejects.toThrow(
      /Animated WebP/,
    );
  });

  it("marks the frame budget as finite metadata on every prepared frame", async () => {
    // §7.4: the wire must be able to say "sampled 3 of N frames", not pretend the whole
    // animation was read. Stills carry sourceFrameCount 1 / truncated false.
    const gif = makeGif(3, 2, [
      { indices: Array(6).fill(RED) },
      { indices: Array(6).fill(GREEN) },
      { indices: Array(6).fill(BLUE) },
      { indices: Array(6).fill(RED) },
    ]);
    const sampled = await prepareQqImage(gif, input({ frameCount: 3 }));
    expect(sampled).toHaveLength(3);
    for (const frame of sampled) {
      expect(frame.sourceFrameCount).toBe(4);
      expect(frame.truncated).toBe(true);
    }
    const whole = await prepareQqImage(
      makeGif(3, 2, [{ indices: Array(6).fill(RED) }, { indices: Array(6).fill(GREEN) }]),
      input({ frameCount: 3 }),
    );
    expect(whole.map((frame) => frame.truncated)).toEqual([false, false]);
    expect(whole[0]?.sourceFrameCount).toBe(2);
    const still = await prepareQqImage(
      encodeQqFramePng(new Uint8Array(8 * 8 * 4).fill(64), 8, 8),
      input(),
    );
    expect(still[0]?.sourceFrameCount).toBe(1);
    expect(still[0]?.truncated).toBe(false);
  });

  it("handles a single-frame GIF as one frame, not an error", async () => {
    const gif = makeGif(2, 2, [{ indices: Array(4).fill(GREEN) }]);
    const result = await prepareQqImage(gif, input());
    expect(result).toHaveLength(1);
    expect(result[0]?.frameIndex).toBe(0);
    expect(result[0]?.sourceFrameCount).toBe(1);
    expect(result[0]?.truncated).toBe(false);
  });

  it("rejects frame counts outside the 1–10 contract before decoding", async () => {
    const gif = makeGif(2, 2, [{ indices: Array(4).fill(RED) }]);
    await expect(prepareQqImage(gif, input({ frameCount: 11 }))).rejects.toThrow();
  });

  it("cancels a job aborted in the worker-startup window through the original signal", async () => {
    // The sampling runs on the worker; aborting in the startup window (before the first
    // message arrives) must end the work with the caller's own reason. This does not claim
    // the CPU composition loop itself is interrupted — only terminate() is that guarantee.
    const controller = new AbortController();
    const gif = makeGif(
      256,
      256,
      Array.from({ length: 8 }, (_, i) => ({
        indices: Array(256 * 256).fill(i % 4),
        disposal: 2,
      })),
    );
    const pending = prepareQqImage(gif, input({ frameCount: 4, signal: controller.signal }));
    controller.abort(new Error("caller gave up"));
    const failure = await pending.then(
      () => {
        throw new Error("cancelled GIF sampling must not resolve");
      },
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(QqImagePrepareError);
    expect((failure as QqImagePrepareError).reason).toBe("cancelled");
    expect((failure as Error).message).toBe("caller gave up");
  });

  it("reports a truncated GIF as unreadable instead of attempting a decode", async () => {
    // A 10-byte hostile header (65535×65535 canvas) cannot be decoded: the reader bails as
    // truncated/unreadable long before any allocation. No pixel-cap product limit is asserted
    // here — that stays an open user decision (§11).
    const header = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0xff, 0xff, 0xff, 0xff];
    await expect(prepareQqImage(new Uint8Array(header), input())).rejects.toThrow();
  });
});
