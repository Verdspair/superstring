// `qq_member_name` 来源：成员当前双名的 mint 与复验。`id` 只定位 `qq_members` 复合主键，
// 授权由 owner 四维 + 完整 scope 的 revision 复算完成；只供 `known` 行的当前双名
// （legacy/双 null 不供，规格 §13.5）。mint 与 access 复算同一 `sourceRevision`。

import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { RunOwner } from "../../shared/contracts/agent-run";
import type { SourceRef } from "../../shared/contracts/evidence";
import type {
  QqConversationScope,
  QqIdentity,
  QqMessageFact,
} from "../../shared/contracts/qq-message";
import type { ContextPrincipal } from "../agent/context-access";
import { DEFAULT_USER_ID } from "../db/repositories";
import { evidenceScopeExists } from "../modules/conversation-evidence";
import type { EvidenceStore } from "../modules/conversation-evidence-store";
import { inTimeline } from "../modules/conversation-evidence-store";
import { normalizeOneBotAccountId } from "./onebot-protocol";
import { ownerScope } from "./qq-media-sources";
import { isObservationExpired } from "./qq-retention";

type SourceAccess = "available" | "expired" | "revoked";

/** One member's verified current-name value plus the ref that proves it. */
export interface QqMemberNameCandidate {
  readonly value: NonNullable<QqIdentity["currentName"]>;
  readonly source: SourceRef;
}

export interface QqMemberNameSource {
  readonly currentName: { groupCard: string | null; personalNickname: string | null };
  readonly source: SourceRef;
}

interface MemberProjection {
  groupCard: string | null;
  personalNickname: string | null;
  nameState: string;
  lastSeenAtSeconds: number;
  expiresAt: string;
}

const botScope = (scope: QqConversationScope) => ({ channel: "onebot11" as const, ...scope });

/** Wire QQ numbers are whatever the platform's own AccountId normalization accepts. */
function isRealQq(qq: string): boolean {
  return normalizeOneBotAccountId(qq) === qq;
}

// 帽与 now 必须是可解析的时间字符串：不可解析即 fail closed，绝不把 NaN 比较当作跳过。
function parseableTime(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

/** The member row behind the exact composite key, all name fields and its real cap. */
function memberRow(
  db: Database,
  accountId: string,
  conversationKind: string,
  peerId: string,
  userId: string,
): MemberProjection | null {
  return (
    (db
      .query(`SELECT group_card AS groupCard,personal_nickname AS personalNickname,
      name_state AS nameState,last_seen_at_seconds AS lastSeenAtSeconds,expires_at AS expiresAt
      FROM qq_members WHERE account_id=? AND conversation_kind=? AND peer_id=? AND user_id=?`)
      .get(accountId, conversationKind, peerId, userId) as MemberProjection | null) ?? null
  );
}

// 事件候选按 scope SQL 先行粗筛，timeline 归属交回 inTimeline 复核；
// 内页固定 400 条，分页穷尽直到命中——不用授权帽截断证据面。
function candidateEventKeys(db: Database, scope: QqConversationScope, qq: string): string[] {
  const statement = db.query(`SELECT e.event_key AS eventKey FROM qq_events e
      JOIN qq_message_facts f ON f.event_key=e.event_key
      WHERE e.account_id=? AND e.conversation_kind=? AND e.peer_id=? AND e.agent_id=?
        AND (e.speaker_id=? OR EXISTS(SELECT 1 FROM json_each(CASE WHEN length(f.parts)<=65536
          AND json_valid(f.parts) THEN f.parts ELSE '[]' END) p
          WHERE json_extract(p.value,'$.kind')='mention' AND json_extract(p.value,'$.qq')=?))
      ORDER BY e.occurred_at_seconds DESC, e.event_key LIMIT 400 OFFSET ?`);
  for (let offset = 0; ; offset += 400) {
    const rows = statement.all(
      scope.accountId,
      scope.conversationKind,
      scope.peerId,
      scope.agentId,
      qq,
      qq,
      offset,
    ) as { eventKey: string }[];
    if (rows.length === 0) return [];
    const scopeArg = botScope(scope);
    for (const { eventKey } of rows) {
      if (inTimeline(db, scopeArg, "qq_event", eventKey)) return [eventKey];
    }
    if (rows.length < 400) return [];
  }
}

/** The QQ really appeared in this conversation's journal timeline (sender or recorded mention). */
function memberEstablished(db: Database, scope: QqConversationScope, qq: string): boolean {
  return candidateEventKeys(db, scope, qq).length > 0;
}

// revision 覆盖完整 8 字段 scope、ref 自己的复合键（含 userId——同名行哈希不可互换）
// 与该行真实 name 字段/lastSeen/expiry；mint 与 access 复算同一函数。
function sourceRevision(
  scope: QqConversationScope,
  refUserId: string,
  row: MemberProjection,
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
        scope.accountId,
        scope.conversationKind,
        scope.peerId,
        refUserId,
        row.groupCard,
        row.personalNickname,
        row.nameState,
        row.lastSeenAtSeconds,
        row.expiresAt,
      ]),
    )
    .digest("hex");
}

