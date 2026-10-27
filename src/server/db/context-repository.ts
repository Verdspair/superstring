// P5 context reads and segmented-summary persistence.
// all model calls live in ContextBuilder
// never in this repository. Callers own transaction boundaries.

import { createHash } from "node:crypto";
import { and, asc, desc, eq, getTableColumns, gt, inArray, or, sql } from "drizzle-orm";
import type { ContentItem, RuntimeConfig } from "../../shared/contracts";
import {
  type ResolvedModelContext,
  ResolvedModelContextSchema,
  RuntimeConfigSchema,
} from "../../shared/contracts/agent";
import { AppError } from "../errors";
import { fullCasefold } from "../services/casefold-table";
import {
  AGENT_LEVEL_SCOPE_KEY,
  MEMORY_SEARCH_INVALID_LAYOUT_SQL,
  memorySearchProjection,
} from "../services/memory-contract";
import {
  correctionMetadata,
  isCorrectionRetired,
  memoryRevision,
} from "../services/memory-revision";
import {
  type MemoryConversationAccess,
  type MemoryScopeKeys,
  memoryAccessEvidence,
} from "../services/memory-scope";
import { qqConversationKey, qqMemoryScopeKey } from "../services/qq-binding-contract";
import { compileSystemPrompt } from "../services/runtime-config";
import {
  activeCorrections,
  type CorrectionScan,
  correctionsForTurns,
  correctionsForTurnsFrom,
} from "./memory-content-repository";
import { entries, ownedSession, sessionScope, turns } from "./memory-repository";
import {
  acceptsObservationSources,
  loadMessageIntegrity,
  loadQqEvents,
  loadSessionIntegrity,
  loadTurnIntegrity,
  type MessageIntegrityRow,
  observationContentSources,
  observationSources,
  observationSourcesIntact,
  type SessionIntegrityRow,
  type TurnIntegrityRow,
} from "./memory-source-repository";
import { DEFAULT_USER_ID, newId, nowIso, type Orm } from "./repositories";
import * as schema from "./schema";

export interface ContextMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ContextTurn {
  id: string;
  sequenceNo: number;
  userMessageId: string;
  assistantMessageId: string;
  user: string;
  assistant: string;
  userSource: { actor: { kind: "user"; id: string }; recorded_at: string };
  assistantSource: { actor: { kind: "agent"; id: string }; recorded_at: string };
}

export interface MemoryItem extends ContentItem {
  createdAt: string;
}

export interface SummaryFact {
  kind: "fact" | "decision" | "todo" | "uncertainty";
  speaker: "user" | "assistant" | "both";
  text: string;
  source_ids: string[];
}

export interface SummaryContent {
  facts: SummaryFact[];
}

export interface SummaryItem {
  id: string;
  content: SummaryContent;
  turnIds: string[];
}

function contextFail(message: string): never {
  throw new AppError("CONTEXT_SOURCE_INVALID", message, 409);
}

function isoExpired(value: string): boolean {
  return new Date(value).getTime() <= Date.now();
}

export function currentUser(
  orm: Orm,
  agentId: string,
  sessionId: string,
  turnId: string,
  options: { generationToken?: string | null } = {},
): {
  id: string;
  sequenceNo: number;
  role: "user";
  content: string;
  generationToken: string;
} {
  ownedSession(orm, agentId, sessionId);
  const turn = orm
    .select()
    .from(schema.turns)
    .where(and(eq(schema.turns.id, turnId), eq(schema.turns.sessionId, sessionId)))
    .get();
  const valid =
    turn !== undefined &&
    turn.generationStatus === "active" &&
    turn.cancelRequested !== 1 &&
    turn.invalidatedAt === null &&
    turn.generationToken !== null &&
    turn.leaseExpiresAt !== null &&
    !isoExpired(turn.leaseExpiresAt) &&
    (options.generationToken === undefined ||
      options.generationToken === null ||
      turn.generationToken === options.generationToken);
  if (!valid || turn === undefined || turn.generationToken === null) {
    contextFail("当前生成已取消、过期、失效或不属于本次请求");
  }
  const item = orm
    .select()
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.turnId, turnId),
        eq(schema.messages.sessionId, sessionId),
        eq(schema.messages.role, "user"),
        eq(schema.messages.status, "completed"),
      ),
    )
    .get();
  if (!item) contextFail("当前轮次用户消息已失效");
  return {
    id: item.id,
    sequenceNo: item.sequenceNo,
    role: "user",
    content: item.content,
    generationToken: turn.generationToken,
  };
}

/** Incrementally freeze one observed capacity. */
export function freezeModelCapacity(
  orm: Orm,
  agentId: string,
  sessionId: string,
  turnId: string,
  model: string,
  capacity: number,
  generationToken: string | null,
): Record<string, number> {
  if (generationToken === null) contextFail("容量冻结缺少本次生成令牌");
  if (!Number.isInteger(capacity) || capacity <= 0) {
    throw new AppError("CONTEXT_CAPACITY_ERROR", "无效模型容量", 409);
  }
  const current = currentUser(orm, agentId, sessionId, turnId, { generationToken });
  const turn = orm.select().from(schema.turns).where(eq(schema.turns.id, turnId)).get();
  if (!turn) contextFail("当前生成已取消、过期、失效或不属于本次请求");

  let raw: unknown;
  try {
    raw = JSON.parse(turn.runtimeConfigSnapshot);
  } catch {
    contextFail("容量冻结的Agent或模型不属于本轮运行快照");
  }
  const runtime = raw as RuntimeConfig;
  const allowed = new Set([
    runtime.model_name,
    runtime.memory_retrieval_model_name,
    runtime.context_compression_model_name,
  ]);
  if (runtime.agent_id !== agentId || !allowed.has(model)) {
    contextFail("容量冻结的Agent或模型不属于本轮运行快照");
  }
  const capacities = { ...(runtime.resolved_model_capacities ?? {}) };
  if (!(model in capacities)) {
    capacities[model] = capacity;
    orm
      .update(schema.turns)
      .set({
        runtimeConfigSnapshot: JSON.stringify({
          ...runtime,
          resolved_model_capacities: capacities,
        }),
      })
      .where(eq(schema.turns.id, turnId))
      .run();
  }
  void current;
  return capacities;
}

