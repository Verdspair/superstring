// Shared management DTOs for the bounded local OneBot event stream.
// Raw packets, source references and credentials are deliberately absent from every HTTP shape.

import { z } from "zod";
import { IsoTimestampSchema } from "./common";
import { OneBotProtocolEventKindSchema, OneBotProtocolEventViewSchema } from "./onebot-events";

export const QqManagedEventKindSchema = OneBotProtocolEventKindSchema;
export type QqManagedEventKind = z.infer<typeof QqManagedEventKindSchema>;

export const QqManagedProtocolEventSchema = OneBotProtocolEventViewSchema;
export type QqManagedProtocolEvent = z.infer<typeof QqManagedProtocolEventSchema>;

/** Stored in the vendor ring; the row contains no message body or raw packet. */
export const QqManagedEventRecordSchema = z.strictObject({
  sequence: z.number().int().positive(),
  expires_at: IsoTimestampSchema,
  event: QqManagedProtocolEventSchema,
});
export type QqManagedEventRecord = z.infer<typeof QqManagedEventRecordSchema>;

export const QqManagedEventCursorSchema = z.strictObject({
  generation: z.string().uuid(),
  sequence: z.number().int().nonnegative(),
});
export type QqManagedEventCursor = z.infer<typeof QqManagedEventCursorSchema>;

export const QqManagedEventQuerySchema = z.strictObject({
  kind: QqManagedEventKindSchema.optional(),
  cursor: z.string().min(1).max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type QqManagedEventQuery = z.infer<typeof QqManagedEventQuerySchema>;

export const QqManagedEventViewSchema = z.strictObject({
  ...QqManagedEventRecordSchema.shape,
  conversation_binding: z.enum(["bound", "unbound", "unknown"]),
  /** Supplied per snapshot only by the existing source-authorized reader; never ring-cached. */
  message_preview: z.string().max(160).nullable(),
  preview_state: z.enum(["available", "unbound", "expired", "unavailable", "not_message"]),
});
export type QqManagedEventView = z.infer<typeof QqManagedEventViewSchema>;

export const QqManagedEventsPageSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("ok"),
    generation: z.string().uuid(),
    latest_sequence: z.number().int().nonnegative(),
    revision: z.number().int().nonnegative(),
    events: z.array(QqManagedEventViewSchema).max(100),
    next_cursor: z.string().nullable(),
    truncated: z.boolean(),
  }),
  z.strictObject({
    status: z.literal("reset_required"),
    generation: z.string().uuid(),
    latest_sequence: z.number().int().nonnegative(),
    revision: z.number().int().nonnegative(),
  }),
]);
export type QqManagedEventsPage = z.infer<typeof QqManagedEventsPageSchema>;

export const QqManagedEventsInvalidationSchema = z.strictObject({
  generation: z.string().uuid(),
  latest_sequence: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(),
});
export type QqManagedEventsInvalidation = z.infer<typeof QqManagedEventsInvalidationSchema>;
