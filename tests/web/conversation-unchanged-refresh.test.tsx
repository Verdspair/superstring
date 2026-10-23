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
});