/**
 * Freeze one observed model-context reading, keyed by the requested model name.
 * The snapshot records only primitives: the budget descriptor, any credential and
 * the endpoint stay outside it. Like `freezeModelCapacity` this writes no
 * transaction of its own — the caller owns the boundary.
 *
 * A turn whose snapshot predates this field keeps the field ABSENT, and that
 * absence is a rejection rather than an invitation: the reading is never
 * injected into an old snapshot, because the retry would then freeze today's
 * route as if it were the original one.
 */
export function freezeModelContext(
  orm: Orm,
  agentId: string,
  sessionId: string,
  turnId: string,
  requestedModel: string,
  metadata: ResolvedModelContext,
  generationToken: string | null,
): Record<string, ResolvedModelContext> {
  if (generationToken === null) contextFail("上下文冻结缺少本次生成令牌");
  const parsedMetadata = ResolvedModelContextSchema.safeParse(metadata);
  if (!parsedMetadata.success) {
    throw new AppError("CONTEXT_SOURCE_INVALID", "无效的模型上下文元数据", 409);
  }
  const reading = parsedMetadata.data;
  currentUser(orm, agentId, sessionId, turnId, { generationToken });
  const turn = orm.select().from(schema.turns).where(eq(schema.turns.id, turnId)).get();
  if (!turn) contextFail("当前生成已取消、过期、失效或不属于本次请求");

  let stored: unknown;
  try {
    stored = JSON.parse(turn.runtimeConfigSnapshot);
  } catch {
    contextFail("上下文冻结的Agent或模型不属于本轮运行快照");
  }
  // Strict parse before any use: a snapshot that no longer satisfies the
  // contract cannot carry a new reading.
  if (stored === null || typeof stored !== "object" || Array.isArray(stored)) {
    contextFail("上下文冻结的Agent或模型不属于本轮运行快照");
  }
  const validated = RuntimeConfigSchema.safeParse(stored);
  if (!validated.success) {
    contextFail("上下文冻结的Agent或模型不属于本轮运行快照");
  }
  const runtime = validated.data;
  const allowed = new Set([
    runtime.model_name,
    runtime.memory_retrieval_model_name,
    runtime.context_compression_model_name,
  ]);
  if (runtime.agent_id !== agentId || !allowed.has(requestedModel)) {
    contextFail("上下文冻结的Agent或模型不属于本轮运行快照");
  }
  const frozen = runtime.resolved_model_contexts;
  if (frozen === undefined) {
    contextFail("本轮运行快照早于模型上下文冻结，拒绝改写其语义");
  }
  const existing = frozen[requestedModel];
  const capacities = { ...(runtime.resolved_model_capacities ?? {}) };
  const frozenCapacity = capacities[requestedModel];
  if (
    (existing !== undefined && frozenCapacity === undefined) ||
    (frozenCapacity !== undefined && frozenCapacity !== reading.capacity)
  ) {
    throw new AppError("CONTEXT_CAPACITY_INSUFFICIENT", "本轮模型容量与已冻结的观测不一致", 409);
  }
  if (existing !== undefined) {
    // First snapshot wins; a later observation never replaces it, and a
    // conflicting one is reported instead of being silently overwritten.
    if (JSON.stringify(existing) !== JSON.stringify(reading)) {
      throw new AppError("CONTEXT_CAPACITY_INSUFFICIENT", "本轮模型上下文已被其他观测冻结", 409);
    }
    return frozen;
  }
  orm
    .update(schema.turns)
    .set({
      // Spread the stored fields, not the validated copy: defaults the contract
      // supplies for absent fields must not be written back into the snapshot.
      runtimeConfigSnapshot: JSON.stringify({
        ...stored,
        resolved_model_capacities: { ...capacities, [requestedModel]: reading.capacity },
        resolved_model_contexts: { ...frozen, [requestedModel]: reading },
      }),
    })
    .where(eq(schema.turns.id, turnId))
    .run();
  return { ...frozen, [requestedModel]: reading };
}

function toContextTurn(row: ReturnType<typeof turns>[number]): ContextTurn {
  return {
    id: row.turn.id,
    sequenceNo: row.user.sequenceNo,
    userMessageId: row.user.id,
    assistantMessageId: row.assistant.id,
    user: row.user.content,
    assistant: row.assistant.content,
    userSource: {
      actor: { kind: "user", id: row.session.userId },
      recorded_at: row.user.createdAt,
    },
    assistantSource: {
      actor: { kind: "agent", id: row.session.agentId },
      recorded_at: row.assistant.createdAt,
    },
  };
}

export function history(
  orm: Orm,
  agentId: string,
  sessionId: string,
  beforeSequenceNo: number,
  ids?: string[],
): ContextTurn[] {
  const result = turns(orm, agentId, sessionId, { ids })
    .map(toContextTurn)
    .filter((item) => item.sequenceNo < beforeSequenceNo);
  if (ids !== undefined) {
    const found = new Set(result.map((item) => item.id));
    if (found.size !== new Set(ids).size || ids.some((id) => !found.has(id))) {
      contextFail("历史来源不属于当前会话或已失效");
    }
  }
  return result;
}

/**
 * Recall candidates.
 * `scopeKeys` is the explicit read scope (see memory-scope.ts). `undefined` keeps
 * the historical agent-level read; `null` is not accepted here because callers
 * must decide explicitly rather than inheriting a silent fallback.
 */
