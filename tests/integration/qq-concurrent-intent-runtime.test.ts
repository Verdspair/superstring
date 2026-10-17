import { afterEach, describe, expect, it } from "bun:test";
import { AgentRuntime } from "../../src/server/agent/agent-runtime";
import { ConversationHost } from "../../src/server/agent/conversation-host";
import type { ModelPort, ModelRequest } from "../../src/server/agent/model-port";
import { readConcurrentReplyJobs } from "../../src/server/channels/onebot11/concurrent-reply-context";
import { assertBotContextSources } from "../../src/server/channels/onebot11/context-source";
import { createOneBotConversationRuntime } from "../../src/server/channels/onebot11/create-runtime";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import type { BusinessDbHandle } from "../../src/server/db/connection";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { readQqBinding } from "../../src/server/db/qq-binding-repository";
import { createQqScheme } from "../../src/server/db/qq-scheme-repository";
import { updateQqSettings } from "../../src/server/db/qq-settings-repository";
import {
  DEFAULT_AGENT_ID,
  DEFAULT_USER_ID,
  ensureDefaults,
} from "../../src/server/db/repositories";
import { normalizeOneBotMessage } from "../../src/server/services/onebot-protocol";
import { recordInbound } from "../../src/server/services/qq-intake";
import { QQ_RHYTHM_DEFAULT } from "../../src/server/services/qq-rhythm-contract";
import { QqStickerStore } from "../../src/server/services/qq-sticker-store";
import { cloneBusinessDb } from "../harness/business-db";

/**
 * 生产组合的受保护意图共享用例：隔离克隆库 + 受控 Promise 网关，无真实模型/QQ/供应商副作用。
 * 其他普通任务（chiming_in）自己的批量评分经真实运行时与 AgentRunRepository 落地
 * （wake→completed evaluate_batch run(observed_seq=冻结问题 seq)→首个完成 step→exact 快照：
 * 真实来源 refs、受保护输出包装、终端 qq_batch_targets 信封、judgement_done=1）之后，
 * 后续批评分与独立直接正常决策都在同一投影里看到它声明的公开意图——不新增模型调用、
 * 不新增规划步骤、不整群阻塞；低分批次一次消费、零 child。撤销（redactContext）与
 * 来源 TTL 过期之后不再泄漏，也不产生额外供应商调用。
 */

const ACCOUNT_ID = "10001";
const GROUP_ID = "30003";
const A = "20002";
const B = "20003";
const C = "20004";

const INTENT_B = "计划补充先前的话题";
const INTENT_LOW = "无新增价值";

type DecisionTrigger = { seq: number; cause: string };
const decisionTriggerOf = (request: ModelRequest): DecisionTrigger => {
  for (const message of request.messages ?? []) {
    for (const part of message.content ?? []) {
      if (part.kind !== "text") continue;
      try {
        const dump = JSON.parse(part.text) as { kind?: string; value?: Record<string, unknown> };
        if (dump?.kind !== "activation_trigger" || dump.value === undefined) continue;
        return {
          seq: Number(dump.value.seq ?? -1),
          cause: String(dump.value.cause ?? ""),
        };
      } catch {}
    }
  }
  throw new Error("DECISION_CALL_WITHOUT_TRIGGER");
};

const isBatchScore = (request: ModelRequest): boolean =>
  (request.responseSchema as { properties?: Record<string, unknown> } | undefined)?.properties
    ?.evaluations !== undefined;
const isDecision = (request: ModelRequest): boolean =>
  Array.isArray((request.responseSchema as { oneOf?: unknown } | undefined)?.oneOf);

