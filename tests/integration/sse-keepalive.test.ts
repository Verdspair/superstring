import { expect, it, spyOn } from "bun:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  createSseResponse,
  parseSseFrames,
  SSE_KEEPALIVE_INTERVAL_MS,
} from "../../src/server/api/sse";
import { createApp } from "../../src/server/app";
import {
  createSession,
  ensureDefaults,
  getTurnByRequest,
  listMessages,
} from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { ModelUnavailableError } from "../../src/server/errors";
import { localhostFetch, type ModelGateway } from "../../src/server/llm/model-gateway";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** Only intercept SSE heartbeats; generation lease/timeout timers stay real. */
function heartbeatClock() {
  const nativeInterval = globalThis.setInterval;
  const nativeClear = globalThis.clearInterval;
  const callbacks = new Map<ReturnType<typeof setInterval>, () => void>();
  const owned = new Set<ReturnType<typeof setInterval>>();
  let nextId = -1;
  const interval = spyOn(globalThis, "setInterval").mockImplementation(((
    callback: () => void,
    delay: number,
    ...args: unknown[]
  ) => {
    if (delay !== SSE_KEEPALIVE_INTERVAL_MS) return nativeInterval(callback, delay, ...args);
    const id = nextId-- as unknown as ReturnType<typeof setInterval>;
    callbacks.set(id, callback);
    owned.add(id);
    return id;
  }) as typeof setInterval);
  const clear = spyOn(globalThis, "clearInterval").mockImplementation(((
    id: ReturnType<typeof setInterval>,
  ) => {
    if (owned.has(id)) callbacks.delete(id);
    else nativeClear(id);
  }) as typeof clearInterval);
  return {
    callbacks,
    tick() {
      for (const callback of callbacks.values()) callback();
    },
    restore() {
      interval.mockRestore();
      clear.mockRestore();
    },
  };
}
const decoder = new TextDecoder();

it.each(["complete", "error", "reader_cancel", "request_abort"] as const)(
  "SSE comments preserve event frames and stop on %s",
  async (ending) => {
    const clock = heartbeatClock();
    const request = new AbortController();
    const gate = deferred();
    const original = new Error("fixture producer failed");
    let disconnected = 0;
    const response = createSseResponse(
      {
        requestSignal: request.signal,
        onDisconnect: () => {
          disconnected++;
          gate.reject(request.signal.reason ?? new DOMException("cancelled", "AbortError"));
        },
      },
      async (writer) => {
        writer.send("started", { seq: 1 });
        await gate.promise;
        writer.send("completed", { seq: 2 });
      },
    );
    if (!response.body) throw new Error("SSE response has no body");
    const reader = response.body.getReader();
    try {
      const start = decoder.decode((await reader.read()).value);
      const queuedTick = [...clock.callbacks.values()][0];
      if (!queuedTick) throw new Error("SSE response has no heartbeat timer");
      clock.tick();
      const heartbeat = decoder.decode((await reader.read()).value);
      expect(heartbeat).toBe(": keepalive\n\n");
      expect(parseSseFrames(start + heartbeat)).toEqual([{ event: "started", data: { seq: 1 } }]);
      if (ending === "complete") {
        gate.resolve();
        const terminal = decoder.decode((await reader.read()).value);
        expect(parseSseFrames(start + heartbeat + terminal).map((event) => event.data)).toEqual([
          { seq: 1 },
          { seq: 2 },
        ]);
        expect((await reader.read()).done).toBe(true);
      } else if (ending === "error") {
        gate.reject(original);
        await expect(reader.read()).rejects.toBe(original);
      } else if (ending === "reader_cancel") {
        await reader.cancel();
      } else {
        request.abort();
        expect((await reader.read()).done).toBe(true);
      }
      expect(disconnected).toBe(ending === "request_abort" || ending === "reader_cancel" ? 1 : 0);
      expect(clock.callbacks.size).toBe(0);
      // Even a callback queued before cleanup cannot enqueue into the closed body.
      expect(queuedTick).not.toThrow();
    } finally {
      request.abort();
      await reader.cancel().catch(() => {});
      clock.restore();
    }
  },
);

