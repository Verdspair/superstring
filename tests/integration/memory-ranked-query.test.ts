import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { rebuildMemorySearchProjection } from "../../src/server/db/memory-repository";
import {
  createSession,
  DEFAULT_AGENT_ID,
  DEFAULT_USER_ID,
  ensureDefaults,
  getAgentRow,
  getTurnByRequest,
  immediate,
  nowIso,
  prepareTurn,
  saveCompletedAssistantMessage,
} from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { SqliteMemoryModule } from "../../src/server/modules/memory-module";
import { runtimeFromAgent } from "../../src/server/services/runtime-config";
import { DEFAULT_STANDARD_PRESET } from "../../src/shared/contracts/models";

function fixture() {
  const business = openBusinessDb();
  const { orm, db } = business;
  ensureDefaults(orm, "synthetic");
  const a = createSession(orm, "A", { modelName: "synthetic" }).id;
  const b = createSession(orm, "B", { modelName: "synthetic" }).id;
  function turn(session: string, request: string) {
    const prepared = prepareTurn(orm, session, "question", request);
    if (!prepared.generationToken) throw new Error("missing token");
    saveCompletedAssistantMessage(orm, session, "answer", request, prepared.generationToken);
    const row = getTurnByRequest(orm, session, request);
    if (!row) throw new Error("missing turn");
    const messages = orm
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.turnId, row.id))
      .all();
    const user = messages.find((m) => m.role === "user"),
      assistant = messages.find((m) => m.role === "assistant");
    if (!user || !assistant) throw new Error("missing messages");
    return {
      turnId: row.id,
      userMessageId: user.id,
      assistantMessageId: assistant.id,
      sequenceNo: user.sequenceNo,
    };
  }
  const own = turn(a, "own"),
    foreign = turn(b, "foreign");
  const journal = new ConversationEventRepository(db);
  const conversation = journal.ensureWeb(a);
  if (!conversation) throw new Error("missing conversation");
  const row = getAgentRow(orm, DEFAULT_AGENT_ID);
  if (!row) throw new Error("missing agent");
  const runtime = runtimeFromAgent(row);
  runtime.p5_config.retrieval_mode = "standard";
  runtime.p5_config.retrieval_presets.standard = { ...DEFAULT_STANDARD_PRESET };
  const memory = new SqliteMemoryModule({ orm, runtime: () => runtime });
  function seed(id: string, body: string, source = own) {
    orm
      .insert(schema.memoryEntries)
      .values({
        id,
        agentId: DEFAULT_AGENT_ID,
        userId: DEFAULT_USER_ID,
        name: id,
        summary: "summary",
        tags: "[]",
        kinds: '["semantic"]',
        body,
        scope: "reality_user",
        scopeKey: DEFAULT_AGENT_ID,
        status: "active",
        configSnapshot: "{}",
        createdAt: nowIso(),
        visibility: "session_private",
      })
      .run();
    orm
      .insert(schema.memorySources)
      .values({ memoryId: id, ...source })
      .run();
  }
  const query = (query: string, cursor?: string) =>
    memory.query({
      agentId: DEFAULT_AGENT_ID,
      sessionId: a,
      conversationId: conversation.id,
      owner: {
        kind: "web_turn",
        id: own.turnId,
        agentId: DEFAULT_AGENT_ID,
        userId: DEFAULT_USER_ID,
      },
      scopes: null,
      query,
      budget: DEFAULT_STANDARD_PRESET.max_tokens,
      ...(cursor ? { cursor } : {}),
    });
  const rebuild = () =>
    immediate(db, () => rebuildMemorySearchProjection(orm, DEFAULT_AGENT_ID, { limit: 300 }));
  return { business, orm, own, foreign, seed, query, rebuild };
}

