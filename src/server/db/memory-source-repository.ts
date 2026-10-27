// Provenance lookup shared by recall, validation and governance.
//
// A memory has two possible kinds of evidence:
//   * `memory_sources` — a paired user/assistant turn (web conversations), and
//   * `qq_memory_sources` — a QQ conversation observation (a group member's message).
//
// A memory is reusable only while EVERY source it depends on is intact.
// Source provenance and destination scope are distinct; a destination label is
// not proof of source ownership or authorization.

import { createHash } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import type { ContentSource, MemoryAccessMetadata } from "../../shared/contracts";
import type { RunOwner } from "../../shared/contracts/agent-run";
import type { SourceAccess, SourceRef } from "../../shared/contracts/evidence";
import { fail } from "../errors";
import { correctionMetadata, memoryRevision } from "../services/memory-revision";
import { qqConversationKey, qqMemoryScopeKey } from "../services/qq-binding-contract";
import {
  qqBlockedJobScope,
  qqEntryPublicationSourcesBatch,
} from "../services/qq-memory-fact-input";
import type { Orm } from "./repositories";
import { DEFAULT_USER_ID } from "./repositories";
import * as schema from "./schema";

export type QqMemorySourceRow = typeof schema.qqMemorySources.$inferSelect;
export type QqEventRow = typeof schema.qqEvents.$inferSelect;

/**
 * The observation rows named by a job, re-validated against the job's own scope.
 *
 * Both halves matter: the row must still exist (a retention pass may not have
 * removed it — the reference is not cascading), and it must belong to the scope
 * the job is writing into. A job may therefore never cite another group's message,
 * even if a caller assembled the id list by hand.
 */
export function ownedObservations(
  orm: Orm,
  agentId: string,
  eventIds: string[],
  scopeKey: string,
): QqEventRow[] {
  const ids = [...new Set(eventIds)];
  if (ids.length === 0) return [];
  const rows = orm
    .select()
    .from(schema.qqEvents)
    .where(inArray(schema.qqEvents.eventKey, ids))
    .all();
  if (rows.length !== ids.length) {
    fail("MEMORY_SOURCE_INVALID", "观察来源不存在或已被清理");
  }
  for (const row of rows) {
    const scopeOfRow = qqMemoryScopeKey({
      kind: "qq",
      accountId: row.accountId,
      conversationKind: row.conversationKind as "group" | "private",
      peerId: row.peerId,
      agentId: row.agentId,
    });
    if (row.agentId !== agentId || scopeOfRow !== scopeKey) {
      fail("MEMORY_SOURCE_INVALID", "观察来源不属于本会话的记忆范围");
    }
  }
  return rows;
}

/** Provenance values for a memory backed by the given observations (no memory id yet). */
export function observationSourceRows(
  events: QqEventRow[],
  scopeKey: string,
): Array<Omit<typeof schema.qqMemorySources.$inferInsert, "memoryId">> {
  return events.map((event) => ({
    eventKey: event.eventKey,
    scopeKey,
    conversationKey: qqConversationKey({
      accountId: event.accountId,
      kind: event.conversationKind as "group" | "private",
      peerId: event.peerId,
    }),
    messageId: event.messageId,
    occurredAtSeconds: event.occurredAtSeconds,
    speakerKind: event.speakerKind,
    speakerId: event.speakerId,
  }));
}

/**
 * Batched source-integrity reads for the same-call validation loops in
 * context-repository.ts and memory-content-repository.ts.
 *
 * These maps replace the previous per-source single-row SELECTs with the SAME
 * projections, evaluated by the caller with the SAME predicates. They are
 * call-scoped: never persisted, never carried across requests. Rows are loaded
 * in variable-boundary chunks (SQLite host-parameter limit) without changing
 * results — a chunked IN returns the same row set as one unbounded IN.
 */
export interface TurnIntegrityRow {
  id: string;
  sessionId: string;
  sourceValid: number;
  contextValid: number;
  generationStatus: string;
}

export interface SessionIntegrityRow {
  id: string;
  agentId: string;
  userId: string;
  title: string;
}

export interface MessageIntegrityRow {
  id: string;
  turnId: string;
  sessionId: string;
  role: string;
  status: string;
  content: string;
}

