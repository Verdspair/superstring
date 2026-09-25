// Test-only pre-cutover behavior oracle; never import from production.
import type { LeafAgentRuntime } from "../../../src/server/agent/agent-runtime";
// The QQ runtime host (ADR0018 §12, P5): the piece that makes the durable state machine run.
//
// Everything the QQ side does was already written and tested, but nothing in the product ever
// CALLED `sweepQqIdleTopics` (and its two siblings `enqueueQqDispatchFromEvent` /
// `runQqDispatchCycle`): they were reachable only from tests, so the candidate table only ever
// filled if a person wrote rows by hand. This host is that caller.
//
// It owns the timer side of the conservative event-driven decision — the quiet-room sweep — and
// nothing else:
//
//   * It does not observe. The transport (`QqIntakeRuntime`) owns the connection, the housekeeping
//     pass and the recording of observations; a second owner for the same rows would be a race
//     with a nice name.
//   * It does not send. The chain runner is an injected capability (`dispatch`), and the entry
//     point wires it now that speech has a destination (P5o): an authorized draft goes to the
//     sender, whose confirmed delivery is what writes the speech record §8.2's "no reply, no
//     second opener" rule learns from. `canAdvance` is the remaining gate — with no live QQ
//     connection there is nothing to deliver into, so the host does not spend model calls.
//
// The loop shape mirrors the memory worker: `start()` runs cycles, `stop()` cancels a pending
// sleep and waits, and `runCycle()` is exposed so tests drive the host deterministically instead
// of racing a timer.

import type { Orm } from "../../../src/server/db/repositories";
import type { ModelGateway } from "../../../src/server/llm/model-gateway";
import { type QqIdleSweep, sweepQqIdleTopics } from "../../../src/server/services/qq-dispatch";
import type { QqStickerStage } from "../../../src/server/services/qq-sticker-runner";
import type { QqStickerStore } from "../../../src/server/services/qq-sticker-store";
import {
  type QqDispatchCycleResult,
  type QqImmediateCycleResult,
  type QqReplySender,
  runQqDispatchCycle,
  runQqImmediateReplyCycle,
} from "./qq-dispatch-cycle";

/** How often the host wakes up. The sweep's own unit is minutes (the scheme's quiet window). */
export const QQ_RUNTIME_POLL_MS = 15_000;

/**
 * One scheduling turn: take the global lease and run at most one model chain. Injected rather
 * than imported so that "the product does not advance the queue yet" is a visible wiring
 * decision instead of a hidden default.
 */
export type QqDispatchRunner = (input: {
  readonly nowSeconds: number;
}) => Promise<QqDispatchCycleResult>;

/**
 * One immediate turn (直接回应 / 连续交谈): answer the newest message aimed at the assistant, or
 * continue an exchange (P5s). Injected for the same reason the queued runner is.
 */
export type QqImmediateRunner = (input: {
  readonly nowSeconds: number;
}) => Promise<QqImmediateCycleResult>;

/**
 * The real runner, built from the same pieces the host was given.
 *
 * `counts` is U13 (does a failed or unknown send count as "already seen"?), which is still
 * undecided; the conservative reading is that only a result we actually saw succeed may push a
 * sticker out of the avoid-recently window. The decision stays the user's, so this is a named
 * recipe rather than a default buried in the host — and the storage layer keeps asking the
 * caller.
 */
export function qqDispatchRunner(input: {
  orm: Orm;
  gateway: Pick<ModelGateway, "complete" | "loadedContextCapacity">;
  store: QqStickerStore;
  agentRuntime?: LeafAgentRuntime;
  conversationKinds?: readonly ("group" | "private")[];
  /** Omitted means this build cannot deliver, and an authorized draft is dropped (P5o). */
  sender?: QqReplySender;
}): QqDispatchRunner {
  const stage: QqStickerStage = {
    counts: ["confirmed"],
    isAvailable: (asset) => input.store.copyExists(asset.fileName),
  };
  return ({ nowSeconds }) =>
    runQqDispatchCycle(
      input.orm,
      input.gateway,
      {
        nowSeconds,
        clockSeconds: () => Math.floor(Date.now() / 1000),
        conversationKinds: input.conversationKinds,
      },
      stage,
      input.sender,
      input.agentRuntime,
    );
}

