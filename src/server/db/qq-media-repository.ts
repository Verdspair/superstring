// Media attachments: storage (ADR0018 P4b / 0012_qq_media_notes.sql).
//
// The row is keyed by the message's permanent dedup identity plus the segment's position,
// so a re-delivery of the same message cannot create a second reading of the same picture.
// Nothing here fetches or reads anything: this module only remembers what was read, how
// many attempts it took, and which model produced the note.

import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, lte, sql } from "drizzle-orm";
import { fail } from "../errors";
import { parseQqMediaKind, type QqMediaKind } from "../services/qq-media-contract";
import { mediaCacheExpiresAt } from "../services/qq-retention";
import {
  findMediaReadTasksForContent,
  findServableMediaReadTaskByIdentity,
  type QqMediaReadPurpose,
  revokeMediaReadTaskResultsForSources,
} from "./qq-media-task-repository";
import { readQqRetentionDays } from "./qq-settings-repository";
import { nowIso, type Orm } from "./repositories";
import * as schema from "./schema";

export type QqMediaNoteRow = typeof schema.qqMediaNotes.$inferSelect;

export interface MediaSegmentRef {
  readonly eventKey: string;
  readonly segmentIndex: number;
  readonly kind: QqMediaKind;
  /** True once a description exists: a cycle skips it rather than spending an attempt. */
  readonly described?: boolean;
}

function requireWholeSegment(input: MediaSegmentRef): void {
  if (!Number.isInteger(input.segmentIndex) || input.segmentIndex < 0) {
    throw new TypeError("Invalid QQ media segment input");
  }
}

/**
 * Remember that a message carried a media segment at this position.
 *
 * Idempotent: the same position yields the same row, because a re-delivered message must
 * not fork into two readings. A position that is re-described as a *different* kind or a
 * different reference is refused rather than merged — the identity of a segment is what a
 * note hangs off, and letting it change would attach a description to the wrong thing.
 * The window defaults to the stored setting (read per write).
 */
export function recordMediaSegment(
  orm: Orm,
  input: MediaSegmentRef & {
    sourceRef: string;
    occurredAtSeconds: number;
    /** Was the carrying message addressed to the assistant? Required: §7.2 retries only these. */
    addressed: boolean;
  },
  retentionDays: number = readQqRetentionDays(orm),
): QqMediaNoteRow {
  requireWholeSegment(input);
  const kind = parseQqMediaKind(input.kind);
  if (input.sourceRef.trim().length === 0) {
    throw new TypeError("Invalid QQ media segment input");
  }
  const existing = mediaNoteRow(orm, input.eventKey, input.segmentIndex);
  if (existing) {
    if (existing.segmentKind !== kind || existing.sourceRef !== input.sourceRef) {
      fail("MEMORY_SOURCE_INVALID", "同一媒体位置描述了不同内容，拒绝覆盖");
    }
    return existing;
  }
  const row = orm
    .insert(schema.qqMediaNotes)
    .values({
      id: crypto.randomUUID(),
      eventKey: input.eventKey,
      segmentIndex: input.segmentIndex,
      segmentKind: kind,
      sourceRef: input.sourceRef,
      note: null,
      noteModel: null,
      attempts: 0,
      addressed: input.addressed ? 1 : 0,
      expiresAt: mediaCacheExpiresAt(input.occurredAtSeconds, retentionDays),
      recordedAt: nowIso(),
      updatedAt: nowIso(),
    })
    .onConflictDoNothing()
    .returning()
    .get();
  if (row) return row;
  const raced = mediaNoteRow(orm, input.eventKey, input.segmentIndex);
  if (!raced) fail("DATABASE_UNAVAILABLE", "数据服务暂不可用，请检查数据库", 503);
  return raced;
}

/**
 * The media segments one message carried, in the order they appeared.
 *
 * The reading cycle needs them because the intake stores a row per segment and nothing else
 * remembers the positions: re-parsing the event would be a second interpretation of the same
 * message, and the rows are already the first one.
 */
