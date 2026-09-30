import { z } from "zod";

export const PermissionGrantSchema = z.strictObject({
  resource: z.string().min(1).max(500),
  approved: z.boolean().default(false),
  revision: z.string().min(1).optional(),
  agentIds: z.array(z.string().min(1)).optional(),
  directories: z.array(z.string().min(1)).default([]),
});
// ---- 执行配置（P7-c）：开关 + 数值分组 -----------------------------------------
// 数值是**有效值**：schema 缺省即当前行为；消费方（任务/研究/沙箱/主循环/QQ）在新 run、
// 新任务或新领取时读取。安全不变量不在可编辑范围：同会话恒为 1、协议每批最多 4 项、
// 只读研究不发言、未知写不重放等仍由各自模块强制。

export const ExecutionTaskLimitsSchema = z.strictObject({
  concurrency: z.number().int().min(1).max(8).default(2),
  /** 任务最长有效期，从入队起算（含排队与审批等待），单位小时。 */
  retentionHours: z
    .number()
    .min(1 / 60)
    .max(24)
    .default(24),
  leaseSeconds: z.number().int().min(5).max(120).default(30),
  pollMs: z.number().int().min(100).max(5_000).default(500),
});
export const ExecutionResearchLimitsSchema = z.strictObject({
  maxPerRun: z.number().int().min(1).max(2).default(2),
  maxSteps: z.number().int().min(1).max(6).default(6),
  deadlineMs: z.number().int().min(1_000).max(120_000).default(60_000),
  maxConclusionChars: z.number().int().min(1).max(4_000).default(4_000),
});
export const ExecutionCodeLimitsSchema = z.strictObject({
  timeoutMs: z.number().int().min(1_000).max(120_000).default(20_000),
  maxCalls: z.number().int().min(1).max(128).default(32),
  concurrency: z.number().int().min(1).max(8).default(3),
  /** QuickJS guest 分配上限；不是整个进程 RSS。 */
  memoryBytes: z.number().int().min(8_388_608).max(134_217_728).default(33_554_432),
  maxTransferBytes: z.number().int().min(65_536).max(8_388_608).default(1_048_576),
  maxConclusionChars: z.number().int().min(1).max(16_000).default(4_000),
});
export const ExecutionLoopLimitsSchema = z.strictObject({
  /** 主循环决策步数上限：Web 与 QQ 两个通道的缺省值。 */
  maxSteps: z.number().int().min(1).max(64).default(16),
  /** 同批只读工具并行上限；协议每批最多 4 项不变。 */
  readBatch: z.number().int().min(1).max(3).default(3),
  /** 同签名调用第 N 次结束这一轮（N-1 次带提醒），3–10。 */
  noProgress: z.number().int().min(3).max(10).default(3),
  /** QQ 跨会话唤醒并发（会话内恒为串行，由数据库租约保证）。 */
  concurrency: z.number().int().min(1).max(16).default(4),
  /** 进程级模型调用上限（所有服务合计）。 */
  modelConcurrency: z.number().int().min(1).max(16).default(1),
  /** 每个服务单独的并发上限：只会在整机帽之下收紧，不能靠它超过整机上限。 */
  providerConcurrency: z.number().int().min(1).max(16).default(1),
});
export const ExecutionQqLimitsSchema = z.strictObject({
  retryDelayMs: z.number().int().min(1_000).max(300_000).default(15_000),
  maxAttempts: z.number().int().min(1).max(10).default(3),
  /** 出站意图有效期：超时未提交按未送达处理，不盲目重发。 */
  deliveryTtlSeconds: z.number().int().min(10).max(3_600).default(120),
});
export const ExecutionModulesSchema = z.strictObject({
  mcp: z.boolean().default(true),
  skills: z.boolean().default(true),
  /** 联网工具（web.search / web.fetch）：默认关闭。 */
  web: z.boolean().default(false),
  tasks: z.boolean().default(true),
  memoryJobs: z.boolean().default(true),
  knowledgeJobs: z.boolean().default(true),
  qqMedia: z.boolean().default(true),
  qqStickers: z.boolean().default(true),
});
export type ExecutionModules = z.infer<typeof ExecutionModulesSchema>;
export const EXECUTION_MODULE_KEYS = ExecutionModulesSchema.keyof().options;
export const ExecutionMaintenanceLimitsSchema = z.strictObject({
  memoryTimeoutSeconds: z.number().int().min(60).max(86_400).default(3_600),
  knowledgeTimeoutSeconds: z.number().int().min(60).max(86_400).default(3_600),
});
/** 追踪保留天数的契约边界：存储端点与冻结逻辑共用同一组来源。 */
export const TELEMETRY_RETENTION_DEFAULT_DAYS = 14;
export const TELEMETRY_RETENTION_MIN_DAYS = 1;
export const TELEMETRY_RETENTION_MAX_DAYS = 3_650;
export const ExecutionTelemetrySchema = z.strictObject({
  /**
   * 运行追踪（runtime_spans）的保留天数。新 trace 在开始时读取并冻结自己的到期帽；
   * 已写入的 trace 不随此设置变化（继续取已写入到期与来源 TTL 的最小值）。
   */
  retentionDays: z
    .number()
    .int()
    .min(TELEMETRY_RETENTION_MIN_DAYS)
    .max(TELEMETRY_RETENTION_MAX_DAYS)
    .default(TELEMETRY_RETENTION_DEFAULT_DAYS),
});

