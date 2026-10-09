import { z } from "zod";
import { ConversationAvatarSchema } from "./conversation-avatar";
import { SourceRefSchema } from "./evidence";
// T13 Step6：事件详情复用 QQ 消息事实的唯一 schema（规格 §6：后台消息详情来自统一事实投影）。
// 仅 import type 语义之外的 runtime schema 复用；qq-message.ts 不回读本文件，无循环。
import { QqMessageFactSchema } from "./qq-message";

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
/**
 * QQ 群显示名（0053）：`number` 是恒在的群号；`originalName` 是 OneBot 报回的群本名
 * （尚未取到为 null）；`customName` 是用户的显示备注。展示优先级由投影折进 `title`，
 * 前端不自行取群名。
 */
export const ConversationQqGroupSchema = z.strictObject({
  number: z.string().regex(/^\d+$/),
  originalName: z.string().nullable(),
  customName: z.string().nullable(),
});
export type ConversationQqGroup = z.infer<typeof ConversationQqGroupSchema>;

/** 群备注保存请求：null / trim 后空串 = 清除备注恢复默认；非空 trim 长度 <= 100。 */
export const ConversationGroupNamePatchSchema = z.strictObject({
  name: z.string().max(100).nullable(),
});
export type ConversationGroupNamePatch = z.infer<typeof ConversationGroupNamePatchSchema>;

export const ConversationSummarySchema = z.strictObject({
  id: z.string(),
  channel: ConversationChannelSchema,
  topology: z.enum(["direct", "shared"]),
  sourceId: z.string(),
  agentId: z.string(),
  bindingEpoch: z.number().int().positive(),
  title: z.string(),
  /** 仅 QQ 群（shared）会话携带；缺失即 Web / 私聊。 */
  qqGroup: ConversationQqGroupSchema.optional(),
  avatar: ConversationAvatarSchema.optional(),
  participants: z.array(ConversationParticipantSchema),
  updatedAt: z.string(),
  lastSeq: z.number().int().nonnegative(),
  consumedSeq: z.number().int().nonnegative(),
});
/** 未送达的原因：期限到、会话变化、授权变化，或来源保留期到期。历史行没有记录原因，按未知处理。 */
export const DeliveryStaleReasonSchema = z.enum([
  "DELIVERY_TTL_EXPIRED",
  "CONVERSATION_CHANGED",
  "DELIVERY_AUTHORITY_CHANGED",
  "SOURCE_EXPIRED",
]);
export type DeliveryStaleReason = z.infer<typeof DeliveryStaleReasonSchema>;

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
  /** 仅 deliveryStatus="stale" 有实义；其余事件恒为 null。 */
  deliveryStaleReason: DeliveryStaleReasonSchema.nullable().optional(),
  /** QQ 事件详情（规格 §6 后台消息详情）：仅授权可读的入站事件携带；缺失即无详情。 */
  qqMessageFacts: z.array(QqMessageFactSchema).optional(),
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
  /** 仅 status="stale" 有实义；null＝未记录原因。 */
  staleReason: DeliveryStaleReasonSchema.nullable().optional(),
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
