// Named QQ-global schemes: identity, switches, rhythm, context, prompts and output reserves.
// Bound schemes cannot be deleted; a no-op save preserves the revision.

import { asc, eq } from "drizzle-orm";
import {
  parseQqSchemeOutputReserve,
  QQ_COMPRESSION_DEFAULT,
  QQ_MEDIA_INPUT_SCHEME_DEFAULT,
  QQ_MESSAGE_SETTINGS_SCHEME_DEFAULT,
  QQ_MODEL_OUTPUT_RESERVE_DEFAULT,
  QQ_REPLY_DEFAULT,
  QQ_STICKER_DEDUP_DEFAULT,
  type QqSchemeCompression,
  type QqSchemeContext,
  type QqSchemeMediaInput,
  QqSchemeMediaInputSchema,
  type QqSchemeMessageSettings,
  QqSchemeMessageSettingsSchema,
  type QqSchemeOutputReserve,
  type QqSchemePrompts,
  type QqSchemeReply,
  QqSchemeReplySchema,
  type QqSchemeResponse,
  QqSchemeResponseSchema,
  type QqSchemeRhythm,
  type QqSchemeStickers,
  type QqSpeechTriggers,
} from "../../shared/contracts/qq";
import { resolveQqInteractionPair } from "../../shared/contracts/qq-group-config";
import { fail } from "../errors";
import type { QqBinding } from "../services/qq-binding-contract";
import {
  parseQqSchemeCompression,
  parseQqSchemeContext,
  QQ_CONTEXT_DEFAULT,
} from "../services/qq-context-contract";
import { parseQqSchemePrompts, QQ_PROMPT_DEFAULTS } from "../services/qq-prompt-contract";
import { parseQqSchemeRhythm, QQ_RHYTHM_DEFAULT } from "../services/qq-rhythm-contract";
import {
  parseQqSpeechTriggers,
  QQ_SPEECH_TRIGGERS_DEFAULT,
} from "../services/qq-speaking-contract";
import {
  parseQqSchemeStickerCollections,
  parseQqSchemeStickers,
} from "../services/qq-sticker-contract";
import { stableStringify } from "./json-text";
import { newId, nowIso, type Orm } from "./repositories";
import * as schema from "./schema";

export type QqSchemeRow = typeof schema.qqSchemes.$inferSelect;

/** The scheme fields a caller may set. The undecided §5.2 groups are deliberately absent. */
export interface QqSchemeInput {
  name: string;
  description?: string | null;
  /**
   * 回复形状（0035）。省略意味着更新时不动、新建时用默认（按发言人分条），与其余参数组同规矩。
   */
  reply?: QqSchemeReply;
  /**
   * The four speech switches. Omitted means "leave them alone" on update and "all off" on
   * create, which is the default a new scheme gets.
   */
  triggers?: QqSpeechTriggers;
  /**
   * The rhythm group. Omitted means "leave them alone" on update and the project defaults on
   * create. It travels whole or not at all, matching how the settings surface saves a group.
   */
  rhythm?: QqSchemeRhythm;
  /**
   * The two context tiers (P3b-2). Same whole-group rule as the rhythm group: it travels
   * whole or not at all.
   */
  context?: QqSchemeContext;
  /**
   * 压缩与装配（0046，）：水位攒够多少条压一次、最多留几个包、装配留多少冗余。
   * 与其余参数组同规矩：省略＝更新时不动、新建时用默认。
   */
  compression?: QqSchemeCompression;
  outputReserve?: QqSchemeOutputReserve;
  /**
   * §9.3's repetition rules (P4d). Whole group again: a scheme that specified only the hard
   * interval would still have to decide the soft one, and the defaults are not what the user
   * asked for in that case.
   */
  stickers?: QqSchemeStickers;
  /**
   * The collections this scheme may draw stickers from (P4g, §9.1). Omitted means "leave them
   * alone" on update and "none" on create — a new scheme authorizes nothing until the user says
   * which collections it may use. Replaces the whole set rather than merging: the surface edits a
   * set, and a merge would make removing an authorization impossible to express.
   */
  stickerCollections?: readonly string[];
  /**
   * The six prompts (P3c). Whole-group again: a half-edited prompt set would be a scheme
   * nobody can reason about, and every slot is non-blank in the schema anyway.
   */
  prompts?: QqSchemePrompts;
  /**
   * 消息设置组（0052，规格 §5/§6）：引用模式、层数、时间模式、时区。与其他 JSON 组同一规矩：
   * 省略＝更新时不动、新建时落已批准默认组（写入侧补默认，不是 NULL）。
   */
  messageSettings?: QqSchemeMessageSettings;
  /**
   * 图片输入组（0052，规格 §7）：模式、阶段开关、图数与规格。省略＝更新时不动、新建时落
   * 已批准默认组。`ordinary_still_max_dimension: null` 是「原图」这个真实设置值；普通动图的
   * 帧数/尺寸不在这组里（rhythm 是唯一真源），故存储时不得复制第二份。
   */
  mediaInput?: QqSchemeMediaInput;
}

