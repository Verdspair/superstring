// P3 durable QQ dispatch: the scheduler that decides *when* a classified initiative runs.
//
// The user's decisions on 2026-09-24 (see TEMP_PLAN_0.3.0 §13 / ADR0018):
//   * conservative event-driven classification - only a real inbound event may start a
//     non-idle path, and a plain group message is only a *candidate* for chiming in;
//   * one global QQ model task at a time; each conversation keeps only its latest candidate;
//   * a lapsed lease is scrapped and re-judged from current facts, never resumed;
//   * the lease is editable (default 120 s, 30-600 s) and renewed about every quarter.
//
// This module schedules and guards. It does not compose prompts, call a model or touch a
// transport, and `authorized` from the commit guard is still not permission to send.

import { z } from "zod";
import type { QqIdleSweepSkipReason } from "../../shared/contracts/qq";
import { readQqBinding, readQqBindings } from "../db/qq-binding-repository";
import {
  claimQqDispatchLease,
  claimQqImmediateLease,
  commitQqDispatchTask,
  forgetQqIdleJudgementsExcept,
  listQqDispatchCandidates,
  newQqDispatchToken,
  type QqDispatchCommit,
  type QqSweepVerdictInput,
  qqDispatchLeaseIsHeld,
  readQqDispatchCandidate,
  readQqDispatchLease,
  readQqDispatchSettings,
  readQqIdleJudgement,
  reapExpiredQqDispatchLease,
  recordQqSweepVerdicts,
  renewQqDispatchLease,
  upsertQqDispatchCandidate,
} from "../db/qq-dispatch-repository";
import { newestMemberEventFor } from "../db/qq-observation-intake";
import type { QqConversationScope } from "../db/qq-observation-repository";
import { effectiveQqTriggers, readQqScheme, schemeRhythm } from "../db/qq-scheme-repository";
import { readQqSends } from "../db/qq-send-repository";
import { readQqSettings } from "../db/qq-settings-repository";
import {
  lastQqInitiativeSeconds,
  lastQqSpeech,
  newestMemberMessageSeconds,
  qqInitiativeSpeechesInWindow,
} from "../db/qq-speech-repository";
import type { Orm } from "../db/repositories";
import { getAgentRow } from "../db/repositories";
import { type QqBinding, qqConversationKey } from "./qq-binding-contract";
import { checkQqInitiativeRhythm } from "./qq-rhythm-contract";
import { checkQqSpeechTrigger, disabledKindsFromTriggers } from "./qq-speaking-contract";
import { classifyQqTrigger } from "./qq-trigger-contract";

export interface QqDispatchEventInput {
  bindingId: string;
  conversationKind: "group" | "private";
  speaker: "member" | "anonymous" | "system";
  /** The speaker's stable id, when the delivery carried one — the attention list matches on it. */
  speakerId?: string | null;
  mentionsSelf: boolean;
  followsAssistant?: boolean;
  /**
   * A separately verified timer candidate (the quiet-room sweep). Only an independently
   * verified scheduler may set it; an inbound message must never fabricate one.
   */
  initiativePath?: "chiming_in" | "idle_topic";
  eventKey?: string | null;
  observedAtSeconds: number;
  nowSeconds: number;
  /** The scheme's merge window, passed in so this module stays free of scheme reading. */
  mergeWindowSeconds: number;
}

export type QqDispatchScheduled = {
  readonly kind: "scheduled";
  readonly conversationKey: string;
  readonly path: "chiming_in" | "idle_topic";
  readonly generation: number;
  readonly readyAtSeconds: number;
};

/**
 * Who may trigger anything in this conversation (0031's hard mode), or `null` for "no narrowing".
 *
 * `soft` returns `null` on purpose: it is a hint to the model, not a gate — the context marks the
 * listed speakers and every threshold stays exactly where it was. `hard` narrows the triggers
 * themselves, which is why the same list also feeds the two "did a real partner speak?" queries:
 * under it, a message from anyone else is still recorded and organised, but it can never make the
 * assistant speak, and it does not wind the quiet-room clock either.
 */
export function attentionTriggerFilter(binding: QqBinding): readonly string[] | null {
  return binding.attention.mode === "hard" ? binding.attention.members : null;
}

