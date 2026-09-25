// Sticker library storage (ADR0018 P4e, §9.1/§9.2).
//
// These suites protect the three §9.1 rules that are easy to lose in storage code, and one that
// is easy to fake:
//
//   * an import saves a copy and leaves the asset DISABLED — nothing becomes selectable merely by
//     being imported;
//   * "移出集合" removes only the membership: the asset, its file and its other collections
//     survive;
//   * a model-assisted description stays a DRAFT, so no code path can read it as the user's text;
//   * and the undecided operations (asset deletion, file replacement, collection deletion,
//     duplicate-import handling, orphan handling) are asserted to be ABSENT, because §9.1 says not
//     to add automatic deletion and a wrong guess here destroys a file the user imported.
//
// The copy store is exercised against a temporary directory, never the app's real data area.

import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import upstream from "omggif";
import {
  addQqStickerToCollections,
  createQqStickerCollection,
  editQqSticker,
  importQqSticker,
  listQqStickerAssets,
  listQqStickerCollections,
  QQ_STICKER_PENDING_GOVERNANCE,
  qqStickerLibrarySnapshot,
  readQqStickerAsset,
  removeQqStickerFromCollection,
  saveQqStickerDraft,
  setQqStickerEnabled,
  updateQqStickerCollection,
} from "../../src/server/db/qq-sticker-repository";
import { ensureDefaults } from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { encodeQqFramePng } from "../../src/server/services/qq-animation-frames";
import { resolveQqStickerLibrary } from "../../src/server/services/qq-sticker-contract";
import { importQqStickerCopy } from "../../src/server/services/qq-sticker-import";
import { QqStickerStore } from "../../src/server/services/qq-sticker-store";

const MODEL = "qwen/qwen3-4b-2507";
// Real bytes, not a stub: §9.2's "格式/大小/尺寸自动读取" reads the header, so a fixture that is
// only a signature would be refused — and asserting a size a file does not really have is how a
// fixture stops testing anything.
const PNG_WIDTH = 320;
const PNG_HEIGHT = 240;
const PNG_BYTES = encodeQqFramePng(
  new Uint8Array(PNG_WIDTH * PNG_HEIGHT * 4).fill(0x80),
  PNG_WIDTH,
  PNG_HEIGHT,
);

/** A second real container, so "the content decides" can be tested against a name that lies. */
function gifBytes(width: number, height: number): Uint8Array {
  const buffer = new Uint8Array(width * height * 4 + 4096 + 768);
  const writer = new upstream.GifWriter(buffer, width, height, {
    palette: [0xff0000, 0x00ff00],
    loop: 0,
  });
  writer.addFrame(0, 0, width, height, new Array(width * height).fill(0), {
    delay: 10,
    disposal: 1,
  });
  return buffer.slice(0, writer.end());
}

function setup() {
  const business = openBusinessDb();
  ensureDefaults(business.orm, MODEL);
  const dir = mkdtempSync(path.join(realpathSync(tmpdir()), "ss-stickers-"));
  return { business, orm: business.orm, store: new QqStickerStore({ directory: dir }), dir };
}

function importAsset(h: ReturnType<typeof setup>, name = "表情.png") {
  const id = crypto.randomUUID();
  const copy = h.store.importCopy({ assetId: id, bytes: PNG_BYTES });
  // The size is no longer passed in from the test: it is read from the header, which is the point.
  return importQqSticker(h.orm, {
    id,
    copy,
    name,
    width: copy.width,
    height: copy.height,
  });
}

const opened: Array<{ close: () => void; dir: string }> = [];
afterEach(() => {
  for (const entry of opened.splice(0)) {
    entry.close();
    rmSync(entry.dir, { recursive: true, force: true });
  }
});

function tracked() {
  const h = setup();
  opened.push({ close: () => h.business.close(), dir: h.dir });
  return h;
}

