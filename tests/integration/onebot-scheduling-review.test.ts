import { describe, expect, it, spyOn } from "bun:test";
import { BotWorker } from "../../src/server/conversation/bot-worker";
import { WakeScheduler } from "../../src/server/conversation/wake-scheduler";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { DEFAULT_AGENT_ID, ensureDefaults } from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { WakeRepository } from "../../src/server/db/wake-repository";
import { RuntimeTelemetry } from "../../src/server/observability/runtime-telemetry";
import { RuntimeSpanRepository } from "../../src/server/observability/span-repository";

describe("recoverable Bot scheduling faults", () => {
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
    h.db
      .query("INSERT INTO qq_schemes(id,name,created_at,updated_at) VALUES('scheme','fixture',?,?)")
      .run(at, at);
    h.db
      .query(
        "INSERT INTO qq_bindings(id,account_id,conversation_kind,peer_id,agent_id,scheme_id,created_at,updated_at) VALUES('binding','10001','group','30003',?,'scheme',?,?)",
      )
      .run(DEFAULT_AGENT_ID, at, at);
    const conversation = new ConversationEventRepository(h.db).ensureOneBot("binding")!;
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