export type QqDispatchEnqueueResult =
  | QqDispatchScheduled
  | { readonly kind: "not_scheduled"; readonly reason: string };

/**
 * Classify one inbound event and, when it is an initiative, write the conversation's latest
 * candidate. A direct `@` returns `handled_directly`: it must not wait behind other
 * conversations, so it stays on the immediate reply path rather than entering this queue.
 */
export function enqueueQqDispatchFromEvent(
  orm: Orm,
  input: QqDispatchEventInput,
): QqDispatchEnqueueResult {
  const parsed = z
    .strictObject({
      bindingId: z.uuid(),
      conversationKind: z.enum(["group", "private"]),
      speaker: z.enum(["member", "anonymous", "system"]),
      speakerId: z.string().trim().min(1).nullable().optional(),
      mentionsSelf: z.boolean(),
      followsAssistant: z.boolean().optional(),
      initiativePath: z.enum(["chiming_in", "idle_topic"]).optional(),
      eventKey: z.string().trim().min(1).nullable().optional(),
      observedAtSeconds: z.number().int().nonnegative(),
      nowSeconds: z.number().int().nonnegative(),
      mergeWindowSeconds: z.number().int().min(0).max(300),
    })
    .safeParse(input);
  if (!parsed.success) throw new TypeError("Invalid QQ dispatch event input");
  const value = parsed.data;
  const classification = classifyQqTrigger({
    conversationKind: value.conversationKind,
    speaker: value.speaker,
    mentionsSelf: value.mentionsSelf,
    ...(value.followsAssistant === undefined ? {} : { followsAssistant: value.followsAssistant }),
    ...(value.initiativePath === undefined ? {} : { initiativePath: value.initiativePath }),
  });
  if (classification.kind === "ignored") return { kind: "not_scheduled", reason: "system_message" };
  if (classification.kind === "pending") return { kind: "not_scheduled", reason: "not_classified" };
  if (classification.kind === "classified") {
    if (classification.path === "direct_reply") {
      return { kind: "not_scheduled", reason: "handled_directly" };
    }
    // `follow_up` needs the assistant-involvement observation the reply chain does not
    // produce yet; queueing it would leave rows nothing can run.
    if (classification.path === "follow_up")
      return { kind: "not_scheduled", reason: "follow_up_unwired" };
  }
  const path = classification.kind === "candidate" ? "chiming_in" : classification.path;
  if (path !== "chiming_in" && path !== "idle_topic") {
    return { kind: "not_scheduled", reason: "path_not_scheduled" };
  }
  const binding = readQqBinding(orm, value.bindingId);
  if (!binding) return { kind: "not_scheduled", reason: "binding_missing" };
  // 0031's hard mode: a message from outside the attention list never becomes a candidate. The
  // direct-@ case returned above as `handled_directly`; its own gate is the immediate path, which
  // re-reads the facts (including this same list) when it looks for something to answer.
  const narrowed = attentionTriggerFilter(binding);
  if (narrowed !== null && (value.speakerId == null || !narrowed.includes(value.speakerId))) {
    return { kind: "not_scheduled", reason: "attention_filtered" };
  }
  const conversationKey = qqConversationKey({
    accountId: binding.accountId,
    kind: binding.kind,
    peerId: binding.peerId,
  });
  const candidate = upsertQqDispatchCandidate(orm, {
    conversationKey,
    bindingId: value.bindingId,
    eventKey: value.eventKey ?? null,
    path,
    readyAtSeconds: value.nowSeconds + value.mergeWindowSeconds,
    observedAtSeconds: value.observedAtSeconds,
  });
  return {
    kind: "scheduled",
    conversationKey,
    path,
    generation: candidate.generation,
    readyAtSeconds: candidate.readyAtSeconds,
  };
}

/**
 * How long a message stays worth answering (P5s).
 *
 * The plan's "可配置等待有效期" is still undecided, so this is a fixed number in ONE place: it
 * bounds how late a direct reply or a continuation can be, which matters because the global
 * one-chain rule can make a message wait for whatever is already running. Ten minutes is the same
 * order as the media supplement window, and it is recorded as pending a user decision.
 */
export const QQ_IMMEDIATE_REPLY_FRESHNESS_SECONDS = 600;

