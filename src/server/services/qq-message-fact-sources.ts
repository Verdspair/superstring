import type { Database } from "bun:sqlite";
import type { RunOwner } from "../../shared/contracts/agent-run";
import type { SourceAccess, SourceRef } from "../../shared/contracts/evidence";
import type { QqConversationScope, QqMessagePart } from "../../shared/contracts/qq-message";
import type { ContextPrincipal } from "../agent/context-access";
import { bodyRevision } from "../db/conversation-event-repository";
import type { QqMessageFactRow } from "../db/qq-message-repository";
import { DEFAULT_USER_ID } from "../db/repositories";
import { evidenceScopeExists } from "../modules/conversation-evidence";
import { inTimeline } from "../modules/conversation-evidence-store";
import { ownerScope } from "./qq-media-sources";
import { isObservationExpired } from "./qq-retention";

export interface QqMessageFactVisibleState {
  fact: QqMessageFactRow;
  visibleParts: QqMessagePart[];
  bodyRevisionValue: string | null;
  textConsistency: string | null;
  body: { body: string; expiresAt: string } | null;
  consumableCap: string;
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

type FactBodyRow = {
  fact: QqMessageFactRow;
  body: string | null;
  bodyExpiresAt: string | null;
};

function factRows(
  db: Database,
  scope: QqConversationScope,
  eventKeys: readonly string[],
): Map<string, FactBodyRow> {
  if (eventKeys.length === 0) return new Map();
  const rows = db
    .query(
      `SELECT f.event_key AS eventKey,f.group_card AS groupCard,f.group_card_source AS groupCardSource,
      f.personal_nickname AS personalNickname,f.personal_nickname_source AS personalNicknameSource,
      f.legacy_display_name AS legacyDisplayName,f.name_state AS nameState,f.parts AS parts,
      f.reply_to_message_id AS replyToMessageId,f.revision AS revision,f.expires_at AS expiresAt,
      f.recorded_at AS recordedAt,
      t.body AS body,t.expires_at AS bodyExpiresAt
      FROM qq_message_facts f JOIN qq_events e ON e.event_key=f.event_key
      LEFT JOIN qq_observation_text t ON t.event_key=f.event_key
      WHERE f.event_key IN (SELECT value FROM json_each(?))
        AND e.account_id=? AND e.conversation_kind=? AND e.peer_id=? AND e.agent_id=?`,
    )
    .all(
      JSON.stringify([...new Set(eventKeys)]),
      scope.accountId,
      scope.conversationKind,
      scope.peerId,
      scope.agentId,
    ) as (QqMessageFactRow & { body: string | null; bodyExpiresAt: string | null })[];
  return new Map(
    rows.map(({ body, bodyExpiresAt, ...fact }) => [fact.eventKey, { fact, body, bodyExpiresAt }]),
  );
}

function factRow(db: Database, scope: QqConversationScope, eventKey: string): FactBodyRow | null {
  return factRows(db, scope, [eventKey]).get(eventKey) ?? null;
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
  if (body === null) return storedText.trim() === "" ? null : "text-expired";
  return [...storedText].join("") === [...body.body].join("") ? null : "text-mismatch";
}

// 可见态纯派生：只依赖调用方已加载的行与 now，不再回查。
function visibleFactStateOf(
  row: { fact: QqMessageFactRow; body: string | null; bodyExpiresAt: string | null },
  now: string,
): QqMessageFactVisibleState {
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
    body,
    consumableCap:
      body && Date.parse(body.expiresAt) < Date.parse(row.fact.expiresAt)
        ? body.expiresAt
        : row.fact.expiresAt,
  };
}

export function visibleFactState(
  db: Database,
  scope: QqConversationScope,
  eventKey: string,
  now: string,
): QqMessageFactVisibleState | null {
  const row = factRow(db, scope, eventKey);
  if (!row) return null;
  return visibleFactStateOf(row, now);
}

/** Scoped rows for one synchronous projection; no proof survives the caller's frame. */
export function visibleFactStates(
  db: Database,
  scope: QqConversationScope,
  eventKeys: readonly string[],
  now: string,
): ReadonlyMap<string, QqMessageFactVisibleState> {
  const states = new Map<string, QqMessageFactVisibleState>();
  for (const [id, row] of factRows(db, scope, eventKeys)) {
    if (!isObservationExpired(row.fact.expiresAt, now))
      states.set(id, visibleFactStateOf(row, now));
  }
  return states;
}

function factSourceVerdict(
  row: FactBodyRow | undefined,
  source: SourceRef,
  scope: QqConversationScope,
  now: string,
): SourceAccess {
  if (!row) return "revoked";
  if (isObservationExpired(row.fact.expiresAt, now)) return "expired";
  if (source.expiresAt !== undefined && Date.parse(source.expiresAt) <= Date.parse(now))
    return "expired";
  const state = visibleFactStateOf(row, now);
  return qqMessageFactSourceRevision(
    scope,
    state.fact,
    state.visibleParts,
    state.bodyRevisionValue,
  ) === source.revision
    ? "available"
    : "revoked";
}

export function qqMessageFactSourceAccessMany(
  db: Database,
  sources: readonly SourceRef[],
  owner: RunOwner,
  principal: ContextPrincipal,
  now: string,
): SourceAccess[] {
  if (sources.length === 0) return [];
  const denied = () => sources.map(() => "revoked" as const);
  if (
    owner.userId === undefined ||
    owner.userId !== principal.userId ||
    principal.userId !== DEFAULT_USER_ID
  )
    return denied();
  const located = ownerScope(db, owner);
  if (!located || located === "ambiguous") return denied();
  const scope = located.scope;
  if (!owner.agentId || owner.agentId !== scope.agentId) return denied();
  if (!evidenceScopeExists(db, { channel: "onebot11", ...scope })) return denied();
  const rows = factRows(
    db,
    scope,
    sources.map((source) => source.id),
  );
  const direct = new Set(
    (
      db
        .query(`SELECT source_id AS id FROM conversation_events
    WHERE conversation_id=? AND source_kind='qq_event' AND kind IN ('inbound','outbound')
      AND source_id IN (SELECT value FROM json_each(?))`)
        .all(scope.conversationId, JSON.stringify([...rows.keys()])) as { id: string }[]
    ).map((row) => row.id),
  );
  return sources.map((source) => {
    if (!rows.has(source.id)) return "revoked";
    // Secondary journal links retain the original authoritative fallback.
    if (
      !direct.has(source.id) &&
      !inTimeline(db, { channel: "onebot11", ...scope }, "qq_event", source.id)
    )
      return "revoked";
    return factSourceVerdict(rows.get(source.id), source, scope, now);
  });
}

export function qqMessageFactSourceAccess(
  db: Database,
  source: SourceRef,
  owner: RunOwner,
  principal: ContextPrincipal,
  now: string,
): SourceAccess | undefined {
  if (source.kind !== "qq_message_fact") return undefined;
  return qqMessageFactSourceAccessMany(db, [source], owner, principal, now)[0];
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
