// Send results: storage (ADR0018 P4c / 0014_qq_send_log.sql).
//
// This module is where the transport's answer finally becomes a durable fact. It owns no
// rule of its own: `services/qq-output-contract.ts` decides which §8.2 row a reply falls
// into and what may be done about it, and this module writes that down and, for a reply
// the plan says entered the no-reply rule, appends the assistant's own speech record —
// which is the writer `qq_speech_log` had been missing since P3a.
//
// Everything is recorded, including the outcomes nobody may act on. A failed send is a
// fact about the conversation; dropping it would make "why did that reply never appear"
// unanswerable, and §10 asks for exactly that kind of record.

import type { Database } from "bun:sqlite";
import { and, desc, eq, inArray, isNotNull, lte } from "drizzle-orm";
import { fail } from "../errors";
import {
  parseQqSendOutcome,
  parseQqSendPartKind,
  parseQqSendPartResult,
  type QqSendOutcome,
  type QqSendOutcomeEffect,
  type QqSendPartKind,
  type QqSendPartResult,
  qqSendOutcomeEffect,
  qqSendSummary,
} from "../services/qq-output-contract";
import { QQ_OBSERVATION_RETENTION_DAYS, speechExpiresAt } from "../services/qq-retention";
import { parseQqSpeechKind, type QqSpeechKind } from "../services/qq-speaking-contract";
import type { QqConversationScope } from "./qq-observation-repository";
import { recordQqSpeech } from "./qq-speech-repository";
import { nowIso, type Orm } from "./repositories";
import * as schema from "./schema";

export type QqSendLogRow = typeof schema.qqSendLog.$inferSelect;
export type QqSendPartRow = typeof schema.qqSendPart.$inferSelect;

/** One platform request: what it carried, and what the platform did with it. */
export interface QqSendPartInput {
  readonly kind: QqSendPartKind;
  readonly result: QqSendPartResult;
  /** Present exactly when `result` is `confirmed`. */
  readonly messageId: string | null;
  /**
   * Which library asset a sticker part carried (§9.3's per-conversation history). The contract
   * requires it for a sticker part and forbids it for a text part, so "absent" here only ever
   * means a part that cannot have one.
   */
  readonly stickerId?: string | null;
}

export interface QqSendInput {
  readonly scope: QqConversationScope;
  /** Which of the four speech paths this reply came from (P3a's kinds). */
  readonly kind: QqSpeechKind;
  /** In send order. At least one part; the contract refuses an empty attempt. */
  readonly parts: readonly QqSendPartInput[];
  readonly sentAtSeconds: number;
  /**
   * What was said, so the judgement can see this assistant's own line (P3b-2). `null` for a
   * sticker-only utterance: there are no words, and the part list already records that a
   * sticker was sent.
   */
  readonly text: string | null;
}

/** Whether the no-reply rule's own record was updated — and if not, why not. */
export type QqSendUnrespondedRecord =
  | { readonly kind: "recorded" }
  | { readonly kind: "not_recorded" }
  | { readonly kind: "pending_decision"; readonly item: "U13" };

export interface QqSendRecord {
  readonly log: QqSendLogRow;
  readonly outcome: QqSendOutcome;
  readonly effect: QqSendOutcomeEffect;
  readonly unrespondedRecord: QqSendUnrespondedRecord;
}

/**
 * Record what the platform did with one reply, and apply the part of §8.2 that is
 * decided: a successfully delivered utterance becomes the assistant's own speech record,
 * so the no-reply rule ("do not keep asking into silence") has something to compare
 * against.
 *
 * A failed or unknown attempt is written down but does NOT create a speech record: §8.2
 * states entering the rule for a successful send only, and whether a failure consumes
 * that slot is U13. The return value says "pending_decision" instead of quietly
 * answering it.
 */
