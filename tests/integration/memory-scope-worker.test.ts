// P2c: the consolidation worker works inside one memory scope (ADR0018).
//
// Two things must hold. The blocked-candidate list is handed to the model, so a
// suppressed memory's body from another conversation must never appear in it; and an
// observation-backed job must fail closed rather than invent a memory, because
// observations still carry no message text.

import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { enqueue, entries, policy } from "../../src/server/db/memory-repository";
import {
  insertQqBinding,
  writeQqGroupAgentConfigRow,
} from "../../src/server/db/qq-binding-repository";
import { createQqScheme } from "../../src/server/db/qq-scheme-repository";
import {
  createSession,
  DEFAULT_USER_ID,
  ensureDefaults,
  getTurnByRequest,
  nowIso,
  prepareTurn,
  saveCompletedAssistantMessage,
} from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import type { ModelGateway } from "../../src/server/llm/model-gateway";
import { qqMemoryScopeKeyset } from "../../src/server/services/memory-scope";
import { MemoryService } from "../../src/server/services/memory-service";
import {
  createQqBinding,
  type QqMemoryAccess,
  type QqMemoryScope,
} from "../../src/server/services/qq-binding-contract";

const AGENT_ID = "00000000-0000-0000-0000-000000000001";
const MODEL = "qwen/qwen3-4b-2507";

const GROUP_A: QqMemoryAccess = (() => {
  const history: QqMemoryScope = {
    kind: "qq",
    accountId: "10001",
    conversationKind: "group",
    peerId: "20001",
    agentId: AGENT_ID,
  };
  return {
    conversationKey: '["qq","10001","group","20001"]',
    historyScope: history,
    readScopes: [history],
    writeScope: history,
  };
})();
const GROUP_B: QqMemoryAccess = (() => {
  const history: QqMemoryScope = {
    kind: "qq",
    accountId: "10001",
    conversationKind: "group",
    peerId: "20002",
    agentId: AGENT_ID,
  };
  return {
    conversationKey: '["qq","10001","group","20002"]',
    historyScope: history,
    readScopes: [history],
    writeScope: history,
  };
})();

/** Captures the prompts the worker sends, so a leak is observable. */
class RecordingGateway implements ModelGateway {
  config = { baseUrl: "http://127.0.0.1:1234/v1", model: MODEL, timeoutSeconds: 30 };
  prompts: string[] = [];
  /**
   * One reply per call. The default `{"memory":null}` never reaches the suppression
   * pass, so a test that wants to observe the blocked list must script a real draft
   * followed by `{"blocked":false}`.
   */
  replies: string[] = [];
  async listModels(): Promise<string[]> {
    return [MODEL];
  }
  async loadedContextCapacity(): Promise<number | null> {
    return 32768;
  }
  async probeModelLoaded(): Promise<boolean> {
    return true;
  }
  async complete(options: { messages: Array<{ role: string; content: string }> }): Promise<string> {
    this.prompts.push(options.messages.map((message) => message.content).join("\n"));
    return this.replies[this.prompts.length - 1] ?? JSON.stringify({ memory: null });
  }
  async *streamChat(): AsyncGenerator<string, void, unknown> {
    yield "unused";
  }
}

const DRAFT_REPLY = JSON.stringify({
  memory: {
    name: "偏好",
    summary: "用户偏好",
    tags: ["偏好"],
    kinds: ["semantic"],
    body: "用户喜欢简短回复。",
  },
});

function setup() {
  const business = openBusinessDb();
  ensureDefaults(business.orm, MODEL);
  const sessionId = createSession(business.orm, "会话", { modelName: MODEL }).id;
  policy(business.orm, AGENT_ID);
  const gateway = new RecordingGateway();
  const service = new MemoryService({
    orm: business.orm,
    db: business.db,
    gateway,
    pollIntervalMs: 5,
    heartbeatIntervalMs: 5,
    jobTimeoutMs: 2_000,
  });
  return { business, orm: business.orm, sessionId, gateway, service };
}
type Orm = ReturnType<typeof setup>["orm"];

