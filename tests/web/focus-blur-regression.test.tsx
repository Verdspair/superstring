import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ConversationEventView,
  ConversationSummary,
} from "../../src/shared/contracts/conversation";
import { api, type SuperstringApi } from "../../src/web/api";
import { useConversationEvents } from "../../src/web/features/conversations/use-conversation-events";
import { ExternalConversation } from "../../src/web/screens/conversations/ExternalConversation";
import { useForegroundRead } from "../../src/web/services/use-foreground-read";
import { useLiveResource } from "../../src/web/services/use-live-resource";
import { useSuperstringStore } from "../../src/web/store";

let originalVisibilityDesc: PropertyDescriptor | undefined;

beforeEach(() => {
  originalVisibilityDesc =
    Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState") ??
    Object.getOwnPropertyDescriptor(document, "visibilityState");
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (originalVisibilityDesc) {
    Object.defineProperty(document, "visibilityState", originalVisibilityDesc);
  }
});

const qqConversation: ConversationSummary = {
  id: "conversation:qq",
  sourceId: "binding-qq",
  channel: "onebot11",
  topology: "shared",
  agentId: "agent",
  title: "QQ 会话",
  bindingEpoch: 1,
  participants: [],
  updatedAt: "2026-09-30T00:00:00Z",
  lastSeq: 0,
  consumedSeq: 0,
};

const sampleEvent = (seq: number, text = `msg-${seq}`): ConversationEventView => ({
  seq,
  eventKey: `event-${seq}`,
  conversationId: "conversation:qq",
  kind: "inbound",
  source: { kind: "qq_event", id: `event-${seq}`, revision: "1" },
  sources: [{ kind: "qq_event", id: `event-${seq}`, revision: "1" }],
  outputId: null,
  runId: null,
  wake: null,
  text,
  contentState: "active",
  media: [],
  qqMessageFacts: [],
  addressing: { reasons: [], mentionIds: [] },
  deliveryStatus: null,
  messageStatus: null,
  participant: { id: "person", label: "User", role: "member" },
  occurredAt: "2026-09-30T00:00:00Z",
  recordedAt: "2026-09-30T00:00:00Z",
});

type ConversationEventsPage = Awaited<ReturnType<SuperstringApi["getConversationEvents"]>>;

function setupApi(overrides: Partial<SuperstringApi>) {
  useSuperstringStore.getState().resetForTests({
    ...api,
    ...overrides,
  });
}

