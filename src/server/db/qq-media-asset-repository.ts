// Scoped image asset cache (T08; spec §8.2/§12/§13.6, migration 0052).
//
// Three stores, three jobs, kept apart:
//   * `qq_media_assets`      — the bytes themselves, deduped per SCOPE + content
//                              sha (the same picture in another group or under
//                              another agent is a different row; sha is never
//                              authority);
//   * `qq_media_asset_sources` — which message media row brought those bytes,
//                              one link per source with its own expiry, so a
//                              cache hit can only be used while at least one
//                              live source still backs it;
//   * `qq_media_variants`    — prepared copies per policy/shape;
//   * `qq_media_classifications` — category per policy with its evidence origin.
//
// Nothing here fetches or decodes: callers hand in bytes they already fetched
// through the authorized OneBot resolver, and hand prepared copies out again
// through run-scoped resolvers. This module only remembers.
//
// Expiry discipline (来源独立 expiry, spec §8.2): every source carries its own
// window. A write NEVER extends an existing window — the stored cap moves only
// earlier, never later, and a cache entry cannot outlive the sources that
// justify it. A cache read returns the earliest live-source cap for THIS
// consumption, not a global window: the same sha in another message (or scope)
// never borrows another source's authorization.

import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { and, eq, gt, lte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { fail } from "../errors";
import { mediaNoteProtected } from "./qq-media-repository";
import { revokeMediaReadTaskResultsForSources } from "./qq-media-task-repository";
import { immediate, nowIso, type Orm } from "./repositories";
import * as schema from "./schema";

/** The underlying bun:sqlite handle, needed for the refill's immediate transaction. */
function clientOf(orm: Orm): Database {
  return (orm as unknown as { $client: Database }).$client;
}

/** The scope an asset lives in: dedup identity + authority boundary in one. */
export interface QqMediaAssetScope {
  readonly accountId: string;
  readonly conversationKind: "group" | "private";
  readonly peerId: string;
  readonly agentId: string;
}

export type QqMediaAssetRow = typeof schema.qqMediaAssets.$inferSelect;
export type QqMediaAssetSourceRow = typeof schema.qqMediaAssetSources.$inferSelect;
export type QqMediaVariantRow = typeof schema.qqMediaVariants.$inferSelect;
export type QqMediaClassificationRow = typeof schema.qqMediaClassifications.$inferSelect;

/** The event-scoped identity one media row's authority is checked against. */
export interface QqMediaSourceIdentity {
  readonly accountId: string;
  readonly conversationKind: "group" | "private";
  readonly peerId: string;
  readonly agentId: string;
}

function requireScope(scope: QqMediaAssetScope): void {
  if (
    scope.accountId.trim().length === 0 ||
    scope.peerId.trim().length === 0 ||
    scope.agentId.trim().length === 0 ||
    (scope.conversationKind !== "group" && scope.conversationKind !== "private")
  ) {
    throw new TypeError("Invalid QQ media asset scope");
  }
}

function requireExpiry(expiresAt: string, at: string): void {
  if (Date.parse(expiresAt) <= Date.parse(at)) {
    fail("MEMORY_SOURCE_INVALID", "媒体来源已过期，不能写入或读取缓存");
  }
}

function earlier(a: string, b: string): string {
  return Date.parse(a) <= Date.parse(b) ? a : b;
}

/** The media note row joined to its carrying event, for scope checks. */
interface MediaNoteWithEvent {
  noteId: string;
  accountId: string;
  conversationKind: string;
  peerId: string;
  agentId: string;
  mediaExpiresAt: string;
}

function mediaNoteIdentity(orm: Orm, mediaNoteId: string): MediaNoteWithEvent | null {
  const row = orm
    .select({
      noteId: schema.qqMediaNotes.id,
      accountId: schema.qqEvents.accountId,
      conversationKind: schema.qqEvents.conversationKind,
      peerId: schema.qqEvents.peerId,
      agentId: schema.qqEvents.agentId,
      mediaExpiresAt: schema.qqMediaNotes.expiresAt,
    })
    .from(schema.qqMediaNotes)
    .innerJoin(schema.qqEvents, eq(schema.qqEvents.eventKey, schema.qqMediaNotes.eventKey))
    .where(eq(schema.qqMediaNotes.id, mediaNoteId))
    .get();
  return row ?? null;
}

function sameScope(identity: MediaNoteWithEvent, scope: QqMediaSourceIdentity): boolean {
  return (
    identity.accountId === scope.accountId &&
    identity.conversationKind === scope.conversationKind &&
    identity.peerId === scope.peerId &&
    identity.agentId === scope.agentId
  );
}

/**
 * Remember the bytes of one picture inside one scope. The dedup identity is
 * (scope, content sha): the same file arriving under a second message reuses
 * the row. A live row's stored cap only ever moves earlier: a later source
 * window cannot stretch an earlier source's authorization (写不延长). An
 * EXPIRED row does not block the same sha forever (F1 裁决 2026-10): a new
 * write with a currently-valid window re-fills the row in a new cache epoch
 * (`refreshExpiredAssetRow`) — the old bytes/derivatives are not revived, the
 * caller proved the content with a fresh fetch.
 */
export function recordMediaAsset(
  orm: Orm,
  input: {
    scope: QqMediaAssetScope;
    bytes: Uint8Array;
    mimeType: string;
    /** The source window justifying this write; the asset never outlives it. */
    expiresAt: string;
    at?: string;
    width?: number;
    height?: number;
  },
): { readonly asset: QqMediaAssetRow; readonly created: boolean } {
  requireScope(input.scope);
  if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength === 0) {
    throw new TypeError("Invalid QQ media asset bytes");
  }
  const mimeType = input.mimeType.trim();
  if (mimeType.length === 0) throw new TypeError("Invalid QQ media asset input");
  const at = input.at ?? nowIso();
  requireExpiry(input.expiresAt, at);
  const contentSha256 = createHash("sha256").update(input.bytes).digest("hex");
  const existing = orm
    .select()
    .from(schema.qqMediaAssets)
    .where(
      and(
        eq(schema.qqMediaAssets.accountId, input.scope.accountId),
        eq(schema.qqMediaAssets.conversationKind, input.scope.conversationKind),
        eq(schema.qqMediaAssets.peerId, input.scope.peerId),
        eq(schema.qqMediaAssets.agentId, input.scope.agentId),
        eq(schema.qqMediaAssets.contentSha256, contentSha256),
      ),
    )
    .get();
  if (existing) {
    if (Date.parse(existing.expiresAt) <= Date.parse(at)) {
      // F1: a fresh fetch with a live window refills the expired row; old
      // source rows are never resurrected.
      const refreshed = refreshExpiredAssetRow(orm, existing, input, contentSha256, at);
      if (refreshed) return { asset: refreshed, created: false };
      // CAS miss: the row moved or vanished — return only what the DB holds now.
      const actual = orm
        .select()
        .from(schema.qqMediaAssets)
        .where(eq(schema.qqMediaAssets.id, existing.id))
        .get();
      if (!actual) fail("DATABASE_UNAVAILABLE", "数据服务暂不可用，请检查数据库", 503);
      return { asset: actual, created: false };
    }
    const expiresAt = earlier(existing.expiresAt, input.expiresAt);
    if (expiresAt !== existing.expiresAt) {
      const updated = orm
        .update(schema.qqMediaAssets)
        .set({ expiresAt })
        .where(
          and(
            eq(schema.qqMediaAssets.id, existing.id),
            // CAS: another writer may have moved the cap between read and
            // write; only narrow it, never widen it back.
            gt(schema.qqMediaAssets.expiresAt, expiresAt),
          ),
        )
        .returning()
        .get();
      if (updated) return { asset: updated, created: false };
      const raced = orm
        .select()
        .from(schema.qqMediaAssets)
        .where(eq(schema.qqMediaAssets.id, existing.id))
        .get();
      if (!raced) fail("DATABASE_UNAVAILABLE", "数据服务暂不可用，请检查数据库", 503);
      return { asset: raced, created: false };
    }
    return { asset: existing, created: false };
  }
  const row = orm
    .insert(schema.qqMediaAssets)
    .values({
      id: crypto.randomUUID(),
      accountId: input.scope.accountId,
      conversationKind: input.scope.conversationKind,
      peerId: input.scope.peerId,
      agentId: input.scope.agentId,
      contentSha256,
      bytes: input.bytes,
      mimeType,
      width: input.width ?? null,
      height: input.height ?? null,
      revision: 1,
      expiresAt: input.expiresAt,
      recordedAt: at,
    })
    .onConflictDoNothing()
    .returning()
    .get();
  if (row) return { asset: row, created: true };
  // A concurrent writer inserted the same (scope, sha) first: it is the same
  // asset, not an error. Same rule as above: never revive an expired row.
  const raced = orm
    .select()
    .from(schema.qqMediaAssets)
    .where(
      and(
        eq(schema.qqMediaAssets.accountId, input.scope.accountId),
        eq(schema.qqMediaAssets.conversationKind, input.scope.conversationKind),
        eq(schema.qqMediaAssets.peerId, input.scope.peerId),
        eq(schema.qqMediaAssets.agentId, input.scope.agentId),
        eq(schema.qqMediaAssets.contentSha256, contentSha256),
      ),
    )
    .get();
  if (!raced) fail("DATABASE_UNAVAILABLE", "数据服务暂不可用，请检查数据库", 503);
  if (Date.parse(raced.expiresAt) <= Date.parse(at)) {
    // F1 refill for the raced row — same rules as the pre-read expired branch.
    const refreshed = refreshExpiredAssetRow(orm, raced, input, contentSha256, at);
    if (refreshed) return { asset: refreshed, created: false };
    const actual = orm
      .select()
      .from(schema.qqMediaAssets)
      .where(eq(schema.qqMediaAssets.id, raced.id))
      .get();
    if (!actual) fail("DATABASE_UNAVAILABLE", "数据服务暂不可用，请检查数据库", 503);
    return { asset: actual, created: false };
  }
  const expiresAt = earlier(raced.expiresAt, input.expiresAt);
  if (expiresAt !== raced.expiresAt) {
    const narrowed = orm
      .update(schema.qqMediaAssets)
      .set({ expiresAt })
      .where(
        and(eq(schema.qqMediaAssets.id, raced.id), gt(schema.qqMediaAssets.expiresAt, expiresAt)),
      )
      .returning()
      .get();
    if (narrowed) return { asset: narrowed, created: false };
    // CAS miss: another writer narrowed the row between our re-read and our
    // UPDATE — return what the DB actually holds, not the pre-read snapshot.
    const actual = orm
      .select()
      .from(schema.qqMediaAssets)
      .where(eq(schema.qqMediaAssets.id, raced.id))
      .get();
    if (!actual) fail("DATABASE_UNAVAILABLE", "数据服务暂不可用，请检查数据库", 503);
    return { asset: actual, created: false };
  }
  return { asset: raced, created: false };
}

