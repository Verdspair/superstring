// T10 prepare 钩子基础：受信任宿主在 actualModel 冻结后、HTTP body 组装前做最终准备。
// 断言：钩子收到的 model === HTTP body 的 model（同一次 effectiveModel 结果，不漂）；
// 钩子输出的 messages/resolver 决定本 call 最终发送内容；无钩子路径逐字不变；
// 钩子抛错/abort/图片能力拒绝 → 零 HTTP；schema 受控重试与 tools 重试共用同一次 prepare；
// 准备中 decode/来源失败原样传播（CONTEXT_SOURCE_INVALID），不泛 unsupported。
import { describe, expect, it } from "bun:test";
import type { Server } from "node:http";
import http from "node:http";
import { createModelPort } from "../../src/server/agent/model-port";
import { createLmStudioClient } from "../../src/server/llm/model-gateway";
import type { ModelMessage } from "../../src/shared/contracts/agent-run";

/** 本地 stub 的连接登记：node:http 的 keep-alive 套接字会让 server.close() 等待，测试要显式清。 */
const sockets = new Set<import("node:net").Socket>();
function listen(handler: http.RequestListener): Promise<{ server: Server; port: number }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, port: (server.address() as { port: number }).port }),
    );
  });
}
const close = (server: Server) =>
  new Promise<void>((resolve) => {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    server.close(() => resolve());
  });

const OK = (content: string) =>
  JSON.stringify({ choices: [{ finish_reason: "stop", message: { content } }] });

/** 聊天桩：记录每次 chat 请求 body；/models 返回本地目录供 effectiveModel 判定。 */
function chatStub(answer = OK('{"kind":"none"}')) {
  const bodies: Array<Record<string, unknown>> = [];
  const handler: http.RequestListener = (req, res) => {
    if ((req.url ?? "").endsWith("/chat/completions")) {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        bodies.push(raw === "" ? {} : (JSON.parse(raw) as Record<string, unknown>));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(answer);
      });
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "local/model" }] }));
  };
  return { bodies, handler };
}

const TEXT: ModelMessage[] = [{ role: "user", content: [{ kind: "text", text: "hi" }] }];
const IMAGE_PART: ModelMessage = {
  role: "user",
  content: [
    { kind: "text", text: "看图" },
    {
      kind: "image",
      sourceId: "a1",
      revision: "r1",
      mimeType: "image/png",
      sha256: "0".repeat(64),
    },
  ],
};
const OWNER = { kind: "qq_group", id: "c1" } as const;

/** 建一个指向桩的 ModelPort；可选注入钩子。 */
async function withPort(
  stub: ReturnType<typeof chatStub>,
  check: (
    port: ReturnType<typeof createModelPort>,
    bodies: Array<Record<string, unknown>>,
  ) => Promise<void>,
) {
  const { server, port } = await listen(stub.handler);
  try {
    const gateway = createLmStudioClient({
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: "local/model",
      timeoutSeconds: 5,
    });
    await check(createModelPort({ gateway }), stub.bodies);
  } finally {
    await close(server);
  }
}

