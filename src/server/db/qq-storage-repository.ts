// QQ storage usage and the one cleanup entry (ADR0018 §11.1/§10, P5h).
//
// §11.1's 存储与诊断 answers "what does the QQ side keep, and what can I do about it". The user's
// decision (2026-09-24) is that it reports only data that EXISTS: media notes hold references and
// descriptions rather than bytes, so there is no cache size to invent, and failure records are not
// stored yet — the page says so instead of showing a zero that reads as "no failures".
//
// Cleanup runs the same windows the rest of the side already uses: `qq-retention.ts` is the single
// definition of "how long do we keep this", and every purge below deletes rows whose expiry has
// passed and nothing else. Sticker copies and collections are counted here but deliberately NOT
// cleaned: §10 keeps material governance independent, and U11 forbids deleting them.
//
// The management half (`/storage/settings`, `/storage/items`, the category/selection cleanup)
// lives below the summary: the list is metadata-only, and the cleanup deletes expired rows of
// the FIVE content categories only — identities (`qq_events`), schemes, bindings and sticker
// material are never addressed by it. Protected rows are described where their predicate is.

import type { Database } from "bun:sqlite";
import { and, count, eq, gt, isNull, lte, sum } from "drizzle-orm";
import type { QqStorageCategory, QqStorageStatusFilter } from "../../shared/contracts/qq-storage";
import {
  type QqSweepVerdictRow,
  qqDispatchLeaseIsHeld,
  readQqDispatchLease,
  readQqSweepVerdicts,
} from "./qq-dispatch-repository";
import { purgeExpiredMediaNotes } from "./qq-media-repository";
import { purgeExpiredQqMembers } from "./qq-member-repository";
import { purgeExpiredObservationText } from "./qq-observation-repository";
import { readQqRetentionDays } from "./qq-settings-repository";
import { purgeExpiredQqSpeech } from "./qq-speech-repository";
import { immediate, nowIso, type Orm } from "./repositories";
import * as schema from "./schema";

/** The underlying bun:sqlite handle, needed for the fixed-SQL management queries below. */
function clientOf(orm: Orm): Database {
  return (orm as unknown as { $client: Database }).$client;
}

export interface QqStorageUsage {
  readonly observations: {
    readonly messages: number;
    readonly text: number;
    readonly expiredText: number;
  };
  readonly speech: { readonly records: number; readonly text: number };
  readonly sends: { readonly attempts: number; readonly parts: number };
  readonly nicknames: { readonly current: number; readonly expired: number };
  readonly stickers: {
    readonly collections: number;
    readonly assets: number;
    readonly enabled: number;
    readonly bytes: number;
  };
  /**
   * What the durable state machine is waiting for (P5m): queued conversations and whether the one
   * global model-chain slot is taken. Counts of rows, read-only — the token that owns the lease is
   * deliberately not part of this view.
   */
  readonly dispatch: {
    readonly candidates: number;
    readonly ready_now: number;
    readonly lease_held: boolean;
  };
  /** Received media positions: how many there are, how many were understood, how many are waiting. */
  readonly media: {
    readonly segments: number;
    readonly described: number;
    readonly pending: number;
  };
  /**
   * The last quiet-room verdict per conversation (0030, §11.1's 原因可追踪). Not a count of stored
   * data but the reason record itself: why each bound conversation did or did not get an opener on
   * the last pass. `tracked` counts every recorded conversation; `entries` carries the newest
   * `QQ_SWEEP_VERDICT_LIMIT` of them, so a page can never be asked to render an unbounded list.
   */
  readonly sweep: {
    readonly tracked: number;
    readonly lastSweptAtSeconds: number | null;
    readonly entries: readonly QqSweepVerdictRow[];
  };
  readonly retentionDays: number;
}

