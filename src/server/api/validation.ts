// Request validation helpers.
//
// FastAPI validates the request body against a Pydantic model and the path
// parameters against their declared type, and reports ANY failure as
// `VALIDATION_ERROR` 422 with the message `请求参数不合法`
// (api/app.py:136-143). Every route in this port must funnel through these
// helpers so the 422 surface is identical for bodies, query strings, and path
// UUIDs — a bare `zod.parse` throw would surface as an unhandled 500 instead.

import type { z } from "zod";
import { UuidSchema } from "../../shared/contracts/common";
import { AppError } from "../errors";

/** 422 VALIDATION_ERROR — the exact body message the source emits. */
export function validationFailed(): AppError {
  return new AppError("VALIDATION_ERROR", "请求参数不合法", 422);
}

/** Parse a request body, converting any failure into VALIDATION_ERROR 422. */
export function parseBody<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const result = schema.safeParse(body);
  if (!result.success) throw validationFailed();
  return result.data;
}

/**
 * Validate and canonicalise a `uuid.UUID` path parameter. An unparseable id is
 * a request validation failure (422), NOT a 404: FastAPI rejects the path before
 * the handler runs, so a non-UUID id never reaches the "not found" branch.
 *
 * The returned value is the CANONICAL form, not the raw segment: the source
 * hands `str(uuid_value)` to the repository (api/app.py:246), so
 * `.../sessions/ABCDEF12-3456-7890-ABCD-EF1234567890` must resolve to the same
 * lowercase row instead of 404ing (#92). Sharing `UuidSchema` with the body
 * contracts also keeps path and body acceptance identical.
 */
export function parseUuidParam(value: string): string {
  const result = UuidSchema.safeParse(value);
  if (!result.success) throw validationFailed();
  return result.data;
}

/**
 * Read and parse a request body exactly the way FastAPI does.
 *
 * Every handler in the source declares a REQUIRED Pydantic body
 * (`body: Model`), so a request with no body at all — or only whitespace — is a
 * RequestValidationError → 422 (api/app.py:136-143). The source has no
 * "empty string becomes {}" helper anywhere. Treating a raw empty body as `{}`
 * silently changed behaviour: `PUT /agents/{id}/persona` accepts `{}` (all five
 * persona fields default to "") and would therefore wipe the persona, even
 * though the real API answers 422 (#90).
 *
 * A literal JSON `{}` still parses to `{}`, which is what the source does; only
 * a MISSING body is rejected.
 */
export async function readJsonBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text.trim() === "") throw validationFailed();
  try {
    return JSON.parse(text);
  } catch {
    throw validationFailed();
  }
}
