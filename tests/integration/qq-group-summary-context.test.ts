// 本群「历史摘要」能力（ADR0019 §13.3）的上下文边界验收：停用后已存包不得装机、新压缩不得排队，
// 原文窗口照旧；装入材料的包附当前纪元的能力引用，停用或纪元前进后连缓存的视图一起失效。
// 真实宿主一侧验收装配行为（夹具不接后台队列），独立构造一侧验收来源复验链不再依赖外部解析器。

import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { createAgentRuntime } from "../../src/server/agent/agent-runtime";
import type { AgentSpec } from "../../src/server/agent/agent-specs";
import { type ActionObservation, ContextEngine } from "../../src/server/agent/context-engine";
import type { ModelPort } from "../../src/server/agent/model-port";
import { BotContextSource } from "../../src/server/channels/onebot11/context-source";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { OutboundIntentRepository } from "../../src/server/db/outbound-intent-repository";
import { insertQqBinding, readQqBinding } from "../../src/server/db/qq-binding-repository";
import {
  readQqGroupAgentConfig,
  updateQqGroupConfig,
} from "../../src/server/db/qq-group-config-repository";
import { createQqScheme, readQqScheme } from "../../src/server/db/qq-scheme-repository";
import { updateQqSettings } from "../../src/server/db/qq-settings-repository";
import { saveQqConversationSummary } from "../../src/server/db/qq-summary-repository";
import {
  DEFAULT_AGENT_ID,
  DEFAULT_USER_ID,
  ensureDefaults,
  getAgentRow,
  type Orm,
} from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import type { ModelGateway } from "../../src/server/llm/model-gateway";
import { QqGroupCapabilityGuard } from "../../src/server/permissions/qq-group-capabilities";
import { captureQqTask, createQqBinding } from "../../src/server/services/qq-binding-contract";
import { runtimeFromAgent } from "../../src/server/services/runtime-config";
import type { RunOwner } from "../../src/shared/contracts/agent-run";
import type { SourceRef } from "../../src/shared/contracts/evidence";
import { QQ_COMPRESSION_DEFAULT } from "../../src/shared/contracts/qq";
import type {
  QqGroupCapability,
  QqGroupSchemeOverrides,
} from "../../src/shared/contracts/qq-group-config";
import { decideGenerate, say } from "../harness/model";
import { closeHarnesses, createOneBotHarness } from "../harness/onebot";

const handles: ReturnType<typeof openBusinessDb>[] = [];
afterEach(() => {
  closeHarnesses();
  for (const handle of handles.splice(0)) handle.close();
});

/** 保存本群配置（整份提交的比较交换）：只改传进来的那一组，其余沿用当前值。 */
function setGroupConfig(
  orm: Orm,
  bindingId: string,
  change: { capabilities?: QqGroupCapability[]; overrides?: QqGroupSchemeOverrides },
) {
  const binding = readQqBinding(orm, bindingId);
  if (!binding) throw new Error("missing binding");
  const scheme = readQqScheme(orm, binding.schemeId);
  if (!scheme) throw new Error("missing scheme");
  const current = readQqGroupAgentConfig(orm, binding);
  return updateQqGroupConfig(orm, {
    bindingId,
    payload: {
      agent_id: binding.agentId,
      expected_binding_revision: binding.revision,
      expected_scheme_revision: scheme.revision,
      expected_revision: current.revision,
      overrides: { ...current.overrides, ...change.overrides },
      disabled_capabilities: change.capabilities ?? current.disabled_capabilities,
    },
  });
}