export function recordQqSend(
  orm: Orm,
  input: QqSendInput,
  retentionDays: number = QQ_OBSERVATION_RETENTION_DAYS,
  transactionDb?: Database,
): QqSendRecord {
  const kind = parseQqSpeechKind(input.kind);
  if (!Number.isInteger(input.sentAtSeconds) || input.sentAtSeconds < 0) {
    throw new TypeError("Invalid QQ send record input");
  }
  const parts = input.parts.map((part) => ({
    kind: parseQqSendPartKind(part.kind),
    result: parseQqSendPartResult(part.result),
    messageId: part.messageId,
    stickerId: part.stickerId ?? null,
  }));
  // The contract validates the whole attempt — what it refuses (an empty attempt, or a
  // platform id on a part the platform never confirmed) is refused before any write.
  const summary = qqSendSummary({ parts });
  const effect = qqSendOutcomeEffect(summary.outcome);
  const expiresAt = speechExpiresAt(input.sentAtSeconds, retentionDays);

  const writeRows = (tx: Orm) => {
    const row = tx
      .insert(schema.qqSendLog)
      .values({
        id: crypto.randomUUID(),
        accountId: input.scope.accountId,
        conversationKind: input.scope.conversationKind,
        peerId: input.scope.peerId,
        agentId: input.scope.agentId,
        kind,
        outcome: summary.outcome,
        deliveryMessageId: summary.deliveryMessageId,
        sentAtSeconds: input.sentAtSeconds,
        expiresAt,
        recordedAt: nowIso(),
      })
      .returning()
      .get();
    if (!row) fail("DATABASE_UNAVAILABLE", "数据服务暂不可用，请检查数据库", 503);
    tx.insert(schema.qqSendPart)
      .values(
        parts.map((part, index) => ({
          sendId: row.id,
          partIndex: index,
          partKind: part.kind,
          result: part.result,
          platformMessageId: part.messageId,
          stickerId: part.stickerId,
        })),
      )
      .run();
    // A confirmed utterance and its speech record are one local fact. Never commit
    // the attempt first and create the no-reply record in a later transaction.
    if (effect.entersUnresponded === true) {
      recordQqSpeech(
        tx,
        { scope: input.scope, kind, spokeAtSeconds: input.sentAtSeconds, text: input.text },
        retentionDays,
      );
    }
    return row;
  };
  const log = transactionDb
    ? transactionDb.transaction(() => writeRows(orm)).immediate()
    : orm.transaction(writeRows, { behavior: "immediate" });

  if (effect.entersUnresponded === "pending") {
    return {
      log,
      outcome: summary.outcome,
      effect,
      unrespondedRecord: { kind: "pending_decision", item: "U13" },
    };
  }
  if (effect.entersUnresponded === false) {
    return { log, outcome: summary.outcome, effect, unrespondedRecord: { kind: "not_recorded" } };
  }
  return { log, outcome: summary.outcome, effect, unrespondedRecord: { kind: "recorded" } };
}

/** One attempt with its parts, in send order, or `null` if it is not there. */
export function readQqSend(
  orm: Orm,
  sendId: string,
): { log: QqSendLogRow; parts: QqSendPartRow[] } | null {
  const log = orm.select().from(schema.qqSendLog).where(eq(schema.qqSendLog.id, sendId)).get();
  if (!log) return null;
  const parts = orm
    .select()
    .from(schema.qqSendPart)
    .where(eq(schema.qqSendPart.sendId, sendId))
    .orderBy(schema.qqSendPart.partIndex)
    .all();
  return { log, parts };
}

/** Recent attempts in one conversation, newest first. */
export function readQqSends(orm: Orm, scope: QqConversationScope, limit = 20): QqSendLogRow[] {
  if (!Number.isInteger(limit) || limit <= 0) throw new TypeError("Invalid QQ send query input");
  return orm
    .select()
    .from(schema.qqSendLog)
    .where(
      and(
        eq(schema.qqSendLog.accountId, scope.accountId),
        eq(schema.qqSendLog.conversationKind, scope.conversationKind),
        eq(schema.qqSendLog.peerId, scope.peerId),
        eq(schema.qqSendLog.agentId, scope.agentId),
      ),
    )
    .orderBy(desc(schema.qqSendLog.sentAtSeconds), desc(schema.qqSendLog.id))
    .limit(limit)
    .all();
}

/**
 * Retention sweep, on the same window as message text (qq-retention.ts). Parts go with
 * their attempt through the foreign key, so the ledger can never keep a part whose
 * attempt has expired.
 */
export function purgeExpiredQqSends(orm: Orm, now: string = nowIso()): number {
  const expired = orm
    .select({ id: schema.qqSendLog.id })
    .from(schema.qqSendLog)
    .where(lte(schema.qqSendLog.expiresAt, now))
    .all();
  if (expired.length === 0) return 0;
  orm.delete(schema.qqSendLog).where(lte(schema.qqSendLog.expiresAt, now)).run();
  return expired.length;
}

