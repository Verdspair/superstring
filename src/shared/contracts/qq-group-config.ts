// 本群 Agent 配置的公共契约：一份稀疏的"本群方案差异"（只固定显式自定义字段，其余跟随基础方案）
// 与一组"本群停用的系统能力"。差异读取时再与基础方案合并，空差异不落库。

import { z } from "zod";
import { UuidSchema } from "./common";
import {
  QQ_MEDIA_INPUT_SCHEME_DEFAULT,
  QQ_MESSAGE_SETTINGS_SCHEME_DEFAULT,
  QqBindingResponseSchema,
  type QqBindingTriggers,
  QqBindingTriggersSchema,
  QqSchemeCompressionSchema,
  QqSchemeContextSchema,
  type QqSchemeMediaInput,
  QqSchemeMediaInputSchema,
  type QqSchemeMessageSettings,
  QqSchemeMessageSettingsSchema,
  QqSchemeOutputReserveSchema,
  QqSchemePromptsSchema,
  QqSchemeReplySchema,
  type QqSchemeResponse,
  QqSchemeResponseSchema,
  QqSchemeRhythmSchema,
  QqSchemeStickerCollectionsSchema,
  QqSchemeStickersSchema,
} from "./qq";

/** 本群可以停用的系统能力；未登记的键读到即拒绝。 */
export const QqGroupCapabilitySchema = z.enum([
  "memory_read",
  "memory_organize",
  "knowledge_read",
  "web",
  "media",
  "stickers",
  "tasks",
  "research",
  "code",
  "mcp",
  "skills",
  "history_summary",
]);
export type QqGroupCapability = z.infer<typeof QqGroupCapabilitySchema>;

/** 带默认值的字段在做成可选覆盖前必须去掉默认值：否则"没改"会被写成"固定成默认文案"。 */
function stripDefault<T extends z.ZodTypeAny>(
  field: T,
): T extends z.ZodDefault<infer Inner> ? Inner : T {
  return (field instanceof z.ZodDefault ? field.unwrap() : field) as never;
}

const Scheme = {
  rhythm: QqSchemeRhythmSchema.shape,
  context: QqSchemeContextSchema.shape,
  compression: QqSchemeCompressionSchema.shape,
  outputReserve: QqSchemeOutputReserveSchema.shape,
  stickers: QqSchemeStickersSchema.shape,
  prompts: QqSchemePromptsSchema.shape,
  reply: QqSchemeReplySchema.shape,
  messageSettings: QqSchemeMessageSettingsSchema.shape,
  mediaInput: QqSchemeMediaInputSchema.shape,
} as const;

