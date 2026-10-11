// P3 独立端到端验证（qq-parallel-media 批次，p3-task-execution-tests）：真实
// createOneBotConversationRuntime 装配 + AgentRuntime + ConversationHost + 业务库 +
// QqSendPort 闭桩，验证**同一发送人的两条 @ 消息作为两条 mention 任务真实并行执行**——
// 不是登记即止：两条任务同时 running、各自冻结的执行快照互相独立、模型调用与出站提交/
// 投递按任务各自结算。夹具组成复用 qq-batch-first-e2e 的真实装配形状（同库克隆、同设置/
// 绑定/方案写法、同 Promise 阀门并发证明），不复制任何生产源码。不接真实 QQ/模型/网络；
// 模型是受控 ModelPort 桩：决策调用按 responseSchema 的 decision envelope 形状识别并挂
// 阀门（请求文本里的 marker 只做路由核对，不做存在性断言——上下文历史允许带别的消息），
// 辅助叶子调用走既有 scripted 空答复；时钟取当前 epoch 真值（TTL/新鲜度/租约全链同一
// 时间源），无 shell sleep。

import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { AgentRuntime } from "../../src/server/agent/agent-runtime";
import { ConversationHost } from "../../src/server/agent/conversation-host";
import type { ModelPort, ModelRequest } from "../../src/server/agent/model-port";
import { OneBot11Adapter } from "../../src/server/channels/onebot11/adapter";
import { createOneBotConversationRuntime } from "../../src/server/channels/onebot11/create-runtime";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import type { BusinessDbHandle } from "../../src/server/db/connection";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { OutboundIntentRepository } from "../../src/server/db/outbound-intent-repository";
import { createQqScheme } from "../../src/server/db/qq-scheme-repository";
import { updateQqSettings } from "../../src/server/db/qq-settings-repository";
import { DEFAULT_AGENT_ID, ensureDefaults } from "../../src/server/db/repositories";
import { WakeRepository } from "../../src/server/db/wake-repository";
import { normalizeOneBotMessage } from "../../src/server/services/onebot-protocol";
import { recordInbound } from "../../src/server/services/qq-intake";
import { QqStickerStore } from "../../src/server/services/qq-sticker-store";
import { cloneBusinessDb } from "../harness/business-db";
import { scriptedModel } from "../harness/model";

const ACCOUNT_ID = "10001";

type TaskRow = {
  id: string;
  status: string;
  error_code: string | null;
  source_from_seq: number;
  source_through_seq: number;
  origin_event_key: string | null;
  origin_run_id: string | null;
  platform_message_id: string | null;
  claimed_at: string | null;
  lease_token: string | null;
  execution_snapshot: string | null;
};

const taskRows = (db: Database): TaskRow[] =>
  db
    .query(
      "SELECT id,status,error_code,source_from_seq,source_through_seq,origin_event_key,origin_run_id,platform_message_id,claimed_at,lease_token,execution_snapshot FROM qq_conversation_tasks ORDER BY rowid",
    )
    .all() as TaskRow[];

/** 紧凑源 trace：任务终态/焦点 seq/run + 出站意图 st/status/stale_reason/ack，供报告分层。 */
const emitTrace = (label: string, db: Database) => {
  const tasks = taskRows(db).map((t) => ({
    platform_message_id: t.platform_message_id,
    status: t.status,
    error_code: t.error_code,
    focus_seq: t.source_through_seq,
    run_id: t.origin_run_id?.slice(0, 8) ?? null,
  }));
  const intents = db
    .query(
      "SELECT i.source_through_seq AS focus_seq,i.speech_kind AS kind,i.status,i.stale_reason AS reason,i.legacy_send_id AS ack,substr(i.run_id,1,8) AS run FROM outbound_intents i ORDER BY i.created_at,i.output_ordinal",
    )
    .all();
  const parts = db
    .query(
      "SELECT i.source_through_seq AS focus_seq,p.status,p.platform_message_id AS ack FROM outbound_parts p JOIN outbound_intents i ON i.id=p.intent_id ORDER BY i.created_at,p.ordinal",
    )
    .all();
  console.error(`[task-execution-trace ${label}]`, JSON.stringify({ tasks, intents, parts }));
};

