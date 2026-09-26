// How much conversation the judgement and the reply each get to see (ADR0018 P3b-2).
//
// §6.1 requires the two to be configured separately, and the reason is that they want
// different things: judging "should this assistant say something" only needs to know what the
// conversation is about right now, while a reply has to actually join in. It also forbids the
// failure mode this module exists to prevent — stuffing the whole group history into every
// judgement.
//
// The user fixed both tiers on 2026-09-23 (20 messages / 1 hour / 2000 bytes to judge;
// 60 messages / 6 hours / 6000 bytes to reply; and the assistant's own words are kept so it
// can see what it just said). This module turns that into a selection: which messages, in
// what order, and what had to be left out.
//
// It is pure — no database, no clock, no model. Budgets are counted with the project's single
// estimator (token-estimate.ts), the same one the web context budgets use, so the two halves
// of the product cannot disagree about what a budget means.
//
// Two things are structural rather than documented:
//   * a `system` notice cannot even be put into a timeline. Someone joining or a recall is
//     not conversation content, and the same rule already governs the no-reply check (P3a);
//   * unread media is carried as a count per message. §7.1 forbids pretending to know what a
//     picture shows, so a message with `mediaUnread > 0` hands the next stage the fact that
//     something was there and was NOT read, instead of a message that merely looks empty.

import { z } from "zod";
import { SourceRefSchema } from "../../shared/contracts/evidence";
// 存储与接口共用同一份契约。这里曾经各留一份，结果"上限放宽到 1 万"只改到了存储侧、
// 接口那边仍卡在 200/500，所以改成直接复用 shared 的定义。
import {
  type QqSchemeCompression,
  QqSchemeCompressionSchema,
  type QqSchemeContext,
  QqSchemeContextSchema,
} from "../../shared/contracts/qq";
import { estimateTokens } from "./token-estimate";

export type { QqSchemeContext };
export { QqSchemeContextSchema };

/**
 * What one message costs beyond its text: speaker label, separators, framing. Messages are
 * not free, and a budget that ignored them would admit more of them than it can pay for. The
 * web context uses the same idea with its own overhead figure (context-builder.ts).
 */
export const QQ_CONTEXT_MESSAGE_OVERHEAD = 16;

export const ContextMessageSchema = z
  .strictObject({
    occurredAtSeconds: z.number().int().nonnegative(),
    speaker: z.enum(["member", "anonymous", "assistant"]),
    /**
     * The speaker's stable QQ number, present exactly for a named member. Latest nicknames
     * are stored separately and resolved only for display; they never replace this identity.
     */
    speakerId: z.string().min(1).nullable(),
    /** `null` when there is nothing readable: a picture with no description, voice unread. */
    text: z.string().min(1).nullable(),
    /** Notes that exist for this message's media. Model output; the caller labels the source. */
    mediaNotes: z.array(z.string().min(1)),
    /** How many of this message's media are still unread. Must not be claimed as understood. */
    mediaUnread: z.number().int().nonnegative(),
    sources: z.array(SourceRefSchema).optional(),
  })
  .superRefine((message, ctx) => {
    // The same rule the observation tables enforce: a member is identified by a number, an
    // anonymous speaker and the assistant are not.
    if ((message.speaker === "member") !== (message.speakerId !== null)) {
      ctx.addIssue({ code: "custom", message: "speakerId is present exactly for a member" });
    }
  });
export type QqContextMessage = z.output<typeof ContextMessageSchema>;

export type QqContextTier = "judgement" | "reply";

/**
 * The values the user fixed on 2026-09-23, matching the DDL defaults. The window ceiling is
 * 14 days on purpose: observation text is deleted after that, so a longer window could only
 * select messages whose bodies are gone.
 * 2026-09-26 起：回复档的**条数**在运行时不取这里，而取绑定助手的「近期保留轮数」；
 * 这份默认值仍是列默认与新建方案的初值。
 */
export const QQ_CONTEXT_DEFAULT: QqSchemeContext = Object.freeze({
  judgement_message_limit: 20,
  judgement_window_minutes: 60,
  judgement_token_budget: 2000,
  reply_message_limit: 60,
  reply_window_minutes: 360,
  reply_token_budget: 6000,
});

export interface QqContextLimits {
  readonly messageLimit: number;
  readonly windowMinutes: number;
  readonly tokenBudget: number;
}

function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) throw new TypeError("Invalid QQ context contract input");
  return result.data;
}

/** Validate a stored or assembled context group; storage maps rows through this. */
export function parseQqSchemeContext(input: unknown): QqSchemeContext {
  return Object.freeze(parse(QqSchemeContextSchema, input));
}

/** 0046：压缩与装配组（与 shared 同一份契约，存储层在这里过一遍并抛 TypeError）。 */
export function parseQqSchemeCompression(input: unknown): QqSchemeCompression {
  const result = QqSchemeCompressionSchema.safeParse(input);
  if (!result.success) throw new TypeError("Invalid QQ scheme compression input");
  return Object.freeze(result.data);
}