describe("ranked memory eligibility", () => {
  it("returns full-body Unicode hits and stable cursor pages in the real conversation", async () => {
    const f = fixture();
    try {
      for (let i = 0; i < 12; i++)
        f.seed(`m${String(i).padStart(2, "0")}`, `${"🪴".repeat(4096)} Straße`);
      f.seed("foreign", "Straße", f.foreign);
      f.rebuild();
      const first = await f.query("strasse");
      expect(first.status).toBe("ok");
      expect(first.items).toHaveLength(10);
      if (!first.nextCursor) throw new Error("missing cursor");
      const second = await f.query("strasse", first.nextCursor);
      expect(second.items).toHaveLength(2);
      expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(12);
      expect([...first.items, ...second.items].map((item) => item.id)).not.toContain("foreign");
    } finally {
      f.business.close();
    }
  });
  it("handles missing, malformed and oversized sources without false complete disclosure", async () => {
    const f = fixture();
    try {
      f.seed("good", "needle");
      f.seed("foreign", "needle", f.foreign);
      f.rebuild();
      f.orm
        .update(schema.memoryEntries)
        .set({ foldedSearch: null, foldVersion: null })
        .where(eq(schema.memoryEntries.id, "foreign"))
        .run();
      expect((await f.query("needle")).items.map((item) => item.id)).toEqual(["good"]);
      f.orm
        .update(schema.memoryEntries)
        .set({ foldedSearch: "{bad" })
        .where(eq(schema.memoryEntries.id, "good"))
        .run();
      expect(await f.query("needle")).toMatchObject({
        status: "unavailable",
        code: "MEMORY_SEARCH_REPAIR_NEEDED",
      });
      f.rebuild();
      f.orm
        .update(schema.memoryEntries)
        .set({ body: "x".repeat(64001) })
        .where(eq(schema.memoryEntries.id, "good"))
        .run();
      expect((await f.query("needle")).items).toEqual([]);
    } finally {
      f.business.close();
    }
  });
  it("searches independent Unicode fields, escapes and symbols without cross-field matches", async () => {
    const f = fixture();
    try {
      f.seed("special", 'Straße 中文 🪴 quote " slash \\');
      f.seed("boundary", "tail");
      f.rebuild();
      expect((await f.query("strasse")).items.map((item) => item.id)).toEqual(["special"]);
      expect((await f.query("中文")).items.map((item) => item.id)).toEqual(["special"]);
      expect((await f.query("🪴")).items.map((item) => item.id)).toEqual(["special"]);
      expect((await f.query('"')).items.map((item) => item.id)).toEqual(["special"]);
      expect((await f.query("\\")).items.map((item) => item.id)).toEqual(["special"]);
      // ID and body are different fields: their concatenation must not match.
      expect((await f.query("boundarytail")).items).toEqual([]);
    } finally {
      f.business.close();
    }
  });

  it("treats valid noncanonical projections and wrong layouts according to the original repair gate", async () => {
    const f = fixture();
    try {
      f.seed("a", "body");
      f.rebuild();
      const original = f.orm
        .select()
        .from(schema.memoryEntries)
        .where(eq(schema.memoryEntries.id, "a"))
        .get();
      if (!original?.foldedSearch) throw new Error("missing projection");
      const escaped = original.foldedSearch.replace('"a"', '"\\u0061"');
      expect(escaped).not.toBe(original.foldedSearch);
      f.orm
        .update(schema.memoryEntries)
        .set({ foldedSearch: escaped })
        .where(eq(schema.memoryEntries.id, "a"))
        .run();
      expect(await f.query("a")).toMatchObject({
        status: "unavailable",
        code: "MEMORY_SEARCH_REPAIR_NEEDED",
      });
      for (const invalid of ['["a"]', '["a",1,"b","c","d"]', "{bad"]) {
        f.orm
          .update(schema.memoryEntries)
          .set({ foldedSearch: invalid })
          .where(eq(schema.memoryEntries.id, "a"))
          .run();
        expect(await f.query("a")).toMatchObject({
          status: "unavailable",
          code: "MEMORY_SEARCH_REPAIR_NEEDED",
        });
      }
    } finally {
      f.business.close();
    }
  });

  it("keeps empty browse independent of folded search", async () => {
    const f = fixture();
    try {
      f.seed("own", "body");
      expect((await f.query("")).items.map((item) => item.id)).toContain("own");
    } finally {
      f.business.close();
    }
  });
});
