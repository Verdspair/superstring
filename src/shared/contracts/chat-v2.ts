import { z } from "zod";
import { RunEventSchema } from "./agent-run";

/** A completed old request may predate Agent runs: replay is a message, not a fabricated run. */
export const ChatReplayEventSchema = z.strictObject({
  type: z.literal("replay"),
  conversationId: z.string(),
  sessionId: z.string(),
  requestId: z.string(),
  runId: z.string().optional(),
  message: z.strictObject({
    id: z.string(),
    text: z.string(),
    createdAt: z.string(),
    completedAt: z.string().nullable(),
  }),
});
export const ChatV2EventSchema = z.union([RunEventSchema, ChatReplayEventSchema]);
export type ChatV2Event = z.infer<typeof ChatV2EventSchema>;
