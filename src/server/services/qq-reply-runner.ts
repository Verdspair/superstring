import type { LeafAgentRuntime } from "../agent/agent-runtime";
// Generate the sentence of a reply after an explicit, readable initiative judgement (ADR0018 P3f).
// This is not a sender: no socket, receipt, speech log, or send ledger is touched.
//
// A blank answer is a draft with no text, not a dead end (P4i): §8.1-2 allows a reply that is a
// sticker alone, and only the sticker stage — which runs outside this module, on the draft's own
// context selection — can tell whether that is possible. Whether the reply has anything to say at
// all is decided when the assembled output is read, not here.

import { qqReplyTaskPrompt } from "../../shared/contracts/qq";
import { readQqBinding } from "../db/qq-binding-repository";
import { qqMemberLabels } from "../db/qq-member-repository";
import { memberEventNeedsReview, newestMemberEventFor } from "../db/qq-observation-intake";
import {
  conversationMessagesSince,
  type QqConversationScope,
  qqMemberEventCount,
} from "../db/qq-observation-repository";
import { readQqOwnerIdentity } from "../db/qq-owner-repository";
import {
  effectiveQqTriggers,
  readQqScheme,
  schemeContext,
  schemeOutputReserve,
  schemePrompts,
  schemeReply,
} from "../db/qq-scheme-repository";
import { readQqSettings } from "../db/qq-settings-repository";
import { ownSpeechSince } from "../db/qq-speech-repository";
import { getAgentRow, type Orm } from "../db/repositories";
import type { ModelGateway } from "../llm/model-gateway";
import { captureQqTask, checkQqTask, type QqTaskSnapshot } from "./qq-binding-contract";
import { checkQqModelCapacity } from "./qq-capacity-preflight";
import {
  type QqContextSelection,
  qqBuildTimeline,
  qqContextLimits,
  qqSelectContext,
} from "./qq-context-contract";
import { attentionTriggerFilter } from "./qq-dispatch";
import { qqJudgementQuestion } from "./qq-judgement-material";
import type { QqJudgementRun, QqReplyOpening } from "./qq-judgement-runner";
import {
  type QqMemoryReadSnapshot,
  qqMemoryReadIsCurrent,
  recallQqReplyMemory,
} from "./qq-memory-recall";
import {
  buildQqPrompt,
  type QqPromptInput,
  qqPromptMessages,
  qqSpeakerLabel,
} from "./qq-prompt-contract";
import { checkQqSpeechSend, disabledKindsFromTriggers } from "./qq-speaking-contract";
import { compileSystemPrompt, runtimeFromAgent } from "./runtime-config";

export interface QqPendingReview {
  /** The model's sentence, or null when it wrote nothing (a sticker may still speak, §8.1-2). */
  readonly text: string | null;
  readonly snapshot: QqTaskSnapshot;
  readonly schemeRevision: number;
  readonly agentConfigVersion: number;
  readonly path: "direct_reply" | "follow_up" | "chiming_in" | "idle_topic";
  readonly nowSeconds: number;
  readonly memberEventCount: number;
  readonly recomputesUsed: number;
  /**
   * The context the sentence was written for. The sticker stage reads the same selection, so the
   * picture is chosen for the conversation the words belong to rather than a later one.
   */
  readonly selection: QqContextSelection;
  /**
   * The sticker this reply carries: an id, null for "none chosen", or undefined while the sticker
   * stage has not run for this draft yet (P4i). The stage is the cycle's, not this module's.
   */
  readonly stickerId: string | null | undefined;
  /**
   * 这条消息回给谁（0037）：对方的群友 ID，就是发送时 `@` 的那个号。`null`＝这一轮没有具体的回话
   * 对象（冷场发起往安静的房间里开话题），发送时不加 `@`。
   */
  readonly targetSpeakerId: string | null;
  readonly memoryRead?: QqMemoryReadSnapshot;
}

