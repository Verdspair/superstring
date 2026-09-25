import { describe, expect, it } from "bun:test";
import { createApp } from "../../src/server/app";
import { createQqScheme } from "../../src/server/db/qq-scheme-repository";
import {
  createQqStickerCollection,
  importQqSticker,
} from "../../src/server/db/qq-sticker-repository";
import { ensureDefaults, nowIso, type Orm } from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";

const MODEL = "qwen/qwen3-4b-2507";
const ASSET = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MISSING = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function fixture() {
  const business = openBusinessDb();
  ensureDefaults(business.orm, MODEL);
  const orm: Orm = business.orm;
  const collection = createQqStickerCollection(orm, { name: "日常" });
  const asset = importQqSticker(orm, {
    id: ASSET,
    name: "问好",
    copy: { fileName: `${ASSET}.png`, byteSize: 42, mediaType: "image" },
    width: 8,
    height: 8,
    collectionIds: [collection.id],
  });
  const scheme = createQqScheme(orm, { name: "聊天", stickerCollections: [collection.id] });
  orm
    .insert(schema.qqBindings)
    .values({
      id: crypto.randomUUID(),
      accountId: "10001",
      conversationKind: "group",
      peerId: "20001",
      agentId: "00000000-0000-0000-0000-000000000001",
      schemeId: scheme.id,
      paused: 1,
      shareWebMemory: 0,
      memoryBatchSize: null,
      ownerIdentityRevision: null,
      revision: 1,
      authorityRevision: 1,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    })
    .run();
  return { business, orm, app: createApp({ business }), collection, asset, scheme };
}

describe("QQ sticker inventory read routes", () => {
  it("lists collections and assets without leaking the private copy name or bytes", async () => {
    const h = fixture();
    try {
      const collections = await h.app.request("/qq/sticker-collections");
      expect(collections.status).toBe(200);
      expect(await collections.json()).toEqual([
        {
          id: h.collection.id,
          name: "日常",
          description: null,
          revision: 1,
          asset_count: 1,
        },
      ]);
      const response = await h.app.request("/qq/stickers");
      expect(response.status).toBe(200);
      const raw = await response.text();
      expect(raw).not.toContain("file_name");
      expect(raw).not.toContain(`${ASSET}.png`);
      expect(JSON.parse(raw)).toEqual([
        expect.objectContaining({
          id: ASSET,
          name: "问好",
          enabled: false,
          media_type: "image",
          collection_ids: [h.collection.id],
          width: 8,
          height: 8,
        }),
      ]);
      const detail = await h.app.request(`/qq/stickers/${ASSET}`);
      expect(detail.status).toBe(200);
      expect(await detail.json()).toEqual(JSON.parse(raw)[0]);
    } finally {
      h.business.close();
    }
  });

  it("reports an impact including paused bindings, without changing enablement", async () => {
    const h = fixture();
    try {
      const response = await h.app.request(`/qq/stickers/${ASSET}/impact`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        asset_id: ASSET,
        collection_ids: [h.collection.id],
        schemes: [{ id: h.scheme.id, name: "聊天", collection_ids: [h.collection.id] }],
        bindings: [
          {
            scheme_id: h.scheme.id,
            account_id: "10001",
            conversation_kind: "group",
            peer_id: "20001",
            paused: true,
          },
        ],
      });
      const collectionImpact = await h.app.request(
        `/qq/sticker-collections/${h.collection.id}/impact`,
      );
      expect(collectionImpact.status).toBe(200);
      expect(await collectionImpact.json()).toEqual({
        collection_ids: [h.collection.id],
        schemes: [{ id: h.scheme.id, name: "聊天", collection_ids: [h.collection.id] }],
        bindings: [
          {
            scheme_id: h.scheme.id,
            account_id: "10001",
            conversation_kind: "group",
            peer_id: "20001",
            paused: true,
          },
        ],
      });
      expect(h.asset.enabled).toBe(false);
      expect((await (await h.app.request(`/qq/stickers/${ASSET}`)).json()).enabled).toBe(false);
    } finally {
      h.business.close();
    }
  });

  it("distinguishes malformed ids from missing assets, and leaves the undecided operations out", async () => {
    const h = fixture();
    try {
      expect((await h.app.request("/qq/stickers/not-an-id")).status).toBe(422);
      expect((await h.app.request(`/qq/stickers/${MISSING}`)).status).toBe(404);
      expect((await h.app.request(`/qq/stickers/${MISSING}/impact`)).status).toBe(404);
      expect((await h.app.request(`/qq/sticker-collections/${MISSING}/impact`)).status).toBe(404);
      expect((await h.app.request("/qq/sticker-collections/not-an-id/impact")).status).toBe(422);
      // Creation goes through `/stickers/import` (P5d); what has no route at all is §9.1's
      // undecided set (U11): deleting an asset or a collection, replacing a file.
      expect((await h.app.request("/qq/stickers", { method: "POST" })).status).toBe(404);
      expect((await h.app.request(`/qq/stickers/${ASSET}`, { method: "DELETE" })).status).toBe(404);
      expect(
        (await h.app.request(`/qq/sticker-collections/${h.collection.id}`, { method: "DELETE" }))
          .status,
      ).toBe(404);
    } finally {
      h.business.close();
    }
  });
});
