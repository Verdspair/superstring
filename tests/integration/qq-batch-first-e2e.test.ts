// BATCHQA 独立端到端验证（qq-flow-and-project-concurrency 批次）：真实 OneBotHost +
// AgentRuntime + 业务库合成夹具，验证批量优先（batch-first）自主批次的**最终批准行为**。
// 不复用旧 onebot 夹具（该文件在制），本文件自带最小合法夹具；X2/Y0 是显式合法方案值，
// 用于让两条合格成员事件构成一个批次机会——生产默认门槛（15/5）由 D1 专测，此处不重复。
// 不接真实 QQ/模型/网络：模型是受控 ModelPort 桩，阀门用 Promise，无 shell sleep。

import { afterEach, describe, expect, it } from "bun:test";
import { AgentRuntime } from "../../src/server/agent/agent-runtime";
import { inputUnits } from "../../src/server/agent/context-engine";
import type { ModelPort, ModelRequest } from "../../src/server/agent/model-port";
import { OneBot11Adapter } from "../../src/server/channels/onebot11/adapter";
import { OneBotHost } from "../../src/server/channels/onebot11/bot-host";
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
    batchSize?: number;
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
    ...(options.judgementBudget === undefined
      ? {}
      : { context: { ...QQ_CONTEXT_DEFAULT, judgement_token_budget: options.judgementBudget } }),
    reply: { split_by_speaker: true },
    triggers: { direct_reply: true, follow_up: false, chiming_in: true, idle_topic: true },
    rhythm: {
      ...QQ_RHYTHM_DEFAULT,
      initiative_batch_target_count: options.batchSize ?? 2,
      initiative_batch_jitter_count: 0,
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
  const clock = { seconds: time };
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
      expect(reply.request.tools?.map((tool) => tool.name)).toContain("speech.reply");
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
  });

  it("a batch evaluation missing a frozen candidate is a protocol failure, not a low score", async () => {
    const f = setup({
      evaluations: (ids) =>
        ids
          .filter((targetId) => targetId !== "20003")
          .map((targetId) => ({ targetId, score: 9, intent: "x", sourceSeqs: [] })),
    });
    f.receive("1", "20002");
    f.clock.seconds += 1;
    f.receive("2", "20003");
    const error = (await f.activate().catch((e: unknown) => e)) as { code?: string };
    expect(error.code).toBe("JUDGEMENT_TARGET_MISSING");
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
      payload.targets.every(
        (target: Record<string, unknown>) => !Object.hasOwn(target, "sourceSeqs"),
      ),
    ).toBe(true);
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
    expect(batch.sourceSeqs).toEqual([1, 2]);
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
    expect(payload.sourceSeqs).toHaveLength(200);
    expect(payload.sourceSeqs).toEqual(Array.from({ length: 200 }, (_, i) => i + 1));
    expect(payload.targets).toHaveLength(20);
    expect(f.calls).toHaveLength(1);
  });
});
