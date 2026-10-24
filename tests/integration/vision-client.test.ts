// The multimodal request shape (ADR0018 P5i; U05's decision, 2026-09-24).
//
// The gateway carries text, so pictures travel through this client instead. What it sends is a
// decided thing rather than an implementation detail: the images are data URLs, one entry per
// sampled frame, and the answer is constrained by a strict response schema — the same shape the
// gateway's own calls use. These cases pin exactly that, with `fetch` injected.

import { describe, expect, it, spyOn } from "bun:test";
import http from "node:http";
import { createLmStudioVisionClient } from "../../src/server/llm/vision-client";

const config = {
  baseUrl: "http://127.0.0.1:1234/v1",
  model: "text-model",
  timeoutSeconds: 5,
};

describe("the multimodal request shape", () => {
  it("sends the prompt first, then each image as a data URL, under the configured token", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '{"description":"x","tags":["y"]}' } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;
    const client = createLmStudioVisionClient({ ...config, apiKey: "secret" }, fetchImpl);
    const answer = await client.annotate({
      model: "vision-model",
      prompt: "写一段说明",
      images: [
        { mimeType: "image/png", bytes: new Uint8Array([1, 2, 3]) },
        { mimeType: "image/png", bytes: new Uint8Array([4]) },
      ],
      responseSchema: { type: "object" },
    });
    expect(answer).toBe('{"description":"x","tags":["y"]}');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://127.0.0.1:1234/v1/chat/completions");
    const init = calls[0]?.init as { headers: Record<string, string>; body: string };
    expect(init.headers.authorization).toBe("Bearer secret");
    const body = JSON.parse(init.body) as {
      model: string;
      temperature: number;
      messages: { role: string; content: unknown[] }[];
      response_format: unknown;
    };
    expect(body.model).toBe("vision-model");
    expect(body.messages[0]?.role).toBe("user");
    const content = body.messages[0]?.content as {
      type: string;
      text?: string;
      image_url?: { url: string };
    }[];
    // The prompt is the first part and every frame follows it; nothing else is in the message.
    expect(content[0]).toEqual({ type: "text", text: "写一段说明" });
    expect(content).toHaveLength(3);
    expect(content[1]?.image_url?.url).toBe(
      `data:image/png;base64,${Buffer.from([1, 2, 3]).toString("base64")}`,
    );
    expect(content[2]?.image_url?.url).toBe(
      `data:image/png;base64,${Buffer.from([4]).toString("base64")}`,
    );
    expect(body.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "superstring_result", strict: true, schema: { type: "object" } },
    });
  });

  it("uses the LM Studio default token and classifies a rejected call like the gateway", async () => {
    const seen: string[] = [];
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(" "));
    let failure: { code?: string; status?: number } | null = null;
    try {
      const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
        const headers = init?.headers as Record<string, string>;
        seen.push(headers.authorization ?? "");
        return new Response("nope", { status: 401 });
      }) as unknown as typeof fetch;
      const client = createLmStudioVisionClient(config, fetchImpl);
      failure = await client.annotate({ model: "v", prompt: "p", images: [] }).then(
        () => null,
        (error: unknown) => error as { code?: string; status?: number },
      );
    } finally {
      console.warn = original;
    }
    expect(seen[0]).toBe("Bearer lm-studio");
    // 鉴权失败与网关同码同文，不再是裸的 "401"；状态码仍跟着走，结构化输出的降级认得出这是 4xx。
    expect(failure?.code).toBe("MODEL_SERVICE_UNAVAILABLE");
    expect(failure?.status).toBe(401);
    expect(warnings.join("\n")).toContain("HTTP 401");
  });

  /**
   * 一张图始终读不出来，库里只有 AGENT_FAILED、日志里什么都没有，于是"为什么
   * 读不出"无从查起。视觉失败的原因现在落在日志里（状态码 + 截断的响应体），错误码保持网关那张
   * 表的通用值——原因不是给机器分流的，是给人看的。
   */
  it("keeps the provider's own reason in the log while the code stays generic", async () => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(" "));
    let failure: { code?: string; status?: number } | null = null;
    try {
      const fetchImpl = (async () =>
        new Response(
          '{"error":{"message":"upstream overloaded, retry later","type":"server_error"}}',
          { status: 503 },
        )) as unknown as typeof fetch;
      const client = createLmStudioVisionClient(config, fetchImpl);
      failure = await client
        .annotate({ model: "vision-model", prompt: "写一段说明", images: [] })
        .then(
          () => null,
          (error: unknown) => error as { code?: string; status?: number },
        );
    } finally {
      console.warn = original;
    }
    expect(failure?.code).toBe("MODEL_ERROR");
    expect(failure?.status).toBe(503);
    const logged = warnings.join("\n");
    expect(logged).toContain("HTTP 503");
    expect(logged).toContain("upstream overloaded, retry later");
  });

  it("does not let a non-JSON 200 look like an invalid decision", async () => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(" "));
    let failure: { code?: string } | null = null;
    try {
      const fetchImpl = (async () =>
        new Response("<html><body>502 Bad Gateway</body></html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        })) as unknown as typeof fetch;
      const client = createLmStudioVisionClient(config, fetchImpl);
      failure = await client.annotate({ model: "vision-model", prompt: "p", images: [] }).then(
        () => null,
        (error: unknown) => error as { code?: string },
      );
    } finally {
      console.warn = original;
    }
    // 运行时会把它当成 SyntaxError（=决策不合法）；映射之后它是普通的模型调用失败。
    expect(failure?.code).toBe("MODEL_ERROR");
    expect(warnings.join("\n")).toContain("502 Bad Gateway");
  });

  it("reports a timed-out vision call as MODEL_TIMEOUT and logs the failure", async () => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(" "));
    let failure: { code?: string } | null = null;
    try {
      const fetchImpl = (async () => {
        throw new DOMException("Model response timed out", "TimeoutError");
      }) as unknown as typeof fetch;
      const client = createLmStudioVisionClient({ ...config, timeoutSeconds: 1 }, fetchImpl);
      failure = await client.annotate({ model: "vision-model", prompt: "p", images: [] }).then(
        () => null,
        (error: unknown) => error as { code?: string },
      );
    } finally {
      console.warn = original;
    }
    expect(failure?.code).toBe("MODEL_TIMEOUT");
    expect(warnings.join("\n")).toContain("TimeoutError");
  });

  /**
   * 图片这一路也要降级：媒体读取走的是这个客户端，而"服务不接受严格
   * json_schema"会让每一次图片理解都失败——失败又会被记成"试过但没读出来"，把两条主动路径按住。
   * 与网关同一条链：json_schema → json_object → 不带 response_format。
   */
  it("falls back from json_schema to json_object when the service rejects the strict shape", async () => {
    const formats: (string | undefined)[] = [];
    const originalTimeout = AbortSignal.timeout;
    const timeoutSignals: AbortSignal[] = [];
    const timeoutSpy = (milliseconds: number) => {
      const signal = originalTimeout(milliseconds);
      timeoutSignals.push(signal);
      return signal;
    };
    const timeoutMock = spyOn(AbortSignal, "timeout").mockImplementation(timeoutSpy);
    const fetchSignals: AbortSignal[] = [];
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      fetchSignals.push(init?.signal as AbortSignal);
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        response_format?: { type?: string };
      };
      formats.push(body.response_format?.type);
      if (body.response_format?.type === "json_schema")
        return new Response("unsupported response_format", { status: 400 });
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"a":1}' } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const client = createLmStudioVisionClient(config, fetchImpl);
    try {
      const answer = await client.annotate({
        model: "vision-model",
        prompt: "写一段说明",
        images: [{ mimeType: "image/png", bytes: new Uint8Array([1]) }],
        responseSchema: { type: "object" },
      });
      expect(answer).toBe('{"a":1}');
      expect(formats).toEqual(["json_schema", "json_object"]);
      expect(timeoutSignals).toHaveLength(1);
      expect(fetchSignals).toHaveLength(2);
      expect(fetchSignals[0]).toBe(fetchSignals[1]);
    } finally {
      timeoutMock.mockRestore();
    }
  });

  it("does not start the shared deadline until the first permit is granted", async () => {
    const originalTimeout = AbortSignal.timeout;
    const timeoutSpy = spyOn(AbortSignal, "timeout").mockImplementation(originalTimeout);
    let grantFirst: (() => void) | undefined;
    const permitWait = new Promise<void>((resolve) => {
      grantFirst = resolve;
    });
    let sends = 0;
    const seenSignals: AbortSignal[] = [];
    const acquireSendPermit = async (_model: string, signal?: AbortSignal) => {
      if (sends === 0) {
        expect(signal).toBeUndefined();
        await permitWait;
      } else {
        expect(signal).toBe(seenSignals[0]);
      }
      return () => {};
    };
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      sends += 1;
      seenSignals.push(init?.signal as AbortSignal);
      if (sends === 1) return new Response("unsupported response_format", { status: 400 });
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const client = createLmStudioVisionClient(config, fetchImpl);
    const result = client.annotate({
      model: "vision-model",
      prompt: "p",
      images: [],
      responseSchema: { type: "object" },
      acquireSendPermit,
    });
    try {
      expect(timeoutSpy).not.toHaveBeenCalled();
      grantFirst?.();
      await expect(result).resolves.toBe("ok");
      expect(timeoutSpy).toHaveBeenCalledTimes(1);
      expect(seenSignals).toHaveLength(2);
      expect(seenSignals[0]).toBe(seenSignals[1]);
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it("lets caller cancellation detach the first permit wait without starting a deadline", async () => {
    const controller = new AbortController();
    const timeoutMock = spyOn(AbortSignal, "timeout").mockImplementation(AbortSignal.timeout);
    let sends = 0;
    const acquireSendPermit = async (_model: string, signal?: AbortSignal) => {
      await new Promise<never>((_resolve, reject) => {
        if (signal?.aborted) {
          reject(signal.reason);
          return;
        }
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      return () => {};
    };
    const fetchImpl = (async () => {
      sends += 1;
      return new Response("unexpected", { status: 200 });
    }) as unknown as typeof fetch;
    const client = createLmStudioVisionClient(config, fetchImpl);
    const result = client.annotate({
      model: "vision-model",
      prompt: "p",
      images: [],
      signal: controller.signal,
      acquireSendPermit,
    });
    try {
      expect(timeoutMock).not.toHaveBeenCalled();
      const reason = new Error("caller cancelled while waiting");
      controller.abort(reason);
      await expect(result).rejects.toBe(reason);
      expect(timeoutMock).not.toHaveBeenCalled();
      expect(sends).toBe(0);
    } finally {
      timeoutMock.mockRestore();
    }
  });

  it("keeps the original deadline while the schema retry waits for a permit", async () => {
    const deadline = new AbortController();
    const timeoutSignals: AbortSignal[] = [];
    const timeoutMock = spyOn(AbortSignal, "timeout").mockImplementation(() => {
      timeoutSignals.push(deadline.signal);
      return deadline.signal;
    });
    const fetchSignals: AbortSignal[] = [];
    let permitCalls = 0;
    let releaseRetry: (() => void) | undefined;
    const acquireSendPermit = async (_model: string, signal?: AbortSignal) => {
      permitCalls += 1;
      if (permitCalls === 1) return () => {};
      expect(signal).toBe(timeoutSignals[0]);
      await new Promise<void>((resolve) => {
        releaseRetry = resolve;
      });
      return () => {};
    };
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      fetchSignals.push(init?.signal as AbortSignal);
      return new Response("unsupported response_format", { status: 400 });
    }) as unknown as typeof fetch;
    const client = createLmStudioVisionClient(config, fetchImpl);
    const result = client.annotate({
      model: "vision-model",
      prompt: "p",
      images: [],
      responseSchema: { type: "object" },
      acquireSendPermit,
    });
    try {
      while (releaseRetry === undefined) await Promise.resolve();
      expect(timeoutMock).toHaveBeenCalledTimes(1);
      deadline.abort(new DOMException("deadline", "TimeoutError"));
      releaseRetry();
      await expect(result).rejects.toMatchObject({ code: "MODEL_TIMEOUT" });
      expect(fetchSignals).toHaveLength(1);
      expect(permitCalls).toBe(2);
    } finally {
      timeoutMock.mockRestore();
      releaseRetry?.();
    }
  });

  /**
   * 413（输入超长）不是 schema 形状问题：与网关共用同一条降级资格谓词，视觉链同样只有
   * 一次失败，不把图字节重传、不降 schema 档。
   */
  it("does not fall back on a 413 (input too long): one failure, generic code", async () => {
    const formats: (string | undefined)[] = [];
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        response_format?: { type?: string };
      };
      formats.push(body.response_format?.type);
      return new Response("payload too large", { status: 413 });
    }) as unknown as typeof fetch;
    const client = createLmStudioVisionClient(config, fetchImpl);
    const failure = await client
      .annotate({
        model: "vision-413-model",
        prompt: "p",
        images: [{ mimeType: "image/png", bytes: new Uint8Array([1]) }],
        responseSchema: { type: "object" },
      })
      .then(
        () => null,
        (error: unknown) => error as { code?: string; status?: number },
      );
    expect(formats).toEqual(["json_schema"]);
    expect(failure?.code).toBe("MODEL_ERROR");
    expect(failure?.status).toBe(413);
  });
});

