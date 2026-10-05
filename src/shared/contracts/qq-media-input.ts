// QQ 图片输入契约（双模式：原生输入 / 文字描述缓存）。不含原始 bytes——字节只存在于
// 服务端的受限资产仓储与 run 内句柄里，契约层只描述"以什么规格、哪个阶段、最多几张"。
//
// 分文件的原因（规格 §2.3）：`QqImageCategory` 由本文件唯一导出，`qq-message.ts` 只以
// `import type` 引用它——消息部件与图片策略各自演进，但分类只有一份，不能互相 runtime
// import 造成循环。
//
// 数值边界与 `QqSchemeRhythmSchema` 的现有媒体字段保持同一组数：帧数 1–10、尺寸 64–2048
// （src/shared/contracts/qq.ts）。`ordinary_still_max_dimension: null` 表示**原图**，不是
// 「跟随基础方案」——跟随语义由本群稀疏覆盖的"字段缺席"表达，null 是一个真实的设置值。

import { z } from "zod";

/** 一张图在取舍与规格选择上的类别；平台证据优先，模型补判次之，均无则 unknown。 */
export const QqImageCategorySchema = z.enum(["ordinary", "expression", "unknown"]);
export type QqImageCategory = z.infer<typeof QqImageCategorySchema>;

/** 图片进入模型输入的阶段；只影响实际发生的步骤，不新增固定评分或生成步骤。 */
export const QqImagePhaseSchema = z.enum(["decision", "evaluation", "generation"]);
export type QqImagePhase = z.infer<typeof QqImagePhaseSchema>;

const positiveInteger = z.number().int().positive();
/** 尺寸边界复用现有普通动图配置的 64–2048；上限是安全/服务约束，不是产品猜测。 */
const dimension = z.number().int().min(64).max(2048);
const frameCount = z.number().int().min(1).max(10);

/**
 * 图片输入设置组（QQ 方案级，本群可稀疏覆盖 stages 与普通静图规格）。
 *
 * 三个阶段布尔互相独立：全 false 是合法状态——图片能力开着但不自动发画面，仅按需读取。
 * `max_images` 的具体上限在执行期由服务/安全约束验证，schema 只要求正整数（规格 §7.1）。
 */
export const QqMediaInputSettingsSchema = z.strictObject({
  /** native＝直接向模型发画面；description＝读取文字描述缓存。新旧方案统一默认 native。 */
  mode: z.enum(["native", "description"]),
  stages: z.strictObject({
    decision: z.boolean(),
    evaluation: z.boolean(),
    generation: z.boolean(),
  }),
  max_images: positiveInteger,
  /** null = 原图优先，不默认降画质；设置值时是普通静图的最大长边。 */
  ordinary_still_max_dimension: dimension.nullable(),
  expression_max_dimension: dimension,
  expression_frame_count: frameCount,
  expression_frame_max_dimension: dimension,
});
export type QqMediaInputSettings = z.infer<typeof QqMediaInputSettingsSchema>;

/** 已批准默认值（规格 §7.1/§7.4，不随本任务更改）：native、三阶段全开、8 张、原图、表情 512、3 帧。 */
export const QQ_MEDIA_INPUT_DEFAULT: Readonly<QqMediaInputSettings> = Object.freeze({
  mode: "native",
  stages: Object.freeze({ decision: true, evaluation: true, generation: true }),
  max_images: 8,
  ordinary_still_max_dimension: null,
  expression_max_dimension: 512,
  expression_frame_count: 3,
  expression_frame_max_dimension: 512,
});

/**
 * 装配边界的只读媒体策略：本方案/本群覆盖汇合后的完整输入规格，加上普通动图的帧数与尺寸。
 * 普通动图两个值优先取现有 `rhythm.media_frame_count` / `media_max_dimension` 真源，
 * 不在 media_input 里重复存储（规格 §6）——所以只出现在 effective 层，不进设置组。
 */
export interface QqEffectiveMediaPolicy extends QqMediaInputSettings {
  ordinary_frame_count: number;
  ordinary_frame_max_dimension: number;
}
