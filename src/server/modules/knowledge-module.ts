import type { Database } from "bun:sqlite";
import { z } from "zod";
import type { RuntimeConfig } from "../../shared/contracts";
import { ContentItemSchema } from "../../shared/contracts/content";
import type { Evidence, SourceRef } from "../../shared/contracts/evidence";
import type { LeafAgentRuntime } from "../agent/agent-runtime";
import { KnowledgeRepository } from "../db/knowledge-repository";
import { fail } from "../errors";
import type { ModelGateway } from "../llm/model-gateway";
import { utf8Size } from "../services/knowledge-segments";
import type {
  EvidenceQueryPage,
  EvidenceReadInput,
  EvidenceTextPage,
  KnowledgeModule,
  KnowledgeQuery,
} from "./contracts";
import {
  assertEvidenceOwner,
  type EvidenceCursorBinding,
  evidenceCatalogCost,
  evidenceCursor,
  evidenceDigest,
  evidencePageLimit,
  evidenceTextPage,
  openEvidenceValue,
  parseEvidenceCursor,
  sealEvidenceValue,
} from "./evidence-pagination";

export function knowledgeTerms(text: string): string[] {
  const parts = text.toLowerCase().match(/[\p{Script=Han}]+|[a-z0-9_]+(?:\.[0-9]+)?/gu) ?? [];
  const words = parts.flatMap((part) => {
    if (!/\p{Script=Han}/u.test(part)) return [part];
    const chars = [...part];
    return chars.length < 2 ? chars : chars.slice(0, -1).map((char, i) => char + chars[i + 1]);
  });
  return [...new Set(words)].slice(0, 64);
}
const KNOWLEDGE_SCAN_BYTES = 65536;
const KNOWLEDGE_SCAN_ROWS = 120;
const KNOWLEDGE_WINDOW_POINTS = 1024;
const KnowledgeRefSchema = z.strictObject({
  version: z.literal(1),
  kind: z.literal("knowledge_body"),
  owner: z.string().regex(/^[a-f0-9]{64}$/),
  agent: z.string().min(1).max(256),
  document: z.string().min(1).max(256),
  revision: z.number().int().positive(),
  documentRevision: z.number().int().positive(),
  chunk: z.string().min(1).max(256).nullable(),
  ordinal: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  length: z.number().int().positive().max(KNOWLEDGE_WINDOW_POINTS),
  origin: z.enum(["original", "derived"]),
  draft: z.string().max(256).nullable(),
  mapping: z.string().max(2048).nullable(),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
});
type KnowledgeRef = z.infer<typeof KnowledgeRefSchema>;
type ScanPosition = ReturnType<typeof parseEvidenceCursor>;
type KnowledgeRow = {
  id: string;
  token: string;
  name: string;
  content_version: number;
  revision: number;
  content_mode: string;
  chunk: string | null;
  ordinal: number;
  start_offset: number;
  end_offset: number;
  point_offset: number;
  body: string;
  more: number;
};

/** Standalone tool backend. No selection models, snapshot writes or new index are used. */
export class SqliteKnowledgeModule implements KnowledgeModule {
  constructor(
    private readonly options: {
      db: Database;
      gateway?: Pick<ModelGateway, "loadedContextCapacity">;
      agentRuntime?: LeafAgentRuntime;
      runtime: (agentId: string) => RuntimeConfig;
      assertSources?: (sources: readonly SourceRef[]) => void;
    },
  ) {}

  private current(
    input: Pick<KnowledgeQuery, "signal" | "sources">,
    sources: readonly SourceRef[] = [],
  ): void {
    input.signal?.throwIfAborted();
    this.options.assertSources?.([...(input.sources ?? []), ...sources]);
    input.signal?.throwIfAborted();
  }

  private rules(runtime: RuntimeConfig) {
    const frozen = runtime.knowledge_read;
    const legacy = frozen ? null : new KnowledgeRepository(this.options.db).settings();
    return {
      enabled: frozen?.config.enabled ?? true,
      ids: frozen?.config.scope === "selected" ? frozen.config.document_ids : null,
      budget: frozen?.budget ?? legacy?.context_budget ?? 0,
      drafts: frozen?.auto_enabled ?? legacy?.auto_enabled ?? false,
    };
  }

