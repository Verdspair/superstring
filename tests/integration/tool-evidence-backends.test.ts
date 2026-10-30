import { afterEach, beforeAll, beforeEach, describe, expect, it, mock } from "bun:test";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { createBuiltInActions } from "../../src/server/agent/built-in-actions";
import type { BusinessDbHandle } from "../../src/server/db/connection";
import { openConnection, toOrmHandle } from "../../src/server/db/connection";
import { rankedMemoryCandidates } from "../../src/server/db/context-repository";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { KnowledgeRepository } from "../../src/server/db/knowledge-repository";
import { correctMemory } from "../../src/server/db/memory-content-repository";
import {
  claim,
  enqueue,
  jobOwned,
  publish,
  rebuildMemorySearchProjection,
} from "../../src/server/db/memory-repository";
import { recordObservation } from "../../src/server/db/qq-observation-intake";
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
import { createSqliteQueryFactory } from "../../src/server/modules/composition";
import { evidenceQueryPage, type MemoryQuery } from "../../src/server/modules/contracts";
import { evidenceCatalogCost } from "../../src/server/modules/evidence-pagination";
import { SqliteKnowledgeModule } from "../../src/server/modules/knowledge-module";
import { SqliteMemoryModule } from "../../src/server/modules/memory-module";
import { KnowledgeOrganizer } from "../../src/server/services/knowledge-organizer";
import { normalizeOneBotMessage } from "../../src/server/services/onebot-protocol";
import { qqConversationKey, qqMemoryScopeKey } from "../../src/server/services/qq-binding-contract";
import { runtimeFromAgent } from "../../src/server/services/runtime-config";
import type { RuntimeConfig } from "../../src/shared/contracts";
import type { Evidence } from "../../src/shared/contracts/evidence";

let serialized: Uint8Array;
let business: BusinessDbHandle;
let runtime: RuntimeConfig;
let repo: KnowledgeRepository;
let memory: ReturnType<ReturnType<typeof createSqliteQueryFactory>>["memory"] & {
  read: NonNullable<ReturnType<ReturnType<typeof createSqliteQueryFactory>>["memory"]["read"]>;
};
let knowledge: SqliteKnowledgeModule;
let sessionId: string;
const owner = { kind: "synthetic", id: "run", agentId: DEFAULT_AGENT_ID, userId: DEFAULT_USER_ID };
const capacity = mock(async () => 32768);
const leaf = mock(async () => '{"ids":[]}');
const observed: string[] = [];

beforeAll(() => {
  const template = openBusinessDb();
  ensureDefaults(template.orm, "synthetic");
  serialized = template.db.serialize();
  template.close();
});
beforeEach(() => {
  business = toOrmHandle(openConnection({ serialized }));
  repo = new KnowledgeRepository(business.db);
  const agent = getAgentRow(business.orm, DEFAULT_AGENT_ID);
  if (!agent) throw new Error("Missing synthetic Agent");
  runtime = runtimeFromAgent(agent);
  runtime.knowledge_read = {
    config: { enabled: true, context_budget: null, scope: "all", document_ids: [] },
    revision: 1,
    budget: 65536,
    budget_source: "global",
    global_revision: 1,
    auto_enabled: true,
  };
  sessionId = createSession(business.orm, "synthetic", { modelName: "synthetic" }).id;
  capacity.mockClear();
  leaf.mockClear();
  observed.length = 0;
  const options = {
    runtime: () => runtime,
    gateway: { loadedContextCapacity: capacity },
    agentRuntime: { completeLeaf: leaf, completeVisionLeaf: leaf },
    assertSources: (sources: readonly { id: string }[]) => {
      observed.push(...sources.map((source) => source.id));
    },
  };
  const module = createSqliteQueryFactory({
    db: business.db,
    orm: business.orm,
    gateway: options.gateway,
    agentRuntime: options.agentRuntime,
  })({ runtime, assertSources: options.assertSources }).memory;
  if (!module.read) throw new Error("Missing memory read capability");
  memory = { ...module, query: module.query.bind(module), read: module.read.bind(module) };
  knowledge = new SqliteKnowledgeModule({ ...options, db: business.db });
});
afterEach(() => business.close());

