import { describe, expect, it } from "bun:test";

// 原生 chat gateway 多模态 wire 契约：全部请求指向 127.0.0.1 合成桩，零真实网络。
import { createHash } from "node:crypto";
import type { Server } from "node:http";
import http from "node:http";
import type { AgentSpec } from "../../src/server/agent/agent-specs";
import {
  ContextEngine,
  type ContextMaterial,
  inputUnits,
  visionCostOf,
} from "../../src/server/agent/context-engine";
import {
  createImageByteResolver,
  type ImageByteResolver,
} from "../../src/server/agent/image-byte-resolver";
import { createModelPort } from "../../src/server/agent/model-port";
import { type AppError, isAppError, ModelUnavailableError } from "../../src/server/errors";
// 错误分类纯函数直测（golden）：能力拒绝 vs 内容层面错误的中英成对断言。
import { createLmStudioClient, type ExternalModelRoute } from "../../src/server/llm/model-gateway";
import type { ModelMessage, RunOwner } from "../../src/shared/contracts/agent-run";

const PNG_BYTES = new Uint8Array([1, 2, 3]);
const PNG_SHA = createHash("sha256").update(PNG_BYTES).digest("hex");
const OWNER: RunOwner = { kind: "qq_group", id: "conv-1" };
const DATA_URL = "data:image/png;base64,AQID";

function listen(handler: http.RequestListener): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, port: (server.address() as { port: number }).port }),
    );
  });
}

const close = (server: Server) => new Promise<void>((resolve) => server.close(() => resolve()));

/** 捕获 /chat/completions 请求体并按 handler 回答（JSON 或 SSE）。 */
function capturing(respond: (body: Record<string, unknown>, res: http.ServerResponse) => void): {
  seen: Record<string, unknown>[];
  handler: http.RequestListener;
} {
  const seen: Record<string, unknown>[] = [];
  const handler: http.RequestListener = (req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      const body = raw === "" ? {} : (JSON.parse(raw) as Record<string, unknown>);
      if ((req.url ?? "").includes("/chat/completions")) seen.push(body);
      respond(body, res);
    });
  };
  return { seen, handler };
}

function answer(res: http.ServerResponse, payload: unknown): void {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

const okNone = (res: http.ServerResponse) =>
  answer(res, { choices: [{ finish_reason: "stop", message: { content: '{"kind":"none"}' } }] });

const status = (code: number, body: string) => (res: http.ServerResponse) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(body);
};

const sse = (res: http.ServerResponse) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write('data: {"choices":[{"delta":{"content":"hi"}}]}\n');
  res.write("data: [DONE]\n");
  res.end();
};

const imagePart = {
  kind: "image" as const,
  sourceId: "m102-img",
  revision: "r1",
  mimeType: "image/png",
  sha256: PNG_SHA,
};

/** 只有 user 一条含图消息的最小请求（owner 隔离用例）。 */
function swappedImageMessages(): ModelMessage[] {
  return [
    { role: "system", content: [{ kind: "text", text: "sys" }] },
    {
      role: "user",
      content: [{ kind: "text", text: "看这张" }, imagePart],
    },
  ];
}

const multimodalMessages: ModelMessage[] = [
  { role: "system", content: [{ kind: "text", text: "sys-prompt" }] },
  {
    role: "user",
    content: [
      { kind: "text", text: "消息m102：阿林回复小周。" },
      imagePart,
      { kind: "text", text: "这张图属于m102，不是m101。" },
    ],
  },
  { role: "assistant", content: [{ kind: "text", text: "earlier" }] },
];

const flatSchema = {
  type: "object",
  properties: { kind: { type: "string" } },
  required: ["kind"],
  additionalProperties: false,
} as const;

interface Hosts {
  cloudSeen: Record<string, unknown>[];
  localSeen: Record<string, unknown>[];
  port: ReturnType<typeof createModelPort>;
  resolver: ImageByteResolver;
  dispose: () => Promise<void>;
}

async function hosts(options: {
  cloud: (res: http.ServerResponse) => void;
  local?: (res: http.ServerResponse) => void;
  vision?: boolean;
  modelCallConcurrency?: number;
  providerConcurrency?: number;
}): Promise<Hosts> {
  const cloud = capturing((_body, res) => options.cloud(res));
  const local = capturing((_body, res) => (options.local ?? okNone)(res));
  const cloudHost = await listen(cloud.handler);
  const localHost = await listen(local.handler);
  const vision = options.vision;
  const gateway = createLmStudioClient(
    {
      baseUrl: `http://127.0.0.1:${localHost.port}/v1`,
      model: "local/model",
      timeoutSeconds: 5,
      apiKey: "test-token",
    },
    {
      externalModel: (model): ExternalModelRoute | null =>
        model.startsWith("cloud/")
          ? {
              baseUrl: `http://127.0.0.1:${cloudHost.port}/v1`,
              apiKey: null,
              contextWindow: 8192,
              ...(vision === undefined ? {} : { vision }),
            }
          : null,
    },
  );
  const resolver = createImageByteResolver();
  resolver.register({
    runId: "run-1",
    owner: OWNER,
    part: imagePart,
    bytes: PNG_BYTES,
    sources: [{ kind: "qq_media", id: "m102-img", revision: "r1" }],
    assertCurrent: () => {},
  });
  const port = createModelPort({
    gateway,
    ...(options.modelCallConcurrency === undefined
      ? {}
      : { modelCallConcurrency: options.modelCallConcurrency }),
    ...(options.providerConcurrency === undefined
      ? {}
      : { providerConcurrency: options.providerConcurrency }),
  });
  return {
    cloudSeen: cloud.seen,
    localSeen: local.seen,
    port,
    resolver,
    dispose: async () => {
      await close(cloudHost.server);
      await close(localHost.server);
    },
  };
}

