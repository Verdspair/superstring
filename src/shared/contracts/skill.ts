import { z } from "zod";

const NameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/);
export const SkillScriptSchema = z.strictObject({
  name: NameSchema,
  description: z.string().min(1).max(500),
  path: z.string().min(1).max(500),
  command: z.string().min(1).max(500),
  args: z.array(z.string().max(500)).max(20).default([]),
  directories: z.array(z.string().min(1).max(1_000)).max(20).default([]),
  timeoutMs: z.number().int().min(100).max(600_000).default(60_000),
  maxOutputChars: z.number().int().min(1).max(200_000).default(20_000),
});
export type SkillScript = z.infer<typeof SkillScriptSchema>;
export const SkillManifestSchema = z
  .strictObject({
    name: NameSchema,
    description: z.string().min(1).max(500),
    body: z.string().min(1).max(200).default("SKILL.md"),
    bodyMaxChars: z.number().int().min(100).max(200_000).default(20_000),
    scripts: z.array(SkillScriptSchema).max(20).default([]),
  })
  .refine(
    (manifest) =>
      new Set(manifest.scripts.map((script) => script.name)).size === manifest.scripts.length,
    "Script names must be unique",
  );
export type SkillManifest = z.infer<typeof SkillManifestSchema>;

// ---- 管理面（P7-b）：目录与详情投影 --------------------------------------------
// 目录只列已装技能的元数据与被拒绝条目的原因码；详情给受限正文与完整脚本声明。
// 授权、批准与执行仍走统一权限（`skill.<技能>.<脚本>`），这里不复制一份。

export const SkillScriptSummarySchema = z.strictObject({
  name: z.string(),
  description: z.string(),
  command: z.string(),
  args: z.array(z.string()),
  /** 清单里声明的目录（相对技能目录或绝对路径，原文照录）。 */
  directories: z.array(z.string()),
  /** 解析后的绝对目录：脚本的同意范围，不是 OS 沙箱。 */
  resolvedDirectories: z.array(z.string()),
  timeoutMs: z.number().int(),
  maxOutputChars: z.number().int(),
  /** 统一权限里的资源名：`skill.<技能>.<脚本>`。 */
  resource: z.string(),
});
export type SkillScriptSummary = z.infer<typeof SkillScriptSummarySchema>;

export const SkillCatalogEntrySchema = z.strictObject({
  name: z.string(),
  description: z.string(),
  /** 内容修订：清单、正文与声明入口的内容摘要。 */
  revision: z.string(),
  scriptCount: z.number().int().nonnegative(),
});
export type SkillCatalogEntry = z.infer<typeof SkillCatalogEntrySchema>;

export const SkillCatalogResponseSchema = z.strictObject({
  skills: z.array(SkillCatalogEntrySchema),
  /** 装了但读不出来的条目：目录名与稳定原因码。 */
  problems: z.array(z.strictObject({ skill: z.string(), code: z.string() })),
});
export type SkillCatalogResponse = z.infer<typeof SkillCatalogResponseSchema>;

export const SkillDetailResponseSchema = SkillCatalogEntrySchema.extend({
  instructions: z.string(),
  bodyChars: z.number().int().nonnegative(),
  scripts: z.array(SkillScriptSummarySchema),
});
export type SkillDetailResponse = z.infer<typeof SkillDetailResponseSchema>;
