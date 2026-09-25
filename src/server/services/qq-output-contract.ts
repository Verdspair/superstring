// Send results for the assistant's own messages (ADR0018 P4c).
//
// The transport already answers one question per platform request — onebot-protocol.ts
// classifies a receipt as confirmed / failed / unknown, and onebot-connection.ts turns
// that into a send result. Nothing consumed it, so §8.2's five rows existed only as
// prose, and the assistant's own speech record had no production writer at all.
//
// This module is the missing half: given what the platform did with each part of a
// reply, which §8.2 row does the reply fall into, and what may be done about it. It is
// pure rules — no database, no socket, no model, no clock.
//
// Two things it deliberately does NOT do:
//
//   * It never decides whether a failed or unknown send consumes a rhythm slot. §8.2
//     states that only for a successful send; whether failure counts is U13. Those
//     outcomes therefore report "pending" rather than a boolean that would be a guess.
//   * It never permits an automatic resend, for any outcome. §8.2 forbids adding one:
//     a send whose fate is unknown may already have been delivered, and a second copy
//     is worse than a missing sticker.

import { z } from "zod";

/** Whether a part carries words or a sticker (a face or a picture from the library). */
const PartKindSchema = z.enum(["text", "sticker"]);
export type QqSendPartKind = z.output<typeof PartKindSchema>;

/**
 * What the platform did with one request. These are exactly the transport's own
 * answers, so a send result can be passed through without a translation layer that
 * could drift: `not_sent` means no request ever reached the platform.
 */
const PartResultSchema = z.enum(["confirmed", "failed", "unknown", "not_sent"]);
export type QqSendPartResult = z.output<typeof PartResultSchema>;

const PartSchema = z
  .strictObject({
    kind: PartKindSchema,
    result: PartResultSchema,
    /**
     * The platform's id for this request. Present exactly when the platform confirmed
     * it — an id is never invented for a part whose fate is unknown, because §8.2 says
     * an unknown outcome must not be treated as either success or failure.
     */
    messageId: z.string().min(1).nullable(),
    /**
     * Which library asset a sticker part carried (P4g).
     *
     * §9.3's repetition rules are "历史按群独立", and this is what that history is made of: the
     * send ledger always recorded that a sticker went out, never which one, so "the same sticker
     * no sooner than ten minutes" had nothing to compare against. A sticker part must therefore
     * name its asset, and a part with words must not.
     *
     * Optional rather than required-nullable because a text part has nothing to say here, and
     * making every text part carry an explicit null would be noise in both directions.
     */
    stickerId: z.string().min(1).nullable().optional(),
  })
  .superRefine((part, ctx) => {
    if ((part.result === "confirmed") !== (part.messageId !== null)) {
      ctx.addIssue({
        code: "custom",
        message: "A platform message id exists exactly when the part was confirmed",
      });
    }
    // Both directions are stated, so neither can drift: a sticker part that cannot name its asset
    // would silently fall out of the repetition history, and a text part naming one would make
    // that history read as if a sticker had been sent.
    if (part.kind === "sticker" && (part.stickerId ?? null) === null) {
      ctx.addIssue({ code: "custom", message: "A sticker part names the asset it carried" });
    }
    if (part.kind === "text" && (part.stickerId ?? null) !== null) {
      ctx.addIssue({ code: "custom", message: "A text part never names a sticker" });
    }
  });

const AttemptSchema = z.strictObject({ parts: z.array(PartSchema).min(1) });
export type QqSendAttempt = Readonly<z.input<typeof AttemptSchema>>;

function parse<S extends z.ZodType>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) throw new TypeError("Invalid QQ send contract input");
  return result.data;
}

/**
 * The §8.2 rows, plus the two shapes the table names in passing: a text-only send that
 * failed outright, and a request that never left this machine.
 */
const OutcomeSchema = z.enum([
  "sent",
  "partially_sent",
  "sticker_failed",
  "text_failed",
  "unknown",
  "not_submitted",
]);
export type QqSendOutcome = z.output<typeof OutcomeSchema>;