/** 稀疏差异的九个组，逐字段取自现有方案契约；三个状态的 triggers 与绑定镜像同形。 */
const OverridesShapeBase = z.strictObject({
  triggers: z
    .strictObject({
      direct_reply: QqBindingTriggersSchema.shape.direct_reply.optional(),
      follow_up: QqBindingTriggersSchema.shape.follow_up.optional(),
      chiming_in: QqBindingTriggersSchema.shape.chiming_in.optional(),
      idle_topic: QqBindingTriggersSchema.shape.idle_topic.optional(),
    })
    .optional(),
  rhythm: z
    .strictObject({
      merge_window_seconds: Scheme.rhythm.merge_window_seconds.optional(),
      reply_cooldown_seconds: Scheme.rhythm.reply_cooldown_seconds.optional(),
      hourly_speech_limit: Scheme.rhythm.hourly_speech_limit.optional(),
      initiative_min_score: Scheme.rhythm.initiative_min_score.optional(),
      // `judgement_interval_turns` 已退役，不是可覆盖项。
      idle_quiet_minutes: Scheme.rhythm.idle_quiet_minutes.optional(),
      active_hours_enabled: Scheme.rhythm.active_hours_enabled.optional(),
      active_hours_start_minutes: Scheme.rhythm.active_hours_start_minutes.optional(),
      active_hours_end_minutes: Scheme.rhythm.active_hours_end_minutes.optional(),
      max_recompute_count: Scheme.rhythm.max_recompute_count.optional(),
      max_sticker_count: Scheme.rhythm.max_sticker_count.optional(),
      media_supplement_window_minutes: Scheme.rhythm.media_supplement_window_minutes.optional(),
      media_frame_count: Scheme.rhythm.media_frame_count.optional(),
      media_max_dimension: Scheme.rhythm.media_max_dimension.optional(),
    })
    .optional(),
  context: z
    .strictObject({
      judgement_message_limit: Scheme.context.judgement_message_limit.optional(),
      judgement_window_minutes: Scheme.context.judgement_window_minutes.optional(),
      judgement_token_budget: Scheme.context.judgement_token_budget.optional(),
      // `reply_message_limit` 跟随绑定助手，不是本群可覆盖项。
      reply_window_minutes: Scheme.context.reply_window_minutes.optional(),
      reply_token_budget: Scheme.context.reply_token_budget.optional(),
    })
    .optional(),
  compression: z
    .strictObject({
      watermark_trigger: Scheme.compression.watermark_trigger.optional(),
      package_limit: Scheme.compression.package_limit.optional(),
      headroom_ratio: Scheme.compression.headroom_ratio.optional(),
    })
    .optional(),
  output_reserve: z
    .strictObject({
      judgement_output_reserved: Scheme.outputReserve.judgement_output_reserved.optional(),
      reply_output_reserved: Scheme.outputReserve.reply_output_reserved.optional(),
    })
    .optional(),
  stickers: z
    .strictObject({
      sticker_min_repeat_minutes: Scheme.stickers.sticker_min_repeat_minutes.optional(),
      sticker_recent_avoid_count: Scheme.stickers.sticker_recent_avoid_count.optional(),
    })
    .optional(),
  /** 素材集合整体替换：必须落在基础方案已授权的集合之内，不能借本群配置扩大授权。 */
  sticker_collections: QqSchemeStickerCollectionsSchema.optional(),
  prompts: z
    .strictObject({
      scene: stripDefault(Scheme.prompts.scene).optional(),
      judge: stripDefault(Scheme.prompts.judge).optional(),
      reply: stripDefault(Scheme.prompts.reply).optional(),
      review: stripDefault(Scheme.prompts.review).optional(),
      sticker: stripDefault(Scheme.prompts.sticker).optional(),
      media: stripDefault(Scheme.prompts.media).optional(),
      compress: stripDefault(Scheme.prompts.compress).optional(),
    })
    .optional(),
  reply: z
    .strictObject({
      split_by_speaker: stripDefault(Scheme.reply.split_by_speaker).optional(),
    })
    .optional(),
  /** 消息设置组（0052）：逐字段稀疏，缺席＝跟随基础方案。 */
  message_settings: z
    .strictObject({
      reply_mode: Scheme.messageSettings.reply_mode.optional(),
      reply_depth: Scheme.messageSettings.reply_depth.optional(),
      time_display: Scheme.messageSettings.time_display.optional(),
      timezone: Scheme.messageSettings.timezone.optional(),
    })
    .optional(),
  /**
   * 图片输入组（0052）。stages 必须逐字段覆盖（三个 bool 独立）：浅合并会让只关一个阶段的
   * 提交把另外两个阶段清成缺省，所以这里把 stages 的每个成员单独做成可选字段。
   * `ordinary_still_max_dimension: null` 是真实设置值（＝原图），不是「跟随」——跟随只由
   * 字段缺席表达，所以 nullable 字段用 `.nullable()` 保留 null 语义。
   */
  media_input: z
    .strictObject({
      mode: Scheme.mediaInput.mode.optional(),
      stages: z
        .strictObject({
          decision: Scheme.mediaInput.stages.shape.decision.optional(),
          evaluation: Scheme.mediaInput.stages.shape.evaluation.optional(),
          generation: Scheme.mediaInput.stages.shape.generation.optional(),
        })
        .optional(),
      max_images: Scheme.mediaInput.max_images.optional(),
      ordinary_still_max_dimension: Scheme.mediaInput.ordinary_still_max_dimension.optional(),
      expression_max_dimension: Scheme.mediaInput.expression_max_dimension.optional(),
      expression_frame_count: Scheme.mediaInput.expression_frame_count.optional(),
      expression_frame_max_dimension: Scheme.mediaInput.expression_frame_max_dimension.optional(),
    })
    .optional(),
});

