// §9.2's management writes (ADR0018 P5d).
//
// These cases protect the boundary as much as the functions, because the boundary is what the
// plan decided: an import always lands DISABLED (§9.1's 用户审核 sits between import and use),
// "保存整理" cannot switch an asset on (only the explicit enable action can), and the operations
// §9.1 leaves undecided — deleting an asset, replacing its file, handling a duplicate import —
// have no route at all. A surface that offered them would be guessing with files the user
// imported himself.
//
// The copy store writes into a temporary directory, never the app's real data area.

import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Hono } from "hono";
import upstream from "omggif";
import { createApp } from "../../src/server/app";
import {
  readOrganizationSettings,
  updateOrganizationSettings,
} from "../../src/server/db/organization-repository";
import { createQqStickerCollection } from "../../src/server/db/qq-sticker-repository";
import { ensureDefaults, type Orm } from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { encodeQqFramePng } from "../../src/server/services/qq-animation-frames";

const MODEL = "qwen/qwen3-4b-2507";
// Real bytes: §9.2's size and dimensions are read from the header, so a signature-only fixture
// would be refused and would assert nothing.
const PNG_WIDTH = 24;
const PNG_HEIGHT = 16;
// Copied into an ArrayBuffer-backed view: `File`'s parts must be ArrayBuffer-backed, and the
// encoder's return type is the wider `Uint8Array<ArrayBufferLike>`.
const PNG_BYTES = new Uint8Array(
  encodeQqFramePng(new Uint8Array(PNG_WIDTH * PNG_HEIGHT * 4).fill(0x40), PNG_WIDTH, PNG_HEIGHT),
);
const MISSING = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    try {
      rmSync(directory, { recursive: true, force: true });
    } catch {
      // Windows can still hold a directory handle for a moment; a leftover temp dir is not a
      // failure of the case that created it.
    }
  }
});

/** The media purposes live on the shared settings row (P5i); the annotation reads the vision one. */
function setVisionModel(orm: Orm, model: string | null) {
  const current = readOrganizationSettings(orm);
  updateOrganizationSettings(orm, {
    model_name: current.model_name,
    vision_model_name: model,
    expected_revision: current.revision,
  });
}

/** Only the capacity probe is reached by the annotation path; the rest is never called here. */
function fakeGateway(capacity: number | null) {
  return {
    config: { baseUrl: "http://127.0.0.1:1/v1", model: MODEL, timeoutSeconds: 5 },
    loadedContextCapacity: async () => capacity,
  };
}

function fixture(
  options: {
    annotator?: (input: { images: readonly { mimeType: string }[] }) => Promise<string>;
  } = {},
) {
  const directory = mkdtempSync(path.join(tmpdir(), "qq-sticker-management-"));
  tempDirectories.push(directory);
  const business = openBusinessDb();
  ensureDefaults(business.orm, MODEL);
  const orm: Orm = business.orm;
  return {
    business,
    orm,
    directory,
    app: createApp({
      business,
      qqStickerDirectory: directory,
      // 65536 estimated units: enough for the prompt plus the fixed annotation reserve.
      gateway: fakeGateway(65536) as never,
      ...(options.annotator === undefined
        ? {}
        : { qqStickerAnnotator: options.annotator as never }),
    }),
  };
}

