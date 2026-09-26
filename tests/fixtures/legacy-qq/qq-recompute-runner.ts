// Test-only pre-cutover behavior oracle; never import from production.
import type { LeafAgentRuntime } from "../../../src/server/agent/agent-runtime";

// P3i: one bounded regeneration after a reviewed supplement. No QQ transport or send.

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
  schemeReply,
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
import { qqJudgementQuestion } from "../../../src/server/services/qq-judgement-material";
import {
  qqMemoryReadIsCurrent,
  recallQqReplyMemory,
} from "../../../src/server/services/qq-memory-recall";
import {
  buildQqPrompt,
  type QqPromptInput,
  qqPromptMessages,
  qqSpeakerLabel,
} from "../../../src/server/services/qq-prompt-contract";
import { qqRecomputeVerdict } from "../../../src/server/services/qq-rhythm-contract";
import {
  checkQqSpeechSend,
  disabledKindsFromTriggers,
} from "../../../src/server/services/qq-speaking-contract";
import { compileSystemPrompt, runtimeFromAgent } from "../../../src/server/services/runtime-config";
import { qqEffectiveReplyPrompt } from "../../../src/shared/contracts/qq";
import type { QqPendingReview } from "./qq-reply-runner";
import type { QqReviewResult } from "./qq-review-runner";

export type QqRecomputeResult =
  | { readonly kind: "blocked"; readonly reason: string }
  | {
      readonly kind:
        | "review_required"
        | "recompute_budget"
        | "model_error"
        | "capacity_unavailable"
        | "capacity_exceeded";
    }
  | { readonly kind: "draft"; readonly draft: QqPendingReview };

