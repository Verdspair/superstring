// P4g: which collections a scheme authorizes (ADR0018, §9.1).
//
// §9.1 makes the collection the unit of authorization — "方案授权其中任一集合即可候选" — but until
// this round nothing stored that relation, so `resolveQqStickerLibrary` took the authorized ids as a
// caller input that no code in the project could produce. These tests are about closing that loop:
// the authorization has to be storable, readable, and actually decide whether a sticker is a
// candidate — and it has to stay a SET, because §9.1 forbids multi-membership from becoming extra
// weight in the draw.
//
// The impact walk is here too: §9.1 requires the surface to show "影响的方案和群" before it enables
// anything, and an answer of "which schemes and conversations" can only come from this relation.

import { describe, expect, it } from "bun:test";
import {
  createQqScheme,
  readQqScheme,
  schemeStickerCollectionIds,
  updateQqScheme,
} from "../../src/server/db/qq-scheme-repository";
import {
  createQqStickerCollection,
  importQqSticker,
  qqStickerAssetImpact,
  qqStickerCollectionImpact,
  qqStickerLibrarySnapshot,
  removeQqStickerFromCollection,
  setQqStickerEnabled,
} from "../../src/server/db/qq-sticker-repository";
import { ensureDefaults, type Orm } from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import {
  parseQqSchemeStickerCollections,
  resolveQqStickerLibrary,
} from "../../src/server/services/qq-sticker-contract";

const MODEL = "qwen/qwen3-4b-2507";
const AGENT_ID = "00000000-0000-0000-0000-000000000001";

function tracked() {
  const business = openBusinessDb();
  ensureDefaults(business.orm, MODEL);
  return { business, orm: business.orm, db: business.db };
}

/** A one-shot asset row: the copy's existence is not what these tests are about. */
function asset(orm: Orm, collectionIds: readonly string[]) {
  const id = crypto.randomUUID();
  return importQqSticker(orm, {
    id,
    copy: { fileName: `${id}.png`, byteSize: 128, mediaType: "image" },
    name: "素材.png",
    width: 64,
    height: 64,
    collectionIds,
  });
}

function binding(orm: Orm, schemeId: string, peerId: string) {
  orm
    .insert(schema.qqBindings)
    .values({
      id: crypto.randomUUID(),
      accountId: "10001",
      conversationKind: "group",
      peerId,
      agentId: AGENT_ID,
      schemeId,
      paused: peerId === "20009" ? 1 : 0,
      shareWebMemory: 0,
      memoryBatchSize: null,
      ownerIdentityRevision: null,
      revision: 1,
      authorityRevision: 1,
      createdAt: "2026-01-01T00:00:00.000000Z",
      updatedAt: "2026-01-01T00:00:00.000000Z",
    })
    .run();
}