/**
 * The switches as booleans, mapped through the contract so a row whose columns disagree
 * with it is rejected rather than treated as a usable scheme.
 */
export function schemeTriggers(row: QqSchemeRow): QqSpeechTriggers {
  return parseQqSpeechTriggers({
    direct_reply: row.triggerDirectReply === 1,
    follow_up: row.triggerFollowUp === 1,
    chiming_in: row.triggerChimingIn === 1,
    idle_topic: row.triggerIdleTopic === 1,
  });
}

/**
 * 回复形状（0035）。与其余参数组同规矩：整组来或整组不动，存储只认 0/1。
 */
export function schemeReply(row: QqSchemeRow): QqSchemeReply {
  return parseQqSchemeReply({ split_by_speaker: row.splitReplyBySpeaker === 1 });
}

/** 与其余参数组同一口径：组里的值不过契约就抛 TypeError，而不是把 ZodError 漏给调用方。 */
function parseQqSchemeReply(input: unknown): QqSchemeReply {
  const result = QqSchemeReplySchema.safeParse(input);
  if (!result.success) throw new TypeError("Invalid QQ scheme reply input");
  return Object.freeze(result.data);
}

/**
 * 严格 JSON 列的读取：值以 TEXT 存储（schema 的 json_valid CHECK 只保证合法 JSON object），
 * 读出口先 JSON.parse 再过契约——组不过契约（含坏 JSON）就抛 TypeError，不把 ZodError 或
 * 半截对象漏给调用方。
 */
function parseJsonColumn(value: string, what: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new TypeError(`Invalid QQ scheme ${what}: not valid JSON`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError(`Invalid QQ scheme ${what}: not a JSON object`);
  }
  return parsed;
}

function parseQqSchemeMessageSettings(input: unknown): QqSchemeMessageSettings {
  const result = QqSchemeMessageSettingsSchema.safeParse(input);
  if (!result.success) throw new TypeError("Invalid QQ scheme message settings");
  return Object.freeze(result.data);
}

function parseQqSchemeMediaInput(input: unknown): QqSchemeMediaInput {
  const result = QqSchemeMediaInputSchema.safeParse(input);
  if (!result.success) throw new TypeError("Invalid QQ scheme media input");
  return Object.freeze(result.data);
}

function replyColumns(reply: QqSchemeReply) {
  return { splitReplyBySpeaker: reply.split_by_speaker ? 1 : 0 };
}

/**
 * 消息设置组（0052）。行值是严格 JSON（TEXT 存储，读出口先解析）；NULL（理论上只出现在
 * 未经写入侧补默认的旧路径）按已批准默认组兜底，与迁移 0052 的回填语义一致。
 */
export function schemeMessageSettings(row: QqSchemeRow): QqSchemeMessageSettings {
  if (row.messageSettings === null) return QQ_MESSAGE_SETTINGS_SCHEME_DEFAULT;
  return parseQqSchemeMessageSettings(parseJsonColumn(row.messageSettings, "message_settings"));
}

/**
 * 图片输入组（0052）。NULL 兜底同上（迁移回填统一 native），普通动图的帧数/尺寸不在这组里，
 * 仍从 rhythm 的真源读取。
 */
export function schemeMediaInput(row: QqSchemeRow): QqSchemeMediaInput {
  if (row.mediaInput === null) return QQ_MEDIA_INPUT_SCHEME_DEFAULT;
  return parseQqSchemeMediaInput(parseJsonColumn(row.mediaInput, "media_input"));
}

function triggerColumns(triggers: QqSpeechTriggers) {
  return {
    triggerDirectReply: triggers.direct_reply ? 1 : 0,
    triggerFollowUp: triggers.follow_up ? 1 : 0,
    triggerChimingIn: triggers.chiming_in ? 1 : 0,
    triggerIdleTopic: triggers.idle_topic ? 1 : 0,
  };
}

function sameTriggers(left: QqSpeechTriggers, right: QqSpeechTriggers): boolean {
  return (
    left.direct_reply === right.direct_reply &&
    left.follow_up === right.follow_up &&
    left.chiming_in === right.chiming_in &&
    left.idle_topic === right.idle_topic
  );
}

/**
 * The rhythm group as the contract describes it, mapped so a row whose columns have drifted
 * outside the decided ranges is rejected rather than treated as a usable scheme.
 */
