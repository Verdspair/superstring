import { afterEach, expect, it, mock, spyOn } from "bun:test";
import { WakeScheduler } from "../../src/server/conversation/wake-scheduler";
import { createRuntime } from "../../src/server/runtime";

afterEach(() => mock.restore());

it("lets timer and socket callbacks run while the production runtime drains immediately settled wakes", async () => {
  const limit = 300;
  let settled = 0;
  spyOn(WakeScheduler.prototype, "runOnce").mockImplementation(async () => ++settled < limit);
  const runtime = createRuntime({
    businessDbPath: ":memory:",
    browserStateSecret: "synthetic-yield-fixture-secret",
  });
  Object.defineProperty(runtime.qqIntake, "state", {
    value: { phase: "ready" },
    configurable: true,
  });
  let timer!: ReturnType<typeof setTimeout>;
  const observed = new Promise<number>((resolve) => {
    timer = setTimeout(() => resolve(settled), 0);
  });
  try {
    await runtime.botWorker.runCycle();
    expect(await observed).toBeLessThan(limit);
    expect(settled).toBeGreaterThanOrEqual(limit);
  } finally {
    clearTimeout(timer);
    await runtime.stop();
  }
});
