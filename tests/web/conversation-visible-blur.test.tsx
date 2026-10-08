import { act, cleanup, fireEvent, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationEventView } from "../../src/shared/contracts/conversation";
import { api, type SuperstringApi } from "../../src/web/api";
import { useConversationEvents } from "../../src/web/features/conversations/use-conversation-events";
import { notifyConversationChange } from "../../src/web/services/conversation-changes";
import { useSuperstringStore } from "../../src/web/store";

type Visibility = "visible" | "hidden";

let originalVisibilityDesc: PropertyDescriptor | undefined;

const setVisibility = (value: Visibility) => {
  Object.defineProperty(document, "visibilityState", { configurable: true, value });
  fireEvent(document, new Event("visibilitychange"));
};

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const sampleEvent = (seq: number, text = `msg-${seq}`): ConversationEventView => ({
  seq,
  eventKey: `event-${seq}`,
  conversationId: "conv-1",
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

function setupApi(overrides: Partial<SuperstringApi>) {
  useSuperstringStore.getState().resetForTests({
    ...api,
    ...overrides,
  });
}

beforeEach(() => {
  originalVisibilityDesc =
    Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState") ??
    Object.getOwnPropertyDescriptor(document, "visibilityState");
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  if (originalVisibilityDesc) {
    Object.defineProperty(document, "visibilityState", originalVisibilityDesc);
  }
});

describe("conversation events visible-blur and document visibility lifecycle", () => {
  it("accepts the first in-flight read after a window blur without waiting for refocus", async () => {
    const first = deferred<{
      items: ConversationEventView[];
      nextSeq: number;
      hasMore: boolean;
    }>();
    const signals: AbortSignal[] = [];
    const events = vi.fn<SuperstringApi["getConversationEvents"]>((_id, _params, signal) => {
      if (signal) signals.push(signal);
      return first.promise;
    });
    setupApi({ getConversationEvents: events });

    const { result } = renderHook(() => useConversationEvents("conv-1"));

    expect(events).toHaveBeenCalledTimes(1);
    expect(result.current.loading).toBe(true);

    // Window blurs while initial load is in flight
    act(() => {
      fireEvent.blur(window);
    });

    // In-flight signal must NOT be aborted by window blur
    expect(signals[0]?.aborted).toBe(false);

    // Resolve deferred response while window is blurred
    await act(async () => {
      first.resolve({
        items: [sampleEvent(1), sampleEvent(2)],
        nextSeq: 2,
        hasMore: false,
      });
      await first.promise;
    });

    // Response must be accepted without refocusing
    expect(result.current.items).toHaveLength(2);
    expect(result.current.loading).toBe(false);
    expect(events).toHaveBeenCalledTimes(1);
  });

  it("does not start an extra GET when the window receives focus", async () => {
    const events = vi.fn<SuperstringApi["getConversationEvents"]>().mockResolvedValue({
      items: [sampleEvent(1)],
      nextSeq: 1,
      hasMore: false,
    });
    setupApi({ getConversationEvents: events });

    const { result } = renderHook(() => useConversationEvents("conv-1"));

    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.items).toHaveLength(1);
    expect(events).toHaveBeenCalledTimes(1);

    // Window blurs then refocuses
    act(() => {
      fireEvent.blur(window);
      fireEvent.focus(window);
    });

    await act(async () => {
      await Promise.resolve();
    });

    // Must NOT trigger extra GET on focus
    expect(events).toHaveBeenCalledTimes(1);
  });

  it("does not start GET when document is initially hidden, resumes once on visible", async () => {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });

    const events = vi.fn<SuperstringApi["getConversationEvents"]>().mockResolvedValue({
      items: [sampleEvent(1)],
      nextSeq: 1,
      hasMore: false,
    });
    setupApi({ getConversationEvents: events });

    const { result } = renderHook(() => useConversationEvents("conv-1"));

    // Initial hidden must NOT start GET
    expect(events).toHaveBeenCalledTimes(0);
    expect(result.current.loading).toBe(false);

    // Document transitions to visible
    act(() => {
      setVisibility("visible");
    });

    await act(async () => {
      await Promise.resolve();
    });

    // Transitions catchup once
    expect(events).toHaveBeenCalledTimes(1);
    expect(result.current.items).toHaveLength(1);
  });

  it("cancels in-flight read on document hidden, ignores late response, and reads once when visible", async () => {
    const hiddenRead = deferred<{
      items: ConversationEventView[];
      nextSeq: number;
      hasMore: boolean;
    }>();
    const visibleRead = deferred<{
      items: ConversationEventView[];
      nextSeq: number;
      hasMore: boolean;
    }>();
    const signals: AbortSignal[] = [];
    const events = vi.fn<SuperstringApi["getConversationEvents"]>((_id, _params, signal) => {
      if (signal) signals.push(signal);
      return signals.length === 1 ? hiddenRead.promise : visibleRead.promise;
    });
    setupApi({ getConversationEvents: events });

    const { result } = renderHook(() => useConversationEvents("conv-1"));
    expect(events).toHaveBeenCalledTimes(1);

    // Document becomes hidden
    act(() => {
      setVisibility("hidden");
    });

    // Hidden aborts in-flight request
    expect(signals[0]?.aborted).toBe(true);

    // Late resolution during hidden
    await act(async () => {
      hiddenRead.resolve({
        items: [sampleEvent(99)],
        nextSeq: 99,
        hasMore: false,
      });
      await hiddenRead.promise;
    });

    // Ignored late response
    expect(result.current.items).toHaveLength(0);

    // Becomes visible again
    act(() => {
      setVisibility("visible");
    });

    expect(events).toHaveBeenCalledTimes(2);

    await act(async () => {
      visibleRead.resolve({
        items: [sampleEvent(1)],
        nextSeq: 1,
        hasMore: false,
      });
      await visibleRead.promise;
    });

    expect(result.current.items).toHaveLength(1);
    expect(events).toHaveBeenCalledTimes(2);
  });
  it("consumes pre-hide notifications in the resumed read and preserves notifications during it", async () => {
    type Page = Awaited<ReturnType<SuperstringApi["getConversationEvents"]>>;
    const first = deferred<Page>();
    const resumed = deferred<Page>();
    const read = vi
      .fn<SuperstringApi["getConversationEvents"]>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(resumed.promise)
      .mockResolvedValue({ items: [sampleEvent(3)], nextSeq: 3, hasMore: false });
    setupApi({ getConversationEvents: read });
    const { result } = renderHook(() => useConversationEvents("conv-1"));
    const changed = () =>
      notifyConversationChange({
        event: "conversation_changed",
        conversationId: "conv-1",
        seq: 2,
        bindingEpoch: 1,
      });
    act(() => {
      changed();
      setVisibility("hidden");
    });
    await act(async () => {
      first.resolve({ items: [sampleEvent(1)], nextSeq: 1, hasMore: false });
    });
    act(() => setVisibility("visible"));
    await act(async () => {
      resumed.resolve({ items: [sampleEvent(2)], nextSeq: 2, hasMore: false });
    });
    expect(read).toHaveBeenCalledTimes(2);
    expect(result.current.items[0]?.seq).toBe(2);
    // A new notification still requires a fresh read after the resumed read has settled.
    await act(async () => {
      changed();
    });
    expect(read).toHaveBeenCalledTimes(3);
    expect(result.current.items[0]?.seq).toBe(3);
  });
});
