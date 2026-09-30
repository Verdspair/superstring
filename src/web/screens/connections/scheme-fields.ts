import type { QqSchemePrompts } from "../../../shared/contracts/qq";
import {
  QqSchemeCompressionSchema,
  QqSchemeContextSchema,
  QqSchemeOutputReserveSchema,
  QqSchemeRhythmSchema,
  QqSchemeStickersSchema,
} from "../../../shared/contracts/qq";

export const numericGroups = {
  rhythm: QqSchemeRhythmSchema,
  context: QqSchemeContextSchema,
  compression: QqSchemeCompressionSchema,
  outputReserve: QqSchemeOutputReserveSchema,
  stickers: QqSchemeStickersSchema,
};
export type NumericGroup = keyof typeof numericGroups;

/** The four editing tasks of the studio; a field's task is also the tab its error is fixed on. */
export type SchemeTask = "participation" | "response" | "context" | "media";

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
/** 表情参数（含「每条回复最多几张」——它存在 rhythm 组，但说的事情是表情）。 */
export const stickerFields = [
  ["rhythm", "max_sticker_count", "connections.stickersPerReply"],
  ["stickers", "sticker_min_repeat_minutes", "connections.shortestRepeatIntervalPerStickerMinutes"],
  ["stickers", "sticker_recent_avoid_count", "connections.avoidTheLastFew"],
] as const;
/** 图片/动图参数（读取媒体时采样与等待用的三个值）。 */
export const imageFields = [
  [
    "rhythm",
    "media_supplement_window_minutes",
    "connections.waitAfterMediaFailsOnADirectMentionMinutes",
  ],
  ["rhythm", "media_frame_count", "connections.animationFramesToSample"],
  ["rhythm", "media_max_dimension", "connections.sampledFrameLongEdgePx"],
] as const;

type NumberSchema = {
  readonly minValue: number | null;
  readonly maxValue: number | null;
  readonly isInt: boolean;
};
const numberSchema = (group: NumericGroup, name: string) =>
  (numericGroups[group].shape as Record<string, NumberSchema | undefined>)[name];

/**
 * 每个数字输入框的 min/max/step 都从契约 schema 现读，不在这里另抄一份边界：
 * schema 改动时输入框跟着变，浏览器拦下的范围就是服务端会拒绝的范围。
 */
export function fieldBounds(group: NumericGroup, name: string) {
  const schema = numberSchema(group, name);
  return {
    min: schema?.minValue ?? undefined,
    max: schema?.maxValue ?? undefined,
    // 整数契约用 step=1；契约里的小数（目前只有装配冗余的比例）交给百分比栏单独换算。
    step: schema?.isInt === false ? ("any" as const) : 1,
  };
}

/** 装配冗余在界面上是整数百分比；边界由契约的比例边界换算（0–50%）。 */
export function headroomPercentBounds() {
  const { min, max } = fieldBounds("compression", "headroom_ratio");
  return { min: Math.round((min ?? 0) * 100), max: Math.round((max ?? 0.5) * 100), step: 1 };
}

const promptTasks: Record<keyof QqSchemePrompts, SchemeTask> = {
  scene: "response",
  judge: "participation",
  reply: "response",
  review: "response",
  compress: "context",
  sticker: "media",
  media: "media",
};
const mediaRhythmNames = new Set<string>(
  [...stickerFields, ...imageFields]
    .filter(([group]) => group === "rhythm")
    .map(([, name]) => name),
);

/** 一个字段在哪个页签编辑——用来在保存前把无效数字所在的页签先切出来并聚焦。 */
export function schemeFieldTask(field: string): SchemeTask {
  const [group, name] = field.split(".");
  if (group === "rhythm") return mediaRhythmNames.has(name) ? "media" : "participation";
  if (group === "stickers") return "media";
  if (
    group === "compression" ||
    group === "context" ||
    group === "output_reserve" ||
    group === "outputReserve"
  )
    return "context";
  if (group === "prompts") return promptTasks[name as keyof QqSchemePrompts] ?? "response";
  if (field === "reply.split_by_speaker") return "response";
  if (field === "sticker_collections.collection_ids") return "media";
  return "participation";
}

/** Stored minutes are UTC; editing and previews use the user's local clock. */
export function localClock(minutes: number) {
  const local = (minutes - new Date().getTimezoneOffset() + 1440) % 1440;
  return `${String(Math.floor(local / 60)).padStart(2, "0")}:${String(local % 60).padStart(2, "0")}`;
}
export function utcMinutes(clock: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(clock);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return (hour * 60 + minute + new Date().getTimezoneOffset() + 1440) % 1440;
}
