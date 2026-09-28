// 执行配置的编辑草稿（P7-d）：数值以字符串保稿，提交前统一解析并按契约边界校验。
//
// 保存给的是**有效值**：页面从 GET 拿到缺省已补齐的分组，未改字段原样回传，
// 因此服务端不会把没动过的项写回成缺省。

import {
  type ExecutionModules,
  type ExecutionPolicy,
  ExecutionPolicySchema,
} from "../../../shared/contracts/permissions";

export interface ExecutionDraft {
  research: boolean;
  code: boolean;
  modules: ExecutionModules;
  pausedTools: string[];
  memoryTimeoutSeconds: string;
  knowledgeTimeoutSeconds: string;
  tasksConcurrency: string;
  tasksRetentionHours: string;
  tasksLeaseSeconds: string;
  tasksPollMs: string;
  researchMaxPerRun: string;
  researchMaxSteps: string;
  researchDeadlineMs: string;
  researchMaxConclusionChars: string;
  codeTimeoutMs: string;
  codeMaxCalls: string;
  codeMemoryMiB: string;
  codeTransferKiB: string;
  codeMaxConclusionChars: string;
  loopMaxSteps: string;
  loopReadBatch: string;
  loopNoProgress: string;
  loopConcurrency: string;
  loopModelConcurrency: string;
  loopProviderConcurrency: string;
  qqRetryDelayMs: string;
  qqMaxAttempts: string;
  qqDeliveryTtlSeconds: string;
}

export const MEBIBYTE = 1_048_576;
export const KIBIBYTE = 1024;

export function executionDraftOf(execution: ExecutionPolicy): ExecutionDraft {
  return {
    research: execution.research,
    code: execution.code,
    modules: { ...execution.modules },
    pausedTools: [...execution.pausedTools],
    memoryTimeoutSeconds: String(execution.maintenance.memoryTimeoutSeconds),
    knowledgeTimeoutSeconds: String(execution.maintenance.knowledgeTimeoutSeconds),
    tasksConcurrency: String(execution.tasks.concurrency),
    tasksRetentionHours: String(execution.tasks.retentionHours),
    tasksLeaseSeconds: String(execution.tasks.leaseSeconds),
    tasksPollMs: String(execution.tasks.pollMs),
    researchMaxPerRun: String(execution.researchLimits.maxPerRun),
    researchMaxSteps: String(execution.researchLimits.maxSteps),
    researchDeadlineMs: String(execution.researchLimits.deadlineMs),
    researchMaxConclusionChars: String(execution.researchLimits.maxConclusionChars),
    codeTimeoutMs: String(execution.codeLimits.timeoutMs),
    codeMaxCalls: String(execution.codeLimits.maxCalls),
    codeMemoryMiB: String(execution.codeLimits.memoryBytes / MEBIBYTE),
    codeTransferKiB: String(execution.codeLimits.maxTransferBytes / KIBIBYTE),
    codeMaxConclusionChars: String(execution.codeLimits.maxConclusionChars),
    loopMaxSteps: String(execution.loop.maxSteps),
    loopReadBatch: String(execution.loop.readBatch),
    loopNoProgress: String(execution.loop.noProgress),
    loopConcurrency: String(execution.loop.concurrency),
    loopModelConcurrency: String(execution.loop.modelConcurrency),
    loopProviderConcurrency: String(execution.loop.providerConcurrency),
    qqRetryDelayMs: String(execution.qq.retryDelayMs),
    qqMaxAttempts: String(execution.qq.maxAttempts),
    qqDeliveryTtlSeconds: String(execution.qq.deliveryTtlSeconds),
  };
}