/** 与 bot-context-source 同构的精简夹具：回复档 + 水位压缩，默认不接检索模块。 */
function setup(input: { watermarkTrigger: number }) {
  const h = openBusinessDb();
  handles.push(h);
  ensureDefaults(h.orm, "reply-model");
  const seconds = Math.floor(Date.now() / 1000),
    now = new Date(seconds * 1000).toISOString();
  updateQqSettings(h.orm, { enabled: true, accountId: "10001", expectedRevision: 1 });
  const scheme = createQqScheme(h.orm, {
    name: "summary-context",
    compression: { ...QQ_COMPRESSION_DEFAULT, watermark_trigger: input.watermarkTrigger },
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
  runtime.p5_config.retrieval_mode = "off";
  const journal = new ConversationEventRepository(h.db),
    outbox = new OutboundIntentRepository(h.db);
  const conversation = journal.ensureOneBot(binding.id);
  if (!conversation) throw new Error("conversation");
  const gateway: ModelGateway = {
    config: { baseUrl: "http://unused.invalid", model: "reply-model", timeoutSeconds: 1 },
    listModels: async () => [],
    probeModelLoaded: async () => true,
    loadedContextCapacity: async () => 65536,
    async complete(request) {
      // 网关契约的 wire messages 自 preparedFrom 起可选（钩子路径不传它）。本夹具是无钩子
      // 的纯文字调用：wire 消息必到，缺了就当场失败，不静默跳过断言。
      const messages = request.messages;
      if (messages === undefined) throw new Error("wire messages expected in text fixture");
      const firstRaw = messages[1].content;
      if (typeof firstRaw !== "string") throw new Error("text content expected");
      const data = JSON.parse(firstRaw);
      if (data.events)
        return JSON.stringify({
          facts: data.events.map((event: { id: string; speaker: string }) => ({
            kind: "fact",
            speaker: event.speaker,
            text: "old fact",
            source_ids: [event.id],
          })),
        });
      return JSON.stringify({ ids: [] });
    },
    async *streamChat() {
      yield "unused";
    },
  };
  const runs = new AgentRunRepository(h.db),
    agentRuntime = createAgentRuntime({ gateway, repository: runs });
  const spec: AgentSpec = {
    id: "test.bot",
    model: "reply-model",
    context: "conversation",
    instructions: "respond concisely",
    availableActions: [],
    limits: { steps: 16 },
  };
  const diagnostics: unknown[] = [];
  /** 一轮一个实例：跨轮复用只允许走存储，缓存视图的失效必须重新读。 */
  const buildSource = () =>
    new BotContextSource({
      ...h,
      gateway,
      agentRuntime,
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
      onDiagnostic: (event) => diagnostics.push(event),
    });
  const seed = (text: string, age = 0) => {
    const id = crypto.randomUUID();
    h.orm
      .insert(schema.qqEvents)
      .values({
        eventKey: id,
        accountId: "10001",
        conversationKind: "group",
        peerId: "30003",
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
    journal.ingestOneBotEvent(id, binding.id);
    return id;
  };
  return {
    ...h,
    runs,
    source: buildSource(),
    spec,
    binding,
    conversation,
    diagnostics,
    seed,
    now,
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
const ownerOf = (bindingId: string): RunOwner => ({
  kind: "qq_binding",
  id: bindingId,
  userId: DEFAULT_USER_ID,
  agentId: DEFAULT_AGENT_ID,
});
const capRefs = (sources: readonly SourceRef[] | undefined) =>
  (sources ?? []).filter((source) => source.kind === "qq_group_capability");
/** 这一轮跑过几次水位压缩（specId 固定在压缩叶子上）。 */
const compressionRuns = (h: ReturnType<typeof setup>) =>
  h.runs
    .listRuns({ ownerKind: "qq_binding", ownerId: h.binding.id })
    .filter((run) => run.specId === "context.compress.events");

describe("本群历史摘要的上下文边界", () => {
  it("初始停用：已存包不进入材料、不排新压缩，原文窗口照旧", async () => {
    const h = setup({ watermarkTrigger: 1 });
    const covered = h.seed("old covered fact", 31001);
    h.seed("old pending fact", 31000);
    h.seed("recent question", 0);
    // 已存包：正文由真实观察行背书；水位停在第一条，第二条与"若启用会新压的那条"同批。
    const saved = saveQqConversationSummary(h.orm, {
      conversationId: h.conversation.id,
      agentId: DEFAULT_AGENT_ID,
      throughSeq: 1,
      coveredSeq: 1,
      packages: [
        {
          facts: [
            {
              kind: "fact",
              speaker: "member:20002",
              text: "STALE-PACKAGE-MARKER-7391",
              source_ids: [],
            },
          ],
          fromSeq: 1,
          throughSeq: 1,
          fromSeconds: 0,
          throughSeconds: 0,
          at: h.now,
          sources: [
            {
              kind: "qq_observation",
              id: covered,
              revision: createHash("sha256").update("old covered fact").digest("hex"),
            },
          ],
        },
      ],
      modelName: "fixture",
      configSnapshot: {},
      estimatedTokens: 16,
      at: h.now,
      expected: null,
      assertCurrent() {},
    });
    expect(saved).toBe(true);
    setGroupConfig(h.orm, h.binding.id, { capabilities: ["history_summary"] });
    const source = h.newSource();
    const material = await source.read(readInput());
    const pending = JSON.stringify(material.pending);
    expect(pending).not.toContain("STALE-PACKAGE-MARKER-7391");
    expect(pending).not.toContain("old covered fact");
    expect(pending).not.toContain("old pending fact");
    expect(pending).toContain("recent question");
    expect(capRefs(material.sources)).toEqual([]);
    expect(source.takeCompressionJob()).toBeUndefined();
    expect(compressionRuns(h)).toHaveLength(0);
    // 已存行原样保留（只是不再被这一群读到）。
    expect(h.orm.select().from(schema.qqConversationSummaries).get()?.content).toContain(
      "STALE-PACKAGE-MARKER-7391",
    );
  });

  it("装入已存包的轮次附当前纪元引用；只排队未装包的轮次不附", async () => {
    const h = setup({ watermarkTrigger: 1 });
    h.seed("old fact", 31000);
    h.seed("recent question", 0);
    // 只排队：本轮没有已存包可装，引用不得凭空出现（否则停用会打死这一轮）。
    const queued = h.newSource();
    const first = await queued.read(readInput());
    expect(JSON.stringify(first.pending)).not.toContain("qq_context_packages");
    expect(capRefs(first.sources)).toEqual([]);
    const job = queued.takeCompressionJob();
    if (!job) throw new Error("expected the queued compression job");
    await job.run(readInput().signal);
    expect(compressionRuns(h)).toHaveLength(1);
    // 装入包：能力引用按签发时刻的纪元进材料，且必须能被 guard 复验为可用。
    const shipped = await h.newSource().read(readInput());
    expect(JSON.stringify(shipped.pending)).toContain("qq_context_packages");
    expect(JSON.stringify(shipped.pending)).toContain("old fact");
    const refs = capRefs(shipped.sources);
    expect(refs).toHaveLength(1);
    const ref = refs[0];
    if (!ref) throw new Error("missing capability source");
    expect(ref.id).toContain("history_summary");
    expect(new QqGroupCapabilityGuard(h.orm).sourceAccess(ref, ownerOf(h.binding.id))).toBe(
      "available",
    );
  });

  it("停用后缓存的包视图整体失效、跨停用-恢复不复活；恢复后的新轮次重新可读", async () => {
    const h = setup({ watermarkTrigger: 1 });
    h.seed("old fact", 31000);
    h.seed("recent question", 0);
    await h.source.read(readInput());
    await compress(h.source);
    expect(compressionRuns(h)).toHaveLength(1);
    const source = h.newSource();
    const material = await source.read(readInput());
    expect(JSON.stringify(material.pending)).toContain("old fact");
    expect(capRefs(material.sources)).toHaveLength(1);
    setGroupConfig(h.orm, h.binding.id, { capabilities: ["history_summary"] });
    // 缓存视图的渲染与重读都在能力边界上结账：不泄旧包正文。
    const context = new ContextEngine().render(h.spec, material, [], ["alice"]);
    await expect(
      source.prepareGeneration(
        { kind: "generate", targetId: "alice", instructions: "answer" },
        { context, outputId: "draft", signal: readInput().signal },
      ),
    ).rejects.toMatchObject({ code: "QQ_GROUP_CAPABILITY_DISABLED" });
    await expect(source.read(readInput())).rejects.toMatchObject({
      code: "QQ_GROUP_CAPABILITY_DISABLED",
    });
    // 停用→恢复＝纪元前进：旧引用永久失效，缓存不得复活。
    setGroupConfig(h.orm, h.binding.id, { capabilities: [] });
    await expect(source.read(readInput())).rejects.toMatchObject({
      code: "QQ_GROUP_CAPABILITY_DISABLED",
    });
    const revived = await h.newSource().read(readInput());
    expect(JSON.stringify(revived.pending)).toContain("old fact");
    expect(capRefs(revived.sources)).toHaveLength(1);
  });

  it("无关能力（记忆读取）停用不失效摘要；原文来源仍按读作用域复验", async () => {
    const h = setup({ watermarkTrigger: 1 });
    const covered = h.seed("old fact", 31000);
    h.seed("recent question", 0);
    await h.source.read(readInput());
    await compress(h.source);
    const source = h.newSource();
    const material = await source.read(readInput());
    expect(JSON.stringify(material.pending)).toContain("old fact");
    setGroupConfig(h.orm, h.binding.id, { capabilities: ["memory_read"] });
    const again = await source.read(readInput());
    expect(JSON.stringify(again.pending)).toContain("old fact");
    expect(capRefs(again.sources)).toHaveLength(1);
    // 摘要之外的真实来源照旧复验：正文行一旦消失，缓存视图不能继续。
    h.db.query("DELETE FROM qq_observation_text WHERE event_key=?").run(covered);
    await expect(source.read(readInput())).rejects.toMatchObject({
      code: "CONTEXT_SOURCE_INVALID",
    });
  });

  it("独立构造（无外部解析器）下 guard 签发的引用通过复验；停用后引用回收、读取即拒", async () => {
    const h = setup({ watermarkTrigger: 1 });
    h.seed("question");
    const owner = ownerOf(h.binding.id);
    const guard = new QqGroupCapabilityGuard(h.orm);
    const issued = guard.sources(owner, "history_summary");
    expect(issued).toHaveLength(1);
    const ref = issued[0];
    if (!ref) throw new Error("missing capability source");
    const observation: ActionObservation = {
      id: "issued",
      name: "summary.query",
      value: { status: "ok", items: [] },
      sources: [ref],
    };
    // 没有 resolveSource 也必须认这个引用（否则所有本群结果都不可用）。
    await h.newSource().read({ signal: readInput().signal, observations: [observation] });
    setGroupConfig(h.orm, h.binding.id, { capabilities: ["history_summary"] });
    expect(guard.sources(owner, "history_summary")).toEqual([]);
    await expect(
      h.newSource().read({ signal: readInput().signal, observations: [observation] }),
    ).rejects.toMatchObject({ code: "QQ_GROUP_CAPABILITY_DISABLED" });
  });
});

describe("真实宿主：停用历史摘要后已存包不再进入上下文", () => {
  it("启用轮次装入已存包；停用后同群新轮次既不装包也不失败，原文窗口照旧", async () => {
    const h = createOneBotHarness({ model: [] });
    const scripted = h.model;
    if (!scripted) throw new Error("expected the scripted model");
    // 脚本记录截断到 4000 字符：包正文断言必须用完整请求（端口外再包一层，重启后生效）。
    const requests: string[] = [];
    const fullText = (messages: Parameters<ModelPort["complete"]>[0]["messages"]) =>
      messages
        .flatMap((message) =>
          message.content.flatMap((part) => (part.kind === "text" ? [part.text] : [])),
        )
        .join("\n");
    const complete = scripted.port.complete;
    scripted.port.complete = async (request) => {
      requests.push(fullText(request.messages));
      return complete(request);
    };
    const streamText = scripted.port.streamText;
    scripted.port.streamText = async function* (request) {
      requests.push(fullText(request.messages));
      yield* streamText(request);
    };
    h.restart();

    h.receive({ id: "101", speaker: "20002", addressed: true, text: "旧消息原文" });
    const row = h.db
      .query(
        "SELECT e.event_key AS key, t.body AS body FROM qq_events e JOIN qq_observation_text t ON t.event_key=e.event_key WHERE e.message_id=?",
      )
      .get("101") as { key: string; body: string } | null;
    if (!row) throw new Error("missing observation row");
    // 夹具的观察行按收到时刻到期；摘要要读它就得处在读作用域的有效期内。
    h.db
      .query("UPDATE qq_observation_text SET expires_at=? WHERE event_key=?")
      .run(new Date(Date.parse(h.now()) + 3_600_000).toISOString(), row.key);
    const saved = saveQqConversationSummary(h.orm, {
      conversationId: h.conversationId,
      agentId: DEFAULT_AGENT_ID,
      throughSeq: 1,
      coveredSeq: 1,
      packages: [
        {
          facts: [
            {
              kind: "fact",
              speaker: "member:20002",
              text: "STALE-PACKAGE-MARKER-7391",
              source_ids: [],
            },
          ],
          fromSeq: 1,
          throughSeq: 1,
          fromSeconds: 0,
          throughSeconds: 0,
          at: h.now(),
          sources: [
            {
              kind: "qq_observation",
              id: row.key,
              revision: createHash("sha256").update(row.body).digest("hex"),
            },
          ],
        },
      ],
      modelName: "fixture",
      configSnapshot: {},
      estimatedTokens: 16,
      at: h.now(),
      expected: null,
      assertCurrent() {},
    });
    expect(saved).toBe(true);

    scripted.push([decideGenerate("20002"), say("收到")]);
    h.receive({ id: "102", speaker: "20002", addressed: true, text: "当前问题" });
    h.advance(3);
    expect(await h.activate("direct_reply")).not.toBeNull();
    await h.deliver();
    const firstRound = requests.splice(0);
    expect(firstRound.some((text) => text.includes("STALE-PACKAGE-MARKER-7391"))).toBe(true);
    expect(firstRound.some((text) => text.includes("旧消息原文"))).toBe(true);

    setGroupConfig(h.orm, h.bindingId, { capabilities: ["history_summary"] });
    scripted.push([decideGenerate("20002"), say("收到2")]);
    h.receive({ id: "103", speaker: "20002", addressed: true, text: "停用后的问题" });
    h.advance(3);
    expect(await h.activate("direct_reply")).not.toBeNull();
    const secondRound = requests.splice(0);
    expect(secondRound.length).toBeGreaterThan(0);
    expect(secondRound.some((text) => text.includes("STALE-PACKAGE-MARKER-7391"))).toBe(false);
    expect(secondRound.some((text) => text.includes("停用后的问题"))).toBe(true);
    expect(secondRound.some((text) => text.includes("旧消息原文"))).toBe(true);
    expect(h.db.query("SELECT count(*) AS n FROM qq_conversation_summaries").get()).toEqual({
      n: 1,
    });
    const stored = h.db.query("SELECT content FROM qq_conversation_summaries").get() as {
      content: string;
    };
    expect(stored.content).toContain("STALE-PACKAGE-MARKER-7391");
  });
});
