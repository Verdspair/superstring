// Agent-scoped memory persistence — 1:1 with `db/memory_repository.py`.
//
// Ownership model (do not "fix")
// Memory belongs to the **Agent**, not to a session. `scope` / `scope_key` are
// retained as historical labels so the original isolation architecture can be
// reinstated later without a data migration, but today every scope keys to the
// owning Agent (`services/memory_contract.py:118-126`). Recall is deliberately
// NOT narrowed by `scope`.
//
// Transactions
// The source explicitly says "callers own transactions; all mutations lock
// Agent first" (memory_repository.py:1). Row locks (`with_for_update`) do not
// exist in SQLite, so every mutating entry point here is expected to be called
// inside `immediate()`, which takes the database write lock up front. The route
// layer does exactly that.

import { and, asc, desc, eq, inArray, notExists, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { AppError, fail } from "../errors";
import {
  DEFAULT_SCOPE,
  type MemoryDraft,
  scopeKey,
  TEMPLATE_VERSION,
} from "../services/memory-contract";
import {
  correctionMetadata,
  correctionSnapshot,
  isCorrectionRetired,
} from "../services/memory-revision";
import { readOrganizationSettings } from "./organization-repository";
import {
  DEFAULT_USER_ID,
  getAgent,
  newId,
  nowIso,
  nowIsoPlusSeconds,
  type Orm,
} from "./repositories";
import * as schema from "./schema";

export type MemoryPolicyRow = typeof schema.memoryPolicies.$inferSelect;
export type MemoryEntryRow = typeof schema.memoryEntries.$inferSelect;
export type MemoryJobRow = typeof schema.memoryJobs.$inferSelect;

/** The `(turn, user, assistant)` triple every memory read is built from. */
export interface TurnTriple {
  turn: typeof schema.turns.$inferSelect;
  user: typeof schema.messages.$inferSelect;
  assistant: typeof schema.messages.$inferSelect;
}

/** memory_repository.py:19-20 — local `fail` helper, default status **409**. */
export { fail };

// Policy

/**
 * memory_repository.py:23-41.
 *
 * The source passes `lock=True` to take `SELECT … FOR UPDATE` on the Agent row
 * twice (once for the read, again before creating the policy) so a concurrent
 * first-touch cannot create two policies. SQLite has no row locks: the route
 * layer wraps every memory mutation in `BEGIN IMMEDIATE`, which holds the
 * database write lock for the whole read-modify-write, so the mutual exclusion
 * is preserved without a per-call flag.
 *
 * The `MEMORY_FORBIDDEN` check is on the *stored* `user_id`, which only differs
 * from the default in a multi-user database.
 */
export function policy(orm: Orm, agentId: string): MemoryPolicyRow {
  getAgent(orm, agentId);

  const read = () =>
    orm
      .select()
      .from(schema.memoryPolicies)
      .where(eq(schema.memoryPolicies.agentId, agentId))
      .get();

  let item = read();
  if (!item) {
    // Creation also re-reads the Agent, including on a plain GET (the source
    // does the same so a first-touch GET still validates ownership).
    getAgent(orm, agentId);
    item = read();
    if (!item) {
      orm
        .insert(schema.memoryPolicies)
        .values({
          agentId,
          userId: DEFAULT_USER_ID,
          autoEnabled: 0,
          everyTurns: 20,
          targetChars: 1200,
          version: 1,
          governanceEpoch: 0,
        })
        .run();
      item = read();
      // Unreachable unless the write itself failed; reported as a storage fault
      // rather than an invented error code.
      if (!item) throw new AppError("DATABASE_UNAVAILABLE", "数据服务暂不可用，请检查数据库", 503);
    }
  }
  if (item.userId !== DEFAULT_USER_ID) {
    fail("MEMORY_FORBIDDEN", "无权访问此 Agent 记忆", 403);
  }
  return item;
}

/** memory_repository.py:44-50. */
export function ownedSession(
  orm: Orm,
  agentId: string,
  sessionId: string,
): typeof schema.sessions.$inferSelect {
  const item = orm
    .select()
    .from(schema.sessions)
    .where(
      and(
        eq(schema.sessions.id, sessionId),
        eq(schema.sessions.agentId, agentId),
        eq(schema.sessions.userId, DEFAULT_USER_ID),
      ),
    )
    .get();
  if (!item) {
    fail("MEMORY_SOURCE_FORBIDDEN", "来源会话不存在或不属于当前 Agent", 404);
  }
  return item;
}

/**
 * memory_repository.py:53-61 — a legacy per-session label kept for API
 * compatibility. It no longer narrows recall; it is still returned so the
 * published contract shape stays intact.
 */
export function sessionScope(orm: Orm, agentId: string, sessionId: string): string {
  ownedSession(orm, agentId, sessionId);
  const state = orm
    .select()
    .from(schema.memorySessionStates)
    .where(eq(schema.memorySessionStates.sessionId, sessionId))
    .get();
  return state ? state.scope : DEFAULT_SCOPE;
}

/** memory_repository.py:64-78. Bumps the governance epoch. */
export function setScope(orm: Orm, agentId: string, sessionId: string, scope: string): void {
  const p = policy(orm, agentId);
  ownedSession(orm, agentId, sessionId);
  const item = orm
    .select()
    .from(schema.memorySessionStates)
    .where(eq(schema.memorySessionStates.sessionId, sessionId))
    .get();
  if (!item) {
    orm.insert(schema.memorySessionStates).values({ sessionId, scope }).run();
  } else {
    orm
      .update(schema.memorySessionStates)
      .set({ scope })
      .where(eq(schema.memorySessionStates.sessionId, sessionId))
      .run();
  }
  orm
    .update(schema.memoryPolicies)
    .set({ governanceEpoch: p.governanceEpoch + 1 })
    .where(eq(schema.memoryPolicies.agentId, agentId))
    .run();
}

// Turn sources

/**
 * memory_repository.py:81-102 — only **valid, completed, paired** turns count as
 * memory sources. A turn qualifies when:
 *   - it is still `source_valid` AND `context_valid`,
 *   - its generation completed, and
 *   - BOTH its user and assistant messages are `completed`.
 *
 * `recent` switches the ordering to newest-first (and limits); otherwise the
 * result is oldest-first. `ids` additionally asserts that *every* requested turn
 * resolved, so a partially-valid selection is rejected as a whole rather than
 * silently processing fewer turns than the user picked.
 */
export function turns(
  orm: Orm,
  agentId: string,
  sessionId: string | null,
  options: { ids?: string[]; recent?: number; unprocessed?: boolean } = {},
): TurnTriple[] {
  if (sessionId === null) {
    // Only merge jobs reach here, and they never call `turns`.
    fail("MEMORY_SOURCE_FORBIDDEN", "来源会话不存在或不属于当前 Agent", 404);
  }
  ownedSession(orm, agentId, sessionId);

  const user = alias(schema.messages, "u");
  const assistant = alias(schema.messages, "a");
  const conditions = [
    eq(schema.turns.sessionId, sessionId),
    eq(schema.turns.sourceValid, 1),
    eq(schema.turns.contextValid, 1),
    eq(schema.turns.generationStatus, "completed"),
    eq(user.role, "user"),
    eq(user.status, "completed"),
    eq(assistant.role, "assistant"),
    eq(assistant.status, "completed"),
  ];
  if (options.ids !== undefined) {
    conditions.push(inArray(schema.turns.id, options.ids));
  }
  if (options.unprocessed) {
    conditions.push(
      notExists(
        orm
          .select()
          .from(schema.memoryProcessedTurns)
          .where(eq(schema.memoryProcessedTurns.turnId, schema.turns.id)),
      ),
    );
  }

  const orderBy = options.recent ? desc(user.sequenceNo) : asc(user.sequenceNo);
  let query = orm
    .select({ turn: schema.turns, user, assistant })
    .from(schema.turns)
    .innerJoin(user, and(eq(user.turnId, schema.turns.id), eq(user.role, "user")))
    .innerJoin(
      assistant,
      and(eq(assistant.turnId, schema.turns.id), eq(assistant.role, "assistant")),
    )
    .where(and(...conditions))
    .orderBy(orderBy);

  if (options.recent) query = query.limit(options.recent) as typeof query;

  const rows = query.all() as TurnTriple[];

  if (options.ids !== undefined) {
    const found = new Set(rows.map((r) => r.turn.id));
    const requested = new Set(options.ids);
    if (found.size !== requested.size || [...requested].some((id) => !found.has(id))) {
      fail("MEMORY_SOURCE_INVALID", "所选轮次已失效、未完成或不属于该会话");
    }
  }
  return rows;
}

/** memory_repository.py:105-108. */
export function sourceData(rows: TurnTriple[]): Array<Record<string, unknown>> {
  return rows.map(({ turn, user, assistant }) => ({
    turn_id: turn.id,
    sequence_no: user.sequenceNo,
    user_message_id: user.id,
    assistant_message_id: assistant.id,
    user: user.content,
    assistant: assistant.content,
  }));
}

// Entries

/**
 * memory_repository.py:111-122. `ids` asserts full resolution (MEMORY_NOT_FOUND
 * 404) so a caller can never act on a subset of what it thinks it selected.
 */
export function entries(
  orm: Orm,
  agentId: string,
  ids?: string[],
  options: { status?: string } = {},
): MemoryEntryRow[] {
  policy(orm, agentId);
  const conditions = [
    eq(schema.memoryEntries.agentId, agentId),
    eq(schema.memoryEntries.userId, DEFAULT_USER_ID),
  ];
  if (ids !== undefined) conditions.push(inArray(schema.memoryEntries.id, ids));
  if (options.status) conditions.push(eq(schema.memoryEntries.status, options.status));

  const items = orm
    .select()
    .from(schema.memoryEntries)
    .where(and(...conditions))
    .orderBy(desc(schema.memoryEntries.createdAt), asc(schema.memoryEntries.id))
    .all();

  if (ids !== undefined) {
    const found = new Set(items.map((i) => i.id));
    if (found.size !== new Set(ids).size || ids.some((id) => !found.has(id))) {
      fail("MEMORY_NOT_FOUND", "记忆不存在或不属于当前 Agent", 404);
    }
  }
  return items;
}

/**
 * memory_repository.py:125-138 — a memory is only reusable while EVERY one of
 * its source turns is still intact. Note this checks `source_valid` and the
 * generation status but deliberately not `context_valid`: a turn that merely
 * scrolled out of the context window has not lost its meaning as a source.
 */
export function validateEntrySources(
  orm: Orm,
  items: MemoryEntryRow[],
): Array<typeof schema.memorySources.$inferSelect> {
  if (items.length === 0) return [];
  const ids = items.map((i) => i.id);
  const sources = orm
    .select()
    .from(schema.memorySources)
    .where(inArray(schema.memorySources.memoryId, ids))
    .all();

  if (new Set(sources.map((s) => s.memoryId)).size !== new Set(ids).size) {
    fail("MEMORY_SOURCE_INVALID", "记忆来源缺失，不能重新启用或整合");
  }

  for (const s of sources) {
    const t = orm.select().from(schema.turns).where(eq(schema.turns.id, s.turnId)).get();
    const u = orm
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, s.userMessageId))
      .get();
    const a = orm
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.id, s.assistantMessageId))
      .get();
    const intact =
      t !== undefined &&
      t.sourceValid === 1 &&
      t.generationStatus === "completed" &&
      u !== undefined &&
      a !== undefined &&
      u.turnId === t.id &&
      a.turnId === t.id &&
      u.status === "completed" &&
      a.status === "completed";
    if (!intact) {
      fail("MEMORY_SOURCE_INVALID", "记忆来源已失效");
    }
  }
  return sources;
}

