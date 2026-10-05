import { act, cleanup, render, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserStateConfig } from "../../src/shared/contracts";
import type {
  ConversationEventView,
  ConversationSummary,
} from "../../src/shared/contracts/conversation";
import type { RuntimeTrace } from "../../src/shared/contracts/runtime-observability";
import { api, type SuperstringApi } from "../../src/web/api";
import { createBrowserStateStorage } from "../../src/web/browser-state";
import { useConversationEvents } from "../../src/web/features/conversations/use-conversation-events";
import { useRuntimeTraces } from "../../src/web/features/observability/use-runtime-traces";
import {
  CACHE_KEYS,
  loadDirectoryCache,
  loadQqEventsCache,
  loadTracesCache,
  saveDirectoryCache,
  saveQqEventsCache,
  saveTracesCache,
  saveWebChatCache,
} from "../../src/web/services/page-snapshot-cache";
import type { ChatItem } from "../../src/web/state/types";
import { useSuperstringStore as store } from "../../src/web/store";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  try {
    sessionStorage.clear();
    localStorage.clear();
  } catch {}
});

const mockConfig: BrowserStateConfig = {
  secret: "test-secret-key-32-chars-long-!",
  storage_keys: {
    session: "superstring-session",
    agent: "superstring-agent",
  },
};

const convSummary = (
  id: string,
  agentId = "agent-1",
  channel: ConversationSummary["channel"] = "web",
  bindingEpoch = 1,
): ConversationSummary => ({
  id,
  sourceId: id.replace("conv-", "session-"),
  channel,
  topology: channel === "onebot11" ? "shared" : "direct",
  agentId,
  title: `Title ${id}`,
  bindingEpoch,
  participants: [],
  updatedAt: "2026-09-30T12:00:00.000Z",
  lastSeq: 1,
  consumedSeq: 1,
});

const sampleQqEvent = (
  seq: number,
  text = `qq-msg-${seq}`,
  contentState: ConversationEventView["contentState"] = "active",
): ConversationEventView => ({
  seq,
  eventKey: `event-${seq}`,
  conversationId: "conv-qq-1",
  kind: "inbound",
  source: { kind: "qq_event", id: `event-${seq}`, revision: "1" },
  sources: [{ kind: "qq_event", id: `event-${seq}`, revision: "1" }],
  outputId: null,
  runId: null,
  wake: null,
  text,
  contentState,
  media: [],
  qqMessageFacts: [],
  addressing: { reasons: ["private"], mentionIds: [] },
  deliveryStatus: null,
  messageStatus: null,
  participant: { id: "person", label: "User", role: "member" },
  occurredAt: "2026-09-30T12:00:00.000Z",
  recordedAt: "2026-09-30T12:00:00.000Z",
});

const sampleChat = (id: string, content: string): ChatItem => ({
  id,
  role: "assistant",
  content,
  status: "completed",
  errorCode: null,
  createdAt: "2026-09-30T12:00:00.000Z",
  completedAt: "2026-09-30T12:00:01.000Z",
});

