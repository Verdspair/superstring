import { z } from "zod";

/**
 * Error taxonomy: docs/reference/api-contract.md §6.2 (v2).
 * Extracted from AppError/fail/ModelUnavailableError call sites in the contract:
 * 57 HTTP codes (including 9 model codes), 1 SSE-only, 2 extra message-only
 * and 6 job-only codes = 66. HTTP codes may also travel over SSE
 * Pure data and Zod validation only.
 */

/** Every error code that exists in the contract (66). */
export const ERROR_CODES = [
  // core subclasses (12)
  "SESSION_NOT_FOUND",
  "MESSAGE_NOT_FOUND",
  "MESSAGE_DELETE_FORBIDDEN",
  "IDEMPOTENCY_CONFLICT",
  "IDEMPOTENCY_KEY_RETIRED",
  "GENERATION_ALREADY_ACTIVE",
  "SESSION_GENERATION_BUSY",
  "GENERATION_OWNERSHIP_LOST",
  "GENERATION_CANCELLED",
  "MODEL_EMPTY_RESPONSE",
  "DATABASE_UNAVAILABLE",
  "MODEL_SERVICE_UNAVAILABLE",
  // Agent / config / persona (7)
  "AGENT_NOT_FOUND",
  "AGENT_DISABLED",
  "AGENT_IN_USE",
  "DEFAULT_AGENT_DELETE_FORBIDDEN",
  "CONFIG_VERSION_CONFLICT",
  "PERSONA_NOT_FOUND",
  "MODE_NOT_AVAILABLE",
  // Validation / migration consistency (4)
  "VALIDATION_ERROR",
  "INVALID_MESSAGE_TURN",
  "INVALID_SESSION_CONFIG",
  "INVALID_TURN_CONFIG",
  // Context building (15)
  "CONTEXT_AUX_BUDGET",
  "CONTEXT_AUX_ERROR",
  "CONTEXT_AUX_TIMEOUT",
  "CONTEXT_BUDGET_EXCEEDED",
  "CONTEXT_CAPACITY_ERROR",
  "CONTEXT_CAPACITY_INSUFFICIENT",
  "CONTEXT_CAPACITY_TIMEOUT",
  "CONTEXT_CAPACITY_UNKNOWN",
  "CONTEXT_CATALOG_LIMIT",
  "CONTEXT_INVALID_RESULT",
  "CONTEXT_INVALID_SELECTION",
  "CONTEXT_MEMORY_BUDGET",
  "CONTEXT_RECALL_BUDGET",
  "CONTEXT_SOURCE_INVALID",
  "CONTEXT_SUMMARY_BUDGET",
  // Memory domain, HTTP-visible (11)
  "MEMORY_FORBIDDEN",
  "MEMORY_SOURCE_FORBIDDEN",
  "MEMORY_NOT_FOUND",
  "MEMORY_JOB_NOT_FOUND",
  "MEMORY_BUSY",
  "MEMORY_POLICY_CONFLICT",
  "MEMORY_REQUEST_CONFLICT",
  "MEMORY_SOURCE_CHANGED",
  "MEMORY_SOURCE_INVALID",
  "MEMORY_STATE_CONFLICT",
  "MEMORY_JOB_OWNERSHIP_LOST",
  // Model gateway, ModelUnavailableError (9, default 503)
  "MODEL_NOT_LOADED",
  "MODEL_TIMEOUT",
  "MODEL_ERROR",
  "MODEL_CAPACITY_AMBIGUOUS",
  "MODEL_CAPACITY_UNAVAILABLE",
  "MODEL_OUTPUT_LIMIT",
  "MODEL_FINISH_UNSUPPORTED",
  "MODEL_STREAM_INTERRUPTED",
  // SSE-only (1)
  "MESSAGE_PERSISTENCE_ERROR",
  // Message-level persisted (messages.error_code) (2 extra)
  "CLIENT_DISCONNECTED",
  "GENERATION_LEASE_EXPIRED",
  // Job-level persisted only (memory_jobs.error_code) (6)
  "MEMORY_WORKER_INTERRUPTED",
  "MEMORY_WORKER_STOPPED",
  "MEMORY_INVALID_RESULT",
  "MEMORY_GOVERNANCE_CHANGED",
  "MEMORY_TIMEOUT",
  "MEMORY_INPUT_TOO_LARGE",
] as const;