/** 决策调用判据：responseSchema 声明 decision envelope（oneOf 决策分支）的那一类调用。 */
const isDecisionRequest = (request: ModelRequest): boolean => {
  const schema = request.responseSchema as { oneOf?: unknown } | undefined;
  return Array.isArray(schema?.oneOf);
};

/** 回复 run 授权材料里的目标（群聊按发言人拆分，取成员 QQ 号）。 */
const authorizedTargetOf = (request: ModelRequest): string =>
  JSON.stringify(request.messages)
    .replace(/\\/g, "")
    .match(/authorizedTargets":\["(\d+)/)?.[1] ?? "20002";

const inlineFinal = (targetId: string, text: string) =>
  JSON.stringify({ kind: "final", outputs: [{ kind: "inline", targetId, text }] });

/** 有限防永挂等待：仅用于观察异步推进，超时即失败（不用无限轮询）。 */
const waitFor = async (predicate: () => boolean, timeoutMs = 3000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("WAIT_TIMEOUT");
    await Bun.sleep(5);
  }
};

const pendingGates: (() => void)[] = [];
const composed: ReturnType<typeof createOneBotConversationRuntime>[] = [];
const handles: BusinessDbHandle[] = [];
afterEach(async () => {
  // 先放行全部阀门让在飞桩调用落地，再停调度器并等在飞任务结算，最后才关库。
  for (const release of pendingGates.splice(0)) release();
  for (const bot of composed.splice(0)) {
    bot.scheduler.stop();
    await bot.scheduler.waitForIdle().catch(() => {});
    bot.delivery.stop();
    await bot.delivery.waitForIdle().catch(() => {});
    bot.release();
  }
  for (const h of handles.splice(0)) h.close();
});

/**
 * 可控阀门：决策调用停在阀门上证明并发；超时受 4s 上界（旧 Bun 用例超时 5s 之内）。
 * 已结算后 finally 清掉计时器，不留下 pending timer。
 */
const controlledGate = () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
    pendingGates.push(release);
  });
  const bounded = (code: string) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      gate,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(code)), 4000);
      }),
    ]).finally(() => clearTimeout(timer));
  };
  return { gate, release, bounded };
};

function setup(options: { model: ModelPort }) {
  const h = cloneBusinessDb();
  handles.push(h);
  ensureDefaults(h.orm, "reply-model");
  updateQqSettings(h.orm, { accountId: ACCOUNT_ID, enabled: true, expectedRevision: 1 });
  // 当前 epoch 真值时钟：adapter 新鲜度/观察 TTL 与宿主/调度器真实时钟同源。
  const clock = { seconds: Math.floor(Date.now() / 1000) };
  const journal = new ConversationEventRepository(h.db),
    wakes = new WakeRepository(h.db),
    outbox = new OutboundIntentRepository(h.db),
    runs = new AgentRunRepository(h.db);
  const adapter = new OneBot11Adapter({
    orm: h.orm,
    journal,
    wakes,
    nowSeconds: () => clock.seconds,
  });
  const makeBinding = (
    peerId: number,
    binding: {
      schemeName: string;
      taskLimits?: { mention_task_limit: number; ordinary_task_limit: number };
    } = { schemeName: "task-execution-e2e" },
  ) => {
    const scheme = createQqScheme(h.orm, {
      name: binding.schemeName,
      triggers: { direct_reply: true, follow_up: false, chiming_in: false, idle_topic: false },
      reply: { split_by_speaker: true },
      ...(binding.taskLimits ? { taskLimits: binding.taskLimits } : {}),
    });
    const bindingId = crypto.randomUUID();
    h.db
      .query(
        "INSERT INTO qq_bindings(id,account_id,conversation_kind,peer_id,agent_id,scheme_id,created_at,updated_at) VALUES(?,'10001','group',?,?,?,?,?)",
      )
      .run(
        bindingId,
        String(peerId),
        DEFAULT_AGENT_ID,
        scheme.id,
        new Date(clock.seconds * 1000).toISOString(),
        new Date(clock.seconds * 1000).toISOString(),
      );
    return bindingId;
  };
  const receive = (group: number, messageId: string, speaker: string, text: string) => {
    const normalized = normalizeOneBotMessage(
      {
        post_type: "message",
        message_type: "group",
        sub_type: "normal",
        time: clock.seconds,
        self_id: 10001,
        user_id: Number(speaker),
        group_id: group,
        message_id: messageId,
        message: [
          { type: "at", data: { qq: "10001" } },
          { type: "text", data: { text } },
        ],
        sender: { nickname: speaker },
      },
      ACCOUNT_ID,
    );
    expect(normalized.kind).toBe("message");
    return recordInbound(h.orm, normalized, {
      accountId: ACCOUNT_ID,
      conversationIngress: adapter,
    });
  };
  const compose = () => {
    const sends: { target: string | undefined; request: unknown }[] = [];
    const runtime = new AgentRuntime({
      repository: runs,
      now: () => new Date().toISOString(),
      model: options.model,
    });
    const gateway = {
      complete: async () => {
        throw new Error("UNIFIED_RUNTIME_REQUIRED");
      },
      loadedContextCapacity: async () => 65536,
    };
    const bot = createOneBotConversationRuntime({
      orm: h.orm,
      db: h.db,
      gateway,
      agentRuntime: runtime,
      host: new ConversationHost({ runtime }),
      journal,
      store: new QqStickerStore({ directory: "synthetic-qq-stickers" }),
      port: {
        async send(request) {
          sends.push({ target: request.peerId, request });
          return { kind: "confirmed", messageId: String(100000 + sends.length) };
        },
      },
      wake: () => {},
      policy: () => ({
        maxSteps: 20,
        deliveryTtlSeconds: 600,
        retryDelayMs: 1000,
        maxAttempts: 3,
        globalConcurrency: 4,
        modelCallConcurrency: 1,
      }),
    });
    composed.push(bot);
    return { bot, sends };
  };
  return { orm: h.orm, db: h.db, journal, wakes, outbox, makeBinding, receive, compose };
}

