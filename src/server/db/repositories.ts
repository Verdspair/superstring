// Session / Turn / Message repository — the lease + idempotency state machine.
// Why this module is synchronous
// A row-locking engine would rely on `SELECT … FOR UPDATE` inside a transaction.
// SQLite has no row locks, so this project uses SQLite's own writer
// lock instead: every mutating operation runs inside `BEGIN IMMEDIATE`, which
// takes the database-level write lock up front. Because bun:sqlite is
// synchronous, nothing can interleave between the reads and the writes inside
// the callback, so a read-modify-write sequence is atomic — the same guarantee
// a row lock provided for this single-writer local application.
// Contract that must not drift (api-contract.md §2)
// IDEMPOTENCY_KEY_RETIRED: turn.invalidation_reason == "message_deleted"
// or the Turn exists but its user message is gone.
// IDEMPOTENCY_CONFLICT: same client_request_id, different content.
// GENERATION_ALREADY_ACTIVE: the SAME turn is still active and leased.
// SESSION_GENERATION_BUSY: a DIFFERENT turn in the session is still leased.
// replay: assistant message already `completed` → return it
// without calling the model.
// Heartbeat returns "active" | "lost" | "cancelled" — never throws.
// Saving raises GENERATION_OWNERSHIP_LOST / GENERATION_CANCELLED and writes
// nothing in those cases.

import type { Database } from "bun:sqlite";
import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import type { RuntimeConfig } from "../../shared/contracts";
import { RuntimeConfigSchema } from "../../shared/contracts";
import {
  DEFAULT_MEMORY_CONSOLIDATION_PROMPT,
  DEFAULT_MEMORY_RETRIEVAL_PROMPT,
} from "../../shared/contracts/agent";
import { DatabaseError } from "../api/error-handler";
import {
  AppError,
  GenerationAlreadyActiveError,
  GenerationCancelledError,
  GenerationOwnershipLostError,
  IdempotencyConflictError,
  IdempotencyKeyRetiredError,
  isAppError,
  MessageDeleteForbiddenError,
  MessageNotFoundError,
  SessionGenerationBusyError,
  SessionNotFoundError,
} from "../errors";
import type { AgentRow } from "../services/runtime-config";
import {
  buildPrompt,
  type HistoryItem,
  requireChat,
  runtimeFromAgent,
} from "../services/runtime-config";
import { KnowledgeReadRepository } from "./knowledge-read-repository";
import { readOrganizationSettings } from "./organization-repository";
import * as schema from "./schema";
import { MessageRole, MessageStatus, type SqlBoolean, TurnGenerationStatus } from "./types";

export type Orm = BunSQLiteDatabase<typeof schema>;

/**
 * The underlying bun:sqlite handle, needed for explicit `BEGIN IMMEDIATE`
 * transactions. Drizzle's `BunSQLiteDatabase` exposes it at runtime as
 * `$client`; the public type omits it, so the cast is confined to this one
 * place instead of being scattered through every repository function.
 */
function clientOf(orm: Orm): Database {
  return (orm as unknown as { $client: Database }).$client;
}

export const DEFAULT_USER_ID = "00000000-0000-0000-0000-000000000001";
export const DEFAULT_AGENT_ID = "00000000-0000-0000-0000-000000000001";
export const DEFAULT_SYSTEM_PROMPT = "你是一个可靠、简洁的中文助手。";
export const DEFAULT_GENERATION_LEASE_SECONDS = 30;

export function newId(): string {
  return crypto.randomUUID();
}

/**
 * Current UTC time as an ISO-8601 string, with no timezone suffix.
 * Fidelity note: the column carries microsecond precision. JS
 * `Date` only exposes milliseconds, so the last three digits are always `000`.
 * Ordering never depends on these timestamps (message order is
 * `sequence_no`), and lease comparisons only need millisecond resolution.
 */
export function nowIso(): string {
  const d = new Date();
  const base = d.toISOString().slice(0, 19);
  return `${base}.${String(d.getMilliseconds()).padStart(3, "0")}000Z`;
}

function msFromIso(value: string): number {
  return new Date(value).getTime();
}

/**
 * A fixed-width timestamp `n` seconds ahead, in the same format as
 * `nowIso()`.
 */
export function nowIsoPlusSeconds(seconds: number): string {
  const d = new Date(Date.now() + seconds * 1000);
  const base = d.toISOString().slice(0, 19);
  return `${base}.${String(d.getMilliseconds()).padStart(3, "0")}000Z`;
}

/** True for a UNIQUE / PRIMARY KEY violation. */
export function isIntegrityError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /UNIQUE|PRIMARY KEY|SQLITE_CONSTRAINT/i.test(message);
}

