import { z } from "zod";

const units = z.number().int().nonnegative();
/** Metadata only: never carries prompts, retrieved documents or summary text. */
export const ContextUsageSchema = z.strictObject({
  session_id: z.string(),
  turn_id: z.string(),
  model: z.string(),
  estimator: z.literal("utf8_bytes_plus_message_overhead"),
  capacity: z.number().int().positive(),
  input_units: units,
  input_limit: units,
  output_reserved: units,
  safety_reserved: units,
  remaining: units,
  components: z.strictObject({
    instructions: units,
    recent_history: units,
    summaries: units,
    long_term_memory: units,
    knowledge: units,
    current_question: units,
    protocol: units,
  }),
});
export type ContextUsage = z.infer<typeof ContextUsageSchema>;