/** What the QQ side currently holds. Reads only; the numbers are the tables' own rows. */
export function qqStorageUsage(orm: Orm, now: string = nowIso()): QqStorageUsage {
  const rows = (row: { n: number | string } | undefined) => Number(row?.n ?? 0);
  const messages = rows(orm.select({ n: count() }).from(schema.qqEvents).get());
  const text = rows(orm.select({ n: count() }).from(schema.qqObservationText).get());
  const expiredText = rows(
    orm
      .select({ n: count() })
      .from(schema.qqObservationText)
      .where(lte(schema.qqObservationText.expiresAt, now))
      .get(),
  );
  const speechRecords = rows(orm.select({ n: count() }).from(schema.qqSpeechLog).get());
  const speechText = rows(orm.select({ n: count() }).from(schema.qqSpeechText).get());
  const attempts = rows(orm.select({ n: count() }).from(schema.qqSendLog).get());
  const parts = rows(orm.select({ n: count() }).from(schema.qqSendPart).get());
  const nicknames = rows(
    orm
      .select({ n: count() })
      .from(schema.qqMembers)
      .where(gt(schema.qqMembers.expiresAt, now))
      .get(),
  );
  const expiredNicknames = rows(
    orm
      .select({ n: count() })
      .from(schema.qqMembers)
      .where(lte(schema.qqMembers.expiresAt, now))
      .get(),
  );
  const collections = rows(orm.select({ n: count() }).from(schema.qqStickerCollections).get());
  const assets = rows(orm.select({ n: count() }).from(schema.qqStickerAssets).get());
  const enabled = rows(
    orm
      .select({ n: count() })
      .from(schema.qqStickerAssets)
      .where(eq(schema.qqStickerAssets.enabled, 1))
      .get(),
  );
  const nowSeconds = Math.floor(Date.parse(now) / 1000);
  const candidates = rows(orm.select({ n: count() }).from(schema.qqDispatchCandidates).get());
  const readyNow = rows(
    orm
      .select({ n: count() })
      .from(schema.qqDispatchCandidates)
      .where(lte(schema.qqDispatchCandidates.readyAtSeconds, nowSeconds))
      .get(),
  );
  const leaseHeld = qqDispatchLeaseIsHeld(readQqDispatchLease(orm), nowSeconds);
  const mediaSegments = rows(orm.select({ n: count() }).from(schema.qqMediaNotes).get());
  const mediaDescribed = rows(
    orm
      .select({ n: count() })
      .from(schema.qqMediaNotes)
      .where(gt(schema.qqMediaNotes.note, ""))
      .get(),
  );
  // "Waiting" means an attempt was spent and no description came back, on a segment that has not
  // expired: an expired one can never be read again, so counting it as pending would be a promise
  // the retention window already withdrew.
  const mediaPending = rows(
    orm
      .select({ n: count() })
      .from(schema.qqMediaNotes)
      .where(
        and(
          isNull(schema.qqMediaNotes.note),
          gt(schema.qqMediaNotes.attempts, 0),
          gt(schema.qqMediaNotes.expiresAt, now),
        ),
      )
      .get(),
  );
  const byteRow = orm
    .select({ total: sum(schema.qqStickerAssets.byteSize) })
    .from(schema.qqStickerAssets)
    .get();
  const sweepTracked = rows(orm.select({ n: count() }).from(schema.qqSweepVerdicts).get());
  const sweepEntries = readQqSweepVerdicts(orm);
  return Object.freeze({
    observations: Object.freeze({ messages, text, expiredText }),
    speech: Object.freeze({ records: speechRecords, text: speechText }),
    sends: Object.freeze({ attempts, parts }),
    nicknames: Object.freeze({ current: nicknames, expired: expiredNicknames }),
    stickers: Object.freeze({
      collections,
      assets,
      enabled,
      bytes: Number(byteRow?.total ?? 0),
    }),
    dispatch: Object.freeze({ candidates, ready_now: readyNow, lease_held: leaseHeld }),
    media: Object.freeze({
      segments: mediaSegments,
      described: mediaDescribed,
      pending: mediaPending,
    }),
    sweep: Object.freeze({
      tracked: sweepTracked,
      // The entries are newest-first, so the first one dates the last pass. `null` when nothing has
      // been recorded at all, which the page must be able to tell apart from "swept just now".
      lastSweptAtSeconds: sweepEntries[0]?.decidedAtSeconds ?? null,
      entries: Object.freeze(sweepEntries),
    }),
    // The window in effect, read from the settings row every call: after a save the summary must
    // state the new rule, not the build-time default (already written rows keep their stamps).
    retentionDays: readQqRetentionDays(orm),
  });
}