describe("model resolved prepare hook（T10 基础）", () => {
  it("钩子收到的 model 与 HTTP body 的 model 同值（used 冻结，不漂）", async () => {
    const stub = chatStub();
    // 装对象躲开 TS 对 let 的控制流收窄（闭包内赋值后 narrow 成 null 会打崩 toBe 的类型重载）。
    const seen: { model: string | null } = { model: null };
    await withPort(stub, async (port, bodies) => {
      await port.complete({
        messages: TEXT,
        model: "local/model",
        prepareWithResolved: async (input) => {
          seen.model = input.model;
          return {};
        },
      });
      expect(bodies).toHaveLength(1);
      expect(bodies[0]?.model).toBe("local/model");
    });
    expect(seen.model).toBe("local/model");
  });

  it("钩子收到的 messages 是原始 ModelMessage[]（未转 wire）", async () => {
    const stub = chatStub();
    const seen: { messages: readonly ModelMessage[] | null } = { messages: null };
    await withPort(stub, async (port) => {
      await port.complete({
        messages: TEXT,
        model: "local/model",
        prepareWithResolved: async (input) => {
          seen.messages = input.messages;
          return {};
        },
      });
    });
    expect(seen.messages).toEqual(TEXT);
  });

  it("无钩子路径逐字不变（纯文字保持字符串 content 旧行为）", async () => {
    const stub = chatStub();
    await withPort(stub, async (port, bodies) => {
      await port.complete({ messages: TEXT, model: "local/model" });
      expect(bodies).toHaveLength(1);
      expect(bodies[0]?.messages).toEqual([{ role: "user", content: "hi" }]);
    });
  });

  it("钩子输出替换最终 messages：替换后的内容进 wire，原 messages 不发", async () => {
    const stub = chatStub();
    const prepared: ModelMessage[] = [
      { role: "system", content: [{ kind: "text", text: "prepared-system" }] },
      { role: "user", content: [{ kind: "text", text: "prepared-user" }] },
    ];
    await withPort(stub, async (port, bodies) => {
      await port.complete({
        messages: TEXT,
        model: "local/model",
        prepareWithResolved: async () => ({ messages: prepared }),
      });
      expect(bodies).toHaveLength(1);
      expect(bodies[0]?.messages).toEqual([
        { role: "system", content: "prepared-system" },
        { role: "user", content: "prepared-user" },
      ]);
    });
  });

  it("钩子替换 resolver：带图消息按新 resolver 解析字节成 data URL", async () => {
    const stub = chatStub();
    const bytes = new Uint8Array([1, 2, 3]);
    await withPort(stub, async (port, bodies) => {
      await port.complete({
        messages: [IMAGE_PART],
        model: "local/model",
        runId: "run-1",
        owner: OWNER,
        imageResolver: {
          resolve: async () => {
            throw new Error("旧 resolver 不应被调用");
          },
        },
        prepareWithResolved: async () => ({
          imageResolver: { resolve: async () => ({ mimeType: "image/png", bytes }) },
        }),
      });
      const sent = bodies[0]?.messages as Array<{ content: unknown }>;
      const parts = sent[0]?.content as Array<{ type: string; image_url?: { url: string } }>;
      expect(
        parts.some(
          (part) =>
            part.type === "image_url" &&
            typeof part.image_url?.url === "string" &&
            part.image_url.url.startsWith("data:image/png;base64,"),
        ),
      ).toBe(true);
    });
  });

  it("vision:false 声明 + 钩子仍回图：发送前 MODEL_IMAGE_UNSUPPORTED，零 HTTP", async () => {
    let chatCalls = 0;
    const handler: http.RequestListener = (req, res) => {
      if ((req.url ?? "").endsWith("/chat/completions")) {
        chatCalls += 1;
        req.on("end", () => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(OK("x"));
        });
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "local/model" }] }));
    };
    const { server, port } = await listen(handler);
    try {
      const gateway = createLmStudioClient(
        { baseUrl: `http://127.0.0.1:${port}/v1`, model: "local/model", timeoutSeconds: 5 },
        {
          externalModel: (model) =>
            model === "novision/model"
              ? {
                  baseUrl: `http://127.0.0.1:${port}/v1`,
                  apiKey: null,
                  contextWindow: 8192,
                  vision: false,
                }
              : null,
        },
      );
      const hooked = createModelPort({ gateway });
      await expect(
        hooked.complete({
          messages: TEXT,
          model: "novision/model",
          prepareWithResolved: async (input) => {
            expect(input.imagesAllowed).toBe(false);
            return { messages: [IMAGE_PART] };
          },
        }),
      ).rejects.toMatchObject({ code: "MODEL_IMAGE_UNSUPPORTED" });
      expect(chatCalls).toBe(0);
    } finally {
      await close(server);
    }
  });

  it("vision 未声明（undefined）时 imagesAllowed=true：未知不全拒", async () => {
    const stub = chatStub(OK("ok"));
    await withPort(stub, async (port, bodies) => {
      await port.complete({
        messages: TEXT,
        model: "local/model",
        prepareWithResolved: async (input) => {
          expect(input.imagesAllowed).toBe(true);
          return {};
        },
      });
      expect(bodies).toHaveLength(1);
    });
  });

  it("钩子抛错：零 HTTP，错误原样传播", async () => {
    const stub = chatStub();
    await withPort(stub, async (port, bodies) => {
      await expect(
        port.complete({
          messages: TEXT,
          model: "local/model",
          prepareWithResolved: async () => {
            throw new Error("prepare failed");
          },
        }),
      ).rejects.toThrow("prepare failed");
      expect(bodies).toHaveLength(0);
    });
  });

  it("调用方 abort 在钩子准备期间：零 HTTP", async () => {
    const stub = chatStub();
    const controller = new AbortController();
    await withPort(stub, async (port, bodies) => {
      await expect(
        port.complete({
          messages: TEXT,
          model: "local/model",
          signal: controller.signal,
          prepareWithResolved: async (input) => {
            controller.abort();
            input.signal?.throwIfAborted();
            return {};
          },
        }),
      ).rejects.toThrow();
      expect(bodies).toHaveLength(0);
    });
  });

  it("schema 受控重试共用同一次 prepare：两次 HTTP 请求一次钩子，body model 不漂", async () => {
    let prepares = 0;
    const bodies: Array<Record<string, unknown>> = [];
    const handler: http.RequestListener = (req, res) => {
      if ((req.url ?? "").endsWith("/chat/completions")) {
        let raw = "";
        req.on("data", (chunk) => {
          raw += chunk;
        });
        req.on("end", () => {
          bodies.push(JSON.parse(raw) as Record<string, unknown>);
          const format = bodies[bodies.length - 1]?.response_format as
            | { type?: string }
            | undefined;
          if (format?.type === "json_schema") {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                error: { message: "response_format json_schema is not supported" },
              }),
            );
            return;
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(OK('{"score":7}'));
        });
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "local/model" }] }));
    };
    const { server, port } = await listen(handler);
    try {
      const gateway = createLmStudioClient({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: "local/model",
        timeoutSeconds: 5,
      });
      const port_ = createModelPort({ gateway });
      const result = await port_.complete({
        messages: TEXT,
        model: "local/model",
        responseSchema: { type: "object", properties: { score: { type: "integer" } } },
        prepareWithResolved: async () => {
          prepares += 1;
          return {};
        },
      });
      expect(result).toBe('{"score":7}');
      expect(bodies).toHaveLength(2);
      expect(bodies[0]?.model).toBe("local/model");
      expect(bodies[1]?.model).toBe("local/model");
      expect(prepares).toBe(1);
    } finally {
      await close(server);
    }
  });

  it("stream 路径同钩子：替换后的消息进 wire，body model 同 used", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const handler: http.RequestListener = (req, res) => {
      if ((req.url ?? "").endsWith("/chat/completions")) {
        let raw = "";
        req.on("data", (chunk) => {
          raw += chunk;
        });
        req.on("end", () => {
          bodies.push(JSON.parse(raw) as Record<string, unknown>);
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write('data: {"choices":[{"delta":{"content":"ok"}}]}\n');
          res.write("data: [DONE]\n");
          res.end();
        });
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "local/model" }] }));
    };
    const { server, port } = await listen(handler);
    try {
      const gateway = createLmStudioClient({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: "local/model",
        timeoutSeconds: 5,
      });
      const chunks: string[] = [];
      for await (const delta of createModelPort({ gateway }).streamText({
        messages: TEXT,
        model: "local/model",
        prepareWithResolved: async (input) => {
          expect(input.model).toBe("local/model");
          return {
            messages: [{ role: "user", content: [{ kind: "text", text: "stream-prepared" }] }],
          };
        },
      })) {
        chunks.push(delta);
      }
      expect(chunks.join("")).toBe("ok");
      expect(bodies).toHaveLength(1);
      expect(bodies[0]?.model).toBe("local/model");
      expect(bodies[0]?.messages).toEqual([{ role: "user", content: "stream-prepared" }]);
    } finally {
      await close(server);
    }
  });

  it("准备中来源失败原样传播：CONTEXT_SOURCE_INVALID 不泛 unsupported", async () => {
    const stub = chatStub();
    await withPort(stub, async (port, bodies) => {
      await expect(
        port.complete({
          messages: [IMAGE_PART],
          model: "local/model",
          runId: "run-1",
          owner: OWNER,
          imageResolver: {
            resolve: async () => {
              const err = new Error("来源失效");
              (err as { code?: string }).code = "CONTEXT_SOURCE_INVALID";
              throw err;
            },
          },
        }),
      ).rejects.toMatchObject({ code: "CONTEXT_SOURCE_INVALID" });
      expect(bodies).toHaveLength(0);
    });
  });

  it("两次调用同一 used（per-call 钩子，无替补）：每次 prepare 拿到当次 used", async () => {
    // 钩子 per-call 架构保证：每个新 call 重新 effectiveModel → prepare → send。
    const stub = chatStub();
    const seen: string[] = [];
    await withPort(stub, async (port, bodies) => {
      for (let i = 0; i < 2; i += 1) {
        await port.complete({
          messages: TEXT,
          model: "local/model",
          prepareWithResolved: async (input) => {
            seen.push(input.model);
            return {};
          },
        });
      }
      expect(seen).toEqual(["local/model", "local/model"]);
      expect(bodies).toHaveLength(2);
      expect(bodies[0]?.model).toBe("local/model");
      expect(bodies[1]?.model).toBe("local/model");
    });
  });

  it("configured 未加载→本地替补 used≠requested：图先真实 400 负缓存，摘图后纯文字发出", async () => {
    // /models 目录只有 local/text-only：请求 local/model（未加载）→ pickUsableModel 本地替补

    // availableLocal[0]（外部从不替补，那条路径不存在，不为它造假覆盖）。

    const REAL_PNG_1PX = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",

      "base64",
    );

    const bodies: Array<Record<string, unknown>> = [];

    let chatCalls = 0;

    let resolverCalls = 0;

    const handler: http.RequestListener = (req, res) => {
      if ((req.url ?? "").endsWith("/chat/completions")) {
        chatCalls += 1;

        let raw = "";

        req.on("data", (chunk) => {
          raw += chunk;
        });

        req.on("end", () => {
          bodies.push(JSON.parse(raw) as Record<string, unknown>);

          const sent = JSON.stringify(bodies[bodies.length - 1]?.messages);

          if (sent.includes('"image_url"')) {
            // 只对真实带图请求回 400 明确能力拒绝（非 401/5xx/内容错），触发负缓存登记。

            res.writeHead(400, { "content-type": "application/json" });

            res.end(
              JSON.stringify({
                error: { message: "Vision input is not supported by this endpoint." },
              }),
            );

            return;
          }

          res.writeHead(200, { "content-type": "application/json" });

          res.end(OK('{"kind":"none"}'));
        });

        return;
      }

      res.writeHead(200, { "content-type": "application/json" });

      res.end(JSON.stringify({ data: [{ id: "local/text-only" }] }));
    };

    const { server, port } = await listen(handler);

    try {
      const gateway = createLmStudioClient({
        baseUrl: `http://127.0.0.1:${port}/v1`,

        model: "local/model",

        timeoutSeconds: 5,
      });

      const port_ = createModelPort({ gateway });

      // 第一次：钩子拿到替补 used（≠requested）；未知能力 imagesAllowed=true 不拦，

      // 真实像素字节进 wire → 服务 400 → MODEL_IMAGE_UNSUPPORTED + 负缓存登记。

      await expect(
        port_.complete({
          messages: [IMAGE_PART],

          model: "local/model",

          runId: "run-sub-1",

          owner: OWNER,

          imageResolver: {
            resolve: async () => {
              resolverCalls += 1;

              return { mimeType: "image/png", bytes: REAL_PNG_1PX };
            },
          },

          prepareWithResolved: async (input) => {
            expect(input.model).toBe("local/text-only");

            expect(input.imagesAllowed).toBe(true);

            return {};
          },
        }),
      ).rejects.toMatchObject({ code: "MODEL_IMAGE_UNSUPPORTED" });

      expect(chatCalls).toBe(1);

      expect(resolverCalls).toBe(1);

      expect(bodies[0]?.model).toBe("local/text-only");

      const firstSent = bodies[0]?.messages as Array<{
        content: Array<{ type: string; image_url?: { url: string } }>;
      }>;

      expect(
        firstSent.some((message) =>
          message.content.some(
            (part) =>
              part.type === "image_url" &&
              part.image_url?.url === `data:image/png;base64,${REAL_PNG_1PX.toString("base64")}`,
          ),
        ),
      ).toBe(true);

      // 第二次（新 request）：负缓存使 imagesAllowed=false，钩子摘图后纯文字真发出。

      const result = await port_.complete({
        messages: [IMAGE_PART],

        model: "local/model",

        runId: "run-sub-2",

        owner: OWNER,

        imageResolver: {
          resolve: async () => {
            throw new Error("负缓存后不应再解析图片字节");
          },
        },

        prepareWithResolved: async (input) => {
          expect(input.model).toBe("local/text-only");

          expect(input.imagesAllowed).toBe(false);

          return {
            messages: [{ role: "user", content: [{ kind: "text", text: "看图" }] }],
          };
        },
      });

      expect(result).toBe('{"kind":"none"}');

      expect(chatCalls).toBe(2);

      expect(resolverCalls).toBe(1);

      expect(bodies[1]?.model).toBe("local/text-only");

      expect(JSON.stringify(bodies[1]?.messages).includes("image_url")).toBe(false);

      expect(bodies[1]?.messages).toEqual([{ role: "user", content: "看图" }]);
    } finally {
      await close(server);
    }
  });

  it("guard 始终放行：prepare 仍 1 次、无新视觉调用、总 HTTP 不变", async () => {
    let prepares = 0;
    let guardCalls = 0;
    const stub = chatStub();
    await withPort(stub, async (port, bodies) => {
      await port.complete({
        messages: TEXT,
        model: "local/model",
        prepareWithResolved: async () => {
          prepares += 1;
          return {};
        },
        assertPreparedCurrent: () => {
          guardCalls += 1;
        },
      });
      expect(prepares).toBe(1);
      expect(guardCalls).toBe(1);
      expect(bodies).toHaveLength(1);
    });
  });

  it("首 HTTP schema 4xx 拒后 guard 撤权：第二次 HTTP 为 0（零追加）", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    let attempts = 0;
    const handler: http.RequestListener = (req, res) => {
      if ((req.url ?? "").endsWith("/chat/completions")) {
        attempts += 1;
        let raw = "";
        req.on("data", (chunk) => {
          raw += chunk;
        });
        req.on("end", () => {
          bodies.push(JSON.parse(raw) as Record<string, unknown>);
          const format = bodies[bodies.length - 1]?.response_format as
            | { type?: string }
            | undefined;
          if (format?.type === "json_schema") {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                error: { message: "response_format json_schema is not supported" },
              }),
            );
            return;
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(OK('{"score":7}'));
        });
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "local/model" }] }));
    };
    const { server, port } = await listen(handler);
    try {
      const gateway = createLmStudioClient({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: "local/model",
        timeoutSeconds: 5,
      });
      const port_ = createModelPort({ gateway });
      await expect(
        port_.complete({
          messages: TEXT,
          model: "local/model",
          responseSchema: { type: "object", properties: { score: { type: "integer" } } },
          assertPreparedCurrent: () => {
            // 首次尝试后撤权：来源/配置 guard 失效。
            if (attempts >= 1) throw new Error("source revoked after first HTTP");
          },
        }),
      ).rejects.toThrow("source revoked after first HTTP");
      expect(attempts).toBe(1);
    } finally {
      await close(server);
    }
  });

  it("tools 4xx 重试同守卫：撤权后第二次 HTTP 为 0", async () => {
    let attempts = 0;
    const bodies: Array<Record<string, unknown>> = [];
    const handler: http.RequestListener = (req, res) => {
      if ((req.url ?? "").endsWith("/chat/completions")) {
        attempts += 1;
        let raw = "";
        req.on("data", (chunk) => {
          raw += chunk;
        });
        req.on("end", () => {
          bodies.push(JSON.parse(raw) as Record<string, unknown>);
          if (bodies[bodies.length - 1]?.tools !== undefined) {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: { message: "tools are not supported" } }));
            return;
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(OK('{"kind":"none"}'));
        });
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "local/model" }] }));
    };
    const { server, port } = await listen(handler);
    try {
      const gateway = createLmStudioClient(
        {
          baseUrl: `http://127.0.0.1:${port}/v1`,
          model: "local/model",
          timeoutSeconds: 5,
          apiKey: "test-token",
        },
        {
          externalModel: (model) =>
            model === "cloud/model"
              ? {
                  baseUrl: `http://127.0.0.1:${port}/v1`,
                  apiKey: null,
                  contextWindow: 8192,
                }
              : null,
        },
      );
      const port_ = createModelPort({ gateway });
      await expect(
        port_.complete({
          messages: TEXT,
          model: "cloud/model",
          tools: [
            {
              name: "speech.evaluate",
              description: "Score one target",
              parameters: { type: "object", properties: { targetId: { type: "string" } } },
            },
          ],
          assertPreparedCurrent: () => {
            if (attempts >= 1) throw new Error("provider revoked after first HTTP");
          },
        }),
      ).rejects.toThrow("provider revoked after first HTTP");
      expect(attempts).toBe(1);
    } finally {
      await close(server);
    }
  });

  it("直调 gateway 传钩子缺 preparedFrom：装配错误，零 HTTP", async () => {
    let attempts = 0;
    const handler: http.RequestListener = (req, res) => {
      if ((req.url ?? "").endsWith("/chat/completions")) {
        attempts += 1;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(OK("x"));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "local/model" }] }));
    };
    const { server, port } = await listen(handler);
    try {
      const gateway = createLmStudioClient({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: "local/model",
        timeoutSeconds: 5,
      });
      // 钩子存在而 preparedFrom 缺失：成对契约 fail closed（不静默忽略钩子）。
      await expect(
        gateway.complete({
          messages: [{ role: "user", content: "hi" }],
          model: "local/model",
          prepareWithResolved: async () => ({}),
        }),
      ).rejects.toThrow("prepareWithResolved and preparedFrom paired");
      expect(attempts).toBe(0);
    } finally {
      await close(server);
    }
  });

  it("直调 gateway 传 preparedFrom 缺钩子：装配错误，零 HTTP", async () => {
    let attempts = 0;
    const handler: http.RequestListener = (req, res) => {
      if ((req.url ?? "").endsWith("/chat/completions")) {
        attempts += 1;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(OK("x"));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "local/model" }] }));
    };
    const { server, port } = await listen(handler);
    try {
      const gateway = createLmStudioClient({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: "local/model",
        timeoutSeconds: 5,
      });
      await expect(
        gateway.complete({
          messages: [{ role: "user", content: "hi" }],
          model: "local/model",
          preparedFrom: { messages: TEXT },
        }),
      ).rejects.toThrow("prepareWithResolved and preparedFrom paired");
      expect(attempts).toBe(0);
    } finally {
      await close(server);
    }
  });

  it("stream 守卫在 timer 创建前执行：guard 抛错时 0 个新 timer（lifetime 未建）", async () => {
    let attempts = 0;
    const handler: http.RequestListener = (req, res) => {
      if ((req.url ?? "").endsWith("/chat/completions")) {
        attempts += 1;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write('data: {"choices":[{"delta":{"content":"ok"}}]}\n');
        res.write("data: [DONE]\n");
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "local/model" }] }));
    };
    const { server, port } = await listen(handler);
    // 只数 requestLifetime 创建的 5000ms 定时器（socket keepalive 等环境定时器按栈排除）。
    // 暖场流建 1 个为基线；带守卫的尝试里 lifetime 若先于 guard 创建会再 +1——正确顺序为 0。
    let lifetimeTimers = 0;
    let lifetimeDeltaAtGuard = -1;
    const realSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((
      fn: Parameters<typeof setTimeout>[0],
      ms?: number,
      ...rest: unknown[]
    ) => {
      if (ms === 5000 && new Error().stack?.includes("requestLifetime")) {
        lifetimeTimers += 1;
      }
      return realSetTimeout(fn as never, ms as never, ...(rest as never[]));
    }) as typeof setTimeout;
    try {
      const gateway = createLmStudioClient({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: "local/model",
        timeoutSeconds: 5,
      });
      // 先跑一次无守卫的暖场流（走完 lifetime/请求全程，/models 缓存 + agent socket 就位），
      // 记录基线；随后带守卫的尝试里，守卫进入点与基线之间新增 5000ms 定时器必须为 0
      // ——若 lifetime 先于 guard 创建，会多出恰好 1 个。不靠 timeoutSeconds 等待验证。
      for await (const _warm of createModelPort({ gateway }).streamText({
        messages: TEXT,
        model: "local/model",
      })) {
        void _warm;
      }
      attempts = 0; // 暖场那次真实 HTTP 不计入守卫零 HTTP 断言。
      const baseline = lifetimeTimers;
      await expect(
        (async () => {
          for await (const _delta of createModelPort({ gateway }).streamText({
            messages: TEXT,
            model: "local/model",
            assertPreparedCurrent: () => {
              lifetimeDeltaAtGuard = lifetimeTimers - baseline;
              throw new Error("revoked before timer creation");
            },
          })) {
            void _delta;
          }
        })(),
      ).rejects.toThrow("revoked before timer creation");
      expect(attempts).toBe(0);
      // 守卫先于 lifetime：本次尝试 0 个新 lifetime 定时器（不靠 timeoutSeconds 等待验证）。
      expect(lifetimeDeltaAtGuard).toBe(0);
    } finally {
      globalThis.setTimeout = realSetTimeout;
      await close(server);
    }
  });

  it("stream 发送前 guard 抛错：流不启动，零 HTTP", async () => {
    let attempts = 0;
    const handler: http.RequestListener = (req, res) => {
      if ((req.url ?? "").endsWith("/chat/completions")) {
        attempts += 1;
        req.on("end", () => {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write('data: {"choices":[{"delta":{"content":"ok"}}]}\n');
          res.write("data: [DONE]\n");
          res.end();
        });
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "local/model" }] }));
    };
    const { server, port } = await listen(handler);
    try {
      const gateway = createLmStudioClient({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        model: "local/model",
        timeoutSeconds: 5,
      });
      const collect = async () => {
        const chunks: string[] = [];
        for await (const delta of createModelPort({ gateway }).streamText({
          messages: TEXT,
          model: "local/model",
          assertPreparedCurrent: () => {
            throw new Error("revoked before stream send");
          },
        })) {
          chunks.push(delta);
        }
        return chunks.join("");
      };
      await expect(collect()).rejects.toThrow("revoked before stream send");
      expect(attempts).toBe(0);
    } finally {
      await close(server);
    }
  });
});
