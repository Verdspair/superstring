// §8.1 output assembly for QQ (ADR0018 P4d).
//
// §8.2 already records what the platform did with a reply; §8.1 decides what the reply IS —
// text alone when text is enough, a sticker alone when one sticker is enough, or both in one
// message. Nothing implemented that decision, so "what should be sent" had no single answer,
// and the fallback rule ("the sticker became unusable, send the text anyway") is exactly the
// kind of shape that a second implementation turns into an accidental resend.
//
// This module is pure: no database, no clock, no model, no platform.
//
// Three rules are load-bearing and easy to get backwards:
//
//   * §8.1-6 is a DOWNGRADE, not a failure. A candidate that became unusable before anything
//     was submitted means "send the text alone"; it is not an attempt, so it must not be
//     recorded as one and must not be retried. The plan reports it as such.
//   * §8.1-3: text and stickers compose into one reply, text first — the same order §8.2's
//     part ledger records, so a partially submitted reply reads the same in both places.
//   * The scheme's sticker count is a CEILING (§8.1-4), so a reply asking for fewer keeps its
//     own number instead of being padded up to the maximum.
//
// §9.3's repetition rules live in the scheme (0020) and reach this module through
// `qqStickerDedupPolicy`, which does the minutes→seconds and count→switch conversion in one
// place rather than at every call site.

import { z } from "zod";
import { type QqSendPartResult, qqSendSummary } from "./qq-output-contract";
import {
  type QqStickerCandidate,
  QqStickerCandidateSchema,
  type QqStickerRejection,
  qqStickerUsable,
} from "./qq-sticker-contract";

const InputSchema = z.strictObject({
  /** The model's text, or null/blank when it chose not to speak in words. */
  text: z.string().nullable(),
  /** How many stickers the model asked for, before the scheme's ceiling is applied. */
  requestedStickers: z.number().int().nonnegative(),
  /** §8.1-4: the scheme's per-reply ceiling, 1–3 (U01). */
  maxStickerCount: z.number().int().min(1).max(3),
  /** The candidates as the caller resolved them for this conversation and sentence. */
  candidates: z.array(QqStickerCandidateSchema),
  /** §9.3's hard rule, or null when no interval has been configured. */
  minRepeatSeconds: z.number().int().nonnegative().nullable(),
  /** §9.3's soft rule: prefer stickers this conversation has not just seen. */
  avoidRecent: z.boolean(),
});
export type QqOutputPlanInput = Readonly<z.input<typeof InputSchema>>;

export type QqOutputShape = "text_only" | "sticker_only" | "mixed";

export type QqOutputPart =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "sticker"; readonly stickerId: string };

/**
 * Why a candidate did not make it into the reply. `over_ceiling` belongs to the reply rather
 * than to the sticker: the sticker itself was perfectly usable and simply exceeded §8.1-4's
 * per-reply count, so it is not one of the library's rejection reasons.
 */
export type QqPlanRejectionReason = QqStickerRejection | "over_ceiling";

export interface QqPlannedOutput {
  readonly kind: "planned";
  readonly shape: QqOutputShape;
  /** In send order: the text (if any) first, then the stickers. */
  readonly parts: readonly QqOutputPart[];
  readonly requestedStickers: number;
  readonly chosenStickerIds: readonly string[];
  /** Why a considered candidate was left out. Diagnostics (§10), never a send decision. */
  readonly rejected: readonly {
    readonly stickerId: string;
    readonly reason: QqPlanRejectionReason;
  }[];
  /**
   * §8.1-6's downgrade happened: stickers were wanted but none could be used, and the text
   * stands on its own. This is not a failure and nothing was submitted, so the caller must
   * not report it as one or resend with another sticker.
   */
  readonly textOnlyBecauseStickersUnavailable: boolean;
}