function validMemoryRows(
  orm: Orm,
  agentId: string,
  scopeKeys?: MemoryScopeKeys,
  boundedRows?: ReturnType<typeof entries>,
  ids?: string[],
  sessionId?: string,
): ReturnType<typeof entries> {
  const rows =
    boundedRows ??
    entries(orm, agentId, ids, { status: "active", scopeKeys, requireAllIds: false });
  const observations = observationSources(
    orm,
    rows.map((row) => row.id),
  );
  // Same-call batched reads: identical projections/predicates to the former
  // per-source SELECTs; maps never leave this call.
  const sourcesByMemory = loadMemorySourcesRaw(
    orm,
    rows.map((row) => row.id),
  );
  const allSources = rows.flatMap((row) => sourcesByMemory.get(row.id) ?? []);
  const turnRows = loadTurnIntegrity(
    orm,
    allSources.map((source) => source.turnId),
  );
  const sessionRows = loadSessionIntegrity(
    orm,
    [...turnRows.values()].map((turn) => turn.sessionId),
  );
  const messageRows = loadMessageIntegrity(
    orm,
    allSources.flatMap((source) => [source.userMessageId, source.assistantMessageId]),
  );
  const observationEvents =
    boundedRows === undefined
      ? undefined
      : loadQqEvents(
          orm,
          [...observations.values()].flat().map((source) => source.eventKey),
        );
  const currentSession =
    sessionId === undefined ? undefined : ownedSession(orm, agentId, sessionId);
  return rows.filter((entry) => {
    if (isCorrectionRetired(entry.configSnapshot)) return false;
    const sources = sourcesByMemory.get(entry.id) ?? [];
    if (sources.length > 0) {
      const intact = sources.map((source) => {
        const turn = turnRows.get(source.turnId);
        return turnSourceIntactOn(
          agentId,
          turn,
          turn === undefined ? undefined : sessionRows.get(turn.sessionId),
          messageRows.get(source.userMessageId),
          messageRows.get(source.assistantMessageId),
        );
      });
      if (intact.every(Boolean)) {
        // Web runtime reads are current-session private: every recorded Web turn
        // must belong to the same owned session. Management/QQ callers omit this.
        if (
          currentSession !== undefined &&
          ((observations.get(entry.id)?.length ?? 0) !== 0 ||
            sources.some((source) => turnRows.get(source.turnId)?.sessionId !== currentSession.id))
        )
          return false;
        return true;
      }
    }
    if (currentSession !== undefined) return false;
    // A QQ memory may be backed by observations instead; web memory may not.
    return (
      acceptsObservationSources(entry.scopeKey, agentId) &&
      observationSourcesIntact(orm, observations.get(entry.id) ?? []) &&
      (boundedRows === undefined ||
        (observations.get(entry.id) ?? []).every((source) => {
          const event = observationEvents?.get(source.eventKey);
          if (
            !event ||
            event.agentId !== agentId ||
            !["group", "private"].includes(event.conversationKind)
          )
            return false;
          const kind = event.conversationKind as "group" | "private";
          try {
            return (
              source.scopeKey === entry.scopeKey &&
              qqMemoryScopeKey({
                kind: "qq",
                accountId: event.accountId,
                conversationKind: kind,
                peerId: event.peerId,
                agentId,
              }) === entry.scopeKey &&
              source.conversationKey ===
                qqConversationKey({ accountId: event.accountId, kind, peerId: event.peerId })
            );
          } catch {
            return false;
          }
        }))
    );
  });
}

/**
 * Every source row of the given summaries, grouped by summary id, each group in
 * the same (sequenceNo asc) order the former per-summary query returned.
 */
function loadSummarySources(
  orm: Orm,
  summaryIds: string[],
): Map<string, Array<typeof schema.summarySources.$inferSelect>> {
  const grouped = new Map<string, Array<typeof schema.summarySources.$inferSelect>>();
  if (summaryIds.length === 0) return grouped;
  const rows = orm
    .select()
    .from(schema.summarySources)
    .where(inArray(schema.summarySources.summaryId, summaryIds))
    .orderBy(schema.summarySources.summaryId, schema.summarySources.sequenceNo)
    .all();
  for (const row of rows) {
    const list = grouped.get(row.summaryId);
    if (list) list.push(row);
    else grouped.set(row.summaryId, [row]);
  }
  return grouped;
}

/**
 * Every turn source of the given memories, grouped by memory id, in the same order
 * the previous per-memory query returned (memory_id, turn_id PK-index order).
 */
/**
 * ALL rows of the given memories' turn sources, no join — the validity read must
 * keep every recorded source, so a source whose turn row is missing still makes
 * the memory invalid instead of disappearing from the comparison.
 */
function loadMemorySourcesRaw(
  orm: Orm,
  memoryIds: string[],
): Map<string, Array<typeof schema.memorySources.$inferSelect>> {
  return groupMemorySourcesByMemory(memoryIds, (chunk) =>
    orm
      .select()
      .from(schema.memorySources)
      .where(inArray(schema.memorySources.memoryId, chunk))
      .orderBy(schema.memorySources.memoryId, schema.memorySources.turnId)
      .all(),
  );
}

function groupMemorySourcesByMemory(
  memoryIds: string[],
  load: (chunk: string[]) => Array<typeof schema.memorySources.$inferSelect>,
): Map<string, Array<typeof schema.memorySources.$inferSelect>> {
  const grouped = new Map<string, Array<typeof schema.memorySources.$inferSelect>>();
  const unique = [...new Set(memoryIds)];
  for (let index = 0; index < unique.length; index += 500) {
    for (const row of load(unique.slice(index, index + 500))) {
      const list = grouped.get(row.memoryId);
      if (list) list.push(row);
      else grouped.set(row.memoryId, [row]);
    }
  }
  return grouped;
}

