// QQ 群观察整理的 worker 边界（业务侧自足，不注入 runtime）：
// 群暂停只挡「开始」——排队中的任务不得开始，已开始的任务照旧完成；本群停用「记忆整理」
// 则连运行中的任务也不得再调模型、不得发布。三个边界分别钉在 claim / generate / publish。

import { describe, expect, it } from "bun:test";
import { setTimeout as delay } from "node:timers/promises";
import { eq } from "drizzle-orm";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { enqueue, entries } from "../../src/server/db/memory-repository";
import { writeQqGroupAgentConfigRow } from "../../src/server/db/qq-binding-repository";
import { recordObservation } from "../../src/server/db/qq-observation-intake";
import type { QqConversationScope } from "../../src/server/db/qq-observation-repository";
import {
  createSession,
  DEFAULT_USER_ID,
  ensureDefaults,
  getTurnByRequest,
  nowIso,
  type Orm,
  prepareTurn,
  saveCompletedAssistantMessage,
} from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import type { ModelGateway } from "../../src/server/llm/model-gateway";
import { MemoryService } from "../../src/server/services/memory-service";
import type { QqObservation } from "../../src/server/services/onebot-protocol";
import { qqMemoryScopeKey } from "../../src/server/services/qq-binding-contract";
import { enqueueQqMemory } from "../../src/server/services/qq-memory-enqueue";

const AGENT_ID = "00000000-0000-0000-0000-000000000001";
const AGENT_B = "00000000-0000-0000-0000-000000000002";
const MODEL = "qwen/qwen3-4b-2507";
const BINDING_X = "11111111-1111-4111-8111-111111111111";
const BINDING_Y = "44444444-4444-4444-8444-444444444444";
const SCHEME_ID = "22222222-2222-4222-8222-222222222222";
const PEER_X = "20001";
const PEER_Y = "20002";
const NOW_SECONDS = Math.floor(Date.parse("2026-09-25T12:00:00.000Z") / 1000);

const VALID_DRAFT = {
  memory: {
    name: "喜好",
    summary: "用户喜欢精炼回复",
    tags: ["偏好"],
    kinds: ["semantic"],
    body: "用户希望答复使用中文，表达简短。",
  },
};

const VALID_DRAFT_JSON = JSON.stringify(VALID_DRAFT);

// Scripted gateway

interface CompleteCall {
  messages: Array<{ role: string; content: string }>;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  responseSchema?: Record<string, unknown>;
  signal?: AbortSignal;
}

class WorkerGateway implements ModelGateway {
  config = { baseUrl: "http://127.0.0.1:1234/v1", model: MODEL, timeoutSeconds: 30 };
  calls: CompleteCall[] = [];
  /** One reply per `complete` call, or `"block"` to hold the call until `release()`. */
  replies: Array<string | "block"> = [];
  private pending: Array<(value: string) => void> = [];

  async listModels(): Promise<string[]> {
    return [MODEL];
  }
  async loadedContextCapacity(): Promise<number | null> {
    return 32768;
  }
  async probeModelLoaded(): Promise<boolean> {
    return true;
  }
  async complete(options: CompleteCall): Promise<string> {
    this.calls.push(options);
    const reply = this.replies[this.calls.length - 1] ?? JSON.stringify({ memory: null });
    if (reply === "block") {
      return new Promise<string>((resolve) => this.pending.push(resolve));
    }
    return reply;
  }
  async *streamChat(): AsyncGenerator<string, void, unknown> {
    yield "unused";
  }
  release(value: string = VALID_DRAFT_JSON): void {
    const waiting = this.pending;
    this.pending = [];
    for (const resolve of waiting) resolve(value);
  }
  get blocked(): boolean {
    return this.pending.length > 0;
  }
}

// Fixtures

function setup() {
  const business = openBusinessDb();
  ensureDefaults(business.orm, MODEL);
  business.orm
    .insert(schema.qqSchemes)
    .values({ id: SCHEME_ID, name: "方案", revision: 1, createdAt: nowIso(), updatedAt: nowIso() })
    .run();
  const gateway = new WorkerGateway();
  const service = new MemoryService({
    orm: business.orm,
    db: business.db,
    gateway,
    pollIntervalMs: 5,
    heartbeatIntervalMs: 5,
    jobTimeoutMs: 2_000,
  });
  // load 的真实事实投影要求事件在本会话 journal 里（inTimeline fail closed），
  // 所以每个绑定都要建立真实 conversation 行，观察记录后 ingest。
  const journal = new ConversationEventRepository(business.db);
  return { business, orm: business.orm, db: business.db, gateway, service, journal };
}