// Jobs

export interface EnqueueArgs {
  /**
   * `auto` is written by the worker's scheduler (`memory_service.py:101-102`),
   * never by a route. `memory_jobs.kind` is a plain `String(16)` in the source
   * with no CHECK constraint, so the set is open-ended and `publish` decides
   * turn-based vs merge behaviour by comparing against `"merge"`.
   */
  kind: "auto" | "manual" | "merge";
  sessionId?: string | null;
  turnIds?: string[];
  memoryIds?: string[];
}

/**
 * memory_repository.py:141-184.
 *
 * Three guard rails, in this order:
 *   1. `request_key` replay — same key + same payload returns the SAME job
 *      (idempotent), same key + different payload is `MEMORY_REQUEST_CONFLICT`.
 *   2. Only one active (queued/running) job per Agent → `MEMORY_BUSY`.
 *   3. A disabled Agent cannot enqueue → `AGENT_DISABLED`.
 *
 * `config_snapshot` freezes everything the worker will need, including the
 * policy version and `governance_epoch`, so a later governance change can
 * invalidate the job instead of letting it publish against moved facts.
 */
export function enqueue(
  orm: Orm,
  agentId: string,
  requestKey: string,
  args: EnqueueArgs,
): MemoryJobRow {
  const p = policy(orm, agentId);
  const kind = args.kind;
  const sessionId = args.sessionId ?? null;
  const turnIds = args.turnIds ?? [];
  const memoryIds = args.memoryIds ?? [];

  const existing = orm
    .select()
    .from(schema.memoryJobs)
    .where(
      and(
        eq(schema.memoryJobs.agentId, agentId),
        eq(schema.memoryJobs.userId, DEFAULT_USER_ID),
        eq(schema.memoryJobs.requestKey, requestKey),
      ),
    )
    .get();
  if (existing) {
    const sameSet = (stored: string, incoming: string[]): boolean => {
      const a = new Set(JSON.parse(stored) as string[]);
      return a.size === new Set(incoming).size && incoming.every((x) => a.has(x));
    };
    if (
      existing.kind !== kind ||
      existing.sessionId !== sessionId ||
      !sameSet(existing.turnIds, turnIds) ||
      !sameSet(existing.memoryIds, memoryIds)
    ) {
      fail("MEMORY_REQUEST_CONFLICT", "请求键已用于不同整理内容");
    }
    return existing;
  }

  const active = orm
    .select({ id: schema.memoryJobs.id })
    .from(schema.memoryJobs)
    .where(
      and(
        eq(schema.memoryJobs.agentId, agentId),
        inArray(schema.memoryJobs.status, ["queued", "running"]),
      ),
    )
    .limit(1)
    .get();
  if (active) {
    fail("MEMORY_BUSY", "该 Agent 已有整理任务，请等待完成");
  }

  const agent = getAgent(orm, agentId);
  if (agent.isActive !== 1) {
    fail("AGENT_DISABLED", "Agent 已停用");
  }

  let scope: string;
  let key: string;
  let selected: MemoryEntryRow[] = [];
  if (kind === "merge") {
    selected = entries(orm, agentId, [...memoryIds]);
    if (selected.some((i) => i.status !== "active")) {
      fail("MEMORY_STATE_CONFLICT", "只能整合有效记忆");
    }
    validateEntrySources(orm, selected);
    // 记忆统一归属 Agent，同一 Agent 的记忆都可整合；scope 仅作为历史标签保留。
    scope = selected[0].scope;
    key = agentId;
  } else {
    turns(orm, agentId, sessionId, { ids: turnIds });
    scope = sessionScope(orm, agentId, sessionId as string);
    key = scopeKey(scope, sessionId as string, agentId);
  }

  const snapshot = {
    model:
      agent.memoryConsolidationModelName ||
      readOrganizationSettings(orm).model_name ||
      agent.modelName,
    base_prompt: agent.memoryConsolidationPrompt,
    additional: agent.memoryConsolidationAdditionalInstructions,
    target_chars: p.targetChars,
    agent_config_version: agent.configVersion,
    policy_version: p.version,
    template_version: TEMPLATE_VERSION,
    scope,
    scope_key: key,
  };

  const result = orm
    .insert(schema.memoryJobs)
    .values({
      id: newId(),
      agentId,
      userId: DEFAULT_USER_ID,
      requestKey,
      kind,
      sessionId,
      turnIds: JSON.stringify([...turnIds].sort()),
      memoryIds: JSON.stringify([...memoryIds].sort()),
      configSnapshot: JSON.stringify(snapshot),
      governanceEpoch: p.governanceEpoch,
      status: "queued",
      createdAt: nowIso(),
    })
    .returning()
    .get();
  // Unreachable unless the write itself failed (see `policy` above).
  if (!result) throw new AppError("DATABASE_UNAVAILABLE", "数据服务暂不可用，请检查数据库", 503);
  return result;
}

