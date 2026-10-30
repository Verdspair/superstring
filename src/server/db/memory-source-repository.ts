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
import { z } from "zod";
import type { ContentSource, MemoryAccessMetadata } from "../../shared/contracts";
import type { RunOwner } from "../../shared/contracts/agent-run";
import type { SourceAccess, SourceRef } from "../../shared/contracts/evidence";
import { normalizeOneBotAccountId } from "../../shared/contracts/onebot-identity";
import { fail } from "../errors";
import { memoryJobScopes } from "../services/memory-contract";
import { correctionMetadata, memoryRevision } from "../services/memory-revision";
import { qqConversationKey, qqMemoryScopeKey } from "../services/qq-binding-contract";
import {
  collectQqEntryPublicationSources,
  type PublicationMaterial,
  qqBlockedJobScope,
  qqPublicationRouteAuthority,
  verifyRetainedQqMaterials,
} from "../services/qq-memory-fact-input";
import { bodyRevision } from "./conversation-event-repository";
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

interface WebSourceIntegrity {
  turnId: string;
  sessionId: string;
  sourceValid: number;
  generationStatus: string;
  sessionAgentId: string;
  sessionUserId: string;
  userTurnId: string | null;
  userSessionId: string | null;
  userRole: string | null;
  userStatus: string | null;
  assistantTurnId: string | null;
  assistantSessionId: string | null;
  assistantRole: string | null;
  assistantStatus: string | null;
}
/** Source validity does not grant private context or raw-message access. */
function webSourceIntact(
  agentId: string,
  userId: string,
  row: WebSourceIntegrity | undefined,
): boolean {
  return (
    !!row &&
    row.sessionAgentId === agentId &&
    row.sessionUserId === userId &&
    row.sourceValid === 1 &&
    row.generationStatus === "completed" &&
    row.userTurnId === row.turnId &&
    row.userSessionId === row.sessionId &&
    row.userRole === "user" &&
    row.userStatus === "completed" &&
    row.assistantTurnId === row.turnId &&
    row.assistantSessionId === row.sessionId &&
    row.assistantRole === "assistant" &&
    row.assistantStatus === "completed"
  );
}

export interface MemorySourceFactAssessment {
  readonly webSources: ReadonlyMap<string, readonly (typeof schema.memorySources.$inferSelect)[]>;
  readonly observationSources: ReadonlyMap<string, readonly QqMemorySourceRow[]>;
  readonly states: ReadonlyMap<string, "valid" | "invalid" | "unknown">;
  readonly revisions: ReadonlyMap<string, string>;
  readonly observationValidity: ReadonlyMap<string, boolean>;
  readonly webSessions: ReadonlyMap<string, readonly (string | null)[]>;
  readonly webValidity: ReadonlyMap<string, boolean>;
}