/**
 * F1 (2026-10): an expired (scope, sha) row is refilled by a genuinely new
 * fetch inside one immediate transaction with a precise CAS (expected revision
 * + expiry still <= at). The new bytes/window become the row and revision
 * advances (旧 revision 引用失效); variants and classifications are cleared
 * (派生不跨缓存纪元); old source links keep their original expiry — never
 * extended, never deleted (deleting them would cascade
 * `qq_media_read_tasks.asset_source_id` away).
 */
function refreshExpiredAssetRow(
  orm: Orm,
  expired: QqMediaAssetRow,
  input: {
    bytes: Uint8Array;
    mimeType: string;
    expiresAt: string;
    width?: number;
    height?: number;
  },
  contentSha256: string,
  at: string,
): QqMediaAssetRow | null {
  const db = clientOf(orm);
  return immediate(db, () => {
    const refreshed = orm
      .update(schema.qqMediaAssets)
      .set({
        bytes: input.bytes,
        mimeType: input.mimeType,
        width: input.width ?? null,
        height: input.height ?? null,
        expiresAt: input.expiresAt,
        recordedAt: at,
        revision: sql`${schema.qqMediaAssets.revision} + 1`,
      })
      .where(
        and(
          eq(schema.qqMediaAssets.id, expired.id),
          eq(schema.qqMediaAssets.contentSha256, contentSha256),
          // Precise CAS: only the row we saw, still expired, still un-refreshed.
          eq(schema.qqMediaAssets.revision, expired.revision),
          lte(schema.qqMediaAssets.expiresAt, at),
        ),
      )
      .returning()
      .get();
    if (!refreshed) return null;
    // Derivatives from the old cache epoch are not reusable across epochs.
    orm.delete(schema.qqMediaVariants).where(eq(schema.qqMediaVariants.assetId, expired.id)).run();
    orm
      .delete(schema.qqMediaClassifications)
      .where(eq(schema.qqMediaClassifications.assetId, expired.id))
      .run();
    return refreshed;
  });
}