describe("a scheme's authorized collections are a set", () => {
  it("starts empty, and stores what it is given", () => {
    const h = tracked();
    try {
      const scheme = createQqScheme(h.orm, { name: "安静方案" });
      // §9.1: nothing is authorized until the user says so. A new scheme must not inherit a
      // collection it never chose.
      expect(schemeStickerCollectionIds(h.orm, scheme.id)).toEqual([]);
      const first = createQqStickerCollection(h.orm, { name: "常用" });
      const second = createQqStickerCollection(h.orm, { name: "节日" });
      const updated = updateQqScheme(h.orm, scheme.id, {
        name: scheme.name,
        stickerCollections: [second.id, first.id],
        expectedRevision: scheme.revision,
      });
      // Sorted on the way in: the order a UI sends a checked list in is not a fact.
      expect(schemeStickerCollectionIds(h.orm, updated.id)).toEqual([first.id, second.id].sort());
    } finally {
      h.business.close();
    }
  });

  it("collapses duplicates and treats a reordered save as no change", () => {
    const h = tracked();
    try {
      const first = createQqStickerCollection(h.orm, { name: "A" });
      const second = createQqStickerCollection(h.orm, { name: "B" });
      const scheme = createQqScheme(h.orm, {
        name: "去重方案",
        stickerCollections: [first.id, first.id, second.id],
      });
      expect(schemeStickerCollectionIds(h.orm, scheme.id)).toEqual([first.id, second.id].sort());
      // Re-sending the same set in another order must not look like an edit: §9.1 treats the
      // authorization as scheme configuration, and a false change would bump the revision that
      // bindings rely on to notice real edits.
      const again = updateQqScheme(h.orm, scheme.id, {
        name: scheme.name,
        stickerCollections: [second.id, first.id],
        expectedRevision: scheme.revision,
      });
      expect(again.revision).toBe(scheme.revision);
    } finally {
      h.business.close();
    }
  });

  it("bumps the revision when the set really changes, and can empty it again", () => {
    const h = tracked();
    try {
      const collection = createQqStickerCollection(h.orm, { name: "常用" });
      const scheme = createQqScheme(h.orm, { name: "换授权" });
      const added = updateQqScheme(h.orm, scheme.id, {
        name: scheme.name,
        stickerCollections: [collection.id],
        expectedRevision: scheme.revision,
      });
      expect(added.revision).toBe(scheme.revision + 1);
      const cleared = updateQqScheme(h.orm, scheme.id, {
        name: scheme.name,
        stickerCollections: [],
        expectedRevision: added.revision,
      });
      expect(cleared.revision).toBe(added.revision + 1);
      // Emptying is a real state, not a failure to write: it means "this scheme uses no stickers".
      expect(schemeStickerCollectionIds(h.orm, cleared.id)).toEqual([]);
    } finally {
      h.business.close();
    }
  });

  it("refuses a collection that does not exist, and writes nothing", () => {
    const h = tracked();
    try {
      const scheme = createQqScheme(h.orm, { name: "坏引用" });
      expect(() =>
        updateQqScheme(h.orm, scheme.id, {
          name: scheme.name,
          stickerCollections: [crypto.randomUUID()],
          expectedRevision: scheme.revision,
        }),
      ).toThrow();
      // The refusal must not leave half a change behind: the revision and the set are untouched.
      expect(schemeStickerCollectionIds(h.orm, scheme.id)).toEqual([]);
      expect(readQqScheme(h.orm, scheme.id)?.revision).toBe(scheme.revision);
    } finally {
      h.business.close();
    }
  });

  it("refuses the same pair twice even when it is written by hand", () => {
    const h = tracked();
    try {
      const collection = createQqStickerCollection(h.orm, { name: "常用" });
      const scheme = createQqScheme(h.orm, {
        name: "主键方案",
        stickerCollections: [collection.id],
      });
      // The repository never writes the pair twice, so the constraint is only visible when the
      // table is written around it — which is exactly why the test writes it by hand.
      expect(() =>
        h.db.run(
          `INSERT INTO qq_scheme_sticker_collections (scheme_id, collection_id, added_at) VALUES ('${scheme.id}', '${collection.id}', 'now')`,
        ),
      ).toThrow();
    } finally {
      h.business.close();
    }
  });

  it("drops only that one authorization when it is removed", () => {
    const h = tracked();
    try {
      const keep = createQqStickerCollection(h.orm, { name: "保留" });
      const drop = createQqStickerCollection(h.orm, { name: "移除" });
      const scheme = createQqScheme(h.orm, {
        name: "两集合",
        stickerCollections: [keep.id, drop.id],
      });
      const updated = updateQqScheme(h.orm, scheme.id, {
        name: scheme.name,
        stickerCollections: [keep.id],
        expectedRevision: scheme.revision,
      });
      expect(schemeStickerCollectionIds(h.orm, updated.id)).toEqual([keep.id]);
      // The collection itself, and anything filed under it, is untouched: this is "stop using
      // this collection", not "delete it".
      expect(
        h.orm
          .select({ id: schema.qqStickerCollections.id })
          .from(schema.qqStickerCollections)
          .all()
          .map((row) => row.id)
          .sort(),
      ).toEqual([keep.id, drop.id].sort());
    } finally {
      h.business.close();
    }
  });
});

describe("the authorization is what makes a sticker a candidate", () => {
  it("counts an asset once even when two authorized collections both hold it", () => {
    const h = tracked();
    try {
      const first = createQqStickerCollection(h.orm, { name: "A" });
      const second = createQqStickerCollection(h.orm, { name: "B" });
      const scheme = createQqScheme(h.orm, {
        name: "多集合",
        stickerCollections: [first.id, second.id],
      });
      const shared = asset(h.orm, [first.id, second.id]);
      setQqStickerEnabled(h.orm, shared.id, true);

      const view = resolveQqStickerLibrary({
        assets: qqStickerLibrarySnapshot(h.orm, () => true).assets,
        authorizedCollectionIds: schemeStickerCollectionIds(h.orm, scheme.id),
      });
      // §9.1 forbids multi-membership from becoming extra weight in the draw.
      expect(view.candidates).toEqual([
        { assetId: shared.id, viaCollectionIds: [first.id, second.id].sort() },
      ]);
    } finally {
      h.business.close();
    }
  });

  it("stops offering an asset once its only authorized collection is removed", () => {
    const h = tracked();
    try {
      const collection = createQqStickerCollection(h.orm, { name: "常用" });
      const scheme = createQqScheme(h.orm, {
        name: "撤销授权",
        stickerCollections: [collection.id],
      });
      const sticker = asset(h.orm, [collection.id]);
      setQqStickerEnabled(h.orm, sticker.id, true);
      const candidates = (schemeId: string) =>
        resolveQqStickerLibrary({
          assets: qqStickerLibrarySnapshot(h.orm, () => true).assets,
          authorizedCollectionIds: schemeStickerCollectionIds(h.orm, schemeId),
        });

      expect(candidates(scheme.id).candidates.map((entry) => entry.assetId)).toEqual([sticker.id]);
      // §9.1: authorization follows the COLLECTION, so removing the membership is enough — the
      // asset stays in the library, enabled and whole.
      removeQqStickerFromCollection(h.orm, sticker.id, collection.id);
      const after = candidates(scheme.id);
      expect(after.candidates).toEqual([]);
      expect(after.rejected).toEqual([{ assetId: sticker.id, reason: "no_authorized_collection" }]);
    } finally {
      h.business.close();
    }
  });
});

