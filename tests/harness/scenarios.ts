// P0 场景的**唯一驱动源**：每条场景只写一遍，两个消费者共用——
//   * `tests/integration/onebot-harness.test.ts` 读它并加断言；
//   * `tools/verify/record-0.4.0-baseline.ts` 读它并把指标写成 JSON（P8 新旧对照的"旧"这一侧）。
//
// 场景只描述"收到什么、模型回什么、按什么顺序"，不写断言：断言属于测试，指标属于基线。

import type { ModelMessage } from "../../src/shared/contracts/agent-run";
import {
  batchScore,
  decideGenerate,
  decideInline,
  decideInvoke,
  decideNone,
  type ModelStep,
  say,
} from "./model";
import { createOneBotHarness, type OneBotHarness } from "./onebot";

export interface ScenarioMetric {
  readonly name: string;
  readonly status: string;
  readonly modelCalls: number;
  readonly phases: Record<string, number>;
  readonly models: readonly string[];
  readonly sends: number;
  readonly sendParts: number;
  readonly intents: number;
  readonly intentStatuses: readonly string[];
  readonly error: string | null;
  /** 没开口的诊断码（如 `MEDIA_READ_FAILED`）：静默挡下时没有唤醒原因，从运行输出里取。 */
  readonly note: string | null;
}

export interface ScenarioRun {
  readonly name: string;
  readonly harness: OneBotHarness;
  readonly status: string;
  readonly metric: ScenarioMetric;
}

export function statusOf(result: unknown): string {
  return result !== null && typeof result === "object" && "status" in result
    ? String((result as { status: unknown }).status)
    : "missing";
}

/** `action_observation` 的载荷：工具结果 + 只带结果自身的来源。 */
export interface ActionObservation {
  readonly name?: string;
  readonly value?: {
    readonly status?: string;
    /** `media.describe` 的结论序号（0＝复用缓存，1/2＝消耗的尝试）。 */
    readonly attempt?: number;
    readonly items?: readonly {
      readonly id?: string;
      readonly bodyRef?: string;
      readonly text?: string;
      readonly summary?: string;
    }[];
  };
}

/** 从消息序列尾部解析最近一条 `action_observation`（上下文引擎把它渲成一条 JSON 文本消息）。 */
export function lastActionObservation(messages: readonly ModelMessage[]): ActionObservation | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const text = (messages[index]?.content ?? [])
      .flatMap((part) => (part.kind === "text" ? [part.text] : []))
      .join("");
    if (!text.includes("action_observation")) continue;
    try {
      const parsed = JSON.parse(text) as { kind?: string; value?: ActionObservation };
      if (parsed.kind === "action_observation") return parsed.value ?? null;
    } catch {
      // 不是 JSON 的整段文本：跳过，继续往前找。
    }
  }
  return null;
}

/**
 * 0.4.0 工具优先：主 Agent 显式 query→read→final，不再有辅助选择叶子。
 * `scriptedModel` 的步骤是静态的，这里在模型端口外面包一层：看到上一 `action_observation`
 * 再按需补下一步（如 read 的 bodyRef 从候选观察里解析）。装好必须 `restart()`，
 * 运行时（在 `build()` 里展开端口）才会拿到新端口。
 */
export function driveToolFirst(
  harness: OneBotHarness,
  decide: (observation: ActionObservation | null) => readonly ModelStep[] | null,
): void {
  const scripted = harness.model;
  if (scripted === null) throw new Error("该场景需要脚本化模型");
  const original = scripted.port.complete;
  scripted.port.complete = async (request) => {
    const steps = decide(lastActionObservation(request.messages));
    if (steps !== null) scripted.push(steps);
    return original(request);
  };
  harness.restart();
}