// Additive product features do not rewrite the error taxonomy.
export const KNOWLEDGE_ERROR_CODES = [
  "KNOWLEDGE_NOT_FOUND",
  "KNOWLEDGE_CATEGORY_NOT_FOUND",
  "KNOWLEDGE_REVISION_CONFLICT",
  "KNOWLEDGE_CATEGORY_NOT_EMPTY",
  "KNOWLEDGE_LAST_CATEGORY",
  "KNOWLEDGE_IMPORT_INVALID",
  "KNOWLEDGE_ACCESS_CHANGED",
  "KNOWLEDGE_SNAPSHOT_INVALID",
  "KNOWLEDGE_CONTEXT_BUDGET",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number] | (typeof KNOWLEDGE_ERROR_CODES)[number];

export const ErrorCodeSchema = z.enum([...ERROR_CODES, ...KNOWLEDGE_ERROR_CODES]);

/**
 * Only MESSAGE_PERSISTENCE_ERROR is SSE-exclusive.
 * MODEL_ERROR is an HTTP 503 code that may also be emitted over SSE;
 * 359 forwards any AppError raised during streaming.
 */
export const SSE_EXCLUSIVE_ERROR_CODES = ["MESSAGE_PERSISTENCE_ERROR"] as const;

/** Codes persisted onto `messages.error_code` (message-level semantics). */
export const MESSAGE_LEVEL_ERROR_CODES = [
  "GENERATION_CANCELLED",
  "CLIENT_DISCONNECTED",
  "GENERATION_LEASE_EXPIRED",
] as const;

/** Codes persisted onto `memory_jobs.error_code` (job-level semantics). */
export const JOB_LEVEL_ERROR_CODES = [
  "MEMORY_WORKER_INTERRUPTED",
  "MEMORY_WORKER_STOPPED",
  "MEMORY_INVALID_RESULT",
  "MEMORY_GOVERNANCE_CHANGED",
  "MEMORY_TIMEOUT",
  "MEMORY_INPUT_TOO_LARGE",
] as const;

/** Codes carried by `ModelUnavailableError`; HTTP 503 unless overridden. */
export const MODEL_LAYER_ERROR_CODES = [
  "MODEL_NOT_LOADED",
  "MODEL_TIMEOUT",
  "MODEL_ERROR",
  "MODEL_CAPACITY_AMBIGUOUS",
  "MODEL_CAPACITY_UNAVAILABLE",
  "MODEL_OUTPUT_LIMIT",
  "MODEL_FINISH_UNSUPPORTED",
  "MODEL_STREAM_INTERRUPTED",
  "MODEL_SERVICE_UNAVAILABLE",
] as const;

/**
 * HTTP status code for each error code that carries one
 * (`docs/reference/api-contract.md` §6.2.1–§6.2.6).
 * `CONTEXT_CAPACITY_ERROR` is the only code with two observed statuses:
 * 409 and 503.
 * 409 is used here as the default; the 503 branch is a per-call-site override
 * (capacity-probe failure). See `CONTEXT_CAPACITY_ERROR_ALT_STATUS`.
 * `MESSAGE_PERSISTENCE_ERROR` has no HTTP status — it only exists as an SSE
 * event — so it is deliberately absent.
 */