function loadMemorySources(
  orm: Orm,
  memoryIds: string[],
): Map<string, Array<{ source: typeof schema.memorySources.$inferSelect; sessionId: string }>> {
  const grouped = new Map<
    string,
    Array<{ source: typeof schema.memorySources.$inferSelect; sessionId: string }>
  >();
  if (memoryIds.length === 0) return grouped;
  const rows = orm
    .select()
    .from(schema.memorySources)
    .innerJoin(schema.turns, eq(schema.turns.id, schema.memorySources.turnId))
    .where(inArray(schema.memorySources.memoryId, memoryIds))
    .orderBy(schema.memorySources.memoryId, schema.memorySources.turnId)
    .all();
  for (const { memory_sources: source, turns: turn } of rows) {
    const list = grouped.get(source.memoryId);
    if (list) list.push({ source, sessionId: turn.sessionId });
    else grouped.set(source.memoryId, [{ source, sessionId: turn.sessionId }]);
  }
  return grouped;
}

/** Same predicate as the former per-source turnSourceIntact, evaluated on batched maps. */
function turnSourceIntactOn(
  agentId: string,
  turn: TurnIntegrityRow | undefined,
  session: SessionIntegrityRow | undefined,
  user: MessageIntegrityRow | undefined,
  assistant: MessageIntegrityRow | undefined,
): boolean {
  return (
    turn !== undefined &&
    session !== undefined &&
    user !== undefined &&
    assistant !== undefined &&
    turn.sourceValid === 1 &&
    turn.contextValid === 1 &&
    turn.generationStatus === "completed" &&
    session.agentId === agentId &&
    session.userId === DEFAULT_USER_ID &&
    user.turnId === turn.id &&
    assistant.turnId === turn.id &&
    user.sessionId === session.id &&
    assistant.sessionId === session.id &&
    user.role === "user" &&
    assistant.role === "assistant" &&
    user.status === "completed" &&
    assistant.status === "completed"
  );
}

function parseStringArray(text: string): string[] {
  const value = JSON.parse(text) as unknown;
  return Array.isArray(value) ? value.map(String) : [];
}

/** One same-call batch read for the memory items a caller is about to project. */
function loadMemoryItems(
  orm: Orm,
  rows: Array<ReturnType<typeof entries>[number]>,
): Map<
  string,
  {
    sources: Array<{ source: typeof schema.memorySources.$inferSelect; sessionId: string }>;
    observations: ReturnType<typeof observationSources> extends Map<string, infer R> ? R : never;
  }
> {
  const byMemory = loadMemorySources(
    orm,
    rows.map((row) => row.id),
  );
  const observations = observationSources(
    orm,
    rows.map((row) => row.id),
  );
  const loaded = new Map<
    string,
    {
      sources: Array<{ source: typeof schema.memorySources.$inferSelect; sessionId: string }>;
      observations: ReturnType<typeof observationSources> extends Map<string, infer R> ? R : never;
    }
  >();
  for (const row of rows) {
    loaded.set(row.id, {
      sources: byMemory.get(row.id) ?? [],
      observations: observations.get(row.id) ?? [],
    });
  }
  return loaded;
}

function asMemoryItem(
  orm: Orm,
  row: ReturnType<typeof entries>[number],
  withBody = false,
  loaded?: {
    sources: Array<{ source: typeof schema.memorySources.$inferSelect; sessionId: string }>;
    observations: ReturnType<typeof observationSources> extends Map<string, infer R> ? R : never;
  },
): MemoryItem {
  // Called only for validMemoryRows; do not load original chat bodies for catalog
  // formatting. A missing batch entry is a caller contract violation, not an
  // empty result — read the single row exactly like the pre-change code did.
  const batch = loaded ?? loadMemoryItems(orm, [row]).get(row.id);
  if (!batch) throw new Error("asMemoryItem called for a row outside its own batch");
  return {
    id: row.id,
    source_type: "memory",
    content_origin: correctionMetadata(row.configSnapshot) ? "manual_correction" : "derived",
    name: row.name,
    summary: row.summary,
    tags: parseStringArray(row.tags),
    revision: memoryRevision(row),
    validity: "valid",
    createdAt: row.createdAt,
    sources: [
      ...batch.sources.map(({ source, sessionId }) => ({
        type: "chat" as const,
        turn_id: source.turnId,
        session_id: sessionId,
        user_message_id: source.userMessageId,
        assistant_message_id: source.assistantMessageId,
        sequence_no: source.sequenceNo,
        valid: true,
      })),
      ...observationContentSources(batch.observations),
    ],
    ...(withBody ? { body: row.body } : {}),
  };
}

/** Coarse candidate eligibility before any title/body projection; proof is revalidated below. */
function runtimeCandidateCondition(access: MemoryConversationAccess) {
  const e = schema.memoryEntries;
  const ownSource =
    access.channel === "web"
      ? sql`EXISTS (SELECT 1 FROM memory_sources ms JOIN turns t ON t.id=ms.turn_id WHERE ms.memory_id=${e.id} AND t.session_id=${access.sourceId})
      AND NOT EXISTS (SELECT 1 FROM memory_sources ms LEFT JOIN turns t ON t.id=ms.turn_id WHERE ms.memory_id=${e.id} AND (t.id IS NULL OR t.session_id<>${access.sourceId}))
      AND NOT EXISTS (SELECT 1 FROM qq_memory_sources qs WHERE qs.memory_id=${e.id})`
      : sql`EXISTS (SELECT 1 FROM qq_memory_sources qs JOIN conversation_events ce ON ce.source_kind='qq_event' AND ce.source_id=qs.event_key WHERE qs.memory_id=${e.id} AND ce.conversation_id=${access.conversationId})
      AND NOT EXISTS (SELECT 1 FROM qq_memory_sources qs WHERE qs.memory_id=${e.id} AND NOT EXISTS (SELECT 1 FROM conversation_events ce WHERE ce.source_kind='qq_event' AND ce.source_id=qs.event_key AND ce.conversation_id=${access.conversationId}))
      AND NOT EXISTS (SELECT 1 FROM memory_sources ms WHERE ms.memory_id=${e.id})`;
  const own = and(eq(e.agentId, access.agentId), ownSource)!;
  if (access.mode !== "agent_shared") return own;
  const granted = sql`(${e.visibility}='public' OR (${e.visibility}='agent_shared' AND ${e.agentId}=${access.agentId}))
    AND EXISTS (SELECT 1 FROM memory_read_grants g WHERE g.memory_id=${e.id} AND g.agent_id=${access.agentId})`;
  return or(own, granted)!;
}