export interface QqStorageCleanup {
  readonly observationText: number;
  readonly mediaNotes: number;
  readonly speech: number;
  readonly sends: number;
  readonly nicknames: number;
}

/**
 * Remove what has expired, on the windows the rest of the side already follows.
 *
 * Nothing live is touched, and nothing here decides a retention rule: each purge reads its own
 * expiry column, which was written from `qq-retention.ts` when the row was created.
 */
export function qqStorageCleanup(orm: Orm, now: string = nowIso()): QqStorageCleanup {
  return Object.freeze({
    observationText: purgeExpiredObservationText(orm, now),
    mediaNotes: purgeExpiredMediaNotes(orm, now),
    speech: purgeExpiredQqSpeech(orm, now),
    // The one delegation: `sends` runs the by-category selection so an empty-body sweep keeps
    // what the category path keeps — `unknown` results and rows an outbound intent still holds
    // (the shared predicate is `sendProtected`).
    sends: qqStorageCleanupExecute(orm, { category: "sends" }, now).removed,
    nicknames: purgeExpiredQqMembers(orm, now),
  });
}

// ---- 管理面（ADR0018 §11.1）：元数据列表与按类别/选中行的清理 -------------------------------
//
// 五个类别各有一条固定的表/列配置：SQL 里的表名与列名只来自这里的常量，绝不拼接请求输入；
// 请求值只作为绑定参数出现（peer/kind/游标/ids）。列表的 SELECT 列表里没有正文、来源引用或
// 平台消息 id —— 元数据是这一层能给出的全部；正文的出口仍是当前对话的原文复验，不在此处。

/** A row of the metadata list, as the fixed per-category SQL returns it. */
interface QqStorageItemRow {
  readonly id: string;
  readonly account_id: string;
  readonly kind: "group" | "private";
  readonly peer_id: string;
  readonly agent_id: string | null;
  readonly created_at: string;
  readonly expires_at: string;
  readonly clock: number | string;
  /** 0/1 from SQL; true = 到期也不得清理。 */
  readonly protected: number;
}

export interface QqStorageItem {
  readonly id: string;
  readonly category: QqStorageCategory;
  readonly accountId: string;
  readonly kind: "group" | "private";
  readonly peerId: string;
  readonly agentId: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly expired: boolean;
  readonly protected: boolean;
}

export interface QqStorageItemsPage {
  readonly items: readonly QqStorageItem[];
  readonly nextCursor: string | null;
  readonly total: number;
}

export interface QqStorageItemsQuery {
  readonly category: QqStorageCategory;
  readonly status: QqStorageStatusFilter;
  readonly peerId?: string;
  readonly kind?: "group" | "private";
  readonly cursor?: { readonly clock: number | string; readonly id: string };
  readonly limit: number;
}

/** The cursor a page hands to the next page: the last item's `(clock, id)`. */
export function encodeQqStorageCursor(clock: number | string, id: string): string {
  return JSON.stringify({ clock, id });
}

/**
 * Sends that must survive even after expiry: an attempt whose platform result is `unknown`
 * (§8.2: unknown is neither success nor loss until it is reconciled), or one an outbound
 * intent still holds (`planned`/`delivering` = in flight, `unknown` = unresolved). Settled
 * intents (`confirmed`/`failed`/`stale`) do not protect their legacy projection.
 */
function sendProtected(alias: string): string {
  return `(${alias}.outcome = 'unknown' OR EXISTS (SELECT 1 FROM outbound_intents i WHERE i.legacy_send_id = ${alias}.id AND i.status IN ('planned','delivering','unknown')))`;
}

/**
 * A nickname has no single-column key; the four PK columns are composed with `:`, which cannot
 * occur in QQ ids (numeric) or the conversation-kind enum, so the composite is unambiguous.
 * The same expression is used by the list's exported `id` and by the cleanup's `ids` filter.
 */