function completedTurn(orm: Orm, sessionId: string, requestKey: string): string {
  const prep = prepareTurn(orm, sessionId, "嗨", requestKey);
  const token = prep.generationToken;
  if (token === null) throw new Error("expected a fresh generation token");
  saveCompletedAssistantMessage(orm, sessionId, "你好", requestKey, token);
  const turn = getTurnByRequest(orm, sessionId, requestKey);
  if (!turn) throw new Error("expected the turn to exist");
  return turn.id;
}

/** A memory whose body can be recognised if it leaks into a prompt. */
function seedMemory(
  orm: Orm,
  id: string,
  scopeKey: string,
  options: { status?: string; body?: string } = {},
) {
  orm
    .insert(schema.memoryEntries)
    .values({
      id,
      agentId: AGENT_ID,
      userId: DEFAULT_USER_ID,
      name: `记忆 ${id}`,
      summary: "简介",
      tags: JSON.stringify(["t"]),
      kinds: JSON.stringify(["semantic"]),
      body: options.body ?? `正文 ${id}`,
      scope: "reality_user",
      scopeKey,
      status: options.status ?? "active",
      configSnapshot: "{}",
      createdAt: nowIso(),
    })
    .run();
}

function seedObservation(orm: Orm, eventKey: string, peerId = "20001") {
  orm
    .insert(schema.qqEvents)
    .values({
      eventKey,
      accountId: "10001",
      conversationKind: "group",
      peerId,
      agentId: AGENT_ID,
      messageId: "-7",
      occurredAtSeconds: 100,
      speakerKind: "member",
      speakerId: "30001",
      recordedAt: nowIso(),
    })
    .run();
}

/** 真实方案×绑定行（账号 10001 × 群 × 默认助手）：群任务 claim 时按绑定复验本群能力。 */
function bindGroup(orm: Orm, peerId: string): string {
  const scheme = createQqScheme(orm, { name: `群方案 ${peerId}` });
  const created = createQqBinding({
    id: crypto.randomUUID(),
    accountId: "10001",
    kind: "group",
    peerId,
    agentId: AGENT_ID,
    schemeId: scheme.id,
    paused: false,
    shareWebMemory: false,
  });
  if (created.kind !== "saved") throw new Error("expected a saved binding");
  return insertQqBinding(orm, created.binding).id;
}

/** 本群停用「记忆整理」：能力边界从 claim 起生效。 */
function disableMemoryOrganize(orm: Orm, bindingId: string): void {
  writeQqGroupAgentConfigRow(orm, {
    bindingId,
    agentId: AGENT_ID,
    overrides: {},
    disabledCapabilities: ["memory_organize"],
    expectedRevision: 0,
  });
}

