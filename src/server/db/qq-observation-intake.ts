// Intake: turn one normalised QQ observation into durable rows.
//
// This is the boundary between "a message arrived over the wire" and "the memory
// machinery can use it". Two rows are written, with two different lifetimes:
//   * `qq_events` — the permanent dedup identity and the target of a memory's
//     provenance; and
//   * `qq_observation_text` — the body, which expires after the retention window.
//
// A media-only message is a real and important case. It gets its identity recorded —
// so a re-delivery is still de-duplicated and a future media description has
// something to attach to — but NO text row, because there is genuinely no text to
// read. It therefore never appears as a consolidation candidate. That is honest
// rather than convenient: we cannot summarise an image we cannot yet read.

import { and, desc, eq, inArray } from "drizzle-orm";
import { fail } from "../errors";
import type { QqObservation } from "../services/onebot-protocol";
import { recordMediaSegment } from "./qq-media-repository";
import { rememberQqMember } from "./qq-member-repository";
import { purgeExpiredObservationText, storeObservationText } from "./qq-observation-repository";
import { nowIso, type Orm } from "./repositories";
import * as schema from "./schema";

/**
 * The newest message a partner sent in this conversation, with the two facts the immediate reply
 * path needs (P5s): which event it is, and whether it was aimed at the assistant.
 *
 * Deliberately the same member/anonymous filter as `newestMemberMessageSeconds` — the screening is
 * the same question ("did a real partner speak?"), so the two must not drift apart.
 */
export function newestMemberEventFor(
  orm: Orm,
  scope: {
    accountId: string;
    conversationKind: "group" | "private";
    peerId: string;
    agentId: string;
  },
  options: {
    readonly attentionMembers?: readonly string[];
    /**
     * 只要"冲着助手来的"那一条（2026-09-25）。
     *
     * 为什么需要：立即路径此前只看**最新一条**消息，于是被 @ 之后、她开口之前只要群里又有人说了话，
     * 那条 @ 就不再是最新消息——这一轮会去回别人，或者（她还没说过话时）整轮跳过，@ 被静默丢掉。
     * 被叫到的那一条与最新的一条是两个不同的问题，所以这里给第二个问题一个显式的开关。
     */
    readonly addressedOnly?: boolean;
  } = {},
): {
  eventKey: string;
  occurredAtSeconds: number;
  addressed: boolean;
  /** 谁说的（匿名/系统为 null）——复核要不要跑，判据里要用它。 */
  speakerId: string | null;
} | null {
  const row = orm
    .select({
      eventKey: schema.qqEvents.eventKey,
      occurredAtSeconds: schema.qqEvents.occurredAtSeconds,
      addressed: schema.qqEvents.addressed,
      speakerId: schema.qqEvents.speakerId,
    })
    .from(schema.qqEvents)
    .where(
      and(
        eq(schema.qqEvents.accountId, scope.accountId),
        eq(schema.qqEvents.conversationKind, scope.conversationKind),
        eq(schema.qqEvents.peerId, scope.peerId),
        eq(schema.qqEvents.agentId, scope.agentId),
        inArray(schema.qqEvents.speakerKind, ["member", "anonymous"]),
        ...(options.addressedOnly ? [eq(schema.qqEvents.addressed, 1)] : []),
        // 0031: the hard attention mode narrows "did a real partner speak?" to the listed people,
        // so an @ from anyone else cannot start a reply either. Passed in rather than read from the
        // binding here, because this function's caller already resolved the binding and its mode.
        ...(options.attentionMembers === undefined
          ? []
          : [inArray(schema.qqEvents.speakerId, [...options.attentionMembers])]),
      ),
    )
    .orderBy(desc(schema.qqEvents.occurredAtSeconds), desc(schema.qqEvents.eventKey))
    .limit(1)
    .get();
  if (!row) return null;
  return Object.freeze({
    eventKey: row.eventKey,
    occurredAtSeconds: row.occurredAtSeconds,
    // NULL is a row written before migration 0027. "Unknown" is read as "not addressed": the
    // other direction answers messages nobody aimed at the assistant.
    addressed: row.addressed === 1,
    speakerId: row.speakerId,
  });
}

/**
 * 这一轮写好的句子要不要因为"群里又有新消息"而重来（用户 2026-09-25）。
 *
 * 原来的判据是"群友事件数变了"——活跃群里任何一句闲话都会触发一次复核模型调用。用户选的口径是：
 * **只有冲着她来的新消息（被 @、回复她、私聊）或者来自她正在回的那个人**才值得重来；别人插一句
 * 无关的话，句子照发。
 *
 * 纯规则，读的事实由调用方给：`newest` 是当下最新的一条群友事件（含是否被叫到与发言人）。
 */
export function memberEventNeedsReview(input: {
  readonly newest: { readonly addressed: boolean; readonly speakerId: string | null } | null;
  /** 这一轮在回谁；`null`＝没有具体对象（冷场发起）或匿名。 */
  readonly targetSpeakerId: string | null;
}): boolean {
  if (input.newest === null) return false;
  if (input.newest.addressed) return true;
  return input.targetSpeakerId !== null && input.newest.speakerId === input.targetSpeakerId;
}

