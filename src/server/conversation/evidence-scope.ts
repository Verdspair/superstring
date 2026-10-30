import type { Database } from "bun:sqlite";
import type { RunOwner } from "../../shared/contracts/agent-run";
import type { QqConversationScope } from "../../shared/contracts/qq-message";
import { DEFAULT_USER_ID } from "../db/repositories";

export interface WebEvidenceScope {
  channel: "web";
  agentId: string;
  sessionId: string;
  currentTurnId: string;
  /** Minted by the factory and serialized into refs: durable re-checks follow the mint, not a live setting. */
  retrievalEnabled: boolean;
}
export interface BotEvidenceScope {
  channel: "onebot11";
  agentId: string;
  conversationId: string;
  bindingId: string;
  bindingEpoch: number;
  authorityRevision: number;
  accountId: string;
  conversationKind: "group" | "private";
  peerId: string;
}
export type ConversationEvidenceScope = WebEvidenceScope | BotEvidenceScope;
/**
 * Scope existence check shared with the QQ message fact projection (T03a): the full
 * conversation/binding/authority/agent/account identity, re-validated per read.
 * Exported for reuse — projection must not copy this authorisation query.
 */
export function evidenceScopeExists(db: Database, scope: ConversationEvidenceScope): boolean {
  if (scope.channel === "web")
    return !!db
      .query(`SELECT 1 FROM sessions s JOIN turns t ON t.session_id=s.id
    WHERE s.id=? AND s.user_id=? AND s.agent_id=? AND t.id=?
      AND t.cancel_requested=0 AND t.invalidated_at IS NULL AND t.generation_status IN ('active','completed')`)
      .get(scope.sessionId, DEFAULT_USER_ID, scope.agentId, scope.currentTurnId);
  return !!db
    .query(`SELECT 1 FROM conversations c JOIN qq_bindings b ON b.id=c.source_id
    WHERE c.id=? AND c.channel='onebot11' AND c.closed_at IS NULL AND c.binding_epoch=?
    AND c.user_id=? AND c.agent_id=? AND b.id=? AND b.agent_id=? AND b.authority_revision=?
    AND b.account_id=? AND b.conversation_kind=? AND b.peer_id=?`)
    .get(
      scope.conversationId,
      scope.bindingEpoch,
      DEFAULT_USER_ID,
      scope.agentId,
      scope.bindingId,
      scope.agentId,
      scope.authorityRevision,
      scope.accountId,
      scope.conversationKind,
      scope.peerId,
    );
}
const BYTES = 262144,
  LINKS = 100;
const bounded = (column: string, bytes = BYTES) =>
  `CASE WHEN length(CAST(${column} AS BLOB))<=${bytes} THEN ${column} END`;
const parse = (value: string | null): unknown => {
  try {
    return value === null ? null : JSON.parse(value);
  } catch {
    return null;
  }
};
function expiry(now: string, values: (string | undefined | null)[]): string | null {
  const dates = values.map((value) => (value ? Date.parse(value) : NaN));
  return dates.length && dates.every((value) => Number.isFinite(value) && value > Date.parse(now))
    ? new Date(Math.min(...dates)).toISOString()
    : null;
}

