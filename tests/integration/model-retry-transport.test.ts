// 用户 retryPolicy 的传输层重试：只有真实 HTTP 429/503 拒绝才自动重发。
// 全部走隔离的本地 HTTP stub 或注入的 vision fetch；无策略＝旧行为零重试；有策略＝整次
// 逻辑调用共享预算（含首次）、逐次元数据/准入/守卫、重试等待计入同一条总传输时限。

import { afterEach, describe, expect, test } from "bun:test";
import http from "node:http";
import { createLmStudioClient } from "../../src/server/llm/model-gateway";
import { createLmStudioVisionClient } from "../../src/server/llm/vision-client";
import type { ModelMessage, ModelResponseMetadata } from "../../src/shared/contracts/agent-run";

const mockFetch = (request: () => Promise<Response>): typeof fetch =>
  Object.assign(request, { preconnect() {} });

const closers: (() => void)[] = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

/** 聊天桩：按第 n 次 chat 请求分发响应；/models 返回本地目录供 effectiveModel 判定。 */
async function startServer(
  handler: (seq: number, res: http.ServerResponse, body: Record<string, unknown>) => void,
) {
  let seq = 0;
  const server = http.createServer((req, res) => {
    if ((req.url ?? "").endsWith("/chat/completions")) {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () =>
        handler(seq++, res, raw === "" ? {} : (JSON.parse(raw) as Record<string, unknown>)),
      );
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "local/model" }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => {
    server.closeAllConnections();
    server.close();
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test port");
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, seen: () => seq };
}

const refused = (res: http.ServerResponse, status: number): void => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message: `stub ${status}` } }));
};
const okJson = (res: http.ServerResponse, content = "ok"): void => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content } }] }));
};
const okStream = (res: http.ServerResponse): void => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.end(
    'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n' + "data: [DONE]\n\n",
  );
};

const gateway = (baseUrl: string, timeoutSeconds = 5) =>
  createLmStudioClient({ baseUrl, model: "local/model", timeoutSeconds });

const MESSAGES: { role: string; content: string }[] = [{ role: "user", content: "hi" }];
const MODEL_MESSAGES: ModelMessage[] = [{ role: "user", content: [{ kind: "text", text: "hi" }] }];

function permitCounter() {
  const counts = { acquired: 0, released: 0 };
  return {
    counts,
    acquire: async () => {
      counts.acquired += 1;
      return () => {
        counts.released += 1;
      };
    },
  };
}

