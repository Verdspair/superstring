// P4f: reading a sticker's real format and pixel size from its bytes (ADR0018, §9.2).
//
// §9.2 asks for "格式/大小/尺寸等自动读取" on import. What matters here is that the answer comes
// from the CONTENT: the file name is what the user's disk called it, not evidence, so a `.gif`
// holding a PNG has to be read as a PNG. A reader that trusted the extension would let the library
// describe an asset as something it is not, and §8's send path would then hand the platform a file
// whose declared type and actual type disagree.
//
// The PNG and GIF fixtures are REAL files — produced by the project's own PNG encoder and by the
// upstream GIF encoder — so those two cases are not asserted from a hand-written header. The JPEG,
// WebP and BMP fixtures are minimal headers built to the container specs, because the project has
// no encoder for them; each one keeps the field order the spec defines and nothing else.

import { describe, expect, it } from "bun:test";
import upstream from "omggif";
import { encodeQqFramePng } from "../../src/server/services/qq-animation-frames";
import { QQ_STICKER_FORMATS, readQqImageHeader } from "../../src/server/services/qq-image-header";

function ascii(text: string): number[] {
  return [...text].map((char) => char.charCodeAt(0));
}

/** A real 4×3 PNG, written by the project's own encoder. */
function realPng(width = 4, height = 3): Uint8Array {
  return encodeQqFramePng(new Uint8Array(width * height * 4).fill(0x80), width, height);
}

/** A real 7×5 GIF, written by the upstream encoder. */
function realGif(width = 7, height = 5): Uint8Array {
  const buffer = new Uint8Array(width * height * 4 + 4096 + 768);
  const writer = new upstream.GifWriter(buffer, width, height, {
    palette: [0xff0000, 0x00ff00],
    loop: 0,
  });
  writer.addFrame(0, 0, width, height, new Array(width * height).fill(0), {
    delay: 10,
    disposal: 1,
  });
  const length = writer.end();
  return buffer.slice(0, length);
}

/** SOI, a JFIF APP0 segment (which must be walked past), then SOF0 carrying the size. */
function jpegBytes(width: number, height: number): Uint8Array {
  const app0 = [
    0xff,
    0xe0,
    0x00,
    0x10,
    ...ascii("JFIF\0"),
    0x01,
    0x01,
    0x00,
    0x00,
    0x01,
    0x00,
    0x01,
    0x00,
    0x00,
  ];
  const sof0 = [
    0xff,
    0xc0,
    0x00,
    0x11,
    0x08,
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x03,
    ...new Array(9).fill(0),
  ];
  return new Uint8Array([0xff, 0xd8, ...app0, ...sof0]);
}

function webpContainer(chunk: string, payload: number[]): Uint8Array {
  const chunkSize = payload.length;
  return new Uint8Array([
    ...ascii("RIFF"),
    0x00,
    0x00,
    0x00,
    0x00,
    ...ascii("WEBP"),
    ...ascii(chunk),
    chunkSize & 0xff,
    (chunkSize >> 8) & 0xff,
    0x00,
    0x00,
    ...payload,
  ]);
}

/** VP8X: flags, reserved, then canvas width-1 and height-1 as 24-bit little-endian. */
function webpExtended(width: number, height: number): Uint8Array {
  const w = width - 1;
  const h = height - 1;
  return webpContainer("VP8X", [
    0x00,
    0x00,
    0x00,
    0x00,
    w & 0xff,
    (w >> 8) & 0xff,
    (w >> 16) & 0xff,
    h & 0xff,
    (h >> 8) & 0xff,
    (h >> 16) & 0xff,
  ]);
}

/** VP8L: the 0x2f signature then 14 bits width-1 and 14 bits height-1, packed little-endian. */
function webpLossless(width: number, height: number): Uint8Array {
  const packed = (width - 1) | ((height - 1) << 14);
  return webpContainer("VP8L", [
    0x2f,
    packed & 0xff,
    (packed >> 8) & 0xff,
    (packed >> 16) & 0xff,
    (packed >> 24) & 0xff,
  ]);
}

/** VP8 (lossy): frame tag, the 0x9d012a start code, then width and height as 14-bit words. */
function webpLossy(width: number, height: number): Uint8Array {
  return webpContainer("VP8 ", [
    0x00,
    0x00,
    0x00,
    0x9d,
    0x01,
    0x2a,
    width & 0xff,
    (width >> 8) & 0xff,
    height & 0xff,
    (height >> 8) & 0xff,
  ]);
}

function bmpBytes(width: number, height: number): Uint8Array {
  const view = new DataView(new ArrayBuffer(4));
  const int32 = (value: number): number[] => {
    view.setInt32(0, value, true);
    return [...new Uint8Array(view.buffer)];
  };
  return new Uint8Array([
    ...ascii("BM"),
    ...int32(54),
    ...int32(0),
    ...int32(54),
    ...int32(40),
    ...int32(width),
    ...int32(height),
    ...int32(1),
    ...int32(24),
  ]);
}

