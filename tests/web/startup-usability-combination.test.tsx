import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { BrowserStateConfig } from "../../src/shared/contracts";
import App from "../../src/web/App";
import { api, type SuperstringApi } from "../../src/web/api";
import { resetConversationChangesForTests } from "../../src/web/services/conversation-changes";
import { loadTracesCache } from "../../src/web/services/page-snapshot-cache";
import { useSuperstringStore as store } from "../../src/web/store";

vi.mock("../../src/web/state/preload-orchestrator", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../src/web/state/preload-orchestrator")>();
  return {
    ...original,
    startChunkPreload: (options: Parameters<typeof original.startChunkPreload>[0]) =>
      original.startChunkPreload({
        ...options,
        scheduleIdle: (callback) => {
          queueMicrotask(callback);
          return () => {};
        },
      }),
  };
});
afterEach(() => {
  cleanup();
  resetConversationChangesForTests();
  vi.restoreAllMocks();
  sessionStorage.clear();
  localStorage.clear();
});
it("shows the shell before browser storage and starts trace prewarm once storage becomes ready", async () => {
  let resolveConfig!: (value: BrowserStateConfig) => void;
  const config = new Promise<BrowserStateConfig>((resolve) => {
    resolveConfig = resolve;
  });
  const summary = {
    totalTraces: 0,
    activeTraces: 0,
    failedTraces: 0,
    matchedSpans: 0,
    lastActivityAt: null,
    now: "2026-10-08T00:00:00Z",
  };
  const traces = vi
    .fn<SuperstringApi["listRuntimeTraces"]>()
    .mockResolvedValue({ items: [], summary, hasMore: false, nextBeforeId: 0 });
  store.getState().resetForTests({
    ...api,
    listConversations: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    listAgents: vi.fn().mockResolvedValue([]),
    listModels: vi.fn().mockResolvedValue({
      provider: "lm_studio",
      status: "available",
      models: [],
      default_model: null,
    }),
    listModelProviders: vi.fn().mockResolvedValue([]),
    getBrowserStateConfig: () => config,
    listRuntimeTraces: traces,
    subscribeConversationChanges: async (_listener, signal) => {
      await new Promise<void>((resolve) => {
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
    },
  });
  store.setState({
    loadPermissionSettings: vi.fn().mockResolvedValue(undefined),
    loadKnowledge: vi.fn().mockResolvedValue(undefined),
    loadQqSchemes: vi.fn().mockResolvedValue(true),
    loadQqBindings: vi.fn().mockResolvedValue(undefined),
  });
  render(<App />);
  await waitFor(() => expect(document.getElementById("superstring-shell")).toBeTruthy());
  expect(store.getState().status).toBe("ready");
  expect(store.getState().sessionStateStorage).toBeNull();
  expect(traces).not.toHaveBeenCalled();
  await act(async () =>
    resolveConfig({
      secret: "synthetic-startup-only",
      storage_keys: { session: "superstring-session", agent: "superstring-agent" },
    }),
  );
  await waitFor(() => expect(traces).toHaveBeenCalledTimes(1));
  await waitFor(async () =>
    expect(await loadTracesCache(store.getState().sessionStateStorage, "{}")).toEqual({
      summary,
      items: [],
    }),
  );
  expect(screen.queryByText("正在加载本地工作区…")).toBeNull();
});