/**
 * Normalise a storage-layer failure into the error `handleError` maps to 503
 * mirroring (any storage-layer error → `DATABASE_UNAVAILABLE`).
 * - `AppError` passes through unchanged (its own `status_code` must win — e.g.
 * the integrity→`AGENT_IN_USE`/`IDEMPOTENCY_CONFLICT` mappings below).
 * - A raw `bun:sqlite` `SqliteError` becomes a `DatabaseError`, so both
 * `handleError` and the marker-name checks (`direct-service.ts:250`
 * `sessions.ts:212`) treat it as a database outage.
 * - Any other (non-DB) error is left untouched, surfacing as a generic 500 the
 * same way an unhandled exception does in the contract.
 */
export function asDatabaseError(error: unknown): Error {
  if (isAppError(error)) return error as Error;
  const candidate = error as { name?: string; code?: string } | null;
  if (
    candidate?.name === "SQLiteError" ||
    candidate?.name === "SqliteError" ||
    candidate?.code?.startsWith("SQLITE_") === true
  ) {
    return new DatabaseError(error instanceof Error ? error.message : String(error), {
      cause: error,
    });
  }
  return error instanceof Error ? error : new Error(String(error));
}

/** Run `fn` inside `BEGIN IMMEDIATE` (see the module header for the rationale). */
export function immediate<T>(db: Database, fn: () => T): T {
  try {
    // Bun uses a SAVEPOINT when another transaction already owns the connection.
    // Channel commits can therefore include the original turn writes and the Agent journal.
    return db.transaction(fn).immediate();
  } catch (error) {
    // A raw `bun:sqlite` error leaving the transaction must become a
    // `DatabaseError` so `handleError` downgrades it to DATABASE_UNAVAILABLE
    // (503) instead of a generic 500. `AppError`s keep their own status.
    throw asDatabaseError(error);
  }
}

export interface TurnPreparation {
  runtime: RuntimeConfig;
  messageId: string;
  replay: boolean;
  generationToken: string | null;
}

export interface MessageDeletionResult {
  messageId: string;
  turnId: string;
  sequenceNo: number;
  role: string;
  contextInvalidated: boolean;
  sourceInvalidated: boolean;
  repeated: boolean;
}

// Agent reads (needed by session creation and runtime resolution)

export function getAgentRow(orm: Orm, agentId: string): AgentRow | null {
  const row = orm.select().from(schema.agents).where(eq(schema.agents.id, agentId)).get();
  if (!row) return null;
  return row as AgentRow;
}

/** agent_repository.get_agent. */
export function getAgent(orm: Orm, agentId: string): AgentRow {
  const row = getAgentRow(orm, agentId);
  if (!row) throw new AppError("AGENT_NOT_FOUND", "Agent 不存在", 404);
  return row;
}

// Defaults