export function executionPayload(
  draft: ExecutionDraft,
): { ok: true; execution: ExecutionPolicy } | { ok: false; problem: ExecutionDraftKey } {
  const numbers: Partial<Record<ExecutionDraftKey, number>> = {};
  for (const key of NUMERIC_KEYS) {
    const value = Number(draft[key]);
    if (!draft[key].trim() || !Number.isFinite(value)) return { ok: false, problem: key };
    numbers[key] = value;
  }
  const number = (key: ExecutionDraftKey) => numbers[key] as number;
  const candidate = {
    research: draft.research,
    code: draft.code,
    modules: draft.modules,
    pausedTools: draft.pausedTools,
    maintenance: {
      memoryTimeoutSeconds: number("memoryTimeoutSeconds"),
      knowledgeTimeoutSeconds: number("knowledgeTimeoutSeconds"),
    },
    tasks: {
      concurrency: number("tasksConcurrency"),
      retentionHours: number("tasksRetentionHours"),
      leaseSeconds: number("tasksLeaseSeconds"),
      pollMs: number("tasksPollMs"),
    },
    researchLimits: {
      maxPerRun: number("researchMaxPerRun"),
      maxSteps: number("researchMaxSteps"),
      deadlineMs: number("researchDeadlineMs"),
      maxConclusionChars: number("researchMaxConclusionChars"),
    },
    codeLimits: {
      timeoutMs: number("codeTimeoutMs"),
      maxCalls: number("codeMaxCalls"),
      memoryBytes: number("codeMemoryMiB") * MEBIBYTE,
      maxTransferBytes: number("codeTransferKiB") * KIBIBYTE,
      maxConclusionChars: number("codeMaxConclusionChars"),
    },
    loop: {
      maxSteps: number("loopMaxSteps"),
      readBatch: number("loopReadBatch"),
      noProgress: number("loopNoProgress"),
      concurrency: number("loopConcurrency"),
      modelConcurrency: number("loopModelConcurrency"),
      providerConcurrency: number("loopProviderConcurrency"),
    },
    qq: {
      retryDelayMs: number("qqRetryDelayMs"),
      maxAttempts: number("qqMaxAttempts"),
      deliveryTtlSeconds: number("qqDeliveryTtlSeconds"),
    },
  };
  const parsed = ExecutionPolicySchema.safeParse(candidate);
  if (!parsed.success) {
    const path = parsed.error.issues[0]?.path.join(".") ?? "";
    const key = NUMERIC_KEYS.find(
      (candidateKey) =>
        draftKeyPath(candidateKey).startsWith(path) || path.startsWith(draftKeyPath(candidateKey)),
    );
    return { ok: false, problem: key ?? "tasksConcurrency" };
  }
  return { ok: true, execution: parsed.data };
}

export type ExecutionDraftKey = Exclude<
  keyof ExecutionDraft,
  "research" | "code" | "modules" | "pausedTools"
>;

export const NUMERIC_KEYS: readonly ExecutionDraftKey[] = [
  "memoryTimeoutSeconds",
  "knowledgeTimeoutSeconds",
  "tasksConcurrency",
  "tasksRetentionHours",
  "tasksLeaseSeconds",
  "tasksPollMs",
  "researchMaxPerRun",
  "researchMaxSteps",
  "researchDeadlineMs",
  "researchMaxConclusionChars",
  "codeTimeoutMs",
  "codeMaxCalls",
  "codeMemoryMiB",
  "codeTransferKiB",
  "codeMaxConclusionChars",
  "loopMaxSteps",
  "loopReadBatch",
  "loopNoProgress",
  "loopConcurrency",
  "loopModelConcurrency",
  "loopProviderConcurrency",
  "qqRetryDelayMs",
  "qqMaxAttempts",
  "qqDeliveryTtlSeconds",
];

/** 草稿键 → 契约路径前缀，用于把校验失败定位回具体输入框。 */
export function draftKeyPath(key: ExecutionDraftKey): string {
  const map: Record<ExecutionDraftKey, string> = {
    memoryTimeoutSeconds: "maintenance.memoryTimeoutSeconds",
    knowledgeTimeoutSeconds: "maintenance.knowledgeTimeoutSeconds",
    tasksConcurrency: "tasks.concurrency",
    tasksRetentionHours: "tasks.retentionHours",
    tasksLeaseSeconds: "tasks.leaseSeconds",
    tasksPollMs: "tasks.pollMs",
    researchMaxPerRun: "researchLimits.maxPerRun",
    researchMaxSteps: "researchLimits.maxSteps",
    researchDeadlineMs: "researchLimits.deadlineMs",
    researchMaxConclusionChars: "researchLimits.maxConclusionChars",
    codeTimeoutMs: "codeLimits.timeoutMs",
    codeMaxCalls: "codeLimits.maxCalls",
    codeMemoryMiB: "codeLimits.memoryBytes",
    codeTransferKiB: "codeLimits.maxTransferBytes",
    codeMaxConclusionChars: "codeLimits.maxConclusionChars",
    loopMaxSteps: "loop.maxSteps",
    loopReadBatch: "loop.readBatch",
    loopNoProgress: "loop.noProgress",
    loopConcurrency: "loop.concurrency",
    loopModelConcurrency: "loop.modelConcurrency",
    loopProviderConcurrency: "loop.providerConcurrency",
    qqRetryDelayMs: "qq.retryDelayMs",
    qqMaxAttempts: "qq.maxAttempts",
    qqDeliveryTtlSeconds: "qq.deliveryTtlSeconds",
  };
  return map[key];
}