function snapshot(
  name: string,
  harness: OneBotHarness,
  status: string,
  error: string | null = null,
  note: string | null = null,
): ScenarioRun {
  const calls = harness.model?.calls ?? [];
  const phases: Record<string, number> = {};
  for (const call of calls) phases[call.phase] = (phases[call.phase] ?? 0) + 1;
  const intents = harness.outbox.list({});
  return {
    name,
    harness,
    status,
    metric: {
      name,
      status,
      modelCalls: calls.length,
      phases,
      models: [...new Set(calls.map((call) => call.model ?? "unknown"))],
      sends: harness.sent.length,
      sendParts: harness.sent.reduce((total, request) => total + request.message.length, 0),
      intents: intents.length,
      intentStatuses: intents.map((intent) => String(intent.status)),
      error,
      note,
    },
  };
}

/** 私聊直接回应：一次决策 + 一次生成，不加 @。 */
export async function privateDirectReply(): Promise<ScenarioRun> {
  const harness = createOneBotHarness({
    kind: "private",
    // 直接回应不做前置意图轮：首 call 直接给正文（规格 §2.4）。
    model: [decideInline("20002", "在的，怎么了")],
  });
  harness.receive({ id: "1", text: "在吗" });
  const result = await harness.activate("direct_reply");
  await harness.deliver();
  return snapshot("私聊直接回应", harness, statusOf(result));
}

/** 群聊被 @：直接回应首 call 直接出正文；@ 由脚本显式 mentionIds 决定（无 auto-at）。 */
export async function groupAddressed(): Promise<ScenarioRun> {
  const harness = createOneBotHarness({
    model: [decideInline("20002", "收到\n马上看", [], undefined, ["20002"])],
  });
  harness.receive({ id: "1", speaker: "20002", addressed: true, text: "在吗" });
  const result = await harness.activate("direct_reply");
  await harness.deliver();
  return snapshot("群聊被 @", harness, statusOf(result));
}

/** 群聊整轮一条回复（关掉按发言人拆分）：换行拆多部件、不加 @。 */
export async function groupUnsplitReply(): Promise<ScenarioRun> {
  const harness = createOneBotHarness({
    splitBySpeaker: false,
    // 不给 mentionIds＝不 @（模型未要求 @ 时线上不应出现 at 段）。
    model: [decideInline("30003", "第一句\n第二句")],
  });
  harness.receive({ id: "1", speaker: "20002", addressed: true, text: "在吗" });
  const result = await harness.activate("direct_reply");
  await harness.deliver();
  return snapshot("群聊整轮一条回复", harness, statusOf(result));
}

/**
 * 自主接话达门槛（规格 §2.2）：阶段一**一次**批量评分 → 达标目标进入回复子 run，
 * 首 call 直接出正文（显式 @ 走 mentionIds，宿主编码 at 段）。
 * 非计数门槛用例：显式 1/0 让单条未叫消息即成自主机会；计数门槛用例保留默认 15/5。
 */
export async function chimingInAboveThreshold(): Promise<ScenarioRun> {
  const harness = createOneBotHarness({
    initiativeBatchTargetCount: 1,
    initiativeBatchJitterCount: 0,
    model: [],
  });
  harness.receive({ id: "1", speaker: "20002", text: "有人知道这个怎么弄吗" });
  // 评分引用必须是本批冻结的真实成员事件 seq；回复首 call 的 @ 由脚本显式 mentionIds 决定。
  harness.model?.push([
    batchScore([
      {
        targetId: "20002",
        score: 9,
        intent: "想帮忙解答",
        sourceSeqs: [harness.lastEventSeq],
      },
    ]),
    decideInline("20002", "这个我知道", [], undefined, ["20002"]),
  ]);
  harness.advance(3);
  const result = await harness.activate("chiming_in");
  await harness.deliver();
  return snapshot("自主接话达门槛", harness, statusOf(result));
}

/**
 * 自主接话低分消费（规格 §2.2）：批评分给出低于门槛的分值＝正常 no_output，
 * 消费本批观察边界，不留待发意图，也不算协议错误。
 */