export interface QqImmediateReplyTask {
  readonly token: string;
  readonly bindingId: string;
  readonly conversationKey: string;
  readonly eventKey: string;
  /** Which of the two immediate paths this message belongs to. */
  readonly path: "direct_reply" | "follow_up";
  readonly leaseSeconds: number;
}

/**
 * The next message that deserves an immediate reply, under the global slot, or `null`.
 *
 * The plan models 直接回应 and 连续交谈 separately from the queued initiatives and keeps them out of
 * the candidate list, because a message aimed at the assistant must not wait behind other
 * conversations' merge windows. They still obey the one-chain rule, so this claims the SAME global
 * lease — and because a claim can fail while another chain runs, the decision is re-derived from
 * storage on every pass rather than remembered in memory: the message is a row, "the assistant
 * already answered it" is a speech row, and "we already tried" is a send attempt.
 *
 * The two paths differ only in the condition that earns them:
 *   * `direct_reply` — addressed to the assistant in a group, or any message in a private chat;
 *   * `follow_up`    — a partner spoke AFTER the assistant's own last utterance here, which is the
 *                      user's definition of 连续交谈 (P3k).
 * A message that is neither is left to the initiative sweep.
 */
export function nextQqImmediateReplyTask(
  orm: Orm,
  input: { nowSeconds: number },
): QqImmediateReplyTask | null {
  const parsed = z.strictObject({ nowSeconds: z.number().int().nonnegative() }).safeParse(input);
  if (!parsed.success) throw new TypeError("Invalid QQ immediate reply input");
  const now = parsed.data.nowSeconds;
  const settings = readQqSettings(orm);
  if (settings.enabled !== 1) return null;

  let best: {
    bindingId: string;
    accountId: string;
    kind: "group" | "private";
    peerId: string;
    eventKey: string;
    occurredAtSeconds: number;
    path: "direct_reply" | "follow_up";
  } | null = null;

  for (const binding of readQqBindings(orm)) {
    if (settings.accountId !== binding.accountId) continue;
    // A paused conversation still observes; it simply does not answer, immediate or otherwise.
    if (binding.paused) continue;
    if (getAgentRow(orm, binding.agentId)?.isActive !== 1) continue;
    const scheme = readQqScheme(orm, binding.schemeId);
    if (!scheme) continue;
    const disabled = disabledKindsFromTriggers(effectiveQqTriggers(binding, scheme));
    const scope: QqConversationScope = {
      kind: "qq",
      accountId: binding.accountId,
      conversationKind: binding.kind,
      peerId: binding.peerId,
      agentId: binding.agentId,
    };
    const newest = newestMemberEventFor(orm, scope, {
      attentionMembers: attentionTriggerFilter(binding) ?? undefined,
    });
    if (!newest) continue;
    const lastSpeech = lastQqSpeech(orm, scope)?.spokeAtSeconds ?? null;
    // A failed or unknown attempt is NOT retried for the same message (§8.2: do not resend
    // immediately); whether it consumes the no-reply slot is U13, so the next NEW message is what
    // earns the next reply. Checked per candidate below, not against the newest message only.
    const lastAttempt = readQqSends(orm, scope, 1)[0]?.sentAtSeconds ?? null;
    const behindUs = (at: number): boolean =>
      (lastSpeech !== null && at <= lastSpeech) || (lastAttempt !== null && at <= lastAttempt);
    const fresh = (at: number): boolean => now - at <= QQ_IMMEDIATE_REPLY_FRESHNESS_SECONDS;
    // 被叫到的那一条**可能不是最新一条**（2026-09-25 修）：@ 之后、她开口之前只要有人又说了话，这条 @
    // 就不再是"最新消息"，而它仍然欠着一次回应。私聊里最新那条就是被叫到的那条，没有这个问题。
    const addressed =
      binding.kind === "private"
        ? newest
        : newestMemberEventFor(orm, scope, {
            attentionMembers: attentionTriggerFilter(binding) ?? undefined,
            addressedOnly: true,
          });
    // 被叫到先答：两条候选里先取"有人叫她"的那条，其次才是"她说过话之后群里又有人开口"。
    let candidate: {
      eventKey: string;
      occurredAtSeconds: number;
      path: "direct_reply" | "follow_up";
    } | null = null;
    if (
      addressed !== null &&
      (binding.kind === "private" || addressed.addressed) &&
      !behindUs(addressed.occurredAtSeconds) &&
      fresh(addressed.occurredAtSeconds)
    ) {
      candidate = { ...addressed, path: "direct_reply" };
    } else if (
      !newest.addressed &&
      lastSpeech !== null &&
      newest.occurredAtSeconds > lastSpeech &&
      !behindUs(newest.occurredAtSeconds) &&
      fresh(newest.occurredAtSeconds)
    ) {
      candidate = { ...newest, path: "follow_up" };
    }
    if (candidate === null) continue;
    // The trigger switch for that kind is a real switch, not a label (§F05).
    if (disabled.includes(candidate.path)) continue;
    if (best === null || candidate.occurredAtSeconds > best.occurredAtSeconds) {
      best = {
        bindingId: binding.id,
        accountId: binding.accountId,
        kind: binding.kind,
        peerId: binding.peerId,
        eventKey: candidate.eventKey,
        occurredAtSeconds: candidate.occurredAtSeconds,
        path: candidate.path,
      };
    }
  }
  if (best === null) return null;

  const conversationKey = qqConversationKey({
    accountId: best.accountId,
    kind: best.kind,
    peerId: best.peerId,
  });
  const token = newQqDispatchToken();
  const leaseSeconds = readQqDispatchSettings(orm).leaseSeconds;
  const claimed = claimQqImmediateLease(orm, {
    token,
    conversationKey,
    nowSeconds: now,
    leaseSeconds,
  });
  // Someone else holds the slot: leave the message to the next pass rather than queueing it.
  if (!claimed) return null;
  return Object.freeze({
    token,
    bindingId: best.bindingId,
    conversationKey,
    eventKey: best.eventKey,
    path: best.path,
    leaseSeconds,
  });
}

