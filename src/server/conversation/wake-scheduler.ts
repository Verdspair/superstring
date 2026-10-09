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
 * `globalConcurrency`）；**本进程跑几条**由这里决定（领取早于容量上限就直接返回 false）。
 * 因此多个调用方可以各自循环 `runOnce()` 形成"车道"，而不会重复执行同一条唤醒；
 * 计时循环的短 tick 走 `dispatchOnce()`：领到并启动就返回，模型在后台跑，
 * 结算时经 `onSettled` 通知 worker 复查下一轮。
 */
export class WakeScheduler {
  private readonly inFlight = new Set<Promise<void>>();
  private readonly controllers = new Set<AbortController>();
  private stopped = false;
  constructor(
    private readonly options: {
      repository: WakeRepository;
      telemetry?: RuntimeTelemetry;
      policy: () => WakeSchedulerPolicy;
      activate: (wake: WakeSignal, signal: AbortSignal) => Promise<unknown>;
      /**
       * 领取前的资源闸（如模型名额提示）。返回 false 的机会保持 pending，不烧 attempts——
       * 释放名额的订阅方负责再唤醒 worker，由下一轮复查。这是提示，不是第二准入。
       */
      resourceGate?: (wake: WakeSignal) => boolean;
      now?: () => string;
      onError?: (error: unknown, wake: WakeSignal) => void;
      /** 一条已启动的唤醒结算（成功/失败/中止）后的通知：worker 据此复查下一轮，不是第二准入。 */
      onSettled?: () => void;
    },
  ) {}
  nextReadyAt(): string | null {
    return this.options.repository.nextReadyAt();
  }
  /** 本进程在飞的唤醒数（诊断与测试用；上限见 `policy().globalConcurrency`）。 */
  get activeCount(): number {
    return this.inFlight.size;
  }
  /** 本进程允许的车道数（= 策略里的跨会话并发上限）。 */
  get concurrencyLimit(): number {
    return Math.max(1, this.options.policy().globalConcurrency ?? 1);
  }
  /** 旧车道 API：领到就**等到结算**才返回。保留给手动触发与既有测试；计时循环走 `dispatchOnce()`。 */
  async runOnce(): Promise<boolean> {
    if (this.stopped) return false;
    // 一次尝试只读一次策略：续租定时器里的那次读取仍是"第二次"，保持原有的失败时序。
    const policy = this.options.policy();
    if (this.inFlight.size >= (policy.globalConcurrency ?? 1)) return false;
    const run = this.startRun(policy);
    if (!run) return false;
    this.inFlight.add(run.settled);
    try {
      await run.settled;
    } finally {
      this.release(run);
    }
    return true;
  }

  /**
   * 短车道 API：领到并启动就返回 true，不等模型跑完。领取、名额与取消控制器都在
   * `startRun` 的同步段里占位，并发的短车道不可能超帽，停机也不会漏掉在飞的 controller。
   * 结算（成功/失败/中止）释放名额并触发一次 `onSettled`；空闸或无可领机会不烧 attempts。
   */
  async dispatchOnce(): Promise<boolean> {
    if (this.stopped) return false;
    const policy = this.options.policy();
    if (this.inFlight.size >= (policy.globalConcurrency ?? 1)) return false;
    const run = this.startRun(policy);
    if (!run) return false;
    this.inFlight.add(run.settled);
    // async 体内没有 await：上面的领取与占位在本调用内同步完成。
    void run.settled
      // 后台车道的结算失败没有调用方可抛：交给 onError，不变成未处理的 rejection。
      .catch((error) => {
        try {
          this.options.onError?.(error, run.wake);
        } catch {
          // 观察者自身抛错只算通知失败：不回灌业务错误，也不阻断名额回收。
        }
      })
      // 名额回收必须在任何观察者异常之后仍可达，否则 waitForIdle 永不结束。
      .finally(() => this.release(run));
    return true;
  }

  /** 等待本进程全部在飞唤醒结算（停机排水用；中止在飞由 stop() 负责，先 stop 后 drain）。 */
  async waitForIdle(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight]);
    }
  }

  /** 名额回收与结算通知。通知失败不改写已落库的结算结果。 */
  private release(run: { settled: Promise<void> }): void {
    this.inFlight.delete(run.settled);
    try {
      this.options.onSettled?.();
    } catch {
      // 通知方的错误只属于通知方。
    }
  }
  /**
   * 唯一的领取/租约/结算 owner。同步段完成恢复、闸挑选与原子领取；领到则返回后台结算
   * promise（activate、续租收尾与失败结算都在其中），由入口决定等待或放后台。
   */
  private startRun(
    policy: WakeSchedulerPolicy,
  ): { settled: Promise<void>; wake: WakeSignal } | null {
    const now = () => this.options.now?.() ?? new Date().toISOString();
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
    // 资源闸在领取前检查：按 peek 顺序取第一个资源允许的机会，用它自己的 id 原子领取。
    // 一个繁忙服务不能挡住后面空闲服务的机会（无 HOL）；被闸住的机会留在队列里，
    // 不产生一次 attempts 或失败结算。
    const gate = this.options.resourceGate;
    let wake: WakeSignal | null;
    if (gate) {
      const chosen =
        this.options.repository.pendingCandidates({ at: now() }).find((c) => gate(c)) ?? null;
      if (!chosen) return null;
      wake = this.options.repository.claim({
        at: now(),
        leaseMs: policy.leaseMs,
        globalConcurrency: policy.globalConcurrency,
        wakeId: chosen.id,
      });
    } else {
      wake = this.options.repository.claim({
        at: now(),
        leaseMs: policy.leaseMs,
        globalConcurrency: policy.globalConcurrency,
      });
    }
    if (!wake) return null;
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
    this.controllers.add(owned);
    const renewal = setInterval(() => {
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
    const settled = (async () => {
      try {
        const run = () => this.options.activate(wake, owned.signal);
        const result = await (span ? span.within(run) : run());
        const row = this.options.repository.get(wake.id);
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
          details: { state: row?.status ?? "missing", readyAt: row?.readyAt ?? null },
        });
        span?.end(
          expired
            ? "skipped"
            : row?.status === "pending"
              ? "deferred"
              : row?.status === "no_output"
                ? "no_output"
                : row?.status === "failed"
                  ? "failed"
                  : "completed",
          expired ? "OPPORTUNITY_EXPIRED" : (reason ?? row?.errorCode ?? "WAKE_SETTLED"),
        );
      } catch (error) {
        // A downstream transport may reject with a generic AbortError. The
        // scheduler's cancellation reason retains the actual lease failure.
        const failure = owned.signal.aborted ? owned.signal.reason : error;
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
      } finally {
        clearInterval(renewal);
        this.controllers.delete(owned);
      }
    })();
    return { settled, wake };
  }

  /** 停止领取并中止**本进程全部在飞**的唤醒（跨会话并发下，取消必须是整体语义）。 */
  stop(): void {
    this.stopped = true;
    for (const controller of [...this.controllers]) controller.abort(new Error("BOT_STOPPED"));
  }
}
