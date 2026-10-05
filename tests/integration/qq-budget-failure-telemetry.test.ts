import { afterEach, describe, expect, it } from "bun:test";
import { createAgentRuntime } from "../../src/server/agent/agent-runtime";
import type { AgentSpec } from "../../src/server/agent/agent-specs";
import { BotContextSource } from "../../src/server/channels/onebot11/context-source";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { OutboundIntentRepository } from "../../src/server/db/outbound-intent-repository";
import { insertQqBinding } from "../../src/server/db/qq-binding-repository";
import { createQqScheme } from "../../src/server/db/qq-scheme-repository";
import { updateQqSettings } from "../../src/server/db/qq-settings-repository";
import { DEFAULT_AGENT_ID, ensureDefaults, getAgentRow } from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import type { ModelGateway } from "../../src/server/llm/model-gateway";
import { captureQqTask, createQqBinding } from "../../src/server/services/qq-binding-contract";
import { QQ_CONTEXT_DEFAULT } from "../../src/server/services/qq-context-contract";
import { QQ_MEDIA_RULE } from "../../src/server/services/qq-prompt-contract";
import { runtimeFromAgent } from "../../src/server/services/runtime-config";
import { closeHarnesses, createOneBotHarness } from "../harness/onebot";

/**
 * QQ 装配预算失败的数值诊断（DIAG-INTERFACE 定稿口径）：预算事件走 context-source 既有
 * `onDiagnostic` union（无第二回调），宿主经既有 diagnose → bot.host.feedback span 落
 * runtime_spans。本文件只断言诊断真实形状与数值数学，不改任何产品行为：
 *
 * 1. window_fit：单条 mandatory 装不下仍是合法拒绝，失败前发出带阶段/档位/容量分项的
 *    预算事件；容量充足的成功路径不发事件——拒绝由容量决定，诊断只观测、不改变它。
 * 2. evaluation_fit：评分上下文超限时事件区分阶段与档位，roomFor = view.limit − units
 *    （该阶段判据的独立数学）。
 * 3. 宿主真链（tests/harness/onebot.ts 同一夹具）：唤醒失败后 bot.host.feedback span
 *    可从 runtime_spans 读回，带真实 runId/sourceSeq 与 scalar 预算分项；details 字段
 *    封闭、不含聊天正文/协议文本；观测订阅者抛错不改原预算错误（宿主 diagnose 既有
 *    try/catch，单一入口，不为本测新增回调框架）。
 *
 * 明示未覆盖（不伪造夹具、不 hook 私有方法）：media_fallback 需媒体 unsupported 降级链
 * 真实 fixture；final_fit 在现有裁剪顺序下难自然触达。两者由宿主/源实现同口径发出。
 *
 * 隐私：输入只有测试自造的标记串与内存 SQLite；断言的是数值/枚举，正文标记串不得出现在
 * 任何 span 或 run 读回里。不读真实 data/local/state、不调模型、不发消息。
 */
const BODY = `TELEMETRYBODYMARKER${"b".repeat(40)}`;

/** 与 context-source union 预算成员同形的只读视图（避免从产品文件导出测试专用类型）。 */
interface BudgetDiagnostic {
  kind: "context_budget_exceeded";
  code: "CONTEXT_BUDGET_EXCEEDED";
  stage: "window_fit" | "final_fit" | "evaluation_fit";
  tier: "reply" | "judgement";
  model: string;
  capacity: number | null;
  ceiling: number;
  renderedCost: number;
  roomFor: number;
}
const isBudgetDiagnostic = (event: unknown): event is BudgetDiagnostic =>
  (event as { kind?: string }).kind === "context_budget_exceeded";

const handles: ReturnType<typeof openBusinessDb>[] = [];
afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
});

/**
 * 夹具时钟固定在模块加载那一刻（与 qq-context-budget-diagnostics 同因）：同一轮里所有
 * 夹具看到同一个 now，避免跨秒让相对时间整体平移。
 */
const FIXED_SECONDS = Math.floor(Date.now() / 1000);
const FIXED_NOW = new Date(FIXED_SECONDS * 1000).toISOString();