export function mediaSegmentsForEvent(orm: Orm, eventKey: string): MediaSegmentRef[] {
  return orm
    .select({
      eventKey: schema.qqMediaNotes.eventKey,
      segmentIndex: schema.qqMediaNotes.segmentIndex,
      kind: schema.qqMediaNotes.segmentKind,
      note: schema.qqMediaNotes.note,
    })
    .from(schema.qqMediaNotes)
    .where(eq(schema.qqMediaNotes.eventKey, eventKey))
    .orderBy(asc(schema.qqMediaNotes.segmentIndex))
    .all()
    .map((row) =>
      Object.freeze({
        eventKey: row.eventKey,
        segmentIndex: row.segmentIndex,
        kind: parseQqMediaKind(row.kind),
        described: row.note !== null,
      }),
    );
}

/**
 * An earlier message from the same speaker whose media was attempted and failed, so a later
 * message from that person can wake one more understanding (§7.1, P5m).
 *
 * The user's decision (2026-09-24) is what makes this query simple: a "related supplement" is the
 * SAME SPEAKER within the scheme's window, so the facts needed are the speaker, the conversation
 * and a time bound — no text matching, no model call, and nothing to guess. `beforeSeconds` keeps
 * the message being handled out of its own answer, and `excludeEventKey` guards the same thing
 * against a clock with one-second resolution.
 *
 * Returns `null` when nothing is waiting, which is the normal case.
 */
export function pendingMediaSupplementFor(
  orm: Orm,
  input: {
    accountId: string;
    conversationKind: "group" | "private";
    peerId: string;
    sinceSeconds: number;
    beforeSeconds: number;
    excludeEventKey: string;
  },
  /** The caller's real ISO `at` (host clock injected); defaults to the storage clock. */
  at: string = nowIso(),
): { eventKey: string; segmentIndex: number } | null {
  // 2026-09-25 后续：不再要求"原图是被@的"。重试的"许可"改由当下这次消息是否被叫到决定；
  // 这里只负责"最近有一次真正失败的读取"——与开口闸同一份 typed 账本真源（failed-only 口径，
  // 在途不是失败），次数上限（两次）仍然是硬闸门。
  const windowEvents = orm
    .select({ eventKey: schema.qqEvents.eventKey })
    .from(schema.qqEvents)
    .where(
      and(
        eq(schema.qqEvents.accountId, input.accountId),
        eq(schema.qqEvents.conversationKind, input.conversationKind),
        eq(schema.qqEvents.peerId, input.peerId),
        eq(schema.qqEvents.speakerKind, "member"),
        gte(schema.qqEvents.occurredAtSeconds, input.sinceSeconds),
        lt(schema.qqEvents.occurredAtSeconds, input.beforeSeconds),
      ),
    )
    .all()
    .map((row) => row.eventKey);
  const blockedIds = blockedMediaNoteIds(orm, windowEvents, at, false);
  if (blockedIds.size === 0) return null;
  const rows = orm
    .select({
      id: schema.qqMediaNotes.id,
      eventKey: schema.qqMediaNotes.eventKey,
      segmentIndex: schema.qqMediaNotes.segmentIndex,
      occurredAtSeconds: schema.qqEvents.occurredAtSeconds,
    })
    .from(schema.qqMediaNotes)
    .innerJoin(schema.qqEvents, eq(schema.qqEvents.eventKey, schema.qqMediaNotes.eventKey))
    .where(
      and(
        eq(schema.qqEvents.accountId, input.accountId),
        eq(schema.qqEvents.conversationKind, input.conversationKind),
        eq(schema.qqEvents.peerId, input.peerId),
        gte(schema.qqEvents.occurredAtSeconds, input.sinceSeconds),
        lt(schema.qqEvents.occurredAtSeconds, input.beforeSeconds),
      ),
    )
    .orderBy(desc(schema.qqEvents.occurredAtSeconds), asc(schema.qqMediaNotes.segmentIndex))
    .all();
  const target = rows.find(
    (row) => blockedIds.has(row.id) && row.eventKey !== input.excludeEventKey,
  );
  if (!target) return null;
  return Object.freeze({ eventKey: target.eventKey, segmentIndex: target.segmentIndex });
}

