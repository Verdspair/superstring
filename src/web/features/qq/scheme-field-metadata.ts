// 方案/本群配置字段元数据的唯一领域所有者（纯数据，无 UI 依赖）：
// 字段文案键、枚举选项键、触发器文案、能力文案。screens 与 features 的 dirty/预览展示都从这里消费。
// 依赖方向：screens -> features 合法；本模块绝不 import screens 或 UI 组件。

import type { QqSchemePrompts } from "../../../shared/contracts/qq";
import type { QqGroupCapability } from "../../../shared/contracts/qq-group-config";

export const TRIGGER_LABELS = {
  direct_reply: "connections.directReplies",
  follow_up: "connections.ongoingConversation",
  chiming_in: "connections.chimingIn",
  idle_topic: "connections.openingAQuietRoom",
} as const;

export const participationFields = [
  [
    "initiative_min_score",
    "connections.unpromptedSpeechThreshold010",
    "connections.theJudgementScoreMustReachThisThresholdBeforeSpeaking",
  ],
  [
    "initiative_batch_target_count",
    "connections.initiativeBatchTargetCount",
    "connections.initiativeBatchTargetCountHint",
  ],
  [
    "initiative_batch_jitter_count",
    "connections.initiativeBatchJitterCount",
    "connections.initiativeBatchJitterCountHint",
  ],
  [
    "merge_window_seconds",
    "connections.mergeWindowSeconds",
    "connections.messagesAreMergedBySpeakerMeasuredFromTheirLast",
  ],
  [
    "reply_cooldown_seconds",
    "connections.speechCooldownSeconds",
    "connections.minimumGapBetweenTwoUnpromptedUtterancesUnpromptedSpeechOnly",
  ],
  [
    "hourly_speech_limit",
    "connections.hourlyCap",
    "connections.unpromptedUtterancesInARollingHourUnpromptedSpeechOnly",
  ],
  [
    "idle_quiet_minutes",
    "connections.quietRoomThresholdMinutes",
    "connections.theConversationCountsAsQuietOnlyAfterThisLong",
  ],
] as const;

/**
 * 回复方式组的节奏类数字字段：与 participationFields 同形，供新分组视图消费。
 * max_recompute_count 是"同一回话目标的回复草稿再生成次数"（1 + 该值；见 bot-host generationLimit），
 * 属回复方式，不是主动发言的评分门槛。
 */
export const responseFields = [
  [
    "max_recompute_count",
    "connections.maximumRecomputes",
    "connections.howOftenAKeyAdditionMayForceARewrite",
  ],
] as const;

export const stickerFields = [
  ["rhythm", "max_sticker_count", "connections.stickersPerReply"],
  ["stickers", "sticker_min_repeat_minutes", "connections.shortestRepeatIntervalPerStickerMinutes"],
  ["stickers", "sticker_recent_avoid_count", "connections.avoidTheLastFew"],
] as const;

export const imageFields = [
  [
    "rhythm",
    "media_supplement_window_minutes",
    "connections.waitAfterMediaFailsOnADirectMentionMinutes",
  ],
  ["rhythm", "media_frame_count", "connections.animationFramesToSample"],
  ["rhythm", "media_max_dimension", "connections.sampledFrameLongEdgePx"],
] as const;

/**
 * 方案字段 → 文案键的唯一映射（canonical 持久键 `group.field`，含触发器、0052 两组与 stages）。
 * 消费方：scheme-studio、group-config、binding-editor（换方案预览）、draft-state（QQ 草稿变更行）。
 * 键缺项时各消费方退回契约字段名本身，不在这里兜底。
 */
