// Test-only pre-cutover behavior oracle; never import from production.
// P3j: read-only send preflight for an internally produced draft (text and/or sticker).
// This is NOT an atomic submit, a source/capacity audit, or permission to use OneBot.
//
// P4i gave the draft a sticker part, so the check is no longer "the sentence is non-empty" but
// "the assembled reply has something to send": §8.1-2 allows a sticker alone, and §8.1-6's
// downgrade — a pick that no longer resolves to a usable candidate leaves the text standing — is
// applied by re-assembling the plan against live facts (`planQqPreparedReply`). The verdict is
// still just a verdict: no body and no receiver leave this module.
import { z } from "zod";
import { readQqBinding } from "../../../src/server/db/qq-binding-repository";
import {
  memberEventNeedsReview,
  newestMemberEventFor,
} from "../../../src/server/db/qq-observation-intake";
import {
  type QqConversationScope,
  qqMemberEventCount,
} from "../../../src/server/db/qq-observation-repository";
import { readQqOwnerIdentity } from "../../../src/server/db/qq-owner-repository";
import { effectiveQqTriggers, readQqScheme } from "../../../src/server/db/qq-scheme-repository";
import { readQqSettings } from "../../../src/server/db/qq-settings-repository";
import { getAgentRow, type Orm } from "../../../src/server/db/repositories";
import { checkQqTask } from "../../../src/server/services/qq-binding-contract";
import { qqMemoryReadIsCurrent } from "../../../src/server/services/qq-memory-recall";
import {
  checkQqSpeechSend,
  disabledKindsFromTriggers,
} from "../../../src/server/services/qq-speaking-contract";
import {
  planQqPreparedReply,
  type QqStickerStage,
} from "../../../src/server/services/qq-sticker-runner";
import type { QqPendingReview } from "./qq-reply-runner";

export type QqSendPreflight =
  | { readonly kind: "blocked"; readonly reason: string }
  | { readonly kind: "review_required" }
  | { readonly kind: "checks_passed" };

/** Call again at submission under an exclusive per-conversation guard; this alone cannot send. */
export function checkQqTextPreflight(
  orm: Orm,
  draft: QqPendingReview,
  stage: QqStickerStage,
): QqSendPreflight {
  const shape = z
    .strictObject({
      text: z.string().nullable(),
      path: z.enum(["direct_reply", "follow_up", "chiming_in", "idle_topic"]),
      schemeRevision: z.number().int().positive(),
      agentConfigVersion: z.number().int().positive(),
      memberEventCount: z.number().int().nonnegative(),
      recomputesUsed: z.number().int().nonnegative(),
      nowSeconds: z.number().int().nonnegative(),
      snapshot: z.unknown(),
      // Carried for the sticker stage's own call, which re-validates its messages; this check
      // does not read it.
      selection: z.unknown(),
      // Absent (the sticker stage has not run) reads as "no sticker", the same reading
      // `planQqPreparedReply` applies — the two must not disagree about an undecided draft.
      stickerId: z.string().min(1).nullable().optional(),
      // 0037: 这条消息回给谁（发送时 `@` 的号）。`null`＝没有对象，不加 `@`。
      targetSpeakerId: z.string().min(1).nullable().optional(),
      memoryRead: z.strictObject({ keys: z.array(z.string()), fingerprint: z.string() }).optional(),
    })
    .safeParse(draft);
  if (!shape.success) throw new TypeError("Invalid QQ send preflight input");
  const binding = readQqBinding(orm, draft.snapshot.bindingId);
  const check = checkQqTask(draft.snapshot, binding, "send", readQqOwnerIdentity(orm));
  if (check.kind === "blocked") return { kind: "blocked", reason: check.reason };
  if (!binding || binding.schemeId !== draft.snapshot.schemeId)
    return { kind: "blocked", reason: "binding_changed" };
  const settings = readQqSettings(orm);
  if (settings.accountId !== binding.accountId)
    return { kind: "blocked", reason: "account_mismatch" };
  const scheme = readQqScheme(orm, binding.schemeId);
  if (!scheme || scheme.revision !== draft.schemeRevision)
    return { kind: "blocked", reason: "scheme_changed" };
  const agent = getAgentRow(orm, binding.agentId);
  if (agent?.isActive !== 1 || agent.configVersion !== draft.agentConfigVersion)
    return { kind: "blocked", reason: "agent_changed" };
  const gate = checkQqSpeechSend({
    kind: draft.path,
    featureEnabled: settings.enabled === 1,
    conversationPaused: binding.paused,
    disabledKinds: disabledKindsFromTriggers(effectiveQqTriggers(binding, scheme)),
  });
  if (gate.kind === "blocked") return { kind: "blocked", reason: gate.reason };
  const scope: QqConversationScope = {
    kind: "qq",
    accountId: binding.accountId,
    conversationKind: binding.kind,
    peerId: binding.peerId,
    agentId: binding.agentId,
  };
  // Everything §8.1 asks before a reply may be sent, assembled from the facts as they are now:
  // no text and no sticker cannot be sent, and neither can a reply whose only content is a
  // sticker that stopped being usable.
  if (draft.memoryRead && !qqMemoryReadIsCurrent(orm, binding.agentId, draft.memoryRead))
    return { kind: "blocked", reason: "memory_changed" };
  const plan = planQqPreparedReply(orm, draft, stage);
  if (plan.kind === "abandoned") return { kind: "blocked", reason: plan.reason };
  // 与生成阶段同一条规矩（2026-09-25）：只有"冲着她来的"或"她正在回的那个人"的新消息才要求复核，
  // 别人插一句无关的话不拦这一条。两处判据必须一致，否则预检会把生成阶段已经放行的草稿又拦下来。
  if (
    qqMemberEventCount(orm, scope) !== draft.memberEventCount &&
    memberEventNeedsReview({
      newest: newestMemberEventFor(orm, scope),
      targetSpeakerId: draft.targetSpeakerId ?? null,
    })
  )
    return { kind: "review_required" };
  return { kind: "checks_passed" };
}