function setup(input: { tokenBudget?: number; specModel?: string } = {}) {
  const handle = openBusinessDb();
  handles.push(handle);
  ensureDefaults(handle.orm, "reply-model");
  const seconds = FIXED_SECONDS;
  const now = FIXED_NOW;
  updateQqSettings(handle.orm, { enabled: true, accountId: "10001", expectedRevision: 1 });
  const scheme = createQqScheme(handle.orm, {
    name: "budget-failure-telemetry",
    context: { ...QQ_CONTEXT_DEFAULT, reply_token_budget: input.tokenBudget ?? 16384 },
  });
  const created = createQqBinding({
    id: crypto.randomUUID(),
    accountId: "10001",
    kind: "group",
    peerId: "30003",
    agentId: DEFAULT_AGENT_ID,
    schemeId: scheme.id,
    paused: false,
    shareWebMemory: false,
  });
  if (created.kind !== "saved") throw new Error("binding");
  const binding = insertQqBinding(handle.orm, created.binding);
  const capture = captureQqTask(binding, "reply");
  if (capture.kind !== "captured") throw new Error("snapshot");
  const row = getAgentRow(handle.orm, DEFAULT_AGENT_ID);
  if (!row) throw new Error("agent");
  const runtime = runtimeFromAgent(row);
  const journal = new ConversationEventRepository(handle.db);
  const outbox = new OutboundIntentRepository(handle.db);
  const conversation = journal.ensureOneBot(binding.id);
  if (!conversation) throw new Error("conversation");
  const gateway: ModelGateway = {
    config: { baseUrl: "http://unused.invalid", model: "reply-model", timeoutSeconds: 1 },
    listModels: async () => [],
    probeModelLoaded: async () => true,
    // 与真实同轮冻结同构：source 构造后的容量探针值不变；这里按 key 如实应答。
    loadedContextCapacity: async () => probe.capacity,
    complete: async () => '{"facts":[]}',
    async *streamChat() {
      yield "unused";
    },
  };
  const probe = { capacity: 65536 };
  const runs = new AgentRunRepository(handle.db);
  const spec: AgentSpec = {
    id: "test.budget.telemetry",
    model: input.specModel ?? "reply-model",
    context: "conversation",
    instructions: QQ_MEDIA_RULE,
    availableActions: [],
    limits: { steps: 16 },
  };
  /** 造一个 source；本实例发出的诊断事件收进调用方给的数组。 */
  const buildSource = (events: unknown[]) =>
    new BotContextSource({
      ...handle,
      gateway,
      agentRuntime: createAgentRuntime({ gateway, repository: runs }),
      journal,
      outbox,
      conversationId: conversation.id,
      binding,
      snapshot: capture.snapshot,
      scheme,
      runtime,
      spec,
      path: "direct_reply",
      decisionTier: "reply",
      targets: () => [{ id: "alice", speakerId: "20002" }],
      assertCurrent() {},
      now: () => now,
      onDiagnostic: (event) => {
        events.push(event);
      },
    });
  /**
   * 一条合成入站消息，带完整的事实快照行（三行 + journal ingest，与真实装配同构；
   * 缺行会让投影恒空、测的不是真实装配路径）。
   */
  const seed = (text: string, age = 0) => {
    const eventKey = crypto.randomUUID();
    handle.orm
      .insert(schema.qqEvents)
      .values({
        eventKey,
        accountId: "10001",
        conversationKind: "group",
        peerId: "30003",
        agentId: DEFAULT_AGENT_ID,
        messageId: eventKey,
        occurredAtSeconds: seconds - age,
        speakerKind: "member",
        speakerId: "20002",
        recordedAt: now,
      })
      .run();
    handle.orm
      .insert(schema.qqMessageFacts)
      .values({
        eventKey,
        legacyDisplayName: "member",
        nameState: "legacy",
        parts: JSON.stringify([{ kind: "text", text }]),
        revision: 1,
        expiresAt: new Date((seconds + 3600) * 1000).toISOString(),
        recordedAt: now,
      })
      .run();
    handle.orm
      .insert(schema.qqObservationText)
      .values({
        eventKey,
        body: text,
        occurredAtSeconds: seconds - age,
        expiresAt: new Date((seconds + 3600) * 1000).toISOString(),
        recordedAt: now,
      })
      .run();
    journal.ingestOneBotEvent(eventKey, binding.id);
    return eventKey;
  };
  /** 装一次回复档窗口；失败时返回错误码（不吞其他错误类型）。 */
  const attempt = (capacity: number, events: unknown[]) => {
    probe.capacity = capacity;
    const source = buildSource(events);
    return source
      .read({ signal: new AbortController().signal, observations: [] })
      .then(() => ({ ok: true as const, source }))
      .catch((error: unknown) => ({
        ok: false as const,
        code: (error as { code?: string }).code,
        source,
      }));
  };
  /** 真实公开入参评分相（宿主对判断档同样如此调用）；intent 是被评分的"打算说什么"。 */
  const evaluate = (capacity: number, intentBytes: number, events: unknown[]) => {
    probe.capacity = capacity;
    const source = buildSource(events);
    return source
      .prepareEvaluation({
        signal: new AbortController().signal,
        target: null,
        ...(intentBytes > 0 ? { intent: "e".repeat(intentBytes) } : {}),
      })
      .then(() => ({ ok: true as const }))
      .catch((error: unknown) => ({ ok: false as const, code: (error as { code?: string }).code }));
  };
  return { ...handle, seed, attempt, evaluate };
}

