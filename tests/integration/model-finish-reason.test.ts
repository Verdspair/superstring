// Per-attempt model response metadata (finish-reason observer) tests.
//
// Everything runs against isolated local HTTP stubs (or an injected vision
// fetch) — no real model service, no private input. The observer must report
// each actual HTTP send attempt exactly once, with the provider's RAW finish
// reasons (explicit null preserved, absent field = []), and must never change
// the result.

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

/** Metadata carries transport/status/finishReasons/doneMarker only — no message body. */
function expectNoBody(item: ModelResponseMetadata): void {
  expect(
    Object.keys(item).every((key) =>
      ["transport", "httpStatus", "finishReasons", "doneMarker"].includes(key),
    ),
  ).toBe(true);
}

describe("complete attempt metadata", () => {
  test("reports the raw stop finish with the HTTP status", async () => {
    const { baseUrl, sent } = await startServer((_body, res) =>
      json(res, { choices: [{ finish_reason: "stop", message: { content: "ok" } }] }),
    );
    const { metadata, onModelResponse } = collect();
    const text = await gateway(baseUrl).complete({
      messages: [{ role: "user", content: "hi" }],
      onModelResponse,
    });
    expect(text).toBe("ok");
    expect(sent).toHaveLength(1);
    expect(metadata).toEqual([{ transport: "complete", httpStatus: 200, finishReasons: ["stop"] }]);
    expectNoBody(metadata[0]!);
  });

  test("reports length and still fails with MODEL_OUTPUT_LIMIT", async () => {
    const { baseUrl } = await startServer((_body, res) =>
      json(res, { choices: [{ finish_reason: "length", message: { content: "partial" } }] }),
    );
    const { metadata, onModelResponse } = collect();
    await expect(
      gateway(baseUrl).complete({ messages: [{ role: "user", content: "hi" }], onModelResponse }),
    ).rejects.toMatchObject({ code: "MODEL_OUTPUT_LIMIT" });
    expect(metadata).toEqual([
      { transport: "complete", httpStatus: 200, finishReasons: ["length"] },
    ]);
  });

  test("reports tool_calls and keeps the readable native decision", async () => {
    const { baseUrl } = await startServer((_body, res) =>
      json(res, {
        choices: [
          {
            finish_reason: "tool_calls",
            message: { tool_calls: [{ function: { name: "lookup", arguments: "{}" } }] },
          },
        ],
      }),
    );
    const { metadata, onModelResponse } = collect();
    const text = await gateway(baseUrl).complete({
      messages: [{ role: "user", content: "hi" }],
      onModelResponse,
    });
    expect(JSON.parse(text)).toEqual({
      kind: "invoke",
      calls: [{ name: "lookup", arguments: {} }],
    });
    expect(metadata).toEqual([
      { transport: "complete", httpStatus: 200, finishReasons: ["tool_calls"] },
    ]);
  });

  test("reports unsupported and unknown finishes raw, still failing", async () => {
    for (const reason of ["content_filter", "weird_finish"]) {
      const { baseUrl } = await startServer((_body, res) =>
        json(res, { choices: [{ finish_reason: reason, message: { content: "x" } }] }),
      );
      const { metadata, onModelResponse } = collect();
      await expect(
        gateway(baseUrl).complete({ messages: [{ role: "user", content: "hi" }], onModelResponse }),
      ).rejects.toMatchObject({ code: "MODEL_FINISH_UNSUPPORTED" });
      expect(metadata).toEqual([
        { transport: "complete", httpStatus: 200, finishReasons: [reason] },
      ]);
    }
  });

  test("keeps explicit null finish acceptance and reports [null]", async () => {
    const { baseUrl } = await startServer((_body, res) =>
      json(res, { choices: [{ finish_reason: null, message: { content: "ok" } }] }),
    );
    const { metadata, onModelResponse } = collect();
    const text = await gateway(baseUrl).complete({
      messages: [{ role: "user", content: "hi" }],
      onModelResponse,
    });
    expect(text).toBe("ok");
    expect(metadata).toEqual([{ transport: "complete", httpStatus: 200, finishReasons: [null] }]);
  });

  test("reports an empty list when finish_reason is missing", async () => {
    const { baseUrl } = await startServer((_body, res) =>
      json(res, { choices: [{ message: { content: "ok" } }] }),
    );
    const { metadata, onModelResponse } = collect();
    const text = await gateway(baseUrl).complete({
      messages: [{ role: "user", content: "hi" }],
      onModelResponse,
    });
    expect(text).toBe("ok");
    expect(metadata).toEqual([{ transport: "complete", httpStatus: 200, finishReasons: [] }]);
  });

  test("a network failure reports no status and no finish reasons", async () => {
    const dead = http.createServer();
    await new Promise<void>((resolve) => dead.listen(0, "127.0.0.1", resolve));
    const address = dead.address();
    if (!address || typeof address === "string") throw new Error("Missing test port");
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    await new Promise<void>((resolve) => dead.close(() => resolve()));
    const { metadata, onModelResponse } = collect();
    await expect(
      gateway(baseUrl).complete({ messages: [{ role: "user", content: "hi" }], onModelResponse }),
    ).rejects.toBeInstanceOf(Error);
    expect(metadata).toEqual([{ transport: "complete", finishReasons: [] }]);
  });

  test("an observer throw never changes the result", async () => {
    const { baseUrl } = await startServer((_body, res) =>
      json(res, { choices: [{ finish_reason: "length", message: { content: "partial" } }] }),
    );
    const seen: ModelResponseMetadata[] = [];
    await expect(
      gateway(baseUrl).complete({
        messages: [{ role: "user", content: "hi" }],
        onModelResponse: (item) => {
          seen.push(item);
          throw new Error("observer boom");
        },
      }),
    ).rejects.toMatchObject({ code: "MODEL_OUTPUT_LIMIT" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.finishReasons).toEqual(["length"]);
  });

  test("a schema retry reports each attempt in order", async () => {
    const { baseUrl, sent } = await startServer((body, res) => {
      if ((body.response_format as { type?: string } | undefined)?.type === "json_schema") {
        rejected(res, 400, "json_schema unsupported");
        return;
      }
      json(res, { choices: [{ finish_reason: "stop", message: { content: "ok" } }] });
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
    expect(metadata).toEqual([
      { transport: "complete", httpStatus: 400, finishReasons: [] },
      { transport: "complete", httpStatus: 200, finishReasons: ["stop"] },
    ]);
  });

  test("a tools retry reports each attempt in order", async () => {
    const { baseUrl, sent } = await startServer((body, res) => {
      if (body.tools !== undefined) {
        rejected(res, 400, "tools unsupported");
        return;
      }
      json(res, { choices: [{ finish_reason: "stop", message: { content: "ok" } }] });
    });
    const { metadata, onModelResponse } = collect();
    const text = await gateway(baseUrl, true).complete({
      messages: [{ role: "user", content: "hi" }],
      tools: [
        { name: "lookup", description: "Lookup", parameters: { type: "object", properties: {} } },
      ],
      onModelResponse,
    });
    expect(text).toBe("ok");
    expect(sent).toHaveLength(2);
    expect(sent[0]!.tools).toBeDefined();
    expect(sent[1]!.tools).toBeUndefined();
    expect(metadata).toEqual([
      { transport: "complete", httpStatus: 400, finishReasons: [] },
      { transport: "complete", httpStatus: 200, finishReasons: ["stop"] },
    ]);
  });
});

describe("stream attempt metadata", () => {
  test("reports stop and the observed [DONE] marker", async () => {
    const { baseUrl } = await startServer((_body, res) =>
      sse(res, ['{"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}', "[DONE]"]),
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
    expect(metadata).toEqual([
      { transport: "stream", httpStatus: 200, finishReasons: ["stop"], doneMarker: true },
    ]);
    expectNoBody(metadata[0]!);
  });

  test("reports length with the marker and still fails", async () => {
    const { baseUrl } = await startServer((_body, res) =>
      sse(res, [
        '{"choices":[{"delta":{"content":"partial"},"finish_reason":"length"}]}',
        "[DONE]",
      ]),
    );
    const { metadata, onModelResponse } = collect();
    const consume = async () => {
      for await (const _chunk of gateway(baseUrl).streamChat({
        messages: [{ role: "user", content: "hi" }],
        onModelResponse,
      })) {
      }
    };
    await expect(consume()).rejects.toMatchObject({ code: "MODEL_OUTPUT_LIMIT" });
    expect(metadata).toEqual([
      { transport: "stream", httpStatus: 200, finishReasons: ["length"], doneMarker: true },
    ]);
  });

  test("reports unsupported finishes raw, still failing", async () => {
    const { baseUrl } = await startServer((_body, res) =>
      sse(res, ['{"choices":[{"finish_reason":"content_filter"}]}']),
    );
    const { metadata, onModelResponse } = collect();
    const consume = async () => {
      for await (const _chunk of gateway(baseUrl).streamChat({
        messages: [{ role: "user", content: "hi" }],
        onModelResponse,
      })) {
      }
    };
    await expect(consume()).rejects.toMatchObject({ code: "MODEL_FINISH_UNSUPPORTED" });
    expect(metadata).toEqual([
      { transport: "stream", httpStatus: 200, finishReasons: ["content_filter"] },
    ]);
  });

  test("an interrupted stream reports no finish and no marker", async () => {
    const { baseUrl } = await startServer((_body, res) =>
      sse(res, ['{"choices":[{"delta":{"content":"hi"}}]}']),
    );
    const { metadata, onModelResponse } = collect();
    const consume = async () => {
      for await (const _chunk of gateway(baseUrl).streamChat({
        messages: [{ role: "user", content: "hi" }],
        onModelResponse,
      })) {
      }
    };
    await expect(consume()).rejects.toMatchObject({ code: "MODEL_STREAM_INTERRUPTED" });
    expect(metadata).toEqual([{ transport: "stream", httpStatus: 200, finishReasons: [] }]);
  });

  test("keeps explicit null and distinct raw values in arrival order", async () => {
    const { baseUrl } = await startServer((_body, res) =>
      sse(res, [
        '{"choices":[{"delta":{"content":"a"},"finish_reason":null}]}',
        '{"choices":[{"delta":{"content":"b"},"finish_reason":"stop"}]}',
        '{"choices":[{"delta":{"content":"c"},"finish_reason":"stop"}]}',
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
    expect(chunks).toEqual(["a", "b", "c"]);
    expect(metadata).toEqual([
      { transport: "stream", httpStatus: 200, finishReasons: [null, "stop"], doneMarker: true },
    ]);
  });
});

describe("vision attempt metadata", () => {
  const annotate = (
    client: ReturnType<typeof createLmStudioVisionClient>,
    seen: ModelResponseMetadata[],
    throwing = false,
  ) =>
    client.annotate({
      model: "vision-model",
      prompt: "describe",
      images: [{ mimeType: "image/png", bytes: new Uint8Array([1]) }],
      onModelResponse: (item) => {
        seen.push(item);
        if (throwing) throw new Error("observer boom");
      },
    });

  test("reports the raw stop finish", async () => {
    const seen: ModelResponseMetadata[] = [];
    const client = createLmStudioVisionClient(
      { baseUrl: "http://127.0.0.1:1/v1", model: "vision-model", timeoutSeconds: 5 },
      mockFetch(
        async () =>
          new Response(
            JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "ok" } }] }),
            { status: 200 },
          ),
      ),
    );
    const text = await annotate(client, seen);
    expect(text).toBe("ok");
    expect(seen).toEqual([{ transport: "vision", httpStatus: 200, finishReasons: ["stop"] }]);
    expectNoBody(seen[0]!);
  });

  test("keeps vision finish acceptance and reports explicit null, missing and unsupported raw", async () => {
    for (const [payload, expected] of [
      [{ finish_reason: null, message: { content: "ok" } }, [null]],
      [{ message: { content: "ok" } }, []],
      [{ finish_reason: "content_filter", message: { content: "ok" } }, ["content_filter"]],
    ] as const) {
      const seen: ModelResponseMetadata[] = [];
      const client = createLmStudioVisionClient(
        { baseUrl: "http://127.0.0.1:1/v1", model: "vision-model", timeoutSeconds: 5 },
        mockFetch(
          async () => new Response(JSON.stringify({ choices: [payload] }), { status: 200 }),
        ),
      );
      const text = await annotate(client, seen);
      expect(text).toBe("ok");
      expect(seen).toEqual([
        { transport: "vision", httpStatus: 200, finishReasons: [...expected] },
      ]);
    }
  });

  test("reports a 4xx with the status and no finish reasons", async () => {
    const seen: ModelResponseMetadata[] = [];
    const client = createLmStudioVisionClient(
      { baseUrl: "http://127.0.0.1:1/v1", model: "vision-model", timeoutSeconds: 5 },
      mockFetch(async () => new Response("no", { status: 400 })),
    );
    await expect(annotate(client, seen)).rejects.toBeInstanceOf(Error);
    expect(seen).toEqual([{ transport: "vision", httpStatus: 400, finishReasons: [] }]);
  });

  test("a network failure reports no status and no finish reasons", async () => {
    const seen: ModelResponseMetadata[] = [];
    const client = createLmStudioVisionClient(
      { baseUrl: "http://127.0.0.1:1/v1", model: "vision-model", timeoutSeconds: 5 },
      mockFetch(async () => {
        throw new Error("connect ECONNREFUSED");
      }),
    );
    await expect(annotate(client, seen)).rejects.toBeInstanceOf(Error);
    expect(seen).toEqual([{ transport: "vision", finishReasons: [] }]);
  });

  test("a non-JSON body reports the status with no finish reasons", async () => {
    const seen: ModelResponseMetadata[] = [];
    const client = createLmStudioVisionClient(
      { baseUrl: "http://127.0.0.1:1/v1", model: "vision-model", timeoutSeconds: 5 },
      mockFetch(async () => new Response("not json", { status: 200 })),
    );
    await expect(annotate(client, seen)).rejects.toBeInstanceOf(Error);
    expect(seen).toEqual([{ transport: "vision", httpStatus: 200, finishReasons: [] }]);
  });

  test("an observer throw never changes the outcome", async () => {
    const seen: ModelResponseMetadata[] = [];
    const client = createLmStudioVisionClient(
      { baseUrl: "http://127.0.0.1:1/v1", model: "vision-model", timeoutSeconds: 5 },
      mockFetch(async () => new Response("no", { status: 400 })),
    );
    await expect(annotate(client, seen, true)).rejects.toBeInstanceOf(Error);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.transport).toBe("vision");
  });
});

test("closing a partially consumed stream reports exactly one attempted response", async () => {
  const { baseUrl } = await startServer((_body, res) =>
    sse(res, [
      '{"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}',
      '{"choices":[{"finish_reason":"stop"}]}',
      "[DONE]",
    ]),
  );
  const { metadata, onModelResponse } = collect();
  for await (const _chunk of gateway(baseUrl).streamChat({
    messages: [{ role: "user", content: "hi" }],
    onModelResponse,
  }))
    break;
  expect(metadata).toEqual([{ transport: "stream", httpStatus: 200, finishReasons: [null] }]);
});

test("a stream keeps an explicit null after a terminal scalar", async () => {
  const { baseUrl } = await startServer((_body, res) =>
    sse(res, [
      '{"choices":[{"finish_reason":"stop"}]}',
      '{"choices":[{"finish_reason":null}]}',
      "[DONE]",
    ]),
  );
  const { metadata, onModelResponse } = collect();
  for await (const _chunk of gateway(baseUrl).streamChat({
    messages: [{ role: "user", content: "hi" }],
    onModelResponse,
  })) {
  }
  expect(metadata).toEqual([
    { transport: "stream", httpStatus: 200, finishReasons: ["stop", null], doneMarker: true },
  ]);
});

test("vision cancellation after admission releases its permit without inventing a send", async () => {
  const abort = new AbortController();
  const reason = new Error("cancelled after admission");
  let releases = 0;
  let sends = 0;
  const metadata: ModelResponseMetadata[] = [];
  const client = createLmStudioVisionClient(
    { baseUrl: "http://127.0.0.1:1/v1", model: "vision", timeoutSeconds: 5 },
    mockFetch(async () => {
      sends++;
      return Response.json({ choices: [{ message: { content: "unused" } }] });
    }),
  );
  await expect(
    client.annotate({
      model: "vision",
      prompt: "fixture",
      images: [],
      signal: abort.signal,
      acquireSendPermit: async () => {
        abort.abort(reason);
        return () => {
          releases++;
        };
      },
      onModelResponse: (item) => metadata.push(item),
    }),
  ).rejects.toBe(reason);
  expect(releases).toBe(1);
  expect(sends).toBe(0);
  expect(metadata).toEqual([]);
});
