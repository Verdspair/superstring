import type { Database } from "bun:sqlite";
import type { RunOwner } from "../../shared/contracts/agent-run";
import type { SourceRef } from "../../shared/contracts/evidence";
import type { QqConversationScope, QqMessagePart } from "../../shared/contracts/qq-message";
import type { ContextPrincipal } from "../agent/context-access";
import { bodyRevision } from "../db/conversation-event-repository";
import type { QqMessageFactRow } from "../db/qq-message-repository";
import { DEFAULT_USER_ID } from "../db/repositories";
import { evidenceScopeExists } from "../modules/conversation-evidence";
import { inTimeline } from "../modules/conversation-evidence-store";
import { ownerScope } from "./qq-media-sources";
import { isObservationExpired } from "./qq-retention";

type SourceAccess = "available" | "expired" | "revoked";

export interface QqMessageFactVisibleState {
  fact: QqMessageFactRow;
  visibleParts: QqMessagePart[];
  bodyRevisionValue: string | null;
  textConsistency: string | null;
}

export function qqMessageFactSourceRevision(
  scope: QqConversationScope,
  fact: QqMessageFactRow,
  visibleParts: readonly QqMessagePart[],
  bodyRevisionValue: string | null,
): string {
  return bodyRevision(
    JSON.stringify([
      scope.conversationId,
      scope.accountId,
      scope.conversationKind,
      scope.peerId,
      scope.agentId,
      scope.bindingId,
      scope.bindingEpoch,
      scope.authorityRevision,
      fact.revision,
      fact.groupCard,
      fact.groupCardSource,
      fact.personalNickname,
      fact.personalNicknameSource,
      fact.legacyDisplayName,
      fact.nameState,
      visibleParts,
      fact.replyToMessageId,
      fact.expiresAt,
      bodyRevisionValue,
    ]),
  );
}

function factRow(
  db: Database,
  scope: QqConversationScope,
  eventKey: string,
): { fact: QqMessageFactRow; body: string | null; bodyExpiresAt: string | null } | null {
  const row = db
    .query(
      `SELECT f.event_key AS eventKey,f.group_card AS groupCard,f.group_card_source AS groupCardSource,
      f.personal_nickname AS personalNickname,f.personal_nickname_source AS personalNicknameSource,
      f.legacy_display_name AS legacyDisplayName,f.name_state AS nameState,f.parts AS parts,
      f.reply_to_message_id AS replyToMessageId,f.revision AS revision,f.expires_at AS expiresAt,
      f.recorded_at AS recordedAt,
      t.body AS body,t.expires_at AS bodyExpiresAt
      FROM qq_message_facts f JOIN qq_events e ON e.event_key=f.event_key
      LEFT JOIN qq_observation_text t ON t.event_key=f.event_key
      WHERE f.event_key=? AND e.account_id=? AND e.conversation_kind=? AND e.peer_id=? AND e.agent_id=?`,
    )
    .get(eventKey, scope.accountId, scope.conversationKind, scope.peerId, scope.agentId) as
    | (QqMessageFactRow & { body: string | null; bodyExpiresAt: string | null })
    | null;
  if (!row) return null;
  const { body, bodyExpiresAt, ...fact } = row;
  return { fact, body, bodyExpiresAt };
}

// 正文副本不能复活已失效来源。
function readableBody(
  row: { body: string | null; bodyExpiresAt: string | null },
  now: string,
): { body: string; expiresAt: string } | null {
  if (row.body === null || row.bodyExpiresAt === null) return null;
  if (isObservationExpired(row.bodyExpiresAt, now)) return null;
  return { body: row.body, expiresAt: row.bodyExpiresAt };
}

function textConsistencyOf(
  stored: readonly QqMessagePart[],
  body: { body: string } | null,
): string | null {
  const storedText = stored.flatMap((p) => (p.kind === "text" ? [p.text] : [])).join("");
  if (body === null) return storedText === "" ? null : "text-expired";
  return [...storedText].join("") === [...body.body].join("") ? null : "text-mismatch";
}

export function visibleFactState(
  db: Database,
  scope: QqConversationScope,
  eventKey: string,
  now: string,
): QqMessageFactVisibleState | null {
  const row = factRow(db, scope, eventKey);
  if (!row) return null;
  const body = readableBody(row, now);
  const stored = JSON.parse(row.fact.parts) as QqMessagePart[];
  const textConsistency = textConsistencyOf(stored, body);
  const visibleParts = (
    textConsistency === null
      ? stored
      : stored.map((part) =>
          part.kind === "text" ? ({ kind: "unavailable", type: textConsistency } as const) : part,
        )
  ) as QqMessagePart[];
  return {
    fact: row.fact,
    visibleParts,
    bodyRevisionValue: body ? bodyRevision(body.body) : null,
    textConsistency,
  };
}

export function qqMessageFactSourceAccess(
  db: Database,
  source: SourceRef,
  owner: RunOwner,
  principal: ContextPrincipal,
  now: string,
): SourceAccess | undefined {
  if (source.kind !== "qq_message_fact") return undefined;
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
  const row = factRow(db, scope, source.id);
  if (!row) return "revoked";
  if (!inTimeline(db, { channel: "onebot11", ...scope }, "qq_event", source.id)) return "revoked";
  // fact 快照自己的窗口：过期 → expired（对已授权 owner 可区分，不猜）。
  if (isObservationExpired(row.fact.expiresAt, now)) return "expired";
  if (source.expiresAt !== undefined && Date.parse(source.expiresAt) <= Date.parse(now))
    return "expired";
  const state = visibleFactState(db, scope, source.id, now);
  if (!state) return "revoked";
  return qqMessageFactSourceRevision(
    scope,
    state.fact,
    state.visibleParts,
    state.bodyRevisionValue,
  ) === source.revision
    ? "available"
    : "revoked";
}

// 期限帽保留原字符串精度。
export function qqMessageFactConsumableCap(
  db: Database,
  scope: QqConversationScope,
  eventKey: string,
  factExpiresAt: string,
  now: string,
): string {
  const row = factRow(db, scope, eventKey);
  const caps = [factExpiresAt];
  if (row) {
    const body = readableBody(row, now);
    if (body) caps.push(body.expiresAt);
  }
  return caps.reduce((min, value) => (Date.parse(value) < Date.parse(min) ? value : min));
}
