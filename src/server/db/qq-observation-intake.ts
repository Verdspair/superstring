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
import type { QqMessagePart } from "../../shared/contracts/qq-message";
import { QQ_SYSTEM_FACE_LABELS } from "../../shared/qq-system-face-labels";
import { fail } from "../errors";
import type { QqObservation } from "../services/onebot-protocol";
import { recordMediaSegment } from "./qq-media-repository";
import { readQqMemberNames, rememberQqMember, rememberQqMemberNames } from "./qq-member-repository";
import { backfillQqMessageFact, recordQqMessageFact } from "./qq-message-repository";
import { purgeExpiredObservationText, storeObservationText } from "./qq-observation-repository";
import { readQqRetentionDays } from "./qq-settings-repository";
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
 * 这一轮写好的句子要不要因为"群里又有新消息"而重来。
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
 * The current two-name directory update (§3.1): presence is preserved field-by-field —
 * `undefined` means "not provided this time" (keep the local value), `null` means the
 * upstream explicitly blanked it (clear). Collapsing undefined into null would throw
 * away a still-valid local card/nickname just because the other field was absent.
 */
function currentNames(observation: QqObservation): {
  readonly groupCard?: string | null;
  readonly personalNickname?: string | null;
  readonly nameState: "known" | "unknown" | "legacy";
} {
  const speaker = observation.speaker;
  if (speaker.kind !== "member") {
    return { groupCard: null, personalNickname: null, nameState: "unknown" };
  }
  // 缺省键整个不出现（沿用本地）；显式空白才置 null（清空）。两个字段独立，不互相归并。
  const names: {
    groupCard?: string | null;
    personalNickname?: string | null;
    nameState: "known" | "unknown" | "legacy";
  } = {
    nameState: "unknown",
  };
  if (speaker.groupCard !== undefined) names.groupCard = speaker.groupCard;
  if (speaker.personalNickname !== undefined) names.personalNickname = speaker.personalNickname;
  return names;
}

/**
 * Resolve the two-name snapshot to store with THIS message (§3.1): wire values win; an
 * explicit blank is a clearing recorded with source "wire" (a wire-verified "no name" is a
 * fact, distinct from an absent field); an absent field falls back to the local current
 * value, recorded as source "local" (never mislabelled as the wire value of this delivery);
 * no evidence at all stays value-null/source-null. A legacy directory row only contributes
 * its single legacy evidence when BOTH wire fields are absent — a blank wire field means the
 * message had no name, and legacy history is not that message's evidence.
 *
 * F1/F4: an absent wire field falls back to the CURRENT directory read at resolve time.
 * That fallback is time-dependent, so it must never rewrite an already-preserved snapshot —
 * the idempotent path only feeds names to backfill when the wire actually carried them
 * (see the redelivery branch in `writeObservation`).
 */
