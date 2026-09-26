import { afterEach, describe, expect, it } from "bun:test";
import { createAgentRuntime } from "../../src/server/agent/agent-runtime";
import type { AgentSpec } from "../../src/server/agent/agent-specs";
import { ContextEngine } from "../../src/server/agent/context-engine";
import { ConversationCompressor } from "../../src/server/agent/conversation-compression";
import {
  BotContextSource,
  type BotContextSourceOptions,
} from "../../src/server/channels/onebot11/context-source";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { KnowledgeRepository } from "../../src/server/db/knowledge-repository";
import { updateOrganizationSettings } from "../../src/server/db/organization-repository";
import { OutboundIntentRepository } from "../../src/server/db/outbound-intent-repository";
import { insertQqBinding } from "../../src/server/db/qq-binding-repository";
import { createQqScheme } from "../../src/server/db/qq-scheme-repository";
import { updateQqSettings } from "../../src/server/db/qq-settings-repository";
import {
  DEFAULT_AGENT_ID,
  DEFAULT_USER_ID,
  ensureDefaults,
  getAgentRow,
} from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { fail } from "../../src/server/errors";
import type { ModelGateway } from "../../src/server/llm/model-gateway";
import {
  captureQqTask,
  createQqBinding,
  qqConversationKey,
  qqConversationScope,
  qqMemoryScopeKey,
} from "../../src/server/services/qq-binding-contract";
import { QQ_CONTEXT_DEFAULT } from "../../src/server/services/qq-context-contract";
import { QQ_MEDIA_RULE } from "../../src/server/services/qq-prompt-contract";
import { runtimeFromAgent } from "../../src/server/services/runtime-config";
import type { RuntimeConfig } from "../../src/shared/contracts";
import { QQ_COMPRESSION_DEFAULT } from "../../src/shared/contracts/qq";

