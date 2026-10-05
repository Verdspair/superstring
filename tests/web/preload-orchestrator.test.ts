import { describe, expect, it } from "vitest";
import type { ChunkPreloadItem } from "../../src/web/state/preload-orchestrator";
import { startChunkPreload } from "../../src/web/state/preload-orchestrator";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function makePump() {
  const pumps: Array<() => void> = [];
  const cancels: number[] = [];
  const scheduleIdle = (callback: () => void) => {
    const entry = () => {
      callback();
    };
    pumps.push(entry);
    cancels.push(0);
    return () => {
      const index = pumps.indexOf(entry);
      if (index >= 0) pumps.splice(index, 1);
      cancels.push(1);
    };
  };
  return {
    pumps,
    cancels,
    scheduleIdle,
    fire: (index: number) => {
      const entry = pumps[index];
      if (entry) entry();
    },
  };
}

function gatedItems(count: number, order: string[]) {
  const gates = Array.from({ length: count }, () => {
    let resolve!: () => void;
    const promise = new Promise<void>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  });
  const items: ChunkPreloadItem[] = gates.map((gate, index) => ({
    id: `space-${index}`,
    loadChunk: () => {
      order.push(`space-${index}`);
      return gate.promise;
    },
  }));
  return { gates, items };
}

describe("startChunkPreload", () => {
  it("dispatches nothing until the idle callback fires, then drains the queue under the concurrency limit", async () => {
    const pump = makePump();
    const order: string[] = [];
    const { gates, items } = gatedItems(4, order);
    startChunkPreload({ items, concurrency: 2, scheduleIdle: pump.scheduleIdle });
    expect(order).toEqual([]);

    pump.fire(0);
    await flush();
    expect(order).toEqual(["space-0", "space-1"]);

    // Settling one slot re-schedules the next idle tick rather than refilling synchronously.
    gates[0].resolve();
    await flush();
    expect(order).toEqual(["space-0", "space-1"]);
    pump.fire(pump.pumps.length - 1);
    await flush();
    expect(order).toEqual(["space-0", "space-1", "space-2"]);

    gates[1].resolve();
    gates[2].resolve();
    gates[3].resolve();
    await flush();
    pump.fire(pump.pumps.length - 1);
    await flush();
    expect(order).toEqual(["space-0", "space-1", "space-2", "space-3"]);
  });

  it("pauses dispatch while hidden, resumes on the visibilitychange event, and keeps the queue", async () => {
    const pump = makePump();
    let visible = false;
    const target = new EventTarget();
    const order: string[] = [];
    const { gates, items } = gatedItems(1, order);
    startChunkPreload({
      items,
      concurrency: 2,
      scheduleIdle: pump.scheduleIdle,
      isDocumentVisible: () => visible,
      visibilityTarget: target,
    });
    // Hidden at startup: no idle pump is scheduled at all.
    expect(pump.pumps).toHaveLength(0);
    expect(order).toEqual([]);

    visible = true;
    target.dispatchEvent(new Event("visibilitychange"));
    await flush();
    expect(pump.pumps.length).toBeGreaterThanOrEqual(1);
    pump.fire(pump.pumps.length - 1);
    await flush();
    expect(order).toEqual(["space-0"]);
    gates[0].resolve();
  });

  it("cancel() stops queued dispatches but never aborts an in-flight chunk load", async () => {
    const pump = makePump();
    const order: string[] = [];
    const { gates, items } = gatedItems(2, order);
    const handle = startChunkPreload({
      items,
      concurrency: 1,
      scheduleIdle: pump.scheduleIdle,
    });
    pump.fire(0);
    await flush();
    expect(order).toEqual(["space-0"]);

    handle.cancel();
    // The in-flight load is not aborted: it settles naturally.
    gates[0].resolve();
    await flush();
    expect(order).toEqual(["space-0"]);

    // No further pump (fresh or stale) dispatches queued items after cancel.
    pump.fire(0);
    await flush();
    expect(order).toEqual(["space-0"]);
  });

  it("keeps draining after a chunk load fails: the failed entry does not block later items", async () => {
    const pump = makePump();
    const order: string[] = [];
    const failing = {
      promise: Promise.reject(new Error("chunk eval failed")).catch(() => undefined),
    };
    const ok = { promise: Promise.resolve() };
    const items: ChunkPreloadItem[] = [
      {
        id: "broken",
        loadChunk: () => {
          order.push("broken");
          return failing.promise;
        },
      },
      {
        id: "healthy",
        loadChunk: () => {
          order.push("healthy");
          return ok.promise;
        },
      },
    ];
    startChunkPreload({ items, concurrency: 1, scheduleIdle: pump.scheduleIdle });
    pump.fire(0);
    await flush();
    expect(order).toEqual(["broken"]);
    pump.fire(pump.pumps.length - 1);
    await flush();
    expect(order).toEqual(["broken", "healthy"]);
  });
});
