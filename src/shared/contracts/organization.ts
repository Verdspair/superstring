import { z } from "zod";
import { GlobalAuxiliaryAllocationSchema } from "./context-allocation";

const modelName = z.string().trim().min(1).max(200).nullable();
/**
 * §7.1's media purposes, on the SHARED row rather than per assistant:
 * annotating a sticker is a QQ-wide operation that belongs to no assistant, and reading media
 * inside QQ uses the same pair. Unset means "cannot understand" — P4b's rule, which is why the
 * fallback to the conversation model that every other purpose has does NOT apply here.
 */
export const OrganizationSettingsSchema = z.strictObject({
  model_name: modelName,
  vision_model_name: modelName,
  transcription_model_name: modelName,
  /**
   * 全局辅助任务分配（0068）。optional 是显式契约：旧行/旧响应不含该字段仍可解析；仓储
   * 读取时 NULL 列与缺席同样解释为「无任何辅助覆盖」，各用途保持调用方现行为。
   */
  auxiliary_allocation: GlobalAuxiliaryAllocationSchema.optional(),
  revision: z.number().int().min(1),
});
export const OrganizationSettingsUpdateSchema = z.strictObject({
  /** 0068 起可选：缺席＝保留现值，使分配可以单独补丁而不夹带模型改写。 */
  model_name: modelName.optional(),
  /** Absent leaves the purpose alone — the same three-state discipline as the QQ transport token. */
  vision_model_name: modelName.optional(),
  transcription_model_name: modelName.optional(),
  /** 分配组（0068）。整组来或整组不动：缺席＝保持现值。 */
  auxiliary_allocation: GlobalAuxiliaryAllocationSchema.optional(),
  expected_revision: z.number().int().min(1),
});
export type OrganizationSettings = z.infer<typeof OrganizationSettingsSchema>;
export type OrganizationSettingsUpdate = z.infer<typeof OrganizationSettingsUpdateSchema>;
