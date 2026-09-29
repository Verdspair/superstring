import { afterEach, describe, expect, it } from "bun:test";
import { createAgentRuntime } from "../../src/server/agent/agent-runtime";
import type { AgentSpec } from "../../src/server/agent/agent-specs";
import { type ActionObservation, ContextEngine } from "../../src/server/agent/context-engine";
import { ConversationCompressor } from "../../src/server/agent/conversation-compression";
import { BotCompressionQueue } from "../../src/server/channels/onebot11/background-compression";
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
    usage?: BotContextSourceOptions["usage"];
    budget?: BotContextSourceOptions["budget"];
    assertBackgroundCurrent?: () => void;
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
      assertBackgroundCurrent: input.assertBackgroundCurrent,
      usage: input.usage,
      budget: input.budget,
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
    const id = seed("memory source event", 20, peer),
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
async function compress(source: BotContextSource, signal = readInput().signal): Promise<void> {
  const job = source.takeCompressionJob();
  if (!job) return;
  try {
    await job.run(signal);
  } catch (error) {
    job.failed(error);
  }
}
/**
 * 漂移 A 的标定：在空动作源上二分出"单个目录条目"的最大可装文本长度。fit 用的就是实现自己的
 * 检查口径（cost ≤ 档上限），所以这个长度近似等于该档剩余房间，测试不必手算协议开销。
 */
async function measureJointRoom(h: ReturnType<typeof setup>): Promise<number> {
  const scratch = h.newSource();
  const fit = await scratch.actionResultFitter(
    "knowledge.query",
    { query: "calibrate" },
    new AbortController().signal,
  );
  const probe = (length: number) => ({
    status: "ok",
    items: [{ id: "k", title: "k", summary: "x".repeat(length), bodyRef: "h" }],
  });
  let lo = 0,
    hi = 1 << 20;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fit(probe(mid), [])) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
/** 联合预留夹具：目录大小可调，域预算与模型容量分别约束。 */
function jointFixture() {
  const sizes = { memory: 0, knowledge: 0 };
  const h = setup({
    tokenBudget: 16384,
    mode: "standard",
    modules: () => ({
      memory: {
        query: async (input: { projection?: string }) =>
          input.projection === "catalog" && sizes.memory > 0
            ? [
                {
                  id: "m1",
                  text: "body",
                  sources: [],
                  preview: { title: "m", summary: `M:${"m".repeat(sizes.memory)}` },
                },
              ]
            : [],
      },
      knowledge: {
        query: async (input: { projection?: string }) => {
          if (input.projection !== "catalog" || sizes.knowledge === 0) return [];
          // 让 memory 的拟合先登记：并发顺序确定，断言才稳定。
          await new Promise((resolve) => setTimeout(resolve, 5));
          return ["K1", "K2"].map((tag, index) => ({
            id: tag,
            text: "body",
            sources: [],
            preview: { title: tag, summary: `${tag}:${"k".repeat(sizes.knowledge)}:${index}` },
          }));
        },
      },
    }),
  });
  // Isolate the shared model ceiling from the independently tested domain allowance.
  h.runtime.p5_config.retrieval_presets.standard.max_tokens = 65536;
  h.gateway.loadedContextCapacity = async () => 32768;
  h.seed("question");
  return { h, sizes };
}
const catalogEntry = (id: string, summary: string) => ({
  id,
  title: id,
  summary,
  bodyRef: `ref-${id}`,
});
async function nextWithPackages(h: ReturnType<typeof setup>, source = h.source) {
  await source.read(readInput());
  await compress(source);
  return h.newSource().read(readInput());
}
/** 这一轮跑过几次水位压缩（specId 固定在压缩叶子上）。 */
const compressionRuns = (h: ReturnType<typeof setup>) =>
  h.runs
    .listRuns({ ownerKind: "qq_binding", ownerId: h.binding.id })
    .filter((run) => run.specId === "context.compress.events");