export type QqReplyDraft =
  | { readonly kind: "blocked"; readonly reason: string }
  | { readonly kind: "model_error" | "capacity_unavailable" | "capacity_exceeded" }
  | { readonly kind: "review_required"; readonly draft: QqPendingReview }
  | {
      readonly kind: "draft";
      readonly text: string | null;
      readonly selection: QqContextSelection;
      /** Kept for the future send-time guard, not a licence to submit. */
      readonly snapshot: QqTaskSnapshot;
      readonly schemeRevision: number;
      readonly agentConfigVersion: number;
      readonly path: "direct_reply" | "follow_up" | "chiming_in" | "idle_topic";
      readonly nowSeconds: number;
      readonly memberEventCount: number;
      readonly recomputesUsed: number;
      /** 这条消息回给谁（0037）；`null`＝没有对象，不加 `@`。 */
      readonly targetSpeakerId: string | null;
      readonly memoryRead?: QqMemoryReadSnapshot;
    };

/**
 * 一个人一条消息（0037）：把模型写的换行并回一句，不改变它的字面内容。
 */
function collapseToSingleLine(text: string): string {
  return text.replace(/\s*\r?\n+\s*/g, " ").trim();
}

function liveCheck(
  orm: Orm,
  snapshot: QqTaskSnapshot,
  schemeId: string,
  path: "direct_reply" | "follow_up" | "chiming_in" | "idle_topic",
) {
  const binding = readQqBinding(orm, snapshot.bindingId);
  const check = checkQqTask(snapshot, binding, "send", readQqOwnerIdentity(orm));
  if (check.kind === "blocked") return check.reason;
  if (!binding || binding.schemeId !== schemeId) return "binding_changed";
  const settings = readQqSettings(orm);
  if (settings.accountId !== binding.accountId) return "account_mismatch";
  const scheme = readQqScheme(orm, schemeId);
  if (!scheme) return "scheme_missing";
  if (getAgentRow(orm, binding.agentId)?.isActive !== 1) return "agent_unavailable";
  const gate = checkQqSpeechSend({
    kind: path,
    featureEnabled: settings.enabled === 1,
    conversationPaused: binding.paused,
    disabledKinds: disabledKindsFromTriggers(effectiveQqTriggers(binding, scheme)),
  });
  return gate.kind === "blocked" ? gate.reason : null;
}

/**
 * Generate the one message that answers ONE opening (0037). Only the candidate returned by
 * runQqJudgement can enter this stage, and only with one of its own openings.
 *
 * 每个目标各自一次调用：这是"不同人的消息分开来跑"的落点——一条消息只回一个人，提示词里也由程序写明
 * "这一轮你回的是谁"，所以"回错人"不是提示词的问题，而是结构上不可能。
 */
