import { afterEach, describe, expect, it } from "bun:test";
import { KnowledgeRepository } from "../../src/server/db/knowledge-repository";
import {
  createSession,
  DEFAULT_AGENT_ID,
  ensureDefaults,
  getTurnByRequest,
  prepareTurn,
} from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import {
  KnowledgeContext,
  knowledgeTerms,
  qqKnowledgeItems,
} from "../../src/server/modules/knowledge-module";
import { knowledgeSegments, utf8Size } from "../../src/server/services/knowledge-segments";
import { type ContentItem, ContentItemSchema } from "../../src/shared/contracts/content";

type Candidate = { id: string; document_id: string; token: string; items: ContentItem[] };
type Document = {
  id: string;
  token: string;
  name: string;
  original_text: string;
  content_version: number;
  content_mode: string;
};
const handles: ReturnType<typeof openBusinessDb>[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
});
function fixture() {
  const h = openBusinessDb({ path: ":memory:" });
  handles.push(h);
  ensureDefaults(h.orm, "synthetic");
  const repo = new KnowledgeRepository(h.db);
  const add = (id: string, text: string, grant = true, name = id) => {
    const doc = repo.importDocument(
      { name, category_id: "default", original_text: text },
      "text",
      id,
    );
    return grant ? repo.replaceGrants(doc.id, doc.revision, [DEFAULT_AGENT_ID]) : doc;
  };
  const begin = (question: string) => {
    const session = createSession(h.orm, "synthetic", { modelName: "synthetic" });
    const request = crypto.randomUUID();
    const prepared = prepareTurn(h.orm, session.id, question, request);
    const turn = getTurnByRequest(h.orm, session.id, request);
    if (!turn || !prepared.generationToken) throw new Error("missing synthetic turn");
    // Pin the legacy public entry: current prepared turns carry an explicit frozen config.
    h.db
      .query(
        "UPDATE turns SET runtime_config_snapshot=json_remove(runtime_config_snapshot,'$.knowledge_read') WHERE id=?",
      )
      .run(turn.id);
    const context = new KnowledgeContext(h.db);
    context.begin(turn.id, DEFAULT_AGENT_ID, prepared.generationToken, question);
    const saved = h.db
      .query<{ items: string }, [string]>(
        "SELECT items FROM turn_knowledge_snapshots WHERE turn_id=?",
      )
      .get(turn.id);
    const snapshot = JSON.parse(saved?.items ?? "null") as { candidates: Candidate[] };
    return {
      candidates: snapshot.candidates,
      context,
      turnId: turn.id,
      token: prepared.generationToken,
    };
  };
  return { h, repo, add, begin };
}
/** Frozen pre-optimization algorithm, used only as an isolated scalar oracle. */
function scalar(f: ReturnType<typeof fixture>, question: string): Candidate[] {
  const settings = f.repo.settings();
  const terms = knowledgeTerms(question);
  const ranked: { candidate: Candidate; score: number }[] = [];
  const rows = f.h.db
    .query<
      Document,
      [string]
    >(`SELECT d.id,g.token,d.name,d.original_text,d.content_version,d.content_mode
    FROM knowledge_documents d JOIN knowledge_grants g ON g.document_id=d.id WHERE g.agent_id=? ORDER BY d.id`)
    .all(DEFAULT_AGENT_ID);
  for (const row of rows) {
    const saved =
      settings.auto_enabled && row.content_mode === "draft"
        ? f.h.db
            .query<{ body: string; sources: string }, [string, number]>(
              "SELECT body,sources FROM knowledge_drafts WHERE document_id=? AND content_version=?",
            )
            .get(row.id, row.content_version)
        : null;
    let mapped: ContentItem["sources"] = [];
    if (saved) {
      try {
        mapped = ContentItemSchema.shape.sources.parse(JSON.parse(saved.sources));
      } catch {}
    }
    for (const chunk of knowledgeSegments(row.original_text, 768)) {
      if (!chunk.body.trim()) continue;
      const original: ContentItem = {
        id: row.id,
        source_type: "knowledge",
        content_origin: "original",
        name: row.name,
        summary: "",
        tags: [],
        body: chunk.body,
        revision: String(row.content_version),
        validity: "valid",
        sources: [
          {
            type: "document",
            document_id: row.id,
            version: row.content_version,
            start: chunk.start,
            end: chunk.end,
            valid: true,
          },
        ],
      };
      const source = mapped.find(
        (s) =>
          s.type === "document" &&
          s.valid &&
          s.document_id === row.id &&
          s.version === row.content_version &&
          s.start <= chunk.start &&
          s.end >= chunk.end &&
          s.end <= row.original_text.length &&
          s.draft_start !== undefined &&
          s.draft_end !== undefined &&
          s.draft_end <= (saved?.body.length ?? 0),
      );
      const derived =
        source?.type === "document" && saved
          ? {
              ...original,
              content_origin: "derived" as const,
              body: saved.body.slice(source.draft_start, source.draft_end),
              sources: [source],
            }
          : null;
      const candidate = {
        id: `${row.id}:${chunk.ordinal}`,
        document_id: row.id,
        token: row.token,
        items: derived ? [derived, original] : [original],
      };
      const haystack = `${row.name}\n${chunk.body}`.toLowerCase();
      ranked.push({
        candidate,
        score: terms.reduce((sum, term) => sum + Number(haystack.includes(term)), 0),
      });
    }
  }
  ranked.sort((a, b) => b.score - a.score || a.candidate.id.localeCompare(b.candidate.id));
  const candidates: Candidate[] = [];
  for (const { candidate } of ranked) {
    if (candidates.length >= 12) break;
    if (utf8Size(JSON.stringify([...candidates, candidate])) <= 8192) candidates.push(candidate);
  }
  return candidates;
}

