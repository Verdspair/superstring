import {
  QqSchemeContextSchema,
  QqSchemeOutputReserveSchema,
  QqSchemeRhythmSchema,
  QqSchemeStickersSchema,
} from "../../../shared/contracts/qq";

export const numericGroups = {
  rhythm: QqSchemeRhythmSchema,
  context: QqSchemeContextSchema,
  outputReserve: QqSchemeOutputReserveSchema,
  stickers: QqSchemeStickersSchema,
};
export type NumericGroup = keyof typeof numericGroups;
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
export const mediaFields = [
  ["rhythm", "max_sticker_count", "connections.stickersPerReply"],
  ["stickers", "sticker_min_repeat_minutes", "connections.shortestRepeatIntervalPerStickerMinutes"],
  ["stickers", "sticker_recent_avoid_count", "connections.avoidTheLastFew"],
  [
    "rhythm",
    "media_supplement_window_minutes",
    "connections.waitAfterMediaFailsOnADirectMentionMinutes",
  ],
  ["rhythm", "media_frame_count", "connections.animationFramesToSample"],
  ["rhythm", "media_max_dimension", "connections.sampledFrameLongEdgePx"],
] as const;

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