export interface RecordedObservation {
  readonly eventKey: string;
  /** `false` when this delivery was a duplicate and nothing new was written. */
  readonly recorded: boolean;
  /** `false` for a media-only message: identity recorded, no body to read. */
  readonly hasText: boolean;
}

function speakerIdOf(observation: QqObservation): string | null {
  return observation.speaker.kind === "member" ? observation.speaker.id : null;
}

/**
 * Record one observation for an assistant.
 *
 * Idempotent by `event_key`: a re-delivered message returns `recorded: false` and
 * leaves the existing rows untouched, because the identity is permanent and must not
 * be rewritten by a later delivery. A delivery that reuses an existing key but
 * describes a *different* message, speaker or conversation is refused instead of
 * merged — silently accepting it would let one message's identity stand for another's
 * content, which is exactly what provenance integrity depends on.
 */
export function recordObservation(
  orm: Orm,
  observation: QqObservation,
  agentId: string,
): RecordedObservation {
  return orm.transaction((tx) => writeObservation(tx, observation, agentId));
}

function writeObservation(
  orm: Orm,
  observation: QqObservation,
  agentId: string,
): RecordedObservation {
  const speakerId = speakerIdOf(observation);
  if (observation.speaker.kind === "member" && speakerId === null) {
    fail("MEMORY_SOURCE_INVALID", "成员发言缺少身份，不能记录");
  }

  const existing = orm
    .select()
    .from(schema.qqEvents)
    .where(eq(schema.qqEvents.eventKey, observation.eventKey))
    .get();
  if (existing) {
    const same =
      existing.accountId === observation.accountId &&
      existing.conversationKind === observation.conversation.kind &&
      existing.peerId === observation.conversation.peerId &&
      existing.agentId === agentId &&
      existing.messageId === observation.messageId &&
      existing.occurredAtSeconds === observation.occurredAtSeconds &&
      existing.speakerKind === observation.speaker.kind &&
      existing.speakerId === speakerId;
    if (!same) {
      fail("MEMORY_SOURCE_INVALID", "同一事件键描述了不同消息，拒绝覆盖");
    }
    return { eventKey: observation.eventKey, recorded: false, hasText: false };
  }

  orm
    .insert(schema.qqEvents)
    .values({
      eventKey: observation.eventKey,
      accountId: observation.accountId,
      conversationKind: observation.conversation.kind,
      peerId: observation.conversation.peerId,
      agentId,
      messageId: observation.messageId,
      occurredAtSeconds: observation.occurredAtSeconds,
      speakerKind: observation.speaker.kind,
      speakerId,
      // P5r: the immediate reply path reads this fact from the ROW on a later pass, because the
      // global one-chain rule can make a message wait; recording it only in the delivery would
      // leave that pass guessing whether the assistant was called.
      addressed: observation.mentionsSelf || observation.conversation.kind === "private" ? 1 : 0,
      recordedAt: nowIso(),
    })
    .run();

  // Display-only metadata cannot invalidate a valid message; no nickname history is kept.
  const nickname = observation.speaker.displayName?.trim();
  if (speakerId !== null && nickname && [...nickname].length <= 64) {
    rememberQqMember(orm, {
      scope: {
        accountId: observation.accountId,
        conversationKind: observation.conversation.kind,
        peerId: observation.conversation.peerId,
      },
      userId: speakerId,
      nickname,
      seenAtSeconds: observation.occurredAtSeconds,
    });
  }
  // Preserve upstream references in the same transaction as the event identity.
  // A missing reference is unreadable, not an invented description or a file fetch.
  for (const [segmentIndex, segment] of observation.segments.entries()) {
    if (
      segment.kind !== "image" &&
      segment.kind !== "record" &&
      segment.kind !== "video" &&
      segment.kind !== "file"
    )
      continue;
    const sourceRef = segment.file?.trim() || segment.url?.trim();
    if (!sourceRef) continue;
    recordMediaSegment(orm, {
      eventKey: observation.eventKey,
      segmentIndex,
      kind: segment.kind,
      sourceRef,
      occurredAtSeconds: observation.occurredAtSeconds,
      // §7.1/§7.2's asymmetry is a fact of the delivery, so it is recorded with the segment:
      // a group message only counts as addressed when it mentions this account, while a private
      // message is addressed by construction.
      addressed: observation.mentionsSelf || observation.conversation.kind === "private",
    });
  }
  const body = observation.text.trim();
  if (body.length === 0) {
    // Media-only (or otherwise textless): identity yes, body no.
    return { eventKey: observation.eventKey, recorded: true, hasText: false };
  }
  storeObservationText(orm, {
    eventKey: observation.eventKey,
    body: observation.text,
    occurredAtSeconds: observation.occurredAtSeconds,
  });
  return { eventKey: observation.eventKey, recorded: true, hasText: true };
}

/**
 * Retention sweep, safe to call at any time. Only expired bodies are removed; the
 * dedup identities and every memory's provenance are untouched, so a memory whose
 * source text has expired stays valid and merely stops being re-readable.
 */
export function sweepObservations(orm: Orm, now: string = nowIso()): number {
  return purgeExpiredObservationText(orm, now);
}
