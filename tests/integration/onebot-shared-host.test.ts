import { afterEach, describe, expect, it } from "bun:test";
import { AgentRuntime } from "../../src/server/agent/agent-runtime";
import { inputUnits } from "../../src/server/agent/context-engine";
import type { ModelPort, ModelRequest } from "../../src/server/agent/model-port";
import { OneBot11Adapter } from "../../src/server/channels/onebot11/adapter";
import { OneBotHost } from "../../src/server/channels/onebot11/bot-host";
import { OutboundDelivery } from "../../src/server/conversation/outbound-delivery";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { KnowledgeRepository } from "../../src/server/db/knowledge-repository";
import { OutboundIntentRepository } from "../../src/server/db/outbound-intent-repository";
import { createQqScheme, updateQqScheme } from "../../src/server/db/qq-scheme-repository";
import { recordQqSend } from "../../src/server/db/qq-send-repository";
import {
  readQqSettings,
  updateQqSettings,
  updateQqStorageSettings,
} from "../../src/server/db/qq-settings-repository";
import { DEFAULT_AGENT_ID, ensureDefaults } from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { WakeRepository } from "../../src/server/db/wake-repository";
import { normalizeOneBotMessage } from "../../src/server/services/onebot-protocol";
import { recordInbound } from "../../src/server/services/qq-intake";
import { speechExpiresAt } from "../../src/server/services/qq-retention";
import { QQ_RHYTHM_DEFAULT } from "../../src/server/services/qq-rhythm-contract";
import type { ModelMessage } from "../../src/shared/contracts/agent-run";

const handles: ReturnType<typeof openBusinessDb>[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
});
const bindingId = "11111111-1111-4111-8111-111111111111",
  time = 2_000_000_000;
function setup(
  model: Partial<ModelPort> = {},
  options: {
    split?: boolean;
    recomputes?: number;
    mergeSeconds?: number;
    follow?: boolean;
    stickersEnabled?: () => boolean;
    onCompression?: (job: unknown) => void;
    onCapacity?: () => void;
  } = {},
) {
  const h = openBusinessDb();
  handles.push(h);
  ensureDefaults(h.orm, "reply-model");
  updateQqSettings(h.orm, {
    accountId: "10001",
    enabled: true,
    judgementModelName: "judge-model",
    expectedRevision: 1,
  });
  const scheme = createQqScheme(h.orm, {
    name: "group",
    reply: { split_by_speaker: options.split ?? true },
    // 连续与自主互斥（保存边界拒绝双 true）：默认只开自主，需要连续交谈的用例传 follow:true。
    triggers: {
      direct_reply: true,
      follow_up: options.follow ?? false,
      chiming_in: !(options.follow ?? false),
      idle_topic: true,
    },
    rhythm: {
      ...QQ_RHYTHM_DEFAULT,
      // 本文件不是批次门槛的验证面：把批量下界设为 1（X1/Y0，合法可配置，queue ON 保持），
      // 让 1 条合格成员事件即可进入既有 host 行为。真实批次门槛（X15/Y5）由 D1 专测。
      initiative_batch_target_count: 1,
      initiative_batch_jitter_count: 0,
      merge_window_seconds: options.mergeSeconds ?? 2,
      max_recompute_count: options.recomputes ?? 1,
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
  const requests: ModelRequest[] = [];
  const runtime = new AgentRuntime({
    repository: runs,
    now,
    model: {
      complete: async (req) => {
        requests.push(req);
        return '{"kind":"none"}';
      },
      async *streamText(req) {
        requests.push(req);
        yield "reply\nfor target";
      },
      completeMultimodal: async () => "",
      ...model,
    },
  });
  const gateway = {
    complete: async () => {
      throw new Error("UNIFIED_RUNTIME_REQUIRED");
    },
    loadedContextCapacity: async () => {
      options.onCapacity?.();
      return 65536;
    },
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
    stickersEnabled: options.stickersEnabled,
    policy: () => ({ maxSteps: 20, deliveryTtlSeconds: 600 }),
    now,
    ...(options.onCompression ? { enqueueCompression: options.onCompression } : {}),
  });
  const receive = (
    id: string,
    speaker = "20002",
    addressed = false,
    text = "hello",
    reply?: string,
  ) =>
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
          message: [
            ...(reply ? [{ type: "reply", data: { id: reply } }] : []),
            ...(addressed ? [{ type: "at", data: { qq: "10001" } }] : []),
            { type: "text", data: { text } },
          ],
          sender: { nickname: speaker },
        },
        "10001",
      ),
      { accountId: "10001", conversationIngress: adapter },
    );
  const activate = async (cause?: string) => {
    const wake = wakes.claim({ at: now(), leaseMs: 120000, cause })!;
    expect(wake).not.toBeNull();
    return host.activate(wake, new AbortController().signal);
  };
  return {
    ...h,
    journal,
    wakes,
    outbox,
    runs,
    requests,
    runtime,
    adapter,
    host,
    clock,
    now,
    receive,
    activate,
    scheme,
  };
}
const generate = (ids: string[]) =>
  JSON.stringify({
    kind: "final",
    outputs: ids.map((targetId) => ({ kind: "generate", targetId, instructions: "respond" })),
  });

/** 从批量评分请求里取出本批候选 target id（data_only 的 qq_batch_targets 块）。 */
const batchTargetIds = (request: { messages?: readonly { content?: unknown }[] }): string[] => {
  for (const message of request.messages ?? []) {
    const parts = Array.isArray(message.content) ? message.content : [];
    for (const part of parts as { kind?: string; text?: string }[]) {
      if (part.kind !== "text" || typeof part.text !== "string") continue;
      try {
        const data = JSON.parse(part.text) as { kind?: string; targets?: { targetId: string }[] };
        if (data.kind === "qq_batch_targets" && data.targets)
          return data.targets.map((entry) => entry.targetId);
      } catch {}
    }
  }
  return [];
};

/** 阶段一批量评分的响应：对给定 target 集合逐人给分（D1 的批 schema）。 */
const batchScores = (ids: string[], score = 9) =>
  JSON.stringify({
    evaluations: ids.map((targetId) => ({ targetId, score, intent: "respond", sourceSeqs: [] })),
  });

/**
 * 本文件里的评分桩：批量评分请求的 responseSchema 带 `evaluations`（区别于单判的 `score`）。
 * 返回该批候选的逐人结论。
 */
const isBatchScore = (request: { responseSchema?: { properties?: Record<string, unknown> } }) =>
  request.responseSchema?.properties?.evaluations !== undefined;

/** 轮询等待条件成立（用于观察在飞 run 的中间状态）。 */
const waitFor = async (predicate: () => boolean, timeoutMs = 3000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("WAIT_TIMEOUT");
    await Bun.sleep(5);
  }
};

/**
 * 可中止等待：外部 gate 未放行时若 signal 中止，立即以中止原因 reject 并移除监听；
 * 否则崩溃用例里挂起的生成器会永久卡住整批结算（无法 allSettle）。
 */