function memoryInput(extra: Partial<MemoryQuery> = {}): MemoryQuery {
  return {
    agentId: DEFAULT_AGENT_ID,
    owner,
    sessionId,
    scopes: null,
    query: "",
    budget: 65536,
    ...extra,
  };
}
function knowledgeInput(extra: Record<string, unknown> = {}) {
  return { agentId: DEFAULT_AGENT_ID, owner, query: "", budget: 65536, ...extra };
}
function seedMemory(id: string, body = "原文𠮷正文", scopeKey = DEFAULT_AGENT_ID) {
  business.orm
    .insert(schema.memoryEntries)
    .values({
      id,
      agentId: DEFAULT_AGENT_ID,
      userId: DEFAULT_USER_ID,
      name: `目录 ${id}`,
      summary: "仅摘要",
      tags: "[]",
      kinds: '["semantic"]',
      body,
      scope: "reality_user",
      scopeKey,
      status: "active",
      configSnapshot: "{}",
      createdAt: nowIso(),
    })
    .run();
  const prepared = prepareTurn(business.orm, sessionId, `问题 ${id}`, id);
  if (!prepared.generationToken) throw new Error("Missing generation token");
  saveCompletedAssistantMessage(business.orm, sessionId, "合成回答", id, prepared.generationToken);
  const turn = getTurnByRequest(business.orm, sessionId, id);
  if (!turn) throw new Error("Missing source turn");
  const messages = business.orm
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.turnId, turn.id))
    .all();
  const user = messages.find((message) => message.role === "user");
  const assistant = messages.find((message) => message.role === "assistant");
  if (!user || !assistant) throw new Error("Missing source messages");
  business.orm
    .insert(schema.memorySources)
    .values({
      memoryId: id,
      turnId: turn.id,
      userMessageId: user.id,
      assistantMessageId: assistant.id,
      sequenceNo: user.sequenceNo,
    })
    .run();
  return turn.id;
}
function addDocument(text = "原文𠮷正文", grant = true) {
  const doc = repo.importDocument({
    name: "资料目录",
    category_id: "default",
    original_text: text,
  });
  if (grant) repo.replaceGrants(doc.id, doc.revision, [DEFAULT_AGENT_ID]);
  return doc.id;
}
function first(items: readonly Evidence[]) {
  const item = items[0];
  if (!item) throw new Error("Expected a directory entry");
  return item;
}
async function readMemory(evidence: Evidence, offset = 0, limit = 4096) {
  if (!memory.read) throw new Error("Missing memory read capability");
  return memory.read({ ...memoryInput(), evidence, offset, limit });
}
async function readKnowledge(evidence: Evidence, offset = 0, limit = 4096) {
  if (!knowledge.read) throw new Error("Missing knowledge read capability");
  return knowledge.read({ ...knowledgeInput(), evidence, offset, limit });
}

// Import through the real repository; only the organizer creates persisted chunks today.
async function organize() {
  const worker = new KnowledgeOrganizer({
    db: business.db,
    gateway: {
      config: { baseUrl: "http://unused.invalid", model: "synthetic", timeoutSeconds: 1 },
      loadedContextCapacity: async () => 32768,
      listModels: async () => ["synthetic"],
      probeModelLoaded: async () => true,
      complete: async () => {
        throw new Error("No model calls in synthetic organizer");
      },
      async *streamChat() {
        yield "unused";
      },
    },
    agentRuntime: {
      completeLeaf: async () => '{"summary":"整理摘要","tags":[],"body":"整理𠮷正文"}',
      completeVisionLeaf: async () => {
        throw new Error("No vision calls");
      },
    },
  });
  expect(await worker.runCycle()).toBe(true);
  await worker.stop();
}