/** Idempotent; safe to call on every entry point. */
export function ensureDefaults(orm: Orm, modelName: string): void {
  const user = orm.select().from(schema.users).where(eq(schema.users.id, DEFAULT_USER_ID)).get();
  if (!user) {
    orm
      .insert(schema.users)
      .values({ id: DEFAULT_USER_ID, name: "本地用户", createdAt: nowIso() })
      .run();
  }

  let agent = orm.select().from(schema.agents).where(eq(schema.agents.id, DEFAULT_AGENT_ID)).get();
  if (!agent) {
    const now = nowIso();
    orm
      .insert(schema.agents)
      .values({
        id: DEFAULT_AGENT_ID,
        name: "本地助手",
        systemPrompt: DEFAULT_SYSTEM_PROMPT,
        description: "",
        additionalInstructions: "",
        p5Config: "{}",
        modelName,
        temperature: 0.7,
        memoryConsolidationModelName: null,
        memoryConsolidationPrompt: DEFAULT_MEMORY_CONSOLIDATION_PROMPT,
        memoryConsolidationAdditionalInstructions: "",
        memoryRetrievalModelName: null,
        memoryRetrievalPrompt: DEFAULT_MEMORY_RETRIEVAL_PROMPT,
        contextCompressionModelName: null,
        personaIntensity: 60,
        isActive: 1,
        configVersion: 1,
        updatedAt: now,
        createdAt: now,
      })
      .run();
    orm.insert(schema.agentKnowledgeReadSettings).values({ agentId: DEFAULT_AGENT_ID }).run();
    agent = orm.select().from(schema.agents).where(eq(schema.agents.id, DEFAULT_AGENT_ID)).get();
  }

  const persona = orm
    .select()
    .from(schema.agentPersonas)
    .where(eq(schema.agentPersonas.agentId, DEFAULT_AGENT_ID))
    .get();
  if (!persona) {
    const now = nowIso();
    orm
      .insert(schema.agentPersonas)
      .values({
        id: newId(),
        agentId: DEFAULT_AGENT_ID,
        coreIdentity: agent?.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
        communicationStyle: "",
        interactionBoundaries: "",
        exampleDialogues: "",
        advancedInstructions: "",
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }
}

// Sessions

export type SessionRow = typeof schema.sessions.$inferSelect;

export function createSession(
  orm: Orm,
  title: string,
  options: {
    agentId?: string | null;
    mode?: string;
    clientRequestId?: string | null;
    modelName?: string;
  } = {},
): SessionRow {
  const mode = options.mode ?? "chat";
  requireChat(mode);
  const db = clientOf(orm);

  return immediate(db, () => {
    ensureDefaults(orm, options.modelName ?? "");
    const requestId = options.clientRequestId || `server-${newId()}`;
    const targetAgentId = options.agentId || DEFAULT_AGENT_ID;

    const existing = orm
      .select()
      .from(schema.sessions)
      .where(
        and(
          eq(schema.sessions.userId, DEFAULT_USER_ID),
          eq(schema.sessions.clientRequestId, requestId),
        ),
      )
      .get();
    if (existing) {
      if (
        existing.title !== title ||
        existing.agentId !== targetAgentId ||
        existing.mode !== mode
      ) {
        throw new IdempotencyConflictError();
      }
      return existing;
    }

    const agentRow = getAgentRow(orm, targetAgentId);
    if (!agentRow) throw new AppError("AGENT_NOT_FOUND", "Agent 不存在", 404);
    if (!agentRow.isActive) {
      throw new AppError("AGENT_DISABLED", "Agent 已停用，请选择其他 Agent", 409);
    }
    const persona = orm
      .select()
      .from(schema.agentPersonas)
      .where(eq(schema.agentPersonas.agentId, agentRow.id))
      .get();
    if (!persona) {
      throw new AppError(
        "PERSONA_NOT_FOUND",
        "Agent 尚未建立人设与性格，请检查迁移或恢复备份",
        409,
      );
    }

    const snapshot = runtimeFromAgent(agentRow, {
      organizationModel: readOrganizationSettings(orm).model_name,
      mode,
      persona: {
        core_identity: persona.coreIdentity,
        communication_style: persona.communicationStyle,
        interaction_boundaries: persona.interactionBoundaries,
        example_dialogues: persona.exampleDialogues,
        advanced_instructions: persona.advancedInstructions,
      },
      personaIntensity: agentRow.personaIntensity,
    });

    const now = nowIso();
    try {
      orm
        .insert(schema.sessions)
        .values({
          id: newId(),
          userId: DEFAULT_USER_ID,
          agentId: agentRow.id,
          title,
          mode,
          clientRequestId: requestId,
          agentConfigSnapshot: JSON.stringify(snapshot),
          configVersion: agentRow.configVersion,
          nextSequenceNo: 1,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    } catch (error) {
      if (!isIntegrityError(error)) throw asDatabaseError(error);
      const raced = orm
        .select()
        .from(schema.sessions)
        .where(
          and(
            eq(schema.sessions.userId, DEFAULT_USER_ID),
            eq(schema.sessions.clientRequestId, requestId),
          ),
        )
        .get();
      if (!raced) throw error;
      if (raced.title !== title || raced.agentId !== agentRow.id || raced.mode !== mode) {
        throw new IdempotencyConflictError();
      }
      return raced;
    }

    const created = orm
      .select()
      .from(schema.sessions)
      .where(
        and(
          eq(schema.sessions.userId, DEFAULT_USER_ID),
          eq(schema.sessions.clientRequestId, requestId),
        ),
      )
      .get();
    if (!created) throw new Error("session insert could not be read back");
    return created;
  });
}

export function getSession(orm: Orm, sessionId: string): SessionRow {
  const row = orm.select().from(schema.sessions).where(eq(schema.sessions.id, sessionId)).get();
  if (!row) throw new SessionNotFoundError();
  return row;
}

/** updated_at desc, then id desc. */
export function listSessions(orm: Orm): SessionRow[] {
  return orm
    .select()
    .from(schema.sessions)
    .orderBy(desc(schema.sessions.updatedAt), desc(schema.sessions.id))
    .all();
}

export function deleteSession(orm: Orm, sessionId: string): SessionRow {
  const db = clientOf(orm);
  return immediate(db, () => {
    const item = getSession(orm, sessionId);
    // Locking the agent row explicitly is unnecessary; BEGIN IMMEDIATE already serialises.
    getAgent(orm, item.agentId);
    const turnIds = orm
      .select({ id: schema.turns.id })
      .from(schema.turns)
      .where(eq(schema.turns.sessionId, sessionId))
      .all()
      .map((r) => r.id);
    invalidateTurnsForMemory(orm, item.agentId, turnIds);
    invalidateTurnsForSummaries(orm, turnIds);
    orm.delete(schema.sessions).where(eq(schema.sessions.id, sessionId)).run();
    return item;
  });
}

export function renameSession(orm: Orm, sessionId: string, title: string): SessionRow {
  const db = clientOf(orm);
  return immediate(db, () => {
    const item = getSession(orm, sessionId);
    orm
      .update(schema.sessions)
      .set({ title, updatedAt: nowIso() })
      .where(eq(schema.sessions.id, sessionId))
      .run();
    return { ...item, title };
  });
}

// Derivation invalidation (memory + summaries)

/** memory_repository.invalidate_turns. */
export function invalidateTurnsForMemory(orm: Orm, agentId: string, turnIds: string[]): void {
  if (turnIds.length === 0) return;

  const policy = orm
    .select()
    .from(schema.memoryPolicies)
    .where(eq(schema.memoryPolicies.agentId, agentId))
    .get();
  if (policy) {
    orm
      .update(schema.memoryPolicies)
      .set({ governanceEpoch: policy.governanceEpoch + 1 })
      .where(eq(schema.memoryPolicies.agentId, agentId))
      .run();
  }

  const affected = orm
    .select({ memoryId: schema.memorySources.memoryId })
    .from(schema.memorySources)
    .where(inArray(schema.memorySources.turnId, turnIds))
    .all()
    .map((r) => r.memoryId);
  if (affected.length > 0) {
    orm
      .update(schema.memoryEntries)
      .set({ status: "invalid" })
      .where(inArray(schema.memoryEntries.id, affected))
      .run();
  }

  orm
    .update(schema.memoryJobs)
    .set({
      status: "failed",
      errorCode: "MEMORY_SOURCE_INVALID",
      token: null,
      leaseExpiresAt: null,
      finishedAt: nowIso(),
    })
    .where(
      and(
        eq(schema.memoryJobs.agentId, agentId),
        inArray(schema.memoryJobs.status, ["queued", "running"]),
      ),
    )
    .run();
}

/** context_repository.invalidate_turns. */
export function invalidateTurnsForSummaries(orm: Orm, turnIds: string[]): void {
  if (turnIds.length === 0) return;
  const affected = orm
    .select({ summaryId: schema.summarySources.summaryId })
    .from(schema.summarySources)
    .where(inArray(schema.summarySources.turnId, turnIds))
    .all()
    .map((r) => r.summaryId);
  if (affected.length === 0) return;
  orm
    .update(schema.sessionSummaries)
    .set({
      isValid: 0,
      invalidatedAt: nowIso(),
      invalidationReason: "source_turn_invalidated",
    })
    .where(
      and(inArray(schema.sessionSummaries.id, affected), eq(schema.sessionSummaries.isValid, 1)),
    )
    .run();
}

// Messages

export type MessageRow = typeof schema.messages.$inferSelect;

export function getMessage(orm: Orm, sessionId: string, messageId: string): MessageRow {
  const row = orm
    .select()
    .from(schema.messages)
    .where(and(eq(schema.messages.id, messageId), eq(schema.messages.sessionId, sessionId)))
    .get();
  if (!row) throw new MessageNotFoundError();
  return row;
}

export function listMessages(
  orm: Orm,
  sessionId: string,
  options: { completedOnly?: boolean } = {},
): MessageRow[] {
  getSession(orm, sessionId);
  const conditions = [eq(schema.messages.sessionId, sessionId)];
  if (options.completedOnly) {
    conditions.push(eq(schema.messages.status, MessageStatus.Completed));
  }
  return orm
    .select()
    .from(schema.messages)
    .where(and(...conditions))
    .orderBy(asc(schema.messages.sequenceNo))
    .all();
}

export function deleteMessage(
  orm: Orm,
  sessionId: string,
  messageId: string,
  options: { reason?: string } = {},
): MessageDeletionResult {
  const reason = options.reason ?? "user_requested";
  const db = clientOf(orm);

  return immediate(db, () => {
    const sourceSession = getSession(orm, sessionId);
    getAgent(orm, sourceSession.agentId);

    const priorEvent = orm
      .select()
      .from(schema.messageDeletionEvents)
      .where(
        and(
          eq(schema.messageDeletionEvents.sessionId, sessionId),
          eq(schema.messageDeletionEvents.originalMessageId, messageId),
        ),
      )
      .get();
    if (priorEvent) return repeatedDeletion(priorEvent);

    const item = orm
      .select()
      .from(schema.messages)
      .where(and(eq(schema.messages.id, messageId), eq(schema.messages.sessionId, sessionId)))
      .get();
    if (!item) {
      const lateEvent = orm
        .select()
        .from(schema.messageDeletionEvents)
        .where(
          and(
            eq(schema.messageDeletionEvents.sessionId, sessionId),
            eq(schema.messageDeletionEvents.originalMessageId, messageId),
          ),
        )
        .get();
      if (lateEvent) return repeatedDeletion(lateEvent);
      throw new MessageNotFoundError();
    }
    if (item.role !== MessageRole.User && item.role !== MessageRole.Assistant) {
      throw new MessageDeleteForbiddenError();
    }

    const turn = orm.select().from(schema.turns).where(eq(schema.turns.id, item.turnId)).get();
    if (!turn) {
      throw new AppError("INVALID_MESSAGE_TURN", "消息轮次不存在，请检查迁移或恢复备份", 409);
    }

    const now = nowIso();
    const result: MessageDeletionResult = {
      messageId: item.id,
      turnId: turn.id,
      sequenceNo: item.sequenceNo,
      role: item.role,
      contextInvalidated: true,
      sourceInvalidated: true,
      repeated: false,
    };

    orm
      .insert(schema.messageDeletionEvents)
      .values({
        id: newId(),
        sessionId,
        turnId: turn.id,
        originalMessageId: item.id,
        originalSequenceNo: item.sequenceNo,
        role: item.role,
        deletedAt: now,
        reason,
      })
      .run();

    invalidateTurnsForMemory(orm, sourceSession.agentId, [turn.id]);
    invalidateTurnsForSummaries(orm, [turn.id]);

    orm
      .update(schema.turns)
      .set({
        contextValid: 0,
        sourceValid: 0,
        invalidatedAt: turn.invalidatedAt ?? now,
        invalidationReason: turn.invalidationReason ?? "message_deleted",
      })
      .where(eq(schema.turns.id, turn.id))
      .run();

    if (turn.generationStatus === TurnGenerationStatus.Active) {
      orm
        .update(schema.turns)
        .set({
          cancelRequested: 1,
          cancelRequestedAt: turn.cancelRequestedAt ?? now,
          generationStatus: TurnGenerationStatus.Cancelled,
          leaseExpiresAt: null,
        })
        .where(eq(schema.turns.id, turn.id))
        .run();

      const assistant = orm
        .select()
        .from(schema.messages)
        .where(
          and(
            eq(schema.messages.turnId, turn.id),
            eq(schema.messages.role, MessageRole.Assistant),
            ne(schema.messages.id, item.id),
          ),
        )
        .get();
      if (assistant) {
        orm
          .update(schema.messages)
          .set({
            status: MessageStatus.Cancelled,
            errorCode: "GENERATION_CANCELLED",
            completedAt: null,
          })
          .where(eq(schema.messages.id, assistant.id))
          .run();
      }
    }

    orm.delete(schema.messages).where(eq(schema.messages.id, item.id)).run();

    return result;
  });
}

function repeatedDeletion(
  event: typeof schema.messageDeletionEvents.$inferSelect,
): MessageDeletionResult {
  return {
    messageId: event.originalMessageId,
    turnId: event.turnId,
    sequenceNo: event.originalSequenceNo,
    role: event.role,
    contextInvalidated: true,
    sourceInvalidated: true,
    repeated: true,
  };
}

// Turn lookup helpers

export type TurnRow = typeof schema.turns.$inferSelect;

export function getTurnByRequest(
  orm: Orm,
  sessionId: string,
  clientRequestId: string,
): TurnRow | null {
  return (
    orm
      .select()
      .from(schema.turns)
      .where(
        and(
          eq(schema.turns.sessionId, sessionId),
          eq(schema.turns.clientRequestId, clientRequestId),
        ),
      )
      .get() ?? null
  );
}

export function getMessageByRequest(
  orm: Orm,
  sessionId: string,
  clientRequestId: string,
  role: string,
): MessageRow | null {
  const row = orm
    .select({ message: schema.messages })
    .from(schema.messages)
    .innerJoin(schema.turns, eq(schema.turns.id, schema.messages.turnId))
    .where(
      and(
        eq(schema.turns.sessionId, sessionId),
        eq(schema.turns.clientRequestId, clientRequestId),
        eq(schema.messages.role, role),
      ),
    )
    .get();
  return row?.message ?? null;
}

// Runtime resolution for a Turn

function runtimeFromTurn(turn: TurnRow, session: SessionRow): RuntimeConfig {
  // validate the snapshot and its binding.
  let raw: unknown;
  try {
    raw = JSON.parse(turn.runtimeConfigSnapshot);
  } catch {
    throw new AppError("INVALID_TURN_CONFIG", "轮次运行配置无效，请检查迁移或恢复备份", 409);
  }
  const candidate = raw as Record<string, unknown>;
  if (candidate.agent_id !== session.agentId || candidate.mode !== session.mode) {
    throw new AppError("INVALID_TURN_CONFIG", "轮次运行配置无效，请检查迁移或恢复备份", 409);
  }
  // 0013/0014 removed the Persona version binding; tolerate stale keys
  delete candidate.persona_version_id;
  delete candidate.persona_version;
  const result = RuntimeConfigSchema.safeParse(candidate);
  if (!result.success) {
    throw new AppError("INVALID_TURN_CONFIG", "轮次运行配置无效，请检查迁移或恢复备份", 409);
  }
  requireChat(result.data.mode);
  return result.data;
}

function runtimeFromPersona(orm: Orm, session: SessionRow): RuntimeConfig {
  // 475.
  const agentRow = getAgentRow(orm, session.agentId);
  const persona = orm
    .select()
    .from(schema.agentPersonas)
    .where(eq(schema.agentPersonas.agentId, session.agentId))
    .get();
  if (!agentRow || !persona) {
    throw new AppError(
      "INVALID_SESSION_CONFIG",
      "会话配置或人设与性格无效，请检查迁移或恢复备份",
      409,
    );
  }
  let runtime: RuntimeConfig;
  try {
    runtime = runtimeFromAgent(agentRow, {
      organizationModel: readOrganizationSettings(orm).model_name,
      mode: session.mode,
      persona: {
        core_identity: persona.coreIdentity,
        communication_style: persona.communicationStyle,
        interaction_boundaries: persona.interactionBoundaries,
        example_dialogues: persona.exampleDialogues,
        advanced_instructions: persona.advancedInstructions,
      },
      personaIntensity: agentRow.personaIntensity,
    });
  } catch {
    throw new AppError(
      "INVALID_SESSION_CONFIG",
      "会话配置或人设与性格无效，请检查迁移或恢复备份",
      409,
    );
  }
  requireChat(runtime.mode);
  return runtime;
}

export function getRuntimeConfig(orm: Orm, sessionId: string): RuntimeConfig {
  const session = getSession(orm, sessionId);
  return runtimeFromPersona(orm, session);
}

// prepare_turn / heartbeat / save

/**
 * the heart of the idempotency + lease contract.
 * Throws (never partially writes) for every rejection path in api-contract §2.
 */
export function prepareTurn(
  orm: Orm,
  sessionId: string,
  content: string,
  clientRequestId: string,
  options: { leaseSeconds?: number } = {},
): TurnPreparation {
  const leaseSeconds = options.leaseSeconds ?? DEFAULT_GENERATION_LEASE_SECONDS;
  const db = clientOf(orm);

  return immediate(db, () => {
    const chatSession = orm
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.id, sessionId))
      .get();
    if (!chatSession) throw new SessionNotFoundError();

    const now = nowIso();
    const nowMs = msFromIso(now);
    const leaseExpiresAt = new Date(nowMs + leaseSeconds * 1000).toISOString();
    const generationToken = newId();

    const turn = getTurnByRequest(orm, sessionId, clientRequestId);
    if (turn && turn.invalidationReason === "message_deleted") {
      throw new IdempotencyKeyRetiredError();
    }
    const runtime = turn
      ? runtimeFromTurn(turn, chatSession)
      : {
          ...runtimeFromPersona(orm, chatSession),
          knowledge_read: new KnowledgeReadRepository(db).freeze(chatSession.agentId),
        };

    const activeTurns = orm
      .select()
      .from(schema.turns)
      .where(
        and(
          eq(schema.turns.sessionId, sessionId),
          eq(schema.turns.generationStatus, TurnGenerationStatus.Active),
        ),
      )
      .all();

    for (const active of activeTurns) {
      const leased = active.leaseExpiresAt !== null && msFromIso(active.leaseExpiresAt) > nowMs;
      if (leased) {
        if (turn && active.id === turn.id) throw new GenerationAlreadyActiveError();
        throw new SessionGenerationBusyError();
      }
      if (turn && active.id === turn.id) continue;

      orm
        .update(schema.turns)
        .set({
          generationStatus: TurnGenerationStatus.Failed,
          generationToken: null,
          leaseExpiresAt: null,
          contextValid: 0,
          sourceValid: 0,
          invalidatedAt: active.invalidatedAt ?? now,
          invalidationReason: active.invalidationReason ?? "generation_lease_expired",
        })
        .where(eq(schema.turns.id, active.id))
        .run();

      const assistant = orm
        .select()
        .from(schema.messages)
        .where(
          and(
            eq(schema.messages.turnId, active.id),
            eq(schema.messages.role, MessageRole.Assistant),
          ),
        )
        .get();
      if (assistant && assistant.status === MessageStatus.Pending) {
        orm
          .update(schema.messages)
          .set({
            status: MessageStatus.Failed,
            errorCode: "GENERATION_LEASE_EXPIRED",
          })
          .where(eq(schema.messages.id, assistant.id))
          .run();
      }
    }

    if (turn) {
      const turnMessages = orm
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.turnId, turn.id))
        .orderBy(asc(schema.messages.sequenceNo))
        .all();
      const user = turnMessages.find((m) => m.role === MessageRole.User);
      let assistant = turnMessages.find((m) => m.role === MessageRole.Assistant);

      if (!user) throw new IdempotencyKeyRetiredError();
      if (user.content !== content) throw new IdempotencyConflictError();
      if (assistant && assistant.status === MessageStatus.Completed) {
        return {
          runtime,
          messageId: assistant.id,
          replay: true,
          generationToken: null,
        };
      }
      if (!assistant) {
        const nextSequence = chatSession.nextSequenceNo;
        orm
          .update(schema.sessions)
          .set({ nextSequenceNo: nextSequence + 1, updatedAt: now })
          .where(eq(schema.sessions.id, sessionId))
          .run();
        orm
          .insert(schema.messages)
          .values({
            id: newId(),
            sessionId,
            turnId: turn.id,
            sequenceNo: nextSequence,
            role: MessageRole.Assistant,
            content: "",
            status: MessageStatus.Pending,
            clientRequestId,
            createdAt: now,
          })
          .run();
      } else {
        orm
          .update(schema.messages)
          .set({
            content: "",
            status: MessageStatus.Pending,
            errorCode: null,
            completedAt: null,
          })
          .where(eq(schema.messages.id, assistant.id))
          .run();
        assistant = {
          ...assistant,
          content: "",
          status: MessageStatus.Pending,
        };
      }

      orm
        .update(schema.turns)
        .set({
          contextValid: 0,
          sourceValid: 0,
          invalidatedAt: null,
          invalidationReason: null,
          generationToken,
          generationStatus: TurnGenerationStatus.Active,
          leaseExpiresAt,
          cancelRequested: 0,
          cancelRequestedAt: null,
        })
        .where(eq(schema.turns.id, turn.id))
        .run();
      orm
        .update(schema.sessions)
        .set({ updatedAt: now })
        .where(eq(schema.sessions.id, sessionId))
        .run();

      const refreshed = orm
        .select({ id: schema.messages.id })
        .from(schema.messages)
        .where(
          and(eq(schema.messages.turnId, turn.id), eq(schema.messages.role, MessageRole.Assistant)),
        )
        .get();
      return {
        runtime,
        messageId: refreshed?.id ?? "",
        replay: false,
        generationToken,
      };
    }

    const nextSequence = chatSession.nextSequenceNo;
    orm
      .update(schema.sessions)
      .set({ nextSequenceNo: nextSequence + 2, updatedAt: now })
      .where(eq(schema.sessions.id, sessionId))
      .run();

    const turnId = newId();
    orm
      .insert(schema.turns)
      .values({
        id: turnId,
        sessionId,
        clientRequestId,
        runtimeConfigSnapshot: JSON.stringify(runtime),
        contextValid: 0,
        sourceValid: 0,
        generationToken,
        generationStatus: TurnGenerationStatus.Active,
        leaseExpiresAt,
        cancelRequested: 0,
        createdAt: now,
      })
      .run();

    const assistantId = newId();
    orm
      .insert(schema.messages)
      .values({
        id: newId(),
        sessionId,
        turnId,
        sequenceNo: nextSequence,
        role: MessageRole.User,
        content,
        status: MessageStatus.Completed,
        clientRequestId,
        createdAt: now,
        completedAt: now,
      })
      .run();
    orm
      .insert(schema.messages)
      .values({
        id: assistantId,
        sessionId,
        turnId,
        sequenceNo: nextSequence + 1,
        role: MessageRole.Assistant,
        content: "",
        status: MessageStatus.Pending,
        clientRequestId,
        createdAt: now,
      })
      .run();

    return { runtime, messageId: assistantId, replay: false, generationToken };
  });
}

