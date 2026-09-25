// The assistant's own utterances: storage (ADR0018 P3a / 0011_qq_speech_log.sql).
//
// Nothing here decides whether the assistant should speak — that is
// `services/qq-speaking-contract.ts`. This module only answers "what is the latest
// relevant fact", so the contract can be applied to it: when this assistant last took
// the initiative here, and whether a real partner has spoken since.

import { and, count, desc, eq, gt, inArray, lte, max } from "drizzle-orm";
import { fail } from "../errors";
import { QQ_OBSERVATION_RETENTION_DAYS, speechExpiresAt } from "../services/qq-retention";
import { QQ_RHYTHM_HOUR_SECONDS } from "../services/qq-rhythm-contract";
import {
  parseQqSpeechKind,
  QQ_INITIATIVE_SPEECH_KINDS,
  type QqSpeechKind,
} from "../services/qq-speaking-contract";
import type { QqConversationScope } from "./qq-observation-repository";
import { nowIso, type Orm } from "./repositories";
import * as schema from "./schema";

export type QqSpeechRow = typeof schema.qqSpeechLog.$inferSelect;

function conditions(scope: QqConversationScope) {
  return [
    eq(schema.qqSpeechLog.accountId, scope.accountId),
    eq(schema.qqSpeechLog.conversationKind, scope.conversationKind),
    eq(schema.qqSpeechLog.peerId, scope.peerId),
    eq(schema.qqSpeechLog.agentId, scope.agentId),
  ];
}

/**
 * Record that this assistant spoke in this conversation.
 *
 * Called after a message reaches the platform, because that is when the fact becomes true for
 * the purpose this row serves. The rule itself only needs order — but since P3b-2 the words
 * are kept too, in a separate row: judging "should I say something now" without being able to
 * see what this assistant just said means repeating itself or dropping its own thread. Pass
 * `text: null` for a sticker-only utterance; there are no words to store, and an empty string
 * is refused rather than written as a body.
 */
export function recordQqSpeech(
  orm: Orm,
  input: {
    scope: QqConversationScope;
    kind: QqSpeechKind;
    spokeAtSeconds: number;
    text?: string | null;
  },
  retentionDays: number = QQ_OBSERVATION_RETENTION_DAYS,
): QqSpeechRow {
  if (!Number.isInteger(input.spokeAtSeconds) || input.spokeAtSeconds < 0) {
    throw new TypeError("Invalid QQ speech record input");
  }
  const text = input.text ?? null;
  if (text !== null && text.trim().length === 0) {
    throw new TypeError("Invalid QQ speech record input");
  }
  const expiresAt = speechExpiresAt(input.spokeAtSeconds, retentionDays);
  const row = orm
    .insert(schema.qqSpeechLog)
    .values({
      id: crypto.randomUUID(),
      accountId: input.scope.accountId,
      conversationKind: input.scope.conversationKind,
      peerId: input.scope.peerId,
      agentId: input.scope.agentId,
      kind: parseQqSpeechKind(input.kind),
      spokeAtSeconds: input.spokeAtSeconds,
      expiresAt,
      recordedAt: nowIso(),
    })
    .returning()
    .get();
  if (!row) fail("DATABASE_UNAVAILABLE", "数据服务暂不可用，请检查数据库", 503);
  if (text !== null) {
    orm
      .insert(schema.qqSpeechText)
      .values({
        speechId: row.id,
        body: text,
        spokeAtSeconds: input.spokeAtSeconds,
        expiresAt,
        recordedAt: nowIso(),
      })
      .run();
  }
  return row;
}

/**
 * What this assistant said here recently, newest first — the assistant's side of a
 * conversation context.
 *
 * An inner join on purpose: an utterance with no words (a sticker) has no text row, and a
 * text row may expire before its speech row does. Both cases are simply absent from the list,
 * which is the honest answer — there is nothing to show.
 */
export function ownSpeechSince(
  orm: Orm,
  scope: QqConversationScope,
  input: { sinceSeconds: number; limit: number },
): Array<{ occurredAtSeconds: number; text: string }> {
  if (!Number.isInteger(input.sinceSeconds) || input.sinceSeconds < 0) {
    throw new TypeError("Invalid QQ own-speech query input");
  }
  if (!Number.isInteger(input.limit) || input.limit <= 0) {
    throw new TypeError("Invalid QQ own-speech query input");
  }
  return orm
    .select({
      occurredAtSeconds: schema.qqSpeechLog.spokeAtSeconds,
      text: schema.qqSpeechText.body,
    })
    .from(schema.qqSpeechLog)
    .innerJoin(schema.qqSpeechText, eq(schema.qqSpeechText.speechId, schema.qqSpeechLog.id))
    .where(and(...conditions(scope), gt(schema.qqSpeechLog.spokeAtSeconds, input.sinceSeconds)))
    .orderBy(desc(schema.qqSpeechLog.spokeAtSeconds), desc(schema.qqSpeechLog.id))
    .limit(input.limit)
    .all();
}