/** A binding row inserted directly; the scheme row above satisfies the table trigger. */
function insertBinding(
  orm: Orm,
  journal: ConversationEventRepository,
  id: string,
  peerId: string,
  patch: { paused?: number; agentId?: string } = {},
) {
  const now = nowIso();
  orm
    .insert(schema.qqBindings)
    .values({
      id,
      accountId: "10001",
      conversationKind: "group",
      peerId,
      agentId: patch.agentId ?? AGENT_ID,
      schemeId: SCHEME_ID,
      paused: patch.paused ?? 0,
      shareWebMemory: 0,
      memoryBatchSize: null,
      ownerIdentityRevision: null,
      revision: 1,
      authorityRevision: 1,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  const conversation = journal.ensureOneBot(id);
  if (!conversation) throw new Error("conversation fixture missing");
}

/** A second assistant, so a rebind can name a real foreign key. */
function addAgent(orm: Orm, id: string) {
  const at = nowIso();
  orm
    .insert(schema.agents)
    .values({
      id,
      name: "另一个助手",
      systemPrompt: "",
      description: "",
      additionalInstructions: "",
      p5Config: "{}",
      modelName: MODEL,
      memoryConsolidationPrompt: "",
      memoryConsolidationAdditionalInstructions: "",
      memoryRetrievalPrompt: "",
      updatedAt: at,
      createdAt: at,
    })
    .run();
}

function scopeOf(peerId: string): QqConversationScope {
  return {
    kind: "qq",
    accountId: "10001",
    conversationKind: "group",
    peerId,
    agentId: AGENT_ID,
  };
}

function observe(
  orm: Orm,
  journal: ConversationEventRepository,
  bindingId: string,
  peerId: string,
  key: string,
  index: number,
): void {
  const observation: QqObservation = {
    accountId: "10001",
    conversation: {
      kind: "group",
      peerId,
      key: JSON.stringify(["qq", "10001", "group", peerId]),
    },
    eventKey: key,
    messageId: `-${index}`,
    occurredAtSeconds: NOW_SECONDS + index,
    subType: "normal",
    speaker: { kind: "member", id: "30001", displayName: "群友" },
    segments: [{ kind: "text", text: `消息${index}` }],
    text: `消息${index}`,
    mentionsSelf: false,
  };
  recordObservation(orm, observation, AGENT_ID);
  // 夹具有效性闸：观察必须真实进入会话 journal；静默 null 会让后续 fail closed 无从定位。
  const ingested = journal.ingestOneBotEvent(key, bindingId);
  expect(ingested).not.toBeNull();
}

function queueGroupJob(
  h: ReturnType<typeof setup>,
  bindingId: string,
  peerId: string,
  requestKey: string,
) {
  observe(h.orm, h.journal, bindingId, peerId, `${requestKey}_0`, 0);
  const job = enqueueQqMemory(h.orm, { scope: scopeOf(peerId), requestKey, limit: 1 });
  if (!job) throw new Error("expected the job to be queued");
  return job;
}

function pause(orm: Orm, bindingId: string): void {
  orm
    .update(schema.qqBindings)
    .set({ paused: 1, updatedAt: nowIso() })
    .where(eq(schema.qqBindings.id, bindingId))
    .run();
}

function disableMemoryOrganize(orm: Orm, bindingId: string): void {
  writeQqGroupAgentConfigRow(orm, {
    bindingId,
    agentId: AGENT_ID,
    overrides: {},
    disabledCapabilities: ["memory_organize"],
    expectedRevision: 0,
  });
}

/** 走真实保存路径恢复（与 PUT /capabilities 同构）：停用纪元 2，旧结果不复活。 */
function enableMemoryOrganize(orm: Orm, bindingId: string): void {
  writeQqGroupAgentConfigRow(orm, {
    bindingId,
    agentId: AGENT_ID,
    overrides: {},
    disabledCapabilities: [],
    expectedRevision: 1,
  });
}

function jobById(orm: Orm, jobId: string) {
  const job = orm.select().from(schema.memoryJobs).where(eq(schema.memoryJobs.id, jobId)).get();
  if (!job) throw new Error("job missing");
  return job;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not reached in time");
    await delay(1);
  }
}

/** Build a COMPLETED web turn — the only shape `turns` accepts for a web job. */
function completedTurn(orm: Orm, sessionId: string, requestKey: string): string {
  const prep = prepareTurn(orm, sessionId, "嗨", requestKey);
  const token = prep.generationToken;
  if (token === null) throw new Error("expected a fresh generation token");
  saveCompletedAssistantMessage(orm, sessionId, "你好", requestKey, token);
  const turn = getTurnByRequest(orm, sessionId, requestKey);
  if (!turn) throw new Error("expected the turn to exist");
  return turn.id;
}

describe("QQ 群整理的 worker 边界", () => {
  it("排队中的任务在群暂停后失败，且不开始模型调用", async () => {
    const h = setup();
    try {
      insertBinding(h.orm, h.journal, BINDING_X, PEER_X);
      const job = queueGroupJob(h, BINDING_X, PEER_X, "req_paused");
      pause(h.orm, BINDING_X);

      await h.service.runJob(job.id);

      const row = jobById(h.orm, job.id);
      expect(row.status).toBe("failed");
      expect(row.errorCode).toBe("CONVERSATION_PAUSED");
      expect(h.gateway.calls).toHaveLength(0);
      expect(entries(h.orm, AGENT_ID, undefined, { status: "active" })).toHaveLength(0);
    } finally {
      h.business.close();
    }
  });

  it("排队中的任务在本群停用记忆整理后失败，且不开始模型调用", async () => {
    const h = setup();
    try {
      insertBinding(h.orm, h.journal, BINDING_X, PEER_X);
      const job = queueGroupJob(h, BINDING_X, PEER_X, "req_disabled");
      disableMemoryOrganize(h.orm, BINDING_X);

      await h.service.runJob(job.id);

      const row = jobById(h.orm, job.id);
      expect(row.status).toBe("failed");
      expect(row.errorCode).toBe("QQ_GROUP_CAPABILITY_DISABLED");
      expect(h.gateway.calls).toHaveLength(0);
      expect(entries(h.orm, AGENT_ID, undefined, { status: "active" })).toHaveLength(0);
    } finally {
      h.business.close();
    }
  });

  it("已开始的任务在群暂停后照旧完成并发布", async () => {
    const h = setup();
    try {
      insertBinding(h.orm, h.journal, BINDING_X, PEER_X);
      const job = queueGroupJob(h, BINDING_X, PEER_X, "req_started_paused");
      h.gateway.replies = ["block"];

      const run = h.service.runJob(job.id);
      await waitUntil(() => jobById(h.orm, job.id).status === "running");
      await waitUntil(() => h.gateway.blocked);
      pause(h.orm, BINDING_X);
      h.gateway.release();
      await run;

      const row = jobById(h.orm, job.id);
      expect(row.status).toBe("succeeded");
      expect(row.errorCode).toBeNull();
      expect(row.resultId).toBeTruthy();
      const published = entries(h.orm, AGENT_ID, undefined, { status: "active" });
      expect(published).toHaveLength(1);
      expect(published[0]?.body).toBe(VALID_DRAFT.memory.body);
    } finally {
      h.business.close();
    }
  });

  it("已开始的任务在本群停用后不再调用模型，也不发布", async () => {
    const h = setup();
    try {
      insertBinding(h.orm, h.journal, BINDING_X, PEER_X);
      const job = queueGroupJob(h, BINDING_X, PEER_X, "req_started_disabled");
      // 一条同分区的已抑制记忆：旧实现会在这一步发起抑制比较调用，正好用来验证它没发生。
      h.orm
        .insert(schema.memoryEntries)
        .values({
          id: crypto.randomUUID(),
          agentId: AGENT_ID,
          userId: DEFAULT_USER_ID,
          name: "旧群规",
          summary: "旧的群规",
          tags: JSON.stringify(["规则"]),
          kinds: JSON.stringify(["semantic"]),
          body: "旧的群规：周三晚上活动。",
          scope: "reality_user",
          scopeKey: qqMemoryScopeKey(scopeOf(PEER_X)),
          status: "suppressed",
          configSnapshot: "{}",
          createdAt: nowIso(),
        })
        .run();
      h.gateway.replies = ["block"];

      const run = h.service.runJob(job.id);
      await waitUntil(() => jobById(h.orm, job.id).status === "running");
      await waitUntil(() => h.gateway.blocked);
      disableMemoryOrganize(h.orm, BINDING_X);
      h.gateway.release();
      await run;

      const row = jobById(h.orm, job.id);
      expect(row.status).toBe("failed");
      expect(row.errorCode).toBe("QQ_GROUP_CAPABILITY_DISABLED");
      // 只有那次已经在飞的调用；解析、抑制比较与发布都被拦下。
      expect(h.gateway.calls).toHaveLength(1);
      expect(row.resultId).toBeNull();
      expect(entries(h.orm, AGENT_ID, undefined, { status: "active" })).toHaveLength(0);
    } finally {
      h.business.close();
    }
  });

  it("换绑到另一个助手后，旧助手的在飞任务不发布", async () => {
    const h = setup();
    try {
      insertBinding(h.orm, h.journal, BINDING_X, PEER_X);
      const job = queueGroupJob(h, BINDING_X, PEER_X, "req_rebind");
      addAgent(h.orm, AGENT_B);
      h.gateway.replies = ["block"];

      const run = h.service.runJob(job.id);
      await waitUntil(() => jobById(h.orm, job.id).status === "running");
      await waitUntil(() => h.gateway.blocked);
      h.orm
        .update(schema.qqBindings)
        .set({ agentId: AGENT_B, revision: 2, authorityRevision: 2, updatedAt: nowIso() })
        .where(eq(schema.qqBindings.id, BINDING_X))
        .run();
      h.gateway.release();
      await run;

      const row = jobById(h.orm, job.id);
      expect(row.status).toBe("failed");
      expect(row.errorCode).toBe("QQ_GROUP_CAPABILITY_DISABLED");
      expect(h.gateway.calls).toHaveLength(1);
      expect(row.resultId).toBeNull();
      expect(entries(h.orm, AGENT_ID, undefined, { status: "active" })).toHaveLength(0);
    } finally {
      h.business.close();
    }
  });

  it("飞行中停用又恢复：旧纪元的结果仍被拒，不发布记忆", async () => {
    const h = setup();
    try {
      insertBinding(h.orm, h.journal, BINDING_X, PEER_X);
      const job = queueGroupJob(h, BINDING_X, PEER_X, "req_off_on");
      h.gateway.replies = ["block"];

      const run = h.service.runJob(job.id);
      await waitUntil(() => jobById(h.orm, job.id).status === "running");
      await waitUntil(() => h.gateway.blocked);
      // 飞行中停用再恢复：当前状态又是启用，但捕获的纪元已过期。
      disableMemoryOrganize(h.orm, BINDING_X);
      enableMemoryOrganize(h.orm, BINDING_X);
      h.gateway.release();
      await run;

      const row = jobById(h.orm, job.id);
      expect(row.status).toBe("failed");
      expect(row.errorCode).toBe("QQ_GROUP_CAPABILITY_DISABLED");
      // 只有那次已经在飞的调用；解析、抑制比较与发布都被拦下。
      expect(h.gateway.calls).toHaveLength(1);
      expect(row.resultId).toBeNull();
      expect(entries(h.orm, AGENT_ID, undefined, { status: "active" })).toHaveLength(0);
    } finally {
      h.business.close();
    }
  });

  it("Web 整理与其他群不受某个群暂停的影响", async () => {
    const h = setup();
    try {
      insertBinding(h.orm, h.journal, BINDING_X, PEER_X, { paused: 1 });
      insertBinding(h.orm, h.journal, BINDING_Y, PEER_Y);

      // Web 会话：scope_key 是裸 Agent id，不属于任何群。
      const sessionId = createSession(h.orm, "会话", { modelName: MODEL }).id;
      const turnId = completedTurn(h.orm, sessionId, "web_turn");
      const webJob = enqueue(h.orm, AGENT_ID, "req_web", {
        kind: "manual",
        sessionId,
        turnIds: [turnId],
      });
      h.gateway.replies = [VALID_DRAFT_JSON];
      await h.service.runJob(webJob.id);
      expect(jobById(h.orm, webJob.id).status).toBe("succeeded");

      // 另一个未暂停的群照旧开始并发布，不受 PEER_X 的暂停牵连。
      const groupJob = queueGroupJob(h, BINDING_Y, PEER_Y, "req_other_group");
      h.gateway.replies.push(VALID_DRAFT_JSON);
      await h.service.runJob(groupJob.id);
      expect(jobById(h.orm, groupJob.id).status).toBe("succeeded");
      expect(entries(h.orm, AGENT_ID, undefined, { status: "active" })).toHaveLength(2);
    } finally {
      h.business.close();
    }
  });
});