function jsonRequest(method: string, body: unknown): RequestInit {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

async function errorCode(response: Response): Promise<string> {
  return ((await response.json()) as { error: { code: string } }).error.code;
}

/** One multipart import, the way a file picker submits it. */
function importForm(
  bytes: Uint8Array<ArrayBuffer>,
  fileName: string,
  fields: Record<string, string> = {},
) {
  const form = new FormData();
  form.set("file", new File([bytes], fileName));
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return form;
}

interface ImportedAsset {
  id: string;
  name: string;
  description: string | null;
  description_draft: string | null;
  tags: string[];
  tags_draft: string[];
  usage_note: string | null;
  media_type: string;
  byte_size: number;
  width: number | null;
  height: number | null;
  enabled: boolean;
  collection_ids: string[];
}

async function importSticker(
  app: Hono,
  fields: Record<string, string> = {},
): Promise<{ response: Response; raw: string; body: { kind: string; asset?: ImportedAsset } }> {
  const response = await app.request("/qq/stickers/import", {
    method: "POST",
    body: importForm(PNG_BYTES, "猫.png", fields),
  });
  const raw = await response.text();
  return { response, raw, body: JSON.parse(raw) as { kind: string; asset?: ImportedAsset } };
}

describe("sticker collections are named resources, not free-form tags", () => {
  it("creates one, refuses a duplicate name, and renames under compare-and-swap", async () => {
    const h = fixture();
    try {
      const created = await h.app.request(
        "/qq/sticker-collections",
        jsonRequest("POST", { name: "日常", description: "平时发的那几张" }),
      );
      expect(created.status).toBe(201);
      const collection = (await created.json()) as { id: string; revision: number };
      expect(collection.revision).toBe(1);

      const duplicate = await h.app.request(
        "/qq/sticker-collections",
        jsonRequest("POST", { name: "日常" }),
      );
      expect(duplicate.status).toBe(409);
      expect(await errorCode(duplicate)).toBe("MEMORY_STATE_CONFLICT");

      const stale = await h.app.request(
        `/qq/sticker-collections/${collection.id}`,
        jsonRequest("PUT", { name: "常用", expected_revision: 2 }),
      );
      expect(stale.status).toBe(409);

      const renamed = await h.app.request(
        `/qq/sticker-collections/${collection.id}`,
        jsonRequest("PUT", { name: "常用", expected_revision: 1 }),
      );
      expect(renamed.status).toBe(200);
      expect(await renamed.json()).toMatchObject({ name: "常用", revision: 2 });

      expect(
        (await h.app.request("/qq/sticker-collections", jsonRequest("POST", { name: "   " })))
          .status,
      ).toBe(422);
      expect(
        (
          await h.app.request(
            "/qq/sticker-collections",
            jsonRequest("POST", { name: "多余字段", extra: 1 }),
          )
        ).status,
      ).toBe(422);
      expect(
        (
          await h.app.request(
            `/qq/sticker-collections/${MISSING}`,
            jsonRequest("PUT", {
              name: "x",
              expected_revision: 1,
            }),
          )
        ).status,
      ).toBe(404);
    } finally {
      h.business.close();
    }
  });
});

describe("importing saves a copy and a disabled asset", () => {
  it("reads the format, size and dimensions from the bytes and exposes no copy name", async () => {
    const h = fixture();
    try {
      const { response, raw, body } = await importSticker(h.app);
      expect(response.status).toBe(201);
      expect(body.kind).toBe("imported");
      const asset = body.asset as ImportedAsset;
      expect(asset).toMatchObject({
        name: "猫.png",
        enabled: false,
        media_type: "image",
        byte_size: PNG_BYTES.byteLength,
        width: PNG_WIDTH,
        height: PNG_HEIGHT,
        collection_ids: [],
        description: null,
        description_draft: null,
        tags: [],
        usage_note: null,
      });
      // The copy exists under the asset's own id, and the response describes the asset rather
      // than the file it now owns.
      expect(raw).not.toContain("file_name");
      const names = readdirSync(h.directory);
      expect(names).toEqual([`${asset.id}.png`]);
      expect(
        readFileSync(path.join(h.directory, names[0] as string)).equals(Buffer.from(PNG_BYTES)),
      ).toBe(true);
    } finally {
      h.business.close();
    }
  });

  it("takes an explicit name, and the app requires nothing else to store the file", async () => {
    const h = fixture();
    try {
      const named = await importSticker(h.app, { name: "微笑" });
      expect(named.response.status).toBe(201);
      expect((named.body.asset as ImportedAsset).name).toBe("微笑");
      expect(
        (
          await h.app.request("/qq/stickers/import", {
            method: "POST",
            body: importForm(PNG_BYTES, "猫.png", { name: "  " }),
          })
        ).status,
      ).toBe(422);
    } finally {
      h.business.close();
    }
  });

  it("answers a refused file with the verdict instead of an error code", async () => {
    const h = fixture();
    try {
      const cases = [
        [new Uint8Array(), "empty"],
        [new TextEncoder().encode("%PDF-1.4\n不再是图片"), "unsupported_format"],
        [PNG_BYTES.slice(0, 8), "truncated_header"],
      ] as const;
      for (const [bytes, expected] of cases) {
        const response = await h.app.request("/qq/stickers/import", {
          method: "POST",
          body: importForm(bytes, "错的文件"),
        });
        // A picked PDF is an ordinary outcome of a file picker, not a failed request: the
        // caller gets the reason and can say which one applies.
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ kind: "rejected", reason: expected });
      }
      // Nothing was written for a file that could not be read.
      expect(readdirSync(h.directory)).toEqual([]);
      expect(
        (
          await h.app.request("/qq/stickers/import", {
            method: "POST",
            body: new FormData(),
          })
        ).status,
      ).toBe(422);
      const extra = new FormData();
      extra.set("file", new File([PNG_BYTES], "猫.png"));
      extra.set("enabled", "true");
      expect(
        (await h.app.request("/qq/stickers/import", { method: "POST", body: extra })).status,
      ).toBe(422);
    } finally {
      h.business.close();
    }
  });
});

