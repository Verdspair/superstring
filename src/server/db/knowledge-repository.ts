import type { Database } from "bun:sqlite";
import type { ContentItem } from "../../shared/contracts/content";
import type {
  AgentKnowledge,
  KnowledgeBatchGrant,
  KnowledgeCategory,
  KnowledgeDocument,
  KnowledgeDocumentDetail,
  KnowledgeDocumentUpdate,
  KnowledgeImport,
  KnowledgeSettings,
  KnowledgeSettingsUpdate,
} from "../../shared/contracts/knowledge";
import { fail } from "../errors";
import { newId, nowIso } from "./repositories";

type DocumentMetadata = Omit<
  KnowledgeDocument,
  "agent_ids" | "summary" | "tags" | "organization_status" | "error_code" | "latest_job_id"
>;
type DocumentRow = DocumentMetadata & { original_text: string };
const DOCUMENT_COLUMNS =
  "id, category_id, name, import_type, content_mode, content_version, revision, created_at, updated_at";
type DraftRow = { id: string; summary: string; tags: string; body: string; sources: string };
type SettingsRow = Omit<KnowledgeSettings, "auto_enabled"> & { auto_enabled: number };
type CategoryRow = { id: string; name: string; revision: number };

/** All write callbacks are synchronous and hold SQLite's immediate transaction lock. */
export class KnowledgeRepository {
  constructor(private readonly db: Database) {}

  private checkRevision(actual: number, expected: number) {
    if (actual !== expected) fail("KNOWLEDGE_REVISION_CONFLICT", "资料已被修改，请刷新后重试");
  }

  private category(id: string): CategoryRow {
    const row = this.db
      .query<CategoryRow, [string]>(
        "SELECT id, name, revision FROM knowledge_categories WHERE id = ?",
      )
      .get(id);
    if (!row) fail("KNOWLEDGE_CATEGORY_NOT_FOUND", "分类不存在", 404);
    return row;
  }

  private document(id: string): DocumentRow {
    const row = this.db
      .query<DocumentRow, [string]>("SELECT * FROM knowledge_documents WHERE id = ?")
      .get(id);
    if (!row) fail("KNOWLEDGE_NOT_FOUND", "资料不存在或未授权", 404);
    return row;
  }

  private requireAgent(id: string) {
    if (!this.db.query("SELECT id FROM agents WHERE id = ?").get(id))
      fail("AGENT_NOT_FOUND", "Agent 不存在", 404);
  }

  settings(): KnowledgeSettings {
    const row = this.db
      .query<SettingsRow, []>(
        "SELECT auto_enabled, model_name, context_budget, revision FROM knowledge_settings WHERE id = 1",
      )
      .get();
    if (!row) throw new Error("Missing knowledge settings");
    return { ...row, auto_enabled: row.auto_enabled === 1 };
  }

  private cancelJobs(documentId?: string) {
    const where = documentId === undefined ? "" : " AND document_id = ?";
    const args = documentId === undefined ? [nowIso()] : [nowIso(), documentId];
    this.db
      .query(
        `UPDATE knowledge_jobs SET status = 'cancelled', token = NULL, lease_expires_at = NULL, finished_at = ? WHERE status IN ('queued', 'running')${where}`,
      )
      .run(...args);
  }

