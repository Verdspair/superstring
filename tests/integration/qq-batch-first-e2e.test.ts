// BATCHQA 独立端到端验证（qq-flow-and-project-concurrency 批次）：真实 OneBotHost +
// AgentRuntime + 业务库合成夹具，验证批量优先（batch-first）自主批次的**最终批准行为**。
// 不复用旧 onebot 夹具（该文件在制），本文件自带最小合法夹具；X2/Y0 是显式合法方案值，
// 用于让两条合格成员事件构成一个批次机会——生产默认门槛（15/5）由 D1 专测，此处不重复。
// 不接真实 QQ/模型/网络：模型是受控 ModelPort 桩，阀门用 Promise，无 shell sleep。

import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import { AgentRuntime } from "../../src/server/agent/agent-runtime";
import { inputUnits } from "../../src/server/agent/context-engine";
import { ConversationHost } from "../../src/server/agent/conversation-host";
import type { ModelPort, ModelRequest } from "../../src/server/agent/model-port";
import { OneBot11Adapter } from "../../src/server/channels/onebot11/adapter";
import { OneBotHost } from "../../src/server/channels/onebot11/bot-host";
import { createOneBotConversationRuntime } from "../../src/server/channels/onebot11/create-runtime";
import { OutboundDelivery } from "../../src/server/conversation/outbound-delivery";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import type { BusinessDbHandle } from "../../src/server/db/connection";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { OutboundIntentRepository } from "../../src/server/db/outbound-intent-repository";
import { createQqScheme, schemeOutputReserve } from "../../src/server/db/qq-scheme-repository";
import { updateQqSettings } from "../../src/server/db/qq-settings-repository";
import { DEFAULT_AGENT_ID, ensureDefaults } from "../../src/server/db/repositories";
import { WakeRepository } from "../../src/server/db/wake-repository";
import { normalizeOneBotMessage } from "../../src/server/services/onebot-protocol";
import { QQ_CONTEXT_DEFAULT } from "../../src/server/services/qq-context-contract";
import { recordInbound } from "../../src/server/services/qq-intake";
import { QQ_BATCH_JUDGEMENT_RESPONSE_SCHEMA } from "../../src/server/services/qq-prompt-contract";
import { QQ_RHYTHM_DEFAULT } from "../../src/server/services/qq-rhythm-contract";
import { QqStickerStore } from "../../src/server/services/qq-sticker-store";
import { estimateTokens } from "../../src/server/services/token-estimate";
import { cloneBusinessDb } from "../harness/business-db";

const time = 2_000_000_000;
const bindingId = "22222222-2222-4222-8222-222222222222";

type Call = { kind: "complete" | "stream"; request: ModelRequest };

type BatchTargetsPayload = {
  kind: string;
  trust?: string;
  sourceSeqs?: number[];
  targets: {
    targetId: string;
    speakerId?: string;
    sourceSeqs?: number[];
  }[];
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

const batchTargetIds = (request: ModelRequest): string[] => {
  const payload = batchTargetsPayload(request);
  return payload ? payload.targets.map((entry) => entry.targetId) : [];
};

const isBatchScore = (request: ModelRequest) =>
  (request.responseSchema as { properties?: Record<string, unknown> } | undefined)?.properties
    ?.evaluations !== undefined;

/** 回复子 run 授权材料里的目标（本夹具固定群号语义，取成员 QQ 号）。 */
const authorizedTargetOf = (request: ModelRequest): string =>
  JSON.stringify(request.messages)
    .replace(/\\/g, "")
    .match(/authorizedTargets":\["(\d+)/)?.[1] ?? "20002";

const inlineFinal = (targetId: string, text: string) =>
  JSON.stringify({ kind: "final", outputs: [{ kind: "inline", targetId, text }] });

/** 有限防永挂等待：仅用于观察在飞 run 的中间状态，超时即失败（不用无限轮询）。 */
const waitFor = async (predicate: () => boolean, timeoutMs = 3000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("WAIT_TIMEOUT");
    await Bun.sleep(5);
  }
};

const pendingGates: (() => void)[] = [];
const handles: BusinessDbHandle[] = [];
afterEach(() => {
  for (const release of pendingGates.splice(0)) release();
  for (const h of handles.splice(0)) h.close();
});