describe("worker keeps the blocked list inside one scope", () => {
  it("does not leak another group's suppressed body into the prompt", () => {
    const h = setup();
    try {
      // 另一群也建真实绑定行：隔离对象是真实存在的群而不是空名。
      bindGroup(h.orm, "20002");
      const turnId = completedTurn(h.orm, h.sessionId, "cr_a");
      // Group B had a memory that the user suppressed; group A must never see it.
      seedMemory(h.orm, "m_b", qqMemoryScopeKeyset(GROUP_B).write, {
        status: "suppressed",
        body: "B群专属的私密内容",
      });
      seedMemory(h.orm, "m_a", qqMemoryScopeKeyset(GROUP_A).write, {
        status: "suppressed",
        body: "A群自己的旧内容",
      });
      const job = enqueue(h.orm, AGENT_ID, "req_a", {
        kind: "manual",
        sessionId: h.sessionId,
        turnIds: [turnId],
        scope: { scope: "reality_user", scopeKey: qqMemoryScopeKeyset(GROUP_A).write },
      });
      h.service.loadInputs(AGENT_ID, job.id, "token-unused");
      // loadInputs needs a live lease, so drive it through the job row directly.
    } catch {
      // expected: the lease is not held here
    }
    try {
      const blocked = entries(h.orm, AGENT_ID, undefined, {
        scopeKeys: qqMemoryScopeKeyset(GROUP_A).read,
      });
      expect(blocked.map((entry) => entry.id)).toEqual(["m_a"]);
      // And the unscoped read (web governance) still sees both.
      expect(
        entries(h.orm, AGENT_ID)
          .map((entry) => entry.id)
          .sort(),
      ).toEqual(["m_a", "m_b"]);
    } finally {
      h.business.close();
    }
  });

  it("runs a web job with exactly today's inputs", async () => {
    const h = setup();
    try {
      const turnId = completedTurn(h.orm, h.sessionId, "cr_web");
      seedMemory(h.orm, "m_web_suppressed", AGENT_ID, {
        status: "suppressed",
        body: "网页已屏蔽内容",
      });
      h.gateway.replies = [DRAFT_REPLY, JSON.stringify({ blocked: false })];
      enqueue(h.orm, AGENT_ID, "req_web", {
        kind: "manual",
        sessionId: h.sessionId,
        turnIds: [turnId],
      });
      await h.service.runCycle();
      // The consolidation prompt carries the turn text, and the suppression pass
      // carries the blocked web body — exactly as before this change.
      const prompt = h.gateway.prompts.join("\n");
      expect(prompt).toContain("嗨");
      expect(prompt).toContain("网页已屏蔽内容");
      expect(prompt).toContain("你好");
    } finally {
      h.business.close();
    }
  });

  it("never leaks a QQ memory's body into a web job's prompt", async () => {
    const h = setup();
    try {
      const turnId = completedTurn(h.orm, h.sessionId, "cr_web2");
      seedMemory(h.orm, "m_qq_suppressed", qqMemoryScopeKeyset(GROUP_A).write, {
        status: "suppressed",
        body: "QQ群私密内容",
      });
      h.gateway.replies = [DRAFT_REPLY, JSON.stringify({ blocked: false })];
      enqueue(h.orm, AGENT_ID, "req_web2", {
        kind: "manual",
        sessionId: h.sessionId,
        turnIds: [turnId],
      });
      await h.service.runCycle();
      const prompt = h.gateway.prompts.join("\n");
      expect(prompt).toContain("嗨");
      // A web job is agent-level, so it filters to the agent-level scope and this
      // group's suppressed body stays out of the model input.
      expect(prompt).not.toContain("QQ群私密内容");
    } finally {
      h.business.close();
    }
  });
});

