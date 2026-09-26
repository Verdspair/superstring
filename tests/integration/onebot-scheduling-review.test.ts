import { describe, expect, it, spyOn } from "bun:test";
import { BotWorker } from "../../src/server/conversation/bot-worker";
import { WakeScheduler } from "../../src/server/conversation/wake-scheduler";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { DEFAULT_AGENT_ID, ensureDefaults } from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { WakeRepository } from "../../src/server/db/wake-repository";
import { RuntimeTelemetry } from "../../src/server/observability/runtime-telemetry";
import { RuntimeSpanRepository } from "../../src/server/observability/span-repository";

function botConversation(h: ReturnType<typeof openBusinessDb>, at: string) {
  h.db
    .query("INSERT INTO qq_schemes(id,name,created_at,updated_at) VALUES('scheme','fixture',?,?)")
    .run(at, at);
  h.db
    .query(
      "INSERT INTO qq_bindings(id,account_id,conversation_kind,peer_id,agent_id,scheme_id,created_at,updated_at) VALUES('binding','10001','group','30003',?,'scheme',?,?)",
    )
    .run(DEFAULT_AGENT_ID, at, at);
  return new ConversationEventRepository(h.db).ensureOneBot("binding")!;
}

describe("recoverable Bot scheduling faults", () => {
  it("releases the scheduler after a policy read fails so the next attempt can claim work", async () => {
    const h = openBusinessDb();
    ensureDefaults(h.orm, "fixture");
    const at = new Date().toISOString();
    const conversation = botConversation(h, at);
    const wakes = new WakeRepository(h.db);
    const wake = wakes.enqueue({
      conversationId: conversation.id,
      cause: "direct_reply",
      throughSeq: 1,
      dedupeKey: "policy-recovery",
      readyAt: at,
      priority: 100,
      at,
    });
    const fault = new Error("fixture configuration read failed");
    let reads = 0,
      activations = 0;
    const scheduler = new WakeScheduler({
      repository: wakes,
      now: () => at,
      policy: () => {
        if (++reads === 1) throw fault;
        return { leaseMs: 1000, renewMs: 500, retryDelayMs: 100, maxAttempts: 3 };
      },
      activate: async (claimed) => {
        activations++;
        wakes.complete(claimed.id, claimed.leaseToken!, "no_output", claimed.throughSeq, at);
      },
    });
    try {
      await expect(scheduler.runOnce()).rejects.toBe(fault);
      expect(wakes.get(wake.id)?.status).toBe("pending");
      expect(await scheduler.runOnce()).toBe(true);
      expect(activations).toBe(1);
      expect(wakes.get(wake.id)?.status).toBe("no_output");
    } finally {
      scheduler.stop();
      h.close();
    }
  });
  it.each(["deadline", "transport"] as const)(
    "reports a %s lookup failure and recovers on normal polling",
    async (failurePoint) => {
      let cycles = 0,
        checks = 0,
        deadlineReads = 0,
        clock = 0;
      const errors: unknown[] = [];
      const fault = new Error("fixture deadline lookup failed");
      const scheduled = new Map<number, { callback: () => void; delay: number }>();
      let timerId = 0;
      const timer = spyOn(globalThis, "setTimeout").mockImplementation(((
        callback: () => void,
        delay: number,
      ) => {
        const id = ++timerId;
        scheduled.set(id, { callback, delay });
        return id;
      }) as unknown as typeof setTimeout);
      const clear = spyOn(globalThis, "clearTimeout").mockImplementation(((id: number) => {
        scheduled.delete(id);
      }) as unknown as typeof clearTimeout);
      const flush = async () => {
        for (let i = 0; i < 15; i++) await Promise.resolve();
      };
      const fire = () => {
        const [id, value] = [...scheduled.entries()][0]!;
        scheduled.delete(id);
        value.callback();
      };
      const worker = new BotWorker({
        sweep: () => {
          cycles++;
        },
        advance: async () => {},
        canAdvance: () => {
          // The second lookup is the sleep/deadline path, after the successful cycle.
          if (++checks === 2 && failurePoint === "transport") throw fault;
          return true;
        },
        nextReadyAt: () => {
          if (++deadlineReads === 1 && failurePoint === "deadline") throw fault;
          return new Date(16000).toISOString();
        },
        clockSeconds: () => clock,
        pollIntervalMs: 15000,
        onError: (error) => {
          errors.push(error);
        },
      });
      try {
        worker.start();
        await flush();
        expect(errors).toEqual([fault]);
        expect(cycles).toBe(1);
        expect([...scheduled.values()].map((t) => t.delay)).toEqual([15000]);
        clock = 15;
        fire();
        await flush();
        expect(cycles).toBe(2);
        expect([...scheduled.values()].map((t) => t.delay)).toEqual([1000]);
        worker.wake();
        await flush();
        expect(cycles).toBe(3);
        expect([...scheduled.values()].map((t) => t.delay)).toEqual([0]);
      } finally {
        // A queued zero-delay notification also belongs to the loop being drained.
        if ([...scheduled.values()][0]?.delay === 0) fire();
        await worker.stop();
        timer.mockRestore();
        clear.mockRestore();
      }
    },
  );

  it("closes activation telemetry when failure settlement itself fails and preserves lease recovery", async () => {
    const h = openBusinessDb();
    ensureDefaults(h.orm, "fixture");
    let at = "2030-01-01T00:00:00.000Z";
    const conversation = botConversation(h, at);
    const wakes = new WakeRepository(h.db);
    const wake = wakes.enqueue({
      conversationId: conversation.id,
      cause: "direct_reply",
      throughSeq: 1,
      dedupeKey: "fixture-wake",
      readyAt: at,
      priority: 100,
      at,
    });
    const telemetry = new RuntimeTelemetry(h.db);
    const spans = new RuntimeSpanRepository(h.db);
    const scheduler = new WakeScheduler({
      repository: wakes,
      telemetry,
      now: () => at,
      policy: () => ({ leaseMs: 1000, renewMs: 500, retryDelayMs: 100, maxAttempts: 3 }),
      activate: async () => {
        throw Object.assign(new Error("fixture activation failed"), {
          code: "MODEL_FIXTURE_FAILED",
        });
      },
    });
    try {
      h.db.exec(
        "CREATE TRIGGER reject_wake_failure BEFORE UPDATE OF status ON wake_signals WHEN NEW.error_code='MODEL_FIXTURE_FAILED' BEGIN SELECT RAISE(ABORT,'fixture settlement failure'); END",
      );
      await expect(scheduler.runOnce()).rejects.toThrow("fixture settlement failure");
      expect(wakes.get(wake.id)).toMatchObject({ status: "leased", attempts: 1 });
      const activation = spans.page({}).items.find((span) => span.name === "bot.wake.activate")!;
      expect(activation).toMatchObject({ status: "failed", code: "MODEL_FIXTURE_FAILED" });
      expect(spans.page({}).summary.active).toBe(0);
      h.db.exec("DROP TRIGGER reject_wake_failure");
      at = "2030-01-01T00:00:01.100Z";
      expect(await scheduler.runOnce()).toBe(false);
      expect(wakes.get(wake.id)).toMatchObject({
        status: "pending",
        errorCode: "WAKE_INTERRUPTED",
        attempts: 1,
      });
      at = "2030-01-01T00:00:01.200Z";
      expect(await scheduler.runOnce()).toBe(true);
      expect(wakes.get(wake.id)).toMatchObject({
        status: "pending",
        errorCode: "MODEL_FIXTURE_FAILED",
        attempts: 2,
      });
      expect(spans.page({}).summary.active).toBe(0);
    } finally {
      scheduler.stop();
      await telemetry.close();
      h.close();
    }
  });
});