function setup(
  options: {
    /** 覆盖回复子 run 的首 call（阶段二）；缺省＝立即给 inline 终局正文。 */
    replyComplete?: (request: ModelRequest) => Promise<string> | string;
    /** 覆盖阶段一评分结论（缺省＝本批候选全部 9 分）。 */
    evaluations?: (targetIds: string[]) => unknown;
    intents?: string[];
    capacity?: number;
    judgementBudget?: number;
    judgementMessageLimit?: number;
    batchSize?: number;
    splitBySpeaker?: boolean;
    clockTime?: number;
    mergeWindowSeconds?: number;
  } = {},
) {
  const h = cloneBusinessDb();
  handles.push(h);
  ensureDefaults(h.orm, "reply-model");
  updateQqSettings(h.orm, {
    accountId: "10001",
    enabled: true,
    judgementModelName: "judge-model",
    expectedRevision: 1,
  });
  const scheme = createQqScheme(h.orm, {
    name: "batch-e2e",
    ...(options.judgementBudget === undefined && options.judgementMessageLimit === undefined
      ? {}
      : {
          context: {
            ...QQ_CONTEXT_DEFAULT,
            ...(options.judgementBudget === undefined
              ? {}
              : { judgement_token_budget: options.judgementBudget }),
            ...(options.judgementMessageLimit === undefined
              ? {}
              : { judgement_message_limit: options.judgementMessageLimit }),
          },
        }),
    reply: { split_by_speaker: options.splitBySpeaker ?? true },
    triggers: { direct_reply: true, follow_up: false, chiming_in: true, idle_topic: true },
    rhythm: {
      ...QQ_RHYTHM_DEFAULT,
      initiative_batch_target_count: options.batchSize ?? 2,
      initiative_batch_jitter_count: 0,
      initiative_time_window_enabled: false,
      merge_window_seconds: 2,
      max_recompute_count: 1,
      judgement_interval_turns: 1,
    },
  });
  h.db
    .query(
      "INSERT INTO qq_bindings(id,account_id,conversation_kind,peer_id,agent_id,scheme_id,created_at,updated_at) VALUES(?,'10001','group','30003',?,?,?,?)",
    )
    .run(
      bindingId,
      DEFAULT_AGENT_ID,
      scheme.id,
      new Date(time * 1000).toISOString(),
      new Date(time * 1000).toISOString(),
    );
  const clock = { seconds: options.clockTime ?? time };
  const now = () => new Date(clock.seconds * 1000).toISOString();
  const journal = new ConversationEventRepository(h.db),
    wakes = new WakeRepository(h.db),
    outbox = new OutboundIntentRepository(h.db),
    runs = new AgentRunRepository(h.db);
  const calls: Call[] = [];
  const model: ModelPort = {
    complete: async (req) => {
      calls.push({ kind: "complete", request: req });
      if (isBatchScore(req)) {
        const ids = batchTargetIds(req);
        const evaluations =
          options.evaluations?.(ids) ??
          ids.map((targetId, index) => ({
            targetId,
            score: 9,
            intent: options.intents?.[index] ?? `intent-${index}`,
            sourceSeqs: [],
          }));
        return JSON.stringify({ evaluations });
      }
      // 回复子 run 的首 call：正文已就绪的 inline 终局输出（terminal body），
      // 目标取自本 run 授权材料；不需要第二轮生成调用。
      return (
        (await options.replyComplete?.(req)) ?? inlineFinal(authorizedTargetOf(req), "reply body")
      );
    },
    async *streamText(req) {
      calls.push({ kind: "stream", request: req });
      yield "reply body";
    },
    completeMultimodal: async () => "",
  };
  const runtime = new AgentRuntime({ repository: runs, now, model });
  const gateway = {
    complete: async () => {
      throw new Error("UNIFIED_RUNTIME_REQUIRED");
    },
    loadedContextCapacity: async () => options.capacity ?? 65536,
  };
  const adapter = new OneBot11Adapter({
    orm: h.orm,
    journal,
    wakes,
    nowSeconds: () => clock.seconds,
  });
  const host = new OneBotHost({
    orm: h.orm,
    journal,
    wakes,
    outbox,
    agentRuntime: runtime,
    gateway,
    stickers: { counts: ["confirmed"], isAvailable: () => false },
    policy: () => ({ maxSteps: 20, deliveryTtlSeconds: 600 }),
    now,
  });
  const receive = (id: string, speaker: string, text = `hello from ${speaker}`) =>
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
          message_id: id,
          message: [{ type: "text", data: { text } }],
          sender: { nickname: speaker },
        },
        "10001",
      ),
      { accountId: "10001", conversationIngress: adapter },
    );
  const activate = async () => {
    const wake = wakes.claim({ at: now(), leaseMs: 120000, cause: "chiming_in" })!;
    expect(wake).not.toBeNull();
    return host.activate(wake, new AbortController().signal);
  };
  return {
    ...h,
    journal,
    wakes,
    outbox,
    runs,
    calls,
    adapter,
    host,
    agentRuntime: runtime,
    gateway,
    scheme,
    clock,
    now,
    receive,
    activate,
  };
}