export interface QqDispatchTask {
  readonly token: string;
  readonly conversationKey: string;
  readonly bindingId: string;
  readonly path: "chiming_in" | "idle_topic";
  readonly generation: number;
  readonly leaseSeconds: number;
}

/**
 * The next task this process may run, or `null`.
 *
 * A lapsed lease is reaped first (the plan scraps it and re-judges later). Only one global
 * task exists at a time: while another live owner holds the lease this returns `null`, and
 * every candidate whose `ready_at` has not arrived is left for a later call.
 */
export function nextQqDispatchTask(orm: Orm, nowSeconds: number): QqDispatchTask | null {
  reapExpiredQqDispatchLease(orm, nowSeconds);
  const settings = readQqDispatchSettings(orm);
  if (qqDispatchLeaseIsHeld(readQqDispatchLease(orm), nowSeconds)) return null;
  for (const candidate of listQqDispatchCandidates(orm)) {
    if (candidate.readyAtSeconds > nowSeconds) continue;
    if (candidate.path !== "chiming_in" && candidate.path !== "idle_topic") continue;
    const token = newQqDispatchToken();
    const claimed = claimQqDispatchLease(orm, {
      token,
      conversationKey: candidate.conversationKey,
      generation: candidate.generation,
      nowSeconds,
      leaseSeconds: settings.leaseSeconds,
    });
    if (!claimed) continue;
    return {
      token,
      conversationKey: candidate.conversationKey,
      bindingId: candidate.bindingId,
      path: candidate.path,
      generation: candidate.generation,
      leaseSeconds: settings.leaseSeconds,
    };
  }
  return null;
}

/** Extend the caller's own lease while a long model call is still running. */
export function renewQqDispatchTask(
  orm: Orm,
  input: { token: string; nowSeconds: number },
): boolean {
  const settings = readQqDispatchSettings(orm);
  return renewQqDispatchLease(orm, {
    token: input.token,
    nowSeconds: input.nowSeconds,
    leaseSeconds: settings.leaseSeconds,
  });
}

/**
 * Atomic submit-time guard. `recheck` is the caller's live-fact probe (for example the send
 * preflight) and runs inside the same write transaction as the lease and generation checks,
 * so nothing can change the conversation between "still valid" and "consumed".
 */
export function finishQqDispatchTask(
  orm: Orm,
  input: { token: string; conversationKey: string; generation: number; nowSeconds: number },
  recheck: () =>
    | { kind: "checks_passed" }
    | { kind: "blocked"; reason: string }
    | { kind: "review_required" },
): QqDispatchCommit {
  return commitQqDispatchTask(orm, input, recheck);
}