/** SQLite host-parameter boundary; results are chunk-independent. */
function chunked<T>(items: T[], batch: (chunk: T[]) => void): void {
  for (let index = 0; index < items.length; index += 500) {
    batch(items.slice(index, index + 500));
  }
}

export function loadTurnIntegrity(orm: Orm, turnIds: string[]): Map<string, TurnIntegrityRow> {
  const map = new Map<string, TurnIntegrityRow>();
  const unique = [...new Set(turnIds)];
  chunked(unique, (chunk) => {
    for (const row of orm
      .select({
        id: schema.turns.id,
        sessionId: schema.turns.sessionId,
        sourceValid: schema.turns.sourceValid,
        contextValid: schema.turns.contextValid,
        generationStatus: schema.turns.generationStatus,
      })
      .from(schema.turns)
      .where(inArray(schema.turns.id, chunk))
      .all()) {
      map.set(row.id, row);
    }
  });
  return map;
}

export function loadSessionIntegrity(
  orm: Orm,
  sessionIds: string[],
): Map<string, SessionIntegrityRow> {
  const map = new Map<string, SessionIntegrityRow>();
  const unique = [...new Set(sessionIds)];
  chunked(unique, (chunk) => {
    for (const row of orm
      .select({
        id: schema.sessions.id,
        agentId: schema.sessions.agentId,
        userId: schema.sessions.userId,
        title: schema.sessions.title,
      })
      .from(schema.sessions)
      .where(inArray(schema.sessions.id, chunk))
      .all()) {
      map.set(row.id, row);
    }
  });
  return map;
}

export function loadMessageIntegrity(
  orm: Orm,
  messageIds: string[],
): Map<string, MessageIntegrityRow> {
  const map = new Map<string, MessageIntegrityRow>();
  const unique = [...new Set(messageIds)];
  chunked(unique, (chunk) => {
    for (const row of orm
      .select({
        id: schema.messages.id,
        turnId: schema.messages.turnId,
        sessionId: schema.messages.sessionId,
        role: schema.messages.role,
        status: schema.messages.status,
        content: schema.messages.content,
      })
      .from(schema.messages)
      .where(inArray(schema.messages.id, chunk))
      .all()) {
      map.set(row.id, row);
    }
  });
  return map;
}

/** Every observation dedup row named by the given event keys, keyed by eventKey. */
export function loadQqEvents(
  orm: Orm,
  eventKeys: string[],
): Map<string, typeof schema.qqEvents.$inferSelect> {
  const map = new Map<string, typeof schema.qqEvents.$inferSelect>();
  const unique = [...new Set(eventKeys)];
  chunked(unique, (chunk) => {
    for (const row of orm
      .select()
      .from(schema.qqEvents)
      .where(inArray(schema.qqEvents.eventKey, chunk))
      .all()) {
      map.set(row.eventKey, row);
    }
  });
  return map;
}

/** Every observation source of the given memories, grouped by memory id. */
export function observationSources(
  orm: Orm,
  memoryIds: string[],
): Map<string, QqMemorySourceRow[]> {
  const grouped = new Map<string, QqMemorySourceRow[]>();
  if (memoryIds.length === 0) return grouped;
  const rows = orm
    .select()
    .from(schema.qqMemorySources)
    .where(inArray(schema.qqMemorySources.memoryId, memoryIds))
    .all();
  for (const row of rows) {
    const list = grouped.get(row.memoryId);
    if (list) list.push(row);
    else grouped.set(row.memoryId, [row]);
  }
  return grouped;
}

/**
 * Intact means the dedup row still exists and still describes the same message,
 * time and speaker the memory recorded. A retention pass may not delete a
 * referenced `qq_events` row (the reference is not cascading), so a missing or
 * mismatched row here means corruption rather than ordinary expiry.
 */
export function observationSourcesIntact(orm: Orm, rows: QqMemorySourceRow[]): boolean {
  if (rows.length === 0) return false;
  return rows.every((row) => {
    const event = orm
      .select()
      .from(schema.qqEvents)
      .where(eq(schema.qqEvents.eventKey, row.eventKey))
      .get();
    return (
      event !== undefined &&
      event.messageId === row.messageId &&
      event.occurredAtSeconds === row.occurredAtSeconds &&
      event.speakerKind === row.speakerKind &&
      event.speakerId === row.speakerId
    );
  });
}

