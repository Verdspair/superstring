import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { z } from "zod";
import type { RuntimeConfig } from "../../shared/contracts";
import type { Evidence, SourceRef } from "../../shared/contracts/evidence";
import { resolveMemoryReadPolicy } from "../../shared/contracts/memory";
import { rankedMemoryCandidates, scanMemoryCandidates } from "../db/context-repository";
import { contextDumps } from "../db/json-text";
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
  EvidenceReadInput,
  EvidenceTextPage,
  MemoryModule,
  MemoryQuery,
  MemoryReadInput,
} from "./contracts";
import { contextKeywords, estimateMessages } from "./memory-query";

export interface SqliteMemoryOptions {
  orm: Orm;
  runtime?: (agentId: string) => RuntimeConfig;
  assertCurrent?: () => void;
  assertSources?: (sources: readonly SourceRef[]) => void;
}

const cursorSecret = randomBytes(32);
const memoryCursorKey = randomBytes(32);
const CursorSchema = z.strictObject({
  version: z.literal(1),
  kind: z.enum(["memory", "knowledge"]),
  owner: z.string().regex(/^[a-f0-9]{64}$/),
  agent: z.string().min(1).max(256),
  scope: z.string().regex(/^[a-f0-9]{64}$/),
  query: z.string().regex(/^[a-f0-9]{64}$/),
  after: z.strictObject({
    id: z.string().max(256),
    ordinal: z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER),
    offset: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    original: z.boolean().optional(),
    score: z.number().int().nonnegative().optional(),
  }),
});
type Cursor = z.infer<typeof CursorSchema>;
export type EvidenceCursorBinding = Omit<Cursor, "version" | "after">;

export function evidenceDigest(value: unknown): string {
  return createHash("sha256").update(contextDumps(value)).digest("hex");
}

export function assertEvidenceOwner(
  input: Pick<MemoryQuery, "owner" | "agentId">,
  runtime: RuntimeConfig,
): void {
  if (
    runtime.agent_id !== input.agentId ||
    (input.owner.agentId !== undefined && input.owner.agentId !== input.agentId) ||
    (input.owner.userId !== undefined && input.owner.userId !== DEFAULT_USER_ID)
  )
    fail("CONTEXT_INVALID_SELECTION", "资料读取身份与助手不匹配");
}

/** Shared signed envelope for server locators and cursors; never an authorization grant. */
export function sealEvidenceValue(value: unknown): string {
  const payload = JSON.stringify(value);
  return JSON.stringify({
    payload,
    mac: createHmac("sha256", cursorSecret).update(payload).digest("hex"),
  });
}

export function openEvidenceValue(value: string): unknown {
  try {
    if (value.length > 4096) throw new Error("Reference too long");
    const envelope = z
      .strictObject({ payload: z.string().max(3500), mac: z.string().regex(/^[a-f0-9]{64}$/) })
      .parse(JSON.parse(value));
    const mac = createHmac("sha256", cursorSecret).update(envelope.payload).digest();
    if (!timingSafeEqual(mac, Buffer.from(envelope.mac, "hex")))
      throw new Error("Invalid signature");
    return JSON.parse(envelope.payload);
  } catch {
    fail("CONTEXT_INVALID_SELECTION", "资料引用无效");
  }
}

/** Memory cursors hide scan positions; neither cursor form grants authority. */
export function evidenceCursor(binding: EvidenceCursorBinding, after: Cursor["after"]): string {
  const value = CursorSchema.parse({ version: 1, ...binding, after });
  if (binding.kind !== "memory") return sealEvidenceValue(value);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", memoryCursorKey, nonce);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return JSON.stringify({
    version: 1,
    nonce: nonce.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  });
}

function openMemoryCursor(value: string): unknown {
  if (value.length > 4096) throw new Error("Cursor too long");
  const envelope = z
    .strictObject({
      version: z.literal(1),
      nonce: z.string(),
      tag: z.string(),
      ciphertext: z.string(),
    })
    .parse(JSON.parse(value));
  const nonce = Buffer.from(envelope.nonce, "base64url");
  const tag = Buffer.from(envelope.tag, "base64url");
  if (nonce.length !== 12 || tag.length !== 16) throw new Error("Invalid cursor");
  const decipher = createDecipheriv("aes-256-gcm", memoryCursorKey, nonce);
  decipher.setAuthTag(tag);
  return JSON.parse(
    Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8"),
  );
}

