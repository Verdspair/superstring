import { expect, it } from "bun:test";
import http from "node:http";
import { createLmStudioClient } from "../../src/server/llm/model-gateway";

async function stub(run: (baseUrl: string) => Promise<void>) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify(
        req.url?.startsWith("/api/v1/models")
          ? {
              models: [
                {
                  type: "llm",
                  key: "actual-local",
                  loaded_instances: [{ id: "actual-local", config: { context_length: 16384 } }],
                },
              ],
            }
          : { data: [{ id: "actual-local" }] },
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(`http://127.0.0.1:${(server.address() as { port: number }).port}/v1`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
it("counts the actual fallback local model with explicit encoding; only an encoding or route change invalidates", async () => {
  await stub(async (baseUrl) => {
    let encoding: "o200k_base" | "cl100k_base" = "o200k_base";
    let revision = "one";
    const seen: string[] = [];
    const gateway = createLmStudioClient(
      { baseUrl, model: "missing", timeoutSeconds: 5 },
      {
        localModelEncoding: (model) => {
          seen.push(model);
          return model === "actual-local" ? { tokenizerEncoding: encoding, revision } : null;
        },
      },
    );
    const budget = await gateway.prepareContextModel!("missing");
    expect(budget.model).toBe("actual-local");
    expect(budget.capacity).toBe(16384);
    expect(budget.tokenizerEncoding).toBe("o200k_base");
    expect(budget.countText?.("你好")).toBeGreaterThan(0);
    expect(seen.every((model) => model === "actual-local")).toBe(true);
    // 无关模型写入推高整文件 revision：本模型生效编码未变 → 旧描述符仍当前，冻结计数器继续可用。
    budget.assertCurrent();
    revision = "two";
    budget.assertCurrent();
    expect(budget.countText?.("hello")).toBeGreaterThan(0);
    // 当前模型自己的编码声明真的变了 → 拒绝。
    encoding = "cl100k_base";
    expect(() => budget.assertCurrent()).toThrow();
  });
});
it("refuses a local budget once its encoding declaration is cleared", async () => {
  await stub(async (baseUrl) => {
    let declared = true;
    const gateway = createLmStudioClient(
      { baseUrl, model: "actual-local", timeoutSeconds: 5 },
      {
        localModelEncoding: () =>
          declared ? { tokenizerEncoding: "o200k_base", revision: "r1" } : null,
      },
    );
    const budget = await gateway.prepareContextModel!("actual-local");
    expect(budget.tokenizerEncoding).toBe("o200k_base");
    expect(budget.countText).toBeDefined();
    declared = false;
    expect(() => budget.assertCurrent()).toThrow();
  });
});
it("refuses a local budget after the model reroutes to an external provider", async () => {
  await stub(async (baseUrl) => {
    let external = false;
    const gateway = createLmStudioClient(
      { baseUrl, model: "actual-local", timeoutSeconds: 5 },
      {
        externalModel: (model) =>
          external && model === "actual-local"
            ? {
                baseUrl: "https://provider.invalid/v1",
                apiKey: null,
                contextWindow: 8192,
                tokenizerEncoding: "cl100k_base",
                providerRevision: 1,
              }
            : null,
        localModelEncoding: () => ({ tokenizerEncoding: "o200k_base", revision: "r1" }),
      },
    );
    const budget = await gateway.prepareContextModel!("actual-local");
    expect(budget.tokenizerEncoding).toBe("o200k_base");
    external = true;
    expect(() => budget.assertCurrent()).toThrow();
  });
});
it("keeps unspecified locals conservative and external declarations authoritative", async () => {
  await stub(async (baseUrl) => {
    const legacy = await createLmStudioClient({ baseUrl, model: "actual-local", timeoutSeconds: 5 })
      .prepareContextModel!("actual-local");
    expect(legacy.tokenizerEncoding).toBeUndefined();
    expect(legacy.countText).toBeUndefined();
    let localCalls = 0;
    const gateway = createLmStudioClient(
      { baseUrl, model: "external", timeoutSeconds: 5 },
      {
        externalModel: (model) =>
          model === "external"
            ? {
                baseUrl: "https://provider.invalid/v1",
                apiKey: null,
                contextWindow: 8192,
                tokenizerEncoding: "cl100k_base",
                providerRevision: 1,
              }
            : null,
        localModelEncoding: () => {
          localCalls++;
          return { tokenizerEncoding: "o200k_base", revision: "local" };
        },
      },
    );
    const budget = await gateway.prepareContextModel!("external");
    expect(budget.model).toBe("external");
    expect(budget.capacity).toBe(8192);
    expect(budget.tokenizerEncoding).toBe("cl100k_base");
    expect(localCalls).toBe(0);
  });
});