function nicknameId(alias: string): string {
  return `(${alias}.account_id || ':' || ${alias}.conversation_kind || ':' || ${alias}.peer_id || ':' || ${alias}.user_id)`;
}

interface QqStorageItemSource {
  /** Fixed FROM clause (table plus the join that names its conversation). */
  readonly from: string;
  /** Fixed SELECT list; aliases must match {@link QqStorageItemRow}. */
  readonly select: string;
  /** Fixed per-category activity clock: primary sort key. */
  readonly clock: string;
  /** Fixed tie-break expression = the row's stable id. */
  readonly tie: string;
  readonly peer: string;
  readonly kind: string;
  readonly expiry: string;
}

const ITEM_SOURCES: Readonly<Record<QqStorageCategory, QqStorageItemSource>> = Object.freeze({
  observation_text: {
    from: "qq_observation_text t JOIN qq_events e ON e.event_key = t.event_key",
    select:
      "t.event_key AS id, e.account_id AS account_id, e.conversation_kind AS kind, e.peer_id AS peer_id, e.agent_id AS agent_id, t.recorded_at AS created_at, t.expires_at AS expires_at, t.occurred_at_seconds AS clock, 0 AS protected",
    clock: "t.occurred_at_seconds",
    tie: "t.event_key",
    peer: "e.peer_id",
    kind: "e.conversation_kind",
    expiry: "t.expires_at",
  },
  media_notes: {
    from: "qq_media_notes t JOIN qq_events e ON e.event_key = t.event_key",
    select:
      "t.id AS id, e.account_id AS account_id, e.conversation_kind AS kind, e.peer_id AS peer_id, e.agent_id AS agent_id, t.recorded_at AS created_at, t.expires_at AS expires_at, t.recorded_at AS clock, 0 AS protected",
    // A media row has no numeric clock; its record time is the category's own ordering key.
    clock: "t.recorded_at",
    tie: "t.id",
    peer: "e.peer_id",
    kind: "e.conversation_kind",
    expiry: "t.expires_at",
  },
  speech: {
    from: "qq_speech_log t",
    select:
      "t.id AS id, t.account_id AS account_id, t.conversation_kind AS kind, t.peer_id AS peer_id, t.agent_id AS agent_id, t.recorded_at AS created_at, t.expires_at AS expires_at, t.spoke_at_seconds AS clock, 0 AS protected",
    clock: "t.spoke_at_seconds",
    tie: "t.id",
    peer: "t.peer_id",
    kind: "t.conversation_kind",
    expiry: "t.expires_at",
  },
  sends: {
    from: "qq_send_log t",
    select: `t.id AS id, t.account_id AS account_id, t.conversation_kind AS kind, t.peer_id AS peer_id, t.agent_id AS agent_id, t.recorded_at AS created_at, t.expires_at AS expires_at, t.sent_at_seconds AS clock, CASE WHEN ${sendProtected("t")} THEN 1 ELSE 0 END AS protected`,
    clock: "t.sent_at_seconds",
    tie: "t.id",
    peer: "t.peer_id",
    kind: "t.conversation_kind",
    expiry: "t.expires_at",
  },
  nicknames: {
    from: "qq_members t",
    select: `${nicknameId("t")} AS id, t.account_id AS account_id, t.conversation_kind AS kind, t.peer_id AS peer_id, NULL AS agent_id, strftime('%Y-%m-%dT%H:%M:%S.000000Z', t.first_seen_at_seconds, 'unixepoch') AS created_at, t.expires_at AS expires_at, t.last_seen_at_seconds AS clock, 0 AS protected`,
    clock: "t.last_seen_at_seconds",
    tie: nicknameId("t"),
    peer: "t.peer_id",
    kind: "t.conversation_kind",
    expiry: "t.expires_at",
  },
});

function readCount(db: Database, sql: string, params: readonly (string | number)[]): number {
  const row = db.query(sql).get(...params) as { n: number } | null | undefined;
  return Number(row?.n ?? 0);
}

