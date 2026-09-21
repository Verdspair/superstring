import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createApp } from "../../src/server/app";
import type { BusinessDbHandle } from "../../src/server/db/connection";
import { KnowledgeRepository } from "../../src/server/db/knowledge-repository";
import {
  createSession,
  DEFAULT_AGENT_ID,
  ensureDefaults,
  getTurnByRequest,
  prepareTurn,
} from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import type { ModelGateway } from "../../src/server/llm/model-gateway";
import { ContextBuilder, estimateMessages } from "../../src/server/services/context-builder";
import {
  KnowledgeContext,
  knowledgeCost,
  knowledgeTerms,
} from "../../src/server/services/knowledge-context";
import { KnowledgeOrganizer } from "../../src/server/services/knowledge-organizer";
import { ContentItemSchema } from "../../src/shared/contracts/content";

let db: BusinessDbHandle;
let repo: KnowledgeRepository;
let context: KnowledgeContext;
let gateway: ModelGateway;
let completeCalls: Parameters<ModelGateway["complete"]>[0][];
let streamCalls: Parameters<ModelGateway["streamChat"]>[0][];
const question = "温度低时允许启动吗，阈值多少？";
const source = "\uFEFF低于10°C时禁止启动。\r\n阈值42.5，维护模式除外。𠮷";
beforeEach(() => {
  db = openBusinessDb();
  ensureDefaults(db.orm, "synthetic");
  repo = new KnowledgeRepository(db.db);
  context = new KnowledgeContext(db.db);
  completeCalls = [];
  streamCalls = [];
  gateway = {
    config: { baseUrl: "http://synthetic.invalid/v1", model: "synthetic", timeoutSeconds: 1 },
    async listModels() {
      return ["synthetic"];
    },
    async loadedContextCapacity() {
      return 32768;
    },
    async probeModelLoaded() {
      return true;
    },
    async complete(call) {
      completeCalls.push(call);
      const shape = call.responseSchema?.properties as { ids?: { items?: { enum?: string[] } } };
      return JSON.stringify({ ids: shape?.ids?.items?.enum ?? [] });
    },
    async *streamChat(call) {
      streamCalls.push(call);
      yield "合成回答";
    },
  };
});
afterEach(() => db.close());
function add(text = source, grant = true, name = "设备规程") {
  const doc = repo.importDocument({ name, category_id: "default", original_text: text });
  return grant ? repo.replaceGrants(doc.id, doc.revision, [DEFAULT_AGENT_ID]) : doc;
}
function active(text = question) {
  const session = createSession(db.orm, "合成会话", { modelName: "synthetic" });
  const request = crypto.randomUUID();
  const prepared = prepareTurn(db.orm, session.id, text, request);
  const turn = getTurnByRequest(db.orm, session.id, request);
  if (!turn || !prepared.generationToken) throw new Error("Missing turn");
  return { session, request, prepared, turn, token: prepared.generationToken };
}
function begin(a: ReturnType<typeof active>) {
  context.begin(a.turn.id, DEFAULT_AGENT_ID, a.token, question);
}
function finish(
  a: ReturnType<typeof active>,
  available = 4096,
  select = async (candidates: Array<Record<string, unknown>>) =>
    candidates.map((item) => String(item.id)),
) {
  return context.finish({
    turnId: a.turn.id,
    agentId: DEFAULT_AGENT_ID,
    generationToken: a.token,
    available,
    select,
  });
}
function revoke(id: string) {
  const doc = repo.detail(id);
  repo.replaceGrants(id, doc.revision, []);
}
function parse(messages: { content: string }[]) {
  if (!messages[0]) return [];
  const parts = JSON.parse(messages[0].content.slice(messages[0].content.indexOf("\n") + 1));
  return parts as Array<{
    body: string;
    content_origin: string;
    sources: Array<{ start: number; end: number }>;
  }>;
}

