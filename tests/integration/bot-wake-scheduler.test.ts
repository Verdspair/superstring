import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WakeScheduler } from "../../src/server/conversation/wake-scheduler";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { DEFAULT_AGENT_ID, ensureDefaults } from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { WakeRepository } from "../../src/server/db/wake-repository";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const clean of cleanups.splice(0).reverse()) clean();
});
/** Windows can hold the SQLite -wal/-shm files for a moment after close(); retry briefly. */
function removeTempDir(dir: string): void {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      Bun.sleepSync(25);
    }
  }
}

const at = "2030-01-01T00:00:00.000Z";
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "bot-global-lease-"));
  cleanups.push(() => removeTempDir(dir));
  const first = openBusinessDb({ path: join(dir, "business.db") });
  ensureDefaults(first.orm, "model");
  const second = openBusinessDb({ path: join(dir, "business.db") });
  cleanups.push(
    () => first.close(),
    () => second.close(),
  );
  const journal = new ConversationEventRepository(first.db);
  first.db
    .query("INSERT INTO qq_schemes(id,name,created_at,updated_at) VALUES('scheme','test',?,?)")
    .run(at, at);
  const ids = ["200", "300"].map((peer) => {
    first.db
      .query(
        "INSERT INTO qq_bindings(id,account_id,conversation_kind,peer_id,agent_id,scheme_id,created_at,updated_at) VALUES(?,'100','group',?,?,'scheme',?,?)",
      )
      .run(peer, peer, DEFAULT_AGENT_ID, at, at);
    return journal.ensureOneBot(peer)!.id;
  });
  return {
    first,
    second,
    journal,
    ids,
    a: new WakeRepository(first.db),
    b: new WakeRepository(second.db),
  };
}
function offer(h: ReturnType<typeof fixture>, index: number, key: string, seq = 1, time = at) {
  return h.a.enqueue({
    conversationId: h.ids[index]!,
    cause: "chiming_in",
    dedupeKey: key,
    throughSeq: seq,
    readyAt: at,
    priority: 50,
    at: time,
  });
}
describe("durable cross-process Bot concurrency", () => {
  it("atomically shares one default slot across two SQLite handles, renews, and recovers after expiry", () => {
    const h = fixture();
    offer(h, 0, "a");
    offer(h, 1, "b", 1, "2030-01-01T00:00:00.001Z");
    const one = h.a.claim({ at: "2030-01-01T00:00:00.002Z", leaseMs: 1000 })!;
    expect(one.conversationId).toBe(h.ids[1]!);
    expect(h.b.claim({ at, leaseMs: 1000 })).toBeNull();
    expect(h.a.renew(one.id, one.leaseToken!, at, 2000)).toBe(true);
    expect(h.b.claim({ at: "2030-01-01T00:00:01.500Z", leaseMs: 1000 })).toBeNull();
    h.b.recover({ at: "2030-01-01T00:00:02.100Z", maxAttempts: 3, retryDelayMs: 100 });
    expect(h.b.claim({ at: "2030-01-01T00:00:02.100Z", leaseMs: 1000 })?.conversationId).toBe(
      h.ids[0]!,
    );
  });
  it("allows configured two slots but never concurrent runs for the same conversation", () => {
    const h = fixture();
    offer(h, 0, "a");
    offer(h, 0, "a2");
    offer(h, 1, "b");
    const one = h.a.claim({ at, leaseMs: 1000, globalConcurrency: 2 })!;
    const two = h.b.claim({ at, leaseMs: 1000, globalConcurrency: 2 })!;
    expect(one.conversationId).not.toBe(two.conversationId);
    expect(h.a.claim({ at, leaseMs: 1000, globalConcurrency: 3 })).toBeNull();
  });
  it("compares activity time across conversations instead of incomparable local sequence values", () => {
    const h = fixture();
    offer(h, 0, "old", 1000, "2029-12-31T23:59:59.000Z");
    offer(h, 1, "new", 1, at);
    expect(h.a.claim({ at, leaseMs: 1000 })?.conversationId).toBe(h.ids[1]!);
  });
  it("appends one metadata wake event on creation, merges opportunity without moving source cursor", () => {
    const h = fixture();
    const wake = offer(h, 0, "merge");
    offer(h, 0, "merge", 20, "2030-01-01T00:00:01.000Z");
    expect(h.journal.eventsAfter(h.ids[0]!).items).toMatchObject([
      { kind: "wake", source: { kind: "wake", id: wake.id } },
    ]);
    expect(h.journal.sourceThroughSeq(h.ids[0]!)).toBe(0);
    expect(h.a.get(wake.id)!.throughSeq).toBe(20);
  });
  it("ordinary merge waits for latest ready time; completing direct work does not swallow idle", () => {
    const h = fixture();
    const c = h.ids[0]!;
    h.a.enqueue({
      conversationId: c,
      cause: "chiming_in",
      dedupeKey: "merge",
      throughSeq: 1,
      readyAt: at,
      priority: 1,
      at,
      mergeReadyAt: "latest",
    });
    h.a.enqueue({
      conversationId: c,
      cause: "chiming_in",
      dedupeKey: "merge",
      throughSeq: 2,
      readyAt: "2030-01-01T00:00:10.000Z",
      priority: 1,
      at,
      mergeReadyAt: "latest",
    });
    expect(h.a.peek({ at })).toBeNull();
    const direct = h.a.enqueue({
      conversationId: c,
      cause: "direct_reply",
      dedupeKey: "direct",
      throughSeq: 2,
      readyAt: at,
      priority: 100,
      at,
    });
    h.a.enqueue({
      conversationId: c,
      cause: "idle_topic",
      dedupeKey: "idle",
      throughSeq: 2,
      readyAt: at,
      priority: 0,
      at,
    });
    const lease = h.a.claim({ at, leaseMs: 1000 })!;
    expect(lease.id).toBe(direct.id);
    h.a.complete(lease.id, lease.leaseToken!, "no_output", 2, at);
    expect(h.a.peek({ at })?.cause).toBe("idle_topic");
  });
});