/**
 * The scoped cache entry for one content sha, or `null` when absent/expired.
 * A hit here is still per-consumption authorization: callers re-check the
 * live sources behind it (`mediaAssetForMediaNote` / sourceAccess) before use.
 */
export function mediaAssetForContent(
  orm: Orm,
  input: { scope: QqMediaAssetScope; contentSha256: string; at: string },
): QqMediaAssetRow | null {
  const row = orm
    .select()
    .from(schema.qqMediaAssets)
    .where(
      and(
        eq(schema.qqMediaAssets.accountId, input.scope.accountId),
        eq(schema.qqMediaAssets.conversationKind, input.scope.conversationKind),
        eq(schema.qqMediaAssets.peerId, input.scope.peerId),
        eq(schema.qqMediaAssets.agentId, input.scope.agentId),
        eq(schema.qqMediaAssets.contentSha256, input.contentSha256),
        gt(schema.qqMediaAssets.expiresAt, input.at),
      ),
    )
    .get();
  return row ?? null;
}

/**
 * Link one message media row to the asset its bytes belong to. The source
 * brings its own expiry (its message's window): an expired media row cannot
 * feed or revive the cache, and the link's window is the *earlier* end of the
 * media row's own window and the caller's — a source can never justify an
 * asset past its message's retention.
 *
 * Scope discipline (§12: 字节缓存命中也要验证当前消息来源): the media row's
 * carrying event must live in the SAME (account, conversation kind, peer,
 * agent) scope as the asset — a link from another group/agent is refused, and
 * so is a link whose target asset does not exist or belongs to another scope.
 * Relinking the same media row is idempotent and returns the existing source
 * row (its identity is UNIQUE per media note).
 */