export const ERROR_HTTP_STATUS = {
  // core
  SESSION_NOT_FOUND: 404,
  MESSAGE_NOT_FOUND: 404,
  MESSAGE_DELETE_FORBIDDEN: 400,
  IDEMPOTENCY_CONFLICT: 409,
  IDEMPOTENCY_KEY_RETIRED: 409,
  GENERATION_ALREADY_ACTIVE: 409,
  SESSION_GENERATION_BUSY: 409,
  GENERATION_OWNERSHIP_LOST: 409,
  GENERATION_CANCELLED: 409,
  MODEL_EMPTY_RESPONSE: 502,
  DATABASE_UNAVAILABLE: 503,
  MODEL_SERVICE_UNAVAILABLE: 503,
  // agent / config / persona
  AGENT_NOT_FOUND: 404,
  AGENT_DISABLED: 409,
  AGENT_IN_USE: 409,
  DEFAULT_AGENT_DELETE_FORBIDDEN: 409,
  CONFIG_VERSION_CONFLICT: 409,
  PERSONA_NOT_FOUND: 409,
  MODE_NOT_AVAILABLE: 409,
  // validation / migration
  VALIDATION_ERROR: 422,
  INVALID_MESSAGE_TURN: 409,
  INVALID_SESSION_CONFIG: 409,
  INVALID_TURN_CONFIG: 409,
  // context building (`fail()` default is 409)
  CONTEXT_AUX_BUDGET: 409,
  CONTEXT_AUX_ERROR: 502,
  CONTEXT_AUX_TIMEOUT: 504,
  CONTEXT_BUDGET_EXCEEDED: 409,
  CONTEXT_CAPACITY_ERROR: 409,
  CONTEXT_CAPACITY_INSUFFICIENT: 409,
  CONTEXT_CAPACITY_TIMEOUT: 504,
  CONTEXT_CAPACITY_UNKNOWN: 409,
  CONTEXT_CATALOG_LIMIT: 409,
  CONTEXT_INVALID_RESULT: 502,
  CONTEXT_INVALID_SELECTION: 409,
  CONTEXT_MEMORY_BUDGET: 409,
  CONTEXT_RECALL_BUDGET: 409,
  CONTEXT_SOURCE_INVALID: 409,
  CONTEXT_SUMMARY_BUDGET: 409,
  // memory domain, HTTP-visible
  MEMORY_FORBIDDEN: 403,
  MEMORY_SOURCE_FORBIDDEN: 404,
  MEMORY_NOT_FOUND: 404,
  MEMORY_JOB_NOT_FOUND: 404,
  MEMORY_BUSY: 409,
  MEMORY_POLICY_CONFLICT: 409,
  MEMORY_REQUEST_CONFLICT: 409,
  MEMORY_SOURCE_CHANGED: 409,
  MEMORY_SOURCE_INVALID: 409,
  MEMORY_STATE_CONFLICT: 409,
  MEMORY_JOB_OWNERSHIP_LOST: 409,
  // model gateway (ModelUnavailableError default 503)
  MODEL_NOT_LOADED: 503,
  MODEL_TIMEOUT: 503,
  MODEL_ERROR: 503,
  MODEL_CAPACITY_AMBIGUOUS: 503,
  MODEL_CAPACITY_UNAVAILABLE: 503,
  MODEL_OUTPUT_LIMIT: 503,
  MODEL_FINISH_UNSUPPORTED: 503,
  MODEL_STREAM_INTERRUPTED: 503,
} satisfies Partial<Record<ErrorCode, number>>;

/**
 * The single code with two reachable statuses in the contract.
 * → 409 → 503.
 */
export const CONTEXT_CAPACITY_ERROR_ALT_STATUS = 503;

export const KNOWLEDGE_ERROR_HTTP_STATUS = {
  KNOWLEDGE_NOT_FOUND: 404,
  KNOWLEDGE_CATEGORY_NOT_FOUND: 404,
  KNOWLEDGE_REVISION_CONFLICT: 409,
  KNOWLEDGE_CATEGORY_NOT_EMPTY: 409,
  KNOWLEDGE_LAST_CATEGORY: 409,
  KNOWLEDGE_IMPORT_INVALID: 422,
  KNOWLEDGE_ACCESS_CHANGED: 409,
  KNOWLEDGE_SNAPSHOT_INVALID: 409,
  KNOWLEDGE_CONTEXT_BUDGET: 409,
} satisfies Record<(typeof KNOWLEDGE_ERROR_CODES)[number], number>;

export function getErrorHttpStatus(code: ErrorCode): number | undefined {
  return (
    { ...ERROR_HTTP_STATUS, ...KNOWLEDGE_ERROR_HTTP_STATUS } as Partial<Record<ErrorCode, number>>
  )[code];
}

/** Unified JSON error envelope: `{ error: { code, message, request_id? } }`. */
export const ErrorEnvelopeSchema = z.strictObject({
  error: z.strictObject({
    code: ErrorCodeSchema,
    message: z.string(),
    request_id: z.string().optional(),
  }),
});

export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;
