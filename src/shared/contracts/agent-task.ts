import { z } from "zod";
import { UuidSchema } from "./common";
import { SourceRefSchema } from "./evidence";

export const TaskPlanSchema = z.strictObject({
  calls: z
    .array(
      z.strictObject({
        name: z.string().min(1).max(500),
        arguments: z.record(z.string(), z.unknown()),
      }),
    )
    .min(1)
    .max(16),
});
export const TaskStatusSchema = z.enum([
  "queued",
  "running",
  "waiting_tool",
  "waiting_approval",
  "completed",
  "failed",
  "cancelled",
  "unknown",
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export const TaskCallSchema = z.strictObject({
  ordinal: z.number().int().nonnegative(),
  name: z.string(),
  revision: z.string(),
  effect: z.enum(["read", "write"]),
  arguments: z.record(z.string(), z.unknown()).nullable(),
  status: z.enum([
    "pending",
    "waiting_approval",
    "approved",
    "running",
    "completed",
    "failed",
    "unknown",
    "cancelled",
  ]),
  approvalRevision: z.string().nullable(),
  result: z.unknown().nullable(),
  errorCode: z.string().nullable(),
});
export type TaskCall = z.infer<typeof TaskCallSchema>;
export const AgentTaskSchema = z.strictObject({
  id: z.string(),
  conversationId: z.string(),
  agentId: z.string(),
  originRunId: z.string().nullable(),
  status: TaskStatusSchema,
  sources: z.array(SourceRefSchema),
  leaseToken: z.string().nullable(),
  leaseExpiresAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  expiresAt: z.string(),
  errorCode: z.string().nullable(),
  calls: z.array(TaskCallSchema),
});
export type AgentTask = z.infer<typeof AgentTaskSchema>;
export const TaskAckSchema = z.strictObject({ ok: z.literal(true) });
export const TaskApprovalSchema = z.strictObject({
  ordinal: z.number().int().min(0).max(15),
  expectedApproval: z.string().min(1).max(128),
  approve: z.boolean(),
});
export type TaskApproval = z.infer<typeof TaskApprovalSchema>;

export const TaskCursorSchema = z.strictObject({
  createdAt: z.string().datetime(),
  id: UuidSchema,
});
export const TaskFiltersSchema = z.strictObject({
  conversationId: UuidSchema.optional(),
  agentId: UuidSchema.optional(),
  status: TaskStatusSchema.optional(),
  originRunId: UuidSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z
    .string()
    .max(200)
    .transform((value, ctx) => {
      try {
        return JSON.parse(value) as unknown;
      } catch {
        ctx.addIssue({ code: "custom", message: "Invalid task cursor" });
        return z.NEVER;
      }
    })
    .pipe(TaskCursorSchema)
    .optional(),
});
export type TaskFilters = z.infer<typeof TaskFiltersSchema>;
export const TaskBodyQuerySchema = z.strictObject({
  offset: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
  limit: z.coerce.number().int().min(1).max(4096).default(2048),
});
export const TaskCallOrdinalSchema = z.coerce.number().int().min(0).max(15);
export const TaskDataStatusSchema = z.enum(["available", "revoked", "expired"]);
export const TaskBodyStatusSchema = z.enum([
  "available",
  "revoked",
  "expired",
  "pending",
  "unavailable",
]);
export const TaskBodyPageSchema = z.strictObject({
  status: TaskBodyStatusSchema,
  text: z.string().nullable(),
  offset: z.number().int().nonnegative(),
  total: z.number().int().nonnegative().nullable(),
  nextOffset: z.number().int().nonnegative().nullable(),
});
export type TaskBodyPage = z.infer<typeof TaskBodyPageSchema>;
export const TaskSummarySchema = z.strictObject({
  id: UuidSchema,
  conversationId: UuidSchema,
  agentId: UuidSchema,
  originRunId: UuidSchema.nullable(),
  status: TaskStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  expiresAt: z.string(),
  errorCode: z.string().nullable(),
  callCount: z.number().int().nonnegative(),
  completedCallCount: z.number().int().nonnegative(),
  waitingOrdinal: z.number().int().nonnegative().nullable(),
  waitingReason: z.enum(["tool", "approval"]).nullable(),
});
export type TaskSummary = z.infer<typeof TaskSummarySchema>;
export const TaskListSchema = z.strictObject({
  items: z.array(TaskSummarySchema),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
});
export type TaskList = z.infer<typeof TaskListSchema>;
export const TaskDetailSchema = TaskSummarySchema.extend({
  dataStatus: TaskDataStatusSchema,
  calls: z.array(
    TaskCallSchema.pick({
      ordinal: true,
      name: true,
      revision: true,
      effect: true,
      status: true,
      approvalRevision: true,
      errorCode: true,
    }).extend({
      argumentsPreview: TaskBodyPageSchema,
      resultStatus: TaskBodyStatusSchema,
    }),
  ),
});
export type TaskDetail = z.infer<typeof TaskDetailSchema>;