describe("batch-first chiming end to end (production host + runtime)", () => {
  it("two member messages form ONE wake; one batch score call; two concurrent per-target reply calls; no extra generate call", async () => {
    // 并发证明：两个回复首 call 都挂在本栅栏上，只有**双方都已进入**才放行。
    // 若回复入口是串行的，第一个 call 永远等不到第二个，栅栏按超时失败（有限防永挂）。
    let releaseBarrier: () => void = () => {};
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    let entered = 0;
    const f = setup({
      intents: ["intent-alpha", "intent-beta"],
      replyComplete: async (req) => {
        entered += 1;
        if (entered === 2) releaseBarrier();
        await Promise.race([
          barrier,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("REPLY_CONCURRENCY_TIMEOUT")), 5000),
          ),
        ]);
        return inlineFinal(authorizedTargetOf(req), "reply body");
      },
    });
    f.receive("1", "20002");
    f.clock.seconds += 1;
    f.receive("2", "20003");
    // 两人各 1 条合格入站＝**一个**会话级合并机会，不是每人一个 wake。
    expect(
      f.db.query("SELECT COUNT(*) AS n FROM wake_signals WHERE status='pending'").get(),
    ).toEqual({ n: 1 });

    const result = await f.activate();
    expect(result.status).toBe("completed");

    // 模型调用 = 阶段一 1 次批量评分 + 阶段二 2 次目标回复；无额外主意图/generate 调用。
    const scores = f.calls.filter((c) => c.kind === "complete" && isBatchScore(c.request));
    const replies = f.calls.filter((c) => c.kind === "complete" && !isBatchScore(c.request));
    expect(scores).toHaveLength(1);
    expect(replies).toHaveLength(2);
    expect(f.calls.filter((c) => c.kind === "stream")).toHaveLength(0);
    expect(batchTargetIds(scores[0]!.request).sort()).toEqual(["20002", "20003"]);

    // 每个回复首 call 只带**自己的**意图材料，并经生产 runtime 挂上授权工具目录。
    for (const reply of replies) {
      const text = JSON.stringify(reply.request.messages);
      expect(text.includes("intent-alpha") !== text.includes("intent-beta")).toBe(true);
      expect(reply.request.tools?.map((tool) => tool.name)).toEqual([
        "memory.query",
        "memory.read",
        "knowledge.query",
        "knowledge.read",
        "history.query",
        "history.read",
        "summary.query",
        "summary.read",
        "sticker.search",
        "reply.text",
        "reply.sticker",
      ]);
    }
    expect(entered).toBe(2);

    // 两个达标目标各写一条出站意图；run 经真实生产 Runtime 入口（agent_runs 行）。
    expect(
      f.outbox
        .list({})
        .map((d) => d.target?.participantId)
        .sort(),
    ).toEqual(["20002", "20003"]);
    const runRows = f.db
      .query("SELECT spec_id,status FROM agent_runs ORDER BY started_at")
      .all() as { spec_id: string; status: string }[];
    expect(runRows.filter((r) => r.spec_id === "onebot.initiative.batch")).toEqual([
      { spec_id: "onebot.initiative.batch", status: "completed" },
    ]);
    expect(runRows.filter((r) => r.spec_id === "onebot.main")).toHaveLength(2);
  });

  it("fast target commits its outbox while the slow sibling is still generating and the parent run is not terminal", async () => {
    let releaseSlow: () => void = () => {};
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
      pendingGates.push(releaseSlow);
    });
    const f = setup({
      replyComplete: async (req) => {
        if (authorizedTargetOf(req) === "20003") {
          // 慢目标挂在外部阀门上：fast 不等整批，先走宿主原事务早提交。
          await slowGate;
        }
        return inlineFinal(authorizedTargetOf(req), "reply body");
      },
    });
    f.receive("1", "20002");
    f.clock.seconds += 1;
    f.receive("2", "20003");
    const pending = f.activate();
    // 快目标生成完成即写自己的 outbox 行（早提交，非投递分层）——此刻慢目标仍在生成。
    await waitFor(() => f.outbox.list({}).length === 1);
    expect(f.outbox.list({}).map((d) => d.target?.participantId)).toEqual(["20002"]);
    // 父 run 与 wake 都还没终态：慢目标未结算。
    const parentDuring = f.db
      .query("SELECT status FROM agent_runs WHERE spec_id='onebot.initiative.batch'")
      .get() as { status: string } | null;
    expect(parentDuring?.status).toBe("generating");
    expect(
      f.db.query("SELECT status FROM wake_signals WHERE status='leased'").get() as {
        status: string;
      } | null,
    ).toEqual({ status: "leased" });
    const conversation = f.journal.ensureOneBot(bindingId)!;
    expect(f.journal.chimingInObservedSeq(conversation.id)).toBeGreaterThan(0);
    expect(f.journal.chimingInJudgedAt(conversation.id)).toBe(f.now());

    releaseSlow();
    const result = await pending;
    // 慢目标放行后整批结算：两个目标的事实齐，父 run 终态，wake 终态。
    expect(result.status).toBe("completed");
    expect(
      f.outbox
        .list({})
        .map((d) => d.target?.participantId)
        .sort(),
    ).toEqual(["20002", "20003"]);
    const parentAfter = f.db
      .query("SELECT status FROM agent_runs WHERE spec_id='onebot.initiative.batch'")
      .get() as { status: string } | null;
    expect(parentAfter?.status).toBe("completed");
    expect(
      f.db.query("SELECT COUNT(*) AS n FROM wake_signals WHERE status='leased'").get() as {
        n: number;
      },
    ).toEqual({ n: 0 });
  });

  it("a low score starts no reply while the high score sibling replies; a complete valid judgement consumes the frozen batch boundary", async () => {
    const f = setup({
      evaluations: (ids) =>
        ids.map((targetId) => ({
          targetId,
          score: targetId === "20002" ? 2 : 9,
          intent: targetId === "20002" ? "low-intent" : "high-intent",
          sourceSeqs: [],
        })),
    });
    f.receive("1", "20002");
    f.clock.seconds += 1;
    f.receive("2", "20003");
    const conversation = f.journal.ensureOneBot(bindingId)!;
    const result = await f.activate();
    expect(result.status).toBe("completed");
    // 低分目标没有回复调用，也没有出站意图；高分目标正常。
    expect(f.calls.filter((c) => c.kind === "complete" && !isBatchScore(c.request))).toHaveLength(
      1,
    );
    expect(f.outbox.list({}).map((d) => d.target?.participantId)).toEqual(["20003"]);
    // 完整有效判断消费本批已观察边界：chiming_in_observed_seq 推进到冻结的 wake.throughSeq。
    expect(f.journal.chimingInObservedSeq(conversation.id)).toBeGreaterThan(0);
    expect(f.journal.chimingInJudgedAt(conversation.id)).toBe(f.now());
  });

  it("production OneBot runtime sends a fast early-committed target before the gated sibling finishes", async () => {
    let releaseSlow: () => void = () => {};
    let slowStarted = false;
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
      pendingGates.push(releaseSlow);
    });
    const f = setup({
      clockTime: Math.floor(Date.now() / 1000) - 2,
      mergeWindowSeconds: 0,
      replyComplete: async (req) => {
        if (authorizedTargetOf(req) === "20003") {
          slowStarted = true;
          await slowGate;
        }
        return inlineFinal(authorizedTargetOf(req), "reply body");
      },
    });
    const sends: Array<{ target: string | undefined; at: string; request: unknown }> = [];
    const bot = createOneBotConversationRuntime({
      orm: f.orm,
      db: f.db,
      gateway: f.gateway,
      agentRuntime: f.agentRuntime,
      host: new ConversationHost({ runtime: f.agentRuntime }),
      journal: f.journal,
      store: new QqStickerStore({ directory: "synthetic-qq-stickers" }),
      port: {
        async send(request) {
          sends.push({ target: request.peerId, at: f.now(), request });
          return { kind: "confirmed", messageId: `synthetic-${sends.length}` };
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
    f.receive("1", "20002");
    f.clock.seconds += 1;
    f.receive("2", "20003");
    const activeBatch = bot.scheduler.runOnce();
    try {
      await waitFor(() => slowStarted);
      await waitFor(() => sends.length === 1);
      expect(sends[0]?.target).toBe("30003");
      expect(sends[0]?.at).toBe(f.now());
      expect(f.outbox.list({}).some((delivery) => delivery.target?.participantId === "20003")).toBe(
        false,
      );
      // The sibling remains gated while the production-wired delivery completes.
      expect(
        f.db.query("SELECT status FROM agent_runs WHERE spec_id='onebot.initiative.batch'").get(),
      ).toEqual({ status: "generating" });
    } finally {
      releaseSlow();
      await Promise.allSettled([activeBatch]);
      bot.scheduler.stop();
      bot.delivery.stop();
      await bot.delivery.waitForIdle();
      bot.release();
    }
    expect(
      f.outbox
        .list({})
        .map((delivery) => delivery.target?.participantId)
        .sort(),
    ).toEqual(["20002", "20003"]);
    expect(f.outbox.list({}).every((delivery) => delivery.status === "confirmed")).toBe(true);
  });

  it("a batch evaluation missing a frozen candidate fails the batch without advancing the judgement time", async () => {
    const f = setup({
      evaluations: (ids) =>
        ids
          .filter((targetId) => targetId !== "20003")
          .map((targetId) => ({ targetId, score: 9, intent: "x", sourceSeqs: [] })),
    });
    f.receive("1", "20002");
    f.clock.seconds += 1;
    f.receive("2", "20003");
    const conversation = f.journal.ensureOneBot(bindingId)!;
    await expect(f.activate()).rejects.toMatchObject({ code: "JUDGEMENT_TARGET_MISSING" });
    expect(f.journal.chimingInObservedSeq(conversation.id)).toBe(0);
    expect(f.journal.chimingInJudgedAt(conversation.id)).toBeNull();
    expect(
      f.db.query("SELECT status FROM agent_runs WHERE spec_id='onebot.initiative.batch'").get() as {
        status: string;
      } | null,
    ).toEqual({ status: "failed" });
  });

  it("shares the complete frozen source allowlist once and uses the actual batch output protocol", async () => {
    const f = setup();
    f.receive("90101", "20002");
    f.clock.seconds += 1;
    f.receive("90102", "20003");
    await f.activate();
    const request = f.calls.find((call) => isBatchScore(call.request))?.request;
    expect(request).toBeDefined();
    const payloads =
      request?.messages.flatMap((message) =>
        message.content.flatMap((part) => {
          if (part.kind !== "text") return [];
          try {
            const value = JSON.parse(part.text);
            return value.kind === "qq_batch_targets" ? [value] : [];
          } catch {
            return [];
          }
        }),
      ) ?? [];
    expect(payloads).toHaveLength(1);
    const payload = payloads[0];
    const conversation = f.journal.ensureOneBot(bindingId)!;
    const seqs = f.db
      .query(
        "SELECT seq FROM conversation_events WHERE conversation_id=? AND kind='inbound' ORDER BY seq",
      )
      .all(conversation.id) as { seq: number }[];
    expect(payload.sourceSeqs).toEqual(seqs.map((row) => row.seq));
    expect(payload.targets).toHaveLength(2);
    expect(
      payload.targets.find((target: { targetId: string }) => target.targetId === "20002")
        ?.sourceSeqs,
    ).toEqual([seqs[0]!.seq]);
    expect(
      payload.targets.find((target: { targetId: string }) => target.targetId === "20003")
        ?.sourceSeqs,
    ).toEqual([seqs[1]!.seq]);
    const systems =
      request?.messages
        .filter((message) => message.role === "system")
        .flatMap((message) =>
          message.content.filter((part) => part.kind === "text").map((part) => part.text),
        )
        .join("\n") ?? "";
    expect(systems).toContain("evaluations");
    expect(systems).not.toContain("score 为必填");
    const replies = f.calls.filter((call) => !isBatchScore(call.request));
    expect(replies).toHaveLength(2);
    expect(
      replies.every((call) => !JSON.stringify(call.request.messages).includes("qq_batch_targets")),
    ).toBe(true);
  });

  it("fits the actual batch before optional history and preserves true mandatory-capacity refusal", async () => {
    const capacity = 16384;
    const f = setup({
      capacity,
      judgementBudget: 16384,
      evaluations: (ids) =>
        ids.map((targetId) => ({ targetId, score: 0, intent: "", sourceSeqs: [] })),
    });
    f.receive("90201", "20002", `OPTIONAL_OLDER_BODY${"x".repeat(10000)}`);
    f.clock.seconds += 1;
    f.receive("90202", "20003", "LATEST_REQUIRED_BODY");
    await f.activate();
    const scored = f.calls.find((call) => isBatchScore(call.request))?.request;
    expect(scored).toBeDefined();
    if (!scored) throw new Error("No batch score request");
    const serialized = JSON.stringify(scored.messages);
    expect(serialized).toContain("LATEST_REQUIRED_BODY");
    expect(serialized).not.toContain("OPTIONAL_OLDER_BODY");
    const schemaCost = estimateTokens(JSON.stringify(QQ_BATCH_JUDGEMENT_RESPONSE_SCHEMA));
    const ceiling = Math.floor(
      (capacity - schemeOutputReserve(f.scheme).judgement_output_reserved) * 0.95,
    );
    expect(inputUnits(scored.messages) + schemaCost).toBeLessThanOrEqual(ceiling);
    const batch = scored.messages.flatMap((message) =>
      message.content.flatMap((part) => {
        if (part.kind !== "text") return [];
        try {
          const value = JSON.parse(part.text);
          return value.kind === "qq_batch_targets" ? [value] : [];
        } catch {
          return [];
        }
      }),
    )[0];
    const conversation = f.journal.ensureOneBot(bindingId)!;
    const inboundSeqs = f.db
      .query(
        "SELECT seq FROM conversation_events WHERE conversation_id=? AND kind='inbound' AND source_kind='qq_event' ORDER BY seq",
      )
      .all(conversation.id) as { seq: number }[];
    expect(batch.sourceSeqs).toEqual(inboundSeqs.map((row) => row.seq));
    expect(batch.targets).toHaveLength(2);
    const small = setup({ capacity: 1024 });
    small.receive("90301", "20002");
    small.clock.seconds += 1;
    small.receive("90302", "20003", "LATEST_REQUIRED_BODY");
    await expect(small.activate()).rejects.toMatchObject({ code: "CONTEXT_BUDGET_EXCEEDED" });
    expect(small.calls).toHaveLength(0);
  });

  it("keeps a large frozen batch source allowlist complete without multiplying it by candidate count", async () => {
    const f = setup({
      capacity: 16384,
      judgementBudget: 16384,
      batchSize: 200,
      evaluations: (ids) =>
        ids.map((targetId) => ({ targetId, score: 0, intent: "", sourceSeqs: [] })),
    });
    for (let i = 0; i < 200; i++) {
      f.receive(String(91000 + i), String(21000 + (i % 20)), `batch message ${i}`);
      f.clock.seconds += 1;
    }
    await f.activate();
    const score = f.calls.find((call) => isBatchScore(call.request))?.request;
    expect(score).toBeDefined();
    if (!score) throw new Error("No batch score");
    const payload = score.messages.flatMap((message) =>
      message.content.flatMap((part) => {
        if (part.kind !== "text") return [];
        try {
          const value = JSON.parse(part.text);
          return value.kind === "qq_batch_targets" ? [value] : [];
        } catch {
          return [];
        }
      }),
    )[0];
    const conversation = f.journal.ensureOneBot(bindingId)!;
    const inboundSeqs = f.db
      .query(
        "SELECT seq FROM conversation_events WHERE conversation_id=? AND kind='inbound' AND source_kind='qq_event' ORDER BY seq",
      )
      .all(conversation.id) as { seq: number }[];
    expect(payload.sourceSeqs).toHaveLength(inboundSeqs.length);
    expect(payload.sourceSeqs).toEqual(inboundSeqs.map((row) => row.seq));
    expect(payload.targets).toHaveLength(20);
    expect(f.calls).toHaveLength(1);
  });
});