describe("shared Bot context source", () => {
  it.each(["off", "conservative", "standard", "broad", "full_catalog", "full_body"] as const)(
    "%s starts with no evidence calls or bodies and keeps queries scoped",
    async (mode) => {
      const h = setup({ mode });
      const own = h.memory("own apples"),
        foreign = h.memory("foreign pears", "40004");
      const repo = new KnowledgeRepository(h.db);
      const doc = repo.importDocument({
        name: "apples manual",
        category_id: "default",
        original_text: "knowledge body not prefetched",
      });
      repo.replaceGrants(doc.id, doc.revision, [DEFAULT_AGENT_ID]);
      h.seed("apples?");
      const material = await h.source.read(readInput());
      expect(JSON.stringify(material)).not.toContain(foreign);
      expect(JSON.stringify(material)).not.toContain("own apples");
      expect(JSON.stringify(material)).not.toContain("knowledge body not prefetched");
      expect(material.evidence ?? []).toEqual([]);
      expect(material.sources?.some((source) => source.kind === "memory")).toBe(false);
      const evaluation = await h.source.prepareEvaluation({ ...readInput(), target: null });
      expect(evaluation.sources.some((source) => source.kind === "memory")).toBe(false);
      expect(JSON.stringify(evaluation.messages)).not.toContain("own apples");
      expect(JSON.stringify(evaluation.messages)).not.toContain("knowledge body not prefetched");
      const context = new ContextEngine().render(h.spec, material, [], ["alice"]);
      const reply = await h.source.prepareGeneration(
        { kind: "generate", targetId: "alice", instructions: "answer" },
        { context, outputId: "initial", signal: readInput().signal },
      );
      expect(JSON.stringify(reply.context?.messages)).not.toContain("own apples");
      expect(JSON.stringify(reply.context?.messages)).not.toContain(
        "knowledge body not prefetched",
      );
      expect(await h.source.read(readInput())).toBe(material);
      expect(h.calls).toHaveLength(0);
      const query = h.source.actions.find((action) => action.description.name === "memory.query");
      if (mode === "off") {
        expect(
          h.source.actions.some((action) => action.description.name.startsWith("memory.")),
        ).toBe(false);
        return;
      }
      if (!query) throw new Error("missing memory query");
      const result = await query.execute(
        { query: "apples" },
        { owner: { kind: "test", id: "test" }, signal: readInput().signal },
      );
      expect(result.value).toMatchObject({ status: "ok", items: [{ id: own }] });
      expect(JSON.stringify(result)).not.toContain(foreign);
      expect(h.calls).toHaveLength(0);
      const observations = [{ id: "query", name: "memory.query", ...result }];
      await h.source.read({ ...readInput(), observations });
      h.db.query("UPDATE memory_entries SET body='revised' WHERE id=?").run(own);
      await expect(h.source.read({ ...readInput(), observations })).rejects.toMatchObject({
        code: "CONTEXT_SOURCE_INVALID",
      });
    },
  );
  it("returns memory metadata without body and reads only this run's authorized reference", async () => {
    const h = setup({ mode: "full_body" });
    const id = h.memory("private full body with details");
    h.db
      .query("UPDATE memory_entries SET name='title', summary='short preview' WHERE id=?")
      .run(id);
    h.seed("question");
    await h.source.read(readInput());
    const query = h.source.actions.find((a) => a.description.name === "memory.query");
    const read = h.source.actions.find((a) => a.description.name === "memory.read");
    if (!query || !read) throw new Error("missing evidence actions");
    const context = { owner: { kind: "test", id: "test" }, signal: readInput().signal };
    const found = await query.execute({ query: "details" }, context);
    const entry = (found.value as { items: { bodyRef: string }[] }).items[0];
    expect(found.value).toMatchObject({
      status: "ok",
      items: [{ id, title: "title", summary: "short preview" }],
    });
    expect(JSON.stringify(found.value)).not.toContain("private full body");
    const page = await read.execute({ bodyRef: entry.bodyRef, limit: 4096 }, context);
    expect(JSON.stringify(page.value)).toContain("private full body");
    const other = h.newSource().actions.find((a) => a.description.name === "memory.read");
    await expect(other?.execute({ bodyRef: entry.bodyRef }, context)).rejects.toMatchObject({
      code: "CONTEXT_INVALID_SELECTION",
    });
    h.db.query("UPDATE memory_entries SET body='corrected' WHERE id=?").run(id);
    await expect(read.execute({ bodyRef: entry.bodyRef }, context)).rejects.toMatchObject({
      code: "CONTEXT_SOURCE_INVALID",
    });
  });

  it("pages knowledge without reselection and rejects a revoked reference", async () => {
    const h = setup();
    const repo = new KnowledgeRepository(h.db);
    const doc = repo.importDocument({
      name: "manual",
      category_id: "default",
      original_text: "apples ".repeat(80),
    });
    repo.replaceGrants(doc.id, doc.revision, [DEFAULT_AGENT_ID]);
    h.seed("apples?");
    await h.source.read(readInput());
    const query = h.source.actions.find((a) => a.description.name === "knowledge.query");
    const read = h.source.actions.find((a) => a.description.name === "knowledge.read");
    if (!query || !read) throw new Error("missing evidence actions");
    const context = { owner: { kind: "test", id: "test" }, signal: readInput().signal };
    const found = await query.execute({ query: "apples" }, context);
    const entry = (found.value as { items: { bodyRef: string }[] }).items[0];
    const calls = h.calls.length;
    const first = await read.execute({ bodyRef: entry.bodyRef, limit: 32 }, context);
    const item = (first.value as { items: { text: string; nextOffset: number }[] }).items[0];
    expect([...item.text]).toHaveLength(32);
    expect(item.nextOffset).toBe(32);
    const second = await read.execute(
      { bodyRef: entry.bodyRef, offset: item.nextOffset, limit: 32 },
      context,
    );
    expect((second.value as { items: { offset: number }[] }).items[0].offset).toBe(32);
    expect(h.calls).toHaveLength(calls);
    repo.replaceGrants(doc.id, repo.detail(doc.id).revision, []);
    await expect(read.execute({ bodyRef: entry.bodyRef }, context)).rejects.toMatchObject({
      code: "CONTEXT_SOURCE_INVALID",
    });
  });

  it.each(["memory", "knowledge"] as const)(
    "%s lazy reads receive host authority, never tool-supplied owners or scopes",
    async (kind) => {
      const queries: unknown[] = [],
        reads: unknown[] = [];
      const remote = { kind: "external", id: kind, revision: "1" };
      const h = setup({
        mode: "full_body",
        modules: () => {
          const backend = {
            async query(input: unknown) {
              queries.push(input);
              return [{ id: "custom", text: "must not use eager text", sources: [remote] }];
            },
            async read(input: { offset: number; limit: number }) {
              reads.push(input);
              const text = "lazy remote body";
              const end = Math.min(input.offset + input.limit, text.length);
              return {
                text: text.slice(input.offset, end),
                offset: input.offset,
                total: text.length,
                nextOffset: end < text.length ? end : null,
              };
            },
          };
          return {
            memory: kind === "memory" ? backend : { query: async () => [] },
            knowledge: kind === "knowledge" ? backend : { query: async () => [] },
          };
        },
        resolveSource: (source) => (source.kind === "external" ? "available" : undefined),
      });
      h.seed("question");
      const material = await h.source.read(readInput());
      expect(queries).toEqual([]);
      expect(reads).toEqual([]);
      expect(JSON.stringify(material)).not.toContain("must not use eager text");
      const query = h.source.actions.find((entry) => entry.description.name === `${kind}.query`);
      const read = h.source.actions.find((entry) => entry.description.name === `${kind}.read`);
      if (!query || !read) throw new Error("missing evidence actions");
      const context = {
        owner: { kind: "test", id: "untrusted-owner" },
        signal: readInput().signal,
      };
      await expect(
        query.execute({ query: "details", scopes: null, owner: context.owner }, context),
      ).rejects.toThrow();
      expect(queries).toEqual([]);
      const result = await query.execute({ query: "details", limit: 2 }, context);
      const entry = (result.value as { items: { bodyRef: string }[] }).items[0];
      const owner = {
        kind: "qq_binding",
        id: h.binding.id,
        userId: DEFAULT_USER_ID,
        agentId: DEFAULT_AGENT_ID,
      };
      expect(queries).toHaveLength(1);
      expect(queries[0]).toMatchObject({
        owner,
        agentId: DEFAULT_AGENT_ID,
        limit: 2,
        projection: "catalog",
      });
      if (kind === "memory")
        expect(queries[0]).toMatchObject({
          scopes: [qqMemoryScopeKey(qqConversationScope(h.binding))],
        });
      expect(JSON.stringify(result.value)).not.toContain("must not use eager text");
      await expect(
        read.execute({ bodyRef: entry.bodyRef, scopes: null, owner: context.owner }, context),
      ).rejects.toThrow();
      expect(reads).toEqual([]);
      const page = await read.execute({ bodyRef: entry.bodyRef, offset: 5, limit: 6 }, context);
      expect(page.value).toMatchObject({
        status: "ok",
        items: [{ text: "remote", offset: 5, nextOffset: 11 }],
      });
      expect(reads).toHaveLength(1);
      expect(reads[0]).toMatchObject({
        owner,
        agentId: DEFAULT_AGENT_ID,
        offset: 5,
        limit: 6,
        evidence: { id: "custom" },
      });
      if (kind === "memory")
        expect(reads[0]).toMatchObject({
          scopes: [qqMemoryScopeKey(qqConversationScope(h.binding))],
        });
    },
  );

  it("uses external Evidence.text only on explicit read and rejects consumed-source revocation", async () => {
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
    expect(material.evidence ?? []).toEqual([]);
    expect(reads).toBe(0);
    const query = h.source.actions.find((entry) => entry.description.name === "knowledge.query");
    const read = h.source.actions.find((entry) => entry.description.name === "knowledge.read");
    if (!query || !read) throw new Error("missing evidence actions");
    const context = { owner: { kind: "test", id: "test" }, signal: readInput().signal };
    const result = await query.execute({ query: "external" }, context);
    const entry = (result.value as { items: { bodyRef: string }[] }).items[0];
    expect(result.sources).toContainEqual(remote);
    expect(JSON.stringify(result.value)).not.toContain("external knowledge");
    const page = await read.execute({ bodyRef: entry.bodyRef }, context);
    expect(JSON.stringify(page.value)).toContain("external knowledge");
    const observations = [{ id: "read", name: "knowledge.read", ...page }];
    await h.source.read({ ...readInput(), observations });
    expect(reads).toBe(1);
    valid = false;
    await expect(h.source.read({ ...readInput(), observations })).rejects.toMatchObject({
      code: "CONTEXT_SOURCE_INVALID",
    });
  });

  it("both tiers start without queries and inherit explicit evidence observations without reselection", async () => {
    let memoryReads = 0,
      knowledgeReads = 0;
    const h = setup({
      mode: "standard",
      decisionTier: "judgement",
      modules: () => ({
        memory: {
          query: async () => {
            memoryReads++;
            return [
              {
                id: "m1",
                text: "memory body",
                preview: { title: "memory title", summary: "memory preview" },
                sources: [],
              },
            ];
          },
        },
        knowledge: {
          query: async () => {
            knowledgeReads++;
            return [{ id: "k1", text: "knowledge body", sources: [] }];
          },
        },
      }),
    });
    h.seed("question");
    await h.source.read(readInput());
    await h.source.prepareEvaluation({ ...readInput(), target: null });
    expect([memoryReads, knowledgeReads]).toEqual([0, 0]);
    const query = h.source.actions.find((entry) => entry.description.name === "memory.query");
    const read = h.source.actions.find((entry) => entry.description.name === "memory.read");
    if (!query || !read) throw new Error("missing evidence actions");
    const action = { owner: { kind: "test", id: "test" }, signal: readInput().signal };
    const result = await query.execute({ query: "follow up" }, action);
    const entry = (result.value as { items: { bodyRef: string }[] }).items[0];
    const page = await read.execute({ bodyRef: entry.bodyRef }, action);
    const observations: ActionObservation[] = [
      { id: "query", name: "memory.query", ...result },
      { id: "read", name: "memory.read", ...page },
    ];
    const material = await h.source.read({ ...readInput(), observations });
    const context = new ContextEngine().render(h.spec, material, observations, ["alice"]);
    const reply = await h.source.prepareGeneration(
      { kind: "generate", targetId: "alice", instructions: "answer" },
      { context, outputId: "output", signal: readInput().signal },
    );
    expect(JSON.stringify(reply.context?.messages)).toContain("memory preview");
    expect(JSON.stringify(reply.context?.messages)).toContain("memory body");
    expect(JSON.stringify(reply.context?.messages)).not.toContain("knowledge body");
    const evaluation = await h.source.prepareEvaluation({ ...readInput(), target: null });
    expect(JSON.stringify(evaluation.messages)).toContain("memory body");
    h.seed("new question");
    h.source.invalidate();
    await h.source.read({ ...readInput(), observations });
    expect([memoryReads, knowledgeReads]).toEqual([1, 0]);
    expect(h.calls).toHaveLength(0);
  });

  it("撤权在查询动作里是硬失败，不是空结果（0.4.0 P2 出口）", async () => {
    // "没搜到"与"不能读"必须是两件事：查询过程中来源失效就整轮失败，
    // 绝不能返回一个空信封让模型说"没有相关资料"。
    const h = setup({
      modules: () => ({
        memory: { query: async () => [] },
        knowledge: {
          query: async () => {
            throw Object.assign(new Error("KNOWLEDGE_ACCESS_CHANGED"), {
              code: "KNOWLEDGE_ACCESS_CHANGED",
            });
          },
        },
      }),
    });
    h.seed("question");
    const action = h.source.actions.find((entry) => entry.description.name === "knowledge.query");
    if (!action) throw new Error("missing action");
    await expect(
      action.execute(
        { query: "anything" },
        { owner: { kind: "test", id: "test" }, signal: new AbortController().signal },
      ),
    ).rejects.toMatchObject({ code: "KNOWLEDGE_ACCESS_CHANGED" });
  });

  it("does not fail when unread knowledge is revoked, but retains queried grant provenance", async () => {
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
    expect(material.evidence ?? []).toEqual([]);
    expect(material.sources?.some((source) => source.kind === "knowledge_grant")).toBe(false);
    repo.replaceGrants(doc.id, repo.detail(doc.id).revision, []);
    expect(await h.source.read(readInput())).toBe(material);
    await h.source.prepareEvaluation({ ...readInput(), target: null });
    expect(h.calls).toHaveLength(0);
    repo.replaceGrants(doc.id, repo.detail(doc.id).revision, [DEFAULT_AGENT_ID]);
    const query = h.source.actions.find((action) => action.description.name === "knowledge.query");
    if (!query) throw new Error("missing knowledge query");
    const result = await query.execute(
      { query: "apples" },
      { owner: { kind: "test", id: "test" }, signal: readInput().signal },
    );
    expect(result.sources?.some((source) => source.kind === "knowledge_grant")).toBe(true);
    const observations = [{ id: "query", name: "knowledge.query", ...result }];
    await h.source.read({ ...readInput(), observations });
    repo.replaceGrants(doc.id, repo.detail(doc.id).revision, []);
    await expect(h.source.read({ ...readInput(), observations })).rejects.toMatchObject({
      code: "CONTEXT_SOURCE_INVALID",
    });
  });

  it("disabled memory and knowledge expose no read actions and never call injected backends", async () => {
    let calls = 0;
    const backend = {
      query: async () => {
        calls++;
        return [];
      },
      read: async () => {
        calls++;
        return { text: "", offset: 0, total: 0, nextOffset: null };
      },
    };
    const h = setup({ mode: "off", modules: () => ({ memory: backend, knowledge: backend }) });
    h.runtime.knowledge_read = {
      config: { enabled: false, context_budget: null, scope: "all", document_ids: [] },
      revision: 1,
      budget: 4096,
      budget_source: "global",
      global_revision: 1,
      auto_enabled: true,
    };
    const source = h.newSource();
    source.configureActions(source.actions.map((action) => action.description));
    h.seed("question");
    const material = await source.read(readInput());
    await source.prepareEvaluation({ ...readInput(), target: null });
    const context = new ContextEngine().render(h.spec, material, [], ["alice"]);
    await source.prepareGeneration(
      { kind: "generate", targetId: "alice", instructions: "answer" },
      { context, outputId: "off", signal: readInput().signal },
    );
    // 关闭时不装记忆/知识读工具；已存历史两档都装，已存摘要仅回复档装（本用例为回复档）。
    const names = source.actions.map((action) => action.description.name);
    expect(
      names.filter((name) => name.startsWith("memory.") || name.startsWith("knowledge.")),
    ).toEqual([]);
    expect(names).toContain("history.query");
    expect(names).toContain("history.read");
    expect(names).toContain("summary.query");
    expect(names).toContain("summary.read");
    expect(calls).toBe(0);
    expect(h.calls).toHaveLength(0);
  });

  it.each(["full_catalog", "full_body"] as const)(
    "legacy %s uses the stored broad budget and continues undisclosed items before the backend cursor",
    async (mode) => {
      const inputs: { cursor?: string; limit?: number; budget: number }[] = [];
      const h = setup({
        mode,
        modules: () => ({
          memory: {
            query: async (input) => {
              inputs.push(input);
              const ids = input.cursor === undefined ? ["m1", "m2", "m3"] : ["m4"];
              return {
                status: "ok",
                items: ids.map((id) => ({ id, text: `body-${id}`, sources: [] })),
                nextCursor: input.cursor === undefined ? "backend-next" : null,
              };
            },
          },
          knowledge: { query: async () => [] },
        }),
      });
      h.runtime.p5_config.retrieval_presets.broad.max_tokens = 4096;
      h.seed("question");
      await h.source.read(readInput());
      expect(inputs).toEqual([]);
      const query = h.source.actions.find((action) => action.description.name === "memory.query");
      if (!query) throw new Error("missing memory query");
      const context = { owner: { kind: "test", id: "test" }, signal: readInput().signal };
      let cursor: string | undefined;
      const ids: string[] = [];
      for (let index = 0; index < 4; index++) {
        const result = await query.execute(
          { query: "", limit: 1, ...(cursor ? { cursor } : {}) },
          context,
        );
        const page = result.value as {
          status: string;
          items: { id: string }[];
          nextCursor: string | null;
        };
        expect(page.status).toBe("ok");
        expect(page.items).toHaveLength(1);
        ids.push(page.items[0].id);
        if (index < 3) expect(typeof page.nextCursor).toBe("string");
        else expect(page.nextCursor).toBeNull();
        cursor = page.nextCursor ?? undefined;
        expect(inputs).toHaveLength(index < 3 ? 1 : 2);
      }
      expect(ids).toEqual(["m1", "m2", "m3", "m4"]);
      expect(inputs).toMatchObject([
        { limit: 1, budget: 4096 },
        { limit: 1, budget: 4096, cursor: "backend-next" },
      ]);
      expect(h.calls).toHaveLength(0);
    },
  );
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
    // 判断档不读水位包；回复档更宽的原文窗口保留其额外来源。
    expect(prepared.context?.sources.length).toBeGreaterThan(context.sources.length);
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
    const query = h.source.actions.find((action) => action.description.name === "memory.query");
    if (!query) throw new Error("missing memory query");
    const result = await query.execute(
      { query: "factual" },
      { owner: { kind: "test", id: "test" }, signal: readInput().signal },
    );
    await h.source.read({
      ...readInput(),
      observations: [
        { id: "query", name: "memory.query", ...result },
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
    expect(h.diagnostics).toEqual([]);
    const query = h.source.actions.find((action) => action.description.name === "memory.query");
    if (!query) throw new Error("missing memory query");
    const result = await query.execute(
      { query: "question" },
      { owner: { kind: "test", id: "test" }, signal: readInput().signal },
    );
    expect(result.value).toMatchObject({
      status: "unavailable",
      code: "CONTEXT_MEMORY_BUDGET",
      items: [],
    });
    expect(h.diagnostics).toMatchObject([
      {
        kind: "supplemental_retrieval_failed",
        name: "memory.query",
        code: "CONTEXT_MEMORY_BUDGET",
      },
    ]);
    expect(JSON.stringify(await h.source.read(readInput()))).toContain("question");
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
    const foreground = await source.read(readInput());
    expect(compressionRuns(h)).toHaveLength(0);
    expect(JSON.stringify(foreground.pending)).not.toContain("qq_context_packages");
    await compress(source);
    const material = await h.newSource().read(readInput());
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
    const material = await nextWithPackages(h, source);
    // 围栏是包装，不是内容。
    expect(JSON.stringify(material.pending)).toContain("qq_context_packages");
    expect(JSON.stringify(material.pending)).toContain("old fact");
    expect(compressionRuns(h)).toHaveLength(1);
  });
  it("advances same-second backlog in journal order without skipping records", async () => {
    const h = setup({ watermarkTrigger: 2 });
    for (let index = 0; index < 6; index++) h.seed(`old ${index}`, 30000);
    for (let cycle = 1; cycle <= 3; cycle++) {
      const source = h.newSource();
      await source.read(readInput());
      await compress(source);
      expect(h.orm.select().from(schema.qqConversationSummaries).get()?.throughSeq).toBe(cycle * 2);
    }
    expect(compressionRuns(h)).toHaveLength(3);
  });

  it("compresses delivered assistant text along with older member messages", async () => {
    const h = setup({ watermarkTrigger: 2 });
    h.seed("older member fact", 30001);
    const id = crypto.randomUUID();
    const at = h.db
      .query("SELECT created_at AS at FROM conversations WHERE id=?")
      .get(h.conversation.id) as { at: string };
    const seconds = Math.floor(Date.parse(at.at) / 1000) - 30000;
    h.db
      .query(
        "INSERT INTO qq_speech_log(id,account_id,conversation_kind,peer_id,agent_id,kind,spoke_at_seconds,expires_at,recorded_at) VALUES(?,?,?,?,?,?,?,?,?)",
      )
      .run(
        id,
        "10001",
        "group",
        "30003",
        DEFAULT_AGENT_ID,
        "direct_reply",
        seconds,
        "2099-01-01T00:00:00.000Z",
        at.at,
      );
    h.db
      .query(
        "INSERT INTO qq_speech_text(speech_id,body,spoke_at_seconds,expires_at,recorded_at) VALUES(?,?,?,?,?)",
      )
      .run(id, "assistant suggestion", seconds, "2099-01-01T00:00:00.000Z", at.at);
    h.journal.append({
      conversationId: h.conversation.id,
      eventKey: `speech:${id}`,
      kind: "outbound",
      source: { kind: "qq_speech", id, revision: String(seconds) },
      occurredAt: new Date(seconds * 1000).toISOString(),
    });
    await h.source.read(readInput());
    await compress(h.source);
    const events = JSON.parse(h.calls[0].messages[1].content).events as {
      speaker: string;
      text: string;
    }[];
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ speaker: "assistant" });
    expect(events[1].text).toContain("assistant suggestion");
  });

  it("includes count-trimmed messages beyond the fetched raw window", async () => {
    const h = setup({ watermarkTrigger: 2 });
    h.runtime.p5_config.recent_turns = 1;
    for (let index = 0; index < 25; index++) h.seed(`message ${index}`, 30 - index);
    await h.source.read(readInput());
    await compress(h.source);
    const row = h.orm.select().from(schema.qqConversationSummaries).get();
    expect(row?.throughSeq).toBe(0);
    expect(row?.coveredSeq).toBe(2);
  });

  it("returns a small catalog when the full memory exceeds the foreground budget", async () => {
    const h = setup({ mode: "full_body" });
    h.gateway.loadedContextCapacity = async () => 16384;
    const id = h.memory("short title");
    // A valid stored body, still much larger than this model's foreground allowance.
    h.db.query("UPDATE memory_entries SET body=? WHERE id=?").run("huge body ".repeat(1500), id);
    h.seed("question");
    await h.source.read(readInput());
    expect(h.spec.limits.inputUnits).toBeLessThan(15000);
    const query = h.source.actions.find((action) => action.description.name === "memory.query");
    const read = h.source.actions.find((action) => action.description.name === "memory.read");
    if (!query || !read) throw new Error("missing actions");
    const context = { owner: { kind: "test", id: "test" }, signal: readInput().signal };
    const found = await query.execute({ query: "title" }, context);
    const item = (found.value as { items: { bodyRef: string }[] }).items[0];
    expect(found.value).toMatchObject({ status: "ok", items: [{ id }] });
    expect(JSON.stringify(found.value)).not.toContain("huge body");
    const page = await read.execute({ bodyRef: item.bodyRef }, context);
    expect(page.value).toMatchObject({ status: "ok", items: [{ nextOffset: 2048 }] });
  });

  it("reuses stored packages without another call when nothing new rolled out", async () => {
    const h = setup({ watermarkTrigger: 2 });
    h.seed(`old ${"x".repeat(50)}`, 31000);
    h.seed(`older ${"x".repeat(50)}`, 30000);
    const first = await nextWithPackages(h);
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
    // 回复档展开只准备后台任务，本轮不等待新包。
    const context = new ContextEngine().render(h.spec, material, [], ["alice"]);
    const reply = await h.source.prepareGeneration(
      { kind: "generate", targetId: "alice", instructions: "answer" },
      { context, outputId: "output", signal: new AbortController().signal },
    );
    expect(compressionRuns(h)).toHaveLength(0);
    expect(JSON.stringify(reply.context?.messages)).not.toContain("qq_context_packages");
    await compress(h.source);
    expect(compressionRuns(h)).toHaveLength(1);
    expect(h.orm.select().from(schema.qqConversationSummaries).get()?.throughSeq).toBe(1);
    // Even an invalid stored package must remain completely untouched by judgement.
    h.db
      .query("UPDATE qq_conversation_summaries SET content='null' WHERE conversation_id=?")
      .run(h.conversation.id);
    const judgement = h.newSource();
    const next = await judgement.read(readInput());
    const evaluation = await judgement.prepareEvaluation({ ...readInput(), target: null });
    expect(JSON.stringify(next.pending)).not.toContain("qq_context_packages");
    expect(JSON.stringify(evaluation.messages)).not.toContain("old fact");
    expect(judgement.takeCompressionJob()).toBeUndefined();
    expect(compressionRuns(h)).toHaveLength(1);
    expect(h.diagnostics).toEqual([]);
  });
  it("honors the originating budget and live authority before background inference", async () => {
    for (const denied of ["budget", "authority"] as const) {
      let current = true;
      const usage = { calls: 1, inputUnits: 10 };
      const h = setup({
        watermarkTrigger: 1,
        usage,
        budget: { maxCalls: denied === "budget" ? 1 : 10 },
        assertBackgroundCurrent() {
          if (!current) throw new Error("BINDING_CHANGED");
        },
      });
      h.seed("old fact", 30000);
      await h.source.read(readInput());
      if (denied === "authority") current = false;
      await compress(h.source);
      expect(h.calls).toHaveLength(0);
      expect(h.orm.select().from(schema.qqConversationSummaries).get()).toBeUndefined();
      expect(h.diagnostics).toContainEqual({
        kind: "supplemental_summary_failed",
        code: denied === "budget" ? "AGENT_BUDGET_EXCEEDED" : "BINDING_CHANGED",
      });
    }
  });

  it("rejects a late compression instead of overwriting a newer package", async () => {
    const h = setup({ watermarkTrigger: 1 });
    h.seed("old fact", 30000);
    const second = h.newSource();
    await h.source.read(readInput());
    await second.read(readInput());
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const complete = h.gateway.complete.bind(h.gateway);
    let calls = 0;
    h.gateway.complete = async (request) => {
      if (++calls === 1) {
        started.resolve();
        await release.promise;
      }
      return complete(request);
    };
    const late = compress(h.source);
    await started.promise;
    await compress(second);
    const first = h.orm.select().from(schema.qqConversationSummaries).get();
    release.resolve();
    await late;
    expect(h.orm.select().from(schema.qqConversationSummaries).get()).toEqual(first);
    expect(h.diagnostics).toContainEqual({
      kind: "supplemental_summary_failed",
      code: "CONTEXT_SUMMARY_STALE",
    });
  });

  it("reconstructs historical package references before checking revocation", async () => {
    const h = setup({ watermarkTrigger: 1 });
    const old = h.seed("old fact", 30000);
    await h.source.read(readInput());
    await compress(h.source);
    h.db
      .query(
        "UPDATE qq_conversation_summaries SET content=json_remove(content,'$.packages[0].sources') WHERE conversation_id=?",
      )
      .run(h.conversation.id);
    expect(JSON.stringify(await h.newSource().read(readInput()))).toContain("old fact");
    h.db.query("DELETE FROM qq_observation_text WHERE event_key=?").run(old);
    const material = await h.newSource().read(readInput());
    expect(JSON.stringify(material)).not.toContain("old fact");
    expect(h.diagnostics).toContainEqual({
      kind: "supplemental_summary_failed",
      code: "CONTEXT_SOURCE_INVALID",
    });
  });

  it("does not reuse stored summary facts after their source is removed", async () => {
    const h = setup({ watermarkTrigger: 1 });
    const old = h.seed("old fact", 30000);
    await h.source.read(readInput());
    await compress(h.source);
    h.db.query("DELETE FROM qq_observation_text WHERE event_key=?").run(old);
    const material = await h.newSource().read(readInput());
    expect(JSON.stringify(material)).not.toContain("old fact");
    expect(h.diagnostics).toContainEqual({
      kind: "supplemental_summary_failed",
      code: "CONTEXT_SOURCE_INVALID",
    });
  });

  it("keeps the foreground readable while the background model is pending", async () => {
    const h = setup({ watermarkTrigger: 1 });
    h.seed("old fact", 30000);
    h.seed("new question");
    await h.source.read(readInput());
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const complete = h.gateway.complete.bind(h.gateway);
    h.gateway.complete = async (request) => {
      started.resolve();
      await release.promise;
      return complete(request);
    };
    const work = compress(h.source);
    await started.promise;
    const foreground = await h.newSource().read(readInput());
    expect(JSON.stringify(foreground)).toContain("new question");
    expect(h.orm.select().from(schema.qqConversationSummaries).get()).toBeUndefined();
    release.resolve();
    await work;
    expect(h.orm.select().from(schema.qqConversationSummaries).get()).toBeDefined();
  });

  it("serializes queued compression and cancels in-flight work before shutdown completes", async () => {
    const queue = new BotCompressionQueue();
    const started = Promise.withResolvers<void>();
    let aborted = false,
      second = false;
    queue.enqueue({
      key: "a",
      async run(signal) {
        started.resolve();
        await new Promise<void>((resolve) =>
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              resolve();
            },
            { once: true },
          ),
        );
      },
      failed() {
        throw new Error("unexpected failure");
      },
    });
    queue.enqueue({
      key: "b",
      async run() {
        second = true;
      },
      failed() {},
    });
    const work = queue.runOnce();
    expect(queue.runOnce()).toBe(work);
    await started.promise;
    await queue.stop();
    await queue.runOnce();
    expect(aborted).toBe(true);
    expect(second).toBe(false);
  });

  it("drops the oldest package once the package limit is exceeded", async () => {
    const h = setup({ watermarkTrigger: 1, packageLimit: 1 });
    h.seed("first fact", 31000);
    await h.source.read(readInput());
    await compress(h.source);
    h.seed("second fact", 30000);
    const again = h.newSource();
    await again.read(readInput());
    await compress(again);
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
    await compress(h.source);
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
    await compress(h.source);
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
    await compress(h.source);
    expect(JSON.stringify(material.pending)).toContain("recent fact");
    expect(h.diagnostics).toEqual([{ kind: "supplemental_summary_failed", code: "MODEL_TIMEOUT" }]);
    expect(h.runs.listRuns({ ownerKind: "qq_binding", ownerId: h.binding.id })[0]?.status).toBe(
      "failed",
    );
  });
  it("stores a package built only from window-trimmed messages without tripping the watermark column", async () => {
    const h = setup({ tokenBudget: 256, watermarkTrigger: 2 });
    h.seed(`old ${"x".repeat(200)}`, 3);
    h.seed(`middle ${"x".repeat(200)}`, 2);
    h.seed(`new ${"x".repeat(200)}`);
    const material = await nextWithPackages(h);
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
    await compress(h.source);
    expect(JSON.stringify(material.pending)).toContain("recent fact");
    expect(JSON.stringify(material.pending)).not.toContain("qq_context_packages");
    // 目标预算放不下就**不发布**（与网页侧同一条纪律）：本轮无包、也不落库，下一轮预算够了再压。
    expect(h.diagnostics).toMatchObject([
      { kind: "supplemental_summary_failed", code: "CONTEXT_SUMMARY_BUDGET" },
    ]);
    expect(h.orm.select().from(schema.qqConversationSummaries).get()).toBeUndefined();
  });
  it("counts prior observations before a legacy full-mode query and returns an explicit budget failure", async () => {
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
    expect((first.value as { status: string; items: unknown[] }).status).toBe("ok");
    expect((first.value as { items: unknown[] }).items.length).toBeGreaterThan(0);
    await h.source.read({
      ...readInput(),
      observations: [{ id: "large", name: "memory.query", value: "x".repeat(65000), sources: [] }],
    });
    // 已有观察耗尽父上下文时，连新目录信封也不能再装；这不是空命中或整批全量语义。
    const second = await action.execute(
      { query: "memory" },
      { owner: { kind: "test", id: "test" }, signal: new AbortController().signal },
    );
    // 0.4.0 P2：返回的是信封——"装不下"与"没有相关内容"对模型是两件事。
    expect(second.value).toEqual({
      status: "unavailable",
      code: "CONTEXT_BUDGET_EXCEEDED",
      items: [],
    });
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
    // 固定协议（含已接线的 history/summary 工具目录）＋最新一条＋下一条观测预留，实测至少需要
    // 约 8268 单位的上限（容量 10752）；原 8192 容量（上限 5836）已低于最低协议。这里取 12288
    // 留出余量，仍小于配置预算 16384，窗口裁剪照旧发生。
    h.gateway.loadedContextCapacity = async () => 12288;
    for (let index = 0; index < 40; index += 1) h.seed(`old ${"x".repeat(480)}`, 1);
    h.seed("newest question", 0);
    await h.source.read(readInput());
    // 12288 − 2048（回复档输出预留）= 10240；× (1 − 5%) = 9728——这是容量上限，步骤预算用它。
    expect(h.spec.limits.inputUnits).toBe(9728);
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
   * 漂移 A：同一批里的多个只读资料工具并发跑时，每个 fit 只看得到"上一轮已提交的 observations"。
   * 各自单独放得下、合起来超过下一步上限 → 下一步渲染时整轮 `AGENT_CONTEXT_LIMIT`。
   * 保守联合预留：把本批其它在飞结果的增量也计入检查；宁可少装，不许炸轮。
   */
  it("联合预留：同批两个查询各自能装、合起来超限时后者被拒（不再下一步炸轮）", async () => {
    const { h, sizes } = jointFixture();
    await h.source.read(readInput());
    const room = await measureJointRoom(h);
    expect(room).toBeGreaterThan(0);
    // 每条按"单独能装上限"的一半：各自装得下，两条合起来必然超限（差值是一个信封余量以上）。
    sizes.memory = Math.floor(room * 0.5);
    sizes.knowledge = Math.floor(room * 0.5);
    const signal = new AbortController().signal;
    const valueM = {
      status: "ok",
      items: [catalogEntry("m1", `M:${"m".repeat(sizes.memory)}`)],
    };
    const valueK1 = {
      status: "ok",
      items: [catalogEntry("K1", `K1:${"k".repeat(sizes.knowledge)}:0`)],
    };
    // ② 顺序单查询不回归：没有同批兄弟时，整份结果照装。
    const solo = h.newSource();
    const soloFit = await solo.actionResultFitter("knowledge.query", { query: "apples" }, signal);
    expect(soloFit(valueK1, [])).toBe(true);
    // ① 同批：memory 先登记，knowledge 与在飞结果合起来超限 → 第二个被 fit 拒。
    const joint = h.newSource();
    const memoryFit = await joint.actionResultFitter("memory.query", { query: "apples" }, signal);
    const knowledgeFit = await joint.actionResultFitter(
      "knowledge.query",
      { query: "apples" },
      signal,
    );
    expect(memoryFit(valueM, [])).toBe(true);
    expect(knowledgeFit(valueK1, [])).toBe(false);
    // 观测被 read() 替换后，上一批的预留不再重复计入：下一批的单查询不被旧在飞结果挡住。
    await joint.read(readInput());
    const clearedFit = await joint.actionResultFitter("memory.query", { query: "again" }, signal);
    expect(clearedFit(valueM, [])).toBe(true);
  });
  /**
   * 同一件事走真实运行时：模型一次 invoke 批两个查询，第二个被联合预留裁小（unavailable），
   * 下一步渲染保持在上限内——整轮以 completed 收场，而不是 `AGENT_CONTEXT_LIMIT` 失败。
   */
  it("真实运行时里同批两个查询：联合预留使后者在批内被裁，整轮完成而非上下文超限", async () => {
    const { h, sizes } = jointFixture();
    await h.source.read(readInput());
    const room = await measureJointRoom(h);
    sizes.memory = Math.floor(room * 0.5);
    sizes.knowledge = Math.floor(room * 0.5);
    const decisions = [
      JSON.stringify({
        kind: "invoke",
        calls: [
          { name: "memory.query", arguments: { query: "apples" } },
          { name: "knowledge.query", arguments: { query: "apples" } },
        ],
      }),
      JSON.stringify({
        kind: "final",
        outputs: [{ kind: "inline", targetId: "alice", text: "ok" }],
      }),
    ];
    const seen: Parameters<ModelGateway["complete"]>[0][] = [];
    h.gateway.complete = async (request) => {
      seen.push(request);
      if (request.messages[0]?.content.includes("Return exactly one JSON decision"))
        return decisions.shift() ?? '{"kind":"none"}';
      return JSON.stringify({ ids: [] });
    };
    const result = await h.agentRuntime.run(h.spec, {
      owner: {
        kind: "qq_binding",
        id: h.binding.id,
        userId: DEFAULT_USER_ID,
        agentId: DEFAULT_AGENT_ID,
      },
      context: h.source,
      actions: h.source.actions,
      authorizedTargets: ["alice", "bob"],
      outputMode: "buffered",
      signal: new AbortController().signal,
      requestId: "joint-batch",
    });
    expect(result.status).toBe("completed");
    expect(seen).toHaveLength(2);
    const observations = seen[1].messages.flatMap((message) => {
      try {
        const data = JSON.parse(message.content) as { kind?: string; value?: unknown };
        return data.kind === "action_observation"
          ? [data.value as { name: string; value: { status: string; items: { id: string }[] } }]
          : [];
      } catch {
        return [];
      }
    });
    const memoryObs = observations.find((entry) => entry.name === "memory.query");
    const knowledgeObs = observations.find((entry) => entry.name === "knowledge.query");
    expect(memoryObs?.value).toMatchObject({ status: "ok" });
    expect(memoryObs?.value.items.map((item) => item.id)).toEqual(["m1"]);
    // 第二个查询被联合预留拒掉：模型看到的是"这次取不到"，而不是塞满后下一步渲染炸轮。
    expect(knowledgeObs?.value).toMatchObject({
      status: "unavailable",
      code: "CONTEXT_BUDGET_EXCEEDED",
      items: [],
    });
  });
  /**
   * 窗口是"配置的预算"，但预算可能比这台模型能装的还大（换模型、调输出预留或装配
   * 冗余都会这样）。**宁可把最老的原文裁掉，也不打死整轮**：预算对半收到放得下为止，最新一条永远在。
   */
  it("shrinks the configured window instead of failing when the model is smaller", async () => {
    const h = setup({ tokenBudget: 16384 });
    // 同「reserves room…」用例：8192 容量已低于含 history/summary 工具目录的最低协议开销，取 12288。
    h.gateway.loadedContextCapacity = async () => 12288;
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
      await h.source.read({ signal: controller.signal, observations: [] });
      const job = h.source.takeCompressionJob();
      if (!job) throw new Error("expected compression job");
      const work = job.run(controller.signal);
      if (cancel) await expect(work).rejects.toThrow("caller cancelled");
      else await expect(work).rejects.toMatchObject({ code: "CONTEXT_SOURCE_INVALID" });
      expect(h.diagnostics).toEqual([]);
    }
  });

  it("rejects deleted parent input during an asynchronous capacity probe before any query backend starts", async () => {
    for (const kind of ["memory", "knowledge"] as const) {
      let queries = 0;
      const backend = {
        query: async () => {
          queries++;
          return [];
        },
      };
      const h = setup({
        mode: "standard",
        decisionTier: "judgement",
        modules: () => ({ memory: backend, knowledge: backend }),
      });
      const question = h.seed("apples question");
      await h.source.read(readInput());
      h.gateway.loadedContextCapacity = async (model) => {
        if (model === "reply-model")
          h.db.query("DELETE FROM qq_observation_text WHERE event_key=?").run(question);
        return 65536;
      };
      const query = h.source.actions.find((action) => action.description.name === `${kind}.query`);
      if (!query) throw new Error("missing query");
      await expect(
        query.execute(
          { query: "apples" },
          { owner: { kind: "test", id: "test" }, signal: readInput().signal },
        ),
      ).rejects.toMatchObject({ code: "CONTEXT_SOURCE_INVALID" });
      expect(queries).toBe(0);
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

it("an explicit recoverable query failure leaves raw input and visible status, cleared by a successful retry", async () => {
  let failed = true,
    queries = 0;
  const h = setup({
    mode: "standard",
    modules: () => ({
      memory: {
        query: async () => {
          queries++;
          if (failed) fail("MODEL_TIMEOUT", "temporary failure");
          return [];
        },
      },
      knowledge: { query: async () => [] },
    }),
  });
  h.seed("raw question survives");
  const material = await h.source.read(readInput());
  expect(JSON.stringify(material.pending)).toContain("raw question survives");
  expect(JSON.stringify(material.pending)).not.toContain("retrieval_status");
  expect(queries).toBe(0);
  expect(h.diagnostics).toEqual([]);
  const action = h.source.actions.find((entry) => entry.description.name === "memory.query");
  if (!action) throw new Error("missing memory query");
  const context = { owner: { kind: "test", id: "test" }, signal: readInput().signal };
  expect(await action.execute({ query: "more" }, context)).toMatchObject({
    value: { status: "unavailable", code: "MODEL_TIMEOUT", items: [] },
  });
  expect(JSON.stringify((await h.source.read(readInput())).pending)).toContain("retrieval_status");
  expect(h.diagnostics).toContainEqual({
    kind: "supplemental_retrieval_failed",
    name: "memory.query",
    code: "MODEL_TIMEOUT",
  });
  failed = false;
  expect(await action.execute({ query: "more" }, context)).toMatchObject({
    value: { status: "ok", items: [] },
  });
  expect(JSON.stringify((await h.source.read(readInput())).pending)).not.toContain(
    "retrieval_status",
  );
  expect(queries).toBe(2);
});

it.each([
  "CONTEXT_INVALID_SELECTION",
  "KNOWLEDGE_ACCESS_CHANGED",
  "CONTEXT_SOURCE_INVALID",
  "TOOL_PERMISSION_REVOKED",
  "MODEL_UNRECOGNIZED",
])("does not turn %s into a recoverable empty query", async (code) => {
  const h = setup({
    modules: () => ({
      memory: { query: async () => [] },
      knowledge: {
        query: async () => {
          throw Object.assign(new Error(code), { code });
        },
      },
    }),
  });
  h.seed("question");
  await h.source.read(readInput());
  const query = h.source.actions.find((action) => action.description.name === "knowledge.query");
  if (!query) throw new Error("missing knowledge query");
  await expect(
    query.execute(
      { query: "details" },
      { owner: { kind: "test", id: "test" }, signal: readInput().signal },
    ),
  ).rejects.toMatchObject({ code });
  expect(h.diagnostics).toEqual([]);
});

it.each(["cancel", "source"] as const)(
  "%s remains a hard failure after a pending query",
  async (failure) => {
    const started = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const h = setup({
      modules: () => ({
        memory: { query: async () => [] },
        knowledge: {
          query: async () => {
            started.resolve();
            await release.promise;
            fail("MODEL_TIMEOUT", "temporary failure");
          },
        },
      }),
    });
    const parent = h.seed("question");
    await h.source.read(readInput());
    const query = h.source.actions.find((action) => action.description.name === "knowledge.query");
    if (!query) throw new Error("missing knowledge query");
    const controller = new AbortController();
    const work = query.execute(
      { query: "details" },
      { owner: { kind: "test", id: "test" }, signal: controller.signal },
    );
    await started.promise;
    if (failure === "cancel") controller.abort(new Error("caller cancelled"));
    else h.db.query("DELETE FROM qq_observation_text WHERE event_key=?").run(parent);
    release.resolve();
    if (failure === "cancel") await expect(work).rejects.toThrow("caller cancelled");
    else await expect(work).rejects.toMatchObject({ code: "CONTEXT_SOURCE_INVALID" });
    expect(h.diagnostics).toEqual([]);
  },
);

it.each(["memory", "knowledge"] as const)(
  "%s query and body pages share a cumulative domain budget",
  async (kind) => {
    const budgets: number[] = [];
    const backend = {
      query: async (input: { budget: number }) => {
        budgets.push(input.budget);
        return [{ id: "entry", text: "x".repeat(10000), sources: [] }];
      },
    };
    const h = setup({
      mode: "full_body",
      modules: () => ({ memory: backend, knowledge: backend }),
    });
    h.runtime.p5_config.retrieval_presets.broad.max_tokens = 2400;
    h.runtime.knowledge_read = {
      config: { enabled: true, context_budget: 2400, scope: "all", document_ids: [] },
      revision: 1,
      budget: 2400,
      budget_source: "assistant",
      global_revision: 1,
      auto_enabled: true,
    };
    h.seed("question");
    const query = h.source.actions.find((action) => action.description.name === `${kind}.query`);
    const read = h.source.actions.find((action) => action.description.name === `${kind}.read`);
    if (!query || !read) throw new Error("missing evidence actions");
    const context = { owner: { kind: "test", id: "test" }, signal: readInput().signal };
    const result = await query.execute({ query: "entry" }, context);
    const entry = (result.value as { items: { bodyRef: string }[] }).items[0];
    expect(budgets).toEqual([2400]);
    const observations: ActionObservation[] = [{ id: "query", name: `${kind}.query`, ...result }];
    let offset = 0,
      exhausted = false;
    for (let index = 0; index < 12; index++) {
      const page = await read.execute({ bodyRef: entry.bodyRef, offset, limit: 4096 }, context);
      const value = page.value as {
        status: string;
        code?: string;
        items: { text: string; nextOffset: number | null }[];
      };
      if (value.status === "unavailable") {
        expect(value.code).toBe("CONTEXT_BUDGET_EXCEEDED");
        exhausted = true;
        break;
      }
      observations.push({ id: `read-${index}`, name: `${kind}.read`, ...page });
      expect(value.items[0].nextOffset).not.toBeNull();
      offset = value.items[0].nextOffset ?? offset;
      // Clearing host reservations cannot reset the factory's cumulative domain charge.
      await h.source.read({ ...readInput(), observations });
    }
    expect(offset).toBeGreaterThan(0);
    expect(offset).toBeLessThan(2400);
    expect(exhausted).toBe(true);
  },
);