/** memory_repository.py:187-194. */
export function jobOwned(orm: Orm, agentId: string, jobId: string): MemoryJobRow {
  policy(orm, agentId);
  const job = orm
    .select()
    .from(schema.memoryJobs)
    .where(
      and(
        eq(schema.memoryJobs.id, jobId),
        eq(schema.memoryJobs.agentId, agentId),
        eq(schema.memoryJobs.userId, DEFAULT_USER_ID),
      ),
    )
    .get();
  if (!job) {
    fail("MEMORY_JOB_NOT_FOUND", "整理任务不存在", 404);
  }
  return job;
}

/**
 * memory_repository.py:197-221.
 *
 * Order matters: the source guard ("can this memory be re-enabled?") runs
 * BEFORE `governance_epoch` is bumped, so a rejected `enable` leaves the epoch
 * untouched. Queued/in-flight jobs are failed *before* the facts they read are
 * changed, which is what makes `MEMORY_GOVERNANCE_CHANGED` meaningful.
 */
export function govern(orm: Orm, agentId: string, ids: string[], action: string): void {
  const p = policy(orm, agentId);
  const selected = entries(orm, agentId, ids);

  if (action === "enable") {
    if (selected.some((i) => isCorrectionRetired(i.configSnapshot))) {
      fail("MEMORY_STATE_CONFLICT", "已被纠正的旧记忆及其派生内容不能重新启用");
    }
    if (selected.some((i) => i.status === "invalid")) {
      fail("MEMORY_SOURCE_INVALID", "来源已失效的记忆不能重新启用");
    }
    validateEntrySources(orm, selected);
  }

  orm
    .update(schema.memoryPolicies)
    .set({ governanceEpoch: p.governanceEpoch + 1 })
    .where(eq(schema.memoryPolicies.agentId, agentId))
    .run();

  // Invalidate queued/in-flight jobs before changing the facts they read.
  orm
    .update(schema.memoryJobs)
    .set({
      status: "failed",
      errorCode: "MEMORY_GOVERNANCE_CHANGED",
      token: null,
      leaseExpiresAt: null,
      finishedAt: nowIso(),
    })
    .where(
      and(
        eq(schema.memoryJobs.agentId, agentId),
        inArray(schema.memoryJobs.status, ["queued", "running"]),
      ),
    )
    .run();

  if (action === "purge") {
    const jobs = orm
      .select()
      .from(schema.memoryJobs)
      .where(eq(schema.memoryJobs.agentId, agentId))
      .all();
    for (const job of jobs) {
      const jobMemoryIds = JSON.parse(job.memoryIds) as string[];
      if (
        (job.resultId !== null && ids.includes(job.resultId)) ||
        jobMemoryIds.some((m) => ids.includes(m))
      ) {
        orm.delete(schema.memoryJobs).where(eq(schema.memoryJobs.id, job.id)).run();
      }
    }
    for (const item of selected) {
      orm.delete(schema.memoryEntries).where(eq(schema.memoryEntries.id, item.id)).run();
    }
    // FK CASCADE removes only links/sources, never child memory rows.
  } else {
    const next = action === "enable" ? "active" : "suppressed";
    for (const item of selected) {
      orm
        .update(schema.memoryEntries)
        .set({ status: next })
        .where(eq(schema.memoryEntries.id, item.id))
        .run();
    }
  }
}

