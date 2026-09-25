import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createApp } from "../../src/server/app";
import type { BusinessDbHandle } from "../../src/server/db/connection";
import { KnowledgeReadRepository } from "../../src/server/db/knowledge-read-repository";
import { KnowledgeRepository } from "../../src/server/db/knowledge-repository";
import {
  createSession,
  DEFAULT_AGENT_ID,
  ensureDefaults,
  getTurnByRequest,
  prepareTurn,
  saveFailedAssistantMessage,
} from "../../src/server/db/repositories";
import { ensureBusinessSchema, openBusinessDb } from "../../src/server/db/schema-gate";
import { createAgent } from "../../src/server/services/agent-service";
import { KnowledgeContext } from "../../src/server/services/knowledge-context";
import {
  AgentKnowledgeReadConfigSchema,
  AgentKnowledgeReadSettingsSchema,
} from "../../src/shared/contracts/knowledge";

let h: BusinessDbHandle;
let read: KnowledgeReadRepository;
let library: KnowledgeRepository;
const agent = DEFAULT_AGENT_ID;
const config = AgentKnowledgeReadConfigSchema.parse({});
beforeEach(() => {
  h = openBusinessDb();
  ensureDefaults(h.orm, "synthetic");
  read = new KnowledgeReadRepository(h.db);
  library = new KnowledgeRepository(h.db);
});
afterEach(() => h.close());
function update(patch: Partial<typeof config>) {
  return read.update(agent, {
    expected_revision: read.settings(agent).revision,
    config: { ...read.settings(agent).config, ...patch },
  });
}
function add(grant = true) {
  const doc = library.importDocument({
    name: "规则",
    category_id: "default",
    original_text: "温度低于10时禁止启动。",
  });
  return grant ? library.replaceGrants(doc.id, doc.revision, [agent]) : doc;
}
function turn() {
  const session = createSession(h.orm, "合成会话", { modelName: "synthetic" });
  const request = crypto.randomUUID();
  const prepared = prepareTurn(h.orm, session.id, "启动条件", request);
  const row = getTurnByRequest(h.orm, session.id, request);
  if (!row || !prepared.generationToken) throw new Error("Missing fixture");
  return { session, request, prepared, row, token: prepared.generationToken };
}
function snapshot(t: ReturnType<typeof turn>) {
  new KnowledgeContext(h.db).begin(t.row.id, agent, t.token, "启动条件");
  return JSON.parse(
    (
      h.db.query("SELECT items FROM turn_knowledge_snapshots WHERE turn_id = ?").get(t.row.id) as {
        items: string;
      }
    ).items,
  );
}
async function req(id: string, body?: unknown) {
  return createApp({ business: h }).request(
    `/agents/${id}/knowledge-read-settings`,
    body === undefined
      ? {}
      : {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
  );
}

describe("S3 per-assistant reading persistence and API", () => {
  it("initializes defaults and new assistants independently", () => {
    expect(read.settings(agent)).toEqual({ revision: 1, config });
    const other = createAgent(
      h.orm,
      { name: "另一个", model_name: "synthetic" },
      {
        core_identity: "",
        communication_style: "",
        interaction_boundaries: "",
        example_dialogues: "",
        advanced_instructions: "",
      },
    );
    expect(read.settings(other.id)).toEqual({ revision: 1, config });
    update({ enabled: false });
    expect(read.settings(other.id).config.enabled).toBe(true);
  });
  it("GET is read-only and PUT has an independent revision", async () => {
    const before = h.db.query("SELECT config_version FROM agents WHERE id = ?").get(agent);
    expect(AgentKnowledgeReadSettingsSchema.parse(await (await req(agent)).json())).toEqual({
      revision: 1,
      config,
    });
    expect(
      (await req(agent, { expected_revision: 1, config: { ...config, enabled: false } })).status,
    ).toBe(200);
    expect((await req(agent, { expected_revision: 1, config })).status).toBe(409);
    expect(read.settings(agent).config.enabled).toBe(false);
    expect(h.db.query("SELECT config_version FROM agents WHERE id = ?").get(agent)).toEqual(before);
  });
  it("rejects malformed, unknown assistant, unknown fields and ungranted selections", async () => {
    expect((await req("not-a-uuid")).status).toBe(422);
    expect((await req(crypto.randomUUID())).status).toBe(404);
    expect((await req(agent, { expected_revision: 1, config, model_name: "leak" })).status).toBe(
      422,
    );
    const hidden = add(false);
    expect(
      (
        await req(agent, {
          expected_revision: 1,
          config: { ...config, scope: "selected", document_ids: [hidden.id] },
        })
      ).status,
    ).toBe(404);
    expect(read.settings(agent).revision).toBe(1);
  });
  it("no-op preserves revision; reordered selected IDs are no-op", () => {
    expect(update({}).revision).toBe(1);
    const a = add(),
      b = add();
    update({ scope: "selected", document_ids: [b.id, a.id] });
    expect(update({ document_ids: [a.id, b.id] }).revision).toBe(2);
  });
  it("changing reading settings neither revokes grants nor cancels organization", () => {
    add();
    const grants = h.db.query("SELECT * FROM knowledge_grants").all();
    const jobs = h.db.query("SELECT * FROM knowledge_jobs").all();
    const global = library.settings();
    update({ enabled: false, context_budget: 8000, scope: "selected", document_ids: [] });
    expect(h.db.query("SELECT * FROM knowledge_grants").all()).toEqual(grants);
    expect(h.db.query("SELECT * FROM knowledge_jobs").all()).toEqual(jobs);
    expect(library.settings()).toEqual(global);
  });
  it("missing or corrupt settings fail closed rather than invent defaults", () => {
    h.db
      .query(
        "UPDATE agent_knowledge_read_settings SET document_ids = '[42]', scope = 'selected' WHERE agent_id = ?",
      )
      .run(agent);
    expect(() => read.settings(agent)).toThrow();
    h.db.query("DELETE FROM agent_knowledge_read_settings WHERE agent_id = ?").run(agent);
    expect(() => turn()).toThrow();
    expect(h.db.query("SELECT * FROM turns").all()).toEqual([]);
  });
});

describe("S3 new-turn reading snapshot", () => {
  it("freezes inherited budget and rules before delayed context assembly", () => {
    add();
    const t = turn();
    update({ enabled: false, context_budget: 1, scope: "selected", document_ids: [] });
    library.updateSettings({
      ...library.settings(),
      context_budget: 1,
      auto_enabled: false,
      expected_revision: library.settings().revision,
    });
    const saved = snapshot(t);
    expect(saved.budget).toBe(16384);
    expect(saved.candidates.length).toBeGreaterThan(0);
    expect(t.prepared.runtime.knowledge_read?.auto_enabled).toBe(true);
    expect(snapshot(turn()).candidates).toEqual([]);
  });
  it("assistant override can exceed global default and remains frozen", () => {
    // 32768 is twice the global default (16384), so "override exceeds global"
    // stays meaningful whatever the default becomes.
    update({ context_budget: 32768 });
    const t = turn();
    expect(t.prepared.runtime.knowledge_read?.budget_source).toBe("assistant");
    update({ context_budget: null });
    expect(snapshot(t).budget).toBe(32768);
    expect(turn().prepared.runtime.knowledge_read?.budget).toBe(16384);
  });
  it("disabled and empty selected make zero selector calls", async () => {
    add();
    for (const patch of [
      { enabled: false },
      { enabled: true, scope: "selected" as const, document_ids: [] },
    ]) {
      update(patch);
      const t = turn();
      const ctx = new KnowledgeContext(h.db);
      snapshot(t);
      let calls = 0;
      expect(
        await ctx.finish({
          turnId: t.row.id,
          agentId: agent,
          generationToken: t.token,
          available: 4096,
          select: async () => {
            calls++;
            return [];
          },
        }),
      ).toEqual([]);
      expect(calls).toBe(0);
    }
  });
  it("selected intersects live authorization without falling back", () => {
    const chosen = add();
    const other = add();
    update({ scope: "selected", document_ids: [chosen.id] });
    const t = turn();
    library.replaceGrants(chosen.id, library.detail(chosen.id).revision, []);
    const saved = snapshot(t);
    expect(saved.candidates).toEqual([]);
    expect(JSON.stringify(saved)).not.toContain(other.id);
    expect(read.settings(agent).config.document_ids).toEqual([chosen.id]);
  });
  it("all includes newly authorized documents on new turns", () => {
    expect(snapshot(turn()).candidates).toEqual([]);
    const doc = add();
    expect(
      snapshot(turn()).candidates.some((c: { document_id: string }) => c.document_id === doc.id),
    ).toBe(true);
  });
  it("same-request retry before begin reuses frozen values", () => {
    add();
    const t = turn();
    saveFailedAssistantMessage(h.orm, t.session.id, t.request, "MODEL_ERROR", t.token);
    update({ enabled: false, context_budget: 1 });
    const retry = prepareTurn(h.orm, t.session.id, "启动条件", t.request);
    expect(retry.runtime.knowledge_read).toEqual(t.prepared.runtime.knowledge_read);
    if (!retry.generationToken) throw new Error("Missing retry token");
    expect(snapshot({ ...t, token: retry.generationToken }).candidates.length).toBeGreaterThan(0);
  });
  it("finished snapshot remains byte-identical after config changes; revoke/regrant still conflicts", async () => {
    const doc = add();
    const t = turn();
    snapshot(t);
    const ctx = new KnowledgeContext(h.db);
    const messages = await ctx.finish({
      turnId: t.row.id,
      agentId: agent,
      generationToken: t.token,
      available: 4096,
      select: async (items) => items.map((i) => String(i.id)),
    });
    const before = h.db.query("SELECT items FROM turn_knowledge_snapshots").get();
    update({ enabled: false });
    expect(
      await ctx.finish({
        turnId: t.row.id,
        agentId: agent,
        generationToken: t.token,
        available: 4096,
        select: async () => [],
      }),
    ).toEqual(messages);
    expect(h.db.query("SELECT items FROM turn_knowledge_snapshots").get()).toEqual(before);
    library.replaceGrants(doc.id, library.detail(doc.id).revision, []);
    library.replaceGrants(doc.id, library.detail(doc.id).revision, [agent]);
    expect(() => ctx.assertAccess(t.row.id, agent)).toThrow();
  });
  it("legacy runtime without S3 config reads its existing v1 snapshot", () => {
    add();
    const t = turn();
    const saved = snapshot(t);
    const legacy = { ...t.prepared.runtime };
    delete legacy.knowledge_read;
    h.db
      .query("UPDATE turns SET runtime_config_snapshot = ? WHERE id = ?")
      .run(JSON.stringify(legacy), t.row.id);
    update({ enabled: false, context_budget: 1 });
    expect(snapshot(t)).toEqual(saved);
  });
  it("legacy runtime without any knowledge snapshot keeps former initialization semantics", () => {
    add();
    const t = turn();
    const legacy = { ...t.prepared.runtime };
    delete legacy.knowledge_read;
    h.db
      .query("UPDATE turns SET runtime_config_snapshot = ? WHERE id = ?")
      .run(JSON.stringify(legacy), t.row.id);
    update({ enabled: false });
    expect(snapshot(t).candidates.length).toBeGreaterThan(0);
  });
  it("invalid frozen rules reject rather than consulting latest settings", () => {
    const t = turn();
    h.db
      .query("UPDATE turns SET runtime_config_snapshot = ? WHERE id = ?")
      .run(JSON.stringify({ ...t.prepared.runtime, knowledge_read: { budget: 0 } }), t.row.id);
    expect(() => snapshot(t)).toThrow();
    expect(h.db.query("SELECT * FROM turn_knowledge_snapshots").all()).toEqual([]);
  });
});

describe("S3 known migration", () => {
  const sql = [
    "0001_initial.sql",
    "0002_knowledge.sql",
    "0003_knowledge_read.sql",
    "0004_organization.sql",
    "0005_qq_transport.sql",
    "0006_qq_memory_sources.sql",
    "0007_qq_observation_text.sql",
    "0008_qq_memory_batch.sql",
    "0009_qq_transport_config.sql",
    "0010_qq_schemes.sql",
    "0011_qq_speech_log.sql",
    "0012_qq_media_notes.sql",
    "0013_qq_scheme_triggers.sql",
    "0014_qq_send_log.sql",
    "0015_qq_scheme_rhythm.sql",
    "0016_qq_context_budget.sql",
    "0017_qq_scheme_prompts.sql",
    "0018_qq_members.sql",
    "0019_qq_output_reserve.sql",
    "0020_qq_scheme_stickers.sql",
    "0021_qq_stickers.sql",
    "0022_qq_sticker_authorization.sql",
    "0023_qq_dispatch.sql",
    "0024_qq_media_purposes.sql",
  ].map((f) => readFileSync(path.join(import.meta.dir, "../../migrations/versions", f), "utf8"));
  it("v2 upgrade seeds existing assistants and preserves all v2 data", () => {
    const db = new Database(":memory:");
    try {
      db.exec(sql.slice(0, 2).join("\n"));
      db.exec("PRAGMA user_version = 2");
      db.exec(
        "INSERT INTO agents (id,name,system_prompt,description,additional_instructions,p5_config,model_name,memory_consolidation_prompt,memory_consolidation_additional_instructions,memory_retrieval_prompt,created_at,updated_at) VALUES ('a','合成','','','','{}','fake','','','','now','now')",
      );
      const before = db.query("SELECT * FROM agents").all();
      ensureBusinessSchema(db);
      expect(db.query("SELECT * FROM agents").all()).toEqual(before);
      expect(db.query("SELECT * FROM agent_knowledge_read_settings").get()).toEqual({
        agent_id: "a",
        enabled: 1,
        context_budget: null,
        scope: "all",
        document_ids: "[]",
        revision: 1,
      });
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 38 });
      ensureBusinessSchema(db);
      expect(db.query("SELECT count(*) AS n FROM agent_knowledge_read_settings").get()).toEqual({
        n: 1,
      });
      db.exec("PRAGMA foreign_keys = ON; DELETE FROM agents WHERE id = 'a'");
      expect(db.query("SELECT * FROM agent_knowledge_read_settings").all()).toEqual([]);
    } finally {
      db.close();
    }
  });
  it("v3 failure rolls back table, seeds, and version to exact v2", () => {
    const db = new Database(":memory:");
    try {
      db.exec(sql.slice(0, 2).join("\n"));
      db.exec("PRAGMA user_version = 2; INSERT INTO users VALUES ('u','合成','now')");
      const before = db.query("SELECT * FROM sqlite_master ORDER BY name").all();
      const failure = `${sql[2]}\nCREATE TABLE guard (n INTEGER CHECK(n=0)); INSERT INTO guard SELECT count(*) FROM users;`;
      expect(() =>
        ensureBusinessSchema(db, [
          sql[0] ?? "",
          sql[1] ?? "",
          failure,
          sql[3] ?? "",
          sql[4] ?? "",
          sql[5] ?? "",
          sql[6] ?? "",
          sql[7] ?? "",
          sql[8] ?? "",
          sql[9] ?? "",
          sql[10] ?? "",
          sql[11] ?? "",
          sql[12] ?? "",
          sql[13] ?? "",
          sql[14] ?? "",
          sql[15] ?? "",
          sql[16] ?? "",
          sql[17] ?? "",
          sql[18] ?? "",
          sql[19] ?? "",
          sql[20] ?? "",
          sql[21] ?? "",
          sql[22] ?? "",
          sql[23] ?? "",
          sql[24] ?? "",
          sql[25] ?? "",
          sql[26] ?? "",
          sql[27] ?? "",
          sql[28] ?? "",
          sql[29] ?? "",
          sql[30] ?? "",
          sql[31] ?? "",
          sql[32] ?? "",
          sql[33] ?? "",
          sql[34] ?? "",
          sql[35] ?? "",
          sql[36] ?? "",
          sql[37] ?? "",
        ]),
      ).toThrow();
      expect(db.query("SELECT * FROM sqlite_master ORDER BY name").all()).toEqual(before);
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 2 });
    } finally {
      db.close();
    }
  });
  it("rejects modified v2 before applying v3", () => {
    const db = new Database(":memory:");
    try {
      db.exec(sql.slice(0, 2).join("\n"));
      db.exec("PRAGMA user_version = 2; CREATE INDEX unexpected ON agents(name)");
      expect(() => ensureBusinessSchema(db)).toThrow("REJECT_UNKNOWN_STRUCTURE");
      expect(
        db
          .query("SELECT name FROM sqlite_master WHERE name = 'agent_knowledge_read_settings'")
          .get(),
      ).toBeNull();
    } finally {
      db.close();
    }
  });
});
