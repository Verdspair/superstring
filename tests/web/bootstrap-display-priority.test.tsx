import { act } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { SuperstringApi } from "../../src/web/api";
import { api } from "../../src/web/api";
import { useSuperstringStore as store } from "../../src/web/store";
import { summaryFixture } from "./helpers/chat-fixture";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
afterEach(() => {
  vi.restoreAllMocks();
  store.getState().resetForTests();
});
it("shows the first directory without waiting for agents or browser configuration", async () => {
  const agents = deferred<Awaited<ReturnType<SuperstringApi["listAgents"]>>>();
  const config = deferred<Awaited<ReturnType<SuperstringApi["getBrowserStateConfig"]>>>();
  const summary = summaryFixture("first");
  store.getState().resetForTests({
    ...api,
    listAgents: () => agents.promise,
    getBrowserStateConfig: () => config.promise,
    listConversations: vi.fn().mockResolvedValue({ items: [summary], nextCursor: null }),
    listModels: vi.fn().mockResolvedValue({
      provider: "lm_studio",
      status: "available",
      models: [],
      default_model: null,
    }),
    listModelProviders: vi.fn().mockResolvedValue([]),
  });
  const select = vi.fn().mockResolvedValue(undefined);
  store.setState({ selectConversation: select });
  const boot = store.getState().bootstrap();
  try {
    await act(async () => {});
    expect(store.getState().status).toBe("ready");
    expect(store.getState().directoryIds).toEqual([summary.id]);
    expect(store.getState().pendingOperations).toBe(0);
    expect(select).not.toHaveBeenCalled();
  } finally {
    await act(async () => {
      agents.resolve([]);
      config.resolve({
        secret: "test-secret",
        storage_keys: { session: "superstring-session", agent: "superstring-agent" },
      });
      await boot;
    });
  }
});
it("does not let late startup restoration replace a user selection", async () => {
  const config = deferred<Awaited<ReturnType<SuperstringApi["getBrowserStateConfig"]>>>();
  const first = summaryFixture("first"),
    chosen = summaryFixture("chosen");
  store.getState().resetForTests({
    ...api,
    listAgents: vi.fn().mockResolvedValue([]),
    getBrowserStateConfig: () => config.promise,
    listConversations: vi.fn().mockResolvedValue({ items: [first, chosen], nextCursor: null }),
    listModels: vi.fn().mockResolvedValue({
      provider: "lm_studio",
      status: "available",
      models: [],
      default_model: null,
    }),
    listModelProviders: vi.fn().mockResolvedValue([]),
  });
  const select = vi.fn().mockResolvedValue(undefined);
  store.setState({ selectConversation: select });
  const boot = store.getState().bootstrap();
  await act(async () => {});
  store.setState({
    currentConversationId: chosen.id,
    selectionRevision: store.getState().selectionRevision + 1,
  });
  await act(async () => {
    config.resolve({
      secret: "test-secret",
      storage_keys: { session: "superstring-session", agent: "superstring-agent" },
    });
    await boot;
  });
  expect(store.getState().currentConversationId).toBe(chosen.id);
  expect(select).not.toHaveBeenCalled();
});