describe("an asset is described and enabled by separate actions", () => {
  it("edits §9.2's fields without touching enablement or the model draft", async () => {
    const h = fixture();
    try {
      const { body } = await importSticker(h.app);
      const asset = body.asset as ImportedAsset;
      const edited = await h.app.request(
        `/qq/stickers/${asset.id}`,
        jsonRequest("PATCH", {
          name: "问好",
          description: "挥手打招呼",
          tags: ["日常", "问候"],
          usage_note: "群里刚见面时用",
        }),
      );
      expect(edited.status).toBe(200);
      expect(await edited.json()).toMatchObject({
        name: "问好",
        description: "挥手打招呼",
        tags: ["日常", "问候"],
        usage_note: "群里刚见面时用",
        // §9.2: 保存整理 does not enable, and the draft column belongs to the model action.
        enabled: false,
        description_draft: null,
      });
      expect(
        (await h.app.request(`/qq/stickers/${asset.id}`, jsonRequest("PATCH", { name: "  " })))
          .status,
      ).toBe(422);
      expect(
        (await h.app.request("/qq/stickers/not-an-id", jsonRequest("PATCH", { name: "x" }))).status,
      ).toBe(422);
      expect(
        (await h.app.request(`/qq/stickers/${MISSING}`, jsonRequest("PATCH", { name: "x" })))
          .status,
      ).toBe(404);
    } finally {
      h.business.close();
    }
  });

  it("enables and disables through the explicit action", async () => {
    const h = fixture();
    try {
      const { body } = await importSticker(h.app);
      const asset = body.asset as ImportedAsset;
      const enabled = await h.app.request(
        `/qq/stickers/${asset.id}/enabled`,
        jsonRequest("PUT", { enabled: true }),
      );
      expect(enabled.status).toBe(200);
      expect(await enabled.json()).toMatchObject({ enabled: true });
      const disabled = await h.app.request(
        `/qq/stickers/${asset.id}/enabled`,
        jsonRequest("PUT", { enabled: false }),
      );
      expect(await disabled.json()).toMatchObject({ enabled: false });
      expect(
        (
          await h.app.request(
            `/qq/stickers/${MISSING}/enabled`,
            jsonRequest("PUT", { enabled: true }),
          )
        ).status,
      ).toBe(404);
    } finally {
      h.business.close();
    }
  });

  it("replaces the membership set, checking every collection before removing any", async () => {
    const h = fixture();
    try {
      const first = createQqStickerCollection(h.orm, { name: "日常" });
      const second = createQqStickerCollection(h.orm, { name: "节日" });
      const { body } = await importSticker(h.app);
      const asset = body.asset as ImportedAsset;

      const both = await h.app.request(
        `/qq/stickers/${asset.id}/collections`,
        jsonRequest("PUT", { collection_ids: [first.id, second.id] }),
      );
      expect(both.status).toBe(200);
      expect([...(await both.json()).collection_ids].sort()).toEqual([first.id, second.id].sort());

      const single = await h.app.request(
        `/qq/stickers/${asset.id}/collections`,
        jsonRequest("PUT", { collection_ids: [second.id] }),
      );
      expect((await single.json()).collection_ids).toEqual([second.id]);
      // §9.1's "移出集合只移除该归类": the asset and its copy are still here.
      expect((await h.app.request(`/qq/stickers/${asset.id}`)).status).toBe(200);
      expect(readdirSync(h.directory)).toEqual([`${asset.id}.png`]);

      // An unknown collection must not cost the memberships that were already there.
      const unknown = await h.app.request(
        `/qq/stickers/${asset.id}/collections`,
        jsonRequest("PUT", { collection_ids: [second.id, MISSING] }),
      );
      expect(unknown.status).toBe(404);
      expect(
        ((await (await h.app.request(`/qq/stickers/${asset.id}`)).json()) as ImportedAsset)
          .collection_ids,
      ).toEqual([second.id]);
      expect(
        (
          await h.app.request(
            `/qq/stickers/${asset.id}/collections`,
            jsonRequest("PUT", { collection_ids: ["not-an-id"] }),
          )
        ).status,
      ).toBe(422);
    } finally {
      h.business.close();
    }
  });

  it("offers no delete or replace route for an asset or a collection", async () => {
    const h = fixture();
    try {
      const collection = createQqStickerCollection(h.orm, { name: "日常" });
      const { body } = await importSticker(h.app);
      const asset = body.asset as ImportedAsset;
      for (const request of [
        [`/qq/stickers/${asset.id}`, "DELETE"],
        [`/qq/sticker-collections/${collection.id}`, "DELETE"],
        [`/qq/stickers/${asset.id}/file`, "PUT"],
        [`/qq/stickers/${asset.id}/replace`, "POST"],
      ] as const) {
        expect((await h.app.request(request[0], { method: request[1] })).status).toBe(404);
      }
      // Nothing was removed by the attempts above.
      expect((await h.app.request(`/qq/stickers/${asset.id}`)).status).toBe(200);
      expect((await h.app.request("/qq/sticker-collections")).status).toBe(200);
    } finally {
      h.business.close();
    }
  });
});

