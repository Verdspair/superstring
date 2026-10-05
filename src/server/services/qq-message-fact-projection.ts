// QQ 消息事实投影（计划 T03 Step8；规格 §4.1/§4.5/§13）。
//
// 对外锁定接口（计划 §2.3）：
//   * `loadQqMessageFact(store, scope, platformMessageId, now)` — 按平台消息 ID 投影一条
//     消息的事实；
//   * `projectQqMessageFacts(store, scope, eventIds, now)` — 按内部事件键批量投影。
//
// 授权与时间线判定复用统一证据模块的既有路径：`evidenceScopeExists`（conversation/
// binding epoch/authority/账号/kind/peer/Agent/bindingId 完整校验）与 `inTimeline`
// （真实 conversation_events 存在判定），不另建宽读路径。一条消息的事实来自 qq_events
// （永久身份，SQL 内 scope 过滤）关联的 qq_message_facts（可过期快照），正文按
// qq_observation 的独立期限复验。它绝不借 member 的当前昵称、永久事件行或 facts 的
// partsJSON "复活"过期/删除的内容——正文与事实到期时给明确的不可读，不猜。当前昵称
// 只作为 `currentName` 单列映射（仅目录有效来源），不写回发送时快照。
//
// 2026-10-04 leaf 依赖边界修复：本文件自 channels/onebot11/message-projection.ts 机械迁出，
// 函数体/判断/默认/来源 guards 原文未改；channel 侧对 `loadQqMessageFact` /
// `loadQqMessageFactState` / `projectQqMessageFacts` 经 re-export 保持原 public API。
// `botScope` 与 `collectMentions` 为入站与出站投影共用，唯一实现在本文件，出站路径
// 按原逻辑引用。

import { and, eq } from "drizzle-orm";
import type { SourceRef } from "../../shared/contracts/evidence";
import type {
  QqConversationScope,
  QqIdentity,
  QqMessageFact,
  QqMessagePart,
} from "../../shared/contracts/qq-message";
import type { QqReplyTargetState } from "../channels/onebot11/reply-context";
import { bodyRevision } from "../db/conversation-event-repository";
import { readQqMemberNames } from "../db/qq-member-repository";
import type { QqMessageFactRow } from "../db/qq-message-repository";
import { nowIso, type Orm } from "../db/repositories";
import * as schema from "../db/schema";
import type { BotEvidenceScope } from "../modules/conversation-evidence";
import { evidenceScopeExists } from "../modules/conversation-evidence";
import type { EvidenceStore } from "../modules/conversation-evidence-store";
import { inTimeline } from "../modules/conversation-evidence-store";
import {
  qqMessageFactConsumableCap,
  qqMessageFactSourceRevision,
  visibleFactState,
} from "./qq-message-fact-sources";
import { isObservationExpired } from "./qq-retention";

export function botScope(scope: QqConversationScope): BotEvidenceScope {
  return { channel: "onebot11", ...scope };
}

/** 当前昵称的单列映射（仅本地目录、有效来源）；legacy 行与空目录都不冒充。 */
function currentNameOf(
  store: EvidenceStore,
  scope: QqConversationScope,
  speakerId: string | null,
  now: string,
): QqIdentity["currentName"] {
  if (speakerId === null) return undefined;
  const names = readQqMemberNames(
    store.orm,
    {
      accountId: scope.accountId,
      conversationKind: scope.conversationKind,
      peerId: scope.peerId,
    },
    speakerId,
    now,
  );
  if (!names || names.nameState === "legacy") return undefined;
  if (names.groupCard === null && names.personalNickname === null) return undefined;
  return { groupCard: names.groupCard, personalNickname: names.personalNickname };
}

function identityOf(
  row: {
    groupCard: string | null;
    personalNickname: string | null;
    legacyDisplayName: string | null;
    nameState: string;
  },
  speakerId: string | null,
  speakerKind: string,
  currentName: QqIdentity["currentName"],
): QqIdentity {
  if (speakerKind === "member") {
    return {
      role: "member",
      qq: speakerId,
      groupCard: row.groupCard,
      personalNickname: row.personalNickname,
      legacyDisplayName: row.legacyDisplayName,
      nameState:
        row.nameState === "known" || row.nameState === "legacy" ? row.nameState : "unknown",
      ...(currentName ? { currentName } : {}),
    };
  }
  if (speakerKind === "anonymous") {
    // §3.2：匿名明确"QQ号不可用"，不归并为一个长期人物，也不编号。
    return {
      role: "anonymous",
      qq: null,
      groupCard: null,
      personalNickname: null,
      legacyDisplayName: null,
      nameState: "unknown",
    };
  }
  return {
    role: "member",
    qq: null,
    groupCard: null,
    personalNickname: null,
    legacyDisplayName: null,
    nameState: "unknown",
  };
}

