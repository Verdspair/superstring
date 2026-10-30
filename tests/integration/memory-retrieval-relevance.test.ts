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
      query: text,
      ...(options.cursor ? { cursor: options.cursor } : {}),
      budget: DEFAULT_STANDARD_PRESET.max_tokens,
    });
  };
  return { business, orm, seed, query };
}

describe("memory relevance in one standard-budget tool query", () => {
  it("finds a unique relevant memory after the old candidate window", async () => {
    const f = fixture();
    try {
      for (let i = 0; i < DEFAULT_STANDARD_PRESET.candidate_limit; i++) {
        f.seed(`a_${String(i).padStart(3, "0")}`, "ordinary", "unrelated material");
      }
      f.seed("z_target", "ordinary", "quartzbeacon");
      const page = await f.query("quartzbeacon");
      expect(page.status).toBe("ok");
      expect(page.items.map((item) => item.id)).toContain("z_target");
    } finally {
      f.business.close();
    }
  });

  it("finds a unique body match beyond the first 4096 Unicode code points", async () => {
    const f = fixture();
    try {
      f.seed("long_target", "ordinary", `${"🪴".repeat(4096)} lateorchid`);
      const page = await f.query("lateorchid");
      expect(page.status).toBe("ok");
      expect(page.items.map((item) => item.id)).toContain("long_target");
    } finally {
      f.business.close();
    }
  });

  it("finds a Chinese name match", async () => {
    const f = fixture();
    try {
      f.seed("chinese_target", "紫藤花园", "ordinary material");
      const page = await f.query("紫藤花园");
      expect(page.status).toBe("ok");
      expect(page.items.map((item) => item.id)).toEqual(["chinese_target"]);
    } finally {
      f.business.close();
    }
  });

  it("finds an exact stable memory ID", async () => {
    const f = fixture();
    try {
      f.seed("stablekey_7842", "ordinary", "ordinary material");
      const page = await f.query("stablekey_7842");
      expect(page.status).toBe("ok");
      expect(page.items.map((item) => item.id)).toEqual(["stablekey_7842"]);
    } finally {
      f.business.close();
    }
  });

  it("requires repair for an unbuilt or wrong-version projection", async () => {
    const f = fixture();
    try {
      f.seed("repair", "needle", "body");
      expect(await f.query("needle", { rebuild: false })).toMatchObject({
        status: "unavailable",
        code: "MEMORY_SEARCH_REPAIR_NEEDED",
      });
      expect((await f.query("needle")).items.map((item) => item.id)).toContain("repair");
      f.orm
        .update(schema.memoryEntries)
        .set({ foldVersion: 99 })
        .where(eq(schema.memoryEntries.id, "repair"))
        .run();
      expect(await f.query("needle", { rebuild: false })).toMatchObject({
        status: "unavailable",
        code: "MEMORY_SEARCH_REPAIR_NEEDED",
      });
    } finally {
      f.business.close();
    }
  });

  it("does not let a source-invalid unbuilt row block valid search", async () => {
    const f = fixture();
    try {
      f.seed("good", "needle", "body");
      f.seed("bad", "other", "body");
      await f.query("needle");
      f.orm
        .update(schema.memoryEntries)
        .set({
          foldedSearch: null,
          foldVersion: null,
          configSnapshot: '{"correction_retired":true}',
        })
        .where(eq(schema.memoryEntries.id, "bad"))
        .run();
      expect((await f.query("needle", { rebuild: false })).items.map((item) => item.id)).toContain(
        "good",
      );
    } finally {
      f.business.close();
    }
  });

  it("folds expanded Unicode and supports literal symbols", async () => {
    const f = fixture();
    try {
      f.seed("fold", "Straße", "symbol §☆");
      expect((await f.query("strasse")).items.map((item) => item.id)).toContain("fold");
      expect((await f.query("§☆")).items.map((item) => item.id)).toContain("fold");
    } finally {
      f.business.close();
    }
  });

  it("uses an owner-bound score cursor without losing tied results", async () => {
    const f = fixture();
    try {
      for (let i = 0; i < 12; i++) f.seed(`tie_${String(i).padStart(2, "0")}`, "sameword", "body");
      const first = await f.query("sameword");
      expect(first.items).toHaveLength(10);
      if (!first.nextCursor) throw new Error("expected continuation");
      const second = await f.query("sameword", { cursor: first.nextCursor, rebuild: false });
      expect(second.items).toHaveLength(2);
      expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(12);
      await expect(
        f.query("sameword", { cursor: first.nextCursor, ownerId: "other", rebuild: false }),
      ).rejects.toThrow();
    } finally {
      f.business.close();
    }
  });

  it("reports an empty complete page when the corpus has no answer", async () => {
    const f = fixture();
    try {
      f.seed("no_answer", "ordinary", "ordinary material");
      const page = await f.query("missingquartz");
      expect(page.status).toBe("ok");
      expect(page.items).toEqual([]);
      expect(page.nextCursor).toBeNull();
    } finally {
      f.business.close();
    }
  });
});