  /** Documents without current chunks have a read-only virtual chunk, never an eager reindex.
   * Both branches authorize in SQL and use (document, ordinal, point offset) keysets.
   */
  private scanSql(agentId: string, ids: string[] | null, after: ScanPosition) {
    const scope =
      ids === null ? "" : ids.length ? ` AND d.id IN (${ids.map(() => "?").join(",")})` : " AND 0";
    return {
      from: `FROM knowledge_documents d JOIN knowledge_grants g ON g.document_id = d.id
        LEFT JOIN knowledge_chunks c ON c.document_id = d.id AND c.content_version = d.content_version
        WHERE g.agent_id = ?${scope} AND (d.id > ? OR (d.id = ? AND
          (COALESCE(c.ordinal, 0) > ? OR (COALESCE(c.ordinal, 0) = ? AND ? > 0))))`,
      args: [
        agentId,
        ...(ids ?? []),
        after.id,
        after.id,
        after.original && after.offset === 0 ? after.ordinal - 1 : after.ordinal,
        after.original && after.offset === 0 ? after.ordinal - 1 : after.ordinal,
        after.offset,
      ],
    };
  }

  private nextRow(
    agentId: string,
    ids: string[] | null,
    after: ScanPosition,
    points: number,
  ): KnowledgeRow | null {
    const query = this.scanSql(agentId, ids, after);
    return this.options.db
      .query<KnowledgeRow, (string | number)[]>(`WITH next AS MATERIALIZED (
        SELECT d.id, g.token, d.content_version, d.revision, d.content_mode,
          c.id AS chunk, COALESCE(c.ordinal, 0) AS ordinal, COALESCE(c.start_offset, 0) AS start_offset,
          COALESCE(c.end_offset, 0) AS end_offset
        ${query.from} ORDER BY d.id, COALESCE(c.ordinal, 0) LIMIT 1)
      SELECT n.*, substr(d.name, 1, 200) AS name,
        CASE WHEN n.id = ? AND n.ordinal = ? THEN ? ELSE 0 END AS point_offset,
        substr(COALESCE(c.body, d.original_text),
          CASE WHEN n.id = ? AND n.ordinal = ? THEN ? + 1 ELSE 1 END, ?) AS body,
        length(substr(COALESCE(c.body, d.original_text),
          CASE WHEN n.id = ? AND n.ordinal = ? THEN ? + ? + 1 ELSE ? + 1 END, 1)) > 0 AS more
      FROM next n JOIN knowledge_documents d ON d.id = n.id
        LEFT JOIN knowledge_chunks c ON c.id = n.chunk`)
      .get(
        ...query.args,
        after.id,
        after.ordinal,
        after.offset,
        after.id,
        after.ordinal,
        after.offset,
        points,
        after.id,
        after.ordinal,
        after.offset,
        points,
        points,
      );
  }

  private hasNext(agentId: string, ids: string[] | null, after: ScanPosition): boolean {
    const query = this.scanSql(agentId, ids, after);
    return (
      this.options.db
        .query(`SELECT d.id ${query.from} ORDER BY d.id, COALESCE(c.ordinal, 0) LIMIT 1`)
        .get(...query.args) !== null
    );
  }