/** Every outcome the store accepts, in the order the table lists them. */
export const QQ_SEND_OUTCOMES: readonly QqSendOutcome[] = Object.freeze([
  "sent",
  "partially_sent",
  "sticker_failed",
  "text_failed",
  "unknown",
  "not_submitted",
]);

export interface QqSendSummary {
  readonly outcome: QqSendOutcome;
  /** The platform message the reply was delivered as; null when nothing was confirmed. */
  readonly deliveryMessageId: string | null;
  readonly partCount: number;
  readonly textParts: number;
  readonly stickerParts: number;
  readonly confirmedParts: number;
  readonly failedParts: number;
  readonly unknownParts: number;
  readonly notSubmittedParts: number;
}

/**
 * Classify a whole reply from what happened to its parts.
 *
 * The precedence is §8.2's, read in order:
 *   1. everything confirmed            -> sent
 *   2. something confirmed, rest not   -> partially_sent ("text went out, the sticker
 *                                         that followed did not")
 *   3. nothing confirmed, nothing sent -> not_submitted (no request reached the platform)
 *   4. nothing confirmed, fate unknown -> unknown (neither assumed lost nor assumed sent)
 *   5. nothing confirmed, stickers only -> sticker_failed
 *   6. nothing confirmed, text involved -> text_failed
 *
 * Order matters: a reply where one part never left and another has an unknown fate is
 * `unknown`, not `not_submitted`, because something may in fact have been delivered.
 */
export function qqSendSummary(input: unknown): Readonly<QqSendSummary> {
  const { parts } = parse(AttemptSchema, input);
  const count = (result: QqSendPartResult) => parts.filter((part) => part.result === result).length;
  const confirmedParts = count("confirmed");
  const unknownParts = count("unknown");
  const failedParts = count("failed");
  const notSubmittedParts = count("not_sent");
  const stickerParts = parts.filter((part) => part.kind === "sticker").length;
  const textParts = parts.length - stickerParts;

  let outcome: QqSendOutcome;
  if (confirmedParts === parts.length) outcome = "sent";
  else if (confirmedParts > 0) outcome = "partially_sent";
  else if (notSubmittedParts === parts.length) outcome = "not_submitted";
  else if (unknownParts > 0) outcome = "unknown";
  else if (textParts === 0) outcome = "sticker_failed";
  else outcome = "text_failed";

  const delivered = parts.find((part) => part.result === "confirmed");

  return Object.freeze({
    outcome,
    deliveryMessageId: delivered?.messageId ?? null,
    partCount: parts.length,
    textParts,
    stickerParts,
    confirmedParts,
    failedParts,
    unknownParts,
    notSubmittedParts,
  });
}

/** Questions §8.2 leaves open for an outcome. They are recorded, never answered here. */
export type QqSendPendingDecision = "manual_retry" | "unknown_reconciliation";

export interface QqSendOutcomeEffect {
  /** §8.2: remember the platform message the reply was delivered as. */
  readonly recordsDeliveryId: boolean;
  /** §8.2: "更新本群发言/素材历史" — only a fully delivered reply updates both. */
  readonly updatesMaterialHistory: boolean;
  /**
   * §8.2 states this for a successful send ("主动发言进入无人回应约束"). Whether a
   * failed or unknown attempt consumes that slot is U13, so those outcomes report
   * "pending" instead of a boolean that would be a decision nobody has made.
   */
  readonly entersUnresponded: true | false | "pending";
  /** §8.2: an unknown outcome may be neither treated as sent nor as lost. */
  readonly assumesDelivery: boolean;
  /** §8.2 forbids an automatic resend for every outcome; nothing here may set it. */
  readonly resendsAutomatically: false;
  /** §8.2 纯表情失败: 不换图. */
  readonly replacesSticker: false;
  /** §8.2 纯表情失败: 不改文字; 部分失败: 不补图. */
  readonly rewritesText: false;
  /** §8.2 部分失败: 不解释. */
  readonly explainsFailure: false;
  /** What is still owed a decision before this outcome's handling is complete. */
  readonly pending: readonly QqSendPendingDecision[];
}