describe("authorized knowledge context", () => {
  it("finds Chinese short questions and exact numeric terms", () => {
    expect(knowledgeTerms("启动条件 42.5")).toContain("启动");
    expect(knowledgeTerms("启动条件 42.5")).toContain("42.5");
  });
  it("filters unauthorized names and text before candidate selection", async () => {
    add();
    add("private-body", false, "private-title");
    const a = active();
    begin(a);
    await finish(a, 4096, async (items) => {
      expect(JSON.stringify(items)).not.toContain("private");
      return items.map((item) => String(item.id));
    });
    const saved = db.db
      .query<{ items: string }, []>("SELECT items FROM turn_knowledge_snapshots")
      .get();
    expect(saved?.items).not.toContain("private");
  });
  it("returns exact original slices and counts source/format cost", async () => {
    add();
    const a = active();
    begin(a);
    const messages = await finish(a);
    for (const item of parse(messages)) {
      const range = item.sources[0];
      expect(item.body).toBe(source.slice(range?.start, range?.end));
    }
    expect(estimateMessages(messages) - 3).toBeLessThanOrEqual(4096);
  });
  it("does not send unrelated material when the selector returns no IDs", async () => {
    add();
    const a = active();
    begin(a);
    expect(await finish(a, 4096, async () => [])).toEqual([]);
  });
  it("offers bounded originals even for synonym-only questions", async () => {
    add("发动机在低温环境下禁止运行。", true, "规则");
    const a = active("冷天能开机吗？");
    context.begin(a.turn.id, DEFAULT_AGENT_ID, a.token, "冷天能开机吗？");
    expect(parse(await finish(a))[0]?.body).toContain("低温");
  });
  it("covers original details beyond a missing summary", async () => {
    add(`${"无关内容。".repeat(500)}最低温度是7.25°C，除非维护模式。`, true, "长文");
    const a = active("最低温度");
    context.begin(a.turn.id, DEFAULT_AGENT_ID, a.token, "最低温度");
    expect(JSON.stringify(await finish(a))).toContain("7.25");
  });
  it("bounds candidate count and does not send a whole long document", async () => {
    for (let i = 0; i < 20; i++) add(`${i}规则。`.repeat(100));
    const a = active();
    begin(a);
    await finish(a, 4096, async (items) => {
      expect(items.length).toBeLessThanOrEqual(12);
      return [];
    });
    const saved = db.db
      .query<{ items: string }, []>("SELECT items FROM turn_knowledge_snapshots")
      .get();
    const snapshot = JSON.parse(saved?.items ?? "{}");
    expect(Buffer.byteLength(JSON.stringify(snapshot.candidates))).toBeLessThanOrEqual(8192);
  });
  it("chooses complete pieces and skips over-budget long sentences", async () => {
    add("长".repeat(10000));
    const a = active();
    begin(a);
    expect(await finish(a)).toEqual([]);
  });
  it("skips knowledge when there is no total budget left without a selector call", async () => {
    add();
    const a = active();
    begin(a);
    expect(
      await finish(a, 10, async () => {
        throw new Error("must not select");
      }),
    ).toEqual([]);
  });
  it("freezes mode, content, budget and final selection across retry", async () => {
    const doc = add();
    const a = active();
    begin(a);
    const first = await finish(a);
    repo.updateDocument(doc.id, {
      expected_revision: doc.revision,
      original_text: "新资料不应进入旧请求",
      content_mode: "original",
    });
    const settings = repo.settings();
    repo.updateSettings({ ...settings, context_budget: 1, expected_revision: settings.revision });
    begin(a);
    expect(
      await finish(a, 4096, async () => {
        throw new Error("must reuse");
      }),
    ).toEqual(first);
  });
  it("rejects shrinking total room for a frozen snapshot instead of silently trimming", async () => {
    add();
    const a = active();
    begin(a);
    await finish(a);
    await expect(finish(a, 1)).rejects.toMatchObject({ code: "KNOWLEDGE_CONTEXT_BUDGET" });
  });
  for (const mutation of ["revoke", "delete", "regrant"] as const) {
    it(`rejects ${mutation} before reusing frozen content`, async () => {
      const doc = add();
      const a = active();
      begin(a);
      await finish(a);
      if (mutation === "delete") repo.deleteDocument(doc.id, doc.revision);
      else {
        revoke(doc.id);
        if (mutation === "regrant") {
          const current = repo.detail(doc.id);
          repo.replaceGrants(doc.id, current.revision, [DEFAULT_AGENT_ID]);
        }
      }
      await expect(finish(a)).rejects.toMatchObject({ code: "KNOWLEDGE_ACCESS_CHANGED" });
    });
  }
  it("rejects revocation during selection before publishing final material", async () => {
    const doc = add();
    const a = active();
    begin(a);
    await expect(
      finish(a, 4096, async (items) => {
        revoke(doc.id);
        return items.map((item) => String(item.id));
      }),
    ).rejects.toMatchObject({ code: "KNOWLEDGE_ACCESS_CHANGED" });
  });
  it("accepts metadata changes and additions without granting the frozen turn new access", async () => {
    const doc = add();
    const a = active();
    begin(a);
    repo.updateDocument(doc.id, { expected_revision: doc.revision, name: "改名" });
    add("新增资料");
    expect(JSON.stringify(await finish(a))).not.toContain("新增资料");
  });
  it("rejects a selector's fabricated or duplicate identifiers", async () => {
    add();
    const a = active();
    begin(a);
    await expect(finish(a, 4096, async () => ["fake"])).rejects.toMatchObject({
      code: "CONTEXT_INVALID_SELECTION",
    });
    await expect(
      finish(a, 4096, async (items) => [String(items[0]?.id), String(items[0]?.id)]),
    ).rejects.toMatchObject({ code: "CONTEXT_INVALID_SELECTION" });
  });
  it("checks generation ownership before saving", async () => {
    add();
    const a = active();
    begin(a);
    await expect(
      finish(a, 4096, async (items) => {
        db.db.query("UPDATE turns SET generation_token = 'new-owner' WHERE id = ?").run(a.turn.id);
        return items.map((item) => String(item.id));
      }),
    ).rejects.toMatchObject({ code: "GENERATION_OWNERSHIP_LOST" });
  });
  it("rejects corrupted snapshots and mismatched agent", async () => {
    add();
    const a = active();
    begin(a);
    expect(() => context.assertAccess(a.turn.id, "wrong-agent")).toThrow();
    db.db
      .query("UPDATE turn_knowledge_snapshots SET items = '{}' WHERE turn_id = ?")
      .run(a.turn.id);
    await expect(finish(a)).rejects.toMatchObject({ code: "KNOWLEDGE_SNAPSHOT_INVALID" });
  });
  it("uses mapped draft fragments with exact supplemental originals, not guessed paragraphs", async () => {
    const doc = add();
    gateway.complete = async () =>
      JSON.stringify({ summary: "条件", tags: [], body: "## 条件\n\n禁止低温启动。" });
    await new KnowledgeOrganizer({ db: db.db, gateway }).runCycle();
    const a = active();
    begin(a);
    const items = parse(await finish(a));
    expect(items.map((item) => item.content_origin)).toEqual(["derived", "original"]);
    expect(items[1]?.body).toBe(source);
    const draft = repo.detail(doc.id).draft;
    expect(ContentItemSchema.safeParse(draft).success).toBe(true);
    if (!draft) throw new Error("Missing draft");
    expect(knowledgeCost([draft])).toBeGreaterThan(Buffer.byteLength(draft.body ?? ""));
  });
  it("falls back to originals for old drafts without explicit mappings", async () => {
    const doc = add();
    db.db
      .query(
        "INSERT INTO knowledge_drafts (id, document_id, content_version, summary, tags, body, sources, model_name, created_at) VALUES (?, ?, 1, 'summary', '[]', 'unmapped draft', '[]', 'synthetic', 'now')",
      )
      .run(crypto.randomUUID(), doc.id);
    const a = active();
    begin(a);
    expect(parse(await finish(a)).every((item) => item.content_origin === "original")).toBe(true);
  });
  it("builds actual chat context and rechecks access after final capacity probe", async () => {
    const doc = add();
    const a = active();
    let probes = 0;
    gateway.loadedContextCapacity = async () => {
      if (++probes === 2) revoke(doc.id);
      return 32768;
    };
    const builder = new ContextBuilder({ orm: db.orm, db: db.db, gateway });
    await expect(
      builder.build({
        sessionId: a.session.id,
        currentTurnId: a.turn.id,
        runtime: a.prepared.runtime,
        generationToken: a.token,
      }),
    ).rejects.toMatchObject({ code: "KNOWLEDGE_ACCESS_CHANGED" });
  });
  it("HTTP chat retries reject revoked knowledge and new request uses fresh permissions", async () => {
    const doc = add();
    const session = createSession(db.orm, "HTTP合成", { modelName: "synthetic" });
    const app = createApp({
      business: db,
      gateway,
      browserStateSecret: "synthetic-knowledge-context",
    });
    const request = crypto.randomUUID();
    gateway.streamChat = async function* (call) {
      streamCalls.push(call);
      yield "合成中间内容";
      throw new Error("synthetic failure");
    };
    const send = (key: string) =>
      app.request("/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session_id: session.id, message: question, client_request_id: key }),
      });
    await (await send(request)).text();
    expect(JSON.stringify(streamCalls)).toContain("42.5");
    revoke(doc.id);
    const retry = await (await send(request)).text();
    expect(retry).toContain("KNOWLEDGE_ACCESS_CHANGED");
    expect(streamCalls).toHaveLength(1);
    gateway.streamChat = async function* (call) {
      streamCalls.push(call);
      yield "新请求";
    };
    expect(await (await send(crypto.randomUUID())).text()).toContain("done");
    expect(JSON.stringify(streamCalls.at(-1))).not.toContain("42.5");
  });
});
