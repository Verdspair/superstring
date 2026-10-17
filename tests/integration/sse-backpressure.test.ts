import { expect, it, spyOn } from "bun:test";
import { createSseResponse, SSE_KEEPALIVE_INTERVAL_MS } from "../../src/server/api/sse";
import { parseSseFrames } from "../harness/sse";

const settle = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

it("backs up a sequential 1000-frame producer at demand and preserves all frame order", async () => {
  const abort = new AbortController();
  let accepted = 0;
  const response = createSseResponse(
    { requestSignal: abort.signal, onDisconnect: () => {} },
    async (writer) => {
      for (let seq = 0; seq < 1000; seq++) {
        await writer.send("item", { seq });
        accepted++;
      }
    },
  );
  await settle();
  expect(accepted).toBe(1);
  const reader = response.body!.getReader();
  let raw = "";
  const decoder = new TextDecoder();
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    raw += decoder.decode(chunk.value);
  }
  expect(accepted).toBe(1000);
  expect(parseSseFrames(raw).map((frame) => frame.data)).toEqual(
    Array.from({ length: 1000 }, (_, seq) => ({ seq })),
  );
});

it.each(["reader_cancel", "request_abort"] as const)(
  "settles a capacity-blocked send on %s without a further pull",
  async (ending) => {
    const abort = new AbortController();
    let disconnected = 0;
    let finished = false;
    const response = createSseResponse(
      {
        requestSignal: abort.signal,
        onDisconnect: () => {
          disconnected++;
        },
      },
      async (writer) => {
        await writer.send("first", {});
        await writer.send("blocked", {});
        await writer.send("late", {});
        finished = true;
      },
    );
    await settle();
    expect(finished).toBe(false);
    const reader = response.body!.getReader();
    if (ending === "reader_cancel") await reader.cancel();
    else {
      abort.abort();
      await settle();
    }
    expect(finished).toBe(true);
    expect(disconnected).toBe(1);
    abort.abort();
    if (ending === "request_abort") {
      const queued = await reader.read();
      expect(parseSseFrames(new TextDecoder().decode(queued.value))).toEqual([
        { event: "first", data: {} },
      ]);
      expect((await reader.read()).done).toBe(true);
    }
    await reader.cancel();
    expect(disconnected).toBe(1);
  },
);

it("skips heartbeat ticks without demand and never delays a pending business frame", async () => {
  let tick: (() => void) | undefined;
  const native = globalThis.setInterval;
  const interval = spyOn(globalThis, "setInterval").mockImplementation(((
    callback: () => void,
    delay: number,
  ) => {
    if (delay !== SSE_KEEPALIVE_INTERVAL_MS) return native(callback, delay);
    tick = callback;
    return -1 as unknown as ReturnType<typeof setInterval>;
  }) as typeof setInterval);
  const abort = new AbortController();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const response = createSseResponse(
    {
      requestSignal: abort.signal,
      onDisconnect: () => {
        release();
      },
    },
    async (writer) => {
      await writer.send("first", {});
      await writer.send("second", {});
      await gate;
    },
  );
  const reader = response.body!.getReader();
  try {
    await settle();
    for (let i = 0; i < 1000; i++) tick?.();
    expect(parseSseFrames(new TextDecoder().decode((await reader.read()).value))[0]?.event).toBe(
      "first",
    );
    expect(parseSseFrames(new TextDecoder().decode((await reader.read()).value))[0]?.event).toBe(
      "second",
    );
    await settle();
    tick?.();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(": keepalive\n\n");
  } finally {
    abort.abort();
    await reader.cancel();
    interval.mockRestore();
  }
});

it.each(["reader_cancel", "request_abort"] as const)(
  "handles %s before the initial ready is consumed",
  async (ending) => {
    const abort = new AbortController();
    let disconnected = 0;
    const response = createSseResponse(
      {
        requestSignal: abort.signal,
        onDisconnect: () => {
          disconnected++;
        },
      },
      async (writer) => {
        await writer.send("ready", {});
        await writer.send("changed", {});
      },
    );
    const reader = response.body!.getReader();
    if (ending === "reader_cancel") await reader.cancel();
    else {
      abort.abort();
      const ready = await reader.read();
      expect(parseSseFrames(new TextDecoder().decode(ready.value))).toEqual([
        { event: "ready", data: {} },
      ]);
      expect((await reader.read()).done).toBe(true);
    }
    expect(disconnected).toBe(1);
  },
);
