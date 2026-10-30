import { z } from "zod";

export const MemoryReadSettingsSchema = z.strictObject({
  enabled: z.boolean(),
  max_bytes: z.number().int().min(1).max(1048576),
});
export type MemoryReadSettings = z.infer<typeof MemoryReadSettingsSchema>;

interface StoredMemoryReadConfig {
  memory_read?: MemoryReadSettings;
  retrieval_mode: string;
  retrieval_presets: Record<
    "conservative" | "standard" | "broad",
    {
      candidate_limit: number;
      max_entries: number;
      max_tokens: number;
    }
  >;
}
export interface ResolvedMemoryReadSettings {
  readonly enabled: boolean;
  readonly maxBytes: number;
  readonly candidateLimit: number;
  readonly maxEntries: number;
}

/** Decode legacy storage once; runtime consumers receive limits, never retrieval tiers. */
export function resolveMemoryReadSettings(
  config: StoredMemoryReadConfig,
): ResolvedMemoryReadSettings {
  const mode = config.retrieval_mode;
  const legacy =
    config.retrieval_presets[
      mode === "conservative" || mode === "standard" || mode === "broad"
        ? mode
        : mode === "off"
          ? "conservative"
          : "broad"
    ];
  return {
    enabled: config.memory_read?.enabled ?? mode !== "off",
    maxBytes: config.memory_read?.max_bytes ?? legacy.max_tokens,
    candidateLimit: legacy.candidate_limit,
    maxEntries: legacy.max_entries,
  };
}
