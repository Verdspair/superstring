// SSE streaming contract tests for `POST /chat`.
// Two layers are covered:
// 1. The WIRE contract through a real Hono app: frame layout, event order
// field names, UTF-8 passthrough, and the three distinct error exits.
// 2. The ORCHESTRATION contract against DirectService directly, because the
// most dangerous behaviours (ownership loss, client disconnect, empty
// output) cannot be expressed with a well-behaved HTTP client.
// The gateway is always a scripted fake — no live model is ever called.

import { describe, expect, it } from "bun:test";
import { setTimeout as sleep } from "node:timers/promises";
import { DatabaseError } from "../../src/server/api/error-handler";
import { parseSseFrames, type SseFrame } from "../../src/server/api/sse";
import { createApp } from "../../src/server/app";
import { deleteMessage, listMessages, type Orm } from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { ModelUnavailableError } from "../../src/server/errors";
import type { ModelGateway } from "../../src/server/llm/model-gateway";
import { DirectService } from "../../src/server/services/direct-service";

/** A gateway whose streaming behaviour is scripted per test. */
class ScriptedGateway implements ModelGateway {
  config = {
    baseUrl: "http://127.0.0.1:1234/v1",
    model: "qwen/qwen3-4b-2507",
    timeoutSeconds: 60,
  };
  /** Deltas to emit, then optional failure to raise after them. */
  script: { deltas: string[]; delayMs?: number; failWith?: unknown } = { deltas: [] };
  /** Capture of the messages handed to the model, for context assertions. */
  lastMessages: Array<{ role: string; content: string }> = [];
  lastOptions: {
    model?: string;
    temperature?: number;
    maxTokens?: number;
    signal?: AbortSignal;
  } = {};

  async listModels(): Promise<string[]> {
    return [this.config.model];
  }
  async loadedContextCapacity(): Promise<number | null> {
    return 32768;
  }
  async probeModelLoaded(): Promise<boolean> {
    return true;
  }
  async complete(): Promise<string> {
    return JSON.stringify({
      kind: "final",
      outputs: [{ kind: "generate", targetId: "reply", instructions: "" }],
    });
  }
  async *streamChat(options: {
    messages: Array<{ role: string; content: string }>;
    model?: string;
    temperature?: number;
    maxTokens?: number;
    signal?: AbortSignal;
  }): AsyncGenerator<string, void, unknown> {
    this.lastMessages = options.messages;
    this.lastOptions = {
      model: options.model,
      temperature: options.temperature,
      maxTokens: options.maxTokens,
      signal: options.signal,
    };
    for (const delta of this.script.deltas) {
      if (this.script.delayMs) await sleep(this.script.delayMs);
      yield delta;
    }
    if (this.script.failWith !== undefined) throw this.script.failWith;
  }
}

function makeApp(gateway: ScriptedGateway) {
  const business = openBusinessDb();
  return { app: createApp({ business, gateway }), business };
}

async function newSession(app: ReturnType<typeof makeApp>["app"]): Promise<string> {
  await app.request("/agents");
  const res = await app.request(
    "/sessions",
    new Request("http://x/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "会话" }),
    }),
  );
  return ((await res.json()) as { id: string }).id;
}

