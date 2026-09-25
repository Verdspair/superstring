import { z } from "zod";
import { UuidSchema } from "./common";
import { ContentItemSchema } from "./content";

const revision = z.number().int().positive();
const categoryId = z.union([z.literal("default"), UuidSchema]);
const name = z
  .string()
  .min(1)
  .max(200)
  .refine((text) => text.trim().length > 0 && !text.includes("\0"));
// No normalization: offsets refer to the exact UTF-16 string retained on import.
export const KnowledgeTextSchema = z
  .string()
  .refine((text) => text.trim().length > 0 && !text.includes("\0") && text.isWellFormed());
export const KnowledgeImportSchema = z.strictObject({
  name,
  category_id: categoryId,
  original_text: KnowledgeTextSchema,
});
export const KnowledgeRevisionSchema = z.strictObject({ expected_revision: revision });
export const KnowledgeCategoryCreateSchema = z.strictObject({ name });
export const KnowledgeCategoryUpdateSchema = z.strictObject({ name, expected_revision: revision });
export const KnowledgeCategoryDeleteSchema = z.strictObject({
  expected_revision: revision,
  move_to: categoryId.optional(),
});
export const KnowledgeDocumentUpdateSchema = z
  .strictObject({
    expected_revision: revision,
    name: name.optional(),
    category_id: categoryId.optional(),
    original_text: KnowledgeTextSchema.optional(),
    content_mode: z.enum(["draft", "original"]).optional(),
  })
  .refine((body) => Object.keys(body).length > 1);
export const KnowledgeGrantUpdateSchema = z.strictObject({
  expected_revision: revision,
  agent_ids: z.array(UuidSchema).refine((ids) => new Set(ids).size === ids.length),
});
export const KnowledgeBatchGrantSchema = z.strictObject({
  documents: z
    .array(z.strictObject({ id: UuidSchema, expected_revision: revision }))
    .min(1)
    .refine((items) => new Set(items.map((item) => item.id)).size === items.length),
  agent_id: UuidSchema,
  granted: z.boolean(),
});
export const KnowledgeSettingsUpdateSchema = z.strictObject({
  expected_revision: revision,
  auto_enabled: z.boolean(),
  model_name: z
    .string()
    .min(1)
    .refine((text) => text.trim().length > 0)
    .nullable(),
  context_budget: z.number().int().positive(),
});
export const KnowledgeSettingsSchema = KnowledgeSettingsUpdateSchema.omit({
  expected_revision: true,
}).extend({ revision });
export const KnowledgeCategorySchema = z.strictObject({
  id: categoryId,
  name,
  revision,
  document_count: z.number().int().nonnegative(),
});
export const KnowledgeDocumentSchema = z.strictObject({
  id: UuidSchema,
  category_id: categoryId,
  name,
  import_type: z.enum(["text", "txt", "md"]),
  content_mode: z.enum(["draft", "original"]),
  content_version: revision,
  revision,
  created_at: z.string(),
  updated_at: z.string(),
  agent_ids: z.array(UuidSchema),
  summary: z.string(),
  tags: z.array(z.string()),
  organization_status: z.enum([
    "pending",
    "queued",
    "running",
    "succeeded",
    "failed",
    "cancelled",
    "disabled",
  ]),
  error_code: z.string().nullable(),
  latest_job_id: UuidSchema.nullable().optional(),
});
export const KnowledgeDocumentDetailSchema = KnowledgeDocumentSchema.extend({
  original_text: z.string(),
  content: ContentItemSchema,
  draft: ContentItemSchema.nullable(),
});
export const AgentKnowledgeSchema = KnowledgeDocumentSchema.pick({
  id: true,
  name: true,
  summary: true,
  tags: true,
  content_mode: true,
  organization_status: true,
});
// S3 first batch. Defaults preserve existing authorized-library behavior.
export const AgentKnowledgeReadConfigSchema = z
  .strictObject({
    enabled: z.boolean().default(true),
    context_budget: z.number().int().positive().nullable().default(null),
    scope: z.enum(["all", "selected"]).default("all"),
    document_ids: z.array(UuidSchema).default([]),
  })
  .superRefine((value, ctx) => {
    if (new Set(value.document_ids).size !== value.document_ids.length)
      ctx.addIssue({ code: "custom", path: ["document_ids"], message: "资料 ID 不得重复" });
    if (value.scope === "all" && value.document_ids.length)
      ctx.addIssue({
        code: "custom",
        path: ["document_ids"],
        message: "全部授权模式不保存指定清单",
      });
  });
export const AgentKnowledgeReadSettingsSchema = z.strictObject({
  revision,
  config: AgentKnowledgeReadConfigSchema,
});
export const AgentKnowledgeReadUpdateSchema = z.strictObject({
  expected_revision: revision,
  config: AgentKnowledgeReadConfigSchema,
});
export const FrozenKnowledgeReadSchema = z.strictObject({
  config: AgentKnowledgeReadConfigSchema,
  revision,
  budget: z.number().int().positive(),
  budget_source: z.enum(["global", "assistant"]),
  global_revision: revision,
  auto_enabled: z.boolean(),
});
export type FrozenKnowledgeRead = z.infer<typeof FrozenKnowledgeReadSchema>;
export type AgentKnowledgeReadConfig = z.infer<typeof AgentKnowledgeReadConfigSchema>;
export type AgentKnowledgeReadSettings = z.infer<typeof AgentKnowledgeReadSettingsSchema>;
export type AgentKnowledgeReadUpdate = z.infer<typeof AgentKnowledgeReadUpdateSchema>;
export type KnowledgeImport = z.infer<typeof KnowledgeImportSchema>;
export type KnowledgeDocumentUpdate = z.infer<typeof KnowledgeDocumentUpdateSchema>;
export type KnowledgeSettingsUpdate = z.infer<typeof KnowledgeSettingsUpdateSchema>;
export type KnowledgeSettings = z.infer<typeof KnowledgeSettingsSchema>;
export type KnowledgeCategory = z.infer<typeof KnowledgeCategorySchema>;
export type KnowledgeDocument = z.infer<typeof KnowledgeDocumentSchema>;
export type KnowledgeDocumentDetail = z.infer<typeof KnowledgeDocumentDetailSchema>;
export type KnowledgeBatchGrant = z.infer<typeof KnowledgeBatchGrantSchema>;
export type AgentKnowledge = z.infer<typeof AgentKnowledgeSchema>;