  private mappedDraft(
    row: KnowledgeRow,
    available: number,
  ):
    | { text: string; summary: string; id: string; mapping: string; bytes: number }
    | { invalid: true; bytes: number }
    | "unavailable"
    | null {
    if (row.chunk === null) return null;
    // Source JSON is inspected in SQLite; never transfer the whole mapping or an oversized draft.
    const saved = this.options.db
      .query<
        {
          id: string;
          body: string | null;
          summary: string;
          mapping: string;
          bytes: number;
        },
        (string | number)[]
      >(`SELECT s.id,
        CASE WHEN length(CAST(s.body AS BLOB)) + length(CAST(j.value AS BLOB)) <= ? THEN s.body ELSE NULL END AS body,
        substr(s.summary, 1, 160) AS summary, j.value AS mapping,
        length(CAST(s.body AS BLOB)) + length(CAST(j.value AS BLOB)) AS bytes
      FROM knowledge_drafts s, json_each(CASE WHEN json_valid(s.sources) THEN s.sources ELSE '[]' END) j
      WHERE s.document_id = ? AND s.content_version = ? AND j.type = 'object'
        AND length(CAST(j.value AS BLOB)) <= 2048
        AND json_extract(j.value, '$.type') = 'document' AND json_extract(j.value, '$.valid') = 1
        AND json_extract(j.value, '$.document_id') = ? AND json_extract(j.value, '$.version') = ?
        AND json_extract(j.value, '$.start') <= ? AND json_extract(j.value, '$.end') >= ?
        AND json_extract(j.value, '$.end') <= (SELECT MAX(c.end_offset) FROM knowledge_chunks c
          WHERE c.document_id = s.document_id AND c.content_version = s.content_version)
        AND json_extract(j.value, '$.draft_start') >= 0 AND json_extract(j.value, '$.draft_end') > json_extract(j.value, '$.draft_start')
      LIMIT 1`)
      .get(
        available,
        row.id,
        row.content_version,
        row.id,
        row.content_version,
        row.start_offset,
        row.end_offset,
      );
    if (!saved) return null;
    if (saved.body === null) return "unavailable";
    const parsed = ContentItemSchema.shape.sources.safeParse([JSON.parse(saved.mapping)]);
    const source = parsed.success ? parsed.data[0] : undefined;
    if (
      source?.type !== "document" ||
      source.draft_start === undefined ||
      source.draft_end === undefined ||
      source.draft_end > saved.body.length
    )
      return { invalid: true, bytes: saved.bytes };
    const text = saved.body.slice(source.draft_start, source.draft_end);
    if (!text.isWellFormed()) return { invalid: true, bytes: saved.bytes };
    return {
      text,
      summary: saved.summary,
      id: saved.id,
      mapping: saved.mapping,
      bytes: saved.bytes,
    };
  }

