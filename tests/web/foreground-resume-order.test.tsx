import { act, cleanup, fireEvent, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationEventView } from "../../src/shared/contracts/conversation";
import { api, type SuperstringApi } from "../../src/web/api";
import { useConversationEvents } from "../../src/web/features/conversations/use-conversation-events";
import { useForegroundRead } from "../../src/web/services/use-foreground-read";
import { useSuperstringStore } from "../../src/web/store";

// jsdom 契约测试：只验证事件顺序下的钩子行为，不冒充真实 OS 失焦验收。
// 覆盖已登记缺口：focus 在 document 仍 hidden 时到达，不得吞掉随后
// visibilitychange(visible) 的那一轮回焦后台复验。

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

function setupApi(overrides: Partial<SuperstringApi>) {
  useSuperstringStore.getState().resetForTests({
    ...api,
    ...overrides,
  });
}

describe("foreground resume order regression", () => {
  it("useForegroundRead: focus consumed while still hidden must not swallow the visible transition (one background revalidation, data retained)", () => {
    const load = vi.fn();
    const clear = vi.fn();
    renderHook(() => useForegroundRead(load, clear, { intervalMs: 60_000 }));
    expect(load).toHaveBeenCalledTimes(1);

    // 1) Window goes hidden.
    act(() => {
      setVisibility("hidden");
    });
    expect(load).toHaveBeenCalledTimes(1);
    expect(clear).not.toHaveBeenCalled();

    // 2) focus arrives while document is STILL hidden (restore order: focus before visibilitychange).
    act(() => {
      fireEvent.focus(window);
    });
    // The read itself is gated on hidden here; the transition must remain unconsumed.

    // 3) Document becomes visible.
    act(() => {
      setVisibility("visible");
    });

    // 回焦总是后台复验一次；旧数据保留（retainOnBlur 不 clear）。
    expect(load).toHaveBeenCalledTimes(2);
    expect(clear).not.toHaveBeenCalled();
  });

  it("useConversationEvents: focus consumed while still hidden must not swallow the visible transition (one background request, data retained)", async () => {
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

    // 1) Hidden: pause only, bodies retained.
    act(() => {
      setVisibility("hidden");
    });
    expect(result.current.items).toHaveLength(2);

    // 2) focus while still hidden.
    act(() => {
      fireEvent.focus(window);
    });

    // 3) Visible again.
    act(() => {
      setVisibility("visible");
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(events).toHaveBeenCalledTimes(2);
    expect(result.current.items).toHaveLength(2);
  });

  it("useForegroundRead: visible blur then focus+visibilitychange in either order triggers exactly one revalidation per transition", () => {
    const load = vi.fn();
    const clear = vi.fn();
    renderHook(() => useForegroundRead(load, clear, { intervalMs: 60_000 }));
    expect(load).toHaveBeenCalledTimes(1);

    // Order A: visibilitychange(visible) first, then focus.
    act(() => {
      fireEvent.blur(window);
      fireEvent(document, new Event("visibilitychange"));
      fireEvent.focus(window);
    });
    expect(load).toHaveBeenCalledTimes(2);

    // Order B: focus first, then visibilitychange.
    act(() => {
      fireEvent.blur(window);
      fireEvent.focus(window);
      fireEvent(document, new Event("visibilitychange"));
    });
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("useConversationEvents: visible blur then focus+visibilitychange in either order triggers exactly one revalidation per transition", async () => {
    const events = vi
      .fn<SuperstringApi["getConversationEvents"]>()
      .mockResolvedValue(page([sampleEvent(1)]));
    setupApi({ getConversationEvents: events });

    const { result } = renderHook(() => useConversationEvents("conv-1"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(events).toHaveBeenCalledTimes(1);

    // Order A: visibilitychange(visible) first, then focus.
    act(() => {
      fireEvent.blur(window);
      fireEvent(document, new Event("visibilitychange"));
      fireEvent.focus(window);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(events).toHaveBeenCalledTimes(2);
    expect(result.current.items).toHaveLength(1);

    // Order B: focus first, then visibilitychange.
    act(() => {
      fireEvent.blur(window);
      fireEvent.focus(window);
      fireEvent(document, new Event("visibilitychange"));
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(events).toHaveBeenCalledTimes(3);
    expect(result.current.items).toHaveLength(1);
  });

  it("useForegroundRead: two rapid foreground transitions each revalidate (no debounce loss)", () => {
    const load = vi.fn();
    const clear = vi.fn();
    renderHook(() => useForegroundRead(load, clear, { intervalMs: 60_000 }));
    expect(load).toHaveBeenCalledTimes(1);

    act(() => {
      fireEvent.blur(window);
      fireEvent.focus(window);
    });
    expect(load).toHaveBeenCalledTimes(2);

    act(() => {
      fireEvent.blur(window);
      fireEvent.focus(window);
    });
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("useConversationEvents: two rapid foreground transitions each revalidate and land their updates (no debounce loss)", async () => {
    const events = vi
      .fn<SuperstringApi["getConversationEvents"]>()
      .mockResolvedValueOnce(page([sampleEvent(1)]))
      .mockResolvedValueOnce(page([sampleEvent(1), sampleEvent(2)]))
      .mockResolvedValueOnce(page([sampleEvent(1), sampleEvent(2), sampleEvent(3)]));
    setupApi({ getConversationEvents: events });

    const { result } = renderHook(() => useConversationEvents("conv-1"));
    await act(async () => {
      await Promise.resolve();
    });
    expect(events).toHaveBeenCalledTimes(1);
    expect(result.current.items).toHaveLength(1);

    // Transition 1.
    act(() => {
      fireEvent.blur(window);
      fireEvent.focus(window);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(events).toHaveBeenCalledTimes(2);
    expect(result.current.items).toHaveLength(2);

    // Transition 2 immediately after.
    act(() => {
      fireEvent.blur(window);
      fireEvent.focus(window);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(events).toHaveBeenCalledTimes(3);
    expect(result.current.items).toHaveLength(3);
  });
});
