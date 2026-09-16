import { z } from "zod";

export const BrowserStateConfigSchema = z.object({
  secret: z.string().min(32),
  storage_keys: z.object({
    session: z.literal("superstring-session"),
    agent: z.literal("superstring-agent"),
  }),
});

export type BrowserStateConfig = z.infer<typeof BrowserStateConfigSchema>;