function runtimeMemoryRows(
  orm: Orm,
  access: MemoryConversationAccess,
  rows: ReturnType<typeof entries>,
): {
  rows: ReturnType<typeof entries>;
  refs: ReadonlyMap<string, import("../../shared/contracts/evidence").SourceRef>;
} {
  const ownRows = rows.filter((row) => row.agentId === access.agentId);
  let own = validMemoryRows(
    orm,
    access.agentId,
    null,
    ownRows,
    undefined,
    access.channel === "web" ? access.sourceId : undefined,
  );
  if (access.channel === "onebot11" && own.length) {
    const db = (orm as Orm & { $client: import("bun:sqlite").Database }).$client;
    const matches = db
      .query(`SELECT q.memory_id FROM qq_memory_sources q
      LEFT JOIN conversation_events ce ON ce.source_kind='qq_event' AND ce.source_id=q.event_key AND ce.conversation_id=?
      WHERE q.memory_id IN (SELECT value FROM json_each(?))
      GROUP BY q.memory_id HAVING COUNT(*)>0 AND COUNT(ce.source_id)=COUNT(*)
      AND NOT EXISTS (SELECT 1 FROM memory_sources w WHERE w.memory_id=q.memory_id)`)
      .all(access.conversationId, JSON.stringify(own.map((row) => row.id))) as {
      memory_id: string;
    }[];
    const ids = new Set(matches.map((row) => row.memory_id));
    own = own.filter((row) => ids.has(row.id));
  }
  const refs = memoryAccessEvidence(orm, access, rows, new Set(own.map((row) => row.id)), nowIso());
  return { rows: rows.filter((row) => refs.has(row.id)), refs };
}

/** Tool reads select at most 300 authorized rows BEFORE validating sources or hashing bodies.
 * Complete bodies are needed by memoryRevision: at most 16,000 UTF-16 units per row
 * (64,000 UTF-8 bytes guarded in SQL), hence at most 19,200,000 body bytes per scan.
 * Search scoring uses only a 4,096-code-point prefix; legacy readers remain separate.
 */
export function scanMemoryCandidates(
  orm: Orm,
  agentId: string,
  scopeKeys: MemoryScopeKeys,
  options: {
    afterId?: string;
    limit: number;
    sessionId?: string;
    id?: string;
    access?: MemoryConversationAccess;
  },
): {
  items: Array<{
    item: MemoryItem;
    searchText: string;
    accessRef?: import("../../shared/contracts/evidence").SourceRef;
  }>;
  scannedIds: string[];
  hasMore: boolean;
} {
  if (options.sessionId) ownedSession(orm, agentId, options.sessionId);
  const limit = Math.min(300, Math.max(1, Math.trunc(options.limit)));
  const conditions = [
    options.access
      ? runtimeCandidateCondition(options.access)
      : eq(schema.memoryEntries.agentId, agentId),
    eq(schema.memoryEntries.userId, DEFAULT_USER_ID),
    eq(schema.memoryEntries.status, "active"),
  ];
  if (scopeKeys !== null && !options.access)
    conditions.push(inArray(schema.memoryEntries.scopeKey, [...scopeKeys]));
  if (options.afterId !== undefined) conditions.push(gt(schema.memoryEntries.id, options.afterId));
  if (options.id !== undefined) conditions.push(eq(schema.memoryEntries.id, options.id));
  const rows = orm
    .select({
      ...getTableColumns(schema.memoryEntries),
      // Reject oversized damaged rows without materializing their body in JavaScript.
      body: sql<string>`CASE WHEN length(CAST(${schema.memoryEntries.body} AS BLOB)) <= 64000 THEN ${schema.memoryEntries.body} ELSE '' END`,
      bodyBytes: sql<number>`length(CAST(${schema.memoryEntries.body} AS BLOB))`,
    })
    .from(schema.memoryEntries)
    .where(and(...conditions))
    .orderBy(asc(schema.memoryEntries.id))
    .limit(limit)
    .all();
  const last = rows.at(-1)?.id;
  const hasMore =
    last !== undefined &&
    orm
      .select({ id: schema.memoryEntries.id })
      .from(schema.memoryEntries)
      .where(and(...conditions, gt(schema.memoryEntries.id, last)))
      .orderBy(asc(schema.memoryEntries.id))
      .limit(1)
      .get() !== undefined;
  const bounded = rows.filter((row) => row.bodyBytes <= 64000 && row.body.length <= 16000);
  const runtime = options.access ? runtimeMemoryRows(orm, options.access, bounded) : undefined;
  const valid =
    runtime?.rows ??
    validMemoryRows(orm, agentId, scopeKeys, bounded, undefined, options.sessionId);
  const itemBatch = loadMemoryItems(orm, valid);
  return {
    items: valid.map((row) => ({
      item: asMemoryItem(orm, row, options.id !== undefined, itemBatch.get(row.id)),
      searchText: [...row.body].slice(0, 4096).join(""),
      ...(runtime?.refs.get(row.id) ? { accessRef: runtime.refs.get(row.id) } : {}),
    })),
    scannedIds: rows.map((row) => row.id),
    hasMore,
  };
}