it("publishes stable error codes without exposing failure text", async () => {
  const h = fixture();
  const wake = offer(h, 0, "typed-error");
  const scheduler = new WakeScheduler({
    repository: h.a,
    policy: () => ({ leaseMs: 1000, renewMs: 500, retryDelayMs: 100, maxAttempts: 1 }),
    now: () => at,
    activate: async () => {
      throw Object.assign(new Error("private model response and local path"), {
        code: "CONTEXT_MEMORY_BUDGET",
      });
    },
  });
  expect(await scheduler.runOnce()).toBe(true);
  expect(h.a.get(wake.id)?.errorCode).toBe("CONTEXT_MEMORY_BUDGET");
  scheduler.stop();
  const next = offer(h, 1, "opaque-error");
  // 记录里只有码（上面两条），原因走 onError 交给组合根打日志。
  const reported: unknown[] = [];
  const opaque = new WakeScheduler({
    repository: h.a,
    policy: () => ({ leaseMs: 1000, renewMs: 500, retryDelayMs: 100, maxAttempts: 1 }),
    now: () => at,
    activate: async () => {
      throw Object.assign(new Error("private model response and local path"), {
        code: "sensitive lowercase payload",
      });
    },
    onError: (error) => void reported.push(error),
  });
  expect(await opaque.runOnce()).toBe(true);
  expect(h.a.get(next.id)?.errorCode).toBe("BOT_RUN_FAILED");
  expect((reported[0] as Error).message).toContain("private model response");
  expect(h.a.get(next.id)?.errorCode).not.toContain("private");
  opaque.stop();
});

