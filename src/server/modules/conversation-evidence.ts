import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { RunOwner } from "../../shared/contracts/agent-run";
import type { Evidence, SourceRef } from "../../shared/contracts/evidence";
import type { ActionContext, EvidenceQueryModule } from "../agent/built-in-actions";
import { readQqMessageFactsByPlatformMessageId } from "../db/qq-message-repository";
import { DEFAULT_USER_ID } from "../db/repositories";
import { fail } from "../errors";
import { fullCasefold } from "../services/text";
import {
  type EvidenceDomain,
  type EvidenceStore,
  evidenceHash,
  loadConversationEvidence,
  type StoredEvidence,
  storedPackages,
  VALID_TURN,
} from "./conversation-evidence-store";

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
export function evidenceScopeExists(
  db: EvidenceStore["db"],
  scope: ConversationEvidenceScope,
): boolean {
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
function scanConversationEvidence(
  store: EvidenceStore,
  scope: ConversationEvidenceScope,
  domain: EvidenceDomain,
  after: string | number,
  limit: number,
) {
  if (scope.channel === "onebot11" && domain === "summary") {
    const keys = (storedPackages(store, scope)?.packages ?? [])
      .map(evidenceHash)
      .sort()
      .filter((key) => key > String(after));
    return {
      keys: keys.slice(0, limit).map((key) => ({ key, position: key })),
      more: keys.length > limit,
    };
  }
  let sql: string, args: (string | number)[];
  if (scope.channel === "web" && domain === "history") {
    sql = `SELECT m.id AS key,m.sequence_no AS position FROM messages m WHERE m.session_id=?
      AND m.sequence_no>? AND m.turn_id<>? AND m.status='completed' AND m.role IN ('user','assistant')
      AND EXISTS(SELECT 1 ${VALID_TURN} AND t.id=m.turn_id AND s.id=?) ORDER BY m.sequence_no LIMIT ?`;
    args = [
      scope.sessionId,
      after,
      scope.currentTurnId,
      DEFAULT_USER_ID,
      scope.agentId,
      scope.sessionId,
    ];
  } else if (scope.channel === "web") {
    sql = `SELECT id AS key,id AS position FROM session_summaries WHERE session_id=?
      AND agent_id=? AND user_id=? AND id>? ORDER BY id LIMIT ?`;
    args = [scope.sessionId, scope.agentId, DEFAULT_USER_ID, after];
  } else {
    sql =
      "SELECT seq AS key,seq AS position FROM conversation_events WHERE conversation_id=? AND seq>? ORDER BY seq LIMIT ?";
    args = [scope.conversationId, after];
  }
  const keys = store.db.query(sql).all(...args, limit + 1) as {
    key: string | number;
    position: string | number;
  }[];
  return { keys: keys.slice(0, limit), more: keys.length > limit };
}

interface CommonOptions extends EvidenceStore {
  agentId: string;
  assertCurrent(): void;
  assertSources(sources: readonly SourceRef[]): void;
  now?: () => string;
}
export interface WebConversationEvidenceOptions extends CommonOptions {
  sessionId: string;
  currentTurnId: string;
  /** Defaults to true; the host passes retrieval_mode !== "off". Only the factory applies this default. */
  retrievalEnabled?: boolean;
}
export interface BotConversationEvidenceOptions extends CommonOptions {
  conversationId: string;
  bindingId: string;
  bindingEpoch: number;
  authorityRevision: number;
  scope: {
    kind: "qq";
    accountId: string;
    conversationKind: "group" | "private";
    peerId: string;
    agentId: string;
  };
  /** Set by the host's decision tier. False means no summary tool is installed. */
  summaryEnabled: boolean;
}
const id = z.string().min(1).max(1024);
const ScopeSchema = z.discriminatedUnion("channel", [
  z.strictObject({
    channel: z.literal("web"),
    agentId: id,
    sessionId: id,
    currentTurnId: id,
    retrievalEnabled: z.boolean(),
  }),
  z.strictObject({
    channel: z.literal("onebot11"),
    agentId: id,
    conversationId: id,
    bindingId: id,
    bindingEpoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    authorityRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    accountId: id,
    conversationKind: z.enum(["group", "private"]),
    peerId: id,
  }),
]);
const KeySchema = z.union([id, z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)]);
const RefSchema = z.tuple([ScopeSchema, z.enum(["history", "summary"]), KeySchema]);
const QuerySchema = z.strictObject({
  query: z.string().max(4096),
  limit: z.number().int().positive().optional(),
  cursor: z.string().min(1).max(16384).optional(),
});
function selection(): never {
  return fail("CONTEXT_INVALID_SELECTION", "会话证据分页或引用无效");
}
function revoked(): never {
  return fail("CONTEXT_SOURCE_INVALID", "会话证据、来源或授权已变化");
}
const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};
const prefix = (text: string, limit: number): string => {
  let result = "",
    n = 0;
  for (const point of text) {
    if (n++ === limit) break;
    result += point;
  }
  return result;
};
function ownerMatches(
  store: EvidenceStore,
  scope: ConversationEvidenceScope,
  owner: RunOwner,
): boolean {
  if (owner.userId !== DEFAULT_USER_ID || owner.agentId !== scope.agentId) return false;
  if (scope.channel === "web") {
    if (owner.kind === "web_turn") return owner.id === scope.currentTurnId;
    return (
      owner.kind === "conversation" &&
      !!store.db
        .query(`SELECT 1 FROM conversations WHERE id=?
      AND channel='web' AND source_id=? AND user_id=? AND agent_id=? AND closed_at IS NULL`)
        .get(owner.id, scope.sessionId, DEFAULT_USER_ID, scope.agentId)
    );
  }
  return (
    (owner.kind === "qq_binding" && owner.id === scope.bindingId) ||
    (owner.kind === "conversation" && owner.id === scope.conversationId)
  );
}
function evidence(
  scope: ConversationEvidenceScope,
  domain: EvidenceDomain,
  key: string | number,
  row: StoredEvidence,
): Evidence {
  const ref: SourceRef = {
    kind: "conversation_evidence",
    id: JSON.stringify([scope, domain, key]),
    revision: evidenceHash([scope, domain, key, row.revision]),
  };
  const expires = row.sources.flatMap((s) => (s.expiresAt ? [s.expiresAt] : [])).sort()[0];
  if (expires) ref.expiresAt = expires;
  return {
    id: ref.id,
    scope: JSON.stringify(scope),
    text: "",
    preview: { title: prefix(row.title, 96), summary: prefix(row.text, 256) },
    sources: [...row.sources, ref],
  };
}
/** Bind before the generic sourceAccess fallback in execution, tasks and inspection.
 * This is a durable store check, not a cached assertion that a query once succeeded.
 */