class WaitingGateway implements ModelGateway {
  config = { baseUrl: "http://unused", model: "model", timeoutSeconds: 1200 };
  entered = deferred();
  release = deferred();
  calls = 0;
  signal?: AbortSignal;
  async listModels() {
    return ["model"];
  }
  async loadedContextCapacity() {
    return 32768;
  }
  async probeModelLoaded() {
    return true;
  }
  async complete(input: Parameters<ModelGateway["complete"]>[0]) {
    this.calls++;
    this.signal = input.signal;
    this.entered.resolve();
    const aborted = () => this.release.reject(input.signal?.reason);
    input.signal?.addEventListener("abort", aborted, { once: true });
    if (input.signal?.aborted) aborted();
    try {
      await this.release.promise;
    } finally {
      input.signal?.removeEventListener("abort", aborted);
    }
    return JSON.stringify({
      kind: "final",
      outputs: [{ kind: "generate", targetId: "reply", instructions: "" }],
    });
  }
  async *streamChat() {
    yield "reply";
  }
}
function routeFixture() {
  const business = openBusinessDb();
  ensureDefaults(business.orm, "model");
  const gateway = new WaitingGateway();
  const session = createSession(business.orm, "fixture", { modelName: "model" });
  const app = createApp({ business, gateway });
  return { business, gateway, session, app };
}
function request(path: string, sessionId: string, signal?: AbortSignal) {
  return new Request(`http://fixture.local${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      session_id: sessionId,
      message: "question",
      client_request_id: "request",
    }),
    signal,
  });
}

for (const path of ["/chat", "/v2/chat"] as const) {
  it(`${path} keeps an idle decision alive without changing event ordering or completed replay`, async () => {
    const clock = heartbeatClock();
    const h = routeFixture();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await h.app.request(request(path, h.session.id));
      if (!response.body) throw new Error("SSE response has no body");
      reader = response.body.getReader();
      await h.gateway.entered.promise;
      expect(clock.callbacks.size).toBe(1);
      clock.tick();
      let raw = "";
      while (!raw.includes(": keepalive\n\n")) raw += decoder.decode((await reader.read()).value);
      expect(h.gateway.signal?.aborted).toBe(false);
      h.gateway.release.resolve();
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        raw += decoder.decode(chunk.value);
      }
      const frames = parseSseFrames(raw);
      if (path === "/chat")
        expect(frames.map((frame) => frame.event)).toEqual(["start", "delta", "done"]);
      else {
        const events = frames.map((frame) => frame.data as { type: string; seq: number });
        expect(events.map((event) => event.seq)).toEqual(events.map((_, i) => i + 1));
        expect(events[0]?.type).toBe("started");
        expect(events.at(-1)?.type).toBe("completed");
      }
      expect(
        listMessages(h.business.orm, h.session.id).find((message) => message.role === "assistant"),
      ).toMatchObject({ content: "reply", status: "completed" });
      expect(clock.callbacks.size).toBe(0);
      const replay = parseSseFrames(
        await (await h.app.request(request(path, h.session.id))).text(),
      );
      expect(replay.map((frame) => frame.event)).toEqual(
        path === "/chat" ? ["start", "delta", "done"] : ["replay"],
      );
      expect(h.gateway.calls).toBe(1);
      expect(clock.callbacks.size).toBe(0);
      expect(h.gateway.config.timeoutSeconds).toBe(1200);
    } finally {
      await reader?.cancel().catch(() => {});
      clock.restore();
      h.business.close();
    }
  });
  it.each(["reader_cancel", "request_abort", "model_error"] as const)(
    `${path} cleans heartbeats after %s and preserves the turn outcome`,
    async (ending) => {
      const clock = heartbeatClock();
      const h = routeFixture();
      const abort = new AbortController();
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      try {
        const response = await h.app.request(request(path, h.session.id, abort.signal));
        if (!response.body) throw new Error("SSE response has no body");
        reader = response.body.getReader();
        await h.gateway.entered.promise;
        expect(clock.callbacks.size).toBe(1);
        if (ending === "reader_cancel") await reader.cancel();
        else {
          if (ending === "request_abort") abort.abort();
          else
            h.gateway.release.reject(new ModelUnavailableError("MODEL_TIMEOUT", "fixture timeout"));
          let raw = "";
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            raw += decoder.decode(chunk.value);
          }
          if (ending === "model_error") {
            const terminal = parseSseFrames(raw).at(-1);
            expect(terminal?.event).toBe(path === "/chat" ? "error" : "failed");
            expect(terminal?.data).toMatchObject({ code: "MODEL_TIMEOUT" });
          }
        }
        expect(getTurnByRequest(h.business.orm, h.session.id, "request")?.generationStatus).toBe(
          ending === "model_error" ? "failed" : "cancelled",
        );
        expect(clock.callbacks.size).toBe(0);
        if (ending !== "model_error") expect(h.gateway.signal?.aborted).toBe(true);
      } finally {
        abort.abort();
        await reader?.cancel().catch(() => {});
        clock.restore();
        h.business.close();
      }
    },
  );
}

it("keeps a real Bun response open beyond an accelerated idle timeout", async () => {
  // The server runs in its own process: other files of this suite replace the global
  // timers and proxy environment while they run, which starves a real server here
  // (keepalive intervals never fire and the idle timeout closes the stream).
  const probe = `
import { createSseResponse } from ${JSON.stringify(
    pathToFileURL(join(import.meta.dir, "../../src/server/api/sse.ts")).href,
  )};
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 1,
  fetch(req) {
    const abort = new AbortController();
    return createSseResponse(
      { requestSignal: req.signal, onDisconnect: () => abort.abort(), keepaliveIntervalMs: 100 },
      async (writer) => {
        writer.send("started", { seq: 1 });
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            abort.signal.removeEventListener("abort", cancelled);
            resolve();
          }, 2500);
          const cancelled = () => {
            clearTimeout(timer);
            reject(abort.signal.reason);
          };
          abort.signal.addEventListener("abort", cancelled, { once: true });
        });
        writer.send("completed", { seq: 2 });
      },
    );
  },
});
console.log(String(server.port));
`;
  const child = Bun.spawn({
    cmd: [process.execPath, "-e", probe],
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const decoder = new TextDecoder();
    let printed = "";
    const reader = child.stdout.getReader();
    while (!printed.includes("\n")) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("SSE probe exited before reporting its port");
      printed += decoder.decode(chunk.value);
    }
    // Probe like the server talks to the local model: the loopback call bypasses any
    // ambient proxy, and only performance.now/AbortSignal.timeout are needed here.
    const port = Number(printed.trim().split("\n")[0]);
    const started = performance.now();
    const response = await localhostFetch(`http://127.0.0.1:${port}`, {
      signal: AbortSignal.timeout(8000),
    });
    const body = await response.text();
    expect(performance.now() - started).toBeGreaterThan(2000);
    expect(body.match(/: keepalive\n\n/g)?.length).toBeGreaterThan(5);
    expect(parseSseFrames(body)).toEqual([
      { event: "started", data: { seq: 1 } },
      { event: "completed", data: { seq: 2 } },
    ]);
  } finally {
    child.kill();
    await child.exited;
  }
}, 15000);