/** The three knobs of one tier, under the names the selection works with. */
export function qqContextLimits(context: unknown, tier: QqContextTier): QqContextLimits {
  const value = parse(QqSchemeContextSchema, context);
  if (tier !== "judgement" && tier !== "reply") throw new TypeError("Invalid QQ context tier");
  return tier === "judgement"
    ? {
        messageLimit: value.judgement_message_limit,
        windowMinutes: value.judgement_window_minutes,
        tokenBudget: value.judgement_token_budget,
      }
    : {
        messageLimit: value.reply_message_limit,
        windowMinutes: value.reply_window_minutes,
        tokenBudget: value.reply_token_budget,
      };
}

/**
 * One conversation in time order, with the assistant's own utterances in their place.
 *
 * Both sides travel in one list because the order between them is the thing that matters:
 * an assistant that does not know its own line was two messages ago cannot continue a thread
 * without repeating itself. The assistant's entries carry no media: what was sent is in the
 * send ledger, and a sticker-only utterance has no words to place here (which is why the
 * caller's own-speech input only contains utterances that had text).
 */
export function qqBuildTimeline(input: unknown): readonly QqContextMessage[] {
  const value = parse(
    z.strictObject({
      messages: z.array(ContextMessageSchema),
      ownSpeech: z.array(
        z.strictObject({
          occurredAtSeconds: z.number().int().nonnegative(),
          text: z.string().min(1),
          sources: z.array(SourceRefSchema).optional(),
        }),
      ),
    }),
    input,
  );
  const own: QqContextMessage[] = value.ownSpeech.map((entry) => ({
    occurredAtSeconds: entry.occurredAtSeconds,
    speaker: "assistant",
    speakerId: null,
    text: entry.text,
    mediaNotes: [],
    mediaUnread: 0,
    ...(entry.sources ? { sources: entry.sources } : {}),
  }));
  return Object.freeze(
    [...value.messages, ...own].sort(
      (left, right) => left.occurredAtSeconds - right.occurredAtSeconds,
    ),
  );
}

export interface QqContextSelection {
  /** Oldest first, which is the order a model reads a conversation in. */
  readonly messages: readonly QqContextMessage[];
  /** Estimated cost of what was kept, in the project's estimator unit. */
  readonly bytes: number;
  readonly included: number;
  readonly droppedByWindow: number;
  readonly droppedByCount: number;
  readonly droppedByBudget: number;
  /** Unread media inside the selection: something was there and was not understood. */
  readonly mediaUnread: number;
  /** True when even the newest message alone exceeds the budget. */
  readonly newestExceedsBudget: boolean;
}

const SelectionInputSchema = z.strictObject({
  timeline: z.array(ContextMessageSchema),
  limits: z.strictObject({
    messageLimit: z.number().int().min(1),
    windowMinutes: z.number().int().min(1),
    tokenBudget: z.number().int().min(1),
  }),
  nowSeconds: z.number().int().nonnegative(),
});

function messageCost(message: QqContextMessage): number {
  const notes = message.mediaNotes.reduce((sum, note) => sum + estimateTokens(note), 0);
  return QQ_CONTEXT_MESSAGE_OVERHEAD + estimateTokens(message.text ?? "") + notes;
}

/**
 * Choose what the next step sees.
 *
 * Order of narrowing, and it matters which is reported: the window first (the plan's "cannot
 * stuff the whole history in" bound), then the count, then the budget. The budget walks from
 * the newest backwards and stops at the first message that would not fit — everything older
 * goes too, so the selection always ends at the newest message rather than dropping a hole in
 * the middle of a conversation.
 *
 * The newest message is kept even when it alone exceeds the budget: a judgement made blind to
 * the message that prompted it is worse than an over-budget one, and the caller is told
 * (`newestExceedsBudget`) so it can be reported rather than discovered.
 */
export function qqSelectContext(input: unknown): QqContextSelection {
  const value = parse(SelectionInputSchema, input);
  const windowStart = value.nowSeconds - value.limits.windowMinutes * 60;

  const inWindow: QqContextMessage[] = [];
  let droppedByWindow = 0;
  for (const message of value.timeline) {
    if (message.occurredAtSeconds < windowStart) droppedByWindow++;
    else inWindow.push(message);
  }

  const newestFirst = [...inWindow].reverse();
  const droppedByCount = Math.max(0, newestFirst.length - value.limits.messageLimit);
  const counted = newestFirst.slice(0, value.limits.messageLimit);

  const kept: QqContextMessage[] = [];
  let bytes = 0;
  let droppedByBudget = 0;
  for (const [index, message] of counted.entries()) {
    const cost = messageCost(message);
    if (kept.length > 0 && bytes + cost > value.limits.tokenBudget) {
      droppedByBudget = counted.length - index;
      break;
    }
    kept.push(message);
    bytes += cost;
  }

  const messages = Object.freeze([...kept].reverse());
  return Object.freeze({
    messages,
    bytes,
    included: messages.length,
    droppedByWindow,
    droppedByCount,
    droppedByBudget,
    mediaUnread: messages.reduce((sum, message) => sum + message.mediaUnread, 0),
    newestExceedsBudget: kept.length === 1 && bytes > value.limits.tokenBudget,
  });
}