export function memoryPublicationSourceRevisions(
  orm: Orm,
  entries: readonly (typeof schema.memoryEntries.$inferSelect)[],
  contentRevisions: ReadonlyMap<string, string>,
  now: string,
): ReadonlyMap<string, string> {
  const unique = [...new Map(entries.map((entry) => [entry.id, entry])).values()];
  const webById = new Map<string, (typeof schema.memorySources.$inferSelect)[]>();
  const qqById = new Map<string, QqMemorySourceRow[]>();
  chunked(
    unique.map((entry) => entry.id),
    (ids) => {
      for (const source of orm
        .select()
        .from(schema.memorySources)
        .where(inArray(schema.memorySources.memoryId, ids))
        .all()) {
        const list = webById.get(source.memoryId) ?? [];
        list.push(source);
        webById.set(source.memoryId, list);
      }
      for (const [id, rows] of observationSources(orm, ids)) qqById.set(id, rows);
    },
  );
  const web = [...webById.values()].flat();
  const turns = loadTurnIntegrity(
    orm,
    web.map((source) => source.turnId),
  );
  const sessions = loadSessionIntegrity(
    orm,
    [...turns.values()].map((turn) => turn.sessionId),
  );
  const messages = loadMessageIntegrity(
    orm,
    web.flatMap((source) => [source.userMessageId, source.assistantMessageId]),
  );
  const db = (orm as Orm & { $client: import("bun:sqlite").Database }).$client;
  const qqProof = qqEntryPublicationSourcesBatch({
    db,
    orm,
    now,
    entries: unique.map((entry) => ({
      id: entry.id,
      agentId: entry.agentId,
      sources: qqById.get(entry.id) ?? [],
    })),
  });
  const result = new Map<string, string>();
  for (const entry of unique) {
    const sources = webById.get(entry.id) ?? [];
    const qq = qqById.get(entry.id) ?? [];
    const qqParts = qqProof.get(entry.id);
    if (sources.length + qq.length === 0 || !qqParts) continue;
    const proof: unknown[] = [...qqParts];
    let valid = true;
    for (const source of sources) {
      const turn = turns.get(source.turnId);
      const session = turn && sessions.get(turn.sessionId);
      const user = messages.get(source.userMessageId);
      const assistant = messages.get(source.assistantMessageId);
      if (
        !turn ||
        !session ||
        session.agentId !== entry.agentId ||
        session.userId !== entry.userId ||
        turn.sourceValid !== 1 ||
        turn.generationStatus !== "completed" ||
        !user ||
        user.turnId !== turn.id ||
        user.sessionId !== session.id ||
        user.role !== "user" ||
        user.status !== "completed" ||
        !assistant ||
        assistant.turnId !== turn.id ||
        assistant.sessionId !== session.id ||
        assistant.role !== "assistant" ||
        assistant.status !== "completed"
      ) {
        valid = false;
        break;
      }
      proof.push([
        "web",
        source.turnId,
        session.id,
        source.userMessageId,
        source.assistantMessageId,
        source.sequenceNo,
        user.content,
        assistant.content,
      ]);
    }
    if (!valid) continue;
    const ordered = proof.map((item) => JSON.stringify(item)).sort();
    const contentRevision = contentRevisions.get(entry.id);
    if (contentRevision === undefined) continue;
    result.set(
      entry.id,
      createHash("sha256")
        .update(JSON.stringify(["memory-publication-v1", entry.id, contentRevision, ordered]))
        .digest("hex"),
    );
  }
  return result;
}

export interface MergeSourceSet {
  readonly turnIds: readonly string[];
  readonly eventKeys: readonly string[];
}

