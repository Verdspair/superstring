// QQ 出站消息事实投影与 speech 引用核验（计划 T03/T04；规格 §4.1/§4.5/§13）。
//
// 入站消息事实投影（`loadQqMessageFact` / `loadQqMessageFactState` / `projectQqMessageFacts`）
// 已机械迁至 `../../services/qq-message-fact-projection.ts`（leaf 依赖边界修复）；channel
// 侧经 re-export 保持原 public API，调用方与测试零改动。入站与出站共用的 `botScope` /
// `collectMentions` 唯一实现也在该服务文件，出站路径按原逻辑引用。

import { eq } from "drizzle-orm";
import type { SourceRef } from "../../../shared/contracts/evidence";
import type {
  QqConversationScope,
  QqMessageFact,
  QqMessagePart,
} from "../../../shared/contracts/qq-message";
import { nowIso, type Orm } from "../../db/repositories";
import * as schema from "../../db/schema";
import { evidenceScopeExists } from "../../modules/conversation-evidence";
import type { EvidenceStore } from "../../modules/conversation-evidence-store";
import { botScope, collectMentions } from "../../services/qq-message-fact-projection";
import {
  type QqOutboundFactPartState,
  qqOutboundFactConsumableCap,
  qqOutboundFactNameState,
  qqOutboundFactSourceRevision,
  visibleQqOutboundFactPartState,
} from "../../services/qq-outbound-fact-sources";
import { isObservationExpired } from "../../services/qq-retention";
import { qqTextSegments } from "../../services/qq-send-transport";
import type { QqReplyTargetState } from "./reply-context";

export {
  loadQqMessageFact,
  loadQqMessageFactState,
  projectQqMessageFacts,
} from "../../services/qq-message-fact-projection";

/**
 * The actual wire segments for one confirmed text part, rebuilt with the same pure
 * encoder the send path used; the mapping to fact parts is mechanical: text→text,
 * at→mention. The encoder itself decides between the structured protocol (payload
 * mentions, no automatic recipient) and the legacy wire (body CQ + program recipient on
 * ordinal 0), so a historical part is never re-interpreted under the new rules.
 */
function outboundWireParts(state: {
  partKind: string;
  payloadText: string | null;
  payloadMentions: readonly string[] | null;
  partOrdinal: number;
  targetParticipantId: string | null;
}): QqMessagePart[] {
  if (state.partKind !== "text" || state.payloadText === null) {
    return [{ kind: "unavailable", type: "sticker" }];
  }
  const legacyRecipient = state.partOrdinal === 0 ? (state.targetParticipantId ?? null) : null;
  const payload =
    state.payloadMentions === null
      ? { text: state.payloadText }
      : { text: state.payloadText, mentions: state.payloadMentions };
  const parts: QqMessagePart[] = [];
  for (const segment of qqTextSegments(payload, legacyRecipient)) {
    if (segment.type === "text") parts.push({ kind: "text", text: segment.data.text });
    else if (segment.type === "at") parts.push({ kind: "mention", qq: segment.data.qq });
  }
  return parts;
}

/**
 * The projection body shared by the fact read and the state read: the located part becomes
 * exactly one `QqMessageFact` with its real identity snapshot, delivery journal seq and the
 * minted `qq_outbound_message_fact` ref. Split out so the two entry points below cannot
 * drift into two different definitions of the same part.
 */
function outboundFactOf(scope: QqConversationScope, state: QqOutboundFactPartState): QqMessageFact {
  const ref: SourceRef = {
    kind: "qq_outbound_message_fact",
    id: state.partId,
    revision: qqOutboundFactSourceRevision(scope, state),
    expiresAt: qqOutboundFactConsumableCap(state),
  };
  const parts = outboundWireParts(state);
  return {
    // 稳定内部身份 = 精确 outbound_parts.id（§2.3：QqMessageFact.id 是已确认发送部件 ID）。
    id: state.partId,
    platformMessageId: state.platformMessageId,
    seq: state.journalSeq,
    occurredAtSeconds: Math.floor(Date.parse(state.finishedAt) / 1000),
    speaker: {
      role: "assistant",
      // qq 是真实发送账号列；Agent UUID 从不充当 QQ 号（§3.2）。
      qq: state.accountId,
      groupCard: state.groupCard,
      personalNickname: state.personalNickname,
      legacyDisplayName: state.legacyDisplayName,
      nameState: qqOutboundFactNameState(state),
    },
    // 文本部件按真实发送线上片段重放（同 qqTextSegments 编码，at→mention）；sticker
    // 平台部件只标存在，不编图片/文本内容。
    parts,
    // 点名 = 线上真实 at 段（程序收件人 + 原文 CQ at），按实际顺序与重复收集。
    mentions: collectMentions(parts),
    // 出站部件没有引用关系；未知就是 null，不猜。
    replyTo: null,
    sources: [ref],
    completeness: state.partKind === "text" ? "full" : "unavailable",
  };
}

