// Safe OneBot protocol event projection shared by transport and management UI.
// It never contains message bodies, raw nodes, credentials, echoes or request flags.

import { z } from "zod";
import { IsoTimestampSchema } from "./common";
import { SourceRefSchema } from "./evidence";
import { OneBotAccountIdSchema, OneBotWireIdSchema } from "./onebot-identity";

export const OneBotProtocolEventKindSchema = z.enum(["message", "notice", "request", "meta_event"]);
export type OneBotProtocolEventKind = z.infer<typeof OneBotProtocolEventKindSchema>;

export const OneBotProtocolSegmentCountsSchema = z.strictObject({
  text: z.number().int().nonnegative().max(256),
  mention: z.number().int().nonnegative().max(256),
  reply: z.number().int().nonnegative().max(256),
  face: z.number().int().nonnegative().max(256),
  image: z.number().int().nonnegative().max(256),
  record: z.number().int().nonnegative().max(256),
  video: z.number().int().nonnegative().max(256),
  file: z.number().int().nonnegative().max(256),
  unsupported: z.number().int().nonnegative().max(256),
});
export type OneBotProtocolSegmentCounts = z.infer<typeof OneBotProtocolSegmentCountsSchema>;

const Base = {
  account_id: OneBotAccountIdSchema,
  occurred_at_seconds: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  observed_at: IsoTimestampSchema,
};
const OptionalId = OneBotAccountIdSchema.nullable();
const BoundedType = z.string().min(1).max(32);

export const OneBotMessageProtocolEventSchema = z.strictObject({
  kind: z.literal("message"),
  ...Base,
  /** Private correlation identity; HTTP DTO deliberately omits it. */
  event_key: z.string().min(1).max(512),
  message_id: OneBotWireIdSchema,
  message_type: z.enum(["group", "private"]),
  sub_type: BoundedType,
  peer_id: OneBotAccountIdSchema,
  sender_id: OptionalId,
  segments: OneBotProtocolSegmentCountsSchema,
});
export const OneBotNoticeProtocolEventSchema = z.strictObject({
  kind: z.literal("notice"),
  ...Base,
  notice_type: BoundedType,
  sub_type: BoundedType.nullable(),
  user_id: OptionalId,
  group_id: OptionalId,
  operator_id: OptionalId,
  target_id: OptionalId,
  message_id: OneBotWireIdSchema.nullable(),
});
export const OneBotRequestProtocolEventSchema = z.strictObject({
  kind: z.literal("request"),
  ...Base,
  request_type: BoundedType,
  sub_type: BoundedType.nullable(),
  user_id: OptionalId,
  group_id: OptionalId,
});
export const OneBotMetaProtocolEventSchema = z.strictObject({
  kind: z.literal("meta_event"),
  ...Base,
  meta_event_type: BoundedType,
  sub_type: BoundedType.nullable(),
  heartbeat: z
    .strictObject({
      good: z.boolean().nullable(),
      online: z.boolean().nullable(),
      interval_ms: z.number().int().nonnegative().max(2_147_483_647).nullable(),
    })
    .nullable(),
});

export const OneBotProtocolEventSchema = z.discriminatedUnion("kind", [
  OneBotMessageProtocolEventSchema,
  OneBotNoticeProtocolEventSchema,
  OneBotRequestProtocolEventSchema,
  OneBotMetaProtocolEventSchema,
]);
export type OneBotProtocolEvent = z.infer<typeof OneBotProtocolEventSchema>;

/** Fields stable enough for the shared HTTP DTO; correlation identity is intentionally absent. */
export const OneBotProtocolEventViewSchema = z.discriminatedUnion("kind", [
  OneBotMessageProtocolEventSchema.omit({ event_key: true }),
  OneBotNoticeProtocolEventSchema,
  OneBotRequestProtocolEventSchema,
  OneBotMetaProtocolEventSchema,
]);
export type OneBotProtocolEventView = z.infer<typeof OneBotProtocolEventViewSchema>;
export const OneBotMessageSourceReferenceSchema = z
  .strictObject({
    event_key: z.string().min(1).max(512),
    scope: z.strictObject({
      conversationId: z.string().min(1).max(128),
      accountId: OneBotAccountIdSchema,
      conversationKind: z.enum(["group", "private"]),
      peerId: OneBotAccountIdSchema,
      agentId: z.string().min(1).max(128),
      bindingId: z.string().min(1).max(128),
      bindingEpoch: z.number().int().positive(),
      authorityRevision: z.number().int().positive(),
    }),
    source: SourceRefSchema.refine(
      (source) => source.kind === "qq_observation" && source.expiresAt !== undefined,
      { message: "OneBot message references require a live observation source" },
    ).transform((source) => ({
      ...source,
      kind: "qq_observation" as const,
      expiresAt: source.expiresAt as string,
    })),
  })
  .refine(({ event_key, source }) => source.id === event_key, {
    message: "Message source ID must match its protocol event key",
  });
export type OneBotMessageSourceReference = z.infer<typeof OneBotMessageSourceReferenceSchema>;
export type OneBotMessageSourceReferenceInput = z.input<typeof OneBotMessageSourceReferenceSchema>;
