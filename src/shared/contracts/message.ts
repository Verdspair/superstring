import { z } from "zod";
import { IsoTimestampSchema, MessageStatusSchema, RoleSchema } from "./common";
import { ErrorCodeSchema } from "./errors";

/**
 * Message response contract. Pure `zod` only.
 * */
export const MessageResponseSchema = z.strictObject({
  id: z.string(),
  role: RoleSchema,
  content: z.string(),
  status: MessageStatusSchema,
  error_code: ErrorCodeSchema.nullable(),
  sequence_no: z.number().int(),
  turn_id: z.string(),
  created_at: IsoTimestampSchema,
  completed_at: IsoTimestampSchema.nullable(),
});

export type MessageResponse = z.infer<typeof MessageResponseSchema>;

export const WEB_MESSAGE_PAGE_SIZE = 100;
const sequenceCursor = z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const MessagePageQuerySchema = z
  .strictObject({
    before_sequence_no: sequenceCursor.min(1).optional(),
    after_sequence_no: sequenceCursor.optional(),
    turn_id: z.string().uuid().optional(),
    client_request_id: z.string().trim().min(1).max(64).optional(),
  })
  .refine((query) => Object.values(query).filter((value) => value !== undefined).length <= 1);
export type MessagePageQuery = z.infer<typeof MessagePageQuerySchema>;
export const MessagePageResponseSchema = z.strictObject({
  items: MessageResponseSchema.array().max(WEB_MESSAGE_PAGE_SIZE),
  has_more: z.boolean(),
});
export type MessagePageResponse = z.infer<typeof MessagePageResponseSchema>;