/**
 * Read-only view for tests and diagnostics: whether a conversation currently has a candidate
 * and whether the global slot is taken.
 */
export function qqDispatchQueueState(orm: Orm, conversationKey: string, nowSeconds: number) {
  const candidate = readQqDispatchCandidate(orm, conversationKey);
  const lease = readQqDispatchLease(orm);
  return {
    hasCandidate: candidate !== null,
    generation: candidate?.generation ?? null,
    readyAtSeconds: candidate?.readyAtSeconds ?? null,
    leaseHeld: qqDispatchLeaseIsHeld(lease, nowSeconds),
    leaseConversationKey: lease.conversationKey,
  };
}

/**
 * Why a conversation produced no idle-topic candidate: `QqIdleSweepSkipReason` in the shared
 * contract, because the settings surface now SHOWS these reasons rather than only logging a count.
 *
 * Reported rather than silently dropped: the plan requires the settings surface to explain a
 * refusal (a user who switched the switch on and sees nothing happen is owed the reason), and
 * a scheduler that returns nothing at all cannot be told apart from one that is broken.
 * Since 0030 each verdict is also written down per conversation, so the reason survives the pass
 * that computed it instead of dying with the process (see `recordQqSweepVerdicts`).
 */
export interface QqIdleSweepInput {
  nowSeconds: number;
}

export interface QqIdleSweep {
  readonly scheduled: readonly QqDispatchScheduled[];
  readonly skipped: readonly { conversationKey: string; reason: QqIdleSweepSkipReason }[];
}

/**
 * The quiet-room sweep: offer each silent conversation an `idle_topic` candidate.
 *
 * This is the timer side of the conservative event-driven decision. A room counts as quiet
 * only when a real partner spoke and then stopped — "how quiet is quiet" is the scheme's
 * `idle_quiet_minutes`, and the user decided on 2026-09-24 that a conversation where nobody
 * has ever spoken is NOT quiet: the assistant's own speech and the binding's age are not
 * baselines either, so a newly bound group is left alone until someone actually talks.
 *
 * Every reason a conversation is skipped is the same set of gates the judgement itself will
 * re-apply, evaluated here so the queue is not filled with work that is already known to be
 * refused. Both checks are needed and they are not redundant: the trigger gate owns the
 * no-reply rule ("an initiative that got no reply is not followed by another one"), the
 * rhythm gate owns cooldown, hourly cap, active hours and the quiet window itself.
 *
 * The sweep takes only a clock. The allowed-hours gate derives the minute of the local day from
 * that same clock inside `checkQqInitiativeRhythm`, and there is exactly one such derivation in
 * the project on purpose — a second parameter for it here would be a second source of truth.
 *
 * A conversation that already holds a candidate is skipped instead of re-enqueued. Enqueueing
 * would bump `generation` on every sweep, which both invalidates whatever is in flight and
 * pushes `ready_at` forward for ever — the sweep would starve the very task it kept creating.
 */
