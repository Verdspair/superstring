import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Hono } from "hono";
import { createApp } from "../../src/server/app";
import type { BusinessDbHandle } from "../../src/server/db/connection";
import { KnowledgeRepository } from "../../src/server/db/knowledge-repository";
import { DEFAULT_AGENT_ID, ensureDefaults } from "../../src/server/db/repositories";
import { agents } from "../../src/server/db/schema";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import {
  AgentKnowledgeSchema,
  KnowledgeDocumentDetailSchema,
} from "../../src/shared/contracts/knowledge";

let db: BusinessDbHandle;
let app: Hono;
let repo: KnowledgeRepository;
const original = "\uFEFF# 原文\r\n  中文𠮷\t42.5\n条件：温度低于10°C时不要开启。";
const otherId = "00000000-0000-4000-8000-000000000002";
async function request(url: string, method = "GET", body?: unknown) {
  return app.request(url, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
}
function add(name = "导入资料", text = original) {
  return repo.importDocument({ name, category_id: "default", original_text: text });
}
function secondAgent() {
  const first = db.orm.select().from(agents).get();
  if (!first) throw new Error("Missing synthetic default agent");
  db.orm
    .insert(agents)
    .values({ ...first, id: otherId, name: "第二助手" })
    .run();
}
function draft(id: string) {
  db.db
    .query(
      "INSERT INTO knowledge_drafts (id, document_id, content_version, summary, tags, body, sources, model_name, created_at) VALUES (?, ?, 1, '摘要', '[]', '整理稿', '[]', 'synthetic', 'now')",
    )
    .run(crypto.randomUUID(), id);
}
beforeEach(() => {
  db = openBusinessDb();
  ensureDefaults(db.orm, "synthetic");
  repo = new KnowledgeRepository(db.db);
  app = createApp({ business: db });
});
afterEach(() => db.close());

describe("knowledge management API", () => {
  it("starts with one editable category, default-on settings and no grants", async () => {
    expect(await (await request("/knowledge/settings")).json()).toEqual({
      auto_enabled: true,
      model_name: null,
      context_budget: 16384,
      revision: 1,
    });
    expect(repo.categories()).toEqual([
      { id: "default", name: "资料", revision: 1, document_count: 0 },
    ]);
    expect(await (await request(`/agents/${DEFAULT_AGENT_ID}/knowledge`)).json()).toEqual([]);
    const response = await request("/knowledge/categories/default", "PATCH", {
      name: "我的资料",
      expected_revision: 1,
    });
    expect(response.status).toBe(200);
    expect(repo.categories()[0]?.name).toBe("我的资料");
  });

  it("JSON import preserves BOM, CRLF, whitespace and astral characters exactly", async () => {
    const response = await request("/knowledge/documents", "POST", {
      name: "原文",
      category_id: "default",
      original_text: original,
    });
    expect(response.status).toBe(201);
    const detail = KnowledgeDocumentDetailSchema.parse(await response.json());
    expect(detail.original_text).toBe(original);
    expect(detail.content.body).toBe(original);
    expect(detail.content.sources).toEqual([
      {
        type: "document",
        document_id: detail.id,
        version: 1,
        start: 0,
        end: original.length,
        valid: true,
      },
    ]);
    expect(detail.agent_ids).toEqual([]);
    expect(detail.organization_status).toBe("queued");
    expect(detail.import_type).toBe("text");
    expect(repo.documents()[0]).not.toHaveProperty("original_text");
  });

  for (const extension of ["txt", "md", "MD"]) {
    it(`uploads UTF-8 ${extension} without stripping its BOM`, async () => {
      const form = new FormData();
      form.set("file", new File([new TextEncoder().encode(original)], `资料.${extension}`));
      form.set("category_id", "default");
      const response = await app.request("/knowledge/import", { method: "POST", body: form });
      expect(response.status).toBe(201);
      const detail = KnowledgeDocumentDetailSchema.parse(await response.json());
      expect(detail.original_text).toBe(original);
      expect(detail.import_type).toBe(extension === "txt" ? "txt" : "md");
    });
  }

  for (const text of ["", " \r\n\t\uFEFF", "abc\0def", "broken\uD800"]) {
    it(`rejects invalid text ${JSON.stringify(text)} without writes`, async () => {
      expect(
        (
          await request("/knowledge/documents", "POST", {
            name: "资料",
            category_id: "default",
            original_text: text,
          })
        ).status,
      ).toBe(422);
      expect(repo.documents()).toEqual([]);
    });
  }

  it("rejects unsupported files, invalid UTF-8, missing and duplicate files", async () => {
    for (const [name, bytes] of [
      ["a.pdf", new Uint8Array([65])],
      ["a.txt", new Uint8Array([0xff])],
    ] as const) {
      const form = new FormData();
      form.set("category_id", "default");
      form.set("file", new File([bytes], name));
      const response = await app.request("/knowledge/import", { method: "POST", body: form });
      expect(response.status).toBe(422);
      expect((await response.json()).error.code).toBe("KNOWLEDGE_IMPORT_INVALID");
    }
    const duplicate = new FormData();
    duplicate.set("category_id", "default");
    duplicate.append("file", new File(["ok"], "a.txt"));
    duplicate.append("file", new File(["ok"], "b.md"));
    expect(
      (await app.request("/knowledge/import", { method: "POST", body: duplicate })).status,
    ).toBe(422);
    expect((await request("/knowledge/import", "POST", {})).status).toBe(422);
    expect(repo.documents()).toEqual([]);
  });

  it("rejects unknown fields and client-supplied grants/import type", async () => {
    for (const extra of [
      { agent_ids: [DEFAULT_AGENT_ID] },
      { import_type: "md" },
      { content_version: 9 },
    ]) {
      expect(
        (
          await request("/knowledge/documents", "POST", {
            name: "资料",
            category_id: "default",
            original_text: "原文",
            ...extra,
          })
        ).status,
      ).toBe(422);
    }
    expect(repo.documents()).toEqual([]);
  });

  it("does not execute imported script or HTML", async () => {
    const text = "<script>throw new Error('never run')</script>\nrm -rf example";
    const detail = add("脚本仅文本", text);
    expect(repo.detail(detail.id).original_text).toBe(text);
    expect((await request(`/knowledge/documents/${detail.id}`)).status).toBe(200);
  });

  it("category deletion requires a target and atomically preserves documents and grants", async () => {
    const item = add();
    const granted = repo.replaceGrants(item.id, item.revision, [DEFAULT_AGENT_ID]);
    const target = repo.createCategory("目标");
    const noTarget = await request("/knowledge/categories/default", "DELETE", {
      expected_revision: 1,
    });
    expect(noTarget.status).toBe(409);
    expect(repo.detail(item.id).category_id).toBe("default");
    expect(
      (
        await request("/knowledge/categories/default", "DELETE", {
          expected_revision: 1,
          move_to: target.id,
        })
      ).status,
    ).toBe(204);
    const after = repo.detail(item.id);
    expect(after.category_id).toBe(target.id);
    expect(after.revision).toBe(granted.revision + 1);
    expect(after.original_text).toBe(original);
    expect(after.agent_ids).toEqual([DEFAULT_AGENT_ID]);
    expect(
      (await request(`/knowledge/categories/${target.id}`, "DELETE", { expected_revision: 1 }))
        .status,
    ).toBe(409);
  });

  it("category rename conflicts and invalid destinations leave all data unchanged", async () => {
    const item = add();
    repo.createCategory("目标");
    expect(
      (
        await request("/knowledge/categories/default", "PATCH", {
          name: "bad",
          expected_revision: 2,
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await request("/knowledge/categories/default", "DELETE", {
          expected_revision: 1,
          move_to: otherId,
        })
      ).status,
    ).toBe(404);
    expect(repo.categories()[0]?.name).toBe("资料");
    expect(repo.detail(item.id).revision).toBe(1);
  });

  it("explicit grants support multiple agents and never follow categories", async () => {
    secondAgent();
    const first = add("已授权");
    repo.replaceGrants(first.id, 1, [DEFAULT_AGENT_ID, otherId]);
    const second = add("未授权");
    const category = repo.createCategory("另一个分类");
    repo.updateDocument(first.id, { expected_revision: 2, category_id: category.id });
    repo.updateDocument(second.id, { expected_revision: 1, category_id: category.id });
    expect(repo.detail(first.id).agent_ids.sort()).toEqual([DEFAULT_AGENT_ID, otherId].sort());
    expect(repo.detail(second.id).agent_ids).toEqual([]);
  });

  it("unauthorized title, summary and body stay outside agent reads", async () => {
    secondAgent();
    const hidden = add("绝密标题", "绝密正文");
    draft(hidden.id);
    const allowed = add("公开给助手");
    repo.replaceGrants(allowed.id, 1, [DEFAULT_AGENT_ID]);
    const response = await request(`/agents/${DEFAULT_AGENT_ID}/knowledge`);
    const text = await response.text();
    expect(text).not.toContain("绝密");
    expect(text).not.toContain("摘要");
    expect(AgentKnowledgeSchema.array().parse(JSON.parse(text))).toHaveLength(1);
    expect(() => repo.authorizedDetail(DEFAULT_AGENT_ID, hidden.id)).toThrow("资料不存在或未授权");
    expect(repo.agentDocuments(otherId)).toEqual([]);
    expect((await request(`/agents/${crypto.randomUUID()}/knowledge`)).status).toBe(404);
  });

  it("unchanged grants retain tokens; revocation and regrant never restore stale tokens", () => {
    const item = add();
    repo.replaceGrants(item.id, 1, [DEFAULT_AGENT_ID]);
    const token = () =>
      (
        db.db.query("SELECT token FROM knowledge_grants WHERE document_id = ?").get(item.id) as {
          token: string;
        } | null
      )?.token;
    const first = token();
    repo.replaceGrants(item.id, 2, [DEFAULT_AGENT_ID]);
    expect(token()).toBe(first);
    expect(repo.detail(item.id).revision).toBe(2);
    repo.replaceGrants(item.id, 2, []);
    expect(repo.agentDocuments(DEFAULT_AGENT_ID)).toEqual([]);
    repo.replaceGrants(item.id, 3, [DEFAULT_AGENT_ID]);
    expect(token()).not.toBe(first);
  });

  it("batch grants have no inheritance and are all-or-nothing on stale documents", async () => {
    const a = add("A");
    const b = add("B");
    let response = await request("/knowledge/grants/batch", "POST", {
      agent_id: DEFAULT_AGENT_ID,
      granted: true,
      documents: [
        { id: a.id, expected_revision: 1 },
        { id: b.id, expected_revision: 2 },
      ],
    });
    expect(response.status).toBe(409);
    expect(repo.agentDocuments(DEFAULT_AGENT_ID)).toEqual([]);
    response = await request("/knowledge/grants/batch", "POST", {
      agent_id: DEFAULT_AGENT_ID,
      granted: true,
      documents: [
        { id: a.id, expected_revision: 1 },
        { id: b.id, expected_revision: 1 },
      ],
    });
    expect(response.status).toBe(200);
    expect(repo.agentDocuments(DEFAULT_AGENT_ID)).toHaveLength(2);
    expect(add("后来导入").agent_ids).toEqual([]);
  });

  it("nonexistent agents and stale grant revisions preserve current permissions", async () => {
    const item = add();
    repo.replaceGrants(item.id, 1, [DEFAULT_AGENT_ID]);
    expect(
      (
        await request(`/knowledge/documents/${item.id}/grants`, "PUT", {
          expected_revision: 2,
          agent_ids: [otherId],
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await request(`/knowledge/documents/${item.id}/grants`, "PUT", {
          expected_revision: 1,
          agent_ids: [],
        })
      ).status,
    ).toBe(409);
    expect(repo.detail(item.id).agent_ids).toEqual([DEFAULT_AGENT_ID]);
  });

  it("text revisions invalidate drafts/chunks/jobs while preserving mode and grants", async () => {
    const item = add();
    repo.replaceGrants(item.id, 1, [DEFAULT_AGENT_ID]);
    repo.updateDocument(item.id, { expected_revision: 2, content_mode: "original" });
    draft(item.id);
    db.db
      .query(
        "INSERT INTO knowledge_chunks (id, document_id, content_version, ordinal, start_offset, end_offset, body) VALUES (?, ?, 1, 0, 0, 1, 'x')",
      )
      .run(crypto.randomUUID(), item.id);
    db.db
      .query(
        "UPDATE knowledge_jobs SET status = 'running', token = 'old-lease' WHERE document_id = ?",
      )
      .run(item.id);
    const next = "\uFEFF新原文\r\n𠮷";
    const response = await request(`/knowledge/documents/${item.id}`, "PATCH", {
      expected_revision: 3,
      original_text: next,
    });
    expect(response.status).toBe(200);
    const detail = KnowledgeDocumentDetailSchema.parse(await response.json());
    expect(detail.content_version).toBe(2);
    expect(detail.original_text).toBe(next);
    expect(detail.content_mode).toBe("original");
    expect(detail.agent_ids).toEqual([DEFAULT_AGENT_ID]);
    expect(detail.draft).toBeNull();
    expect(db.db.query("SELECT * FROM knowledge_chunks").all()).toEqual([]);
    const jobs = db.db
      .query("SELECT status, token, content_version FROM knowledge_jobs ORDER BY rowid")
      .all();
    expect(jobs).toEqual([
      { status: "cancelled", token: null, content_version: 1 },
      { status: "queued", token: null, content_version: 2 },
    ]);
  });

  it("metadata and mode updates never rewrite original text or content version", () => {
    const item = add();
    draft(item.id);
    const result = repo.updateDocument(item.id, {
      expected_revision: 1,
      name: "改名",
      content_mode: "original",
    });
    expect(result.content_version).toBe(1);
    expect(result.original_text).toBe(original);
    expect(result.draft?.body).toBe("整理稿");
    expect(result.content.content_origin).toBe("original");
  });

  it("settings disable cancels work, retains drafts and overrides mode; reenable reuses drafts", async () => {
    const ready = add("完成");
    const pending = add("未完成");
    draft(ready.id);
    expect(repo.detail(ready.id).content.body).toBe("整理稿");
    const settings = {
      expected_revision: 1,
      auto_enabled: false,
      model_name: null,
      context_budget: 4096,
    };
    expect((await request("/knowledge/settings", "PUT", settings)).status).toBe(200);
    expect(repo.detail(ready.id).content.body).toBe(original);
    expect(repo.detail(ready.id).draft?.body).toBe("整理稿");
    expect(repo.detail(pending.id).organization_status).toBe("disabled");
    expect(
      db.db.query("SELECT * FROM knowledge_jobs WHERE status IN ('queued', 'running')").all(),
    ).toEqual([]);
    repo.updateDocument(ready.id, { expected_revision: 1, content_mode: "original" });
    repo.updateSettings({ ...settings, expected_revision: 2, auto_enabled: true });
    expect(repo.detail(ready.id).content.body).toBe(original);
    expect(repo.detail(pending.id).organization_status).toBe("queued");
    expect(
      db.db
        .query("SELECT * FROM knowledge_jobs WHERE document_id = ? AND status = 'queued'")
        .all(ready.id),
    ).toEqual([]);
    expect((await request("/knowledge/settings", "PUT", settings)).status).toBe(409);
  });

  it("preserves long originals without silently truncating them", async () => {
    const text = `${original}\n${"编号42.5，条件不满足时不能执行。\r\n".repeat(20000)}`;
    const response = await request("/knowledge/documents", "POST", {
      name: "长资料",
      category_id: "default",
      original_text: text,
    });
    expect(response.status).toBe(201);
    const detail = KnowledgeDocumentDetailSchema.parse(await response.json());
    expect(detail.original_text).toBe(text);
    expect(repo.detail(detail.id).original_text.length).toBe(text.length);
  });

  it("rolls back grants and document revision if storage fails partway through a batch", () => {
    const a = add("A");
    const b = add("B");
    db.db.exec(
      `CREATE TEMP TRIGGER fail_second_grant BEFORE INSERT ON knowledge_grants WHEN NEW.document_id = '${b.id}' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END`,
    );
    expect(() =>
      repo.batchGrants({
        agent_id: DEFAULT_AGENT_ID,
        granted: true,
        documents: [
          { id: a.id, expected_revision: 1 },
          { id: b.id, expected_revision: 1 },
        ],
      }),
    ).toThrow("synthetic failure");
    expect(repo.agentDocuments(DEFAULT_AGENT_ID)).toEqual([]);
    expect(repo.detail(a.id).revision).toBe(1);
    expect(repo.detail(b.id).revision).toBe(1);
  });

  it("failed organization is visible and does not replace original content", () => {
    const item = add();
    db.db
      .query(
        "UPDATE knowledge_jobs SET status = 'failed', error_code = 'MODEL_NOT_LOADED' WHERE document_id = ?",
      )
      .run(item.id);
    const detail = repo.detail(item.id);
    expect(detail.organization_status).toBe("failed");
    expect(detail.error_code).toBe("MODEL_NOT_LOADED");
    expect(detail.content.body).toBe(original);
    expect(detail.draft).toBeNull();
  });

  it("stale edits/deletes do not change original or remove a document", async () => {
    const item = add();
    expect(
      (
        await request(`/knowledge/documents/${item.id}`, "PATCH", {
          expected_revision: 9,
          original_text: "bad",
        })
      ).status,
    ).toBe(409);
    expect(
      (await request(`/knowledge/documents/${item.id}`, "DELETE", { expected_revision: 9 })).status,
    ).toBe(409);
    expect(repo.detail(item.id).original_text).toBe(original);
    expect(
      (await request(`/knowledge/documents/${item.id}`, "DELETE", { expected_revision: 1 })).status,
    ).toBe(204);
    expect((await request(`/knowledge/documents/${item.id}`)).status).toBe(404);
    expect(db.db.query("SELECT * FROM knowledge_jobs").all()).toEqual([]);
  });
});
