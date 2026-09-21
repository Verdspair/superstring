import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { ContentItem, MemoryContentResponse, MemoryCorrection } from "../../shared/contracts";
import { fail } from "../errors";
import {
  correctionFields,
  correctionMetadata,
  correctionSnapshot,
  isCorrectionRetired,
  memoryMetadata,
} from "../services/memory-revision";
import { entries, govern, type MemoryEntryRow, validateEntrySources } from "./memory-repository";
import { DEFAULT_USER_ID, newId, nowIso, type Orm } from "./repositories";
import * as schema from "./schema";

export function memoryRevision(row: MemoryEntryRow): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        row.id,
        row.name,
        row.summary,
        row.tags,
        row.body,
        row.status,
        row.configSnapshot,
      ]),
    )
    .digest("hex");
}

/** Never expose a message from another agent, even if a damaged source points to it. */
export function memoryContent(orm: Orm, agentId: string, memoryId: string): MemoryContentResponse {
  const row = entries(orm, agentId, [memoryId])[0];
  const links = orm
    .select()
    .from(schema.memorySources)
    .where(eq(schema.memorySources.memoryId, row.id))
    .all();
  const sourceMessages: MemoryContentResponse["source_messages"] = [];
  const sources: ContentItem["sources"] = links.map((link) => {
    const turn = orm.select().from(schema.turns).where(eq(schema.turns.id, link.turnId)).get();
    const session = turn
      ? orm.select().from(schema.sessions).where(eq(schema.sessions.id, turn.sessionId)).get()
      : undefined;
    const owned = session?.agentId === agentId && session?.userId === DEFAULT_USER_ID;
    const user = owned
      ? orm
          .select()
          .from(schema.messages)
          .where(
            and(
              eq(schema.messages.id, link.userMessageId),
              eq(schema.messages.turnId, link.turnId),
              eq(schema.messages.sessionId, session.id),
              eq(schema.messages.role, "user"),
            ),
          )
          .get()
      : undefined;
    const assistant = owned
      ? orm
          .select()
          .from(schema.messages)
          .where(
            and(
              eq(schema.messages.id, link.assistantMessageId),
              eq(schema.messages.turnId, link.turnId),
              eq(schema.messages.sessionId, session.id),
              eq(schema.messages.role, "assistant"),
            ),
          )
          .get()
      : undefined;
    const valid = Boolean(
      owned &&
        turn?.sourceValid === 1 &&
        turn.generationStatus === "completed" &&
        user?.status === "completed" &&
        assistant?.status === "completed",
    );
    sourceMessages.push({
      turn_id: link.turnId,
      session_title: owned ? session.title : null,
      user: user?.status === "completed" ? user.content : null,
      assistant: assistant?.status === "completed" ? assistant.content : null,
    });
    return {
      type: "chat",
      turn_id: link.turnId,
      session_id: owned ? session.id : null,
      user_message_id: link.userMessageId,
      assistant_message_id: link.assistantMessageId,
      sequence_no: link.sequenceNo,
      valid,
    };
  });
  return {
    content: {
      id: row.id,
      source_type: "memory",
      content_origin:
        correctionMetadata(row.configSnapshot) !== null ? "manual_correction" : "derived",
      name: row.name,
      summary: row.summary,
      tags: JSON.parse(row.tags) as string[],
      body: row.body,
      revision: memoryRevision(row),
      sources,
      validity:
        sources.length > 0 && sources.every((source) => source.valid) && row.status !== "invalid"
          ? "valid"
          : "invalid",
    },
    status: row.status as MemoryContentResponse["status"],
    corrected: correctionMetadata(row.configSnapshot) !== null,
    retired: isCorrectionRetired(row.configSnapshot),
    source_messages: sourceMessages,
  };
}

