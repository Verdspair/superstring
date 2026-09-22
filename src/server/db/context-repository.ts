// P5 context reads and segmented-summary persistence.
// all model calls live in ContextBuilder
// never in this repository. Callers own transaction boundaries.

import { createHash } from "node:crypto";
import { and, asc, desc, eq } from "drizzle-orm";
import type { ContentItem, RuntimeConfig } from "../../shared/contracts";
import { AppError } from "../errors";
import { AGENT_LEVEL_SCOPE_KEY } from "../services/memory-contract";
import { correctionMetadata } from "../services/memory-revision";
import { compileSystemPrompt } from "../services/runtime-config";
import { fullCasefold } from "../services/text";
import { correctionsForTurns, memoryRevision } from "./memory-content-repository";
import { entries, ownedSession, sessionScope, turns } from "./memory-repository";
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

function validMemoryRows(orm: Orm, agentId: string): ReturnType<typeof entries> {
  return entries(orm, agentId, undefined, { status: "active" }).filter((entry) => {
    const sources = orm
      .select()
      .from(schema.memorySources)
      .where(eq(schema.memorySources.memoryId, entry.id))
      .all();
    if (sources.length === 0) return false;
    return sources.every((source) => {
      const turn = orm.select().from(schema.turns).where(eq(schema.turns.id, source.turnId)).get();
      const session = turn
        ? orm.select().from(schema.sessions).where(eq(schema.sessions.id, turn.sessionId)).get()
        : undefined;
      const user = orm
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.id, source.userMessageId))
        .get();
      const assistant = orm
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.id, source.assistantMessageId))
        .get();
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
    });
  });
}

function parseStringArray(text: string): string[] {
  const value = JSON.parse(text) as unknown;
  return Array.isArray(value) ? value.map(String) : [];
}

function asMemoryItem(
  orm: Orm,
  row: ReturnType<typeof entries>[number],
  withBody = false,
): MemoryItem {
  // Called only for validMemoryRows; do not load original chat bodies for catalog formatting.
  const sources = orm
    .select()
    .from(schema.memorySources)
    .innerJoin(schema.turns, eq(schema.turns.id, schema.memorySources.turnId))
    .where(eq(schema.memorySources.memoryId, row.id))
    .all();
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
    sources: sources.map(({ memory_sources: source, turns: turn }) => ({
      type: "chat",
      turn_id: source.turnId,
      session_id: turn.sessionId,
      user_message_id: source.userMessageId,
      assistant_message_id: source.assistantMessageId,
      sequence_no: source.sequenceNo,
      valid: true,
    })),
    ...(withBody ? { body: row.body } : {}),
  };
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
  } = {},
): MemoryItem[] {
  sessionScope(orm, agentId, sessionId);
  const limit = options.limit ?? 30;
  let rows = validMemoryRows(orm, agentId);
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
  return rows.slice(0, limit).map((row) => asMemoryItem(orm, row));
}

/** Fingerprint metadata only, never bodies. */
export function catalogFingerprint(orm: Orm, agentId: string, sessionId: string): string {
  sessionScope(orm, agentId, sessionId);
  const digest = createHash("sha256");
  digest.update(`${agentId}:${AGENT_LEVEL_SCOPE_KEY}`);
  for (const row of validMemoryRows(orm, agentId).sort((a, b) => a.id.localeCompare(b.id))) {
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
): MemoryItem[] {
  sessionScope(orm, agentId, sessionId);
  const rows = validMemoryRows(orm, agentId).filter((row) => ids.includes(row.id));
  if (new Set(rows.map((row) => row.id)).size !== new Set(ids).size) {
    contextFail("已选记忆的权限、状态或来源已变化");
  }
  const indexed = new Map(rows.map((row) => [row.id, asMemoryItem(orm, row, true)]));
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
  const result: SummaryItem[] = [];
  for (const row of rows) {
    const sources = orm
      .select()
      .from(schema.summarySources)
      .where(eq(schema.summarySources.summaryId, row.id))
      .orderBy(asc(schema.summarySources.sequenceNo))
      .all();
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
    const corrections = retrievalEnabled
      ? correctionsForTurns(
          orm,
          agentId,
          sources.map((source) => source.turnId),
        )
      : [];
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
