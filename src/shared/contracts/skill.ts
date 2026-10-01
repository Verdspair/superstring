import { z } from "zod";

const codePoints = (value: string) => [...value].length;
const NameSchema = z
  .string()
  .refine((value) => codePoints(value) >= 1 && codePoints(value) <= 64)
  .regex(/^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u)
  .refine((value) => !/\p{Uppercase}/u.test(value) && value === value.toLowerCase());
const descriptionSchema = z
  .string()
  .refine((value) => /\S/u.test(value) && codePoints(value) <= 1024);
// Preserve every string key, including __proto__, which z.record discards.
const stringMetadata = z.custom<Record<string, string>>((value) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (
    (prototype === Object.prototype || prototype === null) &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
});
const optionalMetadata = {
  license: z.string().optional(),
  compatibility: z
    .string()
    .refine((value) => /\S/u.test(value) && codePoints(value) <= 500)
    .optional(),
  metadata: stringMetadata.optional(),
  "allowed-tools": z.string().optional(),
};

export const SkillMetadataSchema = z.object({
  name: NameSchema,
  description: descriptionSchema,
  ...optionalMetadata,
});
export type SkillMetadata = z.infer<typeof SkillMetadataSchema>;

/** 目录条目来源：`system` = 随包系统组件（不可删除、定义不可改），`external` = 用户技能目录。 */
export const SkillOriginSchema = z.enum(["system", "external"]);
export type SkillOrigin = z.infer<typeof SkillOriginSchema>;

export const SkillCatalogEntrySchema = z.strictObject({
  name: NameSchema,
  description: descriptionSchema,
  revision: z.string(),
  origin: SkillOriginSchema,
  /** 全局 skills 模块停用时整目录灰显（只灰，不假 enabled）；系统组件仍保持在列。 */
  globalEnabled: z.boolean(),
});
export type SkillCatalogEntry = z.infer<typeof SkillCatalogEntrySchema>;

export const SkillCatalogResponseSchema = z.strictObject({
  skills: z.array(SkillCatalogEntrySchema),
  problems: z.array(z.strictObject({ skill: z.string(), code: z.string() })),
});
export type SkillCatalogResponse = z.infer<typeof SkillCatalogResponseSchema>;

export const SkillDetailResponseSchema = SkillCatalogEntrySchema.extend({
  instructions: z.string(),
  bodyChars: z.number().int().nonnegative(),
  ...optionalMetadata,
});
export type SkillDetailResponse = z.infer<typeof SkillDetailResponseSchema>;
