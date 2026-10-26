// Per-attempt provider usage metadata tests.
//
// Everything runs against isolated local HTTP stubs (or an injected vision
// fetch) — no real model service, no private input. The cases drive the REAL
// gateway/vision client and assert the metadata the observer receives.
//
// Usage semantics: usage is optional — missing is never
// zero; explicit 0 is reported; every valid provider-reported counter is
// preserved independently (one malformed/missing field never drops the rest,
// a real cached value survives); nothing is derived (totalTokens is never
// summed); cacheState is reported/unreported/invalid and tracks the cache
// dimension only; per attempt the LAST observed usage wins (no accumulation);
// no stream_options.include_usage is sent unilaterally; DeepSeek/Anthropic-
// shaped aliases are not read.

import { afterEach, describe, expect, test } from "bun:test";
import http from "node:http";
import { createLmStudioClient } from "../../src/server/llm/model-gateway";
import { createLmStudioVisionClient } from "../../src/server/llm/vision-client";
import type { ModelResponseMetadata } from "../../src/shared/contracts/agent-run";

const mockFetch = (request: () => Promise<Response>): typeof fetch =>
  Object.assign(request, { preconnect() {} });
const closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

type ChatHandler = (body: Record<string, unknown>, res: http.ServerResponse) => void;

async function startServer(handler: ChatHandler) {
  const sent: Record<string, unknown>[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      if (req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [] }));
        return;
      }
      const body = JSON.parse(raw) as Record<string, unknown>;
      sent.push(body);
      handler(body, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing test port");
  return { sent, baseUrl: `http://127.0.0.1:${address.port}/v1` };
}

function json(res: http.ServerResponse, payload: unknown): void {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

function rejected(res: http.ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message } }));
}

function sse(res: http.ServerResponse, lines: string[]): void {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(lines.map((line) => `data: ${line}\n\n`).join(""));
}

function gateway(baseUrl: string, external = false) {
  return createLmStudioClient(
    { baseUrl, model: "test-model", timeoutSeconds: 5 },
    external
      ? {
          externalModel: () => ({
            baseUrl,
            apiKey: null,
            contextWindow: 8192,
            providerRevision: 1,
          }),
        }
      : {},
  );
}

function collect() {
  const metadata: ModelResponseMetadata[] = [];
  return {
    metadata,
    onModelResponse: (item: ModelResponseMetadata) => {
      metadata.push(item);
    },
  };
}

/** Type-safe usage probe: the field does not exist on the metadata type yet. */
const usageOf = (item: ModelResponseMetadata | undefined): unknown =>
  item === undefined ? undefined : (item as { usage?: unknown }).usage;

const FULL_USAGE = {
  prompt_tokens: 100,
  completion_tokens: 20,
  total_tokens: 120,
  prompt_tokens_details: { cached_tokens: 80 },
};
const FULL_REPORTED = {
  inputTokens: 100,
  outputTokens: 20,
  totalTokens: 120,
  cacheReadInputTokens: 80,
  cacheState: "reported",
};