export async function chimingInSilent(): Promise<ScenarioRun> {
  const harness = createOneBotHarness({
    initiativeBatchTargetCount: 1,
    initiativeBatchJitterCount: 0,
    model: [],
  });
  harness.receive({ id: "1", speaker: "20002", text: "今天天气不错" });
  harness.model?.push([
    batchScore([
      { targetId: "20002", score: 2, intent: "闲聊寒暄", sourceSeqs: [harness.lastEventSeq] },
    ]),
  ]);
  harness.advance(3);
  const result = await harness.activate("chiming_in");
  await harness.deliver();
  return snapshot("自主接话未达门槛且沉默", harness, statusOf(result));
}

/** 投递结果未知：记为未知、不盲目重发。 */
export async function deliveryUnknown(): Promise<ScenarioRun> {
  const harness = createOneBotHarness({
    kind: "private",
    sendOutcomes: ["unknown"],
    model: [decideGenerate("20002"), say("你好")],
  });
  harness.receive({ id: "1", text: "在吗" });
  const result = await harness.activate("direct_reply");
  await harness.deliver();
  await harness.deliver();
  return snapshot("投递结果未知", harness, statusOf(result));
}

/**
 * 批评分低于门槛：**静默结束**（`no_output`），不是整轮失败（规格 §2.2：低分消费本批边界，
 * 与协议错误分开）。
 */
export async function belowThresholdButFinal(): Promise<ScenarioRun> {
  const harness = createOneBotHarness({
    initiativeBatchTargetCount: 1,
    initiativeBatchJitterCount: 0,
    model: [],
  });
  harness.receive({ id: "1", speaker: "20002", text: "无关的话" });
  harness.model?.push([
    batchScore([
      { targetId: "20002", score: 1, intent: "无实质内容", sourceSeqs: [harness.lastEventSeq] },
    ]),
  ]);
  harness.advance(3);
  let status = "missing";
  let error: string | null = null;
  try {
    status = statusOf(await harness.activate("chiming_in"));
  } catch (caught) {
    status = "threw";
    error = caught instanceof Error ? caught.message : String(caught);
  }
  await harness.deliver();
  return snapshot("低于门槛仍要求 final", harness, status, error);
}

/** 被 @ 之后他人插话：这一轮仍然回被叫到的人；@ 由显式 mentionIds 决定。 */
export async function addressedThenInterrupted(): Promise<ScenarioRun> {
  const harness = createOneBotHarness({
    model: [decideInline("20002", "好的", [], undefined, ["20002"])],
  });
  harness.receive({ id: "1", speaker: "20002", addressed: true, text: "帮我看看" });
  harness.receive({ id: "2", speaker: "20003", text: "我先说个别的" });
  const result = await harness.activate("direct_reply");
  await harness.deliver();
  return snapshot("被 @ 之后他人插话", harness, statusOf(result));
}

/**
 * 多人同时说话（规格 §2.2）：**一次**批评分覆盖本批全部候选，达标者各自进回复子 run，
 * 首 call 直接出正文、按目标显式 @。
 */
export async function multipleSpeakers(): Promise<ScenarioRun> {
  const harness = createOneBotHarness({
    mergeWindowSeconds: 2,
    initiativeBatchTargetCount: 1,
    initiativeBatchJitterCount: 0,
    model: [],
  });
  harness.receive({ id: "1", speaker: "20002", text: "甲的问题" });
  const seqA = harness.lastEventSeq;
  harness.advance(1);
  harness.receive({ id: "2", speaker: "20003", text: "乙的问题" });
  const seqB = harness.lastEventSeq;
  harness.model?.push([
    batchScore([
      { targetId: "20002", score: 9, intent: "甲在提问", sourceSeqs: [seqA] },
      { targetId: "20003", score: 7, intent: "乙也在提问", sourceSeqs: [seqB] },
    ]),
    decideInline("20002", "回甲", [], undefined, ["20002"]),
    decideInline("20003", "回乙", [], undefined, ["20003"]),
  ]);
  harness.advance(3);
  const result = await harness.activate("chiming_in");
  await harness.deliver();
  return snapshot("多人同时说话", harness, statusOf(result));
}

