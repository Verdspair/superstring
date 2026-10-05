// T06（原计划文字记忆完整闭环）：memory_job 的 QQ 事实输入与 publication 冻结。
//
// 这里钉住 ruling 的四条主干：load 的真实投影/legacy/expired 分支、scope 冻结与运行期
// 复验、publication 飞行中来源变化的整任务拒绝、以及窄授权（crossjob/非本 job owner/
// 未出现成员的 name ref 全部拒）。全部走真实 openBusinessDb + 真实 intake + journal，
// 不造假投影；飞行中变化用既有 MemoryService + 脚本化 gateway 模式。

import { describe, expect, it } from "bun:test";
import { setTimeout as delay } from "node:timers/promises";
import { eq } from "drizzle-orm";
import { sourceAccess } from "../../src/server/agent/context-access";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { enqueue, entries, policy, updateJobRow } from "../../src/server/db/memory-repository";
import { recordObservation } from "../../src/server/db/qq-observation-intake";
import {
  DEFAULT_AGENT_ID,
  DEFAULT_USER_ID,
  ensureDefaults,
  nowIso,
  type Orm,
} from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { AppError } from "../../src/server/errors";
import type { ModelGateway } from "../../src/server/llm/model-gateway";
import { MemoryService } from "../../src/server/services/memory-service";
import {
  normalizeOneBotMessage,
  type QqObservation,
} from "../../src/server/services/onebot-protocol";
import { qqMemoryScopeKey } from "../../src/server/services/qq-binding-contract";
import { createQqMemberNameSource } from "../../src/server/services/qq-member-sources";
import {
  freezeQqFactScope,
  loadQqFactInputs,
  qqMemoryJobSourceAccess,
  verifyQqFactInputs,
} from "../../src/server/services/qq-memory-fact-input";
import type { RunOwner } from "../../src/shared/contracts/agent-run";
import type { SourceRef } from "../../src/shared/contracts/evidence";

const AGENT_ID = DEFAULT_AGENT_ID;
const MODEL = "qwen/qwen3-4b-2507";
const at = Math.floor(Date.parse("2026-10-01T16:00:00Z") / 1000);
const BINDING_ID = "11111111-1111-4111-8111-111111111111";
const PRIVATE_BINDING_ID = "55555555-5555-4555-8555-555555555555";
const SCHEME_ID = "22222222-2222-4222-8222-222222222222";

const VALID_DRAFT_JSON = JSON.stringify({
  memory: {
    name: "喜好",
    summary: "群友喜欢精炼回复",
    tags: ["偏好"],
    kinds: ["semantic"],
    body: "群友希望答复使用中文，表达简短。",
  },
});

interface CompleteCall {
  messages: Array<{ role: string; content: string }>;
  model?: string;
  temperature?: number;
  responseSchema?: Record<string, unknown>;
  signal?: AbortSignal;
}

class WorkerGateway implements ModelGateway {
  config = { baseUrl: "http://127.0.0.1:1234/v1", model: MODEL, timeoutSeconds: 30 };
  calls: CompleteCall[] = [];
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
    const reply = this.replies[this.callIndex] ?? JSON.stringify({ memory: null });
    this.callIndex += 1;
    if (reply === "block") {
      return new Promise<string>((resolve) => this.pending.push(resolve));
    }
    return reply;
  }
  /** Reply cursor reset: each `runJob` scripts its own replies from the start. */
  callIndex = 0;
  resetReplies(replies: Array<string | "block">): void {
    this.replies = replies;
    this.callIndex = 0;
  }
  async *streamChat(): AsyncGenerator<string, void, unknown> {
    yield "unused";
  }
  release(): void {
    const waiting = this.pending;
    this.pending = [];
    for (const resolve of waiting) resolve(VALID_DRAFT_JSON);
  }
  get blocked(): boolean {
    return this.pending.length > 0;
  }
}

function setup() {
  const business = openBusinessDb();
  ensureDefaults(business.orm, MODEL);
  const journal = new ConversationEventRepository(business.db);
  return { business, db: business.db, orm: business.orm, journal };
}