export function linkMediaAssetSource(
  orm: Orm,
  input: {
    assetId: string;
    mediaNoteId: string;
    scope: QqMediaSourceIdentity;
    expiresAt: string;
    at?: string;
  },
): QqMediaAssetSourceRow {
  requireScope(input.scope);
  const at = input.at ?? nowIso();
  const media = mediaNoteIdentity(orm, input.mediaNoteId);
  if (!media) fail("MEMORY_SOURCE_INVALID", "媒体位置不存在，不能挂接缓存来源");
  if (!sameScope(media, input.scope)) {
    fail("MEMORY_SOURCE_INVALID", "媒体来源与资产不在同一作用域，拒绝挂接");
  }
  if (Date.parse(media.mediaExpiresAt) <= Date.parse(at)) {
    fail("MEMORY_SOURCE_INVALID", "媒体来源已过期，不能写入或读取缓存");
  }
  const asset = orm
    .select({
      id: schema.qqMediaAssets.id,
      accountId: schema.qqMediaAssets.accountId,
      conversationKind: schema.qqMediaAssets.conversationKind,
      peerId: schema.qqMediaAssets.peerId,
      agentId: schema.qqMediaAssets.agentId,
      expiresAt: schema.qqMediaAssets.expiresAt,
    })
    .from(schema.qqMediaAssets)
    .where(eq(schema.qqMediaAssets.id, input.assetId))
    .get();
  if (!asset) fail("MEMORY_SOURCE_INVALID", "图片资产不存在，不能挂接缓存来源");
  if (
    asset.accountId !== input.scope.accountId ||
    asset.conversationKind !== input.scope.conversationKind ||
    asset.peerId !== input.scope.peerId ||
    asset.agentId !== input.scope.agentId
  ) {
    fail("MEMORY_SOURCE_INVALID", "图片资产与来源不在同一作用域，拒绝挂接");
  }
  const expiresAt = earlier(earlier(media.mediaExpiresAt, input.expiresAt), asset.expiresAt);
  const existing = orm
    .select()
    .from(schema.qqMediaAssetSources)
    .where(eq(schema.qqMediaAssetSources.mediaNoteId, input.mediaNoteId))
    .get();
  if (existing) {
    // Idempotent relink — but only to the SAME asset. A second media row
    // cannot be re-pointed at different bytes, and a link never extends its
    // own window.
    if (existing.assetId !== input.assetId) {
      fail("MEMORY_SOURCE_INVALID", "同一媒体位置已挂接不同资产，拒绝覆盖");
    }
    if (Date.parse(existing.expiresAt) > Date.parse(expiresAt)) {
      const narrowed = orm
        .update(schema.qqMediaAssetSources)
        .set({ expiresAt })
        .where(
          and(
            eq(schema.qqMediaAssetSources.id, existing.id),
            gt(schema.qqMediaAssetSources.expiresAt, expiresAt),
          ),
        )
        .returning()
        .get();
      return narrowed ?? existing;
    }
    return existing;
  }
  const row = orm
    .insert(schema.qqMediaAssetSources)
    .values({
      id: crypto.randomUUID(),
      assetId: input.assetId,
      mediaNoteId: input.mediaNoteId,
      expiresAt,
      recordedAt: at,
    })
    .onConflictDoNothing()
    .returning()
    .get();
  if (row) return row;
  const raced = orm
    .select()
    .from(schema.qqMediaAssetSources)
    .where(eq(schema.qqMediaAssetSources.mediaNoteId, input.mediaNoteId))
    .get();
  if (!raced) fail("DATABASE_UNAVAILABLE", "数据服务暂不可用，请检查数据库", 503);
  if (raced.assetId !== input.assetId) {
    fail("MEMORY_SOURCE_INVALID", "同一媒体位置已挂接不同资产，拒绝覆盖");
  }
  return raced;
}

/** Every live source that still backs an asset (cache reuse takes the earliest expiry). */
export function liveMediaAssetSources(
  orm: Orm,
  assetId: string,
  at: string,
): QqMediaAssetSourceRow[] {
  return orm
    .select()
    .from(schema.qqMediaAssetSources)
    .where(
      and(
        eq(schema.qqMediaAssetSources.assetId, assetId),
        gt(schema.qqMediaAssetSources.expiresAt, at),
      ),
    )
    .all();
}

