import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import type { SourceRef } from "../../shared/contracts/evidence";
import { memoryRevision } from "../db/memory-content-repository";
import type { MemoryEntryRow } from "../db/memory-repository";
import type { Orm } from "../db/repositories";
import * as schema from "../db/schema";

/** Metadata only: source URLs, auth tokens, image bytes and source bodies never enter references. */
export function turnSources(orm: Orm, ids: readonly string[]): SourceRef[] {
  if (ids.length === 0) return [];
  return orm
    .select()
    .from(schema.turns)
    .where(inArray(schema.turns.id, [...new Set(ids)]))
    .all()
    .map((turn) => ({
      kind: "web_turn",
      id: turn.id,
      revision: turn.generationToken ?? "completed",
    }));
}

/** Long-term memory is its own durable source; it does not inherit the raw QQ text lifetime. */
export function memoryEntrySources(_orm: Orm, rows: readonly MemoryEntryRow[]): SourceRef[] {
  return rows.map((row) => ({ kind: "memory", id: row.id, revision: memoryRevision(row) }));
}

export function observationSourcesForRun(orm: Orm, ids: readonly string[]): SourceRef[] {
  if (ids.length === 0) return [];
  return orm
    .select()
    .from(schema.qqObservationText)
    .where(inArray(schema.qqObservationText.eventKey, [...new Set(ids)]))
    .all()
    .map((row) => ({
      kind: "qq_observation",
      id: row.eventKey,
      revision: createHash("sha256").update(row.body).digest("hex"),
      expiresAt: row.expiresAt,
    }));
}

/** Candidate snapshots keep the grant token so revoke/regrant cannot authorize old snapshots. */
export function selectionSources(
  orm: Orm,
  candidates: readonly Record<string, unknown>[],
  agentId?: string,
): SourceRef[] {
  const refs: SourceRef[] = [];
  const memoryIds = candidates
    .filter((item) => item.source_type === "memory")
    .map((item) => String(item.id));
  if (memoryIds.length > 0) {
    const rows = orm
      .select()
      .from(schema.memoryEntries)
      .where(inArray(schema.memoryEntries.id, memoryIds))
      .all();
    refs.push(...memoryEntrySources(orm, rows));
  }
  const documents = new Set<string>();
  for (const candidate of candidates) {
    // KnowledgeContext candidates contain contentBlocks: [{id, source_type, sources:[document]}].
    const blocks = Array.isArray(candidate.sources) ? candidate.sources : [];
    for (const block of blocks) {
      if (typeof block !== "object" || block === null) continue;
      const sources = Array.isArray(block.sources) ? block.sources : [];
      for (const source of sources) {
        if (source.type !== "document") continue;
        refs.push({
          kind: "knowledge_document",
          id: source.document_id,
          revision: String(source.version),
        });
        documents.add(source.document_id);
      }
    }
  }
  if (agentId)
    for (const documentId of documents) {
      const grant = orm
        .select()
        .from(schema.knowledgeGrants)
        .where(
          and(
            eq(schema.knowledgeGrants.documentId, documentId),
            eq(schema.knowledgeGrants.agentId, agentId),
          ),
        )
        .get();
      if (grant)
        refs.push({
          kind: "knowledge_grant",
          id: JSON.stringify([documentId, agentId]),
          revision: grant.token,
        });
    }
  return [...new Map(refs.map((ref) => [`${ref.kind}:${ref.id}`, ref])).values()];
}
