import type { Database } from "bun:sqlite";
import type {
  QqConversationTaskLimits,
  QqConversationTaskStatus,
  QqTaskExecutionSnapshot,
} from "../../shared/contracts/qq-task";
import type {
  QqConversationTaskIdentity,
  QqConversationTaskOutcome,
  QqConversationTaskRecovery,
  QqConversationTaskRow,
  QqConversationTaskSourceGuard,
} from "../db/qq-task-repository";
import {
  cancelQqConversationTask,
  claimNextQqConversationTask,
  deferQqConversationTask,
  recoverQqConversationTaskLease,
  renewQqConversationTaskLease,
  settleQqConversationTask,
} from "../db/qq-task-repository";
import type { Orm } from "../db/repositories";

/** Scheduler-internal abort reasons; message-only attribution mirrors wake-scheduler. */
const internalFailureCodes = new Set([
  "QQ_TASK_CANCELLED",
  "QQ_TASK_LEASE_LOST",
  "QQ_TASK_RENEWAL_FAILED",
  "BOT_STOPPED",
]);

import type { RuntimeTelemetry, TraceScope } from "../observability/runtime-telemetry";

export type QqTaskAuthorityTimings = {
  authorityLeaseChecks?: number;
  authorityLeaseMs?: number;
  authorityConfigurationChecks?: number;
  authorityConfigurationMs?: number;
  authorityDetailChecks?: number;
  authorityDetailMs?: number;
};

export interface QqTaskSchedulerPolicy {
  leaseMs: number;
  renewMs: number;
}

/**
 * 一条任务激活的结构化结果：可终结的用 `QqConversationTaskOutcome` 结算；
 * `deferred` 表示宿主这一轮还没到点，任务按 `readyAt` 回 pending 等下一次领取，
 * 不按终态结算。这里不用字符串联合兜底，`activate` 必须回上面的对象。
 */
export type QqTaskActivationResult =
  | { status: QqConversationTaskOutcome; reason?: string }
  | { status: "deferred"; readyAt: string; reason: string };

/** Claims directly from the durable pending table; only actively claimed work has in-memory state. */
export class QqTaskScheduler {
  private readonly running = new Map<
    string,
    { controller: AbortController; settled: Promise<void>; leaseToken: string }
  >();
  private stopped = false;

  constructor(
    private readonly options: {
      orm: Orm;
      telemetry?: RuntimeTelemetry;
      /** 任务 span 的父解析（root composition 提供）；无可解析父时返回 undefined，span 从根开始。 */
      traceParent?: (
        task: Readonly<QqConversationTaskRow>,
      ) => { traceId: string; spanId: string } | undefined;
      policy: () => QqTaskSchedulerPolicy;
      limitsFor: (identity: Readonly<QqConversationTaskIdentity>) => QqConversationTaskLimits;
      sourceState: QqConversationTaskSourceGuard;
      resourceGate?: (task: Readonly<QqConversationTaskRow>) => boolean;
      freezeAtClaim: (
        transaction: Orm,
        task: Readonly<QqConversationTaskRow>,
        limits: Readonly<QqConversationTaskLimits>,
      ) => QqTaskExecutionSnapshot;
      activate: (
        task: QqConversationTaskRow,
        snapshot: QqTaskExecutionSnapshot,
        leaseToken: string,
        signal: AbortSignal,
        onAuthorityTimings?: (timings: QqTaskAuthorityTimings) => void,
      ) => Promise<QqTaskActivationResult>;
      resolveExistingRunAndOutbox: (
        transaction: Orm,
        task: QqConversationTaskRow,
      ) => QqConversationTaskRecovery;
      now?: () => string;
      onSettled?: () => void;
      onError?: (error: unknown, task: QqConversationTaskRow) => void;
    },
  ) {}

  get activeCount(): number {
    return this.running.size;
  }