/**
 * The scoped, authorized read of one confirmed outbound part by its platform message ID.
 *
 * The caller's scope must exist in full (evidenceScopeExists, eight fields); the located
 * part must be a real confirmed `outbound_parts` row whose facts snapshot, intent target
 * (six dimensions + current authorityRevision) and delivery-journal attribution all agree
 * — otherwise `null` without revealing why. The projection carries exactly the located
 * part (never the whole multi-part output), the real identity snapshot of the sending
 * account (never the Agent UUID), the real delivery journal seq and a minted
 * `qq_outbound_message_fact` ref whose revision the unified access path recomputes.
 * Expired facts/intents are unreadable; sticker parts prove existence only and are never
 * interpreted into text.
 */
export function loadQqOutboundMessageFact(
  store: EvidenceStore,
  scope: QqConversationScope,
  platformMessageId: string,
  now: string = nowIso(),
): QqMessageFact | null {
  if (!evidenceScopeExists(store.db, botScope(scope))) return null;
  const state = visibleQqOutboundFactPartState(store.db, scope, { platformMessageId }, now);
  return state ? outboundFactOf(scope, state) : null;
}

/**
 * Which `qq_speech` source ids are **fully** carried by the outbound facts the caller just
 * projected, and which ones are only partly carried.
 *
 * The identity link is exact, not guessed: the send path writes one local fact under one id
 * (`recordQqSend` passes the `qq_send_log` row id into `recordQqSpeech`, so
 * `qq_speech_log.id === qq_send_log.id`), and `outbound_intents.legacy_send_id` points at that
 * same send row. So a speech source id is matched to an intent by
 * `speech.id === intent.legacy_send_id` inside the caller's own scope — never by body text and
 * never by timestamp.
 *
 * "Fully carried" is a strict bar, and it is what makes the caller's single-copy decision
 * safe. The bar is exactly the set the legacy speech body is built from: the send projection
 * joins the intent's **confirmed text** parts and nothing else, so the timeline body may be
 * dropped only when the caller really did project a fact for every one of *those* parts. A
 * sticker, a failed/unknown part and a never-sent part carry no words, so they neither count
 * toward the bar nor hold it back — demanding a fact for them would ask for a body that never
 * existed. A confirmed text part that has no platform message id, failed the loader, fell
 * outside the window, or expired is a different matter: the joined speech body is then still
 * the only readable copy of those words, so the speech line stays the single source and the
 * caller must not print those parts' bodies from the fact section either.
 *
 * A speech row with no matching intent (`legacy_send_id` is null, or the intent is from
 * another scope/epoch) is never returned: it is a standalone legacy utterance with no part
 * identity, and its words stay exactly as they are today.
 */
