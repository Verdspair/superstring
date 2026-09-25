// Test-only pre-cutover behavior oracle; never import from production.
// P3h review gate for newly observed QQ messages. Never submits to OneBot.

import { readQqBinding } from "../../../src/server/db/qq-binding-repository";
import { qqMemberLabels } from "../../../src/server/db/qq-member-repository";
import {
  conversationMessagesSince,
  type QqConversationScope,
  qqMemberEventCount,
} from "../../../src/server/db/qq-observation-repository";
import { readQqOwnerIdentity } from "../../../src/server/db/qq-owner-repository";
import {
  effectiveQqTriggers,
  readQqScheme,
  schemeContext,
  schemeOutputReserve,
  schemePrompts,
  schemeRhythm,
} from "../../../src/server/db/qq-scheme-repository";
import { readQqSettings } from "../../../src/server/db/qq-settings-repository";
import { ownSpeechSince } from "../../../src/server/db/qq-speech-repository";
import { getAgentRow, type Orm } from "../../../src/server/db/repositories";
import type { ModelGateway } from "../../../src/server/llm/model-gateway";
import { checkQqTask } from "../../../src/server/services/qq-binding-contract";
import { checkQqModelCapacity } from "../../../src/server/services/qq-capacity-preflight";
import {
  qqBuildTimeline,
  qqContextLimits,
  qqSelectContext,
} from "../../../src/server/services/qq-context-contract";
import { buildQqPrompt, qqPromptMessages } from "../../../src/server/services/qq-prompt-contract";
import {
  QQ_REVIEW_RESPONSE_SCHEMA,
  qqReviewVerdict,
} from "../../../src/server/services/qq-review-contract";
import { qqRecomputeVerdict } from "../../../src/server/services/qq-rhythm-contract";
import {
  checkQqSpeechSend,
  disabledKindsFromTriggers,
} from "../../../src/server/services/qq-speaking-contract";
import { compileSystemPrompt, runtimeFromAgent } from "../../../src/server/services/runtime-config";
import type { QqPendingReview, QqReplyDraft } from "./qq-reply-runner";

export type QqReviewResult =
  | { readonly kind: "blocked"; readonly reason: string }
  | {
      readonly kind:
        | "review_required"
        | "model_error"
        | "unreadable"
        | "recompute_budget"
        | "capacity_unavailable"
        | "capacity_exceeded";
    }
  | { readonly kind: "recompute_needed"; readonly used: number; readonly eventCount: number }
  | { readonly kind: "unchanged"; readonly text: string; readonly eventCount: number };

