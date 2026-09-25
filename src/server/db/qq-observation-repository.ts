// QQ observation text: storage, retention sweep and the "offered to consolidation"
// marker. See qq-retention.ts for why text and dedup identity have separate lives.

import { and, asc, count, desc, eq, gt, inArray, isNull, lte, max } from "drizzle-orm";
import { fail } from "../errors";
import type { QqMemoryScope } from "../services/qq-binding-contract";
import {
  isObservationExpired,
  observationExpiresAt,
  QQ_OBSERVATION_RETENTION_DAYS,
} from "../services/qq-retention";
import { nowIso, type Orm } from "./repositories";
import * as schema from "./schema";

/** The `kind: "qq"` arm of a memory scope, i.e. the fields a conversation is keyed by. */
export type QqConversationScope = Extract<QqMemoryScope, { kind: "qq" }>;

export type QqObservationTextRow = typeof schema.qqObservationText.$inferSelect;

/** One message of a conversation, as the context selection needs it (P3b-2). */
export interface QqConversationMessageRow {
  readonly eventKey: string;
  readonly occurredAtSeconds: number;
  readonly speaker: "member" | "anonymous";
  readonly speakerId: string | null;
  /** `null` when the body has expired or the message never had text (media only). */
  readonly text: string | null;
  /** Descriptions that exist for this message's media. Model output, never the speaker's. */
  readonly mediaNotes: string[];
  /** Media with no description yet: something was there and was not understood. */
  readonly mediaUnread: number;
}

/**
 * The newest messages of a conversation, for building a judgement or reply context.
 *
 * `system` notices are excluded here rather than filtered later: someone joining is not
 * conversation content, and the same rule already governs the no-reply check. A message whose
 * body has expired comes back with `text: null` and is NOT dropped — the fact that somebody
 * said something at that moment is still true, and pretending the moment was empty would make
 * a conversation look shorter than it was.
 *
 * Media is read in a second query and grouped in memory: one message can carry several
 * segments, and turning that into a join would need an aggregate this schema does not
 * otherwise use.
 */
export function conversationMessagesSince(
  orm: Orm,
  scope: QqConversationScope,
  input: { sinceSeconds: number; limit: number },
): QqConversationMessageRow[] {
  if (!Number.isInteger(input.sinceSeconds) || input.sinceSeconds < 0) {
    throw new TypeError("Invalid QQ conversation query input");
  }
  if (!Number.isInteger(input.limit) || input.limit <= 0) {
    throw new TypeError("Invalid QQ conversation query input");
  }
  const rows = orm
    .select({
      eventKey: schema.qqEvents.eventKey,
      occurredAtSeconds: schema.qqEvents.occurredAtSeconds,
      speakerKind: schema.qqEvents.speakerKind,
      speakerId: schema.qqEvents.speakerId,
      body: schema.qqObservationText.body,
    })
    .from(schema.qqEvents)
    .leftJoin(
      schema.qqObservationText,
      eq(schema.qqObservationText.eventKey, schema.qqEvents.eventKey),
    )
    .where(
      and(
        eq(schema.qqEvents.accountId, scope.accountId),
        eq(schema.qqEvents.conversationKind, scope.conversationKind),
        eq(schema.qqEvents.peerId, scope.peerId),
        eq(schema.qqEvents.agentId, scope.agentId),
        inArray(schema.qqEvents.speakerKind, ["member", "anonymous"] as const),
        gt(schema.qqEvents.occurredAtSeconds, input.sinceSeconds),
      ),
    )
    .orderBy(desc(schema.qqEvents.occurredAtSeconds), desc(schema.qqEvents.eventKey))
    .limit(input.limit)
    .all();
  if (rows.length === 0) return [];

  const notes = orm
    .select({
      eventKey: schema.qqMediaNotes.eventKey,
      note: schema.qqMediaNotes.note,
      noteModel: schema.qqMediaNotes.noteModel,
    })
    .from(schema.qqMediaNotes)
    .where(
      inArray(
        schema.qqMediaNotes.eventKey,
        rows.map((row) => row.eventKey),
      ),
    )
    .all();
  const byEvent = new Map<string, { notes: string[]; unread: number }>();
  for (const note of notes) {
    const entry = byEvent.get(note.eventKey) ?? { notes: [], unread: 0 };
    if (note.note === null || note.noteModel === null) entry.unread++;
    else entry.notes.push(`[${note.noteModel}] ${note.note}`);
    byEvent.set(note.eventKey, entry);
  }

  return rows.map((row) => {
    const media = byEvent.get(row.eventKey) ?? { notes: [], unread: 0 };
    return {
      eventKey: row.eventKey,
      occurredAtSeconds: row.occurredAtSeconds,
      speaker: row.speakerKind === "anonymous" ? ("anonymous" as const) : ("member" as const),
      speakerId: row.speakerId ?? null,
      text: row.body ?? null,
      mediaNotes: media.notes,
      mediaUnread: media.unread,
    };
  });
}