it("propagates caller cancellation to the in-flight vision request", async () => {
  const controller = new AbortController();
  let reached!: () => void;
  const started = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let upstream: AbortSignal | undefined;
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    upstream = init?.signal ?? undefined;
    reached();
    return await new Promise<Response>((_resolve, reject) => {
      upstream?.addEventListener("abort", () => reject(upstream?.reason), { once: true });
    });
  }) as typeof fetch;
  const client = createLmStudioVisionClient(config, fetchImpl);
  const pending = client.annotate({
    model: "vision",
    prompt: "describe",
    images: [],
    signal: controller.signal,
  });
  await started;
  controller.abort(new Error("stop media task"));
  await expect(pending).rejects.toThrow("stop media task");
  expect(upstream?.aborted).toBe(true);
});

it("does not begin a vision request after its caller has cancelled", async () => {
  let calls = 0;
  const client = createLmStudioVisionClient(config, (async () => {
    calls++;
    return new Response("{}");
  }) as unknown as typeof fetch);
  const signal = AbortSignal.abort(new Error("already cancelled"));
  await expect(
    client.annotate({ model: "vision", prompt: "describe", images: [], signal }),
  ).rejects.toThrow("already cancelled");
  expect(calls).toBe(0);
});

it("releases a send permit after fetch failure so the next vision request can proceed", async () => {
  let active = false;
  let calls = 0;
  const acquireSendPermit = async () => {
    if (active) throw new Error("permit overlapped");
    active = true;
    return () => {
      active = false;
    };
  };
  const fetchImpl = (async () => {
    calls += 1;
    if (calls === 1) throw new Error("synthetic fetch failure");
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
      status: 200,
    });
  }) as unknown as typeof fetch;
  const client = createLmStudioVisionClient(config, fetchImpl);
  await expect(
    client.annotate({
      model: "vision-model",
      prompt: "p",
      images: [],
      acquireSendPermit,
    }),
  ).rejects.toMatchObject({ code: "MODEL_ERROR" });
  expect(active).toBe(false);
  await expect(
    client.annotate({ model: "vision-model", prompt: "p", images: [], acquireSendPermit }),
  ).resolves.toBe("ok");
  expect(active).toBe(false);
  expect(calls).toBe(2);
});

