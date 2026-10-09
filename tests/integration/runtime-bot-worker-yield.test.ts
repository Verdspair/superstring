import { afterEach, expect, it, mock, spyOn } from "bun:test";
import { WakeScheduler } from "../../src/server/conversation/wake-scheduler";
import { createRuntime } from "../../src/server/runtime";

afterEach(() => mock.restore());

it("lets timer callbacks run while the production runtime dispatches wakes without awaiting models", async () => {
  let dispatched = 0;
  spyOn(WakeScheduler.prototype, "dispatchOnce").mockImplementation(async () => {
    dispatched += 1;
    return dispatched <= 3;
  });
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
    timer = setTimeout(() => resolve(dispatched), 0);
  });
  try {
    await runtime.botWorker.runCycle();
    // 计时器回调在派发车道让出 I/O 时就跑到了：短 tick 没有被后台车道堵死。
    const duringCycle = await observed;
    expect(duringCycle).toBeLessThan(dispatched);
    expect(dispatched).toBeGreaterThanOrEqual(3);
    // 结算通知后的下一轮短 tick 仍只派发不等模型。
    await runtime.botWorker.runCycle();
    expect(dispatched).toBeGreaterThan(duringCycle);
  } finally {
    clearTimeout(timer);
    await runtime.stop();
  }
});
