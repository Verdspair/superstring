import type { Database } from "bun:sqlite";
import { type Context, Hono } from "hono";
import { z } from "zod";
import {
  TELEMETRY_RETENTION_DEFAULT_DAYS,
  TELEMETRY_RETENTION_MAX_DAYS,
  TELEMETRY_RETENTION_MIN_DAYS,
} from "../../shared/contracts/permissions";
import {
  RuntimeSpanFiltersSchema,
  type RuntimeStorageCategory,
  RuntimeStorageCleanupRequestSchema,
  type RuntimeStorageItemsQuery,
  RuntimeStorageItemsQuerySchema,
  type RuntimeStorageSummary,
} from "../../shared/contracts/runtime-observability";
import { AgentRunRepository } from "../db/agent-run-repository";
import { AgentTaskRepository } from "../db/agent-task-repository";
import { RuntimeSpanRepository } from "../observability/span-repository";
import { managementGuard } from "./management";
import { parseBody, readJsonBody, validationFailed } from "./validation";

export interface ObservabilityRouteOptions {
  /** 有效追踪保留天数（执行配置；函数形式＝每次请求重新读取）。 */
  retentionDays?: () => number;
}

/**
 * 手动清理的能力说明：与请求里的类别/ids 无关，是当前实现自身能处理的范围。
 * 受保护状态＝到期也不清（在跑/待批准/结果未知与来源身份必须保全）。
 */
const CLEANUP_SCOPE: RuntimeStorageSummary["cleanupScope"] = {
  categories: ["traces", "contexts", "task_payloads"],
  protectedTraceStatuses: ["started", "unknown"],
  protectedTaskStatuses: ["queued", "running", "waiting_tool", "waiting_approval", "unknown"],
  protectedCallStatuses: ["running", "waiting_approval", "unknown"],
  contextClearedFields: ["protected_messages", "protected_output"],
  taskClearedFields: ["arguments", "result"],
};

/** 有界数字游标（trace 的 span id / context 的 rowid）：非法输入是 422，不静默回到第一页。 */
function numericCursor(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d{1,18}$/.test(value)) throw validationFailed();
  return Number(value);
}
const TaskPayloadCursorSchema = z.strictObject({
  createdAt: z.string().datetime(),
  id: z.string().uuid(),
});
/** 任务游标是上一页末条的 `{createdAt,id}`；JSON 或形状不合法同样是 422。 */
function taskPayloadCursor(
  value: string | undefined,
): { createdAt: string; id: string } | undefined {
  if (value === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw validationFailed();
  }
  const cursor = TaskPayloadCursorSchema.safeParse(parsed);
  if (!cursor.success) throw validationFailed();
  return cursor.data;
}

function cleanupResult(
  now: string,
  category: RuntimeStorageCategory,
  dryRun: boolean,
  selection: {
    expired: number;
    protected: number;
    matched: number;
    missing: number;
    ids: string[];
    truncated: boolean;
  },
  removed: number,
) {
  return {
    now,
    category,
    dryRun,
    expired: selection.expired,
    removable: selection.expired - selection.protected,
    protected: selection.protected,
    matched: selection.matched,
    missing: selection.missing,
    removed,
    ids: selection.ids,
    truncated: selection.truncated,
  };
}