/**
 * 真实传输层回归：宿主机器设置了 HTTP_PROXY 且未设 NO_PROXY 时，Bun 的全局 fetch 连
 * 127.0.0.1 也会送进代理，图片理解全部 "Unable to connect"。视觉客户端的默认传输必须
 * 像网关一样绕开代理直达本地服务。本用例自带 stub 与环境变量（try/finally 还原），
 * 不改变其他用例的运行环境。
 */
it("reaches the local model service directly despite a dead HTTP_PROXY", async () => {
  const saved = {
    HTTP_PROXY: process.env.HTTP_PROXY,
    HTTPS_PROXY: process.env.HTTPS_PROXY,
    NO_PROXY: process.env.NO_PROXY,
    no_proxy: process.env.no_proxy,
  };
  const seen: Array<{ path: string; authorization: string | undefined; body: string }> = [];
  const stub = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      seen.push({ path: req.url ?? "", authorization: req.headers.authorization, body: raw });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    });
  });
  await new Promise<void>((resolve) => stub.listen(0, "127.0.0.1", resolve));
  const port = (stub.address() as { port: number }).port;
  try {
    process.env.HTTP_PROXY = "http://127.0.0.1:1"; // dead: nothing listening
    process.env.HTTPS_PROXY = "http://127.0.0.1:1";
    delete process.env.NO_PROXY;
    delete process.env.no_proxy;
    const client = createLmStudioVisionClient({
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: "text-model",
      timeoutSeconds: 5,
      apiKey: "secret",
    });
    const answer = await client.annotate({
      model: "vision-model",
      prompt: "写一段说明",
      images: [{ mimeType: "image/png", bytes: new Uint8Array([7, 8, 9]) }],
    });
    expect(answer).toBe("ok");
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await new Promise<void>((resolve) => stub.close(() => resolve()));
  }
  // 恰一次直达自己的 stub：带鉴权、模型名与图字节，而不是死代理的连接失败。
  expect(seen).toHaveLength(1);
  expect(seen[0]?.path).toBe("/v1/chat/completions");
  expect(seen[0]?.authorization).toBe("Bearer secret");
  const body = JSON.parse(seen[0]?.body ?? "{}") as {
    model: string;
    messages: { content: { type: string; image_url?: { url: string } }[] }[];
  };
  expect(body.model).toBe("vision-model");
  expect(body.messages[0]?.content[1]?.image_url?.url).toBe(
    `data:image/png;base64,${Buffer.from([7, 8, 9]).toString("base64")}`,
  );
});