/** Durable provenance facts. Original-body expiry and live read authority are separate. */
export function memorySourceFactAssessment(
  orm: Orm,
  entries: readonly Pick<typeof schema.memoryEntries.$inferSelect, "id" | "agentId" | "userId">[],
): MemorySourceFactAssessment {
  const db = (orm as Orm & { $client: import("bun:sqlite").Database }).$client;
  const webSources = new Map<string, (typeof schema.memorySources.$inferSelect)[]>();
  const observations = new Map<string, QqMemorySourceRow[]>();
  const webSessions = new Map<string, (string | null)[]>();
  const webValidity = new Map<string, boolean>();
  const observationsValid = new Map<string, boolean>();
  const validByMemory = new Map<string, boolean>();
  const proofByMemory = new Map<string, unknown[]>();
  const ownerById = new Map(entries.map((entry) => [entry.id, entry]));
  chunked([...ownerById.keys()], (ids) => {
    const web = db
      .query(`SELECT m.memory_id AS memoryId,m.turn_id AS turnId,m.user_message_id AS userMessageId,
      m.assistant_message_id AS assistantMessageId,m.sequence_no AS sequenceNo,
      t.id AS actualTurnId,t.session_id AS sessionId,t.source_valid AS sourceValid,t.generation_status AS generationStatus,
      s.agent_id AS sessionAgentId,s.user_id AS sessionUserId,
      u.turn_id AS userTurnId,u.session_id AS userSessionId,u.role AS userRole,u.status AS userStatus,
      a.turn_id AS assistantTurnId,a.session_id AS assistantSessionId,a.role AS assistantRole,a.status AS assistantStatus
      FROM memory_sources m LEFT JOIN turns t ON t.id=m.turn_id LEFT JOIN sessions s ON s.id=t.session_id
      LEFT JOIN messages u ON u.id=m.user_message_id LEFT JOIN messages a ON a.id=m.assistant_message_id
      WHERE m.memory_id IN (SELECT value FROM json_each(?))`)
      .all(JSON.stringify(ids)) as Array<
      typeof schema.memorySources.$inferSelect &
        WebSourceIntegrity & { actualTurnId: string | null; sessionId: string | null }
    >;
    for (const row of web) {
      const entry = ownerById.get(row.memoryId)!;
      const source = {
        memoryId: row.memoryId,
        turnId: row.turnId,
        userMessageId: row.userMessageId,
        assistantMessageId: row.assistantMessageId,
        sequenceNo: row.sequenceNo,
      };
      const list = webSources.get(row.memoryId) ?? [];
      list.push(source);
      webSources.set(row.memoryId, list);
      const sessions = webSessions.get(row.memoryId) ?? [];
      sessions.push(row.sessionId);
      webSessions.set(row.memoryId, sessions);
      const valid =
        !!row.actualTurnId &&
        !!row.sessionId &&
        webSourceIntact(entry.agentId, entry.userId, {
          ...row,
          turnId: row.actualTurnId,
          sessionId: row.sessionId,
        });
      webValidity.set(JSON.stringify([row.memoryId, row.turnId]), valid);
      validByMemory.set(row.memoryId, (validByMemory.get(row.memoryId) ?? true) && valid);
      const proof = proofByMemory.get(row.memoryId) ?? [];
      proof.push([
        "web",
        source,
        row.sessionId,
        row.sourceValid,
        row.generationStatus,
        row.userStatus,
        row.assistantStatus,
      ]);
      proofByMemory.set(row.memoryId, proof);
    }
    const qq = db
      .query(`SELECT q.memory_id AS memoryId,q.event_key AS eventKey,q.scope_key AS scopeKey,
      q.conversation_key AS conversationKey,q.message_id AS messageId,q.occurred_at_seconds AS occurredAtSeconds,
      q.speaker_kind AS speakerKind,q.speaker_id AS speakerId,e.event_key AS actualEventKey,
      e.agent_id AS eventAgentId,e.message_id AS eventMessageId,e.occurred_at_seconds AS eventTime,
      e.speaker_kind AS eventSpeakerKind,e.speaker_id AS eventSpeakerId,e.account_id AS accountId,
      e.conversation_kind AS conversationKind,e.peer_id AS peerId
      FROM qq_memory_sources q LEFT JOIN qq_events e ON e.event_key=q.event_key
      WHERE q.memory_id IN (SELECT value FROM json_each(?))`)
      .all(JSON.stringify(ids)) as Array<
      QqMemorySourceRow & {
        actualEventKey: string | null;
        eventAgentId: string | null;
        eventMessageId: string | null;
        eventTime: number | null;
        eventSpeakerKind: string | null;
        eventSpeakerId: string | null;
        accountId: string;
        conversationKind: "group" | "private";
        peerId: string;
      }
    >;
    for (const row of qq) {
      const entry = ownerById.get(row.memoryId)!;
      const source = {
        memoryId: row.memoryId,
        eventKey: row.eventKey,
        scopeKey: row.scopeKey,
        conversationKey: row.conversationKey,
        messageId: row.messageId,
        occurredAtSeconds: row.occurredAtSeconds,
        speakerKind: row.speakerKind,
        speakerId: row.speakerId,
      };
      const list = observations.get(row.memoryId) ?? [];
      list.push(source);
      observations.set(row.memoryId, list);
      let identityValid = false;
      if (
        row.actualEventKey &&
        row.eventAgentId === entry.agentId &&
        normalizeOneBotAccountId(row.accountId) === row.accountId &&
        normalizeOneBotAccountId(row.peerId) === row.peerId &&
        (row.conversationKind === "group" || row.conversationKind === "private")
      ) {
        const conversation = qqConversationKey({
          accountId: row.accountId,
          kind: row.conversationKind,
          peerId: row.peerId,
        });
        let scopeConsistent = true;
        try {
          const key: unknown = JSON.parse(row.scopeKey);
          if (Array.isArray(key) && key[0] === "qq")
            scopeConsistent =
              row.scopeKey ===
              qqMemoryScopeKey({
                kind: "qq",
                accountId: row.accountId,
                conversationKind: row.conversationKind,
                peerId: row.peerId,
                agentId: entry.agentId,
              });
        } catch {
          /* Historical opaque labels are not runtime authorization. */
        }
        identityValid =
          scopeConsistent &&
          row.conversationKey === conversation &&
          row.messageId === row.eventMessageId &&
          row.occurredAtSeconds === row.eventTime &&
          row.speakerKind === row.eventSpeakerKind &&
          row.speakerId === row.eventSpeakerId;
      }
      observationsValid.set(JSON.stringify([row.memoryId, row.eventKey]), identityValid);
      validByMemory.set(row.memoryId, (validByMemory.get(row.memoryId) ?? true) && identityValid);
      const proof = proofByMemory.get(row.memoryId) ?? [];
      proof.push(["qq", source, row.accountId, row.conversationKind, row.peerId, row.eventAgentId]);
      proofByMemory.set(row.memoryId, proof);
    }
  });
  const states = new Map<string, "valid" | "invalid" | "unknown">(),
    revisions = new Map<string, string>();
  for (const entry of entries) {
    const parts = proofByMemory.get(entry.id) ?? [];
    const state =
      parts.length === 0 ? "unknown" : validByMemory.get(entry.id) ? "valid" : "invalid";
    states.set(entry.id, state);
    if (state === "valid")
      revisions.set(
        entry.id,
        createHash("sha256")
          .update(
            JSON.stringify([
              "memory-source-facts-v1",
              entry.id,
              parts.map((part) => JSON.stringify(part)).sort(),
            ]),
          )
          .digest("hex"),
      );
  }
  return {
    webSources,
    observationSources: observations,
    states,
    revisions,
    observationValidity: observationsValid,
    webSessions,
    webValidity,
  };
}

