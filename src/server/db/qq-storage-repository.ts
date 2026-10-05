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
import { mediaAssetSourceProtected } from "./qq-media-asset-repository";
import { mediaNoteProtected } from "./qq-media-repository";
import { revokeMediaReadTaskResultsForSources } from "./qq-media-task-repository";
import { qqMessageFactProtected, qqOutboundMessageFactProtected } from "./qq-message-repository";
import { readQqRetentionDays } from "./qq-settings-repository";
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
 *
 * T14 manual closure: the legacy sweep now delegates to the SAME by-category selection the
 * management surface uses — one selection closure per category, executed for the whole
 * category — so the legacy five counts can never diverge from the category path's counts
 * (no parallel facts sweep that would double-count). Each category's `removed` counts its
 * own primary rows actually deleted (RETURNING), never the FK-cascaded children.
 */
export function qqStorageCleanup(orm: Orm, now: string = nowIso()): QqStorageCleanup {
  const run = (category: QqStorageCategory): number =>
    qqStorageCleanupExecute(orm, { category }, now).removed;
  return Object.freeze({
    observationText: run("observation_text"),
    mediaNotes: run("media_notes"),
    speech: run("speech"),
    sends: run("sends"),
    nicknames: run("nicknames"),
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
  /** Fixed FROM clause (table plus the joins that name its conversation). */
  readonly from: string;
  /** Fixed SELECT list; aliases must match {@link QqStorageItemRow}. */
  readonly select: string;
  /** Fixed per-face activity clock: primary sort key (one type per category). */
  readonly clock: string;
  /** Fixed tie-break expression = the row's stable (prefixed) id. */
  readonly tie: string;
  readonly peer: string;
  readonly kind: string;
  readonly expiry: string;
}

/** Epoch seconds of an ISO stamp column: keeps a category's clock numerically uniform. */
function epochOf(column: string): string {
  return `CAST(strftime('%s', substr(${column}, 1, 19)) AS INTEGER)`;
}

/**
 * A category's metadata list = the UNION of its faces (T14 ruling: 每个可独立选择删除的
 * 私有记录都进元数据列表)。每张脸一个固定 SELECT，列形状一致，ids 带固定前缀防冲突：
 * 新记录 `fact:`/`outbound-fact:`/`asset:`/`asset-source:`/`read-task:` + 真实键；旧表
 * （members 复合键、send/speech/note uuid）保持原 id 不改。元数据只有 id/scope/created/
 * expiry/protected —— 没有正文、blob、URL、path、token、sha、真名或平台消息 ID。
 * source/task 的 scope 从真实 note→event 归属解析；asset 用自己的 scope 列（无 link 也
 * 能列出），它的保护来自"有任一被保护 link"（与 purgeExpiredMediaAssets 同一共享谓词）。
 */
const ITEM_FACES: Readonly<Record<QqStorageCategory, readonly QqStorageItemSource[]>> =
  Object.freeze({
    observation_text: [
      {
        from: "qq_observation_text t JOIN qq_events e ON e.event_key = t.event_key",
        select:
          "t.event_key AS id, e.account_id AS account_id, e.conversation_kind AS kind, e.peer_id AS peer_id, e.agent_id AS agent_id, t.recorded_at AS created_at, t.expires_at AS expires_at, t.occurred_at_seconds AS clock, 0 AS protected",
        clock: "t.occurred_at_seconds",
        tie: "t.event_key",
        peer: "e.peer_id",
        kind: "e.conversation_kind",
        expiry: "t.expires_at",
      },
    ],
    media_notes: [
      {
        from: "qq_media_notes t JOIN qq_events e ON e.event_key = t.event_key",
        select: `t.id AS id, e.account_id AS account_id, e.conversation_kind AS kind, e.peer_id AS peer_id, e.agent_id AS agent_id, t.recorded_at AS created_at, t.expires_at AS expires_at, t.recorded_at AS clock, CASE WHEN ${mediaNoteProtected("t")} THEN 1 ELSE 0 END AS protected`,
        // A media row has no numeric clock; its record time is the category's own ordering key.
        clock: "t.recorded_at",
        tie: "t.id",
        peer: "e.peer_id",
        kind: "e.conversation_kind",
        expiry: "t.expires_at",
      },
      {
        from: "qq_media_assets t",
        select: `'asset:' || t.id AS id, t.account_id AS account_id, t.conversation_kind AS kind, t.peer_id AS peer_id, t.agent_id AS agent_id, t.recorded_at AS created_at, t.expires_at AS expires_at, t.recorded_at AS clock, CASE WHEN EXISTS (SELECT 1 FROM qq_media_asset_sources s WHERE s.asset_id = t.id AND ${mediaAssetSourceProtected("s")}) THEN 1 ELSE 0 END AS protected`,
        clock: "t.recorded_at",
        tie: `'asset:' || t.id`,
        peer: "t.peer_id",
        kind: "t.conversation_kind",
        expiry: "t.expires_at",
      },
      {
        from: "qq_media_asset_sources t JOIN qq_media_notes mn ON mn.id = t.media_note_id JOIN qq_events e ON e.event_key = mn.event_key",
        select: `'asset-source:' || t.id AS id, e.account_id AS account_id, e.conversation_kind AS kind, e.peer_id AS peer_id, e.agent_id AS agent_id, t.recorded_at AS created_at, t.expires_at AS expires_at, t.recorded_at AS clock, CASE WHEN ${mediaAssetSourceProtected("t")} THEN 1 ELSE 0 END AS protected`,
        clock: "t.recorded_at",
        tie: `'asset-source:' || t.id`,
        peer: "e.peer_id",
        kind: "e.conversation_kind",
        expiry: "t.expires_at",
      },
      {
        // 任务账本自带 scope 四列与 expiry（0052）：载体被 purge（SET NULL）后账本行仍在
        // 管理面可见、可归属、可被显式选择删除——LEFT JOIN 不丢孤儿账本行。
        from: "qq_media_read_tasks t LEFT JOIN qq_media_notes mn ON mn.id = t.media_note_id LEFT JOIN qq_events e ON e.event_key = mn.event_key",
        select: `'read-task:' || t.id AS id, t.account_id AS account_id, t.conversation_kind AS kind, t.peer_id AS peer_id, t.agent_id AS agent_id, t.recorded_at AS created_at, t.expires_at AS expires_at, t.recorded_at AS clock, CASE WHEN t.status = 'running' THEN 1 ELSE 0 END AS protected`,
        clock: "t.recorded_at",
        tie: `'read-task:' || t.id`,
        peer: "t.peer_id",
        kind: "t.conversation_kind",
        expiry: "t.expires_at",
      },
    ],
    speech: [
      {
        from: "qq_speech_log t",
        select:
          "t.id AS id, t.account_id AS account_id, t.conversation_kind AS kind, t.peer_id AS peer_id, t.agent_id AS agent_id, t.recorded_at AS created_at, t.expires_at AS expires_at, t.spoke_at_seconds AS clock, 0 AS protected",
        clock: "t.spoke_at_seconds",
        tie: "t.id",
        peer: "t.peer_id",
        kind: "t.conversation_kind",
        expiry: "t.expires_at",
      },
    ],
    sends: [
      {
        from: "qq_send_log t",
        select: `t.id AS id, t.account_id AS account_id, t.conversation_kind AS kind, t.peer_id AS peer_id, t.agent_id AS agent_id, t.recorded_at AS created_at, t.expires_at AS expires_at, t.sent_at_seconds AS clock, CASE WHEN ${sendProtected("t")} THEN 1 ELSE 0 END AS protected`,
        clock: "t.sent_at_seconds",
        tie: "t.id",
        peer: "t.peer_id",
        kind: "t.conversation_kind",
        expiry: "t.expires_at",
      },
      {
        // The outbound identity snapshot's scope lives in the intent's fixed target JSON
        // (account/kind/peer ids only, json_extract on a fixed path — no content).
        from: "qq_outbound_message_facts t JOIN outbound_intents i ON i.id = t.intent_id",
        select: `'outbound-fact:' || t.intent_id AS id, t.account_id AS account_id, json_extract(i.target,'$.conversationKind') AS kind, json_extract(i.target,'$.peerId') AS peer_id, t.agent_id AS agent_id, i.created_at AS created_at, t.expires_at AS expires_at, ${epochOf("i.created_at")} AS clock, CASE WHEN ${qqOutboundMessageFactProtected("t")} THEN 1 ELSE 0 END AS protected`,
        clock: epochOf("i.created_at"),
        tie: `'outbound-fact:' || t.intent_id`,
        peer: `json_extract(i.target,'$.peerId')`,
        kind: `json_extract(i.target,'$.conversationKind')`,
        expiry: "t.expires_at",
      },
    ],
    nicknames: [
      {
        from: "qq_members t",
        select: `${nicknameId("t")} AS id, t.account_id AS account_id, t.conversation_kind AS kind, t.peer_id AS peer_id, NULL AS agent_id, strftime('%Y-%m-%dT%H:%M:%S.000000Z', t.first_seen_at_seconds, 'unixepoch') AS created_at, t.expires_at AS expires_at, t.last_seen_at_seconds AS clock, 0 AS protected`,
        clock: "t.last_seen_at_seconds",
        tie: nicknameId("t"),
        peer: "t.peer_id",
        kind: "t.conversation_kind",
        expiry: "t.expires_at",
      },
      {
        from: "qq_message_facts t JOIN qq_events e ON e.event_key = t.event_key",
        select: `'fact:' || t.event_key AS id, e.account_id AS account_id, e.conversation_kind AS kind, e.peer_id AS peer_id, e.agent_id AS agent_id, t.recorded_at AS created_at, t.expires_at AS expires_at, ${epochOf("t.recorded_at")} AS clock, CASE WHEN ${qqMessageFactProtected("t")} THEN 1 ELSE 0 END AS protected`,
        clock: epochOf("t.recorded_at"),
        tie: `'fact:' || t.event_key`,
        peer: "e.peer_id",
        kind: "e.conversation_kind",
        expiry: "t.expires_at",
      },
    ],
  });

function readCount(db: Database, sql: string, params: readonly (string | number)[]): number {
  const row = db.query(sql).get(...params) as { n: number } | null | undefined;
  return Number(row?.n ?? 0);
}

/**
 * One page of metadata for one category, newest first, `limit` capped by the contract
 * (1..100). The category's faces are UNIONed and ordered `(clock DESC, id DESC)` so the
 * `(clock, id)` cursor stays stable across every face while rows are inserted; only
 * expired/live is judged by the server clock passed in.
 */
export function qqStorageItemsPage(
  orm: Orm,
  query: QqStorageItemsQuery,
  now: string = nowIso(),
): QqStorageItemsPage {
  const faces = ITEM_FACES[query.category];
  const db = clientOf(orm);

  // Each face's conditions reference its own aliases, so the filters are closures over the
  // face — the SAME semantics for every face, applied to that face's fixed expressions.
  const statusFilter =
    query.status === "live"
      ? (face: QqStorageItemSource) => `${face.expiry} > ?`
      : query.status === "expired"
        ? (face: QqStorageItemSource) => `${face.expiry} <= ?`
        : null;
  const baseFilters: readonly ((face: QqStorageItemSource) => string)[] = [
    ...(statusFilter ? [statusFilter] : []),
    ...(query.peerId !== undefined ? [(face: QqStorageItemSource) => `${face.peer} = ?`] : []),
    ...(query.kind !== undefined ? [(face: QqStorageItemSource) => `${face.kind} = ?`] : []),
  ];
  const baseParams: (string | number)[] = [];
  if (statusFilter) baseParams.push(now);
  if (query.peerId !== undefined) baseParams.push(query.peerId);
  if (query.kind !== undefined) baseParams.push(query.kind);

  const unionOf = (
    extra: (face: QqStorageItemSource) => string,
    extraParams: readonly (string | number)[],
  ): { sql: string; params: (string | number)[] } =>
    faces.reduce<{ sql: string; params: (string | number)[] }>(
      (acc, face) => {
        const conditions = [...baseFilters.map((f) => f(face)), extra(face)].filter(
          (c) => c.length > 0,
        );
        const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
        const part = `SELECT ${face.select} FROM ${face.from}${where}`;
        return {
          sql: acc.sql.length > 0 ? `${acc.sql} UNION ALL ${part}` : part,
          params: [...acc.params, ...baseParams, ...extraParams],
        };
      },
      { sql: "", params: [] },
    );

  const totalUnion = unionOf(() => "", []);
  const total = readCount(db, `SELECT COUNT(*) AS n FROM (${totalUnion.sql})`, totalUnion.params);

  const cursorFilter = (face: QqStorageItemSource) =>
    query.cursor === undefined
      ? ""
      : `(${face.clock} < ? OR (${face.clock} = ? AND ${face.tie} < ?))`;
  const cursorParams =
    query.cursor === undefined ? [] : [query.cursor.clock, query.cursor.clock, query.cursor.id];
  const pageUnion = unionOf(cursorFilter, cursorParams);
  const rows = db
    .query(`SELECT * FROM (${pageUnion.sql}) ORDER BY clock DESC, id DESC LIMIT ?`)
    .all(...pageUnion.params, query.limit + 1) as QqStorageItemRow[];
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
          kind: row.kind as "group" | "private",
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

export interface QqStorageCleanupExecution {
  /** The selection's numbers at request time (what the preview showed). */
  readonly counts: QqStorageCleanupCounts;
  /** Rows actually deleted. */
  readonly removed: number;
}

/**
 * One face of a category's selection closure: an independently selectable primary record
 * (T14 ruling: 管理主行＝每个可独立选择删除的私有记录). Fixed text only — request values
 * bind as parameters, never splice into SQL. `idOf` is the prefixed stable id compared
 * against request ids (= the list's exported id); the prefix (`fact:` / `outbound-fact:` /
 * `asset:` / `asset-source:` / `read-task:`) makes ids collision-proof, and a foreign
 * category's prefix can never match this face's rows, so a selection can never borrow its
 * way into another record type.
 */
interface CleanupFace {
  readonly table: string;
  readonly idOf: (alias: string) => string;
  readonly expiryOf: (alias: string) => string;
  /** Fixed protection predicate; null means every expired row of the face is removable. */
  readonly protectionOf: (alias: string) => string | null;
}

const simpleFace = (
  table: string,
  idOf: (alias: string) => string,
  protectionOf: (alias: string) => string | null = () => null,
): CleanupFace => ({ table, idOf, expiryOf: (a) => `${a}.expires_at`, protectionOf });

/** An asset is deletable only when NONE of its source links is protected (shared predicate). */
function assetProtection(alias: string): string {
  return `EXISTS (SELECT 1 FROM qq_media_asset_sources s
      WHERE s.asset_id = ${alias}.id AND ${mediaAssetSourceProtected("s")})`;
}

/**
 * The five categories' faces. Independent faces (members+facts, sends+outbound facts) have
 * no foreign keys between them — both are roots. `media_notes` has real parent→child
 * cascades (note→tasks/sources, asset→sources/variants/classifications, source→tasks), so
 * its execute pre-determines the doom set (below) instead of deleting parents first and
 * over-counting the cascade.
 */
const CLEANUP_FACES: Readonly<Record<QqStorageCategory, readonly CleanupFace[]>> = Object.freeze({
  observation_text: [simpleFace("qq_observation_text", (a) => `${a}.event_key`)],
  speech: [simpleFace("qq_speech_log", (a) => `${a}.id`)],
  nicknames: [
    simpleFace("qq_members", (a) => nicknameId(a)),
    simpleFace("qq_message_facts", (a) => `'fact:' || ${a}.event_key`, qqMessageFactProtected),
  ],
  sends: [
    simpleFace("qq_send_log", (a) => `${a}.id`, sendProtected),
    simpleFace(
      "qq_outbound_message_facts",
      (a) => `'outbound-fact:' || ${a}.intent_id`,
      qqOutboundMessageFactProtected,
    ),
  ],
  media_notes: [
    simpleFace("qq_media_notes", (a) => `${a}.id`, mediaNoteProtected),
    simpleFace("qq_media_assets", (a) => `'asset:' || ${a}.id`, assetProtection),
    simpleFace(
      "qq_media_asset_sources",
      (a) => `'asset-source:' || ${a}.id`,
      mediaAssetSourceProtected,
    ),
    simpleFace(
      "qq_media_read_tasks",
      (a) => `'read-task:' || ${a}.id`,
      (a) => `${a}.status = 'running'`,
    ),
  ],
});

/** The ids condition; `undefined` = whole face, `[]` = match nothing (fail closed). */
function selectionScope(
  face: CleanupFace,
  alias: string,
  ids: readonly string[] | undefined,
): { sql: string; params: string[] } {
  if (ids === undefined) return { sql: "", params: [] };
  if (ids.length === 0) return { sql: "0", params: [] };
  return {
    sql: `${face.idOf(alias)} IN (${ids.map(() => "?").join(", ")})`,
    params: [...ids],
  };
}

/**
 * The parent-delete conditions the media_notes doom set is derived from. Each is the exact
 * DELETE predicate of that parent face (expired + unprotected + in the selection), shared
 * by every child's doom derivation — one definition, evaluated per row.
 */
function deletedNoteCond(alias: string, ids: readonly string[] | undefined, now: string) {
  const scope = selectionScope(CLEANUP_FACES.media_notes[0], alias, ids);
  return {
    sql: `(${alias}.expires_at <= ? AND NOT (${mediaNoteProtected(alias)})${
      scope.sql ? ` AND ${scope.sql}` : ""
    })`,
    params: [now, ...scope.params],
  };
}

function deletedAssetCond(alias: string, ids: readonly string[] | undefined, now: string) {
  const scope = selectionScope(CLEANUP_FACES.media_notes[1], alias, ids);
  return {
    sql: `(${alias}.expires_at <= ? AND NOT (${assetProtection(alias)})${
      scope.sql ? ` AND ${scope.sql}` : ""
    })`,
    params: [now, ...scope.params],
  };
}

/**
 * The per-face cascade-doom condition for `media_notes`: true when the row will leave via
 * another selected row's FK cascade, so it is removed from matched/expired/protected/
 * removable up front (preview computes the same) and never explicitly deleted — the ruling's
 * "root selection" keeps `removed == removable == preview` while real FK cascades do the
 * physical child removal. Protected rows are never doomed: a note delete requires no
 * running task on it, an asset delete requires no protected link, a source delete requires
 * no running task — the shared predicates already fail closed.
 */
function doomCondOf(
  face: CleanupFace,
  ids: readonly string[] | undefined,
  now: string,
): { sql: string; params: (string | number)[] } {
  if (face.table === "qq_media_asset_sources") {
    const asset = deletedAssetCond("da", ids, now);
    const note = deletedNoteCond("dn", ids, now);
    return {
      sql: `(EXISTS (SELECT 1 FROM qq_media_assets da WHERE da.id = {alias}.asset_id AND ${asset.sql})
        OR EXISTS (SELECT 1 FROM qq_media_notes dn WHERE dn.id = {alias}.media_note_id AND ${note.sql}))`,
      params: [...asset.params, ...note.params],
    };
  }
  // qq_media_read_tasks：载体列 ON DELETE SET NULL——note/source/asset 的删除不再级联
  // 带走任务账本（预算不随载体清理消失），任务行只会被 read-task: 前缀的显式选择删除。
  return { sql: "", params: [] };
}

function countRowsWhere(
  db: Database,
  table: string,
  where: string,
  params: readonly (string | number)[],
): number {
  const clause = where.length > 0 ? ` WHERE ${where}` : "";
  return readCount(db, `SELECT COUNT(*) AS n FROM ${table}${clause}`, params);
}

/**
 * The category's counts over its root selection: matched/expired/protected are summed over
 * the faces the ids can address (foreign-prefix ids match no face), with cascade-doomed
 * descendants excluded from every number — `removable = expired - protected` and
 * `removed = removable` both stay exact identities of the explicit deletes.
 */
function selectionCounts(
  db: Database,
  selection: QqStorageCleanupSelection,
  now: string,
): QqStorageCleanupCounts {
  let matched = 0;
  let expired = 0;
  let protectedCount = 0;
  for (const face of CLEANUP_FACES[selection.category]) {
    const alias = face.table;
    const scope = selectionScope(face, alias, selection.ids);
    const rawDoom = doomCondOf(face, selection.ids, now);
    const doomSql = rawDoom.sql.split("{alias}").join(alias);
    const base = [...scope.params, ...rawDoom.params];
    const conditions = (extra: readonly string[]) => [
      ...(scope.sql ? [scope.sql] : []),
      ...(doomSql ? [`NOT ${doomSql}`] : []),
      ...extra,
    ];
    const count = (extra: readonly string[], extraParams: (string | number)[] = []) =>
      countRowsWhere(db, face.table, conditions(extra).join(" AND "), [...base, ...extraParams]);
    matched += count([]);
    expired += count([`${face.expiryOf(alias)} <= ?`], [now]);
    const protection = face.protectionOf(alias);
    if (protection) {
      protectedCount += count([`${face.expiryOf(alias)} <= ?`, protection], [now]);
    }
  }
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

/**
 * Delete the selected expired root rows in one immediate transaction: the counts and the
 * deletion see the same database state, so `removable` can never promise a different number
 * than `removed`. A protected row is never deleted, whichever shape the selection has, and
 * nothing outside the category's faces is touched — identities (qq_events), schemes,
 * bindings and sticker material have no face here.
 */
export function qqStorageCleanupExecute(
  orm: Orm,
  selection: QqStorageCleanupSelection,
  now: string = nowIso(),
): QqStorageCleanupExecution {
  const faces = CLEANUP_FACES[selection.category];
  const db = clientOf(orm);
  return immediate(db, () => {
    const counts = selectionCounts(db, selection, now);
    let removed = 0;
    // All doomed counts are read before any DELETE; explicit deletes then run child-first
    // (media_notes faces are ordered task → source → asset → note) so a parent's cascade can
    // only ever remove rows the doom set already excluded.
    const statements = faces.map((face) => {
      const alias = face.table;
      const scope = selectionScope(face, alias, selection.ids);
      const rawDoom = doomCondOf(face, selection.ids, now);
      const doomSql = rawDoom.sql.split("{alias}").join(alias);
      const conditions = [
        `${face.expiryOf(alias)} <= ?`,
        ...(face.protectionOf(alias) ? [`NOT (${face.protectionOf(alias)})`] : []),
        ...(scope.sql ? [scope.sql] : []),
        ...(doomSql ? [`NOT ${doomSql}`] : []),
      ];
      const where = `WHERE ${conditions.join(" AND ")}`;
      const params = [now, ...scope.params, ...rawDoom.params];
      const doomed = readCount(db, `SELECT COUNT(*) AS n FROM ${face.table} ${where}`, params);
      return { face, where, params, doomed };
    });
    // Freeze each face's exact target primary keys from the same predicates the counts used, BEFORE any
    // transition/delete: the revocation helper below (and the deletes) then consume the SAME frozen sets,
    // so a helper's task-expiry change can never pull unselected rows into a delete, and
    // preview.removable === removed stays the frozen contract.
    const frozenIds = statements.map(({ face, where, params }) => {
      // Freeze by rowid (stable within this transaction, unique per table): the face's own
      // idOf carries a request-facing prefix, so the bare delete key differs per face — rowid is
      // the one handle that is exact for every face and immune to the helper's UPDATE.
      const rows = db.query(`SELECT rowid AS id FROM ${face.table} ${where}`).all(...params) as {
        id: string | number;
      }[];
      return rows.map((row) => String(row.id));
    });
    // Source-death result transition (same immediate transaction, BEFORE any delete): every source row this
    // selection deletes — directly, or by asset/note cascade — ends the consumed result of every task bound
    // to it via asset_source_id. Budget identity/attempts/scope survive; refs freeze their pre-transition
    // revision. Preview counts are unaffected (this UPDATE touches task rows, never the counted faces).
    if (selection.category === "media_notes") {
      const [, assetStmt, sourceStmt, noteStmt] = [
        statements[0],
        statements[1],
        statements[2],
        statements[0],
      ];
      void assetStmt;
      void noteStmt;
      const doomed = new Set<string>();
      // The helper needs the REAL source ids (uuid), not the frozen rowids:
      // (1) the source face's own doomed rows;
      for (const row of db
        .query(
          `SELECT qq_media_asset_sources.id FROM qq_media_asset_sources
          WHERE ${sourceStmt.where.slice("WHERE ".length)}`,
        )
        .all(...sourceStmt.params) as { id: string }[]) {
        doomed.add(row.id);
      }
      // (2) sources cascading away with the doomed ASSETS (live-window sources included);
      if (frozenIds[1].length > 0) {
        for (const row of db
          .query(
            `SELECT qq_media_asset_sources.id FROM qq_media_asset_sources
            JOIN qq_media_assets ON qq_media_assets.id = qq_media_asset_sources.asset_id
            WHERE ${assetStmt.where.slice("WHERE ".length)}`,
          )
          .all(...assetStmt.params) as { id: string }[]) {
          doomed.add(row.id);
        }
      }
      // (3) sources cascading away with the doomed NOTES.
      if (frozenIds[0].length > 0) {
        for (const row of db
          .query(
            `SELECT qq_media_asset_sources.id FROM qq_media_asset_sources
            JOIN qq_media_notes ON qq_media_notes.id = qq_media_asset_sources.media_note_id
            WHERE ${noteStmt.where.slice("WHERE ".length)}`,
          )
          .all(...noteStmt.params) as { id: string }[]) {
          doomed.add(row.id);
        }
      }
      revokeMediaReadTaskResultsForSources(orm, [...doomed], now);
    }
    for (let index = 0; index < statements.length; index += 1) {
      const { face, doomed } = statements[index];
      const ids = frozenIds[index];
      if (ids.length > 0) {
        db.query(`DELETE FROM ${face.table} WHERE rowid IN (${ids.map(() => "?").join(", ")})`).run(
          ...ids,
        );
      }
      // `changes` would also count rows removed through the foreign keys (task/source
      // cascades, speech bodies, send parts); the count of the face's own frozen rows is
      // what `removed` means, matching the existing purge helpers.
      removed += doomed;
    }
    return { counts, removed };
  });
}
