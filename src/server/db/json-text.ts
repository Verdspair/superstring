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

/**
 * Canonical JSON serializer: object keys sorted recursively, arrays left in their
 * original order. This is the single implementation — `contextDumps` (the name the
 * context/observability callers use) and `stableStringify` (the storage-contract name)
 * are the same function, so a stored row and a context dump can never disagree about
 * key order. Pure JSON handling only; no SQLite I/O here.
 */
function canonicalJson(value: unknown): string {
  const sorted = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(sorted);
    if (item !== null && typeof item === "object") {
      const source = item as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(source)
          .sort()
          .map((key) => [key, sorted(source[key])]),
      );
    }
    return item;
  };
  return JSON.stringify(sorted(value));
}

/** Storage-contract name (SQLite TEXT columns). */
export const stableStringify = canonicalJson;

/** Context/observability name (context dumps, omissions, notes). */
export const contextDumps = canonicalJson;