/**
 * 「试过但没读出」的单一 SQL 谓词真源（T08 Step5 迁移，spec §8.1）：主动开口闸门与补充候选
 * 问的是**同一份真实读取任务状态**，判据只有这一份。
 *
 * 一行媒体算「试过但没读出」当且仅当（按调用方给的真实 ISO `at` 判窗，绝不取宿主当前钟）：
 *
 *  1. **typed 账本**：有一个窗口还活着的 `running`／`failed` 读取任务挂在它名下——typed 失败
 *     只写 `qq_media_read_tasks`、不写媒体行的 `attempts`，所以旧投影数不到它；在途按
 *     fail closed 与失败同闸。
 *  2. **legacy 行级失败**：`attempts > 0` 且仍无描述——迁移前的失败记录**永不归零、永不删除**。
 *  3. **有效解除**：上述任一成立、但同一个媒体位置已有一个窗口还活着的 `succeeded` 任务
 *     （真实描述、真实归属）时，这一行不再算失败——旧失败记录保留，新任务成功按真实状态放行
 *     （spec §8.1：原生正常 model call 不是 description attempt，本谓词也从不看「本轮是否
 *     native 读取」来造状态）。
 *
 * `includeRunning` 是同一真源上的两个只读口径：主动开口闸门（`attemptedUnreadMediaCount`）
 * 在途也按住；补充候选（`pendingMediaSupplementFor`）只要**真正失败过**的（第 2 次尝试须
 * 更晚相关补充，在途不是失败）。
 *
 * **只算图片**：语音与视频在这一版**设计上永远读不出来**（转写协议未定、
 * 没有视频解码器），把它们算进"失败"等于永久按住两条主动路径——用户报告"自主接话从不触发"时，
 * 这一条正是原因之一。判据因此是"本来读得出来却失败了"，而不是"这条媒体没有描述"。
 */
function unreadMediaCondition(at: string, includeRunning: boolean) {
  // Content-identity bridges are relational, never guessed from source-ref strings: an asset
  // is unique per scope+sha (uq_qq_media_asset_scope_sha), so two rows whose asset-source links
  // resolve to the SAME asset id carry the SAME content in the SAME scope. A task with a NULL
  // asset_source_id (nothing minted yet) only matches through its carrier row.
  //
  // A blocking task is unresolved only by a success of the SAME purpose (a detail success answers
  // a detail task, never a baseline one; a legacy row-level failure is baseline-shaped) carrying a
  // genuinely readable result (note AND model non-empty, live window, ledger scope pinned to the
  // carrying event) — never by a bare `succeeded` status. A running task is never resolved.
  const pinScope = (alias: string) =>
    sql`${sql.raw(alias)}.account_id = ev.account_id AND ${sql.raw(alias)}.conversation_kind = ev.conversation_kind
        AND ${sql.raw(alias)}.peer_id = ev.peer_id AND ${sql.raw(alias)}.agent_id = ev.agent_id`;
  const sameContentAsNote = (alias: string) => sql`(
          ${sql.raw(alias)}.media_note_id = ${schema.qqMediaNotes.id}
          OR (
            ${sql.raw(alias)}.asset_source_id IS NOT NULL
            AND (SELECT s0.asset_id FROM qq_media_asset_sources s0 WHERE s0.media_note_id = ${schema.qqMediaNotes.id}) IS NOT NULL
            AND (SELECT s1.asset_id FROM qq_media_asset_sources s1 WHERE s1.id = ${sql.raw(alias)}.asset_source_id)
              = (SELECT s0.asset_id FROM qq_media_asset_sources s0 WHERE s0.media_note_id = ${schema.qqMediaNotes.id})
          )
        )`;
  const realResult = (alias: string) =>
    sql`${sql.raw(alias)}.note IS NOT NULL AND ${sql.raw(alias)}.model_name IS NOT NULL`;
  // st resolves rt when it answers the SAME content with the SAME purpose and a real, live result.
  const resolvedBy = sql`AND NOT EXISTS (SELECT 1 FROM qq_media_read_tasks st
          WHERE st.purpose = rt.purpose
            AND (rt.purpose = 'baseline' OR st.question_key = rt.question_key)
            AND st.status = 'succeeded'
            AND st.expires_at > ${at}
            AND ${realResult("st")}
            AND ${pinScope("st")}
            AND (
              st.media_note_id = rt.media_note_id
              OR (
                st.asset_source_id IS NOT NULL AND rt.asset_source_id IS NOT NULL
                AND (SELECT s3.asset_id FROM qq_media_asset_sources s3 WHERE s3.id = st.asset_source_id)
                  = (SELECT s4.asset_id FROM qq_media_asset_sources s4 WHERE s4.id = rt.asset_source_id)
              )
            ))`;
  const liveBlockingTask = sql`EXISTS (SELECT 1 FROM qq_media_read_tasks rt
      JOIN qq_events ev ON ev.event_key = ${schema.qqMediaNotes.eventKey}
      WHERE ${sameContentAsNote("rt")}
        AND rt.expires_at > ${at}
        AND ${pinScope("rt")}
        AND rt.status ${includeRunning ? sql`IN ('running', 'failed')` : sql`= 'failed'`}
        ${resolvedBy})`;
  // The legacy row-level failure is baseline-shaped: only a live succeeded BASELINE task over the
  // same content (carrier or asset bridge) with a real readable result resolves it.
  const legacyResolved = sql`EXISTS (SELECT 1 FROM qq_media_read_tasks lb
      JOIN qq_events ev ON ev.event_key = ${schema.qqMediaNotes.eventKey}
      WHERE ${sameContentAsNote("lb")}
        AND lb.purpose = 'baseline'
        AND lb.status = 'succeeded'
        AND lb.expires_at > ${at}
        AND ${realResult("lb")}
        AND ${pinScope("lb")})`;
  return and(
    eq(schema.qqMediaNotes.segmentKind, "image"),
    gt(schema.qqMediaNotes.expiresAt, at),
    sql`(
      (
        (${schema.qqMediaNotes.attempts} > 0 AND ${schema.qqMediaNotes.note} IS NULL AND NOT ${legacyResolved})
        OR ${liveBlockingTask}
      )
    )`,
  );
}