function bind(
  h: ReturnType<typeof setup>,
  input: { id: string; kind: "group" | "private"; peerId: string },
): { conversationId: string } {
  const now = nowIso();
  h.orm
    .insert(schema.qqSchemes)
    .values({ id: SCHEME_ID, name: "方案", revision: 1, createdAt: now, updatedAt: now })
    .onConflictDoNothing()
    .run();
  h.orm
    .insert(schema.qqBindings)
    .values({
      id: input.id,
      accountId: "90001",
      conversationKind: input.kind,
      peerId: input.peerId,
      agentId: AGENT_ID,
      schemeId: SCHEME_ID,
      paused: 0,
      shareWebMemory: 0,
      memoryBatchSize: null,
      ownerIdentityRevision: null,
      revision: 1,
      authorityRevision: 1,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  const conversation = h.journal.ensureOneBot(input.id);
  if (!conversation) throw new Error("conversation fixture missing");
  return { conversationId: conversation.id };
}

/** 一条带 wire 双名的真实群消息（走 normalize → intake → journal 全链）。 */
function groupObservation(messageId: number, text = "我喜欢精炼的回复", userId = 10001) {
  const result = normalizeOneBotMessage(
    {
      time: at,
      self_id: 90001,
      post_type: "message",
      message_type: "group",
      sub_type: "normal",
      message_id: messageId,
      user_id: userId,
      group_id: 30003,
      sender: { card: "阿林卡", nickname: "阿林" },
      message: [{ type: "text", data: { text } }],
    },
    "90001",
  );
  if (result.kind !== "message") throw new Error("message expected");
  return result.observation;
}

function privateObservation(messageId: number, text = "私聊里说的事") {
  const result = normalizeOneBotMessage(
    {
      time: at,
      self_id: 90001,
      post_type: "message",
      message_type: "private",
      sub_type: "friend",
      message_id: messageId,
      user_id: 30001,
      sender: { nickname: "私友" },
      message: [{ type: "text", data: { text } }],
    },
    "90001",
  );
  if (result.kind !== "message") throw new Error("message expected");
  return result.observation;
}

function recordWithJournal(
  h: ReturnType<typeof setup>,
  bindingId: string,
  observation: QqObservation,
): string {
  recordObservation(h.orm, observation, AGENT_ID);
  h.journal.ingestOneBotEvent(observation.eventKey, bindingId);
  return observation.eventKey;
}

function scopeKeyOf(kind: "group" | "private", peerId: string): string {
  return qqMemoryScopeKey({
    kind: "qq",
    accountId: "90001",
    conversationKind: kind,
    peerId,
    agentId: AGENT_ID,
  });
}

function enqueueJob(
  orm: Orm,
  eventIds: string[],
  scopeKey: string,
  requestKey = `req_${crypto.randomUUID()}`,
) {
  policy(orm, AGENT_ID);
  return enqueue(orm, AGENT_ID, requestKey, {
    kind: "manual",
    eventIds,
    scope: { scope: "reality_user", scopeKey },
  });
}

function loadForJob(
  h: ReturnType<typeof setup>,
  job: { id: string; configSnapshot: string },
  eventKeys?: readonly string[],
) {
  // 与 MemoryService.loadInputs 同一份快照形状（scope_key + source_event_ids），
  // 不另造一个比真源窄的标注。
  const snapshot = JSON.parse(job.configSnapshot) as {
    scope_key: string;
    source_event_ids?: string[];
  };
  const frozen = freezeQqFactScope(h.db, AGENT_ID, job.id, snapshot.scope_key);
  return loadQqFactInputs({
    store: { db: h.db, orm: h.orm },
    scope: frozen,
    scopeKey: snapshot.scope_key,
    eventKeys: eventKeys ?? snapshot.source_event_ids ?? [],
    now: nowIso(),
    important: new Set<string>(),
  });
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof AppError) return error.code;
    throw error;
  }
  throw new Error("expected a failure");
}

function jobOwner(jobId: string): RunOwner {
  return { kind: "memory_job", id: jobId, userId: DEFAULT_USER_ID, agentId: AGENT_ID };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not reached in time");
    await delay(1);
  }
}