  private enqueue(row: DocumentMetadata, settings = this.settings()) {
    if (!settings.auto_enabled) return;
    if (this.validDraft(row)) return;
    if (
      this.db
        .query(
          "SELECT id FROM knowledge_jobs WHERE document_id = ? AND content_version = ? AND settings_revision = ? AND status IN ('queued', 'running')",
        )
        .get(row.id, row.content_version, settings.revision)
    )
      return;
    this.db
      .query(
        "INSERT INTO knowledge_jobs (id, document_id, content_version, settings_revision, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(newId(), row.id, row.content_version, settings.revision, nowIso());
  }

  updateSettings(input: KnowledgeSettingsUpdate): KnowledgeSettings {
    return this.db
      .transaction(() => {
        const old = this.settings();
        this.checkRevision(old.revision, input.expected_revision);
        if (
          old.auto_enabled === input.auto_enabled &&
          old.model_name === input.model_name &&
          old.context_budget === input.context_budget
        )
          return old;
        this.db
          .query(
            "UPDATE knowledge_settings SET auto_enabled = ?, model_name = ?, context_budget = ?, revision = revision + 1 WHERE id = 1",
          )
          .run(input.auto_enabled ? 1 : 0, input.model_name, input.context_budget);
        this.cancelJobs();
        const current = this.settings();
        for (const row of this.db
          .query<DocumentMetadata, []>(`SELECT ${DOCUMENT_COLUMNS} FROM knowledge_documents`)
          .all())
          this.enqueue(row, current);
        return current;
      })
      .immediate();
  }

  categories(): KnowledgeCategory[] {
    return this.db
      .query<KnowledgeCategory, []>(`SELECT c.id, c.name, c.revision, COUNT(d.id) AS document_count
      FROM knowledge_categories c LEFT JOIN knowledge_documents d ON d.category_id = c.id
      GROUP BY c.id ORDER BY c.rowid`)
      .all();
  }

  createCategory(name: string): KnowledgeCategory {
    return this.db
      .transaction(() => {
        const id = newId();
        this.db
          .query("INSERT INTO knowledge_categories (id, name) VALUES (?, CAST(? AS TEXT))")
          .run(id, Buffer.from(name));
        return { ...this.category(id), document_count: 0 };
      })
      .immediate();
  }

  renameCategory(id: string, name: string, expected: number): KnowledgeCategory {
    return this.db
      .transaction(() => {
        const row = this.category(id);
        this.checkRevision(row.revision, expected);
        if (row.name !== name)
          this.db
            .query(
              "UPDATE knowledge_categories SET name = CAST(? AS TEXT), revision = revision + 1 WHERE id = ?",
            )
            .run(Buffer.from(name), id);
        return this.categories().find((item) => item.id === id) as KnowledgeCategory;
      })
      .immediate();
  }

  deleteCategory(id: string, expected: number, moveTo?: string) {
    this.db
      .transaction(() => {
        this.checkRevision(this.category(id).revision, expected);
        if (this.categories().length <= 1) fail("KNOWLEDGE_LAST_CATEGORY", "至少保留一个分类");
        const hasDocuments = this.db
          .query("SELECT id FROM knowledge_documents WHERE category_id = ? LIMIT 1")
          .get(id);
        if (moveTo === id || (hasDocuments && !moveTo))
          fail("KNOWLEDGE_CATEGORY_NOT_EMPTY", "请选择资料迁入分类");
        if (moveTo !== undefined) {
          this.category(moveTo);
          this.db
            .query(
              "UPDATE knowledge_documents SET category_id = ?, revision = revision + 1, updated_at = ? WHERE category_id = ?",
            )
            .run(moveTo, nowIso(), id);
        }
        this.db.query("DELETE FROM knowledge_categories WHERE id = ?").run(id);
      })
      .immediate();
  }

  importDocument(
    input: KnowledgeImport,
    importType: "text" | "txt" | "md" = "text",
    sourceId?: string,
  ): KnowledgeDocumentDetail {
    return this.db
      .transaction(() => {
        this.category(input.category_id);
        const id = sourceId ?? newId();
        const now = nowIso();
        // Binding a JS string through bun:sqlite strips its leading BOM. Bind bytes instead.
        this.db
          .query(
            "INSERT INTO knowledge_documents (id, category_id, name, original_text, import_type, created_at, updated_at) VALUES (?, ?, CAST(? AS TEXT), CAST(? AS TEXT), ?, ?, ?)",
          )
          .run(
            id,
            input.category_id,
            Buffer.from(input.name),
            Buffer.from(input.original_text),
            importType,
            now,
            now,
          );
        this.enqueue(this.document(id));
        return this.detail(id);
      })
      .immediate();
  }

  private validDraft(row: DocumentMetadata): DraftRow | null {
    return this.db
      .query<DraftRow, [string, number]>(
        "SELECT id, summary, tags, body, sources FROM knowledge_drafts WHERE document_id = ? AND content_version = ?",
      )
      .get(row.id, row.content_version);
  }

  private view(row: DocumentMetadata): KnowledgeDocument {
    const metadata: DocumentMetadata = {
      id: row.id,
      category_id: row.category_id,
      name: row.name,
      import_type: row.import_type,
      content_mode: row.content_mode,
      content_version: row.content_version,
      revision: row.revision,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
    const draft = this.validDraft(row);
    const job = this.db
      .query<
        {
          id: string;
          status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
          error_code: string | null;
        },
        [string, number]
      >(
        "SELECT id, status, error_code FROM knowledge_jobs WHERE document_id = ? AND content_version = ? ORDER BY rowid DESC LIMIT 1",
      )
      .get(row.id, row.content_version);
    return {
      ...metadata,
      agent_ids: this.db
        .query<{ agent_id: string }, [string]>(
          "SELECT agent_id FROM knowledge_grants WHERE document_id = ? ORDER BY agent_id",
        )
        .all(row.id)
        .map((grant) => grant.agent_id),
      summary: draft?.summary ?? "",
      tags: draft ? JSON.parse(draft.tags) : [],
      organization_status: draft
        ? "succeeded"
        : !this.settings().auto_enabled
          ? "disabled"
          : job?.status === "succeeded"
            ? "pending"
            : (job?.status ?? "pending"),
      error_code: job?.status === "failed" ? job.error_code : null,
      latest_job_id: job?.id ?? null,
    };
  }

  documents(): KnowledgeDocument[] {
    return this.db
      .query<DocumentMetadata, []>(
        `SELECT ${DOCUMENT_COLUMNS} FROM knowledge_documents ORDER BY created_at, id`,
      )
      .all()
      .map((row) => this.view(row));
  }

  private originalContent(row: DocumentRow): ContentItem {
    return {
      id: row.id,
      source_type: "knowledge",
      content_origin: "original",
      name: row.name,
      summary: "",
      tags: [],
      body: row.original_text,
      revision: String(row.content_version),
      validity: "valid",
      sources: [
        {
          type: "document",
          document_id: row.id,
          version: row.content_version,
          start: 0,
          end: row.original_text.length,
          valid: true,
        },
      ],
    };
  }

  detail(id: string): KnowledgeDocumentDetail {
    const row = this.document(id);
    const original = this.originalContent(row);
    const saved = this.validDraft(row);
    const draft: ContentItem | null = saved
      ? {
          ...original,
          content_origin: "derived",
          body: saved.body,
          summary: saved.summary,
          tags: JSON.parse(saved.tags),
          sources: JSON.parse(saved.sources),
        }
      : null;
    return {
      ...this.view(row),
      original_text: row.original_text,
      draft,
      content:
        this.settings().auto_enabled && row.content_mode === "draft" && draft ? draft : original,
    };
  }

  updateDocument(id: string, input: KnowledgeDocumentUpdate): KnowledgeDocumentDetail {
    return this.db
      .transaction(() => {
        const row = this.document(id);
        this.checkRevision(row.revision, input.expected_revision);
        const categoryId = input.category_id ?? row.category_id;
        this.category(categoryId);
        const name = input.name ?? row.name;
        const original = input.original_text ?? row.original_text;
        const mode = input.content_mode ?? row.content_mode;
        const changedText = original !== row.original_text;
        if (
          name === row.name &&
          categoryId === row.category_id &&
          !changedText &&
          mode === row.content_mode
        )
          return this.detail(id);
        this.db
          .query(
            "UPDATE knowledge_documents SET name = CAST(? AS TEXT), category_id = ?, original_text = CAST(? AS TEXT), content_mode = ?, content_version = ?, revision = revision + 1, updated_at = ? WHERE id = ?",
          )
          .run(
            Buffer.from(name),
            categoryId,
            Buffer.from(original),
            mode,
            row.content_version + (changedText ? 1 : 0),
            nowIso(),
            id,
          );
        if (changedText) {
          this.db.query("DELETE FROM knowledge_chunks WHERE document_id = ?").run(id);
          this.db.query("DELETE FROM knowledge_drafts WHERE document_id = ?").run(id);
          this.cancelJobs(id);
          this.enqueue(this.document(id));
        }
        return this.detail(id);
      })
      .immediate();
  }

  deleteDocument(id: string, expected: number) {
    this.db
      .transaction(() => {
        this.checkRevision(this.document(id).revision, expected);
        this.db.query("DELETE FROM knowledge_documents WHERE id = ?").run(id);
      })
      .immediate();
  }

  private changeGrant(documentId: string, agentId: string, granted: boolean): boolean {
    const existing = this.db
      .query("SELECT token FROM knowledge_grants WHERE document_id = ? AND agent_id = ?")
      .get(documentId, agentId);
    if (granted === !!existing) return false;
    if (granted)
      this.db
        .query(
          "INSERT INTO knowledge_grants (document_id, agent_id, token, created_at) VALUES (?, ?, ?, ?)",
        )
        .run(documentId, agentId, newId(), nowIso());
    else
      this.db
        .query("DELETE FROM knowledge_grants WHERE document_id = ? AND agent_id = ?")
        .run(documentId, agentId);
    return true;
  }

  private touch(id: string) {
    this.db
      .query("UPDATE knowledge_documents SET revision = revision + 1, updated_at = ? WHERE id = ?")
      .run(nowIso(), id);
  }

  replaceGrants(id: string, expected: number, agentIds: string[]): KnowledgeDocumentDetail {
    return this.db
      .transaction(() => {
        this.checkRevision(this.document(id).revision, expected);
        for (const agentId of agentIds) this.requireAgent(agentId);
        const old = this.db
          .query<{ agent_id: string }, [string]>(
            "SELECT agent_id FROM knowledge_grants WHERE document_id = ?",
          )
          .all(id);
        let changed = false;
        for (const grant of old)
          if (!agentIds.includes(grant.agent_id))
            changed = this.changeGrant(id, grant.agent_id, false) || changed;
        for (const agentId of agentIds) changed = this.changeGrant(id, agentId, true) || changed;
        if (changed) this.touch(id);
        return this.detail(id);
      })
      .immediate();
  }

  batchGrants(input: KnowledgeBatchGrant): KnowledgeDocument[] {
    return this.db
      .transaction(() => {
        this.requireAgent(input.agent_id);
        for (const item of input.documents)
          this.checkRevision(this.document(item.id).revision, item.expected_revision);
        return input.documents.map((item) => {
          if (this.changeGrant(item.id, input.agent_id, input.granted)) this.touch(item.id);
          return this.view(this.document(item.id));
        });
      })
      .immediate();
  }

  /** Do not derive this from the management list: filter grants before loading metadata. */
  agentDocuments(agentId: string): AgentKnowledge[] {
    this.requireAgent(agentId);
    const rows = this.db
      .query<DocumentMetadata, [string]>(`SELECT ${DOCUMENT_COLUMNS.split(", ")
        .map((column) => `d.${column}`)
        .join(", ")} FROM knowledge_documents d
      JOIN knowledge_grants g ON g.document_id = d.id WHERE g.agent_id = ? ORDER BY d.created_at, d.id`)
      .all(agentId);
    return rows.map((row) => {
      const view = this.view(row);
      return {
        id: view.id,
        name: view.name,
        summary: view.summary,
        tags: view.tags,
        content_mode: view.content_mode,
        organization_status: view.organization_status,
      };
    });
  }

  authorizedDetail(agentId: string, documentId: string): KnowledgeDocumentDetail {
    this.requireAgent(agentId);
    if (
      !this.db
        .query("SELECT token FROM knowledge_grants WHERE document_id = ? AND agent_id = ?")
        .get(documentId, agentId)
    )
      fail("KNOWLEDGE_NOT_FOUND", "资料不存在或未授权", 404);
    return this.detail(documentId);
  }
}