/**
 * 多人同时说话、**都未达门槛**：所有人都被程序挡下（静默），唤醒不该被记成失败，
 * 其他已成熟参与者的机会也该在本轮一并结算（不留 pending、下轮不再重判）。
 */
export async function multipleSilentBelowThreshold(): Promise<ScenarioRun> {
  const harness = createOneBotHarness({
    mergeWindowSeconds: 2,
    initiativeBatchTargetCount: 1,
    initiativeBatchJitterCount: 0,
    model: [],
  });
  harness.receive({ id: "1", speaker: "20002", text: "随意说说甲" });
  const seqA = harness.lastEventSeq;
  harness.advance(1);
  harness.receive({ id: "2", speaker: "20003", text: "随意说说乙" });
  const seqB = harness.lastEventSeq;
  harness.model?.push([
    batchScore([
      { targetId: "20002", score: 1, intent: "闲聊", sourceSeqs: [seqA] },
      { targetId: "20003", score: 1, intent: "闲聊", sourceSeqs: [seqB] },
    ]),
  ]);
  harness.advance(3);
  const result = await harness.activate("chiming_in");
  await harness.deliver();
  return snapshot("多人都未达门槛且沉默", harness, statusOf(result));
}

/**
 * 混合结果：一人达门槛开口、一人未达门槛被挡下。整轮是 `completed`，但**被挡下的那个目标**
 * 只是故意不开口——它的唤醒语义仍是静默，不该被按目标结算成失败；开口的目标照常。
 */
export async function mixedSilentAndSpeaking(): Promise<ScenarioRun> {
  const harness = createOneBotHarness({
    mergeWindowSeconds: 2,
    initiativeBatchTargetCount: 1,
    initiativeBatchJitterCount: 0,
    model: [],
  });
  harness.receive({ id: "1", speaker: "20002", text: "甲的问题" });
  const seqA = harness.lastEventSeq;
  harness.advance(1);
  harness.receive({ id: "2", speaker: "20003", text: "乙的问题" });
  const seqB = harness.lastEventSeq;
  harness.model?.push([
    batchScore([
      { targetId: "20002", score: 9, intent: "甲在提问", sourceSeqs: [seqA] },
      { targetId: "20003", score: 1, intent: "闲聊", sourceSeqs: [seqB] },
    ]),
    // 只有达标目标进回复子 run；未达标者不派发、不计失败。
    decideInline("20002", "回甲", [], undefined, ["20002"]),
  ]);
  harness.advance(3);
  const result = await harness.activate("chiming_in");
  await harness.deliver();
  return snapshot("混合：一人开口一人未达门槛", harness, statusOf(result));
}

/** 会话暂停：零模型调用、不产生唤醒。 */
export async function pausedConversation(): Promise<ScenarioRun> {
  const harness = createOneBotHarness({ model: [decideNone()] });
  harness.db.query("UPDATE qq_bindings SET paused=1 WHERE id=?").run(harness.bindingId);
  harness.receive({ id: "1", speaker: "20002", addressed: true, text: "在吗" });
  const result = await harness.activate("direct_reply");
  return snapshot("会话暂停", harness, result === null ? "no_wake" : statusOf(result));
}

/**
 * 冷场发起（规格 §2.5）：安静满时长后扫描排程，一次判断（批评分形状）过门槛后
 * 直接进回复任务出正文；面向整间会话，脚本不给 mentionIds＝不加 @。
 */
