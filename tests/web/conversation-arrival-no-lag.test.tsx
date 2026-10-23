import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationEventView } from "../../src/shared/contracts/conversation";
import { api, type SuperstringApi } from "../../src/web/api";
import { useConversationEvents } from "../../src/web/features/conversations/use-conversation-events";
import {
  notifyConversationChange,
  resetConversationChangesForTests,
} from "../../src/web/services/conversation-changes";
import { useSuperstringStore as store } from "../../src/web/store";

type Page = Awaited<ReturnType<SuperstringApi["getConversationEvents"]>>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const event = (seq: number, text = `message-${seq}`): ConversationEventView => ({
  conversationId: "arrival-no-lag",
  seq,
  eventKey: `event-${seq}`,
  kind: "inbound",
  source: { kind: "qq_event", id: `event-${seq}`, revision: "1" },
  sources: [{ kind: "qq_event", id: `event-${seq}`, revision: "1" }],
  occurredAt: "2026-10-23T00:00:00Z",
  recordedAt: "2026-10-23T00:00:00Z",
  participant: { id: "member", label: "Member", role: "member" },
  addressing: { reasons: [], mentionIds: [] },
  runId: null,
  outputId: null,
  wake: null,
  text,
  contentState: "active",
  media: [],
  qqMessageFacts: [],
  deliveryStatus: null,
  messageStatus: null,
});

const page = (...items: ConversationEventView[]): Page => ({
  items,
  nextSeq: items.at(-1)?.seq ?? 0,
  hasMore: false,
});

function notify(seq: number) {
  notifyConversationChange({
    event: "conversation_changed",
    conversationId: "arrival-no-lag",
    seq,
    bindingEpoch: 1,
  });
}

let visibility: PropertyDescriptor | undefined;
beforeEach(() => {
  resetConversationChangesForTests();
  visibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});
afterEach(() => {
  cleanup();
  resetConversationChangesForTests();
  vi.restoreAllMocks();
  if (visibility) Object.defineProperty(document, "visibilityState", visibility);
  else Reflect.deleteProperty(document, "visibilityState");
});

describe("conversation arrival keeps every in-flight notification owned", () => {
  it.each(["older", "refresh"] as const)(
    "%s history read cannot erase a second arrival queued behind a pending tail",
    async (kind) => {
      const tail = deferred<Page>();
      const range = deferred<Page>();
      let tailReads = 0;
      const read = vi.fn<SuperstringApi["getConversationEvents"]>(async (_id, params) => {
        if (!params || typeof params === "number") return page();
        if (params.direction === "latest") return { ...page(event(10)), hasMore: true };
        if (params.direction === "before" || params.afterSeq === 9) return range.promise;
        if (params.afterSeq === 10) {
          tailReads += 1;
          return tail.promise;
        }
        if (params.afterSeq === 11) {
          tailReads += 1;
          return page(event(12));
        }
        return page();
      });
      store.getState().resetForTests({ ...api, getConversationEvents: read });
      const { result } = renderHook(() => useConversationEvents("arrival-no-lag"));
      await act(async () => {});
      expect(result.current.items.map((row) => row.seq)).toEqual([10]);

      act(() => notify(11));
      act(() => notify(12));
      expect(tailReads).toBe(1);
      act(() => {
        if (kind === "older") void result.current.loadMore();
        else void result.current.refresh();
      });
      await act(async () => {
        tail.resolve(page(event(11)));
      });

      // No clock advance or third notification: seq 12 is visible while history stays pending.
      expect(tailReads).toBe(2);
      expect(result.current.items.map((row) => row.seq)).toEqual([10, 11, 12]);
      expect(result.current.loading).toBe(true);
      await act(async () => {
        range.resolve(kind === "older" ? page(event(5)) : page(event(10, "revalidated-10")));
      });
      expect(result.current.items.map((row) => row.seq)).toEqual(
        kind === "older" ? [5, 10, 11, 12] : [10, 11, 12],
      );
      expect(read).toHaveBeenCalledTimes(4);
    },
  );

  it("a repeated same-sequence change during a pending tail is read before the next message", async () => {
    const tail = deferred<Page>();
    const read = vi
      .fn<SuperstringApi["getConversationEvents"]>()
      .mockResolvedValueOnce(page(event(10)))
      .mockReturnValueOnce(tail.promise)
      .mockResolvedValue(page(event(11, "revised-11")));
    store.getState().resetForTests({ ...api, getConversationEvents: read });
    const { result } = renderHook(() => useConversationEvents("arrival-no-lag"));
    await act(async () => {});
    act(() => notify(11));
    act(() => notify(11));
    await act(async () => {
      tail.resolve(page(event(11, "old-11")));
    });
    expect(result.current.items.find((row) => row.seq === 11)?.text).toBe("revised-11");
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("resume drains a notified burst beyond a truncated authoritative range page", async () => {
    const range = deferred<Page>();
    const read = vi.fn<SuperstringApi["getConversationEvents"]>(async (_id, params) => {
      if (!params || typeof params === "number") return page();
      if (params.direction === "latest") return page(event(10));
      if (params.direction === "after" && params.afterSeq === 9) return range.promise;
      if (params.direction === "after" && params.afterSeq === 111) return page(event(500));
      return page();
    });
    store.getState().resetForTests({ ...api, getConversationEvents: read });
    const { result, rerender } = renderHook(
      ({ enabled }) => useConversationEvents("arrival-no-lag", undefined, { enabled }),
      { initialProps: { enabled: true } },
    );
    await act(async () => {});
    expect(result.current.items.map((row) => row.seq)).toEqual([10]);

    rerender({ enabled: false });
    act(() => notify(500));
    expect(read).toHaveBeenCalledTimes(1);
    rerender({ enabled: true });
    expect(read).toHaveBeenCalledTimes(2);
    await act(async () => {
      range.resolve({
        ...page(...Array.from({ length: 101 }, (_, index) => event(index + 11))),
        hasMore: true,
      });
    });

    // The range page is authoritative only through 111, not the whole notified burst.
    expect(read).toHaveBeenCalledTimes(3);
    expect(read.mock.calls[2]?.[1]).toMatchObject({ direction: "after", afterSeq: 111 });
    expect(result.current.items.at(-1)?.seq).toBe(500);
    expect(new Set(result.current.items.map((row) => row.seq)).size).toBe(
      result.current.items.length,
    );
  });
});
