import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationEventView } from "../../src/shared/contracts/conversation";
import { api, type SuperstringApi } from "../../src/web/api";
import { useConversationEvents } from "../../src/web/features/conversations/use-conversation-events";
import {
  notifyConversationChange,
  resetConversationChangesForTests,
} from "../../src/web/services/conversation-changes";
import { useSuperstringStore } from "../../src/web/store";

let originalVisibilityDesc: PropertyDescriptor | undefined;

beforeEach(() => {
  localStorage.clear();
  resetConversationChangesForTests();
  originalVisibilityDesc =
    Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState") ??
    Object.getOwnPropertyDescriptor(document, "visibilityState");
});

afterEach(() => {
  cleanup();
  resetConversationChangesForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (originalVisibilityDesc) {
    Object.defineProperty(document, "visibilityState", originalVisibilityDesc);
  }
});

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
  occurredAt: "2026-10-05T00:00:00Z",
  recordedAt: "2026-10-05T00:00:00Z",
});

function setupApi(overrides: Partial<SuperstringApi>) {
  useSuperstringStore.getState().resetForTests({
    ...api,
    ...overrides,
  });
}

describe("conversation-live-history: dual-channel and progressive tail append", () => {
  it("pending older page does not block new seq SSE: new row visible without resolving older read", async () => {
    let resolveOlderPage!: (value: unknown) => void;
    const olderPromise = new Promise((res) => {
      resolveOlderPage = res;
    });

    const getEvents = vi
      .fn()
      .mockImplementation(
        async (
          _id: string,
          params: Exclude<Parameters<SuperstringApi["getConversationEvents"]>[1], number>,
        ) => {
          if (params?.direction === "latest") {
            return {
              items: [sampleEvent(10, "msg-10")],
              nextSeq: 11,
              hasMore: true,
            };
          }
          if (params?.direction === "before") {
            await olderPromise;
            return {
              items: [sampleEvent(5, "msg-5")],
              nextSeq: 5,
              hasMore: false,
            };
          }
          if (params?.direction === "after") {
            return {
              items: [
                sampleEvent(
                  params.afterSeq ? params.afterSeq + 1 : 11,
                  `tail-${(params.afterSeq ?? 0) + 1}`,
                ),
              ],
              nextSeq: params.afterSeq ? params.afterSeq + 2 : 12,
              hasMore: false,
            };
          }
          return { items: [], nextSeq: 0, hasMore: false };
        },
      );

    setupApi({ getConversationEvents: getEvents });

    const { result } = renderHook(() => useConversationEvents("conv-1"));

    // Initial load settles
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.items.map((i) => i.seq)).toEqual([10]);

    // Trigger loadMore (older page) - this blocks on olderPromise
    act(() => {
      void result.current.loadMore();
    });

    // Verify older request started
    expect(getEvents).toHaveBeenCalledWith(
      "conv-1",
      expect.objectContaining({ direction: "before" }),
      expect.anything(),
    );

    // While older read is STILL pending, a new SSE arrival comes in with seq = 11
    await act(async () => {
      notifyConversationChange({
        event: "conversation_changed",
        conversationId: "conv-1",
        seq: 11,
        bindingEpoch: 1,
      });
      await Promise.resolve();
    });

    // The new tail row (seq 11) must be visible immediately WITHOUT olderPromise being resolved!
    expect(result.current.items.map((i) => i.seq)).toContain(11);

    // Now resolve older page and check both are present
    await act(async () => {
      resolveOlderPage(null);
      await Promise.resolve();
    });
    expect(result.current.items.map((i) => i.seq)).toEqual([5, 10, 11]);
  });

  it("held range revalidation does not block latest SSE tail: tail visible immediately", async () => {
    let resolveRangeRevalidate!: (value: unknown) => void;
    const rangePromise = new Promise((res) => {
      resolveRangeRevalidate = res;
    });

    let initialDone = false;
    const getEvents = vi
      .fn()
      .mockImplementation(
        async (
          _id: string,
          params: Exclude<Parameters<SuperstringApi["getConversationEvents"]>[1], number>,
        ) => {
          if (!initialDone) {
            initialDone = true;
            return {
              items: [sampleEvent(1), sampleEvent(2)],
              nextSeq: 3,
              hasMore: false,
            };
          }
          if (
            params?.direction === "after" &&
            (params?.afterSeq === 0 || params?.afterSeq === -1)
          ) {
            // Range revalidation
            await rangePromise;
            return {
              items: [sampleEvent(1, "msg-1-updated"), sampleEvent(2, "msg-2-updated")],
              nextSeq: 3,
              hasMore: false,
            };
          }
          if (params?.direction === "after" && (params.afterSeq ?? 0) >= 2) {
            // Tail append
            return {
              items: [sampleEvent(3, "msg-3")],
              nextSeq: 4,
              hasMore: false,
            };
          }
          return { items: [], nextSeq: 0, hasMore: false };
        },
      );

    setupApi({ getConversationEvents: getEvents });

    const { result } = renderHook(() => useConversationEvents("conv-1"));

    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.items.map((i) => i.seq)).toEqual([1, 2]);

    // Trigger explicit refresh (range revalidation) - held
    act(() => {
      void result.current.refresh();
    });

    // New SSE arrives with seq = 3
    await act(async () => {
      notifyConversationChange({
        event: "conversation_changed",
        conversationId: "conv-1",
        seq: 3,
        bindingEpoch: 1,
      });
      await Promise.resolve();
    });

    // Tail msg-3 must be visible while range revalidation is still held!
    expect(result.current.items.map((i) => i.seq)).toContain(3);

    // Now resolve range revalidation
    await act(async () => {
      resolveRangeRevalidate(null);
      await Promise.resolve();
    });

    // Fresh tail row (seq 3) must NOT be erased by late range revalidation!
    expect(result.current.items.map((i) => i.seq)).toEqual([1, 2, 3]);
    expect(result.current.items.find((i) => i.seq === 1)?.text).toBe("msg-1-updated");
  });

  it("burst pages in tail append publish page 1 before waiting for page 2", async () => {
    let resolvePage2!: (value: unknown) => void;
    const page2Promise = new Promise((res) => {
      resolvePage2 = res;
    });

    let initialDone = false;
    const getEvents = vi
      .fn()
      .mockImplementation(
        async (
          _id: string,
          params: Exclude<Parameters<SuperstringApi["getConversationEvents"]>[1], number>,
        ) => {
          if (!initialDone) {
            initialDone = true;
            return {
              items: [sampleEvent(1)],
              nextSeq: 2,
              hasMore: false,
            };
          }
          // Range revalidation for seq <= 1
          if (
            params?.direction === "after" &&
            (params?.afterSeq === 0 || params?.afterSeq === -1)
          ) {
            return {
              items: [sampleEvent(1), sampleEvent(2)],
              nextSeq: 2,
              hasMore: true,
            };
          }
          // Tail append for afterSeq === 1
          if (params?.direction === "after" && params?.afterSeq === 1) {
            return {
              items: [sampleEvent(2)],
              nextSeq: 2,
              hasMore: true,
            };
          }
          // Page 2 of after
          if (params?.direction === "after" && params?.afterSeq === 2) {
            await page2Promise;
            return {
              items: [sampleEvent(3)],
              nextSeq: 3,
              hasMore: false,
            };
          }
          return { items: [], nextSeq: 0, hasMore: false };
        },
      );

    setupApi({ getConversationEvents: getEvents });

    const { result } = renderHook(() => useConversationEvents("conv-1"));

    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.items.map((i) => i.seq)).toEqual([1]);

    // SSE notification seq = 3 triggers tail append
    await act(async () => {
      notifyConversationChange({
        event: "conversation_changed",
        conversationId: "conv-1",
        seq: 3,
        bindingEpoch: 1,
      });
      await Promise.resolve();
    });

    // Page 1 (seq 2) must be published immediately BEFORE page 2 resolves!
    // In old hook, while(more) blocks on page2Promise before updating items, so items is [1].
    // In new hook, page 1 is published immediately so items is [1, 2].
    expect(result.current.items.map((i) => i.seq)).toEqual([1, 2]);

    // Resolve page 2
    await act(async () => {
      resolvePage2(null);
      await Promise.resolve();
    });
    expect(result.current.items.map((i) => i.seq)).toEqual([1, 2, 3]);
  });

  it("revalidates same-sequence expiry while retaining messages appended during a slow range read", async () => {
    let release!: (page: Awaited<ReturnType<SuperstringApi["getConversationEvents"]>>) => void;
    const delayed = new Promise<Awaited<ReturnType<SuperstringApi["getConversationEvents"]>>>(
      (resolve) => {
        release = resolve;
      },
    );
    const read = vi
      .fn<SuperstringApi["getConversationEvents"]>()
      .mockResolvedValueOnce({ items: [sampleEvent(1)], nextSeq: 1, hasMore: false })
      .mockReturnValueOnce(delayed)
      .mockResolvedValueOnce({ items: [sampleEvent(2)], nextSeq: 2, hasMore: false });
    setupApi({ getConversationEvents: read });
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
    expect(result.current.items.map((item) => item.seq)).toEqual([1, 2]);
    await act(async () => {
      release({
        items: [{ ...sampleEvent(1), text: null, contentState: "expired" }],
        nextSeq: 1,
        hasMore: false,
      });
    });
    expect(result.current.items.map((item) => [item.seq, item.text])).toEqual([
      [1, null],
      [2, "msg-2"],
    ]);
  });

  it("a failed tail read clears protected history and cancels the older read that could restore it", async () => {
    let release!: (page: Awaited<ReturnType<SuperstringApi["getConversationEvents"]>>) => void;
    const delayed = new Promise<Awaited<ReturnType<SuperstringApi["getConversationEvents"]>>>(
      (resolve) => {
        release = resolve;
      },
    );
    const read = vi
      .fn<SuperstringApi["getConversationEvents"]>()
      .mockResolvedValueOnce({ items: [sampleEvent(10)], nextSeq: 10, hasMore: true })
      .mockReturnValueOnce(delayed)
      .mockRejectedValueOnce(new Error("access removed"));
    setupApi({ getConversationEvents: read });
    const { result } = renderHook(() => useConversationEvents("conv-1"));
    await act(async () => {});
    act(() => {
      void result.current.loadMore();
    });
    await act(async () => {
      notifyConversationChange({
        event: "conversation_changed",
        conversationId: "conv-1",
        seq: 11,
        bindingEpoch: 1,
      });
    });
    expect(result.current.items[0]?.text).toBeNull();
    expect(read.mock.calls[1]?.[2]?.aborted).toBe(true);
    await act(async () => {
      release({ items: [sampleEvent(5)], nextSeq: 5, hasMore: false });
    });
    expect(result.current.items.map((item) => item.seq)).toEqual([10]);
    expect(result.current.items[0]?.text).toBeNull();
  });

  it("does not request a negative sequence when an authoritative empty history is revalidated", async () => {
    const read = vi
      .fn<SuperstringApi["getConversationEvents"]>()
      .mockResolvedValue({ items: [], nextSeq: 0, hasMore: false });
    setupApi({ getConversationEvents: read });
    const { result } = renderHook(() => useConversationEvents("conv-1"));
    await act(async () => {});
    await act(async () => {
      await result.current.refresh();
    });
    expect(read.mock.calls[1]?.[1]).toMatchObject({ afterSeq: 0 });
    expect(result.current.error).toBe("");
  });

  it("revalidates the captured range while a growing history tail loads independently", async () => {
    const known = Array.from({ length: 100 }, (_, index) => sampleEvent(index + 1));
    let resolveRange!: (
      value: Awaited<ReturnType<SuperstringApi["getConversationEvents"]>>,
    ) => void;
    const rangeResult = new Promise<Awaited<ReturnType<SuperstringApi["getConversationEvents"]>>>(
      (resolve) => {
        resolveRange = resolve;
      },
    );
    let tailReadDone = false;
    let resolveFollowing!: (
      value: Awaited<ReturnType<SuperstringApi["getConversationEvents"]>>,
    ) => void;
    const followingResult = new Promise<
      Awaited<ReturnType<SuperstringApi["getConversationEvents"]>>
    >((resolve) => {
      resolveFollowing = resolve;
    });
    let rangeFollowups = 0;
    const read = vi
      .fn<SuperstringApi["getConversationEvents"]>()
      .mockImplementation(async (_id, params) => {
        if (typeof params === "number" || params === undefined)
          return { items: [], nextSeq: 0, hasMore: false };
        if (params.direction === "latest") {
          return { items: known, nextSeq: 100, hasMore: true };
        }
        if (params?.direction === "after" && params.afterSeq === 0 && params.limit !== undefined) {
          return rangeResult;
        }
        if (params?.direction === "after" && params.afterSeq === 100 && !tailReadDone) {
          tailReadDone = true;
          return { items: [sampleEvent(101)], nextSeq: 101, hasMore: false };
        }
        if (params?.direction === "after" && params.afterSeq === 100) {
          rangeFollowups += 1;
          return followingResult;
        }
        if (params?.direction === "after" && params.afterSeq === 200) {
          rangeFollowups += 1;
          return {
            items: Array.from({ length: 50 }, (_, index) => sampleEvent(201 + index)),
            nextSeq: 250,
            hasMore: false,
          };
        }
        return { items: [], nextSeq: 0, hasMore: false };
      });
    setupApi({ getConversationEvents: read });

    const { result } = renderHook(() => useConversationEvents("conv-1"));
    await act(async () => {});
    expect(result.current.items).toHaveLength(100);

    let refresh!: Promise<void>;
    act(() => {
      refresh = result.current.refresh();
    });
    expect(result.current.loading).toBe(true);

    await act(async () => {
      notifyConversationChange({
        event: "conversation_changed",
        conversationId: "conv-1",
        seq: 101,
        bindingEpoch: 1,
      });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.items.at(-1)?.seq).toBe(101);

    try {
      await act(async () => {
        resolveRange({
          items: known.map((row) => ({ ...row, text: `updated-${row.seq}` })),
          nextSeq: 100,
          hasMore: true,
        });
        await Promise.resolve();
        await Promise.resolve();
      });
      // The captured range ends at 100. A later tail page must not hold its result or spinner.
      expect(result.current.items[0]?.text).toBe("updated-1");
      expect(result.current.loading).toBe(false);
      expect(result.current.items.at(-1)?.seq).toBe(101);
      expect(rangeFollowups).toBe(0);
    } finally {
      await act(async () => {
        resolveFollowing({ items: [sampleEvent(102)], nextSeq: 102, hasMore: false });
        await refresh;
      });
    }
  });

  it("revalidates sparse multi-page history only through its captured upper bound", async () => {
    const known = [sampleEvent(1), sampleEvent(50), sampleEvent(100)];
    let resolveRange!: (
      value: Awaited<ReturnType<SuperstringApi["getConversationEvents"]>>,
    ) => void;
    const rangeResult = new Promise<Awaited<ReturnType<SuperstringApi["getConversationEvents"]>>>(
      (resolve) => {
        resolveRange = resolve;
      },
    );
    let tailReadDone = false;
    let rangeFollowups = 0;
    const read = vi
      .fn<SuperstringApi["getConversationEvents"]>()
      .mockImplementation(async (_id, params) => {
        if (typeof params === "number" || params === undefined)
          return { items: [], nextSeq: 0, hasMore: false };
        if (params.direction === "latest") {
          return { items: known, nextSeq: 100, hasMore: true };
        }
        if (params?.direction === "after" && params.afterSeq === 0 && params.limit !== undefined) {
          return rangeResult;
        }
        if (params?.direction === "after" && params.afterSeq === 50 && params.limit === undefined) {
          rangeFollowups += 1;
          return {
            items: [sampleEvent(100, "updated-100"), sampleEvent(101, "range-tail")],
            nextSeq: 101,
            hasMore: false,
          };
        }
        if (params?.direction === "after" && params.afterSeq === 100 && !tailReadDone) {
          tailReadDone = true;
          return { items: [sampleEvent(101, "live-tail")], nextSeq: 101, hasMore: false };
        }
        return { items: [], nextSeq: params?.afterSeq ?? 0, hasMore: false };
      });
    setupApi({ getConversationEvents: read });

    const { result } = renderHook(() => useConversationEvents("conv-1"));
    await act(async () => {});
    expect(result.current.items.map((item) => item.seq)).toEqual([1, 50, 100]);

    act(() => {
      void result.current.refresh();
    });
    await act(async () => {
      notifyConversationChange({
        event: "conversation_changed",
        conversationId: "conv-1",
        seq: 101,
        bindingEpoch: 1,
      });
    });
    expect(result.current.items.at(-1)?.text).toBe("live-tail");

    await act(async () => {
      resolveRange({
        items: [sampleEvent(1, "updated-1"), sampleEvent(50, "updated-50")],
        nextSeq: 50,
        hasMore: true,
      });
    });

    expect(result.current.items.map((item) => item.seq)).toEqual([1, 50, 100, 101]);
    expect(result.current.items.map((item) => item.text)).toEqual([
      "updated-1",
      "updated-50",
      "updated-100",
      "live-tail",
    ]);
    expect(result.current.loading).toBe(false);
    expect(rangeFollowups).toBe(1);
    expect(
      read.mock.calls
        .filter(
          ([, params]) =>
            params !== undefined &&
            typeof params !== "number" &&
            params.direction === "after" &&
            params.limit === undefined,
        )
        .map(([, params]) => (params && typeof params !== "number" ? params.afterSeq : undefined)),
    ).toEqual([50]);
  });

  it("publishes a new tail row already returned by range refresh without another read", async () => {
    const read = vi
      .fn<SuperstringApi["getConversationEvents"]>()
      .mockResolvedValueOnce({
        items: [sampleEvent(1), sampleEvent(2)],
        nextSeq: 2,
        hasMore: false,
      })
      .mockResolvedValueOnce({
        items: [sampleEvent(1, "updated-1"), sampleEvent(3, "refresh-tail")],
        nextSeq: 3,
        hasMore: false,
      });
    setupApi({ getConversationEvents: read });
    const { result } = renderHook(() => useConversationEvents("conv-1"));
    await act(async () => {});
    expect(result.current.items.map((item) => item.seq)).toEqual([1, 2]);

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.items.map((item) => [item.seq, item.text])).toEqual([
      [1, "updated-1"],
      [3, "refresh-tail"],
    ]);
    expect(result.current.loading).toBe(false);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("idle 30s issues no reads; a notify still tails immediately afterwards", async () => {
    vi.useFakeTimers();
    let tailReads = 0;
    const read = vi
      .fn<SuperstringApi["getConversationEvents"]>()
      .mockImplementation(async (_id, params) => {
        if (typeof params === "number" || params === undefined)
          return { items: [], nextSeq: 0, hasMore: false };
        if (params.direction === "latest") {
          return { items: [sampleEvent(1), sampleEvent(2)], nextSeq: 3, hasMore: false };
        }
        if (params.direction === "after" && params.afterSeq === 2) {
          tailReads += 1;
          return { items: [sampleEvent(3, "live-3")], nextSeq: 3, hasMore: false };
        }
        return { items: [], nextSeq: 0, hasMore: false };
      });
    setupApi({ getConversationEvents: read });

    const { result } = renderHook(() => useConversationEvents("conv-1"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.items.map((i) => i.seq)).toEqual([1, 2]);

    // 30 idle seconds: zero reads without any notification.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000);
    });
    expect(read).toHaveBeenCalledTimes(1);

    // A notify still tails immediately.
    await act(async () => {
      notifyConversationChange({
        event: "conversation_changed",
        conversationId: "conv-1",
        seq: 3,
        bindingEpoch: 1,
      });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(tailReads).toBe(1);
    expect(result.current.items.map((i) => i.seq)).toEqual([1, 2, 3]);
  });

  it("manual refresh aborts pending transport; late old resolution does not clear in-flight loading or corrupt state", async () => {
    let oldSignal: AbortSignal | undefined;
    let resolveOld!: (value: unknown) => void;
    const oldPromise = new Promise((res) => {
      resolveOld = res;
    });

    let newSignal: AbortSignal | undefined;
    let resolveFresh!: (value: unknown) => void;
    const freshPromise = new Promise((res) => {
      resolveFresh = res;
    });

    let readCount = 0;
    const getEvents = vi
      .fn()
      .mockImplementation(
        async (
          _id: string,
          params: Exclude<Parameters<SuperstringApi["getConversationEvents"]>[1], number>,
          signal?: AbortSignal,
        ) => {
          if (params?.direction === "latest") {
            return {
              items: [sampleEvent(1), sampleEvent(2)],
              nextSeq: 3,
              hasMore: false,
            };
          }
          if (params?.direction === "after") {
            readCount++;
            if (readCount === 1) {
              oldSignal = signal;
              await oldPromise;
              return {
                items: [sampleEvent(1, "old-late")],
                nextSeq: 3,
                hasMore: false,
              };
            }
            if (readCount === 2) {
              newSignal = signal;
              await freshPromise;
              return {
                items: [sampleEvent(1, "manual-fresh"), sampleEvent(2, "msg-2")],
                nextSeq: 3,
                hasMore: false,
              };
            }
          }
          return { items: [], nextSeq: 0, hasMore: false };
        },
      );

    setupApi({ getConversationEvents: getEvents });
    const { result } = renderHook(() => useConversationEvents("conv-1"));
    await act(async () => {});
    expect(result.current.items.map((i) => i.seq)).toEqual([1, 2]);

    // Initial background or range load starts and hangs on oldPromise
    act(() => {
      void result.current.refresh();
    });
    expect(readCount).toBe(1);
    expect(oldSignal).toBeDefined();
    expect(oldSignal?.aborted).toBe(false);

    // While old read is hanging, user explicitly triggers manual refresh
    act(() => {
      void result.current.refresh();
    });

    // The old readonly transport MUST be explicitly aborted!
    expect(oldSignal?.aborted).toBe(true);
    // Fresh read MUST have started immediately (replacement)
    expect(readCount).toBe(2);
    expect(newSignal).toBeDefined();
    expect(newSignal?.aborted).toBe(false);
    expect(result.current.loading).toBe(true);

    // Now, while fresh read is STILL in-flight, let the old late read resolve!
    await act(async () => {
      resolveOld(null);
      await Promise.resolve();
    });

    // The late resolution of old read must NOT clear the new read's loading state!
    expect(result.current.loading).toBe(true);
    // And it must NOT overwrite the timeline with old late data
    expect(result.current.items.find((i) => i.seq === 1)?.text).not.toBe("old-late");

    // Finally, resolve the fresh read
    await act(async () => {
      resolveFresh(null);
      await Promise.resolve();
    });

    // Fresh read completes cleanly: loading is false, items are from fresh read
    expect(result.current.loading).toBe(false);
    expect(result.current.items.find((i) => i.seq === 1)?.text).toBe("manual-fresh");
  });

  it("empty stale tail snapshot does not defer a newer notification to the 5s poll", async () => {
    vi.useFakeTimers();
    let resolveTail!: (value: Awaited<ReturnType<SuperstringApi["getConversationEvents"]>>) => void;
    const staleTail = new Promise<Awaited<ReturnType<SuperstringApi["getConversationEvents"]>>>(
      (resolve) => {
        resolveTail = resolve;
      },
    );
    let tailReads = 0;
    const read = vi
      .fn<SuperstringApi["getConversationEvents"]>()
      .mockImplementation(async (_id, params) => {
        if (typeof params === "number" || params === undefined)
          return { items: [], nextSeq: 0, hasMore: false };
        if (params.direction === "latest") {
          return { items: [sampleEvent(1)], nextSeq: 2, hasMore: false };
        }
        if (params.direction === "after" && params.afterSeq === 1) {
          tailReads += 1;
          if (tailReads === 1) return staleTail;
          return { items: [sampleEvent(2), sampleEvent(3)], nextSeq: 3, hasMore: false };
        }
        return { items: [], nextSeq: 0, hasMore: false };
      });
    setupApi({ getConversationEvents: read });

    const { result } = renderHook(() => useConversationEvents("conv-1"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.items.map((i) => i.seq)).toEqual([1]);

    // seq 2 starts tail request A, which stays in flight.
    await act(async () => {
      notifyConversationChange({
        event: "conversation_changed",
        conversationId: "conv-1",
        seq: 2,
        bindingEpoch: 1,
      });
      await Promise.resolve();
    });
    expect(tailReads).toBe(1);

    // seq 3 arrives while A is in flight: the second notification must not start its own read.
    await act(async () => {
      notifyConversationChange({
        event: "conversation_changed",
        conversationId: "conv-1",
        seq: 3,
        bindingEpoch: 1,
      });
      await Promise.resolve();
    });
    expect(tailReads).toBe(1);

    // A settles with a stale empty snapshot that ends before seq 2; server nextSeq stays 0.
    await act(async () => {
      resolveTail({ items: [], nextSeq: 0, hasMore: false });
      await vi.advanceTimersByTimeAsync(0);
    });

    // One follow-up read must pick up the deferred seq 3 without any poll advance,
    // and it must resume from the last visible seq, never afterSeq 0.
    expect(tailReads).toBe(2);
    expect(read.mock.calls[1]?.[1]).toMatchObject({ direction: "after", afterSeq: 1 });
    expect(result.current.items.map((i) => i.seq)).toEqual([1, 2, 3]);
  });

  it("ghost tail sequence stays bounded: one extra empty read then stop, no poll advance", async () => {
    vi.useFakeTimers();
    let resolveTail!: (value: Awaited<ReturnType<SuperstringApi["getConversationEvents"]>>) => void;
    const staleTail = new Promise<Awaited<ReturnType<SuperstringApi["getConversationEvents"]>>>(
      (resolve) => {
        resolveTail = resolve;
      },
    );
    let tailReads = 0;
    const read = vi
      .fn<SuperstringApi["getConversationEvents"]>()
      .mockImplementation(async (_id, params) => {
        if (typeof params === "number" || params === undefined)
          return { items: [], nextSeq: 0, hasMore: false };
        if (params.direction === "latest") {
          return { items: [sampleEvent(1)], nextSeq: 2, hasMore: false };
        }
        if (params.direction === "after" && params.afterSeq === 1) {
          tailReads += 1;
          if (tailReads === 1) return staleTail;
          // Ghost notification: seq 2/3 never materialize as rows; server nextSeq stays 0.
          return { items: [], nextSeq: 0, hasMore: false };
        }
        return { items: [], nextSeq: 0, hasMore: false };
      });
    setupApi({ getConversationEvents: read });

    const { result } = renderHook(() => useConversationEvents("conv-1"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.items.map((i) => i.seq)).toEqual([1]);

    await act(async () => {
      notifyConversationChange({
        event: "conversation_changed",
        conversationId: "conv-1",
        seq: 2,
        bindingEpoch: 1,
      });
      await Promise.resolve();
    });
    await act(async () => {
      notifyConversationChange({
        event: "conversation_changed",
        conversationId: "conv-1",
        seq: 3,
        bindingEpoch: 1,
      });
      await Promise.resolve();
    });
    expect(tailReads).toBe(1);

    await act(async () => {
      resolveTail({ items: [], nextSeq: 0, hasMore: false });
      await vi.advanceTimersByTimeAsync(0);
    });

    // Exactly one extra read for the deferred notification; the second empty read stops.
    expect(tailReads).toBe(2);
    expect(read.mock.calls[1]?.[1]).toMatchObject({ direction: "after", afterSeq: 1 });
    expect(result.current.items.map((i) => i.seq)).toEqual([1]);
  });

  it("expires a loaded source locally without a network read or changing a live row", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-22T00:00:00Z"));
    const expiring = {
      ...sampleEvent(1),
      sources: [
        {
          kind: "qq_observation",
          id: "body-1",
          revision: "1",
          expiresAt: new Date(Date.now() + 1000).toISOString(),
        },
      ],
    };
    const live = sampleEvent(2);
    const read = vi
      .fn<SuperstringApi["getConversationEvents"]>()
      .mockResolvedValue({ items: [expiring, live], nextSeq: 2, hasMore: false });
    setupApi({ getConversationEvents: read });
    const { result } = renderHook(() => useConversationEvents("conv-1"));
    await act(async () => {});
    const liveRow = result.current.items[1];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(read).toHaveBeenCalledTimes(1);
    expect(result.current.items[0]).toMatchObject({
      text: null,
      contentState: "expired",
      qqMessageFacts: [],
    });
    expect(result.current.items[1]).toBe(liveRow);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000);
    });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("arms cached source expiry while the initial authoritative read is pending", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-22T00:00:00Z"));
    const cached = {
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
      .mockReturnValue(new Promise(() => {}));
    setupApi({ getConversationEvents: read });
    useSuperstringStore.setState({
      summaryById: { "conv-1": { id: "conv-1", agentId: "agent-1", bindingEpoch: 1 } as never },
      sessionStateStorage: {
        read: vi.fn(async () =>
          JSON.stringify({
            conversationId: "conv-1",
            agentId: "agent-1",
            bindingEpoch: 1,
            items: [cached],
            cachedAt: Date.now(),
          }),
        ),
        write: vi.fn(async () => {}),
        remove: vi.fn(async () => {}),
      },
    });
    const { result } = renderHook(() => useConversationEvents("conv-1"));
    await act(async () => {});
    expect(result.current.items[0]?.text).toBe("msg-1");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(result.current.items[0]).toMatchObject({ text: null, contentState: "expired" });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("keeps long source retention as one bounded deadline and cancels it on unmount", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-22T00:00:00Z"));
    const row = {
      ...sampleEvent(1),
      source: {
        kind: "qq_event",
        id: "event-1",
        revision: "1",
        expiresAt: new Date(Date.now() + 3_000_000_000).toISOString(),
      },
    };
    const read = vi
      .fn<SuperstringApi["getConversationEvents"]>()
      .mockResolvedValue({ items: [row], nextSeq: 1, hasMore: false });
    setupApi({ getConversationEvents: read });
    const { result, unmount } = renderHook(() => useConversationEvents("conv-1"));
    await act(async () => {});
    expect(vi.getTimerCount()).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_147_483_647);
    });
    expect(result.current.items[0]?.text).toBe("msg-1");
    expect(read).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
