// P3l synthetic-only orchestration of classified initiative: no transport and no submit.
//
// 0037（用户 2026-09-25）：这一轮要回几个人，就各跑一遍回复管线——**每人一次生成、一人一条消息**。
// 「不同人的消息分开来跑」在这里落地：一个 opening（一个发言人，或冷场发起那一个"没有对象"的
// opening）各走一次 生成 → 选图 → 复核/重算 → 预检，彼此独立；一个人写不出来只丢他那一条（各自独立，
// 用户在弹窗里选的），全部写不出来才整轮不发。
//
// P4i adds the sticker stage here rather than inside the reply generator: the pick depends on the
// final sentence, the sentence can still be recomputed, and a pick made against a superseded
// sentence must not silently survive. The loop therefore picks after each (re)generation and
// keeps the pick across a review that changed nothing.
import { z } from "zod";
import { readQqBinding } from "../db/qq-binding-repository";
import type { Orm } from "../db/repositories";
import type { ModelGateway } from "../llm/model-gateway";
import { qqConversationKey } from "./qq-binding-contract";
import { type QqJudgementRun, type QqReplyOpening, runQqJudgement } from "./qq-judgement-runner";
import type { QqOutputPlan } from "./qq-output-plan";
import { recomputeQqReply } from "./qq-recompute-runner";
import { generateQqTextReply, type QqPendingReview } from "./qq-reply-runner";
import { pendingQqReview, reviewQqSupplement } from "./qq-review-runner";
import { checkQqTextPreflight } from "./qq-send-preflight";
import { planQqPreparedReply, type QqStickerStage, selectQqSticker } from "./qq-sticker-runner";

const Input = z.strictObject({
  bindingId: z.uuid(),
  path: z.enum(["direct_reply", "follow_up", "chiming_in", "idle_topic"]),
  nowSeconds: z.number().int().nonnegative(),
});

/** 这一轮里**一条**准备好的消息：回给谁、写了什么、装配出来的计划是什么。 */
export interface QqRoundDraft {
  readonly opening: QqReplyOpening;
  readonly pending: QqPendingReview;
  readonly plan: QqOutputPlan;
}

export type QqInitiativeCycle =
  | { readonly kind: "held"; readonly reason: string }
  | {
      readonly kind: "prepared_only";
      readonly recomputesUsed: number;
      /** 至少一条（一个人都没有就是 held）。顺序与这一轮的目标顺序一致。 */
      readonly drafts: readonly QqRoundDraft[];
    };

// Local single-flight prevents duplicate model work in this process only. It is not a
// persisted lease, does not survive restarts, and cannot protect a platform send.
const active = new WeakMap<Orm, Set<string>>();

/** Composition only. Even prepared_only is never a send instruction. */
export async function runQqInitiativeCycle(
  orm: Orm,
  gateway: Pick<ModelGateway, "complete" | "loadedContextCapacity">,
  input: unknown,
  /**
   * The sticker seams (`counts` — U13 — and the copy store's availability). Required: a default
   * would answer U13 and silently skip §8.1-5.
   */
  stage: QqStickerStage,
): Promise<QqInitiativeCycle> {
  const parsed = Input.safeParse(input);
  if (!parsed.success) throw new TypeError("Invalid QQ initiative cycle input");
  const { nowSeconds } = parsed.data;
  const binding = readQqBinding(orm, parsed.data.bindingId);
  if (!binding) return { kind: "held", reason: "binding_missing" };
  const key = qqConversationKey({
    accountId: binding.accountId,
    kind: binding.kind,
    peerId: binding.peerId,
  });
  const entries = active.get(orm) ?? new Set<string>();
  if (entries.has(key)) return { kind: "held", reason: "conversation_busy" };
  entries.add(key);
  active.set(orm, entries);
  try {
    const judgement = await runQqJudgement(orm, gateway, parsed.data);
    if (judgement.kind !== "candidate")
      return {
        kind: "held",
        reason: judgement.kind === "blocked" ? judgement.reason : judgement.kind,
      };
    return await runQqReplyPipeline(orm, gateway, judgement, nowSeconds, stage);
  } finally {
    entries.delete(key);
  }
}

/**
 * The reply half, from an already-decided candidate: per opening, draft → sticker → review →
 * bounded recompute → preflight. Split out so the immediate paths (直接回应 / 连续交谈, P5s) run the
 * SAME chain as a queued initiative — the only difference between them is how the openings were
 * obtained: one judgement per person for an initiative, an offline preparation for a message aimed
 * at the assistant (being called is the decision).
 *
 * 「各自独立」：一个 opening 写不出来（模型报错、容量不够、闸门拦住、被复核判死）只丢它那一条，并写
 * 一行服务端日志；全部写不出来才返回 held。
 */