  nextReadyAt(): string | null {
    // 计时循环的唤醒期限取两族 deadline 的最小值：deferral 的 ready_at 与源 TTL。
    const row = this.client()
      .query(`SELECT MIN(d) AS at FROM (
        SELECT source_expires_at AS d FROM qq_conversation_tasks
          WHERE status='pending' AND source_expires_at IS NOT NULL
        UNION ALL
        SELECT ready_at AS d FROM qq_conversation_tasks
          WHERE status='pending' AND ready_at IS NOT NULL
      )`)
      .get() as { at: string | null } | null;
    return row?.at ?? null;
  }

  async dispatchOnce(): Promise<boolean> {
    return this.startRun() !== null;
  }

  async runOnce(): Promise<boolean> {
    const run = this.startRun();
    if (!run) return false;
    await run.settled;
    return true;
  }

  private startRun(): { settled: Promise<void> } | null {
    if (this.stopped) return null;
    const now = this.now();
    this.recoverExpired(now);
    const leaseMs = this.options.policy().leaseMs;
    const leaseToken = crypto.randomUUID();
    const leaseExpiresAt = new Date(Date.parse(now) + leaseMs).toISOString();
    const claimed = claimNextQqConversationTask(this.options.orm, {
      at: now,
      leaseToken,
      leaseExpiresAt,
      limitsFor: this.options.limitsFor,
      sourceState: this.options.sourceState,
      resourceGate: this.options.resourceGate,
      freezeAtClaim: this.options.freezeAtClaim,
    });
    if (!claimed) return null;
    if (claimed.task.executionSnapshot === null)
      throw new Error("QQ_TASK_EXECUTION_SNAPSHOT_REQUIRED");
    const snapshot = JSON.parse(claimed.task.executionSnapshot) as QqTaskExecutionSnapshot;
    const controller = new AbortController();
    const settled = this.execute(claimed.task, snapshot, leaseToken, controller);
    this.running.set(claimed.task.id, { controller, settled, leaseToken });
    void settled
      .catch((error) => {
        try {
          this.options.onError?.(error, claimed.task);
        } catch {
          // Outcome settlement and permit release do not depend on observers.
        }
      })
      .finally(() => {
        this.running.delete(claimed.task.id);
        try {
          this.options.onSettled?.();
        } catch {
          // The caller notification is not part of the task lease.
        }
      });
    return { settled };
  }

  async waitForIdle(): Promise<void> {
    while (this.running.size)
      await Promise.allSettled([...this.running.values()].map((row) => row.settled));
  }

  cancel(taskId: string): "cancelled" | "requested" | false {
    const result = cancelQqConversationTask(this.options.orm, { taskId, at: this.now() });
    if (result === "requested")
      this.running.get(taskId)?.controller.abort(new Error("QQ_TASK_CANCELLED"));
    return result;
  }

  stop(): void {
    this.stopped = true;
    for (const row of this.running.values()) row.controller.abort(new Error("BOT_STOPPED"));
  }

  private client(): Database {
    return (this.options.orm as Orm & { $client: Database }).$client;
  }

  private now(): string {
    return this.options.now?.() ?? new Date().toISOString();
  }

  private recoverExpired(at: string): void {
    const expired = this.client()
      .query(
        "SELECT id,lease_token FROM qq_conversation_tasks WHERE status='running' AND lease_expires_at<=?",
      )
      .all(at) as { id: string; lease_token: string }[];
    for (const row of expired) {
      if (!row.lease_token) continue;
      recoverQqConversationTaskLease(this.options.orm, {
        taskId: row.id,
        leaseToken: row.lease_token,
        at,
        resolveExistingRunAndOutbox: (transaction, task) =>
          this.options.resolveExistingRunAndOutbox(transaction, task),
      });
    }
  }