/**
 * The triggers that actually apply to one conversation (§0.6/F05, 0029).
 *
 * A binding may switch a module on or off for itself; `null` follows the scheme. This is the ONE
 * place that resolves the two, so every gate — judgement, generation, review, recompute, send
 * preflight, the sweep and the immediate-reply finder — answers the same question the same way.
 */
export function effectiveQqTriggers(
  binding: Pick<QqBinding, "triggers"> | null,
  scheme: QqSchemeRow,
): QqSpeechTriggers {
  const base = schemeTriggers(scheme);
  const pick = (override: boolean | null, fallback: boolean) => override ?? fallback;
  // 连续/自主的生效对统一走 resolveQqInteractionPair：方案自身或组合出的存量双 true
  // 都按 chiming_in 优先解释，无绑定与有绑定走同一归一。
  const pair = resolveQqInteractionPair({
    scheme: { follow_up: base.follow_up, chiming_in: base.chiming_in },
    binding:
      binding === null
        ? { follow_up: null, chiming_in: null }
        : { follow_up: binding.triggers.follow_up, chiming_in: binding.triggers.chiming_in },
  });
  return Object.freeze({
    direct_reply: pick(binding?.triggers.direct_reply ?? null, base.direct_reply),
    follow_up: pair.continuous,
    chiming_in: pair.chimingIn,
    idle_topic: pick(binding?.triggers.idle_topic ?? null, base.idle_topic),
  });
}

export function schemeRhythm(row: QqSchemeRow): QqSchemeRhythm {
  return parseQqSchemeRhythm({
    merge_window_seconds: row.mergeWindowSeconds,
    reply_cooldown_seconds: row.replyCooldownSeconds,
    hourly_speech_limit: row.hourlySpeechLimit,
    initiative_min_score: row.initiativeMinScore,
    judgement_interval_turns: row.judgementIntervalTurns,
    idle_quiet_minutes: row.idleQuietMinutes,
    active_hours_enabled: row.activeHoursEnabled === 1,
    active_hours_start_minutes: row.activeHoursStartMinutes,
    active_hours_end_minutes: row.activeHoursEndMinutes,
    max_recompute_count: row.maxRecomputeCount,
    max_sticker_count: row.maxStickerCount,
    media_supplement_window_minutes: row.mediaSupplementWindowMinutes,
    media_frame_count: row.mediaFrameCount,
    media_max_dimension: row.mediaMaxDimension,
    initiative_batch_target_count: row.initiativeBatchTargetCount,
    initiative_batch_jitter_count: row.initiativeBatchJitterCount,
    initiative_queue_on_busy: row.initiativeQueueOnBusy === 1,
    initiative_time_window_enabled: row.initiativeTimeWindowEnabled === 1,
    initiative_time_target_seconds: row.initiativeTimeTargetSeconds,
    initiative_time_jitter_seconds: row.initiativeTimeJitterSeconds,
  });
}

function rhythmColumns(rhythm: QqSchemeRhythm) {
  return {
    mergeWindowSeconds: rhythm.merge_window_seconds,
    replyCooldownSeconds: rhythm.reply_cooldown_seconds,
    hourlySpeechLimit: rhythm.hourly_speech_limit,
    initiativeMinScore: rhythm.initiative_min_score,
    judgementIntervalTurns: rhythm.judgement_interval_turns,
    idleQuietMinutes: rhythm.idle_quiet_minutes,
    activeHoursEnabled: rhythm.active_hours_enabled ? 1 : 0,
    activeHoursStartMinutes: rhythm.active_hours_start_minutes,
    activeHoursEndMinutes: rhythm.active_hours_end_minutes,
    maxRecomputeCount: rhythm.max_recompute_count,
    maxStickerCount: rhythm.max_sticker_count,
    mediaSupplementWindowMinutes: rhythm.media_supplement_window_minutes,
    mediaFrameCount: rhythm.media_frame_count,
    mediaMaxDimension: rhythm.media_max_dimension,
    initiativeBatchTargetCount: rhythm.initiative_batch_target_count,
    initiativeBatchJitterCount: rhythm.initiative_batch_jitter_count,
    initiativeQueueOnBusy: rhythm.initiative_queue_on_busy ? 1 : 0,
    initiativeTimeWindowEnabled: rhythm.initiative_time_window_enabled ? 1 : 0,
    initiativeTimeTargetSeconds: rhythm.initiative_time_target_seconds,
    initiativeTimeJitterSeconds: rhythm.initiative_time_jitter_seconds,
  };
}