/** The immediate-path runner, built from the same pieces (P5s). */
export function qqImmediateRunner(input: {
  orm: Orm;
  gateway: Pick<ModelGateway, "complete" | "loadedContextCapacity">;
  store: QqStickerStore;
  agentRuntime?: LeafAgentRuntime;
  conversationKinds?: readonly ("group" | "private")[];
  sender?: QqReplySender;
}): QqImmediateRunner {
  const stage: QqStickerStage = {
    counts: ["confirmed"],
    isAvailable: (asset) => input.store.copyExists(asset.fileName),
  };
  return ({ nowSeconds }) =>
    runQqImmediateReplyCycle(
      input.orm,
      input.gateway,
      {
        nowSeconds,
        clockSeconds: () => Math.floor(Date.now() / 1000),
        conversationKinds: input.conversationKinds,
      },
      stage,
      input.sender,
      input.agentRuntime,
    );
}

/** Content-free: a cycle's shape, never a draft, a peer id or a body. */
export type QqRuntimeEvent =
  | {
      readonly kind: "cycle";
      readonly swept: number;
      readonly skipped: number;
      readonly dispatch: QqDispatchCycleResult["kind"] | "not_advanced";
      readonly immediate: QqImmediateCycleResult["kind"] | "not_advanced";
    }
  | { readonly kind: "cycle_failed" };

export interface QqRuntimeCycle {
  readonly sweep: QqIdleSweep;
  /** `null` when no runner is wired: the queue is filled, and advancing it is not this run's job. */
  readonly dispatch: QqDispatchCycleResult | null;
  /** `null` when no immediate runner is wired (P5s). */
  readonly immediate: QqImmediateCycleResult | null;
}

export interface QqRuntimeOptions {
  orm: Orm;
  /** Seconds since epoch, the unit the dispatch rows use. Injectable so tests own the clock. */
  clockSeconds?: () => number;
  pollIntervalMs?: number;
  /** Wired by the entry point (P5o); see the module header. */
  dispatch?: QqDispatchRunner;
  /** The immediate-path runner (P5s); omitted means calling the assistant waits for the queue. */
  immediate?: QqImmediateRunner;
  /**
   * Whether advancing the queue is possible at all right now (P5o). The entry point answers "is
   * the QQ transport connected": with no connection a draft would have no destination and the
   * model calls would be spent on nothing. Reported as `not_advanced`, so a diagnostic can see
   * that this tick deliberately did not run the chain.
   */
  canAdvance?: () => boolean;
  onEvent?: (event: QqRuntimeEvent) => void;
  /** Transitional composition: one timer drives migrated direct and remaining group work. */
  sweep?: (nowSeconds: number) => QqIdleSweep;
  advance?: (nowSeconds: number) => Promise<Pick<QqRuntimeCycle, "immediate" | "dispatch">>;
}

export class QqRuntime {
  readonly #orm: Orm;
  readonly #clockSeconds: () => number;
  readonly #pollIntervalMs: number;
  readonly #dispatch: QqDispatchRunner | undefined;
  readonly #immediate: QqImmediateRunner | undefined;
  readonly #canAdvance: (() => boolean) | undefined;
  readonly #onEvent: ((event: QqRuntimeEvent) => void) | undefined;
  readonly #sweep: (nowSeconds: number) => QqIdleSweep;
  readonly #advance: QqRuntimeOptions["advance"];

  #loopPromise: Promise<void> | null = null;
  #stopped = false;
  #sleepResolve: (() => void) | null = null;
  /** 收到"该干活了"的信号（见 `wake()`）：本轮跑完立刻再跑一轮，不等下一次轮询。 */
  #pendingWake = false;

