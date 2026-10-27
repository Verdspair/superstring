import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
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
import { MEMORY_SEARCH_INVALID_LAYOUT_SQL } from "../../src/server/services/memory-contract";
import { runtimeFromAgent } from "../../src/server/services/runtime-config";
import { DEFAULT_STANDARD_PRESET } from "../../src/shared/contracts/models";

function fixture() {
  const business = openBusinessDb();
  const orm = business.orm;
  ensureDefaults(orm, "synthetic");
  const sessionId = createSession(orm, "synthetic", { modelName: "synthetic" }).id;
  const conversation = new ConversationEventRepository(business.db).ensureWeb(sessionId);
  if (!conversation) throw new Error("missing canonical conversation");
  const request = "source-turn";
  const prepared = prepareTurn(orm, sessionId, "source question", request);
  if (!prepared.generationToken) throw new Error("missing generation token");
  saveCompletedAssistantMessage(orm, sessionId, "source answer", request, prepared.generationToken);
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
  const turnId = turn.id;
  const userId = user.id;
  const assistantId = assistant.id;
  const sequenceNo = user.sequenceNo;
  const agent = getAgentRow(orm, DEFAULT_AGENT_ID);
  if (!agent) throw new Error("missing agent");
  const runtime = runtimeFromAgent(agent);
  // Fix the experiment to the existing standard defaults, not a larger recall budget.
  runtime.p5_config.retrieval_mode = "standard";
  runtime.p5_config.retrieval_presets.standard = { ...DEFAULT_STANDARD_PRESET };
  const memory = new SqliteMemoryModule({ orm, runtime: () => runtime });
  const owner = {
    kind: "web_turn",
    id: turn.id,
    agentId: DEFAULT_AGENT_ID,
    userId: DEFAULT_USER_ID,
  };
  function seed(id: string, name: string, body: string) {
    orm
      .insert(schema.memoryEntries)
      .values({
        id,
        agentId: DEFAULT_AGENT_ID,
        userId: DEFAULT_USER_ID,
        name,
        summary: "ordinary summary",
        tags: "[]",
        kinds: '["semantic"]',
        body,
        scope: "reality_user",
        scopeKey: DEFAULT_AGENT_ID,
        status: "active",
        configSnapshot: "{}",
        createdAt: nowIso(),
      })
      .run();
    orm
      .insert(schema.memorySources)
      .values({
        memoryId: id,
        turnId,
        userMessageId: userId,
        assistantMessageId: assistantId,
        sequenceNo,
      })
      .run();
  }
  const query = (
    text: string,
    options: { rebuild?: boolean; cursor?: string; ownerId?: string } = {},
  ) => {
    if (options.rebuild !== false)
      immediate(business.db, () =>
        rebuildMemorySearchProjection(orm, DEFAULT_AGENT_ID, { limit: 300 }),
      );
    return memory.query({
      agentId: DEFAULT_AGENT_ID,
      sessionId,
      conversationId: conversation.id,
      owner: { ...owner, id: options.ownerId ?? owner.id },
      scopes: null,
      mode: "standard",
      query: text,
      ...(options.cursor ? { cursor: options.cursor } : {}),
      budget: DEFAULT_STANDARD_PRESET.max_tokens,
    });
  };
  return { business, orm, seed, query, turnId };
}