export async function idleTopic(): Promise<ScenarioRun> {
  // 冷场不经自主计数门槛：本场景只走**纯计数**的自主维度（时间窗关闭），单条消息（低于
  // 条数下界 10）因此不成自主机会，会话保持安静，冷场门槛才是唯一的判据。时间维的
  // 「一条消息也能排进未来自主批」由 onebot-opportunity 的时间窗用例覆盖，不在这里混。
  const harness = createOneBotHarness({ model: [], initiativeTimeWindowEnabled: false });
  harness.receive({ id: "1", speaker: "20002", text: "随便说说" });
  const seq = harness.lastEventSeq;
  harness.model?.push([
    batchScore([{ targetId: "30003", score: 8, intent: "没人说话想开个话题", sourceSeqs: [seq] }]),
    decideInline("30003", "好久没人说话了"),
  ]);
  harness.advance(3);
  harness.advance(901);
  harness.sweep();
  const result = await harness.activate("idle_topic");
  await harness.deliver();
  return snapshot("冷场发起", harness, statusOf(result));
}

/** 生成期间来了新消息：这一轮回到决策，最终发改过的那版。 */
export async function newMessageDuringGeneration(): Promise<ScenarioRun> {
  const harness = createOneBotHarness({
    model: [
      decideGenerate("20002", "respond", undefined, undefined, ["20002"]),
      say("第一版", () => harness.receive({ id: "9", speaker: "20002", text: "对了，还有个事" })),
      decideGenerate("20002", "respond", undefined, undefined, ["20002"]),
      say("第二版"),
    ],
  });
  harness.receive({ id: "1", speaker: "20002", addressed: true, text: "帮我看看" });
  const result = await harness.activate("direct_reply");
  await harness.deliver();
  return snapshot("生成期间来了新消息", harness, statusOf(result));
}

/** 重启后待发意图仍可投递：进程内状态丢掉，库里的计划还在。 */
export async function pendingIntentSurvivesRestart(): Promise<ScenarioRun> {
  const harness = createOneBotHarness({
    kind: "private",
    model: [decideGenerate("20002"), say("你好")],
  });
  harness.receive({ id: "1", text: "在吗" });
  await harness.activate("direct_reply");
  harness.restart();
  await harness.deliver();
  return snapshot("重启后待发意图仍可投递", harness, "completed");
}

/**
 * 媒体读失败与补充重读（0.4.0 §8.11，工具优先版）：
 *   ① 群友发图（没叫她）→ 自主接话里主 Agent 走真工具：`media.list→media.describe` 失败后
 *      想发布，被"读过却没读出"的闸门在提交处挡下——整轮以 `MEDIA_READ_FAILED` 失败结束，
 *      零发送（发布从未到达群里）；
 *   ② 更晚且叫她看图的补充到来 → **直接回应路径**（闸门不拦直接回应）里 `list→describe`
 *      重读成功（第二次也是最后一次尝试）→ `note.read` 读到说明 → `final` 收口（显式 stickerIds:[]）。
 * 视觉结果仍是合成桩；缓存复用、尝试计数、补充判定与闸门全走宿主真实代码。
 */