export function rankedMemoryCandidates(
  orm: Orm,
  agentId: string,
  scopeKeys: MemoryScopeKeys,
  options: {
    sessionId?: string;
    access?: MemoryConversationAccess;
    terms: string[];
    limit: number;
    after?: { score: number; id: string };
  },
): {
  repairNeeded: boolean;
  items: Array<{
    item: MemoryItem;
    score: number;
    accessRef?: import("../../shared/contracts/evidence").SourceRef;
  }>;
  positions: Array<{ id: string; score: number }>;
  hasMore: boolean;
} {
  if (options.sessionId) ownedSession(orm, agentId, options.sessionId);
  const e = schema.memoryEntries;
  const conditions = [
    options.access ? runtimeCandidateCondition(options.access) : eq(e.agentId, agentId),
    eq(e.userId, DEFAULT_USER_ID),
    eq(e.status, "active"),
  ];
  if (scopeKeys !== null && !options.access) conditions.push(inArray(e.scopeKey, [...scopeKeys]));
  if (options.sessionId && !options.access) {
    const sessionId = options.sessionId;
    conditions.push(
      sql`exists (select 1 from memory_sources ms join turns t on t.id=ms.turn_id where ms.memory_id=${e.id} and t.session_id=${sessionId})`,
    );
    conditions.push(
      sql`not exists (select 1 from memory_sources ms left join turns t on t.id=ms.turn_id where ms.memory_id=${e.id} and (t.id is null or t.session_id<>${sessionId}))`,
    );
    conditions.push(
      sql`not exists (select 1 from qq_memory_sources qs where qs.memory_id=${e.id})`,
    );
  }
  const invalid = sql.raw(`(${MEMORY_SEARCH_INVALID_LAYOUT_SQL})`);
  const limit = Math.min(300, Math.max(1, Math.trunc(options.limit)));
  const projection = {
    ...getTableColumns(e),
    body: sql<string>`CASE WHEN length(CAST(${e.body} AS BLOB)) <= 64000 THEN ${e.body} ELSE '' END`,
    bodyBytes: sql<number>`length(CAST(${e.body} AS BLOB))`,
  };
  const missing = orm
    .select(projection)
    .from(e)
    .where(and(...conditions, invalid))
    .orderBy(asc(e.id))
    .limit(limit + 1)
    .all();
  const checkable = missing
    .slice(0, limit)
    .filter((row) => row.bodyBytes <= 64000 && row.body.length <= 16000);
  if (
    (options.access
      ? runtimeMemoryRows(orm, options.access, checkable).rows.length
      : validMemoryRows(orm, agentId, scopeKeys, checkable, undefined, options.sessionId).length) ||
    missing.length > limit
  )
    return { repairNeeded: true, items: [], positions: [], hasMore: false };
  const parts = options.terms.map(
    (term) =>
      sql`case when json_valid(${e.foldedSearch}) then case when exists (select 1 from json_each(${e.foldedSearch}) f where instr(f.value, ${term}) > 0) then 1 else 0 end else 0 end`,
  );
  const score = sql<number>`(${sql.join(parts, sql` + `)})`;
  // FTS is only a necessary candidate set; exact field scores and all source checks remain below.
  // Any unsupported term takes the original scan for the entire query.
  const eligibleTerms =
    options.terms.length > 0 &&
    options.terms.every(
      (term) =>
        [...term].length >= 3 &&
        !term.includes("\0") &&
        !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(term),
    );
  if (eligibleTerms) {
    const db = (orm as Orm & { $client: import("bun:sqlite").Database }).$client;
    const counts = db
      .query(`SELECT
      (SELECT count(*) FROM memory_entries) AS entries,
      (SELECT count(*) FROM memory_search_index_ids) AS mappings,
      (SELECT count(*) FROM memory_search_fts_docsize) AS indexed,
      (SELECT count(*) FROM memory_entries WHERE ${MEMORY_SEARCH_INVALID_LAYOUT_SQL}) AS invalid`)
      .get() as {
      entries: number;
      mappings: number;
      indexed: number;
      invalid: number;
    };
    if (counts.entries === counts.mappings && counts.indexed === counts.entries - counts.invalid) {
      const ftsQuery = options.terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ");
      conditions.push(sql`${e.id} IN (
        SELECT ids.memory_id FROM memory_search_fts
        JOIN memory_search_index_ids ids ON ids.index_id = memory_search_fts.rowid
        WHERE memory_search_fts MATCH ${ftsQuery}
      )`);
    }
  }
  conditions.push(sql`${score} > 0`);
  if (options.after)
    conditions.push(
      or(
        sql`${score} < ${options.after.score}`,
        and(sql`${score} = ${options.after.score}`, gt(e.id, options.after.id)),
      )!,
    );
  const rows = orm
    .select({ ...projection, score })
    .from(e)
    .where(and(...conditions))
    .orderBy(desc(score), asc(e.id))
    .limit(limit + 1)
    .all();
  const scanned = rows.slice(0, limit);
  const bounded = scanned.filter((row) => row.bodyBytes <= 64000 && row.body.length <= 16000);
  const runtime = options.access ? runtimeMemoryRows(orm, options.access, bounded) : undefined;
  const valid =
    runtime?.rows ??
    validMemoryRows(orm, agentId, scopeKeys, bounded, undefined, options.sessionId);
  if (valid.some((row) => row.foldedSearch !== memorySearchProjection(row)))
    return { repairNeeded: true, items: [], positions: [], hasMore: false };
  const loaded = loadMemoryItems(orm, valid);
  const scores = new Map(scanned.map((row) => [row.id, row.score]));
  return {
    repairNeeded: false,
    items: valid.map((row) => ({
      item: asMemoryItem(orm, row, false, loaded.get(row.id)),
      score: scores.get(row.id) ?? 0,
      ...(runtime?.refs.get(row.id) ? { accessRef: runtime.refs.get(row.id) } : {}),
    })),
    positions: scanned.map((row) => ({ id: row.id, score: row.score })),
    hasMore: rows.length > limit,
  };
}

export function readMemoryCandidate(
  orm: Orm,
  agentId: string,
  scopeKeys: MemoryScopeKeys,
  id: string,
  sessionId?: string,
  access?: MemoryConversationAccess,
): MemoryItem {
  const item = scanMemoryCandidates(orm, agentId, scopeKeys, { id, sessionId, limit: 1, access })
    .items[0]?.item;
  if (!item) contextFail("已选记忆的权限、状态或来源已变化");
  return item;
}