describe("QQ 装配预算失败诊断", () => {
  it("window_fit：单条 mandatory 装不下仍合法拒绝，失败前发 scalar 预算事件；装得下时不发", async () => {
    const rejected = setup();
    const events: unknown[] = [];
    rejected.seed(BODY, 0);
    const failure = await rejected.attempt(1024, events);
    expect(failure.ok).toBe(false);
    // 观测不改判据：错误码与行为同修复后基线一致，诊断事件不改变拒绝本身。
    expect(!failure.ok && failure.code).toBe("CONTEXT_BUDGET_EXCEEDED");
    const budget = events.filter(isBudgetDiagnostic);
    expect(budget).toHaveLength(1);
    const event = budget[0]!;
    expect(event.code).toBe("CONTEXT_BUDGET_EXCEEDED");
    expect(event.stage).toBe("window_fit");
    expect(event.tier).toBe("reply");
    // 容量来自 available() 同 key 的既有缓存（本夹具探针值），unknown 才是 null。
    expect(event.capacity).toBe(1024);
    // 各分项是真实数学的有限数：上限被容量封顶，成本为正，余量为负（正是拒绝的原因）。
    expect(Number.isSafeInteger(event.ceiling)).toBe(true);
    expect(event.ceiling).toBeGreaterThanOrEqual(1);
    expect(event.ceiling).toBeLessThanOrEqual(1024);
    expect(Number.isSafeInteger(event.renderedCost)).toBe(true);
    expect(event.renderedCost).toBeGreaterThan(0);
    expect(Number.isSafeInteger(event.roomFor)).toBe(true);
    expect(event.roomFor).toBeLessThan(0);
    // window_fit 判据：roomFor = ceiling − 成本 − 信封底限 − 动作余量，后两项非负。
    expect(event.roomFor).toBeLessThanOrEqual(event.ceiling - event.renderedCost);

    // 容量充足时同一条消息照常装下：成功路径不发预算事件（也不发任何预算观测）。
    const accepted = setup();
    const successEvents: unknown[] = [];
    accepted.seed(BODY, 0);
    const ok = await accepted.attempt(65536, successEvents);
    expect(ok.ok).toBe(true);
    expect(successEvents.filter(isBudgetDiagnostic)).toHaveLength(0);
  }, 120_000);

  it("evaluation_fit：评分相超限的事件区分阶段与档位，roomFor = view.limit − units", async () => {
    // 先二分出「评分相（空 intent）恰好装得下」的最小容量：该容量下窗口与评分都成立，
    // 之后只加大真实公开入参 intent（宿主传的"打算说什么"），让 units 越过 view.limit。
    let lo = 1024;
    let hi = 1 << 18;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      const probe = setup({ specModel: "judge-model" });
      probe.seed(BODY, 0);
      const result = await probe.evaluate(mid, 0, []);
      for (const handle of handles.splice(0)) handle.close();
      if (result.ok) hi = mid;
      else if (result.code === "CONTEXT_BUDGET_EXCEEDED") lo = mid + 1;
      else throw new Error(`非预算失败：${result.code}`);
    }
    const capacity = lo;

    const handle = setup({ specModel: "judge-model" });
    const events: unknown[] = [];
    handle.seed(BODY, 0);
    const failure = await handle.evaluate(capacity, 20_000, events);
    expect(failure.ok).toBe(false);
    expect(!failure.ok && failure.code).toBe("CONTEXT_BUDGET_EXCEEDED");
    const budget = events.filter(isBudgetDiagnostic);
    expect(budget).toHaveLength(1);
    const event = budget[0]!;
    // 阶段/档位/模型按该阶段真实判据：评分走判断档与规格模型，容量此时已在缓存里。
    expect(event.stage).toBe("evaluation_fit");
    expect(event.tier).toBe("judgement");
    expect(event.model).toBe("judge-model");
    expect(event.capacity).toBe(capacity);
    expect(Number.isSafeInteger(event.ceiling)).toBe(true);
    expect(event.ceiling).toBeGreaterThanOrEqual(1);
    // intent 不折算进窗口成本、只进评分计量：renderedCost 必须把 20000 字节 intent 计入。
    expect(event.renderedCost).toBeGreaterThan(20_000);
    // 评分阶段的独立数学：roomFor = view.limit − units，恰好是这次的负差值。
    expect(event.roomFor).toBe(event.ceiling - event.renderedCost);
    expect(event.roomFor).toBeLessThan(0);
  }, 240_000);

  it("宿主真链：唤醒失败落 bot.host.feedback span，runId/sourceSeq 真实可读且不含正文", async () => {
    const subscriberEvents: unknown[] = [];
    const h = createOneBotHarness({
      kind: "private",
      capacity: 1024,
      telemetry: true,
      // 观测订阅者抛错：宿主 diagnose 既有 try/catch 吞掉——观测不得改变失败与投递状态。
      onDiagnostic: (event) => {
        subscriberEvents.push(event);
        throw new Error("subscriber must not affect the run");
      },
    });
    try {
      const recorded: unknown = h.receive({ id: "91001", text: BODY });
      if (typeof recorded !== "object" || recorded === null || !("recorded" in recorded))
        throw new Error("fixture did not record input");
      // 入站真实落库：没有消息观察就没有唤醒，后面一切都不成立。
      expect(recorded.recorded).toBe(true);
      let code: unknown = null;
      try {
        await h.activate("direct_reply");
      } catch (error) {
        code = (error as { code?: unknown }).code;
      }
      // 失败发生在 run started 之后：预算错误原样抛出，观测不改变它。
      expect(code).toBe("CONTEXT_BUDGET_EXCEEDED");
      const diagnostics = subscriberEvents.filter(
        (event) => (event as { stage?: string }).stage === "context_budget",
      );
      expect(diagnostics).toHaveLength(1);
      const diagnostic = diagnostics[0] as {
        status: string;
        code: string;
        details: Record<string, unknown>;
        runId: string;
        sourceSeq: number;
      };
      expect(diagnostic.status).toBe("failed");
      expect(diagnostic.code).toBe("CONTEXT_BUDGET_EXCEEDED");
      expect(diagnostic.details.stage).toBe("window_fit");
      expect(diagnostic.details.tier).toBe("reply");
      expect(diagnostic.details.model).toBe("reply-model");
      expect(diagnostic.details.capacity).toBe(1024);
      expect(diagnostic.details.roomFor).toBeLessThan(0);
      expect(typeof diagnostic.runId).toBe("string");
      expect(typeof diagnostic.sourceSeq).toBe("number");

      // 真持久观测面：runtime_spans 实际行（列名按 schema，不用仓储页假象）。
      interface FeedbackRow {
        run_id: string | null;
        source_seq: number | null;
        code: string;
        details: string;
      }
      const rows = h.db
        .query(
          "SELECT run_id,source_seq,code,details FROM runtime_spans WHERE name='bot.host.feedback' AND code='CONTEXT_BUDGET_EXCEEDED' ORDER BY id",
        )
        .all() as FeedbackRow[];
      expect(rows).toHaveLength(1);
      const span = rows[0]!;
      const details = JSON.parse(span.details) as Record<string, unknown>;
      expect(details.stage).toBe("window_fit");
      expect(details.tier).toBe("reply");
      expect(details.model).toBe("reply-model");
      expect(details.capacity).toBe(1024);
      expect(details.feedbackStatus).toBe("failed");
      expect(typeof details.ceiling).toBe("number");
      expect(typeof details.renderedCost).toBe("number");
      expect(details.roomFor).toBeLessThan(0);
      // 诊断明细只含数值/枚举：合成正文标记不得出现在 span 明细里（run 快照合法携带
      // 输入材料，不在本断言范围）。
      expect(span.details).not.toContain("TELEMETRYBODYMARKER");
      // 本失败发生在 run started 之后：runId/sourceSeq 必须已绑定且 run 真实失败。
      expect(span.run_id).toBe(diagnostic.runId);
      expect(span.source_seq).toBe(diagnostic.sourceSeq);
      const run = h.runs.getRun(span.run_id!);
      expect(run?.status).toBe("failed");
    } finally {
      closeHarnesses();
    }
  }, 120_000);
});
