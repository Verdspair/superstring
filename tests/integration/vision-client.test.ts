// The multimodal request shape (ADR0018 P5i; U05's decision, 2026-09-24).
//
// The gateway carries text, so pictures travel through this client instead. What it sends is a
// decided thing rather than an implementation detail: the images are data URLs, one entry per
// sampled frame, and the answer is constrained by a strict response schema — the same shape the
// gateway's own calls use. These cases pin exactly that, with `fetch` injected.

import { describe, expect, it } from "bun:test";
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
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
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
    const answer = await client.annotate({
      model: "vision-model",
      prompt: "写一段说明",
      images: [{ mimeType: "image/png", bytes: new Uint8Array([1]) }],
      responseSchema: { type: "object" },
    });
    expect(answer).toBe('{"a":1}');
    expect(formats).toEqual(["json_schema", "json_object"]);
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