export function catalog(
  orm: Orm,
  agentId: string,
  sessionId: string,
  options: {
    keywords?: string[];
    limit?: number;
    afterId?: string | null;
    allEntries?: boolean;
    scopeKeys?: MemoryScopeKeys;
  } = {},
): MemoryItem[] {
  sessionScope(orm, agentId, sessionId);
  return catalogByScopeKeys(orm, agentId, options.scopeKeys ?? null, {
    ...options,
    limit: options.limit ?? 30,
    withBody: false,
  });
}

export function catalogByScopeKeys(
  orm: Orm,
  agentId: string,
  scopeKeys: MemoryScopeKeys,
  options: {
    keywords?: string[];
    limit?: number;
    afterId?: string | null;
    allEntries?: boolean;
    withBody?: boolean;
  } = {},
): MemoryItem[] {
  const limit = options.limit ?? 10;
  let rows = validMemoryRows(orm, agentId, scopeKeys);
  const afterId = options.afterId;
  if (afterId !== undefined && afterId !== null) {
    rows = rows.filter((row) => row.id > afterId);
  }
  if (options.allEntries) {
    rows.sort((a, b) => a.id.localeCompare(b.id));
  } else if ((options.keywords ?? []).length > 0) {
    const words = (options.keywords ?? []).map(fullCasefold);
    const score = (row: (typeof rows)[number]) => {
      const name = fullCasefold(row.name);
      const summary = fullCasefold(row.summary);
      const body = fullCasefold(row.body);
      return words.reduce(
        (sum, word) =>
          sum + Number(name.includes(word) || summary.includes(word) || body.includes(word)),
        0,
      );
    };
    rows = rows
      .map((row) => ({ row, score: score(row) }))
      .sort(
        (a, b) =>
          b.score - a.score ||
          b.row.createdAt.localeCompare(a.row.createdAt) ||
          a.row.id.localeCompare(b.row.id),
      )
      .map(({ row }) => row);
  } else {
    rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  }
  const selected = rows.slice(0, limit);
  const itemBatch = loadMemoryItems(orm, selected);
  return selected.map((row) =>
    asMemoryItem(orm, row, options.withBody ?? true, itemBatch.get(row.id)),
  );
}

/**
 * Fingerprint metadata only, never bodies. The read scope is part of the digest,
 * so a scope change during a full-catalog scan invalidates the scan.
 */
export function catalogFingerprint(
  orm: Orm,
  agentId: string,
  sessionId: string,
  scopeKeys?: MemoryScopeKeys,
): string {
  sessionScope(orm, agentId, sessionId);
  return memoryFingerprintByScopeKeys(orm, agentId, scopeKeys ?? null);
}

export function memoryFingerprintByScopeKeys(
  orm: Orm,
  agentId: string,
  scopeKeys: MemoryScopeKeys,
): string {
  const digest = createHash("sha256");
  digest.update(`${agentId}:${AGENT_LEVEL_SCOPE_KEY}`);
  digest.update(`:${!Array.isArray(scopeKeys) ? "agent" : JSON.stringify(scopeKeys)}`);
  for (const row of validMemoryRows(orm, agentId, scopeKeys).sort((a, b) =>
    a.id.localeCompare(b.id),
  )) {
    digest.update(
      JSON.stringify([
        row.id,
        row.name,
        row.summary,
        parseStringArray(row.tags),
        row.createdAt,
        row.status,
      ]),
    );
    digest.update("\n");
  }
  return digest.digest("hex");
}

export function memoryBodies(
  orm: Orm,
  agentId: string,
  sessionId: string,
  ids: string[],
  scopeKeys?: MemoryScopeKeys,
): MemoryItem[] {
  sessionScope(orm, agentId, sessionId);
  return memoryBodiesByScopeKeys(orm, agentId, ids, scopeKeys ?? null);
}

export function memoryAccessRefs(
  orm: Orm,
  access: MemoryConversationAccess,
  ids: readonly string[],
): ReadonlyMap<string, import("../../shared/contracts/evidence").SourceRef> {
  const unique = [...new Set(ids)];
  if (!unique.length) return new Map();
  const rows: ReturnType<typeof entries> = [];
  for (let offset = 0; offset < unique.length; offset += 500) {
    const selected = orm
      .select({
        ...getTableColumns(schema.memoryEntries),
        body: sql<string>`CASE WHEN length(CAST(${schema.memoryEntries.body} AS BLOB)) <= 64000 THEN ${schema.memoryEntries.body} ELSE '' END`,
        bodyBytes: sql<number>`length(CAST(${schema.memoryEntries.body} AS BLOB))`,
      })
      .from(schema.memoryEntries)
      .where(
        and(
          inArray(schema.memoryEntries.id, unique.slice(offset, offset + 500)),
          eq(schema.memoryEntries.userId, access.userId),
          eq(schema.memoryEntries.status, "active"),
          runtimeCandidateCondition(access),
        ),
      )
      .all();
    rows.push(...selected.filter((row) => row.bodyBytes <= 64000 && row.body.length <= 16000));
  }
  const refs = new Map<string, import("../../shared/contracts/evidence").SourceRef>();
  for (let offset = 0; offset < rows.length; offset += 300) {
    for (const [id, ref] of runtimeMemoryRows(orm, access, rows.slice(offset, offset + 300)).refs)
      refs.set(id, ref);
  }
  return refs;
}

export function memoryRevisionsForSession(
  orm: Orm,
  agentId: string,
  sessionId: string,
  ids: string[],
): ReadonlyMap<string, string> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = validMemoryRows(orm, agentId, null, undefined, unique, sessionId);
  const valid = new Set(rows.map((row) => row.id));
  if (valid.size !== unique.length) return new Map();
  return new Map(rows.map((row) => [row.id, memoryRevision(row)]));
}

