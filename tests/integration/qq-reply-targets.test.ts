// 这一轮回谁（0037，不同人的消息分开来跑，按 id 算合并窗口）。
//
// 纯算术：给定窗口里的消息、合并窗口、她的上次开口时刻和"现在"，算出这一轮该回哪几个人。它是
// "每人一次任务"的入口——判几次、发几条都由这个列表决定，所以边界值得单独钉住：
//
//   * 合并窗口按**人**算：张三自己的最后一条过完窗口就轮到他，别人刚开口不能把他的窗口往后推；
//   * 她上次开口之后没再说过话的人不进这一轮（已经回过的人不因为别人又开一次口被翻出来）；
//   * 匿名发言是一个目标，只是没有号（`speakerId: null`，发送时不加 `@`）。

import { describe, expect, it } from "bun:test";
import { qqReplyTargets } from "../../src/server/services/qq-reply-targets";

const base = {
  mergeWindowSeconds: 30,
  nowSeconds: 1000,
  lastSpeechSeconds: null,
};

describe("who this round answers (0037)", () => {
  it("measures the merge window per speaker, not on the newest message", () => {
    // 张三 40 秒前说完（过完窗口），李四 5 秒前还在说。等的是李四自己，而不是"最后一条消息"——
    // 但张三不会被李四拖住：这一轮先回张三。
    const plan = qqReplyTargets({
      ...base,
      messages: [
        { speakerId: "20002", occurredAtSeconds: 960 },
        { speakerId: "40004", occurredAtSeconds: 960 },
        { speakerId: "40004", occurredAtSeconds: 995 },
      ],
    });
    expect(plan).toEqual({
      kind: "reply",
      targets: [{ speakerId: "20002", newestSeconds: 960, messageCount: 1 }],
    });
  });

  it("waits for the earliest speaker's own window when nobody is ripe yet", () => {
    const plan = qqReplyTargets({
      ...base,
      mergeWindowSeconds: 30,
      nowSeconds: 1000,
      messages: [
        { speakerId: "20002", occurredAtSeconds: 985 },
        { speakerId: "40004", occurredAtSeconds: 990 },
      ],
    });
    // Ready at the OLDEST of them (985 + 30), so a quiet speaker is not delayed by a chatty one.
    expect(plan).toEqual({ kind: "waiting", readyAtSeconds: 1015 });
  });

  it("answers nobody when no one has spoken since her last speech", () => {
    const plan = qqReplyTargets({
      ...base,
      lastSpeechSeconds: 990,
      messages: [
        { speakerId: "20002", occurredAtSeconds: 900 },
        { speakerId: "20002", occurredAtSeconds: 990 },
      ],
    });
    expect(plan).toEqual({ kind: "nothing_to_answer" });
  });

  it("leaves out whoever she has already answered, and keeps the rest", () => {
    const plan = qqReplyTargets({
      ...base,
      lastSpeechSeconds: 960,
      messages: [
        { speakerId: "20002", occurredAtSeconds: 940 },
        { speakerId: "40004", occurredAtSeconds: 970 },
      ],
    });
    expect(plan).toEqual({
      kind: "reply",
      targets: [{ speakerId: "40004", newestSeconds: 970, messageCount: 1 }],
    });
  });

  it("answers in the order the group saw the messages", () => {
    const plan = qqReplyTargets({
      ...base,
      messages: [
        { speakerId: "40004", occurredAtSeconds: 930 },
        { speakerId: "20002", occurredAtSeconds: 910 },
        { speakerId: "40004", occurredAtSeconds: 950 },
      ],
    });
    expect(plan.kind).toBe("reply");
    expect(plan.kind === "reply" ? plan.targets.map((t) => t.speakerId) : []).toEqual([
      "20002",
      "40004",
    ]);
    expect(plan.kind === "reply" ? plan.targets[1]?.messageCount : 0).toBe(2);
  });

  it("treats anonymous messages as one target without a number", () => {
    const plan = qqReplyTargets({
      ...base,
      messages: [
        { speakerId: null, occurredAtSeconds: 940 },
        { speakerId: null, occurredAtSeconds: 950 },
      ],
    });
    // One target, no `@`: nothing in the event tells two anonymous speakers apart.
    expect(plan).toEqual({
      kind: "reply",
      targets: [{ speakerId: null, newestSeconds: 950, messageCount: 2 }],
    });
  });

  it("refuses anything that is not the documented shape", () => {
    expect(() => qqReplyTargets({ ...base, messages: [{ speakerId: "1", at: 1 }] })).toThrow();
    expect(() => qqReplyTargets({ ...base, messages: [], mergeWindowSeconds: -1 })).toThrow();
    expect(() => qqReplyTargets({ ...base, messages: [], nowSeconds: 1.5 })).toThrow();
  });
});
