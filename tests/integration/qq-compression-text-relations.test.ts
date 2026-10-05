// 压缩输入的文字关系接线验收（T06 接力2）：水位压缩的 CompressionRecord 文字来自
// 统一事实投影（projectQqTextRelations 同 scope/now），id/seq/说话人与旧规则逐字相等，
// 水位计数/CAS 不动；存在但已过期的事实不回旧正文（整条不给正文/名字/关系）；只有真
// 缺 facts 行且原 body 仍有效的消息沿原 text 标 legacy_partial，不编双名；image category
// 在压缩输入统一 unknown 存在标记，不消费模型分类/视觉笔记。测试走真实
// BotContextSource.read 与背景压缩 job（group-summary 夹具同构），捕获 completeLeaf 的
// 真实模型输入，不用 private 方法当生产入口。

import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { createAgentRuntime } from "../../src/server/agent/agent-runtime";
import type { AgentSpec } from "../../src/server/agent/agent-specs";
import { BotContextSource } from "../../src/server/channels/onebot11/context-source";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { contextDumps } from "../../src/server/db/json-text";
import { OutboundIntentRepository } from "../../src/server/db/outbound-intent-repository";
import { insertQqBinding } from "../../src/server/db/qq-binding-repository";
import { rememberQqMemberNames } from "../../src/server/db/qq-member-repository";
import { recordQqMessageFact } from "../../src/server/db/qq-message-repository";
import { createQqScheme } from "../../src/server/db/qq-scheme-repository";
import { updateQqSettings } from "../../src/server/db/qq-settings-repository";
import { DEFAULT_AGENT_ID, ensureDefaults, getAgentRow } from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import type { ModelGateway } from "../../src/server/llm/model-gateway";
import { captureQqTask, createQqBinding } from "../../src/server/services/qq-binding-contract";
import { runtimeFromAgent } from "../../src/server/services/runtime-config";
import { QQ_COMPRESSION_DEFAULT } from "../../src/shared/contracts/qq";
import type { QqMessagePart } from "../../src/shared/contracts/qq-message";
import { closeHarnesses } from "../harness/onebot";

const handles: ReturnType<typeof openBusinessDb>[] = [];
afterEach(() => {
  closeHarnesses();
  for (const handle of handles.splice(0)) handle.close();
});

interface CapturedEvent {
  id: string;
  seq: number | null;
  speaker: string;
  text: string;
}