describe("importing saves a copy and stays disabled", () => {
  it("writes the bytes into the sticker directory and records a disabled asset", () => {
    const h = tracked();
    const asset = importAsset(h);
    // §9.1: 导入 → 保存应用内副本 → 默认停用.
    expect(asset.enabled).toBe(false);
    expect(asset.mediaType).toBe("image");
    expect(asset.byteSize).toBe(PNG_BYTES.byteLength);
    // §9.2's "尺寸自动读取": the row carries the size the header declares.
    expect(asset.width).toBe(PNG_WIDTH);
    expect(asset.height).toBe(PNG_HEIGHT);
    expect(asset.description).toBeNull();
    expect(asset.descriptionDraft).toBeNull();
    expect(asset.tags).toEqual([]);
    // The copy really exists on disk, and its name is the generated one.
    expect(h.store.copyExists(asset.fileName)).toBe(true);
    expect(h.store.readCopy(asset.fileName)).toEqual(PNG_BYTES);
  });

  it("keeps the original file untouched — the app owns a copy, not the source", () => {
    const h = tracked();
    const source = path.join(h.dir, "source.png");
    writeFileSync(source, PNG_BYTES);
    const before = readdirSync(h.dir).sort();
    const store = new QqStickerStore({ directory: path.join(h.dir, "copies") });
    const copy = store.importCopy({ assetId: crypto.randomUUID(), bytes: PNG_BYTES });
    importQqSticker(h.orm, { copy, name: "source.png" });
    // The source is still there, still the same size, and nothing was moved into its place.
    expect(existsSync(source)).toBe(true);
    expect(readdirSync(h.dir).sort()).toEqual([...before, "copies"].sort());
  });

  it("refuses a file whose bytes are not an image, leaving nothing behind", () => {
    const h = tracked();
    expect(() =>
      h.store.importCopy({
        assetId: crypto.randomUUID(),
        bytes: new Uint8Array([..."not an image"].map((char) => char.charCodeAt(0))),
      }),
    ).toThrow(TypeError);
    // The header is read before anything is written, so a refused import creates no directory,
    // no file and — the point — no row claiming a format we never read.
    expect(existsSync(path.join(h.dir, "copies"))).toBe(false);
    expect(listQqStickerAssets(h.orm)).toEqual([]);
  });

  it("refuses a half-read size instead of showing 400 × ?", () => {
    const h = tracked();
    const copy = h.store.importCopy({ assetId: crypto.randomUUID(), bytes: PNG_BYTES });
    expect(() => importQqSticker(h.orm, { copy, width: 400, height: null })).toThrow(TypeError);
    expect(listQqStickerAssets(h.orm)).toEqual([]);
    // The table refuses the same shape even if someone bypasses the repository.
    expect(() =>
      h.business.db.run(
        `INSERT INTO qq_sticker_assets (id, name, file_name, media_type, byte_size, width, height, created_at, updated_at) VALUES ('x','n','f.png','image',1,400,NULL,'t','t')`,
      ),
    ).toThrow();
  });

  it("never writes outside its own directory, even if the id looks like a path", () => {
    const h = tracked();
    expect(() => h.store.importCopy({ assetId: "../../escape", bytes: PNG_BYTES })).toThrow(
      TypeError,
    );
    expect(() => h.store.readCopy("../../escape.png")).toThrow(TypeError);
    expect(() => h.store.readCopy("/etc/passwd")).toThrow(TypeError);
  });

  it("keeps both halves under one id, so the copy's name belongs to the row that owns it", () => {
    const h = tracked();
    const id = crypto.randomUUID();
    const copy = h.store.importCopy({ assetId: id, bytes: PNG_BYTES });
    const asset = importQqSticker(h.orm, { id, copy, name: "同名.png" });
    expect(asset.id).toBe(id);
    expect(asset.fileName).toBe(`${id}.png`);
  });
});

describe("the file decides the format, not the name it arrived under", () => {
  it("stores a PNG as a PNG whatever the import called it", () => {
    const h = tracked();
    const id = crypto.randomUUID();
    // The name §9.2 defaults to is what the user's disk said; it is not evidence about the bytes.
    const copy = h.store.importCopy({ assetId: id, bytes: PNG_BYTES });
    expect(copy.format).toBe("png");
    expect(copy.fileName).toBe(`${id}.png`);
    expect(copy.width).toBe(PNG_WIDTH);
    const asset = importQqSticker(h.orm, { id, copy, name: "其实是PNG.gif" });
    expect(asset.mediaType).toBe("image");
  });

  it("reads a real animation as an animation, and sizes it from its own header", () => {
    const h = tracked();
    const result = importQqStickerCopy({
      orm: h.orm,
      store: h.store,
      request: { bytes: gifBytes(12, 8), name: "表情.png" },
    });
    expect(result.kind).toBe("imported");
    if (result.kind !== "imported") return;
    // Named `.png`, stored as the animation it actually is — otherwise the library would offer a
    // sticker on a canvas its content does not fill, and §8's send path would misdeclare it.
    expect(result.asset.mediaType).toBe("animation");
    expect(result.asset.fileName.endsWith(".gif")).toBe(true);
    expect(result.asset.width).toBe(12);
    expect(result.asset.height).toBe(8);
    expect(result.asset.enabled).toBe(false);
  });
});

