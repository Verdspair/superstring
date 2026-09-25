// The inbound event path (ADR0018 P2/P3/P4, §7.1): what happens right after a message is recorded.
//
// Intake (`qq-intake.ts`) owns the transport, the housekeeping pass and the storage boundary. This
// module is the second half of the same turn — the three things the plan asks for once a message is
// durably ours:
//
//   1. CLASSIFY. The conservative event-driven decision (P3k) turns a real event into at most one
//      queued candidate: a group message that is not addressed to the assistant becomes a
//      `chiming_in` candidate, a directly addressed one does not enter the queue at all. The
//      classification itself is `enqueueQqDispatchFromEvent`'s job; this module only supplies the
//      facts it needs — including the merge window, which belongs to the conversation's scheme.
//   2. UNDERSTAND THE MEDIA ONCE (§7.1). A picture or a voice message is read when it arrives:
//      addressed or not, the FIRST read is allowed (the user decided on 2026-09-24 that non-@
//      media is read once too), and everything about retries stays in the reader.
//   3. WAKE A FAILED READ ONCE MORE, when the SAME SPEAKER comes back within the scheme's window.
//      That is the user's definition of "相关补充" (2026-09-24) — a fact of the delivery, not a
//      judgement about the words, so it costs nothing to decide and cannot be argued with.
//
// What it never does: send anything, and call a model for a segment that is already described.
// Every guard (feature switch, binding, pause, agent, expiry, attempts, model configured) lives in
// the reader; this module hands it facts and reads its verdict.

import { readOrganizationSettings } from "../db/organization-repository";
import { readBindingByConversation } from "../db/qq-binding-repository";
import { mediaSegmentsForEvent, pendingMediaSupplementFor } from "../db/qq-media-repository";
import { readQqScheme, schemePrompts, schemeRhythm } from "../db/qq-scheme-repository";
import type { Orm } from "../db/repositories";
import type { QqObservation } from "./onebot-protocol";
import { enqueueQqDispatchFromEvent, type QqDispatchEnqueueResult } from "./qq-dispatch";
import { type QqMediaCycleResult, readQqAddressedMediaOnce } from "./qq-media-cycle";
import type { QqMediaReadAdapter } from "./qq-media-reader";

/** The media seam. Omitted entirely, media is recorded and never read (P4b's rule stands). */
export interface QqEventMediaDeps {
  /**
   * The adapter for ONE conversation: built per read because the instruction that travels with
   * the picture is that conversation's scheme media slot, and a cached adapter would carry the
   * wrong scheme's words after a switch.
   */
  readonly adapterFor: (input: {
    readonly mediaPrompt: string;
    /** §7.1's 可改 sampling, from the same scheme the prompt came from (0029). */
    readonly frames: number;
    readonly maxDimension: number;
  }) => QqMediaReadAdapter;
}

export interface QqEventPathOutcome {
  readonly dispatch: QqDispatchEnqueueResult;
  /** `null` when nothing was attempted (no media on the message, or no media seam wired). */
  readonly media: {
    readonly hasMedia: boolean;
    readonly own: QqMediaCycleResult | null;
    readonly supplement: QqMediaCycleResult | null;
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
  deps: { readonly media?: QqEventMediaDeps } = {},
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

  const dispatch = enqueueQqDispatchFromEvent(orm, {
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
  if (!deps.media) return { dispatch, media: { hasMedia, own: null, supplement: null } };

  // The two purposes come from the SHARED settings row, and "unset" means the read is refused
  // (P4b) — never a fallback to the conversation model, which would describe a picture it cannot
  // see. Read per message so a change applies to the next one.
  const purposes = readOrganizationSettings(orm);
  const modelConfig = {
    visionModelName: purposes.vision_model_name,
    transcriptionModelName: purposes.transcription_model_name,
  };
  const mediaRhythm = schemeRhythm(scheme);
  const adapter = deps.media.adapterFor({
    mediaPrompt: schemePrompts(scheme).media,
    frames: mediaRhythm.media_frame_count,
    maxDimension: mediaRhythm.media_max_dimension,
  });
  const addressed = observation.mentionsSelf || observation.conversation.kind === "private";

  // The message's OWN media first, when it has any. A message with no media is not a dead end:
  // §7.1's supplement is usually exactly that — "这张图里是猫吧？" carries no picture of its own,
  // and an early return here would mean a waiting read could never be woken.
  const own = hasMedia
    ? await readQqAddressedMediaOnce(orm, adapter, {
        eventKey: observation.eventKey,
        addressedToAssistant: addressed,
        relatedSupplementArrived: false,
        modelConfig,
      })
    : null;

  // §7.1's second understanding: the same speaker, inside the scheme's window. `0` turns the
  // wait off while leaving the first read in place. The window is measured BACK from this
  // message, so only a failed read that is still fresh is woken — a stray message an hour later
  // does not reopen a picture nobody has mentioned since.
  const windowMinutes = schemeRhythm(scheme).media_supplement_window_minutes;
  // 2026-09-25 后续：唤醒不再要求"同一个说话人"——群里谁把话头接回来都算数；而重试本身只在
  // **有人叫到助手**时发生（`addressed` 传进 reader，而不是无条件 true），所以"喊它看图"能生效，
  // 而一条与它无关的闲聊不会替失败的读取花钱。
  const supplement =
    windowMinutes > 0 && observation.speaker.kind === "member"
      ? (() => {
          const target = pendingMediaSupplementFor(orm, {
            accountId: observation.accountId,
            conversationKind: observation.conversation.kind,
            peerId: observation.conversation.peerId,
            sinceSeconds: observation.occurredAtSeconds - windowMinutes * 60,
            beforeSeconds: observation.occurredAtSeconds,
            excludeEventKey: observation.eventKey,
          });
          if (!target) return null;
          return target;
        })()
      : null;

  const supplementResult =
    supplement === null
      ? null
      : await readQqAddressedMediaOnce(orm, adapter, {
          eventKey: supplement.eventKey,
          // 2026-09-25 后续：被叫到（@ / 私聊 / 回复它）才允许这一次重试；`relatedSupplementArrived`
          // 仍然是第二把锁，两把都开才重试。
          addressedToAssistant: addressed,
          relatedSupplementArrived: true,
          modelConfig,
        });

  return { dispatch, media: { hasMedia, own, supplement: supplementResult } };
}
