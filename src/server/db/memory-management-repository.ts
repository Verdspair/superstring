import { and, eq, sql } from "drizzle-orm";
import type {
  MemoryAccessMetadata,
  MemoryManagementList,
  MemoryManagementQuery,
  MemoryReadablePage,
  MemoryScopeView,
  MemorySourcePreviewList,
  MemorySourcePreviewPage,
} from "../../shared/contracts/memory";
import {
  type ConversationSourceTarget,
  inspectConversationSourcePage,
  inspectConversationSourcePages,
} from "../agent/conversation-access";
import { fail } from "../errors";
import {
  evidenceTextPage,
  openEvidenceValue,
  sealEvidenceValue,
} from "../modules/evidence-pagination";
import { correctionMetadata, memoryRevision } from "../services/memory-revision";
import { memoryAccessRefs, memoryConversationAccess } from "../services/memory-scope";
import {
  qqConversationScope,
  qqMemoryScopeKey,
  resolveQqMemoryAccess,
} from "../services/qq-binding-contract";
import { scanMemoryCandidates } from "./context-repository";
import { bodyRevision, ConversationEventRepository } from "./conversation-event-repository";
import {
  type MemoryPreviewTarget,
  memoryAccessMetadataBatch,
  memoryPreviewTargets,
  memorySourceFactAssessment,
} from "./memory-source-repository";
import { readQqBindings } from "./qq-binding-repository";
import { readQqOwnerIdentity } from "./qq-owner-repository";
import { readQqSettings } from "./qq-settings-repository";
import { DEFAULT_USER_ID, nowIso, type Orm } from "./repositories";
import * as schema from "./schema";

