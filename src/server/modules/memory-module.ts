import type { RuntimeConfig } from "../../shared/contracts";
import {
  type Evidence,
  MemoryEvidenceMetadataSchema,
  type SourceRef,
} from "../../shared/contracts/evidence";
import { resolveMemoryReadSettings } from "../../shared/contracts/memory";
import {
  type MemoryItem,
  rankedMemoryCandidates,
  scanMemoryCandidates,
} from "../db/context-repository";
import { DEFAULT_USER_ID, type Orm } from "../db/repositories";
import { fail } from "../errors";
import { fullCasefold } from "../services/casefold-table";
import {
  memoryAccessOwnerMatches,
  memoryConversationAccess,
  memoryGrantFingerprint,
} from "../services/memory-scope";
import type {
  EvidenceQueryPage,
  EvidenceTextPage,
  MemoryModule,
  MemoryQuery,
  MemoryReadInput,
} from "./contracts";
import {
  assertEvidenceOwner,
  type EvidenceCursorBinding,
  evidenceCatalogCost,
  evidenceCursor,
  evidenceDigest,
  evidencePageLimit,
  evidenceTextPage,
  parseEvidenceCursor,
} from "./evidence-pagination";
import { contextKeywords } from "./memory-query";

export interface SqliteMemoryOptions {
  orm: Orm;
  runtime?: (agentId: string) => RuntimeConfig;
  assertCurrent?: () => void;
  assertSources?: (sources: readonly SourceRef[]) => void;
}

function asMemoryEvidence(
  item: MemoryItem,
  scope: string,
  score: number,
  source: SourceRef,
): Evidence {
  return {
    id: item.id,
    text: "",
    preview: { title: item.name, summary: item.summary },
    score,
    sources: [source],
    scope,
    metadata: MemoryEvidenceMetadataSchema.parse({ content_origin: item.content_origin }),
  };
}

/** Queries return bounded evidence pages; bodies are read separately. */
export class SqliteMemoryModule implements MemoryModule {
  constructor(private readonly options: SqliteMemoryOptions) {}

  private current(
    input: Pick<MemoryQuery, "signal" | "sources">,
    sources: readonly SourceRef[] = [],
  ): void {
    input.signal?.throwIfAborted();
    this.options.assertCurrent?.();
    this.options.assertSources?.([...(input.sources ?? []), ...sources]);
    input.signal?.throwIfAborted();
  }

  async query(input: MemoryQuery): Promise<EvidenceQueryPage> {
    this.current(input);
    if (!this.options.runtime)
      throw new Error("SQLite memory module requires a frozen read configuration");
    const runtime = this.options.runtime(input.agentId);
    assertEvidenceOwner(input, runtime);
    const access = input.conversationId
      ? memoryConversationAccess(
          this.options.orm,
          input.conversationId,
          input.agentId,
          DEFAULT_USER_ID,
        )
      : null;
    if ((input.owner.kind === "web_turn" || input.owner.kind === "qq_binding") && !access)
      fail("CONTEXT_SOURCE_INVALID", "会话记忆权限已变化");
    if (input.conversationId && !access) fail("CONTEXT_SOURCE_INVALID", "会话记忆权限已变化");
    if (access && !memoryAccessOwnerMatches(this.options.orm, access, input.owner, input.sessionId))
      fail("CONTEXT_SOURCE_INVALID", "会话记忆权限已变化");
    const settings = resolveMemoryReadSettings(runtime.p5_config);
    const binding: EvidenceCursorBinding = {
      kind: "memory",
      owner: evidenceDigest(input.owner),
      agent: input.agentId,
      scope: evidenceDigest([
        input.scopes,
        input.sessionId ?? null,
        access?.conversationId ?? null,
        access?.revision ?? null,
        access ? memoryGrantFingerprint(this.options.orm, access) : null,
        settings,
      ]),
      query: evidenceDigest(input.query),
    };
    const position = parseEvidenceCursor(input.cursor, binding);
    const limit = evidencePageLimit(
      input.limit,
      Math.min(settings.maxEntries, 20),
      settings.maxEntries,
    );
    if (!settings.enabled || input.scopes?.length === 0) {
      this.current(input);
      return { status: "ok", items: [] };
    }
    const budget = Math.min(input.budget, settings.maxBytes);
    if (!Number.isFinite(budget) || budget < evidenceCatalogCost([]))
      return { status: "unavailable", code: "CONTEXT_AUX_BUDGET", items: [] };
    const result = this.options.orm.transaction((): EvidenceQueryPage => {
      if (input.query.trim()) {
        const terms = contextKeywords(input.query);
        if (!terms.length) terms.push(fullCasefold(input.query.trim()));
        if (input.cursor !== undefined && position.score === undefined)
          fail("CONTEXT_INVALID_SELECTION", "记忆排序游标无效");
        const batch = rankedMemoryCandidates(this.options.orm, input.agentId, input.scopes, {
          sessionId: input.sessionId,
          ...(access ? { access } : {}),
          terms,
          limit: Math.min(settings.candidateLimit, 300),
          ...(position.score === undefined
            ? {}
            : { after: { id: position.id, score: position.score } }),
        });
        if (batch.repairNeeded)
          return { status: "unavailable", code: "MEMORY_SEARCH_REPAIR_NEEDED", items: [] };
        const byId = new Map(batch.items.map((candidate) => [candidate.item.id, candidate]));
        const items: Evidence[] = [];
        let after =
          position.score === undefined ? undefined : { id: position.id, score: position.score };
        let stopped = false;
        for (const current of batch.positions) {
          const candidate = byId.get(current.id);
          if (candidate) {
            const item = candidate.item;
            if (access && !candidate.accessRef) fail("CONTEXT_SOURCE_INVALID", "记忆权限已变化");
            const evidence = asMemoryEvidence(
              item,
              input.scopes === null ? input.agentId : JSON.stringify(input.scopes),
              candidate.score,
              candidate.accessRef ?? { kind: "memory", id: item.id, revision: item.revision },
            );
            if (items.length >= limit || evidenceCatalogCost([...items, evidence]) > budget) {
              if (!items.length)
                return { status: "unavailable", code: "CONTEXT_AUX_BUDGET", items: [] };
              stopped = true;
              break;
            }
            items.push(evidence);
          }
          after = current;
        }
        return {
          status: "ok",
          items,
          nextCursor:
            (stopped || batch.hasMore) && after
              ? evidenceCursor(binding, {
                  id: after.id,
                  score: after.score,
                  ordinal: -1,
                  offset: 0,
                })
              : null,
        };
      }
      if (position.score !== undefined) fail("CONTEXT_INVALID_SELECTION", "记忆浏览游标无效");
      const batch = scanMemoryCandidates(this.options.orm, input.agentId, input.scopes, {
        sessionId: input.sessionId,
        ...(access ? { access } : {}),
        afterId: position.id,
        limit: Math.min(settings.candidateLimit, 300),
      });
      const byId = new Map(batch.items.map((candidate) => [candidate.item.id, candidate]));
      const terms = contextKeywords(input.query);
      const items: Evidence[] = [];
      let afterId = position.id;
      let stopped = false;
      for (const id of batch.scannedIds) {
        const candidate = byId.get(id);
        if (candidate) {
          const { item, searchText } = candidate;
          if (access && !candidate.accessRef) fail("CONTEXT_SOURCE_INVALID", "记忆权限已变化");
          const haystack = `${item.name}\n${item.summary}\n${searchText}`.toLowerCase();
          const score = terms.reduce((sum, term) => sum + Number(haystack.includes(term)), 0);
          if (!input.query.trim() || score > 0) {
            const evidence = asMemoryEvidence(
              item,
              input.scopes === null ? input.agentId : JSON.stringify(input.scopes),
              score,
              candidate.accessRef ?? { kind: "memory", id: item.id, revision: item.revision },
            );
            if (items.length >= limit || evidenceCatalogCost([...items, evidence]) > budget) {
              if (!items.length)
                return { status: "unavailable", code: "CONTEXT_AUX_BUDGET", items: [] };
              stopped = true;
              break;
            }
            items.push(evidence);
          }
        }
        afterId = id;
      }
      return {
        status: "ok",
        items,
        nextCursor:
          stopped || batch.hasMore
            ? evidenceCursor(binding, { id: afterId, ordinal: -1, offset: 0 })
            : null,
      };
    });
    this.current(
      input,
      result.items.flatMap((item) => item.sources),
    );
    return result;
  }