export function parseEvidenceCursor(
  cursor: string | undefined,
  binding: EvidenceCursorBinding,
): Cursor["after"] {
  if (cursor === undefined) return { id: "", ordinal: -1, offset: 0 };
  try {
    const parsed = CursorSchema.parse(
      binding.kind === "memory" ? openMemoryCursor(cursor) : openEvidenceValue(cursor),
    );
    for (const key of ["kind", "owner", "agent", "scope", "query"] as const)
      if (parsed[key] !== binding[key]) throw new Error("Different query scope");
    if (
      (binding.kind === "memory" &&
        (parsed.after.ordinal !== -1 ||
          parsed.after.offset !== 0 ||
          parsed.after.original !== undefined)) ||
      (binding.kind === "knowledge" && parsed.after.score !== undefined)
    )
      throw new Error("Invalid evidence position");
    return parsed.after;
  } catch {
    fail("CONTEXT_INVALID_SELECTION", "资料游标无效或不属于当前查询与范围");
  }
}

/** Offsets and totals are Unicode code points, not UTF-16 units or UTF-8 bytes. */
export function evidenceTextPage(
  text: string,
  input: Pick<EvidenceReadInput, "offset" | "limit">,
): EvidenceTextPage {
  if (
    !Number.isSafeInteger(input.offset) ||
    input.offset < 0 ||
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1
  )
    fail("CONTEXT_INVALID_SELECTION", "资料正文分页参数无效");
  const chars = [...text];
  if (input.offset > chars.length) fail("CONTEXT_INVALID_SELECTION", "资料正文偏移超出证据范围");
  const end = Math.min(chars.length, input.offset + Math.min(4096, input.limit));
  return {
    text: chars.slice(input.offset, end).join(""),
    offset: input.offset,
    total: chars.length,
    nextOffset: end < chars.length ? end : null,
  };
}

export function evidencePageLimit(
  limit: number | undefined,
  fallback: number,
  maximum = 100,
): number {
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1))
    fail("CONTEXT_INVALID_SELECTION", "资料目录分页参数无效");
  return Math.min(100, maximum, limit ?? fallback);
}

export function evidenceCatalogCost(items: readonly Evidence[]): number {
  // Include a host opaque bodyRef placeholder and JSON/protocol framing in the byte budget.
  return estimateMessages([
    {
      role: "user",
      content: JSON.stringify(
        items.map((item) => ({ id: item.id, ...item.preview, bodyRef: "0".repeat(64) })),
      ),
    },
  ]);
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
    const policy = resolveMemoryReadPolicy(input.mode, runtime.p5_config.retrieval_presets);
    const mode = policy.effectiveMode;
    const preset = policy.preset;
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
        mode,
        runtime.p5_config.retrieval_mode,
        preset,
      ]),
      query: evidenceDigest(input.query),
    };
    const position = parseEvidenceCursor(input.cursor, binding);
    const limit = evidencePageLimit(
      input.limit,
      Math.min(preset.max_entries, 20),
      preset.max_entries,
    );
    if (
      mode === "off" ||
      runtime.p5_config.retrieval_mode === "off" ||
      input.scopes?.length === 0
    ) {
      this.current(input);
      return { status: "ok", items: [] };
    }
    const budget = Math.min(input.budget, preset.max_tokens);
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
          limit: Math.min(preset.candidate_limit, 300),
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
            const evidence: Evidence = {
              id: item.id,
              text: "",
              preview: { title: item.name, summary: item.summary },
              score: candidate.score,
              sources: [
                candidate.accessRef ?? { kind: "memory", id: item.id, revision: item.revision },
              ],
              scope: input.scopes === null ? input.agentId : JSON.stringify(input.scopes),
            };
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
        limit: Math.min(preset.candidate_limit, 300),
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
            const evidence: Evidence = {
              id: item.id,
              text: "",
              preview: { title: item.name, summary: item.summary },
              score,
              sources: [
                candidate.accessRef ?? { kind: "memory", id: item.id, revision: item.revision },
              ],
              scope: input.scopes === null ? input.agentId : JSON.stringify(input.scopes),
            };
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
    if (runtime.p5_config.retrieval_mode === "off")
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
      return evidenceTextPage(found.item.body ?? "", input);
    });
    this.current(input, input.evidence.sources);
    return page;
  }
}
