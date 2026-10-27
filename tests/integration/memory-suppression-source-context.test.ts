import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import {
  assertContextSources,
  inspectContext,
  sourceAccess,
} from "../../src/server/agent/context-access";
import { createApp } from "../../src/server/app";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { claim, enqueue, govern, publish } from "../../src/server/db/memory-repository";
import { recordObservation } from "../../src/server/db/qq-observation-intake";
import {
  createSession,
  DEFAULT_AGENT_ID,
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
import { memoryRevision } from "../../src/server/services/memory-revision";
import { MemoryService } from "../../src/server/services/memory-service";
import { normalizeOneBotMessage } from "../../src/server/services/onebot-protocol";
import { enqueueQqMemory } from "../../src/server/services/qq-memory-enqueue";
import {
  qqSuppressionContextStates,
  qqSuppressionContexts,
} from "../../src/server/services/qq-memory-fact-input";

class Gateway implements ModelGateway {
  config = { baseUrl: "http://unused.invalid", model: "synthetic", timeoutSeconds: 30 };
  calls: Array<Parameters<ModelGateway["complete"]>[0]> = [];
  blocked = false;
  draftBody = "same preference";
  onDraft?: () => void;
  onSuppression?: () => void;
  async listModels() {
    return ["synthetic"];
  }
  async loadedContextCapacity() {
    return 32768;
  }
  async probeModelLoaded() {
    return true;
  }
  async complete(input: Parameters<ModelGateway["complete"]>[0]) {
    this.calls.push(input);
    if (input.responseSchema?.title === "SuppressionResult") {
      this.onSuppression?.();
      return JSON.stringify({ blocked: this.blocked });
    }
    this.onDraft?.();
    return JSON.stringify({
      memory: {
        name: "preference",
        summary: "same",
        tags: [],
        kinds: ["semantic"],
        body: this.draftBody,
      },
    });
  }
  async *streamChat() {
    yield "unused";
  }
}

function fixture() {
  const h = openBusinessDb();
  ensureDefaults(h.orm, "synthetic");
  const now = nowIso();
  const schemeId = crypto.randomUUID(),
    bindingId = crypto.randomUUID();
  h.orm
    .insert(schema.qqSchemes)
    .values({ id: schemeId, name: "synthetic", revision: 1, createdAt: now, updatedAt: now })
    .run();
  h.orm
    .insert(schema.qqBindings)
    .values({
      id: bindingId,
      accountId: "90001",
      conversationKind: "group",
      peerId: "30003",
      agentId: DEFAULT_AGENT_ID,
      schemeId,
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
  const journal = new ConversationEventRepository(h.db);
  if (!journal.ensureOneBot(bindingId)) throw new Error("missing QQ conversation");
  const scope = {
    kind: "qq" as const,
    accountId: "90001",
    conversationKind: "group" as const,
    peerId: "30003",
    agentId: DEFAULT_AGENT_ID,
  };
  const observe = (id: number, speaker: number, text = "same preference") => {
    const message = normalizeOneBotMessage(
      {
        time: Math.floor(Date.now() / 1000),
        self_id: 90001,
        post_type: "message",
        message_type: "group",
        sub_type: "normal",
        message_id: id,
        user_id: speaker,
        group_id: 30003,
        sender: { nickname: "synthetic" },
        message: [{ type: "text", data: { text } }],
      },
      "90001",
    );
    if (message.kind !== "message") throw new Error("bad observation");
    recordObservation(h.orm, message.observation, DEFAULT_AGENT_ID);
    journal.ingestOneBotEvent(message.observation.eventKey, bindingId);
    return message.observation.eventKey;
  };
  const enqueue = () =>
    enqueueQqMemory(h.orm, { scope, requestKey: crypto.randomUUID().replace(/-/g, ""), limit: 1 })!;
  return { h, observe, enqueue };
}

function webSource(h: ReturnType<typeof openBusinessDb>, sessionId: string, key: string) {
  const prepared = prepareTurn(h.orm, sessionId, key, key);
  saveCompletedAssistantMessage(h.orm, sessionId, "answer", key, prepared.generationToken!);
  const turn = getTurnByRequest(h.orm, sessionId, key)!;
  const messages = h.orm
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.turnId, turn.id))
    .all();
  const user = messages.find((item) => item.role === "user")!;
  const assistant = messages.find((item) => item.role === "assistant")!;
  return { turn, user, assistant };
}

function webBlocked(
  h: ReturnType<typeof openBusinessDb>,
  sessionId: string,
  id: string,
  body: string,
) {
  const source = webSource(h, sessionId, id);
  h.orm
    .insert(schema.memoryEntries)
    .values({
      id,
      agentId: DEFAULT_AGENT_ID,
      userId: DEFAULT_USER_ID,
      name: id,
      summary: id,
      tags: "[]",
      kinds: "[]",
      body,
      scope: "reality_user",
      scopeKey: DEFAULT_AGENT_ID,
      status: "suppressed",
      configSnapshot: "{}",
      createdAt: nowIso(),
      visibility: "session_private",
    })
    .run();
  h.orm
    .insert(schema.memorySources)
    .values({
      memoryId: id,
      turnId: source.turn.id,
      userMessageId: source.user.id,
      assistantMessageId: source.assistant.id,
      sequenceNo: source.user.sequenceNo,
    })
    .run();
  return source.turn.id;
}

describe("suppression source context", () => {
  it("does not let a stale job lease publish", () => {
    const f = fixture();
    try {
      f.observe(101, 20001);
      const job = f.enqueue();
      const claimed = f.h.orm.transaction((tx) => claim(tx, job.id), { behavior: "immediate" });
      if (!claimed?.token) throw new Error("missing claimed token");
      f.h.orm
        .update(schema.memoryJobs)
        .set({ token: "successor-token" })
        .where(eq(schema.memoryJobs.id, job.id))
        .run();
      expect(() =>
        f.h.orm.transaction(
          (tx) =>
            publish(tx, DEFAULT_AGENT_ID, job.id, claimed.token!, {
              name: "n",
              summary: "s",
              tags: [],
              kinds: ["semantic"],
              body: "body",
            }),
          { behavior: "immediate" },
        ),
      ).toThrow();
      expect(f.h.orm.select().from(schema.memoryEntries).all()).toEqual([]);
    } finally {
      f.h.close();
    }
  });

  it("uses only explicit merge-parent sources for blocked comparison", async () => {
    const h = openBusinessDb();
    try {
      ensureDefaults(h.orm, "synthetic");
      const a = createSession(h.orm, "A", { modelName: "synthetic" });
      const b = createSession(h.orm, "B", { modelName: "synthetic" });
      const parentA = webSource(h, a.id, "parent-a");
      const parentB = webSource(h, b.id, "parent-b");
      for (const [id, source] of [
        ["parent-a", parentA],
        ["parent-b", parentB],
      ] as const) {
        h.orm
          .insert(schema.memoryEntries)
          .values({
            id,
            agentId: DEFAULT_AGENT_ID,
            userId: DEFAULT_USER_ID,
            name: id,
            summary: id,
            tags: "[]",
            kinds: "[]",
            body: id,
            scope: "reality_user",
            scopeKey: DEFAULT_AGENT_ID,
            status: "active",
            configSnapshot: "{}",
            createdAt: nowIso(),
            visibility: "session_private",
          })
          .run();
        h.orm
          .insert(schema.memorySources)
          .values({
            memoryId: id,
            turnId: source.turn.id,
            userMessageId: source.user.id,
            assistantMessageId: source.assistant.id,
            sequenceNo: source.user.sequenceNo,
          })
          .run();
      }
      const parentSource = h.orm
        .select()
        .from(schema.memorySources)
        .where(eq(schema.memorySources.memoryId, "parent-a"))
        .get()!;
      h.orm
        .insert(schema.memoryEntries)
        .values({
          id: "merge-blocked",
          agentId: DEFAULT_AGENT_ID,
          userId: DEFAULT_USER_ID,
          name: "blocked",
          summary: "blocked",
          tags: "[]",
          kinds: "[]",
          body: "same preference",
          scope: "reality_user",
          scopeKey: DEFAULT_AGENT_ID,
          status: "suppressed",
          configSnapshot: "{}",
          createdAt: nowIso(),
          visibility: "session_private",
        })
        .run();
      h.orm
        .insert(schema.memorySources)
        .values({ ...parentSource, memoryId: "merge-blocked" })
        .run();
      webBlocked(h, b.id, "unselected-secret", "UNSELECTED-PRIVATE-SECRET");
      const job = enqueue(h.orm, DEFAULT_AGENT_ID, "merge-job", {
        kind: "merge",
        memoryIds: ["parent-a", "parent-b"],
      });
      const gateway = new Gateway();
      const service = new MemoryService({
        orm: h.orm,
        db: h.db,
        gateway,
        heartbeatIntervalMs: 5,
        jobTimeoutMs: 2000,
      });
      await service.runJob(job.id);
      const result = h.orm
        .select()
        .from(schema.memoryJobs)
        .where(eq(schema.memoryJobs.id, job.id))
        .get()!;
      expect(result.status).toBe("succeeded");
      expect(result.resultId).toBeNull();
      expect(JSON.stringify(gateway.calls)).not.toContain("UNSELECTED-PRIVATE-SECRET");
    } finally {
      h.close();
    }
  });

  it("does not send Web blocked body after its source changes during consolidation", async () => {
    const h = openBusinessDb();
    try {
      ensureDefaults(h.orm, "synthetic");
      const a = createSession(h.orm, "A", { modelName: "synthetic" });
      const oldTurn = webBlocked(h, a.id, "web-blocked", "OLD-WEB-BLOCKED-SECRET");
      const candidate = webSource(h, a.id, "web-candidate");
      const job = enqueue(h.orm, DEFAULT_AGENT_ID, "web-source-change", {
        kind: "manual",
        sessionId: a.id,
        turnIds: [candidate.turn.id],
      });
      const gateway = new Gateway();
      gateway.draftBody = "unrelated new fact";
      gateway.onDraft = () => h.db.query("UPDATE turns SET source_valid=0 WHERE id=?").run(oldTurn);
      const service = new MemoryService({
        orm: h.orm,
        db: h.db,
        gateway,
        heartbeatIntervalMs: 5,
        jobTimeoutMs: 2000,
      });
      await service.runJob(job.id);
      expect(
        h.orm.select().from(schema.memoryJobs).where(eq(schema.memoryJobs.id, job.id)).get()!
          .status,
      ).toBe("failed");
      expect(
        gateway.calls.filter((call) => call.responseSchema?.title === "SuppressionResult"),
      ).toHaveLength(0);
      expect(JSON.stringify(gateway.calls)).not.toContain("OLD-WEB-BLOCKED-SECRET");
    } finally {
      h.close();
    }
  });

  it("keeps Web blocked facts within the current source session", async () => {
    const h = openBusinessDb();
    try {
      ensureDefaults(h.orm, "synthetic");
      const a = createSession(h.orm, "A", { modelName: "synthetic" });
      const b = createSession(h.orm, "B", { modelName: "synthetic" });
      webBlocked(h, a.id, "own-blocked", "same preference");
      webBlocked(h, b.id, "foreign-blocked", "FOREIGN-WEB-SECRET");
      const candidate = webSource(h, a.id, "candidate");
      const job = enqueue(h.orm, DEFAULT_AGENT_ID, "web-job", {
        kind: "manual",
        sessionId: a.id,
        turnIds: [candidate.turn.id],
      });
      const gateway = new Gateway();
      const service = new MemoryService({
        orm: h.orm,
        db: h.db,
        gateway,
        heartbeatIntervalMs: 5,
        jobTimeoutMs: 2000,
      });
      await service.runJob(job.id);
      const result = h.orm
        .select()
        .from(schema.memoryJobs)
        .where(eq(schema.memoryJobs.id, job.id))
        .get()!;
      expect(result.status).toBe("succeeded");
      expect(result.resultId).toBeNull();
      expect(JSON.stringify(gateway.calls)).not.toContain("FOREIGN-WEB-SECRET");
      expect(gateway.calls).toHaveLength(1);
    } finally {
      h.close();
    }
  });

  it("projects 1, 32 and 400 distinct same-scope sources without per-entry SQL", async () => {
    const f = fixture();
    try {
      const gateway = new Gateway();
      const service = new MemoryService({
        orm: f.h.orm,
        db: f.h.db,
        gateway,
        heartbeatIntervalMs: 5,
        jobTimeoutMs: 2000,
      });
      f.observe(101, 20001);
      const first = f.enqueue();
      await service.runJob(first.id);
      const firstJob = f.h.orm
        .select()
        .from(schema.memoryJobs)
        .where(eq(schema.memoryJobs.id, first.id))
        .get()!;
      if (!firstJob.resultId) throw new Error("missing first memory");
      f.h.orm.transaction((tx) => govern(tx, DEFAULT_AGENT_ID, [firstJob.resultId!], "suppress"), {
        behavior: "immediate",
      });
      f.observe(102, 20002);
      const job = f.enqueue();
      await service.runJob(job.id);
      const template = f.h.orm
        .select()
        .from(schema.memoryEntries)
        .where(eq(schema.memoryEntries.id, firstJob.resultId))
        .get()!;
      const originalSource = f.h.orm
        .select()
        .from(schema.qqMemorySources)
        .where(eq(schema.qqMemorySources.memoryId, template.id))
        .get()!;
      const ids: string[] = [];
      for (let index = 0; index < 400; index++) {
        const eventKey = f.observe(1000 + index, 20001);
        const event = f.h.orm
          .select()
          .from(schema.qqEvents)
          .where(eq(schema.qqEvents.eventKey, eventKey))
          .get()!;
        const id = `blocked-${index}`;
        f.h.orm
          .insert(schema.memoryEntries)
          .values({ ...template, id })
          .run();
        f.h.orm
          .insert(schema.qqMemorySources)
          .values({
            ...originalSource,
            memoryId: id,
            eventKey,
            messageId: event.messageId,
            occurredAtSeconds: event.occurredAtSeconds,
            speakerKind: event.speakerKind,
            speakerId: event.speakerId,
          })
          .run();
        ids.push(id);
      }
      const owner = {
        kind: "memory_job",
        id: job.id,
        userId: DEFAULT_USER_ID,
        agentId: DEFAULT_AGENT_ID,
      };
      const warm = qqSuppressionContexts(f.h, job.id, DEFAULT_AGENT_ID, ids.slice(0, 1), nowIso());
      qqSuppressionContextStates(
        f.h,
        [...warm.values()].map((value) => value.ref),
        owner,
        { userId: DEFAULT_USER_ID },
        nowIso(),
      );
      const query = f.h.db.query;
      const prepare = f.h.db.prepare;
      const wrapped = new WeakSet<object>();
      const calls: string[] = [];
      const trace = (sql: string, statement: ReturnType<typeof f.h.db.query>) => {
        if (wrapped.has(statement) || !/^\s*select\b/i.test(sql)) return statement;
        const proxy = new Proxy(statement, {
          get(target, key) {
            const value = Reflect.get(target, key, target);
            if (key === "get" || key === "all" || key === "values")
              return (...args: unknown[]) => {
                calls.push(sql.replace(/\s+/g, " ").trim());
                return Reflect.apply(value, target, args);
              };
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        wrapped.add(proxy);
        return proxy;
      };
      f.h.db.query = ((sql: string, ...args: unknown[]) =>
        trace(sql, Reflect.apply(query, f.h.db, [sql, ...args]))) as typeof f.h.db.query;
      f.h.db.prepare = ((sql: string, ...args: unknown[]) =>
        trace(sql, Reflect.apply(prepare, f.h.db, [sql, ...args]))) as typeof f.h.db.prepare;
      try {
        calls.length = 0;
        expect(qqSuppressionContexts(f.h, job.id, DEFAULT_AGENT_ID, [], nowIso()).size).toBe(0);
        expect(
          qqSuppressionContextStates(f.h, [], owner, { userId: DEFAULT_USER_ID }, nowIso()),
        ).toEqual([]);
        expect(calls).toHaveLength(0);
        const work = [1, 32, 400].map((size) => {
          calls.length = 0;
          const contexts = qqSuppressionContexts(
            f.h,
            job.id,
            DEFAULT_AGENT_ID,
            ids.slice(0, size),
            nowIso(),
          );
          const projection = [...calls];
          calls.length = 0;
          const states = qqSuppressionContextStates(
            f.h,
            [...contexts.values()].map((value) => value.ref),
            owner,
            { userId: DEFAULT_USER_ID },
            nowIso(),
          );
          const validation = [...calls];
          const countFactReads = (sql: string[]) =>
            sql.filter((text) => /\b(?:from|join)\s+["`]?qq_message_facts\b/i.test(text)).length;
          return {
            size: contexts.size,
            states: states.filter((state) => state === "available").length,
            projectionCount: projection.length,
            validationCount: validation.length,
            projectionFactReads: countFactReads(projection),
            validationFactReads: countFactReads(validation),
          };
        });
        console.log(JSON.stringify({ fixture: "suppression-batch-work", work }));
        expect(work.map((entry) => entry.size)).toEqual([1, 32, 400]);
        expect(work.map((entry) => entry.states)).toEqual([1, 32, 400]);
        expect(
          work.every(
            (entry) =>
              entry.projectionCount > 0 &&
              entry.validationCount > 0 &&
              entry.projectionFactReads > 0 &&
              entry.validationFactReads > 0,
          ),
        ).toBe(true);
        expect(work[1]!.projectionFactReads).toBe(work[0]!.projectionFactReads);
        expect(work[2]!.projectionFactReads).toBe(work[0]!.projectionFactReads);
        expect(work[1]!.validationFactReads).toBe(work[0]!.validationFactReads);
        expect(work[2]!.validationFactReads).toBe(work[0]!.validationFactReads);
      } finally {
        f.h.db.query = query;
        f.h.db.prepare = prepare;
      }
    } finally {
      f.h.close();
    }
  });

  it("does not inherit the correction entry's speaker for rejected content", async () => {
    const f = fixture();
    try {
      const gateway = new Gateway();
      const service = new MemoryService({
        orm: f.h.orm,
        db: f.h.db,
        gateway,
        heartbeatIntervalMs: 5,
        jobTimeoutMs: 2000,
      });
      f.observe(101, 20001);
      const first = f.enqueue();
      await service.runJob(first.id);
      const job = f.h.orm
        .select()
        .from(schema.memoryJobs)
        .where(eq(schema.memoryJobs.id, first.id))
        .get()!;
      if (!job.resultId) throw new Error("missing first memory");
      const entry = f.h.orm
        .select()
        .from(schema.memoryEntries)
        .where(eq(schema.memoryEntries.id, job.resultId))
        .get()!;
      const app = createApp({ business: f.h, externalActions: () => [] });
      const corrected = await app.request(
        `/agents/${DEFAULT_AGENT_ID}/memory/entries/${entry.id}/correct`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            expected_revision: memoryRevision(entry),
            name: "corrected",
            summary: "corrected",
            tags: [],
            body: "replacement",
          }),
        },
      );
      expect(corrected.status).toBe(201);
      f.observe(102, 20002);
      gateway.calls.length = 0;
      const next = f.enqueue();
      await service.runJob(next.id);
      const after = f.h.orm
        .select()
        .from(schema.memoryJobs)
        .where(eq(schema.memoryJobs.id, next.id))
        .get()!;
      expect(after.status).toBe("succeeded");
      expect(after.resultId).toBeNull();
      expect(gateway.calls).toHaveLength(1);
      f.observe(103, 20002);
      gateway.calls.length = 0;
      gateway.draftBody = "unrelated candidate";
      const unknown = f.enqueue();
      await service.runJob(unknown.id);
      const unavailable = f.h.orm
        .select()
        .from(schema.memoryJobs)
        .where(eq(schema.memoryJobs.id, unknown.id))
        .get()!;
      expect(unavailable.status).toBe("succeeded");
      expect(unavailable.resultId).not.toBeNull();
      expect(
        gateway.calls.filter((call) => call.responseSchema?.title === "SuppressionResult"),
      ).toHaveLength(1);
    } finally {
      f.h.close();
    }
  });

  it("does not send rejected content after its containing entry source expires during consolidation", async () => {
    const f = fixture();
    try {
      const gateway = new Gateway();
      const service = new MemoryService({
        orm: f.h.orm,
        db: f.h.db,
        gateway,
        heartbeatIntervalMs: 5,
        jobTimeoutMs: 2000,
      });
      const oldEvent = f.observe(101, 20001);
      const first = f.enqueue();
      await service.runJob(first.id);
      const job = f.h.orm
        .select()
        .from(schema.memoryJobs)
        .where(eq(schema.memoryJobs.id, first.id))
        .get()!;
      if (!job.resultId) throw new Error("missing first memory");
      const entry = f.h.orm
        .select()
        .from(schema.memoryEntries)
        .where(eq(schema.memoryEntries.id, job.resultId))
        .get()!;
      const app = createApp({ business: f.h, externalActions: () => [] });
      expect(
        (
          await app.request(`/agents/${DEFAULT_AGENT_ID}/memory/entries/${entry.id}/correct`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              expected_revision: memoryRevision(entry),
              name: "corrected",
              summary: "corrected",
              tags: [],
              body: "replacement",
            }),
          })
        ).status,
      ).toBe(201);
      f.observe(102, 20002);
      gateway.calls.length = 0;
      gateway.draftBody = "unrelated candidate";
      gateway.onDraft = () =>
        f.h.db
          .query("UPDATE qq_message_facts SET expires_at='2020-01-01T00:00:00Z' WHERE event_key=?")
          .run(oldEvent);
      const next = f.enqueue();
      await service.runJob(next.id);
      expect(
        f.h.orm.select().from(schema.memoryJobs).where(eq(schema.memoryJobs.id, next.id)).get()!
          .status,
      ).toBe("failed");
      expect(
        gateway.calls.filter((call) => call.responseSchema?.title === "SuppressionResult"),
      ).toHaveLength(0);
    } finally {
      f.h.close();
    }
  });

  it("does not send unknown QQ blocked body after its source expires during consolidation", async () => {
    const f = fixture();
    try {
      const gateway = new Gateway();
      const service = new MemoryService({
        orm: f.h.orm,
        db: f.h.db,
        gateway,
        heartbeatIntervalMs: 5,
        jobTimeoutMs: 2000,
      });
      const oldEvent = f.observe(101, 20001);
      const first = f.enqueue();
      await service.runJob(first.id);
      const completed = f.h.orm
        .select()
        .from(schema.memoryJobs)
        .where(eq(schema.memoryJobs.id, first.id))
        .get()!;
      if (!completed.resultId) throw new Error("missing first memory");
      f.h.orm.transaction((tx) => govern(tx, DEFAULT_AGENT_ID, [completed.resultId!], "suppress"), {
        behavior: "immediate",
      });
      const otherEvent = f.observe(102, 20002);
      const second = f.h.orm
        .select()
        .from(schema.qqEvents)
        .where(eq(schema.qqEvents.eventKey, otherEvent))
        .get()!;
      const original = f.h.orm
        .select()
        .from(schema.qqMemorySources)
        .where(eq(schema.qqMemorySources.memoryId, completed.resultId))
        .get()!;
      f.h.orm
        .insert(schema.qqMemorySources)
        .values({
          ...original,
          eventKey: otherEvent,
          messageId: second.messageId,
          occurredAtSeconds: second.occurredAtSeconds,
          speakerKind: second.speakerKind,
          speakerId: second.speakerId,
        })
        .run();
      const next = f.enqueue();
      gateway.calls.length = 0;
      gateway.draftBody = "unrelated new fact";
      gateway.onDraft = () =>
        f.h.db
          .query("UPDATE qq_message_facts SET expires_at='2020-01-01T00:00:00Z' WHERE event_key=?")
          .run(oldEvent);
      await service.runJob(next.id);
      const result = f.h.orm
        .select()
        .from(schema.memoryJobs)
        .where(eq(schema.memoryJobs.id, next.id))
        .get()!;
      expect(result.status).toBe("failed");
      expect(
        gateway.calls.filter((call) => call.responseSchema?.title === "SuppressionResult"),
      ).toHaveLength(0);
      expect(JSON.stringify(gateway.calls)).not.toContain("source_context");
    } finally {
      f.h.close();
    }
  });

  it("does not publish after a blocked source expires during semantic comparison", async () => {
    const f = fixture();
    try {
      const gateway = new Gateway();
      const service = new MemoryService({
        orm: f.h.orm,
        db: f.h.db,
        gateway,
        heartbeatIntervalMs: 5,
        jobTimeoutMs: 2000,
      });
      const oldEvent = f.observe(101, 20001);
      const first = f.enqueue();
      await service.runJob(first.id);
      const completed = f.h.orm
        .select()
        .from(schema.memoryJobs)
        .where(eq(schema.memoryJobs.id, first.id))
        .get()!;
      if (!completed.resultId) throw new Error("missing first memory");
      f.h.orm.transaction((tx) => govern(tx, DEFAULT_AGENT_ID, [completed.resultId!], "suppress"), {
        behavior: "immediate",
      });
      f.observe(102, 20002);
      gateway.onSuppression = () => {
        f.h.db
          .query("UPDATE qq_message_facts SET expires_at='2020-01-01T00:00:00Z' WHERE event_key=?")
          .run(oldEvent);
      };
      const next = f.enqueue();
      await service.runJob(next.id);
      const after = f.h.orm
        .select()
        .from(schema.memoryJobs)
        .where(eq(schema.memoryJobs.id, next.id))
        .get()!;
      expect(after.status).toBe("failed");
      expect(after.resultId).toBeNull();
    } finally {
      f.h.close();
    }
  });

  it("keeps a same-speaker collision on the conservative shortcut", async () => {
    const f = fixture();
    try {
      const gateway = new Gateway();
      const service = new MemoryService({
        orm: f.h.orm,
        db: f.h.db,
        gateway,
        heartbeatIntervalMs: 5,
        jobTimeoutMs: 2000,
      });
      f.observe(101, 20001);
      const first = f.enqueue();
      await service.runJob(first.id);
      const result = f.h.orm
        .select()
        .from(schema.memoryJobs)
        .where(eq(schema.memoryJobs.id, first.id))
        .get()!;
      if (!result.resultId) throw new Error("missing first memory");
      f.h.orm.transaction((tx) => govern(tx, DEFAULT_AGENT_ID, [result.resultId!], "suppress"), {
        behavior: "immediate",
      });
      f.observe(102, 20001);
      gateway.calls.length = 0;
      const next = f.enqueue();
      await service.runJob(next.id);
      const after = f.h.orm
        .select()
        .from(schema.memoryJobs)
        .where(eq(schema.memoryJobs.id, next.id))
        .get()!;
      expect(after.status).toBe("succeeded");
      expect(after.resultId).toBeNull();
      expect(gateway.calls).toHaveLength(1);
    } finally {
      f.h.close();
    }
  });

  it.each([false, true])(
    "routes different verified speakers to the original comparator blocked=%s",
    async (blocked) => {
      const f = fixture();
      try {
        const gateway = new Gateway();
        const service = new MemoryService({
          orm: f.h.orm,
          db: f.h.db,
          gateway,
          heartbeatIntervalMs: 5,
          jobTimeoutMs: 2000,
        });
        f.observe(101, 20001, blocked ? "third person likes tea" : "I like tea");
        const first = f.enqueue();
        await service.runJob(first.id);
        const completed = f.h.orm
          .select()
          .from(schema.memoryJobs)
          .where(eq(schema.memoryJobs.id, first.id))
          .get()!;
        expect(completed.status).toBe("succeeded");
        if (!completed.resultId) throw new Error("missing first memory");
        f.h.orm.transaction(
          (tx) => govern(tx, DEFAULT_AGENT_ID, [completed.resultId!], "suppress"),
          { behavior: "immediate" },
        );
        f.observe(102, 20002, blocked ? "third person likes tea" : "I like tea");
        gateway.calls.length = 0;
        gateway.blocked = blocked;
        const next = f.enqueue();
        await service.runJob(next.id);
        const result = f.h.orm
          .select()
          .from(schema.memoryJobs)
          .where(eq(schema.memoryJobs.id, next.id))
          .get()!;
        expect(result.status).toBe("succeeded");
        expect(Boolean(result.resultId)).toBe(!blocked);
        expect(gateway.calls).toHaveLength(2);
        const contexts = qqSuppressionContexts(
          f.h,
          next.id,
          DEFAULT_AGENT_ID,
          [completed.resultId],
          nowIso(),
        );
        const ref = contexts.get(completed.resultId)?.ref;
        if (!ref) throw new Error("missing suppression context ref");
        const owner = {
          kind: "memory_job",
          id: next.id,
          userId: DEFAULT_USER_ID,
          agentId: DEFAULT_AGENT_ID,
        };
        expect(sourceAccess(f.h.db, ref, owner, { userId: DEFAULT_USER_ID }, nowIso())).toBe(
          "available",
        );
        const expiredCap = { ...ref, expiresAt: "2020-01-01T00:00:00Z" };
        expect(sourceAccess(f.h.db, expiredCap, owner, { userId: DEFAULT_USER_ID }, nowIso())).toBe(
          "expired",
        );
        expect(sourceAccess(f.h.db, expiredCap, owner, { userId: "foreign" }, nowIso())).toBe(
          "revoked",
        );
        expect(
          sourceAccess(
            f.h.db,
            ref,
            { ...owner, id: first.id },
            { userId: DEFAULT_USER_ID },
            nowIso(),
          ),
        ).toBe("revoked");
        expect(sourceAccess(f.h.db, ref, owner, { userId: "foreign" }, nowIso())).toBe("revoked");
        expect(
          sourceAccess(
            f.h.db,
            ref,
            { ...owner, agentId: "foreign" },
            { userId: DEFAULT_USER_ID },
            nowIso(),
          ),
        ).toBe("revoked");
        const runs = new AgentRunRepository(f.h.db);
        const runId = crypto.randomUUID(),
          stepId = crypto.randomUUID();
        runs.createRun({ runId, specId: "suppression", specVersion: "1", owner, at: nowIso() });
        runs.startStep({
          runId,
          stepId,
          stepNo: 1,
          model: "synthetic",
          phase: "leaf",
          at: nowIso(),
          messages: [{ role: "user", content: [{ kind: "text", text: "source context" }] }],
          sources: [ref],
        });
        const handle = { runId, stepId };
        expect(inspectContext(f.h.db, runs, handle, { userId: DEFAULT_USER_ID })?.status).toBe(
          "exact",
        );
        for (const eventKey of contexts.get(completed.resultId)!.sourceIds)
          f.h.db
            .query(
              "UPDATE qq_message_facts SET expires_at='2020-01-01T00:00:00Z' WHERE event_key=?",
            )
            .run(eventKey);
        expect(sourceAccess(f.h.db, ref, owner, { userId: DEFAULT_USER_ID }, nowIso())).toBe(
          "revoked",
        );
        expect(
          inspectContext(
            f.h.db,
            runs,
            handle,
            { userId: DEFAULT_USER_ID },
            nowIso(),
            () => "available",
          )?.status,
        ).toBe("revoked");
        expect(() =>
          assertContextSources({
            db: f.h.db,
            sources: [ref],
            owner,
            now: nowIso(),
            resolveSource: () => "available",
            memoryRevisions: () => new Map(),
            messages: { memory: "denied", other: "denied" },
          }),
        ).toThrow();
      } finally {
        f.h.close();
      }
    },
  );
});
