// P5 context reads and segmented-summary persistence.
// all model calls live in ContextBuilder
// never in this repository. Callers own transaction boundaries.

import { createHash } from "node:crypto";
import { and, asc, desc, eq, getTableColumns, gt, inArray, sql } from "drizzle-orm";
import type { ContentItem, RuntimeConfig } from "../../shared/contracts";
import { AppError } from "../errors";
import { AGENT_LEVEL_SCOPE_KEY } from "../services/memory-contract";
import { correctionMetadata, isCorrectionRetired } from "../services/memory-revision";
import type { MemoryScopeKeys } from "../services/memory-scope";
import { qqConversationKey, qqMemoryScopeKey } from "../services/qq-binding-contract";
import { compileSystemPrompt } from "../services/runtime-config";
import { fullCasefold } from "../services/text";
import {
  activeCorrections,
  type CorrectionScan,
  correctionsForTurns,
  correctionsForTurnsFrom,
  memoryRevision,
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

function toContextTurn(row: ReturnType<typeof turns>[number]): ContextTurn {
  return {
    id: row.turn.id,
    sequenceNo: row.user.sequenceNo,
    userMessageId: row.user.id,
    assistantMessageId: row.assistant.id,
    user: row.user.content,
    assistant: row.assistant.content,
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
): ReturnType<typeof entries> {
  const rows = boundedRows ?? entries(orm, agentId, undefined, { status: "active", scopeKeys });
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
      if (intact.every(Boolean)) return true;
    }
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

/** Tool reads select at most 300 authorized rows BEFORE validating sources or hashing bodies.
 * Complete bodies are needed by memoryRevision: at most 16,000 UTF-16 units per row
 * (64,000 UTF-8 bytes guarded in SQL), hence at most 19,200,000 body bytes per scan.
 * Search scoring uses only a 4,096-code-point prefix; legacy readers remain separate.
 */
export function scanMemoryCandidates(
  orm: Orm,
  agentId: string,
  scopeKeys: MemoryScopeKeys,
  options: { afterId?: string; limit: number; sessionId?: string; id?: string },
): {
  items: Array<{ item: MemoryItem; searchText: string }>;
  scannedIds: string[];
  hasMore: boolean;
} {
  if (options.sessionId) ownedSession(orm, agentId, options.sessionId);
  const limit = Math.min(300, Math.max(1, Math.trunc(options.limit)));
  const conditions = [
    eq(schema.memoryEntries.agentId, agentId),
    eq(schema.memoryEntries.userId, DEFAULT_USER_ID),
    eq(schema.memoryEntries.status, "active"),
  ];
  if (scopeKeys !== null) conditions.push(inArray(schema.memoryEntries.scopeKey, [...scopeKeys]));
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
  const valid = validMemoryRows(
    orm,
    agentId,
    scopeKeys,
    rows.filter((row) => row.bodyBytes <= 64000 && row.body.length <= 16000),
  );
  const itemBatch = loadMemoryItems(orm, valid);
  return {
    items: valid.map((row) => ({
      item: asMemoryItem(orm, row, options.id !== undefined, itemBatch.get(row.id)),
      searchText: [...row.body].slice(0, 4096).join(""),
    })),
    scannedIds: rows.map((row) => row.id),
    hasMore,
  };
}

export function readMemoryCandidate(
  orm: Orm,
  agentId: string,
  scopeKeys: MemoryScopeKeys,
  id: string,
  sessionId?: string,
): MemoryItem {
  const item = scanMemoryCandidates(orm, agentId, scopeKeys, { id, sessionId, limit: 1 }).items[0]
    ?.item;
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
    rows.sort(
      (a, b) =>
        score(b) - score(a) || b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id),
    );
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

export function memoryBodiesByScopeKeys(
  orm: Orm,
  agentId: string,
  ids: string[],
  scopeKeys: MemoryScopeKeys,
): MemoryItem[] {
  const rows = validMemoryRows(orm, agentId, scopeKeys).filter((row) => ids.includes(row.id));
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
