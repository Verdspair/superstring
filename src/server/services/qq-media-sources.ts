// T08 来源子单元 a2（R18 裁决）：`qq_media_source` 的 mint 与复验。
//
// 语义锁定（execution-handoff R18 / progress R18）：
//   * `id` = 精确媒体行 id（绝不把 scope 塞进 id）；
//   * `revision` = 完整 scope（含 conversationId）+ 实际 media/asset/link 现值的
//     规范 JSON 数组哈希——旧 ref 在关会话/换绑/epoch/authority 变化后复算不等而失效，
//     不能借另一条 live link 复活；描述尝试计数（attempts）属 read_task/note 自己的
//     来源，不冻结进本 hash——纯描述认领不撤销未改原图的 ref（R21）。
//   * `expiresAt` = 实际消费帽（media/link/asset 三到期最早值）；
//   * access 复用统一证据模块的 `evidenceScopeExists`/`inTimeline`，不复制权限 SQL；
//   * owner 授权先行：从 owner 精准定位唯一活 conversation/binding 重建当前 scope，
//     多活 fail closed，不 LIMIT 1 猜；
//   * 来源 ref 不是授权：群/global media 能力纪元仍由既有 `qq_group_capability`
//     guard refs（T11）组合证明，本 kind 不独自证明 off/on。
//   * sha/bytes/签名 URL 不进外显字段：模型可见的只有 kind/id/revision/expiresAt。

import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { RunOwner } from "../../shared/contracts/agent-run";
import type { SourceAccess, SourceRef } from "../../shared/contracts/evidence";
import type { QqConversationScope } from "../../shared/contracts/qq-message";
import type { ContextPrincipal } from "../agent/context-access";
import { DEFAULT_USER_ID } from "../db/repositories";
import { evidenceScopeExists } from "../modules/conversation-evidence";
import type { EvidenceStore } from "../modules/conversation-evidence-store";
import { inTimeline } from "../modules/conversation-evidence-store";

/** The actual media/asset/link values the revision hash freezes. The projection is an
 * INNER JOIN against the real DDL (0052: link/asset expires_at NOT NULL, one live link
 * per media row, asset always present), so link/asset fields are non-null by construction. */
interface MediaProjection {
  eventKey: string;
  segmentIndex: number;
  sourceRef: string;
  mediaExpiresAt: string;
  linkId: string;
  linkExpiresAt: string;
  assetId: string;
  assetSha256: string;
  assetRevision: number;
  assetExpiresAt: string;
}

/** The earliest of the three windows actually consumed: media / link / asset — all NOT
 * NULL in the DDL and frozen in the revision hash, a minted ref can never outlive a
 * window the hash did not see. */
function consumptionCap(row: MediaProjection): string {
  return [row.mediaExpiresAt, row.linkExpiresAt, row.assetExpiresAt].reduce((min, value) =>
    Date.parse(value) < Date.parse(min) ? value : min,
  );
}

/** The exact media row joined to its carrying event and its live source link, scoped in SQL. */
function mediaProjection(
  db: Database,
  scope: QqConversationScope,
  mediaNoteId: string,
  now: string | null,
): MediaProjection | null {
  const row = db
    .query(`SELECT n.event_key AS eventKey,n.segment_index AS segmentIndex,n.source_ref AS sourceRef,
    n.expires_at AS mediaExpiresAt,
    s.id AS linkId,s.expires_at AS linkExpiresAt,
    a.id AS assetId,a.content_sha256 AS assetSha256,a.revision AS assetRevision,a.expires_at AS assetExpiresAt
    FROM qq_media_notes n JOIN qq_events e ON e.event_key=n.event_key
    JOIN qq_media_asset_sources s ON s.media_note_id=n.id
    JOIN qq_media_assets a ON a.id=s.asset_id
      AND a.account_id=? AND a.conversation_kind=? AND a.peer_id=? AND a.agent_id=?
    WHERE n.id=? AND e.account_id=? AND e.conversation_kind=? AND e.peer_id=? AND e.agent_id=?`)
    .get(
      scope.accountId,
      scope.conversationKind,
      scope.peerId,
      scope.agentId,
      mediaNoteId,
      scope.accountId,
      scope.conversationKind,
      scope.peerId,
      scope.agentId,
    ) as MediaProjection | null;
  if (!row) return null;
  if (now !== null) {
    if (
      ![row.mediaExpiresAt, row.linkExpiresAt, row.assetExpiresAt].every(
        (value) => Date.parse(value) > Date.parse(now),
      )
    )
      return null;
  }
  return row;
}

/** The revision hash: full scope (incl. conversationId) + real media/link/asset identity.
 * Description-attempt counts are NOT frozen here — attempts belong to the read task /
 * note's own source, and a pure describe-claim never revokes an unminted-image ref. */
function sourceRevision(scope: QqConversationScope, row: MediaProjection): string {
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
        row.eventKey,
        row.segmentIndex,
        row.sourceRef,
        row.linkId,
        row.assetId,
        row.assetSha256,
        row.assetRevision,
        row.linkExpiresAt,
        row.mediaExpiresAt,
        row.assetExpiresAt,
      ]),
    )
    .digest("hex");
}

/**
 * Mint the source ref for one media row the caller's scope can see. Every window the
 * consumption depends on (media row, source link, asset) must be live at the caller's
 * real `now` — an expired row, a dead link or a dead asset never mints. The media row's
 * carrying event must live in the caller's (account, kind, peer, agent) scope, the
 * asset must live in the same scope, and the row must sit in the conversation's journal
 * timeline. Returns `null` — never a guess — on any of these failures.
 */