/** Management discovers content; an explicit canonical context is required for runtime diagnostics. */
export function memoryManagementPage(
  orm: Orm,
  agentId: string,
  query: MemoryManagementQuery,
  memoryId?: string,
): MemoryManagementList {
  const db = (orm as Orm & { $client: import("bun:sqlite").Database }).$client;
  if (!db.query("SELECT id FROM agents WHERE id=?").get(agentId))
    fail("AGENT_NOT_FOUND", "Agent 不存在", 404);
  const args: (string | number)[] = [DEFAULT_USER_ID];
  const owned = "m.agent_id=?";
  const received =
    "m.agent_id<>? AND EXISTS(SELECT 1 FROM memory_read_grants g WHERE g.memory_id=m.id AND g.agent_id=?) AND m.visibility='public'";
  const conditions = ["m.user_id=?"];
  if (query.view === "received") {
    conditions.push(`(${received})`);
    args.push(agentId, agentId);
  } else if (query.view === "all") {
    conditions.push(`(${owned} OR (${received}))`);
    args.push(agentId, agentId, agentId);
  } else {
    conditions.push(owned);
    args.push(agentId);
  }
  if (query.scope_key !== undefined) {
    conditions.push("m.scope_key=?");
    args.push(query.scope_key);
  }
  if (query.status !== undefined) {
    conditions.push("m.status=?");
    args.push(query.status);
  }
  if (query.visibility === "unclassified") conditions.push("m.visibility IS NULL");
  else if (query.visibility !== undefined) {
    conditions.push("m.visibility=?");
    args.push(query.visibility);
  }
  if (query.origin_conversation_id) {
    conditions.push(`(EXISTS(SELECT 1 FROM memory_sources ms JOIN turns t ON t.id=ms.turn_id
      JOIN conversations c ON c.channel='web' AND c.source_id=t.session_id AND c.agent_id=m.agent_id AND c.user_id=m.user_id
      WHERE ms.memory_id=m.id AND c.id=?) OR EXISTS(SELECT 1 FROM qq_memory_sources qs
      JOIN conversation_events ce ON ce.source_kind='qq_event' AND ce.source_id=qs.event_key
      WHERE qs.memory_id=m.id AND ce.conversation_id=?))`);
    args.push(query.origin_conversation_id, query.origin_conversation_id);
  }
  if (memoryId) {
    conditions.push("m.id=?");
    args.push(memoryId);
  }
  const where = conditions.join(" AND ");
  type PageRow = Pick<
    typeof schema.memoryEntries.$inferSelect,
    | "id"
    | "agentId"
    | "userId"
    | "name"
    | "summary"
    | "tags"
    | "kinds"
    | "status"
    | "scope"
    | "scopeKey"
    | "createdAt"
    | "visibility"
    | "visibilityRevision"
  >;
  const columns = `m.id,m.agent_id AS agentId,m.user_id AS userId,m.name,m.summary,m.tags,m.kinds,m.status,
    m.scope,m.scope_key AS scopeKey,m.created_at AS createdAt,m.visibility,m.visibility_revision AS visibilityRevision`;
  let total: number;
  let rows: PageRow[];
  if (!query.search) {
    total = (
      db.query(`SELECT count(*) AS total FROM memory_entries m WHERE ${where}`).get(...args) as {
        total: number;
      }
    ).total;
    rows = db
      .query(
        `SELECT ${columns} FROM memory_entries m WHERE ${where} ORDER BY m.created_at DESC,m.id LIMIT ? OFFSET ?`,
      )
      .all(...args, query.limit ?? 100, query.offset ?? 0) as PageRow[];
  } else {
    // Preserve JavaScript locale folding and the exact historical four-field string.
    // Search still scans the eligible range; only one batch and the requested metadata page are retained.
    const needle = query.search.trim().toLocaleLowerCase();
    const page: PageRow[] = [];
    let count = 0;
    let after: { createdAt: string; id: string } | undefined;
    for (;;) {
      const continuation = after ? " AND (m.created_at<? OR (m.created_at=? AND m.id>?))" : "";
      const batch = db
        .query(`SELECT ${columns},m.body FROM memory_entries m WHERE ${where}${continuation}
        ORDER BY m.created_at DESC,m.id LIMIT 200`)
        .all(
          ...args,
          ...(after ? [after.createdAt, after.createdAt, after.id] : []),
        ) as (PageRow & { body: string })[];
      for (const row of batch) {
        if (
          `${row.name}\n${row.summary}\n${row.body}\n${row.tags}`
            .toLocaleLowerCase()
            .includes(needle)
        ) {
          if (count >= (query.offset ?? 0) && page.length < (query.limit ?? 100)) {
            const { body: _body, ...metadata } = row;
            page.push(metadata);
          }
          count++;
        }
      }
      if (batch.length < 200) break;
      after = batch[batch.length - 1]!;
    }
    total = count;
    rows = page;
  }
  const metadata = memoryAccessMetadataBatch(orm, rows);
  let access: ReturnType<typeof memoryConversationAccess> = null;
  if (query.conversation_id) {
    access = memoryConversationAccess(orm, query.conversation_id, agentId, DEFAULT_USER_ID);
    if (!access) fail("CONTEXT_SOURCE_INVALID", "会话记忆权限已变化");
  }
  const refs = access
    ? memoryAccessRefs(
        orm,
        access,
        rows.map((row) => row.id),
      )
    : null;
  return {
    total,
    items: rows.map((row) => ({
      id: row.id,
      owner_agent_id: row.agentId,
      name: row.name,
      summary: row.summary,
      tags: JSON.parse(row.tags),
      kinds: JSON.parse(row.kinds),
      status: row.status as MemoryManagementList["items"][number]["status"],
      scope: row.scope,
      scope_key: row.scopeKey,
      created_at: row.createdAt,
      ...metadata.get(row.id)!,
      runtime_eligibility:
        refs === null ? "unknown" : refs.has(row.id) ? "available" : "unavailable",
      raw_preview: "unknown",
    })),
  };
}