const handles: ReturnType<typeof openBusinessDb>[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
});
function setup(
  input: {
    decisionTier?: "judgement" | "reply";
    tokenBudget?: number;
    watermarkTrigger?: number;
    packageLimit?: number;
    mode?: RuntimeConfig["p5_config"]["retrieval_mode"];
    modules?: BotContextSourceOptions["modules"];
    resolveSource?: BotContextSourceOptions["resolveSource"];
  } = {},
) {
  const h = openBusinessDb();
  handles.push(h);
  ensureDefaults(h.orm, "reply-model");
  const seconds = Math.floor(Date.now() / 1000),
    now = new Date(seconds * 1000).toISOString();
  updateQqSettings(h.orm, { enabled: true, accountId: "10001", expectedRevision: 1 });
  const scheme = createQqScheme(h.orm, {
    name: "context",
    ...(input.tokenBudget
      ? { context: { ...QQ_CONTEXT_DEFAULT, reply_token_budget: input.tokenBudget } }
      : {}),
    ...(input.watermarkTrigger
      ? {
          compression: {
            ...QQ_COMPRESSION_DEFAULT,
            watermark_trigger: input.watermarkTrigger,
            ...(input.packageLimit ? { package_limit: input.packageLimit } : {}),
          },
        }
      : {}),
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
  const binding = insertQqBinding(h.orm, created.binding);
  const capture = captureQqTask(binding, "reply");
  if (capture.kind !== "captured") throw new Error("snapshot");
  const row = getAgentRow(h.orm, DEFAULT_AGENT_ID);
  if (!row) throw new Error("agent");
  const runtime = runtimeFromAgent(row);
  runtime.p5_config.retrieval_mode = input.mode ?? "off";
  const journal = new ConversationEventRepository(h.db),
    outbox = new OutboundIntentRepository(h.db);
  const conversation = journal.ensureOneBot(binding.id);
  if (!conversation) throw new Error("conversation");
  const calls: Parameters<ModelGateway["complete"]>[0][] = [];
  const gateway: ModelGateway = {
    config: { baseUrl: "http://unused.invalid", model: "reply-model", timeoutSeconds: 1 },
    listModels: async () => [],
    probeModelLoaded: async () => true,
    loadedContextCapacity: async () => 65536,
    async complete(request) {
      calls.push(request);
      const data = JSON.parse(request.messages[1].content);
      if (data.events)
        return JSON.stringify({
          facts: [
            ...(data.previous_overview?.facts ?? []),
            ...data.events.map((event: { id: string; speaker: string }) => ({
              kind: "fact",
              speaker: event.speaker,
              text: "old fact",
              source_ids: [event.id],
            })),
          ],
        });
      return JSON.stringify({
        ids: data.candidates.map((candidate: { id: string }) => candidate.id),
      });
    },
    async *streamChat() {
      yield "unused";
    },
  };
  const runs = new AgentRunRepository(h.db),
    agentRuntime = createAgentRuntime({ gateway, repository: runs });
  const spec: AgentSpec = {
    id: "test.bot",
    model: input.decisionTier === "judgement" ? "judge-model" : "reply-model",
    context: "conversation",
    instructions: QQ_MEDIA_RULE,
    availableActions: [],
    limits: { steps: 16 },
  };
  const diagnostics: unknown[] = [];
  /** 一轮一个实例（真实宿主也是这样）：测试需要"下一轮"时另起一个，验证跨轮复用走的是存储。 */
  const buildSource = () =>
    new BotContextSource({
      ...h,
      gateway,
      agentRuntime,
      journal,
      outbox,
      conversationId: conversation.id,
      modules: input.modules,
      resolveSource: input.resolveSource,
      binding,
      snapshot: capture.snapshot,
      scheme,
      runtime,
      spec,
      path: "direct_reply",
      decisionTier: input.decisionTier ?? "reply",
      targets: () => [
        { id: "alice", speakerId: "20002" },
        { id: "bob", speakerId: "20003" },
      ],
      assertCurrent() {},
      now: () => now,
      onDiagnostic: (event) => diagnostics.push(event),
    });
  const source = buildSource();
  spec.availableActions = source.actions.map((action) => action.description);
  const seed = (text: string, age = 0, peer = "30003") => {
    const id = crypto.randomUUID();
    h.orm
      .insert(schema.qqEvents)
      .values({
        eventKey: id,
        accountId: "10001",
        conversationKind: "group",
        peerId: peer,
        agentId: DEFAULT_AGENT_ID,
        messageId: id,
        occurredAtSeconds: seconds - age,
        speakerKind: "member",
        speakerId: "20002",
        recordedAt: now,
      })
      .run();
    h.orm
      .insert(schema.qqObservationText)
      .values({
        eventKey: id,
        body: text,
        occurredAtSeconds: seconds - age,
        expiresAt: new Date((seconds + 3600) * 1000).toISOString(),
        recordedAt: now,
      })
      .run();
    if (peer === "30003") journal.ingestOneBotEvent(id, binding.id);
    return id;
  };
  const memory = (body: string, peer = "30003") => {
    const id = seed(body, 20, peer),
      key = qqMemoryScopeKey({ ...qqConversationScope(binding), peerId: peer });
    h.orm
      .insert(schema.memoryEntries)
      .values({
        id,
        agentId: DEFAULT_AGENT_ID,
        userId: DEFAULT_USER_ID,
        name: body,
        summary: body,
        tags: "[]",
        kinds: '["semantic"]',
        body,
        scope: "reality_user",
        scopeKey: key,
        status: "active",
        configSnapshot: "{}",
        createdAt: now,
      })
      .run();
    h.orm
      .insert(schema.qqMemorySources)
      .values({
        memoryId: id,
        eventKey: id,
        scopeKey: key,
        conversationKey: qqConversationKey({ accountId: "10001", kind: "group", peerId: peer }),
        messageId: id,
        occurredAtSeconds: seconds - 20,
        speakerKind: "member",
        speakerId: "20002",
      })
      .run();
    return id;
  };
  return {
    ...h,
    source,
    spec,
    runtime,
    calls,
    gateway,
    journal,
    conversation,
    memory,
    seed,
    runs,
    diagnostics,
    agentRuntime,
    binding,
    newSource: buildSource,
  };
}
const readInput = () => ({ signal: new AbortController().signal, observations: [] });
/** 这一轮跑过几次水位压缩（specId 固定在压缩叶子上）。 */
const compressionRuns = (h: ReturnType<typeof setup>) =>
  h.runs
    .listRuns({ ownerKind: "qq_binding", ownerId: h.binding.id })
    .filter((run) => run.specId === "context.compress.events");
describe("shared Bot context source", () => {
  it.each(["off", "conservative", "standard", "broad", "full_catalog", "full_body"] as const)(
    "preserves initial %s memory, scope and unchanged-step reuse",
    async (mode) => {
      const h = setup({ mode });
      const own = h.memory("own apples"),
        foreign = h.memory("foreign pears", "40004");
      h.seed("apples?");
      const material = await h.source.read(readInput());
      expect(JSON.stringify(material)).not.toContain(foreign);
      expect(JSON.stringify(h.calls)).not.toContain("foreign pears");
      expect(
        material.sources?.some((source) => source.kind === "memory" && source.id === own),
      ).toBe(mode !== "off");
      expect(h.calls.length > 0).toBe(mode !== "off" && mode !== "full_body");
      const evaluation = await h.source.prepareEvaluation({ ...readInput(), target: null });
      expect(
        evaluation.sources.some((source) => source.kind === "memory" && source.id === own),
      ).toBe(mode !== "off");
      expect(JSON.stringify(evaluation.messages)).not.toContain("foreign pears");
      const count = h.calls.length;
      await h.source.prepareEvaluation({ ...readInput(), target: null });
      expect(await h.source.read(readInput())).toBe(material);
      expect(h.calls).toHaveLength(count);
      if (mode !== "off") {
        h.db.query("UPDATE memory_entries SET body='revised' WHERE id=?").run(own);
        await expect(h.source.read(readInput())).rejects.toMatchObject({
          code: "CONTEXT_SOURCE_INVALID",
        });
      }
    },
  );
  it("uses the injected memory module for initial Bot evidence and later actions", async () => {
    let reads = 0;
    const h = setup({
      mode: "full_body",
      modules: () => ({
        memory: {
          query: async () => {
            reads++;
            return [
              {
                id: "custom",
                text: "opaque external memory",
                sources: [{ kind: "external", id: "memory", revision: "1" }],
              },
            ];
          },
        },
        knowledge: { query: async () => [] },
      }),
      resolveSource: (source) => (source.kind === "external" ? "available" : undefined),
    });
    h.memory("SQLite memory should not be read");
    h.seed("question");
    const material = await h.source.read(readInput());
    expect(JSON.stringify(material.pending)).toContain("opaque external memory");
    // The raw conversation legitimately contains the seeded event, so inspect only the memory section.
    expect(JSON.stringify(material.sources)).not.toContain('"kind":"memory"');
    const action = h.source.actions.find((entry) => entry.description.name === "memory.query");
    if (!action) throw new Error("missing action");
    await action.execute(
      { query: "follow up" },
      { owner: { kind: "test", id: "test" }, signal: new AbortController().signal },
    );
    expect(reads).toBe(2);
  });

  it("accepts a replaceable query backend with explicit source authority and rejects its later revocation", async () => {
    let valid = true,
      reads = 0;
    const remote = { kind: "remote_document", id: "doc", revision: "7" };
    const h = setup({
      modules: () => ({
        memory: { query: async () => [] },
        knowledge: {
          query: async () => {
            reads++;
            return [{ id: "remote", text: "external knowledge", sources: [remote] }];
          },
        },
      }),
      resolveSource: (source) =>
        source.kind === "remote_document" ? (valid ? "available" : "revoked") : undefined,
    });
    h.seed("question");
    const material = await h.source.read(readInput());
    expect(material.evidence?.[0].text).toBe("external knowledge");
    expect(material.sources).toContainEqual(remote);
    await h.source.read(readInput());
    expect(reads).toBe(1);
    valid = false;
    await expect(h.source.read(readInput())).rejects.toMatchObject({
      code: "CONTEXT_SOURCE_INVALID",
    });
  });

  it("injects semantic knowledge initially with grant provenance and rejects revocation on reuse", async () => {
    const h = setup();
    h.seed("apples?");
    const repo = new KnowledgeRepository(h.db);
    const doc = repo.importDocument({
      name: "apples",
      category_id: "default",
      original_text: "apples need cold storage",
    });
    repo.replaceGrants(doc.id, doc.revision, [DEFAULT_AGENT_ID]);
    const material = await h.source.read(readInput());
    expect(JSON.stringify(material.evidence)).toContain("cold storage");
    expect(material.sources?.some((source) => source.kind === "knowledge_grant")).toBe(true);
    repo.replaceGrants(doc.id, repo.detail(doc.id).revision, []);
    await expect(h.source.read(readInput())).rejects.toMatchObject({
      code: "CONTEXT_SOURCE_INVALID",
    });
  });
  it("preserves distinct judgement/reply windows and per-target trusted instructions", async () => {
    const h = setup({ decisionTier: "judgement" });
    h.seed("older reply-only fact", 7200);
    h.seed("recent fact");
    const material = await h.source.read(readInput());
    expect(JSON.stringify(material)).not.toContain("older reply-only fact");
    const context = new ContextEngine().render(h.spec, material, [], ["alice", "bob"]);
    const prepared = await h.source.prepareGeneration(
      { kind: "generate", targetId: "bob", instructions: "answer" },
      { context, outputId: "output", signal: new AbortController().signal },
    );
    expect(JSON.stringify(prepared.context?.messages)).toContain("older reply-only fact");
    expect(prepared.instructions).toContain("20003");
    expect(prepared.model).toBe("reply-model");
    // 回复档看得到更宽的窗口（内容断言见上）。来源数不再要求"严格更多"：判断档现在也会把
    // **窗口之外**的老消息压成滚动摘要，两边的来源集因此可能相同。
    expect(prepared.context?.sources.length).toBeGreaterThanOrEqual(context.sources.length);
    const count = h.calls.length;
    await h.source.read(readInput());
    expect(h.calls).toHaveLength(count);
  });
  it("projects scoring from the same judgement material, including observations and exact configured score instructions", async () => {
    const h = setup({ decisionTier: "judgement", mode: "full_body" });
    const own = h.memory("own factual memory");
    const observed = h.seed("evidence delivered by an action");
    const initial = await h.source.read(readInput());
    const ref = initial.sources?.find((source) => source.id === observed);
    if (!ref) throw new Error("Missing observed source");
    await h.source.read({
      ...readInput(),
      observations: [
        { id: "observation", name: "memory.query", value: "supplemental result", sources: [ref] },
      ],
    });
    const prepared = await h.source.prepareEvaluation({
      ...readInput(),
      target: { id: "bob", speakerId: "20003" },
    });
    expect(prepared.model).toBe("judge-model");
    expect(prepared.messages[0].content).toContain("20003");
    expect(prepared.messages[0].content).toContain("score");
    expect(prepared.messages[0].content).not.toContain("Return exactly one JSON decision");
    expect(prepared.messages[0].content).not.toContain("Write only the response body");
    expect(prepared.messages.slice(1).every((message) => message.role !== "system")).toBe(true);
    expect(JSON.stringify(prepared.messages)).toContain("supplemental result");
    expect(prepared.sources.some((source) => source.id === own)).toBe(true);
    const calls = h.calls.length;
    await h.source.prepareEvaluation({ ...readInput(), target: null });
    expect(h.calls).toHaveLength(calls);
    h.db.query("DELETE FROM qq_observation_text WHERE event_key=?").run(observed);
    await expect(
      h.source.prepareEvaluation({ ...readInput(), target: null }),
    ).rejects.toMatchObject({ code: "CONTEXT_SOURCE_INVALID" });
    expect(h.calls).toHaveLength(calls);
  });

  it("re-observes newer events explicitly while rejecting deleted prior sources", async () => {
    const h = setup();
    const first = h.seed("first");
    await h.source.read(readInput());
    const seq = h.source.observedSeq;
    h.seed("second");
    expect(JSON.stringify(await h.source.read(readInput()))).not.toContain("second");
    h.source.invalidate();
    expect(JSON.stringify(await h.source.read(readInput()))).toContain("second");
    expect(h.source.observedSeq).toBeGreaterThan(seq);
    h.db.query("DELETE FROM qq_observation_text WHERE event_key=?").run(first);
    await expect(h.source.read(readInput())).rejects.toMatchObject({
      code: "CONTEXT_SOURCE_INVALID",
    });
  });
  /**
   * 记忆读取是**可选材料**——它自己的预算检查（选中的正文超过本轮可用额度）
   * 不该打死整次唤醒。群里"处理失败 CONTEXT_MEMORY_BUDGET"就是这条：现在照常判断与回复，
   * 只留一条带码诊断（这一轮没有记忆）。
   */
  it("survives a memory budget overrun instead of failing the whole wake", async () => {
    const h = setup({
      mode: "broad",
      modules: () => ({
        memory: {
          query: async (): Promise<never> => {
            fail("CONTEXT_MEMORY_BUDGET", "已选记忆正文超过可用预算，未静默注入部分正文");
          },
        },
        knowledge: { query: async () => [] },
      }),
    });
    h.seed("question");
    const material = await h.source.read(readInput());
    expect(JSON.stringify(material.pending)).toContain("question");
    expect(JSON.stringify(material.pending)).not.toContain("长期记忆");
    expect(h.diagnostics).toMatchObject([
      {
        kind: "supplemental_retrieval_failed",
        name: "memory.initial",
        code: "CONTEXT_MEMORY_BUDGET",
      },
    ]);
  });
  /**
   * 水位压缩：窗口边界按回复档；凡没进最终原文窗口的消息进水位；
   * 攒够 watermark_trigger 条才压 **一包**；包装在独立消息里，水位里的原文不装配。
   */
  it("does not compress or ship history before the watermark fills", async () => {
    const h = setup({ watermarkTrigger: 5 });
    h.seed(`old ${"x".repeat(50)}`, 31000);
    h.seed(`older ${"x".repeat(50)}`, 30000);
    const material = await h.source.read(readInput());
    expect(JSON.stringify(material.pending)).not.toContain("qq_context_packages");
    expect(JSON.stringify(material.pending)).not.toContain("old ");
    expect(h.orm.select().from(schema.qqConversationSummaries).get()).toBeUndefined();
    expect(compressionRuns(h)).toHaveLength(0);
  });
  it("compresses one package when the watermark fills, with the scheme task and the shared model", async () => {
    const h = setup({ watermarkTrigger: 2 });
    updateOrganizationSettings(h.orm, { model_name: "shared-org-model", expected_revision: 1 });
    h.seed(`old ${"x".repeat(50)}`, 31000);
    h.seed(`older ${"x".repeat(50)}`, 30000);
    h.seed("recent fact");
    const source = h.newSource();
    const material = await source.read(readInput());
    const pending = JSON.stringify(material.pending);
    // 原文窗口没动（老消息不在时间线里），它们只作为一包出现在独立消息里。
    expect(pending).toContain("qq_context_packages");
    expect(pending).toContain("old fact");
    expect(pending).toContain("recent fact");
    const row = h.orm.select().from(schema.qqConversationSummaries).get();
    if (!row) throw new Error("expected the rolling summary row");
    // 两个水位都停在窗口外那批的末尾（seq 2）。
    expect(row.throughSeq).toBe(2);
    expect(row.coveredSeq).toBe(2);
    const stored = JSON.parse(row.content) as { packages: Array<{ throughSeq: number }> };
    expect(stored.packages).toHaveLength(1);
    expect(stored.packages[0]?.throughSeq).toBe(2);
    expect(compressionRuns(h)).toHaveLength(1);
    // 任务描述取方案的 compress 槽位，模型取「共享用途默认值 → 整理模型」。
    const call = h.calls.find((entry) => entry.model === "shared-org-model");
    if (!call) throw new Error("expected the compression call on the shared model");
    expect(JSON.stringify(call.messages)).toContain("压成中性的事实条目");
  });
  it("keeps the package when the summary model wraps its answer in a fence", async () => {
    const h = setup({ watermarkTrigger: 2 });
    const base = h.gateway.complete.bind(h.gateway);
    h.gateway.complete = async (request) => `\`\`\`json\n${await base(request)}\n\`\`\``;
    h.seed(`old ${"x".repeat(50)}`, 31000);
    h.seed(`older ${"x".repeat(50)}`, 30000);
    h.seed("recent fact");
    const source = h.newSource();
    const material = await source.read(readInput());
    // 实测：模型把 JSON 包在 ```json 围栏里——围栏是包装，不是内容，包照常落库、照常装配。
    expect(JSON.stringify(material.pending)).toContain("qq_context_packages");
    expect(JSON.stringify(material.pending)).toContain("old fact");
    expect(compressionRuns(h)).toHaveLength(1);
  });
  it("reuses stored packages without another call when nothing new rolled out", async () => {
    const h = setup({ watermarkTrigger: 2 });
    h.seed(`old ${"x".repeat(50)}`, 31000);
    h.seed(`older ${"x".repeat(50)}`, 30000);
    const first = await h.source.read(readInput());
    expect(compressionRuns(h)).toHaveLength(1);
    const again = h.newSource();
    const second = await again.read(readInput());
    expect(JSON.stringify(second.pending)).toBe(JSON.stringify(first.pending));
    expect(compressionRuns(h)).toHaveLength(1);
  });
  it("keeps the judgement tier off the water level entirely", async () => {
    const h = setup({ decisionTier: "judgement", watermarkTrigger: 1 });
    h.seed(`old ${"x".repeat(50)}`, 30000);
    h.seed("recent fact");
    const material = await h.source.read(readInput());
    // 判断档：不装配包、也不压——一次调用都不花，水位原地不动。
    expect(JSON.stringify(material.pending)).not.toContain("qq_context_packages");
    expect(compressionRuns(h)).toHaveLength(0);
    expect(h.orm.select().from(schema.qqConversationSummaries).get()).toBeUndefined();
    // 回复档展开时才处理水位：老消息这时才压成包、落库、进回复上下文。
    const context = new ContextEngine().render(h.spec, material, [], ["alice"]);
    const reply = await h.source.prepareGeneration(
      { kind: "generate", targetId: "alice", instructions: "answer" },
      { context, outputId: "output", signal: new AbortController().signal },
    );
    expect(compressionRuns(h)).toHaveLength(1);
    expect(JSON.stringify(reply.context?.messages)).toContain("qq_context_packages");
    expect(h.orm.select().from(schema.qqConversationSummaries).get()?.throughSeq).toBe(1);
  });
  it("drops the oldest package once the package limit is exceeded", async () => {
    const h = setup({ watermarkTrigger: 1, packageLimit: 1 });
    h.seed("first fact", 31000);
    await h.source.read(readInput());
    h.seed("second fact", 30000);
    const again = h.newSource();
    await again.read(readInput());
    const row = h.orm.select().from(schema.qqConversationSummaries).get();
    if (!row) throw new Error("expected the rolling summary row");
    const stored = JSON.parse(row.content) as { packages: Array<{ throughSeq: number }> };
    expect(stored.packages).toHaveLength(1);
    expect(stored.packages[0]?.throughSeq).toBe(2);
    expect(row.throughSeq).toBe(2);
  });
  it("keeps the raw window and stores nothing when an optional compression fails", async () => {
    const h = setup({ watermarkTrigger: 1 });
    h.seed(`old ${"x".repeat(50)}`, 31000);
    h.seed("recent fact");
    h.gateway.complete = async () => "invalid JSON";
    const material = await h.source.read(readInput());
    expect(JSON.stringify(material.pending)).toContain("recent fact");
    expect(JSON.stringify(material.pending)).not.toContain("qq_context_packages");
    expect(h.diagnostics).toMatchObject([
      { kind: "supplemental_summary_failed", code: "MODEL_STRUCTURE_INVALID" },
    ]);
    expect(h.orm.select().from(schema.qqConversationSummaries).get()).toBeUndefined();
  });
  it("keeps the water level when the model returns an empty summary", async () => {
    const h = setup({ watermarkTrigger: 1 });
    h.seed(`old ${"x".repeat(50)}`, 31000);
    h.seed("recent fact");
    h.gateway.complete = async () => '{"facts":[]}';
    const material = await h.source.read(readInput());
    // 空包＝把那批老消息唯一一份存证丢掉：判这次尝试失败，水位不动（下次再压），窗口照旧。
    expect(JSON.stringify(material.pending)).toContain("recent fact");
    expect(JSON.stringify(material.pending)).not.toContain("qq_context_packages");
    expect(h.diagnostics).toMatchObject([
      { kind: "supplemental_summary_failed", code: "CONTEXT_SUMMARY_EMPTY" },
    ]);
    expect(h.orm.select().from(schema.qqConversationSummaries).get()).toBeUndefined();
  });
  it("keeps raw input when the optional compression times out, but records its failed leaf", async () => {
    const h = setup({ watermarkTrigger: 1 });
    h.seed(`old ${"x".repeat(50)}`, 31000);
    h.seed("recent fact");
    h.gateway.complete = async () => {
      throw new DOMException("summary timeout", "TimeoutError");
    };
    const material = await h.source.read(readInput());
    expect(JSON.stringify(material.pending)).toContain("recent fact");
    expect(h.diagnostics).toEqual([{ kind: "supplemental_summary_failed", code: "MODEL_TIMEOUT" }]);
    expect(h.runs.listRuns({ ownerKind: "qq_binding", ownerId: h.binding.id })[0]?.status).toBe(
      "failed",
    );
  });
  it("stores a package built only from window-trimmed messages without tripping the watermark column", async () => {
    const h = setup({ tokenBudget: 256, watermarkTrigger: 1 });
    h.seed(`old ${"x".repeat(200)}`, 3);
    h.seed(`middle ${"x".repeat(200)}`, 2);
    h.seed(`new ${"x".repeat(200)}`);
    const material = await h.source.read(readInput());
    expect(JSON.stringify(material.pending)).toContain("qq_context_packages");
    const row = h.orm.select().from(schema.qqConversationSummaries).get();
    if (!row) throw new Error("expected the rolling summary row");
    // 只压了窗口内被裁掉的那段：历史水位没有可推的，落 0（列不允许 -1）；已覆盖水位落在 seq 2。
    expect(row.throughSeq).toBe(0);
    expect(row.coveredSeq).toBe(2);
    const stored = JSON.parse(row.content) as { packages: Array<{ throughSeq: number }> };
    expect(stored.packages).toHaveLength(1);
    expect(stored.packages[0]?.throughSeq).toBe(2);
    // 落库与压缩都成功：没有任何诊断（写失败或坏行都会留一条带码的诊断）。
    expect(h.diagnostics).toEqual([]);
  });
  it("refuses to publish a package that exceeds the read budget", async () => {
    const h = setup({ watermarkTrigger: 1 });
    h.runtime.p5_config.summary_read_max_tokens = 1;
    h.seed(`old ${"x".repeat(50)}`, 31000);
    h.seed("recent fact");
    const material = await h.source.read(readInput());
    expect(JSON.stringify(material.pending)).toContain("recent fact");
    expect(JSON.stringify(material.pending)).not.toContain("qq_context_packages");
    // 目标预算放不下就**不发布**（与网页侧同一条纪律）：本轮无包、也不落库，下一轮预算够了再压。
    expect(h.diagnostics).toMatchObject([
      { kind: "supplemental_summary_failed", code: "CONTEXT_SUMMARY_BUDGET" },
    ]);
    expect(h.orm.select().from(schema.qqConversationSummaries).get()).toBeUndefined();
  });
  it("counts prior action observations and refuses partial full-mode evidence", async () => {
    const h = setup({ mode: "full_body" });
    h.memory("own memory");
    h.seed("question");
    await h.source.read(readInput());
    const action = h.source.actions.find((action) => action.description.name === "memory.query");
    if (!action) throw new Error("Missing memory action");
    const first = await action.execute(
      { query: "memory" },
      { owner: { kind: "test", id: "test" }, signal: new AbortController().signal },
    );
    expect((first.value as unknown[]).length).toBeGreaterThan(0);
    await h.source.read({
      ...readInput(),
      observations: [{ id: "large", name: "memory.query", value: "x".repeat(65000), sources: [] }],
    });
    // 全量模式仍然"要么全给、要么不给"，但**不给也不再打死整轮**——
    // 返回空结果并留一条带码诊断（本轮照常判断与回复）。
    const second = await action.execute(
      { query: "memory" },
      { owner: { kind: "test", id: "test" }, signal: new AbortController().signal },
    );
    expect(second.value).toEqual([]);
    expect(h.diagnostics).toMatchObject([
      {
        kind: "supplemental_retrieval_failed",
        name: "memory.query",
        code: "CONTEXT_BUDGET_EXCEEDED",
      },
    ]);
  });
  /**
   * 同族问题的根：装配要**永远留出后续循环的一条观测**（动作结果会把材料的全部 sources 原样带上，
   * 一条就是几千单位），否则装配贴到上限时任何动作都会"装不下"（贴纸检索就这么抛过
   * STICKER_SEARCH_CONTEXT_LIMIT）。上限本身仍是"能发出去的全部"，预留只压装配目标。
   */
  it("reserves room for the loop's next action observation inside the tier ceiling", async () => {
    const h = setup({ tokenBudget: 16384 });
    h.gateway.loadedContextCapacity = async () => 8192;
    for (let index = 0; index < 40; index += 1) h.seed(`old ${"x".repeat(480)}`, 1);
    h.seed("newest question", 0);
    await h.source.read(readInput());
    // 8192 − 2048（回复档输出预留）= 6144；× (1 − 5%) = 5836——这是容量上限，步骤预算用它。
    expect(h.spec.limits.inputUnits).toBe(5836);
    // 窗口收到"材料 + 下一条观测"放得下为止：动作自己的拟合必须通过。
    const fits = await h.source.actionResultFitter(
      "sticker.search",
      { query: "趴" },
      new AbortController().signal,
    );
    expect(fits({ status: "available", items: [], nextCursor: null }, [])).toBe(true);
  });
  /**
   * 观测是一条条累起来的（模型每调一次动作就多一条），材料却只在新事件到达时重装。累到顶住上限时
   * 必须重装（窗口自动收窄），否则第 N 步的渲染会超上限、运行时只能整轮判失败——群里
   * 00:12–00:24 那几条 `AGENT_CONTEXT_LIMIT` 就是模型连着调 speech.evaluate 把观测堆穿了。
   */
  it("re-assembles the window when accumulated observations crowd the ceiling", async () => {
    const h = setup({ tokenBudget: 16384 });
    h.gateway.loadedContextCapacity = async () => 16384;
    for (let index = 0; index < 20; index += 1) h.seed(`old ${"x".repeat(480)}`, 1);
    h.seed("newest question", 0);
    const first = await h.source.read(readInput());
    const observations = [0, 1].map((index) => ({
      id: crypto.randomUUID(),
      name: "speech.evaluate",
      arguments: {},
      value: { verdict: `v${index}`, note: "y".repeat(2400) },
      sources: [],
    }));
    const material = await h.source.read({ signal: new AbortController().signal, observations });
    // 重装后窗口收窄（材料比没有观测时小），最新一条还在，且仍放得下"这批观测 + 下一条动作结果"。
    expect(JSON.stringify(material.pending).length).toBeLessThan(
      JSON.stringify(first.pending).length,
    );
    expect(JSON.stringify(material.pending)).toContain("newest question");
    const fits = await h.source.actionResultFitter(
      "sticker.search",
      { query: "趴" },
      new AbortController().signal,
    );
    expect(fits({ status: "available", items: [], nextCursor: null }, [])).toBe(true);
  });
  /**
   * 窗口是"配置的预算"，但预算可能比这台模型能装的还大（换模型、调输出预留或装配
   * 冗余都会这样）。**宁可把最老的原文裁掉，也不打死整轮**：预算对半收到放得下为止，最新一条永远在。
   */
  it("shrinks the configured window instead of failing when the model is smaller", async () => {
    const h = setup({ tokenBudget: 16384 });
    h.gateway.loadedContextCapacity = async () => 8192;
    for (let index = 0; index < 20; index += 1) h.seed(`old ${"x".repeat(480)}`, 1);
    h.seed("newest question", 0);
    const material = await h.source.read(readInput());
    expect(JSON.stringify(material.pending)).toContain("newest question");
    const included = material.pending?.filter((message) =>
      JSON.stringify(message).includes("old x"),
    );
    expect(included?.length ?? 0).toBeLessThan(20);
  });

  it("does not turn source invalidation or caller cancellation into optional compression fallback", async () => {
    for (const cancel of [false, true]) {
      const h = setup({ watermarkTrigger: 1 });
      const old = h.seed(`old ${"x".repeat(50)}`, 31000);
      h.seed("new fact");
      const controller = new AbortController();
      h.gateway.complete = async () => {
        if (cancel) controller.abort(new Error("caller cancelled"));
        else h.db.query("DELETE FROM qq_observation_text WHERE event_key=?").run(old);
        return '{"facts":[]}';
      };
      const work = h.source.read({ signal: controller.signal, observations: [] });
      if (cancel) await expect(work).rejects.toThrow("caller cancelled");
      else await expect(work).rejects.toMatchObject({ code: "CONTEXT_SOURCE_INVALID" });
      expect(h.diagnostics).toEqual([]);
    }
  });

  it("rejects deleted parent input before a selector child starts after an asynchronous capacity probe", async () => {
    for (const kind of ["memory", "knowledge"] as const) {
      const h = setup({ mode: kind === "memory" ? "standard" : "off" });
      h.runtime.memory_retrieval_model_name = "selector-model";
      if (kind === "memory") h.memory("candidate apples");
      else {
        const repo = new KnowledgeRepository(h.db);
        const doc = repo.importDocument({
          name: "apples",
          category_id: "default",
          original_text: "apples",
        });
        repo.replaceGrants(doc.id, doc.revision, [DEFAULT_AGENT_ID]);
      }
      const question = h.seed("apples question");
      h.gateway.loadedContextCapacity = async (model) => {
        if (model === "selector-model")
          h.db.query("DELETE FROM qq_observation_text WHERE event_key=?").run(question);
        return 65536;
      };
      await expect(h.source.read(readInput())).rejects.toMatchObject({
        code: "CONTEXT_SOURCE_INVALID",
      });
      expect(h.calls).toHaveLength(0);
      expect(h.runs.listRuns({ ownerKind: "qq_binding", ownerId: h.binding.id })).toHaveLength(0);
    }
  });

  it("folds complete batches into an overview while retaining prior facts and question provenance", async () => {
    const h = setup();
    h.gateway.loadedContextCapacity = async () => 6200;
    const questionSource = { kind: "question", id: "question", revision: "1" };
    let valid = true;
    const compressor = new ConversationCompressor({
      runtime: h.runtime,
      gateway: h.gateway,
      agentRuntime: h.agentRuntime,
      owner: { kind: "summary_test", id: "run" },
      assertSources(sources) {
        if (!valid) throw new Error("revoked");
        expect(sources).toContainEqual(questionSource);
      },
    });
    const records = Array.from({ length: 4 }, (_, index) => ({
      id: `e${index}`,
      seq: index + 1,
      speaker: index % 2 ? "assistant" : "member:42",
      text: "x".repeat(1800),
      sources: [{ kind: "event", id: `e${index}`, revision: "1" }],
    }));
    const input = {
      records,
      question: "what was agreed",
      sources: [questionSource],
      target: 1024,
      signal: new AbortController().signal,
    };
    const evidence = await compressor.summarize(input);
    expect(h.calls.length).toBeGreaterThan(1);
    expect(JSON.parse(evidence?.text ?? "{}").facts).toHaveLength(4);
    const seen = h.calls.flatMap((call) =>
      JSON.parse(call.messages[1].content).events.map((event: { id: string }) => event.id),
    );
    expect(seen).toEqual(records.map((record) => record.id));
    expect(evidence?.sources).toContainEqual(questionSource);
    const count = h.calls.length;
    await expect(compressor.summarize({ ...input, fits: () => false })).rejects.toMatchObject({
      code: "CONTEXT_SUMMARY_BUDGET",
    });
    expect(await compressor.summarize(input)).toBe(evidence);
    expect(h.calls).toHaveLength(count);
    valid = false;
    await expect(compressor.summarize(input)).rejects.toThrow("revoked");
  });
});

it("optional memory backend failure leaves raw input and a visible retrieval status", async () => {
  const h = setup({
    mode: "standard",
    modules: () => ({
      memory: {
        query: async () => {
          throw new Error("MODEL_FAILED");
        },
      },
      knowledge: { query: async () => [] },
    }),
  });
  h.seed("raw question survives");
  const material = await h.source.read(readInput());
  expect(JSON.stringify(material.pending)).toContain("raw question survives");
  expect(JSON.stringify(material.pending)).toContain("retrieval_status");
  expect(h.diagnostics).toContainEqual({
    kind: "supplemental_retrieval_failed",
    name: "memory.initial",
    code: "MODEL_FAILED",
  });
  const action = h.source.actions.find((action) => action.description.name === "memory.query")!;
  expect(
    await action.execute(
      { query: "more" },
      { owner: { kind: "test", id: "test" }, signal: new AbortController().signal },
    ),
  ).toMatchObject({ value: [] });
  expect(h.diagnostics).toContainEqual({
    kind: "supplemental_retrieval_failed",
    name: "memory.query",
    code: "MODEL_FAILED",
  });
});