/**
 * One message's fact row + event identity, filtered by the permanent event scope in SQL
 * (account/kind/peer/agent + platform message ID). A rejected lookup returns nothing, so
 * a cross-conversation platform ID cannot even be seen (§4.3). Two rows for one platform
 * ID cannot be resolved to "which author" and are refused instead of guessed.
 */
function lookupByPlatformId(
  orm: Orm,
  scope: QqConversationScope,
  platformMessageId: string,
): { fact: QqMessageFactRow; event: EventRow } | null {
  const rows = orm
    .select({ fact: schema.qqMessageFacts, event: schema.qqEvents })
    .from(schema.qqEvents)
    .innerJoin(schema.qqMessageFacts, eq(schema.qqMessageFacts.eventKey, schema.qqEvents.eventKey))
    .where(
      and(
        eq(schema.qqEvents.accountId, scope.accountId),
        eq(schema.qqEvents.conversationKind, scope.conversationKind),
        eq(schema.qqEvents.peerId, scope.peerId),
        eq(schema.qqEvents.agentId, scope.agentId),
        eq(schema.qqEvents.messageId, platformMessageId),
      ),
    )
    .all();
  if (rows.length !== 1) return null;
  return { fact: rows[0]!.fact, event: rows[0]!.event };
}

interface EventRow {
  eventKey: string;
  messageId: string;
  occurredAtSeconds: number;
  speakerId: string | null;
  speakerKind: string;
  recordedAt: string;
}

function eventById(orm: Orm, scope: QqConversationScope, eventKey: string): EventRow | null {
  return (
    (orm
      .select()
      .from(schema.qqEvents)
      .where(
        and(
          eq(schema.qqEvents.eventKey, eventKey),
          eq(schema.qqEvents.accountId, scope.accountId),
          eq(schema.qqEvents.conversationKind, scope.conversationKind),
          eq(schema.qqEvents.peerId, scope.peerId),
          eq(schema.qqEvents.agentId, scope.agentId),
        ),
      )
      .get() as EventRow | null) ?? null
  );
}

/**
 * The body is separately expiring evidence: a deleted or expired `qq_observation_text`
 * row removes the text source, and the facts parts alone must never restore it. The
 * observation source rides the same window as the body.
 */
function bodyRow(
  orm: Orm,
  eventKey: string,
  now: string,
): { body: string; expiresAt: string } | null {
  const row = orm
    .select({ body: schema.qqObservationText.body, expiresAt: schema.qqObservationText.expiresAt })
    .from(schema.qqObservationText)
    .where(eq(schema.qqObservationText.eventKey, eventKey))
    .get();
  if (!row || isObservationExpired(row.expiresAt, now)) return null;
  return row;
}

/**
 * The single state-faithful read behind both projections (spec §4.3: unreadable states
 * are expressed separately, never collapsed). One authorization path for both consumers:
 * scope-filtered SQL lookup, timeline re-check, snapshot/body windows checked
 * independently. The outcome is the tagged state plus — for every case that reaches the
 * fact build — the same fact projection `loadQqMessageFact` has always returned:
 *
 *   * `missing` — not recorded in this scope, or the journal/timeline re-check fails (a
 *     cross-scope/foreign-owner id resolves here too: the SQL scope filter runs before
 *     any row is read, so nothing about the target, not even its existence, is provable);
 *   * `expired` — the fact snapshot window has passed in the caller's own scope (which
 *     proves the message once existed there, so the state is safe to express); never
 *     reaches the fact build: no body, identity or current-name is loaded;
 *   * `revoked` — body deleted/expired/rewritten (revision drift); the verified snapshot
 *     identity stays valid but the text is never restored from parts;
 *   * `legacy_unknown` — legacy single-name row, expressed as the legacy relation gap;
 *   * `available` — everything current.
 *
 * `loadQqMessageFactState` strips the fact for every non-`available` state (an expired
 * or revoked fact must never be registrable as general material or a SourceRef);
 * `projectOne` keeps the readable contract unchanged — `null` only for missing/expired,
 * the redacted fact for revoked/legacy rows.
 */
