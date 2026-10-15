import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Server } from "node:http";
import http from "node:http";
import { createModelPort, type ModelContextBudget } from "../../src/server/agent/model-port";
import {
  createLmStudioClient,
  type ExternalModelRoute,
  type ModelGateway,
} from "../../src/server/llm/model-gateway";
import { loadTextTokenCounter } from "../../src/server/llm/text-token-counter";

// 上下文预算（SOURCE GO）离线用例：只跑真实网关 + 本地 HTTP 桩，不连真实服务。
// 覆盖：声明编码才有计数器（未知编码不导入）、请求模型落到实际模型的容量与 body model、
// 准备后 provider 修订变化在任何模型 HTTP 之前拒绝、取消保留原 reason、以及不带预算的
// 旧请求路径零变化（不多一次模型探测、不多一次计数）。
let server: Server;
let port = 0;
/** 每条路径的请求次数，用来断言"没有多余探测/没有多余计数请求"。 */
const hits: Record<string, number> = { chat: 0, models: 0, catalog: 0 };
const sentModels: string[] = [];
/** 桩当前声明的外部路由（可变＝配置修订变化的替身）。 */
let route: ExternalModelRoute | null = null;
/** 桩上被负载的本地模型及其容量。 */
let loadedLocal: { id: string; context_length: number } = {
  id: "local/model",
  context_length: 4096,
};

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const url = req.url ?? "";
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      if (url.startsWith("/v1/models")) {
        hits.models += 1;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: loadedLocal.id }] }));
        return;
      }
      if (url.startsWith("/api/v1/models")) {
        hits.catalog += 1;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            models: [
              {
                type: "llm",
                key: loadedLocal.id,
                loaded_instances: [
                  { id: loadedLocal.id, config: { context_length: loadedLocal.context_length } },
                ],
              },
            ],
          }),
        );
        return;
      }
      if (url.startsWith("/v1/chat/completions")) {
        hits.chat += 1;
        sentModels.push((JSON.parse(raw) as { model: string }).model);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [{ finish_reason: "stop", message: { content: "ok" } }],
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
      void raw;
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  port = (server.address() as { port: number }).port;
});

afterAll(() => {
  server?.close();
});

const localClient = (): ModelGateway =>
  createLmStudioClient({
    baseUrl: `http://127.0.0.1:${port}/v1`,
    model: "local/model",
    timeoutSeconds: 5,
  });

/** 外部路由桩：每次调用现读可变 `route`，与生产装配一样。 */
const externalClient = (): ModelGateway =>
  createLmStudioClient(
    {
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: "local/model",
      timeoutSeconds: 5,
    },
    {
      externalModel: (model) => (model === "cloud/model" ? route : null),
    },
  );

const resetHits = (): void => {
  sentModels.length = 0;
  hits.chat = 0;
  hits.models = 0;
  hits.catalog = 0;
};

describe("上下文预算准备：显式编码才有纯文本计数器", () => {
  it("未声明编码时没有计数器，也不导入任何编码", async () => {
    route = null;
    const budget = await localClient().prepareContextModel!("local/model");
    expect(budget.tokenizerEncoding).toBeUndefined();
    expect(budget.countText).toBeUndefined();
    // 容量按**实际**模型读（本地目录），不是请求名。
    expect(budget.capacity).toBe(4096);
    expect(budget.model).toBe("local/model");
  });

  it("声明的编码给出精确纯文本计数", async () => {
    route = {
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: "secret-token",
      contextWindow: 8192,
      tokenizerEncoding: "cl100k_base",
    };
    const budget = await externalClient().prepareContextModel!("cloud/model");
    expect(budget.model).toBe("cloud/model");
    expect(budget.capacity).toBe(8192);
    expect(budget.tokenizerEncoding).toBe("cl100k_base");
    const count = budget.countText!;
    const reference = (await loadTextTokenCounter("cl100k_base")).count;
    expect(count("hello world")).toBe(reference("hello world"));
    // 描述符只暴露描述符字段：服务地址、apiKey、密钥都不在元数据里。
    expect(Object.keys(budget)).toEqual(
      expect.arrayContaining(["model", "capacity", "tokenizerEncoding", "assertCurrent"]),
    );
    expect(Object.keys(budget)).not.toContain("apiKey");
    expect(Object.keys(budget)).not.toContain("baseUrl");
  });

  it("本地模型名声明不了编码：本地路由不猜", async () => {
    route = null;
    // 请求名未加载 → 实际模型是本地已加载的替补；替补没有外部声明，没有计数器。
    loadedLocal = { id: "other/model", context_length: 2048 };
    try {
      const budget = await localClient().prepareContextModel!("missing/model");
      expect(budget.model).toBe("other/model");
      expect(budget.capacity).toBe(2048);
      expect(budget.countText).toBeUndefined();
    } finally {
      loadedLocal = { id: "local/model", context_length: 4096 };
    }
  });
});

