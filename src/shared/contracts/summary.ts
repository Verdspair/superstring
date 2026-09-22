import { z } from "zod";
import { IsoTimestampSchema, MemoryEntryStatusSchema } from "./common";

/**
 * Memory "summary" (摘要) and "source" (来源) contracts. Pure `zod` only.
 * See api-contract.md §1.4 (entries item), §4.4 (entry status), §7.2.
 *
 * `MemorySummarySchema` is the per-entry summary shape returned in the entries
 * list; `MemorySourceSchema` captures the provenance (scope/scope_key) of an
 * entry, which resolves to the owning agent id.
 */

/** Entry list-item / summary view (api-contract.md §1.4). */
export const MemorySummarySchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  summary: z.string(),
  tags: z.array(z.string()),
  kinds: z.array(z.string()),
  status: MemoryEntryStatusSchema,
  created_at: IsoTimestampSchema,
  scope: z.string(),
  scope_key: z.string(),
});

export type MemorySummary = z.infer<typeof MemorySummarySchema>;

/** Provenance / source reference of a memory entry (scope + scope_key). */
export const MemorySourceSchema = z.strictObject({
  scope: z.string(),
  scope_key: z.string(),
});

export type MemorySource = z.infer<typeof MemorySourceSchema>;