/** Returns "active" | "lost" | "cancelled"; never throws. */
export function heartbeatGeneration(
  orm: Orm,
  sessionId: string,
  clientRequestId: string,
  generationToken: string,
  options: { leaseSeconds?: number } = {},
): "active" | "lost" | "cancelled" {
  const leaseSeconds = options.leaseSeconds ?? DEFAULT_GENERATION_LEASE_SECONDS;
  const db = clientOf(orm);

  return immediate(db, () => {
    const turn = getTurnByRequest(orm, sessionId, clientRequestId);
    if (!turn || turn.generationToken !== generationToken) return "lost" as const;
    if (turn.cancelRequested === 1 || turn.generationStatus === TurnGenerationStatus.Cancelled) {
      return "cancelled" as const;
    }
    if (turn.generationStatus !== TurnGenerationStatus.Active) return "lost" as const;
    orm
      .update(schema.turns)
      .set({
        leaseExpiresAt: new Date(Date.now() + leaseSeconds * 1000).toISOString(),
      })
      .where(eq(schema.turns.id, turn.id))
      .run();
    return "active" as const;
  });
}

export function saveCompletedAssistantMessage(
  orm: Orm,
  sessionId: string,
  content: string,
  clientRequestId: string,
  generationToken: string,
): MessageRow {
  return saveAssistantMessage(
    orm,
    sessionId,
    content,
    clientRequestId,
    generationToken,
    MessageStatus.Completed,
    null,
  );
}

