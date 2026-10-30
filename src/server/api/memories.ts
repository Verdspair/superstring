// Agent-scoped memory API
// The route prefix is `/agents/{agent_id}/memory`, so the
// full paths below are `/agents/:agentId/memory/...`. No memory content is
// injected into chat from here; these routes only read and govern.
// Every handler is synchronous and wrapped in `immediate()`, which stands in for
// the contract's transaction + `SELECT … FOR UPDATE`. See the header
// of `src/server/db/memory-repository.ts` for why that is the faithful mapping.

import type { Database } from "bun:sqlite";
import { and, desc, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import {
  ConsolidateRequestSchema,
  GovernRequestSchema,
  MemoryCorrectionSchema,
  MemorySearchRebuildSchema,
  MemoryVisibilityUpdateSchema,
  MergeRequestSchema,
  PolicyUpdateSchema,
  SessionScopeUpdateSchema,
} from "../../shared/contracts";
import type { MemoryManagementQuery } from "../../shared/contracts/memory";
import { correctMemory, memoryContent, setMemoryVisibility } from "../db/memory-content-repository";
import {
  memoryManagementMetadata,
  memoryManagementPage,
  memoryManagementScopes,
  memoryReadablePage,
  memorySourcePreviewPage,
  memorySourcePreviews,
} from "../db/memory-management-repository";
import {
  enqueue,
  entries,
  govern,
  jobOwned,
  type MemoryEntryRow,
  type MemoryJobRow,
  policy,
  rebuildMemorySearchProjection,
  sessionScope,
  setScope,
  turns,
} from "../db/memory-repository";
import { DEFAULT_USER_ID, immediate, type Orm } from "../db/repositories";
import * as schema from "../db/schema";
import { fail } from "../errors";
import { parseBody, parseUuidParam, readJsonBody, validationFailed } from "./validation";

/** `policy_view`. */
function policyView(p: {
  autoEnabled: number;
  everyTurns: number;
  targetChars: number;
  version: number;
}) {
  return {
    auto_enabled: p.autoEnabled === 1,
    every_turns: p.everyTurns,
    target_chars: p.targetChars,
    version: p.version,
  };
}

/** `job_view`. `session_id` is null for merge jobs. */
function jobView(j: MemoryJobRow) {
  return {
    id: j.id,
    kind: j.kind,
    session_id: j.sessionId,
    status: j.status,
    result_id: j.resultId,
    error_code: j.errorCode,
    created_at: j.createdAt,
    finished_at: j.finishedAt,
  };
}

/** Entry list item. `tags`/`kinds` are JSON TEXT. */
function entrySummary(e: MemoryEntryRow) {
  return {
    id: e.id,
    name: e.name,
    summary: e.summary,
    tags: JSON.parse(e.tags) as string[],
    kinds: JSON.parse(e.kinds) as string[],
    scope: e.scope,
    scope_key: e.scopeKey,
    status: e.status,
    created_at: e.createdAt,
  };
}

/**
 * Return config_snapshot as an object.
 * SQLite stores JSON text; missing, empty or malformed values return null.
 */
function parseConfigSnapshot(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** Entry detail — adds `body` + `config_snapshot`. */
function entryDetail(e: MemoryEntryRow) {
  return {
    ...entrySummary(e),
    body: e.body,
    config_snapshot: parseConfigSnapshot(e.configSnapshot),
  };
}

/**
 * Parse an integer query parameter with `ge, le, default` semantics: a
 * missing value takes the default, anything non-numeric or out of range is
 * a 422 (never a silent clamp).
 */
function intQuery(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw === "") return fallback;
  if (!/^-?\d+$/.test(raw)) throw validationFailed();
  const value = Number.parseInt(raw, 10);
  if (value < min || value > max) throw validationFailed();
  return value;
}

export function memoryRoutes(orm: Orm, options: { includeShared?: boolean } = {}): Hono {
  const router = new Hono();
  const db = (orm as unknown as { $client: Database }).$client;
  const base = "/agents/:agentId/memory";
  router.use(`${base}/*`, async (c, next) => {
    c.header("cache-control", "no-store");
    await next();
  });

  /** Every memory route resolves the agent first, so a bad id is always 404. */
  const agentOf = (c: { req: { param: (name: string) => string } }): string =>
    parseUuidParam(c.req.param("agentId"));

  // Policy

  // GET /policy. The read itself CREATES the row on first
  // touch, which is why a plain GET performs a write.
  router.get(`${base}/policy`, (c) => {
    const agentId = agentOf(c);
    return c.json(immediate(db, () => policyView(policy(orm, agentId))));
  });

  // PATCH /policy, optimistic lock on `version`.
  router.patch(`${base}/policy`, async (c) => {
    const agentId = agentOf(c);
    const body = parseBody(PolicyUpdateSchema, await readJsonBody(c.req.raw));
    return c.json(
      immediate(db, () => {
        const p = policy(orm, agentId);
        if (p.version !== body.expected_version) {
          fail("MEMORY_POLICY_CONFLICT", "记忆策略已变更，请重新加载");
        }
        orm
          .update(schema.memoryPolicies)
          .set({
            autoEnabled: body.auto_enabled ? 1 : 0,
            everyTurns: body.every_turns,
            targetChars: body.target_chars,
            version: p.version + 1,
          })
          .where(eq(schema.memoryPolicies.agentId, agentId))
          .run();
        return policyView({
          autoEnabled: body.auto_enabled ? 1 : 0,
          everyTurns: body.every_turns,
          targetChars: body.target_chars,
          version: p.version + 1,
        });
      }),
    );
  });

  router.post(`${base}/search-projection/rebuild`, async (c) => {
    const agentId = agentOf(c);
    const body = parseBody(MemorySearchRebuildSchema, await readJsonBody(c.req.raw));
    const result = immediate(db, () =>
      rebuildMemorySearchProjection(orm, agentId, {
        ...(body.after_id === undefined ? {} : { afterId: body.after_id }),
        limit: body.limit,
        signal: c.req.raw.signal,
      }),
    );
    return c.json({ rebuilt: result.rebuilt, next_after_id: result.nextAfterId });
  });

  // Sessions / turns / scope

  // sessions that belong to the agent.
  router.get(`${base}/sessions`, (c) => {
    const agentId = agentOf(c);
    return c.json(
      immediate(db, () => {
        policy(orm, agentId);
        const items = orm
          .select()
          .from(schema.sessions)
          .where(
            and(eq(schema.sessions.agentId, agentId), eq(schema.sessions.userId, DEFAULT_USER_ID)),
          )
          .orderBy(desc(schema.sessions.createdAt))
          .all();
        return items.map((s) => ({ id: s.id, title: s.title }));
      }),
    );
  });

  // recent turns with their processed flag.
  router.get(`${base}/sessions/:sessionId/turns`, (c) => {
    const agentId = agentOf(c);
    const sessionId = parseUuidParam(c.req.param("sessionId"));
    const limit = intQuery(c.req.query("limit"), 20, 1, 200);
    return c.json(
      immediate(db, () => {
        const scope = sessionScope(orm, agentId, sessionId);
        const rows = turns(orm, agentId, sessionId, { recent: limit });
        const ids = rows.map((r) => r.turn.id);
        const done =
          ids.length === 0
            ? new Set<string>()
            : new Set(
                orm
                  .select({ turnId: schema.memoryProcessedTurns.turnId })
                  .from(schema.memoryProcessedTurns)
                  .where(inArray(schema.memoryProcessedTurns.turnId, ids))
                  .all()
                  .map((r) => r.turnId),
              );
        return {
          scope,
          turns: rows.map(({ turn, user, assistant }) => ({
            id: turn.id,
            sequence_no: user.sequenceNo,
            user: user.content,
            assistant: assistant.content,
            processed: done.has(turn.id),
          })),
        };
      }),
    );
  });

  // set the legacy scope label (bumps governance epoch).
  router.patch(`${base}/sessions/:sessionId/scope`, async (c) => {
    const agentId = agentOf(c);
    const sessionId = parseUuidParam(c.req.param("sessionId"));
    const body = parseBody(SessionScopeUpdateSchema, await readJsonBody(c.req.raw));
    return c.json(
      immediate(db, () => {
        setScope(orm, agentId, sessionId, body.scope);
        return { scope: body.scope };
      }),
    );
  });

  router.get(`${base}/scopes`, (c) => {
    const agentId = agentOf(c);
    return c.json(immediate(db, () => memoryManagementScopes(orm, agentId)));
  });

  router.get(`${base}/entries`, (c) => {
    const agentId = agentOf(c);
    const view = c.req.query("view") ?? "owned";
    const visibility = c.req.query("visibility");
    const status = c.req.query("status");
    const search = (c.req.query("search") ?? "").trim();
    const scope = c.req.query("scope_key");
    if (
      !["owned", "received", "all"].includes(view) ||
      (visibility !== undefined &&
        !["session_private", "agent_shared", "public", "unclassified"].includes(visibility)) ||
      (status !== undefined && !["active", "suppressed", "replaced", "invalid"].includes(status)) ||
      search.length > 200 ||
      (scope?.length ?? 0) > 2048
    )
      fail("VALIDATION_ERROR", "记忆筛选条件无效", 422);
    const query: MemoryManagementQuery = {
      offset: intQuery(c.req.query("offset"), 0, 0, Number.MAX_SAFE_INTEGER),
      limit: intQuery(c.req.query("limit"), 100, 1, 200),
      view: view as MemoryManagementQuery["view"],
      visibility: visibility as MemoryManagementQuery["visibility"],
      status: status as MemoryManagementQuery["status"],
      search,
      scope_key: scope,
      ...(c.req.query("origin_conversation_id")
        ? { origin_conversation_id: parseUuidParam(c.req.query("origin_conversation_id")!) }
        : {}),
      ...(c.req.query("conversation_id")
        ? { conversation_id: parseUuidParam(c.req.query("conversation_id")!) }
        : {}),
    };
    return c.json(immediate(db, () => memoryManagementPage(orm, agentId, query)));
  });

  const readOptions = (
    c: { req: { query: (name: string) => string | undefined; raw: Request } },
    fields: readonly string[],
  ) => {
    const allowed = new Set(["conversation_id", "offset", "limit", ...fields]);
    const params = new URL(c.req.raw.url).searchParams;
    for (const key of params.keys())
      if (!allowed.has(key) || params.getAll(key).length !== 1)
        fail("VALIDATION_ERROR", "读取参数无效", 422);
    return {
      conversationId: c.req.query("conversation_id")
        ? parseUuidParam(c.req.query("conversation_id")!)
        : undefined,
      signal: c.req.raw.signal,
      includeShared: options.includeShared ?? false,
      offset: intQuery(c.req.query("offset"), 0, 0, Number.MAX_SAFE_INTEGER),
      limit: intQuery(c.req.query("limit"), 4096, 1, 4096),
    };
  };
  router.get(`${base}/entries/:memoryId/read`, (c) => {
    const read = readOptions(c, ["revision"]);
    if (read.offset > 0 && !c.req.query("revision"))
      fail("VALIDATION_ERROR", "续页需要读取修订", 422);
    return c.json(
      orm.transaction(() =>
        memoryReadablePage(orm, agentOf(c), parseUuidParam(c.req.param("memoryId")), {
          ...read,
          revision: c.req.query("revision"),
        }),
      ),
    );
  });
  router.get(`${base}/entries/:memoryId/sources`, (c) => {
    const read = readOptions(c, []);
    return c.json(
      orm.transaction(() =>
        memorySourcePreviews(orm, agentOf(c), parseUuidParam(c.req.param("memoryId")), {
          ...read,
          limit: intQuery(c.req.query("limit"), 20, 1, 100),
        }),
      ),
    );
  });
  router.get(`${base}/entries/:memoryId/source-preview`, (c) => {
    const read = readOptions(c, ["source_key", "revision"]),
      sourceKey = c.req.query("source_key"),
      revision = c.req.query("revision");
    if (!sourceKey || !revision) fail("VALIDATION_ERROR", "来源引用和修订不能为空", 422);
    return c.json(
      orm.transaction(() =>
        memorySourcePreviewPage(orm, agentOf(c), parseUuidParam(c.req.param("memoryId")), {
          ...read,
          sourceKey,
          revision,
        }),
      ),
    );
  });

  // detail. An unknown id is 404 MEMORY_NOT_FOUND.
  router.get(`${base}/entries/:memoryId`, (c) => {
    const agentId = agentOf(c);
    const memoryId = parseUuidParam(c.req.param("memoryId"));
    return c.json(immediate(db, () => entryDetail(entries(orm, agentId, [memoryId])[0])));
  });

  router.get(`${base}/entries/:memoryId/access-metadata`, (c) => {
    const agentId = agentOf(c),
      memoryId = parseUuidParam(c.req.param("memoryId"));
    const conversationId = c.req.query("conversation_id");
    return c.json(
      immediate(db, () =>
        memoryManagementMetadata(
          orm,
          agentId,
          memoryId,
          conversationId ? parseUuidParam(conversationId) : undefined,
        ),
      ),
    );
  });

  router.get(`${base}/entries/:memoryId/content`, (c) => {
    const agentId = agentOf(c);
    const memoryId = parseUuidParam(c.req.param("memoryId"));
    return c.json(immediate(db, () => memoryContent(orm, agentId, memoryId)));
  });

  router.put(`${base}/entries/:memoryId/visibility`, async (c) => {
    const agentId = agentOf(c);
    const memoryId = parseUuidParam(c.req.param("memoryId"));
    const body = parseBody(MemoryVisibilityUpdateSchema, await readJsonBody(c.req.raw));
    return c.json(immediate(db, () => setMemoryVisibility(orm, agentId, memoryId, body)));
  });

  router.post(`${base}/entries/:memoryId/correct`, async (c) => {
    const agentId = agentOf(c);
    const memoryId = parseUuidParam(c.req.param("memoryId"));
    const body = parseBody(MemoryCorrectionSchema, await readJsonBody(c.req.raw));
    return c.json(
      immediate(db, () => correctMemory(orm, agentId, memoryId, body)),
      201,
    );
  });

  // Jobs

  // enqueue a manual consolidation (202).
  router.post(`${base}/consolidate`, async (c) => {
    const agentId = agentOf(c);
    const body = parseBody(ConsolidateRequestSchema, await readJsonBody(c.req.raw));
    return c.json(
      immediate(db, () =>
        jobView(
          enqueue(orm, agentId, body.request_key, {
            kind: "manual",
            sessionId: body.session_id,
            turnIds: body.turn_ids,
          }),
        ),
      ),
      202,
    );
  });

  // enqueue a merge (202). Note: NO session_id.
  router.post(`${base}/merge`, async (c) => {
    const agentId = agentOf(c);
    const body = parseBody(MergeRequestSchema, await readJsonBody(c.req.raw));
    return c.json(
      immediate(db, () =>
        jobView(
          enqueue(orm, agentId, body.request_key, {
            kind: "merge",
            memoryIds: body.memory_ids,
          }),
        ),
      ),
      202,
    );
  });

  // suppress / enable / purge.
  router.post(`${base}/govern`, async (c) => {
    const agentId = agentOf(c);
    const body = parseBody(GovernRequestSchema, await readJsonBody(c.req.raw));
    return c.json(
      immediate(db, () => {
        govern(orm, agentId, body.memory_ids, body.action);
        return { affected: body.memory_ids.length, action: body.action };
      }),
    );
  });

  // most recent 100 jobs.
  router.get(`${base}/jobs`, (c) => {
    const agentId = agentOf(c);
    return c.json(
      immediate(db, () => {
        policy(orm, agentId);
        return orm
          .select()
          .from(schema.memoryJobs)
          .where(
            and(
              eq(schema.memoryJobs.agentId, agentId),
              eq(schema.memoryJobs.userId, DEFAULT_USER_ID),
            ),
          )
          .orderBy(desc(schema.memoryJobs.createdAt))
          .limit(100)
          .all()
          .map(jobView);
      }),
    );
  });

  // job detail.
  router.get(`${base}/jobs/:jobId`, (c) => {
    const agentId = agentOf(c);
    const jobId = parseUuidParam(c.req.param("jobId"));
    return c.json(immediate(db, () => jobView(jobOwned(orm, agentId, jobId))));
  });

  // retry a FAILED job (202).
  // Order of the three guards is part of the contract: state first, then the
  // busier "another job is active" check, then the governance-epoch check.
  router.post(`${base}/jobs/:jobId/retry`, (c) => {
    const agentId = agentOf(c);
    const jobId = parseUuidParam(c.req.param("jobId"));
    return c.json(
      immediate(db, () => {
        const p = policy(orm, agentId);
        const job = jobOwned(orm, agentId, jobId);
        if (job.status !== "failed") {
          fail("MEMORY_STATE_CONFLICT", "只有失败任务可以重试");
        }
        const busy = orm
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
        if (busy) {
          fail("MEMORY_BUSY", "该 Agent 已有整理任务");
        }
        if (job.governanceEpoch !== p.governanceEpoch) {
          fail("MEMORY_SOURCE_CHANGED", "来源或治理已变化，请重新选择并创建新任务");
        }
        const updated = orm
          .update(schema.memoryJobs)
          .set({ status: "queued", errorCode: null, finishedAt: null })
          .where(eq(schema.memoryJobs.id, jobId))
          .returning()
          .get();
        if (!updated) throw fail("MEMORY_JOB_NOT_FOUND", "整理任务不存在", 404);
        return jobView(updated);
      }),
      202,
    );
  });

  return router;
}