/** A two-frame GIF, so the preview's static mode has something to reduce. */
function gifBytes(width: number, height: number): Uint8Array<ArrayBuffer> {
  const buffer = new Uint8Array(width * height * 4 + 4096 + 768);
  const writer = new upstream.GifWriter(buffer, width, height, {
    palette: [0xff0000, 0x00ff00],
    loop: 0,
  });
  writer.addFrame(0, 0, width, height, new Array(width * height).fill(0), {
    delay: 10,
    disposal: 1,
  });
  writer.addFrame(0, 0, width, height, new Array(width * height).fill(1), {
    delay: 10,
    disposal: 1,
  });
  return buffer.slice(0, writer.end());
}

describe("preview: the library's one byte exit, addressed by asset id", () => {
  it("serves the copy's bytes without naming the file", async () => {
    const h = fixture();
    try {
      const { body } = await importSticker(h.app);
      const asset = body.asset as ImportedAsset;
      const response = await h.app.request(`/qq/stickers/${asset.id}/preview`);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/png");
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG_BYTES);
      // The id is the address; the copy's own name and the directory never travel.
      expect(response.headers.get("content-disposition")).toBeNull();
    } finally {
      h.business.close();
    }
  });

  it("answers a still request for an animation with a first-frame PNG", async () => {
    const h = fixture();
    try {
      const still = await importSticker(h.app);
      const stillId = (still.body.asset as ImportedAsset).id;
      const stillPreview = await h.app.request(`/qq/stickers/${stillId}/preview?still=1`);
      // A still image is already static: the flag changes nothing about it.
      expect(new Uint8Array(await stillPreview.arrayBuffer())).toEqual(PNG_BYTES);

      const gif = gifBytes(8, 8);
      const imported = await h.app.request("/qq/stickers/import", {
        method: "POST",
        body: importForm(gif, "动图.gif"),
      });
      const asset = ((await imported.json()) as { asset: ImportedAsset }).asset;
      expect(asset.media_type).toBe("animation");
      const frame = await h.app.request(`/qq/stickers/${asset.id}/preview?still=1`);
      expect(frame.status).toBe(200);
      expect(frame.headers.get("content-type")).toBe("image/png");
      expect((await frame.arrayBuffer()).byteLength).toBeGreaterThan(0);
      // The detail view still gets the animation itself.
      const full = await h.app.request(`/qq/stickers/${asset.id}/preview`);
      expect(full.headers.get("content-type")).toBe("image/gif");
      expect(new Uint8Array(await full.arrayBuffer())).toEqual(gif);
    } finally {
      h.business.close();
    }
  });

  it("answers 404 for a missing asset or a missing copy, without leaking the path", async () => {
    const h = fixture();
    try {
      const { body } = await importSticker(h.app);
      const asset = body.asset as ImportedAsset;
      expect((await h.app.request(`/qq/stickers/${MISSING}/preview`)).status).toBe(404);
      rmSync(path.join(h.directory, `${asset.id}.png`));
      const gone = await h.app.request(`/qq/stickers/${asset.id}/preview`);
      expect(gone.status).toBe(404);
      expect(await errorCode(gone)).toBe("MEMORY_NOT_FOUND");
    } finally {
      h.business.close();
    }
  });
});