/** 每条决策请求里程序写的激活触发（activation_trigger dump 的 value）。 */
type ActivationTrigger = {
  sourceId: string;
  seq: number;
  cause: string;
  text: string | null;
};

/** 从决策请求的 user text part 里提取 activation_trigger dump（找不到＝null）。 */
const activationTriggerOf = (request: ModelRequest): ActivationTrigger | null => {
  for (const message of request.messages ?? []) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part?.kind !== "text" || typeof part.text !== "string") continue;
      try {
        const dump = JSON.parse(part.text) as {
          kind?: string;
          value?: Record<string, unknown>;
        };
        if (dump?.kind !== "activation_trigger" || dump.value === undefined) continue;
        return {
          sourceId: String(dump.value.sourceId ?? ""),
          seq: Number(dump.value.seq ?? -1),
          cause: String(dump.value.cause ?? ""),
          text: typeof dump.value.text === "string" ? dump.value.text : null,
        };
      } catch {
        // 非 dump 的普通文本 part：跳过。
      }
    }
  }
  return null;
};

/**
 * 决策桩：只把 responseSchema 为 decision envelope 的调用当决策调用；其余（辅助叶子）交
 * 既有 scripted 空答复。决策调用按**请求里的 activation_trigger.seq** 路由——每条任务的
 * 焦点来源 seq 唯一，历史里出现别的消息不改变本 run 的触发；没有登记路由的触发视为
 * 早任务的再决策，按其授权目标立即给终结答复。路由未命中且未给 fallback＝用例自己写错，
 * 让它吵。
 */
function decisionStub(
  routes: Map<
    number,
    (request: ModelRequest, trigger: ActivationTrigger) => Promise<string> | string
  >,
  routed: { seq: number; sourceId: string; request: ModelRequest }[],
): ModelPort {
  const aux = scriptedModel([]);
  return {
    complete: async (request) => {
      if (!isDecisionRequest(request)) return aux.port.complete(request);
      const trigger = activationTriggerOf(request);
      if (trigger === null) throw new Error("DECISION_CALL_WITHOUT_ACTIVATION_TRIGGER");
      routed.push({ seq: trigger.seq, sourceId: trigger.sourceId, request });
      const route = routes.get(trigger.seq);
      if (route === undefined) {
        return inlineFinal(authorizedTargetOf(request), "revised reply");
      }
      return route(request, trigger);
    },
    streamText: (request) => aux.port.streamText(request),
    completeMultimodal: async () => "",
  };
}