function resolveNameSnapshot(
  orm: Orm,
  observation: QqObservation,
  scope: { accountId: string; conversationKind: "group" | "private"; peerId: string },
): {
  groupCard: string | null;
  groupCardSource: "wire" | "local" | null;
  personalNickname: string | null;
  personalNicknameSource: "wire" | "local" | null;
  legacyDisplayName: string | null;
  nameState: "known" | "unknown" | "legacy";
} {
  const speaker = observation.speaker;
  if (speaker.kind !== "member") {
    // §3.2：匿名明确"QQ号不可用"，不编真实号；系统通知同理。不把不同匿名归并成一个人。
    return {
      groupCard: null,
      groupCardSource: null,
      personalNickname: null,
      personalNicknameSource: null,
      legacyDisplayName: null,
      nameState: "unknown",
    };
  }
  const wireCard = speaker.groupCard;
  const wireNickname = speaker.personalNickname;
  const wireCardKnown = typeof wireCard === "string";
  const wireNicknameKnown = typeof wireNickname === "string";
  // 双字段都以 wire 原值齐备：无时间依赖，不需要读目录。
  if (wireCardKnown && wireNicknameKnown) {
    return {
      groupCard: wireCard,
      groupCardSource: "wire",
      personalNickname: wireNickname,
      personalNicknameSource: "wire",
      legacyDisplayName: null,
      nameState: wireCard !== "" || wireNickname !== "" ? "known" : "unknown",
    };
  }
  // 有 undefined（缺省）字段：读目录一次补齐（§3.1 字段未提供可用本地有效值）。
  // 显式清空（null）的字段不借目录；legacy 借用只在双字段皆缺省时发生——显式清空是
  // "本次明确无名字"，旧目录单昵称不是这条消息的证据（§13.5 不伪造历史名字）。
  const legacyAllowed = wireCard === undefined && wireNickname === undefined;
  const current = readQqMemberNames(orm, scope, speaker.id!);
  if (legacyAllowed && current?.nameState === "legacy") {
    // legacy 单昵称不伪造成 wire/local 双名：双名字段值与来源都保持无证据（§13.5）。
    return {
      groupCard: null,
      groupCardSource: null,
      personalNickname: null,
      personalNicknameSource: null,
      legacyDisplayName: current.legacyDisplayName,
      nameState: "legacy",
    };
  }
  // 逐字段：wire 原值（含显式清空）记 'wire'；缺省借本地有效值记 'local'，本地也没有
  // 就保持无证据（null/null）——不把"没有证据"伪造成任何来源。
  const groupCard = wireCardKnown
    ? { value: wireCard, source: "wire" as const }
    : wireCard === undefined
      ? scope.conversationKind === "group" && current?.groupCard
        ? { value: current.groupCard, source: "local" as const }
        : { value: null, source: null }
      : { value: null, source: "wire" as const };
  const personalNickname = wireNicknameKnown
    ? { value: wireNickname, source: "wire" as const }
    : wireNickname === undefined
      ? current?.personalNickname
        ? { value: current.personalNickname, source: "local" as const }
        : { value: null, source: null }
      : { value: null, source: "wire" as const };
  const nameState: "known" | "unknown" =
    groupCard.value || personalNickname.value ? "known" : "unknown";
  return {
    groupCard: groupCard.value,
    groupCardSource: groupCard.source,
    personalNickname: personalNickname.value,
    personalNicknameSource: personalNickname.source,
    legacyDisplayName: null,
    nameState,
  };
}

/**
 * Whether this delivery's names may take part in a backfill of an EXISTING permanent
 * identity (F1). Only explicitly wire-provided fields are facts of the message itself:
 * a wire value (or wire-verified blank) is recorded as source "wire"; an absent field is
 * value-null/source-null — its local fallback depends on the directory at resolve time,
 * and letting it rewrite history would turn a legal redelivery into a conflict after a
 * rename.
 */
function wireNameFacts(observation: QqObservation): {
  groupCard: string | null;
  groupCardSource: "wire" | null;
  personalNickname: string | null;
  personalNicknameSource: "wire" | null;
  legacyDisplayName: string | null;
  nameState: "known" | "unknown" | "legacy";
} {
  const speaker = observation.speaker;
  if (speaker.kind !== "member") {
    return {
      groupCard: null,
      groupCardSource: null,
      personalNickname: null,
      personalNicknameSource: null,
      legacyDisplayName: null,
      nameState: "unknown",
    };
  }
  // 只认 wire 原值：string 是事实、显式空白是已核清空（null＋'wire'）、缺省按缺失
  // （null＋NULL）——不把缺省伪造成 wire 事实。
  const groupCard =
    typeof speaker.groupCard === "string" && speaker.groupCard !== "" ? speaker.groupCard : null;
  const groupCardSource = speaker.groupCard === undefined ? null : ("wire" as const);
  const personalNickname =
    typeof speaker.personalNickname === "string" && speaker.personalNickname !== ""
      ? speaker.personalNickname
      : null;
  const personalNicknameSource = speaker.personalNickname === undefined ? null : ("wire" as const);
  return {
    groupCard,
    groupCardSource,
    personalNickname,
    personalNicknameSource,
    legacyDisplayName: null,
    nameState: groupCard || personalNickname ? "known" : "unknown",
  };
}

/**
 * Ordered message parts for the fact row: media presence facts plus text, in wire order.
 * Image segments reference the stable media note row created in the same transaction —
 * the media row is the verifiable identity, not a guessed description. The only category
 * the intake can verify is "unknown": classification is a later, separately-sourced fact.
 */