describe("the impact walk answers 'which schemes and conversations'", () => {
  it("reports the schemes authorizing any of the collections, and their bound conversations", () => {
    const h = tracked();
    try {
      const collection = createQqStickerCollection(h.orm, { name: "常用" });
      const untouched = createQqStickerCollection(h.orm, { name: "无关" });
      const affected = createQqScheme(h.orm, {
        name: "会用到",
        stickerCollections: [collection.id],
      });
      createQqScheme(h.orm, { name: "用别的", stickerCollections: [untouched.id] });
      binding(h.orm, affected.id, "20001");
      // A paused conversation is still reached by the authorization: it is paused, not unbound.
      binding(h.orm, affected.id, "20009");

      const sticker = asset(h.orm, [collection.id]);
      const impact = qqStickerAssetImpact(h.orm, sticker.id);
      expect(impact?.assetId).toBe(sticker.id);
      expect(impact?.collectionIds).toEqual([collection.id]);
      expect(impact?.schemes).toEqual([
        { id: affected.id, name: "会用到", collectionIds: [collection.id] },
      ]);
      expect(impact?.bindings.map((entry) => [entry.peerId, entry.paused])).toEqual([
        ["20001", false],
        ["20009", true],
      ]);
    } finally {
      h.business.close();
    }
  });

  it("reports nothing for a collection no scheme authorizes, and nothing for an unknown asset", () => {
    const h = tracked();
    try {
      const orphan = createQqStickerCollection(h.orm, { name: "没人用" });
      expect(qqStickerCollectionImpact(h.orm, [orphan.id])).toEqual({
        collectionIds: [orphan.id],
        schemes: [],
        bindings: [],
      });
      expect(qqStickerCollectionImpact(h.orm, [])).toEqual({
        collectionIds: [],
        schemes: [],
        bindings: [],
      });
      expect(qqStickerAssetImpact(h.orm, crypto.randomUUID())).toBeNull();
    } finally {
      h.business.close();
    }
  });

  it("is read-only: asking what an asset would affect changes nothing", () => {
    const h = tracked();
    try {
      const collection = createQqStickerCollection(h.orm, { name: "常用" });
      const scheme = createQqScheme(h.orm, {
        name: "只读",
        stickerCollections: [collection.id],
      });
      const sticker = asset(h.orm, [collection.id]);
      const before = {
        assets: h.orm.select().from(schema.qqStickerAssets).all().length,
        authorized: schemeStickerCollectionIds(h.orm, scheme.id),
        revision: readQqScheme(h.orm, scheme.id)?.revision,
        enabled: h.orm
          .select({ enabled: schema.qqStickerAssets.enabled })
          .from(schema.qqStickerAssets)
          .all()
          .map((row) => row.enabled),
      };
      qqStickerAssetImpact(h.orm, sticker.id);
      expect({
        assets: h.orm.select().from(schema.qqStickerAssets).all().length,
        authorized: schemeStickerCollectionIds(h.orm, scheme.id),
        revision: readQqScheme(h.orm, scheme.id)?.revision,
        enabled: h.orm
          .select({ enabled: schema.qqStickerAssets.enabled })
          .from(schema.qqStickerAssets)
          .all()
          .map((row) => row.enabled),
      }).toEqual(before);
      // And the import it was given really is disabled: the impact answer is not a promise to
      // enable anything (§9.1 keeps 用户启用 as the user's act).
      expect(
        h.orm
          .select({ enabled: schema.qqStickerAssets.enabled })
          .from(schema.qqStickerAssets)
          .get(),
      ).toEqual({
        enabled: 0,
      });
    } finally {
      h.business.close();
    }
  });
});

describe("the pure parser behind the storage", () => {
  it("rejects ids that are not uuids and sets larger than the guard", () => {
    expect(() => parseQqSchemeStickerCollections({ collection_ids: ["not-a-uuid"] })).toThrow(
      TypeError,
    );
    expect(() =>
      parseQqSchemeStickerCollections({
        collection_ids: Array.from({ length: 51 }, () => crypto.randomUUID()),
      }),
    ).toThrow(TypeError);
    const one = crypto.randomUUID();
    expect(parseQqSchemeStickerCollections({ collection_ids: [one, one] })).toEqual([one]);
  });
});
