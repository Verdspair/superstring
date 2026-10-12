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

describe("conversation-initial-error-retry: initial latest failure retries latest", () => {
  it("initial latest load rejection sets error; manual refresh must retry with latest, receiving 901..1000 and subsequent SSE tail", async () => {
    let initialCallCount = 0;
    const initialBatch = Array.from({ length: 100 }, (_, i) =>
      sampleEvent(901 + i, `msg-${901 + i}`),
    );

    const getEvents = vi
      .fn()
      .mockImplementation(
        async (
          _id: string,
          params: Exclude<Parameters<SuperstringApi["getConversationEvents"]>[1], number>,
        ) => {
          if (params?.direction === "latest") {
            initialCallCount++;
            if (initialCallCount === 1) {
              throw new Error("Network timeout during startup");
            }
            return {
              items: initialBatch,
              nextSeq: 1001,
              hasMore: true,
            };
          }
          if (params?.direction === "after" && params?.afterSeq === 1000) {
            return {
              items: [sampleEvent(1001, "msg-1001-tail")],
              nextSeq: 1002,
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

    // Initial latest load attempts and rejects
    await act(async () => {
      await Promise.resolve();
    });

    expect(initialCallCount).toBe(1);
    expect(result.current.items).toEqual([]);
    expect(result.current.error).toBe("Network timeout during startup");
    expect(result.current.loading).toBe(false);

    // Manual refresh on error must retry with direction: "latest", NOT afterSeq: 0!
    await act(async () => {
      await result.current.refresh();
    });

    // The second call must have requested direction: "latest"
    const calls = getEvents.mock.calls;
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[0][1]).toEqual({ direction: "latest" });
    expect(calls[1][1]).toEqual({ direction: "latest" });

    // Verify 901..1000 items are loaded and error is cleared
    expect(result.current.error).toBe("");
    expect(result.current.items.length).toBe(100);
    expect(result.current.items[0].seq).toBe(901);
    expect(result.current.items.at(-1)?.seq).toBe(1000);

    // Now an SSE notification arrives for new seq = 1001
    await act(async () => {
      notifyConversationChange({
        event: "conversation_changed",
        conversationId: "conv-1",
        seq: 1001,
        bindingEpoch: 1,
      });
      await Promise.resolve();
    });

    // Verify SSE tail append
    expect(result.current.items.length).toBe(101);
    expect(result.current.items.at(-1)?.seq).toBe(1001);
    expect(result.current.items.at(-1)?.text).toBe("msg-1001-tail");
  });
});