function projectOneState(
  store: EvidenceStore,
  scope: QqConversationScope,
  platformMessageId: string,
  now: string,
): QqReplyTargetState {
  const found = lookupByPlatformId(store.orm, scope, platformMessageId);
  if (!found) return { state: "missing", fact: null };
  const { fact, event } = found;
  // journal 存在性复验（inbound 来源）先于到期标签：事件必须在当前 scope 的 timeline 里，
  // 且带本 conversation 的真实 inbound seq。lookup 只按 account/kind/peer/agent 四维匹配，
  // 不含 conversationId——关闭重开（binding epoch 推进）后同一四维在库里的旧 fact 不能凭
  // 快照到期就向新 conversation 泄露「曾存在」；新 conversation 没有该事件的 journal 来源
  // → missing。同 conversation 的合法 owner 才能拿到 expired（同库可证曾存在）。
  if (!inTimeline(store.db, botScope(scope), "qq_event", event.eventKey)) {
    return { state: "missing", fact: null };
  }
  const seqRow = store.db
    .query(
      `SELECT seq FROM conversation_events WHERE conversation_id=? AND source_id=? AND
      source_kind='qq_event' AND kind='inbound' LIMIT 1`,
    )
    .get(scope.conversationId, event.eventKey) as { seq: number } | null;
  if (!seqRow) return { state: "missing", fact: null };
  // 事实快照过期：整个事实不可用——永久事件身份不当正文授权（§4.5），也不能经
  // member 当前名字复活。本 conversation timeline 在场才安全表达 expired（无正文/身份）。
  if (isObservationExpired(fact.expiresAt, now)) return { state: "expired", fact: null };
  const state = visibleFactState(store.db, scope, event.eventKey, now);
  if (!state) return { state: "missing", fact: null };
  const { visibleParts: parts, textConsistency: consistency } = state;
  // 可见事实摘要 + 期限 + 正文修订：正文/快照变化都会改变 revision，旧 projection 失效。
  const revision = qqMessageFactSourceRevision(scope, fact, parts, state.bodyRevisionValue);
  const sources: SourceRef[] = [
    // 只有可复验的过期事实来源；永久 qq_event 身份不是正文/事实证据，不作为 ref
    // （没有统一 resolver 的 kind 会让父 source 复验失败，§4.5）。
    {
      kind: "qq_message_fact",
      id: event.eventKey,
      revision,
      expiresAt: qqMessageFactConsumableCap(store.db, scope, event.eventKey, fact.expiresAt, now),
    },
  ];
  // 正文只经自己的 qq_observation 来源可读（独立帽）；正文行不在时不产出该 ref。
  const body = bodyRow(store.orm, event.eventKey, now);
  if (body) {
    sources.push({
      kind: "qq_observation",
      id: event.eventKey,
      revision: bodyRevision(body.body),
      expiresAt: body.expiresAt,
    });
  }
  // 完整度（spec §4.5：只有 full 可信为完整）。legacy 单昵称行是 legacy_partial；
  // 正文缺失（删除/到期）而快照存过 text → unavailable：正文未知，但身份/关系这些
  // 被核验过的快照事实仍有效（不能借当前名或永久身份复活原文）；快照旧 text 与真实
  // 正文对不上（正文被改写、parts 无法忠实重建原顺序）→ 同样 fail closed unavailable，
  // 旧正文只经 qq_observation 来源可读，不从 parts 副本供旧文。media-only（无正文行
  // 且快照零 text）是真完整，不因缺 body 行降级。
  const completeness =
    fact.nameState === "legacy"
      ? ("legacy_partial" as const)
      : consistency !== null
        ? ("unavailable" as const)
        : ("full" as const);
  return {
    state:
      completeness === "full"
        ? "available"
        : completeness === "unavailable"
          ? "revoked"
          : "legacy_unknown",
    fact: {
      id: event.eventKey,
      platformMessageId: event.messageId,
      seq: seqRow.seq,
      occurredAtSeconds: event.occurredAtSeconds,
      speaker: identityOf(
        fact,
        event.speakerId,
        event.speakerKind,
        currentNameOf(store, scope, event.speakerId, now),
      ),
      parts,
      mentions: collectMentions(parts),
      replyTo: fact.replyToMessageId ? { platformMessageId: fact.replyToMessageId } : null,
      sources,
      completeness,
    },
  };
}