export type QqOutputPlan =
  | QqPlannedOutput
  | {
      readonly kind: "abandoned";
      /** §8.1-6's second half: without text there is nothing this reply could say. */
      readonly reason: "empty_reply" | "sticker_unavailable_and_no_text";
    };

function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) throw new TypeError("Invalid QQ output plan input");
  return result.data;
}

function textPart(text: string): QqOutputPart {
  return Object.freeze({ kind: "text", text });
}

/** 一轮回复最多几条消息（2026-09-25 用户决定：一条主题一条消息）。可配置化记为后续项。 */
export const QQ_REPLY_MESSAGE_LIMIT = 3;

/**
 * 把一次生成的文本切成"要依次发出的几条消息"（2026-09-25 用户决定）。
 *
 * The model separates distinct topics with line breaks — one topic per line — and the transport
 * sends one platform request per part, so the split IS the user-visible behaviour. Nothing is
 * silently dropped: with more lines than the limit, the tail is joined into the last message
 * (longer is better than losing what somebody was told). A single line — the shape every earlier
 * version produced — passes through untouched.
 */
function textParts(text: string): QqOutputPart[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (lines.length <= 1) return [textPart(text)];
  if (lines.length <= QQ_REPLY_MESSAGE_LIMIT) return lines.map((line) => textPart(line));
  const head = lines.slice(0, QQ_REPLY_MESSAGE_LIMIT - 1);
  const tail = lines.slice(QQ_REPLY_MESSAGE_LIMIT - 1).join(" ");
  return [...head, tail].map((line) => textPart(line));
}

function stickerPart(stickerId: string): QqOutputPart {
  return Object.freeze({ kind: "sticker", stickerId });
}

function rejectedList(
  entries: readonly { stickerId: string; reason: QqPlanRejectionReason }[],
): readonly { readonly stickerId: string; readonly reason: QqPlanRejectionReason }[] {
  return Object.freeze(entries.map((entry) => Object.freeze({ ...entry })));
}

/**
 * Assemble the reply to send, or say that there is nothing to send.
 *
 * Order of decisions is §8.1's own: decide whether text is usable, decide which stickers are,
 * then pick the shape. An `abandoned` result has no parts at all — deliberately, so a caller
 * cannot take a half-filled plan and submit it.
 */
export function planQqOutput(input: unknown): QqOutputPlan {
  const value = parse(InputSchema, input);
  const text = value.text === null ? "" : value.text.trim();
  const hasText = text.length > 0;
  // §8.1-4: a ceiling, not a target. Asking for more than the scheme allows trims.
  const wanted = Math.min(value.requestedStickers, value.maxStickerCount);

  if (wanted === 0) {
    // Nothing was asked for, so candidates are not examined: the model chose text alone
    // (§8.1-1), and reporting every candidate as "rejected" would misdescribe that.
    return hasText
      ? Object.freeze({
          kind: "planned",
          shape: "text_only",
          parts: Object.freeze(textParts(text)),
          requestedStickers: value.requestedStickers,
          chosenStickerIds: Object.freeze([]),
          rejected: rejectedList([]),
          textOnlyBecauseStickersUnavailable: false,
        })
      : Object.freeze({ kind: "abandoned", reason: "empty_reply" });
  }

  const rejected: { stickerId: string; reason: QqPlanRejectionReason }[] = [];
  const usable: QqStickerCandidate[] = [];
  for (const candidate of value.candidates) {
    // The same eligibility used at submit time, from one definition.
    const verdict = qqStickerUsable(candidate, { minRepeatSeconds: value.minRepeatSeconds });
    if (verdict.kind === "rejected") {
      rejected.push({ stickerId: candidate.id, reason: verdict.reason });
      continue;
    }
    usable.push(candidate);
  }

  // §9.3's soft avoidance is an ORDER, not a filter: with only recently-used stickers left,
  // sending one is better than sending no sticker, so they stay in the running.
  const ordered = value.avoidRecent
    ? [
        ...usable.filter((candidate) => !candidate.recentlyUsed),
        ...usable.filter((candidate) => candidate.recentlyUsed),
      ]
    : usable;
  const chosen = ordered.slice(0, wanted);
  for (const candidate of ordered.slice(wanted)) {
    rejected.push({ stickerId: candidate.id, reason: "over_ceiling" });
  }

  if (chosen.length === 0) {
    return hasText
      ? Object.freeze({
          kind: "planned",
          shape: "text_only",
          parts: Object.freeze(textParts(text)),
          requestedStickers: value.requestedStickers,
          chosenStickerIds: Object.freeze([]),
          rejected: rejectedList(rejected),
          textOnlyBecauseStickersUnavailable: true,
        })
      : Object.freeze({ kind: "abandoned", reason: "sticker_unavailable_and_no_text" });
  }

  const stickers = chosen.map((candidate) => stickerPart(candidate.id));
  const parts: QqOutputPart[] = hasText ? [...textParts(text), ...stickers] : stickers;
  return Object.freeze({
    kind: "planned",
    shape: hasText ? "mixed" : "sticker_only",
    parts: Object.freeze(parts),
    requestedStickers: value.requestedStickers,
    chosenStickerIds: Object.freeze(chosen.map((candidate) => candidate.id)),
    rejected: rejectedList(rejected),
    textOnlyBecauseStickersUnavailable: false,
  });
}