describe("focus and blur regression tests", () => {
  it("useConversationEvents: refocus triggers exactly one background request even if both visibilitychange and focus fire", async () => {
    const events = vi.fn<SuperstringApi["getConversationEvents"]>().mockResolvedValue({
      items: [sampleEvent(1), sampleEvent(2)],
      nextSeq: 2,
      hasMore: false,
    });
    setupApi({ getConversationEvents: events });

    const { result } = renderHook(() => useConversationEvents("conv-1"));

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.items).toHaveLength(2);
    expect(events).toHaveBeenCalledTimes(1);

    // Window blurs (still visible)
    act(() => {
      fireEvent.blur(window);
    });

    // Old data is preserved during blur
    expect(result.current.items).toHaveLength(2);
    expect(result.current.loading).toBe(false);

    // Refocus: both visibilitychange (to visible) and focus fire in real browsers
    act(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      fireEvent(document, new Event("visibilitychange"));
      fireEvent.focus(window);
    });

    await act(async () => {
      await Promise.resolve();
    });

    // Should only have revalidated once, NOT twice!
    expect(events).toHaveBeenCalledTimes(2);
    expect(result.current.items).toHaveLength(2);
  });

  it("useConversationEvents: refocus always revalidates in background even if blur was brief (< refreshMs)", async () => {
    const events = vi.fn<SuperstringApi["getConversationEvents"]>().mockResolvedValue({
      items: [sampleEvent(1), sampleEvent(2)],
      nextSeq: 2,
      hasMore: false,
    });
    setupApi({ getConversationEvents: events });

    renderHook(() => useConversationEvents("conv-1", undefined, { refreshMs: 10000 }));

    await act(async () => {
      await Promise.resolve();
    });

    expect(events).toHaveBeenCalledTimes(1);

    // Brief blur (much less than 10000ms refreshMs)
    act(() => {
      fireEvent.blur(window);
    });

    // Refocus
    act(() => {
      fireEvent.focus(window);
    });

    await act(async () => {
      await Promise.resolve();
    });

    // Requirement: "回焦总是重新拉取（用户选 2）"
    expect(events).toHaveBeenCalledTimes(2);
  });

  it("useConversationEvents: rapid two distinct blur-focus cycles without dropping either update (no debounce loss)", async () => {
    const events = vi
      .fn<SuperstringApi["getConversationEvents"]>()
      .mockResolvedValueOnce({
        items: [sampleEvent(1)],
        nextSeq: 1,
        hasMore: false,
      })
      .mockResolvedValueOnce({
        items: [sampleEvent(1), sampleEvent(2)],
        nextSeq: 2,
        hasMore: false,
      })
      .mockResolvedValueOnce({
        items: [sampleEvent(1), sampleEvent(2), sampleEvent(3)],
        nextSeq: 3,
        hasMore: false,
      });
    setupApi({ getConversationEvents: events });

    const { result } = renderHook(() => useConversationEvents("conv-1"));

    await act(async () => {
      await Promise.resolve();
    });
    expect(events).toHaveBeenCalledTimes(1);
    expect(result.current.items).toHaveLength(1);

    // Cycle 1: blur then focus
    act(() => {
      fireEvent.blur(window);
    });
    act(() => {
      fireEvent.focus(window);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(events).toHaveBeenCalledTimes(2);
    expect(result.current.items).toHaveLength(2);

    // Cycle 2: immediately blur and focus again (rapid separate user window alt-tabs)
    act(() => {
      fireEvent.blur(window);
    });
    act(() => {
      fireEvent.focus(window);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(events).toHaveBeenCalledTimes(3);
    expect(result.current.items).toHaveLength(3);
  });

  it("useConversationEvents: scope change to new conversation aborts previous pending and ignores late response", async () => {
    let settleOld!: (val: ConversationEventsPage) => void;
    let settleNew!: (val: ConversationEventsPage) => void;

    const events = vi
      .fn<SuperstringApi["getConversationEvents"]>()
      .mockImplementation((id: string) => {
        if (id === "conv-old") {
          return new Promise((resolve) => {
            settleOld = resolve;
          });
        }
        return new Promise((resolve) => {
          settleNew = resolve;
        });
      });
    setupApi({ getConversationEvents: events });

    let activeId = "conv-old";
    const { result, rerender } = renderHook(() => useConversationEvents(activeId));

    expect(events).toHaveBeenCalledTimes(1);

    // Switch to new conversation before old one resolves
    activeId = "conv-new";
    rerender();

    expect(events).toHaveBeenCalledTimes(2);

    // Old response resolves late
    await act(async () => {
      settleOld({ items: [sampleEvent(99, "old-data")], nextSeq: 99, hasMore: false });
      await Promise.resolve();
    });

    // New response resolves
    await act(async () => {
      settleNew({ items: [sampleEvent(1, "new-data")], nextSeq: 1, hasMore: false });
      await Promise.resolve();
    });

    // Old data must NOT leak into the new conversation
    expect(result.current.items.some((item) => item.text === "old-data")).toBe(false);
    expect(result.current.items.some((item) => item.text === "new-data")).toBe(true);
  });

  it("useForegroundRead: focus and visibilitychange in quick succession trigger at most one read", async () => {
    const load = vi.fn();
    const clear = vi.fn();

    renderHook(() => useForegroundRead(load, clear, { intervalMs: 5000 }));

    expect(load).toHaveBeenCalledTimes(1);

    // Blur window
    act(() => {
      fireEvent.blur(window);
    });

    // Both visibilitychange and focus fire on restore
    act(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      fireEvent(document, new Event("visibilitychange"));
      fireEvent.focus(window);
    });

    // Should only have been called once on return (total 2 including initial)
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("useLiveResource: inline callback with component state updates settles properly without churn", async () => {
    let callCount = 0;
    const read = vi.fn(async (_signal: AbortSignal) => {
      callCount++;
      return { value: callCount };
    });

    const { result } = renderHook(() => {
      // Simulating a component that uses inline read callback closing over state
      return useLiveResource(read);
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.data).toEqual({ value: 1 });
    expect(result.current.loading).toBe(false);
  });

  it("ConversationWorkspace with QQ conversation: initial load being interrupted by blur does not freeze on '正在读取会话'", async () => {
    let settle!: (val: ConversationEventsPage) => void;
    const events = vi.fn<SuperstringApi["getConversationEvents"]>().mockImplementation(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    );
    setupApi({
      getConversationEvents: events,
      getConversationRuntimeStatus: vi.fn(async () => ({
        pendingWakes: 0,
        activeRuns: 0,
        failedWakes: 0,
        unknownDeliveries: 0,
        nextReadyAt: null,
        lastActivityAt: "2026-09-30T00:00:00Z",
        connectionPhase: "ready" as const,
        now: "2026-09-30T00:00:00Z",
      })),
      listRuntimeTraces: vi.fn(async () => ({
        items: [],
        nextBeforeId: 0,
        hasMore: false,
        summary: {
          totalTraces: 0,
          activeTraces: 0,
          failedTraces: 0,
          matchedSpans: 0,
          lastActivityAt: null,
          now: "2026-09-30T00:00:00Z",
        },
      })),
      listTasks: vi.fn(async () => ({ items: [], nextCursor: null, hasMore: false })),
    });

    useSuperstringStore.setState({
      currentConversationId: "conversation:qq",
      conversationById: {},
      summaryById: {
        "conversation:qq": qqConversation,
      },
      directoryIds: ["conversation:qq"],
    });

    render(<ExternalConversation conversation={qqConversation} />);

    // While initial load is in flight: "正在读取会话…" is shown
    expect(screen.getByText("正在读取会话…")).toBeTruthy();

    // User blurs window while initial request is in-flight
    act(() => {
      fireEvent.blur(window);
    });

    // Old in-flight promise resolves late
    await act(async () => {
      settle({ items: [sampleEvent(1, "first-message")], nextSeq: 1, hasMore: false });
      await Promise.resolve();
    });

    // Refocus window
    let settle2!: (val: ConversationEventsPage) => void;
    events.mockImplementation(
      () =>
        new Promise((resolve) => {
          settle2 = resolve;
        }),
    );

    act(() => {
      fireEvent.focus(window);
    });

    // Settle the recovery load
    await act(async () => {
      settle2({ items: [sampleEvent(1, "first-message")], nextSeq: 1, hasMore: false });
      await Promise.resolve();
    });

    // Message must be rendered! It must NOT be stuck on '正在读取会话…'
    expect(await screen.findByText("first-message")).toBeTruthy();
    expect(screen.queryByText("正在读取会话…")).toBeNull();
  });
  it("deferred request A finally arriving late does not clear loading when scope changed to B (B still pending)", async () => {
    let settleOld!: (val: ConversationEventsPage) => void;
    let settleNew!: (val: ConversationEventsPage) => void;

    const events = vi
      .fn<SuperstringApi["getConversationEvents"]>()
      .mockImplementation((id: string) => {
        if (id === "conv-old") {
          return new Promise((resolve) => {
            settleOld = resolve;
          });
        }
        return new Promise((resolve) => {
          settleNew = resolve;
        });
      });
    setupApi({ getConversationEvents: events });

    let activeId = "conv-old";
    const { result, rerender } = renderHook(() => useConversationEvents(activeId));

    expect(result.current.loading).toBe(true);

    // Switch to new conversation before old one resolves; B starts pending
    activeId = "conv-new";
    rerender();

    expect(result.current.loading).toBe(true);

    // Old request A settles late while B is still pending
    await act(async () => {
      settleOld({ items: [sampleEvent(99, "old-data")], nextSeq: 99, hasMore: false });
      await Promise.resolve();
    });

    // Request B is still pending! loading MUST remain true, not be cleared by A's finally
    expect(result.current.loading).toBe(true);

    // Now settle B
    await act(async () => {
      settleNew({ items: [sampleEvent(1, "new-data")], nextSeq: 1, hasMore: false });
      await Promise.resolve();
    });

    expect(result.current.loading).toBe(false);
  });

  it("same scope blur-aborted request A finally arriving late does not clear loading when refocus B is pending", async () => {
    let settleA!: (val: ConversationEventsPage) => void;
    let settleB!: (val: ConversationEventsPage) => void;

    let callIndex = 0;
    const events = vi.fn<SuperstringApi["getConversationEvents"]>().mockImplementation(() => {
      callIndex++;
      if (callIndex === 1) {
        return new Promise((resolve) => {
          settleA = resolve;
        });
      }
      return new Promise((resolve) => {
        settleB = resolve;
      });
    });
    setupApi({ getConversationEvents: events });

    const { result } = renderHook(() => useConversationEvents("conv-1"));

    // Request A in-flight
    expect(result.current.loading).toBe(true);

    // Window blurs: A is aborted
    act(() => {
      fireEvent.blur(window);
    });

    // Window refocuses: Request B starts (initial load recovery since first.current is 0)
    act(() => {
      fireEvent.focus(window);
    });

    // Request B should be pending and loading
    expect(result.current.loading).toBe(true);
    expect(events).toHaveBeenCalledTimes(2);

    // Old aborted Request A finally arrives and settles while B is still in flight
    await act(async () => {
      settleA({ items: [sampleEvent(1)], nextSeq: 1, hasMore: false });
      await Promise.resolve();
    });

    // Request B is STILL pending! A's finally must NOT have set loading to false!
    expect(result.current.loading).toBe(true);

    // Now settle B
    await act(async () => {
      settleB({ items: [sampleEvent(1, "b-data")], nextSeq: 1, hasMore: false });
      await Promise.resolve();
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.items).toHaveLength(1);
  });
});
