import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationEventView } from "../../src/shared/contracts/conversation";
import { api, type SuperstringApi } from "../../src/web/api";
import type { BrowserStateStorage } from "../../src/web/browser-state";
import { useConversationEvents } from "../../src/web/features/conversations/use-conversation-events";
import {
  notifyConversationChange,
  resetConversationChangesForTests,
} from "../../src/web/services/conversation-changes";
import { useSuperstringStore } from "../../src/web/store";

const event = (seq: number): ConversationEventView => ({
  seq,
  eventKey: `event-${seq}`,
  conversationId: "conv-1",
  kind: "inbound",
  source: { kind: "qq_event", id: `event-${seq}`, revision: "1" },
  sources: [{ kind: "qq_event", id: `event-${seq}`, revision: "1" }],
  outputId: null,
  runId: null,
  wake: null,
  text: `message-${seq}`,
  contentState: "active",
  media: [],
  qqMessageFacts: [],
  addressing: { reasons: [], mentionIds: [] },
  deliveryStatus: null,
  messageStatus: null,
  participant: { id: "person", label: "User", role: "member" },
  occurredAt: "2026-10-05T00:00:00Z",
  recordedAt: "2026-10-05T00:00:00Z",
});

function setup(read: SuperstringApi["getConversationEvents"]) {
  const writes: string[] = [];
  const storage: BrowserStateStorage = {
    read: vi.fn(async () => null),
    write: vi.fn(async (_key: string, value: string | null) => {
      if (value !== null) writes.push(value);
    }),
    remove: vi.fn(async () => {}),
  };
  useSuperstringStore.getState().resetForTests({ ...api, getConversationEvents: read });
  useSuperstringStore.setState({ sessionStateStorage: storage });
  return { storage, writes };
}

beforeEach(() => {
  vi.useFakeTimers();
  resetConversationChangesForTests();
});