/** 与 bot-context-source / group-summary 同构的精简夹具：回复档 + 水位压缩。 */
function setup(input: { watermarkTrigger?: number } = {}) {
  const h = openBusinessDb();
  handles.push(h);
  ensureDefaults(h.orm, "reply-model");
  const seconds = Math.floor(Date.now() / 1000),
    now = new Date(seconds * 1000).toISOString();
  updateQqSettings(h.orm, { enabled: true, accountId: "10001", expectedRevision: 1 });
  const scheme = createQqScheme(h.orm, {
    name: "compression-text-relations",
    compression: { ...QQ_COMPRESSION_DEFAULT, watermark_trigger: input.watermarkTrigger ?? 1 },
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
  const capturedEvents: CapturedEvent[][] = [];
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
      if (data.events) {
        capturedEvents.push(data.events as CapturedEvent[]);
        return JSON.stringify({
          facts: data.events.map((event: { id: string; speaker: string }) => ({
            kind: "fact",
            speaker: event.speaker,
            text: "old fact",
            source_ids: [event.id],
          })),
        });
      }
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
  /**
   * 种一条真实入站观察 +（缺省）同键 facts 行。factParts 定制片段；noFact 跳过事实行；
   * bodyExpiresInSeconds/factExpiresInSeconds 可把正文/事实各自的到期分开拨快。
   */
  const seed = (
    text: string,
    age = 0,
    options: {
      speakerId?: string;
      messageId?: string;
      factParts?: QqMessagePart[];
      replyToMessageId?: string;
      noFact?: boolean;
      bodyExpiresInSeconds?: number;
      factExpiresInSeconds?: number;
    } = {},
  ) => {
    const id = crypto.randomUUID();
    const occurredAt = seconds - age;
    h.orm
      .insert(schema.qqEvents)
      .values({
        eventKey: id,
        accountId: "10001",
        conversationKind: "group",
        peerId: "30003",
        agentId: DEFAULT_AGENT_ID,
        messageId: options.messageId ?? id,
        occurredAtSeconds: occurredAt,
        speakerKind: "member",
        speakerId: options.speakerId ?? "20002",
        recordedAt: now,
      })
      .run();
    h.orm
      .insert(schema.qqObservationText)
      .values({
        eventKey: id,
        body: text,
        occurredAtSeconds: occurredAt,
        expiresAt: new Date((options.bodyExpiresInSeconds ?? seconds + 3600) * 1000).toISOString(),
        recordedAt: now,
      })
      .run();
    if (!options.noFact) {
      // 发送时快照按说话人给名字：20002=阿林/林某，30003=小周/周同学（与真实 intake 同构）。
      const named =
        (options.speakerId ?? "20002") === "20002"
          ? { groupCard: "阿林", personalNickname: "林某" }
          : { groupCard: "小周", personalNickname: "周同学" };
      recordQqMessageFact(
        h.orm,
        {
          eventKey: id,
          groupCard: named.groupCard,
          groupCardSource: "wire",
          personalNickname: named.personalNickname,
          personalNicknameSource: "wire",
          legacyDisplayName: null,
          nameState: "known",
          parts: options.factParts ?? [{ kind: "text", text }],
          replyToMessageId: options.replyToMessageId ?? null,
          occurredAtSeconds: occurredAt,
        },
        // 事实行默认与正文同窗；测试用 occurredAtSeconds 推到期，和真实 intake 一致。
      );
      if (options.factExpiresInSeconds !== undefined) {
        h.db
          .query("UPDATE qq_message_facts SET expires_at=? WHERE event_key=?")
          .run(new Date(options.factExpiresInSeconds * 1000).toISOString(), id);
      }
    }
    journal.ingestOneBotEvent(id, binding.id);
    return id;
  };
  return {
    ...h,
    runs,
    source: buildSource(),
    binding,
    conversation,
    diagnostics,
    seed,
    newSource: buildSource,
    capturedEvents,
    seconds,
    now,
  };
}

const readInput = () => ({ signal: new AbortController().signal, observations: [] });
async function compress(source: BotContextSource): Promise<void> {
  const job = source.takeCompressionJob();
  if (!job) return;
  try {
    await job.run(readInput().signal);
  } catch (error) {
    job.failed(error);
  }
}
const compressionRuns = (h: ReturnType<typeof setup>) =>
  h.runs
    .listRuns({ ownerKind: "qq_binding", ownerId: h.binding.id })
    .filter((run) => run.specId === "context.compress.events");
/** 旧规则下 record 的 id：原 sources tuple 的 contextDumps（与源码逐字同一算式）。 */
const legacyIdOf = (sources: readonly { kind: string; id: string; revision?: string }[]) =>
  contextDumps(sources.map((source) => [source.kind, source.id, source.revision]));
const bodySha = (body: string) => createHash("sha256").update(body).digest("hex");

describe("压缩输入的文字关系（T06 接力2）", () => {
  it("有效消息 id/seq/count 与旧规则逐条相等；水位推进位置不变", async () => {
    const h = setup({ watermarkTrigger: 2 });
    const first = h.seed("旧事实一", 30001);
    const second = h.seed("旧事实二", 30000);
    h.seed("recent question");
    const source = h.newSource();
    const material = await source.read(readInput());
    expect(JSON.stringify(material.pending)).not.toContain("旧事实");
    const job = source.takeCompressionJob();
    expect(job).toBeDefined();
    if (!job) throw new Error("expected the queued compression job");
    try {
      await job.run(readInput().signal);
    } catch (error) {
      job.failed(error);
    }
    const row = h.orm.select().from(schema.qqConversationSummaries).get();
    if (!row) throw new Error("expected summary row");
    expect(row.throughSeq).toBe(2);
    expect(row.coveredSeq).toBe(2);
    expect(h.capturedEvents).toHaveLength(1);
    const events = h.capturedEvents[0];
    if (!events) throw new Error("expected captured call");
    expect(events.map((event) => event.seq)).toEqual([1, 2]);
    expect(events.map((event) => event.id)).toEqual([
      legacyIdOf([{ kind: "qq_observation", id: first, revision: bodySha("旧事实一") }]),
      legacyIdOf([{ kind: "qq_observation", id: second, revision: bodySha("旧事实二") }]),
    ]);
  });

  it("发送时双名快照与 @/reply 关系进同一次压缩调用；当前目录名不进", async () => {
    const h = setup({ watermarkTrigger: 2 });
    const first = h.seed("先说一句", 30001, { messageId: "PLAT-101" });
    const second = h.seed("回复你", 30000, {
      speakerId: "30003",
      messageId: "PLAT-102",
      factParts: [
        { kind: "mention", qq: "20002" },
        { kind: "text", text: "回复你" },
      ],
      replyToMessageId: "PLAT-101",
    });
    void first;
    void second;
    // 当前目录另有其名：投影会给出 currentName，压缩输入必须只消费发送时快照。
    rememberQqMemberNames(h.orm, {
      scope: { accountId: "10001", conversationKind: "group", peerId: "30003" },
      userId: "20002",
      names: { groupCard: "当前目录名" },
      seenAtSeconds: h.seconds - 1,
    });
    const source = h.newSource();
    await source.read(readInput());
    await compress(source);
    expect(h.capturedEvents).toHaveLength(1);
    const events = h.capturedEvents[0];
    if (!events) throw new Error("expected captured call");
    const all = JSON.stringify(events);
    // 发送时双名快照进文字；当前目录名（currentName）不进。
    expect(all).toContain("阿林");
    expect(all).toContain("林某");
    expect(all).toContain("小周");
    expect(all).toContain("周同学");
    expect(all).not.toContain("当前目录名");
    // @ 对象与 reply 关系（平台消息 ID）进文字。
    expect(all).toContain("20002");
    expect(all).toContain("PLAT-101");
    expect(all).toContain("PLAT-102");
  });

  it("存在但已过期的事实整跳：不回旧正文、不给名字，只留最少状态", async () => {
    const h = setup({ watermarkTrigger: 1 });
    const key = h.seed("到期旧文 SECRET-BODY-991", 30000, {
      factExpiresInSeconds: h.seconds - 1,
    });
    void key;
    const source = h.newSource();
    await source.read(readInput());
    await compress(source);
    const events = h.capturedEvents[0];
    if (!events) throw Error("expected captured call");
    expect(events).toHaveLength(1);
    const event = events[0];
    if (!event) throw new Error("expected one event");
    // 说话人身份按原规则保留（水位计数与说话人逐字不变），但文字里没有旧正文与名字。
    expect(event.speaker).toBe("20002");
    expect(event.text).toBe(contextDumps({ completeness: "unavailable" }));
    expect(event.text).not.toContain("SECRET-BODY-991");
    expect(event.text).not.toContain("阿林");
  });

  it("正文被改写而片段对不上：unavailable 不供任何私有正文", async () => {
    const h = setup({ watermarkTrigger: 1 });
    h.seed("改写后的正文 REWRITTEN-BODY-77", 30000, {
      factParts: [{ kind: "text", text: "原始片段 ORIGINAL-PARTS-77" }],
    });
    const source = h.newSource();
    await source.read(readInput());
    await compress(source);
    const events = h.capturedEvents[0];
    if (!events) throw new Error("expected captured call");
    const all = JSON.stringify(events);
    expect(all).not.toContain("REWRITTEN-BODY-77");
    expect(all).not.toContain("ORIGINAL-PARTS-77");
    expect(all).not.toContain("阿林");
    expect(all).toContain("unavailable");
  });

  it("真缺 facts 行且原 body 有效的旧消息沿原 text 标 legacy_partial，不编双名", async () => {
    const h = setup({ watermarkTrigger: 1 });
    h.seed("无事实行的旧话 LEGACY-PLAIN-BODY", 30000, { noFact: true });
    const source = h.newSource();
    await source.read(readInput());
    await compress(source);
    const events = h.capturedEvents[0];
    if (!events) throw new Error("expected captured call");
    const all = JSON.stringify(events);
    expect(all).toContain("LEGACY-PLAIN-BODY");
    expect(all).toContain("legacy_partial");
    expect(all).not.toContain("阿林");
    expect(all).not.toContain("林某");
  });

  it("facts 行在 call 期间到期：压缩 job 按来源复验拒绝，不落包", async () => {
    const h = setup({ watermarkTrigger: 2 });
    h.seed("旧事实一", 30001);
    h.seed("旧事实二", 30000);
    const source = h.newSource();
    await source.read(readInput());
    const job = source.takeCompressionJob();
    if (!job) throw new Error("expected the queued compression job");
    // 两条事实行都在读取之后、任务开跑之前到期：合并进 sources 的 fact 引用必须被复验拦下。
    // job.run 的失败走 failed()（真实队列同路径），诊断带码。
    h.db
      .query("UPDATE qq_message_facts SET expires_at=? WHERE 1")
      .run(new Date((h.seconds - 1) * 1000).toISOString());
    try {
      await job.run(readInput().signal);
    } catch (error) {
      job.failed(error);
    }
    expect(compressionRuns(h)).toHaveLength(0);
    expect(h.orm.select().from(schema.qqConversationSummaries).get()).toBeUndefined();
    expect(h.diagnostics).toMatchObject([
      { kind: "supplemental_summary_failed", code: "CONTEXT_SOURCE_INVALID" },
    ]);
  });

  it("ownerScope 定位失败（scope=null）的入站消息 fail closed：不回退 legacy 正文", async () => {
    const h = setup({ watermarkTrigger: 1 });
    h.seed("定位失败的正文 SCOPE-BROKEN-42", 30000);
    // 最小破坏（等效使 ownerScope 对该 conversation 判 null，复审 §4 的"宿主对已关闭
    // 会话跑轮次"）：把本会话行拨成已关闭。ownerScope 只接受 closed_at IS NULL 的活会话
    // （qq-media-sources.ts），于是 compressionRecords 判 scope=null；而绑定行、journal
    // 时间线、facts 行、qq_observation 复验与摘要读写都不依赖 closed_at，宿主
    // assertCurrent 在本夹具是空实现——不会更早拦下，破坏点只剩这一条分类分支。
    // 时序必须在 read 之前：压缩记录在 read 内冻结；若在 read 后、run 前破坏，冻结记录里
    // 的 qq_message_fact 引用会被 job 的来源复验以 CONTEXT_SOURCE_INVALID 整单拒绝
    // （那种时序已由来源复验收紧覆盖，本条负测的是 read 时的分支分类）。
    h.db
      .query("UPDATE conversations SET closed_at=? WHERE id=?")
      .run(new Date().toISOString(), h.conversation.id);
    const source = h.newSource();
    await source.read(readInput());
    await compress(source);
    const events = h.capturedEvents[0];
    if (!events) throw new Error("expected captured call");
    const all = JSON.stringify(events);
    expect(events).toHaveLength(1);
    // 无法定位 scope 与"事实行存在但投影整跳"同判 unavailable：不回退正文、不给名字。
    expect(events[0]?.text).toBe(contextDumps({ completeness: "unavailable" }));
    expect(all).not.toContain("SCOPE-BROKEN-42");
    expect(all).not.toContain("阿林");
    expect(all).not.toContain("林某");
  });

  it("image category 在压缩输入统一 unknown 存在标记；模型分类/视觉笔记不进", async () => {
    const h = setup({ watermarkTrigger: 1 });
    h.seed("看图说话 IMAGE-BODY-51", 30000, {
      // 合成塞入非 unknown 分类（真实 intake 恒为 unknown）：压缩输入必须归一成 unknown，
      // 证明它只做存在标记、不 join 任何分类来源。
      factParts: [
        { kind: "image", mediaId: "img-cat-1", category: "expression" },
        { kind: "text", text: "看图说话 IMAGE-BODY-51" },
      ],
    });
    const source = h.newSource();
    await source.read(readInput());
    await compress(source);
    const events = h.capturedEvents[0];
    if (!events) throw new Error("expected captured call");
    const all = JSON.stringify(events);
    expect(all).toContain("img-cat-1");
    expect(all).toContain("IMAGE-BODY-51");
    expect(all).toContain("unknown");
    expect(all).not.toContain("expression");
    expect(all).not.toContain("mediaNotes");
  });
});