function chatRequest(body: unknown): Request {
  return new Request("http://x/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/**
 * Read the final frame, failing the test if the stream produced none. Written as
 * an explicit guard (rather than `frames.at(-1)?.data`) so a malformed stream
 * reports "no terminal frame" instead of an opaque TypeError on `undefined`.
 */
function lastFrame(frames: SseFrame[]): SseFrame {
  const frame = frames.at(-1);
  if (!frame) throw new Error(`expected a terminal SSE frame, got ${frames.length} frame(s)`);
  return frame;
}

describe("POST /chat wire contract", () => {
  it("opt-in context accounting precedes deltas and adds up without leaking content", async () => {
    const gateway = new ScriptedGateway();
    gateway.script = { deltas: ["ok"] };
    const { app, business } = makeApp(gateway);
    try {
      const sessionId = await newSession(app);
      const request = chatRequest({
        session_id: sessionId,
        message: "private-question",
        client_request_id: "usage-1",
      });
      request.headers.set("X-Superstring-Context-Usage", "1");
      const frames = parseSseFrames(await (await app.request(request)).text());
      expect(frames.map((frame) => frame.event)).toEqual(["start", "context", "delta", "done"]);
      const { ContextUsageSchema } = await import("../../src/shared/contracts/context-usage");
      const usage = ContextUsageSchema.parse((frames[1].data as { usage: unknown }).usage);
      expect(usage.session_id).toBe(sessionId);
      expect(Object.values(usage.components).reduce((a, b) => a + b, 0)).toBe(usage.input_units);
      expect(
        usage.input_units + usage.output_reserved + usage.safety_reserved + usage.remaining,
      ).toBe(usage.capacity);
      expect(usage.components.current_question).toBeGreaterThan(0);
      expect(usage.components.knowledge).toBe(0);
      expect(JSON.stringify(usage)).not.toContain("private-question");
      const replay = chatRequest({
        session_id: sessionId,
        message: "private-question",
        client_request_id: "usage-1",
      });
      replay.headers.set("X-Superstring-Context-Usage", "1");
      expect(
        parseSseFrames(await (await app.request(replay)).text()).some(
          (frame) => frame.event === "context",
        ),
      ).toBe(false);
    } finally {
      business.close();
    }
  });
  it("emits start → delta… → done in order, with the contract's field names", async () => {
    const gateway = new ScriptedGateway();
    gateway.script = { deltas: ["你好", "，", "世界"] };
    const { app } = makeApp(gateway);
    const sessionId = await newSession(app);

    const res = await app.request(
      chatRequest({ session_id: sessionId, message: "嗨", client_request_id: "c-1" }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-cache");
    expect(res.headers.get("x-accel-buffering")).toBe("no");

    const frames = parseSseFrames(await res.text());
    expect(frames.map((f) => f.event)).toEqual(["start", "delta", "delta", "delta", "done"]);

    const start = frames[0].data as { request_id: string; session_id: string };
    expect(start.session_id).toBe(sessionId);
    expect(start.request_id).toBeTruthy();

    // Deltas carry the text verbatim — UTF-8, not escaped.
    const texts = frames.slice(1, 4).map((f) => (f.data as { text: string }).text);
    expect(texts).toEqual(["你好", "，", "世界"]);
    for (const frame of frames.slice(1, 4)) {
      expect((frame.data as { request_id: string }).request_id).toBe(start.request_id);
    }

    const done = frames[4].data as {
      request_id: string;
      message_id: string;
      created_at: string;
      completed_at: string | null;
    };
    expect(done.request_id).toBe(start.request_id);
    expect(done.message_id).toBeTruthy();
    expect(done.completed_at).not.toBeNull();
  });

  it("accepts unknown body fields and ignores them (#93)", async () => {
    // `ChatRequest` is the only request model without
    // an explicit extra-key policy, so the default ignore
    // applies: unknown keys are accepted and dropped. Being strict here turned a
    // request the contract answers 200 into a 422.
    const gateway = new ScriptedGateway();
    gateway.script = { deltas: ["ok"] };
    const { app } = makeApp(gateway);
    const sessionId = await newSession(app);

    const res = await app.request(
      chatRequest({
        session_id: sessionId,
        message: "嗨",
        client_request_id: "cg-extra",
        surprise: 1,
        extra_thing: { a: 1 },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const frames = parseSseFrames(await res.text());
    expect(frames.map((f) => f.event)).toEqual(["start", "delta", "done"]);
  });

  it("persists the concatenated, trimmed answer as a completed message", async () => {
    const gateway = new ScriptedGateway();
    gateway.script = { deltas: ["  你", "好  "] };
    const { app, business } = makeApp(gateway);
    const sessionId = await newSession(app);

    await (
      await app.request(
        chatRequest({ session_id: sessionId, message: "嗨", client_request_id: "c-2" }),
      )
    ).text();

    const messages = listMessages(business.orm, sessionId);
    const assistant = messages.find((m) => m.role === "assistant");
    expect(assistant?.content).toBe("你好"); // joined then .trim()-ed
    expect(assistant?.status).toBe("completed");
  });

  it("passes the runtime model, temperature and max_output_tokens to the gateway", async () => {
    const gateway = new ScriptedGateway();
    gateway.script = { deltas: ["ok"] };
    const { app } = makeApp(gateway);
    const sessionId = await newSession(app);

    await (
      await app.request(
        chatRequest({ session_id: sessionId, message: "嗨", client_request_id: "c-3" }),
      )
    ).text();

    expect(gateway.lastOptions.model).toBe("qwen/qwen3-4b-2507");
    expect(gateway.lastOptions.temperature).toBe(0.7);
    expect(gateway.lastOptions.maxTokens).toBe(4096);
    // The system prompt is compiled from the agent, not sent empty.
    expect(gateway.lastMessages[0]?.role).toBe("system");
    expect(gateway.lastMessages.at(-1)?.content).toBe("嗨");
  });

  it("replays a completed turn without consulting the model again", async () => {
    const gateway = new ScriptedGateway();
    gateway.script = { deltas: ["第一次回答"] };
    const { app, business } = makeApp(gateway);
    const sessionId = await newSession(app);

    await (
      await app.request(
        chatRequest({ session_id: sessionId, message: "嗨", client_request_id: "c-4" }),
      )
    ).text();

    // Second call, same id + same content: replay.
    gateway.script = { deltas: ["不该出现"] };
    const res = await app.request(
      chatRequest({ session_id: sessionId, message: "嗨", client_request_id: "c-4" }),
    );
    const frames = parseSseFrames(await res.text());

    expect(frames.map((f) => f.event)).toEqual(["start", "delta", "done"]);
    expect((frames[1].data as { text: string }).text).toBe("第一次回答");
    // No third message was appended.
    expect(listMessages(business.orm, sessionId)).toHaveLength(2);
  });

  it("emits an error event with the AppError code when the model hits its output limit", async () => {
    const gateway = new ScriptedGateway();
    gateway.script = {
      deltas: ["半句"],
      failWith: new ModelUnavailableError("MODEL_OUTPUT_LIMIT", "模型达到输出上限"),
    };
    const { app, business } = makeApp(gateway);
    const sessionId = await newSession(app);

    const res = await app.request(
      chatRequest({ session_id: sessionId, message: "嗨", client_request_id: "c-5" }),
    );
    const frames = parseSseFrames(await res.text());
    expect(frames.map((f) => f.event)).toEqual(["start", "delta", "error"]);

    const err = frames[2].data as { code: string; message: string; request_id: string };
    expect(err.code).toBe("MODEL_OUTPUT_LIMIT");
    expect(err.request_id).toBe((frames[0].data as { request_id: string }).request_id);

    // The partial text is preserved on the failed row so the user sees what came.
    const assistant = listMessages(business.orm, sessionId).find((m) => m.role === "assistant");
    expect(assistant?.status).toBe("failed");
    expect(assistant?.errorCode).toBe("MODEL_OUTPUT_LIMIT");
    expect(assistant?.content).toBe("半句");
  });

  it("rejects an empty model answer with MODEL_EMPTY_RESPONSE and never saves it", async () => {
    const gateway = new ScriptedGateway();
    // No deltas at all: an empty stream. (A whitespace-only delta is truthy in
    // both in the contract and in JS, so it WOULD be emitted as a delta event first
    // asserted separately below.)
    gateway.script = { deltas: [] };
    const { app, business } = makeApp(gateway);
    const sessionId = await newSession(app);

    const frames = parseSseFrames(
      await (
        await app.request(
          chatRequest({ session_id: sessionId, message: "嗨", client_request_id: "c-6" }),
        )
      ).text(),
    );
    expect(frames.map((f) => f.event)).toEqual(["start", "error"]);
    expect((frames[1].data as { code: string }).code).toBe("MODEL_EMPTY_RESPONSE");

    const assistant = listMessages(business.orm, sessionId).find((m) => m.role === "assistant");
    expect(assistant?.status).toBe("failed");
    expect(assistant?.content).toBe("");
  });

  it("maps an unexpected gateway failure to MODEL_ERROR", async () => {
    const gateway = new ScriptedGateway();
    gateway.script = { deltas: [], failWith: new Error("socket exploded") };
    const { app, business } = makeApp(gateway);
    const sessionId = await newSession(app);

    const frames = parseSseFrames(
      await (
        await app.request(
          chatRequest({ session_id: sessionId, message: "嗨", client_request_id: "c-7" }),
        )
      ).text(),
    );
    const last = lastFrame(frames);
    expect((last.data as { code: string }).code).toBe("MODEL_ERROR");
    const assistant = listMessages(business.orm, sessionId).find((m) => m.role === "assistant");
    expect(assistant?.errorCode).toBe("MODEL_ERROR");
  });

  it("maps a storage failure to DATABASE_UNAVAILABLE", async () => {
    const gateway = new ScriptedGateway();
    gateway.script = { deltas: ["x"], failWith: new DatabaseError("undefined column") };
    const { app } = makeApp(gateway);
    const sessionId = await newSession(app);

    const frames = parseSseFrames(
      await (
        await app.request(
          chatRequest({ session_id: sessionId, message: "嗨", client_request_id: "c-8" }),
        )
      ).text(),
    );
    const err = lastFrame(frames).data as { code: string; message: string };
    expect(err.code).toBe("DATABASE_UNAVAILABLE");
    // The raw storage message must never leak to the client.
    expect(err.message).not.toContain("undefined column");
  });

  it("surfaces an idempotency conflict as a 409 JSON error (prepare_turn is pre-stream)", async () => {
    const gateway = new ScriptedGateway();
    gateway.script = { deltas: ["答案"] };
    const { app } = makeApp(gateway);
    const sessionId = await newSession(app);

    await (
      await app.request(
        chatRequest({ session_id: sessionId, message: "嗨", client_request_id: "c-9" }),
      )
    ).text();

    // Same key, different content, turn now idle → IDEMPOTENCY_CONFLICT, and
    // because `open_reply` is awaited before the StreamingResponse is built
    // it arrives as a normal HTTP error rather than an SSE event.
    const res = await app.request(
      chatRequest({ session_id: sessionId, message: "换一句", client_request_id: "c-9" }),
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "IDEMPOTENCY_CONFLICT",
    );
  });

  it("emits a whitespace-only delta before failing with MODEL_EMPTY_RESPONSE", async () => {
    // " " is truthy in the contract AND in JS, so it emits it as a delta
    // and only then discovers the trimmed answer is empty. Reproduced exactly.
    const gateway = new ScriptedGateway();
    gateway.script = { deltas: ["   "] };
    const { app } = makeApp(gateway);
    const sessionId = await newSession(app);

    const frames = parseSseFrames(
      await (
        await app.request(
          chatRequest({ session_id: sessionId, message: "嗨", client_request_id: "c-6b" }),
        )
      ).text(),
    );
    expect(frames.map((f) => f.event)).toEqual(["start", "delta", "error"]);
    expect((frames[1].data as { text: string }).text).toBe("   ");
    expect((frames[2].data as { code: string }).code).toBe("MODEL_EMPTY_RESPONSE");
  });

  it("rejects an invalid body with 422 before opening a stream", async () => {
    const gateway = new ScriptedGateway();
    const { app } = makeApp(gateway);
    const res = await app.request(
      chatRequest({ session_id: "not-a-uuid", message: "x", client_request_id: "c" }),
    );
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("VALIDATION_ERROR");
  });

  it("409s an unknown session before opening a stream (prepare_turn is pre-stream)", async () => {
    const gateway = new ScriptedGateway();
    const { app } = makeApp(gateway);
    const res = await app.request(
      chatRequest({
        session_id: "44444444-4444-4444-8444-444444444444",
        message: "x",
        client_request_id: "c",
      }),
    );
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "SESSION_NOT_FOUND",
    );
  });
});

describe("DirectService orchestration (behaviours HTTP cannot express)", () => {
  function service(gateway: ScriptedGateway, orm: Orm, heartbeatIntervalMs = 5) {
    return new DirectService({ orm, gateway, heartbeatIntervalMs, leaseSeconds: 30 });
  }

  it("records CLIENT_DISCONNECTED with the partial text when the consumer stops early", async () => {
    const gateway = new ScriptedGateway();
    gateway.script = { deltas: ["第一段", "第二段", "第三段"], delayMs: 5 };
    const business = openBusinessDb();
    const { createSession } = await import("../../src/server/db/repositories");
    const session = createSession(business.orm, "会话", { modelName: "qwen/qwen3-4b-2507" });

    const stream = await service(gateway, business.orm).openReply({
      sessionId: session.id,
      message: "嗨",
      clientRequestId: "d-1",
    });

    // Pull only the first delta, then abandon the stream (the client hung up).
    const first = await stream.next();
    expect(first.done).toBe(false);
    await stream.return(undefined);

    // Stopping the consumer must stop the producer: the contract cancels every
    // task it owns in the generator's `finally`, so
    // this project must abort the signal the model fetch is holding. Without this
    // the upstream request keeps running to its own timeout.
    expect(gateway.lastOptions.signal?.aborted).toBe(true);

    const assistant = listMessages(business.orm, session.id).find((m) => m.role === "assistant");
    expect(assistant?.status).toBe("cancelled");
    expect(assistant?.errorCode).toBe("CLIENT_DISCONNECTED");
    expect(assistant?.content).toBe("第一段");
  });

  it("aborts and writes NO failed row when the turn is cancelled mid-stream", async () => {
    const gateway = new ScriptedGateway();
    gateway.script = { deltas: ["a", "b", "c", "d"], delayMs: 12 };
    const business = openBusinessDb();
    const { createSession } = await import("../../src/server/db/repositories");
    const session = createSession(business.orm, "会话", { modelName: "qwen/qwen3-4b-2507" });

    const svc = service(gateway, business.orm);
    const stream = await svc.openReply({
      sessionId: session.id,
      message: "嗨",
      clientRequestId: "d-2",
    });

    // Consume in the background, then delete the user message mid-flight.
    let failure: unknown = null;
    const drained = (async () => {
      try {
        for await (const _event of stream) {
          // drain
        }
      } catch (error) {
        failure = error;
      }
    })();

    await sleep(20);
    const user = listMessages(business.orm, session.id).find((m) => m.role === "user");
    deleteMessage(business.orm, session.id, user?.id as string);
    await drained;

    // Ownership loss is re-raised, never converted into a persisted failure by
    // the service — the cancelling writer owns that row.
    expect(failure).not.toBeNull();
    expect((failure as { code?: string }).code).toBe("GENERATION_CANCELLED");

    const assistant = listMessages(business.orm, session.id).find((m) => m.role === "assistant");
    expect(assistant?.errorCode).toBe("GENERATION_CANCELLED");
    expect(assistant?.status).toBe("cancelled");
    expect(gateway.lastOptions.signal?.aborted).toBe(true);
  });

  it("returns every event for a normal completion, ending with done", async () => {
    const gateway = new ScriptedGateway();
    gateway.script = { deltas: ["x", "y"] };
    const business = openBusinessDb();
    const { createSession } = await import("../../src/server/db/repositories");
    const session = createSession(business.orm, "会话", { modelName: "qwen/qwen3-4b-2507" });

    const events: string[] = [];
    for await (const event of await service(gateway, business.orm).openReply({
      sessionId: session.id,
      message: "嗨",
      clientRequestId: "d-3",
    })) {
      events.push(event.kind === "delta" ? `delta:${event.text}` : "done");
    }
    expect(events).toEqual(["delta:x", "delta:y", "done"]);
  });

  it("marks a second concurrent generation on the same session as busy", async () => {
    const gateway = new ScriptedGateway();
    gateway.script = { deltas: ["slow"], delayMs: 60 };
    const business = openBusinessDb();
    const { createSession } = await import("../../src/server/db/repositories");
    const session = createSession(business.orm, "会话", { modelName: "qwen/qwen3-4b-2507" });

    const svc = service(gateway, business.orm, 1000);
    const stream = await svc.openReply({
      sessionId: session.id,
      message: "嗨",
      clientRequestId: "d-4",
    });
    const first = stream.next();
    await sleep(10);

    let code = "";
    try {
      await svc.openReply({ sessionId: session.id, message: "另一个", clientRequestId: "d-5" });
    } catch (error) {
      code = (error as { code?: string }).code ?? "";
    }
    expect(code).toBe("SESSION_GENERATION_BUSY");

    await stream.return(undefined);
    await first;
  });
});
