// Media attachments: storage (ADR0018 P4b / 0012_qq_media_notes.sql).
//
// The row is keyed by the message's permanent dedup identity plus the segment's position,
// so a re-delivery of the same message cannot create a second reading of the same picture.
// Nothing here fetches or reads anything: this module only remembers what was read, how
// many attempts it took, and which model produced the note.

import { and, asc, count, desc, eq, gt, gte, inArray, isNull, lt, lte, sql } from "drizzle-orm";
import { fail } from "../errors";
import { parseQqMediaKind, type QqMediaKind } from "../services/qq-media-contract";
import { mediaCacheExpiresAt, QQ_OBSERVATION_RETENTION_DAYS } from "../services/qq-retention";
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
 */
export function recordMediaSegment(
  orm: Orm,
  input: MediaSegmentRef & {
    sourceRef: string;
    occurredAtSeconds: number;
    /** Was the carrying message addressed to the assistant? Required: §7.2 retries only these. */
    addressed: boolean;
  },
  retentionDays: number = QQ_OBSERVATION_RETENTION_DAYS,
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
): { eventKey: string; segmentIndex: number } | null {
  const rows = orm
    .select({
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
        eq(schema.qqEvents.speakerKind, "member"),
        gte(schema.qqEvents.occurredAtSeconds, input.sinceSeconds),
        lt(schema.qqEvents.occurredAtSeconds, input.beforeSeconds),
        // 2026-09-25 后续：不再要求"原图是被@的"。用户报告的真实场景是——一张非@的图读取失败后，
        // 有人（可能是别人）回复助手喊它看图，而此前那一行永远不满足重试资格。重试的"许可"改由
        // 当下这次消息是否被叫到决定（事件路径把 `addressed` 传进 reader），这里只负责"最近有一次
        // 失败的读取"。次数上限（两次）仍然是硬闸门。
        attemptedUnreadMedia(),
      ),
    )
    .orderBy(desc(schema.qqEvents.occurredAtSeconds), asc(schema.qqMediaNotes.segmentIndex))
    .all();
  const target = rows.find((row) => row.eventKey !== input.excludeEventKey);
  if (!target) return null;
  return Object.freeze({ eventKey: target.eventKey, segmentIndex: target.segmentIndex });
}

/**
 * 「试过但没读出」：这一行已经花过读取尝试、却仍然没有描述，而且还没过期。
 *
 * 两个调用方问的是同一个事实，所以判据只有一份：§7.1 的补充唤醒
 * （`pendingMediaSupplementFor`，有人被叫到时再试一次）与 §5.2 的主动开口闸门
 * （`attemptedUnreadMediaCount`，没读懂就别开口）。
 *
 * 它**包含在途**：读取器在调用外部模型之前就先记一次尝试，所以"正在读"与"读失败"在这一行
 * 上同形。闸门按 fail closed 处理（用户 2026-09-25：读取失败就不自主接话）——正在读就不开口，
 * 读完了要开口也得等一条新的群友消息换一张票。
 *
 * **只算图片**（用户 2026-09-25，第二问）：语音与视频在这一版**设计上永远读不出来**（转写协议未定、
 * 没有视频解码器），把它们算进"失败"等于永久按住两条主动路径——用户报告"自主接话从不触发"时，
 * 这一条正是原因之一。判据因此是"本来读得出来却失败了"，而不是"这条媒体没有描述"。
 */
function attemptedUnreadMedia() {
  return and(
    eq(schema.qqMediaNotes.segmentKind, "image"),
    isNull(schema.qqMediaNotes.note),
    gt(schema.qqMediaNotes.attempts, 0),
    gt(schema.qqMediaNotes.expiresAt, nowIso()),
  );
}

/**
 * `eventKeys` 里有多少项媒体是「试过但没读出」（用户 2026-09-25）。
 *
 * 主动开口（自主接话、冷场发起）用它做闸门：一张试过却没读懂的图意味着助手并不知道自己要
 * 接的是什么事，§7.1 又禁止假装知道，于是宁可不开口。窗口由调用方给——这里只数这些消息上的行，
 * 不猜"哪一批算本轮"。
 */
export function attemptedUnreadMediaCount(orm: Orm, eventKeys: readonly string[]): number {
  if (eventKeys.length === 0) return 0;
  const row = orm
    .select({ total: count() })
    .from(schema.qqMediaNotes)
    .where(and(inArray(schema.qqMediaNotes.eventKey, [...eventKeys]), attemptedUnreadMedia()))
    .get();
  return row?.total ?? 0;
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

/** Retention sweep, on the same window as the message the media belongs to. */
export function purgeExpiredMediaNotes(orm: Orm, now: string = nowIso()): number {
  const expired = orm
    .select({ id: schema.qqMediaNotes.id })
    .from(schema.qqMediaNotes)
    .where(lte(schema.qqMediaNotes.expiresAt, now))
    .all();
  if (expired.length === 0) return 0;
  orm.delete(schema.qqMediaNotes).where(lte(schema.qqMediaNotes.expiresAt, now)).run();
  return expired.length;
}
