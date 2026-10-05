// 装配级回归：externalModel 闭包把 provider 行的 vision 三态与 providerRevision 透传进网关。
// 网络边界：全部流量只到本机 port-0 桩；LM_STUDIO_BASE_URL 临时指向桩并在 finally 还原；
// runtime.start 不调用，密钥文件落 tmpdir 合成路径，无真实服务与真实密钥。

import { describe, expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { AGENT_DECISION_JSON_SCHEMA } from "../../src/server/agent/agent-specs";
import {
  createModelProvider,
  updateModelProvider,
} from "../../src/server/db/model-provider-repository";
import type { ChatMessage } from "../../src/server/llm/chat-content";
import { createRuntime } from "../../src/server/runtime";

const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

interface SeenRequest {
  url: string;
  body: Record<string, unknown>;
}

function startStub(respond: (body: Record<string, unknown>, res: http.ServerResponse) => void): {
  seen: SeenRequest[];
  origin: string;
  close: () => Promise<void>;
} {
  const seen: SeenRequest[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      const body = raw === "" ? {} : (JSON.parse(raw) as Record<string, unknown>);
      if ((req.url ?? "").endsWith("/chat/completions")) {
        seen.push({ url: req.url ?? "", body });
        respond(body, res);
        return;
      }
      // /models 容量探测等：空目录，不影响外部路由判断。
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [] }));
    });
  });
  server.listen(0, "127.0.0.1");
  return {
    seen,
    origin: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const answerText = (res: http.ServerResponse, text: string) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: text } }] }));
};

/** 服务明确拒绝图片**输入能力**的 400：命中网关的能力句式窗（400/422 + 能力话术）。 */
const answerImageUnsupported = (res: http.ServerResponse) => {
  res.writeHead(400, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { message: "image input not supported" } }));
};