/**
 * memory_repository.py:240-254 — worker claim. Returns `null` for a job that is
 * not claimable (missing, already taken, or governance moved on). The
 * governance check **fails the job** as a side effect rather than silently
 * dropping it.
 */
export function claim(orm: Orm, jobId: string): MemoryJobRow | null {
  const hint = orm.select().from(schema.memoryJobs).where(eq(schema.memoryJobs.id, jobId)).get();
  if (!hint) return null;
  const p = policy(orm, hint.agentId);
  const job = jobOwned(orm, hint.agentId, jobId);
  if (job.status !== "queued") return null;
  if (job.governanceEpoch !== p.governanceEpoch) {
    updateJobRow(orm, job.id, {
      status: "failed",
      errorCode: "MEMORY_GOVERNANCE_CHANGED",
      finishedAt: nowIso(),
    });
    return null;
  }
  return updateJobRow(orm, job.id, {
    status: "running",
    token: newId(),
    leaseExpiresAt: nowIsoPlusSeconds(60),
  });
}

/** memory_repository.py:257-263. */
export function ownedRunning(
  orm: Orm,
  agentId: string,
  jobId: string,
  token: string,
): MemoryJobRow {
  const p = policy(orm, agentId);
  const job = jobOwned(orm, agentId, jobId);
  if (
    job.status !== "running" ||
    job.token !== token ||
    job.leaseExpiresAt === null ||
    new Date(job.leaseExpiresAt).getTime() <= Date.now() ||
    job.governanceEpoch !== p.governanceEpoch
  ) {
    fail("MEMORY_JOB_OWNERSHIP_LOST", "整理任务已过期或来源已变化");
  }
  return job;
}

