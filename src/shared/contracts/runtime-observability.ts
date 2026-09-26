import { z } from "zod";

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