export function saveFailedAssistantMessage(
  orm: Orm,
  sessionId: string,
  clientRequestId: string,
  errorCode: string,
  generationToken: string,
  options: { partialContent?: string } = {},
): MessageRow {
  const status =
    errorCode === "CLIENT_DISCONNECTED" || errorCode === "GENERATION_CANCELLED"
      ? MessageStatus.Cancelled
      : MessageStatus.Failed;
  return saveAssistantMessage(
    orm,
    sessionId,
    options.partialContent ?? "",
    clientRequestId,
    generationToken,
    status,
    errorCode,
  );
}

/** Raises rather than writing stale output. */
function saveAssistantMessage(
  orm: Orm,
  sessionId: string,
  content: string,
  clientRequestId: string,
  generationToken: string,
  status: string,
  errorCode: string | null,
): MessageRow {
  const db = clientOf(orm);

  return immediate(db, () => {
    const turn = getTurnByRequest(orm, sessionId, clientRequestId);
    if (!turn) throw new GenerationOwnershipLostError();

    const now = nowIso();
    const nowMs = msFromIso(now);
    if (turn.cancelRequested === 1 || turn.generationStatus === TurnGenerationStatus.Cancelled) {
      throw new GenerationCancelledError();
    }
    if (
      turn.generationToken !== generationToken ||
      turn.generationStatus !== TurnGenerationStatus.Active ||
      turn.leaseExpiresAt === null ||
      msFromIso(turn.leaseExpiresAt) <= nowMs
    ) {
      throw new GenerationOwnershipLostError();
    }

    const item = orm
      .select()
      .from(schema.messages)
      .where(
        and(eq(schema.messages.turnId, turn.id), eq(schema.messages.role, MessageRole.Assistant)),
      )
      .get();
    if (!item) throw new GenerationOwnershipLostError();

    orm
      .update(schema.messages)
      .set({
        // bun:sqlite string bindings discard a leading BOM; binding bytes preserves
        // the exact Unicode contract for completed and partial model output.
        content: sql`CAST(${Buffer.from(content, "utf8")} AS TEXT)`,
        status,
        errorCode,
        completedAt: status === MessageStatus.Completed ? now : null,
      })
      .where(eq(schema.messages.id, item.id))
      .run();

    const generationStatus =
      status === MessageStatus.Completed
        ? TurnGenerationStatus.Completed
        : status === MessageStatus.Cancelled
          ? TurnGenerationStatus.Cancelled
          : TurnGenerationStatus.Failed;

    orm
      .update(schema.turns)
      .set({
        generationStatus,
        ...(status === MessageStatus.Cancelled
          ? {
              cancelRequested: 1 as SqlBoolean,
              cancelRequestedAt: turn.cancelRequestedAt ?? now,
            }
          : {}),
        generationToken: null,
        leaseExpiresAt: null,
        contextValid: status === MessageStatus.Completed ? 1 : 0,
        sourceValid: status === MessageStatus.Completed ? 1 : 0,
        invalidatedAt: status === MessageStatus.Completed ? null : (turn.invalidatedAt ?? now),
        invalidationReason:
          status === MessageStatus.Completed ? null : (errorCode ?? "generation_failed"),
      })
      .where(eq(schema.turns.id, turn.id))
      .run();

    orm
      .update(schema.sessions)
      .set({ updatedAt: now })
      .where(eq(schema.sessions.id, sessionId))
      .run();

    const saved = orm.select().from(schema.messages).where(eq(schema.messages.id, item.id)).get();
    if (!saved) throw new Error("assistant message could not be read back");
    return saved;
  });
}