  async query(input: KnowledgeQuery): Promise<EvidenceQueryPage> {
    this.current(input);
    const runtime = this.options.runtime(input.agentId);
    assertEvidenceOwner(input, runtime);
    const rules = this.rules(runtime);
    const binding: EvidenceCursorBinding = {
      kind: "knowledge",
      owner: evidenceDigest(input.owner),
      agent: input.agentId,
      scope: evidenceDigest(rules),
      query: evidenceDigest(input.query),
    };
    let after = parseEvidenceCursor(input.cursor, binding);
    const limit = evidencePageLimit(input.limit, 20);
    if (!rules.enabled || rules.ids?.length === 0) {
      this.current(input);
      return { status: "ok", items: [] };
    }
    const budget = Math.min(input.budget, rules.budget);
    if (!Number.isFinite(budget) || budget < evidenceCatalogCost([]))
      return { status: "unavailable", code: "KNOWLEDGE_CONTEXT_BUDGET", items: [] };
    const result = this.options.db.transaction((): EvidenceQueryPage => {
      const terms = knowledgeTerms(input.query);
      const items: Evidence[] = [];
      let remaining = KNOWLEDGE_SCAN_BYTES;
      for (
        let scanned = 0;
        scanned < KNOWLEDGE_SCAN_ROWS && remaining >= 4 && items.length < limit;
        scanned++
      ) {
        input.signal?.throwIfAborted();
        const row = this.nextRow(
          input.agentId,
          rules.ids,
          after,
          Math.min(KNOWLEDGE_WINDOW_POINTS, Math.floor(remaining / 4)),
        );
        if (!row) break;
        const points = [...row.body].length;
        remaining -= utf8Size(row.body);
        const next = {
          id: row.id,
          ordinal: row.ordinal,
          offset: row.more ? row.point_offset + points : 0,
        };
        const haystack = `${row.name}\n${row.body}`.toLowerCase();
        const score = terms.reduce((sum, term) => sum + Number(haystack.includes(term)), 0);
        if (points && (!input.query.trim() || score > 0)) {
          const mapped =
            !after.original && rules.drafts && row.content_mode === "draft"
              ? this.mappedDraft(row, remaining)
              : null;
          if (mapped === "unavailable") {
            if (items.length) break;
            return { status: "unavailable", code: "KNOWLEDGE_CONTEXT_BUDGET", items: [] };
          }
          if (mapped) remaining -= mapped.bytes;
          const draft = mapped && !("invalid" in mapped) ? mapped : null;
          const text = draft?.text ?? row.body;
          const ref: KnowledgeRef = {
            version: 1,
            kind: "knowledge_body",
            owner: binding.owner,
            agent: input.agentId,
            document: row.id,
            revision: row.content_version,
            documentRevision: row.revision,
            chunk: row.chunk,
            ordinal: row.ordinal,
            offset: row.point_offset,
            length: points,
            origin: draft ? "derived" : "original",
            draft: draft?.id ?? null,
            mapping: draft?.mapping ?? null,
            hash: evidenceDigest(text),
          };
          const evidence: Evidence = {
            id: `knowledge:${ref.origin}:${evidenceDigest(ref)}`,
            text: "",
            score,
            // The host retains the signed locator; only the opaque id and preview are advertised.
            scope: sealEvidenceValue(ref),
            preview: {
              title: row.name,
              summary: draft?.summary || [...row.body].slice(0, 160).join(""),
            },
            sources: [
              { kind: "knowledge_document", id: row.id, revision: String(row.content_version) },
              {
                kind: "knowledge_grant",
                id: JSON.stringify([row.id, input.agentId]),
                revision: row.token,
              },
            ],
          };
          if (evidenceCatalogCost([...items, evidence]) > budget) {
            if (items.length) break;
            return { status: "unavailable", code: "KNOWLEDGE_CONTEXT_BUDGET", items: [] };
          }
          items.push(evidence);
          if (draft) {
            // A draft does not hide its exact supplemental original. If a page ends here,
            // the cursor resumes this same window's original rather than dropping it.
            after = { id: row.id, ordinal: row.ordinal, offset: row.point_offset, original: true };
            const original: Evidence = {
              ...evidence,
              id: `knowledge:original:${evidenceDigest({ ...ref, origin: "original", draft: null, mapping: null, hash: evidenceDigest(row.body) })}`,
              scope: sealEvidenceValue({
                ...ref,
                origin: "original",
                draft: null,
                mapping: null,
                hash: evidenceDigest(row.body),
              }),
              preview: { title: row.name, summary: [...row.body].slice(0, 160).join("") },
            };
            if (items.length >= limit || evidenceCatalogCost([...items, original]) > budget) break;
            items.push(original);
          }
        }
        after = next;
      }
      // Live keysets are not immutable snapshots: updates behind this position require a new query.
      return {
        status: "ok",
        items,
        nextCursor:
          after.original || this.hasNext(input.agentId, rules.ids, after)
            ? evidenceCursor(binding, after)
            : null,
      };
    })();
    this.current(
      input,
      result.items.flatMap((item) => item.sources),
    );
    return result;
  }

