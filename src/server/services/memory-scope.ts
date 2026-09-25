import { type QqMemoryAccess, qqMemoryScopeKey } from "./qq-binding-contract";

// Memory scope keys are opaque strings stored in `memory_entries.scope_key`.
// Web conversation memory keeps the historical agent-level key (`scopeKey()` in
// memory-contract.ts returns the agent id), and those rows must stay readable by
// web callers exactly as before. QQ conversations add their own key, so filtering
// is opt-in: `null` means "no scope filter" (agent-level, today's behaviour) and a
// list means "only these scopes". `qqMemoryScopeKey` owns the web/Qq key spellings
// so a shared read matches the very rows web already wrote.
//
// An empty list is NOT the same as `null`: it matches nothing, so a caller that
// resolved no readable scope fails closed instead of silently falling back to the
// whole agent.
export type MemoryScopeKeys = readonly string[] | null;

export interface MemoryScopeKeyset {
  /** Scopes a read may draw from. `null` = agent-level (unscoped) read. */
  readonly read: MemoryScopeKeys;
  /** Single `scope_key` written for a new memory and frozen into the job snapshot. */
  readonly write: string;
  /** Digest input so a mid-scan scope change invalidates a catalog scan. */
  readonly fingerprintSeed: string;
}

function seedOf(keys: MemoryScopeKeys): string {
  return keys === null ? "agent" : JSON.stringify(keys);
}

/** Web conversations read and write agent-level memory, as before. */
export function webMemoryScopeKeyset(agentId: string): MemoryScopeKeyset {
  return Object.freeze({ read: null, write: agentId, fingerprintSeed: seedOf(null) });
}

/** A QQ conversation reads its own scope and, only when sharing is on, the web scope. */
export function qqMemoryScopeKeyset(access: QqMemoryAccess): MemoryScopeKeyset {
  const read = Object.freeze(access.readScopes.map(qqMemoryScopeKey));
  return Object.freeze({
    read,
    write: qqMemoryScopeKey(access.writeScope),
    fingerprintSeed: seedOf(read),
  });
}

/** True when a stored `scope_key` is visible to the given read scope. */
export function scopeKeyVisible(scopeKey: string, keys: MemoryScopeKeys): boolean {
  return keys === null ? true : keys.includes(scopeKey);
}