/** Explicit merge parents define the maintenance source set, never all Agent private rows. */
export function mergeJobSourceSet(
  orm: Orm,
  jobId: string,
  agentId: string,
  now: string,
): MergeSourceSet | null {
  const db = (orm as Orm & { $client: import("bun:sqlite").Database }).$client;
  const job = db
    .query("SELECT agent_id,user_id,kind,memory_ids FROM memory_jobs WHERE id=?")
    .get(jobId) as { agent_id: string; user_id: string; kind: string; memory_ids: string } | null;
  if (!job || job.kind !== "merge" || job.agent_id !== agentId || job.user_id !== DEFAULT_USER_ID)
    return null;
  let ids: string[];
  try {
    const parsed: unknown = JSON.parse(job.memory_ids);
    if (!Array.isArray(parsed) || !parsed.length || !parsed.every((id) => typeof id === "string"))
      return null;
    ids = [...new Set(parsed)];
  } catch {
    return null;
  }
  const parents = orm
    .select()
    .from(schema.memoryEntries)
    .where(inArray(schema.memoryEntries.id, ids))
    .all();
  if (
    parents.length !== ids.length ||
    parents.some(
      (row) =>
        row.agentId !== agentId || row.userId !== DEFAULT_USER_ID || row.status === "invalid",
    )
  )
    return null;
  const revisions = new Map(parents.map((row) => [row.id, memoryRevision(row)]));
  if (memoryPublicationSourceRevisions(orm, parents, revisions, now).size !== parents.length)
    return null;
  const web = db
    .query(
      "SELECT memory_id,turn_id FROM memory_sources WHERE memory_id IN (SELECT value FROM json_each(?))",
    )
    .all(JSON.stringify(ids)) as { memory_id: string; turn_id: string }[];
  const qq = db
    .query(
      "SELECT memory_id,event_key FROM qq_memory_sources WHERE memory_id IN (SELECT value FROM json_each(?))",
    )
    .all(JSON.stringify(ids)) as { memory_id: string; event_key: string }[];
  const present = new Set([...web.map((row) => row.memory_id), ...qq.map((row) => row.memory_id)]);
  if (ids.some((id) => !present.has(id))) return null;
  return {
    turnIds: [...new Set(web.map((row) => row.turn_id))],
    eventKeys: [...new Set(qq.map((row) => row.event_key))],
  };
}

