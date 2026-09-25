import { describe, expect, it } from "bun:test";
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
