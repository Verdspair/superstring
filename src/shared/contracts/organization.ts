import { z } from "zod";

const modelName = z.string().trim().min(1).max(200).nullable();
/**
 * §7.1's media purposes, on the SHARED row rather than per assistant (user decision 2026-09-24):
 * annotating a sticker is a QQ-wide operation that belongs to no assistant, and reading media
 * inside QQ uses the same pair. Unset means "cannot understand" — P4b's rule, which is why the
 * fallback to the conversation model that every other purpose has does NOT apply here.
 */
export const OrganizationSettingsSchema = z.strictObject({
  model_name: modelName,
  vision_model_name: modelName,
  transcription_model_name: modelName,
  revision: z.number().int().min(1),
});
export const OrganizationSettingsUpdateSchema = z.strictObject({
  model_name: modelName,
  /** Absent leaves the purpose alone — the same three-state discipline as the QQ transport token. */
  vision_model_name: modelName.optional(),
  transcription_model_name: modelName.optional(),
  expected_revision: z.number().int().min(1),
});
export type OrganizationSettings = z.infer<typeof OrganizationSettingsSchema>;
export type OrganizationSettingsUpdate = z.infer<typeof OrganizationSettingsUpdateSchema>;
