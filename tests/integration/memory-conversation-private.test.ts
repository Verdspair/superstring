import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { memoryRevisionsForSession } from "../../src/server/db/context-repository";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import {
  createSession,
  DEFAULT_AGENT_ID,
  DEFAULT_USER_ID,
  deleteSession,
  ensureDefaults,
  getAgentRow,
  getTurnByRequest,
  nowIso,
  prepareTurn,
  saveCompletedAssistantMessage,
} from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { SqliteMemoryModule } from "../../src/server/modules/memory-module";
import { runtimeFromAgent } from "../../src/server/services/runtime-config";
import type { Evidence } from "../../src/shared/contracts/evidence";

const MODEL = "synthetic";
type Orm = ReturnType<typeof openBusinessDb>["orm"];

function source(orm: Orm, memoryId: string, sessionId: string, request: string) {
  const prepared = prepareTurn(orm, sessionId, `question ${request}`, request);
  if (!prepared.generationToken) throw new Error("missing generation token");
  saveCompletedAssistantMessage(
    orm,
    sessionId,
    `answer ${request}`,
    request,
    prepared.generationToken,
  );
  const turn = getTurnByRequest(orm, sessionId, request);
  if (!turn) throw new Error("missing source turn");
  const messages = orm
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.turnId, turn.id))
    .all();
  const user = messages.find((message) => message.role === "user");
  const assistant = messages.find((message) => message.role === "assistant");
  if (!user || !assistant) throw new Error("missing source messages");
  orm
    .insert(schema.memorySources)
    .values({
      memoryId,
      turnId: turn.id,
      userMessageId: user.id,
      assistantMessageId: assistant.id,
      sequenceNo: user.sequenceNo,
    })
    .run();
  return turn.id;
}

function entry(orm: Orm, id: string) {
  orm
    .insert(schema.memoryEntries)
    .values({
      id,
      agentId: DEFAULT_AGENT_ID,
      userId: DEFAULT_USER_ID,
      name: `memory ${id}`,
      summary: `summary ${id}`,
      tags: "[]",
      kinds: '["semantic"]',
      body: `body ${id}`,
      scope: "reality_user",
      scopeKey: DEFAULT_AGENT_ID,
      status: "active",
      configSnapshot: "{}",
      createdAt: nowIso(),
    })
    .run();
}