export async function generateQqTextReply(
  orm: Orm,
  gateway: Pick<ModelGateway, "complete" | "loadedContextCapacity">,
  judgement: Extract<QqJudgementRun, { kind: "candidate" }>,
  opening: QqReplyOpening,
  nowSeconds: number,
  agentRuntime?: LeafAgentRuntime,
): Promise<QqReplyDraft> {
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0)
    throw new TypeError("Invalid QQ reply clock");
  const prepared = judgement.prepared;
  const { bindingId, agentId, schemeId, path } = prepared;
  // 这条消息回给谁：由这一轮的 opening 决定（0037），不是模型说了算。
  const targetSpeakerId = opening.target?.speakerId ?? null;
  const binding = readQqBinding(orm, bindingId);
  if (
    !binding ||
    binding.agentId !== agentId ||
    binding.schemeId !== schemeId ||
    binding.revision !== prepared.bindingRevision ||
    binding.authorityRevision !== prepared.authorityRevision
  ) {
    return { kind: "blocked", reason: "binding_changed" };
  }
  const owner = readQqOwnerIdentity(orm);
  const captured = captureQqTask(binding, "reply", owner);
  if (captured.kind !== "captured") return { kind: "blocked", reason: captured.reason };
  const snapshot = captured.snapshot;
  const first = liveCheck(orm, snapshot, schemeId, path);
  if (first !== null) return { kind: "blocked", reason: first };
  const scheme = readQqScheme(orm, schemeId);
  if (!scheme || scheme.revision !== prepared.schemeRevision) {
    return { kind: "blocked", reason: "scheme_changed" };
  }
  const agent = getAgentRow(orm, agentId);
  if (agent?.isActive !== 1) return { kind: "blocked", reason: "agent_unavailable" };
  if (agent.configVersion !== prepared.agentConfigVersion) {
    return { kind: "blocked", reason: "agent_changed" };
  }
  const scope: QqConversationScope = {
    kind: "qq",
    accountId: binding.accountId,
    conversationKind: binding.kind,
    peerId: binding.peerId,
    agentId,
  };
  // Capture the event count before generation. A new media-only or same-second message
  // still demands review; a timestamp-only comparison would miss both.
  const memberEventsBefore = qqMemberEventCount(orm, scope);
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
  // The comparison sits after the context read so a held draft can still carry the selection its
  // sticker stage reads (P4i). What makes it a comparison is the captured count, not the position.
  if (memberEventsBefore !== prepared.memberEventCount)
    return {
      kind: "review_required",
      draft: {
        text: null,
        snapshot,
        schemeRevision: prepared.schemeRevision,
        agentConfigVersion: prepared.agentConfigVersion,
        path,
        nowSeconds,
        memberEventCount: prepared.memberEventCount,
        recomputesUsed: 0,
        selection,
        stickerId: undefined,
        targetSpeakerId,
      },
    };
  const runtime = runtimeFromAgent(agent);
  // 回复任务文案由方案开关选（用户 2026-09-25）：开＝按发言人分条的程序文案，关＝程序默认文案。
  // 方案里那一列 prompt_reply 因此不再参与这里（迁移 0035 的说明）。
  const replyPrompts = {
    ...schemePrompts(scheme),
    reply: qqReplyTaskPrompt(schemeReply(scheme).split_by_speaker),
  };
  const labels = qqMemberLabels(
    orm,
    {
      accountId: scope.accountId,
      conversationKind: scope.conversationKind,
      peerId: scope.peerId,
    },
    new Date(nowSeconds * 1000).toISOString(),
  );
  const promptInput: QqPromptInput = {
    tier: "reply",
    path,
    persona: compileSystemPrompt(runtime),
    prompts: replyPrompts,
    timeline: selection.messages,
    nowSeconds,
    labels,
    // 0031: mark the attention list in the timeline — a hint to the model, never a threshold.
    attentionMembers: binding.attention.members,
    // 0037: 由程序写明"这一轮回的是谁"。模型不需要猜，也不需要自己写 @。
    ...(targetSpeakerId === null
      ? {}
      : {
          replyingTo: {
            speakerId: targetSpeakerId,
            label: qqSpeakerLabel(targetSpeakerId, labels),
          },
        }),
  };
  // 记忆按方案的**读取强度**取（用户 2026-09-25 明确：这一项对回复始终有效，不能被固定上限取代）：
  // 先按不含资料的提示词做一次容量预检拿到已用额度，再用剩余额度请记忆读取模型挑相关的几条。
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
  const beforeModel = liveCheck(orm, snapshot, schemeId, path);
  if (beforeModel !== null) return { kind: "blocked", reason: beforeModel };
  if (readQqScheme(orm, schemeId)?.revision !== prepared.schemeRevision)
    return { kind: "blocked", reason: "scheme_changed" };
  if (getAgentRow(orm, agentId)?.configVersion !== prepared.agentConfigVersion)
    return { kind: "blocked", reason: "agent_changed" };
  // 2026-09-25：只有"冲着她的"或"她正在回的那个人"的新消息才值得复核（别人插一句闲话就重写一次
  // 句子，用户嫌慢，也嫌多余）。判据只在这里与发送前预检两处，两个方向必须一致。
  if (
    qqMemberEventCount(orm, scope) !== memberEventsBefore &&
    memberEventNeedsReview({
      newest: newestMemberEventFor(orm, scope, {
        attentionMembers: attentionTriggerFilter(binding) ?? undefined,
      }),
      targetSpeakerId,
    })
  )
    return {
      kind: "review_required",
      draft: {
        text: null,
        snapshot,
        schemeRevision: prepared.schemeRevision,
        agentConfigVersion: prepared.agentConfigVersion,
        path,
        nowSeconds,
        memberEventCount: memberEventsBefore,
        recomputesUsed: 0,
        selection,
        stickerId: undefined,
        targetSpeakerId,
      },
    };
  let text: string;
  try {
    if (memory.read && !qqMemoryReadIsCurrent(orm, agentId, memory.read))
      return { kind: "blocked", reason: "memory_changed" };
    text = await gateway.complete({
      model: runtime.model_name,
      messages,
    });
    if (memory.read && !qqMemoryReadIsCurrent(orm, agentId, memory.read))
      return { kind: "blocked", reason: "memory_changed" };
  } catch {
    return { kind: "model_error" };
  }
  // §8.1-2: a sentence the model declined to write is not yet "nothing to send" — a sticker may
  // still be the whole reply, and only the sticker stage can say so.
  //
  // 0037: 开着「按发言人分开回答」时，换行**不再**是分条信号——一个人一条消息是结构决定的（§8.1 的
  // 按行分段仍然照旧服务于关掉开关的那条路径）。所以这里把模型写的换行并成一句，免得它一条消息里又
  // 拆出几条来。
  const rawText = typeof text === "string" ? text.trim() : "";
  const replyText =
    rawText === ""
      ? null
      : schemeReply(scheme).split_by_speaker
        ? collapseToSingleLine(rawText)
        : text;
  const second = liveCheck(orm, snapshot, schemeId, path);
  if (second !== null) return { kind: "blocked", reason: second };
  if (readQqScheme(orm, schemeId)?.revision !== prepared.schemeRevision) {
    return { kind: "blocked", reason: "scheme_changed" };
  }
  if (getAgentRow(orm, agentId)?.configVersion !== prepared.agentConfigVersion) {
    return { kind: "blocked", reason: "agent_changed" };
  }
  // 2026-09-25：只有"冲着她的"或"她正在回的那个人"的新消息才值得复核（别人插一句闲话就重写一次
  // 句子，用户嫌慢，也嫌多余）。判据只在这里与发送前预检两处，两个方向必须一致。
  if (
    qqMemberEventCount(orm, scope) !== memberEventsBefore &&
    memberEventNeedsReview({
      newest: newestMemberEventFor(orm, scope, {
        attentionMembers: attentionTriggerFilter(binding) ?? undefined,
      }),
      targetSpeakerId,
    })
  )
    return {
      kind: "review_required",
      draft: {
        text: replyText,
        snapshot,
        memoryRead: memory.read,
        schemeRevision: prepared.schemeRevision,
        agentConfigVersion: prepared.agentConfigVersion,
        path,
        nowSeconds,
        memberEventCount: memberEventsBefore,
        recomputesUsed: 0,
        selection,
        stickerId: undefined,
        targetSpeakerId,
      },
    };
  return {
    kind: "draft",
    text: replyText,
    selection,
    snapshot,
    memoryRead: memory.read,
    schemeRevision: prepared.schemeRevision,
    agentConfigVersion: prepared.agentConfigVersion,
    path,
    nowSeconds,
    memberEventCount: memberEventsBefore,
    recomputesUsed: 0,
    targetSpeakerId,
  };
}