/** Job-bound current proof for each blocked entry whose source is in the job's own scope. */
export function blockedMemorySourceRefs(
  orm: Orm,
  jobId: string,
  agentId: string,
  ids: readonly string[],
  now: string,
): ReadonlyMap<string, SourceRef> {
  const result = new Map<string, SourceRef>();
  if (!ids.length) return result;
  const db = (orm as Orm & { $client: import("bun:sqlite").Database }).$client;
  const job = db
    .query("SELECT agent_id,user_id,kind,session_id,config_snapshot FROM memory_jobs WHERE id=?")
    .get(jobId) as {
    agent_id: string;
    user_id: string;
    kind: string;
    session_id: string | null;
    config_snapshot: string;
  } | null;
  if (!job || job.agent_id !== agentId || job.user_id !== DEFAULT_USER_ID) return result;
  const merge = job.kind === "merge" ? mergeJobSourceSet(orm, jobId, agentId, now) : null;
  if (job.kind === "merge" && !merge) return result;
  const qq =
    job.kind !== "merge" && job.session_id === null
      ? qqBlockedJobScope({ db, orm }, jobId, agentId)
      : null;
  if (job.kind !== "merge" && job.session_id === null && !qq) return result;
  if (
    job.session_id !== null &&
    !db
      .query("SELECT 1 FROM sessions WHERE id=? AND agent_id=? AND user_id=?")
      .get(job.session_id, agentId, DEFAULT_USER_ID)
  )
    return result;
  const rows: Array<typeof schema.memoryEntries.$inferSelect> = [];
  chunked([...new Set(ids)], (chunk) => {
    rows.push(
      ...orm
        .select()
        .from(schema.memoryEntries)
        .where(inArray(schema.memoryEntries.id, chunk))
        .all(),
    );
  });
  const web = db
    .query(
      `SELECT ms.memory_id AS memoryId,ms.turn_id AS turnId,t.session_id AS sessionId FROM memory_sources ms LEFT JOIN turns t ON t.id=ms.turn_id WHERE ms.memory_id IN (SELECT value FROM json_each(?))`,
    )
    .all(JSON.stringify(ids)) as { memoryId: string; turnId: string; sessionId: string | null }[];
  const qqRows = db
    .query(
      `SELECT q.memory_id AS memoryId,q.event_key AS eventKey,q.scope_key AS scopeKey,t.expires_at AS bodyExpires,f.expires_at AS factExpires FROM qq_memory_sources q LEFT JOIN qq_observation_text t ON t.event_key=q.event_key LEFT JOIN qq_message_facts f ON f.event_key=q.event_key WHERE q.memory_id IN (SELECT value FROM json_each(?))`,
    )
    .all(JSON.stringify(ids)) as {
    memoryId: string;
    eventKey: string;
    scopeKey: string;
    bodyExpires: string | null;
    factExpires: string | null;
  }[];
  const webBy = new Map<string, typeof web>();
  const qqBy = new Map<string, typeof qqRows>();
  for (const row of web) {
    const list = webBy.get(row.memoryId) ?? [];
    list.push(row);
    webBy.set(row.memoryId, list);
  }
  for (const row of qqRows) {
    const list = qqBy.get(row.memoryId) ?? [];
    list.push(row);
    qqBy.set(row.memoryId, list);
  }
  const eligible = rows.filter((row) => {
    if (
      row.userId !== DEFAULT_USER_ID ||
      row.agentId !== agentId ||
      row.status === "invalid" ||
      !(
        row.status === "suppressed" ||
        row.status === "replaced" ||
        correctionMetadata(row.configSnapshot)?.rejected.length
      )
    )
      return false;
    const w = webBy.get(row.id) ?? [],
      q = qqBy.get(row.id) ?? [];
    if (merge)
      return (
        w.length + q.length > 0 &&
        w.every((source) => merge.turnIds.includes(source.turnId)) &&
        q.every((source) => merge.eventKeys.includes(source.eventKey))
      );
    return job.session_id !== null
      ? w.length > 0 && q.length === 0 && w.every((source) => source.sessionId === job.session_id)
      : !!qq &&
          q.length > 0 &&
          w.length === 0 &&
          q.every((source) => source.scopeKey === qq.sourceKey);
  });
  const revisions = new Map(eligible.map((row) => [row.id, memoryRevision(row)]));
  const proofs = memoryPublicationSourceRevisions(orm, eligible, revisions, now);
  for (const row of eligible) {
    const proof = proofs.get(row.id);
    if (!proof) continue;
    const expiry = (qqBy.get(row.id) ?? []).flatMap((source) =>
      [source.bodyExpires, source.factExpires].filter((value): value is string => value !== null),
    );
    const expiresAt = expiry.sort((a, b) => Date.parse(a) - Date.parse(b))[0];
    const id = JSON.stringify([jobId, row.id]);
    const revision = createHash("sha256")
      .update(
        JSON.stringify([
          jobId,
          row.id,
          revisions.get(row.id),
          merge ?? qq?.scope ?? job.session_id,
          proof,
        ]),
      )
      .digest("hex");
    result.set(row.id, {
      kind: "memory_blocked_source",
      id,
      revision,
      ...(expiresAt ? { expiresAt } : {}),
    });
  }
  return result;
}

/** Owner-first batch validation, usable in execution and stored-context inspection. */
export function blockedMemorySourceStates(
  orm: Orm,
  refs: readonly SourceRef[],
  owner: RunOwner,
  principal: { userId: string },
  now: string,
): SourceAccess[] {
  const result: SourceAccess[] = refs.map(() => "revoked");
  if (
    owner.kind !== "memory_job" ||
    !owner.agentId ||
    owner.userId !== principal.userId ||
    principal.userId !== DEFAULT_USER_ID
  )
    return result;
  const ids = refs.map((ref) => {
    try {
      const parsed = JSON.parse(ref.id);
      return Array.isArray(parsed) &&
        parsed.length === 2 &&
        parsed[0] === owner.id &&
        typeof parsed[1] === "string"
        ? (parsed[1] as string)
        : null;
    } catch {
      return null;
    }
  });
  const current = blockedMemorySourceRefs(
    orm,
    owner.id,
    owner.agentId,
    ids.filter((id): id is string => id !== null),
    now,
  );
  for (const [index, id] of ids.entries()) {
    const value = id === null ? undefined : current.get(id),
      ref = refs[index]!;
    if (!value || value.revision !== ref.revision || value.id !== ref.id) continue;
    if (ref.expiresAt !== undefined && !Number.isFinite(Date.parse(ref.expiresAt))) continue;
    if (
      value.expiresAt &&
      (!ref.expiresAt || Date.parse(ref.expiresAt) > Date.parse(value.expiresAt))
    )
      continue;
    result[index] =
      ref.expiresAt !== undefined && Date.parse(ref.expiresAt) <= Date.parse(now)
        ? "expired"
        : "available";
  }
  return result;
}