type DeclaredIntentWire = { targetId: string; score: number; intent: string };
type JobsDump = {
  kind: string;
  jobs: {
    taskId: string;
    status: string;
    questionSeq?: number;
    declaredIntents?: DeclaredIntentWire[];
  }[];
};
const jobsDumpOf = (request: ModelRequest): JobsDump | null => {
  for (const message of request.messages ?? []) {
    for (const part of message.content ?? []) {
      if (part.kind !== "text") continue;
      try {
        const parsed = JSON.parse(part.text) as JobsDump;
        if (parsed?.kind === "qq_concurrent_jobs") return parsed;
      } catch {}
    }
  }
  return null;
};

type BatchEnvelope = { kind: string; targets: { targetId: string }[] };
const envelopeOf = (request: ModelRequest): BatchEnvelope => {
  for (const message of request.messages ?? []) {
    for (const part of message.content ?? []) {
      if (part.kind !== "text") continue;
      try {
        const parsed = JSON.parse(part.text) as BatchEnvelope;
        if (parsed?.kind === "qq_batch_targets" && parsed.targets) return parsed;
      } catch {}
    }
  }
  throw new Error("SCORE_TARGETS_MISSING");
};

const authorizedTargetOf = (request: ModelRequest): string =>
  JSON.stringify(request.messages)
    .replace(/\\/g, "")
    .match(/authorizedTargets":\["(\d+)/)?.[1] ?? A;
const inlineReply = (targetId: string, text: string) =>
  JSON.stringify({ kind: "final", outputs: [{ kind: "inline", targetId, text }] });

const waitFor = async (predicate: () => boolean, timeoutMs = 4000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("WAIT_TIMEOUT_INTENT_RUNTIME_CASE");
    await Bun.sleep(5);
  }
};