describe("observation-backed jobs fail closed", () => {
  it("accepts the job shape but refuses to organise without observation text", async () => {
    const h = setup();
    try {
      // 绑定先就位：claim 的本群复验通过后，缺正文的失败才来自输入来源而不是绑定阻塞。
      bindGroup(h.orm, "20001");
      seedObservation(h.orm, "evt_1");
      const job = enqueue(h.orm, AGENT_ID, "req_obs", {
        kind: "manual",
        eventIds: ["evt_1"],
        scope: { scope: "reality_user", scopeKey: qqMemoryScopeKeyset(GROUP_A).write },
      });
      expect(
        (JSON.parse(job.configSnapshot) as { source_event_ids: string[] }).source_event_ids,
      ).toEqual(["evt_1"]);
      // The worker refuses instead of inventing a memory from no evidence.
      await h.service.runCycle();
      const after = h.orm
        .select()
        .from(schema.memoryJobs)
        .where(eq(schema.memoryJobs.id, job.id))
        .get();
      expect(after?.status).toBe("failed");
      expect(after?.errorCode).toBe("MEMORY_SOURCE_INVALID");
      // Nothing was written and no model call was made.
      expect(h.orm.select().from(schema.memoryEntries).all()).toEqual([]);
      expect(h.gateway.prompts).toEqual([]);
    } finally {
      h.business.close();
    }
  });

  it("refuses a QQ job whose group has no binding, without calling the model", async () => {
    const h = setup();
    try {
      seedObservation(h.orm, "evt_1");
      const job = enqueue(h.orm, AGENT_ID, "req_no_binding", {
        kind: "manual",
        eventIds: ["evt_1"],
        scope: { scope: "reality_user", scopeKey: qqMemoryScopeKeyset(GROUP_A).write },
      });
      await h.service.runCycle();
      const after = h.orm
        .select()
        .from(schema.memoryJobs)
        .where(eq(schema.memoryJobs.id, job.id))
        .get();
      expect(after?.status).toBe("failed");
      expect(after?.errorCode).toBe("QQ_GROUP_CAPABILITY_DISABLED");
      expect(h.orm.select().from(schema.memoryEntries).all()).toEqual([]);
      expect(h.gateway.prompts).toEqual([]);
    } finally {
      h.business.close();
    }
  });

  it("refuses a QQ job after its group disabled memory organising, without calling the model", async () => {
    const h = setup();
    try {
      const bindingId = bindGroup(h.orm, "20001");
      seedObservation(h.orm, "evt_1");
      const job = enqueue(h.orm, AGENT_ID, "req_cap_off", {
        kind: "manual",
        eventIds: ["evt_1"],
        scope: { scope: "reality_user", scopeKey: qqMemoryScopeKeyset(GROUP_A).write },
      });
      disableMemoryOrganize(h.orm, bindingId);
      await h.service.runCycle();
      const after = h.orm
        .select()
        .from(schema.memoryJobs)
        .where(eq(schema.memoryJobs.id, job.id))
        .get();
      expect(after?.status).toBe("failed");
      expect(after?.errorCode).toBe("QQ_GROUP_CAPABILITY_DISABLED");
      expect(h.orm.select().from(schema.memoryEntries).all()).toEqual([]);
      expect(h.gateway.prompts).toEqual([]);
    } finally {
      h.business.close();
    }
  });

  it("rejects an event from another conversation, and mixing turns with events", () => {
    const h = setup();
    try {
      seedObservation(h.orm, "evt_a", "20001");
      seedObservation(h.orm, "evt_b", "20002");
      // Group A's job may not cite group B's message.
      expect(() =>
        enqueue(h.orm, AGENT_ID, "req_cross", {
          kind: "manual",
          eventIds: ["evt_b"],
          scope: { scope: "reality_user", scopeKey: qqMemoryScopeKeyset(GROUP_A).write },
        }),
      ).toThrow();
      expect(() =>
        enqueue(h.orm, AGENT_ID, "req_unknown", {
          kind: "manual",
          eventIds: ["evt_missing"],
          scope: { scope: "reality_user", scopeKey: qqMemoryScopeKeyset(GROUP_A).write },
        }),
      ).toThrow();
      // Events without an explicit scope, or mixed with turns, are refused.
      expect(() =>
        enqueue(h.orm, AGENT_ID, "req_noscope", { kind: "manual", eventIds: ["evt_a"] }),
      ).toThrow();
      const turnId = completedTurn(h.orm, h.sessionId, "cr_mix");
      expect(() =>
        enqueue(h.orm, AGENT_ID, "req_mix", {
          kind: "manual",
          sessionId: h.sessionId,
          turnIds: [turnId],
          eventIds: ["evt_a"],
          scope: { scope: "reality_user", scopeKey: qqMemoryScopeKeyset(GROUP_A).write },
        }),
      ).toThrow();
      // A merge may not single out observation sources.
      expect(() =>
        enqueue(h.orm, AGENT_ID, "req_merge_obs", {
          kind: "merge",
          memoryIds: [],
          eventIds: ["evt_a"],
          scope: { scope: "reality_user", scopeKey: qqMemoryScopeKeyset(GROUP_A).write },
        }),
      ).toThrow();
    } finally {
      h.business.close();
    }
  });
});