/**
 * `eventKeys` 里有多少项媒体是「试过但没读出」。
 *
 * 主动开口（自主接话、冷场发起）用它做闸门：一张试过却没读懂的图意味着助手并不知道自己要
 * 接的是什么事，§7.1 又禁止假装知道，于是宁可不开口。窗口由调用方给——这里只数这些消息上的行，
 * 不猜"哪一批算本轮"。
 */
/**
 * Same-content identity lookup (one controlled read-only pass over the ledger): a note whose
 * live asset can answer for the bytes re-derives its TRUE identity keys through the taskrepo's
 * single key function — never a second hash rule, never a sourceRef guess. A task whose stored
 * identity_key equals a derived key belongs to the SAME content in the SAME scope, wherever its
 * carrier row drifted; `asset_source_id` may be NULL in production and is never the join key.
 * A blocking identity match is resolved only by a succeeded task of the SAME identity_key with a
 * genuinely readable result (note AND model, live window). The SQL predicate above stays the
 * single truth for carrier-attached tasks, legacy failures and the relational asset bridge.
 */
function blockedMediaNoteIds(
  orm: Orm,
  eventKeys: readonly string[],
  at: string,
  includeRunning: boolean,
): Set<string> {
  const blocked = new Set<string>();
  if (eventKeys.length === 0) return blocked;
  // (a) the SQL predicate truth: carrier-attached tasks, legacy row-level failures and the
  // relational asset bridge — scope-pinned, window-live, purpose-matched resolution.
  for (const row of orm
    .select({ id: schema.qqMediaNotes.id })
    .from(schema.qqMediaNotes)
    .where(
      and(
        inArray(schema.qqMediaNotes.eventKey, [...eventKeys]),
        unreadMediaCondition(at, includeRunning),
      ),
    )
    .all()) {
    blocked.add(row.id);
  }
  // (b) the unified all-state content list (task-repo owner's read-only interface): every real
  // ledger row for THIS content in THIS scope, all purposes/questions (identity-NULL legacy rows are
  // never returned). Blocking = live-window rows that are running/failed (failed-only for the
  // candidate view); resolution of each = the controlled servable lookup with THAT row's own recorded
  // model/policy (succeeded + readable + window live) — window-blind rows are never read as successes.
  // A note without a live asset to answer for the bytes gets no derived key (no sourceRef guessing).
  const notes = orm
    .select({
      id: schema.qqMediaNotes.id,
      accountId: schema.qqEvents.accountId,
      conversationKind: schema.qqEvents.conversationKind,
      peerId: schema.qqEvents.peerId,
      agentId: schema.qqEvents.agentId,
      attempts: schema.qqMediaNotes.attempts,
      note: schema.qqMediaNotes.note,
      contentSha256: schema.qqMediaAssets.contentSha256,
    })
    .from(schema.qqMediaNotes)
    .innerJoin(schema.qqEvents, eq(schema.qqEvents.eventKey, schema.qqMediaNotes.eventKey))
    .leftJoin(
      schema.qqMediaAssetSources,
      eq(schema.qqMediaAssetSources.mediaNoteId, schema.qqMediaNotes.id),
    )
    .leftJoin(
      schema.qqMediaAssets,
      and(
        eq(schema.qqMediaAssets.id, schema.qqMediaAssetSources.assetId),
        gt(schema.qqMediaAssets.expiresAt, at),
      ),
    )
    .where(
      and(
        inArray(schema.qqMediaNotes.eventKey, [...eventKeys]),
        eq(schema.qqMediaNotes.segmentKind, "image"),
        gt(schema.qqMediaNotes.expiresAt, at),
      ),
    )
    .all();
  for (const n of notes) {
    if (n.contentSha256 === null) continue;
    const identity = {
      accountId: n.accountId,
      conversationKind: n.conversationKind,
      peerId: n.peerId,
      agentId: n.agentId,
      segmentKind: "image",
      contentSha256: n.contentSha256,
    };
    const rows = findMediaReadTasksForContent(orm, identity);
    const open = rows.filter(
      (row) =>
        Date.parse(row.expiresAt) > Date.parse(at) &&
        (includeRunning
          ? row.status === "running" || row.status === "failed"
          : row.status === "failed"),
    );
    const unresolved = open.some((row) => {
      if (row.status === "succeeded") return false;
      // The typed ledger only stores baseline/detail (schema CHECK); an out-of-band unknown
      // purpose is fail-closed: it never resolves through a servable result, so the note
      // stays blocked instead of untyped data releasing the failed gate.
      const purpose: QqMediaReadPurpose | null =
        row.purpose === "baseline" || row.purpose === "detail" ? row.purpose : null;
      if (purpose === null) return true;
      const served = findServableMediaReadTaskByIdentity(orm, {
        ...identity,
        purpose,
        questionKey: row.questionKey,
        modelName: row.modelName ?? "",
        policy: row.policy,
        now: at,
      });
      return served === null;
    });
    if (unresolved) {
      blocked.add(n.id);
      continue;
    }
    // A legacy row-level failure is baseline-shaped: a servable baseline success resolves it.
    if (n.attempts > 0 && n.note === null) {
      const servedBaseline = rows.some(
        (row) => row.purpose === "baseline" && row.status === "succeeded",
      )
        ? findServableMediaReadTaskByIdentity(orm, {
            ...identity,
            purpose: "baseline",
            questionKey: null,
            modelName:
              rows.find((row) => row.purpose === "baseline" && row.status === "succeeded")
                ?.modelName ?? "",
            policy:
              rows.find((row) => row.purpose === "baseline" && row.status === "succeeded")
                ?.policy ?? "legacy",
            now: at,
          })
        : null;
      if (servedBaseline !== null) blocked.delete(n.id);
    }
  }
  return blocked;
}