/** Immutable correction. Caller holds BEGIN IMMEDIATE across all steps. */
export function correctMemory(
  orm: Orm,
  agentId: string,
  id: string,
  input: MemoryCorrection,
): MemoryContentResponse {
  const row = entries(orm, agentId, [id])[0];
  if (memoryRevision(row) !== input.expected_revision)
    fail("MEMORY_STATE_CONFLICT", "记忆已变化，请重新加载后纠正");
  if (!["active", "suppressed"].includes(row.status) || isCorrectionRetired(row.configSnapshot))
    fail("MEMORY_STATE_CONFLICT", "只能纠正有效或屏蔽的当前记忆");
  const detail = memoryContent(orm, agentId, id);
  if (detail.content.validity !== "valid") fail("MEMORY_SOURCE_INVALID", "记忆来源缺失或已失效");
  const sources = validateEntrySources(orm, [row]);
  const affected = new Set([id]);
  const links = orm.select().from(schema.memoryLinks).all();
  const ownedIds = new Set(entries(orm, agentId).map((item) => item.id));
  let changed = true;
  while (changed) {
    changed = false;
    for (const link of links) {
      if (
        affected.has(link.parentId) &&
        ownedIds.has(link.childId) &&
        !affected.has(link.childId)
      ) {
        affected.add(link.childId);
        changed = true;
      }
    }
  }
  const retired = entries(orm, agentId, [...affected]);
  const rejected = retired.flatMap((item) => [
    { name: item.name, summary: item.summary, body: item.body },
    ...(correctionMetadata(item.configSnapshot)?.rejected ?? []),
  ]);
  const uniqueRejected = [
    ...new Map(rejected.map((item) => [JSON.stringify(item), item])).values(),
  ];
  // Governance invalidates jobs before the records they observed are changed.
  govern(orm, agentId, [...affected], "suppress");
  for (const item of retired) {
    orm
      .update(schema.memoryEntries)
      .set({
        status: item.id === id ? "replaced" : "suppressed",
        configSnapshot: JSON.stringify({
          ...memoryMetadata(item.configSnapshot),
          correction_retired: true,
        }),
      })
      .where(eq(schema.memoryEntries.id, item.id))
      .run();
  }
  const replacementId = newId();
  orm
    .insert(schema.memoryEntries)
    .values({
      ...row,
      ...correctionFields(input),
      id: replacementId,
      status: row.status,
      configSnapshot: correctionSnapshot(row.configSnapshot, id, uniqueRejected),
      createdAt: nowIso(),
    })
    .run();
  for (const source of sources)
    orm
      .insert(schema.memorySources)
      .values({ ...source, memoryId: replacementId })
      .run();
  orm.insert(schema.memoryLinks).values({ parentId: id, childId: replacementId }).run();
  const turnIds = orm
    .select()
    .from(schema.memorySources)
    .where(inArray(schema.memorySources.memoryId, [...affected]))
    .all()
    .map((source) => source.turnId);
  const summaryIds = orm
    .select()
    .from(schema.summarySources)
    .where(inArray(schema.summarySources.turnId, turnIds))
    .all()
    .map((source) => source.summaryId);
  if (summaryIds.length > 0)
    orm
      .update(schema.sessionSummaries)
      .set({ isValid: 0, invalidatedAt: nowIso(), invalidationReason: "memory_corrected" })
      .where(
        and(
          eq(schema.sessionSummaries.agentId, agentId),
          inArray(schema.sessionSummaries.id, summaryIds),
        ),
      )
      .run();
  return memoryContent(orm, agentId, replacementId);
}

/** Corrections constrain regeneration; historical messages themselves remain intact. */
export function correctionsForTurns(orm: Orm, agentId: string, turnIds: string[]) {
  const allowed = new Set(turnIds);
  return entries(orm, agentId, undefined, { status: "active" })
    .filter((entry) => correctionMetadata(entry.configSnapshot) !== null)
    .flatMap((entry) => {
      const detail = memoryContent(orm, agentId, entry.id);
      const ids = detail.content.sources
        .filter((source) => source.type === "chat" && allowed.has(source.turn_id))
        .map((source) => (source.type === "chat" ? source.turn_id : ""));
      return detail.content.validity === "valid" && ids.length > 0
        ? [{ id: entry.id, body: entry.body, revision: detail.content.revision, source_ids: ids }]
        : [];
    });
}