describe("memory_job 的事实输入 load", () => {
  it("full facts：真实投影产出记录与 fact/body refs，speaker 当前名经 mint 复验保留", () => {
    const h = setup();
    try {
      bind(h, { id: BINDING_ID, kind: "group", peerId: "30003" });
      const eventKey = recordWithJournal(h, BINDING_ID, groupObservation(-102));
      const job = enqueueJob(h.orm, [eventKey], scopeKeyOf("group", "30003"));
      const loaded = loadForJob(h, job);

      expect(loaded.records).toHaveLength(1);
      const record = loaded.records[0]?.record;
      expect(record?.id).toBe(eventKey);
      expect(record?.completeness).toBe("full");
      expect(record?.currentName).toEqual({ groupCard: "阿林卡", personalNickname: "阿林" });
      const parts = record?.parts as Array<{ kind: string; text?: string }>;
      expect(parts.some((p) => p.kind === "text" && p.text === "我喜欢精炼的回复")).toBe(true);

      const kinds = loaded.factRefs.map((ref) => ref.kind);
      expect(kinds).toContain("qq_message_fact");
      expect(kinds).toContain("qq_observation");
      expect(loaded.nameRefs).toHaveLength(1);
      const nameRef = loaded.nameRefs[0];
      expect(nameRef?.id).toBe(JSON.stringify(["90001", "group", "30003", "10001"]));

      // 窄 access：fact/name ref 经窄 keeper available；body（qq_observation）走统一入口
      // 的既有 case（keeper 只认 fact/name 两类，其余交给统一入口），两者都不得读裸 body
      // 之外的宽授权。publication 复验当场通过。
      const owner = jobOwner(job.id);
      const principal = { userId: DEFAULT_USER_ID };
      for (const ref of loaded.factRefs as SourceRef[]) {
        if (ref.kind === "qq_message_fact") {
          expect(qqMemoryJobSourceAccess(h.db, ref, owner, nowIso())).toBe("available");
        }
        expect(sourceAccess(h.db, ref, owner, principal, nowIso())).toBe("available");
      }
      for (const ref of loaded.nameRefs as SourceRef[]) {
        expect(qqMemoryJobSourceAccess(h.db, ref, owner, nowIso())).toBe("available");
        expect(sourceAccess(h.db, ref, owner, principal, nowIso())).toBe("available");
      }
      verifyQqFactInputs({
        db: h.db,
        agentId: AGENT_ID,
        jobId: job.id,
        frozen: loaded,
        now: nowIso(),
      });
    } finally {
      h.business.close();
    }
  });

  it("legacy：SQL 真无 facts 行且正文仍活且在 timeline 内 → 沿旧形状，不编名字", () => {
    const h = setup();
    try {
      bind(h, { id: BINDING_ID, kind: "group", peerId: "30003" });
      const eventKey = recordWithJournal(h, BINDING_ID, groupObservation(-103));
      h.db.query("DELETE FROM qq_message_facts WHERE event_key=?").run(eventKey);
      const job = enqueueJob(h.orm, [eventKey], scopeKeyOf("group", "30003"));
      const loaded = loadForJob(h, job);

      const record = loaded.records[0]?.record;
      expect(record?.completeness).toBe("legacy_partial");
      expect(record?.body).toBe("我喜欢精炼的回复");
      expect(record?.speaker_id).toBe("10001");
      expect(record).not.toHaveProperty("currentName");
      expect(loaded.factRefs.map((ref) => ref.kind)).toEqual(["qq_observation"]);
      expect(loaded.nameRefs).toEqual([]);
    } finally {
      h.business.close();
    }
  });

  it("expired/缺失不回退：facts 过期不回裸 body 整任务拒；缺事件与不在 timeline 同拒", () => {
    const h = setup();
    try {
      bind(h, { id: BINDING_ID, kind: "group", peerId: "30003" });
      const eventKey = recordWithJournal(h, BINDING_ID, groupObservation(-104));
      const job = enqueueJob(h.orm, [eventKey], scopeKeyOf("group", "30003"));

      // facts 行存在但已过期：不回裸 body → MEMORY_SOURCE_INVALID。
      h.db
        .query(
          "UPDATE qq_message_facts SET expires_at='2020-01-01T00:00:00.000000Z' WHERE event_key=?",
        )
        .run(eventKey);
      expect(codeOf(() => loadForJob(h, job))).toBe("MEMORY_SOURCE_INVALID");

      // body 也删掉仍然拒（不借事件身份复活）。
      h.db.query("DELETE FROM qq_observation_text WHERE event_key=?").run(eventKey);
      expect(codeOf(() => loadForJob(h, job))).toBe("MEMORY_SOURCE_INVALID");

      // 未 journalled 的事件（只落库不进 timeline）：legacy 也不放行。
      const unjournalled = groupObservation(-105);
      recordObservation(h.orm, unjournalled, AGENT_ID);
      updateJobRow(h.orm, job.id, { status: "succeeded", finishedAt: nowIso() });
      const job2 = enqueueJob(h.orm, [unjournalled.eventKey], scopeKeyOf("group", "30003"));
      h.db.query("DELETE FROM qq_message_facts WHERE event_key=?").run(unjournalled.eventKey);
      expect(codeOf(() => loadForJob(h, job2))).toBe("MEMORY_SOURCE_INVALID");

      // 完全未知的事件键：拒。
      updateJobRow(h.orm, job2.id, { status: "succeeded", finishedAt: nowIso() });
      const job3 = enqueueJob(h.orm, [eventKey], scopeKeyOf("group", "30003"), "req_missing");
      expect(codeOf(() => loadForJob(h, job3, ["evt_unknown"]))).toBe("MEMORY_SOURCE_INVALID");
    } finally {
      h.business.close();
    }
  });

  it("窄授权 crossjob 拒：非本 job owner、别 job 的 eventIds、未出现成员的 name ref 全 revoked", () => {
    const h = setup();
    try {
      bind(h, { id: BINDING_ID, kind: "group", peerId: "30003" });
      const eventKey = recordWithJournal(h, BINDING_ID, groupObservation(-106));
      const otherEvent = recordWithJournal(h, BINDING_ID, groupObservation(-107, "另一条", 10002));
      const job = enqueueJob(h.orm, [eventKey], scopeKeyOf("group", "30003"));
      const loaded = loadForJob(h, job);
      updateJobRow(h.orm, job.id, { status: "succeeded", finishedAt: nowIso() });
      const otherJob = enqueueJob(
        h.orm,
        [otherEvent],
        scopeKeyOf("group", "30003"),
        "req_other_job",
      );
      const otherLoaded = loadForJob(h, otherJob);
      const factRef = loaded.factRefs.find((ref) => ref.kind === "qq_message_fact");
      if (!factRef) throw new Error("fact ref missing");

      // 非 memory_job owner（既有 conversation owner 形态）不进窄 keeper → revoked。
      expect(
        qqMemoryJobSourceAccess(
          h.db,
          factRef,
          {
            kind: "qq_binding",
            id: BINDING_ID,
            userId: DEFAULT_USER_ID,
            agentId: AGENT_ID,
          },
          nowIso(),
        ),
      ).toBe("revoked");
      // 别的 job（哪怕同 scope）引用本 job 的 event：不在它的 source_event_ids → revoked。
      expect(qqMemoryJobSourceAccess(h.db, factRef, jobOwner(otherJob.id), nowIso())).toBe(
        "revoked",
      );
      // 本 job 引用未 selected 的 event：revoked。
      const otherFactRef = otherLoaded.factRefs.find((ref) => ref.kind === "qq_message_fact");
      if (!otherFactRef) throw new Error("other fact ref missing");
      expect(qqMemoryJobSourceAccess(h.db, otherFactRef, jobOwner(job.id), nowIso())).toBe(
        "revoked",
      );
      // 本 job scope 里真实存在、但没出现在 selected events 的成员 name ref：revoked。
      const scope = JSON.parse(JSON.stringify(otherLoaded.scope));
      const stranger = createQqMemberNameSource({ db: h.db, orm: h.orm }, scope, "10002", nowIso());
      if (!stranger) throw new Error("stranger name mint missing");
      expect(qqMemoryJobSourceAccess(h.db, stranger.source, jobOwner(job.id), nowIso())).toBe(
        "revoked",
      );
    } finally {
      h.business.close();
    }
  });

  it("private 正测：私聊任务照常冻结 scope、load 与发布", async () => {
    const h = setup();
    try {
      bind(h, { id: PRIVATE_BINDING_ID, kind: "private", peerId: "30001" });
      const eventKey = recordWithJournal(h, PRIVATE_BINDING_ID, privateObservation(-301));
      const job = enqueueJob(h.orm, [eventKey], scopeKeyOf("private", "30001"));
      const loaded = loadForJob(h, job);
      expect(loaded.records).toHaveLength(1);
      const privateRecord = loaded.records[0]?.record;
      if (!privateRecord) throw new Error("private fact record missing");
      expect(
        (privateRecord.parts as Array<{ kind: string; text?: string }>).some(
          (p) => p.kind === "text" && p.text === "私聊里说的事",
        ),
      ).toBe(true);
      verifyQqFactInputs({
        db: h.db,
        agentId: AGENT_ID,
        jobId: job.id,
        frozen: loaded,
        now: nowIso(),
      });

      const gateway = new WorkerGateway();
      gateway.replies = [VALID_DRAFT_JSON];
      const service = new MemoryService({
        orm: h.orm,
        db: h.db,
        gateway,
        pollIntervalMs: 5,
        heartbeatIntervalMs: 5,
        jobTimeoutMs: 2_000,
      });
      await service.runJob(job.id);
      const row = h.orm
        .select()
        .from(schema.memoryJobs)
        .where(eq(schema.memoryJobs.id, job.id))
        .get();
      expect(row?.status).toBe("succeeded");
      expect(entries(h.orm, AGENT_ID, undefined, { status: "active" })).toHaveLength(1);
      expect(
        h.orm
          .select()
          .from(schema.qqMemorySources)
          .all()
          .map((r) => r.eventKey),
      ).toEqual([eventKey]);
    } finally {
      h.business.close();
    }
  });

  it("publication 飞行中 fact 变化：同 tx 复验拒发布，正文无变化时照常发布", async () => {
    const h = setup();
    try {
      bind(h, { id: BINDING_ID, kind: "group", peerId: "30003" });
      const gateway = new WorkerGateway();
      const service = new MemoryService({
        orm: h.orm,
        db: h.db,
        gateway,
        pollIntervalMs: 5,
        heartbeatIntervalMs: 5,
        jobTimeoutMs: 2_000,
      });

      // 基线：无变化时任务成功并发布。
      const eventKey = recordWithJournal(h, BINDING_ID, groupObservation(-108));
      const okJob = enqueueJob(h.orm, [eventKey], scopeKeyOf("group", "30003"), "req_ok");
      gateway.resetReplies([VALID_DRAFT_JSON]);
      await service.runJob(okJob.id);
      const okRow = h.orm
        .select()
        .from(schema.memoryJobs)
        .where(eq(schema.memoryJobs.id, okJob.id))
        .get();
      expect(okRow?.status).toBe("succeeded");

      // 飞行中 facts revision 前进：generate 返回后的 publication 复验拒 → MEMORY_STATE_CONFLICT。
      const eventKey2 = recordWithJournal(h, BINDING_ID, groupObservation(-109, "第二条消息"));
      const flyingJob = enqueueJob(h.orm, [eventKey2], scopeKeyOf("group", "30003"), "req_flying");
      gateway.resetReplies(["block"]);
      const run = service.runJob(flyingJob.id);
      await waitUntil(() => gateway.blocked);
      h.db
        .query("UPDATE qq_message_facts SET revision=revision+1 WHERE event_key=?")
        .run(eventKey2);
      gateway.release();
      await run;

      const flyingRow = h.orm
        .select()
        .from(schema.memoryJobs)
        .where(eq(schema.memoryJobs.id, flyingJob.id))
        .get();
      expect(flyingRow?.status).toBe("failed");
      expect(flyingRow?.errorCode).toBe("MEMORY_STATE_CONFLICT");
      expect(flyingRow?.resultId).toBeNull();
      // 只有那一次在飞调用；解析后的结果没有继续发布。
      expect(gateway.calls).toHaveLength(2);
      expect(entries(h.orm, AGENT_ID, undefined, { status: "active" })).toHaveLength(1);
    } finally {
      h.business.close();
    }
  });
});