export function saveUserMessage(
  orm: Orm,
  sessionId: string,
  content: string,
  clientRequestId: string,
): MessageRow {
  prepareTurn(orm, sessionId, content, clientRequestId);
  const user = getMessageByRequest(orm, sessionId, clientRequestId, MessageRole.User);
  if (!user) throw new IdempotencyKeyRetiredError();
  return user;
}

// Chat context assembly

/**
 * assemble the prompt the model will see.
 * The `context_valid` filter is the whole point: a Turn whose context was
 * invalidated (its source message was deleted, or its summary was superseded)
 * must NOT be replayed to the model. The CURRENT turn's user message is always
 * included — it is the question being asked right now, even though its turn has
 * not yet been marked valid.
 */
export function getChatContext(
  orm: Orm,
  sessionId: string,
  options: { currentTurnId?: string | null; runtime?: RuntimeConfig } = {},
): Array<{ role: string; content: string }> {
  const runtime = options.runtime ?? getRuntimeConfig(orm, sessionId);
  const currentTurnId = options.currentTurnId ?? null;

  const rows = orm
    .select({
      role: schema.messages.role,
      content: schema.messages.content,
      status: schema.messages.status,
      contextValid: schema.turns.contextValid,
      turnId: schema.turns.id,
    })
    .from(schema.messages)
    .innerJoin(schema.turns, eq(schema.turns.id, schema.messages.turnId))
    .where(
      and(
        eq(schema.messages.sessionId, sessionId),
        eq(schema.messages.status, MessageStatus.Completed),
        currentTurnId === null
          ? eq(schema.turns.contextValid, 1)
          : or(
              eq(schema.turns.contextValid, 1),
              and(eq(schema.turns.id, currentTurnId), eq(schema.messages.role, MessageRole.User)),
            ),
      ),
    )
    .orderBy(asc(schema.messages.sequenceNo))
    .all();

  const history: HistoryItem[] = rows.map((row) => ({
    role: row.role,
    content: row.content,
    status: row.status,
    // The current turn counts as valid for its own user message.
    context_valid: row.contextValid === 1 || row.turnId === currentTurnId,
  }));

  return buildPrompt(runtime, history);
}

// Re-exported so callers do not need a second import for the common predicates.
export { and, eq, isNull, or, sql };
