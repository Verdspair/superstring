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

    const { result } = renderHook(() =>
      useConversationEvents("conv-1", undefined, { refreshMs: 60000 }),
    );

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

    const { result } = renderHook(() =>
      useConversationEvents("conv-1", undefined, { refreshMs: 60000 }),
    );

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

    const { result } = renderHook(() =>
      useConversationEvents("conv-1", undefined, { refreshMs: 60000 }),
    );

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
    const { result } = renderHook(() =>
      useConversationEvents("conv-1", undefined, { refreshMs: 60000 }),
    );
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
    const { result } = renderHook(() =>
      useConversationEvents("conv-1", undefined, { refreshMs: 60000 }),
    );
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
    const { result } = renderHook(() =>
      useConversationEvents("conv-1", undefined, { refreshMs: 60000 }),
    );
    await act(async () => {});
    await act(async () => {
      await result.current.refresh();
    });
    expect(read.mock.calls[1]?.[1]).toMatchObject({ afterSeq: 0 });
    expect(result.current.error).toBe("");
  });
});