describe("跨会话并发与车道（0.4.0 P1）", () => {
  it("两条车道同时领不同会话，且同一会话绝不会被领两次", async () => {
    const h = fixture();
    offer(h, 0, "a");
    offer(h, 1, "b");
    const started: string[] = [];
    const finished: string[] = [];
    let release: (() => void) | undefined;
    const bothStarted = new Promise<void>((resolve) => {
      release = resolve;
    });
    const scheduler = new WakeScheduler({
      repository: h.a,
      now: () => at,
      policy: () => ({
        leaseMs: 60_000,
        renewMs: 30_000,
        retryDelayMs: 100,
        maxAttempts: 3,
        globalConcurrency: 2,
      }),
      activate: async (wake) => {
        started.push(wake.conversationId);
        if (started.length === 2) release?.();
        // 两条都起来了才放行：这是"真的并发"，不是先后错开。
        await bothStarted;
        finished.push(wake.conversationId);
        h.a.complete(wake.id, wake.leaseToken!, "no_output", wake.throughSeq, at);
      },
    });
    const lanes = await Promise.all([scheduler.runOnce(), scheduler.runOnce()]);

    expect(lanes).toEqual([true, true]);
    expect([...started].sort()).toEqual([h.ids[0]!, h.ids[1]!].sort());
    expect([...finished].sort()).toEqual([h.ids[0]!, h.ids[1]!].sort());
    expect(scheduler.activeCount).toBe(0);
  });

  it("同一会话有两条候选时，第二条车道领不到", async () => {
    const h = fixture();
    offer(h, 0, "a");
    offer(h, 0, "a2");
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const scheduler = new WakeScheduler({
      repository: h.a,
      now: () => at,
      policy: () => ({
        leaseMs: 60_000,
        renewMs: 30_000,
        retryDelayMs: 100,
        maxAttempts: 3,
        globalConcurrency: 2,
      }),
      activate: async (wake) => {
        await gate;
        h.a.complete(wake.id, wake.leaseToken!, "no_output", wake.throughSeq, at);
      },
    });
    const first = scheduler.runOnce();
    expect(await scheduler.runOnce()).toBe(false);
    release?.();
    expect(await first).toBe(true);
    expect(await scheduler.runOnce()).toBe(true);
  });

  it("车道数就是策略里的并发上限：1 时第二条车道直接放弃", async () => {
    const h = fixture();
    offer(h, 0, "a");
    offer(h, 1, "b");
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const scheduler = new WakeScheduler({
      repository: h.a,
      now: () => at,
      policy: () => ({ leaseMs: 60_000, renewMs: 30_000, retryDelayMs: 100, maxAttempts: 3 }),
      activate: async (wake) => {
        await gate;
        h.a.complete(wake.id, wake.leaseToken!, "no_output", wake.throughSeq, at);
      },
    });
    expect(scheduler.concurrencyLimit).toBe(1);
    const first = scheduler.runOnce();
    expect(await scheduler.runOnce()).toBe(false);
    expect(scheduler.activeCount).toBe(1);
    release?.();
    await first;
    expect(scheduler.activeCount).toBe(0);
  });

  it("stop() 中止全部在飞唤醒（跨会话一起取消）", async () => {
    const h = fixture();
    offer(h, 0, "a");
    offer(h, 1, "b");
    const aborted: string[] = [];
    const scheduler = new WakeScheduler({
      repository: h.a,
      now: () => at,
      policy: () => ({
        leaseMs: 60_000,
        renewMs: 30_000,
        retryDelayMs: 100,
        maxAttempts: 3,
        globalConcurrency: 2,
      }),
      activate: (wake, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              aborted.push(wake.conversationId);
              reject(new DOMException("aborted", "AbortError"));
            },
            { once: true },
          );
        }),
    });
    const lanes = [scheduler.runOnce(), scheduler.runOnce()];
    await Bun.sleep(5);
    scheduler.stop();
    await Promise.all(lanes);
    expect([...aborted].sort()).toEqual([h.ids[0]!, h.ids[1]!].sort());
  });
});

