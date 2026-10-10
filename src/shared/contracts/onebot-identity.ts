// OneBot wire identity contract: message ids may be signed; account ids must be
// positive. Leading zeros and a redundant sign are stripped ("-00012" -> "-12",
// "-0" -> "0"), so numeric and string wire forms canonicalise to one id.

import { z } from "zod";

export const OneBotWireIdSchema = z
  .union([z.number().int(), z.string().regex(/^-?\d+$/)])
  .transform((value) => {
    const text = String(value);
    const negative = text.startsWith("-");
    const digits = (negative ? text.slice(1) : text).replace(/^0+(?=\d)/, "");
    return negative && digits !== "0" ? `-${digits}` : digits;
  });

/** Accounts and groups are wire ids that must be strictly positive. */
export const OneBotAccountIdSchema = OneBotWireIdSchema.refine(
  (id) => id !== "0" && !id.startsWith("-"),
);

/** The canonical account id, or null when the value is not a positive id. */
export function normalizeOneBotAccountId(input: unknown): string | null {
  const parsed = OneBotAccountIdSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}