describe("importing a file is one act, with one answer", () => {
  it("reads format, byte size and pixel size from the bytes alone", () => {
    const h = tracked();
    const result = importQqStickerCopy({
      orm: h.orm,
      store: h.store,
      request: { bytes: PNG_BYTES, name: "从磁盘导入.png" },
    });
    expect(result).toMatchObject({
      kind: "imported",
      asset: {
        name: "从磁盘导入.png",
        mediaType: "image",
        byteSize: PNG_BYTES.byteLength,
        width: PNG_WIDTH,
        height: PNG_HEIGHT,
      },
    });
    if (result.kind !== "imported") return;
    expect(h.store.copyExists(result.asset.fileName)).toBe(true);
    expect(h.store.readCopy(result.asset.fileName)).toEqual(PNG_BYTES);
  });

  it("reports why a file was refused instead of storing an unreadable asset", () => {
    const h = tracked();
    const ascii = (text: string) => new Uint8Array([...text].map((char) => char.charCodeAt(0)));
    expect(
      importQqStickerCopy({
        orm: h.orm,
        store: h.store,
        request: { bytes: new Uint8Array(0), name: "a" },
      }),
    ).toEqual({ kind: "rejected", reason: "empty" });
    expect(
      importQqStickerCopy({
        orm: h.orm,
        store: h.store,
        request: { bytes: ascii("just a text file"), name: "a.txt" },
      }),
    ).toEqual({ kind: "rejected", reason: "unsupported_format" });
    expect(
      importQqStickerCopy({
        orm: h.orm,
        store: h.store,
        request: { bytes: PNG_BYTES.slice(0, 8), name: "half.png" },
      }),
    ).toEqual({ kind: "rejected", reason: "truncated_header" });
    // A rejected import is not a partial one: no row, and no file written either.
    expect(listQqStickerAssets(h.orm)).toEqual([]);
    expect(readdirSync(h.store.directoryPath)).toEqual([]);
  });

  it("leaves neither a row nor an orphan copy when the row cannot be written", () => {
    const h = tracked();
    // A collection that no longer exists fails the import after the copy has been written — the
    // one window where an import can half-succeed. Both halves have to be gone afterwards.
    expect(() =>
      importQqStickerCopy({
        orm: h.orm,
        store: h.store,
        request: { bytes: PNG_BYTES, name: "要落库里.png", collectionIds: [crypto.randomUUID()] },
      }),
    ).toThrow();
    expect(listQqStickerAssets(h.orm)).toEqual([]);
    const left = existsSync(h.store.directoryPath) ? readdirSync(h.store.directoryPath) : [];
    expect(left).toEqual([]);
  });

  it("imports into the collections it was given", () => {
    const h = tracked();
    const collection = createQqStickerCollection(h.orm, { name: "常用" });
    const result = importQqStickerCopy({
      orm: h.orm,
      store: h.store,
      request: { bytes: PNG_BYTES, name: "归类.png", collectionIds: [collection.id] },
    });
    expect(result.kind).toBe("imported");
    if (result.kind !== "imported") return;
    expect(result.asset.collectionIds).toEqual([collection.id]);
  });
});

describe("editing what was imported", () => {
  it("defaults the name to the file name and lets it be edited", () => {
    const h = tracked();
    const asset = importAsset(h, "默认名.png");
    expect(asset.name).toBe("默认名.png");
    expect(editQqSticker(h.orm, asset.id, { name: "改过的名字" }).name).toBe("改过的名字");
    expect(() => editQqSticker(h.orm, asset.id, { name: "   " })).toThrow();
  });
});