/** Strict id parse: a JSON 4-tuple of non-empty strings with a legal kind (total length bounded). */
function parseMemberId(id: string): {
  accountId: string;
  conversationKind: "group" | "private";
  peerId: string;
  userId: string;
} | null {
  if (id.length > 512) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(id);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 4) return null;
  const [accountId, kind, peerId, userId] = parsed;
  if (
    typeof accountId !== "string" ||
    typeof kind !== "string" ||
    typeof peerId !== "string" ||
    typeof userId !== "string"
  )
    return null;
  if (!accountId || !peerId || !userId) return null;
  if (kind !== "group" && kind !== "private") return null;
  return { accountId, conversationKind: kind, peerId, userId };
}

export function createQqMemberNameSource(
  store: EvidenceStore,
  scope: QqConversationScope,
  qq: string,
  now: string,
): QqMemberNameSource | null {
  if (!evidenceScopeExists(store.db, botScope(scope))) return null;
  if (!isRealQq(qq)) return null;
  if (!memberEstablished(store.db, scope, qq)) return null;
  const row = memberRow(store.db, scope.accountId, scope.conversationKind, scope.peerId, qq);
  if (!row) return null;
  if (isObservationExpired(row.expiresAt, now)) return null;
  if (row.nameState !== "known") return null;
  return {
    currentName: { groupCard: row.groupCard, personalNickname: row.personalNickname },
    source: {
      kind: "qq_member_name",
      id: JSON.stringify([scope.accountId, scope.conversationKind, scope.peerId, qq]),
      revision: sourceRevision(scope, qq, row),
      expiresAt: row.expiresAt,
    },
  };
}

/**
 * Re-verify a `qq_member_name` ref: owner authorization first (R21 — a cross-owner never
 * learns even the expired state), then scope existence, the ref's own timeline establishment
 * and row, and only then expiry and the revision recomputation. `undefined` for other kinds.
 */