describe("后台短车道（dispatchOnce）与停机排水", () => {
  it("领到即返回、模型在后台跑；waitForIdle 排水后状态与名额一致", async () => {
    const h = fixture();
    const wake = offer(h, 0, "bg");
    let release!: () => void;
    const model = new Promise<void>((resolve) => {
      release = resolve;
    });
    const notified: number[] = [];
    const scheduler = new WakeScheduler({
      repository: h.a,
      now: () => at,
      policy: () => ({ leaseMs: 60_000, renewMs: 30_000, retryDelayMs: 100, maxAttempts: 3 }),
      activate: async (w) => {
        await model;
        h.a.complete(w.id, w.leaseToken!, "no_output", w.throughSeq, at);
      },
      onSettled: () => {
        notified.push(1);
      },
    });
    expect(await scheduler.dispatchOnce()).toBe(true);
    expect(scheduler.activeCount).toBe(1);
    expect(h.a.get(wake.id)?.status).toBe("leased");
    let drained = false;
    const idle = scheduler.waitForIdle().then(() => {
      drained = true;
    });
    await Bun.sleep(1);
    expect(drained).toBe(false);
    release();
    await idle;
    expect(drained).toBe(true);
    expect(scheduler.activeCount).toBe(0);
    expect(h.a.get(wake.id)?.status).toBe("no_output");
    expect(notified).toEqual([1]);
    scheduler.stop();
  });

  it("名额与 runOnce 同源：满员即 false 且不通知；结算释放后可再领", async () => {
    const h = fixture();
    offer(h, 0, "a");
    offer(h, 1, "b");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let notified = 0;
    const scheduler = new WakeScheduler({
      repository: h.a,
      now: () => at,
      policy: () => ({ leaseMs: 60_000, renewMs: 30_000, retryDelayMs: 100, maxAttempts: 3 }),
      activate: async (w) => {
        await gate;
        h.a.complete(w.id, w.leaseToken!, "no_output", w.throughSeq, at);
      },
      onSettled: () => {
        notified += 1;
      },
    });
    expect(await scheduler.dispatchOnce()).toBe(true);
    expect(await scheduler.dispatchOnce()).toBe(false);
    expect(scheduler.activeCount).toBe(1);
    expect(notified).toBe(0);
    release();
    await scheduler.waitForIdle();
    expect(notified).toBe(1);
    expect(await scheduler.dispatchOnce()).toBe(true);
    await scheduler.waitForIdle();
    expect([scheduler.activeCount, notified]).toEqual([0, 2]);
    scheduler.stop();
  });

  it("空资源闸不烧 attempts，机会保持 pending", async () => {
    const h = fixture();
    const wake = offer(h, 0, "gated");
    const scheduler = new WakeScheduler({
      repository: h.a,
      now: () => at,
      policy: () => ({ leaseMs: 60_000, renewMs: 30_000, retryDelayMs: 100, maxAttempts: 3 }),
      resourceGate: () => false,
      activate: async () => {
        throw new Error("gated wake must not run");
      },
    });
    expect(await scheduler.dispatchOnce()).toBe(false);
    expect(scheduler.activeCount).toBe(0);
    expect(h.a.get(wake.id)).toMatchObject({ status: "pending", attempts: 0 });
    scheduler.stop();
  });

  it("stop() 中止后台在飞唤醒，waitForIdle 仍排水结束", async () => {
    const h = fixture();
    const wake = offer(h, 0, "abort");
    const scheduler = new WakeScheduler({
      repository: h.a,
      now: () => at,
      policy: () => ({ leaseMs: 60_000, renewMs: 30_000, retryDelayMs: 100, maxAttempts: 3 }),
      activate: (_wake, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        }),
    });
    expect(await scheduler.dispatchOnce()).toBe(true);
    scheduler.stop();
    await scheduler.waitForIdle();
    expect(scheduler.activeCount).toBe(0);
    // 中止按失败结算：预算内回 pending 等下次重试，冻结的来源边界不变。
    expect(h.a.get(wake.id)).toMatchObject({ status: "pending", errorCode: "BOT_STOPPED" });
  });

  it("onError 观察者自身抛错不阻断名额回收与排水", async () => {
    const h = fixture();
    const wake = offer(h, 0, "observer-throw");
    const scheduler = new WakeScheduler({
      repository: h.a,
      now: () => at,
      policy: () => ({ leaseMs: 60_000, renewMs: 30_000, retryDelayMs: 100, maxAttempts: 3 }),
      activate: async () => {
        throw Object.assign(new Error("private model response"), {
          code: "CONTEXT_MEMORY_BUDGET",
        });
      },
      onError: () => {
        throw new Error("fixture observer failure");
      },
    });
    expect(await scheduler.dispatchOnce()).toBe(true);
    await scheduler.waitForIdle();
    expect(scheduler.activeCount).toBe(0);
    expect(h.a.get(wake.id)).toMatchObject({
      status: "pending",
      errorCode: "CONTEXT_MEMORY_BUDGET",
    });
    scheduler.stop();
  });

  it("结算通知抛错不改写已完成唤醒的结算", async () => {
    const h = fixture();
    const wake = offer(h, 0, "notify-throw");
    const scheduler = new WakeScheduler({
      repository: h.a,
      now: () => at,
      policy: () => ({ leaseMs: 60_000, renewMs: 30_000, retryDelayMs: 100, maxAttempts: 3 }),
      activate: async (w) => {
        h.a.complete(w.id, w.leaseToken!, "no_output", w.throughSeq, at);
      },
      onSettled: () => {
        throw new Error("fixture notification failure");
      },
    });
    expect(await scheduler.dispatchOnce()).toBe(true);
    await scheduler.waitForIdle();
    expect(h.a.get(wake.id)).toMatchObject({ status: "no_output", errorCode: null });
    scheduler.stop();
  });
});
