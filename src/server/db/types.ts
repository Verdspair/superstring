// Status / enum literal constants for the 16 business tables.
//
// Source of truth: docs/reference/data-model.md §3 (枚举/状态值全集). These
// literals are what gets stored in the database and MUST match exactly — they
// are referenced by CHECK constraints (see schema.ts / 0001_initial.sql) and by
// the repositories that write these columns.
//
// Boolean columns are stored as INTEGER 0/1 per the type-mapping rule in
// data-model.md §0 (Boolean -> INTEGER(0/1) with CHECK IN (0,1)); the
// BOOL_TRUE / BOOL_FALSE / SqlBoolean helpers encode that contract.

// messages.role (data-model.md:415)
export const MessageRole = {
  User: "user",
  Assistant: "assistant",
  System: "system",
} as const;
export type MessageRole = (typeof MessageRole)[keyof typeof MessageRole];

// messages.status (data-model.md:416)
export const MessageStatus = {
  Pending: "pending",
  Completed: "completed",
  Failed: "failed",
  Cancelled: "cancelled",
} as const;
export type MessageStatus = (typeof MessageStatus)[keyof typeof MessageStatus];

// turns.generation_status (data-model.md:417)
export const TurnGenerationStatus = {
  Active: "active",
  Completed: "completed",
  Failed: "failed",
  Cancelled: "cancelled",
} as const;
export type TurnGenerationStatus = (typeof TurnGenerationStatus)[keyof typeof TurnGenerationStatus];

// sessions.mode (data-model.md:423)
export const SessionMode = {
  Chat: "chat",
  Work: "work",
} as const;
export type SessionMode = (typeof SessionMode)[keyof typeof SessionMode];

// memory_entries.status (data-model.md:420)
export const MemoryEntryStatus = {
  Active: "active",
  Suppressed: "suppressed",
  Replaced: "replaced",
  Invalid: "invalid",
} as const;
export type MemoryEntryStatus = (typeof MemoryEntryStatus)[keyof typeof MemoryEntryStatus];

// memory_jobs.status (data-model.md:421)
export const MemoryJobStatus = {
  Queued: "queued",
  Running: "running",
  Succeeded: "succeeded",
  Failed: "failed",
} as const;
export type MemoryJobStatus = (typeof MemoryJobStatus)[keyof typeof MemoryJobStatus];

// memory_jobs.kind — free-form string, "merge" observed (memory_repository.py:158).
// No CHECK enum; provided here only as the documented example literal.
export const MemoryJobKind = {
  Merge: "merge",
} as const;

// message_deletion_events.role (data-model.md:424)
export const DeletionEventRole = {
  User: "user",
  Assistant: "assistant",
} as const;
export type DeletionEventRole = (typeof DeletionEventRole)[keyof typeof DeletionEventRole];

// message_deletion_events.reason — example literal (repositories.py:260)
export const DeletionEventReason = {
  UserRequested: "user_requested",
} as const;

// session_summaries.template_version — written value "p5-1" (context_repository.py:224)
export const SummaryTemplateVersion = {
  P5_1: "p5-1",
} as const;

// memory_session_states.scope — legacy label, default "reality_user" (models.py:397)
export const MemoryScope = {
  RealityUser: "reality_user",
} as const;
export type MemoryScope = (typeof MemoryScope)[keyof typeof MemoryScope];

// turns.invalidation_reason — example literals (repositories.py:345,583,833)
export const TurnInvalidationReason = {
  MessageDeleted: "message_deleted",
  GenerationLeaseExpired: "generation_lease_expired",
  GenerationFailed: "generation_failed",
} as const;

// Boolean storage contract (data-model.md §0): INTEGER 0/1
export const BOOL_TRUE = 1 as const;
export const BOOL_FALSE = 0 as const;
export type SqlBoolean = 0 | 1;

/** Encode a JS boolean into the INTEGER 0/1 storage literal. */
export function toSqlBoolean(value: boolean): SqlBoolean {
  return value ? BOOL_TRUE : BOOL_FALSE;
}