  async read(input: EvidenceReadInput): Promise<EvidenceTextPage> {
    this.current(input, input.evidence.sources);
    const runtime = this.options.runtime(input.agentId);
    assertEvidenceOwner(input, runtime);
    const rules = this.rules(runtime);
    const parsed = KnowledgeRefSchema.safeParse(openEvidenceValue(input.evidence.scope ?? ""));
    if (!parsed.success) fail("CONTEXT_INVALID_SELECTION", "资料正文引用无效");
    const ref = parsed.data;
    if (
      ref.agent !== input.agentId ||
      ref.owner !== evidenceDigest(input.owner) ||
      input.evidence.id !== `knowledge:${ref.origin}:${evidenceDigest(ref)}`
    )
      fail("CONTEXT_INVALID_SELECTION", "资料正文引用不属于当前读取范围");
    const document = input.evidence.sources.find((source) => source.kind === "knowledge_document");
    const grant = input.evidence.sources.find((source) => source.kind === "knowledge_grant");
    if (
      input.evidence.sources.length !== 2 ||
      document?.id !== ref.document ||
      document.revision !== String(ref.revision) ||
      grant?.id !== JSON.stringify([ref.document, input.agentId])
    )
      fail("CONTEXT_INVALID_SELECTION", "资料正文引用与来源不匹配");
    if (!rules.enabled || (rules.ids !== null && !rules.ids.includes(ref.document)))
      fail("KNOWLEDGE_ACCESS_CHANGED", "资料已关闭或不在当前范围");
    const page = this.options.db.transaction(() => {
      const row = this.options.db
        .query<
          {
            token: string;
            content_version: number;
            revision: number;
            content_mode: string;
          },
          [string, string]
        >(`SELECT g.token, d.content_version, d.revision, d.content_mode
        FROM knowledge_documents d JOIN knowledge_grants g ON g.document_id = d.id
        WHERE d.id = ? AND g.agent_id = ?`)
        .get(ref.document, input.agentId);
      if (
        !row ||
        row.token !== grant.revision ||
        row.content_version !== ref.revision ||
        row.revision !== ref.documentRevision
      )
        fail("KNOWLEDGE_ACCESS_CHANGED", "资料已更新、撤权或删除，请重新查询");
      // Only materialize this evidence's Unicode window, never the whole document.
      // offset=0 means advance past an ordinal in a cursor; a read starts at its beginning.
      const original = this.nextRow(
        input.agentId,
        [ref.document],
        {
          id: ref.document,
          ordinal: ref.offset === 0 ? ref.ordinal - 1 : ref.ordinal,
          offset: ref.offset,
        },
        ref.length,
      );
      if (
        !original ||
        original.id !== ref.document ||
        original.ordinal !== ref.ordinal ||
        original.chunk !== ref.chunk ||
        [...original.body].length !== ref.length
      )
        fail("KNOWLEDGE_ACCESS_CHANGED", "资料片段已变化");
      if (ref.chunk !== null) {
        // Chunks cover the exact original contiguously. Compute code-point positions in SQL
        // so UTF-16 storage offsets cannot split supplementary Unicode characters.
        const intact = this.options.db
          .query(`SELECT c.id FROM knowledge_chunks c
          JOIN knowledge_documents d ON d.id = c.document_id AND d.content_version = c.content_version
          WHERE c.id = ? AND c.document_id = ? AND c.content_version = ? AND c.ordinal = ?
            AND c.start_offset = COALESCE((SELECT p.end_offset FROM knowledge_chunks p
              WHERE p.document_id = c.document_id AND p.content_version = c.content_version AND p.ordinal = c.ordinal - 1), 0)
            AND c.body = substr(d.original_text, 1 + COALESCE((SELECT SUM(length(p.body)) FROM knowledge_chunks p
              WHERE p.document_id = c.document_id AND p.content_version = c.content_version AND p.ordinal < c.ordinal), 0), length(c.body))`)
          .get(ref.chunk, ref.document, ref.revision, ref.ordinal);
        if (!intact) fail("KNOWLEDGE_ACCESS_CHANGED", "资料片段与原文已变化");
      }
      let text = original.body;
      if (ref.origin === "derived") {
        if (!rules.drafts || row.content_mode !== "draft" || !ref.draft || !ref.mapping)
          fail("KNOWLEDGE_ACCESS_CHANGED", "资料整理稿已失效");
        const draft = this.mappedDraft(original, KNOWLEDGE_SCAN_BYTES);
        if (
          !draft ||
          draft === "unavailable" ||
          "invalid" in draft ||
          draft.id !== ref.draft ||
          evidenceDigest(JSON.parse(draft.mapping)) !== evidenceDigest(JSON.parse(ref.mapping))
        )
          fail("KNOWLEDGE_ACCESS_CHANGED", "资料整理稿来源已变化");
        text = draft.text;
      }
      if (evidenceDigest(text) !== ref.hash)
        fail("KNOWLEDGE_ACCESS_CHANGED", "资料正文已变化，请重新查询");
      return evidenceTextPage(text, input);
    })();
    this.current(input, input.evidence.sources);
    return page;
  }
}
