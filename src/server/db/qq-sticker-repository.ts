// Sticker library storage (ADR0018 P4e, §9.1/§9.2).
//
// Storage only: it reads and writes rows and maps them to the shapes the pure contracts already
// define (`resolveQqStickerLibrary`, `qqStickerUsable`). Which sticker a reply uses, whether a
// scheme authorizes a collection, and how often one may repeat are decided elsewhere.
//
// Three §9.1 rules are enforced here rather than at a call site:
//
//   * an import creates an asset that is DISABLED — so "save" and "make selectable" stay two
//     separate actions, and nothing becomes usable merely by being imported;
//   * a model-assisted description lands in `description_draft`, never in `description`, so an
//     unreviewed draft cannot be read as the user's own text;
//   * removing a membership removes only the membership. There is no asset delete, no file
//     replace and no collection delete, because §9.1 leaves those undecided and forbids adding
//     automatic deletion — see `QQ_STICKER_PENDING_GOVERNANCE` for the recorded gap.
//
// Tags are stored as a JSON array in one column and validated on the way in and out, so a
// hand-edited row cannot make the library read as tag-filtered when it is not.

import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { fail } from "../errors";
import { readQqScheme } from "./qq-scheme-repository";
import { newId, nowIso, type Orm } from "./repositories";
import * as schema from "./schema";

const NameSchema = z.string().trim().min(1).max(200);
const OptionalTextSchema = z.string().max(2000).nullable();
const TagsSchema = z.array(z.string().trim().min(1).max(40)).max(50);

export type QqStickerCollectionRow = typeof schema.qqStickerCollections.$inferSelect;
export type QqStickerAssetRow = typeof schema.qqStickerAssets.$inferSelect;
export type QqStickerItemRow = typeof schema.qqStickerCollectionItems.$inferSelect;

/**
 * §9.1's undecided material operations, recorded in one place.
 *
 * These are not "not yet implemented" placeholders for work in progress: the plan explicitly
 * declines to decide them, and a wrong guess here is destructive (a wrong delete loses a file the
 * user imported). Recording them as data lets a test assert that no such function exists yet.
 */
export const QQ_STICKER_PENDING_GOVERNANCE = Object.freeze({
  item: "U11",
  undecided: Object.freeze([
    "asset_deletion",
    "duplicate_import_handling",
    "file_replacement",
    "collection_deletion",
    "orphan_asset_handling",
  ] as const),
});

function parseTags(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  if (typeof value !== "string") throw new TypeError("Invalid QQ sticker tag input");
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new TypeError("Invalid QQ sticker tag input");
  }
  return Object.freeze([...TagsSchema.parse(parsed)]) as unknown as string[];
}

function serializeTags(tags: readonly string[]): string | null {
  const value = TagsSchema.parse([...tags]);
  return value.length === 0 ? null : JSON.stringify(value);
}

