import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserStateConfig } from "../../src/shared/contracts";
import type {
  RuntimeTrace,
  RuntimeTracesPage,
} from "../../src/shared/contracts/runtime-observability";
import { api, type SuperstringApi } from "../../src/web/api";
import { createBrowserStateStorage } from "../../src/web/browser-state";
import { useRuntimeTraces } from "../../src/web/features/observability/use-runtime-traces";
import { loadTracesCache, saveTracesCache } from "../../src/web/services/page-snapshot-cache";
import { PRELOAD_REGISTRY } from "../../src/web/state/preload-registry";
import { useSuperstringStore as store } from "../../src/web/store";

const mockConfig: BrowserStateConfig = {
  secret: "test-secret-key-32-chars-long-!",
  storage_keys: {
    session: "superstring-session",
    agent: "superstring-agent",
  },
};

const filterKey = (filters: Record<string, unknown>): string =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(filters)
        .filter(([, value]) => value !== undefined)
        .sort(([a], [b]) => a.localeCompare(b)),
    ),
  );

const sampleSummary = (totalTraces = 1): RuntimeTracesPage["summary"] => ({
  totalTraces,
  activeTraces: 0,
  failedTraces: 0,
  matchedSpans: totalTraces,
  lastActivityAt: "2026-10-08T00:00:00.000Z",
  now: "2026-10-08T00:00:00.000Z",
});

const sampleTrace = (id = "tr-1", cursorId = 1): RuntimeTrace => ({
  traceId: id,
  cursorId,
  causes: [],
  specIds: [],
  root: {
    id: cursorId,
    traceId: id,
    spanId: `sp-${id}`,
    parentSpanId: null,
    name: "test-span",
    at: "2026-10-08T00:00:00.000Z",
    finishedAt: "2026-10-08T00:00:01.000Z",
    durationMs: 1000,
    channel: "web",
    stage: "run",
    status: "completed",
    code: "OK",
    model: null,
    conversationId: null,
    agentId: null,
    runId: null,
    wakeId: null,
    outputId: null,
    sourceSeq: null,
    details: {},
  },
  at: "2026-10-08T00:00:00.000Z",
  lastActivityAt: "2026-10-08T00:00:00.000Z",
  finishedAt: "2026-10-08T00:00:01.000Z",
  durationMs: 1000,
  status: "completed",
  spanCount: 1,
  matchedSpanCount: 1,
  models: [],
  channels: ["web"],
  runIds: [],
  wakeIds: [],
});