describe("memory search trigram index", () => {
  it("keeps decoded field truth, ranking, Unicode and short fallback", async () => {
    const f = fixture();
    try {
      f.seed("late", "Straße", `${"🪴".repeat(4096)} uniqueend`);
      f.seed("zh", "紫藤花园", "ordinary");
      f.seed("boundary", "boundary", "tail");
      await f.query("uniqueend");
      expect((await f.query("strasse", { rebuild: false })).items.map((x) => x.id)).toContain(
        "late",
      );
      expect((await f.query("紫藤花园", { rebuild: false })).items.map((x) => x.id)).toEqual([
        "zh",
      ]);
      expect((await f.query("🪴", { rebuild: false })).items.map((x) => x.id)).toContain("late");
      expect((await f.query("boundarytail", { rebuild: false })).items).toEqual([]);
      const original = f.business.db
        .query("SELECT folded_search FROM memory_entries WHERE id='zh'")
        .get() as { folded_search: string };
      const escaped = original.folded_search.replace("紫", "\\u7d2b");
      f.business.db.query("UPDATE memory_entries SET folded_search=? WHERE id='zh'").run(escaped);
      const page = await f.query("紫藤花园", { rebuild: false });
      expect(page.status).toBe("unavailable");
      expect(page.code).toBe("MEMORY_SEARCH_REPAIR_NEEDED");
      expect(page.items).toEqual([]);
    } finally {
      f.business.close();
    }
  });

  it("invalid layout scalar predicate equals the previous json_each predicate", () => {
    const f = fixture();
    try {
      const db = f.business.db;
      const migration = readFileSync("migrations/versions/0075_memory_search_index.sql", "utf8");
      expect(migration).toContain(`WHERE ${MEMORY_SEARCH_INVALID_LAYOUT_SQL};`);
      db.query("CREATE TEMP TABLE layout_probe(folded_search TEXT, fold_version INTEGER)").run();
      const insert = db.query("INSERT INTO layout_probe VALUES (?,?)");
      for (const [projection, version] of [
        [null, 1],
        ["{", 1],
        ["{}", 1],
        ['["a","b"]', 1],
        ['["a","b","c","d","e","f"]', 1],
        ['["a","b",null,"d","e"]', 1],
        ['["a","b",3,"d","e"]', 1],
        ['["\\u0061","b","c","d","e"]', 1],
        ['["a","b","c","d","e"]', null],
        ['["a","b","c","d","e"]', 2],
        ['["a","b","c","d","e"]', 1],
      ] as const)
        insert.run(projection, version);
      const old = `folded_search IS NULL OR fold_version IS NULL OR fold_version <> 1 OR json_valid(folded_search)=0 OR CASE WHEN json_valid(folded_search) THEN json_type(folded_search)<>'array' OR json_array_length(folded_search)<>5 OR EXISTS (SELECT 1 FROM json_each(folded_search) f WHERE f.type<>'text') ELSE 1 END`;
      const rows = db
        .query(
          `SELECT (${old}) AS old, (${MEMORY_SEARCH_INVALID_LAYOUT_SQL}) AS next FROM layout_probe`,
        )
        .all();
      for (const row of rows as { old: number; next: number }[]) expect(row.next).toBe(row.old);
    } finally {
      f.business.close();
    }
  });

  it("falls back to exact search when a mapping or FTS row is missing", async () => {
    const f = fixture();
    try {
      f.seed("alpha", "targetalpha", "first");
      f.seed("beta", "targetbeta", "second");
      await f.query("targetalpha");
      const before = await f.query("targetalpha targetbeta", { rebuild: false });
      expect(before.items.map((item) => item.id).sort()).toEqual(["alpha", "beta"]);
      const mapping = f.business.db
        .query("SELECT index_id FROM memory_search_index_ids WHERE memory_id='alpha'")
        .get() as { index_id: number };
      f.business.db.query("DELETE FROM memory_search_fts WHERE rowid=?").run(mapping.index_id);
      const missingFts = await f.query("targetalpha", { rebuild: false });
      expect(missingFts.items.map((item) => item.id)).toContain("alpha");
      immediate(f.business.db, () =>
        rebuildMemorySearchProjection(f.orm, DEFAULT_AGENT_ID, { limit: 300 }),
      );
      f.business.db.query("DELETE FROM memory_search_index_ids WHERE memory_id='alpha'").run();
      const missingMapping = await f.query("targetalpha", { rebuild: false });
      expect(missingMapping.items.map((item) => item.id)).toContain("alpha");
    } finally {
      f.business.close();
    }
  });

  it("does not return an indexed hit after its source is invalidated", async () => {
    const f = fixture();
    try {
      f.seed("expired", "sourcecheck", "private fact");
      expect((await f.query("sourcecheck")).items.map((item) => item.id)).toContain("expired");
      f.orm.update(schema.turns).set({ sourceValid: 0 }).where(eq(schema.turns.id, f.turnId)).run();
      const page = await f.query("sourcecheck", { rebuild: false });
      expect(page.items.map((item) => item.id)).not.toContain("expired");
    } finally {
      f.business.close();
    }
  });

  it("rolls back source and index together on a failed transaction", async () => {
    const f = fixture();
    try {
      f.seed("rollback", "needle", "before");
      await f.query("needle");
      expect(() =>
        immediate(f.business.db, () => {
          f.business.db
            .query("UPDATE memory_entries SET folded_search=? WHERE id='rollback'")
            .run('["rollback","changed","ordinary summary","[]","before"]');
          throw new Error("abort synthetic transaction");
        }),
      ).toThrow("abort synthetic transaction");
      expect((await f.query("needle", { rebuild: false })).items.map((x) => x.id)).toContain(
        "rollback",
      );
      expect((await f.query("changed", { rebuild: false })).items).toEqual([]);
    } finally {
      f.business.close();
    }
  });

  it("updates, deletes and rebuilds through stable mapping including VACUUM", async () => {
    const f = fixture();
    try {
      f.seed("stable", "needle", "before");
      await f.query("needle");
      const mapping = f.business.db
        .query("SELECT index_id FROM memory_search_index_ids WHERE memory_id='stable'")
        .get() as { index_id: number };
      expect(mapping).toBeTruthy();
      f.business.db
        .query("UPDATE memory_entries SET folded_search=folded_search WHERE id='stable'")
        .run();
      f.business.db.exec("VACUUM");
      const restored = Database.deserialize(f.business.db.serialize());
      try {
        const savedMapping = restored
          .query("SELECT index_id FROM memory_search_index_ids WHERE memory_id='stable'")
          .get() as { index_id: number };
        expect(savedMapping.index_id).toBe(mapping.index_id);
        const matched = restored
          .query("SELECT rowid FROM memory_search_fts WHERE memory_search_fts MATCH ?")
          .all('"needle"') as { rowid: number }[];
        expect(matched.map((row) => row.rowid)).toContain(mapping.index_id);
      } finally {
        restored.close(true);
      }
      expect(
        (
          f.business.db
            .query("SELECT index_id FROM memory_search_index_ids WHERE memory_id='stable'")
            .get() as { index_id: number }
        ).index_id,
      ).toBe(mapping.index_id);
      expect((await f.query("needle", { rebuild: false })).items.map((x) => x.id)).toContain(
        "stable",
      );
      f.business.db.query("DELETE FROM memory_entries WHERE id='stable'").run();
      expect(
        f.business.db
          .query("SELECT index_id FROM memory_search_index_ids WHERE memory_id='stable'")
          .get(),
      ).toBeNull();
      expect((await f.query("needle", { rebuild: false })).items).toEqual([]);
    } finally {
      f.business.close();
    }
  });
});
