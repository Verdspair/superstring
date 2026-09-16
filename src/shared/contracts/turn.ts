import { z } from "zod";
import { GenerationStatusSchema, IsoTimestampSchema, ScopeSchema } from "./common";

/**
 * Turn contracts (API-visible + memory turns listing). Pure `zod` only.
 * Source: api-contract.md §1.4, §7.2; db/models.py:26-37.
 */

/** Observable Turn snapshot (api-contract.md §7.2). */
export const TurnSchema = z.strictObject({
  id: z.string(),
  generation_status: GenerationStatusSchema,
  cancel_requested: z.boolean(),
  lease_expires_at: IsoTimestampSchema.nullable(),
  generation_token: z.string().length(36).nullable(),
});

export type Turn = z.infer<typeof TurnSchema>;

/** A single processed/unprocessed turn row (api-contract.md §1.4). */
export const MemoryTurnRowSchema = z.strictObject({
  id: z.string(),
  sequence_no: z.number().int(),
  user: z.string(),
  assistant: z.string(),
  processed: z.boolean(),
});

export type MemoryTurnRow = z.infer<typeof MemoryTurnRowSchema>;

/** `GET /sessions/{id}/turns` response (api-contract.md §1.4). */
export const TurnsListSchema = z.strictObject({
  scope: ScopeSchema,
  turns: z.array(MemoryTurnRowSchema),
});

export type TurnsList = z.infer<typeof TurnsListSchema>;
