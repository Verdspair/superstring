// P4d: sampling frames out of an animation (ADR0018, §7.1).
//
// §7.1 decided that an animated image is understood by sampling a limited number of frames,
// and the request shape for how many and how large was already frozen. What could not be
// built was the sampling itself, because nothing in the project could decode a GIF — that was
// checked (the whole dependency list was read) rather than assumed, and exactly one
// permissively licensed decoder was then approved by the user.
//
// These tests build their own GIFs with the same upstream package's encoder and then decode
// this module's PNG output pixel by pixel, so nothing is asserted from a claim: a frame that
// should be red is read back as red, and a frame whose predecessor said "restore background"
// is checked to no longer carry it. Compositing is the point — a GIF frame is usually a small
// rectangle plus a disposal instruction, and reading frames in isolation would hand a model a
// fragment instead of the picture.

import { describe, expect, it } from "bun:test";
import { inflateSync } from "node:zlib";
import upstream from "omggif";
import { sampleQqAnimationFrames } from "../../src/server/services/qq-animation-frames";

const RED = 0;
const GREEN = 1;
const BLUE = 2;
// The upstream encoder takes one packed 0xRRGGBB integer per colour, and the palette must
// hold a power-of-two number of them — so this one is padded to four.
const PALETTE = [0xff0000, 0x00ff00, 0x0000ff, 0xffffff];

