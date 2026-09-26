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
  globalConcurrency?: number;
}
/** Driven by the shared Bot pump: never creates a second global Bot execution slot. */
export class WakeScheduler {
  private running = false;
  private stopped = false;
  private active: AbortController | null = null;
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
  async runOnce(filter?: { cause?: string; wakeId?: string }): Promise<boolean> {
    if (this.stopped || this.running) return false;
    this.running = true;
    const now = () => this.options.now?.() ?? new Date().toISOString();
    const policy = this.options.policy();
    let renewal: ReturnType<typeof setInterval> | undefined;
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
      if (!wake) return false;
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
        else span?.update({ details: { leaseRenewals: ++renewals } });
      }, policy.renewMs);
      try {
        const run = () => this.options.activate(wake, controller.signal);
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
        const code = error instanceof Error && "code" in error ? error.code : undefined;
        const errorCode =
          typeof code === "string" && /^[A-Z][A-Z0-9_]+$/.test(code)
            ? code
            : error instanceof Error && internalFailureCodes.has(error.message)
              ? error.message.toUpperCase()
              : "BOT_RUN_FAILED";
        this.options.repository.fail(wake.id, wake.leaseToken!, {
          at: now(),
          maxAttempts: policy.maxAttempts,
          retryDelayMs: policy.retryDelayMs,
          errorCode,
        });
        span?.update({
          details: { state: this.options.repository.get(wake.id)?.status ?? "missing" },
        });
        span?.end(errorCode === "BOT_STOPPED" ? "cancelled" : "failed", errorCode);
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
