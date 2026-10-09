import type { Database } from "bun:sqlite";
import type { RunOwner } from "../../shared/contracts/agent-run";
import type { SourceAccess, SourceRef } from "../../shared/contracts/evidence";
import type { ContextPrincipal } from "../agent/context-access";
import { DEFAULT_USER_ID } from "../db/repositories";

export interface QqMemberRosterScope {
  conversationId: string;
  bindingId: string;
  agentId: string;
  accountId: string;
  groupId: string;
  bindingRevision: number;
  bindingAuthorityRevision: number;
  bindingEpoch: number;
}

export function createQqMemberRosterSource(
  scope: QqMemberRosterScope,
  snapshot: { token: string; capturedAt: string; expiresAt: string },
): SourceRef {
  return {
    kind: "qq_member_roster",
    id: JSON.stringify([
      scope.conversationId,
      scope.bindingId,
      scope.agentId,
      scope.accountId,
      scope.groupId,
      snapshot.token,
    ]),
    revision: JSON.stringify([
      scope.bindingRevision,
      scope.bindingAuthorityRevision,
      scope.bindingEpoch,
      snapshot.capturedAt,
    ]),
    expiresAt: snapshot.expiresAt,
  };
}

export function qqMemberRosterSourceAccess(
  db: Database,
  source: SourceRef,
  owner: RunOwner,
  now: string,
  principal: ContextPrincipal = { userId: owner.userId ?? "" },
): SourceAccess | undefined {
  if (source.kind !== "qq_member_roster") return undefined;
  if (
    principal.userId !== DEFAULT_USER_ID ||
    owner.userId !== principal.userId ||
    (owner.kind !== "conversation" && owner.kind !== "qq_binding") ||
    !owner.agentId
  )
    return "revoked";
  let id: unknown;
  let revision: unknown;
  let expiry: number;
  try {
    id = JSON.parse(source.id);
    revision = JSON.parse(source.revision);
    expiry = source.expiresAt === undefined ? Number.NaN : Date.parse(source.expiresAt);
  } catch {
    return "revoked";
  }
  if (
    !Array.isArray(id) ||
    id.length !== 6 ||
    id.some((part) => typeof part !== "string" || part.length === 0) ||
    !Array.isArray(revision) ||
    revision.length !== 4 ||
    !revision.slice(0, 3).every((part) => Number.isSafeInteger(part) && part >= 0) ||
    typeof revision[3] !== "string" ||
    Number.isNaN(Date.parse(revision[3] as string)) ||
    !Number.isFinite(expiry)
  )
    return "revoked";
  const [conversationId, bindingId, agentId, accountId, groupId] = (id as string[]).slice(0, 5);
  if (
    owner.id !== (owner.kind === "conversation" ? conversationId : bindingId) ||
    owner.agentId !== agentId
  )
    return "revoked";
  const row = db
    .query(`SELECT c.source_id,c.binding_epoch,c.agent_id,c.channel,b.account_id,b.conversation_kind,b.peer_id,b.revision,b.authority_revision,b.agent_id AS binding_agent
    FROM conversations c JOIN qq_bindings b ON b.id=c.source_id
    WHERE c.id=? AND c.closed_at IS NULL`)
    .get(conversationId) as {
    source_id: string;
    binding_epoch: number;
    agent_id: string;
    channel: string;
    account_id: string;
    conversation_kind: string;
    peer_id: string;
    revision: number;
    authority_revision: number;
    binding_agent: string;
  } | null;
  if (
    !row ||
    row.channel !== "onebot11" ||
    row.source_id !== bindingId ||
    row.agent_id !== agentId ||
    row.binding_agent !== agentId ||
    row.account_id !== accountId ||
    row.conversation_kind !== "group" ||
    row.peer_id !== groupId ||
    row.binding_epoch !== revision[2] ||
    row.revision !== revision[0] ||
    row.authority_revision !== revision[1]
  )
    return "revoked";
  if (expiry <= Date.parse(now)) return "expired";
  return "available";
}

export function qqExecutionModuleSourceAccess(
  source: SourceRef,
  owner: RunOwner,
  currentRevision: string,
  enabled: boolean,
): SourceAccess | undefined {
  if (source.kind !== "execution_module") return undefined;
  if (
    source.id !== "qqMembers" ||
    (owner.kind !== "conversation" && owner.kind !== "qq_binding") ||
    owner.userId !== DEFAULT_USER_ID ||
    !owner.agentId
  )
    return "revoked";
  return enabled && source.revision === currentRevision ? "available" : "revoked";
}
