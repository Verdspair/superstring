// Named QQ-global schemes: identity, switches, rhythm, context, prompts and output reserves.
// Bound schemes cannot be deleted; a no-op save preserves the revision.

import { asc, eq } from "drizzle-orm";
import {
  QQ_COMPRESSION_DEFAULT,
  QQ_MODEL_OUTPUT_RESERVE_DEFAULT,
  QQ_REPLY_DEFAULT,
  QQ_STICKER_DEDUP_DEFAULT,
  type QqSchemeCompression,
  type QqSchemeContext,
  type QqSchemeOutputReserve,
  type QqSchemePrompts,
  type QqSchemeReply,
  QqSchemeReplySchema,
  type QqSchemeRhythm,
  type QqSchemeStickers,
  type QqSpeechTriggers,
} from "../../shared/contracts/qq";
import { fail } from "../errors";
import type { QqBinding } from "../services/qq-binding-contract";
import { parseQqSchemeOutputReserve } from "../services/qq-capacity-preflight";
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

function replyColumns(reply: QqSchemeReply) {
  return { splitReplyBySpeaker: reply.split_by_speaker ? 1 : 0 };
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
  if (binding === null) return base;
  const pick = (override: boolean | null, fallback: boolean) => override ?? fallback;
  return Object.freeze({
    direct_reply: pick(binding.triggers.direct_reply, base.direct_reply),
    follow_up: pick(binding.triggers.follow_up, base.follow_up),
    chiming_in: pick(binding.triggers.chiming_in, base.chiming_in),
    idle_topic: pick(binding.triggers.idle_topic, base.idle_topic),
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
    left.media_max_dimension === right.media_max_dimension
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
export function createQqScheme(orm: Orm, input: QqSchemeInput): QqSchemeRow {
  const name = normalizeName(input.name);
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