function projectOne(
  store: EvidenceStore,
  scope: QqConversationScope,
  platformMessageId: string,
  now: string,
): QqMessageFact | null {
  return projectOneState(store, scope, platformMessageId, now).fact;
}

/**
 * Project one platform message's facts for the caller's scope (locked interface).
 *
 * The scope check (conversation + binding epoch + authority + account/kind/peer/Agent +
 * bindingId) runs first and in full: a caller from another conversation, a stale binding
 * epoch, a revoked authority or a sibling group receives `null` and learns nothing — not
 * even that the message exists elsewhere. The permanent event identity authorises nothing
 * by itself: the expiring fact snapshot and the expiring body are checked independently.
 */
export function loadQqMessageFact(
  store: EvidenceStore,
  scope: QqConversationScope,
  platformMessageId: string,
  now: string = nowIso(),
): QqMessageFact | null {
  if (!evidenceScopeExists(store.db, botScope(scope))) return null;
  return projectOne(store, scope, platformMessageId, now);
}

/**
 * The controlled state read for reply targets (locked interface; T04/T05 state fidelity,
 * spec §4.3). Same full scope gate as `loadQqMessageFact` — a caller from another
 * conversation, a stale binding epoch, a revoked authority or a sibling group receives
 * `missing` and learns nothing, not even that the message exists elsewhere. Inside the
 * caller's own scope the unreadable states are expressed separately: `expired` (snapshot
 * window passed; no body, identity or current-name is loaded), `revoked` (body deleted,
 * expired or drifted; no snapshot text), `legacy_unknown` (legacy single-name relation
 * gap) — each with `fact: null`, so an expired fact can never be registered as a general
 * material or SourceRef. Only `available` carries the fact, with currently readable
 * sources. No new source kind, table or enum: the states are the reply target's own
 * tagged result, consumed by `expandQqReplies` through the host-injected `loadState`.
 */
export function loadQqMessageFactState(
  store: EvidenceStore,
  scope: QqConversationScope,
  platformMessageId: string,
  now: string = nowIso(),
): QqReplyTargetState {
  if (!evidenceScopeExists(store.db, botScope(scope))) return { state: "missing", fact: null };
  const read = projectOneState(store, scope, platformMessageId, now);
  // 只有 available 携带事实：过期/撤权/legacy 的快照不进本接口——过期事实不能当
  // 一般资料或 SourceRef 注册（§4.3/§12），正文与身份随状态一起不可达。
  return read.state === "available" ? read : { state: read.state, fact: null };
}

/**
 * Project facts for the given internal event keys (locked interface). Every key is
 * re-scoped; keys outside the caller's scope are dropped silently (never revealed), and
 * a repeated platform ID is never guessed across authors.
 */
export function projectQqMessageFacts(
  store: EvidenceStore,
  scope: QqConversationScope,
  eventIds: readonly string[],
  now: string = nowIso(),
): QqMessageFact[] {
  if (eventIds.length === 0) return [];
  if (!evidenceScopeExists(store.db, botScope(scope))) return [];
  const facts: QqMessageFact[] = [];
  for (const eventKey of eventIds) {
    const event = eventById(store.orm, scope, eventKey);
    if (!event) continue;
    const fact = projectOne(store, scope, event.messageId, now);
    if (fact && fact.id === eventKey) facts.push(fact);
  }
  return facts;
}

/** 点名对象（§4.1 第 2 项）来自片段里的 at 段；片段没有身份细节，identity 留 null。 */
export function collectMentions(
  parts: QqMessagePart[],
): Array<{ qq: string | "all"; identity: QqIdentity | null }> {
  return parts
    .filter((p): p is Extract<QqMessagePart, { kind: "mention" }> => p.kind === "mention")
    .map((p) => ({ qq: p.qq, identity: null }));
}
