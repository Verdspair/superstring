import { act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentResponseSchema } from "../../src/shared/contracts";
import type { ModelProviderResponse } from "../../src/shared/contracts/models";
import { api, type SuperstringApi } from "../../src/web/api";
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
function deferred() {
  let resolve!: (value: Catalog) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<Catalog>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function setup(listModels: SuperstringApi["listModels"]) {
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
    listModelProviders: vi.fn().mockResolvedValue([provider]),
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
    const pending = deferred();
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
    const pending = deferred();
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
  });
  it("does not let a delayed old API catalog replace a newer bootstrap", async () => {
    const pending = deferred();
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
});