describe("authorized knowledge ranking work", () => {
  it("ranks 768 segments without building every candidate and matches the complete scalar snapshot", () => {
    const f = fixture();
    const text = Array.from(
      { length: 768 },
      (_, i) => `${i === 767 ? "needle" : "filler"} ${i} ${"x".repeat(480)}。\n`,
    ).join("");
    f.add("10000000-0000-4000-8000-000000000001", text);
    f.add("10000000-0000-4000-8000-000000000002", "needle secret", false);
    const expected = scalar(f, "needle");
    const segments = knowledgeSegments(text, 768).length;
    expect(segments).toBe(768);
    const original = f.h.db.query;
    const query = original.bind(f.h.db);
    let nameReads = 0;
    f.h.db.query = ((sql: string) => {
      const statement = query(sql);
      if (!sql.includes("SELECT d.id, g.token, d.name, d.original_text")) return statement;
      return new Proxy(statement, {
        get(target, key) {
          const value = Reflect.get(target, key, target);
          if (key === "all")
            return (...args: unknown[]) => {
              const rows = Reflect.apply(value, target, args) as Document[];
              return rows.map(
                (row) =>
                  new Proxy(row, {
                    get(document, field) {
                      if (field === "name") nameReads++;
                      return Reflect.get(document, field);
                    },
                  }),
              );
            };
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    }) as typeof f.h.db.query;
    let actual: Candidate[];
    try {
      actual = f.begin("needle").candidates;
    } finally {
      f.h.db.query = original;
    }
    expect(actual).toEqual(expected);
    expect(utf8Size(JSON.stringify(actual))).toBeLessThanOrEqual(8192);
    expect(actual.length).toBeLessThanOrEqual(12);
    expect(nameReads).toBeLessThanOrEqual(segments + 12);
    expect(qqKnowledgeItems(f.h.db, DEFAULT_AGENT_ID, "needle", 12)).toEqual(
      expected.map((candidate) => candidate.items[0]),
    );
  });

  it("preserves mapped draft precedence, exact byte rejection, malformed map fallback and source ranges", () => {
    const f = fixture();
    f.add("10000000-0000-4000-8000-000000000003", "needle" + "界".repeat(4000));
    const text = "\uFEFFneedle 42.5°C 𠮷。\r\nexact second。";
    f.add("10000000-0000-4000-8000-000000000004", text);
    f.add("10000000-0000-4000-8000-000000000005", "needle fallback。");
    f.h.db
      .query(
        "INSERT INTO knowledge_drafts(id,document_id,content_version,summary,tags,body,sources,model_name,created_at) VALUES(?,?,1,'','[]',?,?,'synthetic','now')",
      )
      .run(
        "draft",
        "10000000-0000-4000-8000-000000000004",
        "整理𠮷",
        JSON.stringify([
          {
            type: "document",
            document_id: "10000000-0000-4000-8000-000000000004",
            version: 1,
            start: 0,
            end: text.length,
            valid: true,
            draft_start: 0,
            draft_end: "整理𠮷".length,
          },
        ]),
      );
    f.h.db
      .query(
        "INSERT INTO knowledge_drafts(id,document_id,content_version,summary,tags,body,sources,model_name,created_at) VALUES(?,?,1,'','[]','bad','not-json','synthetic','now')",
      )
      .run("old", "10000000-0000-4000-8000-000000000005");
    f.h.db
      .query(
        "UPDATE knowledge_documents SET content_mode='draft' WHERE id IN ('10000000-0000-4000-8000-000000000004','10000000-0000-4000-8000-000000000005')",
      )
      .run();
    const settings = f.repo.settings();
    f.repo.updateSettings({
      ...settings,
      auto_enabled: true,
      expected_revision: settings.revision,
    });
    const expected = scalar(f, "needle");
    expect(f.begin("needle").candidates).toEqual(expected);
    expect(
      expected.some(
        (candidate) => candidate.document_id === "10000000-0000-4000-8000-000000000003",
      ),
    ).toBe(false);
    expect(
      expected
        .find((candidate) => candidate.document_id === "10000000-0000-4000-8000-000000000004")
        ?.items.map((item) => item.content_origin),
    ).toEqual(["derived", "original"]);
    expect(
      expected.find((candidate) => candidate.document_id === "10000000-0000-4000-8000-000000000005")
        ?.items[0].content_origin,
    ).toBe("original");
    for (const candidate of expected)
      for (const item of candidate.items) {
        if (item.content_origin !== "original") continue;
        const s = item.sources[0];
        if (s.type !== "document") throw new Error("unexpected source");
        const document = f.h.db
          .query<{ original_text: string }, [string]>(
            "SELECT original_text FROM knowledge_documents WHERE id=?",
          )
          .get(candidate.document_id);
        expect(item.body).toBe(document?.original_text.slice(s.start, s.end));
      }
  });

  it("accepts exactly 8192 bytes, skips 8193 without dropping later candidates, and retains the 12 cap", () => {
    const f = fixture();
    const id = "10000000-0000-4000-8000-000000000007";
    f.add(id, "needle。", true, 'escaped "name"\\\n𠮷');
    const template = scalar(f, "needle")[0];
    let body = "needle";
    const size = (text: string) => {
      const candidate: Candidate = JSON.parse(JSON.stringify(template));
      const original = candidate.items[0];
      original.body = text;
      original.revision = "2";
      const source = original.sources[0];
      if (source.type !== "document") throw new Error("missing document source");
      source.version = 2;
      source.end = text.length;
      return utf8Size(JSON.stringify([candidate]));
    };
    while (size(body) < 8192) body += "x";
    expect(size(body)).toBe(8192);
    let doc = f.repo.detail(id);
    f.repo.updateDocument(id, {
      expected_revision: doc.revision,
      original_text: body,
      content_mode: "original",
    });
    const exact = f.begin("needle").candidates;
    expect(utf8Size(JSON.stringify(exact))).toBe(8192);
    expect(exact).toEqual(scalar(f, "needle"));
    f.add("10000000-0000-4000-8000-000000000008", "needle small。");
    doc = f.repo.detail(id);
    f.repo.updateDocument(id, {
      expected_revision: doc.revision,
      original_text: `${body}x`,
      content_mode: "original",
    });
    const skipped = f.begin("needle").candidates;
    expect(skipped).toEqual(scalar(f, "needle"));
    expect(skipped.map((candidate) => candidate.document_id)).toEqual([
      "10000000-0000-4000-8000-000000000008",
    ]);
    f.repo.deleteDocument(id, f.repo.detail(id).revision);
    for (let i = 0; i < 20; i++)
      f.add(`20000000-0000-4000-8000-${String(i).padStart(12, "0")}`, "needle。");
    const capped = f.begin("needle").candidates;
    expect(capped).toEqual(scalar(f, "needle"));
    expect(capped).toHaveLength(12);
  });

  it("rechecks grant tokens on frozen retries and reflects revisions only in fresh rankings", () => {
    const f = fixture();
    f.add("10000000-0000-4000-8000-000000000006", "needle old。");
    const first = f.begin("needle");
    const doc = f.repo.detail("10000000-0000-4000-8000-000000000006");
    f.repo.updateDocument(doc.id, {
      expected_revision: doc.revision,
      original_text: "needle new。",
      content_mode: "original",
    });
    expect(f.begin("needle").candidates).toEqual(scalar(f, "needle"));
    expect(f.begin("needle").candidates).not.toEqual(first.candidates);
    // A content update does not revoke the grant or rewrite the frozen material.
    expect(() => first.context.assertAccess(first.turnId, DEFAULT_AGENT_ID)).not.toThrow();
    const frozen = f.h.db
      .query<{ items: string }, [string]>(
        "SELECT items FROM turn_knowledge_snapshots WHERE turn_id=?",
      )
      .get(first.turnId);
    expect(JSON.parse(frozen?.items ?? "null").candidates).toEqual(first.candidates);
    const current = f.begin("needle");
    expect(() => current.context.assertAccess(current.turnId, DEFAULT_AGENT_ID)).not.toThrow();
    const updated = f.repo.detail("10000000-0000-4000-8000-000000000006");
    f.repo.replaceGrants(updated.id, updated.revision, []);
    expect(() => current.context.assertAccess(current.turnId, DEFAULT_AGENT_ID)).toThrow();
    expect(qqKnowledgeItems(f.h.db, DEFAULT_AGENT_ID, "needle")).toEqual([]);
  });
});
