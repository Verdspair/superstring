import type { LeafAgentRuntime } from "../agent/agent-runtime";
// P3 durable dispatch cycle: run at most one QQ model task, under a persisted lease.
//
// The cycle is the only place where the durable lease meets the P3l composition. It
//   * takes the global slot through `nextQqDispatchTask`,
//   * renews the lease while the model work is still running,
//   * and hands the finished draft to the submit-time guard, which re-checks the live facts
//     and consumes the task in one write transaction.
//
// `authorized` here still means only "this task was current and its facts still stand" — this
// module never decides that a reply MAY go out. What it can do is hand an authorized draft to an
// injected sender (P5o), which is the only place that builds a platform request; with no sender
// wired the draft is dropped exactly as before, which is what every pre-P6 test relies on.

import {
  commitQqImmediateTask,
  qqDispatchRenewSeconds,
  readQqDispatchCandidate,
  recordQqIdleJudgement,
  releaseQqDispatchLease,
  removeQqDispatchCandidate,
} from "../db/qq-dispatch-repository";
import type { QqSendRecord } from "../db/qq-send-repository";
import type { Orm } from "../db/repositories";
import type { ModelGateway } from "../llm/model-gateway";
import {
  finishQqDispatchTask,
  nextQqDispatchTask,
  nextQqImmediateReplyTask,
  type QqDispatchTask,
  renewQqDispatchTask,
} from "./qq-dispatch";
import { type QqRoundDraft, runQqInitiativeCycle, runQqReplyPipeline } from "./qq-initiative-cycle";
import { prepareQqJudgement } from "./qq-judgement-preparation";
import { qqImmediateOpenings } from "./qq-judgement-runner";
import type { QqOutputPlan, QqPlannedOutput } from "./qq-output-plan";
import type { QqPendingReview } from "./qq-reply-runner";
import { checkQqTextPreflight } from "./qq-send-preflight";
import { planQqPreparedReply, type QqStickerStage } from "./qq-sticker-runner";

export interface QqDispatchClock {
  conversationKinds?: readonly ("group" | "private")[];
  nowSeconds: number;
  /** Wall clock used by lease renewals; injectable so tests never depend on timing. */
  clockSeconds?: () => number;
  /** Renewal period in ms; defaults to the lease's renewal interval. */
  renewIntervalMs?: number;
}

export type QqDispatchCycleResult =
  | { readonly kind: "idle" }
  | { readonly kind: "held"; readonly reason: string }
  | { readonly kind: "superseded"; readonly reason: string }
  | { readonly kind: "blocked"; readonly reason: string }
  | {
      readonly kind: "authorized";
      readonly conversationKey: string;
      readonly path: "chiming_in" | "idle_topic";
      readonly renewals: number;
      /**
       * 这一轮每一条消息的投递结果（0037：一轮可能有好几条，每人一条）。`null` 表示这一条没有 sender
       * （P5o：没有接线时草稿被丢弃），数组本身为空表示"一条都没有走到发送"。
       */
      readonly deliveries: readonly (QqSendRecord | null)[];
    };

/**
 * The delivery seam: called with the authorized draft and the plan the preflight judged, and never
 * called with anything else. Injected rather than imported so "this build cannot send" stays a
 * visible wiring decision instead of a hidden default.
 */
export type QqImmediateCycleResult =
  | { readonly kind: "idle" }
  | { readonly kind: "held"; readonly reason: string }
  | {
      readonly kind: "authorized";
      readonly path: "direct_reply" | "follow_up";
      readonly renewals: number;
      /** 被叫到这一轮只有一条消息，但形状与排队路径一致（P5o）。 */
      readonly deliveries: readonly (QqSendRecord | null)[];
    };

/**
 * One immediate turn: answer the newest message that deserves it, under the same global slot.
 *
 * This is 直接回应 and 连续交谈 (P5s). It is a separate cycle from the queued one on purpose: a
 * message aimed at the assistant must not wait for another conversation's merge window, so the
 * task is not a candidate — but it runs under the same one-at-a-time rule, which is why the
 * decision is re-derived from storage and the slot is claimed here rather than in the finder.
 */