const OutcomeSchema = z.strictObject({
  result: z.enum(["confirmed", "failed", "unknown", "not_sent"]),
  /** Present exactly when the platform confirmed this part (§8.2). */
  messageId: z.string().min(1).nullable(),
});

export interface QqPlannedSendPart {
  /** Exactly the plan's own part kinds, so the ledger cannot describe a different reply. */
  readonly kind: QqOutputPart["kind"];
  readonly result: QqSendPartResult;
  readonly messageId: string | null;
  /** Carried through from the plan (P4g): the ledger records which asset went out, not just that one did. */
  readonly stickerId: string | null;
}

/**
 * Pair the planned parts with what the platform said about each one, in send order.
 *
 * This is the seam between §8.1 and §8.2. Without it, the assembler and the ledger each carry
 * their own idea of how many requests a reply became, and a caller that sent two could record
 * one — or record a sticker it never asked for. The count must match exactly, because the
 * ledger is what a later "why is there a sticker nobody planned" question is answered from.
 *
 * The result/id pairing is not re-implemented here: it goes through the send contract's own
 * summary, so the rule "a platform id exists exactly when the part was confirmed" has one
 * definition, and an attempt claiming otherwise fails at this boundary rather than in a row.
 */
export function qqPlannedSendParts(
  plan: QqPlannedOutput,
  outcomes: unknown,
): readonly QqPlannedSendPart[] {
  if (
    plan === null ||
    typeof plan !== "object" ||
    plan.kind !== "planned" ||
    !Array.isArray(plan.parts)
  )
    throw new TypeError("Invalid QQ output plan input");
  const parsed = parse(z.array(OutcomeSchema), outcomes);
  if (parsed.length !== plan.parts.length) {
    throw new TypeError("Invalid QQ output plan input");
  }
  const parts: QqPlannedSendPart[] = [];
  for (const [index, part] of plan.parts.entries()) {
    const outcome = parsed[index];
    if (outcome === undefined) throw new TypeError("Invalid QQ output plan input");
    // Only a planned reply reaches a platform: an abandoned plan had nothing to submit, so
    // it cannot be handed outcomes here. §9.3's per-conversation history is why the sticker's
    // asset id travels with the part: "that a sticker went out" is not enough to answer "was
    // this one used recently".
    parts.push(
      Object.freeze({
        kind: part.kind,
        result: outcome.result,
        messageId: outcome.messageId,
        stickerId: part.kind === "sticker" ? part.stickerId : null,
      }),
    );
  }
  qqSendSummary({ parts });
  return Object.freeze(parts);
}