/** 空组不是覆盖、`triggers` 的 null 成员也不是覆盖、嵌套空 stages 同样不是覆盖，都从结果里去掉；`false`/`0`/空集合是实打实的覆盖。 */
function normalizeOverrides(
  value: z.infer<typeof OverridesShapeBase>,
): z.infer<typeof OverridesShapeBase> {
  const next: Record<string, unknown> = {};
  for (const [key, group] of Object.entries(value)) {
    if (group === undefined) continue;
    let entries = Object.entries(group as Record<string, unknown>).filter(
      ([, member]) => member !== undefined,
    );
    if (key === "triggers") entries = entries.filter(([, member]) => member !== null);
    // 0052 的 stages 是嵌套稀疏组：成员全空＝没有覆盖，整组去掉，与空组同义。
    if (key === "media_input") {
      entries = entries.filter(([, member]) => {
        if (member === null || typeof member !== "object" || Array.isArray(member)) return true;
        return Object.keys(member as Record<string, unknown>).length > 0;
      });
    }
    if (entries.length === 0) continue;
    next[key] = Object.fromEntries(entries);
  }
  return next as z.infer<typeof OverridesShapeBase>;
}

export const QqGroupSchemeOverridesSchema = OverridesShapeBase.transform(normalizeOverrides);
export type QqGroupSchemeOverrides = z.infer<typeof QqGroupSchemeOverridesSchema>;

/** 四个开关都不覆盖＝完全跟随基础方案；绑定镜像与配置记录共用这个空值形态。 */
export const QQ_GROUP_TRIGGERS_FOLLOW: QqBindingTriggers = Object.freeze({
  direct_reply: null,
  follow_up: null,
  chiming_in: null,
  idle_topic: null,
});

/** 差异是否为空（空差异不该作为快照落库）。 */
export function isEmptyQqGroupOverrides(overrides: QqGroupSchemeOverrides): boolean {
  return Object.keys(overrides).length === 0;
}

/** 能力停用是集合：去重并排序，同一集合的两种顺序不算变化、不重复写库。 */
export function normalizeQqGroupCapabilities(
  capabilities: readonly QqGroupCapability[],
): QqGroupCapability[] {
  return [...new Set(capabilities)].sort();
}

function mergeGroup<T extends object>(base: T, override: Partial<T> | undefined): T {
  if (override === undefined) return base;
  const defined: Partial<T> = {};
  for (const [key, value] of Object.entries(override)) {
    if (value !== undefined) (defined as Record<string, unknown>)[key] = value;
  }
  return { ...base, ...defined };
}

/**
 * 消息设置组的稀疏合并：本组没有嵌套结构，逐字段覆盖与 mergeGroup 同形。
 * `null`（如果未来某字段允许）与 `false`/`0` 一样是实打实的覆盖值，不是「跟随」——
 * 跟随只由字段缺席表达。基础方案缺这组时（0052 迁移落地前的既有方案）按已批准默认值生效，
 * 生效值永远是完整组。
 */
function mergeMessageSettings(
  base: QqSchemeMessageSettings | undefined,
  override: Partial<QqSchemeMessageSettings> | undefined,
): QqSchemeMessageSettings {
  return mergeGroup(base ?? QQ_MESSAGE_SETTINGS_SCHEME_DEFAULT, override);
}

/** 图片输入组的稀疏形状：stages 的三个布尔各自可选（这是逐字段跟随语义的类型表达）。 */
type SparseQqMediaInputOverride = {
  [K in keyof QqSchemeMediaInput]?: K extends "stages"
    ? Partial<QqSchemeMediaInput["stages"]>
    : QqSchemeMediaInput[K];
};

/**
 * 图片输入组的稀疏合并（0052）：stages 必须逐字段继承——`{ stages: { evaluation: false } }`
 * 合并后 decision/generation 保持基础方案的值。任何整组替换（浅合并）都会让未改的阶段丢失，
 * 所以这里逐字段展开。`ordinary_still_max_dimension: null` 合并后就是 null（原图），
 * 不会被当成跟随基础方案。基础方案缺这组时（0052 迁移落地前的既有方案）按已批准默认值生效，
 * 生效值永远是完整组。
 */