/** Single-entry management wrapper over the same proof algorithm. */
export function memoryPublicationSourceRevision(
  orm: Orm,
  entry: typeof schema.memoryEntries.$inferSelect,
  contentRevision: string,
  now: string,
): string {
  const revision = memoryPublicationSourceRevisions(
    orm,
    [entry],
    new Map([[entry.id, contentRevision]]),
    now,
  ).get(entry.id);
  if (revision === undefined) fail("MEMORY_SOURCE_INVALID", "记忆来源已失效");
  return revision;
}

/** Metadata only: source identities and grants, never message bodies or read authorization. */
export function memoryAccessMetadataBatch(
  orm: Orm,
  entries: readonly (typeof schema.memoryEntries.$inferSelect)[],
): ReadonlyMap<string, MemoryAccessMetadata> {
  const result = new Map<string, MemoryAccessMetadata>();
  if (!entries.length) return result;
  const db = (orm as Orm & { $client: import("bun:sqlite").Database }).$client;
  const web = new Map<string, Array<{ sessionId: string | null }>>();
  const qq = new Map<
    string,
    Array<{ eventKey: string; scopeKey: string; conversationKey: string }>
  >();
  const grants = new Map<string, string[]>();
  chunked([...new Set(entries.map((entry) => entry.id))], (ids) => {
    const webRows = db
      .query(`SELECT m.memory_id AS memoryId,t.session_id AS sessionId
      FROM memory_sources m LEFT JOIN turns t ON t.id=m.turn_id
      WHERE m.memory_id IN (SELECT value FROM json_each(?))`)
      .all(JSON.stringify(ids)) as Array<{ memoryId: string; sessionId: string | null }>;
    for (const row of webRows) {
      const list = web.get(row.memoryId) ?? [];
      list.push(row);
      web.set(row.memoryId, list);
    }
    for (const [id, rows] of observationSources(orm, ids)) qq.set(id, rows);
    const recipientRows = orm
      .select()
      .from(schema.memoryReadGrants)
      .where(inArray(schema.memoryReadGrants.memoryId, ids))
      .all();
    for (const row of recipientRows) {
      const list = grants.get(row.memoryId) ?? [];
      list.push(row.agentId);
      grants.set(row.memoryId, list);
    }
  });
  const sessionIds = [
    ...new Set([...web.values()].flat().flatMap((row) => (row.sessionId ? [row.sessionId] : []))),
  ];
  const webConversations = new Map<
    string,
    Array<{ id: string; agentId: string; userId: string }>
  >();
  chunked(sessionIds, (ids) => {
    const rows = db
      .query(`SELECT source_id AS sessionId,id,agent_id AS agentId,user_id AS userId
      FROM conversations WHERE channel='web' AND source_id IN (SELECT value FROM json_each(?))`)
      .all(JSON.stringify(ids)) as Array<{
      sessionId: string;
      id: string;
      agentId: string;
      userId: string;
    }>;
    for (const row of rows) {
      const list = webConversations.get(row.sessionId) ?? [];
      list.push(row);
      webConversations.set(row.sessionId, list);
    }
  });
  const eventIds = [...new Set([...qq.values()].flat().map((row) => row.eventKey))];
  const qqConversations = new Map<
    string,
    Array<{
      id: string;
      agentId: string;
      userId: string;
      eventAgentId: string;
      accountId: string;
      kind: string;
      peerId: string;
      bindingAccountId: string | null;
      bindingKind: string | null;
      bindingPeerId: string | null;
      bindingAgentId: string | null;
    }>
  >();
  chunked(eventIds, (ids) => {
    const rows = db
      .query(`SELECT ce.source_id AS eventKey,c.id,c.agent_id AS agentId,c.user_id AS userId,e.account_id AS accountId,
      e.conversation_kind AS kind,e.peer_id AS peerId,e.agent_id AS eventAgentId,
      b.account_id AS bindingAccountId,b.conversation_kind AS bindingKind,b.peer_id AS bindingPeerId,b.agent_id AS bindingAgentId
      FROM conversation_events ce JOIN conversations c ON c.id=ce.conversation_id
      JOIN qq_events e ON e.event_key=ce.source_id LEFT JOIN qq_bindings b ON b.id=c.source_id
      WHERE ce.source_kind='qq_event' AND ce.kind='inbound' AND c.channel='onebot11'
      AND ce.source_id IN (SELECT value FROM json_each(?))`)
      .all(JSON.stringify(ids)) as Array<{
      eventKey: string;
      id: string;
      agentId: string;
      userId: string;
      eventAgentId: string;
      accountId: string;
      kind: string;
      peerId: string;
      bindingAccountId: string | null;
      bindingKind: string | null;
      bindingPeerId: string | null;
      bindingAgentId: string | null;
    }>;
    for (const row of rows) {
      const list = qqConversations.get(row.eventKey) ?? [];
      list.push(row);
      qqConversations.set(row.eventKey, list);
    }
  });
  for (const entry of entries) {
    const origins = new Map<string, MemoryAccessMetadata["origins"][number]>();
    let complete = true;
    const sourceWeb = web.get(entry.id) ?? [];
    const sourceQq = qq.get(entry.id) ?? [];
    if (!sourceWeb.length && !sourceQq.length) complete = false;
    for (const source of sourceWeb) {
      const matches = source.sessionId
        ? (webConversations.get(source.sessionId) ?? []).filter(
            (row) => row.agentId === entry.agentId && row.userId === entry.userId,
          )
        : [];
      if (matches.length !== 1) {
        complete = false;
        continue;
      }
      origins.set(matches[0]!.id, { channel: "web", conversation_id: matches[0]!.id });
    }
    for (const source of sourceQq) {
      const candidates = qqConversations.get(source.eventKey) ?? [];
      if (candidates.length !== 1) {
        complete = false;
        continue;
      }
      const matches = candidates.filter((row) => {
        if (
          row.agentId !== entry.agentId ||
          row.userId !== entry.userId ||
          row.eventAgentId !== entry.agentId ||
          row.bindingAgentId !== entry.agentId ||
          row.bindingAccountId !== row.accountId ||
          row.bindingKind !== row.kind ||
          row.bindingPeerId !== row.peerId ||
          (row.kind !== "group" && row.kind !== "private")
        )
          return false;
        return (
          source.scopeKey ===
            qqMemoryScopeKey({
              kind: "qq",
              accountId: row.accountId,
              conversationKind: row.kind,
              peerId: row.peerId,
              agentId: entry.agentId,
            }) &&
          source.conversationKey ===
            qqConversationKey({ accountId: row.accountId, kind: row.kind, peerId: row.peerId })
        );
      });
      if (matches.length !== 1) {
        complete = false;
        continue;
      }
      origins.set(matches[0]!.id, { channel: "onebot11", conversation_id: matches[0]!.id });
    }
    if (!complete) origins.set("unknown", { channel: "unknown", conversation_id: null });
    result.set(entry.id, {
      visibility: entry.visibility as MemoryAccessMetadata["visibility"],
      visibility_revision: entry.visibilityRevision,
      recipient_agent_ids: (grants.get(entry.id) ?? []).sort(),
      origins: [...origins.values()].sort((a, b) =>
        (a.conversation_id ?? "").localeCompare(b.conversation_id ?? ""),
      ),
      origin_complete: complete,
      source_validity: "not_evaluated",
      runtime_eligibility: "not_evaluated",
      raw_preview: "not_evaluated",
    });
  }
  return result;
}

export function observationContentSources(rows: QqMemorySourceRow[]): ContentSource[] {
  return rows.map((row) => ({
    type: "qq_observation" as const,
    scope_key: row.scopeKey,
    conversation_key: row.conversationKey,
    event_key: row.eventKey,
    message_id: row.messageId,
    occurred_at_seconds: row.occurredAtSeconds,
    speaker_kind: row.speakerKind as "member" | "anonymous" | "system",
    speaker_id: row.speakerId,
    valid: true,
  }));
}

/**
 * Observation provenance is only meaningful inside a QQ scope. The web scope key is
 * the bare agent id, which is also the value family `memory_entries` carries for web
 * memory, so this comparison is exactly the web/QQ boundary.
 */
export function acceptsObservationSources(memoryScopeKey: string, agentId: string): boolean {
  return memoryScopeKey !== agentId;
}
