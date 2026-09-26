import { z } from "zod";
import { SourceRefSchema } from "./evidence";

export const ConversationChannelSchema = z.enum(["web", "onebot11"]);
export const WakeStatusSchema = z.enum(["pending", "leased", "completed", "no_output", "failed"]);
export const ConversationParticipantSchema = z.strictObject({
  id: z.string(),
  label: z.string(),
  role: z.enum(["user", "agent", "member", "anonymous"]),
});
export const ConversationAddressingSchema = z.strictObject({
  reasons: z.array(z.enum(["request", "private", "mention", "reply_to_agent", "legacy_addressed"])),
  mentionIds: z.array(z.string()),
  replyTo: z
    .strictObject({ sourceId: z.string(), participantId: z.string().optional() })
    .optional(),
});
export const ConversationSummarySchema = z.strictObject({
  id: z.string(),
  channel: ConversationChannelSchema,
  topology: z.enum(["direct", "shared"]),
  sourceId: z.string(),
  agentId: z.string(),
  bindingEpoch: z.number().int().positive(),
  title: z.string(),
  participants: z.array(ConversationParticipantSchema),
  updatedAt: z.string(),
  lastSeq: z.number().int().nonnegative(),
  consumedSeq: z.number().int().nonnegative(),
});
export const ConversationEventSchema = z.strictObject({
  conversationId: z.string(),
  seq: z.number().int().positive(),
  eventKey: z.string(),
  kind: z.enum(["inbound", "outbound", "media_revision", "wake", "delivery"]),
  source: SourceRefSchema,
  sources: z.array(SourceRefSchema),
  occurredAt: z.string(),
  recordedAt: z.string(),
  participant: ConversationParticipantSchema.nullable(),
  addressing: ConversationAddressingSchema,
  runId: z.string().nullable(),
  outputId: z.string().nullable(),
});
export const ConversationEventViewSchema = ConversationEventSchema.extend({
  wake: z
    .strictObject({
      id: z.string(),
      cause: z.string(),
      status: WakeStatusSchema,
      readyAt: z.string(),
      errorCode: z.string().nullable(),
    })
    .nullable(),
  text: z.string().nullable(),
  messageStatus: z.enum(["completed", "failed", "cancelled"]).nullable(),
  contentState: z.enum(["active", "expired", "revoked", "unavailable"]),
  media: z.array(
    z.strictObject({
      id: z.string(),
      kind: z.string(),
      description: z.string().nullable(),
      availability: z.enum(["available", "expired", "unavailable"]),
    }),
  ),
  deliveryStatus: z
    .enum(["planned", "delivering", "confirmed", "failed", "unknown", "stale"])
    .nullable(),
});
export const ConversationListSchema = z.strictObject({
  items: z.array(ConversationSummarySchema),
  nextCursor: z.string().nullable(),
});
export const ConversationEventsSchema = z.strictObject({
  items: z.array(ConversationEventViewSchema),
  nextSeq: z.number().int().nonnegative(),
  firstSeq: z.number().int().nonnegative().optional(),
  hasMore: z.boolean(),
});

export const WakeSignalSchema = z.strictObject({
  id: z.string(),
  conversationId: z.string(),
  cause: z.string(),
  dedupeKey: z.string(),
  throughSeq: z.number().int().nonnegative(),
  readyAt: z.string(),
  createdAt: z.string(),
  priority: z.number().int(),
  status: WakeStatusSchema,
  attempts: z.number().int().nonnegative(),
  leaseToken: z.string().nullable(),
  leaseExpiresAt: z.string().nullable(),
  errorCode: z.string().nullable(),
});
export const DeliveryPartSchema = z.strictObject({
  id: z.string(),
  ordinal: z.number().int().nonnegative(),
  kind: z.enum(["text", "sticker"]),
  status: z.enum(["planned", "sending", "confirmed", "failed", "unknown", "not_sent", "stale"]),
  platformMessageId: z.string().nullable(),
  attemptedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  stickerId: z.string().nullable(),
});
export const DeliverySchema = z.strictObject({
  target: z.strictObject({ peerId: z.string(), participantId: z.string().nullable() }).nullable(),
  id: z.string(),
  runId: z.string(),
  conversationId: z.string(),
  ordinal: z.number().int().nonnegative(),
  status: z.enum(["planned", "delivering", "confirmed", "failed", "unknown", "stale"]),
  sourceThroughSeq: z.number().int().nonnegative(),
  deliverBy: z.string(),
  createdAt: z.string(),
  parts: z.array(DeliveryPartSchema),
});
export type ConversationSummary = z.infer<typeof ConversationSummarySchema>;
export type ConversationParticipant = z.infer<typeof ConversationParticipantSchema>;
export type ConversationAddressing = z.infer<typeof ConversationAddressingSchema>;
export type ConversationEvent = z.infer<typeof ConversationEventSchema>;
export type ConversationEventView = z.infer<typeof ConversationEventViewSchema>;
export type WakeSignal = z.infer<typeof WakeSignalSchema>;
export type Delivery = z.infer<typeof DeliverySchema>;
export type DeliveryPart = z.infer<typeof DeliveryPartSchema>;
