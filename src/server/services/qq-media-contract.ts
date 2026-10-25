// Media understanding rules for QQ (ADR0018 P4a).
//
// What was checked rather than assumed:
//   * OneBot 11 delivers image / record / video / file segments with a `file` name and a
//     `url`; there is no base64 field on the receiving side, so media must be fetched by
//     reference.
//   * NapCat answers `get_image` / `get_record` / `get_file` with a path and a URL, so a
//     `file` name alone is enough to obtain a downloadable object, and `get_record`
//     converts formats (mp3/amr/wma/m4a/spx/ogg/wav/flac) — the format problem is solved
//     upstream, not here.
// None of that makes a picture readable. Reading needs a model, and which model, how many
// animated frames and what budget are all still pending, so nothing here invents them.
//
// What this module does fix is the part the plan already decided:
//   * a failed read is never announced in the conversation — only recorded on the admin
//     side (§7.2), and that is expressed as a literal type so it cannot be "helpfully"
//     changed by a caller;
//   * baseline reads once — a failure is recorded and reused, never retried or re-scheduled
//     (§5.7: the supplement time-window/time-unlock flow is retired);
//   * a media's retry count is its own counter and is never reset or shared with the
//     reply-regeneration budget (§7.2: the two must not be able to loop each other);
//   * until a description exists, only the caption, the quote and the topic may be used —
//     claiming to have seen the picture is a type error, not a judgement call.

import { z } from "zod";
import { bodyRevision } from "../db/conversation-event-repository";

const MediaKindSchema = z.enum(["image", "record", "video", "file"]);
export type QqMediaKind = z.output<typeof MediaKindSchema>;

/**
 * 每个真实请求自己的尝试预算（§5.7）：一次有界尝试，失败结果复用，不自动第二次、
 * 不等补充、不循环。同一请求的 invoke/replay 走任务 CAS 去重；真实新消息＝新的请求身份
 * （新的账本行），各自预算——旧的失败不是永久门禁。
 */
export const QQ_MEDIA_MAX_ATTEMPTS = 1;

function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) throw new TypeError("Invalid QQ media contract input");
  return result.data;
}

const RetryInputSchema = z.strictObject({
  kind: MediaKindSchema,
  /** How many read attempts this task identity has already had. */
  attempts: z.number().int().min(0),
});

export type QqMediaRetryVerdict =
  | { readonly kind: "allowed"; readonly attempt: number }
  | {
      readonly kind: "blocked";
      readonly reason: "attempts_exhausted";
    };

/**
 * May this task identity take a read attempt?
 *
 * 语义已按 §5.7 简化：不再有 @/非 @ 的不对称，也不再有"等补充"；每个身份一次有界尝试，
 * 用尽即 blocked（失败结果复用），真实新请求是新的身份行、各自预算。
 */
export function checkQqMediaRetry(input: unknown): QqMediaRetryVerdict {
  const value = parse(RetryInputSchema, input);
  if (value.attempts >= QQ_MEDIA_MAX_ATTEMPTS)
    return Object.freeze({ kind: "blocked", reason: "attempts_exhausted" });
  return Object.freeze({ kind: "allowed", attempt: value.attempts + 1 });
}

const FailureInputSchema = z.strictObject({
  kind: MediaKindSchema,
  attempts: z.number().int().min(0),
});

/**
 * What a failed read is allowed to do. The first two fields are literal types on purpose:
 * §7.2 says the failure is recorded on the admin side and NOT explained in the group, and
 * a boolean here would let a future caller quietly "improve" that.
 */
export interface QqMediaFailureOutcome {
  readonly announceInConversation: false;
  readonly recordInAdminLog: true;
  /** Nothing more will be tried for this identity; the failure is recorded and reused. */
  readonly giveUp: boolean;
}

export function qqMediaFailureOutcome(input: unknown): QqMediaFailureOutcome {
  const value = parse(FailureInputSchema, input);
  return Object.freeze({
    announceInConversation: false,
    recordInAdminLog: true,
    giveUp: value.attempts >= QQ_MEDIA_MAX_ATTEMPTS,
  });
}

const ReadingInputSchema = z.strictObject({
  /** The generated description or transcription, if one exists. */
  note: z.string().nullable(),
  /** Text sent with the media. */
  caption: z.string().nullable(),
  /** Text of the message this one quotes, if any. */
  quotedText: z.string().nullable(),
  /** The surrounding topic, if the caller has one. */
  topicText: z.string().nullable(),
});

export type QqMediaReading =
  | { readonly kind: "described"; readonly note: string }
  | {
      readonly kind: "unread";
      readonly usableText: string | null;
      /**
       * A literal, not a boolean: without a description the assistant may talk about the
       * words around the media, and must not claim to know what it shows. Writing code
       * that does otherwise should not typecheck.
       */
      readonly knowsVisualContent: false;
    };

