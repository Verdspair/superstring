// Rhythm rules for QQ (ADR0018 P3b-1).
//
// §5.2 listed the field groups but left every value pending, so nothing downstream could be
// built: "how quiet is quiet" and "how soon is too soon" are the whole content of those
// rules. The user fixed the values on 2026-09-23, and this module is where they act. It is
// pure — no clock, no database, no model: every function takes the numbers it needs,
// including the current time, so a test can place itself anywhere on a timeline.
//
// The four time gates bind UNPROMPTED speech only (user decision 2026-09-23): a direct
// reply must be answerable at any hour and however recently the assistant last spoke,
// otherwise being addressed — the one case where an answer is unambiguously expected —
// could be silently swallowed. "Unprompted" here means the two initiative paths of
// qq-speaking-contract.ts; a continuation is not gated either, matching the P3a decision
// that it is not initiative-taking.
//
// Two degenerate shapes are defined rather than left to chance:
//   * an allowed-hours window with start === end means ALL DAY. Half-open windows would
//     otherwise make it mean "never", and "never speak" is not a configuration anyone asks
//     for by typing the same number twice; and
//   * a merge window of 0 means each message is judged on its own, so the gate is always
//     ready — that is the only reading of "do not wait" that is useful.

import { z } from "zod";
import { type QqSchemeRhythm, QqSchemeRhythmSchema } from "../../shared/contracts/qq";
import { isInitiativeSpeech, type QqSpeechKind } from "./qq-speaking-contract";

/** A rolling hour, the window the per-hour speech cap is counted over. */
export const QQ_RHYTHM_HOUR_SECONDS = 3600;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_DAY = 24 * 60;

/**
 * The values the user fixed on 2026-09-23. A new scheme starts here, and they are what the
 * DDL defaults say, so an old scheme and a fresh one behave the same.
 */
export const QQ_RHYTHM_DEFAULT: QqSchemeRhythm = Object.freeze({
  merge_window_seconds: 30,
  reply_cooldown_seconds: 10,
  hourly_speech_limit: 200,
  /**
   * 0034 (user decision 2026-09-25): the interest score the judge has to reach for the assistant
   * to open her mouth unprompted. 6 keeps the behaviour the boolean verdict had — a message the
   * old verdict called worth answering still clears it — while leaving room to go quieter by
   * raising it; 0 and 10 are the two ends of "chatty" and "almost never".
   */
  initiative_min_score: 6,
  /**
   * 0036 (user decision 2026-09-25): how many new member messages must arrive before the judge is
   * asked again. 3 keeps a short burst of messages from paying for three identical questions while
   * still re-judging quickly in a quiet conversation; 1 re-asks as soon as one new message
   * arrives, which is the closest thing to the behaviour before this column existed.
   */
  /**
   * 0036 的"判断间隔"：**已不再被任何代码读取**（用户 2026-09-25 取消间隔与复用——每个人的合并窗口
   * 一结束就为他真判一次）。列与契约保留是为了不改 schema 与线上形状，不是还在生效的旋钮。
   */
  judgement_interval_turns: 3,
  idle_quiet_minutes: 15,
  active_hours_enabled: false,
  active_hours_start_minutes: 0,
  active_hours_end_minutes: 1439,
  max_recompute_count: 1,
  max_sticker_count: 1,
  /** P5m (user decision 2026-09-24): the same-speaker window that wakes a failed media read once. */
  media_supplement_window_minutes: 10,
  /** P5t: §7.1's 可改 sampling, defaulting to the fixed behaviour it replaces (3 frames / 512). */
  media_frame_count: 3,
  media_max_dimension: 512,
});

function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) throw new TypeError("Invalid QQ rhythm contract input");
  return result.data;
}

/** Validate a stored or assembled rhythm group; storage maps rows through this. */
export function parseQqSchemeRhythm(input: unknown): QqSchemeRhythm {
  return Object.freeze(parse(QqSchemeRhythmSchema, input));
}

export type QqBatchVerdict =
  | { readonly kind: "ready" }
  | { readonly kind: "waiting"; readonly readyAtSeconds: number };

/**
 * Should the batch of messages ending at `lastMessageSeconds` be judged yet?
 *
 * The window restarts with every new message, which is what makes it a merge: three
 * messages two seconds apart are one conversation and should be judged once, after the
 * sender has stopped. Nothing is cancelled here — the caller may judge later; this only
 * says whether now is early.
 */
export function qqBatchVerdict(input: unknown): QqBatchVerdict {
  const value = parse(
    z.strictObject({
      lastMessageSeconds: z.number().int().nonnegative(),
      nowSeconds: z.number().int().nonnegative(),
      mergeWindowSeconds: z.number().int().min(0).max(300),
    }),
    input,
  );
  const readyAtSeconds = value.lastMessageSeconds + value.mergeWindowSeconds;
  return value.nowSeconds >= readyAtSeconds
    ? Object.freeze({ kind: "ready" })
    : Object.freeze({ kind: "waiting", readyAtSeconds });
}

/**
 * Is this minute of the local day inside the allowed window?
 *
 * Half-open [start, end) so a window never counts the same minute twice; `start === end`
 * means all day (see the module note). The caller supplies the minute of day, so the rule
 * has no timezone of its own.
 */
export function qqActiveHoursAllow(input: unknown): boolean {
  const value = parse(
    z.strictObject({
      minuteOfDay: z
        .number()
        .int()
        .min(0)
        .max(MINUTES_PER_DAY - 1),
      enabled: z.boolean(),
      startMinutes: z
        .number()
        .int()
        .min(0)
        .max(MINUTES_PER_DAY - 1),
      endMinutes: z
        .number()
        .int()
        .min(0)
        .max(MINUTES_PER_DAY - 1),
    }),
    input,
  );
  if (!value.enabled) return true;
  if (value.startMinutes === value.endMinutes) return true;
  if (value.startMinutes < value.endMinutes) {
    return value.minuteOfDay >= value.startMinutes && value.minuteOfDay < value.endMinutes;
  }
  // The window crosses midnight: 22:00–07:00 is two spans, not an empty one.
  return value.minuteOfDay >= value.startMinutes || value.minuteOfDay < value.endMinutes;
}