/** Only an explicit P3h recompute_needed verdict may start a single model call. */
export async function recomputeQqReply(
  orm: Orm,
  gateway: Pick<ModelGateway, "complete" | "loadedContextCapacity">,
  pending: QqPendingReview,
  verdict: Extract<QqReviewResult, { kind: "recompute_needed" }>,
  nowSeconds: number,
  agentRuntime?: LeafAgentRuntime,
): Promise<QqRecomputeResult> {
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0)
    throw new TypeError("Invalid QQ recompute clock");
  if (verdict.used !== pending.recomputesUsed || verdict.eventCount <= pending.memberEventCount)
    return { kind: "blocked", reason: "review_changed" };
  const { snapshot, path, schemeRevision, agentConfigVersion } = pending;
  const binding = readQqBinding(orm, snapshot.bindingId);
  const task = checkQqTask(snapshot, binding, "send", readQqOwnerIdentity(orm));
  if (task.kind === "blocked") return { kind: "blocked", reason: task.reason };
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
  const gate = checkQqSpeechSend({
    kind: path,
    featureEnabled: settings.enabled === 1,
    conversationPaused: binding.paused,
    disabledKinds: disabledKindsFromTriggers(effectiveQqTriggers(binding, scheme)),
  });
  if (gate.kind === "blocked") return { kind: "blocked", reason: gate.reason };
  const budget = qqRecomputeVerdict({
    used: pending.recomputesUsed,
    maxRecomputeCount: schemeRhythm(scheme).max_recompute_count,
  });
  if (budget.kind === "blocked") return { kind: "recompute_budget" };
  const scope: QqConversationScope = {
    kind: "qq",
    accountId: binding.accountId,
    conversationKind: binding.kind,
    peerId: binding.peerId,
    agentId: binding.agentId,
  };
  const eventCount = qqMemberEventCount(orm, scope);
  if (eventCount !== verdict.eventCount) return { kind: "review_required" };
  const limits = qqContextLimits(schemeContext(scheme), "reply");
  const sinceSeconds = Math.max(0, nowSeconds - limits.windowMinutes * 60 - 1);
  const timeline = qqBuildTimeline({
    messages: conversationMessagesSince(orm, scope, {
      sinceSeconds,
      limit: limits.messageLimit,
      includeSources: true,
    }).map(({ eventKey: _eventKey, ...message }) => message),
    ownSpeech: ownSpeechSince(orm, scope, {
      sinceSeconds,
      limit: limits.messageLimit,
      includeSources: true,
    }),
  });
  const selection = qqSelectContext({ timeline, limits, nowSeconds });
  if (qqMemberEventCount(orm, scope) !== eventCount) return { kind: "review_required" };
  const runtime = runtimeFromAgent(agent);
  const promptInput: QqPromptInput = {
    tier: "reply",
    path,
    persona: compileSystemPrompt(runtime),
    prompts: {
      ...schemePrompts(scheme),
      reply: qqEffectiveReplyPrompt(
        schemePrompts(scheme).reply,
        schemeReply(scheme).split_by_speaker,
      ),
    },
    timeline: selection.messages,
    nowSeconds,
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
    ...(pending.targetSpeakerId === null
      ? {}
      : {
          replyingTo: {
            speakerId: pending.targetSpeakerId,
            label: qqSpeakerLabel(
              pending.targetSpeakerId,
              qqMemberLabels(
                orm,
                {
                  accountId: scope.accountId,
                  conversationKind: scope.conversationKind,
                  peerId: scope.peerId,
                },
                new Date(nowSeconds * 1000).toISOString(),
              ),
            ),
          },
        }),
  };
  // 记忆与回复档同一套（读取强度决定怎么筛、最多给多少）。
  const base = await checkQqModelCapacity(gateway, {
    model: runtime.model_name,
    messages: qqPromptMessages(buildQqPrompt(promptInput)).map(({ role, content }) => ({
      role,
      content,
    })),
    outputReserved: schemeOutputReserve(scheme).reply_output_reserved,
  });
  if (base.kind !== "allowed")
    return { kind: base.kind === "unavailable" ? "capacity_unavailable" : "capacity_exceeded" };
  let memory: Awaited<ReturnType<typeof recallQqReplyMemory>>;
  try {
    memory = await recallQqReplyMemory(orm, gateway, {
      agentRuntime,
      sources: selection.messages.flatMap((message) => message.sources ?? []),
      runtime,
      snapshot,
      question: qqJudgementQuestion(selection.messages.map((message) => message.text)),
      available:
        base.capacity - base.inputUnits - schemeOutputReserve(scheme).reply_output_reserved,
    });
  } catch {
    return { kind: "blocked", reason: "memory_unavailable" };
  }
  const sections = buildQqPrompt({ ...promptInput, material: memory.material });
  const messages = qqPromptMessages(sections).map(({ role, content }) => ({ role, content }));
  const capacity =
    memory.material.length === 0
      ? base
      : await checkQqModelCapacity(gateway, {
          model: runtime.model_name,
          messages,
          outputReserved: schemeOutputReserve(scheme).reply_output_reserved,
        });
  if (capacity.kind !== "allowed")
    return { kind: capacity.kind === "unavailable" ? "capacity_unavailable" : "capacity_exceeded" };
  if (
    readQqScheme(orm, scheme.id)?.revision !== schemeRevision ||
    qqMemberEventCount(orm, scope) !== eventCount
  )
    return { kind: "review_required" };
  const current = checkQqTask(
    snapshot,
    readQqBinding(orm, snapshot.bindingId),
    "send",
    readQqOwnerIdentity(orm),
  );
  if (current.kind === "blocked") return { kind: "blocked", reason: current.reason };
  let text: string;
  try {
    if (memory.read && !qqMemoryReadIsCurrent(orm, binding.agentId, memory.read))
      return { kind: "blocked", reason: "memory_changed" };
    text = await gateway.complete({
      model: runtime.model_name,
      messages,
    });
    if (memory.read && !qqMemoryReadIsCurrent(orm, binding.agentId, memory.read))
      return { kind: "blocked", reason: "memory_changed" };
  } catch {
    return { kind: "model_error" };
  }
  const currentBinding = readQqBinding(orm, snapshot.bindingId);
  const after = checkQqTask(snapshot, currentBinding, "send", readQqOwnerIdentity(orm));
  if (after.kind === "blocked") return { kind: "blocked", reason: after.reason };
  if (!currentBinding || currentBinding.schemeId !== snapshot.schemeId)
    return { kind: "blocked", reason: "binding_changed" };
  const currentSettings = readQqSettings(orm);
  if (currentSettings.accountId !== binding.accountId)
    return { kind: "blocked", reason: "account_mismatch" };
  const currentScheme = readQqScheme(orm, scheme.id);
  if (!currentScheme || currentScheme.revision !== schemeRevision)
    return { kind: "blocked", reason: "scheme_changed" };
  const currentAgent = getAgentRow(orm, agent.id);
  if (currentAgent?.isActive !== 1 || currentAgent.configVersion !== agentConfigVersion)
    return { kind: "blocked", reason: "agent_changed" };
  const currentGate = checkQqSpeechSend({
    kind: path,
    featureEnabled: currentSettings.enabled === 1,
    conversationPaused: currentBinding.paused,
    disabledKinds: disabledKindsFromTriggers(effectiveQqTriggers(currentBinding, currentScheme)),
  });
  if (currentGate.kind === "blocked") return { kind: "blocked", reason: currentGate.reason };
  if (qqMemberEventCount(orm, scope) !== eventCount) return { kind: "review_required" };
  // As in P3f: a regenerated sentence may come back blank, and whether that leaves anything to
  // send is decided by the assembled output, not here (§8.1-2, P4i).
  const replyText = typeof text === "string" && text.trim() !== "" ? text : null;
  return {
    kind: "draft",
    draft: {
      text: replyText,
      snapshot,
      schemeRevision,
      agentConfigVersion,
      path,
      nowSeconds,
      memberEventCount: eventCount,
      recomputesUsed: pending.recomputesUsed + 1,
      selection,
      stickerId: undefined,
      // 0037：重算出来的还是回给同一个人。
      targetSpeakerId: pending.targetSpeakerId,
      memoryRead: memory.read,
    },
  };
}