/** Map a stored outcome back through the contract, so a bad row surfaces as a fault. */
export function storedQqSendOutcome(row: QqSendLogRow): QqSendOutcome {
  return parseQqSendOutcome(row.outcome);
}

export interface QqStickerUsage {
  readonly assetId: string;
  /** The most recent send this conversation saw carrying that asset. */
  readonly lastSentAtSeconds: number;
  readonly sent: number;
}

/**
 * Which stickers this conversation has already seen, and when (P4g, §9.3).
 *
 * §9.3 says the repetition history is per conversation ("历史按群独立"), and gives a scheme a hard
 * minimum spacing plus a soft "avoid the recent ones". Both are questions about this table — and
 * neither could be answered before the ledger started recording WHICH asset a sticker part
 * carried, only that one went out.
 *
 * `counts` is a parameter rather than a constant, because whether a failed or unknown send counts
 * as "used" is U13 and is undecided. The caller passes the part results to consult; a sticker the
 * platform never confirmed simply does not appear unless the caller asks for it. The alternative —
 * picking a set here — would be answering U13 inside a storage function.
 *
 * A sticker part recorded before P4g has no asset id and cannot appear: the ledger honestly says
 * "a sticker went out", and this function does not invent which one.
 */
export function qqStickerUsageByConversation(
  orm: Orm,
  scope: QqConversationScope,
  counts: readonly QqSendPartResult[],
): QqStickerUsage[] {
  const allowed = [...new Set(counts.map((result) => parseQqSendPartResult(result)))];
  if (allowed.length === 0) return [];
  const rows = orm
    .select({
      assetId: schema.qqSendPart.stickerId,
      sentAtSeconds: schema.qqSendLog.sentAtSeconds,
    })
    .from(schema.qqSendPart)
    .innerJoin(schema.qqSendLog, eq(schema.qqSendPart.sendId, schema.qqSendLog.id))
    .where(
      and(
        eq(schema.qqSendLog.accountId, scope.accountId),
        eq(schema.qqSendLog.conversationKind, scope.conversationKind),
        eq(schema.qqSendLog.peerId, scope.peerId),
        eq(schema.qqSendLog.agentId, scope.agentId),
        isNotNull(schema.qqSendPart.stickerId),
        inArray(schema.qqSendPart.result, allowed),
      ),
    )
    .all();
  const byAsset = new Map<string, QqStickerUsage>();
  for (const row of rows) {
    // `isNotNull` is in the filter, so the id is present; the check is here so a future edit to the
    // filter cannot make "a sticker with no id" silently enter the history.
    if (row.assetId === null) continue;
    const current = byAsset.get(row.assetId);
    if (current === undefined) {
      byAsset.set(row.assetId, {
        assetId: row.assetId,
        lastSentAtSeconds: row.sentAtSeconds,
        sent: 1,
      });
      continue;
    }
    byAsset.set(row.assetId, {
      assetId: row.assetId,
      lastSentAtSeconds: Math.max(current.lastSentAtSeconds, row.sentAtSeconds),
      sent: current.sent + 1,
    });
  }
  return [...byAsset.values()].sort(
    (left, right) => right.lastSentAtSeconds - left.lastSentAtSeconds,
  );
}

/**
 * 这条平台消息是不是本助手在这个会话里发出去的？(2026-09-25 后续)
 *
 * The QQ "reply" segment carries the id of the message it answers. Answering one of OUR messages is
 * the same act of calling as an @ — but only when we can prove the target was ours: a reply to
 * somebody else's message is not a call, and a target we never sent (older than our ledger, or from
 * another account) says nothing and must not be treated as one.
 */
export function platformMessageWasSentByAssistant(
  orm: Orm,
  input: {
    accountId: string;
    conversationKind: "group" | "private";
    peerId: string;
    platformMessageId: string;
  },
): boolean {
  const row = orm
    .select({ id: schema.qqSendLog.id })
    .from(schema.qqSendLog)
    .where(
      and(
        eq(schema.qqSendLog.accountId, input.accountId),
        eq(schema.qqSendLog.conversationKind, input.conversationKind),
        eq(schema.qqSendLog.peerId, input.peerId),
        eq(schema.qqSendLog.deliveryMessageId, input.platformMessageId),
      ),
    )
    .get();
  return row !== undefined;
}
