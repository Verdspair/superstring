import { describe, expect, it, spyOn } from "bun:test";
import { BotWorker } from "../../src/server/conversation/bot-worker";

describe("neutral Bot worker lifecycle", () => {
  it("finishes shutdown when a concurrent manual cycle fails", async () => {
    let reject!: (error: Error) => void;
    const pending = new Promise<void>((_resolve, fail) => {
      reject = fail;
    });
    const worker = new BotWorker({ sweep() {}, canAdvance: () => true, advance: () => pending });
    const cycle = worker.runCycle();
    await Promise.resolve();
    const stopping = worker.stop();
    reject(new Error("fixture cycle failure"));
    await expect(cycle).rejects.toThrow("fixture cycle failure");
    await stopping;
    await worker.runCycle();
  });
  it("sweeps offline but only advances with a ready transport", async () => {
    let sweeps = 0,
      advances = 0,
      ready = false;
    const worker = new BotWorker({
      sweep: () => {
        sweeps++;
      },
      advance: async () => {
        advances++;
      },
      canAdvance: () => ready,
    });
    await worker.runCycle();
    expect([sweeps, advances]).toEqual([1, 0]);
    ready = true;
    await worker.runCycle();
    expect([sweeps, advances]).toEqual([2, 1]);
    await worker.stop();
    await worker.runCycle();
    expect([sweeps, advances]).toEqual([2, 1]);
  });
  it("shares an active cycle and waits for it before shutdown", async () => {
    let release!: () => void,
      advanced = 0,
      stopped = false;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    const worker = new BotWorker({
      sweep() {},
      canAdvance: () => true,
      advance: async () => {
        advanced++;
        await blocker;
      },
    });
    const one = worker.runCycle(),
      two = worker.runCycle();
    expect(one).toBe(two);
    await Promise.resolve();
    const stopping = worker.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(advanced).toBe(1);
  });
  it("handles incoming wake during an active cycle without waiting the poll interval", async () => {
    let worker: BotWorker,
      calls = 0,
      finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    worker = new BotWorker({
      sweep() {},
      pollIntervalMs: 60_000,
      canAdvance: () => true,
      advance: async () => {
        calls++;
        if (calls === 1) worker.wake();
        else finish();
      },
    });
    worker.start();
    worker.start();
    await done;
    await worker.stop();
    worker.start();
    expect(calls).toBe(2);
  });
  it("reports one failure then accepts the next wake", async () => {
    let worker: BotWorker,
      calls = 0,
      errors = 0,
      finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    worker = new BotWorker({
      sweep() {},
      canAdvance: () => true,
      pollIntervalMs: 60_000,
      advance: async () => {
        if (++calls === 1) throw new Error("fixture");
        finish();
      },
      onError: () => {
        errors++;
        worker.wake();
      },
    });
    worker.start();
    await done;
    await worker.stop();
    expect([calls, errors]).toEqual([2, 1]);
  });
});

it("keeps the nearest durable deadline when another participant wakes the worker, and polls while offline", async () => {
  let clock = 0,
    online = true,
    calls = 0;
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
    sweep() {},
    advance: async () => {
      calls++;
    },
    canAdvance: () => online,
    clockSeconds: () => clock,
    nextReadyAt: () => new Date(15000).toISOString(),
    pollIntervalMs: 15000,
  });
  try {
    worker.start();
    await flush();
    expect([...scheduled.values()].map((t) => t.delay)).toEqual([15000]);
    clock = 14;
    worker.wake();
    await flush();
    // The notification cycle yields to I/O before its next check.
    expect([...scheduled.values()].map((t) => t.delay)).toEqual([0]);
    fire();
    await flush();
    expect([...scheduled.values()].map((t) => t.delay)).toEqual([1000]);
    clock = 15;
    fire();
    await flush();
    expect(calls).toBeGreaterThanOrEqual(3);
    // A ready deadline with no claimable work must not produce zero-delay spinning.
    expect([...scheduled.values()].map((t) => t.delay)).toEqual([15000]);
    online = false;
    clock = 14;
    worker.wake();
    await flush();
    fire();
    await flush();
    expect([...scheduled.values()].map((t) => t.delay)).toEqual([15000]);
  } finally {
    await worker.stop();
    timer.mockRestore();
    clear.mockRestore();
  }
});