export function conversationEvidenceSourceAccess(
  store: EvidenceStore,
  source: SourceRef,
  owner: RunOwner,
  now: string,
): "available" | "expired" | "revoked" | undefined {
  if (source.kind !== "conversation_evidence") return undefined;
  if (!Number.isFinite(Date.parse(now))) return "revoked";
  if (source.expiresAt) {
    if (!Number.isFinite(Date.parse(source.expiresAt))) return "revoked";
    if (Date.parse(source.expiresAt) <= Date.parse(now)) return "expired";
  }
  if (source.id.length > 16384) return "revoked";
  const ref = RefSchema.safeParse(parseJson(source.id));
  if (!ref.success) return "revoked";
  const [scope, domain, key] = ref.data;
  if (!ownerMatches(store, scope, owner) || !evidenceScopeExists(store.db, scope)) return "revoked";
  const row = loadConversationEvidence(store, scope, domain, key, now);
  return row && evidenceHash([scope, domain, key, row.revision]) === source.revision
    ? "available"
    : "revoked";
}
/**
 * Shared guard for every evidence entry point (query/read/locate): one sequence,
 * one owner/scope check, one source re-check — duplicated sequences would drift.
 * The web-turn liveness clause is a no-op for bot scopes, so one implementation
 * serves both channels.
 */