export function createQqMediaSourceRef(
  store: EvidenceStore,
  scope: QqConversationScope,
  mediaNoteId: string,
  now: string,
): SourceRef | null {
  const botScope = { channel: "onebot11" as const, ...scope };
  if (!evidenceScopeExists(store.db, botScope)) return null;
  const row = mediaProjection(store.db, scope, mediaNoteId, now);
  if (!row) return null;
  if (!inTimeline(store.db, botScope, "qq_media", mediaNoteId)) return null;
  return {
    kind: "qq_media_source",
    id: mediaNoteId,
    revision: sourceRevision(scope, row),
    expiresAt: consumptionCap(row),
  };
}

/**
 * The single live (binding, conversation) pair for the owner, located precisely:
 * `qq_binding` owners name the binding row; `conversation` owners name the conversation.
 * Two open conversations for one binding cannot happen (uq_conversations_current_source),
 * and a binding row is unique — anything else fails closed instead of LIMIT 1 guessing.
 */
export function ownerScope(
  db: Database,
  owner: RunOwner,
): { scope: QqConversationScope } | null | "ambiguous" {
  if (owner.kind === "conversation") {
    const row = db
      .query(`SELECT c.id AS conversationId,c.binding_epoch AS bindingEpoch,
      c.agent_id AS agentId,c.source_id AS bindingId,b.account_id AS accountId,
      b.authority_revision AS authorityRevision,b.conversation_kind AS conversationKind,
      b.peer_id AS peerId,b.agent_id AS bindingAgentId
      FROM conversations c JOIN qq_bindings b ON b.id=c.source_id
      WHERE c.id=? AND c.channel='onebot11' AND c.closed_at IS NULL`)
      .get(owner.id) as {
      conversationId: string;
      accountId: string;
      bindingEpoch: number;
      agentId: string;
      bindingId: string;
      authorityRevision: number;
      conversationKind: string;
      peerId: string;
      bindingAgentId: string;
    } | null;
    if (!row) return null;
    // Owner identity is four-dimensional: kind/id/userId/agentId — an owner without an
    // explicit agentId does not pass (dispatch ruling, not the optional RunOwner field).
    if (!owner.agentId || owner.agentId !== row.agentId || owner.agentId !== row.bindingAgentId)
      return null;
    return {
      scope: {
        conversationId: row.conversationId,
        accountId: row.accountId,
        conversationKind: row.conversationKind === "private" ? "private" : "group",
        peerId: row.peerId,
        agentId: row.agentId,
        bindingId: row.bindingId,
        bindingEpoch: row.bindingEpoch,
        authorityRevision: row.authorityRevision,
      },
    };
  }
  if (owner.kind === "qq_binding") {
    const row = db
      .query(`SELECT b.id AS bindingId,b.account_id AS accountId,b.authority_revision AS authorityRevision,
      b.conversation_kind AS conversationKind,b.peer_id AS peerId,b.agent_id AS agentId
      FROM qq_bindings b WHERE b.id=?`)
      .get(owner.id) as {
      bindingId: string;
      accountId: string;
      authorityRevision: number;
      conversationKind: string;
      peerId: string;
      agentId: string;
    } | null;
    if (!row) return null;
    if (!owner.agentId || owner.agentId !== row.agentId) return null;
    // The live conversation this binding currently owns; zero (not yet activated) or one
    // is fine, more than one open row cannot be resolved and fails closed.
    const conversations = db
      .query(`SELECT id,binding_epoch FROM conversations
      WHERE channel='onebot11' AND source_id=? AND closed_at IS NULL`)
      .all(owner.id) as { id: string; binding_epoch: number }[];
    if (conversations.length > 1) return "ambiguous";
    const conversation = conversations[0];
    if (!conversation) return null;
    return {
      scope: {
        conversationId: conversation.id,
        accountId: row.accountId,
        conversationKind: row.conversationKind === "private" ? "private" : "group",
        peerId: row.peerId,
        agentId: row.agentId,
        bindingId: row.bindingId,
        bindingEpoch: conversation.binding_epoch,
        authorityRevision: row.authorityRevision,
      },
    };
  }
  return null;
}

/**
 * Re-verify a `qq_media_source` ref: owner authorization first (cross-owner states
 * stay hidden), then the ref's own expiry cap, then the full scope/timeline/link/
 * asset/hash recomputation. `undefined` falls through for other kinds.
 *
 * Owner authorization is four-dimensional (kind/id/userId/agentId): `userId` MUST be
 * present and equal the default user, and an explicit `agentId` is mandatory — absence
 * or a mismatch with the conversation AND binding agent never passes.
 */
export function qqMediaSourceAccess(
  db: Database,
  source: SourceRef,
  owner: RunOwner,
  principal: ContextPrincipal,
  now: string,
): SourceAccess | undefined {
  if (source.kind !== "qq_media_source") return undefined;
  // Owner authorization first: another owner never learns even the state of this ref.
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
  // The ref's own cap and the row's real state, both only for the ref's exact id.
  const row = mediaProjection(db, scope, source.id, null);
  if (!row) return "revoked";
  if (!inTimeline(db, { channel: "onebot11", ...scope }, "qq_media", source.id)) return "revoked";
  const caps = [row.mediaExpiresAt, row.linkExpiresAt, row.assetExpiresAt, source.expiresAt]
    .filter((value): value is string => value !== undefined && value !== null)
    .map((value) => Date.parse(value));
  if (caps.some((value) => value <= Date.parse(now))) return "expired";
  return sourceRevision(scope, row) === source.revision ? "available" : "revoked";
}