export function memoryBodiesByScopeKeys(
  orm: Orm,
  agentId: string,
  ids: string[],
  scopeKeys: MemoryScopeKeys,
): MemoryItem[] {
  const rows = validMemoryRows(orm, agentId, scopeKeys, undefined, ids);
  if (new Set(rows.map((row) => row.id)).size !== new Set(ids).size) {
    contextFail("已选记忆的权限、状态或来源已变化");
  }
  const itemBatch = loadMemoryItems(orm, rows);
  const indexed = new Map(
    rows.map((row) => [row.id, asMemoryItem(orm, row, true, itemBatch.get(row.id))]),
  );
  return ids.map((id) => {
    const item = indexed.get(id);
    if (!item) contextFail("已选记忆的权限、状态或来源已变化");
    return item;
  });
}

/** Reuse only summaries with complete valid sources. */
export function summaries(
  orm: Orm,
  agentId: string,
  sessionId: string,
  validTurns: ContextTurn[],
  retrievalEnabled = true,
): SummaryItem[] {
  ownedSession(orm, agentId, sessionId);
  const byTurn = new Map(validTurns.map((turn) => [turn.id, turn]));
  const rows = orm
    .select()
    .from(schema.sessionSummaries)
    .where(
      and(
        eq(schema.sessionSummaries.sessionId, sessionId),
        eq(schema.sessionSummaries.agentId, agentId),
        eq(schema.sessionSummaries.userId, DEFAULT_USER_ID),
        eq(schema.sessionSummaries.isValid, 1),
      ),
    )
    .orderBy(
      asc(schema.sessionSummaries.startSequenceNo),
      desc(schema.sessionSummaries.createdAt),
      asc(schema.sessionSummaries.id),
    )
    .all();
  // Same-call batched summary-source read; per-row order (sequenceNo asc) preserved.
  const sourcesBySummary = loadSummarySources(
    orm,
    rows.map((row) => row.id),
  );
  // Lazy, first-use-only correction scan: exactly the rows the pre-change loop
  // reached — an empty or all-invalid row set performs no correction read, and
  // `retrievalEnabled === false` never scans. No cross-call reuse.
  let correctionScan: CorrectionScan[] | null = null;
  const correctionsFor = (turnIds: string[]) => {
    if (!retrievalEnabled) return [];
    correctionScan ??= activeCorrections(orm, agentId);
    return correctionsForTurnsFrom(correctionScan, turnIds);
  };
  const result: SummaryItem[] = [];
  for (const row of rows) {
    const sources = sourcesBySummary.get(row.id) ?? [];
    if (sources.length === 0 || sources.length !== row.sourceCount) continue;
    const valid = sources.every((source) => {
      const turn = byTurn.get(source.turnId);
      return (
        turn !== undefined &&
        turn.userMessageId === source.userMessageId &&
        turn.assistantMessageId === source.assistantMessageId
      );
    });
    if (!valid) continue;
    const snapshot = JSON.parse(row.configSnapshot) as { memory_corrections?: unknown[] };
    const corrections = correctionsFor(sources.map((source) => source.turnId));
    if (JSON.stringify(snapshot.memory_corrections ?? []) !== JSON.stringify(corrections)) continue;
    result.push({
      id: row.id,
      content: JSON.parse(row.content) as SummaryContent,
      turnIds: sources.map((source) => source.turnId),
    });
  }
  return result;
}

/** Must run after the model call in a short write transaction. */
export function saveSummary(
  orm: Orm,
  agentId: string,
  sessionId: string,
  sourceTurns: ContextTurn[],
  content: SummaryContent,
  runtime: RuntimeConfig,
  estimatedTokens: number,
  currentTurnId: string,
  generationToken: string,
): SummaryItem {
  currentUser(orm, agentId, sessionId, currentTurnId, { generationToken });
  const fresh = history(
    orm,
    agentId,
    sessionId,
    Math.max(...sourceTurns.map((turn) => turn.sequenceNo)) + 1,
    sourceTurns.map((turn) => turn.id),
  );
  if (JSON.stringify(fresh) !== JSON.stringify(sourceTurns)) {
    contextFail("摘要生成期间来源已经变化");
  }
  const id = newId();
  orm
    .insert(schema.sessionSummaries)
    .values({
      id,
      sessionId,
      agentId,
      userId: DEFAULT_USER_ID,
      startSequenceNo: Math.min(...fresh.map((turn) => turn.sequenceNo)),
      endSequenceNo: Math.max(...fresh.map((turn) => turn.sequenceNo)),
      sourceCount: fresh.length,
      content: JSON.stringify(content),
      modelName: runtime.context_compression_model_name,
      configSnapshot: JSON.stringify({
        p5_config: runtime.p5_config,
        config_version: runtime.config_version,
        resolved_model_capacities: runtime.resolved_model_capacities,
        memory_corrections:
          runtime.p5_config.retrieval_mode === "off"
            ? []
            : correctionsForTurns(
                orm,
                agentId,
                fresh.map((turn) => turn.id),
              ),
      }),
      templateVersion: "p5-1",
      estimatedTokens,
      isValid: 1,
      invalidatedAt: null,
      invalidationReason: null,
      createdAt: nowIso(),
    })
    .run();
  for (const turn of fresh) {
    orm
      .insert(schema.summarySources)
      .values({
        summaryId: id,
        turnId: turn.id,
        userMessageId: turn.userMessageId,
        assistantMessageId: turn.assistantMessageId,
        sequenceNo: turn.sequenceNo,
      })
      .run();
  }
  return { id, content, turnIds: fresh.map((turn) => turn.id) };
}

export function systemPrompt(runtime: RuntimeConfig): ContextMessage[] {
  const prompt = compileSystemPrompt(runtime);
  return prompt ? [{ role: "system", content: prompt }] : [];
}
