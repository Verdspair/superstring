import { z } from "zod";
import { TaskStatusSchema } from "./agent-task";
import { UuidSchema } from "./common";

export const RuntimeChannelSchema = z.enum(["web", "onebot11", "memory", "knowledge", "system"]);
export const RuntimeStageSchema = z.enum([
  "ingress",
  "wake",
  "context",
  "model",
  "action",
  "sticker",
  "delivery",
  "run",
  "maintenance",
]);
export const RuntimeSpanStatusSchema = z.enum([
  "started",
  "completed",
  "no_output",
  "failed",
  "cancelled",
  "unknown",
  "scheduled",
  "deferred",
  "skipped",
  "observed",
]);
export const RuntimeSpanSchema = z.strictObject({
  id: z.number().int().positive(),
  traceId: z.string(),
  spanId: z.string(),
  parentSpanId: z.string().nullable(),
  name: z.string(),
  at: z.string(),
  finishedAt: z.string().nullable(),
  durationMs: z.number().nonnegative().nullable(),
  channel: RuntimeChannelSchema,
  stage: RuntimeStageSchema,
  status: RuntimeSpanStatusSchema,
  code: z.string(),
  model: z.string().nullable(),
  conversationId: z.string().nullable(),
  agentId: z.string().nullable(),
  runId: z.string().nullable(),
  wakeId: z.string().nullable(),
  outputId: z.string().nullable(),
  sourceSeq: z.number().int().nonnegative().nullable(),
  details: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
});
export const RuntimeSpansPageSchema = z.strictObject({
  items: z.array(RuntimeSpanSchema),
  nextBeforeId: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  summary: z.strictObject({
    total: z.number(),
    active: z.number(),
    failed: z.number(),
    unknown: z.number(),
    lastActivityAt: z.string().nullable(),
    now: z.string(),
  }),
});
export const RuntimeSpanFiltersSchema = z
  .strictObject({
    q: z.string().max(200).optional(),
    channel: RuntimeChannelSchema.optional(),
    stage: RuntimeStageSchema.optional(),
    status: RuntimeSpanStatusSchema.optional(),
    model: z.string().max(200).optional(),
    conversationId: z.string().uuid().optional(),
    agentId: z.string().uuid().optional(),
    runId: z.string().uuid().optional(),
    traceId: z
      .string()
      .regex(/^[a-f0-9]{32}$/)
      .optional(),
    from: z
      .string()
      .datetime()
      .transform((value) => new Date(value).toISOString())
      .optional(),
    to: z
      .string()
      .datetime()
      .transform((value) => new Date(value).toISOString())
      .optional(),
    beforeId: z.coerce.number().int().nonnegative().optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  })
  .refine((filters) => !filters.from || !filters.to || filters.from <= filters.to, {
    message: "The start of the interval must not follow its end",
  });
export const ConversationRuntimeStatusSchema = z.strictObject({
  pendingWakes: z.number(),
  activeRuns: z.number(),
  failedWakes: z.number(),
  unknownDeliveries: z.number(),
  nextReadyAt: z.string().nullable(),
  lastActivityAt: z.string().nullable(),
  connectionPhase: z.string(),
  now: z.string(),
});
export type RuntimeSpan = z.infer<typeof RuntimeSpanSchema>;
export type RuntimeSpansPage = z.infer<typeof RuntimeSpansPageSchema>;
export type RuntimeSpanFilters = z.infer<typeof RuntimeSpanFiltersSchema>;
export type ConversationRuntimeStatus = z.infer<typeof ConversationRuntimeStatusSchema>;

/** Cursor is the first visible span id, so adding child spans never moves a trace between pages. */
export const RuntimeTraceSchema = z.strictObject({
  traceId: z.string(),
  cursorId: z.number().int().positive(),
  causes: z.array(z.string()),
  specIds: z.array(z.string()),
  root: RuntimeSpanSchema,
  at: z.string(),
  lastActivityAt: z.string(),
  finishedAt: z.string().nullable(),
  durationMs: z.number().nonnegative(),
  status: RuntimeSpanStatusSchema,
  spanCount: z.number().int().nonnegative(),
  matchedSpanCount: z.number().int().nonnegative(),
  models: z.array(z.string()),
  channels: z.array(RuntimeChannelSchema),
  runIds: z.array(z.string()),
  wakeIds: z.array(z.string()),
});
export const RuntimeTracesPageSchema = z.strictObject({
  items: z.array(RuntimeTraceSchema),
  nextBeforeId: z.number().int().nonnegative(),
  hasMore: z.boolean(),
  summary: z.strictObject({
    totalTraces: z.number(),
    activeTraces: z.number(),
    failedTraces: z.number(),
    matchedSpans: z.number(),
    lastActivityAt: z.string().nullable(),
    now: z.string(),
  }),
});
export const RuntimeTraceDetailSchema = z.strictObject({
  now: z.string(),
  trace: RuntimeTraceSchema,
  items: z.array(RuntimeSpanSchema),
  matchedSpanIds: z.array(z.string()),
});
export type RuntimeTrace = z.infer<typeof RuntimeTraceSchema>;
export type RuntimeTracesPage = z.infer<typeof RuntimeTracesPageSchema>;
export type RuntimeTraceDetail = z.infer<typeof RuntimeTraceDetailSchema>;