/** The caller retains ownership of a pending item; neither verdict is send permission. */
export async function reviewQqSupplement(
  orm: Orm,
  gateway: Pick<ModelGateway, "complete" | "loadedContextCapacity">,
  pending: QqPendingReview,
  nowSeconds: number,
): Promise<QqReviewResult> {
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0)
    throw new TypeError("Invalid QQ review clock");
  const { snapshot, path, schemeRevision, agentConfigVersion } = pending;
  const binding = readQqBinding(orm, snapshot.bindingId);
  const check = checkQqTask(snapshot, binding, "send", readQqOwnerIdentity(orm));
  if (check.kind === "blocked") return { kind: "blocked", reason: check.reason };
  if (!binding || binding.schemeId !== snapshot.schemeId)
    return { kind: "blocked", reason: "binding_changed" };
  const settings = readQqSettings(orm);
  if (settings.accountId !== binding.accountId)
    return { kind: "blocked", reason: "account_mismatch" };
  const scheme = readQqScheme(orm, binding.schemeId);
  if (!scheme || scheme.revision !== schemeRevision)
    return { kind: "blocked", reason: "scheme_changed" };
  const agent = getAgentRow(orm, binding.agentId);
  if (agent?.isActive !== 1 || agent.configVersion !== agentConfigVersion)
    return { kind: "blocked", reason: "agent_changed" };
  const sendGate = checkQqSpeechSend({
    kind: path,
    featureEnabled: settings.enabled === 1,
    conversationPaused: binding.paused,
    disabledKinds: disabledKindsFromTriggers(effectiveQqTriggers(binding, scheme)),
  });
  if (sendGate.kind === "blocked") return { kind: "blocked", reason: sendGate.reason };
  const scope: QqConversationScope = {
    kind: "qq",
    accountId: binding.accountId,
    conversationKind: binding.kind,
    peerId: binding.peerId,
    agentId: binding.agentId,
  };
  const countBefore = qqMemberEventCount(orm, scope);
  if (countBefore <= pending.memberEventCount) return { kind: "review_required" };
  const limits = qqContextLimits(schemeContext(scheme), "reply");
  const sinceSeconds = Math.max(0, nowSeconds - limits.windowMinutes * 60 - 1);
  const timeline = qqBuildTimeline({
    messages: conversationMessagesSince(orm, scope, {
      sinceSeconds,
      limit: limits.messageLimit,
    }).map(({ eventKey: _eventKey, ...message }) => message),
    ownSpeech: ownSpeechSince(orm, scope, { sinceSeconds, limit: limits.messageLimit }),
  });
  const selection = qqSelectContext({ timeline, limits, nowSeconds });
  if (qqMemberEventCount(orm, scope) !== countBefore) return { kind: "review_required" };
  // Missing/empty original reply cannot be declared safe by a review model. A reply without a
  // sentence is the same case even when it carries a sticker (§8.1-2, P4i): there is nothing for
  // the review prompt's draft section to hold, so the answer is regeneration, not approval.
  if (pending.text === null || pending.text.trim() === "") {
    const budget = qqRecomputeVerdict({
      used: pending.recomputesUsed,
      maxRecomputeCount: schemeRhythm(scheme).max_recompute_count,
    });
    return budget.kind === "allowed"
      ? { kind: "recompute_needed", used: pending.recomputesUsed, eventCount: countBefore }
      : { kind: "recompute_budget" };
  }
  const runtime = runtimeFromAgent(agent);
  const sections = buildQqPrompt({
    tier: "review",
    path,
    persona: compileSystemPrompt(runtime),
    prompts: schemePrompts(scheme),
    timeline: selection.messages,
    nowSeconds,
    material: [{ title: "待复核的草稿（未发送）", body: pending.text }],
    labels: qqMemberLabels(
      orm,
      {
        accountId: scope.accountId,
        conversationKind: scope.conversationKind,
        peerId: scope.peerId,
      },
      new Date(nowSeconds * 1000).toISOString(),
    ),
    // 0031: mark the attention list in the timeline — a hint to the model, never a threshold.
    attentionMembers: binding.attention.members,
  });
  const messages = qqPromptMessages(sections).map(({ role, content }) => ({ role, content }));
  const capacity = await checkQqModelCapacity(gateway, {
    model: runtime.model_name,
    messages,
    outputReserved: schemeOutputReserve(scheme).judgement_output_reserved,
  });
  if (capacity.kind !== "allowed")
    return { kind: capacity.kind === "unavailable" ? "capacity_unavailable" : "capacity_exceeded" };
  if (
    readQqScheme(orm, scheme.id)?.revision !== schemeRevision ||
    qqMemberEventCount(orm, scope) !== countBefore
  )
    return { kind: "review_required" };
  let raw: string;
  try {
    raw = await gateway.complete({
      model: runtime.model_name,
      messages,
      responseSchema: QQ_REVIEW_RESPONSE_SCHEMA,
    });
  } catch {
    return { kind: "model_error" };
  }
  const again = checkQqTask(
    snapshot,
    readQqBinding(orm, snapshot.bindingId),
    "send",
    readQqOwnerIdentity(orm),
  );
  if (again.kind === "blocked") return { kind: "blocked", reason: again.reason };
  const currentSettings = readQqSettings(orm);
  if (currentSettings.accountId !== binding.accountId)
    return { kind: "blocked", reason: "account_mismatch" };
  const currentScheme = readQqScheme(orm, scheme.id);
  if (!currentScheme || currentScheme.revision !== schemeRevision)
    return { kind: "blocked", reason: "scheme_changed" };
  const currentAgent = getAgentRow(orm, agent.id);
  if (currentAgent?.isActive !== 1 || currentAgent.configVersion !== agentConfigVersion)
    return { kind: "blocked", reason: "agent_changed" };
  const currentBinding = readQqBinding(orm, snapshot.bindingId);
  if (!currentBinding) return { kind: "blocked", reason: "binding_changed" };
  const currentGate = checkQqSpeechSend({
    kind: path,
    featureEnabled: currentSettings.enabled === 1,
    conversationPaused: currentBinding.paused,
    disabledKinds: disabledKindsFromTriggers(effectiveQqTriggers(currentBinding, currentScheme)),
  });
  if (currentGate.kind === "blocked") return { kind: "blocked", reason: currentGate.reason };
  if (qqMemberEventCount(orm, scope) !== countBefore) return { kind: "review_required" };
  const verdict = qqReviewVerdict(raw);
  if (verdict.kind === "unreadable") return { kind: "unreadable" };
  if (verdict.kind === "keep")
    return { kind: "unchanged", text: pending.text, eventCount: countBefore };
  const budget = qqRecomputeVerdict({
    used: pending.recomputesUsed,
    maxRecomputeCount: schemeRhythm(scheme).max_recompute_count,
  });
  return budget.kind === "allowed"
    ? { kind: "recompute_needed", used: pending.recomputesUsed, eventCount: countBefore }
    : { kind: "recompute_budget" };
}

/** Explicit conversion for a text draft held back by a new member event. */
export function pendingQqReview(draft: Extract<QqReplyDraft, { kind: "draft" }>): QqPendingReview {
  return {
    text: draft.text,
    snapshot: draft.snapshot,
    schemeRevision: draft.schemeRevision,
    agentConfigVersion: draft.agentConfigVersion,
    path: draft.path,
    nowSeconds: draft.nowSeconds,
    memberEventCount: draft.memberEventCount,
    recomputesUsed: draft.recomputesUsed,
    selection: draft.selection,
    // A fresh draft has no sticker yet: the sticker stage belongs to the dispatch cycle (P4i),
    // which runs it against this draft's own selection.
    stickerId: undefined,
    // 0037：这条消息回给谁跟着草稿一起走。
    targetSpeakerId: draft.targetSpeakerId,
    memoryRead: draft.memoryRead,
  };
}
