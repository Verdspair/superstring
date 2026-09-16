import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Server } from "node:http";
import http from "node:http";
import { createLmStudioClient } from "../../src/server/llm/model-gateway";
import { createRuntime } from "../../src/server/runtime";

// Regression test for the loopback-proxy bug: on machines where HTTP_PROXY is
// set and NO_PROXY is unset, Bun's global `fetch` routes even 127.0.0.1 traffic
// through the proxy. We point HTTP_PROXY at a DEAD proxy so any proxied loopback
// call fails ("Unable to connect"), then assert the local model service is still
// reached directly. With the fix (localhostFetch -> node:http) the calls bypass
// the proxy and pass; with the old `fetch` they would throw and this test fails.
let server: Server;
let port = 0;

const saved = {
  HTTP_PROXY: process.env.HTTP_PROXY,
  HTTPS_PROXY: process.env.HTTPS_PROXY,
  NO_PROXY: process.env.NO_PROXY,
  no_proxy: process.env.no_proxy,
};

beforeAll(async () => {
  process.env.HTTP_PROXY = "http://127.0.0.1:1"; // dead: nothing listening
  process.env.HTTPS_PROXY = "http://127.0.0.1:1";
  delete process.env.NO_PROXY;
  delete process.env.no_proxy;

  server = http.createServer((req, res) => {
    if (req.url?.startsWith("/v1/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "test/model" }] }));
      return;
    }
    if (req.url?.startsWith("/v1/chat/completions")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n');
      res.write("data: [DONE]\n");
      res.end();
      return;
    }
    // /api/v1/models (capacity probe) is intentionally not matched -> 404
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  port = (server.address() as { port: number }).port;
});

afterAll(() => {
  server?.close();
  if (saved.HTTP_PROXY === undefined) delete process.env.HTTP_PROXY;
  else process.env.HTTP_PROXY = saved.HTTP_PROXY;
  if (saved.HTTPS_PROXY === undefined) delete process.env.HTTPS_PROXY;
  else process.env.HTTPS_PROXY = saved.HTTPS_PROXY;
  if (saved.NO_PROXY) process.env.NO_PROXY = saved.NO_PROXY;
  else delete process.env.NO_PROXY;
  if (saved.no_proxy) process.env.no_proxy = saved.no_proxy;
  else delete process.env.no_proxy;
});

const client = () =>
  createLmStudioClient({
    baseUrl: `http://127.0.0.1:${port}/v1`,
    model: "test/model",
    timeoutSeconds: 5,
  });

describe("model gateway bypasses HTTP_PROXY for loopback", () => {
  it("listModels reaches the loopback stub despite a dead HTTP_PROXY", async () => {
    const models = await client().listModels();
    expect(models).toContain("test/model");
  });

  it("streamChat reaches the loopback stub despite a dead HTTP_PROXY", async () => {
    const chunks: string[] = [];
    for await (const c of client().streamChat({ messages: [{ role: "user", content: "hi" }] })) {
      chunks.push(c);
    }
    expect(chunks.join("")).toBe("hi");
  });

  it("loadedContextCapacity reaches the loopback stub despite a dead HTTP_PROXY", async () => {
    // stub returns 404 for /api/v1/models -> null capacity (must reach stub, not proxy)
    const cap = await client().loadedContextCapacity("test/model");
    expect(cap).toBeNull();
  });
});

// Real transport fixtures: headers arrive, then the response body stalls.
async function withBodyStub(
  mode: "stall" | "stream" | "disconnect" | "invalid" | "ok",
  check: (
    gateway: ReturnType<typeof createLmStudioClient>,
    received: Promise<void>,
  ) => Promise<void>,
) {
  let notify = () => {};
  const received = new Promise<void>((resolve) => {
    notify = resolve;
  });
  const sockets = new Set<import("node:net").Socket>();
  const stub = http.createServer((_req, res) => {
    res.writeHead(200, {
      "content-type": mode === "stream" ? "text/event-stream" : "application/json",
    });
    if (mode === "ok") res.end('{"choices":[{"finish_reason":"stop","message":{"content":"ok"}}]}');
    else if (mode === "invalid") res.end("invalid json");
    else {
      res.write(
        mode === "stream" ? 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n' : '{"data":[',
      );
      if (mode === "disconnect") setTimeout(() => res.destroy(), 40);
    }
    notify();
  });
  stub.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
  const gateway = createLmStudioClient({
    baseUrl: `http://127.0.0.1:${(stub.address() as { port: number }).port}/v1`,
    model: "test/model",
    timeoutSeconds: 0.2,
  });
  try {
    await check(gateway, received);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => stub.close(() => resolve()));
  }
}

const messages = [{ role: "user", content: "hi" }];
describe("model response body error lifecycle", () => {
  it("maps post-header list timeout through the real HTTP error handler", async () => {
    await withBodyStub("stall", async (gateway) => {
      const runtime = createRuntime({
        businessDbPath: ":memory:",
        gateway,
        browserStateSecret: "synthetic-review-secret",
      });
      try {
        const response = await runtime.app.request("/models/local");
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({ error: { code: "MODEL_TIMEOUT" } });
      } finally {
        await runtime.stop();
      }
    });
  });
  it("maps complete body timeout", async () => {
    await withBodyStub("stall", async (gateway) => {
      await expect(gateway.complete({ messages })).rejects.toMatchObject({ code: "MODEL_TIMEOUT" });
    });
  });
  it("probe waits for the body instead of falsely reporting ready at headers", async () => {
    await withBodyStub("stall", async (gateway) => {
      await expect(gateway.probeModelLoaded()).rejects.toMatchObject({ code: "MODEL_TIMEOUT" });
    });
  });
  it("preserves a first delta then maps streaming body timeout", async () => {
    await withBodyStub("stream", async (gateway) => {
      const stream = gateway.streamChat({ messages });
      expect((await stream.next()).value).toBe("hi");
      // Bun 1.4.2 can crash in its rejection matcher during a real stream timeout.
      // Capture the same outcome explicitly: unexpected success is null and fails.
      const failure = await stream.next().then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toMatchObject({ code: "MODEL_TIMEOUT" });
    });
  });
  for (const kind of ["complete", "stream", "capacity"] as const) {
    it(`preserves caller cancellation during ${kind} body consumption`, async () => {
      await withBodyStub(kind === "stream" ? "stream" : "stall", async (gateway, received) => {
        const controller = new AbortController();
        const reason = new Error("synthetic caller cancellation");
        const pending =
          kind === "complete"
            ? gateway.complete({ messages, signal: controller.signal })
            : kind === "capacity"
              ? gateway.loadedContextCapacity("test/model", { signal: controller.signal })
              : (async () => {
                  for await (const _chunk of gateway.streamChat({
                    messages,
                    signal: controller.signal,
                  })) {
                    /* consume */
                  }
                })();
        const outcome = pending.then(
          () => null,
          (error: unknown) => error,
        );
        await received;
        await Bun.sleep(20);
        controller.abort(reason);
        expect(await outcome).toBe(reason);
      });
    });
  }
  it("maps hard transport disconnect to service unavailable", async () => {
    await withBodyStub("disconnect", async (gateway) => {
      await expect(gateway.listModels()).rejects.toMatchObject({
        code: "MODEL_SERVICE_UNAVAILABLE",
      });
    });
  });
  it("capacity hard disconnect is unavailable, not unknown capacity", async () => {
    await withBodyStub("disconnect", async (gateway) => {
      await expect(gateway.loadedContextCapacity("test/model")).rejects.toMatchObject({
        code: "MODEL_CAPACITY_UNAVAILABLE",
      });
    });
  });
  it("capacity malformed JSON still means unknown capacity", async () => {
    await withBodyStub("invalid", async (gateway) => {
      expect(await gateway.loadedContextCapacity("test/model")).toBeNull();
    });
  });
  it("capacity keeps its original 10-second timeout and error family", async () => {
    await withBodyStub("stall", async (gateway) => {
      await expect(gateway.loadedContextCapacity("test/model")).rejects.toMatchObject({
        code: "MODEL_CAPACITY_UNAVAILABLE",
      });
    });
  }, 15000);
  it("complete and loaded-model probe still succeed", async () => {
    await withBodyStub("ok", async (gateway) => {
      expect(await gateway.complete({ messages })).toBe("ok");
      expect(await gateway.probeModelLoaded()).toBe(true);
    });
  });
});