  constructor(options: QqRuntimeOptions) {
    this.#orm = options.orm;
    this.#clockSeconds = options.clockSeconds ?? (() => Math.floor(Date.now() / 1000));
    this.#pollIntervalMs = options.pollIntervalMs ?? QQ_RUNTIME_POLL_MS;
    this.#dispatch = options.dispatch;
    this.#immediate = options.immediate;
    this.#canAdvance = options.canAdvance;
    this.#onEvent = options.onEvent;
    this.#sweep = options.sweep ?? ((nowSeconds) => sweepQqIdleTopics(this.#orm, { nowSeconds }));
    this.#advance = options.advance;
  }

  start(): void {
    if (this.#loopPromise !== null) return;
    this.#stopped = false;
    this.#loopPromise = this.#loop();
  }

  /**
   * 「有消息找她，别等下一次轮询」（用户 2026-09-25）。
   *
   * 运行宿主原本是纯轮询（每 15 秒），所以被 @ 之后最多要等 15 秒才开始跑链——用户能感觉到的那段
   * 延迟主要就在这里。入站路径记下一条**冲着她来的**消息后调这里：正在睡就把这一觉叫醒，正在跑就
   * 记一个标记让本轮结束立刻再跑一轮（不并发，纪律不变——只是把"下一次"提前）。
   *
   * 多打几次是安全的：每一轮的决策都是从存储重推的，跑一轮空转只花一次读库的时间。
   */
  wake(): void {
    if (this.#stopped) return;
    this.#pendingWake = true;
    this.#sleepResolve?.();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#sleepResolve?.();
    await this.#loopPromise;
    this.#loopPromise = null;
  }

  /**
   * One scheduling turn: sweep the quiet rooms, then advance the queue once.
   *
   * The order matters. The sweep writes a candidate whose `ready_at` is now, so draining
   * afterwards means a fresh opener does not have to wait a whole tick. Draining first would only
   * delay it.
   *
   * A failed task is not retried here: `runQqDispatchCycle` decides what a refusal or a failure
   * means, and its answer is "the slot is spent; a new turn must be earned by a new real event".
   */
  async runCycle(nowSeconds?: number): Promise<QqRuntimeCycle> {
    const now = nowSeconds ?? this.#clockSeconds();
    const sweep = this.#sweep(now);
    const advance =
      (this.#advance !== undefined ||
        this.#dispatch !== undefined ||
        this.#immediate !== undefined) &&
      (this.#canAdvance?.() ?? true);
    // Immediate first: a message aimed at the assistant is answered before any queued opener, and
    // both share the one global slot, so the order here is what makes "被叫到先答" true.
    const result = advance && this.#advance ? await this.#advance(now) : null;
    const immediate = result
      ? result.immediate
      : advance
        ? ((await this.#immediate?.({ nowSeconds: now })) ?? null)
        : null;
    const dispatch = result
      ? result.dispatch
      : advance
        ? ((await this.#dispatch?.({ nowSeconds: now })) ?? null)
        : null;
    this.#onEvent?.({
      kind: "cycle",
      swept: sweep.scheduled.length,
      skipped: sweep.skipped.length,
      dispatch: dispatch?.kind ?? "not_advanced",
      immediate: immediate?.kind ?? "not_advanced",
    });
    return Object.freeze({ sweep, dispatch, immediate });
  }

  async #loop(): Promise<void> {
    while (!this.#stopped) {
      try {
        await this.runCycle();
      } catch {
        // Fixed message, no exception repr: a cycle can carry model output, and a diagnostic sink
        // is not a place for a draft. The next pass retries; the lease guards make a late retry
        // harmless.
        this.#onEvent?.({ kind: "cycle_failed" });
        console.warn("qq runtime cycle failed; retrying next check");
      }
      if (this.#stopped) return;
      // 轮询期间收到过"该干活了"（`wake()`）：立刻再跑一轮，不再等满一个间隔。
      if (this.#pendingWake) {
        this.#pendingWake = false;
        continue;
      }
      await this.#sleep(this.#pollIntervalMs);
    }
  }

  #sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.#sleepResolve = () => {
        clearTimeout(timer);
        this.#sleepResolve = null;
        resolve();
      };
      const timer = setTimeout(() => {
        this.#sleepResolve = null;
        resolve();
      }, ms);
    });
  }
}
