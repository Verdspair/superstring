// P3 独立端到端验证（qq-parallel-media 批次，P3-TASK-PARTIAL-RECOVERY-TEST-GO）：真实
// createOneBotConversationRuntime 装配 + AgentRuntime + ConversationHost + 业务库 + QqSendPort
// 闭桩，验证**同一条 durable 普通接话任务在部分早提交后崩溃、再走真实恢复链**的行为——
// 不是登记即止，也不是旧 legacyWakeHost 夹具所能代替：一条 ordinary/chiming_in 任务持有两人
// A20002/B20003 的冻结批次，A 先提交并发送（confirmed 或 unknown），B 仍在生成时任务租约被
// 夹具置为过期（模拟进程消失），B 的受控调用随后崩溃；旧实例结算 CAS 失败，任务留在
// running+expired 的恢复候选态。新组合（同库、新 AgentRuntime/ConversationHost）只调公开
// scheduler.runOnce()：真实 recoverExpired + 分支解析器把同一任务恢复为 pending、重取并复用
// 冻结快照，宿主复用受保护判断（0 次新评分），只补齐未覆盖的 B。
//
// 不接真实 QQ/模型/网络/私有库；模型是受控 ModelPort 桩（评分按 responseSchema.evaluations
// 识别，回复决策经 authorizedTargets 路由，慢目标挂外部 Promise 阀门，崩溃＝拒绝该阀门）。
// 不使用 resumeCallback/direct repo/Host legacy runner 作为生产证据；不手造 protected JSON 或
// 历史行；不新增用户输入绕过任何等待；不复制任何生产源码。LF。

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
import { QQ_RHYTHM_DEFAULT } from "../../src/server/services/qq-rhythm-contract";
import { QqStickerStore } from "../../src/server/services/qq-sticker-store";
import { cloneBusinessDb } from "../harness/business-db";

const ACCOUNT_ID = "10001";
const GROUP_PEER = "30003";
const FAST = "20002";
const SLOW = "20003";

type Call = { kind: "complete" | "stream"; request: ModelRequest };

type BatchTargetsPayload = {
  kind: string;
  targets: { targetId: string; speakerId?: string }[];
};

const batchTargetsPayload = (request: ModelRequest): BatchTargetsPayload | null => {
  for (const message of request.messages ?? []) {
    const parts = Array.isArray(message.content) ? message.content : [];
    for (const part of parts as { kind?: string; text?: string }[]) {
      if (part.kind !== "text" || typeof part.text !== "string") continue;
      try {
        const data = JSON.parse(part.text) as BatchTargetsPayload;
        if (data.kind === "qq_batch_targets" && Array.isArray(data.targets)) return data;
      } catch {}
    }
  }
  return null;
};

const batchTargetIds = (request: ModelRequest): string[] =>
  (batchTargetsPayload(request)?.targets ?? []).map((entry) => entry.targetId);

/** 评分调用判据：responseSchema 声明 evaluations 属性（与 QQ_BATCH_JUDGEMENT_RESPONSE_SCHEMA 同形）。 */
const isBatchScore = (request: ModelRequest): boolean =>
  (request.responseSchema as { properties?: Record<string, unknown> } | undefined)?.properties
    ?.evaluations !== undefined;

/** 回复子 run 授权材料里的目标（群聊按发言人拆分，取成员 QQ 号）。 */
const authorizedTargetOf = (request: ModelRequest): string =>
  JSON.stringify(request.messages)
    .replace(/\\/g, "")
    .match(/authorizedTargets":\["(\d+)/)?.[1] ?? FAST;

const inlineFinal = (targetId: string, text: string) =>
  JSON.stringify({ kind: "final", outputs: [{ kind: "inline", targetId, text }] });

/** 有限防永挂等待：仅用于观察异步推进，超时即失败（不用无限轮询）。 */
const waitFor = async (predicate: () => boolean, timeoutMs = 4000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("WAIT_TIMEOUT");
    await Bun.sleep(5);
  }
};