afterEach(() => {
  cleanup();
  resetConversationChangesForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("conversation unchanged authoritative refresh", () => {
  it("does not poll and revalidates equal loaded rows only after a matching change", async () => {
    const read = vi.fn<SuperstringApi["getConversationEvents"]>().mockImplementation(async () => ({
      items: Array.from({ length: 100 }, (_, index) => event(index + 1)),
      nextSeq: 100,
      hasMore: false,
    }));
    const { storage } = setup(read);
    const beforeChange = vi.fn();
    const { result } = renderHook(() => useConversationEvents("conv-1", beforeChange));
    await act(async () => {});
    const initial = result.current.items;
    expect(initial).toHaveLength(100);
    expect(storage.write).toHaveBeenCalledTimes(1);
    beforeChange.mockClear();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(read).toHaveBeenCalledTimes(1);
    await act(async () => {
      notifyConversationChange({
        event: "conversation_changed",
        conversationId: "conv-1",
        seq: 100,
        bindingEpoch: 1,
      });
    });
    expect(read).toHaveBeenCalledTimes(2);
    expect(read.mock.calls[1]?.[1]).toMatchObject({
      direction: "after",
      afterSeq: 0,
      limit: 200,
    });
    expect(result.current.items).toBe(initial);
    expect(beforeChange).not.toHaveBeenCalled();
    expect(storage.write).toHaveBeenCalledTimes(1);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBe("");
    expect(result.current.hasMore).toBe(false);

    await act(async () => {
      await result.current.refresh();
    });
    expect(read).toHaveBeenCalledTimes(3);
    expect(result.current.items).toBe(initial);
    expect(beforeChange).not.toHaveBeenCalled();
    expect(storage.write).toHaveBeenCalledTimes(1);
  });

  it("persists a concurrent tail after an otherwise unchanged held range", async () => {
    type Page = Awaited<ReturnType<SuperstringApi["getConversationEvents"]>>;
    let release!: (page: Page) => void;
    const held = new Promise<Page>((resolve) => {
      release = resolve;
    });
    const read = vi
      .fn<SuperstringApi["getConversationEvents"]>()
      .mockResolvedValueOnce({ items: [event(1)], nextSeq: 1, hasMore: false })
      .mockReturnValueOnce(held)
      .mockResolvedValueOnce({ items: [event(2)], nextSeq: 2, hasMore: false });
    const { storage, writes } = setup(read);
    const { result } = renderHook(() => useConversationEvents("conv-1"));
    await act(async () => {});
    act(() => {
      void result.current.refresh();
    });
    await act(async () => {
      notifyConversationChange({
        event: "conversation_changed",
        conversationId: "conv-1",
        seq: 2,
        bindingEpoch: 1,
      });
    });
    const withTail = result.current.items;
    expect(withTail.map((row) => row.seq)).toEqual([1, 2]);
    expect(storage.write).toHaveBeenCalledTimes(1);
    await act(async () => {
      release({ items: [event(1)], nextSeq: 1, hasMore: false });
    });
    expect(result.current.items).toBe(withTail);
    expect(storage.write).toHaveBeenCalledTimes(2);
    expect(
      JSON.parse(writes.at(-1) ?? "{}").items.map((row: ConversationEventView) => row.seq),
    ).toEqual([1, 2]);
  });

  it("publishes and caches same-sequence expiry while retaining the older loaded range and scroll anchor", async () => {
    const expired = { ...event(1), text: null, contentState: "expired" as const };
    const read = vi
      .fn<SuperstringApi["getConversationEvents"]>()
      .mockResolvedValueOnce({ items: [event(10)], nextSeq: 10, hasMore: true })
      .mockResolvedValueOnce({ items: [event(1)], nextSeq: 1, hasMore: false })
      .mockResolvedValueOnce({ items: [expired, event(10)], nextSeq: 10, hasMore: false });
    const { writes } = setup(read);
    const scroller = document.createElement("div");
    scroller.scrollTop = 140;
    const beforeChange = vi.fn();
    const { result } = renderHook(() => useConversationEvents("conv-1", beforeChange));
    await act(async () => {});
    await act(async () => {
      await result.current.loadMore();
    });
    const latestRow = result.current.items[1];
    beforeChange.mockClear();
    await act(async () => {
      notifyConversationChange({
        event: "conversation_changed",
        conversationId: "conv-1",
        seq: 10,
        bindingEpoch: 1,
      });
    });
    expect(read.mock.calls[2]?.[1]).toMatchObject({ direction: "after", afterSeq: 0 });
    expect(result.current.items.map((row) => [row.seq, row.text])).toEqual([
      [1, null],
      [10, "message-10"],
    ]);
    expect(result.current.items[0]?.contentState).toBe("expired");
    expect(result.current.items[1]).toBe(latestRow);
    expect(beforeChange).toHaveBeenCalledTimes(1);
    expect(scroller.scrollTop).toBe(140);
    const cached = JSON.parse(writes.at(-1) ?? "{}");
    expect(cached.items[0].text).toBeNull();
    expect(cached.items[0].contentState).toBe("expired");
  });

  it("hydrates an inactive cache through source sanitization even when storage resolves after its cap", async () => {
    vi.setSystemTime(new Date("2026-10-29T00:00:00Z"));
    const cached: ConversationEventView = {
      ...event(1),
      source: {
        kind: "qq_event",
        id: "event-1",
        revision: "1",
        expiresAt: new Date(Date.now() + 1000).toISOString(),
      },
      media: [
        { id: "image-1", kind: "image", description: "cached-image", availability: "available" },
      ],
    };
    const stable = event(2);
    let release!: (value: string) => void;
    const pendingCache = new Promise<string>((resolve) => {
      release = resolve;
    });
    const read = vi.fn<SuperstringApi["getConversationEvents"]>().mockResolvedValue({
      items: [cached, stable],
      nextSeq: 2,
      hasMore: false,
    });
    const { storage } = setup(read);
    vi.mocked(storage.read).mockReturnValue(pendingCache);
    useSuperstringStore.setState({
      summaryById: {
        "conv-1": { id: "conv-1", agentId: "agent-1", bindingEpoch: 1 } as never,
      },
    });
    const beforeChange = vi.fn();
    const { result, rerender } = renderHook(
      ({ enabled }) => useConversationEvents("conv-1", beforeChange, { enabled }),
      { initialProps: { enabled: false } },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      release(
        JSON.stringify({
          conversationId: "conv-1",
          agentId: "agent-1",
          bindingEpoch: 1,
          items: [cached, stable],
          cachedAt: Date.now() - 1000,
        }),
      );
    });
    expect(read).not.toHaveBeenCalled();
    expect(result.current.items[0]).toMatchObject({
      text: null,
      contentState: "expired",
      media: [{ id: "image-1", description: null, availability: "unavailable" }],
      qqMessageFacts: [],
    });
    expect(result.current.items[1]?.text).toBe("message-2");
    const expired = result.current.items;
    beforeChange.mockClear();
    rerender({ enabled: true });
    expect(result.current.items[0]?.text).toBeNull();
    expect(result.current.items[1]?.text).toBe("message-2");
    await act(async () => {});
    expect(read).toHaveBeenCalledTimes(1);
    expect(result.current.items).toBe(expired);
    expect(beforeChange).not.toHaveBeenCalled();
    expect(storage.write).toHaveBeenCalledTimes(1);
    const persisted = JSON.parse(vi.mocked(storage.write).mock.calls[0]?.[1] ?? "{}");
    expect(persisted.items[0].text).toBeNull();
    expect(persisted.items[0].media[0].description).toBeNull();
    expect(persisted.items[1].text).toBe("message-2");
  });

  it("keeps an inactive hydrated cache on the same local expiry clock without reads or writes", async () => {
    vi.setSystemTime(new Date("2026-10-29T00:00:00Z"));
    const cached: ConversationEventView = {
      ...event(1),
      sources: [
        {
          kind: "qq_event",
          id: "body-1",
          revision: "1",
          expiresAt: new Date(Date.now() + 3000).toISOString(),
        },
        {
          kind: "qq_observation",
          id: "body-2",
          revision: "1",
          expiresAt: new Date(Date.now() + 1000).toISOString(),
        },
      ],
    };
    const read = vi.fn<SuperstringApi["getConversationEvents"]>();
    const { storage } = setup(read);
    vi.mocked(storage.read).mockResolvedValue(
      JSON.stringify({
        conversationId: "conv-1",
        agentId: "agent-1",
        bindingEpoch: 1,
        items: [cached, event(2)],
        cachedAt: Date.now(),
      }),
    );
    useSuperstringStore.setState({
      summaryById: {
        "conv-1": { id: "conv-1", agentId: "agent-1", bindingEpoch: 1 } as never,
      },
    });
    const beforeChange = vi.fn();
    const { result, unmount } = renderHook(() =>
      useConversationEvents("conv-1", beforeChange, { enabled: false }),
    );
    await act(async () => {});
    const stable = result.current.items[1];
    expect(result.current.items[0]?.text).toBe("message-1");
    expect(vi.getTimerCount()).toBe(1);
    beforeChange.mockClear();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(result.current.items[0]).toMatchObject({ text: null, contentState: "expired" });
    expect(result.current.items[1]).toBe(stable);
    expect(beforeChange).toHaveBeenCalledTimes(1);
    expect(beforeChange).toHaveBeenLastCalledWith("refresh", result.current.items);
    expect(read).not.toHaveBeenCalled();
    expect(storage.write).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