export function attemptedUnreadMediaCount(
  orm: Orm,
  eventKeys: readonly string[],
  /** The caller's real ISO `at` (host clock injected); defaults to the storage clock. */
  at: string = nowIso(),
): number {
  if (eventKeys.length === 0) return 0;
  return blockedMediaNoteIds(orm, eventKeys, at, true).size;
}

/**
 * The blocked NOTE IDENTITIES behind {@link attemptedUnreadMediaCount}: the native-read-proof
 * consumer (the initiative gate) asks the host about exactly these and relaxes only the ones the
 * run genuinely fed this round — never the whole conversation.
 */
export function attemptedUnreadMediaNoteIds(
  orm: Orm,
  eventKeys: readonly string[],
  at: string = nowIso(),
): string[] {
  if (eventKeys.length === 0) return [];
  return [...blockedMediaNoteIds(orm, eventKeys, at, true)];
}

/**
 * 同一会话里同一个来源引用已经读出来的描述（0.4.0 P5 的"复用"）：同图重发时直接照抄，
 * 不再花一次视觉模型。范围严格限定在同一 account＋kind＋peer（也就是同一间会话）**且同一
 * 助手（agent）**：描述不会跨会话漂移，也不会在一次改绑之后漂移到另一任助手名下——旧描述的
 * `note_model` 归属仍是上一任助手的读法，换绑后必须重新读，而不是换个名字照抄。
 */
