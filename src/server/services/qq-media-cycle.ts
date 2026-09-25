// One reading turn for a message that carried media (ADR0018 P4/P5, §7.1).
//
// The reader (`readQqMediaOnce`) reads ONE segment and owns every guard around it. Something has to
// pick which segment, and that is all this module does: it walks the message's media rows in order
// and hands the first one that has no description yet to the reader.
//
// Three §7.1 rules are visible here rather than buried in a loop:
//
//   * ONE segment per turn. A failure means "stay silent and wait for a related supplement", not
//     "try the next one" — so the cycle never burns through a message's media in one call.
//   * Described segments are skipped without an attempt: asking again would spend a budget the
//     plan gave to retries, not to repetition.
//   * Nothing is announced. The reader returns a verdict; the caller decides what a failure means
//     (§7.1: a failed read is recorded in the management page, never posted into the conversation).

import { z } from "zod";
import { mediaSegmentsForEvent } from "../db/qq-media-repository";
import type { Orm } from "../db/repositories";
import {
  type QqMediaReadAdapter,
  type QqMediaReadResult,
  readQqMediaOnce,
} from "./qq-media-reader";

export type QqMediaCycleResult =
  | {
      readonly kind: "read";
      readonly segmentIndex: number;
      readonly result: QqMediaReadResult;
    }
  | { readonly kind: "idle"; readonly reason: "no_media" | "all_described" };

const Input = z.strictObject({
  eventKey: z.string().min(1),
  addressedToAssistant: z.boolean(),
  relatedSupplementArrived: z.boolean(),
  modelConfig: z.strictObject({
    visionModelName: z.string().nullable(),
    transcriptionModelName: z.string().nullable(),
  }),
});

/**
 * Read at most one of a message's media segments.
 *
 * The `modelConfig` arrives from the caller (the shared settings row's two purposes at the time of
 * the turn), and `addressedToAssistant`/`relatedSupplementArrived` describe why this turn is
 * happening at all: §7.1 lets a read happen when the assistant was addressed, or once more when a
 * related supplement arrived after a failure.
 */
export async function readQqAddressedMediaOnce(
  orm: Orm,
  adapter: QqMediaReadAdapter,
  input: unknown,
): Promise<QqMediaCycleResult> {
  const parsed = Input.safeParse(input);
  if (!parsed.success) throw new TypeError("Invalid QQ media cycle input");
  const value = parsed.data;
  const segments = mediaSegmentsForEvent(orm, value.eventKey);
  if (segments.length === 0) return { kind: "idle", reason: "no_media" };
  const target = segments.find((segment) => segment.described !== true);
  if (target === undefined) return { kind: "idle", reason: "all_described" };
  const result = await readQqMediaOnce(orm, adapter, {
    eventKey: target.eventKey,
    segmentIndex: target.segmentIndex,
    addressedToAssistant: value.addressedToAssistant,
    relatedSupplementArrived: value.relatedSupplementArrived,
    modelConfig: value.modelConfig,
  });
  return Object.freeze({ kind: "read", segmentIndex: target.segmentIndex, result });
}
