// P0 场景基线（0.4.0）——断言层。
//
// 驱动逻辑在 `tests/harness/scenarios.ts`：同一份场景被这里和基线记录器
// （`tools/verify/record-0.4.0-baseline.ts`）共用，断言只属于测试、指标只属于基线。
//
// 用途：① 当前内核的行为基线（0.4.0 换内核后逐条对照）；② 验收夹具本身——不接网络、不读真实数据。

import { afterEach, describe, expect, it } from "bun:test";
import type { RunSnapshot } from "../../src/shared/contracts/agent-run";
import { closeHarnesses, type OneBotHarness } from "../harness/onebot";
import {
  type ActionObservation,
  addressedThenInterrupted,
  belowThresholdButFinal,
  chimingInAboveThreshold,
  chimingInSilent,
  deliveryUnknown,
  groupAddressed,
  groupUnsplitReply,
  idleTopic,
  knowledgeRevocation,
  lastActionObservation,
  mediaReadFailureImageOnly,
  mediaReadFailureThenSupplement,
  memoryCorrection,
  mixedSilentAndSpeaking,
  multipleSilentBelowThreshold,
  multipleSpeakers,
  newMessageDuringGeneration,
  pausedConversation,
  pendingIntentSurvivesRestart,
  privateDirectReply,
  rerunKeepsSingleReply,
} from "../harness/scenarios";

afterEach(closeHarnesses);

/** 本会话的 `onebot.main` 运行（新的在前）。 */
function mainRuns(h: OneBotHarness): RunSnapshot[] {
  return h.runs
    .listRuns({ ownerKind: "conversation", ownerId: h.conversationId })
    .filter((run) => run.specId === "onebot.main");
}

/** 运行的全部步骤上下文的文本拼接：`getContext` 回读全量消息，绕开调用记录的 4000 字截断。 */
function fullContextText(h: OneBotHarness, run: RunSnapshot): string {
  const parts: string[] = [];
  for (const step of run.steps) {
    for (const message of h.runs.getContext(step.context)?.messages ?? []) {
      for (const part of message.content) if (part.kind === "text") parts.push(part.text);
    }
  }
  return parts.join("\n");
}

/** 运行里每一步上下文能解析到的最近一条 action_observation（同一条会出现在后续步骤里）。 */
function runObservations(h: OneBotHarness, run: RunSnapshot): ActionObservation[] {
  const found: ActionObservation[] = [];
  for (const step of run.steps) {
    const observation = lastActionObservation(h.runs.getContext(step.context)?.messages ?? []);
    if (observation !== null) found.push(observation);
  }
  return found;
}

