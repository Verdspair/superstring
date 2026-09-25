// The app-internal sticker copy (ADR0018 P4e/P4f, §9.1/§9.2).
//
// §9.1's lifecycle starts "导入 → 保存应用内副本": the user's original file is never moved or
// modified, and what the app later sends is a copy it owns. This module is that copy — bytes in,
// a stored file name out — and nothing else. It does not touch the database, decide enablement,
// or pick a sticker.
//
// Two rules are enforced here rather than trusted from callers:
//
//   * A stored file name is GENERATED from the asset id and the format that was actually read
//     from the bytes. §9.1 leaves file replacement undecided, but an import-time path built from
//     a user-supplied name would make "../../something" a legal sticker, so the name never comes
//     from the source — and §9.2's "格式自动读取" means the extension comes from the content, not
//     from what the file happened to be called.
//   * Every read and write re-checks that the resolved path really sits inside the sticker
//     directory. A generated name makes escape unlikely; the check makes it impossible, which
//     matters because this directory is also where a future feature split would relocate.
//
// Deleting is deliberately absent. §9.1 leaves asset deletion undecided and says not to add
// automatic deletion, so the only removal that exists is `discardCopy`, used to undo a copy whose
// import failed before any row was written — it can never be reached for an asset that exists.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  QQ_STICKER_FORMATS,
  type QqStickerFormat,
  type QqStickerMediaType,
  readQqImageHeader,
} from "./qq-image-header";

export type { QqStickerFormat, QqStickerMediaType };

/**
 * Where copies live when no explicit layout was resolved (the same fallback style as the transport
 * key file). The development private root is `local/`, per the target layout; an installed
 * deployment passes its own `userdata/qq/stickers` path through `AppPathOptions.qqStickersDir`.
 */
export const DEFAULT_QQ_STICKER_DIRECTORY = path.resolve("local", "qq", "stickers");

/** A generated name only: uuid, dot, one lower-case extension from the format table. Never a path. */
const COPY_NAME_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{1,5}$/;

export interface QqStickerCopy {
  readonly fileName: string;
  readonly byteSize: number;
  readonly mediaType: QqStickerMediaType;
  readonly format: QqStickerFormat;
  /** §9.2's pixel size, read from the header rather than asked of the user. */
  readonly width: number;
  readonly height: number;
}

export class QqStickerStore {
  private readonly directory: string;

  /** The sticker directory is injected so tests never write into the app's real data area. */
  constructor(input: { directory: string }) {
    if (typeof input?.directory !== "string" || input.directory.trim().length === 0) {
      throw new TypeError("Invalid QQ sticker store input");
    }
    this.directory = path.resolve(input.directory);
  }

  get directoryPath(): string {
    return this.directory;
  }

  /**
   * Save a copy of an imported file, named for what it actually is.
   *
   * The container is read from the bytes, so the stored extension and media type describe the
   * file rather than the name it arrived under: a `.gif` holding a PNG becomes a PNG copy and an
   * image asset, not an animation the library could never send. A file whose header cannot be
   * read is refused BEFORE anything is written, which is what keeps "unknown format" and
   * "size 0" rows out of the library.
   */
  importCopy(input: { assetId: string; bytes: Uint8Array }): QqStickerCopy {
    const assetId = input?.assetId;
    if (typeof assetId !== "string" || assetId.trim().length === 0) {
      throw new TypeError("Invalid QQ sticker store input");
    }
    if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength === 0) {
      throw new TypeError("Invalid QQ sticker store input");
    }
    const header = readQqImageHeader(input.bytes);
    if (header.kind !== "read") throw new TypeError("Invalid QQ sticker store input");
    const { extension, mediaType } = QQ_STICKER_FORMATS[header.format];
    const fileName = `${assetId}.${extension}`;
    // The id is the caller's, so it is re-checked against the shape rather than assumed: a
    // caller that passed a path-like id must fail here, not write outside the directory.
    if (!COPY_NAME_PATTERN.test(fileName)) throw new TypeError("Invalid QQ sticker store input");
    mkdirSync(this.directory, { recursive: true });
    const destination = this.resolve(fileName);
    writeFileSync(destination, input.bytes);
    return Object.freeze({
      fileName,
      byteSize: input.bytes.byteLength,
      mediaType,
      format: header.format,
      width: header.width,
      height: header.height,
    });
  }

  /** Read a stored copy back. Missing files raise rather than returning empty bytes. */
  readCopy(fileName: unknown): Uint8Array {
    return new Uint8Array(readFileSync(this.resolve(assertCopyName(fileName))));
  }

  copyExists(fileName: unknown): boolean {
    try {
      readFileSync(this.resolve(assertCopyName(fileName)));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Undo a copy whose import failed.
   *
   * Not a user-facing delete: it exists so a half-finished import leaves no orphan, and it is
   * only ever called on the way out of a failed `importCopy` caller.
   */
  discardCopy(fileName: unknown): void {
    rmSync(this.resolve(assertCopyName(fileName)), { force: true });
  }

  private resolve(fileName: string): string {
    const resolved = path.resolve(this.directory, fileName);
    const relative = path.relative(this.directory, resolved);
    // `relative` starting with ".." or being absolute means the name escaped the directory.
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new TypeError("Invalid QQ sticker store input");
    }
    return resolved;
  }
}

function assertCopyName(fileName: unknown): string {
  if (typeof fileName !== "string" || !COPY_NAME_PATTERN.test(fileName)) {
    throw new TypeError("Invalid QQ sticker store input");
  }
  return fileName;
}