export function observabilityRoutes(db: Database, options: ObservabilityRouteOptions = {}): Hono {
  const router = new Hono();
  const repository = new RuntimeSpanRepository(db);
  const runs = new AgentRunRepository(db);
  const tasks = new AgentTaskRepository(db);
  router.use("*", async (c, next) => {
    c.header("cache-control", "no-store");
    await next();
  });
  router.get("/spans", (c) => {
    const query = RuntimeSpanFiltersSchema.safeParse(c.req.query());
    if (!query.success) throw validationFailed();
    return c.json(repository.page(query.data));
  });
  router.get("/traces", (c) => {
    const query = RuntimeSpanFiltersSchema.safeParse(c.req.query());
    if (!query.success) throw validationFailed();
    return c.json(repository.traces(query.data));
  });
  router.get("/traces/:traceId/waterfall", (c) => {
    const query = RuntimeSpanFiltersSchema.safeParse({
      ...c.req.query(),
      traceId: c.req.param("traceId"),
    });
    if (!query.success) throw validationFailed();
    const result = repository.waterfall(c.req.param("traceId"), query.data);
    return result
      ? c.json(result)
      : c.json({ error: { code: "TRACE_NOT_FOUND", message: "追踪不存在或不可访问" } }, 404);
  });
  router.get("/traces/:traceId", (c) => {
    const query = RuntimeSpanFiltersSchema.safeParse({
      ...c.req.query(),
      traceId: c.req.param("traceId"),
    });
    if (!query.success) throw validationFailed();
    return c.json(repository.page(query.data));
  });

  // ---- 存储与保留：同源/本机守卫 + 服务端时钟 ------------------------------------
  // `expired` 一律按服务端 now 判定（请求不能自带时钟）；条目只回元数据，正文/参数/结果永不出现在响应里。
  router.get("/storage", managementGuard(), (c) => {
    const now = new Date().toISOString();
    const traces = repository.storageCounts(now);
    return c.json({
      now,
      retention: {
        traceRetentionDays: options.retentionDays?.() ?? TELEMETRY_RETENTION_DEFAULT_DAYS,
        traceRetentionDefaultDays: TELEMETRY_RETENTION_DEFAULT_DAYS,
        traceRetentionMinDays: TELEMETRY_RETENTION_MIN_DAYS,
        traceRetentionMaxDays: TELEMETRY_RETENTION_MAX_DAYS,
      },
      cleanupScope: CLEANUP_SCOPE,
      traces: traces.traces,
      spans: traces.spans,
      contexts: runs.contextStorageCounts(now),
      taskPayloads: tasks.taskPayloadStorageCounts(now),
    });
  });
  router.get("/storage/items", managementGuard(), (c) => {
    const query = RuntimeStorageItemsQuerySchema.safeParse(c.req.query());
    if (!query.success) throw validationFailed();
    return c.json(storageItemsPage(query.data));
  });
  router.post("/storage/cleanup/preview", managementGuard(), (c) => cleanup(c, true));
  router.post("/storage/cleanup", managementGuard(), (c) => cleanup(c, false));

  function storageItemsPage(query: RuntimeStorageItemsQuery) {
    const { category, status, conversationId, agentId, cursor, limit } = query;
    const now = new Date().toISOString();
    if (category === "traces") {
      const page = repository.storageItems(
        { status, conversationId, agentId, beforeId: numericCursor(cursor), limit },
        now,
      );
      return {
        now,
        category,
        status,
        items: page.items,
        nextCursor: page.hasMore ? String(page.nextBeforeId) : null,
        hasMore: page.hasMore,
        summary: page.summary,
      };
    }
    if (category === "contexts") {
      const page = runs.contextStorageItems(
        { status, conversationId, agentId, beforeRowid: numericCursor(cursor), limit },
        now,
      );
      return {
        now,
        category,
        status,
        items: page.items,
        nextCursor: page.hasMore ? String(page.nextRowid) : null,
        hasMore: page.hasMore,
        summary: page.summary,
      };
    }
    const page = tasks.taskPayloadStorageItems(
      { status, conversationId, agentId, before: taskPayloadCursor(cursor), limit },
      now,
    );
    const last = page.items.at(-1);
    return {
      now,
      category,
      status,
      items: page.items,
      nextCursor:
        page.hasMore && last
          ? JSON.stringify({ createdAt: last.createdAt, id: last.taskId })
          : null,
      hasMore: page.hasMore,
      summary: page.summary,
    };
  }

  async function cleanup(c: Context, dryRun: boolean) {
    const body = parseBody(RuntimeStorageCleanupRequestSchema, await readJsonBody(c.req.raw));
    const now = new Date().toISOString();
    if (body.category === "traces") {
      const selection = repository.traceCleanupSelection({ now, ids: body.ids });
      const removed = dryRun ? 0 : repository.purgeExpiredTraces({ now, ids: body.ids }).traces;
      return c.json(cleanupResult(now, body.category, dryRun, selection, removed));
    }
    if (body.category === "contexts") {
      const selection = runs.contextCleanupSelection({ now, ids: body.ids });
      const removed = dryRun ? 0 : runs.purgeExpiredContextBodies({ now, ids: body.ids }).contexts;
      return c.json(cleanupResult(now, body.category, dryRun, selection, removed));
    }
    const selection = tasks.taskPayloadCleanupSelection({ now, ids: body.ids });
    const removed = dryRun ? 0 : tasks.purgeExpiredTaskPayloads({ now, ids: body.ids }).tasks;
    return c.json(cleanupResult(now, "task_payloads", dryRun, selection, removed));
  }

  return router;
}
