import { z } from "zod";
import { UuidSchema } from "./common";

/** Content only: each repository must enforce its own ownership and lifecycle. */
const ChatSourceSchema = z.strictObject({
  type: z.literal("chat"),
  turn_id: UuidSchema,
  session_id: UuidSchema.nullable(),
  user_message_id: UuidSchema,
  assistant_message_id: UuidSchema,
  sequence_no: z.number().int(),
  valid: z.boolean(),
});
const DocumentSourceSchema = z
  .strictObject({
    type: z.literal("document"),
    document_id: UuidSchema,
    version: z.number().int().positive(),
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
    draft_start: z.number().int().nonnegative().optional(),
    draft_end: z.number().int().nonnegative().optional(),
    valid: z.boolean(),
  })
  .refine(
    (source) =>
      source.end >= source.start &&
      ((source.draft_start === undefined && source.draft_end === undefined) ||
        (source.draft_start !== undefined &&
          source.draft_end !== undefined &&
          source.draft_end > source.draft_start)),
    "Invalid source interval",
  );
/**
 * A memory sourced from a QQ conversation observation rather than a chat turn.
 * A group member's message is not a user/assistant pair, so it cannot be a
 * `chat` source; it carries its own provenance instead. `valid` is computed by the
 * repository, exactly like the chat variant.
 */
const QqObservationSourceSchema = z.strictObject({
  type: z.literal("qq_observation"),
  scope_key: z.string().min(1),
  conversation_key: z.string().min(1),
  event_key: z.string().min(1),
  message_id: z.string().min(1),
  occurred_at_seconds: z.number().int().nonnegative(),
  speaker_kind: z.enum(["member", "anonymous", "system"]),
  speaker_id: z.string().nullable(),
  valid: z.boolean(),
});
export const ContentSourceSchema = z.union([
  ChatSourceSchema,
  DocumentSourceSchema,
  QqObservationSourceSchema,
]);
export const ContentItemSchema = z.strictObject({
  id: UuidSchema,
  source_type: z.enum(["memory", "knowledge"]),
  content_origin: z.enum(["derived", "manual_correction", "original"]),
  name: z.string(),
  summary: z.string(),
  tags: z.array(z.string()),
  body: z.string().optional(),
  revision: z.string().min(1),
  sources: z.array(ContentSourceSchema),
  validity: z.enum(["valid", "invalid"]),
});
export type ContentItem = z.infer<typeof ContentItemSchema>;
export type ContentSource = z.infer<typeof ContentSourceSchema>;

export const MemoryContentResponseSchema = z.strictObject({
  content: ContentItemSchema,
  status: z.enum(["active", "suppressed", "replaced", "invalid"]),
  corrected: z.boolean(),
  retired: z.boolean(),
  source_messages: z.array(
    z.strictObject({
      turn_id: UuidSchema,
      session_title: z.string().nullable(),
      user: z.string().nullable(),
      assistant: z.string().nullable(),
    }),
  ),
});
export type MemoryContentResponse = z.infer<typeof MemoryContentResponseSchema>;

export const MemoryCorrectionSchema = z.strictObject({
  expected_revision: z.string().regex(/^[a-f0-9]{64}$/),
  name: z
    .string()
    .min(1)
    .max(100)
    .refine((s) => s.trim().length > 0),
  summary: z
    .string()
    .min(1)
    .max(500)
    .refine((s) => s.trim().length > 0),
  tags: z.array(z.string().min(1).max(50)).max(20),
  body: z
    .string()
    .min(1)
    .max(16000)
    .refine((s) => s.trim().length > 0),
});
export type MemoryCorrection = z.infer<typeof MemoryCorrectionSchema>;