/** The most recent thing this assistant said here, whatever kind it was. */
export function lastQqSpeech(
  orm: Orm,
  scope: QqConversationScope,
): { kind: QqSpeechKind; spokeAtSeconds: number } | null {
  const row = orm
    .select({
      kind: schema.qqSpeechLog.kind,
      spokeAtSeconds: schema.qqSpeechLog.spokeAtSeconds,
    })
    .from(schema.qqSpeechLog)
    .where(and(...conditions(scope)))
    .orderBy(desc(schema.qqSpeechLog.spokeAtSeconds), desc(schema.qqSpeechLog.id))
    .limit(1)
    .get();
  if (!row) return null;
  return { kind: parseQqSpeechKind(row.kind), spokeAtSeconds: row.spokeAtSeconds };
}

/**
 * When this assistant last spoke unprompted here, or `null` if it never did. Only the
 * initiative-taking kinds count: the no-reply rule is about speaking into silence, not
 * about answering.
 */
export function lastQqInitiativeSeconds(orm: Orm, scope: QqConversationScope): number | null {
  const row = orm
    .select({ at: schema.qqSpeechLog.spokeAtSeconds })
    .from(schema.qqSpeechLog)
    .where(
      and(...conditions(scope), inArray(schema.qqSpeechLog.kind, [...QQ_INITIATIVE_SPEECH_KINDS])),
    )
    .orderBy(desc(schema.qqSpeechLog.spokeAtSeconds), desc(schema.qqSpeechLog.id))
    .limit(1)
    .get();
  return row?.at ?? null;
}

/**
 * The newest message from a real conversation partner, or `null` if none is recorded.
 *
 * `system` notices (someone joined, a recall) are not a partner speaking, so they never
 * release the no-reply rule — otherwise a group's own bookkeeping would look like
 * somebody answering. Anonymous members do count: they are people, even when unnamed.
 *
 * `attentionMembers` (0031) narrows "a partner" to the conversation's attention list, which is
 * what the hard mode means: everyone else is still recorded, but the quiet-room clock is set by
 * the people this conversation actually listens to. Anonymous speakers have no stable id, so a
 * narrowed query can never match one — deliberately, since nobody can put "anonymous" on a list.
 */
export function newestMemberMessageSeconds(
  orm: Orm,
  scope: QqConversationScope,
  options: { readonly attentionMembers?: readonly string[] } = {},
): number | null {
  const row = orm
    .select({ at: max(schema.qqEvents.occurredAtSeconds) })
    .from(schema.qqEvents)
    .where(
      and(
        eq(schema.qqEvents.accountId, scope.accountId),
        eq(schema.qqEvents.conversationKind, scope.conversationKind),
        eq(schema.qqEvents.peerId, scope.peerId),
        eq(schema.qqEvents.agentId, scope.agentId),
        inArray(schema.qqEvents.speakerKind, ["member", "anonymous"]),
        ...(options.attentionMembers === undefined
          ? []
          : [inArray(schema.qqEvents.speakerId, [...options.attentionMembers])]),
      ),
    )
    .get();
  const at = row?.at;
  return at === null || at === undefined ? null : Number(at);
}

/**
 * How many unprompted utterances this assistant delivered here inside the rolling window
 * (one hour by default) — the number the scheme's hourly cap is compared against.
 *
 * Counted from the speech log, which holds delivered utterances only: a send that failed or
 * whose fate is unknown does not consume the budget. Whether it *should* is U13, and this
 * query is the single place that would change — the plan keeps "failed attempts as rhythm
 * slots" in that one open question rather than spread through the gates.
 */
export function qqInitiativeSpeechesInWindow(
  orm: Orm,
  scope: QqConversationScope,
  input: { nowSeconds: number; windowSeconds?: number },
): number {
  const windowSeconds = input.windowSeconds ?? QQ_RHYTHM_HOUR_SECONDS;
  if (!Number.isInteger(input.nowSeconds) || input.nowSeconds < 0) {
    throw new TypeError("Invalid QQ speech count input");
  }
  if (!Number.isInteger(windowSeconds) || windowSeconds <= 0) {
    throw new TypeError("Invalid QQ speech count input");
  }
  const row = orm
    .select({ n: count() })
    .from(schema.qqSpeechLog)
    .where(
      and(
        ...conditions(scope),
        inArray(schema.qqSpeechLog.kind, [...QQ_INITIATIVE_SPEECH_KINDS]),
        gt(schema.qqSpeechLog.spokeAtSeconds, input.nowSeconds - windowSeconds),
      ),
    )
    .get();
  return row?.n ?? 0;
}

/**
 * Retention sweep, on the same window as message text (qq-retention.ts). Forgetting an
 * expired initiative can only release the no-reply rule for a conversation that has
 * been quiet for the whole window, which is not one the assistant should keep speaking
 * into anyway.
 *
 * Bodies go first and by their own expiry, so the two lifetimes the separate table buys stay
 * separable: a body may be forgotten while the record that something was said here survives.
 */
export function purgeExpiredQqSpeech(orm: Orm, now: string = nowIso()): number {
  orm.delete(schema.qqSpeechText).where(lte(schema.qqSpeechText.expiresAt, now)).run();
  const expired = orm
    .select({ id: schema.qqSpeechLog.id })
    .from(schema.qqSpeechLog)
    .where(lte(schema.qqSpeechLog.expiresAt, now))
    .all();
  if (expired.length === 0) return 0;
  orm.delete(schema.qqSpeechLog).where(lte(schema.qqSpeechLog.expiresAt, now)).run();
  return expired.length;
}
