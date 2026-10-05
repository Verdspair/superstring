// T15 P7 补块：水位压缩与记忆链路。
//
// 覆盖矩阵 id54/55/56/57/58 中原 qq-message-multimodal-e2e.test.ts 未真实执行到的子面
// （依据 resume-t15-matrix-review.md Panel E 与 §4 P7 分区），全部走真实链路：
//   * memory 侧：真实 intake 落媒体行 → readQqMediaTaskOnce（真实 typed note 落库）→
//     freezeQqFactScope/loadQqFactInputs（真实 restyleRecord）→ MemoryService worker
//     （真实 loadInputs/generate/publish）→ 发布来源核验（qq_memory_sources/memory_entries）。
//   * 水位侧：真实 OneBot wire→宿主→BotContextSource；判断档 before/after 行 hash 强负；
//     回复档装配正测。真实后台压缩执行需要 harness 暴露 compression job/队列接口
//     （bot-host enqueueCompression 未接线到夹具）——该正半按未执行如实记录，不 skip 冒充。
//   * 跨源侧：同一业务库内造两个 scope（第二个 binding+conversation 经真实 journal），行
//     确实存在的前提下断跨 owner/scope 拒 + 合法 pair available + owner-first fail closed 顺序。
//   * wire 侧：真实 modelPort 捕获（scripted receivedMessages 深拷贝）断 role 顺序/有序片段/
//     tools/schema 逐字形状；持久面扩扫（run/context/event/context_snapshots/出站请求/
//     qq_send_log/qq_outbound_message_facts）；HTTP 边界字节级 wire 捕获（toGatewayMessages
//     data URL）需 harness 网关捕获模式接口，本批用 toGatewayMessages 受控 resolver 单独面补充。
//
// 红线：业务测试不 import artifacts/（本文件自包含）；不建第二 harness/第二模型链；不读真实
// data/密钥；不改产品代码与原 e2e 文件/harness。

import { afterEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { sourceAccess } from "../../src/server/agent/context-access";
import { projectQqMessageFacts } from "../../src/server/channels/onebot11/message-projection";
import { enqueue, entries, policy } from "../../src/server/db/memory-repository";
import {
  linkMediaAssetSource,
  recordMediaAsset,
} from "../../src/server/db/qq-media-asset-repository";
import { recordMediaSegment } from "../../src/server/db/qq-media-repository";
import { saveQqConversationSummary } from "../../src/server/db/qq-summary-repository";
import { DEFAULT_AGENT_ID, DEFAULT_USER_ID, nowIso } from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { type ChatContentPart, toGatewayMessages } from "../../src/server/llm/chat-content";
import type { ModelGateway } from "../../src/server/llm/model-gateway";
import { MemoryService } from "../../src/server/services/memory-service";
import { encodeQqFramePng } from "../../src/server/services/qq-animation-frames";
import {
  qqConversationScopeOf,
  qqMemoryScopeKey,
} from "../../src/server/services/qq-binding-contract";
import { readQqMediaTaskOnce } from "../../src/server/services/qq-media-reader";
import { createQqMediaSourceRef } from "../../src/server/services/qq-media-sources";
import {
  freezeQqFactScope,
  loadQqFactInputs,
  verifyQqFactInputs,
} from "../../src/server/services/qq-memory-fact-input";
import { projectQqTextRelations } from "../../src/server/services/qq-text-relations";
import { decideGenerate, say, scoreOf } from "../harness/model";
import { closeHarnesses, createOneBotHarness, type OneBotHarness } from "../harness/onebot";

afterEach(() => {
  closeHarnesses();
});

// ---- 共享小工具（仅本文件内） ------------------------------------------------------

const png = () => encodeQqFramePng(new Uint8Array(8 * 8 * 4).fill(64), 8, 8);

/** 某次调用输入的全部文本拼接。 */
const callText = (h: OneBotHarness, index: number): string =>
  (h.model?.receivedMessages[index]?.messages ?? [])
    .flatMap((message) =>
      message.content.flatMap((part) => (part.kind === "text" ? [part.text] : [])),
    )
    .join("\n");

const phases = (h: OneBotHarness): string[] => (h.model?.calls ?? []).map((call) => call.phase);

/** 播种一份水位包（与原 e2e seedSummary 同构；来源是真实 knowledge 引用）。 */
function seedSummary(h: OneBotHarness, marker: string): void {
  const documentId = h.knowledge("水位包占位", "占位正文");
  const version = (
    h.db
      .query("SELECT content_version AS v FROM knowledge_documents WHERE id=?")
      .get(documentId) as {
      v: number;
    }
  ).v;
  saveQqConversationSummary(h.orm, {
    conversationId: h.conversationId,
    agentId: DEFAULT_AGENT_ID,
    throughSeq: 0,
    coveredSeq: 0,
    packages: [
      {
        facts: [
          {
            kind: "fact",
            speaker: "20002",
            text: marker,
            source_ids: [JSON.stringify([["knowledge_document", documentId, String(version)]])],
          },
        ],
        fromSeq: 0,
        throughSeq: 0,
        fromSeconds: 0,
        throughSeconds: 0,
        at: h.now(),
      },
    ],
    modelName: "stub",
    configSnapshot: {},
    estimatedTokens: 8,
    at: h.now(),
    expected: null,
    assertCurrent: () => {},
  });
}

/** 水位行快照（before/after 行 hash 强负用）：完整行 JSON，任何推进/包变化都会改变它。 */
const summaryRowJson = (h: OneBotHarness): string | null =>
  (h.db
    .query("SELECT * FROM qq_conversation_summaries WHERE conversation_id=?")
    .get(h.conversationId) as Record<string, unknown> | null) === null
    ? null
    : JSON.stringify(
        h.db
          .query("SELECT * FROM qq_conversation_summaries WHERE conversation_id=?")
          .get(h.conversationId),
      );

/** 真实 intake 之后的 event key（经 message_id 定位，不猜）。 */
const eventKeyOfMessage = (h: OneBotHarness, messageId: string): string => {
  const row = h.db
    .query("SELECT event_key AS k FROM qq_events WHERE message_id=?")
    .get(messageId) as {
    k: string;
  } | null;
  if (!row) throw new Error(`event key missing for message ${messageId}`);
  return row.k;
};

/** 本 harness 记忆 scope key（与 harness.memory() 内部同源）。 */
const memoryScopeKeyOf = (_h: OneBotHarness): string =>
  qqMemoryScopeKey(
    qqConversationScopeOf({
      accountId: "90001",
      conversationKind: "group",
      peerId: "30003",
      agentId: DEFAULT_AGENT_ID,
    }),
  );

/** 给真实媒体行补资产+来源 link（与原 e2e L_56 同构）。 */
function attachAsset(h: OneBotHarness, mediaId: string): { bytes: Uint8Array } {
  const bytes = png();
  const future = new Date(Date.parse(h.now()) + 14 * 24 * 60 * 60 * 1000).toISOString();
  const scope = {
    accountId: "90001",
    conversationKind: "group" as const,
    peerId: "30003",
    agentId: DEFAULT_AGENT_ID,
  };
  const { asset } = recordMediaAsset(h.orm, {
    scope,
    bytes,
    mimeType: "image/png",
    expiresAt: future,
  });
  linkMediaAssetSource(h.orm, {
    assetId: asset.id,
    mediaNoteId: mediaId,
    scope,
    expiresAt: future,
  });
  return { bytes };
}

/** 真实 reader 读取一次（视觉推断真实发生并缓存为 typed note）。 */
async function readImageOnce(h: OneBotHarness, bytes: Uint8Array, note: string): Promise<void> {
  const mediaId = (h.db.query("SELECT id FROM qq_media_notes LIMIT 1").get() as { id: string }).id;
  const row = h.db
    .query("SELECT event_key AS k, segment_index AS s FROM qq_media_notes LIMIT 1")
    .get() as { k: string; s: number };
  const read = await readQqMediaTaskOnce(
    h.orm,
    {
      capabilities: ["image"] as const,
      read: async () => note,
      fetchBytes: async () => ({ bytes }),
    },
    {
      eventKey: row.k,
      segmentIndex: row.s,
      purpose: "baseline",
      policy: "baseline/v1/e2e",
      modelConfig: { visionModelName: "vision-stub", transcriptionModelName: null },
      addressedToAssistant: true,
      assertCurrent: () => {},
      owner: {
        kind: "conversation" as const,
        id: h.conversationId,
        userId: DEFAULT_USER_ID,
        agentId: DEFAULT_AGENT_ID,
      },
    },
  );
  if (read.kind !== "described") throw new Error(`expected described read, got ${read.kind}`);
  void mediaId;
}

/** memory worker 的脚本网关（与 qq-memory-fact-input.test 同构；真实 MemoryService 用）。 */
class WorkerGateway implements ModelGateway {
  config = { baseUrl: "http://127.0.0.1:1234/v1", model: "reply-model", timeoutSeconds: 30 };
  calls: Array<{ messages: unknown; model?: string }> = [];

  async listModels(): Promise<string[]> {
    return ["reply-model"];
  }
  async loadedContextCapacity(): Promise<number | null> {
    return 32768;
  }
  async probeModelLoaded(): Promise<boolean> {
    return true;
  }
  async complete(options: Parameters<ModelGateway["complete"]>[0]): Promise<string> {
    this.calls.push({ messages: options.messages, model: options.model });
    return JSON.stringify({
      memory: {
        name: "群友偏好",
        summary: "群友喜欢精炼回复",
        tags: ["偏好"],
        kinds: ["semantic"],
        body: "群友希望答复使用中文，表达简短。",
      },
    });
  }
  async *streamChat(): AsyncGenerator<string, void, unknown> {
    yield "unused";
  }
}

/** 排一个 QQ 观察整理任务（真实 enqueue，source_event_ids 契约）。 */
function enqueueObservationJob(h: OneBotHarness, eventKeys: string[]) {
  policy(h.orm, DEFAULT_AGENT_ID);
  return enqueue(h.orm, DEFAULT_AGENT_ID, `req_${crypto.randomUUID()}`, {
    kind: "manual",
    eventIds: eventKeys,
    scope: { scope: "reality_user", scopeKey: memoryScopeKeyOf(h) },
  });
}

/** 在同一业务库内造第二个 binding+conversation（真实 journal，不建第二 harness）。 */
function secondBinding(
  h: OneBotHarness,
  input: { id: string; peerId: string; agentId?: string },
): string {
  const now = nowIso();
  h.orm
    .insert(schema.qqSchemes)
    .values({
      id: `22222222-2222-4222-8222-2222222222${input.id.slice(-2).padStart(2, "0")}`,
      name: `方案B-${input.id}`,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .run();
  const schemeRow = h.db
    .query("SELECT id FROM qq_schemes WHERE name=?")
    .get(`方案B-${input.id}`) as { id: string };
  h.orm
    .insert(schema.qqBindings)
    .values({
      id: input.id,
      accountId: "90001",
      conversationKind: "group",
      peerId: input.peerId,
      agentId: input.agentId ?? DEFAULT_AGENT_ID,
      schemeId: schemeRow.id,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  const conversation = h.journal.ensureOneBot(input.id);
  if (!conversation) throw new Error("second conversation missing");
  return conversation.id;
}

/** 在同一业务库内造第二个真实 agent 行（跨 agent 方向用；形状同 ensureDefaults）。 */
function secondAgent(h: OneBotHarness): string {
  const now = nowIso();
  const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  h.orm
    .insert(schema.agents)
    .values({
      id,
      name: "别助手",
      systemPrompt: "别助手的系统提示词",
      description: "",
      additionalInstructions: "",
      p5Config: "{}",
      modelName: "reply-model",
      temperature: 0.7,
      memoryConsolidationModelName: null,
      memoryConsolidationPrompt: "",
      memoryConsolidationAdditionalInstructions: "",
      memoryRetrievalModelName: null,
      memoryRetrievalPrompt: "",
      contextCompressionModelName: null,
      personaIntensity: 60,
      isActive: 1,
      configVersion: 1,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .run();
  return id;
}

// ============================================================================
// [S54_1/S54_2] memory 仅文字关系：真实 memory_job worker 全链（load → generate → publish）
// ============================================================================

function scopeOfHarness(h: OneBotHarness) {
  const binding = h.orm
    .select()
    .from(schema.qqBindings)
    .where(eq(schema.qqBindings.id, h.bindingId))
    .get();
  if (!binding) throw new Error("binding missing");
  const conversation = h.db
    .query("SELECT binding_epoch AS e FROM conversations WHERE id=?")
    .get(h.conversationId) as { e: number };
  return {
    conversationId: h.conversationId,
    accountId: binding.accountId,
    conversationKind: binding.conversationKind as "group" | "private",
    peerId: binding.peerId,
    agentId: binding.agentId,
    bindingId: binding.id,
    bindingEpoch: conversation.e,
    authorityRevision: binding.authorityRevision,
  };
}

describe("memory 仅文字关系（id54/id56 补块）", () => {
  it("[S54_1] vision 推断只落媒体 note；memory_job worker 的输入与发布都只有文字关系", async () => {
    const h = createOneBotHarness({
      accountId: "90001",
      member: "10001",
      model: [],
    });
    try {
      // 真实 wire 图片消息；market face 三键同现 → intake 会写 category:"expression"，
      // 这让 restyleRecord 的归一（→unknown）成为可失败的断言而不是恒真式。
      h.receive({
        id: "-7001",
        speaker: "10001",
        text: "看这个",
        image: "media-src-7001",
        addressed: true,
        imageHint: { emoji_id: "E001", emoji_package_id: "P1", summary: "笑哭" },
      });
      const mediaId = (h.db.query("SELECT id FROM qq_media_notes LIMIT 1").get() as { id: string })
        .id;
      const { bytes } = attachAsset(h, mediaId);
      const VISION = "图里是一只猫XYZ56";
      await readImageOnce(h, bytes, VISION);

      // 对照断言：视觉推断确实真实落库（否则下面的 not.toContain 全是恒真式）。
      const storedNote = (
        h.db.query("SELECT note FROM qq_media_read_tasks WHERE note IS NOT NULL LIMIT 1").get() as {
          note: string;
        }
      ).note;
      expect(storedNote).toBe(VISION);

      const eventKey = eventKeyOfMessage(h, "-7001");
      const job = enqueueObservationJob(h, [eventKey]);
      const scopeKey = memoryScopeKeyOf(h);
      const frozen = freezeQqFactScope(h.db, DEFAULT_AGENT_ID, job.id, scopeKey);
      const loaded = loadQqFactInputs({
        store: { db: h.db, orm: h.orm },
        scope: frozen,
        scopeKey,
        eventKeys: [eventKey],
        now: nowIso(),
        important: new Set<string>(),
      });

      // memory 输入记录：image 片段必须被 restyleRecord 抹成 unknown（intake 写的是 expression）。
      const records = loaded.records.map(({ record }) => record);
      expect(records).toHaveLength(1);
      const parts = records[0]?.parts as Array<Record<string, unknown>>;
      const imageParts = parts.filter((part) => part.kind === "image");
      expect(imageParts.length).toBeGreaterThan(0);
      for (const part of imageParts) {
        expect(part).toEqual({
          kind: "image",
          mediaId: expect.any(String),
          category: "unknown",
        });
      }
      // 串强负：memory 输入无视觉推断/无 base64/无媒体来源引用。
      const serializedRecords = JSON.stringify(records);
      expect(serializedRecords).not.toContain(VISION);
      expect(serializedRecords).not.toContain("base64");
      expect(serializedRecords).not.toContain("media-src-7001");
      // 文字关系仍然在（正面：仅文字关系允许进 memory）。
      expect(serializedRecords).toContain("看这个");
      // 引用与事实 refs 有效（body gate 先行，发布前有效）。
      verifyQqFactInputs({
        db: h.db,
        agentId: DEFAULT_AGENT_ID,
        jobId: job.id,
        frozen: loaded,
        now: nowIso(),
      });

      // 真实 MemoryService worker：loadInputs（复验）→ generate（脚本网关）→ publish。
      const gateway = new WorkerGateway();
      const service = new MemoryService({
        orm: h.orm,
        db: h.db,
        gateway,
        pollIntervalMs: 5,
        heartbeatIntervalMs: 5,
        jobTimeoutMs: 2_000,
      });
      await service.runJob(job.id);
      const jobRow = h.orm
        .select()
        .from(schema.memoryJobs)
        .where(eq(schema.memoryJobs.id, job.id))
        .get();
      expect(jobRow?.status).toBe("succeeded");

      // 发布面末验：正文/名称/摘要无视觉推断；来源只有观察事件（无媒体 note 来源）。
      const published = entries(h.orm, DEFAULT_AGENT_ID, undefined, { status: "active" });
      expect(published).toHaveLength(1);
      const entry = published[0];
      if (!entry) throw new Error("published entry missing");
      const entryJson = JSON.stringify({
        name: entry.name,
        summary: entry.summary,
        body: entry.body,
        tags: entry.tags,
      });
      expect(entryJson).not.toContain(VISION);
      expect(entryJson).not.toContain("base64");
      expect(entryJson).not.toContain("media-src-7001");
      const sourceRows = h.orm
        .select()
        .from(schema.qqMemorySources)
        .where(eq(schema.qqMemorySources.memoryId, entry.id))
        .all();
      expect(sourceRows.map((row) => row.eventKey)).toEqual([eventKey]);
      // 整理调用里同样无视觉推断文本（模型看到的整理输入只有文字关系）。
      const callJson = JSON.stringify(gateway.calls);
      expect(callJson).not.toContain(VISION);
      expect(callJson).not.toContain("media-src-7001");
    } finally {
      h.close();
    }
  });

  it("[S54_2] 发布消费后来源正文失效：verify 拒绝发布，正文不复活", async () => {
    const h = createOneBotHarness({ accountId: "90001", member: "10001", model: [] });
    try {
      h.receive({ id: "-7002", speaker: "10001", text: "我喜欢精炼的回复", addressed: true });
      const eventKey = eventKeyOfMessage(h, "-7002");
      const job = enqueueObservationJob(h, [eventKey]);
      const scopeKey = memoryScopeKeyOf(h);
      const frozen = freezeQqFactScope(h.db, DEFAULT_AGENT_ID, job.id, scopeKey);
      const loaded = loadQqFactInputs({
        store: { db: h.db, orm: h.orm },
        scope: frozen,
        scopeKey,
        eventKeys: [eventKey],
        now: nowIso(),
        important: new Set<string>(),
      });
      expect(loaded.records).toHaveLength(1);

      // load 之后、publish 之前观察正文失效：publication 复验必须整任务拒绝（不回裸 body）。
      h.db.query("DELETE FROM qq_observation_text WHERE event_key=?").run(eventKey);
      let code = "";
      try {
        verifyQqFactInputs({
          db: h.db,
          agentId: DEFAULT_AGENT_ID,
          jobId: job.id,
          frozen: loaded,
          now: nowIso(),
        });
      } catch (error) {
        code = (error as { code?: string }).code ?? "";
      }
      expect(code).toBe("MEMORY_STATE_CONFLICT");

      // 同一场景走真实 worker：任务 failed，零发布（正文不借事件身份复活）。
      const gateway = new WorkerGateway();
      const service = new MemoryService({
        orm: h.orm,
        db: h.db,
        gateway,
        pollIntervalMs: 5,
        heartbeatIntervalMs: 5,
        jobTimeoutMs: 2_000,
      });
      h.db.query("DELETE FROM qq_observation_text WHERE event_key=?").run(eventKey);
      await service.runJob(job.id);
      const jobRow = h.orm
        .select()
        .from(schema.memoryJobs)
        .where(eq(schema.memoryJobs.id, job.id))
        .get();
      expect(jobRow?.status).toBe("failed");
      // 载体删除后 worker 在 load 阶段即拒（MEMORY_SOURCE_INVALID），到不了发布复验；
      // 直接 verify 面同场景得 MEMORY_STATE_CONFLICT（上面已断）。两个码都是 fail closed。
      expect(jobRow?.errorCode).toBe("MEMORY_SOURCE_INVALID");
      expect(jobRow?.resultId).toBeNull();
      expect(entries(h.orm, DEFAULT_AGENT_ID, undefined, { status: "active" })).toHaveLength(0);
    } finally {
      h.close();
    }
  });

  it("[S56_1] facts/关系投影不含 caption/path/base64；vision 推断止步媒体 note", async () => {
    const h = createOneBotHarness({ accountId: "90001", member: "10001", model: [] });
    try {
      // 图片来源引用带真实路径形态（存在媒体行里），path 强负才有对照物。
      h.receive({
        id: "-7051",
        speaker: "10001",
        text: "看图",
        image: "C:/fakepath/qq-media-7051.png",
        addressed: true,
      });
      const mediaId = (h.db.query("SELECT id FROM qq_media_notes LIMIT 1").get() as { id: string })
        .id;
      const { bytes } = attachAsset(h, mediaId);
      const VISION = "图里是一只猫XYZ56";
      await readImageOnce(h, bytes, VISION);
      const storedNote = (
        h.db.query("SELECT note FROM qq_media_read_tasks WHERE note IS NOT NULL LIMIT 1").get() as {
          note: string;
        }
      ).note;
      expect(storedNote).toBe(VISION);

      const eventKey = eventKeyOfMessage(h, "-7051");
      const scope = scopeOfHarness(h);
      const facts = projectQqMessageFacts({ db: h.db, orm: h.orm }, scope, [eventKey], h.now());
      expect(facts).toHaveLength(1);
      const factsJson = JSON.stringify(facts);
      expect(factsJson).not.toContain(VISION);
      expect(factsJson).not.toContain("base64");
      expect(factsJson).not.toContain("caption");
      expect(factsJson).not.toContain("C:/fakepath");
      // image part 三键存在标记（直接对 facts 断言，不只对 relations）。
      const fact = facts[0];
      if (!fact) throw new Error("fact missing");
      for (const part of fact.parts) {
        if (part.kind === "image") {
          expect(part).toEqual({
            kind: "image",
            mediaId: expect.any(String),
            category: "unknown",
          });
        }
      }

      // 压缩输入同源的关系投影同样干净。
      const relations = projectQqTextRelations({ facts, scope, now: h.now() });
      const relationsJson = JSON.stringify(relations);
      expect(relationsJson).not.toContain(VISION);
      expect(relationsJson).not.toContain("base64");
      expect(relationsJson).not.toContain("C:/fakepath");
      expect(relationsJson).not.toContain("caption");
    } finally {
      h.close();
    }
  });
});

// ============================================================================
// [S55_1–S55_3] 水位：判断档不读包/不推进（before/after 行 hash 强负）；回复档按旧规则装配
// ============================================================================

describe("水位与判断档（id55 补块）", () => {
  it("[S55_1] 判断档整轮：水位行 before/after 逐字相等，零压缩写入、零包进输入", async () => {
    const h = createOneBotHarness({
      accountId: "90001",
      member: "10001",
      model: [decideGenerate("10001", "回答", []), say("合成回复正文")],
    });
    try {
      const marker = "水位包标记PACKAGETEXT55";
      seedSummary(h, marker);
      h.receive({
        id: "-7201",
        speaker: "10001",
        text: "普通聊天",
        addressed: true,
        groupCard: "阿林",
      });
      const before = summaryRowJson(h);
      expect(before).not.toBeNull();
      await h.activate("direct_reply");
      await h.deliver();

      // 判断档＝决策相（call 0）：无包正文、无包信封（判断档完全不碰水位）。
      expect(phases(h)).toEqual(["next", "generate"]);
      const decisionText = callText(h, 0);
      expect(decisionText).not.toContain(marker);
      expect(decisionText).not.toContain("qq_context_packages");
      // 生成相＝回复档：已存包按装配规则进入（旧规则装配的整链正测）。
      expect(callText(h, 1)).toContain(marker);
      // 行 hash 强负：before/after 逐字相等——判断档既不压缩也不推进水位
      // （qq_conversation_summaries 只有压缩任务会写）。
      expect(summaryRowJson(h)).toBe(before);
      // 无辅助（压缩/整理）模型调用。
      expect(phases(h)).toEqual(["next", "generate"]);
    } finally {
      h.close();
    }
  });

  it("[S55_2] 私聊回复档：已存包按装配规则进入模型输入（旧规则装配正测）", async () => {
    const h = createOneBotHarness({
      accountId: "90001",
      peerId: "20002",
      kind: "private",
      model: [decideGenerate("20002", "回答", []), say("合成回复正文")],
    });
    try {
      const marker = "水位包标记PACKAGETEXT55P";
      seedSummary(h, marker);
      h.receive({ id: "-7202", text: "普通聊天", addressed: true });
      await h.activate("direct_reply");
      await h.deliver();
      // 私聊决策档=reply：包正文按装配顺序进输入。
      expect(callText(h, 0)).toContain(marker);
    } finally {
      h.close();
    }
  });

  it("[S55_3] 回复档攒够水位触发条数场景：旧包照常装配、窗口照旧（真实后台压缩的 enqueue/消费与包推进由 [S55_4]/[S55_5] 生产队列块实证）", async () => {
    const h = createOneBotHarness({
      accountId: "90001",
      peerId: "20002",
      kind: "private",
      model: [decideGenerate("20002", "回答", []), say("合成回复正文")],
    });
    try {
      // 方案水位触发降到 1：任何窗口外旧消息都足以触发压缩任务。
      h.db.query("UPDATE qq_schemes SET summary_watermark_trigger=1 WHERE id=?").run(h.scheme.id);
      const marker = "水位包标记PACKAGETEXT55Q";
      seedSummary(h, marker);
      h.receive({ id: "-7203", text: "普通聊天", addressed: true });
      await h.activate("direct_reply");
      await h.deliver();
      // 已存包照常装配（压缩未执行不影响旧包）。
      expect(callText(h, 0)).toContain(marker);
      // 压缩任务尚未执行：水位行未被后台任务推进（原 throughSeq=0/coveredSeq=0 保持）。
      const row = h.db
        .query(
          "SELECT through_seq AS t, covered_seq AS c FROM qq_conversation_summaries WHERE conversation_id=?",
        )
        .get(h.conversationId) as { t: number; c: number };
      expect(row.t).toBe(0);
      expect(row.c).toBe(0);
      // 本块只证未消费时水位不动、旧包照常装配；真实后台压缩的 enqueue/消费与新包
      // throughSeq/coveredSeq/package_limit 语义由 [S55_4]/[S55_5]（生产 queue + 真实 job.run）实证。
    } finally {
      h.close();
    }
  });
});

// ============================================================================
// [S57_1] 跨 Source 拒：同一业务库内两个 scope，行确实存在的前提下 fail closed
// ============================================================================

/** 真实媒体行夹具（与原 e2e mediaRow 同构：events → segment → 资产/link → journal）。 */
function createMediaFixture(h: OneBotHarness, eventKey: string): { id: string } {
  const binding = h.orm
    .select()
    .from(schema.qqBindings)
    .where(eq(schema.qqBindings.id, h.bindingId))
    .get();
  if (!binding) throw new Error("binding missing");
  const occurred = Math.floor(Date.parse(h.now()) / 1000);
  h.orm
    .insert(schema.qqEvents)
    .values({
      eventKey,
      accountId: binding.accountId,
      conversationKind: binding.conversationKind,
      peerId: binding.peerId,
      agentId: binding.agentId,
      messageId: `message-${eventKey}`,
      occurredAtSeconds: occurred,
      speakerKind: "member",
      speakerId: "20002",
      recordedAt: h.now(),
    })
    .run();
  const segment = recordMediaSegment(h.orm, {
    eventKey,
    segmentIndex: 0,
    kind: "image",
    sourceRef: `ref-${eventKey}`,
    occurredAtSeconds: occurred,
    addressed: true,
  });
  h.journal.ingestOneBotEvent(eventKey, h.bindingId);
  const bytes = png();
  const future = new Date(Date.parse(h.now()) + 14 * 24 * 60 * 60 * 1000).toISOString();
  const scope = {
    accountId: binding.accountId,
    conversationKind: binding.conversationKind as "group" | "private",
    peerId: binding.peerId,
    agentId: binding.agentId,
  };
  const { asset } = recordMediaAsset(h.orm, {
    scope,
    bytes,
    mimeType: "image/png",
    expiresAt: future,
  });
  linkMediaAssetSource(h.orm, {
    assetId: asset.id,
    mediaNoteId: segment.id,
    scope,
    expiresAt: future,
  });
  return { id: segment.id };
}

describe("跨 Source 拒（id57 补块：同库双 scope）", () => {
  it("[S57_1] 同库两 scope：行存在时跨群/跨 agent 拒、合法 pair 可读、owner-first 不泄过期态", async () => {
    const h = createOneBotHarness({ accountId: "90001", member: "10001", model: [] });
    try {
      // 群 A（本 harness）：真实媒体行 + 来源引用。
      const media = createMediaFixture(h, "l57x-event");
      const scopeA = scopeOfHarness(h);
      const ref = createQqMediaSourceRef({ db: h.db, orm: h.orm }, scopeA, media.id, h.now());
      expect(ref).not.toBeNull();
      if (!ref) throw new Error("source ref missing");

      // 对照：行确实在同一个库里（不是"行不存在导致的 revoked"）。
      const linkCount = (
        h.db
          .query("SELECT COUNT(*) AS n FROM qq_media_asset_sources WHERE media_note_id=?")
          .get(media.id) as { n: number }
      ).n;
      expect(linkCount).toBe(1);
      const mediaCount = (
        h.db.query("SELECT COUNT(*) AS n FROM qq_media_notes WHERE id=?").get(media.id) as {
          n: number;
        }
      ).n;
      expect(mediaCount).toBe(1);

      // 同库第二个 scope（同账号同助手、别群）：真实 binding + journal conversation。
      const conversationB = secondBinding(h, {
        id: "22222222-2222-4222-8222-222222222221",
        peerId: "30888",
      });
      const ownerB = {
        kind: "conversation" as const,
        id: conversationB,
        userId: DEFAULT_USER_ID,
        agentId: DEFAULT_AGENT_ID,
      };
      // 跨群 owner 读 A 群 ref：scope 校验拒（行存在，唯一变量是 owner/scope）。
      expect(sourceAccess(h.db, ref, ownerB, { userId: DEFAULT_USER_ID }, h.now())).toBe("revoked");

      // 跨 agent：同库第二个真实 agent + 它自己的 scope。
      const agentC = secondAgent(h);
      const conversationC = secondBinding(h, {
        id: "22222222-2222-4222-8222-222222222222",
        peerId: "30777",
        agentId: agentC,
      });
      const ownerC = {
        kind: "conversation" as const,
        id: conversationC,
        userId: DEFAULT_USER_ID,
        agentId: agentC,
      };
      expect(sourceAccess(h.db, ref, ownerC, { userId: DEFAULT_USER_ID }, h.now())).toBe("revoked");

      // 合法 pair：A 群自己的 owner 读自己的 ref → available（完整链：owner→scope→
      // timeline→link→revision 复算）。
      const ownerA = {
        kind: "conversation" as const,
        id: h.conversationId,
        userId: DEFAULT_USER_ID,
        agentId: DEFAULT_AGENT_ID,
      };
      expect(sourceAccess(h.db, ref, ownerA, { userId: DEFAULT_USER_ID }, h.now())).toBe(
        "available",
      );

      // fail closed 顺序（R21）：来源过期后，跨 owner 仍 revoked（不泄露 expired 态），
      // 合法 owner 得到 expired（owner 检查先行、其后才是到期帽）。
      h.db.query("UPDATE qq_media_assets SET expires_at='2020-01-01T00:00:00.000000Z'").run();
      h.db
        .query("UPDATE qq_media_asset_sources SET expires_at='2020-01-01T00:00:00.000000Z'")
        .run();
      h.db.query("UPDATE qq_media_notes SET expires_at='2020-01-01T00:00:00.000000Z'").run();
      expect(sourceAccess(h.db, ref, ownerB, { userId: DEFAULT_USER_ID }, h.now())).toBe("revoked");
      expect(sourceAccess(h.db, ref, ownerA, { userId: DEFAULT_USER_ID }, h.now())).toBe("expired");
    } finally {
      h.close();
    }
  });
});

// ============================================================================
// [S58_1] raw wire：role 顺序/有序片段/tools/schema 逐字形状 + 持久面扩扫无 base64/URL/path
// ============================================================================

/** 持久面扩扫：run/context/event/context_snapshots + 出站请求 + 发送日志 + 出站事实。 */
function persistedSurfaces(h: OneBotHarness): string {
  const repository = h.runs;
  let persisted = "";
  for (const run of repository.listRuns({ ownerKind: "conversation", ownerId: h.conversationId })) {
    persisted += JSON.stringify(run);
    for (const step of run.steps) {
      persisted += JSON.stringify(repository.getContext(step.context) ?? {});
    }
    persisted += JSON.stringify(repository.listEvents(run.runId));
  }
  persisted += JSON.stringify(h.db.query("SELECT * FROM context_snapshots").all());
  // 出站面：真正交给发送端的请求体与两张出站表。
  persisted += JSON.stringify(h.sent);
  persisted += JSON.stringify(h.db.query("SELECT * FROM qq_send_log").all());
  persisted += JSON.stringify(h.db.query("SELECT * FROM qq_outbound_message_facts").all());
  return persisted;
}

describe("raw wire 保留（id58 补块）", () => {
  it("[S58_1] 原生多模态整链：role 序列/有序片段/tools/schema 逐字；持久面无 base64/data URL/path", async () => {
    const bytes = png();
    const PATHY_REF = "C:/fakepath/qq-media-7101.png";
    const h = createOneBotHarness({
      accountId: "90001",
      member: "10001",
      mediaEnabled: true,
      vision: ["图里是一只猫"],
      mergeWindowSeconds: 0,
      mediaInput: { mode: "native" },
      imageBytes: { [PATHY_REF]: bytes },
      model: [decideGenerate("10001", "回答", []), scoreOf(6), say("合成回复正文")],
    });
    try {
      h.receive({ id: "-7101", speaker: "10001", text: "看图回答", image: PATHY_REF });
      h.advance(31);
      await h.activate("chiming_in");
      await h.deliver();
      expect(h.sent).toHaveLength(1);

      const received = h.model?.receivedMessages ?? [];
      expect(received.length).toBeGreaterThan(0);
      // role 顺序逐字：整序列比对（system 在首、后续 user 材料次序与装配序一致）。
      expect(received.map((call) => call.messages.map((message) => message.role))).toEqual([
        ["system", "user", "user", "user", "user"],
        ["system", "user", "user", "user", "user", "user"],
        ["system", "user", "user", "user", "user", "user"],
      ]);
      // tools 逐字：决策调用带的工具名数组逐字锁定（动作目录形状）。
      expect(h.model?.calls[0]?.tools ?? []).toEqual([
        "memory.query",
        "memory.read",
        "knowledge.query",
        "knowledge.read",
        "history.query",
        "history.read",
        "media.list",
        "media.note.read",
        "media.describe",
        "media.read",
        "sticker.search",
      ]);
      // schema 逐字：三次调用（决策/评分/生成）全带结构化响应 schema。
      expect((h.model?.calls ?? []).map((call) => call.schema)).toEqual([true, true, true]);

      // 有序片段：带图调用里 image 所在 user message 的 part 序列逐字（text 在前、image 在后）。
      let sawImage = false;
      for (const call of received) {
        for (const message of call.messages) {
          const kinds = message.content.map((part) => part.kind);
          if (kinds.includes("image")) {
            sawImage = true;
            // 原生装配：图片是独立 user message（整段只有 image part），与文字材料分列。
            expect(kinds).toEqual(["image"]);
            const imagePart = message.content.find((part) => part.kind === "image");
            if (imagePart?.kind !== "image") throw new Error("unreachable");
            // image part 只有来源元数据：无 bytes/base64；来源引用是引用对象而非路径字符串。
            expect(Object.keys(imagePart).sort()).toEqual([
              "height",
              "kind",
              "mimeType",
              "revision",
              "sha256",
              "sourceId",
              "width",
            ]);
            expect(JSON.stringify(imagePart)).not.toContain("base64");
            expect(JSON.stringify(imagePart)).not.toContain(PATHY_REF);
          } else {
            expect(kinds.every((kind) => kind === "text")).toBe(true);
          }
        }
      }
      expect(sawImage).toBe(true);

      // 持久面强负（扩扫）：run/context/event/context_snapshots/出站请求/发送日志/出站事实
      // 全部无 base64、无 data URL、无来源路径字符串。
      const persisted = persistedSurfaces(h);
      expect(persisted).not.toContain("base64");
      expect(persisted).not.toContain("data:image");
      expect(persisted).not.toContain(PATHY_REF);
      expect(persisted).not.toContain("file://");
      // 出站发送正文与图片字节彻底脱钩：发送请求不含图（文本回复）。
      expect(JSON.stringify(h.sent)).not.toContain(PATHY_REF);

      // sha 可核：资产面记录的是受控字节的 sha256。
      const asset = h.db
        .query("SELECT content_sha256 AS sha FROM qq_media_assets LIMIT 1")
        .get() as { sha: string };
      const { createHash } = await import("node:crypto");
      expect(asset.sha).toBe(createHash("sha256").update(bytes).digest("hex"));

      // 发送边界转换面（HTTP 边界捕获模式接口到位前的可执行部分）：
      // toGatewayMessages 把元数据消息转成有序 wire 片段（[text, image_url]），
      // data URL 只在返回值里——它由发送边界即时组装，绝不进上面扫过的任何持久面。
      const imageCall = received.find((call) =>
        call.messages.some((message) => message.content.some((part) => part.kind === "image")),
      );
      if (!imageCall) throw new Error("image call missing");
      const wire = await toGatewayMessages({
        messages: imageCall.messages,
        runId: crypto.randomUUID(),
        owner: {
          kind: "conversation",
          id: h.conversationId,
          userId: DEFAULT_USER_ID,
          agentId: DEFAULT_AGENT_ID,
        },
        imageResolver: {
          resolve: async () => ({ mimeType: "image/png", bytes }),
        },
      });
      const imageMessage = wire.find(
        (message) =>
          typeof message.content !== "string" &&
          message.content.some((part) => part.type === "image_url"),
      );
      expect(imageMessage).toBeDefined();
      const parts = (imageMessage?.content as Array<{ type: string }>) ?? [];
      // 该消息只有 image part ⇒ wire 片段恰为 ["image_url"]（空 text 缓冲不产出 text 段）；
      // 有序性由「同序遍历 + flushText」保证，混合消息会是 [text,image_url,…] 交错序。
      expect(parts.map((part) => part.type)).toEqual(["image_url"]);
      const dataUrl = (
        parts.find((part) => part.type === "image_url") as unknown as {
          image_url: { url: string };
        }
      ).image_url.url;
      expect(dataUrl.startsWith("data:image/png;base64,")).toBe(true);
      // 该 data URL 不在任何持久面里。
      expect(persisted).not.toContain(dataUrl);
    } finally {
      h.close();
    }
  });
});

// ============================================================================
// [S58_2] 真实 HTTP 边界捕获（T15 58 项 id58 字节面）：owned loopback + 真实 Runtime port
// ============================================================================

// P4 已实证的入口形状：createModelPort({ gateway: createLmStudioClient(owned loopback) }) 作为
// harness 的 model 传入（现 Partial<ModelPort> 入口，不新增 harness 字段、不第二模型链、
// 不 as never 强 cast）。loopback 是本测试自有的 node:http 服务（port 0 / 127.0.0.1 / finally close），
// 不触真实 LM Studio/外网/17861；每条 /v1/chat/completions 都被拦截并记录 wire body。

import type { Server } from "node:http";
import http from "node:http";

/** 按请求声明的 response_format schema 形状决定 provider envelope 应答（真实网关行为对面）。 */
function loopbackReply(body: {
  response_format?: { json_schema?: { schema?: Record<string, unknown> } };
}): string {
  const schema = body.response_format?.json_schema?.schema;
  const properties = schema?.properties as Record<string, unknown> | undefined;
  const oneOf = schema?.oneOf as Record<string, unknown>[] | undefined;
  if (properties?.scoreResult !== undefined) {
    return JSON.stringify({ scoreResult: { score: 6 }, media: [] });
  }
  if (properties?.score !== undefined) {
    return JSON.stringify({ score: 6, reason: "ok" });
  }
  if (properties?.text !== undefined) {
    return JSON.stringify({ text: "合成回复正文", media: [] });
  }
  if (oneOf !== undefined) {
    // unknown 图 envelope（oneOf 分支带 media 属性）→ envelope 应答；纯文字决策（原 oneOf）
    // 走冻结的裸 JSON 决策协议。
    const hasMediaBranch = oneOf.some(
      (branch) =>
        branch !== null &&
        typeof branch === "object" &&
        (branch as { properties?: { media?: unknown } }).properties?.media !== undefined,
    );
    return hasMediaBranch
      ? JSON.stringify({
          decision: {
            kind: "final",
            outputs: [
              { kind: "generate", targetId: "10001", instructions: "回答", stickerIds: [] },
            ],
          },
          media: [],
        })
      : JSON.stringify({
          kind: "final",
          outputs: [{ kind: "generate", targetId: "10001", instructions: "回答", stickerIds: [] }],
        });
  }
  return "合成回复正文";
}

/** owned loopback：port 0 / 127.0.0.1 / finally close；/models 与 /chat/completions 全拦。 */
async function startCaptureLoopback(captures: string[]): Promise<{ server: Server; port: number }> {
  const server: Server = http.createServer((req, res) => {
    if (req.url?.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "reply-model" }, { id: "judge-model" }] }));
      return;
    }
    if (req.url?.endsWith("/chat/completions")) {
      let raw = "";
      req.on("data", (chunk: Buffer) => {
        raw += chunk.toString("utf8");
      });
      req.on("end", () => {
        captures.push(raw);
        let parsed: {
          stream?: boolean;
          response_format?: { json_schema?: { schema?: Record<string, unknown> } };
        } = {};
        try {
          parsed = JSON.parse(raw) as typeof parsed;
        } catch {
          parsed = {};
        }
        // 生成相走 streamText → gateway streamChat（stream:true，SSE）；其余为 JSON choices。
        if (parsed.stream === true) {
          const delta = JSON.stringify({
            choices: [{ delta: { content: loopbackReply(parsed) } }],
          });
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write(`data: ${delta}\n\n`);
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [{ finish_reason: "stop", message: { content: loopbackReply(parsed) } }],
          }),
        );
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as { port: number }).port;
  return { server, port };
}

describe("raw wire 真实 HTTP 捕获（id58 字节面）", () => {
  it("[S58_2] 纯文字真实 createModelPort→loopback：schema/tools 声明形状与应答按 envelope 分类；持久面无 raw", async () => {
    const captures: string[] = [];
    const { server, port } = await startCaptureLoopback(captures);
    try {
      const { createLmStudioClient } = await import("../../src/server/llm/model-gateway");
      const { createModelPort } = await import("../../src/server/agent/model-port");
      const gateway = createLmStudioClient({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: "reply-model",
        timeoutSeconds: 5,
      });
      const h = createOneBotHarness({
        accountId: "90001",
        member: "10001",
        model: createModelPort({ gateway }),
      });
      try {
        h.receive({ id: "-7121", speaker: "10001", text: "普通聊天", addressed: true });
        await h.activate("direct_reply");
        await h.deliver();
        expect(h.sent).toHaveLength(1);
        expect(captures.length).toBeGreaterThanOrEqual(2);

        // 声明形状（本地路由）：决策请求带 response_format json_schema（oneOf 决策分支）、无 native tools。
        const bodies = captures.map(
          (raw) =>
            JSON.parse(raw) as {
              model?: string;
              tools?: unknown;
              messages?: Array<{ role: string; content: unknown }>;
              response_format?: { json_schema?: { schema?: Record<string, unknown> } };
            },
        );
        const decisionBodies = bodies.filter(
          (body) =>
            (body.response_format?.json_schema?.schema?.oneOf as unknown[] | undefined) !==
            undefined,
        );
        expect(decisionBodies.length).toBe(1);
        expect(decisionBodies[0]?.tools).toBeUndefined();
        // wire 无图：全部消息 content 都是纯文本（string），任何 call 都不得出现 image_url part。
        for (const body of bodies) {
          for (const message of body.messages ?? []) {
            expect(typeof message.content).toBe("string");
          }
        }
        // 端到端行为真实：应答经 runtime 解析→生成→投递（正文可核；message 是 OneBot 段数组）。
        expect(JSON.stringify(h.sent)).toContain("合成回复正文");
        // 持久面强负：无 base64/data URL/raw 字节串。
        const persisted = persistedSurfaces(h);
        expect(persisted).not.toContain("data:image");
        expect(persisted).not.toContain("base64");
      } finally {
        h.close();
      }
    } finally {
      server.close();
    }
  });

  it("[S58_2c] 合法带图真实 HTTP：三相 wire body 的 ordered image_url data URL 与受控字节逐字相等、角色/schema 完整、持久面无 raw", async () => {
    const captures: string[] = [];
    const { server, port } = await startCaptureLoopback(captures);
    try {
      const bytes = png();
      const base64OfBytes = Buffer.from(bytes).toString("base64");
      const { createLmStudioClient } = await import("../../src/server/llm/model-gateway");
      const { createModelPort } = await import("../../src/server/agent/model-port");
      const gateway = createLmStudioClient({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: "reply-model",
        timeoutSeconds: 5,
      });
      const h = createOneBotHarness({
        accountId: "90001",
        member: "10001",
        mediaEnabled: true,
        mergeWindowSeconds: 0,
        mediaInput: { mode: "native" },
        imageBytes: { "l58b-image": bytes },
        model: createModelPort({ gateway }),
      });
      try {
        h.receive({ id: "-7131", speaker: "10001", text: "看图回答", image: "l58b-image" });
        h.advance(31);
        await h.activate("chiming_in");
        await h.deliver();
        expect(h.sent).toHaveLength(1);
        // 决策/评分/生成三相各一条真实 HTTP 调用。
        expect(captures).toHaveLength(3);
        const bodies = captures.map(
          (raw) =>
            JSON.parse(raw) as {
              model?: string;
              tools?: unknown;
              messages?: Array<{ role: string; content: unknown }>;
              response_format?: { json_schema?: { schema?: Record<string, unknown> } };
            },
        );
        const schemaOf = (body: (typeof bodies)[number]) =>
          body.response_format?.json_schema?.schema;
        const phaseOf = (body: (typeof bodies)[number]): "decision" | "score" | "text" => {
          const schema = schemaOf(body);
          if ((schema?.properties as Record<string, unknown> | undefined)?.scoreResult)
            return "score";
          if ((schema?.properties as Record<string, unknown> | undefined)?.text) return "text";
          return "decision";
        };
        expect(bodies.map(phaseOf)).toEqual(["decision", "score", "text"]);
        let sawImage = false;
        for (const body of bodies) {
          // 每相 wire：system 打头；图片以 data URL 出现且与受控字节逐字相等。
          expect(body.messages?.[0]?.role).toBe("system");
          let imageInCall = false;
          for (const message of body.messages ?? []) {
            if (typeof message.content === "string") continue;
            const parts = message.content as Array<{ type: string; image_url?: { url: string } }>;
            for (const [index, part] of parts.entries()) {
              if (part.type !== "image_url") continue;
              sawImage = true;
              imageInCall = true;
              // data URL 逐字节：body 里就是受控 bytes 的 base64（发送边界组装，无第二来源）。
              expect(part.image_url?.url).toBe(`data:image/png;base64,${base64OfBytes}`);
              // 有序片段：image part 前后只能有 text part（wire 序 = 消息 content 序）。
              expect(
                parts.every(
                  (candidate) => candidate.type === "text" || candidate.type === "image_url",
                ),
              ).toBe(true);
              expect(
                index >= 1
                  ? parts[index - 1]?.type === "text" || parts[index - 1]?.type === "image_url"
                  : true,
              ).toBe(true);
            }
          }
          if (imageInCall) {
            // 声明形状：带图 call 必带 response_format（本地路由），无 native tools。
            expect(schemaOf(body)).toBeDefined();
            expect(body.tools).toBeUndefined();
          }
        }
        expect(sawImage).toBe(true);
        // 声明 schema/tools（三相）：决策 oneOf+media envelope、评分 scoreResult、生成 text。
        const decisionSchema = schemaOf(bodies[0] ?? {}) as { oneOf?: unknown } | undefined;
        expect(Array.isArray(decisionSchema?.oneOf)).toBe(true);
        expect(
          (schemaOf(bodies[1] ?? {})?.properties as Record<string, unknown> | undefined)
            ?.scoreResult,
        ).toBeDefined();
        // 持久面强负：wire 上合法的 data URL/b64 绝不落任何持久面。
        const persisted = persistedSurfaces(h);
        expect(persisted).not.toContain("data:image");
        expect(persisted).not.toContain(base64OfBytes);
        expect(persisted).not.toContain("base64");
      } finally {
        h.close();
      }
    } finally {
      server.close();
    }
  });

  it("[S58_2d] 非法 source 强负：伪 revision/foreign owner 的字节句柄 fail closed 拒发，合法句柄同链发出 data URL", async () => {
    // 真实 ImageByteResolver + 真实 toGatewayMessages（发送边界同代码路径）：
    // 非法输入（句柄未按该 owner/run 登记、part 元数据被篡改）在组装 wire 前被拒——
    // 非法 call 零 wire 产出；合法句柄在同一链上照常组装出 data URL。
    const bytes = png();
    const { createImageByteResolver } = await import("../../src/server/agent/image-byte-resolver");
    const runId = crypto.randomUUID();
    const ownerA = {
      kind: "conversation" as const,
      id: "00000000-0000-4000-8000-00000000000a",
      userId: DEFAULT_USER_ID,
      agentId: DEFAULT_AGENT_ID,
    };
    const ownerB = {
      kind: "conversation" as const,
      id: "00000000-0000-4000-8000-00000000000b",
      userId: DEFAULT_USER_ID,
      agentId: DEFAULT_AGENT_ID,
    };
    const resolver = createImageByteResolver();
    resolver.register({
      runId,
      owner: ownerA,
      part: {
        kind: "image",
        sourceId: "media-1",
        revision: "1",
        mimeType: "image/png",
        sha256: "a".repeat(64),
        width: 8,
        height: 8,
      },
      bytes,
      sources: [],
      assertCurrent: () => {},
    });
    const legalPart = {
      kind: "image" as const,
      sourceId: "media-1",
      revision: "1",
      mimeType: "image/png",
      sha256: "a".repeat(64),
      width: 8,
      height: 8,
    };
    const forgedRevisionPart = { ...legalPart, revision: "9" };
    const forgedShaPart = { ...legalPart, sha256: "b".repeat(64) };
    const attempt = async (input: {
      runId: string;
      owner: typeof ownerA;
      part: typeof legalPart;
    }): Promise<string> => {
      const wire = await toGatewayMessages({
        messages: [
          { role: "user", content: [{ kind: "text", text: "看图" }] },
          { role: "user", content: [input.part] },
        ],
        runId: input.runId,
        owner: input.owner,
        imageResolver: { resolve: (request) => resolver.resolve(request) },
      });
      const parts = wire[1]?.content as ChatContentPart[];
      const first = parts[0];
      return first?.type === "image_url" ? first.image_url.url : "";
    };
    // 合法句柄：同链发出，data URL 与受控字节逐字相等。
    const legalUrl = await attempt({ runId, owner: ownerA, part: legalPart });
    expect(legalUrl).toBe(`data:image/png;base64,${Buffer.from(bytes).toString("base64")}`);
    // 非法输入统一 fail closed 在发送边界（chat-content 现码）：resolver 拒绝一律包装为
    // AppError CONTEXT_SOURCE_INVALID（409）——不是模型不支持、不降级、不出 wire。
    const codeOf = async (input: {
      runId: string;
      owner: typeof ownerA;
      part: typeof legalPart;
    }): Promise<string> => {
      try {
        await attempt(input);
      } catch (error) {
        return (error as { code?: string }).code ?? "";
      }
      return "NO_ERROR";
    };
    // 伪 revision：partKey 不匹配 → 句柄缺失 → CONTEXT_SOURCE_INVALID。
    expect(await codeOf({ runId, owner: ownerA, part: forgedRevisionPart })).toBe(
      "CONTEXT_SOURCE_INVALID",
    );
    // 伪 sha256：同理。
    expect(await codeOf({ runId, owner: ownerA, part: forgedShaPart })).toBe(
      "CONTEXT_SOURCE_INVALID",
    );
    // foreign owner：bytes 登记在 ownerA 名下，ownerB 读不到（跨 owner 不泄露字节）。
    expect(await codeOf({ runId, owner: ownerB, part: legalPart })).toBe("CONTEXT_SOURCE_INVALID");
    // 伪 runId：同理。
    expect(await codeOf({ runId: crypto.randomUUID(), owner: ownerA, part: legalPart })).toBe(
      "CONTEXT_SOURCE_INVALID",
    );
  });
});

// ============================================================================
// [S55_4/S55_5] 真实后台压缩 worker：生产 BotCompressionQueue 接线 + 真实 job.run 消费
// ============================================================================

/** 压缩 leaf 的应答器：按冻结 Result schema 回真实 facts（引用 events 里真实 record.id/speaker）。 */
const compressionFactsReply = (
  request: import("../../src/server/agent/model-port").ModelRequest,
): string => {
  // port 层收到的是 ModelMessage（content 为 part 数组）；取出全部 text part 拼接后再解析 contextDumps JSON。
  const userMessage = request.messages?.find((message) => message.role === "user");
  const textOf = (content: unknown): string => {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content
        .flatMap((part) =>
          part !== null && typeof part === "object" && (part as { kind?: string }).kind === "text"
            ? [String((part as { text?: string }).text ?? "")]
            : [],
        )
        .join("");
    }
    return "";
  };
  let events: Array<{ id: string; speaker: string }> = [];
  try {
    const raw = textOf(userMessage?.content);
    const parsed = JSON.parse(raw) as { events?: Array<{ id: string; speaker: string }> };
    events = parsed.events ?? [];
  } catch {
    events = [];
  }
  const first = events[0];
  if (!first) return JSON.stringify({ facts: [] });
  return JSON.stringify({
    facts: [
      {
        kind: "fact",
        speaker: first.speaker,
        text: `压缩事实(${first.id.slice(0, 12)})`,
        source_ids: [first.id],
      },
    ],
  });
};

/** 决策/压缩分流 port（Partial<ModelPort>）：oneOf=决策 final generate；facts schema=压缩应答；streamText=生成正文。 */
const workerPort = (): import("../../src/server/agent/model-port").ModelPort => ({
  complete: async (request) => {
    const schema = request.responseSchema;
    if (Array.isArray(schema?.oneOf)) {
      return JSON.stringify({
        kind: "final",
        outputs: [{ kind: "generate", targetId: "20002", instructions: "回答", stickerIds: [] }],
      });
    }
    if ((schema?.properties as Record<string, unknown> | undefined)?.facts !== undefined) {
      return compressionFactsReply(request);
    }
    return "{}";
  },
  async *streamText() {
    yield "合成回复正文";
  },
  completeMultimodal: async () => "",
});

/** 私聊 harness + 方案压缩旋钮（watermark_trigger/package_limit）+ 真实队列接线。 */
function compressionHarness(input: {
  watermarkTrigger: number;
  packageLimit: number;
}): OneBotHarness {
  const h = createOneBotHarness({
    accountId: "90001",
    peerId: "20002",
    kind: "private",
    compressionQueue: true,
    model: workerPort(),
  });
  h.db
    .query("UPDATE qq_schemes SET summary_watermark_trigger=?, summary_package_limit=? WHERE id=?")
    .run(input.watermarkTrigger, input.packageLimit, h.scheme.id);
  return h;
}

/** 水位行快照（推进 golden/不回退断言用）。 */
const watermarkRow = (
  h: OneBotHarness,
): { throughSeq: number; coveredSeq: number; packages: number } | null => {
  const row = h.db
    .query(
      "SELECT through_seq AS t, covered_seq AS c, content FROM qq_conversation_summaries WHERE conversation_id=?",
    )
    .get(h.conversationId) as { t: number; c: number; content: string } | null;
  if (!row) return null;
  const packages = (JSON.parse(row.content) as { packages?: unknown[] }).packages ?? [];
  return { throughSeq: row.t, coveredSeq: row.c, packages: packages.length };
};

describe("真实后台压缩 worker（S55 补块：生产 queue + 真实 job.run）", () => {
  it("[S55_4] 回复档真实 enqueue→手动消费：真实 job.run 产出新包，throughSeq/coveredSeq 推进、facts 引用真实事件", async () => {
    const h = compressionHarness({ watermarkTrigger: 2, packageLimit: 8 });
    try {
      // 场景构造（不改产品）：本轮触发消息在窗口内；两条历史消息在窗口外（48h 前，14 天保留期内）。
      // recent_turns=1（助手 p5_config 真源）→ 条数裁剪把两条历史消息挤出选中窗口 → 进水位缓冲。
      h.db
        .query("UPDATE agents SET p5_config='{\"recent_turns\":1}' WHERE id=?")
        .run(DEFAULT_AGENT_ID);
      h.receive({ id: "-7301", text: "窗口外第一条消息", addressed: true });
      h.receive({ id: "-7302", text: "窗口外第二条消息", addressed: true });
      h.receive({ id: "-7303", text: "本轮触发消息", addressed: true });
      h.db
        .query(
          "UPDATE qq_events SET occurred_at_seconds=occurred_at_seconds-172800 WHERE message_id IN ('-7301','-7302')",
        )
        .run();
      h.db
        .query(
          "UPDATE qq_observation_text SET occurred_at_seconds=occurred_at_seconds-172800 WHERE event_key IN (SELECT event_key FROM qq_events WHERE message_id IN ('-7301','-7302'))",
        )
        .run();
      const before = watermarkRow(h);
      expect(before).toBeNull();
      await h.activate("direct_reply");
      // 宿主在 activate 末尾已把真实 job enqueue 进生产 queue（同 Runtime 一条 chain）。
      await h.compressionRunOnce();
      const after = watermarkRow(h);
      expect(after).not.toBeNull();
      if (!after) throw new Error("unreachable");
      // 真实压缩产出：两条窗口外消息被压，水位推进（不回退）。
      expect(after.throughSeq).toBeGreaterThanOrEqual(before?.throughSeq ?? 0);
      expect(after.coveredSeq).toBeGreaterThanOrEqual(before?.coveredSeq ?? 0);
      expect(after.packages).toBe(1);
      // 包 facts 是真实叶子应答：引用���实事件 id（source 序规则），非自造字段。
      const content = JSON.parse(
        (
          h.db
            .query("SELECT content FROM qq_conversation_summaries WHERE conversation_id=?")
            .get(h.conversationId) as { content: string }
        ).content,
      ) as {
        packages: Array<{
          facts: Array<{ kind: string; speaker: string; text: string; source_ids: string[] }>;
          fromSeq: number;
          throughSeq: number;
        }>;
      };
      const pkg = content.packages[0];
      expect(pkg).toBeDefined();
      if (!pkg) throw new Error("unreachable");
      expect(pkg.facts.length).toBeGreaterThan(0);
      const fact = pkg.facts[0];
      if (!fact) throw new Error("unreachable");
      expect(fact.kind).toBe("fact");
      expect(fact.source_ids.length).toBe(1);
      const eventKey = (
        h.db.query("SELECT event_key AS k FROM qq_events WHERE message_id='-7301'").get() as {
          k: string;
        }
      ).k;
      // source_ids[0] 是 contextDumps 的 identity tuple JSON 串，引用真实观察事件（含平台消息号 -7301）。
      expect(fact.source_ids[0]).toContain("-7301");
      void eventKey;
      expect(fact.text).toContain("压缩事实");
      // 包范围与批次一致（两条窗口外消息）。
      expect(pkg.fromSeq).toBeLessThanOrEqual(pkg.throughSeq ?? pkg.fromSeq);
    } finally {
      h.close();
    }
  });

  it("[S55_5] package_limit 截断强负：第二次真实压缩后仅保留最新整包、水位不回退", async () => {
    const h = compressionHarness({ watermarkTrigger: 2, packageLimit: 1 });
    try {
      const markerOf = (id: string) => `窗口外消息${id}`;
      const shiftOld = (messageId: string) => {
        h.db
          .query(
            "UPDATE qq_events SET occurred_at_seconds=occurred_at_seconds-172800 WHERE message_id=?",
          )
          .run(messageId);
        h.db
          .query(
            "UPDATE qq_observation_text SET occurred_at_seconds=occurred_at_seconds-172800 WHERE event_key IN (SELECT event_key FROM qq_events WHERE message_id=?)",
          )
          .run(messageId);
      };
      // recent_turns=1：条数裁剪把窗口外历史挤出选中窗口（场景构造，真源是助手 p5_config）。
      h.db
        .query("UPDATE agents SET p5_config='{\"recent_turns\":1}' WHERE id=?")
        .run(DEFAULT_AGENT_ID);
      // 第一批：两条窗口外消息 + 窗口内触发消息 → activate → 消费。
      h.receive({ id: "-7311", text: markerOf("一"), addressed: true });
      h.receive({ id: "-7312", text: markerOf("二"), addressed: true });
      h.receive({ id: "-7316", text: "本轮触发消息一", addressed: true });
      shiftOld("-7311");
      shiftOld("-7312");
      await h.activate("direct_reply");
      await h.compressionRunOnce();
      const first = watermarkRow(h);
      expect(first?.packages).toBe(1);
      // 第二批：再两条窗口外消息 + 窗口内触发消息 → activate → 消费 → package_limit=1 ⇒ 最早整包被丢。
      h.receive({ id: "-7313", text: "窗口外第三条", addressed: true });
      h.receive({ id: "-7314", text: "窗口外第四条", addressed: true });
      h.receive({ id: "-7315", text: "本轮触发消息二", addressed: true });
      shiftOld("-7313");
      shiftOld("-7314");
      await h.activate("direct_reply");
      await h.compressionRunOnce();
      const second = watermarkRow(h);
      expect(second).not.toBeNull();
      if (!second || !first) throw new Error("unreachable");
      // 强负：包数被 limit 截到 1（丢最早整包），水位只增不减。
      expect(second.packages).toBe(1);
      expect(second.throughSeq).toBeGreaterThanOrEqual(first.throughSeq);
      expect(second.coveredSeq).toBeGreaterThanOrEqual(first.coveredSeq);
      // 保留的是新包（含新事实），不含第一批 marker 的旧事实——最早整包确实被丢。
      const content = JSON.parse(
        (
          h.db
            .query("SELECT content FROM qq_conversation_summaries WHERE conversation_id=?")
            .get(h.conversationId) as { content: string }
        ).content,
      ) as { packages: Array<{ facts: Array<{ text: string }> }> };
      const serialized = JSON.stringify(content.packages);
      // 保留的新包：引用第二批真实事件（-7313 在 sources/facts 链上）；第一批事件（-7311/-7312）
      // 已随最早整包被丢，不出现在任何保留面。
      expect(serialized).toContain("-7313");
      expect(serialized).not.toContain("-7311");
      expect(serialized).not.toContain("-7312");
      void markerOf;
    } finally {
      h.close();
    }
  });
});
