// P3h: strict, model-independent verdict for a newly arrived QQ supplement.
// A verdict never authorises delivery; only a later guarded send stage may do that.
import { z } from "zod";

export const QQ_REVIEW_RESPONSE_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["needs_recompute"],
  properties: {
    needs_recompute: { type: "boolean" },
    reason: { type: "string", maxLength: 200 },
  },
});

const ReviewSchema = z.strictObject({
  needs_recompute: z.boolean(),
  reason: z.string().max(200).optional(),
});

export type QqReviewVerdict =
  | { readonly kind: "keep" }
  | { readonly kind: "recompute" }
  | { readonly kind: "unreadable" };

/** Invalid or extra fields never imply that an old draft remains valid. */
export function qqReviewVerdict(raw: string): QqReviewVerdict {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "unreadable" };
  }
  const result = ReviewSchema.safeParse(parsed);
  if (!result.success) return { kind: "unreadable" };
  return { kind: result.data.needs_recompute ? "recompute" : "keep" };
}
