import { z } from "zod";
import { IsoTimestampSchema, nonBlankString, UuidSchema } from "./common";
import { ContextUsageSchema } from "./context-usage";
import { ErrorCodeSchema } from "./errors";

/**
 * Chat request & SSE event contracts. Pure `zod` only.
 * Source: api-contract.md §3.1 (ChatRequest), §5 (SSE protocol).
 *
 * The four SSE events are modelled as a discriminated union on the `event`
 * field (api/app.py:316-379), which is how the streaming server selects the
 * payload shape. `start` is always first and only once; `done` terminates the
 * stream; `error` terminates the stream on failure.
 */

/**
 * POST /chat request body (api/schemas.py:38-46).
 *
 * NOT a strict object on purpose: `ChatRequest` declares no `model_config`, so
 * Pydantic keeps its default `extra="ignore"` and unknown keys are accepted and
 * dropped — proven against the source interpreter (CPython 3.12.11 +
 * pydantic 2.13.5), where `{session_id, message, client_request_id, surprise:1}`
 * validates and `model_dump()` returns only the three declared fields. The
 * sibling `CreateSessionRequest` sets `extra="forbid"` explicitly
 * (api/schemas.py:50), which is why strictness is per-schema here, not global.
 */
export const ChatRequestSchema = z
  .object({
    session_id: UuidSchema,
    message: nonBlankString(1, 8000),
    client_request_id: nonBlankString(1, 64),
  })
  .strip();

export type ChatRequest = z.infer<typeof ChatRequestSchema>;

/** `start` event: emitted once at stream open (api/app.py:316-322). */
export const SseStartEventSchema = z.strictObject({
  event: z.literal("start"),
  request_id: z.string(),
  session_id: z.string(),
});

export type SseStartEvent = z.infer<typeof SseStartEventSchema>;

/** `delta` event: incremental model output (api/app.py:326-330). */
export const SseDeltaEventSchema = z.strictObject({
  event: z.literal("delta"),
  request_id: z.string(),
  text: z.string(),
});

export type SseDeltaEvent = z.infer<typeof SseDeltaEventSchema>;

/** `done` event: normal completion; terminates the stream (api/app.py:331-341). */
export const SseDoneEventSchema = z.strictObject({
  event: z.literal("done"),
  request_id: z.string(),
  message_id: z.string(),
  created_at: IsoTimestampSchema,
  completed_at: IsoTimestampSchema.nullable(),
});

export type SseDoneEvent = z.infer<typeof SseDoneEventSchema>;

/** `error` event: stream-time failure (api/app.py:342-379). */
export const SseErrorEventSchema = z.strictObject({
  event: z.literal("error"),
  request_id: z.string(),
  code: ErrorCodeSchema,
  message: z.string(),
});

export type SseErrorEvent = z.infer<typeof SseErrorEventSchema>;

/** Read-only accounting for the assembled request, emitted before model deltas. */
export const SseContextEventSchema = z.strictObject({
  event: z.literal("context"),
  request_id: z.string(),
  usage: ContextUsageSchema,
});

/** Discriminated union of SSE events, keyed by `event`. */
export const SseEventSchema = z.discriminatedUnion("event", [
  SseStartEventSchema,
  SseDeltaEventSchema,
  SseDoneEventSchema,
  SseErrorEventSchema,
  SseContextEventSchema,
]);

export type SseEvent = z.infer<typeof SseEventSchema>;