/** The earliest live-source cap for one asset, or `null` when none is live. */
export function earliestLiveSourceExpiry(orm: Orm, assetId: string, at: string): string | null {
  const rows = liveMediaAssetSources(orm, assetId, at);
  if (rows.length === 0) return null;
  return rows.reduce((min, row) => earlier(min, row.expiresAt), rows[0].expiresAt);
}

/**
 * Cache one prepared copy (scale / sampled frames) under its policy key.
 * Prepared copies are authorized derivatives of a scoped asset: the write is
 * refused unless a live source still backs the asset (§12: 准备副本写入前复验
 * 来源). The same policy slot with different bytes would silently hand the
 * model the wrong picture, so a content mismatch is refused rather than
 * overwritten.
 */
export function recordMediaVariant(
  orm: Orm,
  input: {
    assetId: string;
    policy: string;
    bytes: Uint8Array;
    mimeType: string;
    width?: number;
    height?: number;
    frameCount?: number;
    frames?: readonly unknown[];
    at?: string;
  },
): { readonly variant: QqMediaVariantRow; readonly created: boolean } {
  const policy = input.policy.trim();
  if (policy.length === 0) throw new TypeError("Invalid QQ media variant policy");
  if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength === 0) {
    throw new TypeError("Invalid QQ media variant bytes");
  }
  const at = input.at ?? nowIso();
  requireLiveAssetSource(orm, input.assetId, at);
  const existing = mediaVariantFor(orm, { assetId: input.assetId, policy });
  if (existing) {
    // blob columns infer as unknown; the stored value is always binary bytes.
    const existingBytes = new Uint8Array(existing.bytes as ArrayBufferLike);
    if (
      Buffer.from(existingBytes).equals(Buffer.from(input.bytes)) === false ||
      existing.mimeType !== input.mimeType
    ) {
      fail("MEMORY_SOURCE_INVALID", "同一策略的图片副本内容不一致，拒绝覆盖");
    }
    return { variant: existing, created: false };
  }
  const row = orm
    .insert(schema.qqMediaVariants)
    .values({
      id: crypto.randomUUID(),
      assetId: input.assetId,
      policy,
      bytes: input.bytes,
      mimeType: input.mimeType,
      width: input.width ?? null,
      height: input.height ?? null,
      frameCount: input.frameCount ?? null,
      frames: input.frames === undefined ? null : JSON.stringify(input.frames),
      recordedAt: nowIso(),
    })
    .onConflictDoNothing()
    .returning()
    .get();
  if (row) return { variant: row, created: true };
  const raced = mediaVariantFor(orm, { assetId: input.assetId, policy });
  if (!raced) fail("DATABASE_UNAVAILABLE", "数据服务暂不可用，请检查数据库", 503);
  if (
    Buffer.from(new Uint8Array(raced.bytes as ArrayBufferLike)).equals(Buffer.from(input.bytes)) ===
    false
  ) {
    fail("MEMORY_SOURCE_INVALID", "同一策略的图片副本内容不一致，拒绝覆盖");
  }
  return { variant: raced, created: false };
}

export function mediaVariantFor(
  orm: Orm,
  input: { assetId: string; policy: string },
): QqMediaVariantRow | null {
  const row = orm
    .select()
    .from(schema.qqMediaVariants)
    .where(
      and(
        eq(schema.qqMediaVariants.assetId, input.assetId),
        eq(schema.qqMediaVariants.policy, input.policy),
      ),
    )
    .get();
  return row ?? null;
}

function requireLiveAssetSource(orm: Orm, assetId: string, at: string): void {
  if (!earliestLiveSourceExpiry(orm, assetId, at)) {
    fail("MEMORY_SOURCE_INVALID", "图片资产没有有效来源，不能写缓存派生数据");
  }
}

/**
 * Cache one classification per (policy, model) slot. Platform evidence wins
 * over any later model label; a `model` classification must name the model
 * that produced it (the 0012 attribution discipline). The cache-match key
 * includes the model: a classification produced by one model is not served to
 * another model's call (换 model 不能误用别的 model 的分类).
 *
 * Storage is a SINGLE slot per (asset, policy) — 0052's UNIQUE DDL is not
 * changed (M1 裁决 2026-10): the write path resolves the REAL policy slot row
 * and UPDATEs it in place (a platform row always wins and is never
 * overwritten); every returned row is what the DB actually holds.
 */