export interface QqStickerAssetView {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly descriptionDraft: string | null;
  readonly tags: readonly string[];
  /** §9.2: the model's tag suggestions, separate from the tags the user saved. */
  readonly tagsDraft: readonly string[];
  readonly usageNote: string | null;
  readonly fileName: string;
  readonly mediaType: "image" | "animation";
  readonly byteSize: number;
  readonly width: number | null;
  readonly height: number | null;
  readonly enabled: boolean;
  readonly collectionIds: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface QqStickerCollectionView {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly revision: number;
  readonly assetCount: number;
}

export interface ImportQqStickerInput {
  /** The in-app copy the store just wrote; the row only ever refers to it by name. */
  readonly copy: {
    readonly fileName: string;
    readonly byteSize: number;
    readonly mediaType: "image" | "animation";
  };
  /**
   * The asset id, when the caller already generated one.
   *
   * The copy's file name is derived from an id, so an importer that lets the repository invent a
   * second one would store a file whose name has nothing to do with the row that owns it. Passing
   * the id keeps the two the same thing.
   */
  readonly id?: string;
  readonly name?: string;
  readonly width?: number | null;
  readonly height?: number | null;
  readonly collectionIds?: readonly string[];
}

function assetView(row: QqStickerAssetRow, collectionIds: readonly string[]): QqStickerAssetView {
  return Object.freeze({
    id: row.id,
    name: row.name,
    description: row.description,
    descriptionDraft: row.descriptionDraft,
    tags: parseTags(row.tags),
    tagsDraft: parseTags(row.tagsDraft),
    usageNote: row.usageNote,
    fileName: row.fileName,
    mediaType: row.mediaType as "image" | "animation",
    byteSize: row.byteSize,
    width: row.width,
    height: row.height,
    enabled: row.enabled === 1,
    collectionIds: Object.freeze([...collectionIds]),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

function collectionsOf(orm: Orm, assetId: string): string[] {
  return orm
    .select({ collectionId: schema.qqStickerCollectionItems.collectionId })
    .from(schema.qqStickerCollectionItems)
    .where(eq(schema.qqStickerCollectionItems.assetId, assetId))
    .orderBy(asc(schema.qqStickerCollectionItems.collectionId))
    .all()
    .map((row) => row.collectionId);
}

export function readQqStickerAsset(orm: Orm, id: string): QqStickerAssetView | null {
  const row = orm
    .select()
    .from(schema.qqStickerAssets)
    .where(eq(schema.qqStickerAssets.id, id))
    .get();
  return row === undefined ? null : assetView(row, collectionsOf(orm, row.id));
}

export function readQqStickerAssetRow(orm: Orm, id: string): QqStickerAssetRow | null {
  return (
    orm.select().from(schema.qqStickerAssets).where(eq(schema.qqStickerAssets.id, id)).get() ?? null
  );
}

export function listQqStickerAssets(orm: Orm): QqStickerAssetView[] {
  return orm
    .select()
    .from(schema.qqStickerAssets)
    .orderBy(asc(schema.qqStickerAssets.name), asc(schema.qqStickerAssets.id))
    .all()
    .map((row) => assetView(row, collectionsOf(orm, row.id)));
}

export function readQqStickerCollection(orm: Orm, id: string): QqStickerCollectionView | null {
  const row = orm
    .select()
    .from(schema.qqStickerCollections)
    .where(eq(schema.qqStickerCollections.id, id))
    .get();
  if (row === undefined) return null;
  const assetCount = orm
    .select({ assetId: schema.qqStickerCollectionItems.assetId })
    .from(schema.qqStickerCollectionItems)
    .where(eq(schema.qqStickerCollectionItems.collectionId, id))
    .all().length;
  return Object.freeze({
    id: row.id,
    name: row.name,
    description: row.description,
    revision: row.revision,
    assetCount,
  });
}

export function listQqStickerCollections(orm: Orm): QqStickerCollectionView[] {
  return orm
    .select()
    .from(schema.qqStickerCollections)
    .orderBy(asc(schema.qqStickerCollections.name), asc(schema.qqStickerCollections.id))
    .all()
    .map((row) => {
      const assetCount = orm
        .select({ assetId: schema.qqStickerCollectionItems.assetId })
        .from(schema.qqStickerCollectionItems)
        .where(eq(schema.qqStickerCollectionItems.collectionId, row.id))
        .all().length;
      return Object.freeze({
        id: row.id,
        name: row.name,
        description: row.description,
        revision: row.revision,
        assetCount,
      });
    });
}

/** A duplicate name is a state conflict, not a raw constraint error: the user's fix is to rename. */
export function createQqStickerCollection(
  orm: Orm,
  input: { name: string; description?: string | null },
): QqStickerCollectionView {
  const name = NameSchema.parse(input.name);
  const description =
    input.description === undefined || input.description === null
      ? null
      : OptionalTextSchema.parse(input.description);
  const existing = orm
    .select({ id: schema.qqStickerCollections.id })
    .from(schema.qqStickerCollections)
    .where(eq(schema.qqStickerCollections.name, name))
    .get();
  if (existing !== undefined) fail("MEMORY_STATE_CONFLICT", "已存在同名集合，请换一个名称");
  const row = orm
    .insert(schema.qqStickerCollections)
    .values({
      id: newId(),
      name,
      description,
      revision: 1,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    })
    .returning()
    .get();
  if (!row) fail("DATABASE_UNAVAILABLE", "数据服务暂不可用，请检查数据库", 503);
  return Object.freeze({
    id: row.id,
    name: row.name,
    description: row.description,
    revision: row.revision,
    assetCount: 0,
  });
}

/** Rename or re-describe a collection under compare-and-swap, the same rule as every settings row. */
export function updateQqStickerCollection(
  orm: Orm,
  id: string,
  input: { name: string; description?: string | null; expectedRevision: number },
): QqStickerCollectionView {
  const current = orm
    .select()
    .from(schema.qqStickerCollections)
    .where(eq(schema.qqStickerCollections.id, id))
    .get();
  if (current === undefined) fail("MEMORY_NOT_FOUND", "集合不存在", 404);
  if (current.revision !== input.expectedRevision) {
    fail("MEMORY_STATE_CONFLICT", "集合已变化，请重新加载后保存");
  }
  const name = NameSchema.parse(input.name);
  const clash = orm
    .select({ id: schema.qqStickerCollections.id })
    .from(schema.qqStickerCollections)
    .where(eq(schema.qqStickerCollections.name, name))
    .get();
  if (clash !== undefined && clash.id !== id)
    fail("MEMORY_STATE_CONFLICT", "已存在同名集合，请换一个名称");
  const description =
    input.description === undefined
      ? current.description
      : OptionalTextSchema.parse(input.description);
  if (name === current.name && description === current.description)
    return readQqStickerCollection(orm, id) as QqStickerCollectionView;
  const row = orm
    .update(schema.qqStickerCollections)
    .set({ name, description, revision: current.revision + 1, updatedAt: nowIso() })
    .where(eq(schema.qqStickerCollections.id, id))
    .returning()
    .get();
  if (!row) fail("DATABASE_UNAVAILABLE", "数据服务暂不可用，请检查数据库", 503);
  return readQqStickerCollection(orm, id) as QqStickerCollectionView;
}

/**
 * Record an imported copy.
 *
 * `enabled` is left at the column default (0) on purpose: §9.1's next steps are the user
 * reviewing and then enabling. A caller that wanted it enabled would have to call
 * `setQqStickerEnabled` explicitly, which is the point.
 */
export function importQqSticker(orm: Orm, input: ImportQqStickerInput): QqStickerAssetView {
  const fileName = z.string().trim().min(1).max(120).parse(input.copy.fileName);
  if (input.copy.byteSize <= 0 || !Number.isSafeInteger(input.copy.byteSize)) {
    throw new TypeError("Invalid QQ sticker import input");
  }
  const name = NameSchema.parse(input.name ?? fileName);
  const width = input.width ?? null;
  const height = input.height ?? null;
  // Both or neither: a half-read header must not reach the table (the CHECK says the same).
  if ((width === null) !== (height === null))
    throw new TypeError("Invalid QQ sticker import input");
  const id = input.id === undefined ? newId() : z.string().trim().min(1).max(120).parse(input.id);
  // One transaction for the row and its memberships: the importer writes the copy BEFORE this
  // call, so a failure part-way through would otherwise leave a row whose file the caller has
  // already discarded, or an asset that silently belongs to fewer collections than it was
  // imported into. Either way the caller then only has to undo the copy.
  return orm.transaction((tx) => {
    const row = tx
      .insert(schema.qqStickerAssets)
      .values({
        id,
        name,
        description: null,
        descriptionDraft: null,
        tags: null,
        tagsDraft: null,
        usageNote: null,
        fileName,
        mediaType: input.copy.mediaType,
        byteSize: input.copy.byteSize,
        width,
        height,
        enabled: 0,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      })
      .returning()
      .get();
    if (!row) fail("DATABASE_UNAVAILABLE", "数据服务暂不可用，请检查数据库", 503);
    if (input.collectionIds !== undefined) addQqStickerToCollections(tx, id, input.collectionIds);
    return readQqStickerAsset(tx, id) as QqStickerAssetView;
  });
}

/** Fields §9.2 lets the user edit. `description` is the reviewed text, never the draft. */
export interface QqStickerAssetEdit {
  readonly name?: string;
  readonly description?: string | null;
  readonly tags?: readonly string[];
  readonly usageNote?: string | null;
}

export function editQqSticker(orm: Orm, id: string, input: QqStickerAssetEdit): QqStickerAssetView {
  const current = readQqStickerAssetRow(orm, id);
  if (current === null) fail("MEMORY_NOT_FOUND", "素材不存在", 404);
  const name = input.name === undefined ? current.name : NameSchema.parse(input.name);
  const description =
    input.description === undefined
      ? current.description
      : OptionalTextSchema.parse(input.description);
  const tags = input.tags === undefined ? current.tags : serializeTags(input.tags);
  const usageNote =
    input.usageNote === undefined ? current.usageNote : OptionalTextSchema.parse(input.usageNote);
  if (
    name === current.name &&
    description === current.description &&
    tags === current.tags &&
    usageNote === current.usageNote
  ) {
    return readQqStickerAsset(orm, id) as QqStickerAssetView;
  }
  orm
    .update(schema.qqStickerAssets)
    .set({ name, description, tags, usageNote, updatedAt: nowIso() })
    .where(eq(schema.qqStickerAssets.id, id))
    .run();
  return readQqStickerAsset(orm, id) as QqStickerAssetView;
}

/**
 * Store a model-assisted draft (§9.2).
 *
 * It writes `description_draft` and leaves `description` alone, so the model can help without its
 * text becoming the shop window. There is no function that promotes a draft to a description:
 * that transition is the user's save, which goes through `editQqSticker`.
 */
export function saveQqStickerDraft(orm: Orm, id: string, draft: string): QqStickerAssetView {
  const current = readQqStickerAssetRow(orm, id);
  if (current === null) fail("MEMORY_NOT_FOUND", "素材不存在", 404);
  const value = z.string().trim().min(1).max(2000).parse(draft);
  orm
    .update(schema.qqStickerAssets)
    .set({ descriptionDraft: value, updatedAt: nowIso() })
    .where(eq(schema.qqStickerAssets.id, id))
    .run();
  return readQqStickerAsset(orm, id) as QqStickerAssetView;
}

/**
 * Store the model's tag suggestions (§9.2), beside the description draft.
 *
 * Same rule as `saveQqStickerDraft`: this writes the DRAFT column and leaves `tags` alone, so an
 * unreviewed suggestion cannot read as something the user chose. There is likewise no function
 * that promotes a draft to tags — that transition is the user's save, through `editQqSticker`.
 */
export function saveQqStickerTagsDraft(
  orm: Orm,
  id: string,
  tags: readonly string[],
): QqStickerAssetView {
  const current = readQqStickerAssetRow(orm, id);
  if (current === null) fail("MEMORY_NOT_FOUND", "素材不存在", 404);
  orm
    .update(schema.qqStickerAssets)
    .set({ tagsDraft: serializeTags(tags), updatedAt: nowIso() })
    .where(eq(schema.qqStickerAssets.id, id))
    .run();
  return readQqStickerAsset(orm, id) as QqStickerAssetView;
}

/** §9.1: enabling is what makes an asset selectable; the store can also take it away again. */
export function setQqStickerEnabled(orm: Orm, id: string, enabled: boolean): QqStickerAssetView {
  const current = readQqStickerAssetRow(orm, id);
  if (current === null) fail("MEMORY_NOT_FOUND", "素材不存在", 404);
  const next = enabled ? 1 : 0;
  if (current.enabled !== next) {
    orm
      .update(schema.qqStickerAssets)
      .set({ enabled: next, updatedAt: nowIso() })
      .where(eq(schema.qqStickerAssets.id, id))
      .run();
  }
  return readQqStickerAsset(orm, id) as QqStickerAssetView;
}

export function addQqStickerToCollections(
  orm: Orm,
  assetId: string,
  collectionIds: readonly string[],
): void {
  if (readQqStickerAssetRow(orm, assetId) === null) fail("MEMORY_NOT_FOUND", "素材不存在", 404);
  for (const collectionId of collectionIds) {
    if (readQqStickerCollection(orm, collectionId) === null) {
      fail("MEMORY_NOT_FOUND", "集合不存在", 404);
    }
    // Re-adding is a no-op rather than an error: the membership is a set, and a management
    // surface that re-applies a selection must not fail for being redundant.
    const existing = orm
      .select({ assetId: schema.qqStickerCollectionItems.assetId })
      .from(schema.qqStickerCollectionItems)
      .where(
        and(
          eq(schema.qqStickerCollectionItems.collectionId, collectionId),
          eq(schema.qqStickerCollectionItems.assetId, assetId),
        ),
      )
      .get();
    if (existing !== undefined) continue;
    orm
      .insert(schema.qqStickerCollectionItems)
      .values({ collectionId, assetId, addedAt: nowIso() })
      .run();
  }
}

/**
 * §9.1: "移出集合"只移除该归类 — the asset, its file and its description are untouched, and other
 * collections keep authorizing it.
 */
export function removeQqStickerFromCollection(
  orm: Orm,
  assetId: string,
  collectionId: string,
): void {
  orm
    .delete(schema.qqStickerCollectionItems)
    .where(
      and(
        eq(schema.qqStickerCollectionItems.collectionId, collectionId),
        eq(schema.qqStickerCollectionItems.assetId, assetId),
      ),
    )
    .run();
}

/**
 * §9.2's "所属集合" as the editor saves it: the whole set, not a delta.
 *
 * The set difference is what keeps §9.1's promise intact — a save that removes a membership
 * removes ONLY that membership, and the asset, its copy and its description are untouched. Every
 * requested collection is checked BEFORE anything is removed: a 404 half-way through would
 * otherwise leave the asset in fewer collections than the caller asked for.
 *
 * Nothing here reorders the caller's meaning: the result is the set, so saving the same selection
 * again is a no-op, and reordering it is not a change either (assets carry no revision, so there
 * is nothing to bump for a reorder anyway).
 */
export function replaceQqStickerCollections(
  orm: Orm,
  assetId: string,
  collectionIds: readonly string[],
): QqStickerAssetView {
  if (readQqStickerAssetRow(orm, assetId) === null) fail("MEMORY_NOT_FOUND", "素材不存在", 404);
  const wanted = [...new Set(collectionIds)];
  for (const collectionId of wanted) {
    if (readQqStickerCollection(orm, collectionId) === null) {
      fail("MEMORY_NOT_FOUND", "集合不存在", 404);
    }
  }
  const current = new Set((readQqStickerAsset(orm, assetId) as QqStickerAssetView).collectionIds);
  const wantedSet = new Set(wanted);
  const removals = [...current].filter((collectionId) => !wantedSet.has(collectionId));
  const additions = wanted.filter((collectionId) => !current.has(collectionId));
  orm.transaction((tx) => {
    for (const collectionId of removals) removeQqStickerFromCollection(tx, assetId, collectionId);
    if (additions.length > 0) addQqStickerToCollections(tx, assetId, additions);
  });
  return readQqStickerAsset(orm, assetId) as QqStickerAssetView;
}

export interface QqStickerBulkUpdate {
  readonly assetIds: readonly string[];
  readonly addCollectionIds?: readonly string[];
  readonly removeCollectionIds?: readonly string[];
  readonly tags?: { readonly add?: readonly string[]; readonly remove?: readonly string[] };
  readonly enabled?: boolean;
}

/**
 * §9.2's batch operations (归类、标签整理与启用), under the user's 2026-09-24 decision: VALIDATE first.
 *
 * Every selected asset and every named collection is checked before the first write, and the
 * writes then run in one transaction. A batch that half-applied would leave the user comparing two
 * lists to find out what happened — and the missing entry is named in the refusal so the fix is
 * obvious. Tags merge by value (add/remove) instead of being replaced: replacing across a
 * selection would overwrite each asset's own tags, which is a different operation than 整理.
 */
export function bulkUpdateQqStickers(orm: Orm, input: QqStickerBulkUpdate): QqStickerAssetView[] {
  const assetIds = [...new Set(input.assetIds)];
  for (const assetId of assetIds) {
    if (readQqStickerAssetRow(orm, assetId) === null) {
      fail("MEMORY_NOT_FOUND", `素材不存在：${assetId}`, 404);
    }
  }
  const additions = [...new Set(input.addCollectionIds ?? [])];
  const removals = [...new Set(input.removeCollectionIds ?? [])];
  for (const collectionId of [...additions, ...removals]) {
    if (readQqStickerCollection(orm, collectionId) === null) {
      fail("MEMORY_NOT_FOUND", `集合不存在：${collectionId}`, 404);
    }
  }
  const tagAdd = TagsSchema.parse([...(input.tags?.add ?? [])]);
  const tagRemove = new Set(TagsSchema.parse([...(input.tags?.remove ?? [])]));
  orm.transaction((tx) => {
    for (const assetId of assetIds) {
      if (additions.length > 0) addQqStickerToCollections(tx, assetId, additions);
      for (const collectionId of removals) removeQqStickerFromCollection(tx, assetId, collectionId);
      if (input.tags !== undefined) {
        const current = readQqStickerAsset(tx, assetId) as QqStickerAssetView;
        editQqSticker(tx, assetId, {
          tags: [
            ...current.tags.filter((tag) => !tagRemove.has(tag)),
            ...tagAdd.filter((tag) => !current.tags.includes(tag)),
          ],
        });
      }
      if (input.enabled !== undefined) setQqStickerEnabled(tx, assetId, input.enabled);
    }
  });
  return assetIds.map((assetId) => readQqStickerAsset(orm, assetId) as QqStickerAssetView);
}

export interface QqStickerLibrarySnapshot {
  readonly assets: readonly {
    readonly id: string;
    readonly enabled: boolean;
    readonly available: boolean;
    readonly collectionIds: readonly string[];
  }[];
}

/**
 * The library as `resolveQqStickerLibrary` needs it: per asset, whether it is enabled and which
 * collections hold it. `available` is the caller's answer (it owns the copy store), so this stays
 * free of the filesystem and testable without one.
 */
export function qqStickerLibrarySnapshot(
  orm: Orm,
  isAvailable: (asset: QqStickerAssetView) => boolean,
): QqStickerLibrarySnapshot {
  const assets = listQqStickerAssets(orm).map((asset) =>
    Object.freeze({
      id: asset.id,
      enabled: asset.enabled,
      available: isAvailable(asset),
      collectionIds: asset.collectionIds,
    }),
  );
  return Object.freeze({ assets: Object.freeze(assets) });
}

/**
 * What authorizing a set of collections would reach (P4g, §9.1).
 *
 * §9.1 requires the surface to show "影响的方案和群" before it enables anything, and §9.2 wants the
 * same answer when an asset is saved-and-enabled. The answer is a walk, not a guess: a collection is
 * what a scheme authorizes, so the affected schemes are the ones naming any of these collections, and
 * the affected conversations are the ones bound to those schemes.
 *
 * Read-only. It reports what WOULD be affected; nothing here enables, sends or writes.
 */
export interface QqStickerCollectionImpact {
  /** The input set, normalized so two callers cannot get different answers for one authorization. */
  readonly collectionIds: readonly string[];
  readonly schemes: readonly {
    readonly id: string;
    readonly name: string;
    /** Which of the given collections this scheme authorizes. */
    readonly collectionIds: readonly string[];
  }[];
  readonly bindings: readonly {
    readonly schemeId: string;
    readonly accountId: string;
    readonly conversationKind: "group" | "private";
    readonly peerId: string;
    /** A paused conversation is still affected — it is paused, not unbound. */
    readonly paused: boolean;
  }[];
}

export function qqStickerCollectionImpact(
  orm: Orm,
  collectionIds: readonly string[],
): QqStickerCollectionImpact {
  const wanted = Object.freeze([...new Set(collectionIds)].sort());
  if (wanted.length === 0) {
    return Object.freeze({
      collectionIds: wanted,
      schemes: Object.freeze([]),
      bindings: Object.freeze([]),
    });
  }
  const rows = orm
    .select({
      schemeId: schema.qqSchemeStickerCollections.schemeId,
      collectionId: schema.qqSchemeStickerCollections.collectionId,
    })
    .from(schema.qqSchemeStickerCollections)
    .where(inArray(schema.qqSchemeStickerCollections.collectionId, [...wanted]))
    .orderBy(asc(schema.qqSchemeStickerCollections.schemeId))
    .all();
  const byScheme = new Map<string, string[]>();
  for (const row of rows) {
    const list = byScheme.get(row.schemeId) ?? [];
    list.push(row.collectionId);
    byScheme.set(row.schemeId, list);
  }
  const schemes = [...byScheme.entries()].map(([id, ids]) =>
    Object.freeze({
      id,
      // A scheme that vanished between the two reads would be a data error, not a normal state;
      // the authorization table is only ever written with a scheme that exists.
      name: readQqScheme(orm, id)?.name ?? id,
      collectionIds: Object.freeze(ids.slice().sort()),
    }),
  );
  const schemeIds = schemes.map((scheme) => scheme.id);
  const bindings =
    schemeIds.length === 0
      ? []
      : orm
          .select({
            schemeId: schema.qqBindings.schemeId,
            accountId: schema.qqBindings.accountId,
            conversationKind: schema.qqBindings.conversationKind,
            peerId: schema.qqBindings.peerId,
            paused: schema.qqBindings.paused,
          })
          .from(schema.qqBindings)
          .where(inArray(schema.qqBindings.schemeId, schemeIds))
          .orderBy(asc(schema.qqBindings.accountId), asc(schema.qqBindings.peerId))
          .all()
          .map((row) =>
            Object.freeze({
              schemeId: row.schemeId,
              accountId: row.accountId,
              conversationKind: row.conversationKind as "group" | "private",
              peerId: row.peerId,
              paused: row.paused === 1,
            }),
          );
  return Object.freeze({
    collectionIds: wanted,
    schemes: Object.freeze(schemes),
    bindings: Object.freeze(bindings),
  });
}

/** §9.2's "保存并启用：展示影响范围", asked the way the surface asks it — from the asset. */
export function qqStickerAssetImpact(
  orm: Orm,
  assetId: string,
): (QqStickerCollectionImpact & { readonly assetId: string }) | null {
  const asset = readQqStickerAsset(orm, assetId);
  if (asset === null) return null;
  return Object.freeze({ assetId, ...qqStickerCollectionImpact(orm, asset.collectionIds) });
}
