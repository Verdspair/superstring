import type { ErrorCode } from "../shared/contracts/errors";

/**
 * Runtime error type, 1:1 with `<reference-project>`.
 *
 * `AppError` is the TS equivalent of the Python base class: it carries the
 * machine-readable `code` (one of the 66 declared in
 * `src/shared/contracts/errors.ts`) plus the HTTP status. The Hono error
 * handler (`src/server/api/error-handler.ts`) turns it into the JSON envelope
 * `{ error: { code, message } }` exactly like `api/app.py:117-122`.
 *
 * Status codes come from `docs/reference/api-contract.md` §6.2. Two rules from
 * the source project that callers must respect:
 *   - `services/context_builder.py:62-63` and `db/memory_repository.py:19-20`
 *     use a local `fail()` helper whose **default status is 409**. Codes raised
 *     that way keep 409 unless the call site overrides it.
 *   - `ModelUnavailableError` (errors.py:99-101) **defaults to 503**.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;

  constructor(code: ErrorCode, message: string, statusCode = 500) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.statusCode = statusCode;
  }
}

// ── errors.py core subclasses (12) ─────────────────────────────────────────

export class SessionNotFoundError extends AppError {
  constructor() {
    super("SESSION_NOT_FOUND", "会话不存在，请先新建会话", 404);
  }
}

export class MessageNotFoundError extends AppError {
  constructor() {
    super("MESSAGE_NOT_FOUND", "消息不存在或不属于当前会话", 404);
  }
}

export class MessageDeleteForbiddenError extends AppError {
  constructor() {
    super("MESSAGE_DELETE_FORBIDDEN", "只允许删除 user 或 assistant 消息", 400);
  }
}

export class IdempotencyConflictError extends AppError {
  constructor() {
    super("IDEMPOTENCY_CONFLICT", "同一个 client_request_id 不能对应不同消息", 409);
  }
}

export class IdempotencyKeyRetiredError extends AppError {
  constructor() {
    super(
      "IDEMPOTENCY_KEY_RETIRED",
      "该 client_request_id 已使用且因消息删除永久退役，请使用新的请求标识",
      409,
    );
  }
}

export class GenerationAlreadyActiveError extends AppError {
  constructor() {
    super("GENERATION_ALREADY_ACTIVE", "该 client_request_id 正在生成，请等待当前请求完成", 409);
  }
}

export class SessionGenerationBusyError extends AppError {
  constructor() {
    super("SESSION_GENERATION_BUSY", "当前会话正在生成其他回复，请等待后重试", 409);
  }
}

export class GenerationOwnershipLostError extends AppError {
  constructor() {
    super("GENERATION_OWNERSHIP_LOST", "生成所有权已失效，当前输出不会保存", 409);
  }
}

export class GenerationCancelledError extends AppError {
  constructor() {
    super("GENERATION_CANCELLED", "生成已取消，后续输出不会保存", 409);
  }
}

export class EmptyModelResponseError extends AppError {
  constructor() {
    super("MODEL_EMPTY_RESPONSE", "本地模型未返回有效内容，请重试", 502);
  }
}

export class DatabaseUnavailableError extends AppError {
  constructor() {
    super("DATABASE_UNAVAILABLE", "数据服务暂不可用，请检查数据库", 503);
  }
}

/**
 * errors.py:99-101 — note the **default code differs** from the class name:
 * the default is `MODEL_SERVICE_UNAVAILABLE`, and callers override both code
 * and message for the other eight model-layer codes.
 */
export class ModelUnavailableError extends AppError {
  constructor(code: ErrorCode = "MODEL_SERVICE_UNAVAILABLE", message = "本地模型服务暂不可用") {
    super(code, message, 503);
  }
}

// ── Repository / service layer codes ───────────────────────────────────────

/**
 * Mirrors the local `fail(code, message, status=409)` helpers in
 * `db/memory_repository.py:19-20` and `services/context_builder.py:62-63`.
 * Default status is **409**.
 */
export function fail(code: ErrorCode, message: string, status = 409): never {
  throw new AppError(code, message, status);
}

/** Validation failure → 422 `VALIDATION_ERROR` (api/app.py:136-143). */
export class ValidationError extends AppError {
  constructor(message = "请求参数不合法") {
    super("VALIDATION_ERROR", message, 422);
  }
}

/** Narrowing helper used by the error handler; works across module boundaries. */
export function isAppError(value: unknown): value is AppError {
  return (
    value instanceof AppError ||
    (typeof value === "object" &&
      value !== null &&
      "code" in value &&
      "statusCode" in value &&
      typeof (value as { code: unknown }).code === "string" &&
      typeof (value as { statusCode: unknown }).statusCode === "number")
  );
}