function sameRhythm(left: QqSchemeRhythm, right: QqSchemeRhythm): boolean {
  // Field-by-field rather than JSON.stringify: the key order of two objects that came from
  // different places is not a promise, and a false "changed" would bump the revision.
  return (
    left.merge_window_seconds === right.merge_window_seconds &&
    left.reply_cooldown_seconds === right.reply_cooldown_seconds &&
    left.hourly_speech_limit === right.hourly_speech_limit &&
    left.initiative_min_score === right.initiative_min_score &&
    left.judgement_interval_turns === right.judgement_interval_turns &&
    left.idle_quiet_minutes === right.idle_quiet_minutes &&
    left.active_hours_enabled === right.active_hours_enabled &&
    left.active_hours_start_minutes === right.active_hours_start_minutes &&
    left.active_hours_end_minutes === right.active_hours_end_minutes &&
    left.max_recompute_count === right.max_recompute_count &&
    left.max_sticker_count === right.max_sticker_count &&
    // Every field of the group belongs here: a missing one makes a save that changes only it look
    // like a no-op, and the page then reports "saved" over a write that never happened (P5o).
    left.media_supplement_window_minutes === right.media_supplement_window_minutes &&
    left.media_frame_count === right.media_frame_count &&
    left.media_max_dimension === right.media_max_dimension &&
    left.initiative_batch_target_count === right.initiative_batch_target_count &&
    left.initiative_batch_jitter_count === right.initiative_batch_jitter_count &&
    left.initiative_queue_on_busy === right.initiative_queue_on_busy &&
    left.initiative_time_window_enabled === right.initiative_time_window_enabled &&
    left.initiative_time_target_seconds === right.initiative_time_target_seconds &&
    left.initiative_time_jitter_seconds === right.initiative_time_jitter_seconds
  );
}

/** The two context tiers as the contract describes them (P3b-2). */
export function schemeContext(row: QqSchemeRow): QqSchemeContext {
  return parseQqSchemeContext({
    judgement_message_limit: row.judgementMessageLimit,
    judgement_window_minutes: row.judgementWindowMinutes,
    judgement_token_budget: row.judgementTokenBudget,
    reply_message_limit: row.replyMessageLimit,
    reply_window_minutes: row.replyWindowMinutes,
    reply_token_budget: row.replyTokenBudget,
  });
}

function contextColumns(context: QqSchemeContext) {
  return {
    judgementMessageLimit: context.judgement_message_limit,
    judgementWindowMinutes: context.judgement_window_minutes,
    judgementTokenBudget: context.judgement_token_budget,
    replyMessageLimit: context.reply_message_limit,
    replyWindowMinutes: context.reply_window_minutes,
    replyTokenBudget: context.reply_token_budget,
  };
}

function sameContext(left: QqSchemeContext, right: QqSchemeContext): boolean {
  return (
    left.judgement_message_limit === right.judgement_message_limit &&
    left.judgement_window_minutes === right.judgement_window_minutes &&
    left.judgement_token_budget === right.judgement_token_budget &&
    left.reply_message_limit === right.reply_message_limit &&
    left.reply_window_minutes === right.reply_window_minutes &&
    left.reply_token_budget === right.reply_token_budget
  );
}

/** 0046：压缩与装配组，映射口径与其余参数组一致（不过契约就抛 TypeError）。 */
export function schemeCompression(row: QqSchemeRow): QqSchemeCompression {
  return parseQqSchemeCompression({
    watermark_trigger: row.summaryWatermarkTrigger,
    package_limit: row.summaryPackageLimit,
    headroom_ratio: row.headroomRatio,
  });
}

function compressionColumns(compression: QqSchemeCompression) {
  return {
    summaryWatermarkTrigger: compression.watermark_trigger,
    summaryPackageLimit: compression.package_limit,
    headroomRatio: compression.headroom_ratio,
  };
}

function sameCompression(left: QqSchemeCompression, right: QqSchemeCompression): boolean {
  return (
    left.watermark_trigger === right.watermark_trigger &&
    left.package_limit === right.package_limit &&
    left.headroom_ratio === right.headroom_ratio
  );
}

/** Two independently editable reserves for complete QQ model calls (P3o). */
export function schemeOutputReserve(row: QqSchemeRow): QqSchemeOutputReserve {
  return parseQqSchemeOutputReserve({
    judgement_output_reserved: row.judgementOutputReserved,
    reply_output_reserved: row.replyOutputReserved,
  });
}
function outputReserveColumns(value: QqSchemeOutputReserve) {
  return {
    judgementOutputReserved: value.judgement_output_reserved,
    replyOutputReserved: value.reply_output_reserved,
  };
}
function sameOutputReserve(left: QqSchemeOutputReserve, right: QqSchemeOutputReserve): boolean {
  return (
    left.judgement_output_reserved === right.judgement_output_reserved &&
    left.reply_output_reserved === right.reply_output_reserved
  );
}