function factParts(
  observation: QqObservation,
  mediaIds: ReadonlyMap<number, string>,
): QqMessagePart[] {
  const parts: QqMessagePart[] = [];
  for (const [segmentIndex, segment] of observation.segments.entries()) {
    switch (segment.kind) {
      case "text":
        parts.push({ kind: "text", text: segment.text });
        break;
      case "mention":
        parts.push({ kind: "mention", qq: segment.target });
        break;
      case "reply":
        // 引用关系单列（reply_to_message_id 列），片段数组只存真实内容片段——
        // reply 不是一种未知媒体，不造 unavailable 占位（§4.1）。
        break;
      case "face":
        // 官方系统表情表命中即用官方短名（OneBot 归一已去前导零，直接按 id 查）；
        // 未命中仍 null（§7.3：不填模型猜测的表情名称），不报错、不走 vision。
        parts.push({
          kind: "face",
          id: segment.id,
          name: QQ_SYSTEM_FACE_LABELS[segment.id] ?? null,
        });
        break;
      case "image": {
        const mediaId = mediaIds.get(segmentIndex);
        if (mediaId === undefined) {
          // 没有可引用的引用行（没有 file/url 的 image）：存在性无法核实，如实标记。
          parts.push({ kind: "unavailable", type: "image" });
          break;
        }
        // 规格 §7.2：market face 三键同现是平台可靠表情证据（协议层已核形）；
        // 其余图一律 unknown——分类是后续、来源分明的事实，intake 不猜。
        parts.push({
          kind: "image",
          mediaId,
          category: segment.categoryEvidence === "expression" ? "expression" : "unknown",
        });
        break;
      }
      case "record":
      case "video":
      case "file":
        parts.push({ kind: "unavailable", type: segment.kind });
        break;
      default:
        parts.push({ kind: "unavailable", type: segment.type });
        break;
    }
  }
  return parts;
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
  hooks?: { beforeWrite?: () => void; afterWrite?: (result: RecordedObservation) => void },
): RecordedObservation {
  return orm.transaction((tx) => {
    hooks?.beforeWrite?.();
    const result = writeObservation(tx, observation, agentId);
    hooks?.afterWrite?.(result);
    return result;
  });
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

  // 一次观察只读一次保留窗口，本次写出的三处到期戳（昵称/媒体/正文）用同一个数：
  // 同一批行若各自读设置，保存与写入交错时会得到两个窗口，"同一句话的各个部分同时到期"
  // 这个不变量就不再成立。改动只影响之后写出的行，不会回改任何已存在的到期戳。
  const retentionDays = readQqRetentionDays(orm);

  // 规格 §3.1：发送时双昵称快照。缺省（undefined）可取本地有效值并记录来源；显式空白 card
  // 是清空——不沿用旧 card，回退个人昵称。快照是这条消息自己的事实，先于任何派生写入。
  // （F1/F4：幂等再交付分支不使用该 snapshot 的姓名部分——回填只认 wire 事实；快照解析
  // 有目录读这一时间依赖，也在 existing 早回之后才发生，重放不白读目录。）

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
    // 同一永久 identity 的再交付：journal append 可能先占了位（facts 缺失或不完整）。
    // 这里补**缺失**的事实（§4.5）：逐字段合并、冲突拒绝；媒体行幂等重建（同位置同引用
    // 返回原行），image 片段可借它补上稳定 ID。不延 expiry、不重排 journal、正文行不动
    // （过期正文不得借再交付复活）。
    // F1：姓名只回填**本次明确 wire 事实**。wire 缺省字段的 local 回退取的是"现在"的目录，
    // 不是发送时事实——不能让目录改名把合法重放变成冲突，也不能用最新目录伪发送时名。
    const mediaIds = new Map<number, string>();
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
      const note = recordMediaSegment(
        orm,
        {
          eventKey: observation.eventKey,
          segmentIndex,
          kind: segment.kind,
          sourceRef,
          occurredAtSeconds: observation.occurredAtSeconds,
          addressed: observation.mentionsSelf || observation.conversation.kind === "private",
        },
        retentionDays,
      );
      if (segment.kind === "image") mediaIds.set(segmentIndex, note.id);
    }
    backfillQqMessageFact(
      orm,
      {
        eventKey: observation.eventKey,
        ...wireNameFacts(observation),
        parts: factParts(observation, mediaIds),
        replyToMessageId: observation.replyToMessageId ?? null,
        occurredAtSeconds: observation.occurredAtSeconds,
      },
      retentionDays,
    );
    return { eventKey: observation.eventKey, recorded: false, hasText: false };
  }

  // 快照解析在 existing 早回之后：时间依赖的 local 回退只发生在"这条消息第一次落库"
  // 的路径上（F1：重放不读目录、不按现在的目录改写历史快照）。
  const snapshot = resolveNameSnapshot(orm, observation, {
    accountId: observation.accountId,
    conversationKind: observation.conversation.kind,
    peerId: observation.conversation.peerId,
  });

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

  // Preserve upstream references in the same transaction as the event identity.
  // A missing reference is unreadable, not an invented description or a file fetch.
  // 媒体引用行先于事实行落库（同一事务）：factParts 的 image 片段需要引用这些行的
  // 稳定 ID。这里只落存在/引用（§7.1），不读取字节、不下载。
  const mediaIds = new Map<number, string>();
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
    const note = recordMediaSegment(
      orm,
      {
        eventKey: observation.eventKey,
        segmentIndex,
        kind: segment.kind,
        sourceRef,
        occurredAtSeconds: observation.occurredAtSeconds,
        // §7.1/§7.2's asymmetry is a fact of the delivery, so it is recorded with the segment:
        // a group message only counts as addressed when it mentions this account, while a private
        // message is addressed by construction.
        addressed: observation.mentionsSelf || observation.conversation.kind === "private",
      },
      retentionDays,
    );
    if (segment.kind === "image") mediaIds.set(segmentIndex, note.id);
  }

  // 事实先落（计划 Step4：先写永久身份+私有 facts，再 journal 派生）。事件刚在本事务插入，
  // 外键可满足；正文随后写入。
  recordQqMessageFact(
    orm,
    {
      eventKey: observation.eventKey,
      groupCard: snapshot.groupCard,
      groupCardSource: snapshot.groupCardSource,
      personalNickname: snapshot.personalNickname,
      personalNicknameSource: snapshot.personalNicknameSource,
      legacyDisplayName: snapshot.legacyDisplayName,
      nameState: snapshot.nameState,
      parts: factParts(observation, mediaIds),
      replyToMessageId: observation.replyToMessageId ?? null,
      occurredAtSeconds: observation.occurredAtSeconds,
    },
    retentionDays,
  );

  // 当前双昵称目录（§3.1）：显式空白 card 清空当前 card；缺省沿用本地；只有更新的观察前进。
  // 必须先于 legacy nickname 写入：两者同为一次观察，先写者推进 last_seen，后写者同秒只补
  // 旧列，不会互相吞掉。
  if (speakerId !== null) {
    rememberQqMemberNames(
      orm,
      {
        scope: {
          accountId: observation.accountId,
          conversationKind: observation.conversation.kind,
          peerId: observation.conversation.peerId,
        },
        userId: speakerId,
        names: currentNames(observation),
        seenAtSeconds: observation.occurredAtSeconds,
      },
      retentionDays,
    );
  }
  // Display-only metadata cannot invalidate a valid message; no nickname history is kept.
  const nickname = observation.speaker.displayName?.trim();
  if (speakerId !== null && nickname && [...nickname].length <= 64) {
    rememberQqMember(
      orm,
      {
        scope: {
          accountId: observation.accountId,
          conversationKind: observation.conversation.kind,
          peerId: observation.conversation.peerId,
        },
        userId: speakerId,
        nickname,
        seenAtSeconds: observation.occurredAtSeconds,
      },
      retentionDays,
    );
  }
  const body = observation.text.trim();
  if (body.length === 0) {
    // Media-only (or otherwise textless): identity yes, body no.
    return { eventKey: observation.eventKey, recorded: true, hasText: false };
  }
  storeObservationText(
    orm,
    {
      eventKey: observation.eventKey,
      body: observation.text,
      occurredAtSeconds: observation.occurredAtSeconds,
    },
    retentionDays,
  );
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
