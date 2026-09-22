import type { Context } from "hono";
import { AppError, DatabaseUnavailableError, isAppError } from "../errors";

/**
 * HTTP error envelope.
 * AppError keeps its status; database errors map to 503, validation to 422.
 * HTTP errors omit request_id. SSE errors include it.
 */
export interface ErrorEnvelopeBody {
  error: {
    code: string;
    message: string;
    request_id?: string;
  };
}

/** Builds the envelope. Omits `request_id` unless explicitly provided. */
export function errorPayload(code: string, message: string, requestId?: string): ErrorEnvelopeBody {
  const error: ErrorEnvelopeBody["error"] = { code, message };
  if (requestId !== undefined) error.request_id = requestId;
  return { error };
}

/**
 * Marker for storage-layer failures.
 * Only errors of this type are downgraded to `DATABASE_UNAVAILABLE`; unrelated
 * programming errors must not be masked as database outages.
 */
export class DatabaseError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "DatabaseError";
  }
}

export function isDatabaseError(value: unknown): value is DatabaseError {
  if (value instanceof DatabaseError || (value as { name?: string })?.name === "DatabaseError") {
    return true;
  }
  // A raw `bun:sqlite` error belongs to the same class of storage-layer
  // failures the mapper sends to `DATABASE_UNAVAILABLE`, so a raw driver
  // error must also downgrade to 503 at the boundary instead of leaking as
  // a generic 500 (or being silently mis-handled by marker-only checks).
  const candidate = value as { name?: string; code?: unknown } | null;
  return (
    candidate?.name === "SQLiteError" ||
    candidate?.name === "SqliteError" ||
    (typeof candidate?.code === "string" && candidate.code.startsWith("SQLITE_"))
  );
}

/** JSON body used for non-`AppError`, non-DB failures. */
export interface InternalErrorBody {
  detail: string;
}

/**
 * Hono `onError` handler. Returns a `Response` for every input so the server
 * never leaks a stack trace or an unstructured body.
 */
export function handleError(err: unknown, c: Context): Response {
  if (isAppError(err)) {
    const status = err.statusCode as 400;
    return c.json(errorPayload(err.code, err.message), status);
  }

  if (isDatabaseError(err)) {
    const dbError = new DatabaseUnavailableError();
    return c.json(errorPayload(dbError.code, dbError.message), dbError.statusCode as 503);
  }

  // Anything else uses the contract's default unhandled-exception response.
  // Shape is marked `待实测确认` in api-contract.md §9: the contract has
  // no custom handler for generic exceptions, so the body uses that default
  // shape rather than the `error` envelope.
  return c.json({ detail: "Internal Server Error" } satisfies InternalErrorBody, 500);
}

export { AppError, DatabaseUnavailableError };
