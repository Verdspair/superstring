// Frozen HTTP behavior verified against the contract.
import { describe, expect, it } from "bun:test";
import { request as httpRequest } from "node:http";
import { isDatabaseError } from "../../src/server/api/error-handler";
import { createApp } from "../../src/server/app";
import { getTurnByRequest, listMessages } from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { type ModelGateway, mapModelError } from "../../src/server/llm/model-gateway";

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class OracleGateway implements ModelGateway {
  config = {
    baseUrl: "http://synthetic.invalid/v1",
    model: "synthetic-model",
    timeoutSeconds: 60,
  };
  mode: "normal" | "block-capacity" | "block-stream" | "invalid" | "exception" = "normal";
  entered = deferred();
  aborted = deferred();
  streamCalls = 0;
  releaseWait = () => {};
  async listModels(): Promise<string[]> {
    throw mapModelError(new Error("synthetic malformed catalog"));
  }
  async waitForAbort(signal?: AbortSignal): Promise<never> {
    this.entered.resolve();
    return new Promise((_, reject) => {
      const abort = () => {
        this.aborted.resolve();
        reject(new DOMException("cancelled", "AbortError"));
      };
      this.releaseWait = abort;
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    });
  }
  async loadedContextCapacity(
    _model: string,
    options?: { signal?: AbortSignal },
  ): Promise<number | null> {
    if (this.mode === "block-capacity") return this.waitForAbort(options?.signal);
    if (this.mode === "invalid") return 0;
    if (this.mode === "exception") throw new Error("synthetic capacity failure");
    return 32768;
  }
  async probeModelLoaded() {
    return true;
  }
  async complete() {
    return JSON.stringify({
      kind: "final",
      outputs: [{ kind: "generate", targetId: "reply", instructions: "" }],
    });
  }
  async *streamChat(options: { signal?: AbortSignal }) {
    this.streamCalls++;
    yield "partial";
    if (this.mode === "block-stream") await this.waitForAbort(options.signal);
  }
}

async function fixture(gateway = new OracleGateway()) {
  const business = openBusinessDb();
  const app = createApp({ business, gateway });
  const response = await app.request("/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const session = (await response.json()) as { id: string; agent_id: string };
  return {
    app,
    business,
    gateway,
    session,
    response,
    close() {
      business.close();
    },
  };
}

function chat(sessionId: string, key: string, signal?: AbortSignal) {
  return new Request("http://synthetic.invalid/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      session_id: sessionId,
      message: "oracle",
      client_request_id: key,
    }),
    signal,
  });
}

async function deadline<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("cancellation did not finish")), 1000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe("real loopback TCP disconnect (Bun server, synthetic gateway and SQLite)", () => {
  for (const mode of ["block-capacity", "block-stream"] as const) {
    it(`socket destruction during ${mode} cancels upstream and persists partial`, async () => {
      const f = await fixture();
      f.gateway.mode = mode;
      const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: f.app.fetch });
      const received = deferred();
      let body = "";
      let status: number | undefined;
      let contentType: string | undefined;
      let networkError: Error | undefined;
      const req = httpRequest(
        {
          hostname: "127.0.0.1",
          port: server.port,
          path: "/chat",
          method: "POST",
          agent: false,
          headers: { "content-type": "application/json" },
        },
        (response) => {
          status = response.statusCode;
          contentType = response.headers["content-type"];
          response.on("error", () => {}); // Expected after deliberate socket destruction.
          response.on("data", (chunk) => {
            body += chunk.toString();
            if (body.includes(mode === "block-stream" ? "event: delta" : "event: start"))
              received.resolve();
          });
        },
      );
      req.on("error", (error) => {
        networkError = error;
        received.resolve();
      });
      req.end(
        JSON.stringify({
          session_id: f.session.id,
          message: "tcp oracle",
          client_request_id: "tcp-disconnect",
        }),
      );
      try {
        await deadline(received.promise);
        if (networkError) throw networkError;
        await deadline(f.gateway.entered.promise);
        expect(status).toBe(200);
        expect(contentType).toContain("text/event-stream");
        expect(body).toContain("event: start");
        expect(body).not.toContain("event: done");
        expect(
          getTurnByRequest(f.business.orm, f.session.id, "tcp-disconnect")?.generationStatus,
        ).not.toBe("cancelled");
        // Real HTTP socket teardown; no direct app.request signal or reader.cancel.
        req.destroy();
        await deadline(f.gateway.aborted.promise);
        await deadline(
          (async () => {
            for (let attempt = 0; attempt < 70; attempt++) {
              if (
                getTurnByRequest(f.business.orm, f.session.id, "tcp-disconnect")
                  ?.generationStatus === "cancelled"
              )
                return;
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
            throw new Error("TCP cancellation was not persisted");
          })(),
        );
        const assistant = listMessages(f.business.orm, f.session.id).find(
          (m) => m.role === "assistant",
        );
        expect(assistant?.status).toBe("cancelled");
        expect(assistant?.errorCode).toBe("CLIENT_DISCONNECTED");
        expect(assistant?.content).toBe(mode === "block-stream" ? "partial" : "");
        expect(f.gateway.streamCalls).toBe(mode === "block-stream" ? 1 : 0);
      } finally {
        req.destroy();
        f.gateway.releaseWait();
        await server.stop(true);
        // Let the cancellation handler finish before closing its synthetic DB.
        await new Promise((resolve) => setTimeout(resolve, 20));
        f.close();
      }
    });
  }
});

