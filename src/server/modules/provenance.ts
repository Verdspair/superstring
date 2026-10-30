import { inArray } from "drizzle-orm";
import type { SourceRef } from "../../shared/contracts/evidence";
import type { MemoryEntryRow } from "../db/memory-repository";
import type { Orm } from "../db/repositories";
import * as schema from "../db/schema";
import { memoryRevision } from "../services/memory-revision";

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
