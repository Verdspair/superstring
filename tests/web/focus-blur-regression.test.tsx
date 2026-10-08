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
  it("useConversationEvents: visible blur and refocus do not trigger a background request", async () => {
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

    act(() => {
      fireEvent.blur(window);
      expect(result.current.items).toHaveLength(2);
      expect(result.current.loading).toBe(false);
      fireEvent(document, new Event("visibilitychange"));
      fireEvent.focus(window);
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(events).toHaveBeenCalledTimes(1);
    expect(result.current.items).toHaveLength(2);
  });

  it("useConversationEvents: brief visible blur does not depend on refocus to finish loading", async () => {
    const events = vi.fn<SuperstringApi["getConversationEvents"]>().mockResolvedValue({
      items: [sampleEvent(1), sampleEvent(2)],
      nextSeq: 2,
      hasMore: false,
    });
    setupApi({ getConversationEvents: events });

    const { result } = renderHook(() =>
      useConversationEvents("conv-1", undefined, { refreshMs: 10000 }),
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(result.current.items).toHaveLength(2);
    expect(events).toHaveBeenCalledTimes(1);

    act(() => {
      fireEvent.blur(window);
      fireEvent.focus(window);
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(events).toHaveBeenCalledTimes(1);
    expect(result.current.items).toHaveLength(2);
  });

  it("useConversationEvents: rapid visible blur-focus cycles add no reads; explicit refreshes still apply each update", async () => {
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

    act(() => {
      fireEvent.blur(window);
      fireEvent.focus(window);
    });
    expect(events).toHaveBeenCalledTimes(1);
    await act(async () => {
      await result.current.refresh();
    });
    expect(events).toHaveBeenCalledTimes(2);
    expect(result.current.items).toHaveLength(2);

    act(() => {
      fireEvent.blur(window);
      fireEvent.focus(window);
    });
    expect(events).toHaveBeenCalledTimes(2);
    await act(async () => {
      await result.current.refresh();
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

  it("useForegroundRead: visible blur and focus do not trigger an extra read", async () => {
    const load = vi.fn();
    const clear = vi.fn();

    renderHook(() => useForegroundRead(load, clear, { intervalMs: 5000 }));

    expect(load).toHaveBeenCalledTimes(1);

    act(() => {
      fireEvent.blur(window);
      fireEvent(document, new Event("visibilitychange"));
      fireEvent.focus(window);
    });

    expect(load).toHaveBeenCalledTimes(1);
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

  it("ConversationWorkspace with QQ conversation: initial load completes after visible blur without refocus", async () => {
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

    // A visible window blur must not cancel or delay acceptance of the initial request.
    act(() => {
      fireEvent.blur(window);
    });

    await act(async () => {
      settle({ items: [sampleEvent(1, "first-message")], nextSeq: 1, hasMore: false });
      await Promise.resolve();
    });

    expect(events).toHaveBeenCalledTimes(1);

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

  it("same scope hidden-page request A arriving late does not clear loading when resumed request B is pending", async () => {
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

    // A genuinely hidden document pauses and aborts the request.
    act(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      fireEvent(document, new Event("visibilitychange"));
    });

    // Resuming the document starts request B; this is not a window-focus transition.
    act(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      fireEvent(document, new Event("visibilitychange"));
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
