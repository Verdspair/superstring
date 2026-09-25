import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Server } from "node:http";
import http from "node:http";
import { createLmStudioClient, resolveLmStudioConfig } from "../../src/server/llm/model-gateway";
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

// LM Studio refuses unauthenticated calls with 401 once its server requires an
// API token. The service is reachable, so this must not be reported as "the
// local model service is down" nor folded into MODEL_CAPACITY_UNAVAILABLE —
// that message sent the user hunting for a service that was running fine.
describe("model gateway distinguishes an auth rejection", () => {
  it("reports 401 as service-unavailable-with-auth, not as missing capacity", async () => {
    const stub = http.createServer((_req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end('{"error":{"code":"invalid_api_key"}}');
    });
    await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
    const gateway = createLmStudioClient({
      baseUrl: `http://127.0.0.1:${(stub.address() as { port: number }).port}/v1`,
      model: "test/model",
      timeoutSeconds: 0.2,
    });
    const capture = (pending: Promise<unknown>) =>
      pending.then(
        () => null,
        (error: unknown) => error as { code?: string; message?: string },
      );
    try {
      const completion = await capture(gateway.complete({ messages }));
      expect(completion).toMatchObject({ code: "MODEL_SERVICE_UNAVAILABLE" });
      expect(completion?.message).toContain("API token");

      const capacity = await capture(gateway.loadedContextCapacity("test/model"));
      expect(capacity).toMatchObject({ code: "MODEL_SERVICE_UNAVAILABLE" });
      expect(capacity?.message).toContain("API token");

      const runtime = createRuntime({
        businessDbPath: ":memory:",
        gateway,
        browserStateSecret: "synthetic-review-secret",
      });
      try {
        const response = await runtime.app.request("/models/local");
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({
          error: { code: "MODEL_SERVICE_UNAVAILABLE" },
        });
      } finally {
        await runtime.stop();
      }
    } finally {
      await new Promise<void>((resolve) => stub.close(() => resolve()));
    }
  });
});

// Requiring an API token is a legitimate LM Studio setting, so the token has to
// be configurable — and it has to reach EVERY call. The capacity probe used to
// be sent with no Authorization header at all, which meant a token-protected
// instance still failed to report its capacity after the chat path was fixed.
describe("model gateway API token", () => {
  it("reads the token from LM_STUDIO_API_KEY and falls back to the LM Studio default", () => {
    expect(resolveLmStudioConfig({}).apiKey).toBe("lm-studio");
    expect(resolveLmStudioConfig({ LM_STUDIO_API_KEY: "  secret-token  " }).apiKey).toBe(
      "secret-token",
    );
    expect(resolveLmStudioConfig({ LM_STUDIO_API_KEY: "   " }).apiKey).toBe("lm-studio");
  });

  it("sends the configured token on chat, model list and the capacity probe", async () => {
    const seen: Array<{ path: string; authorization: string | undefined }> = [];
    const stub = http.createServer((req, res) => {
      seen.push({ path: req.url ?? "", authorization: req.headers.authorization });
      if (req.url?.startsWith("/api/v1/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            models: [
              {
                type: "llm",
                key: "test/model",
                loaded_instances: [{ id: "test/model", config: { context_length: 8192 } }],
              },
            ],
          }),
        );
        return;
      }
      if (req.url?.startsWith("/v1/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "test/model" }] }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n');
      res.write("data: [DONE]\n");
      res.end();
    });
    await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
    const gateway = createLmStudioClient({
      baseUrl: `http://127.0.0.1:${(stub.address() as { port: number }).port}/v1`,
      model: "test/model",
      timeoutSeconds: 5,
      apiKey: "secret-token",
    });
    try {
      expect(await gateway.listModels()).toEqual(["test/model"]);
      expect(await gateway.loadedContextCapacity("test/model")).toBe(8192);
      for await (const _chunk of gateway.streamChat({ messages })) {
        /* consume */
      }
      // 2026-09-25（模型替补）：聊天调用会先问一次"本地加载了哪些模型"，所以序列里多了一个
      // /v1/models。这个用例真正要钉的性质没变——**每一个**请求都带配置的令牌。
      expect(seen.map((entry) => entry.authorization)).toEqual(
        seen.map(() => "Bearer secret-token"),
      );
      expect(seen.filter((entry) => entry.path.startsWith("/v1/chat/completions"))).toHaveLength(1);
      expect(seen.some((entry) => entry.path.startsWith("/api/v1/models"))).toBe(true);
    } finally {
      await new Promise<void>((resolve) => stub.close(() => resolve()));
    }
  });

  it("falls back to the default token when a config literal omits apiKey", async () => {
    const seen: Array<string | undefined> = [];
    const stub = http.createServer((req, res) => {
      seen.push(req.headers.authorization);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [] }));
    });
    await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
    const gateway = createLmStudioClient({
      baseUrl: `http://127.0.0.1:${(stub.address() as { port: number }).port}/v1`,
      model: "test/model",
      timeoutSeconds: 5,
    });
    try {
      await gateway.listModels();
      expect(seen).toEqual(["Bearer lm-studio"]);
    } finally {
      await new Promise<void>((resolve) => stub.close(() => resolve()));
    }
  });
});

