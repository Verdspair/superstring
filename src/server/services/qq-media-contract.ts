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
//   * a non-@ failure is never retried, and an @ failure gets exactly one more attempt
//     after a related supplement arrives, then silence;
//   * a media's retry count is its own counter and is never reset or shared with the
//     reply-regeneration budget (§7.2: the two must not be able to loop each other);
//   * until a description exists, only the caption, the quote and the topic may be used —
//     claiming to have seen the picture is a type error, not a judgement call.

import { z } from "zod";

const MediaKindSchema = z.enum(["image", "record", "video", "file"]);
export type QqMediaKind = z.output<typeof MediaKindSchema>;

/**
 * A second read is the last one (§7.2: after the second failure the wait ends and there
 * is no loop). Not configurable, because the plan fixes this count, unlike the windows
 * and budgets that are still open.
 */
export const QQ_MEDIA_MAX_ATTEMPTS = 2;

function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) throw new TypeError("Invalid QQ media contract input");
  return result.data;
}

const RetryInputSchema = z.strictObject({
  kind: MediaKindSchema,
  /** How many read attempts this media has already had. */
  attempts: z.number().int().min(0),
  /** Was the message that carried it addressed to the assistant? */
  addressedToAssistant: z.boolean(),
  /** Has a related supplement arrived (an explanation, a follow-up question, a reply)? */
  relatedSupplementArrived: z.boolean(),
});

export type QqMediaRetryVerdict =
  | { readonly kind: "allowed"; readonly attempt: number }
  | {
      readonly kind: "blocked";
      readonly reason: "not_addressed" | "awaiting_supplement" | "attempts_exhausted";
    };

/**
 * May this media be read again?
 *
 * The asymmetry between @ and non-@ is deliberate (§7.2): a picture nobody asked about
 * that fails is left alone, while one that was addressed to the assistant is retried
 * once — and only once — when something related arrives. An unrelated message must not
 * wake it, which is why the caller reports "a related supplement arrived" rather than
 * "a message arrived".
 */
export function checkQqMediaRetry(input: unknown): QqMediaRetryVerdict {
  const value = parse(RetryInputSchema, input);
  if (value.attempts >= QQ_MEDIA_MAX_ATTEMPTS)
    return Object.freeze({ kind: "blocked", reason: "attempts_exhausted" });
  if (value.attempts === 0) return Object.freeze({ kind: "allowed", attempt: 1 });
  if (!value.addressedToAssistant)
    return Object.freeze({ kind: "blocked", reason: "not_addressed" });
  if (!value.relatedSupplementArrived)
    return Object.freeze({ kind: "blocked", reason: "awaiting_supplement" });
  return Object.freeze({ kind: "allowed", attempt: value.attempts + 1 });
}

const FailureInputSchema = z.strictObject({
  kind: MediaKindSchema,
  attempts: z.number().int().min(0),
  addressedToAssistant: z.boolean(),
});

/**
 * What a failed read is allowed to do. The first two fields are literal types on purpose:
 * §7.2 says the failure is recorded on the admin side and NOT explained in the group, and
 * a boolean here would let a future caller quietly "improve" that.
 */
export interface QqMediaFailureOutcome {
  readonly announceInConversation: false;
  readonly recordInAdminLog: true;
  /** @ addressing keeps the door open for one related supplement. */
  readonly awaitSupplement: boolean;
  /** Nothing more will be tried; the wait is over rather than pending forever. */
  readonly giveUp: boolean;
}

export function qqMediaFailureOutcome(input: unknown): QqMediaFailureOutcome {
  const value = parse(FailureInputSchema, input);
  const exhausted = value.attempts >= QQ_MEDIA_MAX_ATTEMPTS;
  return Object.freeze({
    announceInConversation: false,
    recordInAdminLog: true,
    awaitSupplement: value.addressedToAssistant && !exhausted,
    giveUp: exhausted,
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

export type QqMediaModelConfig = Readonly<z.output<typeof MediaModelConfigSchema>>;

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