export function memoryManagementMetadata(
  orm: Orm,
  agentId: string,
  memoryId: string,
  conversationId?: string,
): MemoryAccessMetadata {
  const page = memoryManagementPage(
    orm,
    agentId,
    { view: "all", limit: 1, ...(conversationId ? { conversation_id: conversationId } : {}) },
    memoryId,
  );
  const row = page.items.find((item) => item.id === memoryId);
  if (!row) fail("MEMORY_NOT_FOUND", "记忆不存在或不属于当前 Agent", 404);
  const {
    visibility,
    visibility_revision,
    recipient_agent_ids,
    origins,
    origin_complete,
    source_validity,
    runtime_eligibility,
    raw_preview,
  } = row;
  return {
    visibility,
    visibility_revision,
    recipient_agent_ids,
    origins,
    origin_complete,
    source_validity,
    runtime_eligibility,
    raw_preview,
  };
}

type MemoryRow = typeof schema.memoryEntries.$inferSelect;
interface PreviewOptions {
  conversationId?: string;
  signal: AbortSignal;
  includeShared: boolean;
}
/** Resolves discovery only. A received row still needs canonical read qualification. */
function discoverMemory(orm: Orm, agentId: string, id: string): MemoryRow {
  const db = (orm as Orm & { $client: import("bun:sqlite").Database }).$client;
  const identity = db
    .query("SELECT agent_id AS agentId,visibility FROM memory_entries WHERE id=? AND user_id=?")
    .get(id, DEFAULT_USER_ID) as { agentId: string; visibility: string | null } | null;
  if (!identity) fail("MEMORY_NOT_FOUND", "记忆不存在或不可访问", 404);
  if (identity.agentId !== agentId) {
    const grant = db
      .query("SELECT 1 FROM memory_read_grants WHERE memory_id=? AND agent_id=?")
      .get(id, agentId);
    if (identity.visibility !== "public" || !grant)
      fail("MEMORY_NOT_FOUND", "记忆不存在或不可访问", 404);
  }
  const row = orm
    .select()
    .from(schema.memoryEntries)
    .where(
      and(
        eq(schema.memoryEntries.id, id),
        eq(schema.memoryEntries.userId, DEFAULT_USER_ID),
        sql`length(CAST(${schema.memoryEntries.body} AS BLOB))<=64000`,
        sql`length(CAST(${schema.memoryEntries.configSnapshot} AS BLOB))<=262144`,
      ),
    )
    .get();
  if (!row || row.body.length > 16000) fail("CONTEXT_SOURCE_INVALID", "记忆内容过大或已变化");
  return row;
}
function readableMemory(orm: Orm, agentId: string, id: string, options: PreviewOptions) {
  options.signal.throwIfAborted();
  const row = discoverMemory(orm, agentId, id);
  if (!options.conversationId) fail("CONTEXT_INVALID_SELECTION", "请明确选择使用记忆的会话");
  const access = memoryConversationAccess(orm, options.conversationId, agentId, DEFAULT_USER_ID);
  if (!access) fail("CONTEXT_SOURCE_INVALID", "会话记忆权限已变化");
  const found = scanMemoryCandidates(orm, agentId, null, { id, limit: 1, access }).items[0];
  if (!found?.accessRef) fail("CONTEXT_SOURCE_INVALID", "当前会话无权读取这条记忆");
  if (typeof found.item.body !== "string") fail("CONTEXT_SOURCE_INVALID", "记忆正文未加载");
  return { row, ref: found.accessRef, body: found.item.body };
}
export function memoryReadablePage(
  orm: Orm,
  agentId: string,
  id: string,
  options: PreviewOptions & { offset: number; limit: number; revision?: string },
): MemoryReadablePage {
  const current = readableMemory(orm, agentId, id, options);
  if (options.revision && options.revision !== current.ref.revision)
    fail("CONTEXT_SOURCE_INVALID", "记忆读取资格已变化，请重新打开");
  const page = evidenceTextPage(current.body, options);
  const after = readableMemory(orm, agentId, id, options);
  if (after.ref.revision !== current.ref.revision) fail("CONTEXT_SOURCE_INVALID", "记忆已变化");
  options.signal.throwIfAborted();
  return {
    id,
    owner_agent_id: current.row.agentId,
    reader_agent_id: agentId,
    conversation_id: options.conversationId!,
    name: current.row.name,
    summary: current.row.summary,
    tags: JSON.parse(current.row.tags),
    content_origin: correctionMetadata(current.row.configSnapshot)
      ? "manual_correction"
      : "derived",
    revision: current.ref.revision,
    ...page,
  };
}
function previewEntry(orm: Orm, agentId: string, id: string, options: PreviewOptions) {
  options.signal.throwIfAborted();
  const row = discoverMemory(orm, agentId, id);
  const ref = row.agentId === agentId ? null : readableMemory(orm, agentId, id, options).ref;
  const facts = memorySourceFactAssessment(orm, [row]);
  return {
    row,
    facts,
    revision: bodyRevision(
      JSON.stringify([
        memoryRevision(row),
        row.visibilityRevision,
        ref,
        facts.states.get(id),
        facts.revisions.get(id),
      ]),
    ),
  };
}
function inspectionTarget(target: MemoryPreviewTarget): ConversationSourceTarget | null {
  return target.valid && target.conversationId
    ? {
        conversationId: target.conversationId,
        kind: target.channel === "web" ? "web_message" : "qq_observation",
        id: target.id,
        turnId: target.turnId,
        role: target.role,
      }
    : null;
}
export function memorySourcePreviews(
  orm: Orm,
  agentId: string,
  id: string,
  options: PreviewOptions & { offset: number; limit: number },
): MemorySourcePreviewList {
  const entry = previewEntry(orm, agentId, id, options);
  const state = entry.facts.states.get(id) ?? "unknown";
  const { targets, total } = memoryPreviewTargets(orm, entry.row, options);
  if (options.offset > total) fail("CONTEXT_INVALID_SELECTION", "来源分页越界");
  const db = (orm as Orm & { $client: import("bun:sqlite").Database }).$client;
  const repository = new ConversationEventRepository(db);
  const selected = targets;
  const validTargets = selected.map((target) =>
    state === "invalid" ? null : inspectionTarget(target),
  );
  const inspections = inspectConversationSourcePages(
    db,
    repository,
    { userId: DEFAULT_USER_ID },
    validTargets.filter((target): target is ConversationSourceTarget => target !== null),
    { ...options, offset: 0, limit: 1, now: nowIso() },
  );
  let inspected = 0;
  const items: MemorySourcePreviewList["items"] = selected.map((recordedTarget, index) => {
    const target = validTargets[index];
    options.signal.throwIfAborted();
    const result = target
      ? inspections[inspected++]!
      : {
          state: state === "invalid" ? ("unavailable" as const) : ("unknown" as const),
          reason: state === "invalid" ? "changed" : "unmapped",
        };
    if (result.state !== "available" || !target)
      return {
        source_key: null,
        channel: "unknown",
        state: result.state,
        reason: result.reason,
        conversation_id: null,
        revision: null,
        expires_at: null,
        participant: null,
        occurred_at: null,
      };
    const revision = bodyRevision(JSON.stringify([entry.revision, result.revision]));
    const source_key = sealEvidenceValue({
      memory: id,
      agent: agentId,
      conversation: options.conversationId ?? null,
      entry: entry.revision,
      target: recordedTarget,
      raw: result.revision,
    });
    return {
      source_key,
      channel: target.kind === "web_message" ? "web" : "onebot11",
      state: "available",
      reason: null,
      conversation_id: target.conversationId,
      revision,
      expires_at: result.expiresAt,
      participant: result.participant,
      occurred_at: result.occurredAt,
    };
  });
  if (previewEntry(orm, agentId, id, options).revision !== entry.revision)
    fail("CONTEXT_SOURCE_INVALID", "记忆资格已变化");
  const deliveryNow = Date.now();
  for (const item of items)
    if (item.expires_at && Date.parse(item.expires_at) <= deliveryNow) {
      Object.assign(item, {
        state: "unavailable",
        reason: "expired",
        source_key: null,
        revision: null,
        conversation_id: null,
        participant: null,
        occurred_at: null,
      });
    }
  const checked = options.offset + selected.length;
  const complete = options.offset === 0 && checked === total;
  return {
    memory_id: id,
    entry_revision: entry.revision,
    source_validity: state,
    raw_preview:
      state === "invalid"
        ? "unavailable"
        : items.some((item) => item.state === "unavailable")
          ? "unavailable"
          : state === "valid" &&
              complete &&
              total > 0 &&
              items.every((item) => item.state === "available")
            ? "available"
            : "unknown",
    total,
    checked_sources: selected.length,
    nextOffset: checked < total ? checked : null,
    items,
  };
}
export function memorySourcePreviewPage(
  orm: Orm,
  agentId: string,
  id: string,
  options: PreviewOptions & { sourceKey: string; revision: string; offset: number; limit: number },
): MemorySourcePreviewPage {
  const entry = previewEntry(orm, agentId, id, options);
  const value = openEvidenceValue(options.sourceKey) as {
    memory?: unknown;
    agent?: unknown;
    conversation?: unknown;
    entry?: unknown;
    target?: MemoryPreviewTarget;
    raw?: string;
  } | null;
  if (
    !value ||
    value.memory !== id ||
    value.agent !== agentId ||
    value.entry !== entry.revision ||
    value.conversation !== (options.conversationId ?? null) ||
    !value.target ||
    typeof value.raw !== "string"
  )
    fail("CONTEXT_SOURCE_INVALID", "来源引用已失效，请重新检查来源");
  if (entry.facts.states.get(id) !== "valid") fail("CONTEXT_SOURCE_INVALID", "来源事实已变化");
  const exact = memoryPreviewTargets(orm, entry.row, { target: value.target });
  const currentTarget = exact.targets.length === 1 ? exact.targets[0]! : null;
  const target = currentTarget ? inspectionTarget(currentTarget) : null;
  if (!target || JSON.stringify(currentTarget) !== JSON.stringify(value.target))
    fail("CONTEXT_SOURCE_INVALID", "来源关系已变化");
  const db = (orm as Orm & { $client: import("bun:sqlite").Database }).$client;
  const page = inspectConversationSourcePage(
    db,
    new ConversationEventRepository(db),
    { userId: DEFAULT_USER_ID },
    target,
    { ...options, now: nowIso(), expectedRevision: value.raw },
  );
  if (
    page.state !== "available" ||
    bodyRevision(JSON.stringify([entry.revision, page.revision])) !== options.revision
  )
    fail("CONTEXT_SOURCE_INVALID", "来源已到期、变化或无权查看");
  if (previewEntry(orm, agentId, id, options).revision !== entry.revision)
    fail("CONTEXT_SOURCE_INVALID", "记忆资格已变化");
  options.signal.throwIfAborted();
  if (page.expiresAt && Date.parse(page.expiresAt) <= Date.now())
    fail("CONTEXT_SOURCE_INVALID", "来源正文已到期");
  return {
    memory_id: id,
    source_key: options.sourceKey,
    conversation_id: page.conversationId,
    revision: options.revision,
    expires_at: page.expiresAt,
    content_origin: "original",
    corrected:
      correctionMetadata(entry.row.configSnapshot) !== null ||
      !!db
        .query(`SELECT 1 FROM memory_entries
      WHERE user_id=? AND agent_id=? AND json_valid(config_snapshot)
      AND json_extract(config_snapshot,'$.content_correction.replaces')=? LIMIT 1`)
        .get(DEFAULT_USER_ID, entry.row.agentId, id),
    text: page.text,
    offset: page.offset,
    total: page.total,
    nextOffset: page.nextOffset,
  };
}