export async function mediaReadFailureThenSupplement(): Promise<ScenarioRun> {
  const harness = createOneBotHarness({
    initiativeBatchTargetCount: 1,
    initiativeBatchJitterCount: 0,
    vision: ["fail", "图里是一只猫"],
    model: [],
    mediaInput: {
      mode: "native",
      stages: { decision: false, evaluation: false, generation: false },
    },
  });
  let mediaId: string | null = null;
  driveToolFirst(harness, (observation) => {
    if (observation?.name === "media.list" && observation.value?.status === "ok") {
      const item = observation.value.items?.[0];
      if (item?.id !== undefined) {
        mediaId = item.id;
        return [decideInvoke("media.describe", { id: item.id })];
      }
      return [decideNone()];
    }
    if (observation?.name === "media.describe") {
      const status = observation.value?.status;
      if (status === "described" && mediaId !== null)
        return [decideInvoke("media.note.read", { id: mediaId })];
      // 读失败：想发布就会被闸门在提交处挡下（这一轮以失败结束）。
      if (status === "failed") return [decideGenerate("20002")];
    }
    if (observation?.name === "media.note.read" && observation.value?.status === "ok")
      return [decideInline("20002", "看到了，是只猫", [], undefined, ["20002"])];
    return null;
  });

  // ① 群友发了图和一句话、没叫她：批评分先行（规格 §2.2），回复任务里模型先读图，失败后发布被闸。
  harness.receive({ id: "1", speaker: "20002", text: "看这个", image: "upstream-1" });
  harness.advance(3);
  harness.model?.push([
    batchScore([
      { targetId: "20002", score: 7, intent: "想看看这张图", sourceSeqs: [harness.lastEventSeq] },
    ]),
    decideInvoke("media.list", {}),
  ]);
  let blockedNote: string;
  try {
    blockedNote = statusOf(await harness.activate("chiming_in"));
  } catch (error) {
    blockedNote = `failed:${(error as { code?: string }).code ?? "unknown"}`;
  }
  const blockedRun = harness.runs
    .listRuns({ ownerKind: "conversation", ownerId: harness.conversationId })
    .find((run) => run.errorCode === "MEDIA_READ_FAILED");
  if (blockedRun === undefined) throw new Error("缺少被媒体闸门挡下的运行");

  // ② 更晚、明确叫她看这张图的补充：直接回应路径重读一次（最后一次尝试）并收口。
  harness.advance(1);
  harness.receive({ id: "2", speaker: "20002", addressed: true, text: "就是这张，你看下" });
  harness.model?.push([decideInvoke("media.list", {})]);
  const result = await harness.activate("direct_reply");
  await harness.deliver();
  return snapshot("媒体读失败与补充读取", harness, statusOf(result), null, blockedNote);
}

/**
 * 重跑同一个机会只有一条回复（0.4.0 P1 的幂等键）：
 * 第一轮把回复提交成"计划中"但还没投递，然后模拟崩溃重排——同一份入站事实再唤醒一次。
 * 没有幂等键时群里会收到两条；有了它，计划中的那条被新一轮内容替换，最终只发一条（新版）。
 */
export async function rerunKeepsSingleReply(): Promise<ScenarioRun> {
  const harness = createOneBotHarness({
    kind: "private",
    model: [decideGenerate("20002"), say("第一版")],
  });
  harness.receive({ id: "1", text: "在吗" });
  await harness.activate("direct_reply");
  const planned = harness.outbox.list({}).length;

  harness.restart();
  harness.model?.push([decideGenerate("20002"), say("第二版")]);
  harness.wakes.enqueue({
    conversationId: harness.conversationId,
    cause: "direct_reply",
    dedupeKey: "rerun-same-opportunity",
    throughSeq: harness.lastEventSeq,
    readyAt: harness.now(),
    priority: 100,
    at: harness.now(),
  });
  const result = await harness.activate("direct_reply");
  await harness.deliver();
  return snapshot("重跑同一机会只有一条回复", harness, statusOf(result), null, `first=${planned}`);
}

/**
 * 记忆更正后旧正文不可复活（0.4.0 P5，从 P0 前移；取数改为主 Agent 显式 query→read→final）：
 *   ① 第一轮 query 拿候选，read 的 bodyRef 从上一 action_observation 解析，旧正文真的进了上下文；
 *   ② 人工纠正后：新轮只取到更正行（候选列表里没有已退休的旧行），正文只剩更正后的；
 *   ③ 模型复用第一轮的旧引用再读：整轮硬失败关闭（CONTEXT_INVALID_SELECTION），旧正文不会被"猜"回来。
 */