export function reusableMediaNote(
  orm: Orm,
  input: {
    accountId: string;
    conversationKind: "group" | "private";
    peerId: string;
    agentId: string;
    kind: QqMediaKind;
    sourceRef: string;
    at: string;
  },
): { note: string; noteModel: string } | null {
  const row = orm
    .select({ note: schema.qqMediaNotes.note, noteModel: schema.qqMediaNotes.noteModel })
    .from(schema.qqMediaNotes)
    .innerJoin(schema.qqEvents, eq(schema.qqEvents.eventKey, schema.qqMediaNotes.eventKey))
    .where(
      and(
        eq(schema.qqEvents.accountId, input.accountId),
        eq(schema.qqEvents.conversationKind, input.conversationKind),
        eq(schema.qqEvents.peerId, input.peerId),
        eq(schema.qqEvents.agentId, input.agentId),
        eq(schema.qqMediaNotes.segmentKind, input.kind),
        eq(schema.qqMediaNotes.sourceRef, input.sourceRef),
        gt(schema.qqMediaNotes.expiresAt, input.at),
      ),
    )
    .orderBy(desc(schema.qqMediaNotes.updatedAt))
    .all()
    .find((candidate) => candidate.note !== null && candidate.noteModel !== null);
  return row?.note !== null && row?.note !== undefined && row.noteModel !== null
    ? { note: row.note, noteModel: row.noteModel }
    : null;
}

export function mediaNoteRow(
  orm: Orm,
  eventKey: string,
  segmentIndex: number,
): QqMediaNoteRow | null {
  const row = orm
    .select()
    .from(schema.qqMediaNotes)
    .where(
      and(
        eq(schema.qqMediaNotes.eventKey, eventKey),
        eq(schema.qqMediaNotes.segmentIndex, segmentIndex),
      ),
    )
    .get();
  return row ?? null;
}

/**
 * Store what the media was read as.
 *
 * The note and its model are written together: a description without a model would be an
 * unattributed reading, which §7.1 forbids and the table's CHECK refuses, so the pair is
 * validated here before the database has to.
 */
export function recordMediaNote(
  orm: Orm,
  input: {
    eventKey: string;
    segmentIndex: number;
    note: string;
    noteModel: string;
    expectedAttempts?: number;
    /** A runtime callback checked in the same transaction as the conditional write. */
    validateBeforeWrite?: (tx: Orm) => boolean;
  },
): QqMediaNoteRow {
  const body = input.note.trim();
  const model = input.noteModel.trim();
  if (body.length === 0 || model.length === 0) {
    throw new TypeError("Invalid QQ media note input");
  }
  return orm.transaction(
    (tx) => {
      if (input.validateBeforeWrite !== undefined && !input.validateBeforeWrite(tx)) {
        fail("MEMORY_SOURCE_INVALID", "媒体授权已变化，不能保存描述");
      }
      const updated = tx
        .update(schema.qqMediaNotes)
        .set({ note: input.note, noteModel: model, updatedAt: nowIso() })
        .where(
          and(
            eq(schema.qqMediaNotes.eventKey, input.eventKey),
            eq(schema.qqMediaNotes.segmentIndex, input.segmentIndex),
            ...(input.expectedAttempts === undefined
              ? []
              : [
                  eq(schema.qqMediaNotes.attempts, input.expectedAttempts),
                  isNull(schema.qqMediaNotes.note),
                  gt(schema.qqMediaNotes.expiresAt, nowIso()),
                ]),
          ),
        )
        .returning()
        .get();
      if (!updated) fail("MEMORY_SOURCE_INVALID", "媒体位置不存在或理解尝试已变化，不能保存描述");
      return updated;
    },
    { behavior: "immediate" },
  );
}