/** Historical storage labels remain technical metadata, never runtime read grants. */
export function memoryManagementScopes(orm: Orm, agentId: string): MemoryScopeView[] {
  const db = (orm as Orm & { $client: import("bun:sqlite").Database }).$client;
  if (
    db
      .query(
        "SELECT 1 FROM memory_jobs WHERE agent_id=? AND user_id=? AND NOT json_valid(config_snapshot) LIMIT 1",
      )
      .get(agentId, DEFAULT_USER_ID)
  )
    fail("INVALID_SESSION_CONFIG", "记忆任务快照无效");
  const counts = db
    .query(`SELECT scope_key,count(*) AS count,sum(status='active') AS active_count FROM memory_entries
    WHERE agent_id=? AND user_id=? GROUP BY scope_key`)
    .all(agentId, DEFAULT_USER_ID) as { scope_key: string; count: number; active_count: number }[];
  const byScope = new Map(counts.map((row) => [row.scope_key, row]));
  const jobs = db
    .query(`SELECT id,kind,session_id,status,result_id,error_code,created_at,finished_at,
    json_extract(config_snapshot,'$.scope_key') AS scope_key FROM (
      SELECT *,row_number() OVER(PARTITION BY json_extract(config_snapshot,'$.scope_key') ORDER BY created_at DESC,id) AS position
      FROM memory_jobs WHERE agent_id=? AND user_id=? AND json_valid(config_snapshot)
    ) WHERE position=1`)
    .all(agentId, DEFAULT_USER_ID) as Array<{
    id: string;
    kind: string;
    session_id: string | null;
    status: "queued" | "running" | "succeeded" | "failed";
    result_id: string | null;
    error_code: string | null;
    created_at: string;
    finished_at: string | null;
    scope_key: string;
  }>;
  const latest = new Map(jobs.map((job) => [job.scope_key, job]));
  const bindings = readQqBindings(orm).filter((binding) => binding.agentId === agentId);
  const byBinding = new Map(
    bindings.map((binding) => [qqMemoryScopeKey(qqConversationScope(binding)), binding]),
  );
  const settings = readQqSettings(orm),
    owner = readQqOwnerIdentity(orm);
  const pending = db
    .query(`SELECT e.account_id,e.conversation_kind,e.peer_id,count(*) AS total
    FROM qq_events e JOIN qq_observation_text t ON t.event_key=e.event_key
    LEFT JOIN qq_processed_events p ON p.event_key=e.event_key
    WHERE e.agent_id=? AND t.expires_at>? AND p.event_key IS NULL
    GROUP BY e.account_id,e.conversation_kind,e.peer_id`)
    .all(agentId, nowIso()) as {
    account_id: string;
    conversation_kind: string;
    peer_id: string;
    total: number;
  }[];
  const pendingByKey = new Map(
    pending.map((row) => [
      JSON.stringify([row.account_id, row.conversation_kind, row.peer_id]),
      row.total,
    ]),
  );
  return [...new Set([agentId, ...byScope.keys(), ...byBinding.keys(), ...latest.keys()])].map(
    (key) => {
      const count = byScope.get(key),
        binding = byBinding.get(key),
        job = latest.get(key);
      const access = binding ? resolveQqMemoryAccess(binding, owner) : null;
      return {
        scope_key: key,
        count: count?.count ?? 0,
        active_count: count?.active_count ?? 0,
        read_scope_keys: null,
        write_scope_key:
          access?.kind === "resolved" ? qqMemoryScopeKey(access.access.writeScope) : key,
        pending: binding
          ? (pendingByKey.get(JSON.stringify([binding.accountId, binding.kind, binding.peerId])) ??
            0)
          : null,
        binding: binding
          ? {
              id: binding.id,
              revision: binding.revision,
              memory_batch_size: binding.memoryBatchSize,
              paused: binding.paused,
              enabled: settings.enabled === 1 && settings.accountId === binding.accountId,
            }
          : null,
        latest_job: job
          ? {
              id: job.id,
              kind: job.kind,
              session_id: job.session_id,
              status: job.status,
              result_id: job.result_id,
              error_code: job.error_code,
              created_at: job.created_at,
              finished_at: job.finished_at,
            }
          : null,
      };
    },
  );
}