describe("qq task execution end to end (production composition)", () => {
  it("two same-sender @ messages execute as two concurrent tasks with independent focus; the fast sibling early-commits and delivers", async () => {
    const gateA = controlledGate();
    const gateB = controlledGate();
    const routed: { seq: number; sourceId: string; request: ModelRequest }[] = [];
    const routes = new Map<
      number,
      (request: ModelRequest, trigger: ActivationTrigger) => Promise<string> | string
    >();
    const model = decisionStub(routes, routed);
    const f = setup({ model });
    f.makeBinding(30003, { schemeName: "task-execution-overlap" });
    f.receive(30003, "91001", "20002", "FOCUS_MARKER_AAA one");
    const seqA = taskRows(f.db)[0]!.source_through_seq;
    routes.set(seqA, (request, trigger) => {
      // 焦点事实断言：触发 seq/因果/正文都来自任务 A 自己的 focus 来源。
      expect(trigger.seq).toBe(seqA);
      expect(trigger.cause).toBe("direct_reply");
      expect(trigger.text).toContain("FOCUS_MARKER_AAA");
      return gateA
        .bounded("A_GATE_TIMEOUT")
        .then(() => inlineFinal(authorizedTargetOf(request), "reply-AAA"));
    });
    expect(taskRows(f.db).map((t) => [t.status, t.platform_message_id])).toEqual([
      ["pending", "91001"],
    ]);

    const { bot, sends } = f.compose();
    expect(await bot.scheduler.dispatchOnce()).toBe(true);
    await waitFor(() => routed.length === 1);
    expect(taskRows(f.db)[0]!.status).toBe("running");

    // 第二条 @ 在 A 已进入生成后到达：登记为第二条 pending 任务（不合并、不顶替）。
    f.receive(30003, "91002", "20002", "FOCUS_MARKER_BBB two");
    const seqB = taskRows(f.db)[1]!.source_through_seq;
    routes.set(seqB, (request, trigger) => {
      expect(trigger.seq).toBe(seqB);
      expect(trigger.text).toContain("FOCUS_MARKER_BBB");
      return gateB
        .bounded("B_GATE_TIMEOUT")
        .then(() => inlineFinal(authorizedTargetOf(request), "reply-BBB"));
    });
    expect(taskRows(f.db).map((t) => [t.status, t.platform_message_id])).toEqual([
      ["running", "91001"],
      ["pending", "91002"],
    ]);
    expect(await bot.scheduler.dispatchOnce()).toBe(true);
    await waitFor(() => routed.length === 2);

    // 同时在飞：两条任务同时 running，租约与认领时刻真实落库。
    const mid = taskRows(f.db);
    expect(mid.map((t) => t.status)).toEqual(["running", "running"]);
    for (const row of mid) {
      expect(row.claimed_at).toBeTruthy();
      expect(row.lease_token).toBeTruthy();
    }
    // 焦点互相独立：不同 origin 事件、不同 source 窗口（mention 窗口＝单事件）。
    expect(mid[0]!.origin_event_key).not.toBe(mid[1]!.origin_event_key);
    expect(mid[0]!.source_through_seq).not.toBe(mid[1]!.source_through_seq);
    expect(mid[0]!.source_from_seq).toBe(mid[0]!.source_through_seq);
    expect(mid[1]!.source_from_seq).toBe(mid[1]!.source_through_seq);
    const snapshots = mid.map(
      (row) => JSON.parse(row.execution_snapshot!) as Record<string, unknown>,
    );
    for (const [index, snap] of snapshots.entries()) {
      expect(snap.taskClass).toBe("mention");
      expect(snap.cause).toBe("direct_reply");
      expect(snap.authorizedTargets).toEqual(["20002"]);
      expect(snap.targetParticipants).toEqual([{ targetId: "20002", speakerId: "20002" }]);
      expect(snap.sourceThroughSeq).toBe(mid[index]!.source_through_seq);
      expect(snap.mentionTaskLimit).toBe(4);
      expect(snap.ordinaryTaskLimit).toBe(1);
      expect(snap.taskKey).not.toBe(snapshots[1 - index]!.taskKey);
    }

    // 后到的 B 先生成完：不等慢 A，先提交并发送自己的回复（早提交语义）。
    gateB.release();
    await waitFor(() => sends.length === 1);
    expect(JSON.stringify(sends[0]!.request)).toContain("reply-BBB");
    expect(taskRows(f.db)[1]!.status).toBe("completed");
    expect(taskRows(f.db)[0]!.status).toBe("running");

    // 放行慢 A 后整链收口：两条任务都 completed，各一条出站意图、各一次真实投递。
    gateA.release();
    await bot.scheduler.waitForIdle();
    emitTrace("T1-overlap", f.db);
    const done = taskRows(f.db);
    expect(done.map((t) => t.status)).toEqual(["completed", "completed"]);
    const intents = f.db
      .query(
        "SELECT source_through_seq AS st,status,target FROM outbound_intents ORDER BY source_through_seq",
      )
      .all() as { st: number; status: string; target: string }[];
    // 两条出站意图各挂各任务的焦点 seq 且都确认投递：慢任务的回复不得被丢弃/改挂到
    // 别的消息 seq 上（普通历史展示可以带别消息，但出站归属必须是本任务焦点）。
    expect(intents.map((i) => [i.st, i.status])).toEqual([
      [seqA, "confirmed"],
      [seqB, "confirmed"],
    ]);
    expect(intents.every((i) => i.target.includes('"participantId":"20002"'))).toBe(true);
    expect(sends).toHaveLength(2);
    expect(JSON.stringify(sends[0]!.request)).toContain("reply-BBB");
    expect(JSON.stringify(sends[1]!.request)).toContain("reply-AAA");
    // 两条任务各自的 run 是独立两条（不是一次合并运行），各自挂在任务的 through seq 上。
    const runRows = f.db
      .query(
        "SELECT run_id,observed_seq FROM agent_runs WHERE spec_id LIKE 'onebot%' ORDER BY observed_seq",
      )
      .all() as { run_id: string; observed_seq: number }[];
    expect(new Set(runRows.map((r) => r.run_id)).size).toBe(2);
    expect(runRows.map((r) => r.observed_seq)).toEqual(
      done.map((t) => t.source_through_seq).sort((a, b) => a - b),
    );
    // direct_reply wake 全部随 mention 任务移交而终态（不再有待跑机会残留）。
    expect(
      f.db
        .query("SELECT COUNT(*) AS n FROM wake_signals WHERE status IN ('pending','leased')")
        .get() as { n: number },
    ).toEqual({ n: 0 });
  });

  it("an identical redelivered @ message registers no second task and no second opportunity", async () => {
    const routed: { seq: number; sourceId: string; request: ModelRequest }[] = [];
    const routes = new Map<
      number,
      (request: ModelRequest, trigger: ActivationTrigger) => Promise<string> | string
    >();
    const model = decisionStub(routes, routed);
    const f = setup({ model });
    f.makeBinding(30003, { schemeName: "task-execution-replay" });
    const first = f.receive(30003, "92001", "20002", "REPLAY_MARKER same body");
    expect(first.kind).toBe("recorded");
    routes.set(taskRows(f.db)[0]!.source_through_seq, (request) =>
      inlineFinal(authorizedTargetOf(request), "replayed reply"),
    );
    // 同一平台消息原样再交付：不产生第二条任务、不产生第二条机会。
    const second = f.receive(30003, "92001", "20002", "REPLAY_MARKER same body");
    expect(second.kind).toBe("recorded");
    expect(taskRows(f.db)).toHaveLength(1);
    expect(f.db.query("SELECT COUNT(*) AS n FROM wake_signals").get() as { n: number }).toEqual({
      n: 1,
    });

    const { bot, sends } = f.compose();
    expect(await bot.scheduler.dispatchOnce()).toBe(true);
    await bot.scheduler.waitForIdle();
    emitTrace("T2-replay", f.db);
    // 消费后仍只有一条任务、一次模型决策、一次投递：重放没有复制任何工作。
    expect(taskRows(f.db).map((t) => t.status)).toEqual(["completed"]);
    expect(routed).toHaveLength(1);
    expect(sends).toHaveLength(1);
  });

  it("mentionTaskLimit=1 keeps the second same-conversation mention pending while another conversation's eligible task claims", async () => {
    const gateA1 = controlledGate();
    const routed: { seq: number; sourceId: string; request: ModelRequest }[] = [];
    const routes = new Map<
      number,
      (request: ModelRequest, trigger: ActivationTrigger) => Promise<string> | string
    >();
    const model = decisionStub(routes, routed);
    const f = setup({ model });
    f.makeBinding(30003, {
      schemeName: "task-limit-conv-a",
      taskLimits: { mention_task_limit: 1, ordinary_task_limit: 1 },
    });
    f.makeBinding(30004, { schemeName: "task-limit-conv-b" });
    f.receive(30003, "93001", "20002", "LIMIT_A1 first");
    const seqA1 = taskRows(f.db)[0]!.source_through_seq;
    routes.set(seqA1, (request, trigger) => {
      expect(trigger.seq).toBe(seqA1);
      expect(trigger.text).toContain("LIMIT_A1");
      return gateA1
        .bounded("A1_GATE_TIMEOUT")
        .then(() => inlineFinal(authorizedTargetOf(request), "reply-A1"));
    });
    expect(taskRows(f.db)).toHaveLength(1);

    const { bot, sends } = f.compose();
    expect(await bot.scheduler.dispatchOnce()).toBe(true);
    await waitFor(() => routed.length === 1);
    expect(taskRows(f.db)[0]!.status).toBe("running");

    f.receive(30003, "93002", "20002", "LIMIT_A2 second");
    const seqA2 = taskRows(f.db)[1]!.source_through_seq;
    routes.set(seqA2, (request) => inlineFinal(authorizedTargetOf(request), "reply-A2"));
    f.receive(30004, "93003", "20012", "LIMIT_B1 other group");
    const seqB1 = taskRows(f.db)[2]!.source_through_seq;
    routes.set(seqB1, (request, trigger) => {
      expect(trigger.seq).toBe(seqB1);
      expect(trigger.text).toContain("LIMIT_B1");
      return inlineFinal(authorizedTargetOf(request), "reply-B1");
    });
    expect(await bot.scheduler.dispatchOnce()).toBe(true);
    await waitFor(() => routed.length === 2);

    // 会话 A 的第二条被 mentionTaskLimit=1 闸住保持 pending 且从未被认领；
    // 会话 B 的合格任务照常被认领（此刻可能在跑也可能已结算，认领事实是关键）。
    const limited = taskRows(f.db);
    expect(limited[0]!.status).toBe("running");
    expect(limited[1]!.platform_message_id).toBe("93002");
    expect(limited[1]!.status).toBe("pending");
    expect(limited[1]!.claimed_at).toBeNull();
    expect(limited[2]!.platform_message_id).toBe("93003");
    expect(limited[2]!.claimed_at).not.toBeNull();

    gateA1.release();
    await bot.scheduler.waitForIdle();
    // 上限空出后第二条可认领：第三次调度只消费 A2（会话 B 已无 pending）。
    expect(await bot.scheduler.dispatchOnce()).toBe(true);
    await bot.scheduler.waitForIdle();
    emitTrace("T3-limit", f.db);
    expect(taskRows(f.db).map((t) => [t.platform_message_id, t.status, t.error_code])).toEqual([
      ["93001", "completed", null],
      ["93002", "completed", null],
      ["93003", "completed", null],
    ]);
    // 桩只计数真实发生的决策调用：3 条任务＝3 次决策调用；模型级全局/供应商帽不在本桩内伪造。
    expect(routed).toHaveLength(3);
    // 三条出站意图各挂各任务焦点 seq 且全部确认投递。
    const t3Intents = f.db
      .query(
        "SELECT source_through_seq AS st,status FROM outbound_intents ORDER BY source_through_seq",
      )
      .all() as { st: number; status: string }[];
    expect(t3Intents.map((i) => [i.st, i.status])).toEqual(
      [seqA1, seqA2, seqB1].sort((a, b) => a - b).map((st) => [st, "confirmed"]),
    );
    expect(sends).toHaveLength(3);
  });

  it("cancelling one gated task leaves its sibling untouched; cancelling a pending task never reaches the model", async () => {
    const gateA = controlledGate();
    const gateB = controlledGate();
    const routed: { seq: number; sourceId: string; request: ModelRequest }[] = [];
    const routes = new Map<
      number,
      (request: ModelRequest, trigger: ActivationTrigger) => Promise<string> | string
    >();
    const model = decisionStub(routes, routed);
    const f = setup({ model });
    f.makeBinding(30003, { schemeName: "task-execution-cancel" });
    f.receive(30003, "94001", "20002", "CANCEL_A one");
    const seqA = taskRows(f.db)[0]!.source_through_seq;
    routes.set(seqA, (_request, trigger) => {
      expect(trigger.seq).toBe(seqA);
      expect(trigger.text).toContain("CANCEL_A");
      // 生成闸门：测试取消 A 后放行阀门，桩按取消语义抛出。
      return gateA.bounded("A_GATE_TIMEOUT").then(() => {
        throw new Error("QQ_TASK_CANCELLED_AT_GENERATION_GATE");
      });
    });
    expect(taskRows(f.db)).toHaveLength(1);

    const { bot, sends } = f.compose();
    expect(await bot.scheduler.dispatchOnce()).toBe(true);
    await waitFor(() => routed.length === 1);
    expect(taskRows(f.db)[0]!.status).toBe("running");

    f.receive(30003, "94002", "20002", "CANCEL_B two");
    const seqB = taskRows(f.db)[1]!.source_through_seq;
    routes.set(seqB, (request, trigger) => {
      expect(trigger.seq).toBe(seqB);
      expect(trigger.text).toContain("CANCEL_B");
      return gateB
        .bounded("B_GATE_TIMEOUT")
        .then(() => inlineFinal(authorizedTargetOf(request), "reply-cancel-B"));
    });
    f.receive(30003, "94003", "20002", "CANCEL_C three");
    const seqC = taskRows(f.db)[2]!.source_through_seq;
    // C 的触发永远不该作为任何 run 的激活出现；出现＝任务被吞并/误认领，让测试吵。
    routes.set(seqC, () => {
      throw new Error("CANCELLED_TASK_MUST_NOT_BE_ACTIVATED");
    });
    expect(await bot.scheduler.dispatchOnce()).toBe(true);
    await waitFor(() => routed.length === 2);
    const claimed = taskRows(f.db);
    expect(claimed.map((t) => t.status)).toEqual(["running", "running", "pending"]);

    // 生成闸门中的 A：取消是 requested（先请求，阀门放行后桩抛出、任务结算为 cancelled）。
    expect(bot.scheduler.cancel(claimed[0]!.id)).toBe("requested");
    // 仍 pending 的 C：直接终态取消，从未被认领、从未进模型。
    expect(bot.scheduler.cancel(claimed[2]!.id)).toBe("cancelled");
    expect(taskRows(f.db)[2]!.status).toBe("cancelled");
    expect(taskRows(f.db)[2]!.claimed_at).toBeNull();

    gateA.release();
    await waitFor(() => taskRows(f.db)[0]!.status === "cancelled");
    // B 不受兄弟取消影响：照常结算并投递。
    gateB.release();
    await bot.scheduler.waitForIdle();
    emitTrace("T4-cancel", f.db);
    const done = taskRows(f.db);
    expect(done.map((t) => t.status)).toEqual(["cancelled", "completed", "cancelled"]);
    expect(done[1]!.error_code).toBeNull();
    expect(done[0]!.claimed_at).toBeTruthy();
    expect(done[1]!.origin_run_id).toBeTruthy();
    expect(done[2]!.claimed_at).toBeNull();
    expect(done[2]!.origin_run_id).toBeNull();
    // A 的取消发生在生成中段（决策调用确实进过模型桩）；C 的焦点 seq 从未成为任何 run。
    expect(routed).toHaveLength(2);
    const cSeq = f.db
      .query(
        "SELECT seq FROM conversation_events ce JOIN qq_events e ON e.event_key=ce.source_id WHERE e.message_id='94003'",
      )
      .get() as { seq: number } | null;
    expect(cSeq).not.toBeNull();
    expect(
      f.db.query("SELECT COUNT(*) AS n FROM agent_runs WHERE observed_seq=?").get(cSeq!.seq) as {
        n: number;
      },
    ).toEqual({ n: 0 });
    const t4Intents = f.db
      .query("SELECT source_through_seq AS st,status,target FROM outbound_intents")
      .all() as { st: number; status: string; target: string }[];
    expect(t4Intents.map((i) => [i.st, i.status])).toEqual([[seqB, "confirmed"]]);
    expect(sends).toHaveLength(1);
    expect(JSON.stringify(sends[0]!.request)).toContain("reply-cancel-B");
    expect(f.db.query("SELECT COUNT(*) AS n FROM outbound_intents").get() as { n: number }).toEqual(
      { n: 1 },
    );
  });
});
