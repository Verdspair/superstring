import type { WakeSignal } from "../../shared/contracts/conversation";
import type { WakeRepository } from "../db/wake-repository";
import type { RuntimeTelemetry } from "../observability/runtime-telemetry";

// These are application-owned sentinels, not provider/model error messages.
const internalFailureCodes = new Set([
  "BINDING_CHANGED",
  "BINDING_EPOCH_CHANGED",
  "BOT_ACCOUNT_CHANGED",
  "BOT_CONFIGURATION_CHANGED",
  "BOT_CONFIGURATION_MISSING",
  "BOT_CONTEXT_MISSING",
  "BOT_CONVERSATION_REQUIRED",
  "BOT_WAKE_CAUSE_INVALID",
  "CONVERSATION_CHANGED_AT_COMMIT",
  "JUDGEMENT_UNREADABLE",
  "OUTPUT_CHANGED_AT_COMMIT",
  "OUTPUT_PREPARATION_MISSING",
  "WAKE_LEASE_LOST",
  "BOT_STOPPED",
  "binding_changed",
  "authority_changed",
  "paused",
  "wrong_purpose",
  "owner_identity_required",
  "private_only",
  "scheme_changed",
  "agent_changed",
]);
export interface WakeSchedulerPolicy {
  leaseMs: number;
  renewMs: number;
  retryDelayMs: number;
  maxAttempts: number;
  /**
   * 本进程同时最多跑几条唤醒（跨会话）。**会话内**始终串行——那是数据库里
   * `wake_signals` 的租约保证的（同一会话已有 `leased` 行时不会再被领取），不靠这里的计数。
   */
  globalConcurrency?: number;
}
/**
 * 唤醒的领取、租约与结算。
 *
 * 并发模型分两层，各自只有一个真源：**能不能领**由数据库决定（同一会话不双领、全局不超过
 * `globalConcurrency`）；**本进程跑几条**由这里决定（`runOnce` 早于容量上限就直接返回 false）。
 * 因此多个调用方可以各自循环 `runOnce()` 形成"车道"，而不会重复执行同一条唤醒。
 */