/** §9.3's two repetition rules as the contract describes them (P4d). */
export function schemeStickers(row: QqSchemeRow): QqSchemeStickers {
  return parseQqSchemeStickers({
    sticker_min_repeat_minutes: row.stickerMinRepeatMinutes,
    sticker_recent_avoid_count: row.stickerRecentAvoidCount,
  });
}
function stickerColumns(value: QqSchemeStickers) {
  return {
    stickerMinRepeatMinutes: value.sticker_min_repeat_minutes,
    stickerRecentAvoidCount: value.sticker_recent_avoid_count,
  };
}
function sameStickers(left: QqSchemeStickers, right: QqSchemeStickers): boolean {
  return (
    left.sticker_min_repeat_minutes === right.sticker_min_repeat_minutes &&
    left.sticker_recent_avoid_count === right.sticker_recent_avoid_count
  );
}

/** The six editable prompts as the contract describes them (P3c). */
export function schemePrompts(row: QqSchemeRow): QqSchemePrompts {
  return parseQqSchemePrompts({
    scene: row.promptScene,
    judge: row.promptJudge,
    reply: row.promptReply,
    review: row.promptReview,
    sticker: row.promptSticker,
    media: row.promptMedia,
    compress: row.promptCompress,
  });
}

function promptColumns(prompts: QqSchemePrompts) {
  return {
    promptScene: prompts.scene,
    promptJudge: prompts.judge,
    promptReply: prompts.reply,
    promptReview: prompts.review,
    promptSticker: prompts.sticker,
    promptMedia: prompts.media,
    promptCompress: prompts.compress,
  };
}

/** 0052 的两组严格 JSON：写入侧整组序列化（stages 整组、null 原图原样），不落半截组。 */
function messageSettingsColumns(value: QqSchemeMessageSettings) {
  return { messageSettings: stableStringify(parseQqSchemeMessageSettings(value)) };
}
function mediaInputColumns(value: QqSchemeMediaInput) {
  return { mediaInput: stableStringify(parseQqSchemeMediaInput(value)) };
}

function samePrompts(left: QqSchemePrompts, right: QqSchemePrompts): boolean {
  // Field-by-field rather than a JSON comparison: the six slots are the contract, and a slot
  // added later must make this function fail to compile rather than pass silently.
  return (
    left.scene === right.scene &&
    left.judge === right.judge &&
    left.reply === right.reply &&
    left.review === right.review &&
    left.sticker === right.sticker &&
    left.media === right.media &&
    left.compress === right.compress
  );
}

/** 0052 两组的逐字段比较：归一化后逐字段，键序差异不算变化（stableStringify 比较同效果，显式逐字段更严）。 */
function sameMessageSettings(
  left: QqSchemeMessageSettings,
  right: QqSchemeMessageSettings,
): boolean {
  return (
    left.reply_mode === right.reply_mode &&
    left.reply_depth === right.reply_depth &&
    left.time_display === right.time_display &&
    left.timezone === right.timezone
  );
}
function sameMediaInput(left: QqSchemeMediaInput, right: QqSchemeMediaInput): boolean {
  return (
    left.mode === right.mode &&
    left.stages.decision === right.stages.decision &&
    left.stages.evaluation === right.stages.evaluation &&
    left.stages.generation === right.stages.generation &&
    left.max_images === right.max_images &&
    left.ordinary_still_max_dimension === right.ordinary_still_max_dimension &&
    left.expression_max_dimension === right.expression_max_dimension &&
    left.expression_frame_count === right.expression_frame_count &&
    left.expression_frame_max_dimension === right.expression_frame_max_dimension
  );
}

/**
 * 方案行的线形（原 api/qq.ts 的本地映射）：路由、本群配置响应与将来的运行装配共用一份，
 * 两处各写一遍是漂移的温床。素材集合单列查询（方案授权表）。
 */
export function schemeResponse(orm: Orm, row: QqSchemeRow): QqSchemeResponse {
  return QqSchemeResponseSchema.parse({
    id: row.id,
    name: row.name,
    description: row.description,
    triggers: schemeTriggers(row),
    rhythm: schemeRhythm(row),
    context: schemeContext(row),
    compression: schemeCompression(row),
    output_reserve: schemeOutputReserve(row),
    stickers: schemeStickers(row),
    sticker_collections: { collection_ids: schemeStickerCollectionIds(orm, row.id) },
    prompts: schemePrompts(row),
    reply: schemeReply(row),
    message_settings: schemeMessageSettings(row),
    media_input: schemeMediaInput(row),
    revision: row.revision,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  });
}