it.each(["policy", "renewal"] as const)(
  "cancels safely after a %s failure in the renewal timer and can retry later",
  async (failurePoint) => {
    const h = openBusinessDb();
    ensureDefaults(h.orm, "fixture");
    let at = "2030-01-01T00:00:00.000Z";
    const conversation = botConversation(h, at);
    const wakes = new WakeRepository(h.db);
    const wake = wakes.enqueue({
      conversationId: conversation.id,
      cause: "direct_reply",
      throughSeq: 1,
      dedupeKey: "renewal-fault",
      readyAt: at,
      priority: 100,
      at,
    });
    const telemetry = new RuntimeTelemetry(h.db);
    const spans = new RuntimeSpanRepository(h.db);
    let tick: (() => void) | undefined;
    const timer = spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void) => {
      tick = callback;
      return 17;
    }) as unknown as typeof setInterval);
    const clear = spyOn(globalThis, "clearInterval").mockImplementation(() => {});
    const policyFault = new Error("fixture renewal policy read failed");
    const errors: unknown[] = [];
    let reads = 0,
      activations = 0,
      activeSignal: AbortSignal | undefined;
    const scheduler = new WakeScheduler({
      repository: wakes,
      telemetry,
      now: () => at,
      policy: () => {
        if (++reads === 2 && failurePoint === "policy") throw policyFault;
        return { leaseMs: 1000, renewMs: 500, retryDelayMs: 100, maxAttempts: 3 };
      },
      activate: async (claimed, signal) => {
        if (++activations === 1) {
          activeSignal = signal;
          await new Promise<void>((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => reject(new DOMException("aborted", "AbortError")),
              { once: true },
            );
          });
        }
        wakes.complete(claimed.id, claimed.leaseToken!, "no_output", claimed.throughSeq, at);
      },
      onError: (error) => {
        errors.push(error);
      },
    });
    let running: Promise<boolean> | undefined;
    try {
      running = scheduler.runOnce();
      if (failurePoint === "renewal")
        h.db.exec(
          "CREATE TRIGGER reject_renewal BEFORE UPDATE OF lease_expires_at ON wake_signals WHEN OLD.status='leased' AND NEW.status='leased' BEGIN SELECT RAISE(ABORT,'fixture lease write failed'); END",
        );
      expect(tick).toBeDefined();
      expect(() => tick?.()).not.toThrow();
      expect(activeSignal?.aborted).toBe(true);
      const reason = activeSignal?.reason as Error & { code: string };
      expect(reason).toMatchObject({ message: "WAKE_RENEWAL_FAILED", code: "WAKE_RENEWAL_FAILED" });
      if (failurePoint === "policy") expect(reason.cause).toBe(policyFault);
      else expect(reason.cause).toMatchObject({ message: "fixture lease write failed" });
      expect(await running).toBe(true);
      expect(errors).toEqual([reason]);
      expect(wakes.get(wake.id)).toMatchObject({
        status: "pending",
        errorCode: "WAKE_RENEWAL_FAILED",
        attempts: 1,
      });
      expect(spans.page({}).items.find((span) => span.name === "bot.wake.activate")).toMatchObject({
        status: "failed",
        code: "WAKE_RENEWAL_FAILED",
      });
      expect(spans.page({}).summary.active).toBe(0);
      expect(clear).toHaveBeenCalledWith(17);
      // Cancellation does not immediately replay the attempt or bypass its retry delay.
      expect(await scheduler.runOnce()).toBe(false);
      expect(activations).toBe(1);
      if (failurePoint === "renewal") h.db.exec("DROP TRIGGER reject_renewal");
      at = "2030-01-01T00:00:00.100Z";
      expect(await scheduler.runOnce()).toBe(true);
      expect(activations).toBe(2);
      expect(wakes.get(wake.id)).toMatchObject({ status: "no_output", attempts: 2 });
      expect(spans.page({}).summary.active).toBe(0);
    } finally {
      scheduler.stop();
      await running;
      timer.mockRestore();
      clear.mockRestore();
      await telemetry.close();
      h.close();
    }
  },
);
