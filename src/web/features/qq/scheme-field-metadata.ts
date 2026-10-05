// 方案/本群配置字段元数据的唯一领域所有者（纯数据，无 UI 依赖）：
// 字段文案键、枚举选项键、触发器文案、能力文案。screens 与 features 的 dirty/预览展示都从这里消费。
// 依赖方向：screens -> features 合法；本模块绝不 import screens 或 UI 组件。

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
  ...Object.fromEntries(participationFields.map(([name, label]) => [`rhythm.${name}`, label])),
  ...Object.fromEntries(
    [...stickerFields, ...imageFields].map(([group, name, label]) => [`${group}.${name}`, label]),
  ),
  "rhythm.active_hours_enabled": "connections.allowedHours",
  "rhythm.active_hours_start_minutes": "connections.allowedHoursStart",
  "rhythm.active_hours_end_minutes": "connections.allowedHoursEnd",
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
};