describe("P0 场景基线：OneBot 整链（离线）", () => {
  it("私聊直接回应：首 call 直接出正文，回复发给对方且不加 @", async () => {
    const { status, harness: h } = await privateDirectReply();

    expect(status).toBe("completed");
    // 直接回应首 call 直接出正文（规格 §2.4）：无前置意图轮、无独立生成调用。
    expect(h.model?.calls.map((call) => call.phase)).toEqual(["next"]);
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
    // @ 段只来自脚本显式 mentionIds（无 auto-at）；正文逐字发送、在前，at 段按 mentions 追加在后
    // （D2 结构化出站线上语义）。
    expect(h.sent).toEqual([
      {
        kind: "group",
        peerId: "30003",
        message: [
          { type: "text", data: { text: "收到 马上看" } },
          { type: "at", data: { qq: "20002" } },
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

  it("自主接话达门槛：一次批评分 → 达标目标回复子 run 首 call 出正文（评分用判断模型）", async () => {
    const { status, harness: h } = await chimingInAboveThreshold();

    expect(status).toBe("completed");
    // 规格 §2.2：阶段一一次批评分（判断模型），达标目标进回复子 run，首 call 直接出正文。
    expect(h.model?.calls.map((call) => `${call.phase}:${call.model}`)).toEqual([
      "next:judge-model",
      "next:reply-model",
    ]);
    expect(h.model?.remaining()).toBe(0);
    // 与直接回应同一编码器：正文逐字在前，at 按 mentionIds 后置（D2 结构化出站）。
    expect(h.sent).toEqual([
      {
        kind: "group",
        peerId: "30003",
        message: [
          { type: "text", data: { text: "这个我知道" } },
          { type: "at", data: { qq: "20002" } },
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
    // 许可被拒＝故意不开口，唤醒记录同样要静默（no_output／无错误码），不能显示成"处理失败"。
    const wake = h.db
      .query("SELECT status,error_code FROM wake_signals WHERE cause='chiming_in'")
      .get() as { status: string; error_code: string | null };
    expect(wake.status).toBe("no_output");
    expect(wake.error_code).toBeNull();
  });

  it("多人都未达门槛：每个成熟机会都被结算，唤醒都不是失败，第二轮不再重复判断", async () => {
    const { status, harness: h } = await multipleSilentBelowThreshold();

    expect(status).toBe("no_output");
    expect(h.outbox.list({})).toHaveLength(0);
    expect(h.sent).toHaveLength(0);
    // 都静默＝都不是失败；本批是**一次**会话级机会（规格 §2.2），完整低分判断后结算为 no_output。
    const wakes = h.db
      .query(
        "SELECT status,error_code FROM wake_signals WHERE cause='chiming_in' ORDER BY through_seq",
      )
      .all() as { status: string; error_code: string | null }[];
    expect(wakes).toHaveLength(1);
    for (const wake of wakes) {
      expect(wake.status).toBe("no_output");
      expect(wake.error_code).toBeNull();
    }
    expect(
      h.db.query("SELECT COUNT(*) AS n FROM wake_signals WHERE status='pending'").get(),
    ).toEqual({
      n: 0,
    });
    // 机会都已结算：第二轮没有可领的机会，也不该再花任何模型调用。
    const callsAfterFirst = h.model?.calls.length ?? 0;
    const second = await h.activate("chiming_in");
    expect(second).toBeNull();
    expect(h.model?.calls.length ?? 0).toBe(callsAfterFirst);
  });

  it("混合结果：一人开口一人未达门槛，整轮 completed，静默目标的唤醒仍不记失败", async () => {
    const { status, harness: h } = await mixedSilentAndSpeaking();

    expect(status).toBe("completed");
    expect(h.sent).toHaveLength(1);
    // 本批是一次会话级机会（规格 §2.2）：达标目标由各自回复子 run 结算，未达标者不派发。
    // 关键不变量不变：机会终态不因低分目标带资格错误码、不标 failed。
    const bySeq = h.db
      .query(
        "SELECT through_seq,status,error_code FROM wake_signals WHERE cause='chiming_in' ORDER BY through_seq",
      )
      .all() as { through_seq: number; status: string; error_code: string | null }[];
    expect(bySeq).toHaveLength(1);
    for (const wake of bySeq) {
      expect(wake.error_code).toBeNull();
      expect(wake.status).not.toBe("failed");
    }
  });

  it("被 @ 之后他人插话：这一轮仍然回被叫到的人", async () => {
    const { status, harness: h } = await addressedThenInterrupted();

    expect(status).toBe("completed");
    expect(h.outbox.list({})[0]?.target).toEqual({ peerId: "30003", participantId: "20002" });
    // at 来自显式 mentionIds、追加在正文之后（D2 结构化出站）。
    expect(h.sent[0]?.message.at(-1)).toEqual({ type: "at", data: { qq: "20002" } });
    expect(h.sent[0]?.message[0]?.type).toBe("text");
  });

  it("多人同时说话：逐人评分、逐人回复", async () => {
    const { status, harness: h } = await multipleSpeakers();

    expect(status).toBe("completed");
    expect(h.outbox.list({}).map((intent) => intent.target?.participantId)).toEqual([
      "20002",
      "20003",
    ]);
    // 跨 target 允许按完成先后早发（规格 §4）：按 target/内容键断言，不锁完成顺序；
    // 每 target 正文对应其显式 mentionIds，单条消息内部件序保持（正文前、at 后）。
    const replies = new Map(
      h.sent.map((request) => {
        const at = request.message.find((part) => part.type === "at");
        const text = request.message.find((part) => part.type === "text");
        return [at?.data?.qq, text?.data?.text];
      }),
    );
    expect(h.sent).toHaveLength(2);
    expect(replies.get("20002")).toBe("回甲");
    expect(replies.get("20003")).toBe("回乙");
    for (const request of h.sent) {
      expect(request.message.map((part) => part.type)).toEqual(["text", "at"]);
    }
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
    // @ 只来自显式 mentionIds；正文逐字在前，at 段按 D2 结构化出站后置。
    expect(h.sent).toEqual([
      {
        kind: "group",
        peerId: "30003",
        message: [
          { type: "text", data: { text: "第二版" } },
          { type: "at", data: { qq: "20002" } },
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

  it("媒体读失败按住主动接话，被 @ 的补充到来后经真工具重读并收口", async () => {
    const { status, metric, harness: h } = await mediaReadFailureThenSupplement();

    // ① 第一轮自主接话被媒体闸门按住：发布在提交处被挡（整轮以 MEDIA_READ_FAILED 失败），零发送。
    expect(metric.note).toBe("failed:MEDIA_READ_FAILED");
    expect(h.outbox.list({})).toHaveLength(1); // 只有第二轮那条
    expect(h.model?.calls.every((call) => call.phase === "next")).toBe(true);
    // ② 视觉真的走了宿主：第一次失败、补充到来后第二次成功（重试上限 2 由真实读取器判定）。
    expect(h.visionCalls).toHaveLength(2);
    expect(h.visionCalls.map((call) => call.model)).toEqual(["vision-stub", "vision-stub"]);
    // ③ 第二轮直接回应：list→describe→note.read 的说明进了模型上下文，收口一条 @。
    expect(status).toBe("completed");
    expect(mainRuns(h).some((run) => fullContextText(h, run).includes("图里是一只猫"))).toBe(true);
    // 与本文件其余 wire 断言同一编码器：正文逐字在前，at 按 mentionIds 后置（D2 结构化出站）。
    expect(h.sent).toEqual([
      {
        kind: "group",
        peerId: "30003",
        message: [
          { type: "text", data: { text: "看到了，是只猫" } },
          { type: "at", data: { qq: "20002" } },
        ],
      },
    ]);
  });

  it("同秒同人两真纯图（无 text 段）一败一成：失败图阻发布，MEDIA_READ_FAILED，零出站零发送", async () => {
    const { status, metric, harness: h } = await mediaReadFailureImageOnly();

    expect(metric.error).toBe("MEDIA_READ_FAILED");
    expect(status).toBe("failed");
    const blockedRun = h.runs
      .listRuns({ ownerKind: "conversation", ownerId: h.conversationId })
      .find((run) => run.errorCode === "MEDIA_READ_FAILED");
    if (blockedRun === undefined) throw new Error("缺少被媒体闸门挡下的运行");
    expect(h.outbox.list({})).toHaveLength(0);
    expect(h.sent).toHaveLength(0);
    expect(h.visionCalls).toHaveLength(2);
  });

  it("记忆更正后旧正文不可复活：显式 query→read 取正文，更正后只剩新正文，旧引用整轮硬失败", async () => {
    const { status, harness: h } = await memoryCorrection();

    expect(status).toBe("completed/completed/failed:CONTEXT_INVALID_SELECTION");
    const calls = h.model?.calls ?? [];
    // 全程主 Agent 显式取数（query→read），没有辅助选择调用；失败轮停在 read 执行处。
    expect(calls.every((call) => call.phase !== "auxiliary")).toBe(true);
    expect(calls.map((call) => call.phase)).toEqual([
      "next",
      "next",
      "next",
      "generate",
      "next",
      "next",
      "next",
      "generate",
      "next",
      "next",
    ]);
    // ① 旧正文真的进过第一轮（生成调用带完整装配；更正会撤权清空该轮落库快照，只能看调用记录）。
    expect(calls[3]?.text).toContain("错误金额999元");

    const runs = mainRuns(h);
    expect(runs).toHaveLength(3);
    const failed = runs.find((run) => run.errorCode === "CONTEXT_INVALID_SELECTION");
    if (failed === undefined) throw new Error("缺少 CONTEXT_INVALID_SELECTION 的失败运行");
    // ② 更正后的新轮：候选只有更正行，正文只剩更正后的（全量上下文回读，不受 4000 截断影响）。
    const corrected = runs.find((run) => fullContextText(h, run).includes("正确金额80元"));
    if (corrected === undefined) throw new Error("缺少更正后带新正文的运行");
    const query = runObservations(h, corrected).find((obs) => obs.name === "memory.query");
    expect(query?.value?.items).toHaveLength(1);
    expect(query?.value?.items?.[0]?.summary).toContain("已更正");
    expect(fullContextText(h, corrected)).not.toContain("错误金额999元");
    // ③ 旧引用再读被判越界：整轮硬失败，旧正文不回填；已退休的行也不在候选里。
    const staleQuery = runObservations(h, failed).find((obs) => obs.name === "memory.query");
    expect(staleQuery?.value?.items).toHaveLength(0);
    expect(fullContextText(h, failed)).not.toContain("错误金额999元");
    const staleStep = failed.steps[1];
    if (staleStep === undefined) throw new Error("失败运行缺少第二步");
    expect(h.runs.getContext(staleStep.context)?.output?.text).toContain("memory.read");
    // 硬失败只关掉那一轮：前两轮照常投递，没有编出第三条。
    expect(h.sent).toEqual([
      {
        kind: "private",
        peerId: "20002",
        message: [{ type: "text", data: { text: "金额我再确认一下" } }],
      },
      {
        kind: "private",
        peerId: "20002",
        message: [{ type: "text", data: { text: "这是更正后的金额" } }],
      },
    ]);
  });

  it("资料撤权后不再进上下文：新 query 为空，正文不再出现也不换种说法编出来", async () => {
    const { status, harness: h } = await knowledgeRevocation();

    expect(status).toBe("completed/completed");
    const calls = h.model?.calls ?? [];
    // 第一轮：query→read→final；撤权后候选为空，直接收口；全程没有辅助选择调用。
    expect(calls.every((call) => call.phase !== "auxiliary")).toBe(true);
    expect(calls.map((call) => call.phase)).toEqual([
      "next",
      "next",
      "next",
      "generate",
      "next",
      "next",
      "generate",
    ]);
    // ① 已授权时正文真的进过上下文（生成调用带完整装配）。
    expect(calls[3]?.text).toContain("苹果单价是每斤八元");
    // ② 撤权后的轮次：调用记录与全量上下文都没有正文；query 观察是空候选。
    expect(
      calls
        .slice(4)
        .map((call) => call.text)
        .join("\n"),
    ).not.toContain("苹果单价是每斤八元");
    const runs = mainRuns(h);
    expect(runs).toHaveLength(2);
    const revoked = runs.find((run) =>
      runObservations(h, run).some(
        (obs) => obs.name === "knowledge.query" && obs.value?.items?.length === 0,
      ),
    );
    if (revoked === undefined) throw new Error("缺少撤权后空候选的运行");
    expect(fullContextText(h, revoked)).not.toContain("苹果单价是每斤八元");
    expect(h.sent).toEqual([
      {
        kind: "private",
        peerId: "20002",
        message: [{ type: "text", data: { text: "每斤八元" } }],
      },
      {
        kind: "private",
        peerId: "20002",
        message: [{ type: "text", data: { text: "这个我查不到了" } }],
      },
    ]);
  });
});