describe("cache-refresh-hydration integration tests", () => {
  it("1. hydrates cached directory and web chat early while network is deferred", async () => {
    const storage = createBrowserStateStorage(mockConfig, sessionStorage);
    await saveDirectoryCache(storage, [convSummary("conv-1")], 1);
    await saveWebChatCache(storage, "session-1", "agent-1", 1, [
      sampleChat("msg-1", "Cached web chat text"),
    ]);

    let resolveConvs!: (val: unknown) => void;
    const listConvs = vi.fn().mockImplementation(
      () =>
        new Promise((r) => {
          resolveConvs = r;
        }),
    );

    store.getState().resetForTests({
      ...api,
      getBrowserStateConfig: async () => mockConfig,
      listConversations: listConvs,
    } as unknown as SuperstringApi);

    const bootPromise = store.getState().bootstrap();

    // Wait for early cache hydration before network resolves
    await vi.waitFor(() => {
      expect(store.getState().directoryIds).toContain("conv-1");
    });

    // Settle network
    await act(async () => {
      resolveConvs({ items: [convSummary("conv-1"), convSummary("conv-2")], nextCursor: null });
      await bootPromise;
    });

    // Network data authority replaces
    expect(store.getState().directoryIds).toEqual(["conv-1", "conv-2"]);
  });

  it("2. hydrates cached QQ events early while network is deferred, then replaces with authoritative latest response", async () => {
    const storage = createBrowserStateStorage(mockConfig, sessionStorage);
    await saveQqEventsCache(storage, "conv-qq-1", "agent-1", 1, [
      sampleQqEvent(1, "Old cached QQ body text"),
    ]);

    let resolveEvents!: (val: unknown) => void;
    const eventsMock = vi.fn().mockImplementation(
      () =>
        new Promise((r) => {
          resolveEvents = r;
        }),
    );

    store.getState().resetForTests({
      ...api,
      getBrowserStateConfig: async () => mockConfig,
      getConversationEvents: eventsMock,
    } as unknown as SuperstringApi);

    store.setState({
      sessionStateStorage: storage,
      currentConversationId: "conv-qq-1",
      summaryById: { "conv-qq-1": convSummary("conv-qq-1", "agent-1", "onebot11") },
      directoryIds: ["conv-qq-1"],
    });

    const { result } = renderHook(() => useConversationEvents("conv-qq-1"));

    // Early cache hydration before network returns
    await vi.waitFor(() => {
      expect(result.current.items).toHaveLength(1);
    });
    expect(result.current.items[0]?.text).toBe("Old cached QQ body text");

    // Now authoritative server response returns fresh projection
    await act(async () => {
      resolveEvents({
        items: [
          sampleQqEvent(1, "Authoritative fresh text from server"),
          sampleQqEvent(2, "Second event"),
        ],
        nextSeq: 2,
        hasMore: false,
      });
    });

    // Authoritative server projections replace the cache preview cleanly
    await vi.waitFor(() => {
      expect(result.current.items).toHaveLength(2);
    });
    expect(result.current.items[0]?.text).toBe("Authoritative fresh text from server");
  });

  it("3. authoritative revocation (403 or error) redacts messages on screen and purges cache", async () => {
    const storage = createBrowserStateStorage(mockConfig, sessionStorage);
    await saveQqEventsCache(storage, "conv-qq-1", "agent-1", 1, [
      sampleQqEvent(1, "Pre-revocation text"),
    ]);

    let rejectEvents!: (err: unknown) => void;
    const eventsMock = vi.fn().mockImplementation(
      () =>
        new Promise((_, rej) => {
          rejectEvents = rej;
        }),
    );

    store.getState().resetForTests({
      ...api,
      getBrowserStateConfig: async () => mockConfig,
      getConversationEvents: eventsMock,
    } as unknown as SuperstringApi);

    store.setState({
      sessionStateStorage: storage,
      currentConversationId: "conv-qq-1",
      summaryById: { "conv-qq-1": convSummary("conv-qq-1", "agent-1", "onebot11") },
      directoryIds: ["conv-qq-1"],
    });

    const { result } = renderHook(() => useConversationEvents("conv-qq-1"));

    // First wait for cached preview to be visible on screen
    await vi.waitFor(() => {
      expect(result.current.items[0]?.text).toBe("Pre-revocation text");
    });

    // Authoritative error arriving afterwards redacts screen and purges cache
    await act(async () => {
      rejectEvents(new Error("403 Forbidden: Access revoked"));
    });

    await vi.waitFor(() => {
      expect(result.current.items[0]?.text).toBeNull();
    });
    expect(result.current.items[0]?.contentState).toBe("unavailable");

    // Storage cache is purged
    const cached = await loadQqEventsCache(storage, "conv-qq-1", "agent-1", 1);
    expect(cached).toBeNull();
  });

  it("3b. network error arriving before slow cache decryption rejects late cache", async () => {
    const storage = createBrowserStateStorage(mockConfig, sessionStorage);
    await saveQqEventsCache(storage, "conv-qq-late", "agent-1", 1, [
      sampleQqEvent(1, "Late secret text"),
    ]);

    let unblockCacheRead!: () => void;
    const origRead = storage.read.bind(storage);
    storage.read = async (key) => {
      await new Promise<void>((resolve) => {
        unblockCacheRead = resolve;
      });
      return origRead(key);
    };

    store.getState().resetForTests({
      ...api,
      getBrowserStateConfig: async () => mockConfig,
      getConversationEvents: vi.fn().mockRejectedValue(new Error("403 Forbidden: Access revoked")),
    } as unknown as SuperstringApi);

    store.setState({
      sessionStateStorage: storage,
      currentConversationId: "conv-qq-late",
      summaryById: { "conv-qq-late": convSummary("conv-qq-late", "agent-1", "onebot11") },
      directoryIds: ["conv-qq-late"],
    });

    const { result } = renderHook(() => useConversationEvents("conv-qq-late"));

    // Network error lands first
    await vi.waitFor(() => {
      expect(result.current.error).toContain("403 Forbidden");
    });

    // Unblock the slow cache read
    unblockCacheRead();

    // Late cache must be rejected! Screen must not resurrect the secret text
    await new Promise((r) => setTimeout(r, 20));
    expect(result.current.items).toHaveLength(0);
  });

  it("4. fresh network response arriving before slow cache decryption rejects late cache", async () => {
    const storage = createBrowserStateStorage(mockConfig, sessionStorage);
    await saveWebChatCache(storage, "session-fast", "agent-1", 1, [
      sampleChat("msg-old", "Old stale cached message"),
    ]);

    let unblockCacheRead!: () => void;
    const origRead = storage.read.bind(storage);
    storage.read = async (key) => {
      await new Promise<void>((resolve) => {
        unblockCacheRead = resolve;
      });
      return origRead(key);
    };

    store.getState().resetForTests({
      ...api,
      getBrowserStateConfig: async () => mockConfig,
      listMessages: vi.fn().mockResolvedValue([
        {
          id: "msg-fresh",
          role: "assistant",
          content: "Fresh network message",
          status: "completed",
          error_code: null,
          created_at: "2026-09-30T12:00:00.000Z",
          completed_at: "2026-09-30T12:00:01.000Z",
        },
      ]),
      getSessionRuntime: vi
        .fn()
        .mockResolvedValue({ status: "idle", agent_id: "agent-1", mode: "standard" }),
      listConversations: vi.fn().mockResolvedValue({
        items: [convSummary("conv-session-fast", "agent-1", "web")],
        nextCursor: null,
      }),
    } as unknown as SuperstringApi);

    store.setState({
      sessionStateStorage: storage,
      summaryById: { "conv-session-fast": convSummary("conv-session-fast", "agent-1", "web") },
      sessionConversationIds: { "session-fast": "conv-session-fast" },
      directoryIds: ["conv-session-fast"],
    });

    // Fresh network response arrives first
    await store.getState().selectSession("session-fast");
    expect(store.getState().conversationById["conv-session-fast"]?.messages[0]?.content).toBe(
      "Fresh network message",
    );

    // Unblock the slow cache read
    unblockCacheRead();

    // Late cache must be rejected! Fresh network response stays intact
    await new Promise((r) => setTimeout(r, 20));
    expect(store.getState().conversationById["conv-session-fast"]?.messages[0]?.content).toBe(
      "Fresh network message",
    );
  });

  it("5. scope mismatch (agentId or bindingEpoch) rejects cross-scope cache", async () => {
    const storage = createBrowserStateStorage(mockConfig, sessionStorage);
    await saveQqEventsCache(storage, "conv-qq-1", "agent-1", 1, [
      sampleQqEvent(1, "Agent 1 Secret QQ Message"),
    ]);

    // Same conversation ID but bound to agent-2 now
    const cachedForAgent2 = await loadQqEventsCache(storage, "conv-qq-1", "agent-2", 1);
    expect(cachedForAgent2).toBeNull();

    // Same conversation ID and agent but new bindingEpoch (epoch 2)
    const cachedForEpoch2 = await loadQqEventsCache(storage, "conv-qq-1", "agent-1", 2);
    expect(cachedForEpoch2).toBeNull();

    // Missing scope (agentId or epoch null) must reject hydration
    const missingAgent = await loadQqEventsCache(storage, "conv-qq-1", null, 1);
    expect(missingAgent).toBeNull();
    const missingEpoch = await loadQqEventsCache(storage, "conv-qq-1", "agent-1", null);
    expect(missingEpoch).toBeNull();
  });

  it("5b. runtime scope switch on same conversation ID clears previous items and rejects old scope cache", async () => {
    const storage = createBrowserStateStorage(mockConfig, sessionStorage);
    await saveQqEventsCache(storage, "conv-qq-switch", "agent-1", 1, [
      sampleQqEvent(1, "Agent 1 Scope Body"),
    ]);

    let resolveEvents1!: (val: unknown) => void;
    let resolveEvents2!: (val: unknown) => void;
    let callCount = 0;
    const getEventsMock = vi.fn().mockImplementation((_id: string) => {
      callCount++;
      if (callCount === 1) {
        return new Promise((r) => {
          resolveEvents1 = r;
        });
      }
      return new Promise((r) => {
        resolveEvents2 = r;
      });
    });

    store.getState().resetForTests({
      ...api,
      getBrowserStateConfig: async () => mockConfig,
      getConversationEvents: getEventsMock,
    } as unknown as SuperstringApi);

    store.setState({
      sessionStateStorage: storage,
      currentConversationId: "conv-qq-switch",
      summaryById: { "conv-qq-switch": convSummary("conv-qq-switch", "agent-1", "onebot11", 1) },
      directoryIds: ["conv-qq-switch"],
    });

    const { result, rerender } = renderHook(() => useConversationEvents("conv-qq-switch"));

    // Preview for scope 1 is visible while network is deferred
    await vi.waitFor(() => {
      expect(result.current.items[0]?.text).toBe("Agent 1 Scope Body");
    });

    // Authoritative response for scope 1 arrives
    await act(async () => {
      resolveEvents1({
        items: [sampleQqEvent(1, "Scope 1 authoritative text")],
        nextSeq: 1,
        hasMore: false,
      });
    });

    await vi.waitFor(() => {
      expect(result.current.items[0]?.text).toBe("Scope 1 authoritative text");
    });

    // Summary dynamically updates to bindingEpoch 2 for the same conversation ID
    await act(async () => {
      store.setState({
        summaryById: { "conv-qq-switch": convSummary("conv-qq-switch", "agent-1", "onebot11", 2) },
      });
    });

    rerender();

    // Previous scope items are cleared immediately upon scope switch!
    expect(result.current.items).toHaveLength(0);

    // Old scope cache must NOT hydrate into epoch 2; authoritative fetch for epoch 2 must resolve
    await act(async () => {
      resolveEvents2({
        items: [sampleQqEvent(10, "Fresh epoch 2 body")],
        nextSeq: 10,
        hasMore: false,
      });
    });

    await vi.waitFor(() => {
      expect(result.current.items[0]?.text).toBe("Fresh epoch 2 body");
    });
  });

  it("6. malformed cache or quota overflow is non-fatal and falls back to clean network state", async () => {
    sessionStorage.setItem(CACHE_KEYS.DIRECTORY, "corrupted-payload");

    store.getState().resetForTests({
      ...api,
      getBrowserStateConfig: async () => mockConfig,
      listConversations: vi
        .fn()
        .mockResolvedValue({ items: [convSummary("conv-clean")], nextCursor: null }),
    } as unknown as SuperstringApi);

    await expect(store.getState().bootstrap()).resolves.not.toThrow();
    expect(store.getState().directoryIds).toContain("conv-clean");
  });

  it("7. hydrates cached runtime traces summary and list early while network is deferred", async () => {
    const storage = createBrowserStateStorage(mockConfig, sessionStorage);
    const traceFilter = { channel: "web" as const };
    const filterK = JSON.stringify({ channel: "web" });
    const cachedSummary = {
      totalTraces: 10,
      activeTraces: 2,
      failedTraces: 1,
      matchedSpans: 5,
      lastActivityAt: "2026-09-30T12:00:00.000Z",
      now: "2026-09-30T12:00:00.000Z",
    };
    const cachedTrace: RuntimeTrace = {
      traceId: "tr-cached-1",
      cursorId: 100,
      causes: [],
      specIds: [],
      root: {
        id: 1,
        traceId: "tr-cached-1",
        spanId: "sp-1",
        parentSpanId: null,
        name: "test-span",
        at: "2026-09-30T12:00:00.000Z",
        finishedAt: "2026-09-30T12:00:01.000Z",
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
      at: "2026-09-30T12:00:00.000Z",
      lastActivityAt: "2026-09-30T12:00:00.000Z",
      finishedAt: "2026-09-30T12:00:01.000Z",
      durationMs: 1000,
      status: "completed",
      spanCount: 1,
      matchedSpanCount: 1,
      models: [],
      channels: ["web"],
      runIds: [],
      wakeIds: [],
    };

    await saveTracesCache(storage, filterK, cachedSummary, [cachedTrace]);

    let resolveTraces!: (val: unknown) => void;
    const listTracesMock = vi.fn().mockImplementation(
      () =>
        new Promise((r) => {
          resolveTraces = r;
        }),
    );

    store.getState().resetForTests({
      ...api,
      getBrowserStateConfig: async () => mockConfig,
      listRuntimeTraces: listTracesMock,
    } as unknown as SuperstringApi);

    store.setState({ sessionStateStorage: storage });

    const { result } = renderHook(() => useRuntimeTraces(traceFilter));

    // Wait for early traces cache hydration before network returns
    await vi.waitFor(() => {
      expect(result.current.items).toHaveLength(1);
    });
    expect(result.current.items[0]?.traceId).toBe("tr-cached-1");
    expect(result.current.summary?.totalTraces).toBe(10);

    // Settle network with authoritative fresh page
    await act(async () => {
      resolveTraces({
        items: [{ ...cachedTrace, traceId: "tr-fresh-2", cursorId: 200 }],
        summary: { ...cachedSummary, totalTraces: 15 },
        nextBeforeId: 200,
        hasMore: false,
      });
    });

    // Authoritative fresh traces replace cache cleanly
    await vi.waitFor(() => {
      expect(result.current.items[0]?.traceId).toBe("tr-fresh-2");
    });
    expect(result.current.summary?.totalTraces).toBe(15);
  });
  it("8. full F5 bootstrap: while directory, agents, models, providers deferred, early hydrates saved selected QQ conversation, sets currentConversationId and pre-displays 5 cached QQ message bodies; authoritative latest events replace without drafts/in-flight actions", async () => {
    const sessionStorageInstance = createBrowserStateStorage(mockConfig, sessionStorage);
    const localStorageInstance = createBrowserStateStorage(mockConfig, localStorage);

    // Persist saved selection into localStorage
    await localStorageInstance.write("superstring-conversation", "conv-qq-f5");
    await localStorageInstance.write("superstring-session", null);

    // Persist cached directory and 5 cached QQ events into sessionStorage
    await saveDirectoryCache(
      sessionStorageInstance,
      [convSummary("conv-qq-f5", "agent-1", "onebot11")],
      1,
    );
    const fiveCachedEvents = Array.from({ length: 5 }, (_, i) =>
      sampleQqEvent(i + 1, `Cached QQ Event ${i + 1}`),
    );
    await saveQqEventsCache(sessionStorageInstance, "conv-qq-f5", "agent-1", 1, fiveCachedEvents);

    let resolveConvs!: (val: unknown) => void;
    let resolveAgents!: (val: unknown) => void;
    let resolveModels!: (val: unknown) => void;
    let resolveProviders!: (val: unknown) => void;
    let resolveEvents!: (val: unknown) => void;

    store.getState().resetForTests({
      ...api,
      getBrowserStateConfig: async () => mockConfig,
      listConversations: vi.fn().mockImplementation(
        () =>
          new Promise((r) => {
            resolveConvs = r;
          }),
      ),
      listAgents: vi.fn().mockImplementation(
        () =>
          new Promise((r) => {
            resolveAgents = r;
          }),
      ),
      listModels: vi.fn().mockImplementation(
        () =>
          new Promise((r) => {
            resolveModels = r;
          }),
      ),
      listModelProviders: vi.fn().mockImplementation(
        () =>
          new Promise((r) => {
            resolveProviders = r;
          }),
      ),
      getConversationEvents: vi.fn().mockImplementation(
        () =>
          new Promise((r) => {
            resolveEvents = r;
          }),
      ),
    } as unknown as SuperstringApi);

    // Trigger bootstrap
    const bootPromise = store.getState().bootstrap();

    // Early hydration must set currentConversationId and directoryIds BEFORE network resolves!
    await vi.waitFor(() => {
      expect(store.getState().currentConversationId).toBe("conv-qq-f5");
      expect(store.getState().directoryIds).toContain("conv-qq-f5");
    });

    // Mount useConversationEvents for the early-selected QQ conversation
    const { result } = renderHook(() => useConversationEvents("conv-qq-f5"));

    // 5 cached message bodies are visible on screen while network is STILL pending!
    await vi.waitFor(() => {
      expect(result.current.items).toHaveLength(5);
    });
    expect(result.current.items[0]?.text).toBe("Cached QQ Event 1");
    expect(result.current.items[4]?.text).toBe("Cached QQ Event 5");

    // Settle network: authoritative events arrive from server
    await act(async () => {
      resolveEvents({
        items: [
          sampleQqEvent(1, "Fresh Server QQ Event 1"),
          sampleQqEvent(2, "Fresh Server QQ Event 2"),
        ],
        nextSeq: 2,
        hasMore: false,
      });
      resolveConvs({
        items: [convSummary("conv-qq-f5", "agent-1", "onebot11")],
        nextCursor: null,
      });
      resolveAgents([]);
      resolveModels({ models: [] });
      resolveProviders([]);
      await bootPromise;
    });

    // Authoritative fresh server events cleanly replace preview
    await vi.waitFor(() => {
      expect(result.current.items).toHaveLength(2);
    });
    expect(result.current.items[0]?.text).toBe("Fresh Server QQ Event 1");
    expect(result.current.items[1]?.text).toBe("Fresh Server QQ Event 2");
  });

  it("9. directory authority settles independently: fresh empty directory returns while models/providers slow, late cache decryption does not resurrect deleted directory", async () => {
    const sessionStorageInstance = createBrowserStateStorage(mockConfig, sessionStorage);
    await saveDirectoryCache(sessionStorageInstance, [convSummary("conv-deleted-remote")], 1);

    // listConversations resolves immediately with empty directory, but listModelProviders is slow/deferred
    let resolveProviders!: (val: unknown) => void;
    store.getState().resetForTests({
      ...api,
      getBrowserStateConfig: async () => mockConfig,
      listConversations: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
      listAgents: vi.fn().mockResolvedValue([]),
      listModels: vi.fn().mockResolvedValue({ models: [] }),
      listModelProviders: vi.fn().mockImplementation(
        () =>
          new Promise((r) => {
            resolveProviders = r;
          }),
      ),
    } as unknown as SuperstringApi);

    const bootPromise = store.getState().bootstrap();

    // Give asynchronous tasks time to run while listModelProviders is STILL pending
    await new Promise((r) => setTimeout(r, 50));

    // Directory must remain empty! Late cache must NOT resurrect the deleted conversation
    expect(store.getState().directoryIds).toHaveLength(0);

    // Finally settle slow providers
    await act(async () => {
      resolveProviders([]);
      await bootPromise;
    });
    expect(store.getState().directoryIds).toHaveLength(0);
  });
  it("10. root App F5 bootstrap: renders WorkspaceShell & cached 5 QQ bodies while status remains loading during slow network, replaces cleanly on settle", async () => {
    const sessionStorageInstance = createBrowserStateStorage(mockConfig, sessionStorage);
    const localStorageInstance = createBrowserStateStorage(mockConfig, localStorage);

    // Persist saved selection into localStorage
    await localStorageInstance.write("superstring-conversation", "conv-qq-root");
    await localStorageInstance.write("superstring-session", null);

    // Persist cached directory and 5 cached QQ events into sessionStorage
    await saveDirectoryCache(
      sessionStorageInstance,
      [convSummary("conv-qq-root", "agent-1", "onebot11")],
      1,
    );
    const fiveCachedEvents = Array.from({ length: 5 }, (_, i) =>
      sampleQqEvent(i + 1, `Root App Cached Event ${i + 1}`),
    );
    await saveQqEventsCache(sessionStorageInstance, "conv-qq-root", "agent-1", 1, fiveCachedEvents);

    let resolveConvs!: (val: unknown) => void;
    let resolveAgents!: (val: unknown) => void;
    let resolveModels!: (val: unknown) => void;
    let resolveProviders!: (val: unknown) => void;
    let resolveEvents!: (val: unknown) => void;

    store.getState().resetForTests({
      ...api,
      getBrowserStateConfig: async () => mockConfig,
      listConversations: vi.fn().mockImplementation(
        () =>
          new Promise((r) => {
            resolveConvs = r;
          }),
      ),
      listAgents: vi.fn().mockImplementation(
        () =>
          new Promise((r) => {
            resolveAgents = r;
          }),
      ),
      listModels: vi.fn().mockImplementation(
        () =>
          new Promise((r) => {
            resolveModels = r;
          }),
      ),
      listModelProviders: vi.fn().mockImplementation(
        () =>
          new Promise((r) => {
            resolveProviders = r;
          }),
      ),
      getConversationEvents: vi.fn().mockImplementation(
        () =>
          new Promise((r) => {
            resolveEvents = r;
          }),
      ),
    } as unknown as SuperstringApi);

    // Dynamically import App
    const { default: App } = await import("../../src/web/App");

    const { getByText, queryByText } = render(<App />);

    // While network is STILL in flight and status is STILL loading:
    // The prehydrated preview MUST allow root App to show the 5 cached QQ messages!
    await vi.waitFor(() => {
      expect(store.getState().status).toBe("loading");
      expect(getByText("Root App Cached Event 1")).toBeDefined();
    });

    expect(getByText("Root App Cached Event 5")).toBeDefined();
    expect(queryByText("正在加载工作区…")).toBeNull();

    // Settle network
    await act(async () => {
      resolveEvents({
        items: [
          sampleQqEvent(1, "Root App Fresh Event 1"),
          sampleQqEvent(2, "Root App Fresh Event 2"),
        ],
        nextSeq: 2,
        hasMore: false,
      });
      resolveConvs({
        items: [convSummary("conv-qq-root", "agent-1", "onebot11")],
        nextCursor: null,
      });
      resolveAgents([]);
      resolveModels({ models: [] });
      resolveProviders([]);
    });

    // Authoritative replacement after settle
    await vi.waitFor(() => {
      expect(store.getState().status).toBe("ready");
      expect(getByText("Root App Fresh Event 1")).toBeDefined();
    });
    expect(queryByText("Root App Cached Event 1")).toBeNull();
  });

  it("11. bootstrap saved read race: slow savedConversation read delayed across fresh empty directory landing does NOT resurrect deleted directory or leave previewId", async () => {
    const sessionStorageInstance = createBrowserStateStorage(mockConfig, sessionStorage);
    const localStorageInstance = createBrowserStateStorage(mockConfig, localStorage);

    await localStorageInstance.write("superstring-conversation", "conv-deleted-during-read");
    await saveDirectoryCache(sessionStorageInstance, [convSummary("conv-deleted-during-read")], 1);

    let unblockSavedRead!: () => void;
    let resolveProviders!: (val: unknown) => void;

    // Delay localStorageInstance.read for superstring-conversation
    const origRead = localStorageInstance.read.bind(localStorageInstance);
    localStorageInstance.read = async (key) => {
      if (key === "superstring-conversation") {
        await new Promise<void>((r) => {
          unblockSavedRead = r;
        });
      }
      return origRead(key);
    };

    store.getState().resetForTests({
      ...api,
      getBrowserStateConfig: async () => mockConfig,
      listConversations: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
      listAgents: vi.fn().mockResolvedValue([]),
      listModels: vi.fn().mockResolvedValue({ models: [] }),
      listModelProviders: vi.fn().mockImplementation(
        () =>
          new Promise((r) => {
            resolveProviders = r;
          }),
      ),
    } as unknown as SuperstringApi);

    // Override browserStateStorage in store to use our delayed localStorageInstance
    store.setState({ browserStateStorage: localStorageInstance });

    const bootPromise = store.getState().bootstrap();

    // Give listConversations time to complete and mark directorySettled = true
    await new Promise((r) => setTimeout(r, 30));

    // Now unblock the slow savedConversation read
    if (typeof unblockSavedRead === "function") {
      unblockSavedRead();
    }

    await new Promise((r) => setTimeout(r, 30));

    // Store MUST NOT resurrect the deleted directory!
    expect(store.getState().directoryIds).toHaveLength(0);

    // Settle providers
    await act(async () => {
      resolveProviders([]);
      await bootPromise;
    });

    // Final state: directoryIds is empty and currentConversationId MUST be null!
    expect(store.getState().directoryIds).toHaveLength(0);
    expect(store.getState().currentConversationId).toBeNull();
  });
  it("12. trace preview authoritative replacement: preview A and B are replaced by fresh B and C on initial authoritative response; deleted A is not retained in state or re-saved cache", async () => {
    const storage = createBrowserStateStorage(mockConfig, sessionStorage);
    const traceFilter = { channel: "onebot11" as const };
    const filterK = JSON.stringify({ channel: "onebot11" });

    const makeTrace = (id: string, cursorId: number): RuntimeTrace => ({
      traceId: id,
      cursorId,
      causes: [],
      specIds: [],
      root: {
        id: cursorId,
        traceId: id,
        spanId: `sp-${id}`,
        parentSpanId: null,
        name: `span-${id}`,
        at: "2026-09-30T12:00:00.000Z",
        finishedAt: "2026-09-30T12:00:01.000Z",
        durationMs: 1000,
        channel: "onebot11",
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
      at: "2026-09-30T12:00:00.000Z",
      lastActivityAt: "2026-09-30T12:00:00.000Z",
      finishedAt: "2026-09-30T12:00:01.000Z",
      durationMs: 1000,
      status: "completed",
      spanCount: 1,
      matchedSpanCount: 1,
      models: [],
      channels: ["onebot11"],
      runIds: [],
      wakeIds: [],
    });

    const traceA = makeTrace("tr-A", 10);
    const traceB = makeTrace("tr-B", 20);
    const traceC = makeTrace("tr-C", 30);

    const initialSummary = {
      totalTraces: 2,
      activeTraces: 0,
      failedTraces: 0,
      matchedSpans: 2,
      lastActivityAt: "2026-09-30T12:00:00.000Z",
      now: "2026-09-30T12:00:00.000Z",
    };

    // Cache has A and B
    await saveTracesCache(storage, filterK, initialSummary, [traceA, traceB]);

    let resolveTraces!: (val: unknown) => void;
    const listTracesMock = vi.fn().mockImplementation(
      () =>
        new Promise((r) => {
          resolveTraces = r;
        }),
    );

    store.getState().resetForTests({
      ...api,
      getBrowserStateConfig: async () => mockConfig,
      listRuntimeTraces: listTracesMock,
    } as unknown as SuperstringApi);

    store.setState({ sessionStateStorage: storage });

    const { result } = renderHook(() => useRuntimeTraces(traceFilter));

    // Wait for cached preview: A and B are visible
    await vi.waitFor(() => {
      expect(result.current.items).toHaveLength(2);
    });
    expect(result.current.items.map((t) => t.traceId)).toEqual(["tr-A", "tr-B"]);

    // Fresh authoritative response arrives from server containing only B and C (A was deleted!)
    await act(async () => {
      resolveTraces({
        items: [traceB, traceC],
        summary: { ...initialSummary, totalTraces: 2 },
        nextBeforeId: 30,
        hasMore: false,
      });
    });

    // Authoritative replacement: items must contain ONLY B and C, deleted A MUST NOT be retained!
    await vi.waitFor(() => {
      expect(result.current.items.map((t) => t.traceId)).toEqual(["tr-C", "tr-B"]);
    });

    // Verify re-saved cache in storage: must also contain ONLY B and C!
    const reloadedCache = await loadTracesCache(storage, filterK);
    expect(reloadedCache?.items.map((t) => t.traceId)).toEqual(["tr-C", "tr-B"]);
  });

  it("13. trace failure clears preview and rejects late cache: authoritative error landing before slow cache decryption leaves screen empty and purges storage cache", async () => {
    const storage = createBrowserStateStorage(mockConfig, sessionStorage);
    const traceFilter = { channel: "system" as const };
    const filterK = JSON.stringify({ channel: "system" });

    const makeTrace = (id: string, cursorId: number): RuntimeTrace => ({
      traceId: id,
      cursorId,
      causes: [],
      specIds: [],
      root: {
        id: cursorId,
        traceId: id,
        spanId: `sp-${id}`,
        parentSpanId: null,
        name: `span-${id}`,
        at: "2026-09-30T12:00:00.000Z",
        finishedAt: "2026-09-30T12:00:01.000Z",
        durationMs: 1000,
        channel: "system",
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
      at: "2026-09-30T12:00:00.000Z",
      lastActivityAt: "2026-09-30T12:00:00.000Z",
      finishedAt: "2026-09-30T12:00:01.000Z",
      durationMs: 1000,
      status: "completed",
      spanCount: 1,
      matchedSpanCount: 1,
      models: [],
      channels: ["system"],
      runIds: [],
      wakeIds: [],
    });

    await saveTracesCache(
      storage,
      filterK,
      {
        totalTraces: 1,
        activeTraces: 0,
        failedTraces: 0,
        matchedSpans: 1,
        lastActivityAt: null,
        now: "2026-09-30T12:00:00.000Z",
      },
      [makeTrace("tr-secret-late", 1)],
    );

    // Delay storage.read for traces artificially
    let unblockTraceRead!: () => void;
    let delayedOnce = false;
    const origRead = storage.read.bind(storage);
    storage.read = async (key) => {
      if (key.includes("traces") && !delayedOnce) {
        delayedOnce = true;
        await new Promise<void>((r) => {
          unblockTraceRead = r;
        });
      }
      return origRead(key);
    };

    const listMock = vi.fn().mockRejectedValue(new Error("403 Forbidden: Traces access revoked"));
    store.getState().resetForTests({
      ...api,
      getBrowserStateConfig: async () => mockConfig,
      listRuntimeTraces: listMock,
    } as unknown as SuperstringApi);

    store.setState({ sessionStateStorage: storage });

    const { result } = renderHook(() => useRuntimeTraces(traceFilter));

    // Authoritative error lands first
    await vi.waitFor(() => {
      expect(result.current.error).toContain("403 Forbidden");
    });
    expect(result.current.items).toHaveLength(0);

    // Now unblock the slow cache read
    if (typeof unblockTraceRead === "function") {
      unblockTraceRead();
    }

    // Give time for any late promise to settle
    await new Promise((r) => setTimeout(r, 40));

    // Late cache must be rejected! Screen must NOT resurrect the secret trace!
    expect(result.current.items).toHaveLength(0);

    // Storage cache must be purged
    const cached = await loadTracesCache(storage, filterK);
    expect(cached).toBeNull();
  });
  it("14. bootstrap self-caches authoritative directory: initial full network bootstrap saves directory cache to sessionStorage without manual seed, enabling subsequent F5 deferred reload to prehydrate directory and QQ events", async () => {
    // Clean sessionStorage and localStorage: NO directory cache is seeded manually!
    sessionStorage.clear();
    localStorage.clear();

    const storage = createBrowserStateStorage(mockConfig, sessionStorage);
    const localStorageInstance = createBrowserStateStorage(mockConfig, localStorage);

    // Save ONLY the QQ events cache (simulating an existing active conversation session)
    const fiveCachedEvents = Array.from({ length: 5 }, (_, i) =>
      sampleQqEvent(i + 1, `Bootstrap Roundtrip Event ${i + 1}`),
    );
    await saveQqEventsCache(storage, "conv-qq-bootstrap", "agent-1", 1, fiveCachedEvents);
    await localStorageInstance.write("superstring-conversation", "conv-qq-bootstrap");

    // Phase 1: Initial full bootstrap with all network fulfilled
    store.getState().resetForTests({
      ...api,
      getBrowserStateConfig: async () => mockConfig,
      listConversations: vi.fn().mockResolvedValue({
        items: [convSummary("conv-qq-bootstrap", "agent-1", "onebot11")],
        nextCursor: null,
      }),
      listAgents: vi.fn().mockResolvedValue([]),
      listModels: vi.fn().mockResolvedValue({ models: [] }),
      listModelProviders: vi.fn().mockResolvedValue([]),
      getConversationEvents: vi.fn().mockResolvedValue({
        items: fiveCachedEvents,
        nextSeq: 5,
        hasMore: false,
      }),
    } as unknown as SuperstringApi);

    await store.getState().bootstrap();

    // Verify: bootstrap() ITSELF must have persisted the directory cache into sessionStorage!
    // Without this, loadDirectoryCache would return null and the cached preview could never render.
    await vi.waitFor(async () => {
      const persistedDir = await loadDirectoryCache(storage);
      expect(persistedDir).not.toBeNull();
      expect(persistedDir?.items).toHaveLength(1);
      expect(persistedDir?.items[0]?.id).toBe("conv-qq-bootstrap");
    });

    // Phase 2: Simulate subsequent F5 refresh where network is deferred
    let resolveConvs!: (val: unknown) => void;
    let resolveEvents!: (val: unknown) => void;

    store.getState().resetForTests({
      ...api,
      getBrowserStateConfig: async () => mockConfig,
      listConversations: vi.fn().mockImplementation(
        () =>
          new Promise((r) => {
            resolveConvs = r;
          }),
      ),
      listAgents: vi.fn().mockResolvedValue([]),
      listModels: vi.fn().mockResolvedValue({ models: [] }),
      listModelProviders: vi.fn().mockResolvedValue([]),
      getConversationEvents: vi.fn().mockImplementation(
        () =>
          new Promise((r) => {
            resolveEvents = r;
          }),
      ),
    } as unknown as SuperstringApi);

    const { default: App } = await import("../../src/web/App");
    const { getByText } = render(<App />);

    // Because bootstrap() persisted the directory cache in Phase 1,
    // the F5 refresh prehydrates directory AND renders the 5 cached QQ message bodies while network is pending!
    await vi.waitFor(() => {
      expect(store.getState().currentConversationId).toBe("conv-qq-bootstrap");
      expect(getByText("Bootstrap Roundtrip Event 1")).toBeDefined();
      expect(getByText("Bootstrap Roundtrip Event 5")).toBeDefined();
    });

    // Cleanly settle network
    await act(async () => {
      resolveEvents({
        items: [sampleQqEvent(1, "Fresh Settle Event 1")],
        nextSeq: 1,
        hasMore: false,
      });
      resolveConvs({
        items: [convSummary("conv-qq-bootstrap", "agent-1", "onebot11")],
        nextCursor: null,
      });
    });

    await vi.waitFor(() => {
      expect(getByText("Fresh Settle Event 1")).toBeDefined();
    });
  });
});
