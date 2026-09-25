// 外部模型 API（0032，用户 2026-09-25）：provider 的读写、解析与容量来源。
//
// What is pinned here: the key never comes back over HTTP, a model name belongs to exactly one
// provider, the whole models list travels with compare-and-swap, and — the reason the page asks for
// a context window at all — a declared external model answers the capacity preflight from that
// number instead of asking the local service.
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApp } from "../../src/server/app";
import {
  readModelProviders,
  resolveModelProviderRoute,
} from "../../src/server/db/model-provider-repository";
import { ensureDefaults } from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { createLmStudioClient, pickUsableModel } from "../../src/server/llm/model-gateway";
import { createLmStudioVisionClient } from "../../src/server/llm/vision-client";
import type { ModelProviderResponse } from "../../src/shared/contracts/models";

const MODEL = "local-model";

function setup() {
  const business = openBusinessDb();
  ensureDefaults(business.orm, MODEL);
  // One key file for the whole test: the write path seals with it, so the read path can open it.
  const dir = mkdtempSync(path.join(tmpdir(), "model-providers-"));
  const keyPath = path.join(dir, "providers.key");
  const app = createApp({ business, modelProviderKeyPath: keyPath });
  return { business, orm: business.orm, app, keyPath, dir };
}

function cleanup(h: ReturnType<typeof setup>) {
  h.business.close();
  rmSync(h.dir, { recursive: true, force: true });
}

function json(app: ReturnType<typeof createApp>, method: string, path: string, payload: unknown) {
  return app.request(path, {
    method,
    body: JSON.stringify(payload),
    headers: { "content-type": "application/json" },
  });
}

async function body<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

