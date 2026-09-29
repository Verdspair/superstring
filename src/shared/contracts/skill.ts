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

export const SkillCatalogEntrySchema = z.strictObject({
  name: NameSchema,
  description: descriptionSchema,
  revision: z.string(),
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