export async function runQqReplyPipeline(
  orm: Orm,
  gateway: Pick<ModelGateway, "complete" | "loadedContextCapacity">,
  judgement: Extract<QqJudgementRun, { kind: "candidate" }>,
  nowSeconds: number,
  stage: QqStickerStage,
): Promise<QqInitiativeCycle> {
  const drafts: QqRoundDraft[] = [];
  let failure: string | null = null;
  let recomputesUsed = 0;
  for (const opening of judgement.openings) {
    const one = await prepareOneReply(orm, gateway, judgement, opening, nowSeconds, stage);
    if (one.kind === "held") {
      failure = one.reason;
      console.warn(
        `[qq-reply] ${judgement.prepared.path} 放弃回 ${opening.target?.speakerId ?? "（没有对象）"} 的那一条：${one.reason}`,
      );
      continue;
    }
    recomputesUsed += one.draft.pending.recomputesUsed;
    drafts.push(one.draft);
  }
  if (drafts.length === 0) return { kind: "held", reason: failure ?? "no_reply_prepared" };
  return {
    kind: "prepared_only",
    recomputesUsed,
    drafts: Object.freeze(drafts),
  };
}

/** 一个 opening 的整条回复管线。 */
async function prepareOneReply(
  orm: Orm,
  gateway: Pick<ModelGateway, "complete" | "loadedContextCapacity">,
  judgement: Extract<QqJudgementRun, { kind: "candidate" }>,
  opening: QqReplyOpening,
  nowSeconds: number,
  stage: QqStickerStage,
): Promise<
  | { readonly kind: "draft"; readonly draft: QqRoundDraft }
  | { readonly kind: "held"; readonly reason: string }
> {
  const reply = await generateQqTextReply(orm, gateway, judgement, opening, nowSeconds);
  if (reply.kind !== "draft" && reply.kind !== "review_required")
    return { kind: "held", reason: reply.kind === "blocked" ? reply.reason : reply.kind };
  let pending: QqPendingReview = reply.kind === "draft" ? pendingQqReview(reply) : reply.draft;
  // The capped budget lives in the scheme; each review/regeneration checks it again.
  for (let turn = 0; turn < 4; turn++) {
    if (pending.stickerId === undefined) {
      const pick = await selectQqSticker(
        orm,
        gateway,
        {
          bindingId: pending.snapshot.bindingId,
          schemeId: pending.snapshot.schemeId,
          schemeRevision: pending.schemeRevision,
          agentId: pending.snapshot.agentId,
          agentConfigVersion: pending.agentConfigVersion,
          path: pending.path,
          text: pending.text,
          // The sentence's own context, not a fresh read: the picture must fit the words that
          // were written for that conversation (P4i).
          messages: pending.selection.messages,
          nowSeconds: pending.nowSeconds,
        },
        stage,
      );
      if (pick.kind === "blocked") return { kind: "held", reason: pick.reason };
      // A sticker that could not be chosen leaves a complete reply (§8.1-1); only the pick
      // that was made is carried forward.
      pending = { ...pending, stickerId: pick.kind === "chosen" ? pick.stickerId : null };
    }
    const preflight = checkQqTextPreflight(orm, pending, stage);
    if (preflight.kind === "blocked") return { kind: "held", reason: preflight.reason };
    if (preflight.kind === "checks_passed") {
      return {
        kind: "draft",
        draft: { opening, pending, plan: planQqPreparedReply(orm, pending, stage) },
      };
    }
    const review = await reviewQqSupplement(orm, gateway, pending, nowSeconds);
    if (review.kind === "blocked") return { kind: "held", reason: review.reason };
    if (review.kind === "unchanged") {
      // A reviewed unchanged draft has a new event baseline, not a new permission to send. The
      // sentence stands, so the sticker chosen for it stands too.
      pending = { ...pending, text: review.text, memberEventCount: review.eventCount };
      continue;
    }
    if (review.kind !== "recompute_needed") return { kind: "held", reason: review.kind };
    const refreshed = await recomputeQqReply(orm, gateway, pending, review, nowSeconds);
    if (refreshed.kind === "blocked") return { kind: "held", reason: refreshed.reason };
    if (refreshed.kind !== "draft") return { kind: "held", reason: refreshed.kind };
    // A regenerated sentence invalidates the pick: the loop runs the stage again.
    pending = refreshed.draft;
  }
  return { kind: "held", reason: "review_cycle_limit" };
}