describe("batch operations validate before they write", () => {
  it("applies collections, tags and enablement to every selected asset", async () => {
    const h = fixture();
    try {
      const daily = createQqStickerCollection(h.orm, { name: "日常" });
      const festive = createQqStickerCollection(h.orm, { name: "节日" });
      const first = (await importSticker(h.app)).body.asset as ImportedAsset;
      const second = (await importSticker(h.app, { name: "第二张" })).body.asset as ImportedAsset;

      const applied = await h.app.request(
        "/qq/stickers/bulk",
        jsonRequest("POST", {
          asset_ids: [first.id, second.id],
          add_collection_ids: [daily.id],
          tags: { add: ["问候"] },
          enabled: true,
        }),
      );
      expect(applied.status).toBe(200);
      const assets = ((await applied.json()) as { assets: ImportedAsset[] }).assets;
      expect(assets.map((row) => row.id)).toEqual([first.id, second.id]);
      for (const row of assets) {
        expect(row.enabled).toBe(true);
        expect(row.collection_ids).toEqual([daily.id]);
        expect(row.tags).toEqual(["问候"]);
      }

      // 移出集合只移归类，标签按值移除，停用与单个动作同义。
      const moved = await h.app.request(
        "/qq/stickers/bulk",
        jsonRequest("POST", {
          asset_ids: [first.id],
          remove_collection_ids: [daily.id],
          add_collection_ids: [festive.id],
          tags: { remove: ["问候"], add: ["已整理"] },
          enabled: false,
        }),
      );
      const updated = ((await moved.json()) as { assets: ImportedAsset[] })
        .assets[0] as ImportedAsset;
      expect(updated.collection_ids).toEqual([festive.id]);
      expect(updated.tags).toEqual(["已整理"]);
      expect(updated.enabled).toBe(false);
      // The asset and both copies are still here.
      expect(readdirSync(h.directory)).toHaveLength(2);
    } finally {
      h.business.close();
    }
  });

  it("refuses the whole batch, naming the entry, before writing anything", async () => {
    const h = fixture();
    try {
      const daily = createQqStickerCollection(h.orm, { name: "日常" });
      const only = (await importSticker(h.app)).body.asset as ImportedAsset;
      const response = await h.app.request(
        "/qq/stickers/bulk",
        jsonRequest("POST", {
          asset_ids: [only.id, MISSING],
          add_collection_ids: [daily.id],
          enabled: true,
        }),
      );
      expect(response.status).toBe(404);
      expect(((await response.json()) as { error: { message: string } }).error.message).toContain(
        MISSING,
      );
      // Validation ran before any write: the usable asset was not touched.
      const after = (await (
        await h.app.request(`/qq/stickers/${only.id}`)
      ).json()) as ImportedAsset;
      expect(after.enabled).toBe(false);
      expect(after.collection_ids).toEqual([]);
    } finally {
      h.business.close();
    }
  });

  it("refuses a missing collection and an empty request", async () => {
    const h = fixture();
    try {
      const { body } = await importSticker(h.app);
      const assetBody = body.asset as ImportedAsset;
      const missingCollection = await h.app.request(
        "/qq/stickers/bulk",
        jsonRequest("POST", { asset_ids: [assetBody.id], add_collection_ids: [MISSING] }),
      );
      expect(missingCollection.status).toBe(404);
      // A batch with no operation at all is a malformed request, not a no-op success.
      expect(
        (
          await h.app.request(
            "/qq/stickers/bulk",
            jsonRequest("POST", { asset_ids: [assetBody.id] }),
          )
        ).status,
      ).toBe(422);
      expect(
        (
          await h.app.request(
            "/qq/stickers/bulk",
            jsonRequest("POST", { asset_ids: [], enabled: true }),
          )
        ).status,
      ).toBe(422);
    } finally {
      h.business.close();
    }
  });
});