interface FrameSpec {
  readonly indices: number[];
  delay?: number;
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
      { delay: frame.delay ?? 10, disposal: frame.disposal ?? 1 },
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

/** Decode this module's own PNG output: 8-bit RGBA, one IDAT, filter type 0 on every row. */
function decodePng(png: Uint8Array): DecodedPng {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  expect([...png.subarray(0, 8)]).toEqual(signature);
  let at = 8;
  let width = 0;
  let height = 0;
  const idat: Uint8Array[] = [];
  while (at + 12 <= png.length) {
    const length = u32(png, at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    const payload = png.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = u32(payload, 0);
      height = u32(payload, 4);
      expect(payload[8]).toBe(8);
      expect(payload[9]).toBe(6);
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
  const stride = 1 + width * 4;
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    expect(raw[y * stride]).toBe(0);
    rgba.set(raw.subarray(y * stride + 1, y * stride + 1 + width * 4), y * width * 4);
  }
  return { width, height, rgba };
}

function pixel(png: Uint8Array, x: number, y: number): number[] {
  const decoded = decodePng(png);
  const at = (y * decoded.width + x) * 4;
  return [...decoded.rgba.subarray(at, at + 4)];
}

const request = (frames: number, maxDimension = 64) => ({
  frames,
  maxDimension,
  budgetTokens: 1024,
});

describe("sampling an animation", () => {
  it("returns the requested frames as readable pictures", () => {
    const gif = makeGif(3, 2, [{ indices: Array(6).fill(RED) }, { indices: Array(6).fill(BLUE) }]);
    const sample = sampleQqAnimationFrames(gif, request(2));
    if (sample.kind !== "sampled") throw new Error("expected a sample");
    expect(sample.frameCount).toBe(2);
    expect(sample.sourceWidth).toBe(3);
    expect(sample.sourceHeight).toBe(2);
    expect(sample.truncated).toBe(false);
    expect(sample.frames.map((frame) => frame.index)).toEqual([0, 1]);
    expect(sample.frames.map((frame) => [frame.width, frame.height])).toEqual([
      [3, 2],
      [3, 2],
    ]);
    expect(sample.totalPixels).toBe(12);
    // Read back from the PNG bytes, not from a claim about them.
    expect(pixel(sample.frames[0]?.png as Uint8Array, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(pixel(sample.frames[1]?.png as Uint8Array, 2, 1)).toEqual([0, 0, 255, 255]);
  });

  it("treats a single-frame image as one frame, not as an error", () => {
    const gif = makeGif(2, 2, [{ indices: Array(4).fill(GREEN) }]);
    const sample = sampleQqAnimationFrames(gif, request(4));
    if (sample.kind !== "sampled") throw new Error("expected a sample");
    expect(sample.frameCount).toBe(1);
    expect(sample.frames).toHaveLength(1);
    expect(sample.truncated).toBe(false);
    expect(pixel(sample.frames[0]?.png as Uint8Array, 1, 1)).toEqual([0, 255, 0, 255]);
  });

  it("samples across the whole animation and keeps both ends", () => {
    const frames = Array.from({ length: 5 }, (_, index) => ({
      indices: Array(4).fill(index % 3),
    }));
    const sample = sampleQqAnimationFrames(makeGif(2, 2, frames), request(2));
    if (sample.kind !== "sampled") throw new Error("expected a sample");
    // The first frame carries the composition and the last one the punchline; an even spread
    // must not drop either of them.
    expect(sample.frames.map((frame) => frame.index)).toEqual([0, 4]);
    expect(sample.frameCount).toBe(5);
    expect(sample.truncated).toBe(true);
  });

  it("never asks for more frames than the source has", () => {
    const gif = makeGif(2, 2, [{ indices: Array(4).fill(RED) }, { indices: Array(4).fill(BLUE) }]);
    const sample = sampleQqAnimationFrames(gif, request(8));
    if (sample.kind !== "sampled") throw new Error("expected a sample");
    expect(sample.frames.map((frame) => frame.index)).toEqual([0, 1]);
    expect(sample.truncated).toBe(false);
  });

  it("scales a frame down to the requested longest edge and keeps the shape", () => {
    const gif = makeGif(8, 4, [{ indices: Array(32).fill(BLUE) }]);
    const sample = sampleQqAnimationFrames(gif, request(1, 4));
    if (sample.kind !== "sampled") throw new Error("expected a sample");
    const frame = sample.frames[0];
    expect([frame?.width, frame?.height]).toEqual([4, 2]);
    expect(decodePng(frame?.png as Uint8Array).width).toBe(4);
    // Averages of one colour are that colour, so scaling must not shift the picture.
    expect(pixel(frame?.png as Uint8Array, 3, 1)).toEqual([0, 0, 255, 255]);
  });

  it("does not enlarge a frame that is already small enough", () => {
    const gif = makeGif(3, 3, [{ indices: Array(9).fill(GREEN) }]);
    const sample = sampleQqAnimationFrames(gif, request(1, 400));
    if (sample.kind !== "sampled") throw new Error("expected a sample");
    expect([sample.frames[0]?.width, sample.frames[0]?.height]).toEqual([3, 3]);
  });

  it("composes a partial frame on top of what came before", () => {
    // Frame 0 paints the whole canvas red; frame 1 draws a one-pixel blue square somewhere
    // else with "leave in place" disposal, which is what most animations do.
    const gif = makeGif(3, 3, [
      { indices: Array(9).fill(RED) },
      { indices: [BLUE], x: 1, y: 1, width: 1, height: 1, disposal: 1 },
    ]);
    const sample = sampleQqAnimationFrames(gif, request(2));
    if (sample.kind !== "sampled") throw new Error("expected a sample");
    const second = sample.frames[1]?.png as Uint8Array;
    expect(pixel(second, 1, 1)).toEqual([0, 0, 255, 255]);
    // The rest of the canvas still shows the first frame rather than being blanked.
    expect(pixel(second, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(pixel(second, 2, 2)).toEqual([255, 0, 0, 255]);
  });

  it("applies restore-to-background before the next frame is shown", () => {
    const gif = makeGif(3, 3, [
      { indices: Array(9).fill(RED) },
      { indices: [BLUE], x: 1, y: 1, width: 1, height: 1, disposal: 2 },
      { indices: Array(9).fill(GREEN), disposal: 1 },
    ]);
    const sample = sampleQqAnimationFrames(gif, request(3));
    if (sample.kind !== "sampled") throw new Error("expected a sample");
    // The blue square belongs to frame 1 only: it was drawn to be thrown away afterwards, so
    // the last frame must not carry it.
    expect(pixel(sample.frames[1]?.png as Uint8Array, 1, 1)).toEqual([0, 0, 255, 255]);
    expect(pixel(sample.frames[2]?.png as Uint8Array, 1, 1)).toEqual([0, 255, 0, 255]);
  });

  it("applies restore-to-previous for the frame that asks for it", () => {
    const gif = makeGif(3, 3, [
      { indices: Array(9).fill(RED) },
      { indices: Array(9).fill(BLUE), disposal: 3 },
      { indices: [GREEN], x: 0, y: 0, width: 1, height: 1, disposal: 1 },
    ]);
    const sample = sampleQqAnimationFrames(gif, request(3));
    if (sample.kind !== "sampled") throw new Error("expected a sample");
    // Frame 2 drew one green pixel and left the red canvas underneath it: had the blue frame
    // been left in place, the pixel next to it would be blue.
    expect(pixel(sample.frames[2]?.png as Uint8Array, 1, 1)).toEqual([255, 0, 0, 255]);
  });
});

describe("refusing what cannot be read", () => {
  it("reports bytes that are not an animation as unreadable", () => {
    expect(sampleQqAnimationFrames(new Uint8Array([1, 2, 3, 4]), request(2))).toEqual({
      kind: "unreadable",
      reason: "invalid_animation",
    });
    expect(sampleQqAnimationFrames(new Uint8Array(0), request(2))).toEqual({
      kind: "unreadable",
      reason: "invalid_animation",
    });
  });

  it("rejects input that does not match the request contract", () => {
    const gif = makeGif(2, 2, [{ indices: Array(4).fill(RED) }]);
    expect(() =>
      sampleQqAnimationFrames(gif, { frames: 0, maxDimension: 8, budgetTokens: 1 }),
    ).toThrow(TypeError);
    expect(() =>
      sampleQqAnimationFrames(gif, { frames: 1, maxDimension: 8, budgetTokens: 1, extra: true }),
    ).toThrow(TypeError);
    // Not a byte container at all: a caller mistake, not an unreadable picture.
    expect(() => sampleQqAnimationFrames("not bytes", request(1))).toThrow(TypeError);
    expect(() => sampleQqAnimationFrames(null, request(1))).toThrow(TypeError);
  });
});

describe("one frame from a multi-frame animation", () => {
  it("samples the first frame instead of failing on an even-spacing division by zero", () => {
    // `frameIndices(n, 1)` used to compute 0/0 and hand NaN to the decoder, which reported the
    // whole file as unreadable — a defect the preview's `?still=1` exposed (P5i).
    const gif = makeGif(3, 2, [{ indices: Array(6).fill(RED) }, { indices: Array(6).fill(BLUE) }]);
    const sample = sampleQqAnimationFrames(gif, {
      frames: 1,
      maxDimension: 64,
      budgetTokens: 1,
    });
    expect(sample.kind).toBe("sampled");
    if (sample.kind !== "sampled") return;
    expect(sample.frames).toHaveLength(1);
    expect(sample.frames[0]?.index).toBe(0);
    expect(sample.truncated).toBe(true);
  });
});