/** Descriptions are model output and are labelled as such; they never masquerade as the member's own words. */
function firstNonEmpty(values: readonly (string | null)[]): string | null {
  for (const value of values) {
    if (value !== null && value.trim().length > 0) return value;
  }
  return null;
}

export function qqMediaReading(input: unknown): QqMediaReading {
  const value = parse(ReadingInputSchema, input);
  if (value.note !== null && value.note.trim().length > 0) {
    return Object.freeze({ kind: "described", note: value.note });
  }
  return Object.freeze({
    kind: "unread",
    usableText: firstNonEmpty([value.caption, value.quotedText, value.topicText]),
    knowsVisualContent: false,
  });
}

const FrameRequestSchema = z.strictObject({
  /** How many frames to sample from an animated image. */
  frames: z.number().int().min(1),
  /** Longest edge of a sampled frame, in pixels. */
  maxDimension: z.number().int().min(1),
  /** Token budget for the frame batch. */
  budgetTokens: z.number().int().min(1),
});

export interface QqAnimatedFrameRequest {
  readonly frames: number;
  readonly maxDimension: number;
  readonly budgetTokens: number;
}

/**
 * Validate an animation sampling request. Every field is required and none has a default:
 * §7.1 says the frame count, size and budget are adjustable, and no value has been agreed
 * yet, so supplying one here would decide the product's media budget by accident.
 */
export function parseQqAnimatedFrameRequest(input: unknown): QqAnimatedFrameRequest {
  return Object.freeze(parse(FrameRequestSchema, input));
}

/** Validate a stored or assembled media kind; storage maps rows through this. */
export function parseQqMediaKind(input: unknown): QqMediaKind {
  return parse(MediaKindSchema, input);
}

const MediaModelConfigSchema = z.strictObject({
  /** The model that reads still pictures and video frames. */
  visionModelName: z.string().nullable(),
  /** The model or service that turns voice into text. */
  transcriptionModelName: z.string().nullable(),
});

export type QqMediaModelChoice =
  | { readonly kind: "configured"; readonly model: string }
  | { readonly kind: "not_configured" };

/**
 * Which configured model reads this media, if any.
 *
 * Every other model purpose in this project falls back to the conversation model when it is
 * unset. Media deliberately does not: a text-only model asked to describe a picture does
 * not fail, it invents something plausible. So "not configured" means "not readable", and
 * the caller leaves the media unread — which is the honest outcome — rather than reading it
 * badly.
 *
 * A `file` segment is never read. OneBot's file segment carries a document's name and URL,
 * and the plan's input capability covers pictures, animations and voice; a document is not
 * one of them, so this returns "not configured" rather than choosing a model.
 *
 * 0.4.0 P5：这个函数回答的是"该用哪个模型"，而"这一版到底读不读得出来"由适配器的
 * `capabilities` 声明先在读取器里判掉——语音即使配了转写模型，只要没有实现声明它，就不会被尝试。
 */
export function qqMediaModelFor(kind: unknown, config: unknown): QqMediaModelChoice {
  const mediaKind = parse(MediaKindSchema, kind);
  const value = parse(MediaModelConfigSchema, config);
  const wanted =
    mediaKind === "image" || mediaKind === "video"
      ? value.visionModelName
      : mediaKind === "record"
        ? value.transcriptionModelName
        : null;
  const model = wanted === null ? "" : wanted.trim();
  if (model.length === 0) return Object.freeze({ kind: "not_configured" });
  return Object.freeze({ kind: "configured", model });
}

/**
 * 生效媒体输入形状的稳定修订串——分类缓存槽与 typed 结果缓存共用的唯一策略键真源。
 *
 * v2（统一规格断版，§5.6）：静图长边（所有类别共用，null=原图）与动图帧数/边长
 * （所有类别共用 rhythm 真源）一起进修订组成；形状标识同时从 media/v1 升到 media/v2，
 * 所以旧表情规格产出的成功描述不可能在"规格字面恰好相同"时被静默复用——这一版是
 * 无条件断版，不依赖两份规格碰巧取值不同。调用方必须提供 stillMaxDimension，
 * 不能只传 v1 的三个字段。
 *
 * 键序固定 shape→prompt→still→frames→maxDimension：键序变了缓存键就变。
 */
export const QQ_MEDIA_POLICY_SHAPE = "media/v2";

export function qqMediaPolicyRevision(input: {
  readonly prompt: string;
  /** 所有类别共用的静图长边；null＝原图。 */
  readonly stillMaxDimension: number | null;
  readonly frames: number;
  readonly maxDimension: number;
}): string {
  return bodyRevision(
    JSON.stringify({
      shape: QQ_MEDIA_POLICY_SHAPE,
      prompt: input.prompt,
      stillMaxDimension: input.stillMaxDimension,
      frames: input.frames,
      maxDimension: input.maxDimension,
    }),
  );
}