/** Permanent event identities, including media-only messages; scoped exactly like context. */
export function qqMemberEventCount(orm: Orm, scope: QqConversationScope): number {
  const row = orm
    .select({ total: count() })
    .from(schema.qqEvents)
    .where(
      and(
        eq(schema.qqEvents.accountId, scope.accountId),
        eq(schema.qqEvents.conversationKind, scope.conversationKind),
        eq(schema.qqEvents.peerId, scope.peerId),
        eq(schema.qqEvents.agentId, scope.agentId),
        inArray(schema.qqEvents.speakerKind, ["member", "anonymous"] as const),
      ),
    )
    .get();
  return row?.total ?? 0;
}

/**
 * 某个发言人在这个会话里的消息条数（0037）。
 *
 * 判断改成"每人一次"之后，"判断间隔"也要按人算：张三又说了三条才重问一次张三，李四说话不花张三那次
 * 判断。用它取代原来的会话级计数，同时避开"同秒两条消息"这类时间戳比较的坑。
 */
export function qqSpeakerEventCount(
  orm: Orm,
  scope: QqConversationScope,
  speakerId: string,
): number {
  const row = orm
    .select({ total: count() })
    .from(schema.qqEvents)
    .where(
      and(
        eq(schema.qqEvents.accountId, scope.accountId),
        eq(schema.qqEvents.conversationKind, scope.conversationKind),
        eq(schema.qqEvents.peerId, scope.peerId),
        eq(schema.qqEvents.agentId, scope.agentId),
        inArray(schema.qqEvents.speakerKind, ["member", "anonymous"] as const),
        eq(schema.qqEvents.speakerId, speakerId),
      ),
    )
    .get();
  return row?.total ?? 0;
}

export interface QqObservedConversation {
  readonly accountId: string;
  readonly kind: "group" | "private";
  readonly peerId: string;
  readonly messages: number;
  readonly lastAtSeconds: number;
  /** Set once the conversation is bound; `null` means it is being observed but not owned. */
  readonly bindingId: string | null;
}

/**
 * The conversations the intake has actually seen, most recent activity first.
 *
 * A settings surface gets its list of groups and private chats from here rather than from a
 * typed-in number: a conversation exists because messages arrived from it. `binding_id`
 * tells the surface whether it is already ours, which is exactly the question it has to
 * answer before offering to bind.
 */
export function observedQqConversations(orm: Orm): QqObservedConversation[] {
  return orm
    .select({
      accountId: schema.qqEvents.accountId,
      kind: schema.qqEvents.conversationKind,
      peerId: schema.qqEvents.peerId,
      messages: count(),
      lastAtSeconds: max(schema.qqEvents.occurredAtSeconds),
      bindingId: schema.qqBindings.id,
    })
    .from(schema.qqEvents)
    .leftJoin(
      schema.qqBindings,
      and(
        eq(schema.qqBindings.accountId, schema.qqEvents.accountId),
        eq(schema.qqBindings.conversationKind, schema.qqEvents.conversationKind),
        eq(schema.qqBindings.peerId, schema.qqEvents.peerId),
      ),
    )
    .groupBy(
      schema.qqEvents.accountId,
      schema.qqEvents.conversationKind,
      schema.qqEvents.peerId,
      schema.qqBindings.id,
    )
    .orderBy(desc(max(schema.qqEvents.occurredAtSeconds)))
    .all()
    .map((row) => ({
      accountId: row.accountId,
      // The column's CHECK limits it to these two values, which the contract repeats.
      kind: row.kind === "private" ? ("private" as const) : ("group" as const),
      peerId: row.peerId,
      messages: Number(row.messages),
      lastAtSeconds: Number(row.lastAtSeconds ?? 0),
      bindingId: row.bindingId ?? null,
    }));
}

/**
 * Store a message body against an existing dedup row. The dedup row must already
 * exist (a body without an identity could never be de-duplicated), and the body is
 * stamped with the sender's time so retention cannot be extended by late storage.
 */
export function storeObservationText(
  orm: Orm,
  input: { eventKey: string; body: string; occurredAtSeconds: number },
  retentionDays: number = QQ_OBSERVATION_RETENTION_DAYS,
): QqObservationTextRow {
  const event = orm
    .select()
    .from(schema.qqEvents)
    .where(eq(schema.qqEvents.eventKey, input.eventKey))
    .get();
  if (!event) fail("MEMORY_SOURCE_INVALID", "观察去重身份不存在，不能保存正文");
  if (input.body.trim().length === 0) fail("MEMORY_SOURCE_INVALID", "观察正文不能为空");
  const row = orm
    .insert(schema.qqObservationText)
    .values({
      eventKey: input.eventKey,
      body: input.body,
      occurredAtSeconds: input.occurredAtSeconds,
      expiresAt: observationExpiresAt(input.occurredAtSeconds, retentionDays),
      recordedAt: nowIso(),
    })
    .onConflictDoUpdate({
      target: schema.qqObservationText.eventKey,
      set: {
        body: input.body,
        occurredAtSeconds: input.occurredAtSeconds,
        expiresAt: observationExpiresAt(input.occurredAtSeconds, retentionDays),
        recordedAt: nowIso(),
      },
    })
    .returning()
    .get();
  if (!row) fail("DATABASE_UNAVAILABLE", "数据服务暂不可用，请检查数据库", 503);
  return row;
}