describe("complete usage metadata", () => {
  test("reports provider usage with a reported cache read", async () => {
    const { baseUrl } = await startServer((_body, res) =>
      json(res, {
        choices: [{ finish_reason: "stop", message: { content: "ok" } }],
        usage: FULL_USAGE,
      }),
    );
    const { metadata, onModelResponse } = collect();
    const text = await gateway(baseUrl).complete({
      messages: [{ role: "user", content: "hi" }],
      onModelResponse,
    });
    expect(text).toBe("ok");
    expect(metadata).toHaveLength(1);
    const usage = usageOf(metadata[0]);
    expect(usage).toEqual(FULL_REPORTED);
    expect(usage).not.toHaveProperty("cacheWriteInputTokens");
  });

  test("omits usage entirely when the payload has none (missing is never zero)", async () => {
    const { baseUrl } = await startServer((_body, res) =>
      json(res, { choices: [{ finish_reason: "stop", message: { content: "ok" } }] }),
    );
    const { metadata, onModelResponse } = collect();
    await gateway(baseUrl).complete({
      messages: [{ role: "user", content: "hi" }],
      onModelResponse,
    });
    expect(metadata).toHaveLength(1);
    expect(usageOf(metadata[0])).toBeUndefined();
    expect(metadata[0]).not.toHaveProperty("usage");
  });

  test("reports an explicit zero cache read as a reported zero", async () => {
    const { baseUrl } = await startServer((_body, res) =>
      json(res, {
        choices: [{ finish_reason: "stop", message: { content: "ok" } }],
        usage: {
          prompt_tokens: 5,
          completion_tokens: 1,
          total_tokens: 6,
          prompt_tokens_details: { cached_tokens: 0 },
        },
      }),
    );
    const { metadata, onModelResponse } = collect();
    await gateway(baseUrl).complete({
      messages: [{ role: "user", content: "hi" }],
      onModelResponse,
    });
    expect(usageOf(metadata[0])).toEqual({
      inputTokens: 5,
      outputTokens: 1,
      totalTokens: 6,
      cacheReadInputTokens: 0,
      cacheState: "reported",
    });
  });

  test("marks cache unreported when usage has no cache fields", async () => {
    const { baseUrl } = await startServer((_body, res) =>
      json(res, {
        choices: [{ finish_reason: "stop", message: { content: "ok" } }],
        usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 },
      }),
    );
    const { metadata, onModelResponse } = collect();
    await gateway(baseUrl).complete({
      messages: [{ role: "user", content: "hi" }],
      onModelResponse,
    });
    const usage = usageOf(metadata[0]);
    expect(usage).toEqual({
      inputTokens: 9,
      outputTokens: 2,
      totalTokens: 11,
      cacheState: "unreported",
    });
    expect(usage).not.toHaveProperty("cacheReadInputTokens");
  });

  test("marks cache invalid on malformed cache values, no invented numbers", async () => {
    const { baseUrl } = await startServer((_body, res) =>
      json(res, {
        choices: [{ finish_reason: "stop", message: { content: "ok" } }],
        usage: {
          prompt_tokens: 9,
          completion_tokens: 2,
          total_tokens: 11,
          prompt_tokens_details: { cached_tokens: -1 },
        },
      }),
    );
    const { metadata, onModelResponse } = collect();
    await gateway(baseUrl).complete({
      messages: [{ role: "user", content: "hi" }],
      onModelResponse,
    });
    const usage = usageOf(metadata[0]);
    expect(usage).toEqual({
      inputTokens: 9,
      outputTokens: 2,
      totalTokens: 11,
      cacheState: "invalid",
    });
    expect(usage).not.toHaveProperty("cacheReadInputTokens");
  });

  test("a malformed main counter drops only that field and keeps valid others", async () => {
    const { baseUrl } = await startServer((_body, res) =>
      json(res, {
        choices: [{ finish_reason: "stop", message: { content: "ok" } }],
        usage: { prompt_tokens: "100", completion_tokens: 20, total_tokens: 120 },
      }),
    );
    const { metadata, onModelResponse } = collect();
    await gateway(baseUrl).complete({
      messages: [{ role: "user", content: "hi" }],
      onModelResponse,
    });
    const usage = usageOf(metadata[0]);
    expect(usage).toEqual({
      outputTokens: 20,
      totalTokens: 120,
      cacheState: "unreported",
    });
    expect(usage).not.toHaveProperty("inputTokens");
  });

  test("a real cached=80 survives a missing total and a malformed counter", async () => {
    const { baseUrl } = await startServer((_body, res) =>
      json(res, {
        choices: [{ finish_reason: "stop", message: { content: "ok" } }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: "20",
          prompt_tokens_details: { cached_tokens: 80 },
        },
      }),
    );
    const { metadata, onModelResponse } = collect();
    await gateway(baseUrl).complete({
      messages: [{ role: "user", content: "hi" }],
      onModelResponse,
    });
    const usage = usageOf(metadata[0]);
    expect(usage).toEqual({
      inputTokens: 100,
      cacheReadInputTokens: 80,
      cacheState: "reported",
    });
    expect(usage).not.toHaveProperty("outputTokens");
    expect(usage).not.toHaveProperty("totalTokens");
  });

  test("never derives totalTokens from input and output", async () => {
    const { baseUrl } = await startServer((_body, res) =>
      json(res, {
        choices: [{ finish_reason: "stop", message: { content: "ok" } }],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      }),
    );
    const { metadata, onModelResponse } = collect();
    await gateway(baseUrl).complete({
      messages: [{ role: "user", content: "hi" }],
      onModelResponse,
    });
    const usage = usageOf(metadata[0]);
    expect(usage).toEqual({ inputTokens: 100, outputTokens: 20, cacheState: "unreported" });
    expect(usage).not.toHaveProperty("totalTokens");
  });

  test("usage with no valid field at all is omitted entirely", async () => {
    const { baseUrl } = await startServer((_body, res) =>
      json(res, {
        choices: [{ finish_reason: "stop", message: { content: "ok" } }],
        usage: { prompt_tokens: "x", completion_tokens: "y", total_tokens: "z" },
      }),
    );
    const { metadata, onModelResponse } = collect();
    await gateway(baseUrl).complete({
      messages: [{ role: "user", content: "hi" }],
      onModelResponse,
    });
    expect(usageOf(metadata[0])).toBeUndefined();
  });

  test("does not read unconfirmed DeepSeek or Anthropic-shaped cache aliases", async () => {
    const { baseUrl } = await startServer((_body, res) =>
      json(res, {
        choices: [{ finish_reason: "stop", message: { content: "ok" } }],
        usage: {
          prompt_tokens: 9,
          completion_tokens: 2,
          total_tokens: 11,
          prompt_cache_hit_tokens: 5,
          prompt_cache_miss_tokens: 4,
          cache_creation_input_tokens: 7,
        },
      }),
    );
    const { metadata, onModelResponse } = collect();
    await gateway(baseUrl).complete({
      messages: [{ role: "user", content: "hi" }],
      onModelResponse,
    });
    expect(usageOf(metadata[0])).toEqual({
      inputTokens: 9,
      outputTokens: 2,
      totalTokens: 11,
      cacheState: "unreported",
    });
  });
});

