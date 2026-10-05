// 已确认出站部件的事实来源：`qq_outbound_message_fact` 的定位、mint 与复验。
//
// 定位只认两处台账同时一致：`outbound_parts` 的确认部件（status='confirmed'、平台消息
// ID、真实 payload）与 `qq_outbound_message_facts` 的同 ordinal/kind/平台 ID/文本快照；
// 任一侧漂移即不可读。intent 的 target 按调用方当前 scope 的六个维度 + authorityRevision
// 比对——target 缺省 authorityRevision 是 legacy，不能冒充当前权限纪元。delivery 归属只
// 查本会话真实的 `kind='delivery'`/`source_kind='outbound_intent'` 投递行，不放宽通用
// `inTimeline` 的 inbound/outbound 面。授权复用 `ownerScope` + 完整八字段
// `evidenceScopeExists`，不复制权限 SQL；`id` 是精确 `outbound_parts.id`，revision 冻结
// 完整 scope、target、事实修订与身份、实际部件 payload/status/id/finishedAt、两侧期限与
// journal 归属，mint 与 access 复算同一函数。

import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { RunOwner } from "../../shared/contracts/agent-run";
import type { SourceAccess, SourceRef } from "../../shared/contracts/evidence";
import type { QqConversationScope } from "../../shared/contracts/qq-message";
import type { ContextPrincipal } from "../agent/context-access";
import { DEFAULT_USER_ID } from "../db/repositories";
import { evidenceScopeExists } from "../modules/conversation-evidence";
import { ownerScope } from "./qq-media-sources";
import { isObservationExpired } from "./qq-retention";

/** One confirmed outbound part together with every value the revision hash freezes. */
export interface QqOutboundFactPartState {
  intentId: string;
  intentExpiresAt: string;
  targetRaw: string;
  factRevision: number;
  factExpiresAt: string;
  accountId: string;
  groupCard: string | null;
  personalNickname: string | null;
  legacyDisplayName: string | null;
  partId: string;
  partKind: "text" | "sticker";
  partOrdinal: number;
  partStatus: string;
  platformMessageId: string;
  payload: string;
  payloadText: string | null;
  finishedAt: string;
  /** 程序生成的收件人（target.participantId）——只有合法纯数字才算，与发送通路同判。 */
  targetParticipantId: string | null;
  journalSeq: number;
  journalEventKey: string;
}

export type QqOutboundFactPartKey = { partId: string } | { platformMessageId: string };

interface OutboundFactRow {
  intentId: string;
  intentExpiresAt: string;
  targetRaw: string;
  factRevision: number;
  factExpiresAt: string;
  accountId: string;
  groupCard: string | null;
  personalNickname: string | null;
  legacyDisplayName: string | null;
  factParts: string;
  partId: string;
  partKind: string;
  partOrdinal: number;
  partStatus: string;
  platformMessageId: string | null;
  payload: string | null;
  finishedAt: string | null;
}

/** Fixed-width timestamps written by this project parse back correctly; NaN never passes. */
function parseableTime(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

/** The stored outbound fact parts, bounded and shape-checked before use. */
function parseFactParts(raw: string): Array<Record<string, unknown>> | null {
  if (raw.length > 65536) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length > 100) return null;
  if (parsed.some((entry) => typeof entry !== "object" || entry === null || Array.isArray(entry)))
    return null;
  return parsed as Array<Record<string, unknown>>;
}

/**
 * The raw part/intent/fact join, scoped in SQL by conversation + fact account/agent so a
 * cross-scope lookup cannot even read the rows. The platform message ID is a plain string
 * (negative values are legal); a part or intent outside the conversation never appears.
 */
function outboundFactRows(
  db: Database,
  scope: QqConversationScope,
  key: QqOutboundFactPartKey,
): OutboundFactRow[] {
  const byPartId = "partId" in key;
  return db
    .query(`SELECT p.id AS partId,p.intent_id AS intentId,p.ordinal AS partOrdinal,
    p.kind AS partKind,p.payload AS payload,p.status AS partStatus,
    p.platform_message_id AS platformMessageId,p.finished_at AS finishedAt,
    i.target AS targetRaw,i.expires_at AS intentExpiresAt,
    f.account_id AS accountId,f.group_card AS groupCard,f.personal_nickname AS personalNickname,
    f.legacy_display_name AS legacyDisplayName,f.parts AS factParts,
    f.revision AS factRevision,f.expires_at AS factExpiresAt
    FROM outbound_parts p
    JOIN outbound_intents i ON i.id=p.intent_id
    JOIN qq_outbound_message_facts f ON f.intent_id=i.id
    WHERE ${byPartId ? "p.id=?" : "p.platform_message_id=?"} AND i.conversation_id=?
      AND f.account_id=? AND f.agent_id=?`)
    .all(
      byPartId ? key.partId : key.platformMessageId,
      scope.conversationId,
      scope.accountId,
      scope.agentId,
    ) as OutboundFactRow[];
}

