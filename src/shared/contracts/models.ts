import { z } from "zod";
import { LocalModelStatusSchema, nonBlankString, RetrievalModeSchema, rawString } from "./common";

/**
 * Model catalogue and context-budget (P5) contracts. Pure `zod` only.
 * Source: api/schemas.py:200-206, api/models.py:18-22, services/context_config.py.
 */

/**
 * Retrieval preset DEFAULTS. Values are deliberately generous: they are the
 * first numbers a new agent gets, and a user who never opens this page should
 * not be silently capped to a handful of memories. The validation ranges below
 * are unchanged — only the defaults moved (each roughly doubled, ordering
 * conservative < standard < broad preserved).
 */
export const DEFAULT_CONSERVATIVE_PRESET = {
  candidate_limit: 30,
  max_entries: 6,
  max_tokens: 2048,
  relevance_instruction: "直接相关",
} as const;

export const DEFAULT_STANDARD_PRESET = {
  candidate_limit: 60,
  max_entries: 10,
  max_tokens: 4096,
  relevance_instruction: "直接或必要背景",
} as const;

export const DEFAULT_BROAD_PRESET = {
  candidate_limit: 120,
  max_entries: 16,
  max_tokens: 8192,
  relevance_instruction: "有帮助的间接背景",
} as const;

export const DEFAULT_RETRIEVAL_PRESETS = {
  conservative: DEFAULT_CONSERVATIVE_PRESET,
  standard: DEFAULT_STANDARD_PRESET,
  broad: DEFAULT_BROAD_PRESET,
} as const;

/** A single retrieval preset (context_config.py:7-27). */
export const RetrievalPresetSchema = z
  .strictObject({
    candidate_limit: z.number().int().min(1).max(10000),
    max_entries: z.number().int().min(1).max(10000),
    max_tokens: z.number().int().min(1).max(1048576),
    relevance_instruction: nonBlankString(1, 16000),
  })
  .superRefine((v, ctx) => {
    if (v.max_entries > v.candidate_limit) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "max_entries 必须 <= candidate_limit",
        path: ["max_entries"],
      });
    }
  });

export type RetrievalPreset = z.infer<typeof RetrievalPresetSchema>;

/** Exactly the three fixed retrieval presets (conservative/standard/broad). */
export const RetrievalPresetsSchema = z.strictObject({
  conservative: RetrievalPresetSchema.default(DEFAULT_CONSERVATIVE_PRESET),
  standard: RetrievalPresetSchema.default(DEFAULT_STANDARD_PRESET),
  broad: RetrievalPresetSchema.default(DEFAULT_BROAD_PRESET),
});

export type RetrievalPresets = z.infer<typeof RetrievalPresetsSchema>;

/**
 * P5 context-budget configuration (context_config.py:41-67).
 * Cross-field invariants (context_config.py:61-64):
 *  - `max_output_tokens + context_window * safety_margin_ratio < context_window`
 *    whenever `context_window` is set.
 *  - `summary_target_tokens <= summary_max_tokens`.
 */
export const P5ConfigSchema = z
  .strictObject({
    context_window: z.number().int().min(1024).max(1048576).nullable().default(null),
    max_output_tokens: z.number().int().min(1).max(1048576).default(4096),
    safety_margin_ratio: z
      .number()
      .min(0)
      .refine((v) => v < 1, "必须 0 <= x < 1")
      .default(0.1),
    compression_enabled: z.boolean().default(true),
    compression_trigger_ratio: z
      .number()
      .refine((v) => v > 0 && v <= 1, "必须 0 < x <= 1")
      .default(0.8),
    // 10 turns (5 exchanges) kept verbatim. The default is generous because the
    // oldest turns are what the user notices missing; the builder drops them
    // oldest-first when the budget runs out, so a larger default degrades
    // gracefully instead of overflowing.
    recent_turns: z.number().int().min(1).max(10000).default(10),
    summary_target_tokens: z.number().int().min(1).max(1048576).default(2048),
    summary_max_tokens: z.number().int().min(1).max(1048576).default(4096),
    // Absent/null inherits the compression cap, preserving pre-existing turn snapshots.
    summary_read_max_tokens: z.number().int().min(1).max(1048576).nullable().optional(),
    retrieval_mode: RetrievalModeSchema.default("standard"),
    retrieval_presets: RetrievalPresetsSchema.default(DEFAULT_RETRIEVAL_PRESETS),
    // 15 minutes, not 5: this budget covers capacity probes plus every
    // compression / summary / retrieval auxiliary call, and those run on the
    // same local model as the chat turn.
    auxiliary_timeout_seconds: z
      .number()
      .refine((v) => v > 0 && v <= 3600, "必须 0 < x <= 3600")
      .default(900),
    max_catalog_batches: z.number().int().min(1).max(10000).default(100),
    catalog_batch_size: z.number().int().min(1).max(10000).default(30),
    // Compatibility only for stored configurations/snapshots; automatic recall is retired.
    recall_max_tokens: z.number().int().min(1).max(1048576).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.context_window !== null) {
      const budget = v.max_output_tokens + v.context_window * v.safety_margin_ratio;
      if (!(budget < v.context_window)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "最大回复预留加安全余量必须小于上下文容量",
          path: ["context_window"],
        });
      }
    }
    if (v.summary_target_tokens > v.summary_max_tokens) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "摘要目标不能超过摘要硬上限",
        path: ["summary_target_tokens"],
      });
    }
  });

export type P5Config = z.infer<typeof P5ConfigSchema>;

/**
 * /models/capacity has three disjoint shapes (api/models.py:13-22):
 * loaded has integer context_length; unknown has null context_length;
 * unavailable has null context_length and a required string error_code.
 * loaded/unknown never carry error_code (#89).
 */
export const ModelCapacityResponseSchema = z.union([
  z.strictObject({
    model: rawString(1, 200),
    status: z.literal("loaded"),
    context_length: z.number().int(),
  }),
  z.strictObject({
    model: rawString(1, 200),
    status: z.literal("unknown"),
    context_length: z.null(),
  }),
  z.strictObject({
    model: rawString(1, 200),
    status: z.literal("unavailable"),
    context_length: z.null(),
    error_code: z.string().min(1),
  }),
]);

export type ModelCapacityResponse = z.infer<typeof ModelCapacityResponseSchema>;

/** `/models/local` response (api/schemas.py:200-206). */
export const LocalModelCatalogResponseSchema = z.strictObject({
  provider: z.literal("lm_studio"),
  status: LocalModelStatusSchema,
  models: z.array(z.string()),
  default_model: z.string(),
});

export type LocalModelCatalogResponse = z.infer<typeof LocalModelCatalogResponseSchema>;