export async function runQqImmediateReplyCycle(
  orm: Orm,
  gateway: Pick<ModelGateway, "complete" | "loadedContextCapacity">,
  input: QqDispatchClock,
  stage: QqStickerStage,
  sender?: QqReplySender,
  agentRuntime?: LeafAgentRuntime,
): Promise<QqImmediateCycleResult> {
  const now = input.nowSeconds;
  const task = nextQqImmediateReplyTask(orm, { nowSeconds: now }, input.conversationKinds);
  if (!task) return { kind: "idle" };
  const clock = input.clockSeconds ?? (() => Math.floor(Date.now() / 1000));
  const intervalMs = input.renewIntervalMs ?? qqDispatchRenewSeconds(task.leaseSeconds) * 1000;
  let renewals = 0;
  const timer = setInterval(() => {
    try {
      if (renewQqDispatchTask(orm, { token: task.token, nowSeconds: clock() })) renewals += 1;
    } catch {
      // The submit guard re-verifies the lease and reports `superseded`; a failed renewal is not
      // fatal here for the same reason it is not on the queued path.
    }
  }, intervalMs);
  (timer as unknown as { unref?: () => void }).unref?.();
  try {
    // Being called IS the decision, so the judgement step is the offline preparation and the model
    // chain goes straight to the sentence (§F03: 被叫到时应答). `focusEventKey` is the message that
    // earned this turn — not necessarily the newest one — so the reply goes to the person who called.
    const preparation = prepareQqJudgement(orm, {
      bindingId: task.bindingId,
      path: task.path,
      nowSeconds: now,
      focusEventKey: task.eventKey,
    });
    if (preparation.kind !== "prepared") {
      releaseQqDispatchLease(orm, task.token);
      return {
        kind: "held",
        reason: preparation.kind === "blocked" ? preparation.reason : "not_prepared",
      };
    }
    // 0037: 这一轮回的是谁由预备算出来（叫她的那个人；匿名或冷场时是没有对象的那一条），没有分数。
    const outcome = await runQqReplyPipeline(
      orm,
      gateway,
      { kind: "candidate", prepared: preparation, openings: qqImmediateOpenings(preparation) },
      now,
      stage,
      agentRuntime,
    );
    if (outcome.kind !== "prepared_only" || outcome.drafts.length === 0) {
      releaseQqDispatchLease(orm, task.token);
      return {
        kind: "held",
        reason: outcome.kind === "held" ? outcome.reason : "no_prepared_draft",
      };
    }
    const [draft] = outcome.drafts;
    if (draft === undefined) {
      releaseQqDispatchLease(orm, task.token);
      return { kind: "held", reason: "no_prepared_draft" };
    }
    const prepared = draft.pending;
    // Same discipline as the queued path: the plan that goes out is the one the guard judged.
    let authorizedPlan: QqPlannedOutput | null = null;
    const commit = commitQqImmediateTask(
      orm,
      { token: task.token, conversationKey: task.conversationKey, nowSeconds: clock() },
      () => {
        const verdict = checkQqTextPreflight(orm, prepared, stage);
        if (verdict.kind === "checks_passed") {
          const plan = planQqPreparedReply(orm, prepared, stage);
          authorizedPlan = plan.kind === "planned" ? plan : null;
        }
        return verdict;
      },
    );
    if (commit.kind === "authorized") {
      const delivery =
        sender && authorizedPlan ? await sender({ prepared, plan: authorizedPlan }) : null;
      return { kind: "authorized", path: task.path, renewals, deliveries: [delivery] };
    }
    releaseQqDispatchLease(orm, task.token);
    return { kind: "held", reason: commit.reason };
  } finally {
    clearInterval(timer);
  }
}

export type QqReplySender = (input: {
  readonly prepared: QqPendingReview;
  readonly plan: QqPlannedOutput;
}) => Promise<QqSendRecord | null>;

/**
 * One scheduling turn.
 *
 * Task consumption follows the conservative event-driven decision: whatever the outcome, the
 * conversation's candidate slot is spent and a new turn must be earned by a new real event.
 * Only `superseded` leaves the row alone, because that row already belongs to a newer
 * generation. Failures are therefore not retried in a loop, and U13 (whether a failure counts
 * as "nobody responded") stays undecided.
 */