describe("tool evidence backends", () => {
  it("preserves published and manually corrected content origin in ranked, browsed and freshly read memory", async () => {
    const sourceTurn = seedMemory("origin-source", "Source text is not the correction");
    const job = immediate(business.db, () =>
      enqueue(business.orm, DEFAULT_AGENT_ID, "origin-publish", {
        kind: "manual",
        sessionId,
        turnIds: [sourceTurn],
      }),
    );
    const claimed = immediate(business.db, () => claim(business.orm, job.id));
    if (!claimed?.token) throw new Error("Missing claimed memory job");
    immediate(business.db, () =>
      publish(business.orm, DEFAULT_AGENT_ID, job.id, claimed.token!, {
        name: "origin needle",
        summary: "Published memory",
        tags: [],
        kinds: ["semantic"],
        body: "甲𠮷乙",
      }),
    );
    const id = jobOwned(business.orm, DEFAULT_AGENT_ID, job.id).resultId;
    if (!id) throw new Error("Missing published memory");
    immediate(business.db, () =>
      rebuildMemorySearchProjection(business.orm, DEFAULT_AGENT_ID, { limit: 10 }),
    );
    for (const query of ["", "needle"]) {
      const page = evidenceQueryPage(await memory.query(memoryInput({ query })));
      const item = page.items.find((candidate) => candidate.id === id);
      expect(item).toMatchObject({ metadata: { content_origin: "derived" } });
      if (!item) throw new Error("Missing published query item");
      const priced = { ...item, metadata: { content_origin: "derived" as const } };
      const noMetadata = {
        id: item.id,
        text: item.text,
        preview: item.preview,
        score: item.score,
        sources: item.sources,
        scope: item.scope,
      };
      expect(evidenceCatalogCost([priced])).toBeGreaterThan(evidenceCatalogCost([noMetadata]));
      const read = await readMemory(item, 0, 2);
      expect(read).toMatchObject({
        text: "甲𠮷",
        offset: 0,
        nextOffset: 2,
        metadata: { content_origin: "derived" },
      });
    }
    const old = first(
      evidenceQueryPage(await memory.query(memoryInput({ query: "needle" }))).items,
    );
    const corrected = immediate(business.db, () =>
      correctMemory(business.orm, DEFAULT_AGENT_ID, id, {
        expected_revision: old.sources[0]!.revision,
        name: "origin needle correction",
        summary: "Human correction, not an original speaker confirmation",
        tags: [],
        body: "更正𠮷正文",
      }),
    );
    await expect(readMemory(old)).rejects.toMatchObject({ code: "CONTEXT_SOURCE_INVALID" });
    for (const query of ["", "needle"]) {
      const page = evidenceQueryPage(await memory.query(memoryInput({ query })));
      expect(page.items.some((item) => item.id === id)).toBe(false);
      const fresh = page.items.find((item) => item.id === corrected.content.id);
      expect(fresh).toMatchObject({ metadata: { content_origin: "manual_correction" } });
      if (!fresh) throw new Error("Missing corrected query item");
      const forgedSnapshot = { ...fresh, metadata: { content_origin: "derived" as const } };
      expect(await readMemory(forgedSnapshot, 0, 2)).toMatchObject({
        text: "更正",
        offset: 0,
        nextOffset: 2,
        metadata: { content_origin: "manual_correction" },
      });
    }
    const actions = createBuiltInActions(
      {
        memory: {
          query: (query, action) =>
            memory.query({ ...memoryInput(), ...query, signal: action.signal }),
          read: (read, action) => memory.read({ ...memoryInput(), ...read, signal: action.signal }),
        },
      },
      { assertSources() {}, fit: async () => () => true },
    );
    const ctx = { owner, runId: "origin-tools", signal: new AbortController().signal };
    const query = actions.find((action) => action.description.name === "memory.query")!;
    const read = actions.find((action) => action.description.name === "memory.read")!;
    const traced: string[] = [];
    const originalQuery = business.db.query;
    const originalPrepare = business.db.prepare;
    business.db.query = ((sql: string, ...rest: unknown[]) => {
      traced.push(sql);
      return Reflect.apply(originalQuery, business.db, [sql, ...rest]);
    }) as typeof originalQuery;
    business.db.prepare = ((sql: string, ...rest: unknown[]) => {
      traced.push(sql);
      return Reflect.apply(originalPrepare, business.db, [sql, ...rest]);
    }) as typeof originalPrepare;
    try {
      const direct = evidenceQueryPage(
        await memory.query(memoryInput({ query: "needle", limit: 1 })),
      );
      const directReads = [...traced];
      traced.length = 0;
      const result = await query.execute({ query: "needle", limit: 1 }, ctx);
      expect(traced).toEqual(directReads);
      expect(directReads.length).toBeGreaterThan(0);
      const item = (result.value as { items: { bodyRef: string }[] }).items[0]!;
      expect(item).toMatchObject({ metadata: { content_origin: "manual_correction" } });
      traced.length = 0;
      await readMemory(first(direct.items), 0, 2);
      const directBodyReads = [...traced];
      traced.length = 0;
      const page = await read.execute({ bodyRef: item.bodyRef, offset: 0, limit: 2 }, ctx);
      expect(traced).toEqual(directBodyReads);
      expect(page.value).toMatchObject({
        items: [{ text: "更正", nextOffset: 2, metadata: { content_origin: "manual_correction" } }],
      });
    } finally {
      business.db.query = originalQuery;
      business.db.prepare = originalPrepare;
      for (const action of actions) action.release?.(ctx);
    }
    expect(capacity).not.toHaveBeenCalled();
    expect(leaf).not.toHaveBeenCalled();
  });

  it("queries metadata and lazily reads without any selector or gateway call", async () => {
    seedMemory("m1", "不应预取的记忆正文");
    addDocument("不应预取的资料正文");
    const m = evidenceQueryPage(await memory.query(memoryInput()));
    const k = evidenceQueryPage(await knowledge.query(knowledgeInput()));
    expect(first(m.items).text).toBe("");
    expect(first(k.items).text).toBe("");
    expect((await readMemory(first(m.items))).text).toBe("不应预取的记忆正文");
    expect((await readKnowledge(first(k.items))).text).toBe("不应预取的资料正文");
    expect(capacity).not.toHaveBeenCalled();
    expect(leaf).not.toHaveBeenCalled();
  });

  it("fails closed for empty QQ scopes and disabled reads, while Web remains agent-wide", async () => {
    seedMemory("m1", "群记忆", '["qq","a","group","b"]');
    const page = evidenceQueryPage(await memory.query(memoryInput()));
    expect(page.items).toHaveLength(1);
    expect(evidenceQueryPage(await memory.query(memoryInput({ scopes: [] }))).items).toEqual([]);
    const active = runtime.p5_config.memory_read;
    runtime.p5_config.memory_read = { enabled: false, max_bytes: 8192 };
    expect(evidenceQueryPage(await memory.query(memoryInput())).items).toEqual([]);
    runtime.p5_config.memory_read = active;
    await expect(
      memory.read?.({
        ...memoryInput({ scopes: [] }),
        evidence: first(page.items),
        offset: 0,
        limit: 100,
      }),
    ).rejects.toMatchObject({ code: "CONTEXT_INVALID_SELECTION" });
    runtime.p5_config.memory_read = { enabled: false, max_bytes: 8192 };
    expect(evidenceQueryPage(await memory.query(memoryInput())).items).toEqual([]);
    await expect(readMemory(first(page.items))).rejects.toMatchObject({
      code: "CONTEXT_SOURCE_INVALID",
    });
    addDocument();
    const k = first(evidenceQueryPage(await knowledge.query(knowledgeInput())).items);
    if (!runtime.knowledge_read) throw new Error("Missing knowledge rules");
    runtime.knowledge_read.config.enabled = false;
    expect(evidenceQueryPage(await knowledge.query(knowledgeInput())).items).toEqual([]);
    await expect(readKnowledge(k)).rejects.toMatchObject({ code: "KNOWLEDGE_ACCESS_CHANGED" });
  });

  it("uses stored presets, keyset continuation and bounded legacy full-mode quotas", async () => {
    runtime.p5_config.retrieval_presets.broad = {
      candidate_limit: 2,
      max_entries: 1,
      max_tokens: 4096,
      relevance_instruction: "legacy",
    };
    seedMemory("m1");
    seedMemory("m2");
    seedMemory("m3", "needle");
    seedMemory("m4", "needle");
    immediate(business.db, () =>
      rebuildMemorySearchProjection(business.orm, DEFAULT_AGENT_ID, { limit: 10 }),
    );
    const input = memoryInput({ query: "needle" });
    const one = evidenceQueryPage(await memory.query(input));
    expect(one.items.map((item) => item.id)).toEqual(["m3"]);
    expect(one.nextCursor).toBeString();
    const two = evidenceQueryPage(
      await memory.query({ ...input, cursor: one.nextCursor ?? undefined }),
    );
    expect(two.items.map((item) => item.id)).toEqual(["m4"]);
    expect(capacity).not.toHaveBeenCalled();
    expect(leaf).not.toHaveBeenCalled();
  });

  it("returns unavailable for an insufficient metadata budget, not a false no-match", async () => {
    seedMemory("m1");
    addDocument();
    expect(evidenceQueryPage(await memory.query(memoryInput({ budget: 1 })))).toMatchObject({
      status: "unavailable",
      code: "CONTEXT_AUX_BUDGET",
      items: [],
    });
    expect(evidenceQueryPage(await knowledge.query(knowledgeInput({ budget: 1 })))).toMatchObject({
      status: "unavailable",
      code: "KNOWLEDGE_CONTEXT_BUDGET",
      items: [],
    });
  });

  it("rejects forged, oversized, cross-owner, cross-scope and cross-query cursors", async () => {
    seedMemory("m1");
    seedMemory("m2");
    addDocument("x".repeat(6000));
    const mInput = memoryInput({ limit: 1 });
    const m = evidenceQueryPage(await memory.query(mInput));
    const kInput = knowledgeInput({ limit: 1 });
    const k = evidenceQueryPage(await knowledge.query(kInput));
    expect(m.nextCursor).toBeString();
    expect(k.nextCursor).toBeString();
    for (const cursor of ["{}", "x".repeat(4097), `${m.nextCursor}x`]) {
      await expect(memory.query({ ...mInput, cursor })).rejects.toMatchObject({
        code: "CONTEXT_INVALID_SELECTION",
      });
    }
    for (const extra of [
      { query: "other" },
      { scopes: [] },
      { owner: { ...owner, id: "another-run" } },
    ]) {
      await expect(
        memory.query({ ...mInput, cursor: m.nextCursor ?? undefined, ...extra }),
      ).rejects.toMatchObject({ code: "CONTEXT_INVALID_SELECTION" });
    }
    await expect(
      knowledge.query({ ...kInput, query: "other", cursor: k.nextCursor ?? undefined }),
    ).rejects.toMatchObject({ code: "CONTEXT_INVALID_SELECTION" });
    await expect(knowledge.query({ ...kInput, cursor: "x".repeat(4097) })).rejects.toMatchObject({
      code: "CONTEXT_INVALID_SELECTION",
    });
  });

  it("does not revive retired corrections, suppressed entries or invalid sources", async () => {
    seedMemory("retired");
    seedMemory("suppressed");
    const turn = seedMemory("invalid");
    seedMemory("valid");
    business.db
      .query("UPDATE memory_entries SET config_snapshot = ? WHERE id = 'retired'")
      .run('{"correction_retired":true}');
    business.db
      .query("UPDATE memory_entries SET status = 'suppressed' WHERE id = 'suppressed'")
      .run();
    business.db.query("UPDATE turns SET source_valid = 0 WHERE id = ?").run(turn);
    expect(
      evidenceQueryPage(await memory.query(memoryInput())).items.map((item) => item.id),
    ).toEqual(["valid"]);
  });

  it("rejects memory revisions and source invalidation after a preview", async () => {
    const turn = seedMemory("m1");
    const item = first(evidenceQueryPage(await memory.query(memoryInput())).items);
    business.db.query("UPDATE memory_entries SET body = 'updated' WHERE id = 'm1'").run();
    await expect(readMemory(item)).rejects.toMatchObject({ code: "CONTEXT_SOURCE_INVALID" });
    const fresh = first(evidenceQueryPage(await memory.query(memoryInput())).items);
    business.db.query("UPDATE turns SET source_valid = 0 WHERE id = ?").run(turn);
    await expect(readMemory(fresh)).rejects.toMatchObject({ code: "CONTEXT_SOURCE_INVALID" });
  });

  for (const mutation of ["revoke", "regrant", "version"] as const) {
    it(`rejects an old knowledge ref after ${mutation}`, async () => {
      const id = addDocument();
      const item = first(evidenceQueryPage(await knowledge.query(knowledgeInput())).items);
      if (mutation === "version")
        repo.updateDocument(id, {
          expected_revision: repo.detail(id).revision,
          original_text: "修改后的正文",
        });
      else {
        repo.replaceGrants(id, repo.detail(id).revision, []);
        if (mutation === "regrant")
          repo.replaceGrants(id, repo.detail(id).revision, [DEFAULT_AGENT_ID]);
      }
      await expect(readKnowledge(item)).rejects.toMatchObject({ code: "KNOWLEDGE_ACCESS_CHANGED" });
    });
  }

  it("authorizes selected documents before scanning and attaches only disclosed sources", async () => {
    const one = addDocument();
    const two = addDocument("其他正文");
    const secret = addDocument("私密正文", false);
    if (!runtime.knowledge_read) throw new Error("Missing knowledge rules");
    runtime.knowledge_read.config = {
      enabled: true,
      context_budget: null,
      scope: "selected",
      document_ids: [one],
    };
    const page = evidenceQueryPage(await knowledge.query(knowledgeInput({ limit: 1 })));
    expect(page.items).toHaveLength(1);
    expect(first(page.items).sources).toHaveLength(2);
    expect(JSON.stringify(page)).not.toContain(two);
    expect(JSON.stringify(page)).not.toContain(secret);
    expect(observed).not.toContain(two);
    expect(observed).not.toContain(secret);
    runtime.knowledge_read.config.document_ids = [two];
    await expect(readKnowledge(first(page.items))).rejects.toMatchObject({
      code: "KNOWLEDGE_ACCESS_CHANGED",
    });
  });

  it("continues a no-match bounded knowledge scan into a second batch", async () => {
    addDocument(`${"x".repeat(70000)} needle`);
    const input = knowledgeInput({ query: "needle" });
    const page = evidenceQueryPage(await knowledge.query(input));
    expect(page.status).toBe("ok");
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeString();
    const next = evidenceQueryPage(
      await knowledge.query({ ...input, cursor: page.nextCursor ?? undefined }),
    );
    expect(next.items.length).toBeGreaterThan(0);
    expect((await readKnowledge(first(next.items))).text).toContain("needle");
  });

  it("uses persisted chunks and retains valid draft mappings without a selector", async () => {
    addDocument("原文𠮷正文");
    await organize();
    expect(business.db.query("SELECT id FROM knowledge_chunks").all().length).toBeGreaterThan(0);
    const page = evidenceQueryPage(await knowledge.query(knowledgeInput()));
    expect((await readKnowledge(first(page.items))).text).toBe("整理𠮷正文");
    expect(first(page.items).text).toBe("");
    expect(leaf).not.toHaveBeenCalled();
    expect(capacity).not.toHaveBeenCalled();
  });

  it("preserves Unicode across partial body pages and enforces the 4096-character cap", async () => {
    const body = `${"𠮷".repeat(4095)}終𠮷`;
    seedMemory("unicode", body);
    const m = first(evidenceQueryPage(await memory.query(memoryInput())).items);
    const page = await readMemory(m, 0, 9000);
    expect([...page.text]).toHaveLength(4096);
    expect(page.total).toBe(4097);
    expect(page.nextOffset).toBe(4096);
    expect(page.text + (await readMemory(m, page.nextOffset ?? 0)).text).toBe(body);
    addDocument("A𠮷B𠮷C");
    const k = first(evidenceQueryPage(await knowledge.query(knowledgeInput())).items);
    let result = "";
    let offset: number | null = 0;
    while (offset !== null) {
      const part = await readKnowledge(k, offset, 2);
      expect(part.text.isWellFormed()).toBe(true);
      result += part.text;
      offset = part.nextOffset;
    }
    expect(result).toBe("A𠮷B𠮷C");
    await expect(readKnowledge(k, -1)).rejects.toMatchObject({ code: "CONTEXT_INVALID_SELECTION" });
  });

  it("keeps supplemental originals across draft pages and refuses changed drafts", async () => {
    const id = addDocument("原文𠮷正文");
    await organize();
    const input = knowledgeInput({ limit: 1 });
    const page = evidenceQueryPage(await knowledge.query(input));
    const derived = first(page.items);
    expect((await readKnowledge(derived)).text).toBe("整理𠮷正文");
    expect(page.nextCursor).toBeString();
    const next = evidenceQueryPage(
      await knowledge.query({ ...input, cursor: page.nextCursor ?? undefined }),
    );
    expect((await readKnowledge(first(next.items))).text).toBe("原文𠮷正文");
    business.db.query("UPDATE knowledge_drafts SET body = 'changed' WHERE document_id = ?").run(id);
    await expect(readKnowledge(derived)).rejects.toMatchObject({
      code: "KNOWLEDGE_ACCESS_CHANGED",
    });
  });

  it("pages persisted chunks by ordinal and excludes stale content versions", async () => {
    const id = addDocument("𠮷alpha。".repeat(300));
    await organize();
    repo.updateDocument(id, {
      expected_revision: repo.detail(id).revision,
      content_mode: "original",
    });
    let cursor: string | undefined;
    let text = "";
    let pages = 0;
    do {
      const page = evidenceQueryPage(
        await knowledge.query({ ...knowledgeInput({ limit: 1 }), cursor }),
      );
      expect(page.items).toHaveLength(1);
      text += (await readKnowledge(first(page.items))).text;
      cursor = page.nextCursor ?? undefined;
      pages++;
    } while (cursor && pages < 20);
    expect(pages).toBeGreaterThan(1);
    expect(text).toBe("𠮷alpha。".repeat(300));
    business.db
      .query(
        "UPDATE knowledge_documents SET content_version = content_version + 1, original_text = 'new source' WHERE id = ?",
      )
      .run(id);
    const fresh = first(evidenceQueryPage(await knowledge.query(knowledgeInput())).items);
    expect((await readKnowledge(fresh)).text).toBe("new source");
  });

  it("revalidates grants on each continuation and rejects locator/source injection", async () => {
    const id = addDocument("x".repeat(3000));
    const page = evidenceQueryPage(await knowledge.query(knowledgeInput({ limit: 1 })));
    const item = first(page.items);
    await expect(readKnowledge({ ...item, id })).rejects.toMatchObject({
      code: "CONTEXT_INVALID_SELECTION",
    });
    await expect(readKnowledge({ ...item, sources: [] })).rejects.toMatchObject({
      code: "CONTEXT_INVALID_SELECTION",
    });
    await expect(readKnowledge(item, 1025)).rejects.toMatchObject({
      code: "CONTEXT_INVALID_SELECTION",
    });
    repo.replaceGrants(id, repo.detail(id).revision, []);
    const next = evidenceQueryPage(
      await knowledge.query({
        ...knowledgeInput({ limit: 1 }),
        cursor: page.nextCursor ?? undefined,
      }),
    );
    expect(next.items).toEqual([]);
    expect(next.nextCursor).toBeNull();
  });

  it("checks cancellation after repository work, without publishing evidence", async () => {
    seedMemory("m1");
    addDocument();
    for (const domain of ["memory", "knowledge"] as const) {
      const controller = new AbortController();
      const assertSources = (sources: readonly { kind: string }[]) => {
        if (sources.length) controller.abort();
      };
      const result =
        domain === "memory"
          ? new SqliteMemoryModule({
              orm: business.orm,
              runtime: () => runtime,
              assertSources,
            }).query(memoryInput({ signal: controller.signal }))
          : new SqliteKnowledgeModule({
              db: business.db,
              runtime: () => runtime,
              assertSources,
            }).query({ ...knowledgeInput(), signal: controller.signal });
      await expect(result).rejects.toThrow();
    }
  });

  it("caps memory scans at 300 rows and knowledge scans at 120 rows", async () => {
    seedMemory("m0000", "ordinary");
    business.db.transaction(() => {
      for (let i = 1; i <= 301; i++) {
        const id = `m${String(i).padStart(4, "0")}`;
        business.db
          .query(`INSERT INTO memory_entries
          (id, agent_id, user_id, name, summary, tags, kinds, body, scope, scope_key, status, config_snapshot, created_at)
          SELECT ?, agent_id, user_id, name, summary, tags, kinds, ?, scope, scope_key, status, config_snapshot, created_at FROM memory_entries WHERE id = 'm0000'`)
          .run(id, "needle");
        business.db
          .query(
            `INSERT INTO memory_sources SELECT ?, turn_id, user_message_id, assistant_message_id, sequence_no FROM memory_sources WHERE memory_id = 'm0000'`,
          )
          .run(id);
      }
    })();
    runtime.p5_config.retrieval_presets.broad = {
      candidate_limit: 1000,
      max_entries: 100,
      max_tokens: 65536,
      relevance_instruction: "bounded",
    };
    const firstRebuild = immediate(business.db, () =>
      rebuildMemorySearchProjection(business.orm, DEFAULT_AGENT_ID, { limit: 300 }),
    );
    const nextAfterId = firstRebuild.nextAfterId;
    if (!nextAfterId) throw new Error("expected a second rebuild page");
    immediate(business.db, () =>
      rebuildMemorySearchProjection(business.orm, DEFAULT_AGENT_ID, {
        afterId: nextAfterId,
        limit: 300,
      }),
    );
    const queries: Array<{ query: string; params: unknown[] }> = [];
    const measured = drizzle(business.db, {
      schema,
      logger: {
        logQuery(query, params) {
          queries.push({ query, params });
        },
      },
    });
    const bounded = rankedMemoryCandidates(measured, DEFAULT_AGENT_ID, null, {
      sessionId,
      terms: ["needle"],
      limit: 1000,
    });
    expect(bounded.positions).toHaveLength(300);
    expect(bounded.hasMore).toBe(true);
    const ranked = queries.find(
      (entry) => /json_each/i.test(entry.query) && /order by/i.test(entry.query),
    );
    expect(ranked).toBeDefined();
    expect(ranked?.params).toContain(301);
    const input = memoryInput({ query: "needle" });
    const seen = new Set<string>();
    const fixtureCount = 301;
    const pageSize = Math.min(runtime.p5_config.retrieval_presets.broad.max_entries, 20);
    const maxPages = Math.ceil(fixtureCount / pageSize) + 1;
    let cursor: string | undefined;
    for (let pageNumber = 0; pageNumber < maxPages; pageNumber++) {
      const previous = cursor;
      const page = evidenceQueryPage(await memory.query({ ...input, cursor }));
      expect(page.status).toBe("ok");
      expect(page.items.length).toBeLessThanOrEqual(pageSize);
      for (const item of page.items) {
        expect(seen.has(item.id)).toBe(false);
        seen.add(item.id);
      }
      cursor = page.nextCursor ?? undefined;
      if (cursor === undefined) break;
      expect(cursor).not.toBe(previous);
    }
    expect(seen.size).toBe(fixtureCount);
    expect(cursor).toBeUndefined();
    for (let i = 0; i < 121; i++) addDocument("ordinary");
    const firstPage = evidenceQueryPage(await knowledge.query(knowledgeInput({ query: "absent" })));
    expect(firstPage.items).toEqual([]);
    expect(firstPage.nextCursor).toBeString();
    const next = evidenceQueryPage(
      await knowledge.query({
        ...knowledgeInput({ query: "absent" }),
        cursor: firstPage.nextCursor ?? undefined,
      }),
    );
    expect(next.items).toEqual([]);
    expect(next.nextCursor).toBeNull();
  });

  it("reports an oversized valid draft as unavailable instead of silently using originals", async () => {
    const id = addDocument();
    await organize();
    const body = "大".repeat(30000);
    business.db
      .query("UPDATE knowledge_drafts SET body = ?, sources = ? WHERE document_id = ?")
      .run(
        body,
        JSON.stringify([
          {
            type: "document",
            document_id: id,
            version: 1,
            start: 0,
            end: "原文𠮷正文".length,
            valid: true,
            draft_start: 0,
            draft_end: body.length,
          },
        ]),
        id,
      );
    expect(evidenceQueryPage(await knowledge.query(knowledgeInput()))).toMatchObject({
      status: "unavailable",
      code: "KNOWLEDGE_CONTEXT_BUDGET",
      items: [],
    });
  });

  it("only advertises opaque ids and preview, and does not bind undisclosed grants", async () => {
    const ids = [addDocument(), addDocument(), addDocument()].sort();
    const page = evidenceQueryPage(await knowledge.query(knowledgeInput({ limit: 1 })));
    const item = first(page.items);
    expect(item.id).toMatch(/^knowledge:original:[a-f0-9]{64}$/);
    expect(item.sources[0]?.id).toBe(ids[0]);
    expect(observed).not.toContain(ids[1]);
    expect(observed).not.toContain(ids[2]);
    const id = ids[2];
    if (!id) throw new Error("Missing undisclosed document");
    repo.replaceGrants(id, repo.detail(id).revision, []);
    expect((await readKnowledge(item)).text).toBe("原文𠮷正文");
  });

  it("validates observation provenance against the bounded memory's own QQ scope", async () => {
    const now = nowIso();
    const schemeId = crypto.randomUUID();
    const bindingId = crypto.randomUUID();
    business.orm
      .insert(schema.qqSchemes)
      .values({ id: schemeId, name: "synthetic", revision: 1, createdAt: now, updatedAt: now })
      .run();
    business.orm
      .insert(schema.qqBindings)
      .values({
        id: bindingId,
        accountId: "10001",
        conversationKind: "group",
        peerId: "20001",
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
    const journal = new ConversationEventRepository(business.db);
    const conversation = journal.ensureOneBot(bindingId);
    if (!conversation) throw new Error("Missing QQ canonical conversation");
    const event = normalizeOneBotMessage(
      {
        time: Math.floor(Date.now() / 1000),
        self_id: 10001,
        post_type: "message",
        message_type: "group",
        sub_type: "normal",
        message_id: 123,
        user_id: 30001,
        group_id: 20001,
        message: [{ type: "text", data: { text: "合成群消息" } }],
      },
      "10001",
    );
    if (event.kind !== "message") throw new Error("Missing QQ observation");
    recordObservation(business.orm, event.observation, DEFAULT_AGENT_ID);
    journal.ingestOneBotEvent(event.observation.eventKey, bindingId);
    const scopeKey = qqMemoryScopeKey({
      kind: "qq",
      accountId: "10001",
      conversationKind: "group",
      peerId: "20001",
      agentId: DEFAULT_AGENT_ID,
    });
    seedMemory("qq", "群资料", scopeKey);
    business.db.query("DELETE FROM memory_sources WHERE memory_id = 'qq'").run();
    business.orm
      .insert(schema.qqMemorySources)
      .values({
        memoryId: "qq",
        eventKey: event.observation.eventKey,
        scopeKey,
        conversationKey: qqConversationKey({ accountId: "10001", kind: "group", peerId: "20001" }),
        messageId: event.observation.messageId,
        occurredAtSeconds: event.observation.occurredAtSeconds,
        speakerKind: "member",
        speakerId: event.observation.speaker.id,
      })
      .run();
    const qqOwner = {
      kind: "qq_binding",
      id: bindingId,
      userId: DEFAULT_USER_ID,
      agentId: DEFAULT_AGENT_ID,
    } as const;
    const input = memoryInput({
      sessionId: undefined,
      conversationId: conversation.id,
      owner: qqOwner,
      scopes: [scopeKey],
    });
    const item = first(evidenceQueryPage(await memory.query(input)).items);
    expect((await memory.read({ ...input, evidence: item, offset: 0, limit: 4096 })).text).toBe(
      "群资料",
    );
    business.db
      .query("UPDATE qq_events SET peer_id = 'foreign' WHERE event_key = ?")
      .run(event.observation.eventKey);
    await expect(
      memory.read({ ...input, evidence: item, offset: 0, limit: 4096 }),
    ).rejects.toMatchObject({ code: "CONTEXT_SOURCE_INVALID" });
    expect(evidenceQueryPage(await memory.query(input)).items).toEqual([]);
    business.db
      .query("UPDATE qq_events SET peer_id=? WHERE event_key=?")
      .run("20001", event.observation.eventKey);
    business.db
      .query("UPDATE qq_events SET account_id=? WHERE event_key=?")
      .run("foreign", event.observation.eventKey);
    await expect(
      memory.read({ ...input, evidence: item, offset: 0, limit: 4096 }),
    ).rejects.toMatchObject({ code: "CONTEXT_SOURCE_INVALID" });
    expect(evidenceQueryPage(await memory.query(input)).items).toEqual([]);
    business.db
      .query("UPDATE qq_events SET account_id=? WHERE event_key=?")
      .run("10001", event.observation.eventKey);
    expect((await memory.read({ ...input, evidence: item, offset: 0, limit: 4096 })).text).toBe(
      "群资料",
    );
  });

  it("checks cancellation before and after backend work and rejects foreign owners", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(memory.query(memoryInput({ signal: controller.signal }))).rejects.toThrow();
    await expect(
      knowledge.query({ ...knowledgeInput(), signal: controller.signal }),
    ).rejects.toThrow();
    await expect(
      memory.query(memoryInput({ owner: { ...owner, userId: "foreign" } })),
    ).rejects.toMatchObject({ code: "CONTEXT_INVALID_SELECTION" });
    await expect(
      knowledge.query({ ...knowledgeInput(), owner: { ...owner, agentId: "foreign" } }),
    ).rejects.toMatchObject({ code: "CONTEXT_INVALID_SELECTION" });
  });
});