export function qqMemberNameSourceAccess(
  db: Database,
  source: SourceRef,
  owner: RunOwner,
  principal: ContextPrincipal,
  now: string,
): SourceAccess | undefined {
  if (source.kind !== "qq_member_name") return undefined;
  if (
    owner.userId === undefined ||
    owner.userId !== principal.userId ||
    principal.userId !== DEFAULT_USER_ID
  )
    return "revoked";
  const parsed = parseMemberId(source.id);
  if (!parsed) return "revoked";
  // ownerScope 的 owner 定位先于 id 与 scope 的比对；ref 的行定位键（id）此时才展开，
  // 且 userId 必须是平台规则的合法 QQ。
  if (!isRealQq(parsed.userId)) return "revoked";
  const located = ownerScope(db, owner);
  if (located === "ambiguous") return "revoked";
  if (!located) return "revoked";
  const scope = located.scope;
  if (!owner.agentId || owner.agentId !== scope.agentId) return "revoked";
  if (
    parsed.accountId !== scope.accountId ||
    parsed.conversationKind !== scope.conversationKind ||
    parsed.peerId !== scope.peerId
  )
    return "revoked";
  if (!evidenceScopeExists(db, botScope(scope))) return "revoked";
  if (!memberEstablished(db, scope, parsed.userId)) return "revoked";
  const row = memberRow(
    db,
    parsed.accountId,
    parsed.conversationKind,
    parsed.peerId,
    parsed.userId,
  );
  if (!row) return "revoked";
  // 行帽在（isObservationExpired 按固定宽字符串比较）；ref 冻结帽是可选补充：
  // 出现但不可解析 → fail closed（revoked，不跳过）；可解析且已过 → expired。
  if (isObservationExpired(row.expiresAt, now)) return "expired";
  if (source.expiresAt !== undefined) {
    if (!parseableTime(source.expiresAt)) return "revoked";
    if (Date.parse(source.expiresAt) <= Date.parse(now)) return "expired";
  }
  return sourceRevision(scope, parsed.userId, row) === source.revision ? "available" : "revoked";
}

/**
 * Clip each identity's optional `currentName` to what a currently-valid name source proves.
 * A candidate is bound to one member: the ref's id must name THIS identity's QQ, its value
 * must equal the row's real current dual name (mint's own value), and the identity's
 * currentName must match that too. Anonymous/null-QQ or unverifiable identities are clipped;
 * snapshots, text parts, reply metadata and `fact.sources` are preserved verbatim, and the
 * caller's facts are never mutated. Not a whole-context inspection — body/fact sources are
 * still checked elsewhere; this helper only owns the optional currentName field.
 */
export function pruneQqMemberCurrentNames(input: {
  db: Database;
  facts: readonly QqMessageFact[];
  owner: RunOwner;
  principal: ContextPrincipal;
  now: string;
  candidates: ReadonlyMap<string, QqMemberNameCandidate>;
}): QqMessageFact[] {
  const verdicts = new Map<SourceRef, boolean>();
  const verified = (candidate: QqMemberNameCandidate): boolean => {
    const cached = verdicts.get(candidate.source);
    if (cached !== undefined) return cached;
    const ok =
      candidate.source.kind === "qq_member_name" &&
      qqMemberNameSourceAccess(
        input.db,
        candidate.source,
        input.owner,
        input.principal,
        input.now,
      ) === "available";
    verdicts.set(candidate.source, ok);
    return ok;
  };
  const withoutCurrentName = (identity: QqIdentity): QqIdentity => {
    if (identity.currentName === undefined) return identity;
    const clone = { ...identity };
    delete clone.currentName;
    return clone;
  };
  const resolve = (identity: QqIdentity): QqIdentity => {
    if (identity.role !== "member" || identity.qq === null) return withoutCurrentName(identity);
    const current = identity.currentName;
    if (current === undefined) return identity;
    const candidate = input.candidates.get(identity.qq);
    if (!candidate || !verified(candidate)) return withoutCurrentName(identity);
    const proven = parseMemberId(candidate.source.id);
    if (!proven || proven.userId !== identity.qq) return withoutCurrentName(identity);
    const row = memberRow(
      input.db,
      proven.accountId,
      proven.conversationKind,
      proven.peerId,
      proven.userId,
    );
    if (row?.nameState !== "known" || isObservationExpired(row.expiresAt, input.now))
      return withoutCurrentName(identity);
    if (
      candidate.value.groupCard !== row.groupCard ||
      candidate.value.personalNickname !== row.personalNickname ||
      candidate.value.groupCard !== current.groupCard ||
      candidate.value.personalNickname !== current.personalNickname
    )
      return withoutCurrentName(identity);
    return identity;
  };
  return input.facts.map((fact) => {
    const clone = structuredClone(fact) as QqMessageFact;
    clone.speaker = resolve(clone.speaker);
    clone.mentions = clone.mentions.map((mention) =>
      mention.identity ? { ...mention, identity: resolve(mention.identity) } : mention,
    );
    return clone;
  });
}