describe("enabling is a separate act from importing", () => {
  it("becomes selectable only after it is enabled, and can be taken away again", () => {
    const h = tracked();
    const asset = importAsset(h);
    const eligible = () =>
      resolveQqStickerLibrary({
        assets: qqStickerLibrarySnapshot(h.orm, () => true).assets.map((entry) => ({
          id: entry.id,
          enabled: entry.enabled,
          available: entry.available,
          collectionIds: entry.collectionIds,
        })),
        authorizedCollectionIds: ["any"],
      });
    // Nothing is selectable yet, because it belongs to no authorized collection.
    expect(eligible().candidates).toEqual([]);
    expect(schemeSees(h, asset.id)).toBe(false);
    setQqStickerEnabled(h.orm, asset.id, true);
    expect(readQqStickerAsset(h.orm, asset.id)?.enabled).toBe(true);
    setQqStickerEnabled(h.orm, asset.id, false);
    expect(readQqStickerAsset(h.orm, asset.id)?.enabled).toBe(false);
  });

  it("keeps a disabled asset out of the library even inside an authorized collection", () => {
    const h = tracked();
    const asset = importAsset(h);
    const collection = createQqStickerCollection(h.orm, { name: "常用" });
    addQqStickerToCollections(h.orm, asset.id, [collection.id]);
    // Enabled is off, so the collection membership is not enough (§9.1: 候选素材必须已启用).
    const library = resolveQqStickerLibrary({
      assets: qqStickerLibrarySnapshot(h.orm, () => true).assets,
      authorizedCollectionIds: [collection.id],
    });
    expect(library.candidates).toEqual([]);
    expect(library.rejected).toEqual([{ assetId: asset.id, reason: "disabled" }]);

    setQqStickerEnabled(h.orm, asset.id, true);
    const after = resolveQqStickerLibrary({
      assets: qqStickerLibrarySnapshot(h.orm, () => true).assets,
      authorizedCollectionIds: [collection.id],
    });
    expect(after.candidates.map((entry) => entry.assetId)).toEqual([asset.id]);
  });

  function schemeSees(h: ReturnType<typeof setup>, assetId: string) {
    const view = listQqStickerAssets(h.orm).find((entry) => entry.id === assetId);
    return view?.enabled ?? false;
  }
});

describe("collections and membership", () => {
  it("puts one asset in several collections without duplicating it", () => {
    const h = tracked();
    const asset = importAsset(h);
    const first = createQqStickerCollection(h.orm, { name: "A" });
    const second = createQqStickerCollection(h.orm, { name: "B" });
    addQqStickerToCollections(h.orm, asset.id, [first.id, second.id]);
    // Membership alone is not selectability: §9.1 also requires the asset to be enabled.
    setQqStickerEnabled(h.orm, asset.id, true);
    const stored = readQqStickerAsset(h.orm, asset.id);
    expect(stored?.collectionIds).toEqual([first.id, second.id].sort());
    // §9.1: the same asset reached through two authorized collections is still ONE candidate.
    const library = resolveQqStickerLibrary({
      assets: qqStickerLibrarySnapshot(h.orm, () => true).assets,
      authorizedCollectionIds: [first.id, second.id],
    });
    expect(library.candidates).toHaveLength(1);
    expect(library.candidates[0]?.viaCollectionIds).toHaveLength(2);
  });

  it("removes only the membership: file, description and other collections survive", () => {
    const h = tracked();
    const asset = importAsset(h);
    const keep = createQqStickerCollection(h.orm, { name: "留着" });
    const drop = createQqStickerCollection(h.orm, { name: "移出" });
    addQqStickerToCollections(h.orm, asset.id, [keep.id, drop.id]);
    editQqSticker(h.orm, asset.id, { description: "用户写的说明" });
    removeQqStickerFromCollection(h.orm, asset.id, drop.id);
    const after = readQqStickerAsset(h.orm, asset.id);
    expect(after?.collectionIds).toEqual([keep.id]);
    expect(after?.description).toBe("用户写的说明");
    expect(h.store.copyExists(after?.fileName as string)).toBe(true);
  });

  it("re-adding a membership is a no-op rather than an error", () => {
    const h = tracked();
    const asset = importAsset(h);
    const collection = createQqStickerCollection(h.orm, { name: "A" });
    addQqStickerToCollections(h.orm, asset.id, [collection.id]);
    addQqStickerToCollections(h.orm, asset.id, [collection.id]);
    expect(readQqStickerAsset(h.orm, asset.id)?.collectionIds).toEqual([collection.id]);
    expect(listQqStickerCollections(h.orm)[0]?.assetCount).toBe(1);
  });

  it("refuses a membership that names something absent", () => {
    const h = tracked();
    const asset = importAsset(h);
    expect(() =>
      addQqStickerToCollections(h.orm, crypto.randomUUID(), [
        createQqStickerCollection(h.orm, { name: "A" }).id,
      ]),
    ).toThrow();
    expect(() => addQqStickerToCollections(h.orm, asset.id, [crypto.randomUUID()])).toThrow();
  });

  it("keeps collection names unique and renames under compare-and-swap", () => {
    const h = tracked();
    const created = createQqStickerCollection(h.orm, { name: "常用", description: "日常用" });
    expect(() => createQqStickerCollection(h.orm, { name: "常用" })).toThrow();
    const renamed = updateQqStickerCollection(h.orm, created.id, {
      name: "常用表情",
      expectedRevision: created.revision,
    });
    expect(renamed.name).toBe("常用表情");
    expect(renamed.revision).toBe(created.revision + 1);
    // A stale revision is refused rather than silently applied.
    expect(() =>
      updateQqStickerCollection(h.orm, created.id, {
        name: "别的",
        expectedRevision: created.revision,
      }),
    ).toThrow();
    // A no-op save is not a change.
    const noop = updateQqStickerCollection(h.orm, created.id, {
      name: "常用表情",
      expectedRevision: renamed.revision,
    });
    expect(noop.revision).toBe(renamed.revision);
  });
});

