import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type {
  ContentItem,
  MemoryContentResponse,
  MemoryCorrection,
  MemoryVisibilityUpdate,
} from "../../shared/contracts";
import type { SourceRef } from "../../shared/contracts/evidence";
import { AppError, fail } from "../errors";
import { MEMORY_SEARCH_FOLD_VERSION, memorySearchProjection } from "../services/memory-contract";
import {
  correctionFields,
  correctionMetadata,
  correctionSnapshot,
  isCorrectionRetired,
  memoryMetadata,
  memoryRevision,
} from "../services/memory-revision";
import { memoryAccessRefs, memoryConversationForSession } from "../services/memory-scope";
import { assertQqRouteCurrent, entries, govern, validateEntrySources } from "./memory-repository";
import {
  issueMemoryPublications,
  memorySourceFactAssessment,
  observationContentSources,
  observationSources,
  retainedMemoryPublications,
} from "./memory-source-repository";
import { DEFAULT_USER_ID, newId, nowIso, type Orm } from "./repositories";
import * as schema from "./schema";

/** Never expose a message from another agent, even if a damaged source points to it. */
export function memoryContent(orm: Orm, agentId: string, memoryId: string): MemoryContentResponse {
  const row = entries(orm, agentId, [memoryId])[0];
  const facts = memorySourceFactAssessment(orm, [row]);
  const links = facts.webSources.get(row.id) ?? [];
  const observations = [...(facts.observationSources.get(row.id) ?? [])];
  const sessions = facts.webSessions.get(row.id) ?? [];
  const chatSources: ContentItem["sources"] = links.map((link, index) => ({
    type: "chat",
    turn_id: link.turnId,
    session_id: facts.webValidity.get(JSON.stringify([row.id, link.turnId]))
      ? (sessions[index] ?? null)
      : null,
    user_message_id: link.userMessageId,
    assistant_message_id: link.assistantMessageId,
    sequence_no: link.sequenceNo,
    valid: facts.webValidity.get(JSON.stringify([row.id, link.turnId])) === true,
  }));
  let sourcesValid = false;
  try {
    if (Object.hasOwn(memoryMetadata(row.configSnapshot), "qq_route"))
      assertQqRouteCurrent(orm, agentId, row.configSnapshot);
    validateEntrySources(orm, [row]);
    sourcesValid = true;
  } catch (error) {
    if (
      !(error instanceof AppError) ||
      !["MEMORY_SOURCE_INVALID", "MEMORY_STATE_CONFLICT"].includes(error.code)
    )
      throw error;
  }
  const sources: ContentItem["sources"] = [
    ...chatSources,
    ...observationContentSources(observations, facts.observationValidity),
  ];
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
        sources.length > 0 &&
        sources.every((source) => source.valid) &&
        row.status !== "invalid" &&
        sourcesValid
          ? "valid"
          : "invalid",
    },
    status: row.status as MemoryContentResponse["status"],
    corrected: correctionMetadata(row.configSnapshot) !== null,
    retired: isCorrectionRetired(row.configSnapshot),
  };
}