export type QqRhythmBlockReason =
  | "cooling_down"
  | "hourly_limit"
  | "outside_active_hours"
  | "not_quiet_yet";

export type QqRhythmVerdict =
  | { readonly kind: "allowed" }
  | {
      readonly kind: "blocked";
      readonly reason: QqRhythmBlockReason;
      /** When the block would lift, or null when only the situation can lift it. */
      readonly readyAtSeconds: number | null;
    };

const RhythmInputSchema = z.strictObject({
  kind: z.enum(["direct_reply", "follow_up", "chiming_in", "idle_topic"]),
  rhythm: QqSchemeRhythmSchema,
  nowSeconds: z.number().int().nonnegative(),
  /** When this assistant last actually spoke here (delivered), or null. */
  lastSpeechSeconds: z.number().int().nonnegative().nullable(),
  /** Delivered unprompted utterances in the conversation over the last rolling hour. */
  speechesThisHour: z.number().int().nonnegative(),
  /** Newest recorded message from a real conversation partner, or null if none. */
  newestMemberMessageSeconds: z.number().int().nonnegative().nullable(),
});

/**
 * The time gates, for one intended utterance.
 *
 * Direct replies and continuations pass untouched (they are not unprompted; see the module
 * note), and an idle topic additionally has to arrive after the conversation has actually
 * gone quiet — that is what makes it an opener rather than an interruption. Order matters
 * for the message the user sees: a conversation that is both cooling down and outside its
 * hours should be told the nearer reason, so the cooldown is checked first because it is
 * the only one that expires on its own clock.
 */
export function checkQqInitiativeRhythm(input: unknown): QqRhythmVerdict {
  const value = parse(RhythmInputSchema, input);
  if (!isInitiativeSpeech(value.kind)) return Object.freeze({ kind: "allowed" });
  const rhythm = value.rhythm;

  if (value.lastSpeechSeconds !== null) {
    const readyAtSeconds = value.lastSpeechSeconds + rhythm.reply_cooldown_seconds;
    if (value.nowSeconds < readyAtSeconds) {
      return Object.freeze({ kind: "blocked", reason: "cooling_down", readyAtSeconds });
    }
  }

  if (value.speechesThisHour >= rhythm.hourly_speech_limit) {
    // The cap lifts as the oldest counted utterance ages out, which this module cannot see;
    // the caller owns that window, so no ready time is promised here.
    return Object.freeze({ kind: "blocked", reason: "hourly_limit", readyAtSeconds: null });
  }

  if (
    !qqActiveHoursAllow({
      minuteOfDay: Math.floor(value.nowSeconds / SECONDS_PER_MINUTE) % MINUTES_PER_DAY,
      enabled: rhythm.active_hours_enabled,
      startMinutes: rhythm.active_hours_start_minutes,
      endMinutes: rhythm.active_hours_end_minutes,
    })
  ) {
    return Object.freeze({ kind: "blocked", reason: "outside_active_hours", readyAtSeconds: null });
  }

  if (value.kind === "idle_topic" && value.newestMemberMessageSeconds !== null) {
    const readyAtSeconds =
      value.newestMemberMessageSeconds + rhythm.idle_quiet_minutes * SECONDS_PER_MINUTE;
    if (value.nowSeconds < readyAtSeconds) {
      return Object.freeze({ kind: "blocked", reason: "not_quiet_yet", readyAtSeconds });
    }
  }

  return Object.freeze({ kind: "allowed" });
}

/**
 * How many stickers this reply may carry (§8.1-4).
 *
 * The scheme's number is a ceiling, not a target: §8.1 says text alone when text is enough,
 * so a reply that asks for fewer stickers keeps its own number. Clamping rather than
 * refusing is deliberate — a model proposing three stickers is not an error, it is a wish
 * the settings get to trim.
 */
export function qqStickerCount(input: unknown): number {
  const value = parse(
    z.strictObject({
      requested: z.number().int().nonnegative(),
      maxStickerCount: z.number().int().min(1).max(3),
    }),
    input,
  );
  return Math.min(value.requested, value.maxStickerCount);
}

export type QqRecomputeVerdict =
  | { readonly kind: "allowed" }
  | { readonly kind: "blocked"; readonly reason: "recompute_budget" };

/**
 * May the content generated for this reply be re-generated once more?
 *
 * §5.1: at most one recompute by default, adjustable, and never unlimited — a reply that
 * keeps being cancelled while the conversation moves on is worse than a slightly stale one.
 * The budget is the reply's own and is never reset by a media retry, which has a separate
 * counter (§7.2). This particular call is "should the first recompute happen", which is why
 * the default scheme allows exactly one.
 */
export function qqRecomputeVerdict(input: unknown): QqRecomputeVerdict {
  const value = parse(
    z.strictObject({
      /** How many recomputes this reply has already used. */
      used: z.number().int().nonnegative(),
      maxRecomputeCount: z.number().int().min(0).max(2),
    }),
    input,
  );
  return value.used < value.maxRecomputeCount
    ? Object.freeze({ kind: "allowed" })
    : Object.freeze({ kind: "blocked", reason: "recompute_budget" });
}

/** Whether the four time gates apply to this kind of speech at all. */
export function qqRhythmAppliesTo(kind: unknown): boolean {
  return isInitiativeSpeech(kind as QqSpeechKind);
}