/**
 * Claim one read attempt atomically. The conditional SQL update and the table's CHECK
 * both cap it at 2; competing consumers cannot both claim the same attempt number.
 * This counter is the media's own and never the reply-regeneration one.
 */
export function recordMediaAttempt(
  orm: Orm,
  input: {
    eventKey: string;
    segmentIndex: number;
    /** Optional retry baseline: a concurrent claimant must not turn a first read into a retry. */
    expectedAttempts?: number;
    /** Check current binding/account authorization inside the same transaction as the claim. */
    validateBeforeClaim?: (tx: Orm) => boolean;
  },
): QqMediaNoteRow {
  return orm.transaction(
    (tx) => {
      if (input.validateBeforeClaim !== undefined && !input.validateBeforeClaim(tx)) {
        fail("MEMORY_SOURCE_INVALID", "媒体授权已变化，不能开始理解");
      }
      const updated = tx
        .update(schema.qqMediaNotes)
        .set({ attempts: sql`${schema.qqMediaNotes.attempts} + 1`, updatedAt: nowIso() })
        .where(
          and(
            eq(schema.qqMediaNotes.eventKey, input.eventKey),
            eq(schema.qqMediaNotes.segmentIndex, input.segmentIndex),
            lt(schema.qqMediaNotes.attempts, 2),
            isNull(schema.qqMediaNotes.note),
            gt(schema.qqMediaNotes.expiresAt, nowIso()),
            ...(input.expectedAttempts === undefined
              ? []
              : [eq(schema.qqMediaNotes.attempts, input.expectedAttempts)]),
          ),
        )
        .returning()
        .get();
      if (!updated) fail("MEMORY_SOURCE_INVALID", "媒体位置不存在、已过期或理解次数已变化");
      return updated;
    },
    { behavior: "immediate" },
  );
}

/**
 * The one media-domain protection predicate, shared by the retention purge and the storage
 * management category: an expired media note stays physically deletable only when nothing
 * still holds it. Parameterised by the SQL alias the caller uses for `qq_media_notes` so
 * the list's fixed SELECT, the cleanup counts and the DELETE all compile the same text.
 *
 * A note is protected when:
 *  1. a real read task is `running` on it — deleting the note CASCADEs the task
 *     (`qq_media_read_tasks.media_note_id … ON DELETE CASCADE`, 0052), which would erase the
 *     claim token and the consumed attempt of an in-flight model call;
 *  2. a nonterminal run's exact context snapshot references it by the exact kind/id the
 *     minter wrote (`qq_media` id = note id, `qq_media_source` id = note id,
 *     `qq_media_note` id = note id, `qq_media_read_task` id = task id joined back through
 *     `media_note_id`) — the run re-validates sources against this row;
 *  3. an unsafe agent task references it the same way — unsafe = nonterminal, or still
 *     holding a `running`/`waiting_approval`/`unknown` call even in a terminal state,
 *     the same scope as `TASK_PROTECTION_SQL` (agent-task-repository.ts): an interrupted
 *     write call keeps its unknown outcome forever, so the task's evidence must not lose
 *     its source. Task statuses are typed (`unknown` is a real settled task state here);
 *     the predicate only reads what the ledger recorded and never invents a call status.
 * All references are matched on exact kind + id: a kind this predicate does not name can
 * never protect a row, and neither can a run/task with no source at all.
 */
