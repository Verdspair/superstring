import { z } from "zod";
import { IsoTimestampSchema, MessageStatusSchema, RoleSchema } from "./common";
import { ErrorCodeSchema } from "./errors";

/**
 * Message response contract. Pure `zod` only.
 * Source: api/schemas.py:303-318; db/models.py:18-24.
 */
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
