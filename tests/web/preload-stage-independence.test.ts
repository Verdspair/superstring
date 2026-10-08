import { describe, expect, it } from "vitest";
import type { ChunkPreloadItem } from "../../src/web/state/preload-orchestrator";
import { startChunkPreload } from "../../src/web/state/preload-orchestrator";

function makePump() {
  const pending: Array<() => void> = [];
  return {
    pending,
    scheduleIdle: (callback: () => void) => {
      pending.push(callback);
      return () => {};
    },
    fireNext: () => pending.shift()?.(),
  };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("startup chunk and data preload stages", () => {
  it("continues loading chunks while two independent data prewarms are pending", async () => {
    const pump = makePump();
    const slowA = deferred();
    const slowB = deferred();
    const chunkStarted: string[] = [];
    const dataStarted: string[] = [];
    const dataDone: string[] = [];
    const item = (id: string, gate?: ReturnType<typeof deferred>): ChunkPreloadItem => ({
      id,
      loadChunk: async () => {
        chunkStarted.push(id);
      },
      ...(gate && {
        loadData: async () => {
          dataStarted.push(id);
          await gate.promise;
          dataDone.push(id);
        },
      }),
    });

    const handle = startChunkPreload({
      items: [item("A", slowA), item("B", slowB), item("C"), item("D")],
      concurrency: 2,
      scheduleIdle: pump.scheduleIdle,
    });
    pump.fireNext();
    await flush();
    while (pump.pending.length > 0) {
      pump.fireNext();
      await flush();
    }

    const observed = {
      chunkStarted: [...chunkStarted],
      dataStarted: [...dataStarted],
      dataDone: [...dataDone],
    };
    slowA.resolve();
    slowB.resolve();
    await flush();
    handle.cancel();

    expect(observed).toEqual({
      chunkStarted: ["A", "B", "C", "D"],
      dataStarted: ["A", "B"],
      dataDone: [],
    });
  });
});
