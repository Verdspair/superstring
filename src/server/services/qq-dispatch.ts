// Quiet-room eligibility and diagnostics. The current conversation adapter owns queue writes.

import { z } from "zod";
import type { QqIdleSweepSkipReason } from "../../shared/contracts/qq";
import { readQqBindings } from "../db/qq-binding-repository";
import {
  forgetQqIdleJudgementsExcept,
  type QqSweepVerdictInput,
  readQqIdleJudgement,
  recordQqSweepVerdicts,
} from "../db/qq-dispatch-repository";
import { readEffectiveQqScheme } from "../db/qq-group-config-repository";
import type { QqConversationScope } from "../db/qq-observation-repository";
import { effectiveQqTriggers, schemeRhythm } from "../db/qq-scheme-repository";
import { readQqSettings } from "../db/qq-settings-repository";
import {
  lastQqInitiativeSeconds,
  lastQqSpeech,
  newestMemberMessageSeconds,
  qqInitiativeSpeechesInWindow,
} from "../db/qq-speech-repository";
import type { Orm } from "../db/repositories";
import { type QqBinding, qqConversationKey } from "./qq-binding-contract";
import { checkQqInitiativeRhythm } from "./qq-rhythm-contract";
import { checkQqSpeechTrigger, disabledKindsFromTriggers } from "./qq-speaking-contract";

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

/** Maximum age of a direct-reply source accepted by the current host. */
export const QQ_IMMEDIATE_REPLY_FRESHNESS_SECONDS = 600;

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
export interface QqDispatchScheduled {
  readonly kind: "scheduled";
  readonly conversationKey: string;
  readonly path: "chiming_in" | "idle_topic";
  readonly generation: number;
  readonly readyAtSeconds: number;
}

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
 * `idle_quiet_minutes`. A conversation where nobody
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
export function sweepQqIdleTopics(
  orm: Orm,
  input: QqIdleSweepInput,
  options: {
    conversationKinds?: readonly ("group" | "private")[];
    hasPending: (binding: QqBinding) => boolean;
    enqueue: (input: {
      binding: QqBinding;
      conversationKey: string;
      nowSeconds: number;
      basisSeconds: number;
    }) => { readonly generation: number; readonly readyAtSeconds: number };
  },
): QqIdleSweep {
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
    if (options?.conversationKinds && !options.conversationKinds.includes(binding.kind)) continue;
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
    const scheme = readEffectiveQqScheme(orm, binding);
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
    if (options.hasPending(binding)) {
      skip("candidate_pending", newest);
      continue;
    }
    // Already quiet by the scheme's own number, so the candidate is runnable now: the merge
    // window exists to batch new messages, and there is no new message here.
    const candidate = options.enqueue({
      binding,
      conversationKey,
      nowSeconds: value.nowSeconds,
      basisSeconds: newest,
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
    readQqBindings(orm).map((binding) =>
      qqConversationKey({
        accountId: binding.accountId,
        kind: binding.kind,
        peerId: binding.peerId,
      }),
    ),
  );
  // 0036 的判断读数随绑定收敛这一步**已撤掉**：没有代码再读写
  // 那两列，收敛一张永远为空的表只会让人以为它还在起作用。表与列保留在 schema 里，不迁移。
  return { scheduled, skipped };
}