export function mediaNoteProtected(alias: string): string {
  const runTaskRef = (refsAlias: string): string =>
    `(json_extract(${refsAlias}.value,'$.kind') = 'qq_media_read_task'
      AND EXISTS (SELECT 1 FROM qq_media_read_tasks rt2
        WHERE rt2.id = json_extract(${refsAlias}.value,'$.id')
        AND rt2.media_note_id = ${alias}.id))`;
  return `(
    EXISTS (SELECT 1 FROM qq_media_read_tasks rt
      WHERE rt.media_note_id = ${alias}.id AND rt.status = 'running')
    OR EXISTS (SELECT 1 FROM context_snapshots c
      JOIN agent_steps st ON st.step_id = c.step_id
      JOIN agent_runs r ON r.run_id = st.run_id
      WHERE c.status = 'exact' AND r.status NOT IN ('completed','no_output','failed','cancelled')
      AND (EXISTS (SELECT 1 FROM json_each(c.source_refs) j
        WHERE json_extract(j.value,'$.id') = ${alias}.id
        AND json_extract(j.value,'$.kind') IN ('qq_media','qq_media_source','qq_media_note'))
      OR EXISTS (SELECT 1 FROM json_each(c.source_refs) j
        WHERE ${runTaskRef("j")})))
    OR EXISTS (SELECT 1 FROM agent_tasks t
      WHERE (t.status NOT IN ('completed','failed','cancelled')
        OR EXISTS (SELECT 1 FROM agent_task_calls bc
          WHERE bc.task_id = t.id
          AND bc.status IN ('running','waiting_approval','unknown')))
      AND (EXISTS (SELECT 1 FROM json_each(t.sources) j
        WHERE json_extract(j.value,'$.id') = ${alias}.id
        AND json_extract(j.value,'$.kind') IN ('qq_media','qq_media_source','qq_media_note'))
      OR EXISTS (SELECT 1 FROM json_each(t.sources) j
        WHERE ${runTaskRef("j")})))
  )`;
}

/**
 * Retention sweep, on the same window as the message the media belongs to. Expired notes
 * still held by the protection predicate ({@link mediaNoteProtected}) are kept: expiry
 * already made them unreadable, and protection only defers the physical delete. Returns
 * the rows this table actually lost (DELETE..RETURNING — never a pre-SELECT count, and
 * never a count of cascade-removed task rows, 0 is a legal no-op).
 */
export function purgeExpiredMediaNotes(orm: Orm, now: string = nowIso()): number {
  // One immediate transaction owns the sweep. Deleting a note CASCADEs its asset-source rows
  // (qq_media_asset_sources.media_note_id ON DELETE CASCADE); any succeeded read task consuming
  // one of those sources is revoked FIRST (same transaction, taskrepo's shared helper) so a
  // source-cleared success can never keep posing as a readable result. The ledger's identity,
  // attempts and scope survive the carrier purge untouched (ON DELETE SET NULL) — no budget
  // is silently deleted here.
  return orm.transaction(
    (tx) => {
      const doomed = tx
        .select({ id: schema.qqMediaNotes.id })
        .from(schema.qqMediaNotes)
        .where(
          and(
            lte(schema.qqMediaNotes.expiresAt, now),
            // The predicate is a fixed string built from the alias constant above — never
            // request input — so it is spliced as raw SQL, not bound as a parameter.
            sql.raw(`NOT ${mediaNoteProtected("qq_media_notes")}`),
          ),
        )
        .all();
      if (doomed.length === 0) return 0;
      const noteIds = doomed.map((row) => row.id);
      const sourceIds = tx
        .select({ id: schema.qqMediaAssetSources.id })
        .from(schema.qqMediaAssetSources)
        .where(inArray(schema.qqMediaAssetSources.mediaNoteId, noteIds))
        .all()
        .map((row) => row.id);
      revokeMediaReadTaskResultsForSources(tx, sourceIds, now);
      const deleted = tx
        .delete(schema.qqMediaNotes)
        .where(
          and(
            lte(schema.qqMediaNotes.expiresAt, now),
            sql.raw(`NOT ${mediaNoteProtected("qq_media_notes")}`),
          ),
        )
        .returning({ id: schema.qqMediaNotes.id })
        .all();
      return deleted.length;
    },
    { behavior: "immediate" },
  );
}