describe("上下文预算：路由当前性", () => {
  it("rejects an in-place provider revision change before sending", async () => {
    route = {
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: "secret-token",
      contextWindow: 8192,
      providerRevision: 3,
    };
    resetHits();
    const gateway = externalClient();
    const budget = await gateway.prepareContextModel!("cloud/model");
    Object.assign(route, { providerRevision: 4 });
    await expect(
      gateway.complete({
        messages: [{ role: "user", content: "hi" }],
        contextBudget: budget,
      }),
    ).rejects.toThrow("上下文预算已过期");
    expect(hits.chat).toBe(0);
  });

  it("准备后 provider 修订变化 → 在任何模型 HTTP 之前拒绝", async () => {
    route = {
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: "secret-token",
      contextWindow: 8192,
      tokenizerEncoding: "cl100k_base",
      providerRevision: 3,
    };
    resetHits();
    const gateway = externalClient();
    const budget = await gateway.prepareContextModel!("cloud/model");
    route = { ...route, providerRevision: 4 };
    await expect(
      gateway.complete({
        messages: [{ role: "user", content: "hi" }],
        model: "cloud/model",
        contextBudget: budget,
      }),
    ).rejects.toThrow("上下文预算已过期");
    expect(hits.chat).toBe(0);
  });

  it("准备后窗口或服务地址变化同样拒绝", async () => {
    route = {
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: "secret-token",
      contextWindow: 8192,
    };
    const gateway = externalClient();
    const budget = await gateway.prepareContextModel!("cloud/model");
    route = { ...route, contextWindow: 4096 };
    expect(() => budget.assertCurrent()).toThrow("上下文预算已过期");
  });

  it("配置未变时复验通过，请求按预算的模型发出", async () => {
    route = {
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: "secret-token",
      contextWindow: 8192,
      tokenizerEncoding: "cl100k_base",
      providerRevision: 3,
    };
    resetHits();
    const gateway = externalClient();
    const budget = await gateway.prepareContextModel!("cloud/model");
    expect(budget.routeRevision).toBe(3);
    const text = await gateway.complete({
      messages: [{ role: "user", content: "hi" }],
      model: "different/requested-model",
      contextBudget: budget,
    });
    expect(text).toBe("ok");
    expect(hits.chat).toBe(1);
    expect(sentModels).toEqual([budget.model]);
  });

  it("取消保留原 reason", async () => {
    route = {
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: "secret-token",
      contextWindow: 8192,
      tokenizerEncoding: "cl100k_base",
    };
    const controller = new AbortController();
    const reason = new Error("cancelled by caller");
    controller.abort(reason);
    await expect(
      externalClient().prepareContextModel!("cloud/model", { signal: controller.signal }),
    ).rejects.toBe(reason);
  });
});

describe("端口把预算透传给网关（可选面，缺席即旧行为）", () => {
  it("createModelPort 暴露 prepareContextModel，未实现时缺席", async () => {
    const withGateway = createModelPort({ gateway: externalClient() });
    expect(withGateway.prepareContextModel).toBeFunction();
    const budget = await withGateway.prepareContextModel!("cloud/model");
    expect(budget.model).toBe("cloud/model");
    route = { ...(route as ExternalModelRoute), contextWindow: 1024 };
    await expect(
      withGateway.complete({
        messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
        model: "cloud/model",
        contextBudget: budget,
      }),
    ).rejects.toThrow("上下文预算已过期");
    const bare = createModelPort({});
    expect(bare.prepareContextModel).toBeUndefined();
  });

  it("不带预算的请求路径零变化：不多一次模型探测、不多一次计数", async () => {
    route = null;
    resetHits();
    const gateway = localClient();
    const port = createModelPort({ gateway });
    const text = await port.complete({
      messages: [{ role: "user", content: [{ kind: "text", text: "hi" }] }],
    });
    expect(text).toBe("ok");
    // 旧路径只发一次 chat；/v1/models 由既有 5 秒 loaded 缓存服务，不因本改动新增请求。
    expect(hits.chat).toBe(1);
  });
});

describe("预算描述符是只读冻结的普通对象", () => {
  it("声明符被冻结，模型面不携带额外私有字段", () => {
    const budget: ModelContextBudget = Object.freeze({
      model: "cloud/model",
      capacity: 8192,
      tokenizerEncoding: "cl100k_base",
      countText: (text: string) => text.length,
      assertCurrent: () => {},
    });
    expect(Object.isFrozen(budget)).toBe(true);
  });
});