// ---- 运行侧「数据与保留」（存储统计、到期条目与手动清理）--------------------------------
// 只报告磁盘上真实存在的行；`expired` 一律按**服务端当前时间**判定，请求不能自带时钟。
// 条目接口只返回元数据（身份/时间/计数/保护状态），绝不返回任何受保护正文、参数或结果。
export const RuntimeStorageCategorySchema = z.enum(["traces", "contexts", "task_payloads"]);
export type RuntimeStorageCategory = z.infer<typeof RuntimeStorageCategorySchema>;
export const RuntimeStorageStatusFilterSchema = z.enum(["all", "live", "expired"]);
export type RuntimeStorageStatusFilter = z.infer<typeof RuntimeStorageStatusFilterSchema>;

/** 手动清理能处理的范围：与请求里的类别、ids 无关，是当前实现自身的能力说明。 */
export const RuntimeStorageCleanupScopeSchema = z.strictObject({
  categories: z.array(RuntimeStorageCategorySchema),
  /** 已到期但保留的 trace 状态（在跑/结果未知）。 */
  protectedTraceStatuses: z.array(RuntimeSpanStatusSchema),
  /** 已到期但保留 payload 的任务状态。 */
  protectedTaskStatuses: z.array(TaskStatusSchema),
  /** 已到期但保留 payload 的调用状态（在跑/待批准/效果未知）。 */
  protectedCallStatuses: z.array(z.string()),
  /** 清理这些快照时只清正文，来源引用与布局身份保留。 */
  contextClearedFields: z.array(z.string()),
  /** 清理任务 payload 时只清这些字段，任务状态与来源身份保留。 */
  taskClearedFields: z.array(z.string()),
});

export const RuntimeStorageSummarySchema = z.strictObject({
  now: z.string(),
  retention: z.strictObject({
    traceRetentionDays: z.number().int().positive(),
    traceRetentionDefaultDays: z.number().int().positive(),
    traceRetentionMinDays: z.number().int().positive(),
    traceRetentionMaxDays: z.number().int().positive(),
  }),
  cleanupScope: RuntimeStorageCleanupScopeSchema,
  traces: z.strictObject({
    /** 未到期（仍可见）。 */
    live: z.number().int().nonnegative(),
    /** 已到期（仅物理留存；来源失效的行本就不可见）。 */
    expired: z.number().int().nonnegative(),
    /** 含在跑 span 的 trace：即使到期也不能手动删除。 */
    started: z.number().int().nonnegative(),
    /** 含结果未知 span 的 trace：同上。 */
    unknown: z.number().int().nonnegative(),
  }),
  spans: z.strictObject({
    live: z.number().int().nonnegative(),
    expired: z.number().int().nonnegative(),
  }),
  contexts: z.strictObject({
    /** 现在可读的正文快照（status=exact 且未到期）。 */
    live: z.number().int().nonnegative(),
    /** 到期时间已过（含已清正文与仍残留正文的）。 */
    expired: z.number().int().nonnegative(),
    revoked: z.number().int().nonnegative(),
    /** 仍物理持有受保护正文的快照（任何状态）。 */
    withProtectedBody: z.number().int().nonnegative(),
    /** 已到期且正文仍物理残留：手动清理的目标。 */
    expiredProtectedBodies: z.number().int().nonnegative(),
  }),
  taskPayloads: z.strictObject({
    /** 未到期且仍有 arguments/result 的任务数。 */
    live: z.number().int().nonnegative(),
    /** 已到期且仍有 arguments/result 的任务数。 */
    expired: z.number().int().nonnegative(),
    /** 已到期但按保全规则不能清理的任务数。 */
    protected: z.number().int().nonnegative(),
    /** 已到期且可清理的任务数。 */
    removable: z.number().int().nonnegative(),
  }),
});
export type RuntimeStorageSummary = z.infer<typeof RuntimeStorageSummarySchema>;

