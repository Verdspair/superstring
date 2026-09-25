// Reading a sticker's real format and pixel size from its bytes (ADR0018 P4f, §9.2).
//
// §9.2 asks for "格式/大小/尺寸等自动读取" when an asset is imported. Only one of those three can
// come from outside the file: the byte size. The other two are properties of the CONTENT, and the
// file name is not evidence — a `.gif` that really holds a PNG is an image, not an animation, and
// calling it an animation would make the library describe something it is not. So the container is
// read from its magic number and the size from its header, and the caller's declared extension
// plays no part in either.
//
// This module is pure: bytes in, verdict out. No filesystem, no database, no model. It parses only
// as much as the dimensions need, and it never guesses — a container whose header runs out, or that
// declares a zero size, is reported as unreadable rather than as a half-known asset, because
// §9.2's surface would otherwise have to show "400 × ?".
//
// Time is not a concern here the way it is for §7.1's animation sampling: reading a header is a
// bounded walk over a few dozen bytes, so there is no budget to enforce and nothing to truncate.

/** The containers the app can show, and what each one means for the library (§9.2). */
export const QQ_STICKER_FORMATS = Object.freeze({
  png: Object.freeze({ extension: "png", mediaType: "image" }),
  jpeg: Object.freeze({ extension: "jpg", mediaType: "image" }),
  gif: Object.freeze({ extension: "gif", mediaType: "animation" }),
  webp: Object.freeze({ extension: "webp", mediaType: "image" }),
  bmp: Object.freeze({ extension: "bmp", mediaType: "image" }),
});
/**
 * The media type to serve a stored copy under (P5g's preview endpoint).
 *
 * Kept beside the format table rather than in the route: "what is this file" already has one
 * definition here, and a second spelling of it is how a `.jpg` starts being served as a PNG.
 */
export const QQ_STICKER_CONTENT_TYPES: Readonly<Record<QqStickerFormat, string>> = Object.freeze({
  png: "image/png",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
});

export type QqStickerFormat = keyof typeof QQ_STICKER_FORMATS;
export type QqStickerMediaType = (typeof QQ_STICKER_FORMATS)[QqStickerFormat]["mediaType"];

/** Why a file could not be read as an image. Diagnostics only — nothing acts on it here. */
export type QqImageHeaderRejection =
  | "empty"
  | "unsupported_format"
  | "truncated_header"
  | "invalid_dimensions";

export type QqImageHeader =
  | {
      readonly kind: "read";
      readonly format: QqStickerFormat;
      readonly width: number;
      readonly height: number;
    }
  | { readonly kind: "unreadable"; readonly reason: QqImageHeaderRejection };

function unreadable(reason: QqImageHeaderRejection): QqImageHeader {
  return Object.freeze({ kind: "unreadable", reason });
}

function read(format: QqStickerFormat, width: number, height: number): QqImageHeader {
  // A header that names a size of zero is not a size we can store (§9.2 would show 0 × 0), and the
  // table's own CHECK says the same. Report it as what it is rather than as a truncated file.
  if (width <= 0 || height <= 0) return unreadable("invalid_dimensions");
  return Object.freeze({ kind: "read", format, width, height });
}

// Every reader checks its own bounds before reading, so these treat an offset past the end as 0
// rather than asserting: the caller has already decided what happens in that case.
function byte(bytes: Uint8Array, offset: number): number {
  return bytes[offset] ?? 0;
}

function uint16be(bytes: Uint8Array, offset: number): number {
  return (byte(bytes, offset) << 8) | byte(bytes, offset + 1);
}

function uint32be(bytes: Uint8Array, offset: number): number {
  return (
    ((byte(bytes, offset) << 24) |
      (byte(bytes, offset + 1) << 16) |
      (byte(bytes, offset + 2) << 8) |
      byte(bytes, offset + 3)) >>>
    0
  );
}

function uint16le(bytes: Uint8Array, offset: number): number {
  return byte(bytes, offset) | (byte(bytes, offset + 1) << 8);
}

function uint32le(bytes: Uint8Array, offset: number): number {
  return (
    (byte(bytes, offset) |
      (byte(bytes, offset + 1) << 8) |
      (byte(bytes, offset + 2) << 16) |
      (byte(bytes, offset + 3) << 24)) >>>
    0
  );
}

function int32le(bytes: Uint8Array, offset: number): number {
  return (
    byte(bytes, offset) |
    (byte(bytes, offset + 1) << 8) |
    (byte(bytes, offset + 2) << 16) |
    (byte(bytes, offset + 3) << 24) |
    0
  );
}

function matches(bytes: Uint8Array, offset: number, ascii: string): boolean {
  if (offset + ascii.length > bytes.length) return false;
  for (let index = 0; index < ascii.length; index += 1) {
    if (byte(bytes, offset + index) !== ascii.charCodeAt(index)) return false;
  }
  return true;
}

/**
 * Read the format and pixel size of an image, or say why it cannot be read.
 *
 * The result is a verdict, not an exception: "this file is not an image we can show" is an
 * expected outcome of a user picker, and the management surface has to tell the user which of the
 * four reasons applies.
 */
export function readQqImageHeader(bytes: unknown): QqImageHeader {
  if (!(bytes instanceof Uint8Array)) throw new TypeError("Invalid QQ image header input");
  if (bytes.byteLength === 0) return unreadable("empty");
  if (matches(bytes, 0, "\u0089PNG\r\n\u001a\n")) return readPng(bytes);
  if (byte(bytes, 0) === 0xff && byte(bytes, 1) === 0xd8) return readJpeg(bytes);
  if (matches(bytes, 0, "GIF87a") || matches(bytes, 0, "GIF89a")) return readGif(bytes);
  if (matches(bytes, 0, "RIFF") && matches(bytes, 8, "WEBP")) return readWebp(bytes);
  if (matches(bytes, 0, "BM")) return readBmp(bytes);
  return unreadable("unsupported_format");
}