describe("the model-assisted description stays a draft", () => {
  it("never becomes the description a reader sees", () => {
    const h = tracked();
    const asset = importAsset(h);
    const withDraft = saveQqStickerDraft(h.orm, asset.id, "模型猜的说明");
    expect(withDraft.descriptionDraft).toBe("模型猜的说明");
    // §9.2: the model helps, the user decides. The shared description is still empty.
    expect(withDraft.description).toBeNull();
    const approved = editQqSticker(h.orm, asset.id, { description: "用户审过并改过的说明" });
    expect(approved.description).toBe("用户审过并改过的说明");
    // Saving the description does not silently clear or promote the draft.
    expect(approved.descriptionDraft).toBe("模型猜的说明");
    // And saving a draft never enables anything.
    expect(approved.enabled).toBe(false);
  });

  it("refuses blank text and unknown assets", () => {
    const h = tracked();
    const asset = importAsset(h);
    expect(() => saveQqStickerDraft(h.orm, asset.id, "   ")).toThrow();
    expect(() => saveQqStickerDraft(h.orm, crypto.randomUUID(), "x")).toThrow();
    expect(() => readQqStickerAsset(h.orm, crypto.randomUUID())).toBeDefined();
    expect(readQqStickerAsset(h.orm, crypto.randomUUID())).toBeNull();
  });

  it("validates tags on the way in and out", () => {
    const h = tracked();
    const asset = importAsset(h);
    const tagged = editQqSticker(h.orm, asset.id, { tags: ["开心", "猫"] });
    expect(tagged.tags).toEqual(["开心", "猫"]);
    expect(editQqSticker(h.orm, asset.id, { tags: [] }).tags).toEqual([]);
    expect(() => editQqSticker(h.orm, asset.id, { tags: ["  "] })).toThrow();
    // A hand-edited row cannot make the library read as if it had tags it does not.
    h.business.db.run(`UPDATE qq_sticker_assets SET tags = 'not json' WHERE id = '${asset.id}'`);
    expect(() => readQqStickerAsset(h.orm, asset.id)).toThrow();
  });
});

describe("the undecided material operations remain absent", () => {
  it("records §9.1's open questions instead of guessing at them", () => {
    expect(QQ_STICKER_PENDING_GOVERNANCE.item).toBe("U11");
    expect([...QQ_STICKER_PENDING_GOVERNANCE.undecided]).toEqual([
      "asset_deletion",
      "duplicate_import_handling",
      "file_replacement",
      "collection_deletion",
      "orphan_asset_handling",
    ]);
  });

  it("exposes no delete, replace or cleanup function", async () => {
    const module = await import("../../src/server/db/qq-sticker-repository");
    const names = Object.keys(module);
    // §9.1 says not to add automatic deletion by default, and a wrong guess destroys a file the
    // user imported — so the absence is asserted rather than left to reviewers to notice.
    for (const forbidden of [
      "deleteQqSticker",
      "deleteQqStickerAsset",
      "deleteQqStickerCollection",
      "replaceQqStickerFile",
      "purgeQqStickers",
    ]) {
      expect(names).not.toContain(forbidden);
    }
    // The only removal is the membership one, plus the store's rollback helper.
    expect(names).toContain("removeQqStickerFromCollection");
  });
});