export function recordMediaClassification(
  orm: Orm,
  input: {
    assetId: string;
    category: "ordinary" | "expression" | "unknown";
    evidence: "platform" | "model" | "unknown";
    policy: string;
    modelName?: string;
    at?: string;
  },
): QqMediaClassificationRow {
  const policy = input.policy.trim();
  if (policy.length === 0) throw new TypeError("Invalid QQ media classification policy");
  const at = input.at ?? nowIso();
  // Classifications are authorized derivatives too: refuse without a live source.
  requireLiveAssetSource(orm, input.assetId, at);
  const modelName = input.modelName?.trim() ?? null;
  if (input.evidence === "model" && (modelName === null || modelName.length === 0)) {
    throw new TypeError("A model classification must name its model");
  }
  if (input.evidence !== "model" && modelName !== null) {
    throw new TypeError("Only a model classification carries a model name");
  }
  // The REAL policy slot: one row per (asset, policy) regardless of model —
  // mediaClassificationFor's model filter must not make a same-policy row
  // written by another model look "absent" to the write path.
  const slot = orm
    .select()
    .from(schema.qqMediaClassifications)
    .where(
      and(
        eq(schema.qqMediaClassifications.assetId, input.assetId),
        eq(schema.qqMediaClassifications.policy, policy),
      ),
    )
    .get();
  if (slot) {
    if (slot.evidence === "platform") return slot;
    const updated = orm
      .update(schema.qqMediaClassifications)
      .set({ category: input.category, evidence: input.evidence, modelName, recordedAt: nowIso() })
      .where(
        and(
          eq(schema.qqMediaClassifications.id, slot.id),
          sql`${schema.qqMediaClassifications.evidence} <> 'platform'`,
        ),
      )
      .returning()
      .get();
    if (updated) return updated;
    const raced = orm
      .select()
      .from(schema.qqMediaClassifications)
      .where(eq(schema.qqMediaClassifications.id, slot.id))
      .get();
    if (!raced) fail("DATABASE_UNAVAILABLE", "数据服务暂不可用，请检查数据库", 503);
    return raced;
  }
  const row = orm
    .insert(schema.qqMediaClassifications)
    .values({
      id: crypto.randomUUID(),
      assetId: input.assetId,
      category: input.category,
      evidence: input.evidence,
      modelName,
      policy,
      recordedAt: nowIso(),
    })
    .onConflictDoNothing()
    .returning()
    .get();
  if (row) return row;
  // Raced insert: re-read the REAL slot row and apply the same
  // UPDATE-or-platform-wins rule, so the return value is always what the DB
  // actually holds (M1).
  const raced = orm
    .select()
    .from(schema.qqMediaClassifications)
    .where(
      and(
        eq(schema.qqMediaClassifications.assetId, input.assetId),
        eq(schema.qqMediaClassifications.policy, policy),
      ),
    )
    .get();
  if (!raced) fail("DATABASE_UNAVAILABLE", "数据服务暂不可用，请检查数据库", 503);
  if (raced.evidence === "platform") return raced;
  const updated = orm
    .update(schema.qqMediaClassifications)
    .set({ category: input.category, evidence: input.evidence, modelName, recordedAt: nowIso() })
    .where(
      and(
        eq(schema.qqMediaClassifications.id, raced.id),
        sql`${schema.qqMediaClassifications.evidence} <> 'platform'`,
      ),
    )
    .returning()
    .get();
  if (updated) return updated;
  // A failed guard means a platform write landed between the read and the
  // UPDATE: re-read the real slot row instead of returning the stale snapshot.
  const actual = orm
    .select()
    .from(schema.qqMediaClassifications)
    .where(eq(schema.qqMediaClassifications.id, raced.id))
    .get();
  if (!actual) fail("DATABASE_UNAVAILABLE", "数据服务暂不可用，请检查数据库", 503);
  return actual;
}

/**
 * The classification cache entry for one (asset, policy, model) match.
 * `modelName` narrows the match to a single model's cached verdict; without
 * it, only non-model evidence (platform/unknown) is returned — a cached model
 * classification must never be served to a caller that did not name the same
 * model.
 */
export function mediaClassificationFor(
  orm: Orm,
  input: { assetId: string; policy: string; modelName?: string },
): QqMediaClassificationRow | null {
  const row = orm
    .select()
    .from(schema.qqMediaClassifications)
    .where(
      and(
        eq(schema.qqMediaClassifications.assetId, input.assetId),
        eq(schema.qqMediaClassifications.policy, input.policy),
      ),
    )
    .get();
  if (!row) return null;
  if (row.evidence === "model") {
    if (input.modelName === undefined) return null;
    if (row.modelName !== input.modelName.trim()) return null;
  }
  return row;
}

/**
 * The one asset-source protection predicate, shared by the retention purge and the storage
 * management surface's media_notes category (T14 manual cleanup). Parameterised by the
 * caller's SQL alias for `qq_media_asset_sources` so the purge's DELETE predicates and the
 * category's preview/execute compile the same text — one definition, not copies.
 *
 * A source link is protected when: a read task is `running` on it exactly (deleting the
 * link would cascade `qq_media_read_tasks.asset_source_id` away and strand an in-flight
 * attempt), or the note/task behind the link is held through a real minted ref (kind
 * `qq_media_source` by media note id, kind `qq_media_read_task` by the task id) by a
 * nonterminal run's exact snapshot or an unsafe agent task (nonterminal, or still holding
 * a `running`/`waiting_approval`/`unknown` call — the TASK_PROTECTION face), or the
 * attached note itself is protected ({@link mediaNoteProtected}: a running read task on
 * the note may not yet carry `asset_source_id`, and the T14 manual closure must not delete
 * the bytes/links of a note the same surface would keep).
 */