const completeArgs = (model: string, responseSchema: Record<string, unknown> = flatSchema) => ({
  messages: multimodalMessages,
  model,
  temperature: 0.2,
  maxTokens: 512,
  responseSchema,
  tools: [
    {
      name: "history.read",
      description: "Read history",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  ],
  runId: "run-1",
  owner: OWNER,
  imageResolver: undefined as ImageByteResolver | undefined,
});

describe("原生 chat gateway 多模态 wire", () => {
  it("完整 wire：角色顺序、[text,image_url,text]、tools、json_schema、参数正确（Step1/2）", async () => {
    const h = await hosts({ cloud: okNone });
    try {
      const args = { ...completeArgs("cloud/m-main"), imageResolver: h.resolver };
      await h.port.complete(args);
      expect(h.cloudSeen.length).toBe(1);
      const body = h.cloudSeen[0] as Record<string, unknown>;
      expect(body.model).toBe("cloud/m-main");
      expect(body.temperature).toBe(0.2);
      expect(body.max_tokens).toBe(512);
      const messages = body.messages as Array<{ role: string; content: unknown }>;
      expect(messages.map((m) => m.role)).toEqual(["system", "user", "assistant"]);
      expect(messages[0].content).toBe("sys-prompt");
      expect(messages[1].content).toEqual([
        { type: "text", text: "消息m102：阿林回复小周。" },
        { type: "image_url", image_url: { url: DATA_URL } },
        { type: "text", text: "这张图属于m102，不是m101。" },
      ]);
      expect(messages[2].content).toBe("earlier");
      expect((body.tools as Array<{ function: { name: string } }>)[0].function.name).toBe(
        "history.read",
      );
      expect((body.response_format as { type: string }).type).toBe("json_schema");
    } finally {
      await h.dispose();
    }
  });

  it("text-only 消息保持字符串 content（先 type narrow，不对数组调字符串操作）", async () => {
    const h = await hosts({ cloud: okNone });
    try {
      await h.port.complete({
        messages: [
          { role: "system", content: [{ kind: "text", text: "sys" }] },
          { role: "user", content: [{ kind: "text", text: "plain" }] },
        ],
        model: "cloud/m-text",
      });
      const body = h.cloudSeen[0] as { messages: Array<{ content: unknown }> };
      expect(body.messages[0].content).toBe("sys");
      expect(body.messages[1].content).toBe("plain");
    } finally {
      await h.dispose();
    }
  });

  it("同请求内无图消息保持字符串 content：只有含图消息转数组", async () => {
    const h = await hosts({ cloud: okNone });
    try {
      await h.port.complete({ ...completeArgs("cloud/m-mixed"), imageResolver: h.resolver });
      const body = h.cloudSeen[0] as { messages: Array<{ content: unknown }> };
      expect(body.messages[0].content).toBe("sys-prompt");
      expect(body.messages[2].content).toBe("earlier");
      expect(Array.isArray(body.messages[1].content)).toBe(true);
    } finally {
      await h.dispose();
    }
  });

  it("纯文字数组 content 在 vision:false 下不被拒（数组只含文字不是图片）", async () => {
    const h = await hosts({ cloud: okNone, vision: false });
    try {
      const raw = await h.port.complete({
        messages: [
          { role: "system", content: [{ kind: "text", text: "sys" }] },
          { role: "user", content: [{ kind: "text", text: "plain" }] },
        ],
        model: "cloud/m-textarray",
      });
      expect(raw).toBe('{"kind":"none"}');
      expect(h.cloudSeen.length).toBe(1);
    } finally {
      await h.dispose();
    }
  });

  it("本地路由与外部路由同 content 透传：未声明 vision 的本地也允许原生尝试", async () => {
    const h = await hosts({ cloud: okNone, local: okNone });
    try {
      await h.port.complete({ ...completeArgs("local/m-native"), imageResolver: h.resolver });
      const body = h.localSeen[0] as { messages: Array<{ content: unknown }> };
      expect(body.messages[1].content).toEqual([
        { type: "text", text: "消息m102：阿林回复小周。" },
        { type: "image_url", image_url: { url: DATA_URL } },
        { type: "text", text: "这张图属于m102，不是m101。" },
      ]);
    } finally {
      await h.dispose();
    }
  });

  it("tools fallback 与图片共存：服务拒绝 tools 后去掉 tools 重发，图片仍在（Step3）", async () => {
    let calls = 0;
    const h = await hosts({
      cloud: (res) => {
        calls += 1;
        if (calls === 1) status(400, '{"error":{"message":"tools are not supported"}}')(res);
        else okNone(res);
      },
    });
    try {
      const raw = await h.port.complete({
        ...completeArgs("cloud/m-tools"),
        responseSchema: undefined,
        imageResolver: h.resolver,
      });
      expect(raw).toBe('{"kind":"none"}');
      expect(h.cloudSeen.length).toBe(2);
      expect(h.cloudSeen[0].tools).toBeDefined();
      expect(h.cloudSeen[1].tools).toBeUndefined();
      for (const body of h.cloudSeen) {
        expect((body.messages as Array<{ content: unknown }>)[1].content).toEqual([
          { type: "text", text: "消息m102：阿林回复小周。" },
          { type: "image_url", image_url: { url: DATA_URL } },
          { type: "text", text: "这张图属于m102，不是m101。" },
        ]);
      }
    } finally {
      await h.dispose();
    }
  });

  it("流式 streamText 同样接 image 数组并整段占名额（Step4）", async () => {
    const h = await hosts({ cloud: sse });
    try {
      const chunks: string[] = [];
      for await (const delta of h.port.streamText({
        messages: multimodalMessages,
        model: "cloud/m-stream",
        runId: "run-1",
        owner: OWNER,
        imageResolver: h.resolver,
      })) {
        chunks.push(delta);
      }
      expect(chunks.join("")).toBe("hi");
      const body = h.cloudSeen[0] as {
        stream?: boolean;
        messages: Array<{ content: unknown }>;
      };
      expect(body.stream).toBe(true);
      expect(body.messages[1].content).toEqual([
        { type: "text", text: "消息m102：阿林回复小周。" },
        { type: "image_url", image_url: { url: DATA_URL } },
        { type: "text", text: "这张图属于m102，不是m101。" },
      ]);
    } finally {
      await h.dispose();
    }
  });
});

describe("错误分类：只有明确图片拒绝或 capability=false 才是 MODEL_IMAGE_UNSUPPORTED（Step6）", () => {
  it("provider 声明 vision=false：发请求前拒绝，零网络", async () => {
    const h = await hosts({ cloud: okNone, vision: false });
    try {
      const error = await h.port
        .complete({ ...completeArgs("cloud/m-off"), imageResolver: h.resolver })
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(error).toBeInstanceOf(ModelUnavailableError);
      expect((error as ModelUnavailableError).code).toBe("MODEL_IMAGE_UNSUPPORTED");
      expect(h.cloudSeen.length).toBe(0);
    } finally {
      await h.dispose();
    }
  });

  it("格式不支持/尺寸过大不是模型能力拒绝：原 code、仅 1 次请求、不毒 tools/schema 档，第二条合法图片仍可发", async () => {
    for (const text of [
      "unsupported image format: image/webp",
      "图片尺寸过大不支持",
      "image input not allowed at this size",
    ] as const) {
      let calls = 0;
      let failing = true;
      const h = await hosts({
        cloud: (res) => {
          calls += 1;
          if (failing) status(400, `{"error":{"message":"${text}"}}`)(res);
          else okNone(res);
        },
      });
      try {
        const args = { ...completeArgs(`cloud/m-badfmt-${calls}`), imageResolver: h.resolver };
        const first = (await h.port.complete(args).then(
          () => null,
          (e: unknown) => e,
        )) as ModelUnavailableError;
        expect(first).not.toBeNull();
        expect(first.code).not.toBe("MODEL_IMAGE_UNSUPPORTED");
        // 内容拒绝不走 tools 重发与 schema 降级链：图字节不重传，只有 1 次请求。
        expect(calls).toBe(1);
        // 不记 toolsUnavailable / 不降 schema 档：错误修正后同 provider/model 第二条合法
        // picture 必须仍带 tools + json_schema 原档发出（若 negative cache 或档位被污染，
        // 这次会在发请求前被 MODEL_IMAGE_UNSUPPORTED 拦下，calls 不再增长）。
        failing = false;
        const raw = await h.port.complete(args);
        expect(raw).toBe('{"kind":"none"}');
        expect(calls).toBe(2);
        const second = h.cloudSeen[calls - 1] as {
          tools?: unknown;
          response_format?: { type?: string };
        };
        expect(second.tools).toBeDefined();
        expect(second.response_format?.type).toBe("json_schema");
      } finally {
        await h.dispose();
      }
    }
  });

  it("429/408/413 携带能力句式也保持原 code/status：不映射 unsupported、不毒 negative cache，第二条合法图片仍发", async () => {
    for (const [code, text] of [
      [429, "vision is not supported on the free tier, upgrade your plan"],
      [408, "vision is not supported right now, please retry later"],
      [413, "this model does not support image input: request entity too large"],
    ] as const) {
      let calls = 0;
      let failing = true;
      const h = await hosts({
        cloud: (res) => {
          calls += 1;
          if (failing) status(code, `{"error":{"message":"${text}"}}`)(res);
          else okNone(res);
        },
      });
      try {
        const args = { ...completeArgs(`cloud/m-cap-${code}`), imageResolver: h.resolver };
        const first = (await h.port.complete(args).then(
          () => null,
          (e: unknown) => e,
        )) as ModelUnavailableError;
        // 暂时/超长状态不是能力声明：原 generic code + 原 HTTP status，不写 vision 负缓存。
        expect(first.code).toBe("MODEL_ERROR");
        expect((first as unknown as { status?: number }).status).toBe(code);
        expect(first.code).not.toBe("MODEL_IMAGE_UNSUPPORTED");
        expect(calls).toBe(1);
        // negative cache 未被登记：第二条合法请求真实到达服务。
        failing = false;
        const raw = await h.port.complete(args);
        expect(raw).toBe('{"kind":"none"}');
        expect(calls).toBe(2);
      } finally {
        await h.dispose();
      }
    }
  });

  it("未声明 + 明确图片拒绝：映射 MODEL_IMAGE_UNSUPPORTED，并按 provider+model 缓存后发前拒绝", async () => {
    let calls = 0;
    const h = await hosts({
      cloud: (res) => {
        calls += 1;
        status(400, '{"error":{"message":"this model does not support image input"}}')(res);
      },
    });
    try {
      const args = { ...completeArgs("cloud/m-reject"), imageResolver: h.resolver };
      const first = await h.port.complete(args).then(
        () => null,
        (e: unknown) => e,
      );
      expect((first as ModelUnavailableError).code).toBe("MODEL_IMAGE_UNSUPPORTED");
      expect(calls).toBe(1);
      const second = await h.port.complete(args).then(
        () => null,
        (e: unknown) => e,
      );
      expect((second as ModelUnavailableError).code).toBe("MODEL_IMAGE_UNSUPPORTED");
      expect(calls).toBe(1);
    } finally {
      await h.dispose();
    }
  });

  it("401/403/413/429/5xx 保持原 code，不猜「含 image 就不支持」", async () => {
    for (const [code, expected] of [
      [401, "MODEL_SERVICE_UNAVAILABLE"],
      [403, "MODEL_SERVICE_UNAVAILABLE"],
      [413, "MODEL_ERROR"],
      [429, "MODEL_ERROR"],
      [500, "MODEL_ERROR"],
    ] as const) {
      const h = await hosts({ cloud: status(code, '{"error":{"message":"boom"}}') });
      try {
        const error = (await h.port
          .complete({ ...completeArgs(`cloud/m-${code}`), imageResolver: h.resolver })
          .then(
            () => null,
            (e: unknown) => e,
          )) as ModelUnavailableError;
        expect(error.code).toBe(expected);
        expect(error.code).not.toBe("MODEL_IMAGE_UNSUPPORTED");
      } finally {
        await h.dispose();
      }
    }
  });

  it("与图片无关的 400 不是 MODEL_IMAGE_UNSUPPORTED", async () => {
    const h = await hosts({ cloud: status(400, '{"error":{"message":"invalid request"}}') });
    try {
      const error = (await h.port
        .complete({ ...completeArgs("cloud/m-plain400"), imageResolver: h.resolver })
        .then(
          () => null,
          (e: unknown) => e,
        )) as ModelUnavailableError;
      expect(error.code).not.toBe("MODEL_IMAGE_UNSUPPORTED");
    } finally {
      await h.dispose();
    }
  });

  it("流式请求被服务明确拒绝图片：同样映射 MODEL_IMAGE_UNSUPPORTED（stream 同边界）", async () => {
    let calls = 0;
    const h = await hosts({
      cloud: (res) => {
        calls += 1;
        status(400, '{"error":{"message":"image input is not supported by this model"}}')(res);
      },
    });
    try {
      const error = await (async () => {
        const iterator = h.port.streamText({
          ...completeArgs("cloud/m-stream-reject"),
          responseSchema: undefined,
          tools: undefined,
          imageResolver: h.resolver,
        });
        try {
          for await (const _delta of iterator) void _delta;
          return null;
        } catch (e) {
          return e;
        }
      })();
      expect((error as ModelUnavailableError).code).toBe("MODEL_IMAGE_UNSUPPORTED");
      expect(calls).toBe(1);
    } finally {
      await h.dispose();
    }
  });

  it("流式 429/408 携带能力句式：保持原 code/status，不当 unsupported、不写 negative cache", async () => {
    for (const [code, text] of [
      [429, "vision is not supported on the free tier, upgrade your plan"],
      [408, "vision is not supported right now, please retry later"],
    ] as const) {
      let calls = 0;
      let failing = true;
      const h = await hosts({
        cloud: (res) => {
          calls += 1;
          if (failing) status(code, `{"error":{"message":"${text}"}}`)(res);
          else sse(res);
        },
      });
      try {
        const error = await (async () => {
          const iterator = h.port.streamText({
            ...completeArgs(`cloud/m-stream-${code}`),
            responseSchema: undefined,
            tools: undefined,
            imageResolver: h.resolver,
          });
          try {
            for await (const _delta of iterator) void _delta;
            return null;
          } catch (e) {
            return e;
          }
        })();
        const mapped = error as ModelUnavailableError;
        expect(mapped.code).toBe("MODEL_ERROR");
        expect((mapped as unknown as { status?: number }).status).toBe(code);
        expect(mapped.code).not.toBe("MODEL_IMAGE_UNSUPPORTED");
        expect(calls).toBe(1);
        // negative cache 未被登记：第二条合法流式请求真实发出并成功。
        failing = false;
        const chunks: string[] = [];
        for await (const delta of h.port.streamText({
          ...completeArgs(`cloud/m-stream-${code}`),
          responseSchema: undefined,
          tools: undefined,
          imageResolver: h.resolver,
        })) {
          chunks.push(delta);
        }
        expect(chunks.join("")).toBe("hi");
        expect(calls).toBe(2);
      } finally {
        await h.dispose();
      }
    }
  });

  it("含图片词但不是能力拒绝的错误保持原 code：invalid URL、schema、413、5xx", async () => {
    for (const [code, text, expected] of [
      [400, '{"error":{"message":"image URL is invalid"}}', "MODEL_ERROR"],
      [400, '{"error":{"message":"image part schema mismatch"}}', "MODEL_ERROR"],
      [413, '{"error":{"message":"image too large"}}', "MODEL_ERROR"],
      [429, '{"error":{"message":"image rate limited"}}', "MODEL_ERROR"],
      [500, '{"error":{"message":"image decode failed"}}', "MODEL_ERROR"],
    ] as const) {
      const h = await hosts({ cloud: status(code, text) });
      try {
        const error = (await h.port
          .complete({ ...completeArgs(`cloud/m-img-${code}`), imageResolver: h.resolver })
          .then(
            () => null,
            (e: unknown) => e,
          )) as ModelUnavailableError;
        expect(error.code).toBe(expected);
        expect(error.code).not.toBe("MODEL_IMAGE_UNSUPPORTED");
      } finally {
        await h.dispose();
      }
    }
  });

  it(
    "golden（真实 gateway/stub 断言，不经源码导出）：真能力拒绝 400/422 → MODEL_IMAGE_UNSUPPORTED 且只 1 次请求；" +
      "内容/暂时状态 → 原 code 且不写 negative cache",
    async () => {
      // 正例：400/422 且句式确实是能力拒绝 → 分类生效、单请求、按 provider+model 记住后发前拦截。
      for (const [code, text] of [
        [400, "this model does not support image input"],
        [422, "vision is not supported"],
        [400, "该模型不支持图片输入"],
      ] as const) {
        let calls = 0;
        const h = await hosts({
          cloud: (res) => {
            calls += 1;
            status(code, `{"error":{"message":"${text}"}}`)(res);
          },
        });
        try {
          const args = { ...completeArgs(`cloud/m-gold-${code}`), imageResolver: h.resolver };
          const first = (await h.port.complete(args).then(
            () => null,
            (e: unknown) => e,
          )) as ModelUnavailableError;
          expect(first.code).toBe("MODEL_IMAGE_UNSUPPORTED");
          expect(calls).toBe(1);
          const second = await h.port.complete(args).then(
            () => null,
            (e: unknown) => e,
          );
          expect((second as ModelUnavailableError).code).toBe("MODEL_IMAGE_UNSUPPORTED");
          expect(calls).toBe(1);
        } finally {
          await h.dispose();
        }
      }
      // 负例：400/422 的内容层面错误与 408/413/429/500 任何文案 → 原码，绝不写负缓存。
      for (const [code, text] of [
        [400, "unsupported image format: image/webp"],
        [400, "image URL is invalid"],
        [400, "image part schema mismatch"],
        [400, "the image exceeds the pixel limit"],
        [400, "图片损坏，无法处理"],
        [408, "vision is not supported right now, please retry later"],
        [413, "vision is not supported: payload too large"],
        [429, "vision is not supported, slow down"],
        [500, "vision is not supported (internal error)"],
      ] as const) {
        let calls = 0;
        let failing = true;
        const h = await hosts({
          cloud: (res) => {
            calls += 1;
            if (failing) status(code, `{"error":{"message":"${text}"}}`)(res);
            else okNone(res);
          },
        });
        try {
          const args = { ...completeArgs(`cloud/m-goldneg-${code}`), imageResolver: h.resolver };
          const first = (await h.port.complete(args).then(
            () => null,
            (e: unknown) => e,
          )) as ModelUnavailableError;
          expect(first.code).not.toBe("MODEL_IMAGE_UNSUPPORTED");
          failing = false;
          await h.port.complete(args);
          expect(calls).toBe(2);
        } finally {
          await h.dispose();
        }
      }
    },
  );

  it("413 输入超长如实一次失败：不降 schema 档、不记 toolsUnavailable，后续合法请求仍带 tools+原结构档", async () => {
    let calls = 0;
    let failing = true;
    const h = await hosts({
      cloud: (res) => {
        calls += 1;
        if (failing) status(413, '{"error":{"message":"request entity too large"}}')(res);
        else okNone(res);
      },
    });
    try {
      const args = { ...completeArgs("cloud/m-413chain"), imageResolver: h.resolver };
      const error = (await h.port.complete(args).then(
        () => null,
        (e: unknown) => e,
      )) as ModelUnavailableError;
      // 只有 1 次失败：413 不进 tools/schema 形状降级链（否则全部图字节最多重传 5 次）。
      expect(error.code).not.toBe("MODEL_IMAGE_UNSUPPORTED");
      expect(error.code).not.toBe("MODEL_NOT_LOADED");
      expect(calls).toBe(1);
      // 不记 toolsUnavailable / 不降 schema 档：同服务后续合法请求仍带 tools + json_schema 原档。
      failing = false;
      const raw = await h.port.complete(args);
      expect(raw).toBe('{"kind":"none"}');
      expect(calls).toBe(2);
      const second = h.cloudSeen[1] as { tools?: unknown; response_format?: { type?: string } };
      expect(second.tools).toBeDefined();
      expect(second.response_format?.type).toBe("json_schema");
    } finally {
      await h.dispose();
    }
  });

  it("413 输入超长（text-only 也一样）：保持原 generic code，不伪结构拒，只有一次请求", async () => {
    let calls = 0;
    const h = await hosts({
      cloud: (res) => {
        calls += 1;
        status(413, '{"error":{"message":"payload too large"}}')(res);
      },
    });
    try {
      const error = (await h.port
        .complete({
          messages: [
            { role: "system", content: [{ kind: "text", text: "sys" }] },
            { role: "user", content: [{ kind: "text", text: "plain" }] },
          ],
          model: "cloud/m-413text",
          responseSchema: flatSchema,
          tools: undefined,
        })
        .then(
          () => null,
          (e: unknown) => e,
        )) as ModelUnavailableError;
      expect(error.code).not.toBe("MODEL_IMAGE_UNSUPPORTED");
      expect(calls).toBe(1);
    } finally {
      await h.dispose();
    }
  });

  it("text-only 请求撞上带图片词的形状拒绝：不标内容拒绝，沿原 fallback 可成功", async () => {
    // 服务 400 的文案同时含图片词与内容词（"size"/"schema"），但请求本身没有图——
    // 这是 tools/response_format 形状拒绝，不该被当成"图片内容被拒"丢掉降级资格。
    let calls = 0;
    const h = await hosts({
      cloud: (res) => {
        calls += 1;
        const last = h.cloudSeen[h.cloudSeen.length - 1] as {
          response_format?: { type?: string };
        };
        const format = last.response_format?.type;
        if (format === "json_schema")
          status(
            400,
            '{"error":{"message":"the image field in your json schema is invalid at this size"}}',
          )(res);
        else if (format === "json_object")
          status(400, '{"error":{"message":"json_object rejected too"}}')(res);
        else okNone(res);
      },
    });
    try {
      const error = await h.port
        .complete({
          messages: [
            { role: "system", content: [{ kind: "text", text: "sys" }] },
            { role: "user", content: [{ kind: "text", text: "plain" }] },
          ],
          model: "cloud/m-textfmt",
          responseSchema: flatSchema,
          tools: [
            {
              name: "history.read",
              description: "Read history",
              parameters: { type: "object", properties: {}, additionalProperties: false },
            },
          ],
        })
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(error).toBeNull();
      // 沿原链降级：json_schema(+tools) 400 → 去掉 tools 重发 json_schema 400 →
      // json_object 400 → none 成功（json_object 也拒是桩文案，非本例目标）。
      expect(calls).toBe(4);
      const bodies = h.cloudSeen.map(
        (b) =>
          b as {
            tools?: unknown;
            response_format?: { type?: string };
          },
      );
      expect(bodies[0].tools).toBeDefined();
      expect(bodies[0].response_format?.type).toBe("json_schema");
      expect(bodies[1].tools).toBeUndefined();
      expect(bodies[1].response_format?.type).toBe("json_schema");
      expect(bodies[2].tools).toBeUndefined();
      expect(bodies[2].response_format?.type).toBe("json_object");
      expect(bodies[3].response_format).toBeUndefined();
    } finally {
      await h.dispose();
    }
  });

  it("公开错误消息不回显 provider 原文", async () => {
    const h = await hosts({
      cloud: status(400, '{"error":{"message":"internal secret relay detail xyzzy"}}'),
    });
    try {
      const error = (await h.port
        .complete({
          ...completeArgs("cloud/m-echo"),
          responseSchema: undefined,
          tools: undefined,
          imageResolver: h.resolver,
        })
        .then(
          () => null,
          (e: unknown) => e,
        )) as ModelUnavailableError;
      expect(error.message).not.toContain("xyzzy");
    } finally {
      await h.dispose();
    }
  });

  it("未声明 provider 成功带图：原生尝试成功，后续不拦", async () => {
    const h = await hosts({ cloud: okNone });
    try {
      const args = { ...completeArgs("cloud/m-success"), imageResolver: h.resolver };
      await h.port.complete(args);
      await h.port.complete(args);
      expect(h.cloudSeen.length).toBe(2);
    } finally {
      await h.dispose();
    }
  });
});

describe("port 边界与字节隔离", () => {
  it("缺可信 run/owner/resolver 是来源缺陷不是模型不支持：CONTEXT_SOURCE_INVALID，不发请求", async () => {
    const h = await hosts({ cloud: okNone });
    try {
      const error = (await h.port.complete(completeArgs("cloud/m-nores")).then(
        () => null,
        (e: unknown) => e,
      )) as ModelUnavailableError;
      expect(error.code).toBe("CONTEXT_SOURCE_INVALID");
      expect(error.code).not.toBe("MODEL_IMAGE_UNSUPPORTED");
      expect(h.cloudSeen.length).toBe(0);
    } finally {
      await h.dispose();
    }
  });

  it("resolve 阶段 assertCurrent 失效（来源撤权）：来源错误，不发请求", async () => {
    const h = await hosts({ cloud: okNone });
    try {
      let current = true;
      const strict = createImageByteResolver();
      strict.register({
        runId: "run-1",
        owner: OWNER,
        part: imagePart,
        bytes: PNG_BYTES,
        sources: [{ kind: "qq_media", id: "m102-img", revision: "r1" }],
        assertCurrent: () => {
          if (!current) throw new Error("revoked");
        },
      });
      current = false;
      const error = (await h.port
        .complete({ ...completeArgs("cloud/m-revoked"), imageResolver: strict })
        .then(
          () => null,
          (e: unknown) => e,
        )) as ModelUnavailableError;
      expect(error.code).toBe("CONTEXT_SOURCE_INVALID");
      expect(error.code).not.toBe("MODEL_IMAGE_UNSUPPORTED");
      expect(h.cloudSeen.length).toBe(0);
    } finally {
      await h.dispose();
    }
  });

  it("resolve 中途被 caller 取消：保持 signal.reason 原样，不转 CONTEXT_SOURCE_INVALID，不发请求", async () => {
    const h = await hosts({ cloud: okNone });
    try {
      const controller = new AbortController();
      const cancelReason = new DOMException("caller cancelled", "AbortError");
      const hanging = createImageByteResolver();
      hanging.register({
        runId: "run-1",
        owner: OWNER,
        part: imagePart,
        bytes: PNG_BYTES,
        sources: [],
        assertCurrent: () => {},
      });
      const wrapped: ImageByteResolver = {
        register: hanging.register,
        release: hanging.release,
        resolve: async (input) => {
          controller.abort(cancelReason);
          input.signal.throwIfAborted();
          return { mimeType: "image/png", bytes: PNG_BYTES };
        },
      };
      const error = (await h.port
        .complete({
          ...completeArgs("cloud/m-cancel"),
          imageResolver: wrapped,
          signal: controller.signal,
        })
        .then(
          () => null,
          (e: unknown) => e,
        )) as unknown;
      expect(error === cancelReason).toBe(true);
      expect(error).not.toBeInstanceOf(ModelUnavailableError);
      expect(h.cloudSeen.length).toBe(0);
    } finally {
      await h.dispose();
    }
  });

  it("resolve 前 caller 已取消（preaborted）：signal.reason 原样，不发请求", async () => {
    const h = await hosts({ cloud: okNone });
    try {
      const controller = new AbortController();
      const cancelReason = new Error("preaborted reason");
      controller.abort(cancelReason);
      const error = (await h.port
        .complete({
          ...completeArgs("cloud/m-preabort"),
          imageResolver: h.resolver,
          signal: controller.signal,
        })
        .then(
          () => null,
          (e: unknown) => e,
        )) as Error;
      expect(error === cancelReason).toBe(true);
      expect(h.cloudSeen.length).toBe(0);
    } finally {
      await h.dispose();
    }
  });

  it("同 kind/id 不同 owner 身份不能取字节：跨 owner 拒绝", async () => {
    const h = await hosts({ cloud: okNone });
    try {
      const isolated = createImageByteResolver();
      isolated.register({
        runId: "run-1",
        owner: { kind: "qq_group", id: "conv-1", userId: "u1", agentId: "a1" },
        part: imagePart,
        bytes: PNG_BYTES,
        sources: [{ kind: "qq_media", id: "m102-img", revision: "r1" }],
        assertCurrent: () => {},
      });
      const swapped: ModelMessage[] = [
        {
          role: "user",
          content: [{ kind: "text", text: "hi" }, imagePart],
        },
      ];
      const error = (await h.port
        .complete({
          messages: swapped,
          model: "cloud/m-owner",
          runId: "run-1",
          owner: { kind: "qq_group", id: "conv-1", userId: "u2", agentId: "a1" },
          imageResolver: isolated,
        })
        .then(
          () => null,
          (e: unknown) => e,
        )) as AppError;
      expect(isAppError(error)).toBe(true);
      expect(error.code).not.toBe("MODEL_IMAGE_UNSUPPORTED");
      expect(h.cloudSeen.length).toBe(0);
    } finally {
      await h.dispose();
    }
  });

  it("同 run 正确 owner 解析有效（正测）", async () => {
    const h = await hosts({ cloud: okNone });
    try {
      const isolated = createImageByteResolver();
      isolated.register({
        runId: "run-1",
        owner: { kind: "qq_group", id: "conv-1", userId: "u1", agentId: "a1" },
        part: imagePart,
        bytes: PNG_BYTES,
        sources: [{ kind: "qq_media", id: "m102-img", revision: "r1" }],
        assertCurrent: () => {},
      });
      await h.port.complete({
        messages: swappedImageMessages(),
        model: "cloud/m-owner-ok",
        runId: "run-1",
        owner: { kind: "qq_group", id: "conv-1", userId: "u1", agentId: "a1" },
        imageResolver: isolated,
      });
      expect(h.cloudSeen.length).toBe(1);
    } finally {
      await h.dispose();
    }
  });

  it("release 只移除指定 owner：其他 owner 仍可解析", async () => {
    const isolated = createImageByteResolver();
    const ownerA = { kind: "qq_group", id: "conv-1" } as RunOwner;
    const ownerB = { kind: "web", id: "conv-1" } as RunOwner;
    isolated.register({
      runId: "run-1",
      owner: ownerA,
      part: imagePart,
      bytes: PNG_BYTES,
      sources: [],
      assertCurrent: () => {},
    });
    isolated.register({
      runId: "run-1",
      owner: ownerB,
      part: imagePart,
      bytes: PNG_BYTES,
      sources: [],
      assertCurrent: () => {},
    });
    isolated.release("run-1", ownerA);
    await expect(
      isolated.resolve({
        runId: "run-1",
        owner: ownerA,
        part: imagePart,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow();
    const kept = await isolated.resolve({
      runId: "run-1",
      owner: ownerB,
      part: imagePart,
      signal: new AbortController().signal,
    });
    expect(kept.mimeType).toBe("image/png");
  });

  it("错误与 wire 之外不携带 base64 字节", async () => {
    const h = await hosts({ cloud: okNone, vision: false });
    try {
      const error = (await h.port
        .complete({ ...completeArgs("cloud/m-leak"), imageResolver: h.resolver })
        .then(
          () => null,
          (e: unknown) => e,
        )) as Error;
      expect(JSON.stringify(error)).not.toContain("AQID");
    } finally {
      await h.dispose();
    }
  });

  it("两级限流对 image 调用同名额：并发1时串行（Step9）", async () => {
    let active = 0;
    let max = 0;
    const h = await hosts({
      cloud: async (res) => {
        active += 1;
        max = Math.max(max, active);
        await new Promise((r) => setTimeout(r, 30));
        active -= 1;
        okNone(res);
      },
      modelCallConcurrency: 1,
      providerConcurrency: 1,
    });
    try {
      const args = { ...completeArgs("cloud/m-serial"), imageResolver: h.resolver };
      await Promise.all([h.port.complete(args), h.port.complete(args)]);
      expect(max).toBe(1);
    } finally {
      await h.dispose();
    }
  });
});

describe("context-engine visionCost（Step7）", () => {
  const spec = {
    instructions: "i",
    availableActions: [],
    limits: { steps: 1 },
  } as unknown as AgentSpec;

  it("inputUnits 文字估算不变：image part 不计文字 token", () => {
    const textOnly: ModelMessage[] = [{ role: "user", content: [{ kind: "text", text: "hi" }] }];
    const withImage: ModelMessage[] = [
      {
        role: "user",
        content: [{ kind: "text", text: "hi" }, imagePart],
      },
    ];
    expect(inputUnits(withImage)).toBe(inputUnits(textOnly));
  });

  it("render 有图 → unknown（不是 0）；无图 → 精确 0", () => {
    const material: ContextMaterial = {
      history: [
        {
          role: "user",
          content: [
            { kind: "text", text: "看这张" },
            { ...imagePart, width: 4, height: 2 },
          ],
        },
      ],
    };
    const rendered = new ContextEngine().render(spec, material, [], ["t1"]);
    expect(rendered.visionCost).toEqual({ state: "unknown", images: 1, pixels: 8 });
    const plain = new ContextEngine().render(spec, {}, [], ["t1"]);
    expect(plain.visionCost).toEqual({ state: "estimated", images: 0, pixels: 0 });
    expect(visionCostOf(plain.messages)).toEqual(plain.visionCost);
  });
});
