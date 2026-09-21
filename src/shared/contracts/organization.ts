import { z } from "zod";

const modelName = z.string().trim().min(1).max(200).nullable();
export const OrganizationSettingsSchema = z.strictObject({
  model_name: modelName,
  revision: z.number().int().min(1),
});
export const OrganizationSettingsUpdateSchema = z.strictObject({
  model_name: modelName,
  expected_revision: z.number().int().min(1),
});
export type OrganizationSettings = z.infer<typeof OrganizationSettingsSchema>;
export type OrganizationSettingsUpdate = z.infer<typeof OrganizationSettingsUpdateSchema>;