export function qqSpeechCarriedByOutboundFacts(input: {
  /** The `qq_speech` source ids actually present in the assembled timeline. */
  readonly speechSourceIds: readonly string[];
  /**
   * The **part id** each projected outbound fact came from, keyed by platform message id.
   *
   * Keyed by `outbound_parts.id`, not just "some fact has this platform id": `QqMessageFact.id`
   * IS the part id and the minted `qq_outbound_message_fact` ref carries the same value, so a
   * platform id alone could be satisfied by a different part's fact. Callers key this by
   * platform id (the only handle the projection hands back) but must store the part id as the
   * value; the check below then requires the very same part, never merely the same wire id.
   */
  readonly projectedByPlatformMessageId: ReadonlyMap<string, string>;
  readonly store: EvidenceStore;
  readonly scope: QqConversationScope;
  readonly now: string;
}): {
  /** Every confirmed text part of these intents is projected: the speech body is a duplicate. */
  readonly fullyCarriedSpeechIds: ReadonlySet<string>;
  /**
   * Some but not all confirmed text parts are projected: the speech body must stay the single
   * source, so those facts keep identity/relation and drop only their body text.
   */
  readonly partlyCarriedSpeechIds: ReadonlySet<string>;
  /** Part ids of the partly-carried intents, so the caller reuses this same located intent. */
  readonly partlyCarriedPartIds: ReadonlySet<string>;
} {
  const fullyCarried = new Set<string>();
  const partlyCarried = new Set<string>();
  const partlyPartIds = new Set<string>();
  const none = {
    fullyCarriedSpeechIds: fullyCarried,
    partlyCarriedSpeechIds: partlyCarried,
    partlyCarriedPartIds: partlyPartIds,
  };
  if (input.speechSourceIds.length === 0) return none;
  // The same eight-field scope check every other read in this module makes first. A scope
  // that does not exist proves nothing about which parts are carried, so nothing is dropped.
  if (!evidenceScopeExists(input.store.db, botScope(input.scope))) return none;
  const unique = [...new Set(input.speechSourceIds)];
  const rows = input.store.db
    .query(
      `SELECT i.id AS intentId,i.legacy_send_id AS speechId
      FROM outbound_intents i
      WHERE i.legacy_send_id IN (${unique.map(() => "?").join(",")})
        AND i.conversation_id=?
        AND json_extract(i.target,'$.accountId')=?
        AND json_extract(i.target,'$.conversationKind')=?
        AND json_extract(i.target,'$.peerId')=?
        AND json_extract(i.target,'$.agentId')=?
        AND json_extract(i.target,'$.bindingId')=?
        AND json_extract(i.target,'$.bindingEpoch')=?
        AND json_extract(i.target,'$.authorityRevision')=?`,
    )
    .all(
      ...unique,
      input.scope.conversationId,
      input.scope.accountId,
      input.scope.conversationKind,
      input.scope.peerId,
      input.scope.agentId,
      input.scope.bindingId,
      input.scope.bindingEpoch,
      input.scope.authorityRevision,
    ) as {
    intentId: string;
    speechId: string;
  }[];
  if (rows.length === 0) return none;
  // One send writes one speech row under one id, so each `legacy_send_id` should name exactly
  // one intent. If a row ever names two, neither side can be proven complete, so that id is
  // left out entirely (its speech body stays) rather than guessed either way.
  const intentIdBySpeech = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const row of rows) {
    if (intentIdBySpeech.has(row.speechId)) ambiguous.add(row.speechId);
    else intentIdBySpeech.set(row.speechId, row.intentId);
  }
  for (const [speechId, intentId] of intentIdBySpeech) {
    if (ambiguous.has(speechId)) continue;
    const parts = input.store.db
      .query(
        "SELECT id,kind,status,platform_message_id AS platformMessageId FROM outbound_parts WHERE intent_id=? ORDER BY ordinal ASC",
      )
      .all(intentId) as Array<{
      id: string;
      kind: string;
      status: string;
      platformMessageId: string | null;
    }>;
    // The carriage bar is exactly the set the legacy speech body is built from: the send
    // projection joins **confirmed text** parts only, so a sticker, a failed/unknown part or
    // a never-sent part contributes no words and cannot make the joined body incomplete.
    // Judging on the raw part list instead would demand a fact for words that never existed.
    const carriedTextParts = parts.filter(
      (part) => part.kind === "text" && part.status === "confirmed",
    );
    if (carriedTextParts.length === 0) continue;
    let projected = 0;
    for (const part of carriedTextParts) {
      if (part.platformMessageId === null || part.platformMessageId === "") continue;
      // Same part, not merely the same wire id.
      if (input.projectedByPlatformMessageId.get(part.platformMessageId) !== part.id) continue;
      projected += 1;
    }
    if (projected === carriedTextParts.length) {
      fullyCarried.add(speechId);
      continue;
    }
    if (projected > 0) {
      partlyCarried.add(speechId);
      for (const part of carriedTextParts) partlyPartIds.add(part.id);
    }
  }
  return {
    fullyCarriedSpeechIds: fullyCarried,
    partlyCarriedSpeechIds: partlyCarried,
    partlyCarriedPartIds: partlyPartIds,
  };
}
/**
 * The state-faithful read for a confirmed outbound part (the `qq_outbound_message_fact`
 * counterpart of `loadQqMessageFactState`; plan T04 Step3 / spec §4.3).
 *
 * Same single source of truth as the fact read — no permission SQL is duplicated and no new
 * taxonomy is invented. The verdict is reached in this order, and each step can only refuse,
 * never widen:
 *
 *   1. `evidenceScopeExists` — the caller's full eight-field scope must exist. A stale binding
 *      epoch, revoked authority, sibling group or different conversation fails here and learns
 *      nothing, not even that the part exists.
 *   2. `visibleQqOutboundFactPartState(db, scope, key, null)` — the expiry-free locate. It
 *      answers "is there a currently visible, still-authorized confirmed part here at all",
 *      and `now=null` deliberately skips the expiry verdict so this step can separate the
 *      cases. Anything it refuses (no rows, not confirmed, no platform ID, ambiguous claim,
 *      both ledgers disagree, foreign/legacy intent target, no delivery journal) is `missing`:
 *      it may be an unconfirmed draft, an unknown delivery, a revoked source or a foreign
 *      id, and this interface cannot prove which — reporting any of them would leak.
 *   3. Expiry is the *only* state this interface may add, and it is safe to express because
 *      step 2 proved the part is genuinely visible and authorized inside the caller's own
 *      scope: it is exactly the same evidence `expired` requires on the inbound side (the
 *      event provably existed in this scope, so only the window having passed is reported —
 *      never a body, an identity or a current name).
 *   4. `available` carries the fact, with the same currently readable sources the fact read
 *      mints. Sticker parts keep the inbound path's shape: the fact exists but carries no
 *      text.
 *
 * `revoked` and `legacy_unknown` are deliberately **not** re-derived here. Both already have
 * an exact, authorized verdict available — `qqOutboundFactSourceAccess` for a ref the caller
 * actually holds — and an outbound part has no legacy single-name row to be partial about.
 * Guessing them from a refused locate would invent a distinction this read cannot prove.
 */