/** PNG: the IHDR chunk is fixed as the first chunk, so the size sits at a known offset. */
function readPng(bytes: Uint8Array): QqImageHeader {
  if (bytes.byteLength < 24) return unreadable("truncated_header");
  if (!matches(bytes, 12, "IHDR")) return unreadable("unsupported_format");
  return read("png", uint32be(bytes, 16), uint32be(bytes, 20));
}

/**
 * GIF: the logical screen descriptor follows the six-byte signature.
 *
 * Note this is the CANVAS size, which is what §9.2's preview needs; the per-frame size can be
 * smaller and is not read here.
 */
function readGif(bytes: Uint8Array): QqImageHeader {
  if (bytes.byteLength < 10) return unreadable("truncated_header");
  return read("gif", uint16le(bytes, 6), uint16le(bytes, 8));
}

/**
 * JPEG: walk the marker segments until a start-of-frame carries the size.
 *
 * The size is not at a fixed offset — it lives in whichever SOFn segment comes first, after any
 * number of application/quantization/huffman segments — so the walk is the only way to read it.
 */
function readJpeg(bytes: Uint8Array): QqImageHeader {
  let offset = 2;
  for (;;) {
    if (offset + 1 >= bytes.byteLength) return unreadable("truncated_header");
    if (byte(bytes, offset) !== 0xff) return unreadable("truncated_header");
    let marker = byte(bytes, offset + 1);
    offset += 2;
    // Fill bytes are legal between segments: any run of 0xff is padding, the real marker is last.
    while (marker === 0xff) {
      if (offset >= bytes.byteLength) return unreadable("truncated_header");
      marker = byte(bytes, offset);
      offset += 1;
    }
    // Standalone markers carry no length. SOI cannot reappear meaningfully, but skipping it keeps
    // the walk honest about what it saw instead of reading the next two bytes as a length.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 1 >= bytes.byteLength) return unreadable("truncated_header");
    const segmentLength = uint16be(bytes, offset);
    // A segment length covers its own two bytes, so anything below 2 would not advance the walk.
    if (segmentLength < 2) return unreadable("truncated_header");
    // SOF0–SOF15 carry the frame size, except DHT (0xc4), JPG (0xc8) and DAC (0xcc), which share
    // the range without being frame headers.
    const isFrameHeader =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrameHeader) {
      // length(2) + precision(1) + height(2) + width(2).
      if (offset + 7 > bytes.byteLength) return unreadable("truncated_header");
      return read("jpeg", uint16be(bytes, offset + 5), uint16be(bytes, offset + 3));
    }
    offset += segmentLength;
  }
}

/**
 * WebP: a RIFF container holding exactly one of three chunk layouts.
 *
 * All three are read because all three are real files in the wild: `VP8X` is the extended form
 * (also used for animation), `VP8L` is lossless, `VP8 ` is lossy.
 */
function readWebp(bytes: Uint8Array): QqImageHeader {
  if (bytes.byteLength < 20) return unreadable("truncated_header");
  if (matches(bytes, 12, "VP8X")) {
    // flags(1) + reserved(3) + canvas width-1(3, little-endian) + canvas height-1(3).
    if (bytes.byteLength < 30) return unreadable("truncated_header");
    const width = (byte(bytes, 24) | (byte(bytes, 25) << 8) | (byte(bytes, 26) << 16)) + 1;
    const height = (byte(bytes, 27) | (byte(bytes, 28) << 8) | (byte(bytes, 29) << 16)) + 1;
    return read("webp", width, height);
  }
  if (matches(bytes, 12, "VP8L")) {
    // signature byte(1) + 14 bits width-1 + 14 bits height-1, packed little-endian.
    if (bytes.byteLength < 25) return unreadable("truncated_header");
    if (byte(bytes, 20) !== 0x2f) return unreadable("truncated_header");
    const packed = uint32le(bytes, 21);
    return read("webp", (packed & 0x3fff) + 1, ((packed >> 14) & 0x3fff) + 1);
  }
  if (matches(bytes, 12, "VP8 ")) {
    // frame tag(3) + start code(3) + width(2, 14 bits) + height(2, 14 bits).
    if (bytes.byteLength < 30) return unreadable("truncated_header");
    if (byte(bytes, 23) !== 0x9d || byte(bytes, 24) !== 0x01 || byte(bytes, 25) !== 0x2a) {
      return unreadable("truncated_header");
    }
    return read("webp", uint16le(bytes, 26) & 0x3fff, uint16le(bytes, 28) & 0x3fff);
  }
  return unreadable("unsupported_format");
}

/** BMP: the header size decides which variant follows, and top-down rows are a negative height. */
function readBmp(bytes: Uint8Array): QqImageHeader {
  if (bytes.byteLength < 18) return unreadable("truncated_header");
  const headerSize = uint32le(bytes, 14);
  if (headerSize === 12) {
    // BITMAPCOREHEADER: 16-bit dimensions.
    if (bytes.byteLength < 22) return unreadable("truncated_header");
    return read("bmp", uint16le(bytes, 18), uint16le(bytes, 20));
  }
  if (headerSize < 40) return unreadable("unsupported_format");
  if (bytes.byteLength < 26) return unreadable("truncated_header");
  return read("bmp", int32le(bytes, 18), Math.abs(int32le(bytes, 22)));
}