/** Run a fixed-SQL COUNT(*) with extra conditions appended to the mandatory WHERE parts. */
function countRows(
  db: Database,
  table: string,
  conditions: readonly string[],
  params: readonly (string | number)[],
): number {
  const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
  return readCount(db, `SELECT COUNT(*) AS n FROM ${table}${where}`, params);
}

/**
 * One page of metadata for one category, newest first, `limit` capped by the contract (1..100).
 * Ordering is `(clock DESC, id DESC)` so the `(clock, id)` cursor is stable while rows are
 * inserted; only expired/live is judged by the server clock passed in.
 */
export function qqStorageItemsPage(
  orm: Orm,
  query: QqStorageItemsQuery,
  now: string = nowIso(),
): QqStorageItemsPage {
  const source = ITEM_SOURCES[query.category];
  const db = clientOf(orm);
  const filters: string[] = [];
  const params: (string | number)[] = [];
  if (query.status === "live") {
    filters.push(`${source.expiry} > ?`);
    params.push(now);
  } else if (query.status === "expired") {
    filters.push(`${source.expiry} <= ?`);
    params.push(now);
  }
  if (query.peerId !== undefined) {
    filters.push(`${source.peer} = ?`);
    params.push(query.peerId);
  }
  if (query.kind !== undefined) {
    filters.push(`${source.kind} = ?`);
    params.push(query.kind);
  }
  const totalWhere = filters.length > 0 ? ` WHERE ${filters.join(" AND ")}` : "";
  const total = readCount(db, `SELECT COUNT(*) AS n FROM ${source.from}${totalWhere}`, params);

  const pageFilters = [...filters];
  const pageParams = [...params];
  if (query.cursor !== undefined) {
    pageFilters.push(`(${source.clock} < ? OR (${source.clock} = ? AND ${source.tie} < ?))`);
    pageParams.push(query.cursor.clock, query.cursor.clock, query.cursor.id);
  }
  const pageWhere = pageFilters.length > 0 ? ` WHERE ${pageFilters.join(" AND ")}` : "";
  const rows = db
    .query(
      `SELECT ${source.select} FROM ${source.from}${pageWhere} ORDER BY ${source.clock} DESC, ${source.tie} DESC LIMIT ?`,
    )
    .all(...pageParams, query.limit + 1) as QqStorageItemRow[];
  const hasMore = rows.length > query.limit;
  const visible = hasMore ? rows.slice(0, query.limit) : rows;
  const last = visible.at(-1);
  return Object.freeze({
    items: Object.freeze(
      visible.map((row): QqStorageItem => {
        return {
          id: row.id,
          category: query.category,
          accountId: row.account_id,
          kind: row.kind,
          peerId: row.peer_id,
          agentId: row.agent_id,
          createdAt: row.created_at,
          expiresAt: row.expires_at,
          // Same comparison the SQL uses (both sides are fixed-width ISO); rows are never
          // rewritten, so this is a statement about the stamp, not about cleanup state.
          expired: row.expires_at <= now,
          protected: row.protected === 1,
        };
      }),
    ),
    nextCursor: hasMore && last ? encodeQqStorageCursor(last.clock, last.id) : null,
    total,
  });
}

// ---- 按类别/选中行的清理 ---------------------------------------------------------------------
//
// 只删已到期行；`ids` 给出时只删选中的行（空数组由契约拒绝，绝不会退化成"全部"）。
// identity 表（qq_events/方案/绑定/素材）不在这份配置里 —— 清理无法触达它们。
// speech 的说明：qq_speech_log/qq_speech_text 没有 run/task/outbound 关联列，行也只在发言
// 确实送达后写入（recordQqSpeech 契约），所以不存在"仍被进行中工作引用"的行可保全；
// 到期即视为可清理（与既有 purgeExpiredQqSpeech 一致，不引入猜测性联结）。

export interface QqStorageCleanupSelection {
  readonly category: QqStorageCategory;
  readonly ids?: readonly string[];
}

export interface QqStorageCleanupCounts {
  readonly matched: number;
  readonly expired: number;
  readonly protected: number;
  readonly removable: number;
}