type TaskRow = {
  id: string;
  conversation_id: string;
  status: string;
  error_code: string | null;
  judgement_done: number;
  source_from_seq: number;
  source_through_seq: number;
  origin_wake_id: string | null;
  origin_run_id: string | null;
  claimed_at: string | null;
  lease_token: string | null;
  lease_expires_at: string | null;
  execution_snapshot: string | null;
  task_class: string;
  cause: string;
};

const taskRows = (db: Database): TaskRow[] =>
  db
    .query(
      "SELECT id,conversation_id,status,error_code,judgement_done,source_from_seq,source_through_seq,origin_wake_id,origin_run_id,claimed_at,lease_token,lease_expires_at,execution_snapshot,task_class,cause FROM qq_conversation_tasks ORDER BY rowid",
    )
    .all() as TaskRow[];

/** 受保护判断仍可复用的真实证据：completed 评分叶子 + exact/output_recorded 的受保护输出、未过期。 */
const protectedJudgementCount = (db: Database, task: TaskRow): number => {
  const row = db
    .query(`SELECT COUNT(*) AS n FROM agent_runs r
      JOIN agent_steps s ON s.run_id=r.run_id JOIN context_snapshots c ON c.step_id=s.step_id
      WHERE r.spec_id='onebot.initiative.evaluate_batch' AND r.wake_id=? AND r.conversation_id=?
        AND r.status='completed' AND s.status='completed' AND c.status='exact'
        AND c.output_recorded=1 AND c.protected_output IS NOT NULL
        AND (c.expires_at IS NULL OR c.expires_at>?)`)
    .get(task.origin_wake_id, task.conversation_id, new Date().toISOString()) as {
    n: number;
  };
  return row.n;
};

const pendingGates: (() => void)[] = [];
const composed: ReturnType<typeof createOneBotConversationRuntime>[] = [];
const handles: BusinessDbHandle[] = [];
afterEach(async () => {
  // 先放行全部阀门让在飞桩调用落地，再停调度器/投递并等结算，最后才关库。
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
 * 慢目标的受控阀门（一次性）：只有**第一次**慢目标进入用它阻塞，崩溃＝拒绝该阀门；
 * 之后（恢复组合的新激活，宿主对未覆盖目标重新生成）不再回到这个 Promise——旧实例的
 * 崩溃不该绑住新实例的正常模型调用。结算后释放以免留下悬挂 Promise。
 */
const slowGate = () => {
  let reject: (error: unknown) => void = () => {};
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve, rejectFn) => {
    reject = rejectFn;
    release = () => resolve();
    pendingGates.push(release);
  });
  // The controlled crash is observed from creation: abort may abandon the waiting model call.
  const observed = gate.catch((error: unknown) => error);
  let armed = true;
  return {
    reject,
    release,
    observed,
    /** 只在第一次慢目标进入时真等阀门；此后立即放行（一次性语义）。 */
    async wait() {
      if (!armed) return;
      armed = false;
      await gate;
    },
  };
};