// 结构化输出的自动降级（用户 2026-09-25）：不是每个 OpenAI 兼容服务都接受严格的 json_schema。
// 这里用一个"只认 json_object"的服务端钉住这条链：第一次降级要多一次请求，之后同一服务+模型的
// 调用直接按降级后的档发（进程内记住），而且**只**在 4xx 形状错误时降级。
describe("structured output falls back when the service rejects json_schema", () => {
  /** Only the chat calls count: the same stub also answers the model-list probe. */
  async function withStructuredStub(
    seen: Array<Record<string, unknown>>,
    respond: (body: Record<string, unknown>, attempt: number) => { status: number; body: string },
    check: (gateway: ReturnType<typeof createLmStudioClient>) => Promise<void>,
  ) {
    const stub = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        const body = raw === "" ? {} : (JSON.parse(raw) as Record<string, unknown>);
        const isChat = (req.url ?? "").endsWith("/chat/completions");
        if (isChat) seen.push(body);
        const answer = respond(body, seen.length);
        void isChat;
        if (answer.status >= 400) {
          res.writeHead(answer.status, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: answer.body } }));
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(answer.body);
      });
    });
    await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
    const gateway = createLmStudioClient({
      baseUrl: `http://127.0.0.1:${(stub.address() as { port: number }).port}/v1`,
      model: "test/model",
      timeoutSeconds: 5,
    });
    try {
      await check(gateway);
    } finally {
      await new Promise<void>((resolve) => stub.close(() => resolve()));
    }
  }

  const ok = (content: string) => ({
    status: 200,
    body: JSON.stringify({ choices: [{ finish_reason: "stop", message: { content } }] }),
  });

  it("retries with json_object, then remembers the level for the next call", async () => {
    const seen: Array<Record<string, unknown>> = [];
    await withStructuredStub(
      seen,
      (body) => {
        const format = body.response_format as { type?: string } | undefined;
        if (format?.type === "json_schema")
          return { status: 400, body: "response_format json_schema is not supported" };
        return ok('{"score":7}');
      },
      async (gateway) => {
        const schema = { type: "object", properties: { score: { type: "integer" } } };
        expect(await gateway.complete({ messages: [], responseSchema: schema })).toBe(
          '{"score":7}',
        );
        // 第二次调用直接走降级后的档：只多了一次请求。
        expect(await gateway.complete({ messages: [], responseSchema: schema })).toBe(
          '{"score":7}',
        );
      },
    );
    expect(
      seen.map((body) => (body.response_format as { type?: string } | undefined)?.type),
    ).toEqual(["json_schema", "json_object", "json_object"]);
  });

  it("drops response_format entirely when json_object is rejected too", async () => {
    const seen: Array<Record<string, unknown>> = [];
    await withStructuredStub(
      seen,
      (body) => {
        if (body.response_format !== undefined)
          return { status: 422, body: "unsupported parameter: response_format" };
        return ok('{"score":9}');
      },
      async (gateway) => {
        expect(
          await gateway.complete({
            messages: [],
            responseSchema: { type: "object", properties: { score: { type: "integer" } } },
          }),
        ).toBe('{"score":9}');
      },
    );
    expect(seen.map((body) => Boolean(body.response_format))).toEqual([true, true, false]);
  });

  it("does not downgrade on an auth rejection", async () => {
    const seen: Array<Record<string, unknown>> = [];
    await withStructuredStub(
      seen,
      () => ({ status: 401, body: "invalid api key" }),
      async (gateway) => {
        await expect(
          gateway.complete({
            messages: [],
            responseSchema: { type: "object", properties: { score: { type: "integer" } } },
          }),
        ).rejects.toThrow();
      },
    );
    // 凭据问题降级只会掩盖真正的配置错误：只该有那一次请求。
    expect(seen).toHaveLength(1);
  });
});
