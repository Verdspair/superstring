import { act, cleanup, fireEvent, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ConversationEventView,
  ConversationSummary,
} from "../../src/shared/contracts/conversation";
import { api, type SuperstringApi } from "../../src/web/api";
import { useConversationEvents } from "../../src/web/features/conversations/use-conversation-events";
import { ExternalConversation } from "../../src/web/screens/conversations/ExternalConversation";
import { notifyConversationChange } from "../../src/web/services/conversation-changes";
import { useSuperstringStore } from "../../src/web/store";
import { render } from "./helpers/render-with-providers";

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
  vi.useRealTimers();
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

  it.each(["hidden document", "inactive messages", "paused workspace"])(
    "redacts the retained timeline DOM at its cap in a %s and restores with one read",
    async (pause) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-29T00:00:00Z"));
      const expiring: ConversationEventView = {
        ...sampleEvent(1, "protected-timeline-body"),
        source: {
          kind: "qq_event",
          id: "event-1",
          revision: "1",
          expiresAt: new Date(Date.now() + 1000).toISOString(),
        },
        media: [
          {
            id: "image-1",
            kind: "image",
            description: "protected-image",
            availability: "available",
          },
          {
            id: "sticker-1",
            kind: "sticker",
            description: "protected-sticker",
            availability: "available",
          },
        ],
        qqMessageFacts: [
          {
            id: "fact-1",
            platformMessageId: "platform-1",
            seq: 1,
            occurredAtSeconds: 1,
            speaker: {
              role: "member",
              qq: "10001",
              groupCard: "protected-name",
              personalNickname: null,
              legacyDisplayName: null,
              nameState: "known",
            },
            parts: [{ kind: "text", text: "protected-fact" }],
            mentions: [],
            replyTo: null,
            sources: [],
            completeness: "full",
          },
        ],
      };
      const stable = sampleEvent(2, "unexpired-timeline-body");
      type Page = Awaited<ReturnType<SuperstringApi["getConversationEvents"]>>;
      const resumed = deferred<Page>();
      const events = vi
        .fn<SuperstringApi["getConversationEvents"]>()
        .mockResolvedValueOnce({ items: [expiring, stable], nextSeq: 2, hasMore: false })
        .mockReturnValueOnce(resumed.promise);
      setupApi({
        getConversationEvents: events,
        listRuntimeTraces: async () => ({
          items: [],
          summary: {
            totalTraces: 0,
            activeTraces: 0,
            failedTraces: 0,
            matchedSpans: 0,
            lastActivityAt: null,
            now: new Date().toISOString(),
          },
          hasMore: false,
          nextBeforeId: 0,
        }),
      });
      const conversation: ConversationSummary = {
        id: "conv-1",
        sourceId: "binding-1",
        channel: "onebot11",
        topology: "direct",
        agentId: "agent-1",
        bindingEpoch: 1,
        title: "Private",
        participants: [],
        updatedAt: expiring.occurredAt,
        lastSeq: 2,
        consumedSeq: 2,
      };
      const tree = (active: boolean) => (
        <div hidden={pause === "paused workspace" && !active}>
          <ExternalConversation conversation={conversation} active={active} />
        </div>
      );
      const view = render(tree(true));
      await act(async () => {});
      const viewport = view.container.querySelector<HTMLElement>("[role=tabpanel]")!;
      Object.defineProperties(viewport, {
        scrollHeight: { configurable: true, value: 1600 },
        clientHeight: { configurable: true, value: 400 },
      });
      viewport.scrollTop = 300;
      fireEvent.scroll(viewport);
      expect(view.container.textContent).toContain("protected-timeline-body");
      expect(view.container.textContent).toContain("protected-name");
      if (pause === "hidden document") act(() => setVisibility("hidden"));
      else view.rerender(tree(false));
      expect(viewport.isConnected).toBe(true);
      expect(view.container.textContent).toContain("protected-timeline-body");
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      for (const protectedText of [
        "protected-timeline-body",
        "protected-image",
        "protected-sticker",
        "protected-name",
      ]) {
        expect(view.container.textContent).not.toContain(protectedText);
      }
      expect(view.container.textContent).toContain("unexpired-timeline-body");
      expect(view.container.querySelector("#source-qq_event-event-1")).not.toBeNull();
      expect(events).toHaveBeenCalledTimes(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30000);
      });
      expect(events).toHaveBeenCalledTimes(1);
      if (pause === "hidden document") act(() => setVisibility("visible"));
      else {
        viewport.scrollTop = 0;
        view.rerender(tree(true));
      }
      expect(view.container.textContent).not.toContain("protected-timeline-body");
      expect(view.container.textContent).toContain("unexpired-timeline-body");
      expect(events).toHaveBeenCalledTimes(2);
      await act(async () => {
        // A stale active projection is still subject to its original source cap.
        resumed.resolve({
          items: [expiring, stable, sampleEvent(3, "resumed-arrival")],
          nextSeq: 3,
          hasMore: false,
        });
      });
      expect(view.container.textContent).not.toContain("protected-timeline-body");
      expect(view.container.textContent).toContain("resumed-arrival");
      expect(viewport.scrollTop).toBe(300);
      act(() => {
        fireEvent.blur(window);
        fireEvent.focus(window);
      });
      expect(events).toHaveBeenCalledTimes(2);
    },
  );

  it.each(["hidden", "disabled"])(
    "aborts both history transports while %s without disarming loaded content expiry",
    async (pause) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-10-29T00:00:00Z"));
      type Page = Awaited<ReturnType<SuperstringApi["getConversationEvents"]>>;
      const older = deferred<Page>();
      const tail = deferred<Page>();
      const row: ConversationEventView = {
        ...sampleEvent(10),
        sources: [
          {
            kind: "qq_event",
            id: "event-10",
            revision: "1",
            expiresAt: new Date(Date.now() + 1000).toISOString(),
          },
        ],
      };
      const read = vi
        .fn<SuperstringApi["getConversationEvents"]>()
        .mockResolvedValueOnce({ items: [row], nextSeq: 10, hasMore: true })
        .mockReturnValueOnce(older.promise)
        .mockReturnValueOnce(tail.promise);
      setupApi({ getConversationEvents: read });
      const { result, rerender } = renderHook(
        ({ enabled }) => useConversationEvents("conv-1", undefined, { enabled }),
        { initialProps: { enabled: true } },
      );
      await act(async () => {});
      act(() => {
        void result.current.loadMore();
      });
      act(() =>
        notifyConversationChange({
          event: "conversation_changed",
          conversationId: "conv-1",
          seq: 11,
          bindingEpoch: 1,
        }),
      );
      const rangeSignal = read.mock.calls[1]?.[2];
      const tailSignal = read.mock.calls[2]?.[2];
      expect(rangeSignal?.aborted).toBe(false);
      expect(tailSignal?.aborted).toBe(false);
      if (pause === "hidden") act(() => setVisibility("hidden"));
      else rerender({ enabled: false });
      expect(rangeSignal?.aborted).toBe(true);
      expect(tailSignal?.aborted).toBe(true);
      await act(async () => {
        await result.current.refresh();
        await result.current.loadMore();
        await vi.advanceTimersByTimeAsync(1000);
        older.resolve({ items: [sampleEvent(5, "late-older")], nextSeq: 5, hasMore: false });
        tail.resolve({ items: [sampleEvent(11, "late-tail")], nextSeq: 11, hasMore: false });
      });
      expect(result.current.items.map((item) => [item.seq, item.text, item.contentState])).toEqual([
        [10, null, "expired"],
      ]);
      expect(result.current.loading).toBe(false);
      expect(read).toHaveBeenCalledTimes(3);
    },
  );

  it("sanitizes a retained body before resumed transport when a hidden clock jumps beyond its cap", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-29T00:00:00Z"));
    const row: ConversationEventView = {
      ...sampleEvent(1),
      source: {
        kind: "qq_event",
        id: "event-1",
        revision: "1",
        expiresAt: new Date(Date.now() + 1000).toISOString(),
      },
    };
    const read = vi
      .fn<SuperstringApi["getConversationEvents"]>()
      .mockResolvedValueOnce({ items: [row], nextSeq: 1, hasMore: false })
      .mockReturnValueOnce(new Promise(() => {}));
    setupApi({ getConversationEvents: read });
    const { result } = renderHook(() => useConversationEvents("conv-1"));
    await act(async () => {});
    act(() => setVisibility("hidden"));
    // Background browsers may defer timers. The visibility path must use the same cap.
    vi.setSystemTime(new Date(Date.now() + 2000));
    expect(result.current.items[0]?.text).toBe("msg-1");
    act(() => setVisibility("visible"));
    expect(result.current.items[0]).toMatchObject({ text: null, contentState: "expired" });
    expect(read).toHaveBeenCalledTimes(2);
    expect(result.current.loading).toBe(true);
  });
});
