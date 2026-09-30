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
  type KnowledgeDocumentsPage,
  KnowledgeDocumentsPageSchema,
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
function draft(id: string, summary = "摘要", tags: string[] = []) {
  db.db
    .query(
      "INSERT INTO knowledge_drafts (id, document_id, content_version, summary, tags, body, sources, model_name, created_at) VALUES (?, ?, 1, ?, ?, '整理稿', '[]', 'synthetic', 'now')",
    )
    .run(crypto.randomUUID(), id, summary, JSON.stringify(tags));
}
/** Fixed ascending timestamps keep list ordering deterministic despite same-millisecond imports. */
function pinOrder(ids: string[]) {
  const base = Date.parse("2026-09-30T00:00:00.000Z");
  ids.forEach((id, index) => {
    db.db
      .query("UPDATE knowledge_documents SET created_at = ? WHERE id = ?")
      .run(`${new Date(base + index * 1000).toISOString().slice(0, 19)}.000000Z`, id);
  });
}
function listUrl(params: Record<string, string | number> = {}): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) query.set(key, String(value));
  const serialized = query.toString();
  return `/knowledge/documents${serialized === "" ? "" : `?${serialized}`}`;
}
/** GET the list and fail loudly if the response is not a valid page. */
async function listPage(
  params: Record<string, string | number> = {},
): Promise<KnowledgeDocumentsPage> {
  const response = await request(listUrl(params));
  expect(response.status).toBe(200);
  return KnowledgeDocumentsPageSchema.parse(await response.json());
}
function idsOf(page: KnowledgeDocumentsPage): string[] {
  return page.items.map((item) => item.id);
}
/** base64url cursor payload, i.e. what the server hands out as `next_cursor`. */
function wire(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
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
    expect(repo.documents({ limit: 50 }).items[0]).not.toHaveProperty("original_text");
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
      expect(repo.documents({ limit: 50 }).items).toEqual([]);
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
    expect(repo.documents({ limit: 50 }).items).toEqual([]);
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
    expect(repo.documents({ limit: 50 }).items).toEqual([]);
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

describe("knowledge document list: server-side search, filters and pagination", () => {
  it("combines search, category and status filters and counts only matches", async () => {
    const other = repo.createCategory("另一类");
    const succeededItem = add("季度资料A");
    draft(succeededItem.id, "第三季度汇总", ["回顾"]);
    const failedItem = add("季度资料B");
    repo.updateDocument(failedItem.id, { expected_revision: 1, category_id: other.id });
    db.db
      .query("UPDATE knowledge_jobs SET status = 'failed', error_code = 'X' WHERE document_id = ?")
      .run(failedItem.id);
    const queuedItem = add("季度资料C");
    pinOrder([succeededItem.id, failedItem.id, queuedItem.id]);

    const searched = await listPage({ search: "季度" });
    expect(searched.total).toBe(3);
    expect(idsOf(searched)).toEqual([succeededItem.id, failedItem.id, queuedItem.id]);
    expect(idsOf(await listPage({ search: "季度", category: other.id }))).toEqual([failedItem.id]);
    expect(idsOf(await listPage({ search: "季度", status: "failed" }))).toEqual([failedItem.id]);
    expect(
      idsOf(await listPage({ search: "季度", category: "default", status: "succeeded" })),
    ).toEqual([succeededItem.id]);
    expect(
      idsOf(await listPage({ search: "季度", category: "default", status: "queued" })),
    ).toEqual([queuedItem.id]);
    // `all` and an absent filter are the same request.
    expect(await listPage({ search: "季度", category: "all", status: "all" })).toEqual(searched);
    // An unknown category is a filter that matches nothing, not an error.
    const unknown = await listPage({ category: "00000000-0000-4000-8000-0000000000ff" });
    expect(unknown).toEqual({ items: [], next_cursor: null, total: 0 });
  });

  it("keeps first-page counts correct after a category is deleted and its documents move", async () => {
    const source = repo.createCategory("源分类");
    const target = repo.createCategory("目标分类");
    const moved = add("被搬运");
    repo.updateDocument(moved.id, { expected_revision: 1, category_id: source.id });
    const staying = add("留在目标");
    repo.updateDocument(staying.id, { expected_revision: 1, category_id: source.id });
    expect((await listPage({ category: source.id })).total).toBe(2);

    const deleted = await request(`/knowledge/categories/${source.id}`, "DELETE", {
      expected_revision: 1,
      move_to: target.id,
    });
    expect(deleted.status).toBe(204);
    const firstPage = await listPage({ category: target.id });
    expect(firstPage.total).toBe(2);
    expect(idsOf(firstPage).sort()).toEqual([moved.id, staying.id].sort());
    expect((await listPage({ category: source.id })).total).toBe(0);
  });

  it("searches name, summary and tags as literal case-insensitive text including astral characters", async () => {
    const named = add("𠮷野家菜单");
    const summarized = add("普通标题");
    draft(summarized.id, "温度低于10°C时不要开启设备。", ["冬季"]);
    const tagged = add("第二份资料");
    draft(tagged.id, "摘要", ["微笑🙂", "tag-ALPHA"]);
    const literal = add("100%_off 折扣");
    const backslash = add("反斜杠\\路径");
    pinOrder([named.id, summarized.id, tagged.id, literal.id, backslash.id]);

    expect(idsOf(await listPage({ search: "𠮷" }))).toEqual([named.id]);
    expect(idsOf(await listPage({ search: "10°C" }))).toEqual([summarized.id]);
    expect(idsOf(await listPage({ search: "微笑🙂" }))).toEqual([tagged.id]);
    // ASCII letters fold case like the browser-side filter did (non-ASCII case below).
    expect(idsOf(await listPage({ search: "alpha" }))).toEqual([tagged.id]);
    // `%` and `_` stay literal: `0%_o` matches the stored text, `100_off` cannot.
    expect(idsOf(await listPage({ search: "0%_o" }))).toEqual([literal.id]);
    expect(idsOf(await listPage({ search: "100_off" }))).toEqual([]);
    // `\` is literal too, even though it used to be the LIKE escape character.
    expect(idsOf(await listPage({ search: "反斜杠\\路径" }))).toEqual([backslash.id]);
    expect(await listPage({ search: "反斜杠路径" })).toEqual({
      items: [],
      next_cursor: null,
      total: 0,
    });
    // Empty search equals no search, and no match is an empty page.
    expect(await listPage({ search: "" })).toEqual(await listPage());
    expect(await listPage({ search: "不存在的资料" })).toEqual({
      items: [],
      next_cursor: null,
      total: 0,
    });
  });

  it("folds non-ASCII case like the former browser filter and stays server-paginated", async () => {
    const first = add("Ärger 指南");
    const second = add("别册 ÄRGER 资料");
    const third = add("ärger 备注");
    const summarized = add("普通标题");
    draft(summarized.id, "Österreich 概览", ["Straße"]);
    const decomposed = add("Cafe\u0301 Central");
    const precomposed = add("Café Nord");
    pinOrder([first.id, second.id, third.id, summarized.id, decomposed.id, precomposed.id]);

    // The reported regression: 'ärger' must match 'Ärger', because the page
    // filtered with JS Unicode `toLowerCase().includes()`.
    expect(idsOf(await listPage({ search: "ärger" }))).toEqual([first.id, second.id, third.id]);
    expect(idsOf(await listPage({ search: "ÄRGER" }))).toEqual([first.id, second.id, third.id]);
    expect(idsOf(await listPage({ search: "ärGer" }))).toEqual([first.id, second.id, third.id]);
    // Diacritics are not stripped: 'arger' is a different word than 'ärger'.
    expect(await listPage({ search: "arger" })).toEqual({ items: [], next_cursor: null, total: 0 });

    // Search stays server-side: the cursor walks matched rows without gaps and
    // `total` counts every match, not only the rows after the cursor.
    const pageOne = await listPage({ search: "ärger", limit: 2 });
    expect(idsOf(pageOne)).toEqual([first.id, second.id]);
    expect(pageOne.total).toBe(3);
    expect(pageOne.next_cursor).not.toBeNull();
    const pageTwo = await listPage({
      search: "ärger",
      limit: 2,
      cursor: pageOne.next_cursor as string,
    });
    expect(idsOf(pageTwo)).toEqual([third.id]);
    expect(pageTwo.total).toBe(3);
    expect(pageTwo.next_cursor).toBeNull();

    // Summary and tags fold the same way.
    expect(idsOf(await listPage({ search: "ÖSTERREICH 概览" }))).toEqual([summarized.id]);
    expect(idsOf(await listPage({ search: "STRAßE" }))).toEqual([summarized.id]);
    // `toLowerCase()` semantics, not full casefold: 'ß' stays 'ß', it is not 'ss'.
    expect(await listPage({ search: "STRASSE" })).toEqual({
      items: [],
      next_cursor: null,
      total: 0,
    });

    // Code points compare as stored: decomposed 'e\u0301' is not precomposed 'é'.
    expect(idsOf(await listPage({ search: "cafe\u0301" }))).toEqual([decomposed.id]);
    expect(idsOf(await listPage({ search: "CAFE\u0301 CENTRAL" }))).toEqual([decomposed.id]);
    expect(idsOf(await listPage({ search: "café" }))).toEqual([precomposed.id]);
    expect(idsOf(await listPage({ search: "CAFÉ NORD" }))).toEqual([precomposed.id]);
  });

  it("binds search text as data and rejects malformed query values with 422", async () => {
    const item = add("百分号资料");
    pinOrder([item.id]);
    const attack = "%'; DROP TABLE knowledge_documents; --";
    expect(await listPage({ search: attack })).toEqual({ items: [], next_cursor: null, total: 0 });
    expect((await listPage()).total).toBe(1);

    const invalidQueries: Record<string, string>[] = [
      { category: "" },
      { category: "not-a-category" },
      { status: "" },
      { status: "failed-ish" },
      { status: "' OR 1=1 --" },
      { search: "a".repeat(201) },
      { cursor: "not-a-cursor" },
      { cursor: wire({}) },
      { cursor: wire({ created_at: "2026-09-30T00:00:00.000000Z" }) },
      { cursor: wire({ created_at: "2026-09-30T00:00:00.000000Z", id: "not-a-uuid" }) },
      {
        cursor: wire({
          created_at: "2026-09-30T00:00:00.000000Z",
          id: crypto.randomUUID(),
          extra: 1,
        }),
      },
      { cursor: "a".repeat(201) },
      { limit: "0" },
      { limit: "101" },
      { limit: "-1" },
      { limit: "1.5" },
      { limit: "abc" },
      { unknown: "1" },
    ];
    for (const query of invalidQueries) {
      const response = await request(listUrl(query));
      expect(response.status).toBe(422);
      expect((await response.json()).error.code).toBe("VALIDATION_ERROR");
    }
    // A cursor past the end is an exhausted page, not a validation failure.
    expect(
      await listPage({
        cursor: wire({ created_at: "2999-01-01T00:00:00.000000Z", id: crypto.randomUUID() }),
      }),
    ).toEqual({ items: [], next_cursor: null, total: 1 });
    for (const limit of ["1", "100"]) {
      expect((await request(listUrl({ limit }))).status).toBe(200);
    }
  });

  it("pages identically ordered rows without duplicates or gaps when inserts arrive mid-browse", async () => {
    const imported = Array.from({ length: 7 }, (_, index) => add(`资料${index + 1}`).id);
    const sameInstant = "2026-09-30T00:00:00.000000Z";
    for (const id of imported)
      db.db
        .query("UPDATE knowledge_documents SET created_at = ? WHERE id = ?")
        .run(sameInstant, id);
    const expected = [...imported].sort();

    const firstPage = await listPage({ limit: 3 });
    expect(idsOf(firstPage)).toEqual(expected.slice(0, 3));
    expect(firstPage.total).toBe(7);
    expect(firstPage.next_cursor).not.toBeNull();
    const middlePage = await listPage({ limit: 3, cursor: firstPage.next_cursor as string });
    expect(idsOf(middlePage)).toEqual(expected.slice(3, 6));
    expect(middlePage.total).toBe(7);

    // A document imported while browsing lands after the read window.
    const late = add("后来资料");
    db.db
      .query("UPDATE knowledge_documents SET created_at = ? WHERE id = ?")
      .run("2026-10-01T00:00:00.000000Z", late.id);
    const replay = await listPage({ limit: 3, cursor: firstPage.next_cursor as string });
    expect(replay.items.map((item) => item.id)).toEqual(middlePage.items.map((item) => item.id));
    expect(replay.total).toBe(8);
    const lastPage = await listPage({ limit: 3, cursor: middlePage.next_cursor as string });
    expect(idsOf(lastPage)).toEqual([expected[6] as string, late.id]);
    expect(lastPage.next_cursor).toBeNull();
    const walked = [...idsOf(firstPage), ...idsOf(replay), ...idsOf(lastPage)];
    expect(new Set(walked).size).toBe(8);
  });

  it("defaults to 50 results, reports the filtered total and continues from the cursor", async () => {
    const imported = Array.from({ length: 55 }, (_, index) => add(`资料 ${index + 1}`).id);
    pinOrder(imported);
    const firstPage = await listPage();
    expect(firstPage.items).toHaveLength(50);
    expect(firstPage.total).toBe(55);
    expect(firstPage.next_cursor).not.toBeNull();
    const secondPage = await listPage({ cursor: firstPage.next_cursor as string });
    expect(secondPage.items).toHaveLength(5);
    expect(secondPage.total).toBe(55);
    expect(secondPage.next_cursor).toBeNull();
    expect(new Set([...idsOf(firstPage), ...idsOf(secondPage)]).size).toBe(55);
    // Matches "资料 5" plus "资料 50".."资料 55".
    const searched = await listPage({ search: "资料 5" });
    expect(searched.total).toBe(7);
    expect(searched.items).toHaveLength(7);
  });

  it("filters by the same derived organization status the list shows", async () => {
    const succeeded = add("已完成");
    draft(succeeded.id);
    const failed = add("失败");
    db.db
      .query("UPDATE knowledge_jobs SET status = 'failed', error_code = 'E' WHERE document_id = ?")
      .run(failed.id);
    const queued = add("排队中");
    const multi = add("多任务");
    db.db.query("UPDATE knowledge_jobs SET status = 'failed' WHERE document_id = ?").run(multi.id);
    db.db
      .query(
        "INSERT INTO knowledge_jobs (id, document_id, content_version, settings_revision, created_at) VALUES (?, ?, 1, 1, '2026-09-30T00:00:02.000000Z')",
      )
      .run(crypto.randomUUID(), multi.id);
    const cancelled = add("已取消");
    db.db
      .query("UPDATE knowledge_jobs SET status = 'cancelled' WHERE document_id = ?")
      .run(cancelled.id);
    const pendingJob = add("成功待整理");
    db.db
      .query("UPDATE knowledge_jobs SET status = 'succeeded' WHERE document_id = ?")
      .run(pendingJob.id);
    const noJob = add("没有任务");
    db.db.query("DELETE FROM knowledge_jobs WHERE document_id = ?").run(noJob.id);
    pinOrder([succeeded.id, failed.id, queued.id, multi.id, cancelled.id, pendingJob.id, noJob.id]);

    const all = await listPage({ limit: 100 });
    expect(all.total).toBe(7);
    for (const status of ["succeeded", "failed", "queued", "cancelled", "pending", "disabled"]) {
      const filtered = await listPage({ status, limit: 100 });
      const expected = all.items
        .filter((item) => item.organization_status === status)
        .map((item) => item.id);
      expect(idsOf(filtered)).toEqual(expected);
      expect(filtered.total).toBe(expected.length);
    }
    // `multi` keeps its newest job (queued), not the older failed one.
    expect(idsOf(await listPage({ status: "queued", limit: 100 }))).toEqual([queued.id, multi.id]);
    expect(idsOf(await listPage({ status: "pending", limit: 100 }))).toEqual([
      pendingJob.id,
      noJob.id,
    ]);

    // Disabling auto-organization relabels every document without a valid draft; drafts stay succeeded.
    const disabled = await request("/knowledge/settings", "PUT", {
      expected_revision: 1,
      auto_enabled: false,
      model_name: null,
      context_budget: 16384,
    });
    expect(disabled.status).toBe(200);
    expect(idsOf(await listPage({ status: "disabled", limit: 100 }))).toEqual([
      failed.id,
      queued.id,
      multi.id,
      cancelled.id,
      pendingJob.id,
      noJob.id,
    ]);
    expect(idsOf(await listPage({ status: "succeeded", limit: 100 }))).toEqual([succeeded.id]);
    expect(await listPage({ status: "queued", limit: 100 })).toEqual({
      items: [],
      next_cursor: null,
      total: 0,
    });
  });

  it("keeps detail, grants and batch grants addressable beyond the current page", async () => {
    const imported = Array.from({ length: 3 }, (_, index) => add(`资料${index + 1}`).id);
    pinOrder(imported);
    const [firstId, secondId, thirdId] = imported as [string, string, string];

    const firstPage = await listPage({ limit: 1 });
    expect(idsOf(firstPage)).toEqual([firstId]);
    const detail = await request(`/knowledge/documents/${thirdId}`);
    expect(detail.status).toBe(200);
    expect(KnowledgeDocumentDetailSchema.parse(await detail.json()).id).toBe(thirdId);

    const granted = await request(`/knowledge/documents/${thirdId}/grants`, "PUT", {
      expected_revision: 1,
      agent_ids: [DEFAULT_AGENT_ID],
    });
    expect(granted.status).toBe(200);
    const scoped = await listPage({ search: "资料3", limit: 1 });
    expect(scoped.items[0]?.agent_ids).toEqual([DEFAULT_AGENT_ID]);

    const grantedAll = await request("/knowledge/grants/batch", "POST", {
      agent_id: DEFAULT_AGENT_ID,
      granted: true,
      documents: [
        { id: firstId, expected_revision: 1 },
        { id: secondId, expected_revision: 1 },
        { id: thirdId, expected_revision: 2 },
      ],
    });
    expect(grantedAll.status).toBe(200);
    expect(repo.agentDocuments(DEFAULT_AGENT_ID)).toHaveLength(3);
    // `thirdId` was already granted, so the batch did not bump it again.
    const revoked = await request("/knowledge/grants/batch", "POST", {
      agent_id: DEFAULT_AGENT_ID,
      granted: false,
      documents: [
        { id: firstId, expected_revision: 2 },
        { id: secondId, expected_revision: 2 },
        { id: thirdId, expected_revision: 2 },
      ],
    });
    expect(revoked.status).toBe(200);
    expect(repo.agentDocuments(DEFAULT_AGENT_ID)).toEqual([]);
  });
});