export async function runQqDispatchCycle(
  orm: Orm,
  gateway: Pick<ModelGateway, "complete" | "loadedContextCapacity">,
  input: QqDispatchClock,
  /** Sticker seams, passed through to the composition and the submit-time guard (P4i). */
  stage: QqStickerStage,
  /** Omitted means "this build cannot deliver": the draft is dropped after the commit (P5o). */
  sender?: QqReplySender,
  agentRuntime?: LeafAgentRuntime,
): Promise<QqDispatchCycleResult> {
  const task: QqDispatchTask | null = nextQqDispatchTask(
    orm,
    input.nowSeconds,
    input.conversationKinds,
  );
  if (!task) return { kind: "idle" };
  // The basis this task judges, read before anything consumes the candidate: a silent outcome is
  // remembered against it so the timed sweep does not judge the same quiet episode again (0033).
  const idleBasisSeconds =
    task.path === "idle_topic"
      ? (readQqDispatchCandidate(orm, task.conversationKey)?.observedAtSeconds ?? null)
      : null;
  const rememberIdleJudgement = (): void => {
    if (idleBasisSeconds === null) return;
    recordQqIdleJudgement(orm, {
      conversationKey: task.conversationKey,
      basisSeconds: idleBasisSeconds,
      nowSeconds: clock(),
    });
  };
  const clock = input.clockSeconds ?? (() => Math.floor(Date.now() / 1000));
  const intervalMs = input.renewIntervalMs ?? qqDispatchRenewSeconds(task.leaseSeconds) * 1000;
  let renewals = 0;
  const timer = setInterval(() => {
    try {
      if (renewQqDispatchTask(orm, { token: task.token, nowSeconds: clock() })) renewals += 1;
    } catch {
      // A failed renewal is not fatal here: the submit guard re-verifies the lease anyway
      // and reports `superseded`, which is the honest outcome for a lost lease.
    }
  }, intervalMs);
  // Never keep a host alive for a heartbeat.
  (timer as unknown as { unref?: () => void }).unref?.();
  try {
    const outcome = await runQqInitiativeCycle(
      orm,
      gateway,
      { bindingId: task.bindingId, path: task.path, nowSeconds: input.nowSeconds },
      stage,
      agentRuntime,
    );
    if (outcome.kind !== "prepared_only" || outcome.drafts.length === 0) {
      // Release first: the lease row references the candidate, so it must stop naming it
      // before the candidate can be dropped. A held task spends its slot — the plan
      // re-judges on the next real event instead of retrying a failed draft.
      releaseQqDispatchLease(orm, task.token);
      removeQqDispatchCandidate(orm, task.conversationKey);
      rememberIdleJudgement();
      return {
        kind: "held",
        reason: outcome.kind === "held" ? outcome.reason : "no_prepared_draft",
      };
    }
    const drafts = outcome.drafts;
    // The plan each preflight judged is captured INSIDE the commit transaction's recheck, so the
    // words and the sticker that go out are the ones the guard actually saw. Recomputing after the
    // commit could pick a different sticker from a library that changed in between.
    //
    // 0037：一轮有好几条（每人一条）。守卫仍然只走一次事务（候选只能被消费一次），但**每一条各自
    // 复核、各自成败**：`review_required` 说明事实变了，整轮作废重来；被判 blocked 的那一条丢掉，
    // 剩下的照发（用户在弹窗里定的"各自独立"）。
    let authorized: readonly { readonly draft: QqRoundDraft; readonly plan: QqPlannedOutput }[] =
      [];
    // `planQqPreparedReply` can also answer `abandoned` (an empty reply); that plan is not a
    // sendable one, and a preflight that passed cannot have produced it — but the type still has
    // to be narrowed instead of asserted.
    const sendable = (plan: QqOutputPlan): QqPlannedOutput | null =>
      plan.kind === "planned" ? plan : null;
    const commit = finishQqDispatchTask(
      orm,
      {
        token: task.token,
        conversationKey: task.conversationKey,
        generation: task.generation,
        nowSeconds: clock(),
      },
      () => {
        const accepted: { draft: QqRoundDraft; plan: QqPlannedOutput }[] = [];
        let stale = false;
        let blockedReason: string | null = null;
        for (const draft of drafts) {
          const verdict = checkQqTextPreflight(orm, draft.pending, stage);
          if (verdict.kind === "review_required") {
            stale = true;
            continue;
          }
          if (verdict.kind === "blocked") {
            blockedReason = blockedReason ?? verdict.reason;
            continue;
          }
          const plan = sendable(planQqPreparedReply(orm, draft.pending, stage));
          if (plan === null) {
            blockedReason = blockedReason ?? "empty_reply";
            continue;
          }
          accepted.push({ draft, plan });
        }
        if (stale) return { kind: "review_required" };
        if (accepted.length === 0)
          return { kind: "blocked", reason: blockedReason ?? "all_blocked" };
        authorized = accepted;
        return { kind: "checks_passed" };
      },
    );
    if (commit.kind === "authorized") {
      // Delivery happens AFTER the guard: the replies were authorized, and this is the only step that
      // turns that into platform requests (§8.2's ledger is written by the sender itself). Each
      // message is delivered on its own: one failure does not stop the others.
      const deliveries: (QqSendRecord | null)[] = [];
      for (const entry of authorized) {
        deliveries.push(
          sender ? await sender({ prepared: entry.draft.pending, plan: entry.plan }) : null,
        );
      }
      return {
        kind: "authorized",
        conversationKey: task.conversationKey,
        path: task.path,
        renewals,
        deliveries,
      };
    }
    if (commit.kind === "blocked") {
      releaseQqDispatchLease(orm, task.token);
      rememberIdleJudgement();
      return { kind: "blocked", reason: commit.reason };
    }
    releaseQqDispatchLease(orm, task.token);
    rememberIdleJudgement();
    return { kind: "superseded", reason: commit.reason };
  } finally {
    clearInterval(timer);
  }
}