export function sweepQqIdleTopics(orm: Orm, input: QqIdleSweepInput): QqIdleSweep {
  const parsed = z.strictObject({ nowSeconds: z.number().int().nonnegative() }).safeParse(input);
  if (!parsed.success) throw new TypeError("Invalid QQ idle sweep input");
  const value = parsed.data;
  const settings = readQqSettings(orm);
  const scheduled: QqDispatchScheduled[] = [];
  const skipped: { conversationKey: string; reason: QqIdleSweepSkipReason }[] = [];
  // The same decisions, in the shape the diagnostics surface stores: identity for a label, the
  // verbatim reason, and what the decision was looking at when it stopped.
  const verdicts: QqSweepVerdictInput[] = [];
  for (const binding of readQqBindings(orm)) {
    const conversationKey = qqConversationKey({
      accountId: binding.accountId,
      kind: binding.kind,
      peerId: binding.peerId,
    });
    const skip = (
      reason: QqIdleSweepSkipReason,
      observedAtSeconds: number | null = null,
      readyAtSeconds: number | null = null,
    ) => {
      skipped.push({ conversationKey, reason });
      verdicts.push({
        conversationKey,
        kind: binding.kind,
        peerId: binding.peerId,
        outcome: "skipped",
        reason,
        observedAtSeconds,
        readyAtSeconds,
      });
    };
    if (settings.enabled !== 1) {
      skip("feature_off");
      continue;
    }
    if (settings.accountId !== binding.accountId) {
      // A binding for a different account than the configured one is not this runtime's to act on.
      skip("feature_off");
      continue;
    }
    if (binding.paused) {
      skip("conversation_paused");
      continue;
    }
    const scheme = readQqScheme(orm, binding.schemeId);
    if (!scheme) {
      skip("trigger_off");
      continue;
    }
    const scope: QqConversationScope = {
      kind: "qq",
      accountId: binding.accountId,
      conversationKind: binding.kind,
      peerId: binding.peerId,
      agentId: binding.agentId,
    };
    const newest = newestMemberMessageSeconds(orm, scope, {
      attentionMembers: attentionTriggerFilter(binding) ?? undefined,
    });
    if (newest === null) {
      skip("no_member_baseline");
      continue;
    }
    const trigger = checkQqSpeechTrigger({
      kind: "idle_topic",
      featureEnabled: settings.enabled === 1,
      conversationPaused: binding.paused,
      disabledKinds: disabledKindsFromTriggers(effectiveQqTriggers(binding, scheme)),
      lastInitiativeSeconds: lastQqInitiativeSeconds(orm, scope),
      newestMemberMessageSeconds: newest,
    });
    if (trigger.kind === "blocked") {
      skip(trigger.reason, newest);
      continue;
    }
    // 0033: "it decided not to speak" is a conclusion about THIS quiet episode, and one judgement is
    // enough. Without this the timed sweep re-judged the same basis every pass — a model call each
    // time, forever — because a silent outcome leaves no speech record and no candidate behind.
    const judged = readQqIdleJudgement(orm, conversationKey);
    if (judged !== null && judged.basisSeconds >= newest) {
      skip("already_judged", newest);
      continue;
    }
    const rhythm = checkQqInitiativeRhythm({
      kind: "idle_topic",
      rhythm: schemeRhythm(scheme),
      nowSeconds: value.nowSeconds,
      lastSpeechSeconds: lastQqSpeech(orm, scope)?.spokeAtSeconds ?? null,
      speechesThisHour: qqInitiativeSpeechesInWindow(orm, scope, { nowSeconds: value.nowSeconds }),
      newestMemberMessageSeconds: newest,
    });
    if (rhythm.kind === "blocked") {
      skip(rhythm.reason, newest, rhythm.readyAtSeconds);
      continue;
    }
    if (readQqDispatchCandidate(orm, conversationKey) !== null) {
      skip("candidate_pending", newest);
      continue;
    }
    // Already quiet by the scheme's own number, so the candidate is runnable now: the merge
    // window exists to batch new messages, and there is no new message here.
    const candidate = upsertQqDispatchCandidate(orm, {
      conversationKey,
      bindingId: binding.id,
      eventKey: null,
      path: "idle_topic",
      readyAtSeconds: value.nowSeconds,
      observedAtSeconds: newest,
    });
    scheduled.push({
      kind: "scheduled",
      conversationKey,
      path: "idle_topic",
      generation: candidate.generation,
      readyAtSeconds: candidate.readyAtSeconds,
    });
    verdicts.push({
      conversationKey,
      kind: binding.kind,
      peerId: binding.peerId,
      outcome: "scheduled",
      reason: null,
      observedAtSeconds: newest,
      readyAtSeconds: null,
    });
  }
  // Write the pass down before reporting it. A reason held only in memory cannot answer "why was
  // there no sound from that group" a minute later, which is exactly when the question is asked.
  recordQqSweepVerdicts(orm, { nowSeconds: value.nowSeconds, verdicts });
  // 0033: the judgement memory follows the bindings, exactly like the verdicts — a conversation
  // that is no longer bound must not keep a "judged" note that would silence a future re-bind.
  forgetQqIdleJudgementsExcept(
    orm,
    verdicts.map((verdict) => verdict.conversationKey),
  );
  // 0036 的判断读数随绑定收敛这一步**已撤掉**（用户 2026-09-25 取消判断间隔与复用）：没有代码再读写
  // 那两列，收敛一张永远为空的表只会让人以为它还在起作用。表与列保留在 schema 里，不迁移。
  return { scheduled, skipped };
}
