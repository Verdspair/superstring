import { act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentResponseSchema } from "../../src/shared/contracts";
import type { ModelProviderResponse } from "../../src/shared/contracts/models";
import { ApiError, api, type SuperstringApi } from "../../src/web/api";
import { useSuperstringStore as store } from "../../src/web/store";
import { summaryFixture } from "./helpers/chat-fixture";

type Catalog = Awaited<ReturnType<SuperstringApi["listModels"]>>;
const catalog: Catalog = {
  provider: "lm_studio",
  status: "available",
  models: ["local"],
  default_model: "local",
};
const provider: ModelProviderResponse = {
  id: "provider",
  name: "External",
  base_url: "https://fixture.invalid/v1",
  has_api_key: false,
  models: [{ name: "external", context_window: 8192 }],
  revision: 1,
  created_at: "2026-10-07T00:00:00.000Z",
  updated_at: "2026-10-07T00:00:00.000Z",
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function setup(
  listModels: SuperstringApi["listModels"],
  listModelProviders: SuperstringApi["listModelProviders"] = vi.fn().mockResolvedValue([provider]),
) {
  const client: SuperstringApi = {
    ...api,
    listModels,
    listAgents: vi.fn().mockResolvedValue([
      AgentResponseSchema.parse({
        id: "agent",
        name: "Agent",
        config_version: 1,
        model_name: "local",
        persona_intensity: 60,
        created_at: "2026-10-07T00:00:00.000Z",
        updated_at: "2026-10-07T00:00:00.000Z",
      }),
    ]),
    listConversations: vi
      .fn()
      .mockResolvedValue({ items: [summaryFixture("session")], nextCursor: null }),
    listModelProviders,
    getBrowserStateConfig: vi.fn().mockRejectedValue(new Error("no fixture browser storage")),
  };
  store.getState().resetForTests(client);
  const select = vi.fn().mockResolvedValue(undefined);
  store.setState({ selectConversation: select });
  return { client, select };
}
afterEach(() => {
  vi.restoreAllMocks();
  store.getState().resetForTests();
});

describe("bootstrap optional model reads", () => {
  it("opens the authoritative directory while the model catalog is still pending", async () => {
    const pending = deferred<Catalog>();
    const { select } = setup(() => pending.promise);
    const boot = store.getState().bootstrap();
    await act(async () => {});
    expect(store.getState().status).toBe("ready");
    expect(store.getState().directoryIds).toEqual(["test:session"]);
    expect(select).toHaveBeenCalledWith("test:session");
    await act(async () => {
      pending.resolve(catalog);
    });
    await boot;
    expect(store.getState().modelNames).toEqual(["local", "external"]);
  });
  it("keeps external models usable after a delayed local catalog failure", async () => {
    const pending = deferred<Catalog>();
    setup(() => pending.promise);
    const boot = store.getState().bootstrap();
    await act(async () => {});
    expect(store.getState().status).toBe("ready");
    await act(async () => {
      pending.reject(new Error("catalog unavailable"));
    });
    await boot;
    expect(store.getState().modelNames).toEqual(["external"]);
    expect(store.getState().modelStatus).toContain("catalog unavailable");
    expect(store.getState().error).toBeNull();
    expect(store.getState().modelStatus).toContain("已登记的外部模型仍可选择");
  });
  it("does not let a delayed old API catalog replace a newer bootstrap", async () => {
    const pending = deferred<Catalog>();
    const { select } = setup(() => pending.promise);
    const oldBoot = store.getState().bootstrap();
    await act(async () => {});
    expect(select).toHaveBeenCalledTimes(1);
    setup(async () => ({ ...catalog, models: ["new"], default_model: "new" }));
    await act(async () => {
      await store.getState().bootstrap();
    });
    await act(async () => {
      pending.resolve(catalog);
    });
    await oldBoot;
    expect(store.getState().modelNames).toEqual(["new", "external"]);
    expect(select).toHaveBeenCalledTimes(1);
  });
  it("retains complete model discovery when the model sources settle immediately", async () => {
    setup(async () => catalog);
    await store.getState().bootstrap();
    expect(store.getState().status).toBe("ready");
    expect(store.getState().loadedModelNames).toEqual(["local"]);
    expect(store.getState().externalModelNames).toEqual(["external"]);
  });
  it("keeps local models usable when the provider read fails", async () => {
    setup(async () => catalog, vi.fn().mockRejectedValue(new Error("providers unavailable")));
    await store.getState().bootstrap();
    const state = store.getState();
    expect(state.modelNames).toEqual(["local"]);
    expect(state.loadedModelNames).toEqual(["local"]);
    expect(state.externalModelNames).toEqual([]);
    expect(state.error).toBeNull();
    expect(state.modelStatus).toContain("本地模型仍可选择");
    expect(state.modelStatus).toContain("外部模型列表加载失败");
    expect(state.modelStatus).not.toContain("LM Studio 当前没有报告");
  });
  it("keeps a truthful status when neither model source answers", async () => {
    setup(
      vi
        .fn()
        .mockRejectedValue(new ApiError(503, "MODEL_SERVICE_UNAVAILABLE", "本地模型服务暂不可用")),
      vi.fn().mockRejectedValue(new Error("providers unavailable")),
    );
    await store.getState().bootstrap();
    const state = store.getState();
    expect(state.modelNames).toEqual([]);
    expect(state.error).toBeNull();
    expect(state.modelStatus).toContain("MODEL_SERVICE_UNAVAILABLE");
    expect(state.modelStatus).toContain("仍可保留或手动输入模型 ID");
    expect(state.modelStatus).toContain("模型列表加载失败");
  });
  it("opens the directory while the provider read is still pending", async () => {
    const pending = deferred<ModelProviderResponse[]>();
    const { select } = setup(
      async () => catalog,
      () => pending.promise,
    );
    const boot = store.getState().bootstrap();
    await act(async () => {});
    expect(store.getState().status).toBe("ready");
    expect(store.getState().directoryIds).toEqual(["test:session"]);
    expect(select).toHaveBeenCalledWith("test:session");
    expect(store.getState().modelNames).toEqual([]);
    await act(async () => {
      pending.resolve([provider]);
    });
    await boot;
    expect(store.getState().modelNames).toEqual(["local", "external"]);
  });
});

describe("shared model discovery in refresh", () => {
  it("keeps external models selectable when the local catalog fails", async () => {
    const listModels = vi
      .fn()
      .mockRejectedValue(new ApiError(503, "MODEL_SERVICE_UNAVAILABLE", "本地模型服务暂不可用"));
    store.getState().resetForTests({ ...api, listModels });
    store.setState({ error: "chat failed" });
    await store.getState().refreshModels([provider]);
    const state = store.getState();
    expect(state.modelNames).toEqual(["external"]);
    expect(state.externalModelNames).toEqual(["external"]);
    expect(state.error).toBe("chat failed");
    expect(state.modelStatus).toContain("已登记的外部模型仍可选择");
    expect(state.modelStatus).toContain("本地模型服务连不上");
  });
  it("reports a provider failure without a global error when local models load", async () => {
    const listModels = vi.fn().mockResolvedValue(catalog);
    const listModelProviders = vi.fn().mockRejectedValue(new Error("providers unavailable"));
    store.getState().resetForTests({ ...api, listModels, listModelProviders });
    store.setState({ error: "chat failed" });
    await store.getState().refreshModels();
    const state = store.getState();
    expect(state.modelNames).toEqual(["local"]);
    expect(state.error).toBe("chat failed");
    expect(state.modelStatus).toContain("本地模型仍可选择");
    expect(state.modelStatus).toContain("外部模型列表加载失败");
    expect(state.modelStatus).not.toContain("LM Studio 当前没有报告");
  });
  it("keeps a prefetched rejection as the original failure when local models load", async () => {
    const listModels = vi.fn().mockResolvedValue(catalog);
    const listModelProviders = vi.fn().mockResolvedValue([]);
    store.getState().resetForTests({ ...api, listModels, listModelProviders });
    store.setState({ error: "chat failed" });
    await store.getState().refreshModels(Promise.reject(new Error("prefetch failed")));
    const state = store.getState();
    expect(state.modelNames).toEqual(["local"]);
    expect(state.error).toBe("chat failed");
    expect(state.modelStatus).toContain("本地模型仍可选择");
    expect(state.modelStatus).toContain("外部模型列表加载失败");
    expect(state.modelStatus).toContain("prefetch failed");
  });
  it("keeps a truthful status when neither source answers", async () => {
    const listModels = vi.fn().mockRejectedValue(new Error("catalog unavailable"));
    const listModelProviders = vi.fn().mockRejectedValue(new Error("providers unavailable"));
    store.getState().resetForTests({ ...api, listModels, listModelProviders });
    store.setState({ error: "chat failed" });
    await store.getState().refreshModels();
    const state = store.getState();
    expect(state.modelNames).toEqual([]);
    expect(state.error).toBe("chat failed");
    expect(state.modelStatus).toContain("catalog unavailable");
    expect(state.modelStatus).toContain("仍可保留或手动输入模型 ID");
  });
  it("does not clear an unrelated error when both model sources succeed", async () => {
    const listModels = vi.fn().mockResolvedValue(catalog);
    const listModelProviders = vi.fn().mockResolvedValue([provider]);
    store.getState().resetForTests({ ...api, listModels, listModelProviders });
    store.setState({ error: "chat failed" });
    await store.getState().refreshModels();
    const state = store.getState();
    expect(state.modelNames).toEqual(["local", "external"]);
    expect(state.error).toBe("chat failed");
  });
  it("replaces a stale model status without touching chat errors", async () => {
    const listModels = vi.fn().mockResolvedValue(catalog);
    const listModelProviders = vi.fn().mockResolvedValue([provider]);
    store.getState().resetForTests({ ...api, listModels, listModelProviders });
    store.setState({
      error: "chat failed",
      modelStatus: "模型列表加载失败：旧故障",
      unselectedChat: { ...store.getState().unselectedChat, error: "chat failed" },
    });
    await store.getState().refreshModels();
    const state = store.getState();
    expect(state.modelNames).toEqual(["local", "external"]);
    expect(state.modelStatus).toContain("LM Studio 当前报告");
    expect(state.error).toBe("chat failed");
    expect(state.unselectedChat.error).toBe("chat failed");
  });
  it("ignores an older discovery that settles after a newer refresh", async () => {
    const stale = deferred<Catalog>();
    const listModels = vi
      .fn()
      .mockImplementationOnce(() => stale.promise)
      .mockResolvedValue(catalog);
    store.getState().resetForTests({
      ...api,
      listModels,
      listModelProviders: vi.fn().mockResolvedValue([]),
    });
    const oldRefresh = store.getState().refreshModels();
    await store.getState().refreshModels();
    expect(store.getState().modelNames).toEqual(["local"]);
    stale.resolve({ ...catalog, models: ["stale"] });
    await expect(oldRefresh).resolves.toBeUndefined();
    expect(store.getState().modelNames).toEqual(["local"]);
  });
});