export function mediaAssetSourceProtected(alias: string): string {
  return `(
    EXISTS (SELECT 1 FROM qq_media_read_tasks rt
      WHERE rt.asset_source_id = ${alias}.id AND rt.status = 'running')
    OR EXISTS (SELECT 1 FROM qq_media_notes mp
      WHERE mp.id = ${alias}.media_note_id AND ${mediaNoteProtected("mp")})
    OR EXISTS (SELECT 1 FROM context_snapshots c
      JOIN agent_steps st ON st.step_id = c.step_id
      JOIN agent_runs r ON r.run_id = st.run_id
      WHERE c.status = 'exact'
        AND r.status NOT IN ('completed','no_output','failed','cancelled')
        AND (EXISTS (SELECT 1 FROM json_each(c.source_refs) j
            WHERE json_extract(j.value,'$.kind') = 'qq_media_source'
              AND json_extract(j.value,'$.id') = ${alias}.media_note_id)
          OR EXISTS (SELECT 1 FROM json_each(c.source_refs) j2
            WHERE json_extract(j2.value,'$.kind') = 'qq_media_read_task'
              AND json_extract(j2.value,'$.id') IN (SELECT rt2.id FROM qq_media_read_tasks rt2
                WHERE rt2.asset_source_id = ${alias}.id))))
    OR EXISTS (SELECT 1 FROM agent_tasks t
      WHERE (t.status NOT IN ('completed','failed','cancelled')
        OR EXISTS (SELECT 1 FROM agent_task_calls bc
          WHERE bc.task_id = t.id
          AND bc.status IN ('running','waiting_approval','unknown')))
      AND (EXISTS (SELECT 1 FROM json_each(t.sources) j
        WHERE json_extract(j.value,'$.kind') = 'qq_media_read_task'
          AND json_extract(j.value,'$.id') IN (SELECT rt3.id FROM qq_media_read_tasks rt3
            WHERE rt3.asset_source_id = ${alias}.id))
        OR EXISTS (SELECT 1 FROM json_each(t.sources) j4
          WHERE json_extract(j4.value,'$.kind') = 'qq_media_source'
            AND json_extract(j4.value,'$.id') = ${alias}.media_note_id))))`;
}

/**
 * Retention sweep — a MANUAL retention action in the same category as the
 * media notes' cleanup, with in-use protection, and it is NOT wired as an
 * automatic job (字节清理接线仍属 T14). Semantics (M2 裁决 2026-10, narrowed by
 * the T14 asset-retention protection): a sweep with NOTHING to delete is legal
 * and returns 0; unrelated live assets never block it, and neither do assets
 * that were already dead before the sweep (all their sources expired — there is
 * no readable access left to protect). The source delete only removes rows
 * whose own window has passed (活 source 不因本语句消失); the asset delete takes
 * an expired asset together with its links — except when one link is HELD, then
 * the whole asset stays. Rows still HELD by
 * real consumers are protected in the delete predicates themselves (same shape
 * as the outbound/inbound facts purges): a source referenced by a RUNNING read
 * task keeps its row — deleting it would cascade `qq_media_read_tasks`
 * `.asset_source_id` away and strand an in-flight attempt (claim token and
 * failure evidence wiped) — and a source whose note is held through a real
 * minted ref (kind `qq_media_source` by media note id, kind
 * `qq_media_read_task` by the task id) by a nonterminal run or an unsafe agent
 * task (nonterminal, or still holding a running/waiting_approval/unknown call
 * — the TASK_PROTECTION face) keeps its row too: physical deletion would turn a
 * still distinguishable `expired` into a `revoked`. An asset is deleted only
 * when NONE of its links is protected, so the asset cascade can never bypass
 * the source protection (asset → sources → tasks). Every deletion stays inside
 * one immediate transaction: an abort rolls BOTH deletes back (counted assets
 * never commit half a sweep). Expired assets go together with their sources,
 * variants and classifications (ON DELETE CASCADE); a source belongs to exactly
 * one asset, so cascade deletes can never strand a different asset. The return
 * value is the number of expired ASSETS actually removed via `RETURNING` (0
 * when only source rows were swept — never a pre-SELECT count).
 *
 * 过期源与过期资产读取仍不可用（保护只延迟物理删除）；a source with no related
 * held refs deletes as soon as its own window ends, and a fully unrelated
 * expired pair never blocks another row's cleanup.
 */