describe("API section 9 original-runtime facts", () => {
  it("DOMException numeric codes are not database errors", () => {
    expect(isDatabaseError(new DOMException("cancelled", "AbortError"))).toBe(false);
    expect(isDatabaseError({ code: 20 })).toBe(false);
    expect(isDatabaseError({ code: "SQLITE_BUSY" })).toBe(true);
  });
  it("omitted Agent binds default; runtime capacity stays empty after Turn freezes", async () => {
    const f = await fixture();
    try {
      expect(f.response.status).toBe(201);
      expect(f.session.agent_id).toBe("00000000-0000-0000-0000-000000000001");
      const reply = await f.app.request(chat(f.session.id, "freeze"));
      expect(await reply.text()).toContain("event: done");
      const turn = getTurnByRequest(f.business.orm, f.session.id, "freeze");
      expect(JSON.parse(turn?.runtimeConfigSnapshot ?? "{}").resolved_model_capacities).toEqual({
        "synthetic-model": 32768,
      });
      const runtime = await f.app.request(`/sessions/${f.session.id}/runtime-config`);
      expect(
        ((await runtime.json()) as { resolved_model_capacities: object }).resolved_model_capacities,
      ).toEqual({});
    } finally {
      f.close();
    }
  });

  it("MODEL_ERROR reaches non-SSE JSON HTTP 503", async () => {
    const f = await fixture();
    try {
      const response = await f.app.request("/models/local");
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        error: { code: "MODEL_ERROR", message: "本地模型调用失败" },
      });
    } finally {
      f.close();
    }
  });

  for (const mode of ["invalid", "exception"] as const) {
    it(`capacity ${mode} is SSE error inside HTTP 200`, async () => {
      const f = await fixture();
      f.gateway.mode = mode;
      try {
        const response = await f.app.request(chat(f.session.id, mode));
        expect(response.status).toBe(200);
        const body = await response.text();
        expect(body).toContain("event: start");
        expect(body).toContain("CONTEXT_CAPACITY_ERROR");
        expect(body).not.toContain("event: done");
        expect(f.gateway.streamCalls).toBe(0);
      } finally {
        f.close();
      }
    });
  }

  for (const mode of ["block-capacity", "block-stream"] as const) {
    for (const via of ["reader", "request"] as const) {
      it(`${via} disconnect during ${mode} aborts upstream and persists cancellation`, async () => {
        const f = await fixture();
        f.gateway.mode = mode;
        const controller = new AbortController();
        try {
          const response = await f.app.request(chat(f.session.id, "disconnect", controller.signal));
          expect(response.status).toBe(200);
          const reader = response.body?.getReader();
          if (!reader) throw new Error("missing response stream");
          await deadline(f.gateway.entered.promise);
          if (via === "reader") await deadline(reader.cancel());
          else {
            controller.abort();
            while (!(await deadline(reader.read())).done) {
              /* drain pre-abort frames */
            }
          }
          await deadline(f.gateway.aborted.promise);
          const messages = listMessages(f.business.orm, f.session.id);
          const assistant = messages.find((message) => message.role === "assistant");
          expect(assistant?.errorCode).toBe("CLIENT_DISCONNECTED");
          expect(assistant?.status).toBe("cancelled");
          expect(assistant?.content).toBe(mode === "block-stream" ? "partial" : "");
          expect(
            getTurnByRequest(f.business.orm, f.session.id, "disconnect")?.generationStatus,
          ).toBe("cancelled");
        } finally {
          controller.abort();
          f.close();
        }
      });
    }
  }
});