/**
 * 组值 → 行上对应的列覆盖：本群生效行（基础行 + 覆盖列）唯一组装点。
 * 列名与组的对应关系只维护在这里，调用方拿到的永远是完整组值，不做逐字段的列拼接。
 * 0052 的两组：调用方（runtime 生效行）传入合并后的完整组，序列化成严格 JSON 列。
 */
export function schemeColumnsFromGroups(groups: {
  triggers: QqSpeechTriggers;
  rhythm: QqSchemeRhythm;
  context: QqSchemeContext;
  compression: QqSchemeCompression;
  outputReserve: QqSchemeOutputReserve;
  stickers: QqSchemeStickers;
  prompts: QqSchemePrompts;
  reply: QqSchemeReply;
  messageSettings?: QqSchemeMessageSettings;
  mediaInput?: QqSchemeMediaInput;
}): Partial<QqSchemeRow> {
  return {
    ...triggerColumns(groups.triggers),
    ...rhythmColumns(groups.rhythm),
    ...contextColumns(groups.context),
    ...compressionColumns(groups.compression),
    ...outputReserveColumns(groups.outputReserve),
    ...stickerColumns(groups.stickers),
    ...promptColumns(groups.prompts),
    ...replyColumns(groups.reply),
    ...(groups.messageSettings === undefined ? {} : messageSettingsColumns(groups.messageSettings)),
    ...(groups.mediaInput === undefined ? {} : mediaInputColumns(groups.mediaInput)),
  };
}

function normalizeName(name: string): string {
  const value = name.trim();
  if (value.length === 0) fail("MEMORY_SOURCE_INVALID", "方案名称不能为空");
  return value;
}

/**
 * The collections a scheme authorizes (P4g, §9.1), sorted like every other read of this set.
 *
 * This is what the sticker consumer passes as `authorizedCollectionIds`: authorization follows the
 * collection, so a scheme's reachable stickers are exactly the assets that sit in one of these.
 */
export function schemeStickerCollectionIds(orm: Orm, schemeId: string): string[] {
  return orm
    .select({ collectionId: schema.qqSchemeStickerCollections.collectionId })
    .from(schema.qqSchemeStickerCollections)
    .where(eq(schema.qqSchemeStickerCollections.schemeId, schemeId))
    .orderBy(asc(schema.qqSchemeStickerCollections.collectionId))
    .all()
    .map((row) => row.collectionId);
}

/**
 * Replace a scheme's authorized set, inside the caller's transaction.
 *
 * Every collection must exist, and this check runs BEFORE the delete so a bad id leaves the previous
 * authorization intact instead of half-applying. It is not redundant with the foreign key — that one
 * would refuse the row too, but it fails with a raw constraint error from the middle of a
 * transaction, while §9.1's surface needs to be told which collection is missing.
 */
function writeSchemeStickerCollections(
  orm: Orm,
  schemeId: string,
  collectionIds: readonly string[],
): void {
  const next = parseQqSchemeStickerCollections({ collection_ids: collectionIds });
  for (const collectionId of next) {
    const row = orm
      .select({ id: schema.qqStickerCollections.id })
      .from(schema.qqStickerCollections)
      .where(eq(schema.qqStickerCollections.id, collectionId))
      .get();
    if (!row) fail("MEMORY_NOT_FOUND", "集合不存在", 404);
  }
  orm
    .delete(schema.qqSchemeStickerCollections)
    .where(eq(schema.qqSchemeStickerCollections.schemeId, schemeId))
    .run();
  // Drizzle refuses an empty VALUES list, and an empty set is a real state ("no stickers").
  if (next.length === 0) return;
  const addedAt = nowIso();
  orm
    .insert(schema.qqSchemeStickerCollections)
    .values(next.map((collectionId) => ({ schemeId, collectionId, addedAt })))
    .run();
}