  private async execute(
    task: QqConversationTaskRow,
    snapshot: QqTaskExecutionSnapshot,
    leaseToken: string,
    controller: AbortController,
  ): Promise<void> {
    const policy = this.options.policy();
    const telemetry = this.options.telemetry;
    // 任务生命周期 span：跟随旧 wake 车道的形态——activate 在 span 内执行，稳定态按
    // 结算后的行状态收尾，业务错误在这里结算并收尾，不再向上抛。
    const span: TraceScope | undefined = telemetry?.start("bot.task.activate", {
      channel: "onebot11",
      stage: "wake",
      wakeId: task.originWakeId ?? undefined,
      conversationId: task.conversationId,
      agentId: task.agentId,
      sourceSeq: task.sourceThroughSeq,
      parent: this.options.traceParent?.(task) ?? undefined,
      details: {
        cause: task.cause,
        taskClass: task.taskClass,
        taskId: task.id,
        leaseRenewals: 0,
        leaseRenewalAttempts: 0,
        lastReason: null,
        lastDurationMs: null,
      },
    });
    let renewals = 0;
    let renewalAttempts = 0;
    // 续租回调与结算/中止同生命周期：异常只中止本任务，不再向上逃逸成未处理 rejection。
    const renewal = setInterval(() => {
      if (controller.signal.aborted) return;
      span?.update({ details: { leaseRenewalAttempts: ++renewalAttempts } });
      const startedAt = performance.now();
      try {
        const at = this.now();
        const result = renewQqConversationTaskLease(this.options.orm, {
          taskId: task.id,
          leaseToken,
          at,
          leaseExpiresAt: new Date(Date.parse(at) + this.options.policy().leaseMs).toISOString(),
          sourceState: this.options.sourceState,
        });
        const durationMs = performance.now() - startedAt;
        const lastReason = result.status === "renewed" ? "renewed" : result.reason;
        if (result.status === "renewed") ++renewals;
        span?.update({
          details: {
            leaseRenewals: renewals,
            leaseRenewalAttempts: renewalAttempts,
            lastReason,
            lastDurationMs: durationMs,
          },
        });
        if (result.status === "lost")
          controller.abort(
            Object.assign(new Error("QQ_TASK_LEASE_LOST"), {
              code: "QQ_TASK_LEASE_LOST",
              details: { reason: result.reason },
            }),
          );
      } catch (cause) {
        span?.update({
          details: {
            leaseRenewalAttempts: renewalAttempts,
            lastReason: "renewal_failed",
            lastDurationMs: performance.now() - startedAt,
          },
        });
        controller.abort(
          Object.assign(new Error("QQ_TASK_RENEWAL_FAILED", { cause }), {
            code: "QQ_TASK_RENEWAL_FAILED",
          }),
        );
      }
    }, policy.renewMs);
    // 结算失败/CAS false 后的唯一真源是行状态：按 DB 实际状态收尾，不假写 pending，
    // 也不把已取消的行冒成 failed。返回实际落库的终态（或 null=行已不在 running 面）。
    const finishFromRow = (errorCode: string): QqConversationTaskStatus | null => {
      const row = this.client()
        .query("SELECT status FROM qq_conversation_tasks WHERE id=?")
        .get(task.id) as { status: QqConversationTaskStatus } | null;
      const status = row?.status ?? null;
      if (status === "expired") {
        span?.update({ details: { state: "expired" } });
        span?.end("skipped", "OPPORTUNITY_EXPIRED");
      } else if (status === "cancelled") {
        span?.update({ details: { state: "cancelled" } });
        span?.end("cancelled", "QQ_TASK_CANCELLED");
      } else {
        span?.update({ details: { state: status ?? "missing" } });
        span?.end("failed", errorCode);
        // 公开车道（runOnce/dispatchOnce/waitForIdle）不向上抛业务错误；观察者收到通知即可，
        // 与旧 wake 车道的稳定语义一致。只有真正 failed 才通知，取消/过期不算错误。
        try {
          this.options.onError?.(new Error(errorCode), task);
        } catch {
          // 观察者异常不属于任务结算。
        }
      }
      return status;
    };
    const fail = (errorCode: string): void => {
      const settled = settleQqConversationTask(this.options.orm, {
        taskId: task.id,
        leaseToken,
        outcome: controller.signal.aborted ? "cancelled" : "failed",
        at: this.now(),
        sourceState: this.options.sourceState,
        errorCode,
      });
      // settle 的返回值是实际落库的终态（源过期会 terminalize 成 expired）；false 才读行。
      if (settled !== false) {
        span?.update({ details: { state: settled } });
        span?.end(
          settled === "cancelled" ? "cancelled" : settled === "expired" ? "skipped" : "failed",
          settled === "expired" ? "OPPORTUNITY_EXPIRED" : errorCode,
        );
        if (settled === "failed")
          try {
            this.options.onError?.(new Error(errorCode), task);
          } catch {
            // 观察者异常不属于任务结算。
          }
        return;
      }
      finishFromRow(errorCode);
    };
    try {
      controller.signal.throwIfAborted();
      const authorityTimings: QqTaskAuthorityTimings = {};
      const onAuthorityTimings = (timings: QqTaskAuthorityTimings) =>
        Object.assign(authorityTimings, timings);
      let result: QqTaskActivationResult;
      try {
        result = await (span
          ? span.within(() =>
              this.options.activate(
                task,
                snapshot,
                leaseToken,
                controller.signal,
                onAuthorityTimings,
              ),
            )
          : this.options.activate(
              task,
              snapshot,
              leaseToken,
              controller.signal,
              onAuthorityTimings,
            ));
      } finally {
        span?.update({ details: authorityTimings });
      }
      if (result.status === "deferred") {
        // 「还没到点」不是终态：按宿主给的 readyAt 回 pending 等重取。CAS 是唯一真源，
        // false（源过期/被取消/租约已丢）按实际行状态收尾，不假写 pending/deferred。
        const at = this.now();
        const deferred = deferQqConversationTask(this.options.orm, {
          taskId: task.id,
          leaseToken,
          at,
          readyAt: result.readyAt,
          sourceState: this.options.sourceState,
        });
        if (deferred) {
          span?.update({ details: { state: "pending", readyAt: result.readyAt } });
          span?.end("deferred", result.reason.toUpperCase());
        } else {
          // defer CAS false：源过期/被取消/租约已丢，按行状态真实收尾（失败时通知观察者）。
          finishFromRow(result.reason.toUpperCase());
        }
        return;
      }
      // activate 回的每个可终结 status 都是合法 outcome（completed/no_output/expired/failed/
      // cancelled），按原样结算，不折算、不兜底；deferred 已在上面分支处理。
      const outcome: QqConversationTaskOutcome = result.status;
      const settled = settleQqConversationTask(this.options.orm, {
        taskId: task.id,
        leaseToken,
        outcome,
        at: this.now(),
        sourceState: this.options.sourceState,
      });
      if (settled === false) {
        // settle CAS false（租约丢失/源闸改判）按行状态真实收尾。
        finishFromRow("QQ_TASK_FAILED");
        return;
      }
      // settle 的返回值才是实际落库的终态：源过期会 terminalize 成 expired，取消请求成 cancelled。
      span?.update({ details: { state: settled, readyAt: null } });
      span?.end(
        settled === "no_output" ? "no_output" : settled === "expired" ? "skipped" : settled,
        settled === "expired"
          ? "OPPORTUNITY_EXPIRED"
          : (result.reason?.toUpperCase() ?? settled.toUpperCase()),
      );
    } catch (error) {
      // A generic AbortError loses the scheduler's abort reason; wake-scheduler
      // precedent: attribute from the cancellation reason first.
      const failure = controller.signal.aborted ? controller.signal.reason : error;
      const code = failure instanceof Error && "code" in failure ? failure.code : undefined;
      const errorCode =
        typeof code === "string" && internalFailureCodes.has(code)
          ? code
          : failure instanceof Error && internalFailureCodes.has(failure.message)
            ? failure.message
            : "QQ_TASK_FAILED";
      fail(errorCode);
    } finally {
      clearInterval(renewal);
    }
  }
}