export function inTimeline(
  db: Database,
  scope: BotEvidenceScope,
  kind: string,
  id: string,
  now?: string,
): boolean {
  const direct = db.query(`SELECT 1 FROM conversation_events e
    WHERE e.conversation_id=? AND e.source_kind=? AND e.source_id=?
      AND e.kind IN ('inbound','outbound') AND (e.source_kind<>'qq_send' OR EXISTS(
        SELECT 1 FROM qq_send_log l WHERE l.id=e.source_id AND l.outcome='sent')) LIMIT 1`);
  if (direct.get(scope.conversationId, kind, id)) return true;
  if (kind === "qq_observation" && direct.get(scope.conversationId, "qq_event", id)) return true;
  const secondary = db
    .query(`SELECT 1 FROM conversation_events e WHERE e.conversation_id=? AND
    e.kind IN ('inbound','outbound') AND (e.source_kind<>'qq_send' OR EXISTS(
      SELECT 1 FROM qq_send_log l WHERE l.id=e.source_id AND l.outcome='sent')) AND
    ((e.source_id=? AND (e.source_kind=? OR (?='qq_observation' AND e.source_kind='qq_event'))) OR
    EXISTS(SELECT 1 FROM json_each(CASE WHEN length(e.sources)<=65536 AND json_valid(e.sources)
      THEN e.sources ELSE '[]' END) s WHERE s.type='object'
      AND json_extract(s.value,'$.kind')=? AND json_extract(s.value,'$.id')=?)) LIMIT 1`)
    .get(scope.conversationId, id, kind, kind, kind, id);
  if (secondary) return true;
  if (kind !== "qq_speech" || !evidenceScopeExists(db, scope)) return false;

  // A confirmed send and its legacy speech share one exact identity. This path
  // proves their existing delivery ownership; it does not create journal evidence.
  const links = db
    .query(`SELECT i.id AS intentId,i.conversation_id AS conversationId,
    ${bounded("i.target")} AS target,i.status AS intentStatus,i.expires_at AS intentExpiry,
    l.outcome,l.account_id AS sendAccount,l.conversation_kind AS sendKind,
    l.peer_id AS sendPeer,l.agent_id AS sendAgent,l.kind AS sendSpeechKind,l.expires_at AS sendExpiry,
    s.account_id AS speechAccount,s.conversation_kind AS speechKind,
    s.peer_id AS speechPeer,s.agent_id AS speechAgent,s.kind AS speechPath,s.expires_at AS speechExpiry,
    ${bounded("t.body")} AS body,t.expires_at AS bodyExpiry,i.speech_kind AS intentPath
    FROM outbound_intents i JOIN qq_send_log l ON l.id=i.legacy_send_id
    JOIN qq_speech_log s ON s.id=l.id JOIN qq_speech_text t ON t.speech_id=s.id
    WHERE i.legacy_send_id=? LIMIT 2`)
    .all(id) as {
    intentId: string;
    conversationId: string;
    target: string | null;
    intentStatus: string;
    intentExpiry: string;
    outcome: string;
    sendAccount: string;
    sendKind: string;
    sendPeer: string;
    sendAgent: string;
    sendSpeechKind: string;
    sendExpiry: string;
    speechAccount: string;
    speechKind: string;
    speechPeer: string;
    speechAgent: string;
    speechPath: string;
    speechExpiry: string;
    body: string | null;
    bodyExpiry: string;
    intentPath: string;
  }[];
  if (links.length !== 1) return false;
  const link = links[0];
  if (
    !link ||
    link.conversationId !== scope.conversationId ||
    link.intentStatus !== "confirmed" ||
    link.outcome !== "sent" ||
    !link.body ||
    link.sendAccount !== scope.accountId ||
    link.sendKind !== scope.conversationKind ||
    link.sendPeer !== scope.peerId ||
    link.sendAgent !== scope.agentId ||
    link.speechAccount !== scope.accountId ||
    link.speechKind !== scope.conversationKind ||
    link.speechPeer !== scope.peerId ||
    link.speechAgent !== scope.agentId ||
    link.intentPath !== link.sendSpeechKind ||
    link.intentPath !== link.speechPath ||
    !expiry(now ?? new Date().toISOString(), [
      link.intentExpiry,
      link.sendExpiry,
      link.speechExpiry,
      link.bodyExpiry,
    ])
  )
    return false;
  const target = parse(link.target) as Record<string, unknown> | null;
  if (
    !target ||
    typeof target !== "object" ||
    Array.isArray(target) ||
    [
      "accountId",
      "conversationKind",
      "peerId",
      "agentId",
      "bindingId",
      "bindingEpoch",
      "authorityRevision",
    ].some((key) => target[key] !== scope[key as keyof BotEvidenceScope])
  )
    return false;
  const journal = db
    .query(`SELECT 1 FROM conversation_events
    WHERE conversation_id=? AND kind='delivery' AND source_kind='outbound_intent' AND source_id=? LIMIT 1`)
    .get(scope.conversationId, link.intentId);
  if (!journal) return false;
  const parts = db
    .query(`SELECT ordinal,kind,status,platform_message_id AS platformId,
    attempted_at AS attemptedAt,finished_at AS finishedAt,${bounded("payload")} AS payload
    FROM outbound_parts WHERE intent_id=? ORDER BY ordinal LIMIT ?`)
    .all(link.intentId, LINKS + 1) as {
    ordinal: number;
    kind: string;
    status: string;
    platformId: string | null;
    attemptedAt: string | null;
    finishedAt: string | null;
    payload: string | null;
  }[];
  const receipts = db
    .query(`SELECT part_index AS ordinal,part_kind AS kind,result,
    platform_message_id AS platformId,sticker_id AS stickerId
    FROM qq_send_part WHERE send_id=? ORDER BY part_index LIMIT ?`)
    .all(id, LINKS + 1) as {
    ordinal: number;
    kind: string;
    result: string;
    platformId: string | null;
    stickerId: string | null;
  }[];
  if (!parts.length || parts.length > LINKS || receipts.length !== parts.length) return false;
  const texts: string[] = [];
  const platformIds = new Set<string>();
  for (const [index, part] of parts.entries()) {
    const receipt = receipts[index];
    if (
      !receipt ||
      part.ordinal !== index ||
      receipt.ordinal !== part.ordinal ||
      receipt.kind !== part.kind ||
      receipt.result !== "confirmed" ||
      part.status !== "confirmed" ||
      !part.platformId ||
      receipt.platformId !== part.platformId ||
      platformIds.has(part.platformId) ||
      part.attemptedAt === null ||
      part.finishedAt === null ||
      !Number.isFinite(Date.parse(part.attemptedAt)) ||
      !Number.isFinite(Date.parse(part.finishedAt))
    )
      return false;
    platformIds.add(part.platformId);
    const payload = parse(part.payload) as Record<string, unknown> | null;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
    if (part.kind === "text") {
      if (typeof payload.text !== "string" || receipt.stickerId !== null) return false;
      texts.push(payload.text);
    } else if (part.kind === "sticker") {
      if (typeof payload.stickerId !== "string" || payload.stickerId !== receipt.stickerId)
        return false;
    } else return false;
  }
  return texts.length > 0 && texts.join("\n") === link.body;
}
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
