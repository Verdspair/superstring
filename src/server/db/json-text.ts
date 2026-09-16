// JSON stored as TEXT in SQLite.
//
// Source: docs/reference/data-model.md §0 (JSON -> TEXT, no native JSON type) and
// §4.3-4.4 (object key order / array order semantics).
//
// Contract:
//  - Serialization uses a *canonical* form: object keys are sorted recursively
//    so that two semantically-equal objects always produce a byte-identical
//    string. This yields stable equality / dedup and avoids non-deterministic
//    diffs when the same JSON is written more than once.
//  - Array element ORDER is preserved exactly (arrays are never sorted). Order
//    carries meaning for: memory_jobs.turn_ids / memory_ids (sorted at write time
//    in memory_repository.py:177), memory_entries.tags / kinds, and the inline
//    fact/source arrays inside memory_entries.body / session_summaries.content.
//  - Timestamp / microsecond precision is the caller's responsibility; this
//    module only (de)serializes plain JSON values.

/**
 * Serialize a value to a canonical JSON string: object keys sorted recursively,
 * arrays left in their original order.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

/**
 * Parse a JSON string previously produced by {@link stableStringify} (or any
 * valid JSON text) back into a value of type T.
 */
export function parseJson<T = unknown>(text: string): T {
  return JSON.parse(text) as T;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    // Preserve array order — do not sort.
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      out[key] = sortKeys(record[key]);
    }
    return out;
  }
  return value;
}