function traceSelects<T>(f: ReturnType<typeof fixture>, run: () => T): { value: T; sql: string[] } {
  const db = f.business.db;
  const query = db.query;
  const prepare = db.prepare;
  const wrapped = new WeakSet<object>();
  const sql: string[] = [];
  const normalize = (statement: string) =>
    statement
      .replace(/\s+/g, " ")
      .replace(/IN \((?:\?, ?)+\?\)/gi, "IN (?)")
      .trim();
  const trace = (statementSql: string, statement: ReturnType<typeof db.query>) => {
    if (wrapped.has(statement) || !/^\s*select\b/i.test(statementSql)) return statement;
    const proxy = new Proxy(statement, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (key === "get" || key === "all" || key === "values") {
          return (...args: unknown[]) => {
            sql.push(normalize(statementSql));
            return Reflect.apply(value, target, args);
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    wrapped.add(proxy);
    return proxy;
  };
  db.query = ((statementSql: string, ...args: unknown[]) =>
    trace(statementSql, Reflect.apply(query, db, [statementSql, ...args]))) as typeof db.query;
  db.prepare = ((statementSql: string, ...args: unknown[]) =>
    trace(statementSql, Reflect.apply(prepare, db, [statementSql, ...args]))) as typeof db.prepare;
  try {
    return { value: run(), sql };
  } finally {
    db.query = query;
    db.prepare = prepare;
  }
}

function selectCounts(sql: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const statement of sql) {
    const from = statement.match(/\b(?:from|join)\s+[`"']?([a-z_]+)[`"']?/gi) ?? [];
    for (const item of from) {
      const table = item
        .replace(/^.*\s+/i, "")
        .replace(/[`"']/g, "")
        .toLowerCase();
      counts.set(table, (counts.get(table) ?? 0) + 1);
    }
  }
  return counts;
}

function fixture() {
  const business = openBusinessDb();
  const orm = business.orm;
  ensureDefaults(orm, MODEL);
  const a = createSession(orm, "A", { modelName: MODEL }).id;
  const b = createSession(orm, "B", { modelName: MODEL }).id;
  const journal = new ConversationEventRepository(business.db);
  const conversationA = journal.ensureWeb(a);
  const conversationB = journal.ensureWeb(b);
  if (!conversationA || !conversationB) throw new Error("missing canonical conversations");
  const conversationId = (sessionId: string) =>
    sessionId === a ? conversationA.id : conversationB.id;
  entry(orm, "m_a");
  const turnA = source(orm, "m_a", a, "source_a");
  entry(orm, "m_b");
  const turnB = source(orm, "m_b", b, "source_b");
  entry(orm, "m_mixed");
  source(orm, "m_mixed", a, "mixed_a");
  source(orm, "m_mixed", b, "mixed_b");
  entry(orm, "m_unknown");
  const agent = getAgentRow(orm, DEFAULT_AGENT_ID);
  if (!agent) throw new Error("missing agent");
  const runtime = runtimeFromAgent(agent);
  const memory = new SqliteMemoryModule({ orm, runtime: () => runtime });
  const owner = (session: string) => ({
    kind: "web_turn" as const,
    id: session === a ? turnA : turnB,
    agentId: DEFAULT_AGENT_ID,
    userId: DEFAULT_USER_ID,
  });
  const query = (sessionId: string) =>
    memory.query({
      agentId: DEFAULT_AGENT_ID,
      sessionId,
      conversationId: conversationId(sessionId),
      owner: owner(sessionId),
      scopes: null,
      query: "",
      budget: 65536,
    });
  const read = (sessionId: string, evidence: Evidence) =>
    memory.read({
      agentId: DEFAULT_AGENT_ID,
      sessionId,
      conversationId: conversationId(sessionId),
      owner: owner(sessionId),
      scopes: null,
      evidence,
      offset: 0,
      limit: 4096,
    });
  return { business, orm, a, b, query, read };
}

describe("Web memory defaults to the current conversation", () => {
  it("finds and reads an intact memory sourced only in the current session", async () => {
    const f = fixture();
    try {
      const page = await f.query(f.a);
      const item = page.items.find((candidate) => candidate.id === "m_a");
      expect(item).toBeDefined();
      if (!item) throw new Error("same-session memory not returned");
      expect((await f.read(f.a, item)).text).toBe("body m_a");
    } finally {
      f.business.close();
    }
  });

  it("does not list the same Agent's other session memory", async () => {
    const f = fixture();
    try {
      expect((await f.query(f.a)).items.map((item) => item.id)).not.toContain("m_b");
      expect((await f.query(f.b)).items.map((item) => item.id)).not.toContain("m_a");
    } finally {
      f.business.close();
    }
  });

  it("keeps the opposite direction private when reading from session B", async () => {
    const f = fixture();
    try {
      expect((await f.query(f.b)).items.map((item) => item.id)).toContain("m_b");
      expect((await f.query(f.b)).items.map((item) => item.id)).not.toContain("m_a");
    } finally {
      f.business.close();
    }
  });

  it("refuses a previously obtained other-session evidence body", async () => {
    const f = fixture();
    try {
      const item = (await f.query(f.b)).items.find((candidate) => candidate.id === "m_b");
      if (!item) throw new Error("source-session memory not returned");
      await expect(f.read(f.a, item)).rejects.toThrow();
    } finally {
      f.business.close();
    }
  });

  it("does not list a memory with sources from both sessions", async () => {
    const f = fixture();
    try {
      const page = await f.query(f.a);
      expect(page.items.map((item) => item.id)).not.toContain("m_mixed");
    } finally {
      f.business.close();
    }
  });

  it("rejects a mixed Web and QQ source at catalog, direct read and batch revalidation", async () => {
    const f = fixture();
    try {
      const item = (await f.query(f.a)).items.find((candidate) => candidate.id === "m_a");
      if (!item) throw new Error("pure Web memory not returned");
      expect((await f.read(f.a, item)).text).toBe("body m_a");
      const scopeKey = JSON.stringify(["qq", "10001", "group", "20001", DEFAULT_AGENT_ID]);
      f.orm
        .insert(schema.qqEvents)
        .values({
          eventKey: "qq-event-mixed",
          accountId: "10001",
          conversationKind: "group",
          peerId: "20001",
          agentId: DEFAULT_AGENT_ID,
          messageId: "qq-message-mixed",
          occurredAtSeconds: 123,
          speakerKind: "member",
          speakerId: "20002",
          recordedAt: nowIso(),
        })
        .run();
      f.orm
        .insert(schema.qqMemorySources)
        .values({
          memoryId: "m_a",
          eventKey: "qq-event-mixed",
          scopeKey,
          conversationKey: JSON.stringify(["qq", "10001", "group", "20001"]),
          messageId: "qq-message-mixed",
          occurredAtSeconds: 123,
          speakerKind: "member",
          speakerId: "20002",
        })
        .run();
      expect((await f.query(f.a)).items.map((candidate) => candidate.id)).not.toContain("m_a");
      await expect(f.read(f.a, item)).rejects.toThrow();
      expect(memoryRevisionsForSession(f.orm, DEFAULT_AGENT_ID, f.a, ["m_a"])).toEqual(new Map());
    } finally {
      f.business.close();
    }
  });

  it("fails closed for a memory with no provable source", async () => {
    const f = fixture();
    try {
      expect((await f.query(f.a)).items.map((item) => item.id)).not.toContain("m_unknown");
    } finally {
      f.business.close();
    }
  });

  it("does not make a mixed memory eligible after deleting the foreign source session", async () => {
    const f = fixture();
    try {
      deleteSession(f.business.orm, f.b);
      expect((await f.query(f.a)).items.map((item) => item.id)).not.toContain("m_mixed");
    } finally {
      f.business.close();
    }
  });

  it("batch-validates memory revisions with empty zero-work and all-or-nothing results", () => {
    const f = fixture();
    try {
      const empty = traceSelects(f, () =>
        memoryRevisionsForSession(f.orm, DEFAULT_AGENT_ID, f.a, []),
      );
      expect(empty.value).toEqual(new Map());
      expect(empty.sql).toEqual([]);
      const bulkIds = Array.from({ length: 400 }, (_, index) => `m_bulk_${index}`);
      for (const id of bulkIds) {
        entry(f.orm, id);
        source(f.orm, id, f.a, `bulk_${id}`);
      }
      memoryRevisionsForSession(f.orm, DEFAULT_AGENT_ID, f.a, ["m_a"]);
      const work = [1, 32, 400].map((size) =>
        traceSelects(f, () =>
          memoryRevisionsForSession(f.orm, DEFAULT_AGENT_ID, f.a, bulkIds.slice(0, size)),
        ),
      );
      expect(work.map((entry) => entry.value.size)).toEqual([1, 32, 400]);
      expect(work.every((entry) => entry.sql.length > 0)).toBe(true);
      const counts = work.map((entry) => selectCounts(entry.sql));
      for (const [index, count] of counts.entries()) {
        const size = [1, 32, 400][index]!;
        expect(count.get("memory_entries")).toBe(1);
        expect(count.get("memory_sources")).toBe(1);
        expect(count.get("turns")).toBe(1);
        expect(count.get("sessions")).toBe(2);
        expect(count.get("messages")).toBe(Math.ceil((2 * size) / 500));
      }
      expect(memoryRevisionsForSession(f.orm, DEFAULT_AGENT_ID, f.a, ["m_a", "m_b"])).toEqual(
        new Map(),
      );
      expect(memoryRevisionsForSession(f.orm, DEFAULT_AGENT_ID, f.b, ["m_b"])).toHaveProperty(
        "size",
        1,
      );
      expect(memoryRevisionsForSession(f.orm, DEFAULT_AGENT_ID, f.a, ["m_mixed"])).toEqual(
        new Map(),
      );
    } finally {
      f.business.close();
    }
  });
});
