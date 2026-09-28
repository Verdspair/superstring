// P0 场景基线（0.4.0）——断言层。
//
// 驱动逻辑在 `tests/harness/scenarios.ts`：同一份场景被这里和基线记录器
// （`tools/verify/record-0.4.0-baseline.ts`）共用，断言只属于测试、指标只属于基线。
//
// 用途：① 当前内核的行为基线（0.4.0 换内核后逐条对照）；② 验收夹具本身——不接网络、不读真实数据。

import { afterEach, describe, expect, it } from "bun:test";
import { closeHarnesses } from "../harness/onebot";
import {
  addressedThenInterrupted,
  belowThresholdButFinal,
  chimingInAboveThreshold,
  chimingInSilent,
  deliveryUnknown,
  groupAddressed,
  groupUnsplitReply,
  idleTopic,
  knowledgeRevocation,
  mediaReadFailureThenSupplement,
  memoryCorrection,
  multipleSpeakers,
  newMessageDuringGeneration,
  pausedConversation,
  pendingIntentSurvivesRestart,
  privateDirectReply,
  rerunKeepsSingleReply,
} from "../harness/scenarios";

afterEach(closeHarnesses);

describe("P0 场景基线：OneBot 整链（离线）", () => {
  it("私聊直接回应：一次决策 + 一次生成，回复发给对方且不加 @", async () => {
    const { status, harness: h } = await privateDirectReply();

    expect(status).toBe("completed");
    expect(h.model?.calls.map((call) => call.phase)).toEqual(["next", "generate"]);
    expect(h.sent).toEqual([
      {
        kind: "private",
        peerId: "20002",
        message: [{ type: "text", data: { text: "在的，怎么了" } }],
      },
    ]);
  });

  it("群聊被 @：按发言人拆开，换行折叠成一句，@ 加在部件上", async () => {
    const { status, harness: h } = await groupAddressed();

    expect(status).toBe("completed");
    expect(h.outbox.list({})[0]?.target).toEqual({ peerId: "30003", participantId: "20002" });
    expect(h.sent).toEqual([
      {
        kind: "group",
        peerId: "30003",
        message: [
          { type: "at", data: { qq: "20002" } },
          { type: "text", data: { text: " 收到 马上看" } },
        ],
      },
    ]);
  });

  it("群聊整轮一条回复（关掉按发言人拆分）：换行拆成多条部件且不加 @", async () => {
    const { status, harness: h } = await groupUnsplitReply();

    expect(status).toBe("completed");
    // 关掉拆分时收件人是显式 `null`（整间会话）——0.4.0 要把这个"null 兼三义"换成显式收件人类型。
    expect(h.outbox.list({})[0]?.target).toEqual({ peerId: "30003", participantId: null });
    expect(h.sent).toEqual([
      { kind: "group", peerId: "30003", message: [{ type: "text", data: { text: "第一句" } }] },
      { kind: "group", peerId: "30003", message: [{ type: "text", data: { text: "第二句" } }] },
    ]);
  });

  it("自主接话达门槛：意图 → 程序触发许可 → 写正文（评分与决策用判断模型）", async () => {
    const { status, harness: h } = await chimingInAboveThreshold();

    expect(status).toBe("completed");
    // 0.4.0 P4 §4.1：模型只产出意图（一次决策），评分由程序在写正文前发出，正文用会话模型。
    expect(h.model?.calls.map((call) => `${call.phase}:${call.model}`)).toEqual([
      "next:judge-model",
      "next:judge-model",
      "generate:reply-model",
    ]);
    expect(h.model?.remaining()).toBe(0);
    expect(h.sent).toEqual([
      {
        kind: "group",
        peerId: "30003",
        message: [
          { type: "at", data: { qq: "20002" } },
          { type: "text", data: { text: " 这个我知道" } },
        ],
      },
    ]);
  });

  it("自主接话未达门槛且模型沉默：这一轮没有输出，也不留待发意图", async () => {
    const { status, harness: h } = await chimingInSilent();

    expect(status).toBe("no_output");
    expect(h.outbox.list({})).toHaveLength(0);
    expect(h.sent).toHaveLength(0);
  });

  it("投递结果未知：记为未知且不盲目重发", async () => {
    const { harness: h } = await deliveryUnknown();

    expect(h.sendResults[0]?.kind).toBe("unknown");
    expect(h.outbox.list({})[0]?.status).toBe("unknown");
    expect(h.sent).toHaveLength(1);
  });

  it("低于门槛仍要求发言：许可不通过＝静默结束，不留待发意图（§4.1 已落）", async () => {
    const { status, metric, harness: h } = await belowThresholdButFinal();

    expect(status).toBe("no_output");
    expect(metric.error).toBeNull();
    expect(h.outbox.list({})).toHaveLength(0);
    expect(h.sent).toHaveLength(0);
  });

  it("被 @ 之后他人插话：这一轮仍然回被叫到的人", async () => {
    const { status, harness: h } = await addressedThenInterrupted();

    expect(status).toBe("completed");
    expect(h.outbox.list({})[0]?.target).toEqual({ peerId: "30003", participantId: "20002" });
    expect(h.sent[0]?.message[0]).toEqual({ type: "at", data: { qq: "20002" } });
  });

  it("多人同时说话：逐人评分、逐人回复", async () => {
    const { status, harness: h } = await multipleSpeakers();

    expect(status).toBe("completed");
    expect(h.outbox.list({}).map((intent) => intent.target?.participantId)).toEqual([
      "20002",
      "20003",
    ]);
    expect(h.sent.map((request) => request.message[0])).toEqual([
      { type: "at", data: { qq: "20002" } },
      { type: "at", data: { qq: "20003" } },
    ]);
  });

  it("会话暂停：零模型调用、不产生唤醒", async () => {
    const { status, harness: h } = await pausedConversation();

    expect(status).toBe("no_wake");
    expect(h.model?.calls).toHaveLength(0);
    expect(h.sent).toHaveLength(0);
  });

  it("冷场发起：安静满时长后扫描排程，面向整间会话且不加 @", async () => {
    const { status, harness: h } = await idleTopic();

    expect(status).toBe("completed");
    expect(h.outbox.list({})[0]?.target).toEqual({ peerId: "30003", participantId: null });
    expect(h.sent).toEqual([
      {
        kind: "group",
        peerId: "30003",
        message: [{ type: "text", data: { text: "好久没人说话了" } }],
      },
    ]);
  });

  it("生成期间来了新消息：这一轮回到决策，最终发的是改过的那版", async () => {
    const { status, harness: h } = await newMessageDuringGeneration();

    expect(status).toBe("completed");
    expect(h.model?.calls.map((call) => call.phase)).toEqual([
      "next",
      "generate",
      "next",
      "generate",
    ]);
    expect(h.sent).toEqual([
      {
        kind: "group",
        peerId: "30003",
        message: [
          { type: "at", data: { qq: "20002" } },
          { type: "text", data: { text: " 第二版" } },
        ],
      },
    ]);
  });

  it("重启后待发意图仍可投递（进程内状态丢掉，库里的计划还在）", async () => {
    const { harness: h } = await pendingIntentSurvivesRestart();

    expect(h.sent).toHaveLength(1);
    expect(h.outbox.list({})[0]?.status).toBe("confirmed");
  });

  it("重跑同一个机会只留一条回复：计划中的被替换、已尝试过的原样返回", async () => {
    const { status, harness: h } = await rerunKeepsSingleReply();

    expect(status).toBe("completed");
    expect(h.outbox.list({})).toHaveLength(1);
    expect(h.outbox.list({})[0]?.status).toBe("confirmed");
    expect(h.sent).toEqual([
      { kind: "private", peerId: "20002", message: [{ type: "text", data: { text: "第二版" } }] },
    ]);
  });

  it("媒体读失败按住房子的主动接话，补充读取成功后才放行", async () => {
    const { status, metric, harness: h } = await mediaReadFailureThenSupplement();

    // ① 第一轮被媒体闸门按住：原因写清楚，且一次模型都没调。
    expect(metric.note).toBe("media_read_failed");
    // ② 补充读取调了第二次视觉（第一次失败、第二次给出说明）。
    expect(h.visionCalls).toHaveLength(2);
    // ③ 第三轮放行：媒体说明真的进了模型看到的上下文。
    expect(status).toBe("completed");
    expect(h.model?.calls.some((call) => call.text.includes("图里是一只猫"))).toBe(true);
    expect(h.sent).toEqual([
      {
        kind: "group",
        peerId: "30003",
        message: [
          { type: "at", data: { qq: "20002" } },
          { type: "text", data: { text: " 看到了，是只猫" } },
        ],
      },
    ]);
  });

  it("记忆更正后旧正文不可复活：旧正文进过上下文，之后只在更正后才出现", async () => {
    const { status, harness: h } = await memoryCorrection();

    expect(status).toBe("completed/completed/completed");
    const calls = h.model?.calls ?? [];
    // 每轮：选择器（辅助叶子）→ 决策 → 生成。
    expect(calls.map((call) => call.phase)).toEqual([
      "auxiliary",
      "next",
      "generate",
      "auxiliary",
      "next",
      "generate",
      "auxiliary",
      "next",
      "generate",
    ]);
    // ① 旧正文确实进过第一轮（生成调用带上了完整装配；决策调用被 4000 字截断，断言看生成）。
    expect(calls[2]?.text).toContain("错误金额999元");
    // ② 更正之后的每一轮只有更正后的正文。
    expect(calls[5]?.text).toContain("正确金额80元");
    const afterCorrection = calls
      .slice(3)
      .map((call) => call.text)
      .join("\n");
    expect(afterCorrection).not.toContain("错误金额999元");
    // ③ 指名已退休旧行的选择被判越界：这一轮没有记忆（失败关闭），并留下失败的选择器运行。
    expect(calls[8]?.text).not.toContain("正确金额80元");
    const selectorRuns = h.runs
      .listRuns({ ownerKind: "qq_binding", ownerId: h.bindingId })
      .filter((run) => run.specId === "memory.select");
    expect(selectorRuns.some((run) => run.status === "failed")).toBe(true);
    // 三轮都投递成功：越界选择只影响那一轮的记忆，不影响会话继续。
    expect(h.sent).toHaveLength(3);
  });

  it("资料撤权后不再进上下文：撤权后的新读取看不见它，也不换种说法编出来", async () => {
    const { status, harness: h } = await knowledgeRevocation();

    expect(status).toBe("completed/completed");
    const calls = h.model?.calls ?? [];
    // 第一轮：资料选择（辅助）+ 决策 + 生成；撤权后没有资料可挑，选择器调用消失。
    expect(calls.map((call) => call.phase)).toEqual([
      "auxiliary",
      "next",
      "generate",
      "next",
      "generate",
    ]);
    expect(calls[2]?.text).toContain("苹果单价是每斤八元");
    expect(calls[4]?.text).not.toContain("苹果单价是每斤八元");
    expect(
      calls
        .slice(3)
        .map((call) => call.text)
        .join("\n"),
    ).not.toContain("苹果单价是每斤八元");
    expect(h.sent).toEqual([
      { kind: "private", peerId: "20002", message: [{ type: "text", data: { text: "每斤八元" } }] },
      {
        kind: "private",
        peerId: "20002",
        message: [{ type: "text", data: { text: "这个我查不到了" } }],
      },
    ]);
  });
});