/** 首次准入立即放行，其后准入一直挂起、直到传入的 signal 被中止才拒绝：钉总时限覆盖准入等待。 */
function hangingPermit() {
  const counts = { acquired: 0, released: 0 };
  return {
    counts,
    acquire: async (_model: string, signal?: AbortSignal): Promise<() => void> => {
      counts.acquired += 1;
      if (counts.acquired === 1) {
        return () => {
          counts.released += 1;
        };
      }
      await new Promise<never>((_resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason);
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      throw new Error("unreachable");
    },
  };
}

describe("complete retryPolicy", () => {
  test("429 then ok: two sends, per-attempt metadata, one prepare, guards per send", async () => {
    let prepares = 0;
    let guards = 0;
    let retries = 0;
    const metadata: ModelResponseMetadata[] = [];
    const permit = permitCounter();
    const { baseUrl } = await startServer((seq, res) => {
      if (seq === 0) return refused(res, 429);
      okJson(res);
    });
    const text = await gateway(baseUrl).complete({
      messages: MESSAGES,
      retryPolicy: { maxAttempts: 3, retryDelayMs: 5 },
      onRetry: () => {
        retries += 1;
      },
      onModelResponse: (item) => metadata.push(item),
      acquireSendPermit: permit.acquire,
      prepareWithResolved: async () => {
        prepares += 1;
        return {};
      },
      preparedFrom: { messages: MODEL_MESSAGES },
      assertPreparedCurrent: () => {
        guards += 1;
      },
    });
    expect(text).toBe("ok");
    expect(metadata).toEqual([
      { transport: "complete", httpStatus: 429, finishReasons: [] },
      { transport: "complete", httpStatus: 200, finishReasons: ["stop"] },
    ]);
    expect(prepares).toBe(1);
    expect(guards).toBe(2);
    expect(permit.counts).toEqual({ acquired: 2, released: 2 });
    expect(retries).toBe(1);
  });

  test("repeated 503 exhausts the shared budget (maxAttempts includes the first)", async () => {
    let retries = 0;
    const metadata: ModelResponseMetadata[] = [];
    const permit = permitCounter();
    const { baseUrl } = await startServer((_seq, res) => refused(res, 503));
    await expect(
      gateway(baseUrl).complete({
        messages: MESSAGES,
        retryPolicy: { maxAttempts: 3, retryDelayMs: 5 },
        onRetry: () => {
          retries += 1;
        },
        onModelResponse: (item) => metadata.push(item),
        acquireSendPermit: permit.acquire,
      }),
    ).rejects.toMatchObject({ code: "MODEL_ERROR", status: 503 });
    expect(metadata).toHaveLength(3);
    expect(metadata.every((item) => item.httpStatus === 503)).toBe(true);
    expect(permit.counts).toEqual({ acquired: 3, released: 3 });
    expect(retries).toBe(2);
  });

  test("shared budget spans the schema fallback subchain (400 then 429 interleave)", async () => {
    let retries = 0;
    const metadata: ModelResponseMetadata[] = [];
    const levels: string[] = [];
    const { baseUrl } = await startServer((seq, res, body) => {
      levels.push((body.response_format as { type?: string } | undefined)?.type ?? "none");
      if (seq === 0) return refused(res, 400);
      refused(res, 429);
    });
    await expect(
      gateway(baseUrl).complete({
        messages: MESSAGES,
        responseSchema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
          additionalProperties: false,
        },
        retryPolicy: { maxAttempts: 2, retryDelayMs: 5 },
        onRetry: () => {
          retries += 1;
        },
        onModelResponse: (item) => metadata.push(item),
      }),
    ).rejects.toMatchObject({ status: 429 });
    // json_schema 400 降档后，json_object 档继续共用同一份剩余额度：maxAttempts 2 = 共 3 发。
    expect(levels).toEqual(["json_schema", "json_object", "json_object"]);
    expect(metadata.map((item) => item.httpStatus)).toEqual([400, 429, 429]);
    expect(retries).toBe(1);
  });

  test("maxAttempts 1 means no retry at all", async () => {
    let retries = 0;
    const metadata: ModelResponseMetadata[] = [];
    const { baseUrl } = await startServer((_seq, res) => refused(res, 429));
    await expect(
      gateway(baseUrl).complete({
        messages: MESSAGES,
        retryPolicy: { maxAttempts: 1, retryDelayMs: 5 },
        onRetry: () => {
          retries += 1;
        },
        onModelResponse: (item) => metadata.push(item),
      }),
    ).rejects.toMatchObject({ status: 429 });
    expect(metadata).toHaveLength(1);
    expect(retries).toBe(0);
  });

  test("401, 500, network failure and timeout are never retried", async () => {
    const run = async (status: number) => {
      let retries = 0;
      const metadata: ModelResponseMetadata[] = [];
      const { baseUrl } = await startServer((_seq, res) => refused(res, status));
      await expect(
        gateway(baseUrl).complete({
          messages: MESSAGES,
          retryPolicy: { maxAttempts: 3, retryDelayMs: 5 },
          onRetry: () => {
            retries += 1;
          },
          onModelResponse: (item) => metadata.push(item),
        }),
      ).rejects.toBeInstanceOf(Error);
      expect(metadata).toHaveLength(1);
      expect(retries).toBe(0);
      expect(metadata[0]?.httpStatus).toBe(status);
    };
    await run(401);
    await run(500);
  });

  test("a network failure reports one send with no status and does not retry", async () => {
    let retries = 0;
    const metadata: ModelResponseMetadata[] = [];
    const dead = http.createServer();
    await new Promise<void>((resolve) => dead.listen(0, "127.0.0.1", resolve));
    const address = dead.address();
    if (!address || typeof address === "string") throw new Error("missing test port");
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    await new Promise<void>((resolve) => dead.close(() => resolve()));
    await expect(
      gateway(baseUrl).complete({
        messages: MESSAGES,
        retryPolicy: { maxAttempts: 3, retryDelayMs: 5 },
        onRetry: () => {
          retries += 1;
        },
        onModelResponse: (item) => metadata.push(item),
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(metadata).toEqual([{ transport: "complete", finishReasons: [] }]);
    expect(retries).toBe(0);
  });

  test("a timeout is not a retryable refusal", async () => {
    let retries = 0;
    const metadata: ModelResponseMetadata[] = [];
    const { baseUrl } = await startServer(() => {
      /* stall until the caller gives up */
    });
    await expect(
      gateway(baseUrl, 0.2).complete({
        messages: MESSAGES,
        retryPolicy: { maxAttempts: 3, retryDelayMs: 5 },
        onRetry: () => {
          retries += 1;
        },
        onModelResponse: (item) => metadata.push(item),
      }),
    ).rejects.toMatchObject({ code: "MODEL_TIMEOUT" });
    expect(metadata).toHaveLength(1);
    expect(retries).toBe(0);
  });

  test("caller cancellation during the retry delay sends nothing more", async () => {
    const abort = new AbortController();
    const reason = new Error("cancelled during retry wait");
    let retries = 0;
    const metadata: ModelResponseMetadata[] = [];
    const { baseUrl } = await startServer((_seq, res) => refused(res, 429));
    await expect(
      gateway(baseUrl).complete({
        messages: MESSAGES,
        signal: abort.signal,
        retryPolicy: { maxAttempts: 3, retryDelayMs: 5000 },
        onRetry: () => {
          retries += 1;
        },
        onModelResponse: (item) => {
          metadata.push(item);
          if (metadata.length === 1) abort.abort(reason);
        },
      }),
    ).rejects.toBe(reason);
    expect(metadata).toHaveLength(1);
    expect(retries).toBe(0);
  });

  test("the one total transport deadline covers the retry delay (no reset per retry)", async () => {
    const { baseUrl, seen } = await startServer((_seq, res) => refused(res, 429));
    await expect(
      gateway(baseUrl, 0.2).complete({
        messages: MESSAGES,
        retryPolicy: { maxAttempts: 5, retryDelayMs: 5000 },
      }),
    ).rejects.toMatchObject({ code: "MODEL_TIMEOUT" });
    expect(seen()).toBe(1);
  });

  test("a blocked second admission cannot outlive the one total deadline", async () => {
    let retries = 0;
    const metadata: ModelResponseMetadata[] = [];
    const permit = hangingPermit();
    const { baseUrl, seen } = await startServer((_seq, res) => refused(res, 429));
    await expect(
      gateway(baseUrl, 0.2).complete({
        messages: MESSAGES,
        retryPolicy: { maxAttempts: 3, retryDelayMs: 5 },
        onRetry: () => {
          retries += 1;
        },
        onModelResponse: (item) => metadata.push(item),
        acquireSendPermit: permit.acquire,
      }),
    ).rejects.toMatchObject({ code: "MODEL_TIMEOUT" });
    // 准入等待也被总时限终止：无额外 HTTP、无虚构尝试元数据、首次许可已释放、无泄漏。
    expect(seen()).toBe(1);
    expect(retries).toBe(1);
    expect(metadata).toHaveLength(1);
    expect(permit.counts).toEqual({ acquired: 2, released: 1 });
  });

  test("a throwing onRetry blocks the extra send", async () => {
    const boom = new Error("budget exhausted");
    let sends = 0;
    const permit = permitCounter();
    const { baseUrl } = await startServer((_seq, res) => {
      sends += 1;
      return refused(res, 429);
    });
    await expect(
      gateway(baseUrl).complete({
        messages: MESSAGES,
        retryPolicy: { maxAttempts: 3, retryDelayMs: 5 },
        onRetry: () => {
          throw boom;
        },
        acquireSendPermit: permit.acquire,
      }),
    ).rejects.toBe(boom);
    expect(sends).toBe(1);
    expect(permit.counts).toEqual({ acquired: 1, released: 1 });
  });
});

describe("streamChat retryPolicy", () => {
  test("a real 429 then ok retries only at acquisition and reports each send", async () => {
    let retries = 0;
    const metadata: ModelResponseMetadata[] = [];
    const permit = permitCounter();
    const { baseUrl } = await startServer((seq, res) => {
      if (seq === 0) return refused(res, 429);
      okStream(res);
    });
    const chunks: string[] = [];
    for await (const chunk of gateway(baseUrl).streamChat({
      messages: MESSAGES,
      retryPolicy: { maxAttempts: 3, retryDelayMs: 5 },
      onRetry: () => {
        retries += 1;
      },
      onModelResponse: (item) => metadata.push(item),
      acquireSendPermit: permit.acquire,
    })) {
      chunks.push(chunk);
    }
    expect(chunks).toEqual(["hi"]);
    expect(metadata).toEqual([
      { transport: "stream", httpStatus: 429, finishReasons: [] },
      { transport: "stream", httpStatus: 200, finishReasons: ["stop"], doneMarker: true },
    ]);
    expect(permit.counts).toEqual({ acquired: 2, released: 2 });
    expect(retries).toBe(1);
  });

  test("a blocked second admission cannot outlive the one total deadline", async () => {
    let retries = 0;
    const metadata: ModelResponseMetadata[] = [];
    const permit = hangingPermit();
    const { baseUrl, seen } = await startServer((_seq, res) => refused(res, 429));
    await expect(
      (async () => {
        for await (const _chunk of gateway(baseUrl, 0.2).streamChat({
          messages: MESSAGES,
          retryPolicy: { maxAttempts: 3, retryDelayMs: 5 },
          onRetry: () => {
            retries += 1;
          },
          onModelResponse: (item) => metadata.push(item),
          acquireSendPermit: permit.acquire,
        })) {
        }
      })(),
    ).rejects.toMatchObject({ code: "MODEL_TIMEOUT" });
    expect(seen()).toBe(1);
    expect(retries).toBe(1);
    expect(metadata).toHaveLength(1);
    expect(permit.counts).toEqual({ acquired: 2, released: 1 });
  });

  test("a partially consumed stream never retries", async () => {
    let retries = 0;
    const metadata: ModelResponseMetadata[] = [];
    const { baseUrl, seen } = await startServer((_seq, res) => {
      // 先产出一条 delta 再提前断流：响应体已经开始，绝不重试。
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end('data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n');
    });
    const chunks: string[] = [];
    await expect(
      (async () => {
        for await (const chunk of gateway(baseUrl).streamChat({
          messages: MESSAGES,
          retryPolicy: { maxAttempts: 3, retryDelayMs: 5 },
          onRetry: () => {
            retries += 1;
          },
          onModelResponse: (item) => metadata.push(item),
        })) {
          chunks.push(chunk);
        }
      })(),
    ).rejects.toMatchObject({ code: "MODEL_STREAM_INTERRUPTED" });
    expect(chunks).toEqual(["partial"]);
    expect(seen()).toBe(1);
    expect(metadata).toHaveLength(1);
    expect(retries).toBe(0);
  });
});

describe("vision retryPolicy", () => {
  test("429 then ok retries with the shared timeout signal and reports each send", async () => {
    let retries = 0;
    let seq = 0;
    const seen: ModelResponseMetadata[] = [];
    const client = createLmStudioVisionClient(
      { baseUrl: "http://127.0.0.1:1/v1", model: "vision", timeoutSeconds: 5 },
      mockFetch(async () => {
        seq += 1;
        if (seq === 1) return new Response("no", { status: 429 });
        return new Response(
          JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "ok" } }] }),
          { status: 200 },
        );
      }),
    );
    const text = await client.annotate({
      model: "vision",
      prompt: "p",
      images: [],
      retryPolicy: { maxAttempts: 3, retryDelayMs: 5 },
      onRetry: () => {
        retries += 1;
      },
      onModelResponse: (item) => seen.push(item),
    });
    expect(text).toBe("ok");
    expect(seen).toEqual([
      { transport: "vision", httpStatus: 429, finishReasons: [] },
      { transport: "vision", httpStatus: 200, finishReasons: ["stop"] },
    ]);
    expect(retries).toBe(1);
    expect(seq).toBe(2);
  });

  test("shared budget spans the schema fallback subchain (400 then 429 interleave)", async () => {
    let retries = 0;
    let seq = 0;
    const seen: ModelResponseMetadata[] = [];
    const client = createLmStudioVisionClient(
      { baseUrl: "http://127.0.0.1:1/v1", model: "vision", timeoutSeconds: 5 },
      mockFetch(async () => {
        seq += 1;
        return new Response("no", { status: seq === 1 ? 400 : 429 });
      }),
    );
    await expect(
      client.annotate({
        model: "vision",
        prompt: "p",
        images: [],
        responseSchema: { type: "object" },
        retryPolicy: { maxAttempts: 2, retryDelayMs: 5 },
        onRetry: () => {
          retries += 1;
        },
        onModelResponse: (item) => seen.push(item),
      }),
    ).rejects.toMatchObject({ status: 429 });
    // json_schema 400 降档后不重置额度：maxAttempts 2 = 共 3 发。
    expect(seen.map((item) => item.httpStatus)).toEqual([400, 429, 429]);
    expect(retries).toBe(1);
    expect(seq).toBe(3);
  });

  test("vision's total timeout covers the retry delay", async () => {
    let sends = 0;
    const client = createLmStudioVisionClient(
      { baseUrl: "http://127.0.0.1:1/v1", model: "vision", timeoutSeconds: 0.2 },
      mockFetch(async () => {
        sends += 1;
        return new Response("no", { status: 429 });
      }),
    );
    await expect(
      client.annotate({
        model: "vision",
        prompt: "p",
        images: [],
        retryPolicy: { maxAttempts: 5, retryDelayMs: 5000 },
      }),
    ).rejects.toMatchObject({ code: "MODEL_TIMEOUT" });
    expect(sends).toBe(1);
  });
});