export function purgeExpiredMediaAssets(orm: Orm, now: string = nowIso()): number {
  const db = clientOf(orm);
  return immediate(db, () => {
    /**
     * The protection faces, expressed once against an aliased source row: a running read
     * task consumes the link exactly, or the note/task behind the link is held via a real
     * minted ref by a nonterminal run's exact snapshot or an unsafe agent task. Shared with
     * the storage management surface via {@link mediaAssetSourceProtected}.
     */
    const protectsSource = sql.raw(mediaAssetSourceProtected("s"));
    // Freeze the EXACT doom sets ONCE, from this transaction's initial state, with the SAME
    // predicates the deletes below consume: helper and DELETEs can never diverge (an alias
    // mistake in a re-derived predicate would revoke results for sources that survive).
    const sAlias = alias(schema.qqMediaAssetSources, "s");
    const doomedSources = orm
      .select({ id: sAlias.id })
      .from(sAlias)
      .where(sql`${sAlias.expiresAt} <= ${now} AND NOT ${protectsSource}`)
      .all()
      .map((row) => row.id);
    const doomedAssets = orm
      .select({ id: schema.qqMediaAssets.id })
      .from(schema.qqMediaAssets)
      .where(
        sql`expires_at <= ${now}
          AND NOT EXISTS (SELECT 1 FROM qq_media_asset_sources s
            WHERE s.asset_id = qq_media_assets.id AND ${protectsSource})`,
      )
      .all()
      .map((row) => row.id);
    // Source-death result transition (BEFORE the deletes): every succeeded task bound to a
    // doomed source loses the note/model that the dead source justified — budget identity,
    // attempts and scope survive. A source whose SIBLING is protected keeps its asset alive
    // (the asset doom set above excludes it) and therefore keeps its result untouched.
    revokeMediaReadTaskResultsForSources(orm, doomedSources, now);
    if (doomedSources.length > 0) {
      orm
        .delete(schema.qqMediaAssetSources)
        .where(
          sql`id IN (${sql.join(
            doomedSources.map((id) => sql`${id}`),
            sql`, `,
          )})`,
        )
        .run();
    }
    if (doomedAssets.length > 0) {
      const deletedAssets = orm
        .delete(schema.qqMediaAssets)
        .where(
          sql`${schema.qqMediaAssets.id} IN (${sql.join(
            doomedAssets.map((id) => sql`${id}`),
            sql`, `,
          )})`,
        )
        .returning({ id: schema.qqMediaAssets.id })
        .all();
      return deletedAssets.length;
    }
    return 0;
  });
}

/**
 * The asset behind one media row, when the row's source link is still live
 * AND the media event still belongs to the requested scope. The returned cap
 * is the earliest of the media row's own window, the source link's and the
 * asset's: a read through this row can never outlive any of the three. A
 * deleted/expired/revoked source (its link row is gone or past its window)
 * means no asset — another live source of the same asset does NOT revive this
 * message's read.
 */
export function mediaAssetForMediaNote(
  orm: Orm,
  input: { mediaNoteId: string; scope: QqMediaSourceIdentity; at: string },
): { readonly asset: QqMediaAssetRow; readonly expiresAt: string } | null {
  const media = mediaNoteIdentity(orm, input.mediaNoteId);
  if (!media || !sameScope(media, input.scope)) return null;
  if (Date.parse(media.mediaExpiresAt) <= Date.parse(input.at)) return null;
  const rows = orm
    .select({ asset: schema.qqMediaAssets, sourceExpiresAt: schema.qqMediaAssetSources.expiresAt })
    .from(schema.qqMediaAssetSources)
    .innerJoin(
      schema.qqMediaAssets,
      eq(schema.qqMediaAssets.id, schema.qqMediaAssetSources.assetId),
    )
    .where(
      and(
        eq(schema.qqMediaAssetSources.mediaNoteId, input.mediaNoteId),
        gt(schema.qqMediaAssetSources.expiresAt, input.at),
        gt(schema.qqMediaAssets.expiresAt, input.at),
      ),
    )
    .limit(1)
    .all();
  const hit = rows[0];
  if (!hit) return null;
  return {
    asset: hit.asset,
    expiresAt: earlier(earlier(media.mediaExpiresAt, hit.sourceExpiresAt), hit.asset.expiresAt),
  };
}

/** Sanity check used by tests and callers: a scope never sees another's rows. */
export function countMediaAssetsInScope(orm: Orm, scope: QqMediaAssetScope): number {
  const row = orm
    .select({ total: sql<number>`count(*)` })
    .from(schema.qqMediaAssets)
    .where(
      and(
        eq(schema.qqMediaAssets.accountId, scope.accountId),
        eq(schema.qqMediaAssets.conversationKind, scope.conversationKind),
        eq(schema.qqMediaAssets.peerId, scope.peerId),
        eq(schema.qqMediaAssets.agentId, scope.agentId),
      ),
    )
    .get();
  return row?.total ?? 0;
}
