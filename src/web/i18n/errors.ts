import type { Locale } from "./index";

const labels: Record<string, string> = {
  SESSION_NOT_FOUND: "Chat not found",
  MESSAGE_NOT_FOUND: "Message not found",
  MESSAGE_DELETE_FORBIDDEN: "This message cannot be deleted",
  IDEMPOTENCY_CONFLICT: "Request identifier conflicts with an earlier request",
  IDEMPOTENCY_KEY_RETIRED: "This request identifier can no longer be reused",
  GENERATION_ALREADY_ACTIVE: "Generation is already running",
  SESSION_GENERATION_BUSY: "This chat is generating a reply",
  GENERATION_OWNERSHIP_LOST: "Generation ownership was lost",
  GENERATION_CANCELLED: "Generation cancelled",
  MODEL_EMPTY_RESPONSE: "The model returned an empty response",
  DATABASE_UNAVAILABLE: "Database unavailable",
  MODEL_SERVICE_UNAVAILABLE: "Model service unavailable",
  AGENT_NOT_FOUND: "Assistant not found",
  AGENT_DISABLED: "Assistant disabled",
  AGENT_IN_USE: "This assistant is used by existing chats",
  DEFAULT_AGENT_DELETE_FORBIDDEN: "The default assistant cannot be deleted",
  CONFIG_VERSION_CONFLICT: "Configuration changed; reload and retry",
  PERSONA_NOT_FOUND: "Persona not found",
  MODE_NOT_AVAILABLE: "This mode is not available",
  VALIDATION_ERROR: "Invalid input",
  INVALID_MESSAGE_TURN: "Invalid message turn",
  INVALID_SESSION_CONFIG: "Invalid chat configuration",
  INVALID_TURN_CONFIG: "Invalid turn configuration",
  CONTEXT_AUX_BUDGET: "Auxiliary context budget exceeded",
  CONTEXT_AUX_ERROR: "Auxiliary context task failed",
  CONTEXT_AUX_TIMEOUT: "Auxiliary context task timed out",
  CONTEXT_BUDGET_EXCEEDED: "Context budget exceeded",
  CONTEXT_CAPACITY_ERROR: "Context capacity lookup failed",
  CONTEXT_CAPACITY_INSUFFICIENT: "Insufficient context capacity",
  CONTEXT_CAPACITY_TIMEOUT: "Context capacity lookup timed out",
  CONTEXT_CAPACITY_UNKNOWN: "Context capacity unknown",
  CONTEXT_CATALOG_LIMIT: "Memory catalog limit reached",
  CONTEXT_INVALID_RESULT: "Invalid context result",
  CONTEXT_INVALID_SELECTION: "Invalid context selection",
  CONTEXT_MEMORY_BUDGET: "Memory context budget exceeded",
  CONTEXT_RECALL_BUDGET: "Source recall budget exceeded",
  CONTEXT_SOURCE_INVALID: "Invalid context source",
  CONTEXT_SUMMARY_BUDGET: "Summary budget exceeded",
  MEMORY_FORBIDDEN: "Memory access denied",
  MEMORY_SOURCE_FORBIDDEN: "Memory source access denied",
  MEMORY_NOT_FOUND: "Memory not found",
  MEMORY_JOB_NOT_FOUND: "Memory task not found",
  MEMORY_BUSY: "Memory operation is busy",
  MEMORY_POLICY_CONFLICT: "Memory policy changed; reload and retry",
  MEMORY_REQUEST_CONFLICT: "Memory request conflict",
  MEMORY_SOURCE_CHANGED: "Memory source changed",
  MEMORY_SOURCE_INVALID: "Invalid memory source",
  MEMORY_STATE_CONFLICT: "Memory state conflict",
  MEMORY_JOB_OWNERSHIP_LOST: "Memory task ownership was lost",
  MODEL_NOT_LOADED: "Model not loaded",
  MODEL_TIMEOUT: "Model request timed out",
  MODEL_ERROR: "Model request failed",
  MODEL_CAPACITY_AMBIGUOUS: "Model capacity is ambiguous",
  MODEL_CAPACITY_UNAVAILABLE: "Model capacity unavailable",
  MODEL_OUTPUT_LIMIT: "Model output limit reached",
  MODEL_FINISH_UNSUPPORTED: "Unsupported model completion status",
  MODEL_STREAM_INTERRUPTED: "Model stream interrupted",
  MESSAGE_PERSISTENCE_ERROR: "Could not save the message",
  CLIENT_DISCONNECTED: "Client disconnected",
  GENERATION_LEASE_EXPIRED: "Generation lease expired",
};
const knownErrors = new Map<string, { code: string; detail: string }>();
export function registerError(code: string, detail: string): string {
  const text = `[${code}] ${detail}`;
  knownErrors.set(text, { code, detail });
  if (knownErrors.size > 500) knownErrors.delete(knownErrors.keys().next().value as string);
  return text;
}
export function translateError(text: string, locale: Locale): string | undefined {
  const error = knownErrors.get(text);
  if (!error) return undefined;
  return locale === "en" && labels[error.code]
    ? `${labels[error.code]} [${error.code}]`
    : `[${error.code}] ${error.detail}`;
}