export async function memoryCorrection(): Promise<ScenarioRun> {
  const harness = createOneBotHarness({ kind: "private", model: [] });
  const memoryId = harness.memory("错误金额999元", { name: "订单金额", summary: "用户订单金额" });

  let oldBodyRef: string | null = null;
  let reply = "金额我再确认一下";
  let staleRound = false;
  driveToolFirst(harness, (observation) => {
    if (observation?.name === "memory.query" && observation.value?.status === "ok") {
      const item = observation.value.items?.[0];
      if (staleRound && oldBodyRef !== null) {
        return [decideInvoke("memory.read", { bodyRef: oldBodyRef, offset: 0, limit: 4096 })];
      }
      if (item?.bodyRef !== undefined) {
        if (oldBodyRef === null) oldBodyRef = item.bodyRef;
        return [decideInvoke("memory.read", { bodyRef: item.bodyRef, offset: 0, limit: 4096 })];
      }
      return [decideGenerate("20002"), say("这轮没有可用记忆")];
    }
    if (observation?.name === "memory.read" && observation.value?.status === "ok") {
      return [decideGenerate("20002"), say(reply)];
    }
    return null;
  });

  harness.model?.push([decideInvoke("memory.query", { query: "订单金额" })]);
  harness.receive({ id: "1", text: "订单金额是多少" });
  const first = await harness.activate("direct_reply");
  await harness.deliver();

  harness.correctMemory(memoryId, {
    name: "订单金额",
    summary: "用户订单金额（已更正）",
    tags: [],
    body: "正确金额80元",
  });
  reply = "这是更正后的金额";
  harness.model?.push([decideInvoke("memory.query", { query: "订单金额" })]);
  harness.receive({ id: "2", text: "订单金额是多少" });
  const second = await harness.activate("direct_reply");
  await harness.deliver();

  // ③ 旧引用已不属于任何一轮授权查询：read 抛 CONTEXT_INVALID_SELECTION，整轮失败关闭；
  //    前两轮照常投递，旧正文不会借这个引用复活。
  staleRound = true;
  harness.model?.push([decideInvoke("memory.query", { query: "错误金额" })]);
  harness.receive({ id: "3", text: "订单金额是多少" });
  let third: string;
  try {
    third = statusOf(await harness.activate("direct_reply"));
  } catch (error) {
    third = `failed:${(error as { code?: string }).code ?? "unknown"}`;
  }
  await harness.deliver();
  return snapshot(
    "记忆更正后旧正文不可复活",
    harness,
    `${statusOf(first)}/${statusOf(second)}/${third}`,
  );
}

/**
 * 资料撤权后不再进上下文（0.4.0 P5，从 P0 前移；取数改为主 Agent 显式 query→read→final）：
 *   ① 已授权的资料：query→read 后正文进了上下文；
 *   ② 撤权之后：新 query 返回空候选，生成里不再有正文（失败关闭＝直接看不见，不是换个说法）。
 */
export async function knowledgeRevocation(): Promise<ScenarioRun> {
  const harness = createOneBotHarness({ kind: "private", model: [] });
  const documentId = harness.knowledge("价格手册", "苹果单价是每斤八元");

  driveToolFirst(harness, (observation) => {
    if (observation?.name === "knowledge.query" && observation.value?.status === "ok") {
      const item = observation.value.items?.[0];
      if (item?.bodyRef !== undefined) {
        return [decideInvoke("knowledge.read", { bodyRef: item.bodyRef, offset: 0, limit: 4096 })];
      }
      // 撤权后候选为空：收口说"查不到"，而不是把原文换个说法编出来。
      return [decideGenerate("20002"), say("这个我查不到了")];
    }
    if (observation?.name === "knowledge.read" && observation.value?.status === "ok") {
      return [decideGenerate("20002"), say("每斤八元")];
    }
    return null;
  });

  harness.model?.push([decideInvoke("knowledge.query", { query: "苹果" })]);
  harness.receive({ id: "1", text: "苹果多少钱一斤" });
  const first = await harness.activate("direct_reply");
  await harness.deliver();

  harness.revokeKnowledge(documentId);
  harness.model?.push([decideInvoke("knowledge.query", { query: "苹果" })]);
  harness.receive({ id: "2", text: "苹果多少钱一斤" });
  const second = await harness.activate("direct_reply");
  await harness.deliver();
  return snapshot("资料撤权后不再进上下文", harness, `${statusOf(first)}/${statusOf(second)}`);
}