function mergeMediaInput(
  base: QqSchemeMediaInput | undefined,
  override: SparseQqMediaInputOverride | undefined,
): QqSchemeMediaInput {
  const effective = base ?? QQ_MEDIA_INPUT_SCHEME_DEFAULT;
  if (override === undefined) return effective;
  const { stages: overrideStages, ...restOverride } = override;
  const mergedStages =
    overrideStages === undefined
      ? effective.stages
      : {
          decision: overrideStages.decision ?? effective.stages.decision,
          evaluation: overrideStages.evaluation ?? effective.stages.evaluation,
          generation: overrideStages.generation ?? effective.stages.generation,
        };
  const defined: Partial<QqSchemeMediaInput> = {};
  for (const [key, value] of Object.entries(restOverride)) {
    if (value !== undefined) (defined as Record<string, unknown>)[key] = value;
  }
  return { ...effective, ...defined, stages: mergedStages };
}

/** 基础方案 + 本群差异 → 生效方案（纯函数，界面与服务端读路径共用同一套合并语义）。 */
export function mergeQqGroupScheme(
  base: QqSchemeResponse,
  overrides: QqGroupSchemeOverrides,
): QqSchemeResponse {
  return {
    ...base,
    triggers: {
      direct_reply: overrides.triggers?.direct_reply ?? base.triggers.direct_reply,
      follow_up: overrides.triggers?.follow_up ?? base.triggers.follow_up,
      chiming_in: overrides.triggers?.chiming_in ?? base.triggers.chiming_in,
      idle_topic: overrides.triggers?.idle_topic ?? base.triggers.idle_topic,
    },
    rhythm: mergeGroup(base.rhythm, overrides.rhythm),
    context: mergeGroup(base.context, overrides.context),
    compression: mergeGroup(base.compression, overrides.compression),
    output_reserve: mergeGroup(base.output_reserve, overrides.output_reserve),
    stickers: mergeGroup(base.stickers, overrides.stickers),
    prompts: mergeGroup(base.prompts, overrides.prompts),
    reply: mergeGroup(base.reply, overrides.reply),
    sticker_collections: overrides.sticker_collections ?? base.sticker_collections,
    message_settings: mergeMessageSettings(base.message_settings, overrides.message_settings),
    media_input: mergeMediaInput(base.media_input, overrides.media_input),
  };
}

/**
 * 本群配置的读取结果：`binding` 内的四个开关是绑定镜像，`base_scheme` 是当前基础方案，
 * `effective_scheme` 是合并后的生效值；`revision` 为 0 表示还没有记录。
 */
export const QqGroupConfigResponseSchema = z.strictObject({
  binding: QqBindingResponseSchema,
  base_scheme: QqSchemeResponseSchema,
  effective_scheme: QqSchemeResponseSchema,
  overrides: QqGroupSchemeOverridesSchema,
  disabled_capabilities: z.array(QqGroupCapabilitySchema),
  revision: z.number().int().nonnegative(),
});
export type QqGroupConfigResponse = z.infer<typeof QqGroupConfigResponseSchema>;

/**
 * 保存本群配置（整份状态提交，比较交换）。
 *
 * `agent_id` 是身份而不是可改字段；`expected_scheme_revision` 指*目标*基础方案的修订号；
 * `expected_revision` 指配置记录修订号，0 表示还没有记录。更换基础方案时必须显式给出
 * `scheme_change`：`keep` 保留差异、`reset` 清空方案差异（能力停用不随之重置）。
 */
export const UpdateQqGroupConfigRequestSchema = z.strictObject({
  agent_id: UuidSchema,
  expected_binding_revision: z.number().int().positive(),
  expected_scheme_revision: z.number().int().positive(),
  expected_revision: z.number().int().nonnegative(),
  overrides: QqGroupSchemeOverridesSchema,
  disabled_capabilities: z.array(QqGroupCapabilitySchema),
  scheme_id: UuidSchema.optional(),
  scheme_change: z.enum(["keep", "reset"]).optional(),
});
export type UpdateQqGroupConfigRequest = z.infer<typeof UpdateQqGroupConfigRequestSchema>;