export class WakeScheduler {
  private readonly inFlight = new Set<Promise<unknown>>();
  private readonly controllers = new Set<AbortController>();
  private stopped = false;
  constructor(
    private readonly options: {
      repository: WakeRepository;
      telemetry?: RuntimeTelemetry;
      policy: () => WakeSchedulerPolicy;
      activate: (wake: WakeSignal, signal: AbortSignal) => Promise<unknown>;
      now?: () => string;
      onError?: (error: unknown, wake: WakeSignal) => void;
    },
  ) {}
  nextReadyAt(): string | null {
    return this.options.repository.nextReadyAt();
  }
  peek(cause?: string): WakeSignal | null {
    return this.options.repository.peek({
      at: this.options.now?.() ?? new Date().toISOString(),
      cause,
    });
  }
  /** 本进程在飞的唤醒数（诊断与测试用；上限见 `policy().globalConcurrency`）。 */
  get activeCount(): number {
    return this.inFlight.size;
  }
  /** 本进程允许的车道数（= 策略里的跨会话并发上限）。 */
  get concurrencyLimit(): number {
    return Math.max(1, this.options.policy().globalConcurrency ?? 1);
  }
  async runOnce(filter?: { cause?: string; wakeId?: string }): Promise<boolean> {
    if (this.stopped) return false;
    // 一次尝试只读一次策略：续租定时器里的那次读取仍是"第二次"，保持原有的失败时序。
    const policy = this.options.policy();
    if (this.inFlight.size >= (policy.globalConcurrency ?? 1)) return false;
    const run = this.startRun(filter, policy);
    this.inFlight.add(run);
    let started = false;
    try {
      started = (await run).started;
    } finally {
      this.inFlight.delete(run);
    }
    return started;
  }
  private async startRun(
    filter: { cause?: string; wakeId?: string } | undefined,
    policy: WakeSchedulerPolicy,
  ): Promise<{ started: boolean }> {
    const now = () => this.options.now?.() ?? new Date().toISOString();
    let renewal: ReturnType<typeof setInterval> | undefined;
    let controller: AbortController | null = null;
    try {
      const interrupted = this.options.telemetry
        ? (this.options.repository.db
            .query(
              "SELECT id,conversation_id,through_seq FROM wake_signals WHERE status='leased' AND lease_expires_at<=?",
            )
            .all(now()) as { id: string; conversation_id: string; through_seq: number }[])
        : [];
      this.options.repository.recover({
        at: now(),
        maxAttempts: policy.maxAttempts,
        retryDelayMs: policy.retryDelayMs,
      });
      for (const previous of interrupted) {
        const recovered = this.options.repository.get(previous.id);
        this.options.telemetry?.record("bot.wake.recover", {
          channel: "onebot11",
          stage: "wake",
          status: recovered?.status === "failed" ? "failed" : "deferred",
          code: "WAKE_INTERRUPTED",
          conversationId: previous.conversation_id,
          wakeId: previous.id,
          sourceSeq: previous.through_seq,
          parent: this.options.telemetry.parentFor("wake_id", previous.id) ?? undefined,
        });
      }
      const wake = this.options.repository.claim({
        at: now(),
        leaseMs: policy.leaseMs,
        globalConcurrency: policy.globalConcurrency,
        ...filter,
      });
      if (!wake) return { started: false };
      const conversation = this.options.repository.db
        .query("SELECT agent_id FROM conversations WHERE id=?")
        .get(wake.conversationId) as { agent_id: string } | null;
      const span = this.options.telemetry?.start("bot.wake.activate", {
        channel: "onebot11",
        stage: "wake",
        wakeId: wake.id,
        conversationId: wake.conversationId,
        agentId: conversation?.agent_id,
        sourceSeq: wake.throughSeq,
        parent: this.options.telemetry.parentFor("wake_id", wake.id) ?? undefined,
        details: { cause: wake.cause, attempt: wake.attempts, readyAt: wake.readyAt },
      });
      let renewals = 0;
      const owned = new AbortController();
      controller = owned;
      this.controllers.add(owned);
      renewal = setInterval(() => {
        if (owned.signal.aborted) return;
        try {
          if (
            !this.options.repository.renew(
              wake.id,
              wake.leaseToken!,
              now(),
              this.options.policy().leaseMs,
            )
          )
            owned.abort(new Error("WAKE_LEASE_LOST"));
          else span?.update({ details: { leaseRenewals: ++renewals } });
        } catch (cause) {
          owned.abort(
            Object.assign(new Error("WAKE_RENEWAL_FAILED", { cause }), {
              code: "WAKE_RENEWAL_FAILED",
            }),
          );
        }
      }, policy.renewMs);
      try {
        const run = () => this.options.activate(wake, owned.signal);
        const result = await (span ? span.within(run) : run());
        const settled = this.options.repository.get(wake.id);
        const reason =
          result &&
          typeof result === "object" &&
          "reason" in result &&
          typeof result.reason === "string" &&
          /^[a-z_]+$/.test(result.reason)
            ? result.reason.toUpperCase()
            : undefined;
        const expired =
          result && typeof result === "object" && "status" in result && result.status === "expired";
        span?.update({
          details: { state: settled?.status ?? "missing", readyAt: settled?.readyAt ?? null },
        });
        span?.end(
          expired
            ? "skipped"
            : settled?.status === "pending"
              ? "deferred"
              : settled?.status === "no_output"
                ? "no_output"
                : settled?.status === "failed"
                  ? "failed"
                  : "completed",
          expired ? "OPPORTUNITY_EXPIRED" : (reason ?? settled?.errorCode ?? "WAKE_SETTLED"),
        );
      } catch (error) {
        // A downstream transport may reject with a generic AbortError. The
        // scheduler's cancellation reason retains the actual lease failure.
        const failure = controller.signal.aborted ? controller.signal.reason : error;
        const code = failure instanceof Error && "code" in failure ? failure.code : undefined;
        const errorCode =
          typeof code === "string" && /^[A-Z][A-Z0-9_]+$/.test(code)
            ? code
            : failure instanceof Error && internalFailureCodes.has(failure.message)
              ? failure.message.toUpperCase()
              : "BOT_RUN_FAILED";
        try {
          this.options.repository.fail(wake.id, wake.leaseToken!, {
            at: now(),
            maxAttempts: policy.maxAttempts,
            retryDelayMs: policy.retryDelayMs,
            errorCode,
          });
          span?.update({
            details: { state: this.options.repository.get(wake.id)?.status ?? "missing" },
          });
        } finally {
          // Failure settlement may itself fail; that error still propagates, but the
          // activation has ended and must not remain a live diagnostic indefinitely.
          span?.end(errorCode === "BOT_STOPPED" ? "cancelled" : "failed", errorCode);
        }
        this.options.onError?.(failure, wake);
      }
      return { started: true };
    } finally {
      if (renewal) clearInterval(renewal);
      if (controller !== null) this.controllers.delete(controller);
    }
  }
  /** 停止领取并中止**本进程全部在飞**的唤醒（跨会话并发下，取消必须是整体语义）。 */
  stop(): void {
    this.stopped = true;
    for (const controller of [...this.controllers]) controller.abort(new Error("BOT_STOPPED"));
  }
}