export const QQ_SCHEME_FIELD_LABELS: Readonly<Record<string, string>> = {
  ...Object.fromEntries(
    Object.entries(TRIGGER_LABELS).map(([key, label]) => [`triggers.${key}`, label]),
  ),
  ...Object.fromEntries(
    [...participationFields, ...responseFields].map(([name, label]) => [`rhythm.${name}`, label]),
  ),
  ...Object.fromEntries(
    [...stickerFields, ...imageFields].map(([group, name, label]) => [`${group}.${name}`, label]),
  ),
  "rhythm.active_hours_enabled": "connections.allowedHours",
  "rhythm.active_hours_start_minutes": "connections.allowedHoursStart",
  "rhythm.active_hours_end_minutes": "connections.allowedHoursEnd",
  "rhythm.initiative_queue_on_busy": "connections.initiativeQueueOnBusy",
  "context.judgement_message_limit": "connections.judgementRecentMessages",
  "context.judgement_window_minutes": "connections.judgementTimeWindowMinutes",
  "context.judgement_token_budget": "connections.judgementBudgetEstimatedBytes",
  "context.reply_message_limit": "connections.replyRecentMessages",
  "context.reply_window_minutes": "connections.replyTimeWindowMinutes",
  "context.reply_token_budget": "connections.replyBudgetEstimatedBytes",
  "compression.watermark_trigger": "connections.watermarkTriggerMessages",
  "compression.package_limit": "connections.watermarkPackageLimit",
  "compression.headroom_ratio": "connections.assemblyHeadroomPercent",
  "output_reserve.judgement_output_reserved": "connections.judgementOutputReserveEstimatedBytes",
  "output_reserve.reply_output_reserved": "connections.replyOutputReserveEstimatedBytes",
  "sticker_collections.collection_ids": "connections.authorizedCollections",
  "prompts.scene": "connections.sceneAndBehaviour",
  "prompts.judge": "connections.judgementTask",
  "prompts.reply": "connections.effectiveReplyTask",
  "prompts.review": "connections.reviewTask",
  "prompts.sticker": "connections.stickerTask",
  "prompts.media": "connections.mediaNoteTask",
  "prompts.compress": "connections.watermarkCompressionTask",
  "reply.split_by_speaker": "connections.answerEachSpeakerSeparately",
  // 0052 两组。
  "message_settings.reply_mode": "connections.quoteReplyMode",
  "message_settings.reply_depth": "connections.quoteDepth",
  "message_settings.time_display": "connections.timeDisplayMode",
  "message_settings.timezone": "connections.timezone",
  "media_input.mode": "connections.imageInputMode",
  "media_input.stages.decision": "schemes.studio.stageDecision",
  "media_input.stages.evaluation": "schemes.studio.stageEvaluation",
  "media_input.stages.generation": "schemes.studio.stageGeneration",
  "media_input.max_images": "connections.maxAutoImages",
  "media_input.ordinary_still_max_dimension": "connections.ordinaryStillMaxDimension",
  "media_input.expression_max_dimension": "connections.expressionStillMaxDimension",
  "media_input.expression_frame_count": "connections.expressionFrameCount",
  "media_input.expression_frame_max_dimension": "connections.expressionFrameMaxDimension",
};

/**
 * 方案配置的六个目的分组（共享方案与本群覆盖共用同一份 id 与文案键）。
 * id 是稳定的 section key（用于错误定位映射与展示导航）；labelKey 只指向界面文案，
 * 由 locale 单一作者维护。SchemeTask 类型由这里的 id 列表派生，不另抄第二份 id 清单。
 */
export const QQ_SCHEME_SECTIONS = [
  { id: "participation", labelKey: "schemes.sections.participation" },
  { id: "response", labelKey: "schemes.sections.response" },
  { id: "context_reading", labelKey: "schemes.sections.contextReading" },
  { id: "history_compression", labelKey: "schemes.sections.historyCompression" },
  { id: "image_understanding", labelKey: "schemes.sections.imageUnderstanding" },
  { id: "sticker_sending", labelKey: "schemes.sections.stickerSending" },
] as const;
export type QqSchemeSection = (typeof QQ_SCHEME_SECTIONS)[number]["id"];

