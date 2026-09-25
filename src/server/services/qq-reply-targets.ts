// 这一轮要回谁：按发言人分组、按发言人算合并窗口（用户 2026-09-25）。
//
// 用户要的机制是"不同人的消息分开来跑"：不是让模型写出一堆行再按行切开，而是**每个人各自一次任务、
// 各自一条消息**。谁进这一轮由两件事决定，都是按**人**算的：
//
//   1. 合并窗口按 id：他自己的最后一条消息过完 `merge_window_seconds` 就算"说完了"，可以回。别人刚
//      开口不算他没过窗口——这正是"按 id 来算"的意思。
//   2. 她上次开口之后他还说过话：说过的人才是这一轮的活。已经回过的人不会因为一条新消息**在别人
//      那里**被重新翻出来；要重新被回，得他自己再说。
//
// Pure: it reads nothing and writes nothing. The caller supplies the window's messages, the clock, the
// merge window and her last speech time; everything here is arithmetic over those facts. Ordering is
// chronological (whoever spoke first is answered first), so the round reads in the order the group saw
// the messages.
//
// 匿名发言没有号，也就没有可 @ 的对象——但它仍然是**一个人说的话**，所以照样是一个目标，只是这个目标
// 的 `speakerId` 是 `null`（发送时不加 `@`）。所有匿名发言归成同一个目标：它们的区别无法从事件里读出来。

import { z } from "zod";

export interface QqReplyTarget {
  /** 群友的号（`@` 的对象）；`null` = 匿名发言，没有号，因此发送时不加 `@`。 */
  readonly speakerId: string | null;
  /** Their newest message in the window; the merge window is measured from this. */
  readonly newestSeconds: number;
  /** How many messages they contributed to the window. Ordering and diagnostics only. */
  readonly messageCount: number;
}

export type QqReplyTargetPlan =
  | { readonly kind: "reply"; readonly targets: readonly QqReplyTarget[] }
  /** Someone is still talking: wait until their own window closes. */
  | { readonly kind: "waiting"; readonly readyAtSeconds: number }
  /** Nobody has said anything since she last spoke — there is no one to answer. */
  | { readonly kind: "nothing_to_answer" };

const Input = z.strictObject({
  messages: z.array(
    z.strictObject({
      speakerId: z.string().nullable(),
      occurredAtSeconds: z.number().int().nonnegative(),
    }),
  ),
  mergeWindowSeconds: z.number().int().min(0).max(300),
  nowSeconds: z.number().int().nonnegative(),
  /** Her own newest confirmed speech in this conversation, or `null` if she has never spoken. */
  lastSpeechSeconds: z.number().int().nonnegative().nullable(),
});

/** Who this round answers, or why it does not answer anyone yet. */
export function qqReplyTargets(input: unknown): QqReplyTargetPlan {
  const parsed = Input.safeParse(input);
  if (!parsed.success) throw new TypeError("Invalid QQ reply target input");
  const { messages, mergeWindowSeconds, nowSeconds, lastSpeechSeconds } = parsed.data;

  // Mutable while grouping; the exported entries are frozen below.
  interface Accumulating {
    speakerId: string | null;
    newestSeconds: number;
    messageCount: number;
  }
  // Keyed by id, with `""` standing for "anonymous": every anonymous message is one target, because
  // nothing in the event tells them apart.
  const bySpeaker = new Map<string, Accumulating>();
  for (const message of messages) {
    const id = message.speakerId;
    const key = id ?? "";
    const current = bySpeaker.get(key);
    if (current === undefined) {
      bySpeaker.set(key, {
        speakerId: id,
        newestSeconds: message.occurredAtSeconds,
        messageCount: 1,
      });
      continue;
    }
    current.messageCount += 1;
    current.newestSeconds = Math.max(current.newestSeconds, message.occurredAtSeconds);
  }

  // Eligible = they spoke after her last confirmed speech. A conversation she has never spoken in has
  // everyone eligible, which is what "she has not answered them yet" means.
  const eligible = [...bySpeaker.values()].filter(
    (target) => lastSpeechSeconds === null || target.newestSeconds > lastSpeechSeconds,
  );
  if (eligible.length === 0) return Object.freeze({ kind: "nothing_to_answer" });

  const ready = eligible.filter(
    (target) => nowSeconds >= target.newestSeconds + mergeWindowSeconds,
  );
  if (ready.length === 0) {
    const earliest = Math.min(...eligible.map((target) => target.newestSeconds));
    return Object.freeze({ kind: "waiting", readyAtSeconds: earliest + mergeWindowSeconds });
  }
  ready.sort(
    (left, right) =>
      left.newestSeconds - right.newestSeconds ||
      (left.speakerId ?? "").localeCompare(right.speakerId ?? ""),
  );
  const targets: readonly QqReplyTarget[] = Object.freeze(
    ready.map((target) => Object.freeze({ ...target })),
  );
  return Object.freeze({ kind: "reply", targets });
}
