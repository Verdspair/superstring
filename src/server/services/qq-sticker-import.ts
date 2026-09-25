// Importing a sticker: bytes in, library row out (ADR0018 P4f, §9.1/§9.2).
//
// The store owns the copy and the repository owns the row, but neither can do the whole import:
// §9.1's sequence is "保存应用内副本" and THEN the asset exists, and §9.2's surface needs one
// answer about whether a picked file became an asset. This module is that answer, and it is the
// only place where the two halves are joined.
//
// Two things it deliberately does not do:
//
//   * It does not enable anything. §9.1 puts 用户审核 between import and use, so the row lands
//     disabled and stays that way until the user acts — a caller cannot ask for otherwise.
//   * It does not guess a format. The container and the pixel size come from the bytes; a file
//     whose header cannot be read is reported as rejected, with the reason, and no copy is left
//     behind for it.
//
// Failure left behind a half-imported asset is the one thing worth engineering against: the copy
// is written before the row exists (it has to be — the row refers to the file name), so if the
// row cannot be created the copy is discarded. That is the only reason `discardCopy` exists.

import { z } from "zod";
import { importQqSticker, type QqStickerAssetView } from "../db/qq-sticker-repository";
import type { Orm } from "../db/repositories";
import { newId } from "../db/repositories";
import { type QqImageHeaderRejection, readQqImageHeader } from "./qq-image-header";
import type { QqStickerStore } from "./qq-sticker-store";

export interface ImportQqStickerRequest {
  readonly bytes: Uint8Array;
  /** §9.2: the name defaults to the file name the user picked, and stays editable afterwards. */
  readonly name: string;
  readonly collectionIds?: readonly string[];
}

export type QqStickerImportResult =
  | { readonly kind: "imported"; readonly asset: QqStickerAssetView }
  | { readonly kind: "rejected"; readonly reason: QqImageHeaderRejection };

const NameSchema = z.string().trim().min(1).max(200);

/**
 * Import one file into the sticker library.
 *
 * Returns a verdict rather than throwing on an unreadable file: a user picking a PDF is an
 * ordinary outcome of a file picker, and §9.2's surface has to be able to say which of the four
 * reasons applies.
 */
export function importQqStickerCopy(input: {
  orm: Orm;
  store: QqStickerStore;
  request: ImportQqStickerRequest;
}): QqStickerImportResult {
  const request = input?.request;
  const bytes = request?.bytes;
  if (!(bytes instanceof Uint8Array)) throw new TypeError("Invalid QQ sticker import input");
  const header = readQqImageHeader(bytes);
  if (header.kind !== "read") {
    return Object.freeze({ kind: "rejected", reason: header.reason });
  }
  const name = NameSchema.parse(request.name);
  // One id for both halves, so the copy's generated name and the row that owns it agree.
  const id = newId();
  const copy = input.store.importCopy({ assetId: id, bytes });
  try {
    const asset = importQqSticker(input.orm, {
      id,
      copy,
      name,
      // §9.2's "格式/大小/尺寸等自动读取": read from the header, never asked of the user.
      width: copy.width,
      height: copy.height,
      collectionIds: request.collectionIds,
    });
    return Object.freeze({ kind: "imported", asset });
  } catch (error) {
    // The row never came into being, so the copy is an orphan: remove it and let the caller see
    // why the import failed. Nothing else is rolled back, because nothing else was done.
    input.store.discardCopy(copy.fileName);
    throw error;
  }
}