const pendingGates: (() => void)[] = [];
const composed: ReturnType<typeof createOneBotConversationRuntime>[] = [];
const handles: BusinessDbHandle[] = [];
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
afterEach(async () => {
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

function composeRuntime() {
  const h = cloneBusinessDb();
  handles.push(h);
  ensureDefaults(h.orm, "intent-runtime-model");
  updateQqSettings(h.orm, { accountId: ACCOUNT_ID, enabled: true, expectedRevision: 1 });
  const scheme = createQqScheme(h.orm, {
    name: `intent-runtime-${crypto.randomUUID()}`,
    triggers: { direct_reply: true, follow_up: false, chiming_in: true, idle_topic: false },
    reply: { split_by_speaker: true },
    taskLimits: { mention_task_limit: 4, ordinary_task_limit: 2 },
    rhythm: {
      ...QQ_RHYTHM_DEFAULT,
      initiative_batch_target_count: 1,
      initiative_batch_jitter_count: 0,
      initiative_time_window_enabled: false,
      merge_window_seconds: 0,
      reply_cooldown_seconds: 1,
      judgement_interval_turns: 1,
    },
  });
  const bindingId = crypto.randomUUID();
  const now = () => new Date().toISOString();
  h.db
    .query(
      "INSERT INTO qq_bindings(id,account_id,conversation_kind,peer_id,agent_id,scheme_id,created_at,updated_at) VALUES(?,'10001','group','30003',?,?,?,?)",
    )
    .run(bindingId, DEFAULT_AGENT_ID, scheme.id, now(), now());
  const journal = new ConversationEventRepository(h.db);
  const runs = new AgentRunRepository(h.db);
  const firstChildGate = controlledGate();
  type ScoreCall = { request: ModelRequest; jobs: JobsDump | null; envelope: BatchEnvelope };
  type DecisionCall = { request: ModelRequest; jobs: JobsDump | null; trigger: DecisionTrigger };
  const scoreCalls: ScoreCall[] = [];
  const decisionCalls: DecisionCall[] = [];
  const model: ModelPort = {
    async complete(request) {
      if (isBatchScore(request)) {
        const envelope = envelopeOf(request);
        const score = scoreCalls.length === 0 ? 10 : 1;
        scoreCalls.push({ request, jobs: jobsDumpOf(request), envelope });
        return JSON.stringify({
          evaluations: envelope.targets.map((target) => ({
            targetId: target.targetId,
            score,
            intent: score === 10 ? INTENT_B : INTENT_LOW,
            sourceSeqs: [],
          })),
        });
      }
      if (!isDecision(request)) return "{}";
      const trigger = decisionTriggerOf(request);
      decisionCalls.push({ request, jobs: jobsDumpOf(request), trigger });
      // 第一个自主 child 决策挂在受控网关上：B 保持 running，后续批次/直接决策照常并发。
      if (trigger.cause !== "direct_reply" && decisionCalls.length === 1)
        await firstChildGate.bounded("CHILD_GATE_TIMEOUT");
      const targetId = authorizedTargetOf(request);
      return inlineReply(
        targetId,
        trigger.cause === "direct_reply" ? `direct-${targetId}` : `autonomy-${targetId}`,
      );
    },
    async *streamText() {
      yield "";
    },
    async completeMultimodal() {
      return "";
    },
  };
  const runtime = new AgentRuntime({ repository: runs, model, now });
  const bot = createOneBotConversationRuntime({
    orm: h.orm,
    db: h.db,
    gateway: {
      async complete() {
        throw new Error("UNIFIED_RUNTIME_REQUIRED");
      },
      async loadedContextCapacity() {
        return 65536;
      },
    },
    agentRuntime: runtime,
    host: new ConversationHost({ runtime }),
    journal,
    store: new QqStickerStore({ directory: "synthetic-intent-runtime-stickers" }),
    port: {
      async send() {
        return { kind: "confirmed", messageId: String(60000 + Math.random()) };
      },
    },
    wake: () => {},
    policy: () => ({
      maxSteps: 20,
      deliveryTtlSeconds: 600,
      retryDelayMs: 1000,
      maxAttempts: 3,
      globalConcurrency: 4,
      modelCallConcurrency: 4,
    }),
  });
  composed.push(bot);
  const receive = (messageId: string, memberId: string, text: string, addressed: boolean) => {
    const normalized = normalizeOneBotMessage(
      {
        post_type: "message",
        message_type: "group",
        sub_type: "normal",
        time: Math.floor(Date.now() / 1000),
        self_id: Number(ACCOUNT_ID),
        user_id: Number(memberId),
        group_id: Number(GROUP_ID),
        message_id: messageId,
        message: [
          ...(addressed ? [{ type: "at", data: { qq: ACCOUNT_ID } }] : []),
          { type: "text", data: { text } },
        ],
        sender: { nickname: memberId },
      },
      ACCOUNT_ID,
    );
    return recordInbound(h.orm, normalized, {
      accountId: ACCOUNT_ID,
      conversationIngress: bot.adapter,
    });
  };
  return { h, bot, scoreCalls, decisionCalls, firstChildGate, receive };
}

const taskRowOf = (h: BusinessDbHandle, id: string) =>
  h.db
    .query(
      "SELECT id,conversation_id AS conversationId,source_through_seq AS throughSeq,origin_wake_id AS wakeId,judgement_done AS judgementDone,status FROM qq_conversation_tasks WHERE id=?",
    )
    .get(id) as {
    id: string;
    conversationId: string;
    throughSeq: number;
    wakeId: string | null;
    judgementDone: number;
    status: string;
  };
const readProjection = (h: BusinessDbHandle, conversationId: string) => {
  const scope = h.db
    .query("SELECT binding_epoch AS epoch,agent_id AS agentId FROM conversations WHERE id=?")
    .get(conversationId) as { epoch: number; agentId: string };
  return readConcurrentReplyJobs(h.db, {
    conversationId,
    bindingEpoch: scope.epoch,
    agentId: scope.agentId,
    now: new Date().toISOString(),
    visibleEventKeys: new Set<string>(),
    assertSources: (sources) => {
      const bindingRow = h.db
        .query("SELECT source_id FROM conversations WHERE id=?")
        .get(conversationId) as { source_id: string };
      const binding = readQqBinding(h.orm, bindingRow.source_id)!;
      const access = { ...binding, bindingEpoch: scope.epoch };
      assertBotContextSources(
        { db: h.db, orm: h.orm, binding, snapshot: { access } as never },
        { kind: "qq_binding", id: binding.id, agentId: binding.agentId, userId: DEFAULT_USER_ID },
        sources,
      );
    },
  });
};

describe("qq concurrent intent sharing (production composition, protected judgement via the real runtime)", () => {
  it("a judged other ordinary job's declared intent reaches the first judge and a separate normal decision without extra model calls; revocation and source expiry do not leak", async () => {
    const f = composeRuntime();

    // B 的普通消息：真实批评分完成，判定链由运行时经真实仓储持久化（不 seed 任何行）。
    f.receive("81001", B, "ordinary note from B", false);
    expect(await f.bot.scheduler.dispatchOnce()).toBe(true);
    const taskB = f.h.db
      .query("SELECT id FROM qq_conversation_tasks WHERE cause='chiming_in'")
      .get() as { id: string };
    await waitFor(() => f.decisionCalls.some((entry) => entry.trigger.cause !== "direct_reply"));
    await waitFor(() => taskRowOf(f.h, taskB.id).judgementDone === 1);
    expect(taskRowOf(f.h, taskB.id).wakeId).not.toBeNull();

    // 真实持久化身份：completed evaluate_batch run 的 wake/observed_seq 与任务冻结输入一致，
    // 首个完成 step 带 exact + output_recorded 快照；来源 refs 是真实会话来源，非合成 kind。
    const convId = taskRowOf(f.h, taskB.id).conversationId;
    if (convId === null) throw new Error("CONVERSATION_REQUIRED");
    const judged = f.h.db
      .query(
        `SELECT r.run_id AS runId,r.wake_id AS wakeId,r.observed_seq AS observedSeq,
        s.step_id AS stepId,c.status AS snapStatus,c.output_recorded AS outputRecorded,c.source_refs AS sourceRefs
      FROM agent_runs r
      JOIN agent_steps s ON s.run_id=r.run_id AND s.status='completed'
      JOIN context_snapshots c ON c.step_id=s.step_id
      WHERE r.spec_id='onebot.initiative.evaluate_batch' AND r.conversation_id=? AND r.status='completed'
      ORDER BY s.step_no LIMIT 1`,
      )
      .get(convId) as {
      runId: string;
      wakeId: string;
      observedSeq: number;
      stepId: string;
      snapStatus: string;
      outputRecorded: number;
      sourceRefs: string;
    };
    expect(judged).toBeDefined();
    const wakeB = taskRowOf(f.h, taskB.id).wakeId;
    if (wakeB === null) throw new Error("JUDGEMENT_WAKE_REQUIRED");
    expect(judged.wakeId).toBe(wakeB);
    expect(judged.observedSeq).toBe(taskRowOf(f.h, taskB.id).throughSeq);
    expect(judged.snapStatus).toBe("exact");
    expect(judged.outputRecorded).toBe(1);

    // C 的第二批：首次批评分在线里看到 B 已接受的公开意图；低分（<min_score 6）一次消费，零 child。
    f.receive("81002", C, "another ordinary note from C", false);
    expect(await f.bot.scheduler.dispatchOnce()).toBe(true);
    const taskC = f.h.db
      .query("SELECT id FROM qq_conversation_tasks WHERE cause='chiming_in' AND id<>?")
      .get(taskB.id) as { id: string };
    await waitFor(() => f.scoreCalls.length >= 2);
    await waitFor(() => taskRowOf(f.h, taskC.id).judgementDone === 1);
    expect(f.decisionCalls).toHaveLength(1);
    const score2 = f.scoreCalls[1]!;
    expect(score2.jobs).not.toBeNull();
    const wireB = score2.jobs!.jobs.find((job) => job.taskId === taskB.id);
    expect(wireB).toBeDefined();
    expect(wireB!.status).toBe("running");
    expect(wireB!.declaredIntents).toEqual([
      { targetId: f.scoreCalls[0]!.envelope.targets[0]!.targetId, score: 10, intent: INTENT_B },
    ]);

    // 独立的直接正常决策同样在线里看到同一意图；此刻 B 的 child 仍被网关挡住＝无整群阻塞。
    f.receive("81003", A, "direct question from A", true);
    expect(await f.bot.scheduler.dispatchOnce()).toBe(true);
    await waitFor(() => f.decisionCalls.some((entry) => entry.trigger.cause === "direct_reply"));
    const direct = f.decisionCalls.find((entry) => entry.trigger.cause === "direct_reply")!;
    expect(direct.jobs).not.toBeNull();
    expect(direct.jobs!.jobs.find((job) => job.taskId === taskB.id)!.declaredIntents).toEqual([
      { targetId: f.scoreCalls[0]!.envelope.targets[0]!.targetId, score: 10, intent: INTENT_B },
    ]);

    // 有界读取方 sidecar：sources/contexts 持有判定快照身份，refs 与快照逐条一致（真实来源）。
    const projection = readProjection(f.h, convId);
    const jobB = projection.jobs.find((job) => job.taskId === taskB.id)!;
    expect(jobB).toBeDefined();
    expect(jobB.declaredIntents).toEqual([
      { targetId: f.scoreCalls[0]!.envelope.targets[0]!.targetId, score: 10, intent: INTENT_B },
    ]);
    expect(projection.contexts).toHaveLength(1);
    expect(projection.contexts[0]!.runId).toBe(judged.runId);
    expect(projection.contexts[0]!.stepId).toBe(judged.stepId);
    const snapshotRefs = JSON.parse(judged.sourceRefs) as { kind: string; id: string }[];
    expect(snapshotRefs.length).toBeGreaterThan(0);
    expect(projection.sources).toHaveLength(snapshotRefs.length);
    for (const ref of snapshotRefs)
      expect(projection.sources.some((s) => s.kind === ref.kind && s.id === ref.id)).toBe(true);

    // 撤销：真实 redactContext 撤掉判定快照 → 意图不再泄漏；任务仍在投影但保持未知。
    new AgentRunRepository(f.h.db).redactContext(
      { runId: judged.runId, stepId: judged.stepId },
      "revoked",
    );
    const afterRevoke = readProjection(f.h, convId);
    const revokedB = afterRevoke.jobs.find((job) => job.taskId === taskB.id);
    expect(revokedB).toBeDefined();
    expect(revokedB!.declaredIntents).toBeUndefined();
    expect(afterRevoke.sources).toEqual([]);
    expect(afterRevoke.contexts).toEqual([]);

    // 来源 TTL 过期：整个任务退出有界投影，更无意图可泄漏。
    f.h.db
      .query(
        "UPDATE qq_conversation_tasks SET source_expires_at='2020-01-01T00:00:00.000Z' WHERE id=?",
      )
      .run(taskB.id);
    const afterTtl = readProjection(f.h, convId);
    expect(afterTtl.jobs.find((job) => job.taskId === taskB.id)).toBeUndefined();

    // 供应商面精确计数：恰好 2 次批评分（每个真实批一次，无规划/复核调用、无第二装配入口）
    // + 2 次决策（B child + A 直接）。低分批零 child；撤权/过期未触发任何额外模型调用。
    expect(f.scoreCalls).toHaveLength(2);
    expect(f.decisionCalls).toHaveLength(2);

    // 放行 B 的 child，调度归闲；不新增任何模型调用。
    f.firstChildGate.release();
    await f.bot.scheduler.waitForIdle().catch(() => {});
    expect(f.scoreCalls).toHaveLength(2);
    expect(f.decisionCalls).toHaveLength(2);
  }, 20000);
});