describe("vision usage metadata", () => {
  test("reports usage on the vision transport", async () => {
    const seen: ModelResponseMetadata[] = [];
    const client = createLmStudioVisionClient(
      { baseUrl: "http://127.0.0.1:1/v1", model: "vision-model", timeoutSeconds: 5 },
      mockFetch(
        async () =>
          new Response(
            JSON.stringify({
              choices: [{ finish_reason: "stop", message: { content: "ok" } }],
              usage: {
                prompt_tokens: 12,
                completion_tokens: 3,
                total_tokens: 15,
                prompt_tokens_details: { cached_tokens: 7 },
              },
            }),
            { status: 200 },
          ),
      ),
    );
    const text = await client.annotate({
      model: "vision-model",
      prompt: "describe",
      images: [{ mimeType: "image/png", bytes: new Uint8Array([1]) }],
      onModelResponse: (item) => {
        seen.push(item);
      },
    });
    expect(text).toBe("ok");
    expect(seen).toHaveLength(1);
    expect(usageOf(seen[0])).toEqual({
      inputTokens: 12,
      outputTokens: 3,
      totalTokens: 15,
      cacheReadInputTokens: 7,
      cacheState: "reported",
    });
  });
});

describe("stream usage metadata", () => {
  test("continues past a usage-only frame and reports its usage", async () => {
    const { baseUrl } = await startServer((_body, res) =>
      sse(res, [
        '{"usage":{"prompt_tokens":9,"completion_tokens":2,"total_tokens":11}}',
        '{"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}',
        "[DONE]",
      ]),
    );
    const { metadata, onModelResponse } = collect();
    const chunks: string[] = [];
    for await (const chunk of gateway(baseUrl).streamChat({
      messages: [{ role: "user", content: "hi" }],
      onModelResponse,
    })) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual(["hi"]);
    expect(metadata).toHaveLength(1);
    expect(metadata[0]!.finishReasons).toEqual(["stop"]);
    expect(metadata[0]!.doneMarker).toBe(true);
    expect(usageOf(metadata[0])).toEqual({
      inputTokens: 9,
      outputTokens: 2,
      totalTokens: 11,
      cacheState: "unreported",
    });
  });

  test("keeps the last cumulative usage frame without accumulating", async () => {
    const { baseUrl } = await startServer((_body, res) =>
      sse(res, [
        '{"choices":[{"delta":{"content":"a"}}]}',
        '{"usage":{"prompt_tokens":9,"completion_tokens":2,"total_tokens":11}}',
        '{"usage":{"prompt_tokens":18,"completion_tokens":4,"total_tokens":22}}',
        '{"choices":[{"delta":{"content":"b"},"finish_reason":"stop"}]}',
        "[DONE]",
      ]),
    );
    const { metadata, onModelResponse } = collect();
    const chunks: string[] = [];
    for await (const chunk of gateway(baseUrl).streamChat({
      messages: [{ role: "user", content: "hi" }],
      onModelResponse,
    })) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual(["a", "b"]);
    expect(usageOf(metadata[0])).toEqual({
      inputTokens: 18,
      outputTokens: 4,
      totalTokens: 22,
      cacheState: "unreported",
    });
  });

  test("reports usage carried on the final choice chunk", async () => {
    const { baseUrl } = await startServer((_body, res) =>
      sse(res, [
        JSON.stringify({
          choices: [{ delta: { content: "hi" }, finish_reason: "stop" }],
          usage: {
            prompt_tokens: 30,
            completion_tokens: 5,
            total_tokens: 35,
            prompt_tokens_details: { cached_tokens: 12 },
          },
        }),
        "[DONE]",
      ]),
    );
    const { metadata, onModelResponse } = collect();
    const chunks: string[] = [];
    for await (const chunk of gateway(baseUrl).streamChat({
      messages: [{ role: "user", content: "hi" }],
      onModelResponse,
    })) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual(["hi"]);
    expect(usageOf(metadata[0])).toEqual({
      inputTokens: 30,
      outputTokens: 5,
      totalTokens: 35,
      cacheReadInputTokens: 12,
      cacheState: "reported",
    });
  });

  test("a schema retry reports usage only for the attempt that has it", async () => {
    const { baseUrl, sent } = await startServer((body, res) => {
      if ((body.response_format as { type?: string } | undefined)?.type === "json_schema") {
        rejected(res, 400, "json_schema unsupported");
        return;
      }
      json(res, {
        choices: [{ finish_reason: "stop", message: { content: "ok" } }],
        usage: { prompt_tokens: 40, completion_tokens: 6, total_tokens: 46 },
      });
    });
    const { metadata, onModelResponse } = collect();
    const text = await gateway(baseUrl).complete({
      messages: [{ role: "user", content: "hi" }],
      responseSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
      onModelResponse,
    });
    expect(text).toBe("ok");
    expect(sent).toHaveLength(2);
    expect(usageOf(metadata[0])).toBeUndefined();
    expect(usageOf(metadata[1])).toEqual({
      inputTokens: 40,
      outputTokens: 6,
      totalTokens: 46,
      cacheState: "unreported",
    });
  });

  test("does not add stream_options to the request body", async () => {
    const { baseUrl, sent } = await startServer((_body, res) =>
      sse(res, ['{"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}', "[DONE]"]),
    );
    for await (const _chunk of gateway(baseUrl).streamChat({
      messages: [{ role: "user", content: "hi" }],
    })) {
      // consume the stream
    }
    expect(sent).toHaveLength(1);
    expect("stream_options" in sent[0]!).toBe(false);
  });

  test("an interrupted stream with no usage received omits usage", async () => {
    const { baseUrl } = await startServer((_body, res) =>
      sse(res, ['{"choices":[{"delta":{"content":"hi"}}]}']),
    );
    const { metadata, onModelResponse } = collect();
    await expect(
      (async () => {
        for await (const _chunk of gateway(baseUrl).streamChat({
          messages: [{ role: "user", content: "hi" }],
          onModelResponse,
        })) {
          // consume until the stream breaks
        }
      })(),
    ).rejects.toMatchObject({ code: "MODEL_STREAM_INTERRUPTED" });
    expect(metadata).toHaveLength(1);
    expect(usageOf(metadata[0])).toBeUndefined();
  });

  test("an interrupted stream keeps usage actually received and still fails", async () => {
    const { baseUrl, sent } = await startServer((_body, res) =>
      sse(res, [
        '{"usage":{"prompt_tokens":9,"completion_tokens":2,"total_tokens":11}}',
        '{"choices":[{"delta":{"content":"hi"}}]}',
      ]),
    );
    const { metadata, onModelResponse } = collect();
    await expect(
      (async () => {
        for await (const _chunk of gateway(baseUrl).streamChat({
          messages: [{ role: "user", content: "hi" }],
          onModelResponse,
        })) {
          // consume until the stream breaks
        }
      })(),
    ).rejects.toMatchObject({ code: "MODEL_STREAM_INTERRUPTED" });
    // one physical attempt, one callback: the failure is never faked into success
    // and no retry is added — the attempt still fails with its real code.
    expect(metadata).toHaveLength(1);
    expect(sent).toHaveLength(1);
    // the usage the provider actually returned is preserved verbatim (D1/D2)
    expect(usageOf(metadata[0])).toEqual({
      inputTokens: 9,
      outputTokens: 2,
      totalTokens: 11,
      cacheState: "unreported",
    });
  });
});