const EFFECTS: Readonly<Record<QqSendOutcome, QqSendOutcomeEffect>> = Object.freeze({
  // 发送成功: 记录送达消息标识，更新本群发言/素材历史；主动发言进入无人回应约束.
  sent: Object.freeze({
    recordsDeliveryId: true,
    updatesMaterialHistory: true,
    entersUnresponded: true as const,
    assumesDelivery: true,
    resendsAutomatically: false as const,
    replacesSticker: false as const,
    rewritesText: false as const,
    explainsFailure: false as const,
    pending: Object.freeze([] as const),
  }),
  // 已发文字、后续表情明确失败: 保留已发文字，只记录部分失败，不补图、不解释.
  partially_sent: Object.freeze({
    recordsDeliveryId: true,
    updatesMaterialHistory: false,
    entersUnresponded: "pending" as const,
    assumesDelivery: true,
    resendsAutomatically: false as const,
    replacesSticker: false as const,
    rewritesText: false as const,
    explainsFailure: false as const,
    pending: Object.freeze([] as const),
  }),
  // 纯表情明确失败: 只记录，不补发、不换图、不改文字.
  sticker_failed: Object.freeze({
    recordsDeliveryId: false,
    updatesMaterialHistory: false,
    entersUnresponded: "pending" as const,
    assumesDelivery: true,
    resendsAutomatically: false as const,
    replacesSticker: false as const,
    rewritesText: false as const,
    explainsFailure: false as const,
    pending: Object.freeze([] as const),
  }),
  // Not a row of the table: §8.2 mentions it only to say its manual retry is undecided.
  text_failed: Object.freeze({
    recordsDeliveryId: false,
    updatesMaterialHistory: false,
    entersUnresponded: "pending" as const,
    assumesDelivery: true,
    resendsAutomatically: false as const,
    replacesSticker: false as const,
    rewritesText: false as const,
    explainsFailure: false as const,
    pending: Object.freeze(["manual_retry"] as const),
  }),
  // 发送超时或结果不确定: 标记送达未知，不立即重复发送；不假定失败或成功.
  unknown: Object.freeze({
    recordsDeliveryId: false,
    updatesMaterialHistory: false,
    entersUnresponded: "pending" as const,
    assumesDelivery: false,
    resendsAutomatically: false as const,
    replacesSticker: false as const,
    rewritesText: false as const,
    explainsFailure: false as const,
    pending: Object.freeze(["unknown_reconciliation"] as const),
  }),
  // No request reached the platform, so nothing was delivered and nothing is at risk.
  not_submitted: Object.freeze({
    recordsDeliveryId: false,
    updatesMaterialHistory: false,
    entersUnresponded: "pending" as const,
    assumesDelivery: true,
    resendsAutomatically: false as const,
    replacesSticker: false as const,
    rewritesText: false as const,
    explainsFailure: false as const,
    pending: Object.freeze([] as const),
  }),
});

/** What may be done about an outcome; see `QqSendOutcomeEffect` for what is left open. */
export function qqSendOutcomeEffect(outcome: unknown): QqSendOutcomeEffect {
  return EFFECTS[parse(OutcomeSchema, outcome)];
}

/** Validate a stored outcome; storage maps rows through this. */
export function parseQqSendOutcome(input: unknown): QqSendOutcome {
  return parse(OutcomeSchema, input);
}

export function parseQqSendPartResult(input: unknown): QqSendPartResult {
  return parse(PartResultSchema, input);
}

export function parseQqSendPartKind(input: unknown): QqSendPartKind {
  return parse(PartKindSchema, input);
}

/**
 * The combination is not atomic at the platform (user-facing consequence of §8.1's
 * "compose into one message where possible"): one request can be accepted while the
 * next is refused. `partially_sent` exists so the ledger can say which, instead of a
 * single status column that would have to round the mixture to success or failure.
 */
export const QQ_SEND_IS_NOT_ATOMIC = true;

/**
 * 已提交平台后用户关闭: 不保证撤销平台请求，不自动撤回已送达内容.
 *
 * Kept as a named policy so a later "can we unsend that?" question has the answer in
 * one place rather than being re-derived from the platform's behaviour.
 */
export const QQ_WITHDRAWAL_POLICY = Object.freeze({
  recoversSubmittedRequest: false,
  autoRecallsDeliveredContent: false,
});