/** The single confirmed part that may claim this platform message ID inside the conversation. */
function claimedByExactlyOnePart(
  db: Database,
  scope: QqConversationScope,
  platformMessageId: string,
): boolean {
  const claimed = db
    .query(`SELECT COUNT(*) AS n FROM outbound_parts p
    JOIN outbound_intents i ON i.id=p.intent_id
    WHERE i.conversation_id=? AND p.platform_message_id=? AND p.status='confirmed'`)
    .get(scope.conversationId, platformMessageId) as { n: number };
  return claimed.n === 1;
}

/**
 * Locate one confirmed outbound part inside the caller's scope and verify both ledgers
 * agree. `now=null` skips the expiry verdict so the access path can tell "expired" from
 * "revoked"; a provided `now` refuses the whole read once either window has passed.
 */
export function visibleQqOutboundFactPartState(
  db: Database,
  scope: QqConversationScope,
  key: QqOutboundFactPartKey,
  now: string | null,
): QqOutboundFactPartState | null {
  const rows = outboundFactRows(db, scope, key);
  // Never guess between two authors/parts: the lookup is only valid when it is unique.
  if (rows.length !== 1) return null;
  const [row] = rows;
  if (!row) return null;
  if (row.partStatus !== "confirmed") return null;
  if (row.platformMessageId === null || row.platformMessageId === "") return null;
  if (row.finishedAt === null || !parseableTime(row.finishedAt)) return null;
  if (row.partKind !== "text" && row.partKind !== "sticker") return null;
  if (!claimedByExactlyOnePart(db, scope, row.platformMessageId)) return null;
  const target = parseJsonObject(row.targetRaw);
  if (!target) return null;
  // The intent must belong to the current scope exactly: six target dimensions plus the
  // current authority revision. A legacy target without authorityRevision cannot pose as
  // the current holder.
  if (
    target.accountId !== scope.accountId ||
    target.conversationKind !== scope.conversationKind ||
    target.peerId !== scope.peerId ||
    target.agentId !== scope.agentId ||
    target.bindingId !== scope.bindingId ||
    target.bindingEpoch !== scope.bindingEpoch ||
    target.authorityRevision !== scope.authorityRevision
  )
    return null;
  const factParts = parseFactParts(row.factParts);
  if (!factParts) return null;
  const matching = factParts.filter((entry) => entry.platformMessageId === row.platformMessageId);
  if (matching.length !== 1) return null;
  const [entry] = matching;
  if (!entry) return null;
  if (entry.ordinal !== row.partOrdinal || entry.kind !== row.partKind) return null;
  if (row.payload === null) return null;
  const payload = parseJsonObject(row.payload);
  if (!payload) return null;
  let payloadText: string | null = null;
  if (row.partKind === "text") {
    const text = payload.text;
    if (typeof text !== "string") return null;
    if (entry.text !== text) return null;
    payloadText = text;
  } else {
    // A sticker proves existence only; the image content is never interpreted here.
    if (typeof payload.stickerId !== "string" || payload.stickerId === "") return null;
    if (entry.text !== null) return null;
  }
  // Real delivery journal attribution: the intent's own delivery event in this
  // conversation. The generic timeline face (inbound/outbound) is not widened for this.
  const journal = db
    .query(`SELECT seq,event_key AS eventKey FROM conversation_events
    WHERE conversation_id=? AND kind='delivery' AND source_kind='outbound_intent' AND source_id=?
    ORDER BY seq ASC LIMIT 1`)
    .get(scope.conversationId, row.intentId) as { seq: number; eventKey: string } | null;
  if (!journal) return null;
  if (
    now !== null &&
    (isObservationExpired(row.factExpiresAt, now) || isObservationExpired(row.intentExpiresAt, now))
  )
    return null;
  return {
    intentId: row.intentId,
    intentExpiresAt: row.intentExpiresAt,
    targetRaw: row.targetRaw,
    factRevision: row.factRevision,
    factExpiresAt: row.factExpiresAt,
    accountId: row.accountId,
    groupCard: row.groupCard,
    personalNickname: row.personalNickname,
    legacyDisplayName: row.legacyDisplayName,
    partId: row.partId,
    partKind: row.partKind,
    partOrdinal: row.partOrdinal,
    partStatus: row.partStatus,
    platformMessageId: row.platformMessageId,
    payload: row.payload,
    payloadText,
    finishedAt: row.finishedAt,
    // 与发送通路同一口径：ordinal 0 才带程序收件人，且只认合法纯数字
    // （qqTextSegments 的 mention 形状检查）；sticker 部件按实际线上无 at。
    targetParticipantId:
      row.partOrdinal === 0 &&
      typeof target.participantId === "string" &&
      /^\d+$/.test(target.participantId)
        ? target.participantId
        : null,
    journalSeq: journal.seq,
    journalEventKey: journal.eventKey,
  };
}