// Provider URLs may point at a local port, so error guidance follows the resolved route,
// not the hostname. Exercise the vision transport as well as the shared mapper.
describe("vision transport maps errors by the resolved route", () => {
  type Captured = { code?: string; status?: number; message?: string };
  const capture = (pending: Promise<unknown>) =>
    pending.then(
      () => null,
      (error: unknown) => error as Captured,
    );
  const externalRoute = (model: string) =>
    model === "cloud/vision"
      ? { baseUrl: "https://external.provider.example/v1", apiKey: "external-secret-token" }
      : null;

  for (const status of [401, 403] as const) {
    it(`sends an external ${status} rejection to the provider's own key, not the local env`, async () => {
      const seen: { url: string; authorization: string }[] = [];
      const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
        const headers = init?.headers as Record<string, string>;
        seen.push({ url: String(url), authorization: headers.authorization });
        return new Response("invalid provider key", { status });
      }) as unknown as typeof fetch;
      const client = createLmStudioVisionClient(
        { ...config, apiKey: "local-only-token" },
        fetchImpl,
        { externalModel: externalRoute },
      );
      const failure = await capture(
        client.annotate({ model: "cloud/vision", prompt: "p", images: [] }),
      );
      // 实际传输走外部地址与外部 key；本地 token 没有出站。
      expect(seen).toEqual([
        {
          url: "https://external.provider.example/v1/chat/completions",
          authorization: "Bearer external-secret-token",
        },
      ]);
      expect(failure).toMatchObject({ code: "MODEL_SERVICE_UNAVAILABLE", status });
      expect(failure?.message).toContain("外部模型服务鉴权失败");
      expect(failure?.message).toContain("API key");
      expect(failure?.message).not.toContain("LM_STUDIO_API_KEY");
      expect(failure?.message).not.toContain("external-secret-token");
    });
  }

  it("reports an external connection failure as the external service, not the local one", async () => {
    const fetchImpl = (async () => {
      throw new Error("fetch failed");
    }) as unknown as typeof fetch;
    const client = createLmStudioVisionClient(
      { ...config, apiKey: "local-only-token" },
      fetchImpl,
      { externalModel: externalRoute },
    );
    const failure = await capture(
      client.annotate({ model: "cloud/vision", prompt: "p", images: [] }),
    );
    expect(failure?.code).toBe("MODEL_SERVICE_UNAVAILABLE");
    expect(failure?.status).toBeUndefined();
    expect(failure?.message).toContain("外部模型服务暂不可用");
    expect(failure?.message).not.toContain("本地模型服务");
    expect(failure?.message).not.toContain("external-secret-token");
  });

  it("keeps an external 503 generic with its status and without the provider key", async () => {
    const fetchImpl = (async () =>
      new Response('{"error":{"message":"upstream temporarily unavailable"}}', {
        status: 503,
      })) as unknown as typeof fetch;
    const client = createLmStudioVisionClient(
      { ...config, apiKey: "local-only-token" },
      fetchImpl,
      { externalModel: externalRoute },
    );
    const failure = await capture(
      client.annotate({ model: "cloud/vision", prompt: "p", images: [] }),
    );
    // 既有映射：503 仍是 MODEL_ERROR + status 503（只换文案的晚补不改码/状态）。
    expect(failure).toMatchObject({ code: "MODEL_ERROR", status: 503 });
    expect(failure?.message).not.toContain("external-secret-token");
  });

  it("keeps an undeclared model on the local route and local auth guidance", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string | URL) => {
      seen.push(String(url));
      return new Response("denied", { status: 401 });
    }) as unknown as typeof fetch;
    const client = createLmStudioVisionClient({ ...config, apiKey: "local-secret" }, fetchImpl, {
      externalModel: externalRoute,
    });
    const failure = await capture(
      client.annotate({ model: "local/vision", prompt: "p", images: [] }),
    );
    // 钩子在，但该模型没被声明：仍走本地地址与本地鉴权动作。
    expect(seen).toEqual([`${config.baseUrl}/chat/completions`]);
    expect(failure).toMatchObject({ code: "MODEL_SERVICE_UNAVAILABLE", status: 401 });
    expect(failure?.message).toContain("LM_STUDIO_API_KEY");
    expect(failure?.message).not.toContain("外部模型服务");
  });
});
