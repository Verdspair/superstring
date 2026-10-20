import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelProviderResponse } from "../../src/shared/contracts/models";
import { api, type SuperstringApi } from "../../src/web/api";
import { useSuperstringStore as store } from "../../src/web/store";

type Catalog = Awaited<ReturnType<SuperstringApi["listModels"]>>;

const PROVIDER_A = "11111111-1111-4111-8111-111111111111";
const PROVIDER_B = "22222222-2222-4222-8222-222222222222";

function catalog(models: string[]): Catalog {
  return {
    provider: "lm_studio",
    status: "available",
    models,
    default_model: models[0] ?? "",
  };
}

function provider(id: string, name: string, models: string[]): ModelProviderResponse {
  return {
    id,
    name,
    base_url: "https://fixture.invalid/v1",
    has_api_key: false,
    models: models.map((model) => ({ name: model, context_window: 8192 })),
    revision: 1,
    created_at: "2026-10-18T00:00:00.000Z",
    updated_at: "2026-10-18T00:00:00.000Z",
  };
}

function client(overrides: Partial<SuperstringApi>): SuperstringApi {
  return { ...api, ...overrides };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  vi.restoreAllMocks();
  store.getState().resetForTests();
});

describe("model services refresh regression", () => {
  it("reuses prefetched provider rows and merges their models with the local catalog", async () => {
    const listModels = vi.fn().mockResolvedValue(catalog(["qwen/a", "qwen/a", "qwen/b"]));
    const listModelProviders = vi.fn().mockResolvedValue([]);
    store.getState().resetForTests(client({ listModels, listModelProviders }));

    await store
      .getState()
      .refreshModels([provider(PROVIDER_A, "External", ["qwen/b", "remote/c"])]);

    expect(listModels).toHaveBeenCalledTimes(1);
    expect(listModelProviders).not.toHaveBeenCalled();
    expect(store.getState().modelNames).toEqual(["qwen/a", "qwen/b", "remote/c"]);
    expect(store.getState().loadedModelNames).toEqual(["qwen/a", "qwen/b"]);
    expect(store.getState().externalModelNames).toEqual(["qwen/b", "remote/c"]);
  });

  it("reads the local catalog and provider rows once each when no rows are prefetched", async () => {
    const listModels = vi.fn().mockResolvedValue(catalog(["local"]));
    const listModelProviders = vi
      .fn()
      .mockResolvedValue([provider(PROVIDER_B, "External", ["remote"])]);
    store.getState().resetForTests(client({ listModels, listModelProviders }));

    await store.getState().refreshModels();

    expect(listModels).toHaveBeenCalledTimes(1);
    expect(listModelProviders).toHaveBeenCalledTimes(1);
    expect(store.getState().modelNames).toEqual(["local", "remote"]);
    expect(store.getState().loadedModelNames).toEqual(["local"]);
    expect(store.getState().externalModelNames).toEqual(["remote"]);
  });

  it("keeps local models usable when the provider read fails", async () => {
    const listModels = vi.fn().mockResolvedValue(catalog(["local"]));
    const listModelProviders = vi.fn().mockRejectedValue(new Error("providers unavailable"));
    store.getState().resetForTests(client({ listModels, listModelProviders }));

    await expect(store.getState().refreshModels()).resolves.toBeUndefined();

    expect(listModelProviders).toHaveBeenCalledTimes(1);
    expect(store.getState().modelNames).toEqual(["local"]);
    expect(store.getState().loadedModelNames).toEqual(["local"]);
    expect(store.getState().externalModelNames).toEqual([]);
    expect(store.getState().error).toBeNull();
  });

  it("ignores an old client's successful catalog after the client switches", async () => {
    const staleCatalog = deferred<Catalog>();
    const oldClient = client({
      listModels: vi.fn(() => staleCatalog.promise),
      listModelProviders: vi.fn().mockResolvedValue([]),
    });
    store.getState().resetForTests(oldClient);
    const oldRefresh = store.getState().refreshModels([]);

    store.getState().resetForTests(
      client({
        listModels: vi.fn().mockResolvedValue(catalog(["new"])),
        listModelProviders: vi
          .fn()
          .mockResolvedValue([provider(PROVIDER_A, "New external", ["new-remote"])]),
      }),
    );
    await store.getState().refreshModels();
    expect(store.getState().modelNames).toEqual(["new", "new-remote"]);

    staleCatalog.resolve(catalog(["stale"]));
    await expect(oldRefresh).resolves.toBeUndefined();

    expect(store.getState().modelNames).toEqual(["new", "new-remote"]);
    expect(store.getState().loadedModelNames).toEqual(["new"]);
    expect(store.getState().externalModelNames).toEqual(["new-remote"]);
  });

  it("ignores an old client's failure after the client switches", async () => {
    const staleCatalog = deferred<Catalog>();
    const oldClient = client({
      listModels: vi.fn(() => staleCatalog.promise),
      listModelProviders: vi.fn().mockResolvedValue([]),
    });
    store.getState().resetForTests(oldClient);
    const oldRefresh = store.getState().refreshModels([]);

    store.getState().resetForTests(
      client({
        listModels: vi.fn().mockResolvedValue(catalog(["new"])),
        listModelProviders: vi.fn().mockResolvedValue([]),
      }),
    );
    await store.getState().refreshModels();
    expect(store.getState().modelNames).toEqual(["new"]);

    staleCatalog.reject(new Error("stale catalog failure"));
    await expect(oldRefresh).resolves.toBeUndefined();

    expect(store.getState().modelNames).toEqual(["new"]);
    expect(store.getState().error).toBeNull();
    expect(store.getState().modelStatus).not.toContain("stale catalog failure");
  });
});