/** Both arrays come from `parseQqSchemeStickerCollections`, so element-wise equality is set equality. */
function sameStickerCollections(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

export function readQqSchemes(orm: Orm): QqSchemeRow[] {
  return orm
    .select()
    .from(schema.qqSchemes)
    .orderBy(asc(schema.qqSchemes.name), asc(schema.qqSchemes.id))
    .all();
}

export function readQqScheme(orm: Orm, id: string): QqSchemeRow | null {
  return orm.select().from(schema.qqSchemes).where(eq(schema.qqSchemes.id, id)).get() ?? null;
}

/**
 * Create a scheme. The name is the resource's identity to a human, so it is unique; a
 * duplicate is reported as a state conflict rather than surfacing a raw constraint error,
 * because the user's fix is to rename.
 */
/**
 * 方案自身的显式触发器写入（新建/更新共用）拒绝双 true：连续交谈与自主接话互斥，
 * 开启一项必须显式关闭另一项。存量 raw 双 true 的读取走 effectiveQqTriggers 的归一，
 * 不经这里。
 */
function assertSchemeInteractionPair(triggers: QqSpeechTriggers): void {
  if (triggers.follow_up && triggers.chiming_in) {
    fail("MEMORY_SOURCE_INVALID", "连续交谈与自主接话互斥，开启一项时另一项必须关闭");
  }
}

export function createQqScheme(orm: Orm, input: QqSchemeInput): QqSchemeRow {
  const name = normalizeName(input.name);
  assertSchemeInteractionPair(input.triggers ?? QQ_SPEECH_TRIGGERS_DEFAULT);
  const existing = orm
    .select({ id: schema.qqSchemes.id })
    .from(schema.qqSchemes)
    .where(eq(schema.qqSchemes.name, name))
    .get();
  if (existing) fail("MEMORY_STATE_CONFLICT", "已存在同名方案，请换一个名称");
  // The row and its authorized collections are one fact: a scheme created with an authorization
  // that failed to write would be a scheme whose stickers silently do not work.
  return orm.transaction(
    (tx) => {
      const row = tx
        .insert(schema.qqSchemes)
        .values({
          id: newId(),
          name,
          description: input.description ?? null,
          revision: 1,
          ...triggerColumns(input.triggers ?? QQ_SPEECH_TRIGGERS_DEFAULT),
          ...rhythmColumns(input.rhythm ?? QQ_RHYTHM_DEFAULT),
          ...contextColumns(input.context ?? QQ_CONTEXT_DEFAULT),
          ...compressionColumns(input.compression ?? QQ_COMPRESSION_DEFAULT),
          ...outputReserveColumns(input.outputReserve ?? QQ_MODEL_OUTPUT_RESERVE_DEFAULT),
          ...stickerColumns(input.stickers ?? QQ_STICKER_DEDUP_DEFAULT),
          ...promptColumns(parseQqSchemePrompts(input.prompts ?? QQ_PROMPT_DEFAULTS)),
          ...replyColumns(parseQqSchemeReply(input.reply ?? QQ_REPLY_DEFAULT)),
          // 0052 写入侧补默认（T12）：未提供的两组落完整 JSON，而不是靠读取兜底的 NULL。
          ...messageSettingsColumns(input.messageSettings ?? QQ_MESSAGE_SETTINGS_SCHEME_DEFAULT),
          ...mediaInputColumns(input.mediaInput ?? QQ_MEDIA_INPUT_SCHEME_DEFAULT),
          createdAt: nowIso(),
          updatedAt: nowIso(),
        })
        .returning()
        .get();
      if (!row) fail("DATABASE_UNAVAILABLE", "数据服务暂不可用，请检查数据库", 503);
      if (input.stickerCollections !== undefined) {
        writeSchemeStickerCollections(tx, row.id, input.stickerCollections);
      }
      return row;
    },
    { behavior: "immediate" },
  );
}

export interface QqSchemeUpdate extends QqSchemeInput {
  expectedRevision: number;
}

export function updateQqScheme(orm: Orm, id: string, input: QqSchemeUpdate): QqSchemeRow {
  const current = readQqScheme(orm, id);
  if (current === null) fail("MEMORY_NOT_FOUND", "方案不存在", 404);
  if (current.revision !== input.expectedRevision) {
    fail("MEMORY_STATE_CONFLICT", "方案已变化，请重新加载后保存");
  }
  const name = normalizeName(input.name);
  const clash = orm
    .select({ id: schema.qqSchemes.id })
    .from(schema.qqSchemes)
    .where(eq(schema.qqSchemes.name, name))
    .get();
  if (clash && clash.id !== id) fail("MEMORY_STATE_CONFLICT", "已存在同名方案，请换一个名称");
  const description = input.description === undefined ? current.description : input.description;
  const currentTriggers = schemeTriggers(current);
  const nextTriggers =
    input.triggers === undefined ? currentTriggers : parseQqSpeechTriggers(input.triggers);
  assertSchemeInteractionPair(nextTriggers);
  const currentRhythm = schemeRhythm(current);
  const nextRhythm = input.rhythm === undefined ? currentRhythm : parseQqSchemeRhythm(input.rhythm);
  const currentContext = schemeContext(current);
  const nextContext =
    input.context === undefined ? currentContext : parseQqSchemeContext(input.context);
  const currentCompression = schemeCompression(current);
  const nextCompression =
    input.compression === undefined
      ? currentCompression
      : parseQqSchemeCompression(input.compression);
  const currentOutputReserve = schemeOutputReserve(current);
  const nextOutputReserve =
    input.outputReserve === undefined
      ? currentOutputReserve
      : parseQqSchemeOutputReserve(input.outputReserve);
  const currentStickers = schemeStickers(current);
  const nextStickers =
    input.stickers === undefined ? currentStickers : parseQqSchemeStickers(input.stickers);
  const currentPrompts = schemePrompts(current);
  const nextPrompts =
    input.prompts === undefined ? currentPrompts : parseQqSchemePrompts(input.prompts);
  const currentReply = schemeReply(current);
  const nextReply = input.reply === undefined ? currentReply : parseQqSchemeReply(input.reply);
  // 0052 两组：未提供＝保持现值（读出口已按默认兜底），整组来或整组不动。
  const currentMessageSettings = schemeMessageSettings(current);
  const nextMessageSettings =
    input.messageSettings === undefined
      ? currentMessageSettings
      : parseQqSchemeMessageSettings(input.messageSettings);
  const currentMediaInput = schemeMediaInput(current);
  const nextMediaInput =
    input.mediaInput === undefined ? currentMediaInput : parseQqSchemeMediaInput(input.mediaInput);
  const currentCollectionIds = schemeStickerCollectionIds(orm, id);
  const nextCollectionIds =
    input.stickerCollections === undefined
      ? currentCollectionIds
      : parseQqSchemeStickerCollections({ collection_ids: input.stickerCollections });
  const collectionsChanged = !sameStickerCollections(currentCollectionIds, nextCollectionIds);
  // A save that changes nothing must not look like a change, the same no-op discipline every
  // other settings surface here follows.
  if (
    name === current.name &&
    description === current.description &&
    sameTriggers(currentTriggers, nextTriggers) &&
    sameRhythm(currentRhythm, nextRhythm) &&
    sameContext(currentContext, nextContext) &&
    sameCompression(currentCompression, nextCompression) &&
    sameOutputReserve(currentOutputReserve, nextOutputReserve) &&
    sameStickers(currentStickers, nextStickers) &&
    samePrompts(currentPrompts, nextPrompts) &&
    nextReply.split_by_speaker === currentReply.split_by_speaker &&
    sameMessageSettings(currentMessageSettings, nextMessageSettings) &&
    sameMediaInput(currentMediaInput, nextMediaInput) &&
    !collectionsChanged
  ) {
    return current;
  }
  return orm.transaction(
    (tx) => {
      const row = tx
        .update(schema.qqSchemes)
        .set({
          name,
          description,
          ...triggerColumns(nextTriggers),
          ...rhythmColumns(nextRhythm),
          ...contextColumns(nextContext),
          ...compressionColumns(nextCompression),
          ...outputReserveColumns(nextOutputReserve),
          ...stickerColumns(nextStickers),
          ...promptColumns(nextPrompts),
          ...replyColumns(nextReply),
          ...messageSettingsColumns(nextMessageSettings),
          ...mediaInputColumns(nextMediaInput),
          revision: current.revision + 1,
          updatedAt: nowIso(),
        })
        .where(eq(schema.qqSchemes.id, id))
        .returning()
        .get();
      if (!row) fail("DATABASE_UNAVAILABLE", "数据服务暂不可用，请检查数据库", 503);
      if (collectionsChanged) writeSchemeStickerCollections(tx, id, nextCollectionIds);
      return row;
    },
    { behavior: "immediate" },
  );
}

/**
 * How many bindings name this scheme. Surfaced so a UI can explain *why* a delete is
 * refused instead of just failing.
 */
export function qqSchemeUsage(orm: Orm, id: string): number {
  return orm
    .select({ id: schema.qqBindings.id })
    .from(schema.qqBindings)
    .where(eq(schema.qqBindings.schemeId, id))
    .all().length;
}

/**
 * Delete a scheme. Refused while any binding still names it — the trigger enforces this in
 * SQL, and this check turns it into a message that says what to do first. Deleting an
 * in-use scheme is the destructive version of "re-pointing bindings", which the plan
 * forbids.
 */
export function deleteQqScheme(orm: Orm, id: string): void {
  const scheme = readQqScheme(orm, id);
  if (scheme === null) fail("MEMORY_NOT_FOUND", "方案不存在", 404);
  const usage = qqSchemeUsage(orm, id);
  if (usage > 0) {
    fail("MEMORY_STATE_CONFLICT", `该方案仍被 ${usage} 个群或私聊使用，请先改绑再删除`);
  }
  orm.delete(schema.qqSchemes).where(eq(schema.qqSchemes.id, id)).run();
}