export const ExecutionPolicySchema = z.strictObject({
  research: z.boolean().default(false),
  code: z.boolean().default(false),
  modules: ExecutionModulesSchema.prefault({}),
  maintenance: ExecutionMaintenanceLimitsSchema.prefault({}),
  telemetry: ExecutionTelemetrySchema.prefault({}),
  pausedTools: z.array(z.string().min(1).max(500)).default([]),
  tasks: ExecutionTaskLimitsSchema.prefault({}),
  researchLimits: ExecutionResearchLimitsSchema.prefault({}),
  codeLimits: ExecutionCodeLimitsSchema.prefault({}),
  loop: ExecutionLoopLimitsSchema.prefault({}),
  qq: ExecutionQqLimitsSchema.prefault({}),
});
export type ExecutionPolicy = z.infer<typeof ExecutionPolicySchema>;

export const PermissionPolicySchema = z
  .strictObject({
    version: z.literal(1),
    grants: z.array(PermissionGrantSchema).default([]),
    /** 可选：老策略（没有本组）与只写 grants 的调用方都合法；有效值由 `executionPolicy` 补齐。 */
    execution: ExecutionPolicySchema.prefault({}).optional(),
  })
  .refine(
    (policy) => new Set(policy.grants.map((grant) => grant.resource)).size === policy.grants.length,
    "Permission resources must be unique",
  );

/** 解析后的有效执行配置：老策略（没有 execution）与手工构造的策略都得到全部缺省值。 */
export function executionPolicy(policy: PermissionPolicy): ExecutionPolicy {
  return ExecutionPolicySchema.parse(policy.execution ?? {});
}
export type PermissionPolicy = z.infer<typeof PermissionPolicySchema>;
export type PermissionGrant = z.infer<typeof PermissionGrantSchema>;

// 联网动作共用 web 授权资源，暂停须同时匹配资源名与动作名。
const WEB_PERMISSION_RESOURCE = "web";

export function toolExecutionEnabled(execution: ExecutionPolicy, name: string): boolean {
  return (
    !execution.pausedTools.includes(name) &&
    (!name.startsWith("mcp.") || execution.modules.mcp) &&
    (!name.startsWith("skill.") || execution.modules.skills) &&
    (!name.startsWith("web.") ||
      (execution.modules.web && !execution.pausedTools.includes(WEB_PERMISSION_RESOURCE)))
  );
}

export type ExecutionMode = "direct" | "sandbox" | "subtask";
export interface PermissionRequirement {
  resource: string;
  revision: string;
  approvalRequired: boolean;
  directories?: readonly string[];
}
export type PermissionDecision =
  | { allowed: true }
  | {
      allowed: false;
      code:
        | "PERMISSION_DENIED"
        | "PERMISSION_APPROVAL_REQUIRED"
        | "PERMISSION_REVISION_CHANGED"
        | "PERMISSION_DIRECTORY_DENIED"
        | "PERMISSION_MODE_DENIED";
    };
export const PermissionUpdateSchema = z.strictObject({
  expectedRevision: z.string(),
  policy: PermissionPolicySchema,
});

/** 管理面读取（P7-d）：策略 + 当前已发现资源；不包含任何凭据值。 */
export const PermissionResourceSchema = z.strictObject({
  name: z.string(),
  description: z.string(),
  effect: z.enum(["read", "write"]),
  resource: z.string(),
  revision: z.string(),
  approvalRequired: z.boolean(),
  directories: z.array(z.string()).optional(),
});
export type PermissionResource = z.infer<typeof PermissionResourceSchema>;
export const PermissionsResponseSchema = z.strictObject({
  revision: z.string(),
  policy: PermissionPolicySchema,
  resources: z.array(PermissionResourceSchema),
});
export type PermissionsResponse = z.infer<typeof PermissionsResponseSchema>;
export const PermissionSnapshotSchema = z.strictObject({
  revision: z.string(),
  policy: PermissionPolicySchema,
});
export type PermissionSnapshot = z.infer<typeof PermissionSnapshotSchema>;
