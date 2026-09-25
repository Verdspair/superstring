// Provenance lookup shared by recall, validation and governance.
//
// A memory has two possible kinds of evidence:
//   * `memory_sources` — a paired user/assistant turn (web conversations), and
//   * `qq_memory_sources` — a QQ conversation observation (a group member's message).
//
// A memory is reusable only while EVERY source it depends on is intact. Web
// memory stays turn-only: an agent-level (web) memory may never claim observation
// provenance, because a group observation is not part of the web scope and
// accepting one there would let QQ evidence validate a web memory.

import { eq, inArray } from "drizzle-orm";
import type { ContentSource } from "../../shared/contracts";
import { fail } from "../errors";
import { qqConversationKey, qqMemoryScopeKey } from "../services/qq-binding-contract";
import type { Orm } from "./repositories";
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