describe("runtime 把 vision 三态与 providerRevision 接进 externalModel 闭包", () => {
  it("vision:false 带图零请求；vision:true 与未声明真实发图并保持 role", async () => {
    const savedBaseUrl = process.env.LM_STUDIO_BASE_URL;
    let runtime: ReturnType<typeof createRuntime> | undefined;
    let stub: ReturnType<typeof startStub> | undefined;
    try {
      stub = startStub((_body, res) => answerText(res, '{"kind":"none"}'));
      process.env.LM_STUDIO_BASE_URL = stub.origin;
      runtime = createRuntime({
        businessDbPath: ":memory:",
        browserStateSecret: "synthetic-image-capability-secret",
        modelProviderKeyPath: path.join(tmpdir(), `synthetic-provider-${randomUUID()}.key`),
      });
      createModelProvider(runtime.business.orm, {
        id: randomUUID(),
        name: "Synthetic vision cloud",
        baseUrl: stub.origin,
        apiKey: null,
        models: [
          {
            name: "cloud/vision-off",
            context_window: 8192,
            capabilities: {
              toolCalling: false,
              parallelToolCalls: false,
              vision: false,
              codeExecution: false,
            },
          },
          {
            name: "cloud/vision-on",
            context_window: 8192,
            capabilities: {
              toolCalling: true,
              parallelToolCalls: true,
              vision: true,
              codeExecution: false,
            },
          },
          { name: "cloud/vision-undeclared", context_window: 8192 },
        ],
        keyPath: path.join(tmpdir(), `synthetic-provider-${randomUUID()}.key`),
      });
      const imageMessage: ChatMessage = {
        role: "user",
        content: [
          { type: "text", text: "这张图里是什么？" },
          {
            type: "image_url",
            image_url: { url: `data:image/png;base64,${PNG_1PX.toString("base64")}` },
          },
        ],
      };

      // 1) vision:false：发前闸在网关内拦下，桩上不出现任何 chat/completions。
      await expect(
        runtime.gateway.complete({
          messages: [imageMessage],
          model: "cloud/vision-off",
          responseSchema: AGENT_DECISION_JSON_SCHEMA,
        }),
      ).rejects.toHaveProperty("code", "MODEL_IMAGE_UNSUPPORTED");
      expect(stub.seen).toHaveLength(0);

      // 2) vision:true：真实发到桩，user role 保持，image_url part 原样到达。
      await runtime.gateway.complete({
        messages: [imageMessage],
        model: "cloud/vision-on",
        responseSchema: AGENT_DECISION_JSON_SCHEMA,
      });
      expect(stub.seen).toHaveLength(1);
      const sent = stub.seen[0]?.body.messages as ChatMessage[] | undefined;
      expect(sent?.[0]?.role).toBe("user");
      const sentContent = sent?.[0]?.content;
      expect(
        Array.isArray(sentContent) && sentContent.some((part) => part.type === "image_url"),
      ).toBe(true);

      // 3) 未声明（undefined）＝不是 false：允许原生尝试，同样真实发到桩。
      await runtime.gateway.complete({
        messages: [imageMessage],
        model: "cloud/vision-undeclared",
        responseSchema: AGENT_DECISION_JSON_SCHEMA,
      });
      expect(stub.seen).toHaveLength(2);
      const secondMessages = stub.seen[1]?.body.messages as ChatMessage[] | undefined;
      expect(secondMessages?.[0]?.role).toBe("user");
    } finally {
      if (runtime) await runtime.stop();
      if (savedBaseUrl === undefined) delete process.env.LM_STUDIO_BASE_URL;
      else process.env.LM_STUDIO_BASE_URL = savedBaseUrl;
      if (stub) await stub.close();
    }
  });

  it("真实图片拒绝登记负缓存；同修订发前拦，CAS 推进修订后重试真实到达", async () => {
    const savedBaseUrl = process.env.LM_STUDIO_BASE_URL;
    let runtime: ReturnType<typeof createRuntime> | undefined;
    let stub: ReturnType<typeof startStub> | undefined;
    const keyPath = path.join(tmpdir(), `synthetic-provider-${randomUUID()}.key`);
    let rejectImages = true;
    try {
      stub = startStub((_body, res) => {
        if (rejectImages) {
          answerImageUnsupported(res);
          return;
        }
        answerText(res, '{"kind":"none"}');
      });
      process.env.LM_STUDIO_BASE_URL = stub.origin;
      runtime = createRuntime({
        businessDbPath: ":memory:",
        browserStateSecret: "synthetic-image-capability-secret",
        modelProviderKeyPath: keyPath,
      });
      const provider = createModelProvider(runtime.business.orm, {
        id: randomUUID(),
        name: "Synthetic revision cloud",
        baseUrl: stub.origin,
        apiKey: null,
        models: [
          {
            name: "cloud/flipped",
            context_window: 8192,
            capabilities: {
              toolCalling: false,
              parallelToolCalls: false,
              vision: true,
              codeExecution: false,
            },
          },
        ],
        keyPath,
      });
      const imageMessage: ChatMessage = {
        role: "user",
        content: [
          { type: "text", text: "看图" },
          {
            type: "image_url",
            image_url: { url: `data:image/png;base64,${PNG_1PX.toString("base64")}` },
          },
        ],
      };

      // 第一次：vision:true 不被发前闸拦，请求真实到达桩（calls=1），服务 400 明确拒绝
      // 图片输入 → MODEL_IMAGE_UNSUPPORTED，此刻负缓存才登记（指纹含 revision=1）。
      await expect(
        runtime.gateway.complete({
          messages: [imageMessage],
          model: "cloud/flipped",
          responseSchema: AGENT_DECISION_JSON_SCHEMA,
        }),
      ).rejects.toHaveProperty("code", "MODEL_IMAGE_UNSUPPORTED");
      expect(stub.seen).toHaveLength(1);

      // 第二次：同修订重试由负缓存在发前拦下，不再有网络请求（calls 仍=1）。
      await expect(
        runtime.gateway.complete({
          messages: [imageMessage],
          model: "cloud/flipped",
          responseSchema: AGENT_DECISION_JSON_SCHEMA,
        }),
      ).rejects.toHaveProperty("code", "MODEL_IMAGE_UNSUPPORTED");
      expect(stub.seen).toHaveLength(1);

      // CAS 推进修订（同模型同能力声明，只改名字；revision 1→2）并放行桩：
      // 负缓存指纹随 providerRevision 失效，第三次真实发出（calls=2）并成功。
      const updated = updateModelProvider(
        runtime.business.orm,
        provider.id,
        { name: "Synthetic revision cloud renamed" },
        provider.revision,
        keyPath,
      );
      expect(updated.revision).toBe(provider.revision + 1);
      expect(updated.models).toEqual(provider.models);
      rejectImages = false;
      await runtime.gateway.complete({
        messages: [imageMessage],
        model: "cloud/flipped",
        responseSchema: AGENT_DECISION_JSON_SCHEMA,
      });
      expect(stub.seen).toHaveLength(2);
      const retryMessages = stub.seen[1]?.body.messages as ChatMessage[] | undefined;
      expect(retryMessages?.[0]?.role).toBe("user");
      const retryContent = retryMessages?.[0]?.content;
      expect(
        Array.isArray(retryContent) && retryContent.some((part) => part.type === "image_url"),
      ).toBe(true);
    } finally {
      if (runtime) await runtime.stop();
      if (savedBaseUrl === undefined) delete process.env.LM_STUDIO_BASE_URL;
      else process.env.LM_STUDIO_BASE_URL = savedBaseUrl;
      if (stub) await stub.close();
    }
  });

  it("text-only 与 vision:false 声明纯文字照常发；toolCalling 传输开关行为不变", async () => {
    const savedBaseUrl = process.env.LM_STUDIO_BASE_URL;
    let runtime: ReturnType<typeof createRuntime> | undefined;
    let stub: ReturnType<typeof startStub> | undefined;
    try {
      stub = startStub((_body, res) => answerText(res, '{"kind":"none"}'));
      process.env.LM_STUDIO_BASE_URL = stub.origin;
      runtime = createRuntime({
        businessDbPath: ":memory:",
        browserStateSecret: "synthetic-image-capability-secret",
        modelProviderKeyPath: path.join(tmpdir(), `synthetic-provider-${randomUUID()}.key`),
      });
      createModelProvider(runtime.business.orm, {
        id: randomUUID(),
        name: "Synthetic text cloud",
        baseUrl: stub.origin,
        apiKey: null,
        models: [
          {
            name: "cloud/text-off",
            context_window: 8192,
            capabilities: {
              toolCalling: false,
              parallelToolCalls: false,
              codeExecution: false,
            },
          },
          {
            name: "cloud/text-vision-false",
            context_window: 8192,
            capabilities: {
              toolCalling: false,
              parallelToolCalls: false,
              vision: false,
              codeExecution: false,
            },
          },
          { name: "cloud/text-undeclared", context_window: 8192 },
        ],
        keyPath: path.join(tmpdir(), `synthetic-provider-${randomUUID()}.key`),
      });
      const textMessage: ChatMessage = { role: "user", content: "hi" };
      const tools = [
        {
          name: "speech.evaluate",
          description: "Score one target",
          parameters: { type: "object", properties: { targetId: { type: "string" } } },
        },
      ];

      // 纯文字请求不触发任何 vision 闸（vision:false 也不拦），toolCalling:false 不带 tools，
      // 未声明能力照发——现行传输行为保持。
      await runtime.gateway.complete({
        messages: [textMessage],
        model: "cloud/text-off",
        responseSchema: AGENT_DECISION_JSON_SCHEMA,
        tools,
      });
      await runtime.gateway.complete({
        messages: [textMessage],
        model: "cloud/text-vision-false",
        responseSchema: AGENT_DECISION_JSON_SCHEMA,
        tools,
      });
      await runtime.gateway.complete({
        messages: [textMessage],
        model: "cloud/text-undeclared",
        responseSchema: AGENT_DECISION_JSON_SCHEMA,
        tools,
      });
      expect(stub.seen).toHaveLength(3);
      expect(stub.seen[0]?.body.tools).toBeUndefined();
      expect(stub.seen[1]?.body.tools).toBeUndefined();
      expect(stub.seen[2]?.body.tools).toBeDefined();
    } finally {
      if (runtime) await runtime.stop();
      if (savedBaseUrl === undefined) delete process.env.LM_STUDIO_BASE_URL;
      else process.env.LM_STUDIO_BASE_URL = savedBaseUrl;
      if (stub) await stub.close();
    }
  });
});