/** rhythm 组内按字段名分流的分组：节奏类属发言时机，媒体/表情类各自成组。 */
const rhythmSectionByName: Readonly<Record<string, QqSchemeSection>> = {
  ...Object.fromEntries(participationFields.map(([name]) => [name, "participation"])),
  ...Object.fromEntries(responseFields.map(([name]) => [name, "response"])),
  ...Object.fromEntries(
    imageFields
      .filter(([group]) => group === "rhythm")
      .map(([, name]) => [name, "image_understanding"]),
  ),
  ...Object.fromEntries(
    stickerFields
      .filter(([group]) => group === "rhythm")
      .map(([, name]) => [name, "sticker_sending"]),
  ),
  active_hours_enabled: "participation",
  active_hours_start_minutes: "participation",
  active_hours_end_minutes: "participation",
  initiative_queue_on_busy: "participation",
};

/** 提示词槽位 → 分组：各自独立任务指导，不是固定流水线阶段。 */
const promptSectionBySlot: Readonly<Record<keyof QqSchemePrompts, QqSchemeSection>> = {
  scene: "response",
  judge: "participation",
  reply: "response",
  review: "response",
  compress: "history_compression",
  sticker: "sticker_sending",
  media: "image_understanding",
};

/** 编辑器 camelCase 组名 → 契约 canonical 组名；错误定位同时接受两种写法。 */
const groupAliases: Readonly<Record<string, string>> = {
  outputReserve: "output_reserve",
  messageSettings: "message_settings",
  mediaInput: "media_input",
};

/**
 * 字段 → 分组（field→section 的唯一真源）。接受 canonical 持久键与编辑器 camelCase 别名，
 * 供错误定位（无效数字所在分组）与展示导航共用；未识别字段回落到参与组，不在这里抛错。
 */
export function qqSchemeFieldSection(field: string): QqSchemeSection {
  const [rawGroup, ...rest] = field.split(".");
  const group = groupAliases[rawGroup] ?? rawGroup;
  const name = rest.join(".");
  if (group === "triggers") return "participation";
  if (group === "rhythm") return rhythmSectionByName[name] ?? "participation";
  if (group === "context" || group === "output_reserve" || group === "message_settings")
    return "context_reading";
  if (group === "compression") return "history_compression";
  if (group === "stickers" || group === "sticker_collections") return "sticker_sending";
  if (group === "reply") return "response";
  if (group === "prompts") return promptSectionBySlot[name as keyof QqSchemePrompts] ?? "response";
  if (group === "media_input") return "image_understanding";
  return "participation";
}

export const QQ_SCHEME_ENUM_OPTION_LABELS: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {
  "message_settings.reply_mode": {
    one_then_on_demand: "connections.quoteMode.one_then_on_demand",
    configured_depth: "connections.quoteMode.configured_depth",
  },
  "message_settings.time_display": {
    full: "connections.timeDisplay.full",
    full_relative: "connections.timeDisplay.full_relative",
    hybrid: "connections.timeDisplay.hybrid",
  },
  "media_input.mode": {
    native: "connections.imageMode.native",
    description: "connections.imageMode.description",
  },
};

/** 12 项本群能力文案键：draft-state 的变更行与 group-config 的能力列表共用。 */
export const QQ_GROUP_CAPABILITY_LABELS: Record<QqGroupCapability, string> = {
  memory_read: "schemes.qq.groupConfig.capability.memoryRead",
  memory_organize: "schemes.qq.groupConfig.capability.memoryOrganize",
  knowledge_read: "schemes.qq.groupConfig.capability.knowledgeRead",
  web: "schemes.qq.groupConfig.capability.web",
  media: "schemes.qq.groupConfig.capability.media",
  stickers: "schemes.qq.groupConfig.capability.stickers",
  tasks: "schemes.qq.groupConfig.capability.tasks",
  research: "schemes.qq.groupConfig.capability.research",
  code: "schemes.qq.groupConfig.capability.code",
  mcp: "schemes.qq.groupConfig.capability.mcp",
  skills: "schemes.qq.groupConfig.capability.skills",
  history_summary: "schemes.qq.groupConfig.capability.historySummary",
  members_read: "schemes.qq.groupConfig.capability.membersRead",
};
