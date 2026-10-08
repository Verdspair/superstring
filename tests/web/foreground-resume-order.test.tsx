import { act, cleanup, fireEvent, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationEventView } from "../../src/shared/contracts/conversation";
import { api, type SuperstringApi } from "../../src/web/api";
import { useConversationEvents } from "../../src/web/features/conversations/use-conversation-events";
import { useForegroundRead } from "../../src/web/services/use-foreground-read";
import { useSuperstringStore } from "../../src/web/store";

// jsdom contract tests for document visibility and window-focus independence.

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

type Visibility = "visible" | "hidden";

const setVisibility = (value: Visibility) => {
  Object.defineProperty(document, "visibilityState", { configurable: true, value });
  fireEvent(document, new Event("visibilitychange"));
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

const page = (items: ConversationEventView[]): ConversationEventsPage => ({
  items,
  nextSeq: items.length,
  hasMore: false,
});

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

function setupApi(overrides: Partial<SuperstringApi>) {
  useSuperstringStore.getState().resetForTests({
    ...api,
    ...overrides,
  });
}

describe("foreground read lifecycle", () => {
  it("useForegroundRead: a hidden document pauses reads and visibility restores one read while retaining data", () => {
    const load = vi.fn();
    const clear = vi.fn();
    renderHook(() => useForegroundRead(load, clear, { intervalMs: 60_000 }));
    expect(load).toHaveBeenCalledTimes(1);

    act(() => setVisibility("hidden"));
    expect(load).toHaveBeenCalledTimes(1);
    expect(clear).not.toHaveBeenCalled();

    // A focus event cannot resume reads while the document is hidden.
    act(() => fireEvent.focus(window));
    expect(load).toHaveBeenCalledTimes(1);

    act(() => setVisibility("visible"));

    // Visibility restoration triggers one read; existing data is retained.
    expect(load).toHaveBeenCalledTimes(2);
    expect(clear).not.toHaveBeenCalled();
  });

  it("useConversationEvents: focus while the document remains hidden does not resume until visible", async () => {
    const events = vi
      .fn<SuperstringApi["getConversationEvents"]>()
      .mockResolvedValue(page([sampleEvent(1), sampleEvent(2)]));
    setupApi({ getConversationEvents: events });

    const { result } = renderHook(() => useConversationEvents("conv-1"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(events).toHaveBeenCalledTimes(1);
    expect(result.current.items).toHaveLength(2);

    act(() => setVisibility("hidden"));
    expect(result.current.items).toHaveLength(2);

    act(() => setVisibility("visible"));
    await act(async () => {
      await Promise.resolve();
    });

    expect(events).toHaveBeenCalledTimes(2);
    expect(result.current.items).toHaveLength(2);
  });

  it("useForegroundRead: visible window blur and focus do not start reads", () => {
    const load = vi.fn();
    const clear = vi.fn();
    renderHook(() => useForegroundRead(load, clear, { intervalMs: 60_000 }));
    expect(load).toHaveBeenCalledTimes(1);

    act(() => {
      fireEvent.blur(window);
      fireEvent.focus(window);
      fireEvent.blur(window);
      fireEvent.focus(window);
    });

    expect(load).toHaveBeenCalledTimes(1);
    expect(clear).not.toHaveBeenCalled();
  });

  it("useConversationEvents: visible window blur keeps an in-flight read and focus does not add a request", async () => {
    const first = deferred<ConversationEventsPage>();
    const events = vi.fn<SuperstringApi["getConversationEvents"]>(() => first.promise);
    setupApi({ getConversationEvents: events });

    const { result } = renderHook(() => useConversationEvents("conv-1"));
    expect(events).toHaveBeenCalledTimes(1);
    const signal = events.mock.calls[0]?.[2];
    expect(signal?.aborted).toBe(false);

    act(() => fireEvent.blur(window));
    expect(signal?.aborted).toBe(false);
    act(() => fireEvent.focus(window));
    expect(events).toHaveBeenCalledTimes(1);

    await act(async () => {
      first.resolve(page([sampleEvent(1)]));
      await first.promise;
    });

    expect(events).toHaveBeenCalledTimes(1);
    expect(signal?.aborted).toBe(false);
    expect(result.current.items).toHaveLength(1);
  });

  it("useForegroundRead: repeated visible blur and focus do not start extra reads", () => {
    const load = vi.fn();
    const clear = vi.fn();
    renderHook(() => useForegroundRead(load, clear, { intervalMs: 60_000 }));
    expect(load).toHaveBeenCalledTimes(1);

    act(() => {
      fireEvent.blur(window);
      fireEvent.focus(window);
      fireEvent.blur(window);
      fireEvent.focus(window);
    });

    expect(load).toHaveBeenCalledTimes(1);
    expect(clear).not.toHaveBeenCalled();
  });

  it("useConversationEvents: repeated visible window blur and focus do not add requests or discard updates", async () => {
    const events = vi
      .fn<SuperstringApi["getConversationEvents"]>()
      .mockResolvedValueOnce(page([sampleEvent(1)]));
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
      fireEvent.blur(window);
      fireEvent.focus(window);
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(events).toHaveBeenCalledTimes(1);
    expect(result.current.items).toHaveLength(1);
  });
});
