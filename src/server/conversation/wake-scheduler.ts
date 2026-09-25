import type { WakeSignal } from "../../shared/contracts/conversation";
import type { WakeRepository } from "../db/wake-repository";
export interface WakeSchedulerPolicy {
  leaseMs: number;
  renewMs: number;
  retryDelayMs: number;
  maxAttempts: number;
}
/** Driven by the shared Bot pump: never creates a second global Bot execution slot. */
export class WakeScheduler {
  private running = false;
  private stopped = false;
  private active: AbortController | null = null;
  constructor(
    private readonly options: {
      repository: WakeRepository;
      policy: () => WakeSchedulerPolicy;
      activate: (wake: WakeSignal, signal: AbortSignal) => Promise<unknown>;
      now?: () => string;
      onError?: (error: unknown, wake: WakeSignal) => void;
    },
  ) {}
  peek(cause?: string): WakeSignal | null {
    return this.options.repository.peek({
      at: this.options.now?.() ?? new Date().toISOString(),
      topology: "direct",
      cause,
    });
  }
  async runOnce(filter?: { cause?: string; wakeId?: string }): Promise<boolean> {
    if (this.stopped || this.running) return false;
    this.running = true;
    const now = () => this.options.now?.() ?? new Date().toISOString();
    const policy = this.options.policy();
    let renewal: ReturnType<typeof setInterval> | undefined;
    try {
      this.options.repository.recover({
        at: now(),
        maxAttempts: policy.maxAttempts,
        retryDelayMs: policy.retryDelayMs,
      });
      const wake = this.options.repository.claim({
        at: now(),
        leaseMs: policy.leaseMs,
        topology: "direct",
        ...filter,
      });
      if (!wake) return false;
      const controller = new AbortController();
      this.active = controller;
      renewal = setInterval(() => {
        if (
          !this.options.repository.renew(
            wake.id,
            wake.leaseToken!,
            now(),
            this.options.policy().leaseMs,
          )
        )
          controller.abort(new Error("WAKE_LEASE_LOST"));
      }, policy.renewMs);
      try {
        await this.options.activate(wake, controller.signal);
      } catch (error) {
        this.options.repository.fail(wake.id, wake.leaseToken!, {
          at: now(),
          maxAttempts: policy.maxAttempts,
          retryDelayMs: policy.retryDelayMs,
          errorCode:
            error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message)
              ? error.message
              : "BOT_RUN_FAILED",
        });
        this.options.onError?.(error, wake);
      }
      return true;
    } finally {
      if (renewal) clearInterval(renewal);
      this.active = null;
      this.running = false;
    }
  }
  stop(): void {
    this.stopped = true;
    this.active?.abort(new Error("BOT_STOPPED"));
  }
}
