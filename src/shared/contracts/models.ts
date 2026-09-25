import { z } from "zod";
import { LocalModelStatusSchema, nonBlankString, RetrievalModeSchema, rawString } from "./common";

/**
 * Model catalogue and context-budget (P5) contracts. Pure `zod` only.
 * */

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

/** A single retrieval preset. */
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
 * P5 context-budget configuration.
 * Cross-field invariants:
 * - `max_output_tokens + context_window * safety_margin_ratio < context_window`
 * whenever `context_window` is set.
 * - `summary_target_tokens <= summary_max_tokens`.
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
 * /models/capacity has three disjoint shapes:
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

/** `/models/local` response. */
export const LocalModelCatalogResponseSchema = z.strictObject({
  provider: z.literal("lm_studio"),
  status: LocalModelStatusSchema,
  models: z.array(z.string()),
  default_model: z.string(),
});

export type LocalModelCatalogResponse = z.infer<typeof LocalModelCatalogResponseSchema>;

// ---- 外部模型 API（0032，用户 2026-09-25）--------------------------------------------------

/** One model a provider serves, with the context window the user typed for it. */
export const ModelProviderModelSchema = z.strictObject({
  name: nonBlankString(1, 200),
  /**
   * 手填的上下文窗口。外部服务通常不报这个数，而容量预检拿不到数就一律拒绝（QQ 的判断/回复/
   * 复核/选图与标注都先过这道闸）——所以这里没有默认值：填了才可用。
   */
  context_window: z.number().int().min(256).max(10_000_000),
});
export type ModelProviderModel = z.infer<typeof ModelProviderModelSchema>;

/** A provider declares a handful of models, not a catalogue mirror. */
export const MODEL_PROVIDER_MODEL_LIMIT = 50;
export const MODEL_PROVIDER_LIST_LIMIT = 20;

const ProviderName = nonBlankString(1, 100);
/** Only the OpenAI-compatible surface is supported; the scheme check catches typos early. */
const ProviderBaseUrl = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine((value) => /^https?:\/\//.test(value), {
    message: "地址必须以 http:// 或 https:// 开头",
  });

/**
 * A provider as the page receives it. The key is never echoed: the response says whether one is
 * stored, exactly like the QQ transport token.
 */
export const ModelProviderResponseSchema = z.strictObject({
  id: z.string().uuid(),
  name: ProviderName,
  base_url: ProviderBaseUrl,
  has_api_key: z.boolean(),
  models: z.array(ModelProviderModelSchema).max(MODEL_PROVIDER_MODEL_LIMIT),
  revision: z.number().int().positive(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type ModelProviderResponse = z.infer<typeof ModelProviderResponseSchema>;

export const CreateModelProviderRequestSchema = z.strictObject({
  name: ProviderName,
  base_url: ProviderBaseUrl,
  /** Omitted or empty means "no key"; the value is write-only. */
  api_key: z.string().max(500).nullable().optional(),
  models: z.array(ModelProviderModelSchema).max(MODEL_PROVIDER_MODEL_LIMIT).optional(),
});
export type CreateModelProviderRequest = z.infer<typeof CreateModelProviderRequestSchema>;

export const UpdateModelProviderRequestSchema = z.strictObject({
  name: ProviderName.optional(),
  base_url: ProviderBaseUrl.optional(),
  /** Absent leaves the stored key alone; `null` clears it. */
  api_key: z.string().max(500).nullable().optional(),
  /** The whole list travels, like every other group in this project. */
  models: z.array(ModelProviderModelSchema).max(MODEL_PROVIDER_MODEL_LIMIT).optional(),
  expected_revision: z.number().int().positive(),
});
export type UpdateModelProviderRequest = z.infer<typeof UpdateModelProviderRequestSchema>;

/** The "test connection" answer: what the provider's own `/models` said, or why it could not. */
export const ModelProviderTestResponseSchema = z.strictObject({
  ok: z.boolean(),
  models: z.array(z.string()),
  error: z.string().nullable(),
});
export type ModelProviderTestResponse = z.infer<typeof ModelProviderTestResponseSchema>;