/**
 * 真纯图负例（wire 无 text 段，receive text:null）：同秒同人两条纯图（不同 message id →
 * 不同 eventKey/fileRef，身份稳定性由真实 source 裁定，夹具不猜时间），批评分后回复任务
 * 逐张读图——一失败一成功，模型经 terminal speech.reply 尝试发布——失败图必须在提交处
 * 挡下：整轮 MEDIA_READ_FAILED、零出站、零发送、恰两次视觉调用。
 * 不入 ALL_SCENARIOS（基线记录器消费面不变），只由 owned 断言文件接线。
 */
export async function mediaReadFailureImageOnly(): Promise<ScenarioRun> {
  const harness = createOneBotHarness({
    initiativeBatchTargetCount: 1,
    initiativeBatchJitterCount: 0,
    vision: ["fail", "图里是一只猫"],
    model: [],
    mediaInput: {
      mode: "native",
      stages: { decision: false, evaluation: false, generation: false },
    },
  });
  // 逐张描述已列出的图；全部描述完（一失败一成功）仍尝试经 terminal 发布。
  const listed: string[] = [];
  const described: string[] = [];
  driveToolFirst(harness, (observation) => {
    if (observation?.name === "media.list" && observation.value?.status === "ok") {
      for (const item of observation.value.items ?? [])
        if (item?.id !== undefined) listed.push(item.id);
      const first = listed[0];
      return first === undefined ? [decideNone()] : [decideInvoke("media.describe", { id: first })];
    }
    if (observation?.name === "media.describe") {
      described.push(observation.value?.status ?? "unknown");
      const next = listed[described.length];
      if (next !== undefined) return [decideInvoke("media.describe", { id: next })];
      return [
        decideInvoke("speech.reply", {
          outputs: [{ kind: "inline", targetId: "20002", text: "看到了图", stickerIds: [] }],
        }),
      ];
    }
    return null;
  });
  // 同秒同人两条真纯图：同一 clock tick 内连续落库，稳定身份只能来自真实 eventKey；
  // 引用 seq 逐条捕获（两次入站之间夹着 wake 事件，不能按差值猜）。
  harness.receive({ id: "1", speaker: "20002", image: "upstream-1", text: null });
  const seqFirst = harness.lastEventSeq;
  harness.receive({ id: "2", speaker: "20002", image: "upstream-2", text: null });
  const seqSecond = harness.lastEventSeq;
  harness.model?.push([
    batchScore([
      {
        targetId: "20002",
        score: 7,
        intent: "想看看这两张图",
        sourceSeqs: [seqFirst, seqSecond],
      },
    ]),
    decideInvoke("media.list", {}),
  ]);
  harness.advance(3);
  let status = "missing";
  let error: string | null = null;
  try {
    status = statusOf(await harness.activate("chiming_in"));
  } catch (caught) {
    status = "failed";
    error = (caught as { code?: string }).code ?? String(caught);
  }
  await harness.deliver();
  return snapshot("真纯图读失败发布被闸", harness, status, error);
}

/** 全部 P0 场景，顺序固定（基线与测试都按这个顺序走）。 */
export const ALL_SCENARIOS: readonly (() => Promise<ScenarioRun>)[] = Object.freeze([
  privateDirectReply,
  groupAddressed,
  groupUnsplitReply,
  chimingInAboveThreshold,
  chimingInSilent,
  deliveryUnknown,
  belowThresholdButFinal,
  addressedThenInterrupted,
  multipleSpeakers,
  pausedConversation,
  multipleSilentBelowThreshold,
  mixedSilentAndSpeaking,
  idleTopic,
  newMessageDuringGeneration,
  pendingIntentSurvivesRestart,
  mediaReadFailureThenSupplement,
  rerunKeepsSingleReply,
  memoryCorrection,
  knowledgeRevocation,
]);