export function memoryPublicationSourceRevisions(
  orm: Orm,
  entries: readonly Pick<typeof schema.memoryEntries.$inferSelect, "id" | "agentId" | "userId">[],
  contentRevisions: ReadonlyMap<string, string>,
  now: string,
  captured?: Map<string, PublicationMaterial[]>,
  capturedAuthority?: Map<string, unknown[]>,
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
  const qqCollected = collectQqEntryPublicationSources(
    {
      db,
      orm,
      now,
      entries: unique.map((entry) => ({
        id: entry.id,
        agentId: entry.agentId,
        sources: qqById.get(entry.id) ?? [],
      })),
    },
    false,
    captured !== undefined,
  );
  const qqProof = qqCollected.proof;
  if (capturedAuthority)
    for (const [id, parts] of qqCollected.authority) capturedAuthority.set(id, parts);
  const result = new Map<string, string>();
  for (const entry of unique) {
    const sources = webById.get(entry.id) ?? [];
    const qq = qqById.get(entry.id) ?? [];
    const qqParts = qqProof.get(entry.id);
    if (sources.length + qq.length === 0 || !qqParts) continue;
    const proof: unknown[] = [...qqParts];
    const materials: PublicationMaterial[] = [...(qqCollected.materials.get(entry.id) ?? [])];
    let valid = true;
    for (const source of sources) {
      const turn = turns.get(source.turnId);
      const session = turn && sessions.get(turn.sessionId);
      const user = messages.get(source.userMessageId);
      const assistant = messages.get(source.assistantMessageId);
      const integrity =
        turn && session
          ? {
              turnId: turn.id,
              sessionId: session.id,
              sourceValid: turn.sourceValid,
              generationStatus: turn.generationStatus,
              sessionAgentId: session.agentId,
              sessionUserId: session.userId,
              userTurnId: user?.turnId ?? null,
              userSessionId: user?.sessionId ?? null,
              userRole: user?.role ?? null,
              userStatus: user?.status ?? null,
              assistantTurnId: assistant?.turnId ?? null,
              assistantSessionId: assistant?.sessionId ?? null,
              assistantRole: assistant?.role ?? null,
              assistantStatus: assistant?.status ?? null,
            }
          : undefined;
      if (!webSourceIntact(entry.agentId, entry.userId, integrity)) {
        valid = false;
        break;
      }
      for (const message of [user!, assistant!])
        materials.push({
          kind: "web_message",
          id: message.id,
          revision: bodyRevision(message.content),
          own_cap: null,
          consumable_cap: null,
          producer_revision: null,
        });
      proof.push([
        "web",
        source.turnId,
        session!.id,
        source.userMessageId,
        source.assistantMessageId,
        source.sequenceNo,
        user!.content,
        assistant!.content,
      ]);
    }
    if (!valid) continue;
    captured?.set(entry.id, materials);
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

const PUBLICATION_V2_PREFIX = "mempub:v2:";
const digestPattern = /^[a-f0-9]{64}$/;
const capSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(?:\d{3})?Z$/)
  .refine((value) => Number.isFinite(Date.parse(value)))
  .nullable();
const materialSchema = z.strictObject({
  kind: z.enum(["web_message", "qq_message_fact", "qq_observation"]),
  id: z.string().min(1),
  revision: z.string().min(1),
  own_cap: capSchema,
  consumable_cap: capSchema,
  producer_revision: z.string().nullable(),
});
const publicationV2Schema = z.strictObject({
  v: z.literal(2),
  issuance: z.string().regex(digestPattern),
  basis: z.string().regex(digestPattern),
  facts: z.string().regex(digestPattern),
  authority: z.string().regex(digestPattern),
  sources: z.array(materialSchema).min(1),
});
export type MemoryPublicationV2 = z.infer<typeof publicationV2Schema>;
function orderedMaterials(materials: readonly PublicationMaterial[]): PublicationMaterial[] {
  const byKey = new Map<string, PublicationMaterial>();
  for (const item of materials) {
    const key = JSON.stringify([item.kind, item.id]),
      previous = byKey.get(key);
    if (previous && JSON.stringify(previous) !== JSON.stringify(item))
      fail("MEMORY_SOURCE_INVALID", "发布材料不一致");
    byKey.set(key, item);
  }
  return [...byKey.values()].sort(
    (a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id),
  );
}
export function parseMemoryPublication(raw: string | null): MemoryPublicationV2 | "legacy" | null {
  if (raw === null) return null;
  if (digestPattern.test(raw)) return "legacy";
  if (!raw.startsWith(PUBLICATION_V2_PREFIX)) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw.slice(PUBLICATION_V2_PREFIX.length));
  } catch {
    return null;
  }
  const parsed = publicationV2Schema.safeParse(value);
  if (!parsed.success) return null;
  const manifest = parsed.data;
  if (
    manifest.sources.some((item) =>
      item.kind === "web_message"
        ? item.own_cap !== null || item.consumable_cap !== null || item.producer_revision !== null
        : item.own_cap === null ||
          item.consumable_cap === null ||
          Date.parse(item.consumable_cap) > Date.parse(item.own_cap) ||
          (item.kind === "qq_observation" && item.producer_revision !== null) ||
          (item.kind === "qq_message_fact" &&
            (item.producer_revision === null || !/^[1-9]\d*$/.test(item.producer_revision))),
    )
  )
    return null;
  const keys = manifest.sources.map((item) => JSON.stringify([item.kind, item.id]));
  if (new Set(keys).size !== keys.length) return null;
  const ordered = orderedMaterials(manifest.sources);
  if (
    ordered.length !== manifest.sources.length ||
    JSON.stringify(ordered) !== JSON.stringify(manifest.sources)
  )
    return null;
  return PUBLICATION_V2_PREFIX + JSON.stringify(manifest) === raw ? manifest : null;
}
function publicationBasis(
  entry: typeof schema.memoryEntries.$inferSelect,
  manifest: Omit<MemoryPublicationV2, "basis" | "v">,
): string {
  return bodyRevision(
    JSON.stringify([
      "memory-publication-retained-v2",
      entry.id,
      entry.userId,
      entry.agentId,
      memoryRevision(entry),
      manifest.facts,
      manifest.authority,
      manifest.issuance,
      manifest.sources,
    ]),
  );
}
/** Current source authority only; original source identities stay separate from raw retention. */
function publicationAuthorities(
  orm: Orm,
  entries: readonly (typeof schema.memoryEntries.$inferSelect)[],
  facts: MemorySourceFactAssessment,
  qqAuthority?: ReadonlyMap<string, unknown[]>,
): ReadonlyMap<string, string> {
  const db = (orm as Orm & { $client: import("bun:sqlite").Database }).$client;
  const qq =
    qqAuthority ??
    collectQqEntryPublicationSources(
      {
        db,
        orm,
        now: new Date().toISOString(),
        entries: entries.map((entry) => ({
          id: entry.id,
          agentId: entry.agentId,
          sources: facts.observationSources.get(entry.id) ?? [],
        })),
      },
      true,
    ).authority;
  const sessionIds = [
    ...new Set([...facts.webSessions.values()].flat().filter((id): id is string => id !== null)),
  ];
  const conversations = new Map<
    string,
    Array<{ id: string; sourceId: string; userId: string; agentId: string; epoch: number }>
  >();
  chunked(sessionIds, (ids) => {
    const rows = db
      .query(`SELECT id,source_id AS sourceId,user_id AS userId,agent_id AS agentId,binding_epoch AS epoch FROM conversations
      WHERE channel='web' AND closed_at IS NULL AND source_id IN (SELECT value FROM json_each(?))`)
      .all(JSON.stringify(ids)) as Array<{
      id: string;
      sourceId: string;
      userId: string;
      agentId: string;
      epoch: number;
    }>;
    for (const row of rows) {
      const list = conversations.get(row.sourceId) ?? [];
      list.push(row);
      conversations.set(row.sourceId, list);
    }
  });
  const result = new Map<string, string>();
  const routes = new Map<string, unknown[] | null>();
  for (const entry of entries) {
    if (facts.states.get(entry.id) !== "valid") continue;
    const parts = qq.get(entry.id);
    if (!parts) continue;
    const web: unknown[] = [];
    let valid = true;
    for (const id of facts.webSessions.get(entry.id) ?? []) {
      const matched =
        id === null
          ? []
          : (conversations.get(id) ?? []).filter(
              (row) => row.userId === entry.userId && row.agentId === entry.agentId,
            );
      if (matched.length !== 1) {
        valid = false;
        break;
      }
      web.push(matched[0]);
    }
    const routeKey = JSON.stringify([
      entry.agentId,
      entry.scopeKey,
      memoryJobScopes(JSON.parse(entry.configSnapshot)).route ?? null,
    ]);
    if (!routes.has(routeKey))
      routes.set(routeKey, qqPublicationRouteAuthority({ db, orm }, entry));
    const route = routes.get(routeKey)!;
    if (!valid || route === null) continue;
    result.set(
      entry.id,
      bodyRevision(
        JSON.stringify([
          parts.map((part) => JSON.stringify(part)).sort(),
          web.map((part) => JSON.stringify(part)).sort(),
          route,
        ]),
      ),
    );
  }
  return result;
}
export function issueMemoryPublications(
  orm: Orm,
  entries: readonly (typeof schema.memoryEntries.$inferSelect)[],
  now: string,
): ReadonlyMap<string, string> {
  if (!Number.isFinite(Date.parse(now))) return new Map();
  const materials = new Map<string, PublicationMaterial[]>(),
    qqAuthority = new Map<string, unknown[]>();
  const live = memoryPublicationSourceRevisions(
    orm,
    entries,
    new Map(entries.map((entry) => [entry.id, memoryRevision(entry)])),
    now,
    materials,
    qqAuthority,
  );
  const facts = memorySourceFactAssessment(orm, entries),
    authority = publicationAuthorities(orm, entries, facts, qqAuthority);
  const result = new Map<string, string>();
  for (const entry of entries) {
    const issuance = live.get(entry.id),
      sourceFacts = facts.revisions.get(entry.id),
      sourceAuthority = authority.get(entry.id);
    if (!issuance || !sourceFacts || !sourceAuthority) continue;
    const sources = orderedMaterials(materials.get(entry.id) ?? []);
    const content = { issuance, facts: sourceFacts, authority: sourceAuthority, sources };
    const manifest: MemoryPublicationV2 = {
      v: 2,
      issuance,
      basis: publicationBasis(entry, content),
      facts: sourceFacts,
      authority: sourceAuthority,
      sources,
    };
    const encoded = PUBLICATION_V2_PREFIX + JSON.stringify(manifest);
    if (parseMemoryPublication(encoded)) result.set(entry.id, encoded);
  }
  return result;
}
/** Batch read qualification. No writes and no regeneration of a lost issuance receipt. */
export function retainedMemoryPublications(
  orm: Orm,
  entries: readonly (typeof schema.memoryEntries.$inferSelect)[],
  now: string,
): ReadonlyMap<string, string> {
  if (!Number.isFinite(Date.parse(now))) return new Map();
  const parsed = new Map<string, MemoryPublicationV2>();
  const legacy: (typeof schema.memoryEntries.$inferSelect)[] = [];
  for (const entry of entries) {
    const value = parseMemoryPublication(entry.publicationSourceRevision);
    if (value === "legacy") legacy.push(entry);
    else if (value) parsed.set(entry.id, value);
  }
  const result = new Map<string, string>();
  const legacyProof = memoryPublicationSourceRevisions(
    orm,
    legacy,
    new Map(legacy.map((entry) => [entry.id, memoryRevision(entry)])),
    now,
  );
  for (const entry of legacy)
    if (legacyProof.get(entry.id) === entry.publicationSourceRevision)
      result.set(entry.id, entry.publicationSourceRevision!);
  const candidates = entries.filter((entry) => parsed.has(entry.id));
  if (!candidates.length) return result;
  const facts = memorySourceFactAssessment(orm, candidates);
  const db = (orm as Orm & { $client: import("bun:sqlite").Database }).$client;
  const qqAuthority = collectQqEntryPublicationSources(
    {
      db,
      orm,
      now,
      entries: candidates.map((entry) => ({
        id: entry.id,
        agentId: entry.agentId,
        sources: facts.observationSources.get(entry.id) ?? [],
      })),
    },
    true,
  ).authority;
  const authorities = publicationAuthorities(orm, candidates, facts, qqAuthority);
  const descriptors = new Map<string, readonly PublicationMaterial[]>();
  const validCandidates = candidates.filter((entry) => {
    const value = parsed.get(entry.id)!;
    if (
      value.facts !== facts.revisions.get(entry.id) ||
      value.authority !== authorities.get(entry.id) ||
      publicationBasis(entry, value) !== value.basis
    )
      return false;
    const webIds = new Set(
      (facts.webSources.get(entry.id) ?? []).flatMap((source) => [
        source.userMessageId,
        source.assistantMessageId,
      ]),
    );
    const qqIds = new Set(
      (facts.observationSources.get(entry.id) ?? []).map((source) => source.eventKey),
    );
    const coveredQqIds = new Set<string>();
    for (const item of value.sources) {
      if (item.kind === "web_message") {
        if (!webIds.delete(item.id)) return false;
      } else {
        if (!qqIds.has(item.id)) return false;
        coveredQqIds.add(item.id);
      }
    }
    if (webIds.size || coveredQqIds.size !== qqIds.size) return false;
    descriptors.set(entry.id, value.sources);
    return true;
  });
  const qqValid = verifyRetainedQqMaterials(
    {
      db,
      orm,
      now,
      entries: validCandidates.map((entry) => ({
        id: entry.id,
        agentId: entry.agentId,
        sources: facts.observationSources.get(entry.id) ?? [],
      })),
    },
    descriptors,
    qqAuthority,
  );
  const webMaterials = [...descriptors.values()]
    .flat()
    .filter((item) => item.kind === "web_message");
  const messages = loadMessageIntegrity(
    orm,
    webMaterials.map((item) => item.id),
  );
  for (const entry of validCandidates) {
    const manifest = parsed.get(entry.id)!;
    if (
      !qqValid.has(entry.id) ||
      manifest.sources.some(
        (item) =>
          item.kind === "web_message" &&
          (!messages.has(item.id) ||
            bodyRevision(messages.get(item.id)!.content) !== item.revision),
      )
    )
      continue;
    result.set(entry.id, entry.publicationSourceRevision!);
  }
  return result;
}

