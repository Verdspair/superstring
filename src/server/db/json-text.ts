// JSON stored as TEXT in SQLite.
// See docs/reference/data-model.md §0 (JSON -> TEXT, no native JSON type) and
// §4.3-4.4 (object key order / array order semantics).
// Contract:
// - Serialization uses a *canonical* form: object keys are sorted recursively
// so that two semantically-equal objects always produce a byte-identical
// string. This yields stable equality / dedup and avoids non-deterministic
// diffs when the same JSON is written more than once.
// - Array element ORDER is preserved exactly (arrays are never sorted). Order
// carries meaning for: memory_jobs.turn_ids / memory_ids (sorted at write time
// in), memory_entries.tags / kinds, and the inline
// fact/source arrays inside memory_entries.body / session_summaries.content.
// - Timestamp / microsecond precision is the caller's responsibility; this
// module only (de)serializes plain JSON values.

import { contextDumps } from "../modules/memory-query";

/**
 * Serialize a value to a canonical JSON string: object keys sorted recursively
 * arrays left in their original order.
 */
export function stableStringify(value: unknown): string {
  return contextDumps(value);
}