function createEvidenceGuard(options: CommonOptions, scope: ConversationEvidenceScope) {
  return function guard(context: ActionContext) {
    context.signal.throwIfAborted();
    context.assertAuthority?.();
    options.assertCurrent();
    if (!ownerMatches(options, scope, context.owner) || !evidenceScopeExists(options.db, scope))
      revoked();
    if (
      scope.channel === "web" &&
      !options.db
        .query(`SELECT 1 FROM turns WHERE id=? AND generation_status='active'
      AND cancel_requested=0 AND invalidated_at IS NULL`)
        .get(scope.currentTurnId)
    )
      revoked();
    options.assertSources(context.sources ?? []);
    context.signal.throwIfAborted();
  };
}
/** Same clock validation as the guard's callers rely on: an unparsable clock must not mint or load a reference. */
function createEvidenceNow(options: CommonOptions) {
  return () => {
    const value = options.now?.() ?? new Date().toISOString();
    if (!Number.isFinite(Date.parse(value))) revoked();
    return value;
  };
}
function createDomain(
  options: CommonOptions,
  scope: ConversationEvidenceScope,
  domain: EvidenceDomain,
  guard: (context: ActionContext) => void,
  now: () => string,
): EvidenceQueryModule {
  // Internal keysets are authenticated; the factory alone mints run/owner opaque tool cursors.
  const secret = randomBytes(32),
    scopeKey = JSON.stringify(scope);
  const sign = (text: string) => createHmac("sha256", secret).update(text).digest("hex");
  function position(query: string, cursor?: string): string | number {
    if (cursor === undefined) return domain === "history" ? 0 : "";
    const split = cursor.lastIndexOf("."),
      payload = cursor.slice(0, split),
      mac = cursor.slice(split + 1);
    if (
      split < 1 ||
      !/^[a-f0-9]{64}$/.test(mac) ||
      !timingSafeEqual(Buffer.from(mac, "hex"), Buffer.from(sign(payload), "hex"))
    )
      selection();
    const value = parseJson(payload);
    if (
      !Array.isArray(value) ||
      value.length !== 4 ||
      value[0] !== scopeKey ||
      value[1] !== domain ||
      value[2] !== query
    )
      selection();
    const last = value[3];
    if (
      domain === "history"
        ? !Number.isSafeInteger(last) || last < 1
        : typeof last !== "string" || !last.length || last.length > 1024
    )
      selection();
    return last;
  }
  return {
    async query(input, context) {
      guard(context);
      const parsed = QuerySchema.safeParse(input);
      if (!parsed.success) selection();
      const { query, cursor } = parsed.data,
        limit = Math.min(100, parsed.data.limit ?? 20);
      const after = position(query, cursor),
        page = scanConversationEvidence(options, scope, domain, after, limit);
      const items: Evidence[] = [];
      for (const entry of page.keys) {
        const row = loadConversationEvidence(options, scope, domain, entry.key, now());
        if (!row || (query && !fullCasefold(prefix(row.text, 4096)).includes(fullCasefold(query))))
          continue;
        const item = evidence(scope, domain, entry.key, row);
        options.assertSources(item.sources);
        items.push(item);
      }
      guard(context);
      options.assertSources(items.flatMap((item) => item.sources));
      context.signal.throwIfAborted();
      const last = page.keys.at(-1)?.position;
      const payload =
        last !== undefined && page.more ? JSON.stringify([scopeKey, domain, query, last]) : null;
      return {
        status: "ok",
        items,
        ...(payload ? { nextCursor: `${payload}.${sign(payload)}` } : {}),
      };
    },
    async read(input, context) {
      guard(context);
      if (
        !Number.isSafeInteger(input.offset) ||
        input.offset < 0 ||
        !Number.isSafeInteger(input.limit) ||
        input.limit < 1 ||
        input.evidence.id.length > 16384
      )
        selection();
      const ref = RefSchema.safeParse(parseJson(input.evidence.id));
      if (!ref.success || JSON.stringify(ref.data[0]) !== scopeKey || ref.data[1] !== domain)
        selection();
      const row = loadConversationEvidence(options, scope, domain, ref.data[2], now());
      if (!row) revoked();
      const current = evidence(scope, domain, ref.data[2], row);
      if (JSON.stringify(current.sources) !== JSON.stringify(input.evidence.sources)) revoked();
      options.assertSources(current.sources);
      const limit = Math.min(input.limit, 4096),
        offset = input.offset;
      let total = 0,
        text = "";
      for (const point of row.text) {
        if (total >= offset && total - offset < limit) text += point;
        total++;
      }
      if (offset > total) selection();
      guard(context);
      return { text, offset, total, nextOffset: offset + limit < total ? offset + limit : null };
    },
  };
}
export function createWebConversationEvidence(options: WebConversationEvidenceOptions): {
  history: EvidenceQueryModule;
  summary: EvidenceQueryModule;
} {
  const scope = ScopeSchema.parse({
    channel: "web",
    agentId: options.agentId,
    sessionId: options.sessionId,
    currentTurnId: options.currentTurnId,
    retrievalEnabled: options.retrievalEnabled ?? true,
  });
  const guard = createEvidenceGuard(options, scope),
    now = createEvidenceNow(options);
  return {
    history: createDomain(options, scope, "history", guard, now),
    summary: createDomain(options, scope, "summary", guard, now),
  };
}
export function createBotConversationEvidence(options: BotConversationEvidenceOptions): {
  history: EvidenceQueryModule;
  summary?: EvidenceQueryModule;
  locateHistory(platformMessageId: string, context: ActionContext): Evidence | null;
} {
  if (options.scope.kind !== "qq" || options.scope.agentId !== options.agentId) revoked();
  const scope: BotEvidenceScope = ScopeSchema.options[1].parse({
    channel: "onebot11",
    agentId: options.agentId,
    conversationId: options.conversationId,
    bindingId: options.bindingId,
    bindingEpoch: options.bindingEpoch,
    authorityRevision: options.authorityRevision,
    accountId: options.scope.accountId,
    conversationKind: options.scope.conversationKind,
    peerId: options.scope.peerId,
  });
  const guard = createEvidenceGuard(options, scope),
    now = createEvidenceNow(options);
  const history = createDomain(options, scope, "history", guard, now);
  const summary = options.summaryEnabled
    ? createDomain(options, scope, "summary", guard, now)
    : undefined;
  /**
   * Host-side location of one inbound message by platform message ID: the SQL scope
   * filter of `readQqMessageFactsByPlatformMessageId` is the authorisation boundary,
   * so a cross-conversation ID resolves to zero candidates and reveals nothing. The
   * returned item is minted by the same evidence wrapper as a query hit, with the
   * tagged `qq-message:<eventKey>` key — the body is never attached here; pages come
   * only from the module's own read path through that loader, so body/fact state and
   * sources are re-checked on every read.
   */
  function locateHistory(platformMessageId: string, context: ActionContext): Evidence | null {
    guard(context);
    if (!z.string().min(1).max(1024).safeParse(platformMessageId).success) selection();
    const facts = readQqMessageFactsByPlatformMessageId(options.orm, {
      accountId: scope.accountId,
      conversationKind: scope.conversationKind,
      peerId: scope.peerId,
      agentId: scope.agentId,
      platformMessageId,
    });
    const keys = [...new Set(facts.map((row) => row.eventKey))];
    // Zero candidates or an ambiguous platform ID resolve to nothing; a foreign-scope
    // ID never enters the candidate set (the SQL filter runs before any row is read).
    const [only] = keys;
    if (only === undefined || keys.length !== 1) return null;
    const key = `qq-message:${only}`;
    const row = loadConversationEvidence(options, scope, "history", key, now());
    if (!row) return null;
    const item = evidence(scope, "history", key, row);
    if (!RefSchema.safeParse(parseJson(item.id)).success) return null;
    options.assertSources(item.sources);
    guard(context);
    return item;
  }
  return {
    history,
    ...(summary ? { summary } : {}),
    locateHistory,
  };
}