const abortableWait = (gate: Promise<void>, signal?: AbortSignal): Promise<void> => {
  if (signal === undefined) return gate;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void gate.then(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
};
describe("shared Bot model-controlled conversation", () => {
  it("captures the sticker switch per reply and preserves the text path while paused", async () => {
    let enabled = true;
    let offered: string[][] = [];
    const f = setup(
      {
        complete: async (request) => {
          offered.push(request.tools?.map((tool) => tool.name) ?? []);
          enabled = false;
          return generate(["20002"]);
        },
      },
      { stickersEnabled: () => enabled },
    );
    f.receive("9901", "20002", true);
    expect((await f.activate("direct_reply")).status).toBe("completed");
    expect(offered[0]).toContain("sticker.search");
    f.clock.seconds += 2;
    f.receive("9902", "20002", true);
    offered = [];
    expect((await f.activate("direct_reply")).status).toBe("completed");
    expect(offered[0]).not.toContain("sticker.search");
    expect(f.outbox.list({})).toHaveLength(2);
  });

  it("把输出预留下发为 max_tokens：direct/continuous 决策与生成都用回复预留，方案改值后新轮生效", async () => {
    const seen: ModelRequest[] = [];
    const h = setup({
      complete: async (request) => {
        seen.push(request);
        return generate(["20002"]);
      },
      async *streamText(request) {
        seen.push(request);
        yield "answer";
      },
    });
    const textOf = (request: ModelRequest) =>
      request.messages
        .flatMap((message) =>
          message.content.flatMap((part) => (part.kind === "text" ? [part.text] : [])),
        )
        .join("\n");
    const find = (marker: string) => seen.find((request) => textOf(request).includes(marker));
    h.receive("1", "20002", true);
    expect((await h.activate("direct_reply")).status).toBe("completed");
    // 群聊 direct 走**回复档**（规格 §3.3）：决策与生成/重算都按回复预留（默认 2048）下发。
    expect(find("Return exactly one JSON decision")?.maxTokens).toBe(2048);
    expect(find("Write only the response body")?.maxTokens).toBe(2048);
    seen.length = 0;
    updateQqScheme(h.orm, h.scheme.id, {
      name: h.scheme.name,
      outputReserve: { judgement_output_reserved: 640, reply_output_reserved: 896 },
      expectedRevision: h.scheme.revision,
    });
    h.clock.seconds += 2;
    h.receive("2", "20002", true);
    expect((await h.activate("direct_reply")).status).toBe("completed");
    expect(find("Return exactly one JSON decision")?.maxTokens).toBe(896);
    expect(find("Write only the response body")?.maxTokens).toBe(896);
  });

  it("group direct replies on the first call via speech.reply with native tools advertised and reply tier", async () => {
    let calls = 0;
    const seen: ModelRequest[] = [];
    const h = setup({
      complete: async (request) => {
        calls++;
        seen.push(request);
        return JSON.stringify({
          kind: "invoke",
          name: "speech.reply",
          arguments: {
            outputs: [{ kind: "inline", targetId: "20002", text: "hi", stickerIds: [] }],
          },
        });
      },
      async *streamText() {
        yield "should-not-stream";
      },
    });
    h.receive("1", "20002", true);
    const result = await h.activate("direct_reply");
    expect(result.status).toBe("completed");
    // 首 call 直接回，不前置意图/生成。
    expect(calls).toBe(1);
    // 终结能力进同一次原生工具目录（系统声明与 tools 都能看到它）。
    expect(seen[0].tools?.map((tool) => tool.name)).toContain("speech.reply");
    expect(JSON.stringify(seen[0].messages)).toContain("speech.reply");
    // 首 call 就是**回复正文任务**：带 qqEffectiveReplyPrompt 的正文任务提示词（custom/sentinel）。
    expect(JSON.stringify(seen[0].messages)).toContain("写这一轮要发的话");
    // 群 direct 用回复档预留。
    expect(seen[0].maxTokens).toBe(2048);
    expect(h.outbox.list({})[0]!.target?.participantId).toBe("20002");
  });

  it("carries structured mentionIds into the committed outbox part", async () => {
    const h = setup({
      complete: async () =>
        JSON.stringify({
          kind: "invoke",
          name: "speech.reply",
          arguments: {
            outputs: [
              {
                kind: "inline",
                targetId: "20002",
                text: "ping",
                mentionIds: ["20002"],
                stickerIds: [],
              },
            ],
          },
        }),
    });
    h.receive("1", "20002", true);
    expect((await h.activate("direct_reply")).status).toBe("completed");
    const intent = h.outbox.list({})[0]!;
    const part = h.outbox.parts(intent.id)[0]!;
    // 结构化 mention 进入 outbox part 的 payload.mentions；正文 CQ 不再被解释为编码来源。
    expect(JSON.parse(part.payload!)).toEqual({ text: "ping", mentions: ["20002"] });
  });

  it("continuous with scheme split off still replies per person, one target each, no none", async () => {
    const seen: ModelRequest[] = [];
    const h = setup(
      {
        complete: async (request) => {
          seen.push(request);
          return JSON.stringify({
            kind: "invoke",
            name: "speech.reply",
            // 两位不同发言人各一条：不合并成 room 单条，也不能 none。
            arguments: {
              outputs: [
                { kind: "inline", targetId: "20002", text: "to A", stickerIds: [] },
                { kind: "inline", targetId: "20003", text: "to B", stickerIds: [] },
              ],
            },
          });
        },
        async *streamText() {
          yield "should-not-stream";
        },
      },
      { split: false, follow: true },
    );
    recordQqSend(h.orm, {
      scope: {
        kind: "qq",
        accountId: "10001",
        conversationKind: "group",
        peerId: "30003",
        agentId: DEFAULT_AGENT_ID,
      },
      kind: "direct_reply",
      parts: [{ kind: "text", result: "confirmed", messageId: "previous" }],
      text: "previous",
      sentAtSeconds: time - 10,
    });
    h.receive("1", "20002", false);
    h.receive("2", "20003", false);
    h.clock.seconds += 5;
    // 连续交谈按人滚动：每个人各有一次唤醒，各自回他自己的那条。
    const first = await h.activate("follow_up");
    const second = await h.activate("follow_up");
    expect(first.status).toBe("completed");
    expect(second.status).toBe("completed");
    // 首 call 即回复档正文任务（回复提示词与终结能力出现在首条 wire），非判断档。
    expect(JSON.stringify(seen[0].messages)).toContain("speech.reply");
    expect(seen[0].maxTokens).toBe(2048);
    // 连续交谈强制按人：两位各一条，按 speaker 目标（scheme split 关了也如此）。
    expect(
      h.outbox
        .list({})
        .map((d) => d.target?.participantId)
        .sort(),
    ).toEqual(["20002", "20003"]);
  });

  it("continuous (follow_up) refuses a silent none instead of dropping a required reply", async () => {
    let calls = 0;
    const h = setup(
      {
        complete: async () => {
          calls++;
          return '{"kind":"none"}';
        },
      },
      { follow: true },
    );
    // 先有一次她自己的发言，随后的成员消息才归 continuous。
    recordQqSend(h.orm, {
      scope: {
        kind: "qq",
        accountId: "10001",
        conversationKind: "group",
        peerId: "30003",
        agentId: DEFAULT_AGENT_ID,
      },
      kind: "direct_reply",
      parts: [{ kind: "text", result: "confirmed", messageId: "previous" }],
      text: "previous",
      sentAtSeconds: time - 10,
    });
    h.receive("1", "20002", false);
    h.clock.seconds += 5;
    // continuous 是"必回"：模型返回 none 时宿主明确拒绝，不静默当无输出。
    await expect(h.activate("follow_up")).rejects.toThrow("CONTINUOUS_REPLY_REQUIRED");
    expect(calls).toBeGreaterThan(0);
  });

  it("keeps addressed target even when another speaker is newer; unrelated later events do not block delivery", async () => {
    let h: ReturnType<typeof setup>;
    let generated = 0;
    h = setup({
      complete: async () => generate(["20002"]),
      async *streamText(req) {
        expect(req.model).toBe("reply-model");
        generated++;
        h.receive("3", "20004", false, "unrelated during output");
        yield "answer\nline";
      },
    });
    h.receive("1", "20002", true);
    h.receive("2", "20003", false);
    const result = await h.activate("direct_reply");
    expect(result.status).toBe("completed");
    expect(generated).toBe(1);
    const intent = h.outbox.list({})[0]!;
    expect(intent.target).toEqual({ peerId: "30003", participantId: "20002" });
    const sends: unknown[] = [];
    const delivery = new OutboundDelivery({
      orm: h.orm,
      repository: h.outbox,
      journal: h.journal,
      authorize: () => true,
      stickerFile: () => null,
      now: h.now,
      port: {
        async send(request) {
          sends.push(request);
          return { kind: "confirmed", messageId: "sent" };
        },
      },
    });
    await delivery.deliver(intent.id);
    // 新协议：结构化 mention 是 @ 的唯一来源；本轮没有 mentionIds，所以正文按字面文本发送
    // （不再由程序自动 @ 收件人）。收件人仍由 target.participantId 决定投递去向。
    expect(sends).toEqual([
      {
        kind: "group",
        peerId: "30003",
        message: [{ type: "text", data: { text: "answer line" } }],
      },
    ]);
  });
  it("ordinary group activity keeps participant opportunities and one Agent run evaluates and replies to the mature batch", async () => {
    let decisions = 0;
    const scoreModels: string[] = [];
    const generated: string[] = [];
    const h = setup({
      complete: async (req) => {
        // 阶段一批量评分：一次调用对整批候选逐人给分（D1 的 QQ_BATCH_JUDGEMENT_RESPONSE_SCHEMA）。
        const schema = req.responseSchema as { properties?: Record<string, unknown> } | undefined;
        if (schema?.properties?.evaluations) {
          scoreModels.push(req.model!);
          return JSON.stringify({
            evaluations: [
              { targetId: "20002", score: 9, intent: "a", sourceSeqs: [] },
              { targetId: "20003", score: 9, intent: "b", sourceSeqs: [] },
            ],
          });
        }
        decisions++;
        return generate(["20002", "20003"]);
      },
      async *streamText(req) {
        generated.push(JSON.stringify(req.messages[0]));
        yield "separate\nmessage";
      },
    });
    h.receive("1", "20002");
    h.clock.seconds++;
    h.receive("2", "20003");
    // 自主批次是**一个**会话级合并机会（D1 批次边界），不是每人一个 wake。
    expect(
      h.db.query("SELECT COUNT(*) AS n FROM wake_signals WHERE status='pending'").get(),
    ).toEqual({ n: 1 });
    h.clock.seconds += 2;
    const result = await h.activate("chiming_in");
    expect(result.status).toBe("completed");
    // 整批**一次**评分调用（而非逐人两次）。
    expect(scoreModels).toEqual(["judge-model"]);
    expect(generated).toHaveLength(2);
    expect(generated[0]).toContain("20002");
    expect(generated[1]).toContain("20003");
    expect(h.outbox.list({}).map((d) => d.target?.participantId)).toEqual(["20002", "20003"]);
    expect(h.outbox.list({}).map((d) => h.outbox.parts(d.id).length)).toEqual([1, 1]);
  });
  it("keeps shared replies unsplit with no forced recipient when the scheme switch is off", async () => {
    const h = setup({ complete: async () => generate(["30003", "30003"]) }, { split: false });
    h.receive("1", "20002", true);
    await h.activate("direct_reply");
    expect(h.outbox.list({})).toHaveLength(1);
    const intent = h.outbox.list({})[0]!;
    expect(intent.target).toEqual({ peerId: "30003", participantId: null });
    expect(h.outbox.parts(intent.id)).toHaveLength(2);
  });
  it("verified reply to an assistant receipt is addressed without fabricating a mention", () => {
    const h = setup();
    recordQqSend(h.orm, {
      scope: {
        kind: "qq",
        accountId: "10001",
        conversationKind: "group",
        peerId: "30003",
        agentId: DEFAULT_AGENT_ID,
      },
      kind: "direct_reply",
      parts: [{ kind: "text", result: "confirmed", messageId: "100", stickerId: null }],
      text: "assistant",
      sentAtSeconds: time - 1,
    });
    h.receive("1", "20002", false, "reply", "100");
    const c = h.journal.ensureOneBot(bindingId)!;
    const message = h.journal.eventsAfter(c.id).items.find((e) => e.kind === "inbound")!;
    expect(message.addressing.reasons).toEqual(["reply_to_agent"]);
    expect(message.addressing.mentionIds).toEqual([]);
    expect(h.wakes.peek({ at: h.now() })?.cause).toBe("direct_reply");
  });
  it("a new unaddressed partner message after own speech becomes follow_up", async () => {
    const h = setup({ complete: async () => generate(["20002"]) }, { follow: true });
    recordQqSend(h.orm, {
      scope: {
        kind: "qq",
        accountId: "10001",
        conversationKind: "group",
        peerId: "30003",
        agentId: DEFAULT_AGENT_ID,
      },
      kind: "direct_reply",
      parts: [{ kind: "text", result: "confirmed", messageId: "100", stickerId: null }],
      text: "assistant",
      sentAtSeconds: time - 1,
    });
    h.receive("1");
    // 连续交谈现按人滚动：merge 窗口过后才成熟，等过一个窗口再取。
    h.clock.seconds += 5;
    expect(h.wakes.peek({ at: h.now() })?.cause).toBe("follow_up");
    expect((await h.activate("follow_up")).status).toBe("completed");
  });
  for (const count of [0, 2])
    it(`bounds independent generation calls with configured recompute budget ${count}`, async () => {
      let h: ReturnType<typeof setup>;
      let generations = 0;
      h = setup(
        {
          complete: async (request) =>
            JSON.stringify(request.messages).includes("generation_budget_exhausted")
              ? '{"kind":"none"}'
              : generate(["20002"]),
          async *streamText() {
            generations++;
            if (generations <= 2) h.receive(String(generations + 1), "20002", true);
            yield "draft";
          },
        },
        { recomputes: count },
      );
      h.receive("1", "20002", true);
      if (count === 0) {
        expect((await h.activate()).status).toBe("no_output");
        expect(generations).toBe(1);
        expect(h.outbox.list({})).toEqual([]);
        expect(h.journal.ensureOneBot(bindingId)!.consumedSeq).toBeGreaterThan(0);
      } else {
        expect((await h.activate()).status).toBe("completed");
        expect(generations).toBe(3);
        expect(h.outbox.list({})).toHaveLength(1);
      }
    });
  it("migrates a pending legacy candidate once without changing its ready time", () => {
    const h = setup();
    h.receive("1");
    const event = h.db.query("SELECT event_key FROM qq_events WHERE message_id='1'").get() as {
      event_key: string;
    };
    h.db.exec("DELETE FROM wake_signals");
    h.db
      .query(
        "INSERT INTO qq_dispatch_candidates(conversation_key,binding_id,event_key,path,ready_at_seconds,observed_at_seconds,generation) VALUES('legacy',?,?,'chiming_in',?,?,4)",
      )
      .run(bindingId, event.event_key, time + 10, time);
    expect(h.adapter.migrateLegacyCandidates()).toBe(1);
    expect(h.adapter.migrateLegacyCandidates()).toBe(0);
    expect(h.db.query("SELECT ready_at,through_seq FROM wake_signals").get()).toMatchObject({
      ready_at: new Date((time + 10) * 1000).toISOString(),
      through_seq: 1,
    });
    expect(h.db.query("SELECT * FROM qq_dispatch_candidates").all()).toEqual([]);
  });
});
describe("shared configuration and races", () => {
  for (const mode of ["hard", "soft"])
    it(`preserves ${mode} attention semantics on the actual new ingress`, async () => {
      const h = setup({ complete: async () => generate(["20003"]) });
      h.db
        .query("UPDATE qq_bindings SET attention_mode=?,attention_members='[\"20002\"]' WHERE id=?")
        .run(mode, bindingId);
      h.receive("1", "20003", true);
      if (mode === "hard") {
        expect(h.wakes.peek({ at: h.now() })).toBeNull();
        expect(
          h.journal
            .eventsAfter(h.journal.ensureOneBot(bindingId)!.id)
            .items.filter((e) => e.kind === "inbound"),
        ).toHaveLength(1);
      } else {
        expect((await h.activate()).status).toBe("completed");
        expect(h.outbox.list({})[0]!.target?.participantId).toBe("20003");
      }
    });
  it("continues another recipient after one generation fails and preserves both output statuses", async () => {
    const h = setup({
      complete: async (req) =>
        isBatchScore(req) ? batchScores(batchTargetIds(req)) : generate(["20002", "20003"]),
      async *streamText(req) {
        if (JSON.stringify(req.messages[0]).includes('authorizedTarget\\":\\"20002'))
          throw new Error("MODEL_FAILED");
        yield "second recipient survives";
      },
    });
    h.receive("1", "20002");
    h.receive("2", "20003");
    h.clock.seconds += 2;
    const result = await h.activate();
    expect(result.status).toBe("completed");
    expect("outputs" in result ? result.outputs.map((o) => o.status) : []).toEqual([
      "failed",
      "prepared",
    ]);
    expect(h.outbox.list({}).map((d) => d.target?.participantId)).toEqual(["20003"]);
  });
  it("commits a fast target's outbox while a slow sibling is still generating, parent not terminal", async () => {
    let releaseSlow = () => {};
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const h = setup({
      complete: async (req) =>
        isBatchScore(req) ? batchScores(batchTargetIds(req)) : generate(["20002", "20003"]),
      async *streamText(req) {
        // 慢目标挂起等待外部放行；快目标立刻产出正文，验证早提交不等整批。
        if (JSON.stringify(req.messages[0]).includes("20002")) {
          yield "fast recipient";
          return;
        }
        await abortableWait(slowGate, req.signal);
        yield "slow recipient";
      },
    });
    h.receive("1", "20002");
    h.receive("2", "20003");
    h.clock.seconds += 2;
    const pending = h.activate();
    try {
      // 快目标生成完成即写自己的 outbox 行——此时慢目标仍在生成、父 run 仍非终态。
      await waitFor(() => h.outbox.list({}).some((d) => d.target?.participantId === "20002"));
      expect(h.outbox.list({}).map((d) => d.target?.participantId)).toEqual(["20002"]);
      const parentRuns = h.db
        .query("SELECT status FROM agent_runs WHERE spec_id='onebot.initiative.batch'")
        .all() as { status: string }[];
      expect(parentRuns).toHaveLength(1);
      expect(["completed", "failed", "cancelled"]).not.toContain(parentRuns[0]!.status);
    } finally {
      releaseSlow();
    }
    const result = await pending;
    expect(result.status).toBe("completed");
    expect(
      h.outbox
        .list({})
        .map((d) => d.target?.participantId)
        .sort(),
    ).toEqual(["20002", "20003"]);
  });
  it("forks a per-target session source so children keep their own intent and run id", async () => {
    const generationPrompts: string[] = [];
    const h = setup({
      complete: async (req) => {
        if (isBatchScore(req))
          return JSON.stringify({
            evaluations: batchTargetIds(req).map((targetId) => ({
              targetId,
              score: 9,
              intent: targetId === "20002" ? "announce-alpha" : "announce-beta",
              sourceSeqs: [],
            })),
          });
        return generate(["20002", "20003"]);
      },
      async *streamText(req) {
        generationPrompts.push(JSON.stringify(req.messages));
        yield "ok";
      },
    });
    h.receive("1", "20002");
    h.receive("2", "20003");
    h.clock.seconds += 2;
    const result = await h.activate();
    expect(result.status).toBe("completed");
    expect(generationPrompts).toHaveLength(2);
    const forAlpha = generationPrompts.find((prompt) => prompt.includes("announce-alpha"))!;
    const forBeta = generationPrompts.find((prompt) => prompt.includes("announce-beta"))!;
    expect(forAlpha).toBeDefined();
    expect(forBeta).toBeDefined();
    // 每个子 run 只带本人的 intent（独立 source）：alpha 材料里没有 beta 的意图，反之亦然。
    expect(forAlpha).not.toContain("announce-beta");
    expect(forBeta).not.toContain("announce-alpha");
    // 两个子 run 各有独立 run row（bindRun 的 runId 不互相覆写）。
    const replyRuns = h.db
      .query("SELECT run_id FROM agent_runs WHERE spec_id='onebot.main'")
      .all() as { run_id: string }[];
    expect(replyRuns).toHaveLength(2);
    expect(new Set(replyRuns.map((run) => run.run_id)).size).toBe(2);
  });
  it("prepares the reply view once so forked children do not re-compress the watermark", async () => {
    let capacityProbes = 0;
    const h = setup(
      {
        complete: async (req) =>
          isBatchScore(req) ? batchScores(batchTargetIds(req)) : generate(["20002", "20003"]),
        async *streamText() {
          yield "ok";
        },
      },
      { onCapacity: () => (capacityProbes += 1) },
    );
    h.receive("1", "20002");
    h.receive("2", "20003");
    h.clock.seconds += 2;
    const result = await h.activate();
    expect(result.status).toBe("completed");
    // 父先建 reply 档视图一次：容量探针恰 2 次＝判断档（1）＋父的 reply 档（1）；
    // 两个子 run 复制该视图与容量缓存，不各自重建（否则两 child 各建一次＝3，已实测）。
    expect(capacityProbes).toBe(2);
  });
  it("resumes a fully committed opportunity without re-judging or replaying (0 model calls)", async () => {
    let judgeCalls = 0;
    const generations: string[] = [];
    const h = setup({
      complete: async (req) => {
        if (isBatchScore(req)) {
          judgeCalls += 1;
          return batchScores(batchTargetIds(req));
        }
        return generate(["20002", "20003"]);
      },
      async *streamText(req) {
        generations.push(JSON.stringify(req.messages));
        yield "ok";
      },
    });
    h.receive("1", "20002");
    h.receive("2", "20003");
    h.clock.seconds += 2;
    const wake = h.wakes.claim({ at: h.now(), leaseMs: 120000 })!;
    const first = await h.host.activate(wake, new AbortController().signal);
    expect(first.status).toBe("completed");
    expect(judgeCalls).toBe(1);
    expect(generations).toHaveLength(2);
    // 崩溃恢复：committed 已落（outbox 行），但 wake 未结算——重新租约同一行再跑一次
    //（模拟进程中断后重取同一冻结机会）。
    const crashToken = "lease-crash-resume";
    h.db
      .query(
        "UPDATE wake_signals SET status='leased', lease_token=?, lease_expires_at=?, attempts=attempts+1 WHERE id=?",
      )
      .run(crashToken, new Date((h.clock.seconds + 600) * 1000).toISOString(), wake.id);
    const resumed = await h.host.activate(
      { ...wake, leaseToken: crashToken, status: "leased" },
      new AbortController().signal,
    );
    expect(resumed.status).toBe("no_output");
    expect(judgeCalls).toBe(1); // 0 次新判断调用（全已提交，判定前查 outbox）
    expect(generations).toHaveLength(2); // 不重生成已提交目标
    expect(h.outbox.list({})).toHaveLength(2);
  });
  it("resumes a partially committed opportunity by reusing the persisted stage-1 judgement", async () => {
    let judgeCalls = 0;
    let hangSlow = true;
    let releaseSlow = () => {};
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const generations: string[] = [];
    const h = setup({
      complete: async (req) => {
        if (isBatchScore(req)) {
          judgeCalls += 1;
          return batchScores(batchTargetIds(req));
        }
        return generate(["20002", "20003"]);
      },
      async *streamText(req) {
        const isFast = JSON.stringify(req.messages[0]).includes("20002");
        if (!isFast && hangSlow) await abortableWait(slowGate, req.signal);
        yield "ok";
        generations.push(isFast ? "20002" : "20003");
      },
    });
    h.receive("1", "20002");
    h.receive("2", "20003");
    h.clock.seconds += 2;
    const wake = h.wakes.claim({ at: h.now(), leaseMs: 120000 })!;
    const crash = new AbortController();
    const crashing = h.host.activate(wake, crash.signal);
    // 快目标早提交后中断（模拟崩溃）：20002 已 committed，20003 未完成。
    try {
      await waitFor(() => h.outbox.list({}).some((d) => d.target?.participantId === "20002"));
      crash.abort(new Error("CRASH"));
      await expect(crashing).rejects.toBeTruthy();
    } finally {
      releaseSlow();
    }
    expect(judgeCalls).toBe(1);
    // 恢复走真实重启语义：租约到期后 WakeRepository.recover 把该 wake 退回 pending，再 claim
    // 同一行（不是手工 SQL 伪造租约）。判断步 raw 经 exact wake 链接持久复用，不重判；只补缺目标。
    hangSlow = false;
    h.clock.seconds += 121;
    expect(h.wakes.recover({ at: h.now(), maxAttempts: 5, retryDelayMs: 1000 })).toBe(1);
    h.clock.seconds += 2;
    const resumedWake = h.wakes.claim({ at: h.now(), leaseMs: 120000, wakeId: wake.id })!;
    expect(resumedWake.id).toBe(wake.id);
    const resumed = await h.host.activate(resumedWake, new AbortController().signal);
    expect(resumed.status).toBe("completed");
    expect(judgeCalls).toBe(1); // 复用持久判断：0 次新判断调用
    expect(generations.filter((target) => target === "20002")).toHaveLength(1); // 不重放已提交
    expect(generations.filter((target) => target === "20003")).toHaveLength(1); // 只补缺目标
    expect(
      h.outbox
        .list({})
        .map((d) => d.target?.participantId)
        .sort(),
    ).toEqual(["20002", "20003"]);
  });
  it("re-judges instead of consuming a redacted stage-1 judgement context after recovery", async () => {
    let judgeCalls = 0;
    let hangSlow = true;
    let releaseSlow = () => {};
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const generationPrompts: string[] = [];
    const h = setup({
      complete: async (req) => {
        if (isBatchScore(req)) {
          judgeCalls += 1;
          const intent = judgeCalls === 1 ? "stale-intent" : "fresh-intent";
          return JSON.stringify({
            evaluations: batchTargetIds(req).map((targetId) => ({
              targetId,
              score: 9,
              intent,
              sourceSeqs: [],
            })),
          });
        }
        return generate(["20002", "20003"]);
      },
      async *streamText(req) {
        generationPrompts.push(JSON.stringify(req.messages));
        const isFast = JSON.stringify(req.messages[0]).includes("20002");
        if (!isFast && hangSlow) await abortableWait(slowGate, req.signal);
        yield "ok";
      },
    });
    h.receive("1", "20002");
    h.receive("2", "20003");
    h.clock.seconds += 2;
    const wake = h.wakes.claim({ at: h.now(), leaseMs: 120000 })!;
    const crash = new AbortController();
    const crashing = h.host.activate(wake, crash.signal);
    try {
      await waitFor(() => h.outbox.list({}).some((d) => d.target?.participantId === "20002"));
      crash.abort(new Error("CRASH"));
      await expect(crashing).rejects.toBeTruthy();
    } finally {
      releaseSlow();
    }
    expect(judgeCalls).toBe(1);
    // 只清掉旧判断步 ctx 的正文与状态（redactSource，真实 API + 真实 source_refs）；当前 QQ 来源
    // 授权仍然合法——所以"旧正文不可复用"不等于"当前来源不可用"，不得就此判成未授权。
    const snapshot = h.db
      .query(
        `SELECT c.source_refs AS source_refs FROM context_snapshots c
         JOIN agent_steps s ON s.step_id=c.step_id
         JOIN agent_runs r ON r.run_id=s.run_id
         WHERE r.spec_id='onebot.initiative.evaluate_batch' AND r.wake_id=? AND c.status='exact'
         ORDER BY r.rowid DESC LIMIT 1`,
      )
      .get(wake.id) as { source_refs: string } | null;
    expect(snapshot).not.toBeNull();
    const refs = JSON.parse(snapshot!.source_refs) as { kind: string; id: string }[];
    expect(refs.length).toBeGreaterThan(0);
    let redacted = 0;
    for (const ref of refs) redacted += h.runs.redactSource(ref.kind, ref.id, "revoked");
    expect(redacted).toBeGreaterThan(0);
    // 恢复：真实租约到期→recover→claim 同一 wake。旧正文不得被消费：当前来源仍合法，允许按新判断
    // 补缺目标回复（SPEC 只要求不重放旧缓存，不禁止合法重判）。
    hangSlow = false;
    const beforeResume = generationPrompts.length;
    h.clock.seconds += 121;
    expect(h.wakes.recover({ at: h.now(), maxAttempts: 5, retryDelayMs: 1000 })).toBe(1);
    h.clock.seconds += 2;
    const resumedWake = h.wakes.claim({ at: h.now(), leaseMs: 120000, wakeId: wake.id })!;
    expect(resumedWake.id).toBe(wake.id);
    const resumed = await h.host.activate(resumedWake, new AbortController().signal);
    expect(resumed.status).toBe("completed");
    expect(judgeCalls).toBe(2); // 旧 raw 未被消费：按当前合法来源重新判断
    // 恢复只补缺目标 20003，且其材料是新判断的 fresh-intent，不是旧保护正文的 stale-intent。
    const resumedPrompts = generationPrompts.slice(beforeResume);
    expect(resumedPrompts).toHaveLength(1);
    expect(resumedPrompts[0]).toContain("20003");
    expect(resumedPrompts[0]).toContain("fresh-intent");
    expect(resumedPrompts[0]).not.toContain("stale-intent");
    // 已提交目标不重生成；缺目标在当前来源合法下正常补回复。
    expect(
      h.outbox
        .list({})
        .map((d) => d.target?.participantId)
        .sort(),
    ).toEqual(["20002", "20003"]);
  });
  it("refuses to reuse a stage-1 judgement after its observation sources expire", async () => {
    let judgeCalls = 0;
    let hangSlow = true;
    let releaseSlow = () => {};
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    const h = setup({
      complete: async (req) => {
        if (isBatchScore(req)) {
          judgeCalls += 1;
          return batchScores(batchTargetIds(req));
        }
        return generate(["20002", "20003"]);
      },
      async *streamText(req) {
        const isFast = JSON.stringify(req.messages[0]).includes("20002");
        if (!isFast && hangSlow) await abortableWait(slowGate, req.signal);
        yield "ok";
      },
    });
    h.receive("1", "20002");
    h.receive("2", "20003");
    h.clock.seconds += 2;
    const wake = h.wakes.claim({ at: h.now(), leaseMs: 120000 })!;
    const crash = new AbortController();
    const crashing = h.host.activate(wake, crash.signal);
    try {
      await waitFor(() => h.outbox.list({}).some((d) => d.target?.participantId === "20002"));
      crash.abort(new Error("CRASH"));
      await expect(crashing).rejects.toBeTruthy();
    } finally {
      releaseSlow();
    }
    expect(judgeCalls).toBe(1);
    // 真实来源失效：把承载本批成员证据的观察正文置为已过期（真实 store 语义；不是 redact 旧 ctx，也不造假权限表）。
    h.db.exec("UPDATE qq_observation_text SET expires_at='2000-01-01T00:00:00.000Z'");
    hangSlow = false;
    h.clock.seconds += 121;
    expect(h.wakes.recover({ at: h.now(), maxAttempts: 5, retryDelayMs: 1000 })).toBe(1);
    h.clock.seconds += 2;
    const resumedWake = h.wakes.claim({ at: h.now(), leaseMs: 120000, wakeId: wake.id })!;
    // 恢复必须经 current guard 拒绝：旧判断 ctx 的来源已过期，不得复用旧 raw 产出缺目标未授权回复。
    await expect(h.host.activate(resumedWake, new AbortController().signal)).rejects.toMatchObject({
      code: "CONTEXT_SOURCE_INVALID",
    });
    expect(h.outbox.list({}).map((d) => d.target?.participantId)).toEqual(["20002"]);
  });
  it("a related message buried under an unrelated latest message still causes a new decision", async () => {
    let h: ReturnType<typeof setup>;
    let generations = 0;
    h = setup({
      complete: async () => generate(["20002"]),
      async *streamText() {
        generations++;
        if (generations === 1) {
          h.receive("2", "20002", false, "related");
          h.receive("3", "20004", false, "unrelated latest");
        }
        yield "reply";
      },
    });
    h.receive("1", "20002", true);
    expect((await h.activate()).status).toBe("completed");
    expect(generations).toBe(2);
  });
  it("new addressed participant becomes an authorized target when re-deciding", async () => {
    let h: ReturnType<typeof setup>;
    let calls = 0;
    h = setup({
      complete: async (req) => {
        calls++;
        if (calls === 2) expect(JSON.stringify(req.messages[0])).toContain("20003");
        return generate(calls === 1 ? ["20002"] : ["20002", "20003"]);
      },
      async *streamText() {
        if (calls === 1) h.receive("2", "20003", true);
        yield "reply";
      },
    });
    h.receive("1", "20002", true);
    await h.activate();
    expect(h.outbox.list({}).map((d) => d.target?.participantId)).toEqual(["20002", "20003"]);
  });
  it("new addressed message after final but before network marks the committed plan stale", async () => {
    const h = setup({ complete: async () => generate(["20002"]) });
    h.receive("1", "20002", true);
    await h.activate();
    const intent = h.outbox.list({})[0]!;
    h.receive("2", "20003", true);
    h.receive("3", "20004", false);
    let sends = 0;
    const delivery = new OutboundDelivery({
      orm: h.orm,
      repository: h.outbox,
      journal: h.journal,
      authorize: () => true,
      stickerFile: () => null,
      now: h.now,
      port: {
        async send() {
          sends++;
          return { kind: "confirmed", messageId: "unexpected" };
        },
      },
    });
    await delivery.deliver(intent.id);
    expect(sends).toBe(0);
    expect(h.outbox.get(intent.id)!.status).toBe("stale");
  });
  it("idle initiative threshold and unanswered rule remain active under the same host", async () => {
    const h = setup({
      complete: async (req) =>
        isBatchScore(req)
          ? batchScores(batchTargetIds(req), 0)
          : '{"kind":"final","outputs":[{"kind":"generate","targetId":"30003","instructions":"开个话题"}]}',
    });
    h.receive("1");
    h.db.exec("UPDATE wake_signals SET status='no_output'");
    h.clock.seconds += 16 * 60;
    h.adapter.sweep();
    expect((await h.activate("idle_topic")).status).toBe("no_output");
    expect(h.outbox.list({})).toEqual([]);
    recordQqSend(h.orm, {
      scope: {
        kind: "qq",
        accountId: "10001",
        conversationKind: "group",
        peerId: "30003",
        agentId: DEFAULT_AGENT_ID,
      },
      kind: "idle_topic",
      parts: [{ kind: "text", result: "confirmed", messageId: "200", stickerId: null }],
      text: "opener",
      sentAtSeconds: h.clock.seconds,
    });
    h.clock.seconds += 16 * 60;
    h.adapter.sweep();
    expect(h.wakes.peek({ at: h.now(), cause: "idle_topic" })).toBeNull();
  });
});
describe("failed generation and observation epochs", () => {
  it("all failed generations fail the run and leave wake/source unacknowledged", async () => {
    const h = setup({
      complete: async () => generate(["20002"]),
      async *streamText() {
        yield await Promise.reject<string>(new Error("MODEL_FAILURE"));
      },
    });
    h.receive("1", "20002", true);
    await expect(h.activate()).rejects.toThrow("No output could be prepared");
    expect(h.outbox.list({})).toEqual([]);
    expect(h.journal.ensureOneBot(bindingId)!.consumedSeq).toBe(0);
    expect(h.db.query("SELECT status FROM agent_runs WHERE spec_id='onebot.main'").get()).toEqual({
      status: "failed",
    });
  });
  it("new related input during generation defers to the next frozen batch without reusing the unscored source", async () => {
    let h: ReturnType<typeof setup>;
    let scores = 0,
      generations = 0;
    const genPrompts: string[] = [];
    h = setup({
      complete: async (req) => {
        if (isBatchScore(req)) {
          scores++;
          return batchScores(batchTargetIds(req));
        }
        return generate(["20002"]);
      },
      async *streamText(req) {
        generations++;
        genPrompts.push(JSON.stringify(req.messages));
        if (generations === 1) {
          h.receive("2", "20002", false, "new material");
          h.clock.seconds += 2;
        }
        yield "answer";
      },
    });
    h.receive("1");
    h.clock.seconds += 2;
    expect((await h.activate()).status).toBe("completed");
    // 同一冻结批次只评分一次；运行中新到的相关输入属于下一冻结批次（留 pending），不回喂当前回复。
    expect(scores).toBe(1);
    expect(generations).toBe(1);
    expect(genPrompts[0]).not.toContain("new material"); // 回复未消费未评分的新来源
    expect(h.outbox.list({})).toHaveLength(1);
    expect(
      h.db.query("SELECT COUNT(*) AS n FROM wake_signals WHERE status='pending'").get(),
    ).toEqual({ n: 1 });
  });
});

describe("immediate opportunity coverage", () => {
  function previousSpeech(h: ReturnType<typeof setup>) {
    recordQqSend(
      h.orm,
      {
        scope: {
          kind: "qq",
          accountId: "10001",
          conversationKind: "group",
          peerId: "30003",
          agentId: DEFAULT_AGENT_ID,
        },
        kind: "direct_reply",
        parts: [{ kind: "text", result: "confirmed", messageId: "previous" }],
        text: "previous",
        sentAtSeconds: time - 10,
      },
      undefined,
      h.db,
    );
  }
  function transport(h: ReturnType<typeof setup>, status: "confirmed" | "failed" | "unknown") {
    return new OutboundDelivery({
      orm: h.orm,
      repository: h.outbox,
      journal: h.journal,
      now: h.now,
      stickerFile: () => null,
      authorize: () => true,
      port: {
        async send() {
          return status === "confirmed"
            ? { kind: "confirmed", messageId: "receipt" }
            : status === "unknown"
              ? { kind: "unknown", reason: "timeout" }
              : { kind: "failed", retcode: 500 };
        },
      },
    });
  }
  it.each(["confirmed", "failed", "unknown"] as const)(
    "does not repeat covered same-person input after a %s direct attempt",
    async (status) => {
      const h = setup({ complete: async () => generate(["20002"]) }, { follow: true });
      previousSpeech(h);
      h.receive("1", "20002", false);
      h.clock.seconds++;
      h.receive("2", "20002", true);
      await h.activate("direct_reply");
      await transport(h, status).runOnce();
      // 连续交谈按人滚动：下一个窗口成熟后才可领取。
      h.clock.seconds += 5;
      const c = h.journal.ensureOneBot(bindingId)!;
      const idle = h.wakes.enqueue({
        conversationId: c.id,
        cause: "idle_topic",
        throughSeq: h.journal.sourceThroughSeq(c.id),
        dedupeKey: "unrelated-idle",
        readyAt: h.now(),
        at: h.now(),
        priority: 0,
      });
      expect(await h.activate("follow_up")).toMatchObject({
        status: "no_output",
        reason: status === "confirmed" ? "already_replied" : "already_attempted",
      });
      expect(
        h.db.query("SELECT COUNT(*) AS n FROM agent_runs WHERE spec_id='onebot.main'").get(),
      ).toEqual({ n: 1 });
      expect(h.wakes.get(idle.id)?.status).toBe("pending");
      h.clock.seconds += 5;
      h.receive("3", "20002", false, "a genuinely new input");
      h.clock.seconds += 5;
      expect((await h.activate("follow_up")).status).toBe("completed");
      expect(h.outbox.list({})).toHaveLength(2);
    },
  );
  it("does not consume another participant merely because the first reply observed their input", async () => {
    let decisions = 0;
    const h = setup(
      { complete: async () => generate([++decisions === 1 ? "20003" : "20002"]) },
      { follow: true },
    );
    previousSpeech(h);
    h.receive("1", "20002", false);
    h.clock.seconds++;
    h.receive("2", "20003", true);
    await h.activate("direct_reply");
    await transport(h, "confirmed").runOnce();
    h.clock.seconds += 5;
    expect((await h.activate("follow_up")).status).toBe("completed");
    expect(h.outbox.list({}).map((d) => d.target?.participantId)).toEqual(["20003", "20002"]);
  });
});

function pendingPlan(
  request: ModelRequest,
):
  | { outputs: { text?: string; targetId: string }[]; generationBudget: { remaining: number }[] }
  | undefined {
  for (const message of request.messages)
    for (const part of message.content) {
      if (part.kind !== "text") continue;
      try {
        const data = JSON.parse(part.text);
        if (data.kind === "pending_plan") return data.value;
      } catch {}
    }
}
describe("Agent-directed recovery", () => {
  it.each(["malformed", "model_error"])(
    "fails the whole initiative batch when its single batch score is %s",
    async (failure) => {
      let scores = 0,
        replies = 0;
      const h = setup({
        complete: async (request) => {
          if (isBatchScore(request)) {
            scores++;
            if (failure === "model_error") throw new Error("MODEL_FAILED");
            return "invalid";
          }
          replies++;
          return generate(["20002", "20003"]);
        },
      });
      h.receive("1", "20002");
      h.receive("2", "20003");
      h.clock.seconds += 2;
      // 新协议：阶段一只有一次批量评分；协议错误/模型失败整批结算为失败，不逐 target 重试或部分回复。
      if (failure === "model_error") await expect(h.activate()).rejects.toThrow("MODEL_FAILED");
      else await expect(h.activate()).rejects.toMatchObject({ code: "JUDGEMENT_UNREADABLE" });
      expect(scores).toBe(1);
      expect(replies).toBe(0);
      expect(h.outbox.list({})).toHaveLength(0);
      expect(h.journal.ensureOneBot(bindingId)!.consumedSeq).toBe(0); // 游标未消费
      expect(
        h.db.query("SELECT COUNT(*) AS n FROM wake_signals WHERE status='completed'").get(),
      ).toEqual({ n: 0 }); // wake 未消费
    },
  );
  it.each(["keep", "revise", "defer"])(
    "Agent can %s a pending draft after new input even with zero regeneration budget",
    async (choice) => {
      let h: ReturnType<typeof setup>;
      let decisions = 0,
        generations = 0;
      h = setup(
        {
          complete: async (request) => {
            if (++decisions === 1) return generate(["20002"]);
            const plan = pendingPlan(request);
            expect(plan?.outputs[0]?.text).toBe("original draft");
            expect(plan?.generationBudget[0]?.remaining).toBe(0);
            expect(JSON.stringify(request.messages)).toContain("additional detail");
            return choice === "defer"
              ? '{"kind":"none"}'
              : JSON.stringify({
                  kind: "final",
                  outputs: [
                    {
                      kind: "inline",
                      targetId: "20002",
                      text: choice === "keep" ? plan!.outputs[0]!.text : "revised draft",
                      stickerIds: [],
                    },
                  ],
                });
          },
          async *streamText() {
            generations++;
            h.receive("2", "20002", true, "additional detail");
            yield "original draft";
          },
        },
        { recomputes: 0 },
      );
      h.receive("1", "20002", true);
      const result = await h.activate();
      expect(result.status).toBe(choice === "defer" ? "no_output" : "completed");
      expect(generations).toBe(1);
      expect(decisions).toBe(2);
      const intents = h.outbox.list({});
      expect(intents).toHaveLength(choice === "defer" ? 0 : 1);
      if (choice !== "defer")
        expect(JSON.parse(h.outbox.parts(intents[0]!.id)[0]!.payload!).text).toBe(
          choice === "keep" ? "original draft" : "revised draft",
        );
    },
  );
  it("cannot reuse a pending draft after its source leaves the raw window and is deleted", async () => {
    let h: ReturnType<typeof setup>,
      decisions = 0;
    h = setup(
      {
        complete: async (request) => {
          if (++decisions === 1) return generate(["20002"]);
          expect(pendingPlan(request)?.outputs[0]?.text).toBe("original secret");
          h.db.exec(
            "DELETE FROM qq_observation_text WHERE event_key IN (SELECT event_key FROM qq_events WHERE message_id='1')",
          );
          return JSON.stringify({
            kind: "final",
            outputs: [
              { kind: "inline", targetId: "20002", text: "original secret", stickerIds: [] },
            ],
          });
        },
        async *streamText() {
          h.clock.seconds++;
          h.receive("2", "20002", true, "new input");
          yield "original secret";
        },
      },
      { recomputes: 0 },
    );
    h.db.exec("UPDATE qq_schemes SET judgement_message_limit=1, reply_message_limit=1");
    h.receive("1", "20002", true, "sensitive old source");
    await expect(h.activate()).rejects.toMatchObject({ code: "CONTEXT_SOURCE_INVALID" });
    expect(h.outbox.list({})).toHaveLength(0);
    expect(h.journal.ensureOneBot(bindingId)!.consumedSeq).toBe(0);
  });
  it("stamps the retention window saved at commit time into the planned intent", async () => {
    const h = setup({ complete: async () => generate(["20002"]) });
    // 30 days, saved before the commit: the commit point reads the setting when it runs, and
    // the intent's expiry (the row every later read is bounded by) must carry that window.
    updateQqStorageSettings(h.orm, {
      retentionDays: 30,
      expectedRevision: readQqSettings(h.orm).revision,
    });
    h.receive("1", "20002", true);
    expect((await h.activate("direct_reply")).status).toBe("completed");
    const intent = h.outbox.row(h.outbox.list({})[0]!.id)!;
    expect(intent.expires_at).toBe(speechExpiresAt(time, 30));
  });
});

it.each(["revoked", "cancelled"])(
  "does not turn %s authority loss into an unauthorized reply",
  async (failure) => {
    const controller = new AbortController();
    let h: ReturnType<typeof setup>;
    let scores = 0;
    h = setup({
      complete: async (request) => {
        if (isBatchScore(request)) {
          scores++;
          return batchScores(batchTargetIds(request));
        }
        return generate(["20002", "20003"]);
      },
    });
    h.receive("1", "20002");
    h.receive("2", "20003");
    h.clock.seconds += 2;
    // 撤权：删掉承载成员证据的会话事件（真实让来源不可用）；取消：直接 abort。
    // 注：当前 QQ 评分相没有可 assert 的"来源授权"入口（评分叶子非能力门控、删 observation text 不影响来源），
    // 真实"扣授权"面见 knowledge grant（父已批准范围），故本用例只证"撤权/取消不产未授权回复、不进评分"。
    if (failure === "revoked") h.db.exec("DELETE FROM conversation_events");
    else controller.abort();
    const wake = h.wakes.claim({ at: h.now(), leaseMs: 120000 })!;
    const settled = await h.host.activate(wake, controller.signal).then(
      (value) => ({ ok: true as const, status: value.status }),
      () => ({ ok: false as const }),
    );
    expect(h.outbox.list({})).toHaveLength(0); // 不产未授权回复
    expect(scores).toBe(0); // 来源不可用/已取消时不进入评分（非普通评分失败）
    if (failure === "cancelled") expect(settled.ok).toBe(false);
  },
);
describe("durable participant windows across actual Host and delivery", () => {
  it("A at 0 is answered at 15; B at 14 remains pending and is answered at 29 after A's confirmed delivery", async () => {
    let h: ReturnType<typeof setup>;
    h = setup(
      {
        // 15/29 的按人滚动成熟属于连续交谈（follow_up），不是自主接话。
        complete: async () =>
          JSON.stringify({
            kind: "invoke",
            name: "speech.reply",
            arguments: {
              outputs: [
                { kind: "inline", targetId: "20002", text: "to A", stickerIds: [] },
                { kind: "inline", targetId: "20003", text: "to B", stickerIds: [] },
              ],
            },
          }),
        async *streamText() {
          yield "should-not-stream";
        },
      },
      { mergeSeconds: 15, follow: true },
    );
    recordQqSend(h.orm, {
      scope: {
        kind: "qq",
        accountId: "10001",
        conversationKind: "group",
        peerId: "30003",
        agentId: DEFAULT_AGENT_ID,
      },
      kind: "direct_reply",
      parts: [{ kind: "text", result: "confirmed", messageId: "previous" }],
      text: "previous",
      sentAtSeconds: time - 10,
    });
    h.receive("1", "20002");
    h.clock.seconds = time + 14;
    h.receive("2", "20003");
    h.clock.seconds = time + 15;
    expect((await h.activate("follow_up")).status).toBe("completed");
    expect(h.outbox.list({}).map((d) => d.target?.participantId)).toEqual(["20002"]);
    expect(
      h.db.query("SELECT COUNT(*) AS n FROM wake_signals WHERE status='pending'").get(),
    ).toEqual({ n: 1 });
    const delivery = new OutboundDelivery({
      orm: h.orm,
      repository: h.outbox,
      journal: h.journal,
      authorize: () => true,
      stickerFile: () => null,
      now: h.now,
      port: { send: async () => ({ kind: "confirmed", messageId: "receipt-a" }) },
    });
    await delivery.deliver(h.outbox.list({})[0]!.id);
    expect(h.outbox.list({})[0]!.status).toBe("confirmed");
    h.adapter.sweep();
    h.clock.seconds = time + 29;
    expect((await h.activate("follow_up")).status).toBe("completed");
    expect(
      h.outbox
        .list({})
        .map((d) => d.target?.participantId)
        .sort(),
    ).toEqual(["20002", "20003"]);
    expect(
      h.db.query("SELECT COUNT(*) AS n FROM agent_runs WHERE spec_id='onebot.main'").get(),
    ).toEqual({ n: 2 });
    expect(
      h.db.query("SELECT COUNT(*) AS n FROM wake_signals WHERE status='pending'").get(),
    ).toEqual({ n: 0 });
  });
  it("an unpaired legacy or room-wide initiative still preserves the unanswered gate", async () => {
    const h = setup({}, { mergeSeconds: 15 });
    h.receive("1", "20002");
    h.clock.seconds = time + 15;
    recordQqSend(h.orm, {
      scope: {
        kind: "qq",
        accountId: "10001",
        conversationKind: "group",
        peerId: "30003",
        agentId: DEFAULT_AGENT_ID,
      },
      kind: "chiming_in",
      parts: [{ kind: "text", result: "confirmed", messageId: "legacy", stickerId: null }],
      sentAtSeconds: time + 1,
      text: "room topic",
    });
    const result = await h.activate("chiming_in");
    expect(result.status).toBe("no_output");
    expect(result).toHaveProperty("reason", "awaiting_reply");
    expect(h.requests).toHaveLength(0);
  });
  it("initiative low score freezes the batch and consumes its frozen members once without leaving pending", async () => {
    const seen: ModelRequest[] = [];
    const h = setup({
      complete: async (req) => {
        seen.push(req);
        // 主动批次：一次批量评分；低于门槛＝本批无达标目标，整批冻结成员一次性消费（非按人 15/29 成熟）。
        return isBatchScore(req) ? batchScores(batchTargetIds(req), 0) : '{"kind":"none"}';
      },
    });
    h.receive("1", "20002");
    h.receive("2", "20003");
    h.clock.seconds += 2;
    expect((await h.activate("chiming_in")).status).toBe("no_output");
    expect(seen).toHaveLength(1); // 只一次批量评分
    expect(h.outbox.list({})).toHaveLength(0);
    expect(
      h.db.query("SELECT COUNT(*) AS n FROM wake_signals WHERE status='pending'").get(),
    ).toEqual({ n: 0 }); // 冻结成员一次消费完毕，无残留 pending
  });
  it("split off keeps one logical room reply covering both qualified intents", async () => {
    const generationPrompts: string[] = [];
    const h = setup(
      {
        complete: async (req) => {
          if (isBatchScore(req))
            return JSON.stringify({
              evaluations: [
                { targetId: "20002", score: 9, intent: "intent-a", sourceSeqs: [] },
                { targetId: "20003", score: 9, intent: "intent-b", sourceSeqs: [] },
              ],
            });
          return generate(["30003"]);
        },
        async *streamText(req) {
          generationPrompts.push(JSON.stringify(req.messages));
          yield "room reply";
        },
      },
      { split: false },
    );
    h.receive("1", "20002");
    h.receive("2", "20003");
    h.clock.seconds += 2;
    expect((await h.activate("chiming_in")).status).toBe("completed");
    // 自主批次：一个会话 wake，只结算 1 个 completed（不是每个机会各一个）。
    expect(
      h.db.query("SELECT COUNT(*) AS n FROM wake_signals WHERE status='completed'").get(),
    ).toEqual({ n: 1 });
    expect(h.outbox.list({})).toHaveLength(1);
    expect(h.outbox.list({})[0]!.target).toEqual({ peerId: "30003", participantId: null });
    // intent 完整性：room 回复材料覆盖两个达标 intent，而不是只计 part 数。
    expect(generationPrompts).toHaveLength(1);
    expect(generationPrompts[0]).toContain("intent-a");
    expect(generationPrompts[0]).toContain("intent-b");
  });
  it("keeps one room wake while a failed target child does not fail the parent or its sibling", async () => {
    const h = setup({
      complete: async (req) =>
        isBatchScore(req) ? batchScores(batchTargetIds(req)) : generate(["20002", "20003"]),
      async *streamText(req) {
        if (JSON.stringify(req.messages[0]).includes("20002")) throw new Error("MODEL_A_FAILED");
        yield "B reply";
      },
    });
    h.receive("1", "20002");
    h.receive("2", "20003");
    h.clock.seconds += 2;
    expect((await h.activate("chiming_in")).status).toBe("completed");
    // 分层：A 的 target 子 run 失败、B 的子 run 完成；父 run 仍 completed，同一会话 wake 只结算一次。
    const childStates = (
      h.db.query("SELECT status FROM agent_runs WHERE spec_id='onebot.main'").all() as {
        status: string;
      }[]
    ).map((row) => row.status);
    expect(childStates.sort()).toEqual(["completed", "failed"]);
    expect(h.outbox.list({}).map((d) => d.target?.participantId)).toEqual(["20003"]);
    expect(
      h.db
        .query(
          "SELECT COUNT(*) AS n FROM agent_runs WHERE spec_id='onebot.initiative.batch' AND status='completed'",
        )
        .get(),
    ).toEqual({ n: 1 });
    expect(
      h.db.query("SELECT COUNT(*) AS n FROM wake_signals WHERE status='completed'").get(),
    ).toEqual({ n: 1 });
  });
});

describe("confirmed reply coverage across opportunity paths", () => {
  function coverageFixture() {
    let initiativeTarget = "20002",
      initiative = false,
      decisions = 0,
      evaluations = 0;
    const h = setup(
      {
        complete: async (req) => {
          if (isBatchScore(req)) {
            evaluations++;
            return batchScores(batchTargetIds(req));
          }
          if (!initiative) return generate(["20002"]);
          decisions++;
          return generate([initiativeTarget]);
        },
      },
      { mergeSeconds: 15, follow: false },
    );
    return {
      ...h,
      startInitiative(target = "20002") {
        initiative = true;
        initiativeTarget = target;
      },
      get evaluations() {
        return evaluations;
      },
      async deliverDirect(outcome: "confirmed" | "failed" | "unknown") {
        const delivery = new OutboundDelivery({
          orm: h.orm,
          repository: h.outbox,
          journal: h.journal,
          authorize: () => true,
          stickerFile: () => null,
          now: h.now,
          port: {
            send: async () =>
              outcome === "confirmed"
                ? { kind: "confirmed", messageId: "direct-receipt" }
                : outcome === "unknown"
                  ? { kind: "unknown", reason: "timeout" }
                  : { kind: "failed", retcode: 500 },
          },
        });
        await delivery.deliver(h.outbox.list({})[0]!.id);
        expect(h.outbox.list({})[0]!.status).toBe(outcome);
      },
    };
  }

  it("skips an older ordinary opportunity already covered by the same recipient's confirmed direct reply", async () => {
    const h = coverageFixture();
    h.receive("1", "20002");
    h.clock.seconds++;
    h.receive("2", "20002", true);
    expect((await h.activate("direct_reply")).status).toBe("completed");
    await h.deliverDirect("confirmed");
    h.startInitiative();
    h.clock.seconds = time + 15;
    expect(await h.activate("chiming_in")).toEqual({
      status: "no_output",
      reason: "already_replied",
    });
    expect(h.evaluations).toBe(0);
    expect(h.outbox.list({})).toHaveLength(1);
    expect(
      h.db.query("SELECT COUNT(*) AS n FROM agent_runs WHERE spec_id='onebot.main'").get(),
    ).toEqual({ n: 1 });
  });

  it("filters covered A from a mature batch while preserving and evaluating unconfirmed B", async () => {
    const h = coverageFixture();
    h.receive("1", "20002");
    h.clock.seconds++;
    h.receive("2", "20003");
    h.clock.seconds++;
    h.receive("3", "20002", true);
    expect((await h.activate("direct_reply")).status).toBe("completed");
    await h.deliverDirect("confirmed");
    h.startInitiative("20003");
    h.clock.seconds = time + 17;
    // B 是更新的普通机会并拥有这次激活；A 必须从同批其它成熟目标里被过滤（不是只在 claim 时检查）。
    expect((await h.activate("chiming_in")).status).toBe("completed");
    expect(h.evaluations).toBe(1); // 一次批量评分，不重复模型调用
    expect(h.outbox.list({}).map((d) => d.target?.participantId)).toEqual(["20002", "20003"]); // 保留 A 的 direct 已发事实
    // 一次自主批过滤 covered A、回复 B 后不应再有第二个 wake。
    expect(
      h.db.query("SELECT COUNT(*) AS n FROM wake_signals WHERE status='pending'").get(),
    ).toEqual({ n: 0 });
    expect(
      h.db.query("SELECT COUNT(*) AS n FROM agent_runs WHERE spec_id='onebot.main'").get(),
    ).toEqual({ n: 2 });
  });

  it.each(["failed", "unknown"] as const)(
    "does not treat %s direct delivery as confirmed coverage",
    async (outcome) => {
      const h = coverageFixture();
      h.receive("1", "20002");
      h.clock.seconds++;
      h.receive("2", "20002", true);
      await h.activate("direct_reply");
      await h.deliverDirect(outcome);
      h.startInitiative();
      h.clock.seconds = time + 15;
      expect((await h.activate("chiming_in")).status).toBe("completed");
      expect(h.evaluations).toBe(1);
      expect(h.outbox.list({}).map((d) => d.status)).toEqual([outcome, "planned"]);
    },
  );

  it("does not cover a participant's newer source with an earlier confirmed reply", async () => {
    const h = coverageFixture();
    h.receive("1", "20002");
    h.clock.seconds++;
    h.receive("2", "20002", true);
    await h.activate("direct_reply");
    await h.deliverDirect("confirmed");
    h.clock.seconds = time + 5;
    h.receive("3", "20002");
    h.startInitiative();
    h.clock.seconds = time + 20;
    expect((await h.activate("chiming_in")).status).toBe("completed");
    expect(h.evaluations).toBe(1);
    expect(h.outbox.list({})).toHaveLength(2);
  });
});

interface EvidenceEnvelope {
  status: "ok" | "unavailable";
  code?: string;
  items: {
    id: string;
    title?: string;
    summary?: string;
    bodyRef: string;
    text?: string;
    offset?: number;
    nextOffset?: number | null;
  }[];
  nextCursor?: string | null;
}

/** The latest rendered `action_observation` envelope with this action name, if any. */
function evidencePage(request: ModelRequest, name: string): EvidenceEnvelope | undefined {
  let found: EvidenceEnvelope | undefined;
  for (const message of request.messages)
    for (const part of message.content) {
      if (part.kind !== "text") continue;
      try {
        const data = JSON.parse(part.text) as {
          kind?: string;
          value?: { name?: string; value?: EvidenceEnvelope };
        };
        if (data.kind === "action_observation" && data.value?.name === name)
          found = data.value.value;
      } catch {}
    }
  return found;
}

interface CommittedObservation {
  id: string;
  name: string;
  arguments: unknown;
  value: unknown;
  sources: unknown;
}

/** Every distinct evidence observation the run ever produced, deduped by observation id. */
function committedObservations(
  requests: readonly ModelRequest[],
  prefix: string,
): CommittedObservation[] {
  const observations = new Map<string, CommittedObservation>();
  for (const request of requests)
    for (const message of request.messages)
      for (const part of message.content) {
        if (part.kind !== "text") continue;
        try {
          const data = JSON.parse(part.text) as {
            kind?: string;
            value?: CommittedObservation;
          };
          const observation = data.value;
          if (
            data.kind !== "action_observation" ||
            typeof observation?.name !== "string" ||
            !observation.name.startsWith(prefix) ||
            typeof observation.id !== "string"
          )
            continue;
          observations.set(observation.id, observation);
        } catch {}
      }
  return [...observations.values()];
}

/**
 * Mirrors the production charge for one published observation (`observationUnits` in
 * built-in-actions): the rendered action_observation envelope measured by `inputUnits`.
 * The id placeholder is the same length as a real observation id, so the charge matches.
 */
function observationCharge(observation: CommittedObservation): number {
  const message: ModelMessage = {
    role: "user",
    content: [
      {
        kind: "text",
        text: JSON.stringify({
          kind: "action_observation",
          trust: "data_only",
          value: {
            id: "00000000-0000-0000-0000-000000000000",
            name: observation.name,
            arguments: observation.arguments,
            value: observation.value,
            sources: observation.sources,
          },
        }),
      },
    ],
  };
  return inputUnits([message]) - inputUnits([]);
}

describe("Bot tool-first knowledge reading in the shared host", () => {
  function seedKnowledge(h: ReturnType<typeof setup>, name: string, text: string) {
    const library = new KnowledgeRepository(h.db);
    const doc = library.importDocument({ name, category_id: "default", original_text: text });
    library.replaceGrants(doc.id, doc.revision, [DEFAULT_AGENT_ID]);
    return doc;
  }
  function setKnowledgeBudget(h: ReturnType<typeof setup>, budget: number) {
    h.db
      .query("UPDATE agent_knowledge_read_settings SET context_budget=? WHERE agent_id=?")
      .run(budget, DEFAULT_AGENT_ID);
  }

  it("keeps knowledge raw until the Agent explicitly queries and reads it", async () => {
    const seen: ModelRequest[] = [];
    let decisions = 0;
    let h: ReturnType<typeof setup>;
    h = setup({
      complete: async (request) => {
        seen.push(request);
        decisions++;
        if (decisions === 1)
          return '{"kind":"invoke","name":"knowledge.query","arguments":{"query":"apples"}}';
        if (decisions === 2) {
          const catalog = evidencePage(request, "knowledge.query");
          expect(catalog?.status).toBe("ok");
          expect(catalog?.items).toHaveLength(1);
          expect(catalog?.items[0]?.title).toBe("apples manual");
          return JSON.stringify({
            kind: "invoke",
            name: "knowledge.read",
            arguments: { bodyRef: catalog!.items[0]!.bodyRef },
          });
        }
        return '{"kind":"none"}';
      },
    });
    // 正文标记特意放在 160 字摘要之外：目录信封即使带摘要也不得泄漏正文。
    seedKnowledge(h, "apples manual", "apples " + "Q".repeat(200) + " SECRET_BODY");
    h.receive("1", "20002", true, "apples question");
    expect((await h.activate("direct_reply")).status).toBe("no_output");
    expect(decisions).toBe(3);
    // 预取已移除：第一条决策里没有正文、没有证据信封、没有检索失败状态。
    const first = JSON.stringify(seen[0]!.messages);
    expect(first).not.toContain("SECRET_BODY");
    expect(first).not.toContain("retrieval_status");
    expect(evidencePage(seen[0]!, "knowledge.query")).toBeUndefined();
    // 工具可用 ≠ 内容注入；独立 selector 已移除（任何请求都不再出现 ids 选择 schema）。
    expect(seen[0]!.tools?.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["knowledge.query", "knowledge.read"]),
    );
    for (const request of seen)
      expect(
        (request.responseSchema?.properties as Record<string, unknown> | undefined)?.ids,
      ).toBeUndefined();
    // 显式 query 只给目录信封（标题/摘要/bodyRef）：正文标记落在 160 字摘要之外，仍不进入模型输入。
    const second = JSON.stringify(seen[1]!.messages);
    expect(second).toContain("apples manual");
    expect(second).not.toContain("SECRET_BODY");
    // 只有 knowledge.read 之后正文才进入，并带着资料文档与授权的来源。
    const read = evidencePage(seen[2]!, "knowledge.read");
    expect(read?.items[0]?.text).toContain("SECRET_BODY");
    expect(JSON.stringify(seen[2]!.messages)).toContain("knowledge_grant");
    expect(h.outbox.list({})).toEqual([]);
  });

  it("bounds explicit query and paged reads by the frozen knowledge budget", async () => {
    const seen: ModelRequest[] = [];
    const body = "apples " + "Q".repeat(4000);
    let h: ReturnType<typeof setup>;
    h = setup({
      complete: async (request) => {
        seen.push(request);
        const read = evidencePage(request, "knowledge.read");
        if (read) {
          if (read.status !== "ok") return '{"kind":"none"}';
          const page = read.items[0]!;
          if (page.nextOffset == null) return '{"kind":"none"}';
          return JSON.stringify({
            kind: "invoke",
            name: "knowledge.read",
            arguments: { bodyRef: page.bodyRef, offset: page.nextOffset, limit: 4096 },
          });
        }
        const catalog = evidencePage(request, "knowledge.query");
        if (!catalog)
          return '{"kind":"invoke","name":"knowledge.query","arguments":{"query":"apples"}}';
        if (catalog.status !== "ok") return '{"kind":"none"}';
        return JSON.stringify({
          kind: "invoke",
          name: "knowledge.read",
          arguments: { bodyRef: catalog.items[0]!.bodyRef },
        });
      },
    });
    seedKnowledge(h, "apples", body);
    setKnowledgeBudget(h, 3000);
    h.receive("1", "20002", true, "apples question");
    expect((await h.activate("direct_reply")).status).toBe("no_output");

    const pages = seen
      .map((request) => evidencePage(request, "knowledge.read"))
      .filter((page): page is EvidenceEnvelope => page !== undefined);
    const text = pages
      .filter((page) => page.status === "ok")
      .map((page) => page.items[0]!.text)
      .join("");
    // 预算是逐页截断而不是放行：读到的正文是原文前缀，且在读完之前就被截住。
    expect(text.length).toBeGreaterThan(0);
    expect(body.startsWith(text)).toBe(true);
    expect(text.length).toBeLessThan(body.length);
    expect(
      pages.some(
        (page) => page.status === "unavailable" && page.code === "CONTEXT_BUDGET_EXCEEDED",
      ),
    ).toBe(true);
    // 已放行披露的观察加总不超过冻结预算：生产每次放行前先记账（同一域累计）。
    // "取不到"的失败信封不再参与额度结算、也无法再截断，是必要的失败告知，单独按形状断言。
    const disclosed = committedObservations(seen, "knowledge.").filter(
      (observation) => (observation.value as { status?: unknown }).status === "ok",
    );
    const charge = disclosed.reduce(
      (total, observation) => total + observationCharge(observation),
      0,
    );
    expect(disclosed.length).toBeGreaterThan(0);
    expect(charge).toBeGreaterThan(0);
    expect(charge).toBeLessThanOrEqual(3000);
    expect(h.outbox.list({})).toEqual([]);
  });

  it("serves the frozen reading settings for the whole turn and applies edits to the next turn", async () => {
    const seen: ModelRequest[] = [];
    let turn = 0;
    let h: ReturnType<typeof setup>;
    h = setup({
      complete: async (request) => {
        seen.push(request);
        if (turn !== 0) return '{"kind":"none"}';
        if (evidencePage(request, "knowledge.read")) return '{"kind":"none"}';
        const catalog = evidencePage(request, "knowledge.query");
        if (catalog)
          return JSON.stringify({
            kind: "invoke",
            name: "knowledge.read",
            arguments: { bodyRef: catalog.items[0]!.bodyRef },
          });
        // 决策中途改设置：本轮必须继续按激活时冻结的快照服务。
        h.db.exec(
          "UPDATE agent_knowledge_read_settings SET enabled=0, context_budget=1, document_ids='[]', revision=revision+1",
        );
        return '{"kind":"invoke","name":"knowledge.query","arguments":{"query":"apples"}}';
      },
    });
    const selected = seedKnowledge(h, "apples selected", "apples ALLOWED_KNOWLEDGE");
    seedKnowledge(h, "apples excluded", "apples EXCLUDED_KNOWLEDGE");
    h.db
      .query(
        "UPDATE agent_knowledge_read_settings SET scope='selected', document_ids=? WHERE agent_id=?",
      )
      .run(JSON.stringify([selected.id]), DEFAULT_AGENT_ID);
    h.receive("1", "20002", true, "apples");
    expect((await h.activate("direct_reply")).status).toBe("no_output");
    const frozenText = JSON.stringify(seen.map((request) => request.messages));
    expect(frozenText).toContain("ALLOWED_KNOWLEDGE");
    expect(frozenText).not.toContain("EXCLUDED_KNOWLEDGE");
    expect(seen.flatMap((request) => request.tools?.map((tool) => tool.name) ?? [])).toContain(
      "knowledge.query",
    );

    // 下一轮（新的激活）读到的是改后的设置：读取能力整体关闭，工具与内容都不再出现。
    turn = 1;
    seen.length = 0;
    h.clock.seconds += 2;
    h.receive("2", "20002", true, "apples again");
    expect((await h.activate("direct_reply")).status).toBe("no_output");
    const nextText = JSON.stringify(seen.map((request) => request.messages));
    expect(nextText).not.toContain("ALLOWED_KNOWLEDGE");
    expect(nextText).not.toContain("EXCLUDED_KNOWLEDGE");
    for (const request of seen)
      expect(request.tools?.map((tool) => tool.name) ?? []).not.toContain("knowledge.query");
    expect(h.outbox.list({})).toEqual([]);
  });

  it("returns an unavailable envelope with retrieval_status instead of failing the turn", async () => {
    const seen: ModelRequest[] = [];
    let h: ReturnType<typeof setup>;
    h = setup({
      complete: async (request) => {
        seen.push(request);
        if (seen.length === 1)
          return '{"kind":"invoke","name":"knowledge.query","arguments":{"query":"apples"}}';
        return '{"kind":"none"}';
      },
    });
    // 预算落在"装得下取不到信封（266）、装不下一条目录（380）"的窗口：
    // 冻结额度先于正文内容生效，模型直接收到知识模块的不可用码而不是工厂的兜底码。
    seedKnowledge(h, "apples", "apples " + "Q".repeat(200) + " OPTIONAL_BODY");
    setKnowledgeBudget(h, 300);
    h.receive("1", "20002", true, "valid raw question");
    expect((await h.activate("direct_reply")).status).toBe("no_output");

    // "取不到"是信封状态，不是整轮失败；原始提问照常留在输入里。
    const page = evidencePage(seen[1]!, "knowledge.query");
    expect(page).toMatchObject({
      status: "unavailable",
      code: "KNOWLEDGE_CONTEXT_BUDGET",
      items: [],
    });
    const text = JSON.stringify(seen[1]!.messages);
    expect(text).toContain("valid raw question");
    expect(text).toContain("retrieval_status");
    expect(text).toContain("KNOWLEDGE_CONTEXT_BUDGET");
    expect(text).not.toContain("OPTIONAL_BODY");
    expect(h.outbox.list({})).toEqual([]);
  });

  it("fails the turn hard when the grant is revoked between query and read", async () => {
    const seen: ModelRequest[] = [];
    let h: ReturnType<typeof setup>;
    h = setup({
      complete: async (request) => {
        seen.push(request);
        if (seen.length === 1)
          return '{"kind":"invoke","name":"knowledge.query","arguments":{"query":"apples"}}';
        const catalog = evidencePage(request, "knowledge.query")!;
        h.db.exec("DELETE FROM knowledge_grants");
        return JSON.stringify({
          kind: "invoke",
          name: "knowledge.read",
          arguments: { bodyRef: catalog.items[0]!.bodyRef },
        });
      },
    });
    seedKnowledge(h, "apples", "apples " + "Q".repeat(200) + " REVOKED_BODY");
    h.receive("1", "20002", true, "apples question");
    await expect(h.activate("direct_reply")).rejects.toMatchObject({
      code: "CONTEXT_SOURCE_INVALID",
    });
    // 撤权不是"这次取不到"：不回 ok/空、也不回 unavailable 信封，正文永不兑现。
    for (const request of seen) expect(evidencePage(request, "knowledge.read")).toBeUndefined();
    expect(JSON.stringify(seen)).not.toContain("REVOKED_BODY");
    expect(h.outbox.list({})).toEqual([]);
    expect(h.journal.ensureOneBot(bindingId)!.consumedSeq).toBe(0);
  });

  it("rejects instead of swallowing cancellation into an unavailable envelope", async () => {
    const controller = new AbortController();
    const seen: ModelRequest[] = [];
    let h: ReturnType<typeof setup>;
    h = setup({
      complete: async (request) => {
        seen.push(request);
        controller.abort();
        return '{"kind":"invoke","name":"knowledge.query","arguments":{"query":"apples"}}';
      },
    });
    seedKnowledge(h, "apples", "apples CANCELLED_BODY");
    h.receive("1", "20002", true, "apples question");
    const wake = h.wakes.claim({ at: h.now(), leaseMs: 120000 })!;
    await expect(h.host.activate(wake, controller.signal)).rejects.toBeDefined();
    expect(seen).toHaveLength(1);
    expect(evidencePage(seen[0]!, "knowledge.query")).toBeUndefined();
    expect(JSON.stringify(seen)).not.toContain("CANCELLED_BODY");
    expect(h.outbox.list({})).toEqual([]);
    expect(h.journal.ensureOneBot(bindingId)!.consumedSeq).toBe(0);
  });
});