  async read(input: MemoryReadInput): Promise<EvidenceTextPage> {
    this.current(input, input.evidence.sources);
    if (!this.options.runtime)
      throw new Error("SQLite memory module requires a frozen read configuration");
    const runtime = this.options.runtime(input.agentId);
    assertEvidenceOwner(input, runtime);
    if (!resolveMemoryReadSettings(runtime.p5_config).enabled)
      fail("CONTEXT_SOURCE_INVALID", "记忆读取已关闭");
    const scope = input.scopes === null ? input.agentId : JSON.stringify(input.scopes);
    const source = input.evidence.sources[0];
    const access = input.conversationId
      ? memoryConversationAccess(
          this.options.orm,
          input.conversationId,
          input.agentId,
          DEFAULT_USER_ID,
        )
      : null;
    if ((input.owner.kind === "web_turn" || input.owner.kind === "qq_binding") && !access)
      fail("CONTEXT_SOURCE_INVALID", "会话记忆权限已变化");
    if (input.conversationId && !access) fail("CONTEXT_SOURCE_INVALID", "会话记忆权限已变化");
    if (access && !memoryAccessOwnerMatches(this.options.orm, access, input.owner, input.sessionId))
      fail("CONTEXT_SOURCE_INVALID", "会话记忆权限已变化");
    if (
      input.evidence.scope !== scope ||
      input.scopes?.length === 0 ||
      input.evidence.sources.length !== 1 ||
      !source ||
      (source.kind !== "memory" && source.kind !== "memory_access")
    )
      fail("CONTEXT_INVALID_SELECTION", "记忆证据不属于当前范围");
    const page = this.options.orm.transaction(() => {
      const found = scanMemoryCandidates(this.options.orm, input.agentId, input.scopes, {
        id: input.evidence.id,
        sessionId: input.sessionId,
        limit: 1,
        ...(access ? { access } : {}),
      }).items[0];
      if (
        !found ||
        (source.kind === "memory"
          ? source.id !== found.item.id || source.revision !== found.item.revision
          : !found.accessRef ||
            source.id !== found.accessRef.id ||
            source.revision !== found.accessRef.revision)
      )
        fail("CONTEXT_SOURCE_INVALID", "记忆已更新，请重新查询");
      return {
        ...evidenceTextPage(found.item.body ?? "", input),
        metadata: MemoryEvidenceMetadataSchema.parse({ content_origin: found.item.content_origin }),
      };
    });
    this.current(input, input.evidence.sources);
    return page;
  }
}
