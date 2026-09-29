// The inbound event path (ADR0018 P2/P3/P4, §7.1): what happens right after a message is recorded.
//
// Intake (`qq-intake.ts`) owns the transport, the housekeeping pass and the storage boundary. This
// module is the second half of the same turn:
//
//   1. CLASSIFY. The conservative event-driven decision (P3k) turns a real event into at most one
//      queued candidate: a group message that is not addressed to the assistant becomes a
//      `chiming_in` candidate, a directly addressed one does not enter the queue at all. The
//      classification itself is `enqueueQqDispatchFromEvent`'s job (or the caller's dispatch);
//      this module only supplies the facts it needs — including the merge window, which belongs
//      to the conversation's scheme.
//   2. REPORT THE MEDIA FACT. The storage boundary still records every media segment; this module
//      only reports whether the message carried any. Nothing is read: per ADR0019 §8.11 the main
//      Agent understands images on demand through an explicit tool call, so this path never calls
//      a model and never retries a failed read.

import { readBindingByConversation } from "../db/qq-binding-repository";
import { mediaSegmentsForEvent } from "../db/qq-media-repository";
import { readQqScheme, schemeRhythm } from "../db/qq-scheme-repository";
import type { Orm } from "../db/repositories";
import type { QqObservation } from "./onebot-protocol";
import { enqueueQqDispatchFromEvent, type QqDispatchEnqueueResult } from "./qq-dispatch";

export interface QqEventPathOutcome {
  readonly dispatch: QqDispatchEnqueueResult;
  /**
   * `hasMedia` is the recorded fact. `own` and `supplement` are always `null` — the field shape is
   * kept so the caller's diagnostic event stays stable, not because a read might still happen here.
   */
  readonly media: {
    readonly hasMedia: boolean;
    readonly own: null;
    readonly supplement: null;
  };
}

const NO_MEDIA = Object.freeze({ hasMedia: false, own: null, supplement: null });

/**
 * One recorded message, followed up.
 *
 * Returns what it did rather than reporting through a callback, so the caller can log a
 * content-free summary and tests can pin the decisions without reading a log.
 */
export async function handleQqRecordedMessage(
  orm: Orm,
  input: {
    readonly observation: QqObservation;
    readonly nowSeconds: number;
  },
  deps: {
    /** The canonical ingress owns wake creation; legacy callers retain their original classifier. */
    readonly dispatch?: typeof enqueueQqDispatchFromEvent;
  } = {},
): Promise<QqEventPathOutcome> {
  const { observation } = input;
  // Resolved here rather than taken from the caller: recording already resolved it once, and a
  // conversation that was re-bound between the write and this turn must be refused instead of
  // classified against a binding that is no longer this one.
  const binding = readBindingByConversation(orm, {
    accountId: observation.accountId,
    kind: observation.conversation.kind,
    peerId: observation.conversation.peerId,
  });
  if (!binding) {
    return {
      dispatch: { kind: "not_scheduled", reason: "binding_missing" },
      media: NO_MEDIA,
    };
  }
  const scheme = readQqScheme(orm, binding.schemeId);
  if (!scheme) {
    return {
      dispatch: { kind: "not_scheduled", reason: "scheme_missing" },
      media: NO_MEDIA,
    };
  }

  const dispatch = (deps.dispatch ?? enqueueQqDispatchFromEvent)(orm, {
    bindingId: binding.id,
    conversationKind: observation.conversation.kind,
    speaker: observation.speaker.kind,
    // The attention list matches on the stable id, so the classification needs it too (0031).
    speakerId: observation.speaker.kind === "member" ? observation.speaker.id : null,
    mentionsSelf: observation.mentionsSelf,
    eventKey: observation.eventKey,
    observedAtSeconds: observation.occurredAtSeconds,
    nowSeconds: input.nowSeconds,
    mergeWindowSeconds: schemeRhythm(scheme).merge_window_seconds,
  });

  const hasMedia = mediaSegmentsForEvent(orm, observation.eventKey).length > 0;
  return { dispatch, media: { hasMedia, own: null, supplement: null } };
}
