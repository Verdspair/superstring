import type { Context } from "hono";
import {
  AppError,
  DatabaseError,
  DatabaseUnavailableError,
  isAppError,
  isDatabaseError,
} from "../errors";

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

// DatabaseError/isDatabaseError 的稳定定义已挪到 `../errors`（中立模块）；
// 这里继续导出同名符号，既有导入面不变。
export { AppError, DatabaseError, DatabaseUnavailableError, isDatabaseError };