export const RuntimeStorageTraceItemSchema = z.strictObject({
  kind: z.literal("trace"),
  traceId: z.string(),
  at: z.string(),
  lastActivityAt: z.string(),
  status: RuntimeSpanStatusSchema,
  spanCount: z.number().int().positive(),
  expiresAt: z.string(),
  expired: z.boolean(),
  /** 到期也不能删（含 started/unknown span）。 */
  protected: z.boolean(),
  channels: z.array(RuntimeChannelSchema),
  agentId: z.string().nullable(),
  conversationId: z.string().nullable(),
});
export const RuntimeStorageContextItemSchema = z.strictObject({
  kind: z.literal("context"),
  stepId: z.string(),
  runId: z.string(),
  at: z.string(),
  status: z.enum(["exact", "expired", "revoked"]),
  expiresAt: z.string().nullable(),
  expired: z.boolean(),
  sourceCount: z.number().int().nonnegative(),
  hasProtectedBody: z.boolean(),
  agentId: z.string().nullable(),
  conversationId: z.string().nullable(),
});
export const RuntimeStorageTaskPayloadItemSchema = z.strictObject({
  kind: z.literal("task_payload"),
  taskId: z.string(),
  conversationId: z.string(),
  agentId: z.string(),
  status: TaskStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  expiresAt: z.string(),
  expired: z.boolean(),
  protected: z.boolean(),
  callCount: z.number().int().nonnegative(),
  payloadCallCount: z.number().int().nonnegative(),
});
export const RuntimeStorageItemSchema = z.discriminatedUnion("kind", [
  RuntimeStorageTraceItemSchema,
  RuntimeStorageContextItemSchema,
  RuntimeStorageTaskPayloadItemSchema,
]);
export type RuntimeStorageItem = z.infer<typeof RuntimeStorageItemSchema>;

export const RuntimeStorageItemsQuerySchema = z.strictObject({
  category: RuntimeStorageCategorySchema,
  status: RuntimeStorageStatusFilterSchema.default("all"),
  conversationId: UuidSchema.optional(),
  agentId: UuidSchema.optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type RuntimeStorageItemsQuery = z.infer<typeof RuntimeStorageItemsQuerySchema>;
export const RuntimeStorageItemsPageSchema = z.strictObject({
  now: z.string(),
  category: RuntimeStorageCategorySchema,
  status: RuntimeStorageStatusFilterSchema,
  items: z.array(RuntimeStorageItemSchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
  summary: z.strictObject({
    total: z.number().int().nonnegative(),
    live: z.number().int().nonnegative(),
    expired: z.number().int().nonnegative(),
  }),
});
export type RuntimeStorageItemsPage = z.infer<typeof RuntimeStorageItemsPageSchema>;

/** 清理永远要求显式类别；`ids` 只在选中一部分行时出现，空数组是 422 而不是"全部"。 */
export const RuntimeStorageCleanupRequestSchema = z.strictObject({
  category: RuntimeStorageCategorySchema,
  ids: z.array(z.string().min(1).max(128)).min(1).max(200).optional(),
});
export type RuntimeStorageCleanupRequest = z.infer<typeof RuntimeStorageCleanupRequestSchema>;
export const RuntimeStorageCleanupResultSchema = z.strictObject({
  now: z.string(),
  category: RuntimeStorageCategorySchema,
  dryRun: z.boolean(),
  /** 选中范围内已到期的单元数。 */
  expired: z.number().int().nonnegative(),
  /** 已到期且按保全规则可清理的单元数。 */
  removable: z.number().int().nonnegative(),
  /** 已到期但按保全规则保留的单元数。 */
  protected: z.number().int().nonnegative(),
  /** 请求 ids 中存在于范围内的个数（类别范围＝范围内的全部单元）。 */
  matched: z.number().int().nonnegative(),
  /** 请求 ids 中找不到的个数。 */
  missing: z.number().int().nonnegative(),
  /** 实际移除数（预览为 0）。 */
  removed: z.number().int().nonnegative(),
  /** 将移除/已移除的单元 id；有界。 */
  ids: z.array(z.string()),
  truncated: z.boolean(),
});
export type RuntimeStorageCleanupResult = z.infer<typeof RuntimeStorageCleanupResultSchema>;