beforeEach(() => {
  try {
    sessionStorage.clear();
    localStorage.clear();
  } catch {}
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("conversation-preload and consumption lifecycle", () => {
  it("1. registry conversations entry is eligible and warms global + active conversation traces into session cache", async () => {
    const storage = createBrowserStateStorage(mockConfig, sessionStorage);
    const listTraces = vi.fn().mockImplementation(async (filters) => ({
      items: [sampleTrace(filters.conversationId ? "tr-conv" : "tr-global")],
      nextBeforeId: 1,
      hasMore: false,
      summary: sampleSummary(1),
    }));

    store.getState().resetForTests({
      ...api,
      getBrowserStateConfig: async () => mockConfig,
      listRuntimeTraces: listTraces,
    } as unknown as SuperstringApi);

    store.setState({
      sessionStateStorage: storage,
      currentConversationId: "conv-100",
    });

    const entry = PRELOAD_REGISTRY.find((item) => item.space === "conversations");
    expect(entry?.dataStatus).toBe("eligible");
    expect(typeof entry?.loadData).toBe("function");

    await entry?.loadData?.();

    // Must have requested global ({}) and active conversation ({ conversationId: 'conv-100' })
    expect(listTraces).toHaveBeenCalledTimes(2);

    const globalCached = await loadTracesCache(storage, filterKey({}));
    expect(globalCached?.items[0]?.traceId).toBe("tr-global");

    const convCached = await loadTracesCache(storage, filterKey({ conversationId: "conv-100" }));
    expect(convCached?.items[0]?.traceId).toBe("tr-conv");
  });

  it("2. hydrates empty trace list with non-null summary on first mount without loader block", async () => {
    const storage = createBrowserStateStorage(mockConfig, sessionStorage);
    const emptySummary = sampleSummary(0);
    // Cached traces with 0 items but valid summary
    await saveTracesCache(storage, filterKey({}), emptySummary, []);

    let resolveTraces!: (val: RuntimeTracesPage) => void;
    const listTraces = vi.fn().mockImplementation(
      () =>
        new Promise<RuntimeTracesPage>((r) => {
          resolveTraces = r;
        }),
    );

    store.getState().resetForTests({
      ...api,
      getBrowserStateConfig: async () => mockConfig,
      listRuntimeTraces: listTraces,
    } as unknown as SuperstringApi);

    store.setState({ sessionStateStorage: storage });

    const { result } = renderHook(() => useRuntimeTraces({}));

    // Must hydrate summary immediately even though items is empty (firstpaint readiness)
    await vi.waitFor(() => {
      expect(result.current.summary).not.toBeNull();
      expect(result.current.summary?.totalTraces).toBe(0);
    });
    expect(result.current.items).toEqual([]);

    // Settle network
    await act(async () => {
      resolveTraces({
        items: [],
        nextBeforeId: 0,
        hasMore: false,
        summary: emptySummary,
      });
    });
  });

  it("3. displays prewarmed cached items immediately while background fresh read is pending", async () => {
    const storage = createBrowserStateStorage(mockConfig, sessionStorage);
    const cachedSummary = sampleSummary(1);
    const cachedItem = sampleTrace("tr-cached", 10);
    await saveTracesCache(storage, filterKey({}), cachedSummary, [cachedItem]);

    let resolveTraces!: (val: RuntimeTracesPage) => void;
    const listTraces = vi.fn().mockImplementation(
      () =>
        new Promise<RuntimeTracesPage>((r) => {
          resolveTraces = r;
        }),
    );

    store.getState().resetForTests({
      ...api,
      getBrowserStateConfig: async () => mockConfig,
      listRuntimeTraces: listTraces,
    } as unknown as SuperstringApi);

    store.setState({ sessionStateStorage: storage });

    const { result } = renderHook(() => useRuntimeTraces({}));

    // Immediately shows prewarmed item before network returns
    await vi.waitFor(() => {
      expect(result.current.items).toHaveLength(1);
      expect(result.current.items[0]?.traceId).toBe("tr-cached");
      expect(result.current.summary?.totalTraces).toBe(1);
    });

    // Settle background read with fresh data
    await act(async () => {
      resolveTraces({
        items: [sampleTrace("tr-fresh", 20)],
        nextBeforeId: 20,
        hasMore: false,
        summary: sampleSummary(2),
      });
    });

    await vi.waitFor(() => {
      expect(result.current.items).toHaveLength(1);
      expect(result.current.items[0]?.traceId).toBe("tr-fresh");
      expect(result.current.summary?.totalTraces).toBe(2);
    });
  });

  it("4. prewarm ignores late save if API client is changed before network returns", async () => {
    const storage = createBrowserStateStorage(mockConfig, sessionStorage);
    let resolveTraces!: (val: RuntimeTracesPage) => void;
    const listTraces = vi.fn().mockImplementation(
      () =>
        new Promise<RuntimeTracesPage>((r) => {
          resolveTraces = r;
        }),
    );

    const oldApi = {
      ...api,
      getBrowserStateConfig: async () => mockConfig,
      listRuntimeTraces: listTraces,
    } as unknown as SuperstringApi;

    store.getState().resetForTests(oldApi);
    store.setState({ sessionStateStorage: storage });

    const entry = PRELOAD_REGISTRY.find((item) => item.space === "conversations");
    const prewarmPromise = entry?.loadData?.();
    await vi.waitFor(() => expect(listTraces).toHaveBeenCalledOnce());

    // Now switch API client before prewarm settles
    const newApi = { ...api } as SuperstringApi;
    store.setState({ apiClient: newApi });

    // Settle old prewarm
    await act(async () => {
      resolveTraces({
        items: [sampleTrace("tr-stale", 1)],
        nextBeforeId: 1,
        hasMore: false,
        summary: sampleSummary(1),
      });
      await prewarmPromise;
    });

    // Stale result must NOT have been saved into storage cache
    const cached = await loadTracesCache(storage, filterKey({}));
    expect(cached).toBeNull();
  });
});

it("does not replace a newer foreground snapshot with a late prewarm result", async () => {
  const storage = createBrowserStateStorage(mockConfig, sessionStorage);
  let finish!: (page: RuntimeTracesPage) => void;
  const listTraces = vi.fn<SuperstringApi["listRuntimeTraces"]>(
    () =>
      new Promise<RuntimeTracesPage>((resolve) => {
        finish = resolve;
      }),
  );
  store.getState().resetForTests({ ...api, listRuntimeTraces: listTraces });
  store.setState({ sessionStateStorage: storage });
  const warming = PRELOAD_REGISTRY.find((entry) => entry.space === "conversations")?.loadData?.();
  await vi.waitFor(() => expect(listTraces).toHaveBeenCalledOnce());
  await saveTracesCache(storage, "{}", sampleSummary(2), [sampleTrace("current-foreground", 20)]);
  await act(async () => {
    finish({
      items: [sampleTrace("old-warm", 10)],
      summary: sampleSummary(1),
      hasMore: false,
      nextBeforeId: 10,
    });
    await warming;
  });
  expect((await loadTracesCache(storage, "{}"))?.items[0]?.traceId).toBe("current-foreground");
});

it("uses an existing preview instead of repeating a startup prewarm read", async () => {
  const storage = createBrowserStateStorage(mockConfig, sessionStorage);
  await saveTracesCache(storage, "{}", sampleSummary(1), [sampleTrace("already-warm", 10)]);
  const listTraces = vi.fn<SuperstringApi["listRuntimeTraces"]>();
  store.getState().resetForTests({ ...api, listRuntimeTraces: listTraces });
  store.setState({ sessionStateStorage: storage });
  await PRELOAD_REGISTRY.find((entry) => entry.space === "conversations")?.loadData?.();
  expect(listTraces).not.toHaveBeenCalled();
});