export function loadQqOutboundMessageFactState(
  store: EvidenceStore,
  scope: QqConversationScope,
  platformMessageId: string,
  now: string = nowIso(),
): QqReplyTargetState {
  if (!evidenceScopeExists(store.db, botScope(scope))) return { state: "missing", fact: null };
  const state = visibleQqOutboundFactPartState(store.db, scope, { platformMessageId }, null);
  if (!state) return { state: "missing", fact: null };
  // 同 scope 可见且已授权：唯一可安全区分的不可读原因是期限已过（不给正文/身份/当前名）。
  if (
    isObservationExpired(state.factExpiresAt, now) ||
    isObservationExpired(state.intentExpiresAt, now)
  )
    return { state: "expired", fact: null };
  return { state: "available", fact: outboundFactOf(scope, state) };
}

/**
 * The assistant's own outbound facts for one intent: the platform identity snapshot plus
 * the confirmed part texts with their platform message IDs. Unconfirmed parts are omitted
 * from the projection entirely — they are not "sent原文" (§13.4).
 *
 * T03b 边界（2026-10-02 批次）：本函数尚无 scope 参数，不能作为已授权读取入口；本轮
 * 入站投影不改它、不调用它绕绑定，scope 化的重写在 T03b 落地。
 */
export function projectQqOutboundMessageFacts(
  orm: Orm,
  intentId: string,
  now: string = nowIso(),
): {
  identity: {
    qq: string;
    groupCard: string | null;
    personalNickname: string | null;
    legacyDisplayName: string | null;
    nameState: "known" | "unknown" | "legacy";
  } | null;
  parts: Array<{ ordinal: number; platformMessageId: string; text: string | null }>;
  expired: boolean;
} {
  const row = orm
    .select()
    .from(schema.qqOutboundMessageFacts)
    .where(eq(schema.qqOutboundMessageFacts.intentId, intentId))
    .get() as
    | {
        accountId: string;
        groupCard: string | null;
        personalNickname: string | null;
        legacyDisplayName: string | null;
        parts: string;
        revision: number;
        expiresAt: string;
      }
    | undefined;
  if (!row) return { identity: null, parts: [], expired: false };
  if (isObservationExpired(row.expiresAt, now)) {
    return { identity: null, parts: [], expired: true };
  }
  const stored = JSON.parse(row.parts) as Array<{
    kind: "text" | "sticker";
    ordinal: number;
    platformMessageId: string | null;
    text: string | null;
  }>;
  return {
    identity: {
      // qq 是真实发送账号列；Agent UUID 从不充当 QQ 号（§3.2）。
      qq: row.accountId,
      groupCard: row.groupCard,
      personalNickname: row.personalNickname,
      legacyDisplayName: row.legacyDisplayName,
      // 没有独立 state 列：从实际有效快照列推导（与 display 优先级一致）——
      // 群名片或个人昵称非空＝known；两者皆空且 legacy 非空＝legacy；全空＝unknown。
      nameState:
        row.groupCard !== null || row.personalNickname !== null
          ? "known"
          : row.legacyDisplayName !== null
            ? "legacy"
            : "unknown",
    },
    parts: stored
      .filter((p) => p.platformMessageId !== null)
      .map((p) => ({
        ordinal: p.ordinal,
        platformMessageId: p.platformMessageId!,
        text: p.text,
      })),
    expired: false,
  };
}
