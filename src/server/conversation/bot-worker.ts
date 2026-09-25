export interface BotWorkerOptions {
  sweep: (nowSeconds: number) => void;
  advance: () => Promise<void>;
  canAdvance: () => boolean;
  pollIntervalMs?: number;
  clockSeconds?: () => number;
  onError?: (error: unknown) => void;
}

/** Timer and lifecycle only. Wakes, leases and Agent activation belong to WakeScheduler. */
export class BotWorker {
  private stopped = false;
  private pendingWake = false;
  private loopPromise: Promise<void> | null = null;
  private cyclePromise: Promise<void> | null = null;
  private sleepResolve: (() => void) | null = null;
  constructor(private readonly options: BotWorkerOptions) {}

  start(): void {
    if (this.stopped || this.loopPromise) return;
    this.loopPromise = this.loop();
  }
  wake(): void {
    if (this.stopped) return;
    this.pendingWake = true;
    this.sleepResolve?.();
  }
  async stop(): Promise<void> {
    this.stopped = true;
    this.sleepResolve?.();
    // A caller still receives a manual cycle failure; shutdown must finish draining it.
    await Promise.allSettled([this.cyclePromise, this.loopPromise]);
  }
  runCycle(
    nowSeconds = this.options.clockSeconds?.() ?? Math.floor(Date.now() / 1000),
  ): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.cyclePromise) return this.cyclePromise;
    this.cyclePromise = Promise.resolve()
      .then(async () => {
        this.options.sweep(nowSeconds);
        if (!this.stopped && this.options.canAdvance()) await this.options.advance();
      })
      .finally(() => {
        this.cyclePromise = null;
      });
    return this.cyclePromise;
  }
  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.runCycle();
      } catch (error) {
        this.options.onError?.(error);
      }
      if (this.stopped) return;
      if (this.pendingWake) {
        this.pendingWake = false;
        continue;
      }
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          this.sleepResolve = null;
          resolve();
        };
        const timer = setTimeout(finish, this.options.pollIntervalMs ?? 15_000);
        this.sleepResolve = finish;
      });
    }
  }
}