describe("生成说明和标签 (§9.2): one picture call, two drafts", () => {
  it("stores the description and the tags as drafts and touches nothing else", async () => {
    const calls: { images: readonly { mimeType: string }[] }[] = [];
    const h = fixture({
      annotator: async (input) => {
        calls.push({ images: input.images });
        return JSON.stringify({ description: "一只猫在笑", tags: ["微笑", "猫"] });
      },
    });
    try {
      setVisionModel(h.orm, "vision-model");
      const imported = await importSticker(h.app, { name: "微笑" });
      const asset = imported.body.asset as ImportedAsset;
      const response = await h.app.request(`/qq/stickers/${asset.id}/annotate`, { method: "POST" });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { kind: string; asset: ImportedAsset };
      expect(body.kind).toBe("annotated");
      // §9.2: the model produces DRAFTS. What the user saved is exactly what it was.
      expect(body.asset).toMatchObject({
        description: null,
        description_draft: "一只猫在笑",
        tags: [],
        tags_draft: ["微笑", "猫"],
        enabled: false,
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]?.images).toHaveLength(1);
      expect(calls[0]?.images[0]?.mimeType).toBe("image/png");
    } finally {
      h.business.close();
    }
  });

  it("samples an animation into three frames rather than sending one picture", async () => {
    const mimes: string[] = [];
    const h = fixture({
      annotator: async (input) => {
        for (const image of input.images) mimes.push(image.mimeType);
        return JSON.stringify({ description: "动图", tags: ["动"] });
      },
    });
    try {
      setVisionModel(h.orm, "vision-model");
      const imported = await h.app.request("/qq/stickers/import", {
        method: "POST",
        body: importForm(gifBytes(8, 8), "动图.gif"),
      });
      const asset = ((await imported.json()) as { asset: ImportedAsset }).asset;
      expect(asset.media_type).toBe("animation");
      expect(
        (await h.app.request(`/qq/stickers/${asset.id}/annotate`, { method: "POST" })).status,
      ).toBe(200);
      // The sampler is asked for three frames and returns what the file has; a two-frame GIF
      // therefore travels as two PNGs rather than as the original animation.
      expect(mimes).toEqual(["image/png", "image/png"]);
    } finally {
      h.business.close();
    }
  });

  it("refuses without a picture model, and never calls one", async () => {
    let called = false;
    const h = fixture({
      annotator: async () => {
        called = true;
        return "{}";
      },
    });
    try {
      const imported = await importSticker(h.app);
      const asset = imported.body.asset as ImportedAsset;
      const response = await h.app.request(`/qq/stickers/${asset.id}/annotate`, { method: "POST" });
      expect(await response.json()).toEqual({
        kind: "rejected",
        reason: "model_not_configured",
      });
      expect(called).toBe(false);
    } finally {
      h.business.close();
    }
  });

  it("rejects an answer that is not the requested shape, leaving both drafts empty", async () => {
    const h = fixture({ annotator: async () => "这是一张好图" });
    try {
      setVisionModel(h.orm, "vision-model");
      const imported = await importSticker(h.app);
      const asset = imported.body.asset as ImportedAsset;
      expect(
        await (await h.app.request(`/qq/stickers/${asset.id}/annotate`, { method: "POST" })).json(),
      ).toEqual({ kind: "rejected", reason: "unreadable_answer" });
      const after = (await (
        await h.app.request(`/qq/stickers/${asset.id}`)
      ).json()) as ImportedAsset;
      expect(after.description_draft).toBeNull();
      expect(after.tags_draft).toEqual([]);
    } finally {
      h.business.close();
    }
  });

  it("reports a model failure instead of storing half an answer", async () => {
    const h = fixture({
      annotator: async () => {
        throw new Error("synthetic");
      },
    });
    try {
      setVisionModel(h.orm, "vision-model");
      const imported = await importSticker(h.app);
      const asset = imported.body.asset as ImportedAsset;
      expect(
        await (await h.app.request(`/qq/stickers/${asset.id}/annotate`, { method: "POST" })).json(),
      ).toEqual({ kind: "rejected", reason: "model_error" });
    } finally {
      h.business.close();
    }
  });
});