function setup(options: { schemeName: string; unknownFastReceipt?: boolean }) {
  const h = cloneBusinessDb();
  handles.push(h);
  ensureDefaults(h.orm, "reply-model");
  updateQqSettings(h.orm, {
    accountId: ACCOUNT_ID,
    enabled: true,
    judgementModelName: "judge-model",
    expectedRevision: 1,
  });
  const scheme = createQqScheme(h.orm, {
    name: options.schemeName,
    triggers: { direct_reply: true, follow_up: false, chiming_in: true, idle_topic: false },
    reply: { split_by_speaker: true },
    rhythm: {
      ...QQ_RHYTHM_DEFAULT,
      participation_timing: "resource_window",
      // 普通接话：两人一批（count 2、jitter 0），关闭时间窗维度，纯计数窗口；
      // merge 0＝每条各自成立；cooldown 1 是合法字段值，不与默认冲突。
      initiative_batch_target_count: 2,
      initiative_batch_jitter_count: 0,
      initiative_time_window_enabled: false,
      merge_window_seconds: 0,
      reply_cooldown_seconds: 1,
      max_recompute_count: 1,
      judgement_interval_turns: 1,
    },
  });
  h.db
    .query(
      "INSERT INTO qq_bindings(id,account_id,conversation_kind,peer_id,agent_id,scheme_id,created_at,updated_at) VALUES(?,'10001','group',?,?,?,?,?)",
    )
    .run(
      crypto.randomUUID(),
      GROUP_PEER,
      DEFAULT_AGENT_ID,
      scheme.id,
      new Date().toISOString(),
      new Date().toISOString(),
    );
  // 真实 epoch 真值的一致时钟：起在墙钟前 2 秒，两条成员消息各 +1 秒仍在过去，
  // 这样任务/唤醒的 ready_at 不落在未来（合成 future 会让真实 Date.now 的领取器闸住）。
  const clock = { seconds: Math.floor(Date.now() / 1000) - 2 };
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
  const receive = (messageId: string, speaker: string, text: string) =>
    recordInbound(
      h.orm,
      normalizeOneBotMessage(
        {
          post_type: "message",
          message_type: "group",
          sub_type: "normal",
          time: clock.seconds,
          self_id: 10001,
          user_id: Number(speaker),
          group_id: 30003,
          message_id: messageId,
          message: [{ type: "text", data: { text } }],
          sender: { nickname: speaker },
        },
        ACCOUNT_ID,
      ),
      { accountId: ACCOUNT_ID, conversationIngress: adapter },
    );
  const calls: Call[] = [];
  const sends: { peerId: string | undefined; request: unknown }[] = [];
  const gate = slowGate();
  const slowEntered = Promise.withResolvers<void>();
  const model: ModelPort = {
    complete: async (request) => {
      calls.push({ kind: "complete", request });
      if (isBatchScore(request)) {
        return JSON.stringify({
          evaluations: batchTargetIds(request).map((targetId) => ({
            targetId,
            score: 10,
            intent: `intent-${targetId}`,
            sourceSeqs: [],
          })),
        });
      }
      const target = authorizedTargetOf(request);
      if (target === SLOW) {
        // Signal model entry before the gate wait; the crash must hit a live call.
        slowEntered.resolve();
        await gate.wait();
      }
      return inlineFinal(target, `reply-${target}`);
    },
    async *streamText(request) {
      calls.push({ kind: "stream", request });
      yield "reply body";
    },
    completeMultimodal: async () => "",
  };
  const compose = () => {
    const runtime = new AgentRuntime({
      repository: runs,
      now: () => new Date().toISOString(),
      model,
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
          sends.push({ peerId: request.peerId, request });
          const isFastReply = JSON.stringify(request).includes(`reply-${FAST}`);
          if (options.unknownFastReceipt && isFastReply && sends.length === 1)
            return { kind: "unknown", reason: "transport_error" };
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
    return bot;
  };
  return {
    orm: h.orm,
    db: h.db,
    journal,
    wakes,
    outbox,
    runs,
    scheme,
    clock,
    now: () => new Date(clock.seconds * 1000).toISOString(),
    receive,
    compose,
    calls,
    sends,
    gate,
    slowEntered: slowEntered.promise,
  };
}

const judgeCallCount = (calls: Call[]): number =>
  calls.filter((call) => call.kind === "complete" && isBatchScore(call.request)).length;

const intentRows = (db: Database) =>
  db
    .query(
      `SELECT json_extract(target,'$.participantId') AS participant,status,source_through_seq AS through_seq FROM outbound_intents ORDER BY created_at,output_ordinal`,
    )
    .all() as { participant: string | null; status: string; through_seq: number }[];

/**
 * 同一合法作用域下的两种部分恢复：A 的收据 confirmed（默认）或 unknown（变体）。
 * 顺序：登记普通机会 → 短接入领取 → A 早提交/发送 → 冻结断言 → 夹具置租约过期 →
 * B 受控崩溃 → 旧实例结算 CAS 失败留 running+expired → 新组合 runOnce 复用同判断补齐 B。
 */
function partialRecoveryCase(options: { schemeName: string; unknownFastReceipt?: boolean }) {
  return async () => {
    const f = setup(options);
    const bot1 = f.compose();
    f.receive("91001", FAST, "CHIME_A ordinary");
    f.receive("91002", SLOW, "CHIME_B ordinary");
    expect(
      f.db.query("SELECT COUNT(*) AS n FROM wake_signals WHERE status='pending'").get() as {
        n: number;
      },
    ).toEqual({ n: 1 });

    // 短接入：登记普通任务并领取启动。
    expect(await bot1.scheduler.dispatchOnce()).toBe(true);
    await waitFor(() => f.sends.length === 1);
    const fastSendBody = JSON.stringify(f.sends[0]?.request ?? "");
    expect(fastSendBody).toContain(`reply-${FAST}`);

    // 崩溃前冻结面断言：任务 running、judgement_done=1、冻结快照 2 目标、受保护判断 exact 落盘。
    const before = taskRows(f.db)[0];
    expect(before).toBeDefined();
    if (!before) throw new Error("TASK_ROW_MISSING");
    expect(before.status).toBe("running");
    expect(before.task_class).toBe("ordinary");
    expect(before.cause).toBe("chiming_in");
    expect(before.judgement_done).toBe(1);
    const snapshot = JSON.parse(before.execution_snapshot ?? "") as {
      authorizedTargets: string[];
      targetParticipants: { targetId: string }[];
      sourceThroughSeq: number;
    };
    expect([...snapshot.authorizedTargets].sort()).toEqual([FAST, SLOW]);
    expect(snapshot.targetParticipants).toHaveLength(2);
    expect(snapshot.sourceThroughSeq).toBe(before.source_through_seq);
    expect(protectedJudgementCount(f.db, before)).toBe(1);
    // A 的意图：confirmed 或 unknown，都是「已尝试过」的原行。
    const fastIntent = intentRows(f.db).find((intent) => intent.participant === FAST);
    expect(fastIntent?.status).toBe(options.unknownFastReceipt ? "unknown" : "confirmed");
    expect(fastIntent?.through_seq).toBe(before.source_through_seq);
    const sendsBeforeCrash = f.sends.length;

    // 先等 B 进入模型调用：此时租约仍有效。置为过去后再等，排队的生成会在进模型前被拒。
    await f.slowEntered;

    // 夹具模拟进程消失：把任务租约置为过去（不 sleep，续租周期 40s > 测试时长，不手造任何 JSON/历史）。
    const expiredAt = new Date(Date.now() - 30_000).toISOString();
    expect(
      f.db
        .query("UPDATE qq_conversation_tasks SET lease_expires_at=? WHERE id=?")
        .run(expiredAt, before.id).changes,
    ).toBe(1);

    // 受控崩溃：B 已在模型调用中，拒绝落在真实等待者上；旧实例结算 CAS 失败 → 任务留在 running+expired。
    const modelCrash = new Error("QQ_SYNTHETIC_MODEL_CRASH");
    f.gate.reject(modelCrash);
    await bot1.scheduler.waitForIdle();
    expect(await f.gate.observed).toBe(modelCrash);
    const crashed = taskRows(f.db)[0];
    expect(crashed?.status).toBe("running");
    expect(Date.parse(crashed?.lease_expires_at ?? "")).toBeLessThanOrEqual(Date.now());

    // 排空旧实例（结算已尝试，再停调度器与投递泵，最后才关库）。
    bot1.scheduler.stop();
    bot1.delivery.stop();
    await bot1.delivery.waitForIdle();
    bot1.release();

    // 新组合：同库、新 AgentRuntime/ConversationHost，只调公开 runOnce → recoverExpired + 解析器
    // → 重取 → 宿主复用受保护判断。无需任何新用户输入即可恢复。
    const bot2 = f.compose();
    expect(await bot2.scheduler.runOnce()).toBe(true);
    await bot2.scheduler.waitForIdle();
    // 恢复后的真实状态先落一条 compact trace（证据，不改期望）。
    emitTrace(`${options.schemeName}-post-recovery`, f.db);

    // 同一身份：同 task id、同一冻结快照字符串、同一 claimedAt、同一 origin wake。
    const after = taskRows(f.db)[0];
    expect(after).toBeDefined();
    if (!after) throw new Error("TASK_ROW_MISSING_AFTER_RECOVERY");

    expect(after.id).toBe(before.id);
    expect(after.execution_snapshot).toBe(before.execution_snapshot);
    expect(after.claimed_at).toBe(before.claimed_at);
    expect(after.origin_wake_id).toBe(before.origin_wake_id);
    // 全链只有一次真实评分：恢复复用受保护 raw，不重判。
    expect(judgeCallCount(f.calls)).toBe(1);
    // 冻结目标全部有账：A 原行保留（confirmed/unknown），B 新登记并确认；任务完成。
    const intents = intentRows(f.db);
    expect(intents.map((intent) => intent.participant).sort()).toEqual([FAST, SLOW]);
    expect(intents.every((intent) => intent.through_seq === before.source_through_seq)).toBe(true);
    expect(intents.find((intent) => intent.participant === FAST)?.status).toBe(
      options.unknownFastReceipt ? "unknown" : "confirmed",
    );
    expect(intents.find((intent) => intent.participant === SLOW)?.status).toBe("confirmed");
    // A 不重生成、不重发：A 只有它崩溃前的那一次发送；B 恰好一次新发送。
    const fastSends = f.sends.filter((send) =>
      String(JSON.stringify(send.request)).includes(`reply-${FAST}`),
    );
    const slowSends = f.sends.filter((send) =>
      String(JSON.stringify(send.request)).includes(`reply-${SLOW}`),
    );
    expect(fastSends).toHaveLength(1);
    expect(slowSends).toHaveLength(1);
    expect(f.sends).toHaveLength(sendsBeforeCrash + 1);
    expect(after.status).toBe("completed");
    expect(after.error_code).toBeNull();
    emitTrace(options.schemeName, f.db);
  };
}

/** 紧凑源 trace：任务终态/焦点/冻结目标 + 出站意图账（供 root 分层核对）。 */
const emitTrace = (label: string, db: Database) => {
  const tasks = taskRows(db).map((task) => ({
    status: task.status,
    error: task.error_code,
    judgement_done: task.judgement_done,
    claimed_at: task.claimed_at,
    wake: task.origin_wake_id?.slice(0, 8) ?? null,
    through: task.source_through_seq,
  }));
  const intents = db
    .query(
      `SELECT json_extract(target,'$.participantId') AS participant,status,source_through_seq AS through_seq,substr(run_id,1,8) AS run FROM outbound_intents ORDER BY created_at,output_ordinal`,
    )
    .all();
  console.error(`[task-partial-recovery-trace ${label}]`, JSON.stringify({ tasks, intents }));
};

describe("qq durable task partial recovery (production composition)", () => {
  it(
    "resumes a partially committed ordinary chime after a lease-expired crash: same task, reused protected judgement, only the uncovered target completed",
    partialRecoveryCase({
      schemeName: "partial-recovery-confirmed",
    }),
  );

  it(
    "keeps an unknown fast receipt unreplayed in the same recovery scope while the remaining target completes",
    partialRecoveryCase({
      schemeName: "partial-recovery-unknown",
      unknownFastReceipt: true,
    }),
  );
});