async function recoverDurableAudience(
  corruptInput?: "missing-envelope" | "speaker-mismatch",
): Promise<void> {
  const baseTime = Math.floor(Date.now() / 1000);
  let rejectSlow: (error: unknown) => void = () => {};
  let releaseSlow: () => void = () => {};
  let crashing = true;
  const slowGate = new Promise<void>((resolve, reject) => {
    releaseSlow = resolve;
    rejectSlow = reject;
    pendingGates.push(resolve);
  });
  const f = setup({
    clockTime: baseTime,
    batchSize: 5,
    judgementMessageLimit: 4,
    replyComplete: async (request) => {
      const targetId = authorizedTargetOf(request);
      if (crashing && targetId === "20005") await slowGate;
      return inlineFinal(targetId, `RECOVERY_TARGET_${targetId}`);
    },
  });
  const sentCarriers: string[] = [];
  const buildBot = () =>
    createOneBotConversationRuntime({
      orm: f.orm,
      db: f.db,
      gateway: f.gateway,
      agentRuntime: f.agentRuntime,
      host: new ConversationHost({ runtime: f.agentRuntime }),
      journal: f.journal,
      store: new QqStickerStore({ directory: "synthetic-qq-stickers" }),
      port: {
        async send(request) {
          const wire = JSON.stringify(request);
          const carriers = ["20003", "20004", "20005", "20006"].filter((id) =>
            wire.includes(`RECOVERY_TARGET_${id}`),
          );
          if (carriers.length !== 1) throw new Error("fixture: unique reply carrier missing");
          sentCarriers.push(carriers[0]!);
          return { kind: "unknown" as const, reason: "transport_error" as const };
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
  let bot: ReturnType<typeof buildBot> | undefined;
  let first: Promise<boolean> | undefined;
  try {
    setSystemTime(new Date(baseTime * 1000));
    for (const [index, speaker] of ["20002", "20003", "20004", "20005", "20006"].entries()) {
      f.clock.seconds = baseTime + index;
      setSystemTime(new Date(f.clock.seconds * 1000));
      f.receive(String(96001 + index), speaker);
    }
    f.clock.seconds += 3;
    setSystemTime(new Date(f.clock.seconds * 1000));
    bot = buildBot();
    first = bot.scheduler.runOnce();
    await waitFor(() => f.outbox.list({}).some((delivery) => delivery.status === "unknown"));
    const task = f.db
      .query(
        "SELECT id,status,judgement_done,execution_snapshot,lease_expires_at,origin_run_id FROM qq_conversation_tasks WHERE cause='chiming_in'",
      )
      .get() as {
      id: string;
      status: string;
      judgement_done: number;
      execution_snapshot: string;
      lease_expires_at: string;
      origin_run_id: string | null;
    };
    expect(task.status).toBe("running");
    expect(task.judgement_done).toBe(1);
    expect(task.origin_run_id).toBeTruthy();
    const frozen = JSON.parse(task.execution_snapshot) as {
      targetParticipants: { targetId: string }[];
    };
    expect(frozen.targetParticipants.map((target) => target.targetId).sort()).toEqual([
      "20002",
      "20003",
      "20004",
      "20005",
      "20006",
    ]);
    const scores = f.calls.filter((call) => isBatchScore(call.request));
    expect(scores).toHaveLength(1);
    expect(batchTargetIds(scores[0]!.request).sort()).toEqual(["20003", "20004", "20005", "20006"]);
    expect(f.outbox.list({}).some((delivery) => delivery.target?.participantId === "20002")).toBe(
      false,
    );
    const originalDeliveries = f.outbox.list({});
    const existingIds = originalDeliveries.map((delivery) => delivery.id);
    const originalUnknown = originalDeliveries.filter((delivery) => delivery.status === "unknown");
    const originalPlanned = originalDeliveries.filter((delivery) => delivery.status === "planned");
    expect(originalUnknown.length).toBeGreaterThan(0);
    expect(
      originalDeliveries.every(
        (delivery) =>
          typeof delivery.target?.participantId === "string" &&
          ["20003", "20004", "20006"].includes(delivery.target.participantId),
      ),
    ).toBe(true);
    expect(
      originalUnknown.every((delivery) =>
        delivery.parts.every(
          (part) =>
            part.status === "unknown" && part.attemptedAt !== null && part.finishedAt !== null,
        ),
      ),
    ).toBe(true);
    expect(
      originalPlanned.every((delivery) =>
        delivery.parts.every(
          (part) =>
            part.status === "planned" && part.attemptedAt === null && part.finishedAt === null,
        ),
      ),
    ).toBe(true);
    const sentBefore = [...sentCarriers];
    for (const delivery of originalUnknown) {
      expect(sentBefore.filter((id) => id === delivery.target?.participantId)).toHaveLength(1);
    }
    for (const delivery of originalPlanned) {
      expect(sentBefore.filter((id) => id === delivery.target?.participantId)).toHaveLength(0);
    }
    const sendsBefore = sentCarriers.length;
    // Stop after the actual lease expires: scheduler CAS cannot terminalize the crashed owner.
    // New composition then uses its real recovery resolver and the stored accepted judgement.
    f.clock.seconds = Math.floor(Date.parse(task.lease_expires_at) / 1000) + 1;
    setSystemTime(new Date(f.clock.seconds * 1000));
    bot.scheduler.stop();
    rejectSlow(new Error("SYNTHETIC_PROCESS_INTERRUPTED"));
    await Promise.allSettled([first]);
    bot.delivery.stop();
    await bot.delivery.waitForIdle();
    bot.release();
    const interrupted = f.db
      .query("SELECT status,judgement_done FROM qq_conversation_tasks WHERE id=?")
      .get(task.id) as { status: string; judgement_done: number };
    expect(interrupted).toEqual({ status: "running", judgement_done: 1 });
    const callsBeforeResume = f.calls.length;
    if (corruptInput) {
      // Only corrupt a legitimately recorded synthetic proof for negative recovery checks.
      // The accepted judgement marker/output were produced by the original host above.
      const stored = f.db
        .query(`SELECT c.step_id,c.protected_messages AS messages
        FROM context_snapshots c JOIN agent_steps s ON s.step_id=c.step_id
        JOIN agent_runs r ON r.run_id=s.run_id
        WHERE r.spec_id='onebot.initiative.evaluate_batch' AND r.status='completed'`)
        .get() as { step_id: string; messages: string };
      const messages = JSON.parse(stored.messages) as Array<ModelRequest["messages"][number]>;
      const terminal = messages[messages.length - 1];
      const content = terminal?.content[0];
      if (content?.kind !== "text")
        throw new Error("fixture: original host input envelope missing");
      if (corruptInput === "missing-envelope") messages.pop();
      else {
        const envelope = JSON.parse(content.text) as BatchTargetsPayload;
        envelope.targets[0]!.speakerId = "29999";
        content.text = JSON.stringify(envelope);
      }
      f.db
        .query("UPDATE context_snapshots SET protected_messages=? WHERE step_id=?")
        .run(JSON.stringify(messages), stored.step_id);
    }
    crashing = false;
    bot = buildBot();
    expect(await bot.scheduler.runOnce()).toBe(true);
    const resumed = f.db
      .query("SELECT status,error_code FROM qq_conversation_tasks WHERE id=?")
      .get(task.id) as { status: string; error_code: string | null };
    if (corruptInput) {
      expect(resumed.status).toBe("failed");
      expect(f.calls).toHaveLength(callsBeforeResume);
      expect(f.outbox.list({}).map((delivery) => delivery.id)).toEqual(existingIds);
      expect(sentCarriers).toHaveLength(sendsBefore);
      return;
    }
    if (resumed.status === "failed") {
      const failed = f.db
        .query(
          "SELECT error_code FROM agent_runs WHERE spec_id='onebot.initiative.batch' AND status='failed' ORDER BY started_at DESC LIMIT 1",
        )
        .get() as { error_code: string } | null;
      expect({ taskError: resumed.error_code, parentError: failed?.error_code ?? null }).toEqual({
        taskError: "QQ_TASK_FAILED",
        parentError: "JUDGEMENT_TARGET_MISSING",
      });
    }
    expect(resumed.status).toBe("completed");
    expect(resumed.error_code).toBeNull();
    expect(f.calls.filter((call) => isBatchScore(call.request))).toHaveLength(1);
    const deliveries = f.outbox.list({});
    expect(deliveries.map((delivery) => delivery.target?.participantId).sort()).toEqual([
      "20003",
      "20004",
      "20005",
      "20006",
    ]);
    expect(existingIds.every((id) => deliveries.some((delivery) => delivery.id === id))).toBe(true);
    // FIFO can leave never-attempted plans pending after an unknown result. A first
    // attempt of those plans is legal; any second attempt of a carrier is not.
    expect(sentCarriers.every((id) => ["20003", "20004", "20005", "20006"].includes(id))).toBe(
      true,
    );
    for (const id of ["20003", "20004", "20005", "20006"]) {
      expect(sentCarriers.filter((carrier) => carrier === id).length).toBeLessThanOrEqual(1);
    }
    for (const original of originalUnknown) {
      const restored = deliveries.find((delivery) => delivery.id === original.id);
      expect(restored?.status).toBe("unknown");
      expect(
        restored?.parts.map((part) => [part.id, part.status, part.attemptedAt, part.finishedAt]),
      ).toEqual(
        original.parts.map((part) => [part.id, part.status, part.attemptedAt, part.finishedAt]),
      );
    }
    expect(
      f.calls.filter(
        (call) => !isBatchScore(call.request) && authorizedTargetOf(call.request) === "20002",
      ),
    ).toHaveLength(0);
  } finally {
    bot?.scheduler.stop();
    rejectSlow(new Error("SYNTHETIC_TEST_CLEANUP"));
    releaseSlow();
    if (first) await Promise.allSettled([first]);
    if (bot) {
      await bot.scheduler.waitForIdle();
      bot.delivery.stop();
      await bot.delivery.waitForIdle();
      bot.release();
    }
    setSystemTime();
  }
}

it("durable recovery reuses the original four-member judgement audience inside a five-member claim", async () => {
  await recoverDurableAudience();
});

it("durable recovery rejects a missing original host audience without judging or replying again", async () => {
  await recoverDurableAudience("missing-envelope");
});

it("durable recovery rejects an input audience whose speaker differs from the frozen claim", async () => {
  await recoverDurableAudience("speaker-mismatch");
});

it("an own chiming intent confirmed during the crash still resumes the frozen batch with the reused judgement", async () => {
  // 规格 §8.2 恢复一致性：同 frozen wake 的 own stable key 在 confirmed 状态下同样排除出
  // 覆盖判定——崩溃恢复后复用持久判断（0 次新评分）、已确认目标不重生成不重发、目标集完整。
  let releaseSlow: () => void = () => {};
  let rejectCrash: (error: unknown) => void = () => {};
  const slowGate = new Promise<void>((resolve) => {
    releaseSlow = resolve;
    pendingGates.push(releaseSlow);
  });
  const crashed = new Promise<never>((_, reject) => {
    rejectCrash = reject;
  });
  const sends: string[] = [];
  const f = setup({
    replyComplete: async (req) => {
      if (authorizedTargetOf(req) === "20003") await Promise.race([slowGate, crashed]);
      return inlineFinal(authorizedTargetOf(req), "reply body");
    },
  });
  f.receive("1", "20002");
  f.clock.seconds += 1;
  f.receive("2", "20003");
  const wake = f.wakes.claim({ at: f.now(), leaseMs: 120000, cause: "chiming_in" })!;
  const crash = new AbortController();
  const crashing = f.host.activate(wake, crash.signal);
  try {
    await waitFor(() => f.outbox.list({}).length === 1);
    // 真实投递把快目标的 part 送到 confirmed——wake 仍未终态（慢目标挂起）。
    const delivery = new OutboundDelivery({
      orm: f.orm,
      repository: f.outbox,
      journal: f.journal,
      stickerFile: () => null,
      authorize: () => true,
      port: {
        async send() {
          sends.push("20002");
          return { kind: "confirmed", messageId: "synthetic-a" };
        },
      },
    });
    await delivery.runOnce();
    expect(f.outbox.list({}).find((d) => d.target?.participantId === "20002")?.status).toBe(
      "confirmed",
    );
    const crashError = new Error("CRASH");
    crash.abort(crashError);
    rejectCrash(crashError);
    await expect(crashing).rejects.toBeTruthy();
  } finally {
    releaseSlow();
  }
  // 发送之后的新成员输入解除 no-reply 等待（既批准规则：只有晚于我们发言的成员消息
  // 放行下一次主动）；租约到期后同 wake 恢复。
  f.clock.seconds += 60;
  f.receive("3", "20004");
  f.clock.seconds += 61;
  expect(f.wakes.recover({ at: f.now(), maxAttempts: 5, retryDelayMs: 1000 })).toBe(1);
  f.clock.seconds += 2;
  const resumedWake = f.wakes.claim({
    at: f.now(),
    leaseMs: 120000,
    cause: "chiming_in",
    wakeId: wake.id,
  })!;
  expect(resumedWake.id).toBe(wake.id);
  const resumed = await f.host.activate(resumedWake, new AbortController().signal);
  expect(resumed.status).toBe("completed");
  const scoreCalls = f.calls.filter(
    (call) => call.kind === "complete" && isBatchScore(call.request),
  ).length;
  expect(scoreCalls).toBe(1);
  expect(
    f.outbox
      .list({})
      .map((d) => d.target?.participantId)
      .sort(),
  ).toEqual(["20002", "20003"]);
  expect(f.outbox.list({}).find((d) => d.target?.participantId === "20002")?.status).toBe(
    "confirmed",
  );
  expect(sends).toEqual(["20002"]);
});

it("a second completed batch exposes only each speaker's new eligible inputs while retaining the full frozen allowlist", async () => {
  const f = setup();
  f.receive("92001", "20002", "ALREADY_ANSWERED_A");
  f.clock.seconds += 1;
  f.receive("92002", "20003", "ALREADY_ANSWERED_B");
  expect((await f.activate()).status).toBe("completed");
  expect(
    f.outbox
      .list({})
      .map((delivery) => delivery.target?.participantId)
      .sort(),
  ).toEqual(["20002", "20003"]);
  const conversation = f.journal.ensureOneBot(bindingId)!;
  const firstBoundary = f.journal.chimingInObservedSeq(conversation.id);
  const callsBefore = f.calls.length;

  f.clock.seconds += 60;
  f.receive("92003", "20002", "NEW_ELIGIBLE_A");
  f.clock.seconds += 1;
  recordInbound(
    f.orm,
    normalizeOneBotMessage(
      {
        post_type: "message",
        message_type: "group",
        sub_type: "normal",
        time: f.clock.seconds,
        self_id: 10001,
        user_id: 20002,
        group_id: 30003,
        message_id: "92004",
        message: [
          { type: "at", data: { qq: "10001" } },
          { type: "text", data: { text: "SEPARATE_DIRECT_A" } },
        ],
        sender: { nickname: "20002" },
      },
      "10001",
    ),
    { accountId: "10001", conversationIngress: f.adapter },
  );
  f.clock.seconds += 1;
  f.receive("92005", "20004", "NEW_ELIGIBLE_C");
  const wake = f.wakes.claim({ at: f.now(), leaseMs: 120000, cause: "chiming_in" })!;
  expect(wake).not.toBeNull();
  expect((await f.host.activate(wake, new AbortController().signal)).status).toBe("completed");

  const secondCalls = f.calls.slice(callsBefore);
  const scores = secondCalls.filter(
    (call) => call.kind === "complete" && isBatchScore(call.request),
  );
  const replies = secondCalls.filter(
    (call) => call.kind === "complete" && !isBatchScore(call.request),
  );
  expect(scores).toHaveLength(1);
  expect(replies).toHaveLength(2);
  expect(replies.map((call) => authorizedTargetOf(call.request)).sort()).toEqual([
    "20002",
    "20004",
  ]);
  expect(
    f.outbox
      .list({})
      .map((delivery) => delivery.target?.participantId)
      .sort(),
  ).toEqual(["20002", "20002", "20003", "20004"]);
  const rows = f.db
    .query(
      "SELECT seq,event_key FROM conversation_events WHERE conversation_id=? AND kind='inbound' AND source_kind='qq_event' ORDER BY seq",
    )
    .all(conversation.id) as { seq: number; event_key: string }[];
  expect(rows).toHaveLength(5);
  const frozen = rows.filter((row) => row.seq > firstBoundary && row.seq <= wake.throughSeq);
  expect(frozen.map((row) => row.seq)).toEqual([rows[2]!.seq, rows[3]!.seq, rows[4]!.seq]);
  const payload = batchTargetsPayload(scores[0]!.request);
  expect(payload).not.toBeNull();
  expect(payload!.sourceSeqs).toEqual(frozen.map((row) => row.seq));
  expect(payload!.targets.map((target) => target.targetId).sort()).toEqual(["20002", "20004"]);
  // The direct input stays in the shared reference window, not A's ordinary pending input.
  expect(payload!.targets.find((target) => target.targetId === "20002")?.sourceSeqs).toEqual([
    rows[2]!.seq,
  ]);
  expect(payload!.targets.find((target) => target.targetId === "20004")?.sourceSeqs).toEqual([
    rows[4]!.seq,
  ]);
});

it("a repeat speaker's reply child anchors the new event instead of answered history and keeps its recipient", async () => {
  const f = setup();
  f.receive("92101", "20002", "ANSWERED_HISTORY_A");
  f.clock.seconds += 1;
  f.receive("92102", "20003", "ANSWERED_HISTORY_B");
  expect((await f.activate()).status).toBe("completed");
  const callsBefore = f.calls.length;
  f.clock.seconds += 60;
  f.receive("92103", "20002", "CURRENT_REQUEST_A");
  f.clock.seconds += 1;
  f.receive("92104", "20004", "CURRENT_REQUEST_C");
  expect((await f.activate()).status).toBe("completed");

  const replies = f.calls
    .slice(callsBefore)
    .filter((call) => call.kind === "complete" && !isBatchScore(call.request));
  expect(replies).toHaveLength(2);
  const request = replies.find((call) => authorizedTargetOf(call.request) === "20002")!.request;
  expect(request).toBeDefined();
  // History remains available; only the explicit current-input material identifies what to answer.
  expect(JSON.stringify(request.messages)).toContain("ANSWERED_HISTORY_A");
  expect(JSON.stringify(request.messages)).toContain("CURRENT_REQUEST_A");
  const conversation = f.journal.ensureOneBot(bindingId)!;
  const rows = f.db
    .query(
      "SELECT seq,event_key FROM conversation_events WHERE conversation_id=? AND kind='inbound' AND source_kind='qq_event' ORDER BY seq",
    )
    .all(conversation.id) as { seq: number; event_key: string }[];
  expect(rows).toHaveLength(4);
  expect(
    f.outbox
      .list({})
      .map((delivery) => delivery.target?.participantId)
      .sort(),
  ).toEqual(["20002", "20002", "20003", "20004"]);
  const anchors = request.messages.flatMap((message) =>
    message.content.flatMap((part) => {
      if (part.kind !== "text") return [];
      try {
        const value = JSON.parse(part.text);
        return value.kind === "qq_active_input" ? [value] : [];
      } catch {
        return [];
      }
    }),
  );
  expect(anchors).toHaveLength(1);
  const currentSource = f.db
    .query(
      "SELECT source_id FROM conversation_events WHERE conversation_id=? AND seq=? AND source_kind='qq_event'",
    )
    .get(conversation.id, rows[2]!.seq) as { source_id: string };
  expect(anchors[0]).toEqual({
    kind: "qq_active_input",
    trust: "data_only",
    targetId: "20002",
    sourceSeqs: [rows[2]!.seq],
    eventIds: [currentSource.source_id],
  });
});

it("keeps one room reply while anchoring only the remaining speakers' new inputs", async () => {
  const f = setup({ splitBySpeaker: false });
  f.receive("92201", "20002", "ROOM_HISTORY_A");
  f.clock.seconds += 1;
  f.receive("92202", "20003", "ROOM_HISTORY_B");
  expect((await f.activate()).status).toBe("completed");
  const before = f.calls.length;
  f.clock.seconds += 60;
  f.receive("92203", "20002", "ROOM_NEW_A");
  f.clock.seconds += 1;
  f.receive("92204", "20004", "ROOM_NEW_C");
  expect((await f.activate()).status).toBe("completed");
  const replies = f.calls
    .slice(before)
    .filter((call) => call.kind === "complete" && !isBatchScore(call.request));
  expect(replies).toHaveLength(1);
  expect(authorizedTargetOf(replies[0]!.request)).toBe("30003");
  const conversation = f.journal.ensureOneBot(bindingId)!;
  const rows = f.db
    .query(
      "SELECT seq,source_id FROM conversation_events WHERE conversation_id=? AND kind='inbound' AND source_kind='qq_event' ORDER BY seq",
    )
    .all(conversation.id) as { seq: number; source_id: string }[];
  expect(rows).toHaveLength(4);
  const request = replies[0]!.request;
  expect(JSON.stringify(request.messages)).toContain("ROOM_HISTORY_A");
  const anchors = request.messages.flatMap((message) =>
    message.content.flatMap((part) => {
      if (part.kind !== "text") return [];
      try {
        const value = JSON.parse(part.text);
        return value.kind === "qq_active_input" ? [value] : [];
      } catch {
        return [];
      }
    }),
  );
  expect(anchors).toEqual([
    {
      kind: "qq_active_input",
      trust: "data_only",
      targetId: "30003",
      sourceSeqs: rows.slice(2).map((row) => row.seq),
      eventIds: rows.slice(2).map((row) => row.source_id),
    },
  ]);
});

it("excludes a member's old ordinary candidate after a newer confirmed direct reply, but keeps new inputs", async () => {
  for (const hasNewInput of [false, true]) {
    const f = setup({ batchSize: 1 });
    f.receive("92301", "20002", "OLD_ORDINARY_P");
    f.clock.seconds += 1;
    recordInbound(
      f.orm,
      normalizeOneBotMessage(
        {
          post_type: "message",
          message_type: "group",
          sub_type: "normal",
          time: f.clock.seconds,
          self_id: 10001,
          user_id: 20002,
          group_id: 30003,
          message_id: "92302",
          message: [
            { type: "at", data: { qq: "10001" } },
            { type: "text", data: { text: "NEW_DIRECT_P" } },
          ],
          sender: { nickname: "P" },
        },
        "10001",
      ),
      { accountId: "10001", conversationIngress: f.adapter },
    );
    const direct = f.wakes.claim({ at: f.now(), leaseMs: 120000, cause: "direct_reply" });
    expect(direct).not.toBeNull();
    expect((await f.host.activate(direct!, new AbortController().signal)).status).toBe("completed");
    const delivery = new OutboundDelivery({
      orm: f.orm,
      repository: f.outbox,
      journal: f.journal,
      now: f.now,
      stickerFile: () => null,
      authorize: () => true,
      port: {
        async send() {
          return { kind: "confirmed", messageId: "synthetic-direct-p" };
        },
      },
    });
    await delivery.runOnce();
    expect(f.outbox.list({})[0]?.status).toBe("confirmed");
    const before = f.calls.length;
    f.clock.seconds += 60;
    if (hasNewInput) {
      f.receive("92303", "20002", "AFTER_DIRECT_NEW_P");
      f.clock.seconds += 1;
    }
    f.receive("92304", "20004", "INDEPENDENT_NEW_Q");
    expect((await f.activate()).status).toBe("completed");
    const later = f.calls.slice(before);
    const score = later.find((call) => isBatchScore(call.request));
    expect(score).toBeDefined();
    const expected = hasNewInput ? ["20002", "20004"] : ["20004"];
    expect(batchTargetIds(score!.request).sort()).toEqual(expected);
    expect(
      later
        .filter((call) => !isBatchScore(call.request))
        .map((call) => authorizedTargetOf(call.request))
        .sort(),
    ).toEqual(expected);
  }
});