/** Revisions for tasks consuming derived memory, not original transcripts or new public publication. */
export function memoryDerivedSourceRevisions(
  orm: Orm,
  entries: readonly (typeof schema.memoryEntries.$inferSelect)[],
  now: string,
  facts: MemorySourceFactAssessment = memorySourceFactAssessment(orm, entries),
): ReadonlyMap<string, string> {
  const routed = entries.filter(
    (entry) =>
      memoryJobScopes(
        JSON.parse(entry.configSnapshot) as { scope_key?: unknown; qq_route?: unknown },
      ).route !== undefined,
  );
  const publications = memoryPublicationSourceRevisions(
    orm,
    routed,
    new Map(routed.map((entry) => [entry.id, memoryRevision(entry)])),
    now,
  );
  const result = new Map<string, string>();
  for (const entry of entries) {
    if (facts.states.get(entry.id) !== "valid") continue;
    const web = facts.webSources.get(entry.id) ?? [],
      qq = facts.observationSources.get(entry.id) ?? [];
    const scopes = memoryJobScopes(
      JSON.parse(entry.configSnapshot) as { scope_key?: unknown; qq_route?: unknown },
    );
    if (scopes.route) {
      if (
        scopes.destination !== entry.scopeKey ||
        !qq.length ||
        qq.some((source) => source.scopeKey !== scopes.source)
      )
        continue;
      const proof = publications.get(entry.id);
      if (proof) result.set(entry.id, proof);
    } else if (!(qq.length && !web.length && entry.scopeKey === entry.agentId)) {
      result.set(
        entry.id,
        createHash("sha256")
          .update(
            JSON.stringify([
              "memory-derived-source-v1",
              entry.id,
              memoryRevision(entry),
              facts.revisions.get(entry.id),
            ]),
          )
          .digest("hex"),
      );
    }
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
  if (memoryDerivedSourceRevisions(orm, parents, now).size !== parents.length) return null;
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
  const proofs = merge
    ? memoryDerivedSourceRevisions(orm, eligible, now)
    : memoryPublicationSourceRevisions(orm, eligible, revisions, now);
  for (const row of eligible) {
    const proof = proofs.get(row.id);
    if (!proof) continue;
    const expiry = merge
      ? []
      : (qqBy.get(row.id) ?? []).flatMap((source) =>
          [source.bodyExpires, source.factExpires].filter(
            (value): value is string => value !== null,
          ),
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

export interface MemoryPreviewTarget {
  channel: "web" | "onebot11";
  id: string;
  turnId: string | null;
  role: "user" | "assistant" | null;
  conversationId: string | null;
  valid: boolean;
}
/** Page recorded identities first. Only the requested targets resolve canonical identities. */
export function memoryPreviewTargets(
  orm: Orm,
  entry: Pick<typeof schema.memoryEntries.$inferSelect, "id" | "agentId" | "userId">,
  page: { offset: number; limit: number } | { target: MemoryPreviewTarget },
) {
  const db = (orm as Orm & { $client: import("bun:sqlite").Database }).$client;
  const total = (
    db
      .query(`SELECT (SELECT count(*)*2 FROM memory_sources WHERE memory_id=?) +
    (SELECT count(*) FROM qq_memory_sources WHERE memory_id=?) AS total`)
      .get(entry.id, entry.id) as { total: number }
  ).total;
  const exact = "target" in page;
  const predicate = exact ? "WHERE channel=? AND id=? AND turnId IS ? AND role IS ?" : "";
  const selected = db
    .query(`WITH links AS (
    SELECT 'web' AS channel,user_message_id AS id,turn_id AS turnId,'user' AS role FROM memory_sources WHERE memory_id=?
    UNION ALL SELECT 'web',assistant_message_id,turn_id,'assistant' FROM memory_sources WHERE memory_id=?
    UNION ALL SELECT 'onebot11',event_key,NULL,NULL FROM qq_memory_sources WHERE memory_id=?
  ) SELECT * FROM links ${predicate} ORDER BY channel,turnId,id LIMIT ? OFFSET ?`)
    .all(
      entry.id,
      entry.id,
      entry.id,
      ...(exact ? [page.target.channel, page.target.id, page.target.turnId, page.target.role] : []),
      exact ? 2 : page.limit,
      exact ? 0 : page.offset,
    ) as Array<Omit<MemoryPreviewTarget, "conversationId" | "valid">>;
  if (!selected.length) return { total, targets: [] as MemoryPreviewTarget[] };
  const targets = db
    .query(`WITH selected AS (SELECT value FROM json_each(?)), resolved AS (
    SELECT selected.value AS item,
      CASE WHEN json_extract(selected.value,'$.channel')='web' THEN (
        SELECT CASE WHEN count(*)=1 THEN min(c.id) END FROM conversations c JOIN turns t ON t.session_id=c.source_id
        WHERE t.id=json_extract(selected.value,'$.turnId') AND c.channel='web' AND c.agent_id=?
      ) ELSE (
        SELECT CASE WHEN count(*)=1 THEN min(c.id) END FROM conversation_events ce JOIN conversations c ON c.id=ce.conversation_id
        WHERE ce.source_kind='qq_event' AND ce.kind='inbound' AND ce.source_id=json_extract(selected.value,'$.id')
          AND c.channel='onebot11' AND c.agent_id=?
      ) END AS conversationId,
      CASE WHEN json_extract(selected.value,'$.channel')='web' THEN EXISTS (
        SELECT 1 FROM memory_sources ms JOIN turns t ON t.id=ms.turn_id JOIN sessions s ON s.id=t.session_id
        JOIN messages u ON u.id=ms.user_message_id JOIN messages a ON a.id=ms.assistant_message_id
        WHERE ms.memory_id=? AND ms.turn_id=json_extract(selected.value,'$.turnId')
          AND s.agent_id=? AND s.user_id=? AND t.source_valid=1 AND t.generation_status='completed'
          AND u.turn_id=t.id AND a.turn_id=t.id AND u.session_id=s.id AND a.session_id=s.id
          AND u.role='user' AND a.role='assistant' AND u.status='completed' AND a.status='completed'
          AND u.sequence_no=ms.sequence_no
          AND ((json_extract(selected.value,'$.role')='user' AND u.id=json_extract(selected.value,'$.id'))
            OR (json_extract(selected.value,'$.role')='assistant' AND a.id=json_extract(selected.value,'$.id')))
      ) ELSE EXISTS (
        SELECT 1 FROM qq_memory_sources qs JOIN qq_events e ON e.event_key=qs.event_key
        WHERE qs.memory_id=? AND qs.event_key=json_extract(selected.value,'$.id') AND e.agent_id=?
          AND qs.message_id=e.message_id AND qs.occurred_at_seconds=e.occurred_at_seconds
          AND qs.speaker_kind=e.speaker_kind AND qs.speaker_id IS e.speaker_id
          AND qs.conversation_key=json_array('qq',e.account_id,e.conversation_kind,e.peer_id)
          AND CASE WHEN json_valid(qs.scope_key) THEN CASE WHEN json_type(qs.scope_key)='array'
            THEN json_extract(qs.scope_key,'$[0]') IS NOT 'qq'
              OR qs.scope_key=json_array('qq',e.account_id,e.conversation_kind,e.peer_id,e.agent_id)
            ELSE 1 END ELSE 1 END
      ) END AS valid FROM selected
  ) SELECT item,conversationId,valid FROM resolved`)
    .all(
      JSON.stringify(selected),
      entry.agentId,
      entry.agentId,
      entry.id,
      entry.agentId,
      entry.userId,
      entry.id,
      entry.agentId,
    ) as Array<{ item: string; conversationId: string | null; valid: number }>;
  return {
    total,
    targets: targets.map(({ item, conversationId, valid }) => ({
      ...JSON.parse(item),
      conversationId,
      valid: valid === 1,
    })) as MemoryPreviewTarget[],
  };
}

/** Metadata only: source identities and grants, never message bodies or read authorization. */
export function memoryAccessMetadataBatch(
  orm: Orm,
  entries: readonly Pick<
    typeof schema.memoryEntries.$inferSelect,
    "id" | "agentId" | "userId" | "visibility" | "visibilityRevision"
  >[],
): ReadonlyMap<string, MemoryAccessMetadata> {
  const result = new Map<string, MemoryAccessMetadata>();
  if (!entries.length) return result;
  const db = (orm as Orm & { $client: import("bun:sqlite").Database }).$client;
  const facts = memorySourceFactAssessment(orm, entries);
  const web = new Map(
    [...facts.webSessions].map(([id, sessions]) => [
      id,
      sessions.map((sessionId) => ({ sessionId })),
    ]),
  );
  const qq = facts.observationSources;
  const grants = new Map<string, string[]>();
  chunked([...new Set(entries.map((entry) => entry.id))], (ids) => {
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
      source_validity: facts.states.get(entry.id) ?? "unknown",
      runtime_eligibility: "unknown",
      raw_preview: "unknown",
    });
  }
  return result;
}

export function observationContentSources(
  rows: QqMemorySourceRow[],
  validity?: ReadonlyMap<string, boolean>,
): ContentSource[] {
  return rows.map((row) => ({
    type: "qq_observation" as const,
    scope_key: row.scopeKey,
    conversation_key: row.conversationKey,
    event_key: row.eventKey,
    message_id: row.messageId,
    occurred_at_seconds: row.occurredAtSeconds,
    speaker_kind: row.speakerKind as "member" | "anonymous" | "system",
    speaker_id: row.speakerId,
    valid: validity?.get(JSON.stringify([row.memoryId, row.eventKey])) ?? true,
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