describe("the format and the size come from the content", () => {
  it("reads a real PNG, GIF, JPEG, WebP and BMP", () => {
    expect(readQqImageHeader(realPng(4, 3))).toEqual({
      kind: "read",
      format: "png",
      width: 4,
      height: 3,
    });
    expect(readQqImageHeader(realGif(7, 5))).toEqual({
      kind: "read",
      format: "gif",
      width: 7,
      height: 5,
    });
    expect(readQqImageHeader(jpegBytes(202, 101))).toEqual({
      kind: "read",
      format: "jpeg",
      width: 202,
      height: 101,
    });
    expect(readQqImageHeader(webpExtended(300, 200))).toEqual({
      kind: "read",
      format: "webp",
      width: 300,
      height: 200,
    });
    expect(readQqImageHeader(webpLossless(64, 32))).toEqual({
      kind: "read",
      format: "webp",
      width: 64,
      height: 32,
    });
    expect(readQqImageHeader(webpLossy(120, 80))).toEqual({
      kind: "read",
      format: "webp",
      width: 120,
      height: 80,
    });
    expect(readQqImageHeader(bmpBytes(33, 17))).toEqual({
      kind: "read",
      format: "bmp",
      width: 33,
      height: 17,
    });
  });

  it("says which container each format is, and what that means for the library", () => {
    // §9.1: only the animation is its own media type; everything else is a still image.
    expect(QQ_STICKER_FORMATS.gif.mediaType).toBe("animation");
    for (const name of ["png", "jpeg", "webp", "bmp"] as const) {
      expect(QQ_STICKER_FORMATS[name].mediaType).toBe("image");
    }
    // The stored extension is the canonical one, which is why a JPEG lands as `.jpg`.
    expect(QQ_STICKER_FORMATS.jpeg.extension).toBe("jpg");
  });

  it("reads the canvas size of an animation, which is what a preview shows", () => {
    const header = readQqImageHeader(realGif(11, 6));
    expect(header).toMatchObject({ kind: "read", width: 11, height: 6 });
  });

  it("takes the absolute value of a negative BMP height", () => {
    // Top-down rows are stored as a negative height; the size is still 17, not -17.
    expect(readQqImageHeader(bmpBytes(33, -17))).toMatchObject({ kind: "read", height: 17 });
  });
});

describe("a file it cannot read is reported, not guessed", () => {
  it("separates the four reasons", () => {
    expect(readQqImageHeader(new Uint8Array(0))).toEqual({ kind: "unreadable", reason: "empty" });
    expect(readQqImageHeader(new Uint8Array(ascii("this is not an image")))).toEqual({
      kind: "unreadable",
      reason: "unsupported_format",
    });
    // A recognized container that stops before its size is truncated, not unsupported.
    expect(readQqImageHeader(realPng().slice(0, 8))).toEqual({
      kind: "unreadable",
      reason: "truncated_header",
    });
    expect(readQqImageHeader(realGif().slice(0, 6))).toEqual({
      kind: "unreadable",
      reason: "truncated_header",
    });
    expect(readQqImageHeader(jpegBytes(202, 101).slice(0, 6))).toEqual({
      kind: "unreadable",
      reason: "truncated_header",
    });
    expect(readQqImageHeader(webpExtended(300, 200).slice(0, 24))).toEqual({
      kind: "unreadable",
      reason: "truncated_header",
    });
    expect(readQqImageHeader(bmpBytes(33, 17).slice(0, 20))).toEqual({
      kind: "unreadable",
      reason: "truncated_header",
    });
  });

  it("refuses a header that declares no size at all", () => {
    // A PNG whose IHDR says 0 × 16 is a valid chunk with an impossible size: §9.2's surface would
    // otherwise show "0 × 16", and the table's own CHECK refuses it too.
    const zeroWidth = new Uint8Array([
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a,
      0x00,
      0x00,
      0x00,
      0x0d,
      ...ascii("IHDR"),
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00,
      0x10,
    ]);
    expect(readQqImageHeader(zeroWidth)).toEqual({
      kind: "unreadable",
      reason: "invalid_dimensions",
    });
  });

  it("refuses a RIFF file that is not WebP, and a WebP chunk it cannot read", () => {
    const wave = new Uint8Array([...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WAVE")]);
    expect(readQqImageHeader(wave)).toEqual({
      kind: "unreadable",
      reason: "unsupported_format",
    });
    // The container is a real WebP, but this is not a chunk layout whose size we know.
    const unknownChunk = webpContainer("XXXX", new Array(16).fill(0));
    expect(readQqImageHeader(unknownChunk)).toEqual({
      kind: "unreadable",
      reason: "unsupported_format",
    });
  });

  it("refuses a PNG whose first chunk is not IHDR", () => {
    const notIhdr = realPng().slice();
    notIhdr.set(ascii("ABCD"), 12);
    expect(readQqImageHeader(notIhdr)).toEqual({
      kind: "unreadable",
      reason: "unsupported_format",
    });
  });

  it("rejects input that is not bytes at all", () => {
    expect(() => readQqImageHeader("not bytes")).toThrow(TypeError);
    expect(() => readQqImageHeader(null)).toThrow(TypeError);
  });
});