/** Display-state derivation from the snapshot columns (no separate state column exists). */
export function qqOutboundFactNameState(
  state: Pick<QqOutboundFactPartState, "groupCard" | "personalNickname" | "legacyDisplayName">,
): "known" | "unknown" | "legacy" {
  if (state.groupCard !== null || state.personalNickname !== null) return "known";
  return state.legacyDisplayName !== null ? "legacy" : "unknown";
}

/** The revision frozen by mint and recomputed by access: scope + target + both ledgers. */
export function qqOutboundFactSourceRevision(
  scope: QqConversationScope,
  state: QqOutboundFactPartState,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        scope.conversationId,
        scope.accountId,
        scope.conversationKind,
        scope.peerId,
        scope.agentId,
        scope.bindingId,
        scope.bindingEpoch,
        scope.authorityRevision,
        state.intentId,
        state.targetRaw,
        state.factRevision,
        state.accountId,
        state.groupCard,
        state.personalNickname,
        state.legacyDisplayName,
        state.partId,
        state.partKind,
        state.partOrdinal,
        state.partStatus,
        state.platformMessageId,
        state.payload,
        state.finishedAt,
        state.intentExpiresAt,
        state.factExpiresAt,
        state.journalSeq,
        state.journalEventKey,
      ]),
    )
    .digest("hex");
}

/** The consumable cap: the earliest of the intent window and the fact window. */
export function qqOutboundFactConsumableCap(state: QqOutboundFactPartState): string {
  return [state.intentExpiresAt, state.factExpiresAt].reduce((min, value) =>
    Date.parse(value) < Date.parse(min) ? value : min,
  );
}

/**
 * Re-verify a `qq_outbound_message_fact` ref: owner authorization first (four-dimensional
 * owner, full eight-field scope), so a cross-owner never learns even the expired state
 * (R21 order). Drift between the ref and the live ledger (payload delete/rewrite,
 * un-confirm, facts id/text change, scope/authority/epoch change, journal loss, revision
 * mismatch) is refused as revoked before any expiry verdict, and a frozen ref cap can
 * only shorten — never extend — the readable window. `undefined` falls through for other
 * kinds.
 */
export function qqOutboundFactSourceAccess(
  db: Database,
  source: SourceRef,
  owner: RunOwner,
  principal: ContextPrincipal,
  now: string,
): SourceAccess | undefined {
  if (source.kind !== "qq_outbound_message_fact") return undefined;
  if (
    owner.userId === undefined ||
    owner.userId !== principal.userId ||
    principal.userId !== DEFAULT_USER_ID
  )
    return "revoked";
  const located = ownerScope(db, owner);
  if (located === "ambiguous") return "revoked";
  if (!located) return "revoked";
  const scope = located.scope;
  if (!owner.agentId || owner.agentId !== scope.agentId) return "revoked";
  if (!evidenceScopeExists(db, { channel: "onebot11", ...scope })) return "revoked";
  const state = visibleQqOutboundFactPartState(db, scope, { partId: source.id }, null);
  if (!state) return "revoked";
  // The row windows and the ref's own frozen cap are authoritative for expiry: an old
  // ref never extends when the underlying window is widened, and a passed cap reads
  // expired before the revision recompute (same order as the accepted inbound kind).
  if (
    isObservationExpired(state.factExpiresAt, now) ||
    isObservationExpired(state.intentExpiresAt, now)
  )
    return "expired";
  if (source.expiresAt !== undefined) {
    if (!parseableTime(source.expiresAt)) return "revoked";
    if (Date.parse(source.expiresAt) <= Date.parse(now)) return "expired";
  }
  if (qqOutboundFactSourceRevision(scope, state) !== source.revision) return "revoked";
  return "available";
}