/** Bodies for the given events, omitting anything already expired. */
export function observationText(
  orm: Orm,
  eventKeys: string[],
  now: string = nowIso(),
): Map<string, string> {
  const found = new Map<string, string>();
  if (eventKeys.length === 0) return found;
  const rows = orm
    .select()
    .from(schema.qqObservationText)
    .where(inArray(schema.qqObservationText.eventKey, [...new Set(eventKeys)]))
    .all();
  for (const row of rows) {
    if (!isObservationExpired(row.expiresAt, now)) found.set(row.eventKey, row.body);
  }
  return found;
}

/**
 * Retention sweep. Deletes expired bodies (and, by the same window, the media cache
 * that belongs to them once media storage exists). It never touches `qq_events` or
 * `qq_memory_sources`: a memory whose source text has expired stays valid and simply
 * stops being re-readable, which is exactly the distinction ADR0018 draws.
 */
export function purgeExpiredObservationText(orm: Orm, now: string = nowIso()): number {
  const expired = orm
    .select({ eventKey: schema.qqObservationText.eventKey })
    .from(schema.qqObservationText)
    .where(lte(schema.qqObservationText.expiresAt, now))
    .all();
  if (expired.length === 0) return 0;
  orm.delete(schema.qqObservationText).where(lte(schema.qqObservationText.expiresAt, now)).run();
  return expired.length;
}

function conversationConditions(scope: QqConversationScope) {
  return [
    eq(schema.qqEvents.accountId, scope.accountId),
    eq(schema.qqEvents.conversationKind, scope.conversationKind),
    eq(schema.qqEvents.peerId, scope.peerId),
    eq(schema.qqEvents.agentId, scope.agentId),
  ];
}

/**
 * Observations of one conversation that still have text and have not been offered to
 * consolidation yet, oldest first. This is what a caller selects from; the batch size
 * (i.e. the pacing of QQ memory) is the caller's decision, because no threshold has
 * been agreed for it.
 */
export function pendingObservations(
  orm: Orm,
  scope: QqConversationScope,
  limit: number,
  now: string = nowIso(),
): Array<{ eventKey: string; body: string; occurredAtSeconds: number }> {
  if (limit <= 0) return [];
  return orm
    .select({
      eventKey: schema.qqEvents.eventKey,
      occurredAtSeconds: schema.qqEvents.occurredAtSeconds,
      body: schema.qqObservationText.body,
    })
    .from(schema.qqEvents)
    .innerJoin(
      schema.qqObservationText,
      eq(schema.qqObservationText.eventKey, schema.qqEvents.eventKey),
    )
    .leftJoin(
      schema.qqProcessedEvents,
      eq(schema.qqProcessedEvents.eventKey, schema.qqEvents.eventKey),
    )
    .where(and(...pendingConditions(scope, now)))
    .orderBy(asc(schema.qqEvents.occurredAtSeconds), asc(schema.qqEvents.eventKey))
    .limit(limit)
    .all();
}

/**
 * Row conditions for "readable and not yet offered".
 *
 * Expiry is compared in SQL, not in JavaScript, so a count does not have to load
 * every body to decide it is out of window. `isObservationExpired` is
 * `expiresAt <= now`, so "still readable" is the strict greater-than below — the two
 * must stay complementary.
 */
function pendingConditions(scope: QqConversationScope, now: string) {
  return [
    ...conversationConditions(scope),
    isNull(schema.qqProcessedEvents.eventKey),
    gt(schema.qqObservationText.expiresAt, now),
  ];
}

/** How many observations of this conversation are still waiting. */
export function pendingObservationCount(
  orm: Orm,
  scope: QqConversationScope,
  now: string = nowIso(),
): number {
  const row = orm
    .select({ total: count() })
    .from(schema.qqEvents)
    .innerJoin(
      schema.qqObservationText,
      eq(schema.qqObservationText.eventKey, schema.qqEvents.eventKey),
    )
    .leftJoin(
      schema.qqProcessedEvents,
      eq(schema.qqProcessedEvents.eventKey, schema.qqEvents.eventKey),
    )
    .where(and(...pendingConditions(scope, now)))
    .get();
  return row?.total ?? 0;
}

/** Mark a batch as offered. Idempotent, and independent of the text's lifetime. */
export function markObservationsProcessed(orm: Orm, eventKeys: string[]): void {
  for (const eventKey of [...new Set(eventKeys)]) {
    orm
      .insert(schema.qqProcessedEvents)
      .values({ eventKey, processedAt: nowIso() })
      .onConflictDoNothing()
      .run();
  }
}