interface QqStorageCleanupSource {
  /** Fixed table; deletions never leave these five tables. */
  readonly table: string;
  /** Fixed identity expression compared against request ids (= the list's exported id). */
  readonly id: string;
  /** Fixed protection predicate; null means every expired row of the table is removable. */
  readonly protection: string | null;
}

const CLEANUP_SOURCES: Readonly<Record<QqStorageCategory, QqStorageCleanupSource>> = Object.freeze({
  observation_text: { table: "qq_observation_text", id: "event_key", protection: null },
  media_notes: { table: "qq_media_notes", id: "id", protection: null },
  speech: { table: "qq_speech_log", id: "id", protection: null },
  sends: { table: "qq_send_log", id: "id", protection: sendProtected("qq_send_log") },
  nicknames: { table: "qq_members", id: nicknameId("qq_members"), protection: null },
});

/** The ids condition; `undefined` = whole category, `[]` = match nothing (fail closed). */
function selectionScope(
  source: QqStorageCleanupSource,
  ids: readonly string[] | undefined,
): { sql: string; params: string[] } {
  if (ids === undefined) return { sql: "", params: [] };
  if (ids.length === 0) return { sql: "0", params: [] };
  return { sql: `${source.id} IN (${ids.map(() => "?").join(", ")})`, params: [...ids] };
}

function selectionCounts(
  db: Database,
  selection: QqStorageCleanupSelection,
  now: string,
): QqStorageCleanupCounts {
  const source = CLEANUP_SOURCES[selection.category];
  const scope = selectionScope(source, selection.ids);
  const conditions = (extra: readonly string[]) => [...(scope.sql ? [scope.sql] : []), ...extra];
  const count = (extra: readonly string[], extraParams: (string | number)[] = []) =>
    countRows(db, source.table, conditions(extra), [...scope.params, ...extraParams]);
  const matched = count([]);
  const expired = count(["expires_at <= ?"], [now]);
  const protectedCount = source.protection
    ? count(["expires_at <= ?", source.protection], [now])
    : 0;
  return Object.freeze({
    matched,
    expired,
    protected: protectedCount,
    removable: expired - protectedCount,
  });
}

/** Counts only; zero writes. Same filter the execute uses: expired, minus protected. */
export function qqStorageCleanupPreview(
  orm: Orm,
  selection: QqStorageCleanupSelection,
  now: string = nowIso(),
): QqStorageCleanupCounts {
  return selectionCounts(clientOf(orm), selection, now);
}

export interface QqStorageCleanupExecution {
  /** The selection's numbers at request time (what the preview showed). */
  readonly counts: QqStorageCleanupCounts;
  /** Rows actually deleted. */
  readonly removed: number;
}

/**
 * Delete the selected expired rows in one immediate transaction: the counts and the deletion see
 * the same database state, so `removable` can never promise a different number than `removed`.
 * A protected row is never deleted, whichever shape the selection has.
 */
export function qqStorageCleanupExecute(
  orm: Orm,
  selection: QqStorageCleanupSelection,
  now: string = nowIso(),
): QqStorageCleanupExecution {
  const source = CLEANUP_SOURCES[selection.category];
  const db = clientOf(orm);
  return immediate(db, () => {
    const counts = selectionCounts(db, selection, now);
    const scope = selectionScope(source, selection.ids);
    const conditions = [
      "expires_at <= ?",
      ...(source.protection ? [`NOT (${source.protection})`] : []),
      ...(scope.sql ? [scope.sql] : []),
    ];
    const where = `WHERE ${conditions.join(" AND ")}`;
    const params = [now, ...scope.params];
    // `changes` would also count rows removed through the foreign keys (speech bodies, send
    // parts); the count of the selection's own rows under the same predicate is what `removed`
    // means, matching the existing purge helpers.
    const doomed = readCount(db, `SELECT COUNT(*) AS n FROM ${source.table} ${where}`, params);
    db.query(`DELETE FROM ${source.table} ${where}`).run(...params);
    return { counts, removed: doomed };
  });
}
