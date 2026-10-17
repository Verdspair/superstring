// 统一上下文分配（0068）：模式契约。fixed＝按已存字段额度取用（既有行为，缺席也按它解释）；
// auto＝显式启用后按该请求实际可用容量取用可选材料（读取开关、授权、输出预留与安全余量不借）。
// 模式属于具体功能配置：这里只有最小形状 { mode }，各功能自己的策略字段归各自契约所有。

import { z } from "zod";

export const AllocationModeSchema = z.enum(["fixed", "auto"]);
export type AllocationMode = z.infer<typeof AllocationModeSchema>;

/** 模式组：mode 必填——"尚未决定"由整个对象缺席表达，不引入 modeless 空对象。 */
export const ContextAllocationSchema = z.strictObject({ mode: AllocationModeSchema });
export type ContextAllocation = z.infer<typeof ContextAllocationSchema>;

/**
 * 已校验值的唯一缺席解释点：null/undefined＝fixed（旧配置/旧快照的受保护缺席语义）。
 * 只接受已通过 ContextAllocationSchema 的形状，不做 unknown 宽化——非法值必须在上游抛出，
 * 不在这里被静默当成 fixed。
 */
export function contextAllocationMode(value?: { mode: AllocationMode } | null): AllocationMode {
  return value === null || value === undefined ? "fixed" : value.mode;
}

/** QQ 方案级的分配组：判断与回复是两份独立请求配置，分别持自己的模式。 */
export const QqSchemeAllocationSchema = z.strictObject({
  judgement: ContextAllocationSchema,
  reply: ContextAllocationSchema,
});
export type QqSchemeAllocation = z.infer<typeof QqSchemeAllocationSchema>;

/** 新建方案/旧行的初值：两档都按既有固定行为。 */
export const QQ_ALLOCATION_DEFAULT: QqSchemeAllocation = Object.freeze({
  judgement: Object.freeze({ mode: "fixed" }),
  reply: Object.freeze({ mode: "fixed" }),
});
// ---- 辅助任务分配（0068，AUX-CONTRACT-FROZEN）---------------------------------------------
//
// 辅助任务是单请求模型调用（知识整理、表情标注、媒体描述、记忆整理、记忆检索选材、研究子任务）。
// profile 描述"这一个用途的请求怎么限量"：input_limit 用该应用现有的估算输入单位（显式声明
// 完整请求计量器的用途除外），output_reserved 一律是发送给模型的 max_tokens，绝不是字符目标。

/** 单个辅助用途的分配档。mode 必填；两个限额都是可选三态（数字＝硬帽，null＝显式清帽，缺席＝跟随调用方现值）。 */
export const AuxiliaryAllocationProfileSchema = z.strictObject({
  mode: AllocationModeSchema,
  /** 硬输入上限：fixed＝显式输入帽照用；auto＝已知模型容量封顶、有值再加硬帽。不截断不可分输入。 */
  input_limit: z.number().int().positive().nullable().optional(),
  /** 硬输出预留：两种模式下都是 hard（发送 max_tokens）；缺席＝保留调用方现有的预留/公式。不发明 auto 输出比例。 */
  output_reserved: z.number().int().positive().nullable().optional(),
});
export type AuxiliaryAllocationProfile = z.infer<typeof AuxiliaryAllocationProfileSchema>;

/** 全局辅助用途（组织设置行）：整理、标注、媒体描述。 */
export const GlobalAuxiliaryAllocationSchema = z.strictObject({
  knowledge_organize: AuxiliaryAllocationProfileSchema.optional(),
  qq_sticker_annotate: AuxiliaryAllocationProfileSchema.optional(),
  qq_media_describe: AuxiliaryAllocationProfileSchema.optional(),
});
export type GlobalAuxiliaryAllocation = z.infer<typeof GlobalAuxiliaryAllocationSchema>;

/** 助手范围的辅助用途（P5）：记忆整理、记忆检索选材、研究子任务。 */
export const AgentAuxiliaryAllocationSchema = z.strictObject({
  memory_consolidate: AuxiliaryAllocationProfileSchema.optional(),
  memory_retrieval_select: AuxiliaryAllocationProfileSchema.optional(),
  research: AuxiliaryAllocationProfileSchema.optional(),
});
export type AgentAuxiliaryAllocation = z.infer<typeof AgentAuxiliaryAllocationSchema>;