/** Caller owns the management transaction. */
export function setMemoryVisibility(
  orm: Orm,
  agentId: string,
  id: string,
  input: MemoryVisibilityUpdate,
): { visibility: string; visibility_revision: number; recipient_agent_ids: string[] } {
  const row = entries(orm, agentId, [id])[0]!;
  if (row.visibilityRevision !== input.expected_revision)
    fail("MEMORY_STATE_CONFLICT", "记忆授权已变化，请重新加载");
  const recipients = [...input.recipient_agent_ids].sort();
  if (
    (input.visibility === "session_private" && recipients.length !== 0) ||
    (input.visibility === "agent_shared" &&
      (recipients.length !== 1 || recipients[0] !== agentId)) ||
    (input.visibility === "public" && recipients.length === 0)
  )
    fail("MEMORY_STATE_CONFLICT", "接收助手与可见范围不一致");
  if (recipients.length) {
    const known = orm
      .select({ id: schema.agents.id })
      .from(schema.agents)
      .where(inArray(schema.agents.id, recipients))
      .all();
    if (known.length !== recipients.length) fail("AGENT_NOT_FOUND", "接收助手不存在", 404);
  }
  const current = orm
    .select()
    .from(schema.memoryReadGrants)
    .where(eq(schema.memoryReadGrants.memoryId, id))
    .all();
  const previous = current.map((grant) => grant.agentId).sort();
  const sameRecipients = JSON.stringify(previous) === JSON.stringify(recipients);
  const same = row.visibility === input.visibility && sameRecipients;
  const subset = recipients.every((recipient) => previous.includes(recipient));
  const contraction =
    input.visibility === "session_private" ||
    (row.visibility === input.visibility && subset && recipients.length < previous.length) ||
    (row.visibility === "public" &&
      input.visibility === "agent_shared" &&
      subset &&
      recipients.length === 1 &&
      recipients[0] === agentId);
  if (!contraction && (row.status !== "active" || isCorrectionRetired(row.configSnapshot)))
    fail("MEMORY_STATE_CONFLICT", "只能发布有效记忆");
  let publication = row.publicationSourceRevision;
  let reissued = false;
  if (input.visibility === "session_private") publication = null;
  else if (!contraction) {
    if (
      same &&
      !input.revalidate_publication &&
      retainedMemoryPublications(orm, [row], nowIso()).has(id)
    ) {
      return {
        visibility: input.visibility,
        visibility_revision: row.visibilityRevision,
        recipient_agent_ids: recipients,
      };
    }
    if (same && !input.revalidate_publication)
      fail("MEMORY_SOURCE_INVALID", "发布依据无法验证，请显式重新验证发布依据或撤销接收者");
    publication = issueMemoryPublications(orm, [row], nowIso()).get(id) ?? null;
    if (!publication)
      fail(
        "MEMORY_SOURCE_INVALID",
        "无法重新验证发布依据：来源原文已到期、缺失或授权变化；现有接收授权未变",
      );
    reissued = input.revalidate_publication === true;
  }
  if (same && row.publicationSourceRevision === publication && !reissued) {
    return {
      visibility: input.visibility,
      visibility_revision: row.visibilityRevision,
      recipient_agent_ids: recipients,
    };
  }
  const result = orm
    .update(schema.memoryEntries)
    .set({
      visibility: input.visibility,
      visibilityRevision: row.visibilityRevision + 1,
      publicationSourceRevision: publication,
    })
    .where(
      and(
        eq(schema.memoryEntries.id, id),
        eq(schema.memoryEntries.visibilityRevision, input.expected_revision),
      ),
    )
    .returning({ id: schema.memoryEntries.id })
    .get();
  if (!result) fail("MEMORY_STATE_CONFLICT", "记忆授权已变化，请重新加载");
  for (const grant of current) {
    if (!recipients.includes(grant.agentId))
      orm
        .delete(schema.memoryReadGrants)
        .where(
          and(
            eq(schema.memoryReadGrants.memoryId, id),
            eq(schema.memoryReadGrants.agentId, grant.agentId),
          ),
        )
        .run();
  }
  const existing = new Set(previous);
  for (const recipient of recipients) {
    if (!existing.has(recipient))
      orm
        .insert(schema.memoryReadGrants)
        .values({ memoryId: id, agentId: recipient, token: crypto.randomUUID() })
        .run();
    else if (
      !contraction &&
      (reissued ||
        row.visibility !== input.visibility ||
        row.publicationSourceRevision !== publication)
    )
      orm
        .update(schema.memoryReadGrants)
        .set({ token: crypto.randomUUID() })
        .where(
          and(
            eq(schema.memoryReadGrants.memoryId, id),
            eq(schema.memoryReadGrants.agentId, recipient),
          ),
        )
        .run();
  }
  return {
    visibility: input.visibility,
    visibility_revision: row.visibilityRevision + 1,
    recipient_agent_ids: recipients,
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
  const fields = correctionFields(input);
  orm
    .insert(schema.memoryEntries)
    .values({
      ...row,
      ...fields,
      id: replacementId,
      visibility: "session_private",
      visibilityRevision: 1,
      publicationSourceRevision: null,
      foldedSearch: memorySearchProjection({ id: replacementId, ...fields }),
      foldVersion: MEMORY_SEARCH_FOLD_VERSION,
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
  // A corrected QQ memory keeps its observation provenance; dropping it would leave
  // the replacement with no evidence and therefore unusable.
  for (const observation of observationSources(orm, [id]).get(id) ?? [])
    orm
      .insert(schema.qqMemorySources)
      .values({ ...observation, memoryId: replacementId })
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
export interface CorrectionScan {
  id: string;
  body: string;
  revision: string;
  /** All chat turn ids of this entry, in the entry's source order. */
  source_ids: string[];
  validity: "valid" | "invalid";
  source: SourceRef | null;
}

/**
 * One active-correction scan for a call site. Per-entry validity is computed with
 * the same projections and predicates as `memoryContent` on same-call batched
 * maps; the result is a plain value (never persisted, never reused across calls).
 */
export function activeCorrections(
  orm: Orm,
  agentId: string,
  qualify: (ids: readonly string[]) => ReadonlyMap<string, SourceRef>,
): CorrectionScan[] {
  const correctionEntries = orm
    .select()
    .from(schema.memoryEntries)
    .where(
      and(
        eq(schema.memoryEntries.agentId, agentId),
        eq(schema.memoryEntries.userId, DEFAULT_USER_ID),
        inArray(schema.memoryEntries.status, ["active", "suppressed", "invalid", "replaced"]),
        sql`CASE WHEN json_valid(${schema.memoryEntries.configSnapshot}) THEN (json_type(${schema.memoryEntries.configSnapshot},'$.content_correction.replaces')='text' OR json_extract(${schema.memoryEntries.configSnapshot},'$.correction_retired')=1) ELSE 0 END`,
      ),
    )
    .orderBy(desc(schema.memoryEntries.createdAt), schema.memoryEntries.id)
    .all();
  if (!correctionEntries.length) return [];
  const refs = qualify(correctionEntries.map((entry) => entry.id));
  const currentIds = new Set(
    correctionEntries
      .filter(
        (entry) =>
          entry.status === "active" &&
          refs.has(entry.id) &&
          !isCorrectionRetired(entry.configSnapshot),
      )
      .map((entry) => entry.id),
  );
  const descendants = orm
    .select()
    .from(schema.memoryLinks)
    .where(
      sql`${schema.memoryLinks.parentId} IN (SELECT value FROM json_each(${JSON.stringify(correctionEntries.map((entry) => entry.id))}))`,
    )
    .all();
  const hasCurrentDescendant = (id: string): boolean => {
    const pending = [id],
      seen = new Set<string>();
    while (pending.length) {
      const parent = pending.pop()!;
      if (seen.has(parent)) continue;
      seen.add(parent);
      for (const link of descendants)
        if (link.parentId === parent) {
          if (currentIds.has(link.childId)) return true;
          pending.push(link.childId);
        }
    }
    return false;
  };
  const eligible = correctionEntries.filter(
    (entry) => !isCorrectionRetired(entry.configSnapshot) || !hasCurrentDescendant(entry.id),
  );
  const links = loadMemorySourcesOrdered(
    orm,
    eligible.map((entry) => entry.id),
  );
  return eligible.map((entry) => ({
    id: entry.id,
    body: currentIds.has(entry.id) ? entry.body : "",
    revision: memoryRevision(entry),
    source: refs.get(entry.id) ?? null,
    source_ids: (links.get(entry.id) ?? []).map((source) => source.turnId),
    validity: currentIds.has(entry.id) ? ("valid" as const) : ("invalid" as const),
  }));
}

/** Apply a prepared scan to one allowed turn set; same rule as the per-call reader. */
export function correctionsForTurnsFrom(scan: CorrectionScan[], turnIds: string[]) {
  const allowed = new Set(turnIds);
  return scan.flatMap((entry) => {
    const ids = entry.source_ids.filter((id) => allowed.has(id));
    if (ids.length > 0 && (entry.validity !== "valid" || entry.source === null))
      fail("CONTEXT_SOURCE_INVALID", "历史已有纠正但当前无权读取，不能恢复旧错误正文");
    return entry.validity === "valid" && entry.source !== null && ids.length > 0
      ? [
          {
            id: entry.id,
            body: entry.body,
            revision: entry.revision,
            source_ids: ids,
            source: entry.source!,
          },
        ]
      : [];
  });
}

/**
 * Every turn source of the given memories, grouped by memory id, in PK-index
 * (memory_id, turn_id) order — the same order the former per-memory query
 * returned, so `source_ids` order is unchanged.
 */
function loadMemorySourcesOrdered(
  orm: Orm,
  memoryIds: string[],
): Map<string, Array<typeof schema.memorySources.$inferSelect>> {
  const grouped = new Map<string, Array<typeof schema.memorySources.$inferSelect>>();
  if (memoryIds.length === 0) return grouped;
  const rows = orm
    .select()
    .from(schema.memorySources)
    .where(inArray(schema.memorySources.memoryId, memoryIds))
    .orderBy(schema.memorySources.memoryId, schema.memorySources.turnId)
    .all();
  for (const row of rows) {
    const list = grouped.get(row.memoryId);
    if (list) list.push(row);
    else grouped.set(row.memoryId, [row]);
  }
  return grouped;
}

/** Relevant retained turns do not substitute for the full canonical source authorization. */
export function conversationCorrectionScan(
  orm: Orm,
  agentId: string,
  sessionId: string,
): CorrectionScan[] {
  const access = memoryConversationForSession(orm, agentId, sessionId, DEFAULT_USER_ID);
  if (!access) fail("CONTEXT_SOURCE_INVALID", "会话记忆资格已失效，不能恢复原历史");
  return activeCorrections(orm, agentId, (ids) => memoryAccessRefs(orm, access, ids));
}
export function conversationCorrections(
  orm: Orm,
  agentId: string,
  sessionId: string,
  turnIds: string[],
) {
  return correctionsForTurnsFrom(conversationCorrectionScan(orm, agentId, sessionId), turnIds);
}
