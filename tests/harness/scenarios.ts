// P0 场景的**唯一驱动源**：每条场景只写一遍，两个消费者共用——
//   * `tests/integration/onebot-harness.test.ts` 读它并加断言；
//   * `tools/verify/record-0.4.0-baseline.ts` 读它并把指标写成 JSON（P8 新旧对照的"旧"这一侧）。
//
// 场景只描述"收到什么、模型回什么、按什么顺序"，不写断言：断言属于测试，指标属于基线。

import type { ModelMessage } from "../../src/shared/contracts/agent-run";
import {
  decideGenerate,
  decideGenerateMany,
  decideInvoke,
  decideNone,
  type ModelStep,
  say,
  scoreOf,
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
  /** 唤醒给的"为什么没开口"（如 `media_read_failed`）：诊断要看的就是这个。 */
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

/** 唤醒返回的 `reason`（没开口时给的原因），没有就是 `null`。 */
export function reasonOf(result: unknown): string | null {
  if (result === null || typeof result !== "object" || !("reason" in result)) return null;
  const reason = (result as { reason: unknown }).reason;
  return typeof reason === "string" ? reason : null;
}

/** `action_observation` 的载荷：工具结果 + 只带结果自身的来源。 */
export interface ActionObservation {
  readonly name?: string;
  readonly value?: {
    readonly status?: string;
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
function driveToolFirst(
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
    model: [decideGenerate("20002"), say("在的，怎么了")],
  });
  harness.receive({ id: "1", text: "在吗" });
  const result = await harness.activate("direct_reply");
  await harness.deliver();
  return snapshot("私聊直接回应", harness, statusOf(result));
}

/** 群聊被 @：按发言人拆开、换行折叠、`@` 加在部件上。 */
export async function groupAddressed(): Promise<ScenarioRun> {
  const harness = createOneBotHarness({
    model: [decideGenerate("20002"), say("收到\n马上看")],
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
    model: [decideGenerate("30003"), say("第一句\n第二句")],
  });
  harness.receive({ id: "1", speaker: "20002", addressed: true, text: "在吗" });
  const result = await harness.activate("direct_reply");
  await harness.deliver();
  return snapshot("群聊整轮一条回复", harness, statusOf(result));
}

/**
 * 自主接话达门槛：意图 → **程序触发**许可 → 写正文（0.4.0 P4 §4.1）。
 * 模型只产出意图（generate 的 instructions），评分由程序在写正文之前发出。
 */
export async function chimingInAboveThreshold(): Promise<ScenarioRun> {
  const harness = createOneBotHarness({
    model: [decideGenerate("20002"), scoreOf(9), say("这个我知道")],
  });
  harness.receive({ id: "1", speaker: "20002", text: "有人知道这个怎么弄吗" });
  harness.advance(3);
  const result = await harness.activate("chiming_in");
  await harness.deliver();
  return snapshot("自主接话达门槛", harness, statusOf(result));
}

/** 自主接话时模型自己判断没什么可说：直接 none（零评分调用），不留待发意图。 */
export async function chimingInSilent(): Promise<ScenarioRun> {
  const harness = createOneBotHarness({ model: [decideNone()] });
  harness.receive({ id: "1", speaker: "20002", text: "今天天气不错" });
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

/** 低于门槛仍要求 final：许可不通过＝**静默结束**（`no_output`），不是整轮失败（§4.1 已落）。 */
export async function belowThresholdButFinal(): Promise<ScenarioRun> {
  const harness = createOneBotHarness({
    model: [decideGenerate("20002"), scoreOf(1)],
  });
  harness.receive({ id: "1", speaker: "20002", text: "无关的话" });
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

/** 被 @ 之后他人插话：这一轮仍然回被叫到的人。 */
export async function addressedThenInterrupted(): Promise<ScenarioRun> {
  const harness = createOneBotHarness({
    model: [decideGenerate("20002"), say("好的")],
  });
  harness.receive({ id: "1", speaker: "20002", addressed: true, text: "帮我看看" });
  harness.receive({ id: "2", speaker: "20003", text: "我先说个别的" });
  const result = await harness.activate("direct_reply");
  await harness.deliver();
  return snapshot("被 @ 之后他人插话", harness, statusOf(result));
}

/** 多人同时说话：逐人评分、逐人回复。 */
export async function multipleSpeakers(): Promise<ScenarioRun> {
  const harness = createOneBotHarness({
    mergeWindowSeconds: 2,
    // 程序按目标逐个走"许可 → 写正文"，所以脚本也按这个顺序交错。
    model: [
      decideGenerateMany(["20002", "20003"]),
      scoreOf(9),
      say("回甲"),
      scoreOf(7),
      say("回乙"),
    ],
  });
  harness.receive({ id: "1", speaker: "20002", text: "甲的问题" });
  harness.advance(1);
  harness.receive({ id: "2", speaker: "20003", text: "乙的问题" });
  harness.advance(3);
  const result = await harness.activate("chiming_in");
  await harness.deliver();
  return snapshot("多人同时说话", harness, statusOf(result));
}

/** 会话暂停：零模型调用、不产生唤醒。 */
export async function pausedConversation(): Promise<ScenarioRun> {
  const harness = createOneBotHarness({ model: [decideNone()] });
  harness.db.query("UPDATE qq_bindings SET paused=1 WHERE id=?").run(harness.bindingId);
  harness.receive({ id: "1", speaker: "20002", addressed: true, text: "在吗" });
  const result = await harness.activate("direct_reply");
  return snapshot("会话暂停", harness, result === null ? "no_wake" : statusOf(result));
}

/** 冷场发起：安静满时长后扫描排程，面向整间会话、不加 @。 */
export async function idleTopic(): Promise<ScenarioRun> {
  const harness = createOneBotHarness({
    model: [decideNone(), decideGenerate("30003"), scoreOf(8), say("好久没人说话了")],
  });
  harness.receive({ id: "1", speaker: "20002", text: "随便说说" });
  harness.advance(3);
  await harness.activate("chiming_in");
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
      decideGenerate("20002"),
      say("第一版", () => harness.receive({ id: "9", speaker: "20002", text: "对了，还有个事" })),
      decideGenerate("20002"),
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
 * 媒体读失败与补充读取：
 *   ① 群友发的图读一次失败 → 这一轮自主接话被"媒体闸门"按住（零模型调用）；
 *   ② 同一人接着叫她看图（仍在补充窗口内、且是叫她）→ 第二次读取成功，说明落库；
 *   ③ 她再开口 → 这一轮放行，且媒体说明真的进了模型看到的上下文。
 */
export async function mediaReadFailureThenSupplement(): Promise<ScenarioRun> {
  const harness = createOneBotHarness({
    vision: ["fail", "图里是一只猫"],
    model: [decideGenerate("20002"), scoreOf(9), say("看到了，是只猫")],
  });
  harness.receive({ id: "1", speaker: "20002", text: "看这个", image: "upstream-1" });
  await harness.understandMedia();
  harness.advance(3);
  const blocked = await harness.activate("chiming_in");
  const blockedNote = reasonOf(blocked);

  harness.receive({ id: "2", speaker: "20002", addressed: true, text: "就是这张，你看下" });
  await harness.understandMedia();
  harness.receive({ id: "3", speaker: "20002", text: "你们觉得呢" });
  harness.advance(3);
  const result = await harness.activate("chiming_in");
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
  idleTopic,
  newMessageDuringGeneration,
  pendingIntentSurvivesRestart,
  mediaReadFailureThenSupplement,
  rerunKeepsSingleReply,
  memoryCorrection,
  knowledgeRevocation,
]);