describe("视觉调用也走外部路由（0032 后续）", () => {
  it("视觉模型声明成外部模型时，图片发到它的 provider；其他名字仍发本地", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string) => {
      seen.push(url);
      return new Response(JSON.stringify({ choices: [{ message: { content: "一笔" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const config = {
      baseUrl: "http://127.0.0.1:1234/v1",
      model: "local",
      timeoutSeconds: 5,
    };
    const vision = createLmStudioVisionClient(config, fetchImpl, {
      externalModel: (model) =>
        model === "gpt-6-luna" ? { baseUrl: "https://relay.invalid/v1/", apiKey: "sk-x" } : null,
    });
    await vision.annotate({ model: "gpt-6-luna", prompt: "看图", images: [] });
    await vision.annotate({ model: "local-vlm", prompt: "看图", images: [] });
    expect(seen[0]).toBe("https://relay.invalid/v1/chat/completions");
    expect(seen[1]).toBe("http://127.0.0.1:1234/v1/chat/completions");
  });
});

describe("配置的模型不可用时的替补（用户 2026-09-25）", () => {
  it("本地模型没加载时改用可用的，加载回来就用回原来的", () => {
    // 配置的是本地没加载的模型 → 用当前可用的第一个
    expect(
      pickUsableModel({
        configured: "3.8-27b-iq3s",
        availableLocal: ["qwen3-4b"],
        isExternal: false,
      }),
    ).toBe("qwen3-4b");
    // 加载回来 → 用回配置的那个（每次调用重新判定，不粘住替补）
    expect(
      pickUsableModel({
        configured: "3.8-27b-iq3s",
        availableLocal: ["3.8-27b-iq3s", "qwen3-4b"],
        isExternal: false,
      }),
    ).toBe("3.8-27b-iq3s");
  });

  it("外部声明的模型不参与替补（它是用户的选择，窗口也已在册）", () => {
    expect(
      pickUsableModel({ configured: "gpt-6-luna", availableLocal: ["qwen3-4b"], isExternal: true }),
    ).toBe("gpt-6-luna");
  });

  it("一个可用模型都没有时不发明替补，保留配置名让容量错误去解释", () => {
    expect(pickUsableModel({ configured: "missing", availableLocal: [], isExternal: false })).toBe(
      "missing",
    );
  });
});

describe("外部模型 API", () => {
  it("creates a provider without ever echoing the key, and normalizes nothing it was not asked to", async () => {
    const h = setup();
    try {
      const response = await json(h.app, "POST", "/models/providers", {
        name: "DeepSeek",
        base_url: "https://api.deepseek.com/v1/",
        api_key: "sk-secret-value",
        models: [{ name: "deepseek-chat", context_window: 65536 }],
      });
      expect(response.status).toBe(201);
      const created = await body<ModelProviderResponse>(response);
      expect(created).toEqual({
        id: created.id,
        name: "DeepSeek",
        base_url: "https://api.deepseek.com/v1/",
        has_api_key: true,
        models: [{ name: "deepseek-chat", context_window: 65536 }],
        revision: 1,
        created_at: expect.any(String),
        updated_at: expect.any(String),
      });
      // The key is write-only: the wire body must not contain it anywhere.
      expect(JSON.stringify(created)).not.toContain("sk-secret-value");
      // And a URL that is not http(s) is refused at the boundary.
      expect(
        (
          await json(h.app, "POST", "/models/providers", {
            name: "Bad",
            base_url: "ftp://example.invalid",
          })
        ).status,
      ).toBe(422);
    } finally {
      cleanup(h);
    }
  });

  it("refuses a duplicate provider name and a model name another provider already declares", async () => {
    const h = setup();
    try {
      expect(
        (
          await json(h.app, "POST", "/models/providers", {
            name: "A",
            base_url: "https://a.invalid/v1",
            models: [{ name: "shared-model", context_window: 8192 }],
          })
        ).status,
      ).toBe(201);
      expect(
        (
          await json(h.app, "POST", "/models/providers", {
            name: "A",
            base_url: "https://b.invalid/v1",
          })
        ).status,
      ).toBe(409);
      const clash = await json(h.app, "POST", "/models/providers", {
        name: "B",
        base_url: "https://b.invalid/v1",
        models: [{ name: "shared-model", context_window: 4096 }],
      });
      expect(clash.status).toBe(409);
      expect(JSON.stringify(await clash.json())).toContain("shared-model");
    } finally {
      cleanup(h);
    }
  });

  it("replaces the whole models list under compare-and-swap and clears the key explicitly", async () => {
    const h = setup();
    try {
      const created = await body<ModelProviderResponse>(
        await json(h.app, "POST", "/models/providers", {
          name: "Moonshot",
          base_url: "https://api.moonshot.cn/v1",
          api_key: "sk-moonshot",
          models: [{ name: "kimi-k2", context_window: 200000 }],
        }),
      );
      const updated = await body<ModelProviderResponse>(
        await json(h.app, "PATCH", `/models/providers/${created.id}`, {
          models: [{ name: "kimi-k2-turbo", context_window: 128000 }],
          expected_revision: created.revision,
        }),
      );
      expect(updated.models).toEqual([{ name: "kimi-k2-turbo", context_window: 128000 }]);
      expect(updated.revision).toBe(created.revision + 1);
      // `api_key` absent keeps the stored one; the response still only says whether one exists.
      expect(updated.has_api_key).toBe(true);
      expect(
        (
          await json(h.app, "PATCH", `/models/providers/${created.id}`, {
            expected_revision: created.revision,
          })
        ).status,
      ).toBe(409);
      const cleared = await body<ModelProviderResponse>(
        await json(h.app, "PATCH", `/models/providers/${created.id}`, {
          api_key: null,
          expected_revision: updated.revision,
        }),
      );
      expect(cleared.has_api_key).toBe(false);
      expect(
        (await h.app.request(`/models/providers/${created.id}`, { method: "DELETE" })).status,
      ).toBe(204);
      expect(readModelProviders(h.orm)).toEqual([]);
    } finally {
      cleanup(h);
    }
  });

  it("resolves a declared model to its provider and leaves every other name local", async () => {
    const h = setup();
    try {
      {
        const keyPath = h.keyPath;
        await json(h.app, "POST", "/models/providers", {
          name: "DeepSeek",
          base_url: "https://api.deepseek.com/v1",
          api_key: "sk-live",
          models: [{ name: "deepseek-chat", context_window: 65536 }],
        });
        const route = resolveModelProviderRoute(h.orm, "deepseek-chat", keyPath);
        expect(route).toEqual({
          providerId: expect.any(String),
          providerName: "DeepSeek",
          baseUrl: "https://api.deepseek.com/v1",
          apiKey: "sk-live",
          contextWindow: 65536,
        });
        expect(resolveModelProviderRoute(h.orm, MODEL, keyPath)).toBeNull();

        // The gateway answers capacity from the typed window, without touching the local service:
        // the client below points at a dead port, so any HTTP attempt would surface as an error.
        const gateway = createLmStudioClient(
          { baseUrl: "http://127.0.0.1:9/v1", model: MODEL, timeoutSeconds: 1 },
          {
            externalModel: (model) => {
              const found = resolveModelProviderRoute(h.orm, model, keyPath);
              return found === null
                ? null
                : {
                    baseUrl: found.baseUrl,
                    apiKey: found.apiKey,
                    contextWindow: found.contextWindow,
                  };
            },
          },
        );
        expect(await gateway.loadedContextCapacity("deepseek-chat")).toBe(65536);
        expect(gateway.config.model).toBe(MODEL);
      }
    } finally {
      cleanup(h);
    }
  });

  it("reports a failed connection test instead of pretending the provider answered", async () => {
    const h = setup();
    try {
      const created = await body<ModelProviderResponse>(
        await json(h.app, "POST", "/models/providers", {
          name: "Dead",
          // Port 9 (discard) refuses immediately, so the test route answers fast without a timeout.
          base_url: "http://127.0.0.1:9/v1",
        }),
      );
      const result = await body<{ ok: boolean; models: string[]; error: string | null }>(
        await json(h.app, "POST", `/models/providers/${created.id}/test`, {}),
      );
      expect(result.ok).toBe(false);
      expect(result.models).toEqual([]);
      expect(typeof result.error).toBe("string");
    } finally {
      cleanup(h);
    }
  });
});