/**
 * The DB half of the worker heartbeat (`memory_service.py:107-113`).
 *
 * Ownership is re-checked on every beat, so a job that lost its lease (or whose
 * `governance_epoch` moved) makes the heartbeat itself throw — the running
 * generation then aborts and can never publish against moved facts. The source
 * extends the lease by a flat 60s each beat while beating every 15s.
 */
export function renewLease(orm: Orm, agentId: string, jobId: string, token: string): void {
  ownedRunning(orm, agentId, jobId, token);
  updateJobRow(orm, jobId, { leaseExpiresAt: nowIsoPlusSeconds(60) });
}

/**
 * The draft type is owned by the contract module (`memory_contract.py:79-98`)
 * and re-exported here so existing callers keep importing it from one place.
 */
export type { MemoryDraft };

/**
 * memory_repository.py:266-298 — publish a worker result.
 *
 * `draft === null` means "nothing worth remembering": the job still succeeds and
 * (for manual/auto) its turns are still marked processed, so the same turns are
 * not re-offered forever. For a merge, the replaced parents are linked to the
 * new child via `memory_links` so the merge stays auditable.
 */
export function publish(
  orm: Orm,
  agentId: string,
  jobId: string,
  token: string,
  draft: MemoryDraft | null,
): void {
  const job = ownedRunning(orm, agentId, jobId, token);

  let sourceRows: Array<Record<string, unknown>> = [];
  let selected: MemoryEntryRow[] = [];
  if (job.kind === "merge") {
    selected = entries(orm, agentId, JSON.parse(job.memoryIds) as string[]);
    if (selected.some((i) => i.status !== "active")) {
      fail("MEMORY_STATE_CONFLICT", "来源记忆状态已变化");
    }
    const sources = validateEntrySources(orm, selected);
    // Several memories can share a turn; the merged entry stores that source once.
    sourceRows = [...new Map(sources.map((source) => [source.turnId, source])).values()].map(
      (s) => ({
        turn_id: s.turnId,
        user_message_id: s.userMessageId,
        assistant_message_id: s.assistantMessageId,
        sequence_no: s.sequenceNo,
      }),
    );
  } else {
    const rows = turns(orm, agentId, job.sessionId, { ids: JSON.parse(job.turnIds) as string[] });
    sourceRows = rows.map(({ turn, user, assistant }) => ({
      turn_id: turn.id,
      user_message_id: user.id,
      assistant_message_id: assistant.id,
      sequence_no: user.sequenceNo,
    }));
  }

  if (draft !== null) {
    const snapshot = JSON.parse(job.configSnapshot) as { scope: string; scope_key: string };
    const entry = orm
      .insert(schema.memoryEntries)
      .values({
        id: newId(),
        agentId,
        userId: DEFAULT_USER_ID,
        name: draft.name,
        summary: draft.summary,
        tags: JSON.stringify(draft.tags),
        kinds: JSON.stringify(draft.kinds),
        body: draft.body,
        scope: snapshot.scope,
        scopeKey: snapshot.scope_key,
        status: "active",
        configSnapshot: selected.some((item) => correctionMetadata(item.configSnapshot) !== null)
          ? correctionSnapshot(
              job.configSnapshot,
              selected[0].id,
              selected.flatMap((item) => correctionMetadata(item.configSnapshot)?.rejected ?? []),
            )
          : job.configSnapshot,
        createdAt: nowIso(),
      })
      .returning()
      .get();
    if (!entry) throw new AppError("DATABASE_UNAVAILABLE", "数据服务暂不可用，请检查数据库", 503);

    for (const data of sourceRows) {
      orm
        .insert(schema.memorySources)
        .values({
          memoryId: entry.id,
          turnId: data.turn_id as string,
          userMessageId: data.user_message_id as string,
          assistantMessageId: data.assistant_message_id as string,
          sequenceNo: data.sequence_no as number,
        })
        .run();
    }
    if (job.kind === "merge") {
      for (const item of selected) {
        orm
          .update(schema.memoryEntries)
          .set({ status: "replaced" })
          .where(eq(schema.memoryEntries.id, item.id))
          .run();
        orm.insert(schema.memoryLinks).values({ parentId: item.id, childId: entry.id }).run();
      }
    }
    updateJobRow(orm, job.id, { resultId: entry.id });
  }

  if (job.kind !== "merge") {
    for (const turnId of JSON.parse(job.turnIds) as string[]) {
      const existing = orm
        .select()
        .from(schema.memoryProcessedTurns)
        .where(eq(schema.memoryProcessedTurns.turnId, turnId))
        .get();
      if (!existing) {
        orm.insert(schema.memoryProcessedTurns).values({ turnId, processedAt: nowIso() }).run();
      }
    }
  }

  updateJobRow(orm, job.id, {
    status: "succeeded",
    finishedAt: nowIso(),
    token: null,
    leaseExpiresAt: null,
  });
}

/**
 * Shared narrow update helper: only the columns a job transition touches.
 *
 * Exported because the worker's lease/failure transitions are service-level
 * policy in the source (`memory_service.py:60-72,107-113,156-166`) that mutates
 * a repository-provided row directly; keeping the primitive here preserves the
 * DB-in-repository layering without inventing near-duplicate wrappers.
 */
export function updateJobRow(
  orm: Orm,
  jobId: string,
  values: Partial<{
    status: string;
    token: string | null;
    leaseExpiresAt: string | null;
    resultId: string | null;
    errorCode: string | null;
    finishedAt: string | null;
  }>,
): MemoryJobRow {
  const row = orm
    .update(schema.memoryJobs)
    .set(values)
    .where(eq(schema.memoryJobs.id, jobId))
    .returning()
    .get();
  if (!row) throw new AppError("MEMORY_JOB_NOT_FOUND", "整理任务不存在", 404);
  return row;
}

// `sql` is re-exported so route modules can build ad-hoc predicates without a
// second drizzle import (keeps the import graph shallow).
export { sql };
