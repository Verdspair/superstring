import { act, cleanup, fireEvent, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ConversationEventView,
  ConversationSummary,
} from "../../src/shared/contracts/conversation";
import { api, type ConversationChangeEvent, type SuperstringApi } from "../../src/web/api";
import { useConversationEvents } from "../../src/web/features/conversations/use-conversation-events";
import {
  notifyConversationChange,
  resetConversationChangesForTests,
  startConversationChanges,
} from "../../src/web/services/conversation-changes";
import { useSuperstringStore } from "../../src/web/store";
import { summaryFixture } from "./helpers/chat-fixture";

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

type Visibility = "visible" | "hidden";

const setVisibility = (value: Visibility) => {
  Object.defineProperty(document, "visibilityState", { configurable: true, value });
  fireEvent(document, new Event("visibilitychange"));
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
  occurredAt: "2026-10-05T00:00:00Z",
  recordedAt: "2026-10-05T00:00:00Z",
});

function setupApi(overrides: Partial<SuperstringApi>) {
  useSuperstringStore.getState().resetForTests({
    ...api,
    ...overrides,
  });
}

describe("conversation arrival instant update", () => {
  it("triggers authoritative timeline read immediately on conversation_changed event well before 5s poll", async () => {
    vi.useFakeTimers();
    let seq = 1;
    const getEvents = vi.fn().mockImplementation(async () => ({
      items: [sampleEvent(seq++)],
      nextSeq: seq,
      hasMore: false,
    }));

    setupApi({ getConversationEvents: getEvents });

    const { result } = renderHook(() =>
      useConversationEvents("conv-1", undefined, { refreshMs: 5000 }),
    );

    // Initial mount load
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(getEvents).toHaveBeenCalledTimes(1);

    // Advance 500ms (far before 5000ms poll)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(getEvents).toHaveBeenCalledTimes(1);

    // Incoming notification for conv-1 arrives at 500ms
    await act(async () => {
      notifyConversationChange({
        event: "conversation_changed",
        conversationId: "conv-1",
        seq: 2,
        bindingEpoch: 1,
      });
      await vi.advanceTimersByTimeAsync(10);
    });

    // Immediately read before 5s!
    expect(getEvents).toHaveBeenCalledTimes(2);
    expect(result.current.items.length).toBe(1);

    // Advance the remaining time to 5000ms to verify fallback poll still functions
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4500);
    });
    expect(getEvents).toHaveBeenCalledTimes(3);
  });

  it("directory directional update fetches GET /v2/conversations/:id summary without calling listConversations discover for each change", async () => {
    const listSpy = vi.fn().mockResolvedValue({ items: [], nextCursor: null });
    const convSummary: ConversationSummary = {
      ...summaryFixture("qq-source-1"),
      id: "conv-target",
      channel: "onebot11",
      title: "新QQ消息会话",
      lastSeq: 5,
    };
    const getConversationSpy = vi.fn().mockResolvedValue(convSummary);

    setupApi({
      listConversations: listSpy,
      getConversation: getConversationSpy,
    });

    let sseCallback: ((event: ConversationChangeEvent) => void) | null = null;
    const subscribeSpy = vi.fn().mockImplementation(async (onEvent) => {
      sseCallback = onEvent;
    });
    setupApi({
      listConversations: listSpy,
      getConversation: getConversationSpy,
      subscribeConversationChanges: subscribeSpy,
    });

    // Start shared subscriber
    const cleanupChanges = startConversationChanges(useSuperstringStore.getState().apiClient);

    expect(subscribeSpy).toHaveBeenCalledTimes(1);
    expect(sseCallback).toBeTruthy();

    // Fire ready first
    await act(async () => {
      sseCallback!({ event: "ready", ready: true });
    });

    // List discover is NOT invoked on initial ready since already loaded
    expect(listSpy).toHaveBeenCalledTimes(0);

    // Fire conversation_changed for conv-target
    await act(async () => {
      sseCallback!({
        event: "conversation_changed",
        conversationId: "conv-target",
        seq: 5,
        bindingEpoch: 1,
      });
    });

    // Bounded summary fetch was called for conv-target
    expect(getConversationSpy).toHaveBeenCalledWith("conv-target");
    // Crucial: listConversations was NOT called for this item arrival!
    expect(listSpy).toHaveBeenCalledTimes(0);

    // Directory state has the updated summary and ordered ID
    const storeState = useSuperstringStore.getState();
    expect(storeState.summaryById["conv-target"]?.title).toBe("新QQ消息会话");
    expect(storeState.directoryIds[0]).toBe("conv-target");

    cleanupChanges();
  });

  it("pending reads coalesce multiple rapid notifications into exactly one follow-up revalidation", async () => {
    let resolveFirstRead!: (val: any) => void;
    const firstReadPromise = new Promise((resolve) => {
      resolveFirstRead = resolve;
    });

    let readCallCount = 0;
    const getEvents = vi.fn().mockImplementation(() => {
      readCallCount++;
      if (readCallCount === 1) {
        return firstReadPromise;
      }
      return Promise.resolve({
        items: [sampleEvent(2)],
        nextSeq: 2,
        hasMore: false,
      });
    });

    setupApi({ getConversationEvents: getEvents });

    renderHook(() => useConversationEvents("conv-1"));

    // First read is now in-flight (pending)
    expect(getEvents).toHaveBeenCalledTimes(1);

    // Three rapid notifications arrive while first read is still pending
    await act(async () => {
      notifyConversationChange({
        event: "conversation_changed",
        conversationId: "conv-1",
        seq: 2,
        bindingEpoch: 1,
      });
      notifyConversationChange({
        event: "conversation_changed",
        conversationId: "conv-1",
        seq: 3,
        bindingEpoch: 1,
      });
      notifyConversationChange({
        event: "conversation_changed",
        conversationId: "conv-1",
        seq: 4,
        bindingEpoch: 1,
      });
    });

    // Should NOT have launched additional in-flight calls while pending
    expect(getEvents).toHaveBeenCalledTimes(1);

    // Now resolve the first read
    await act(async () => {
      resolveFirstRead({
        items: [sampleEvent(1)],
        nextSeq: 1,
        hasMore: false,
      });
      await Promise.resolve();
    });

    // Coalesced into exactly ONE subsequent revalidation call!
    expect(getEvents).toHaveBeenCalledTimes(2);
  });

  it("does not trigger network fetch when hidden or inactive; executes one authoritative read upon returning to foreground", async () => {
    const getEvents = vi.fn().mockResolvedValue({
      items: [sampleEvent(1)],
      nextSeq: 1,
      hasMore: false,
    });

    setupApi({ getConversationEvents: getEvents });

    const { rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useConversationEvents("conv-1", undefined, { enabled }),
      { initialProps: { enabled: true } },
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(getEvents).toHaveBeenCalledTimes(1);

    // 1) When inactive (enabled = false)
    rerender({ enabled: false });

    await act(async () => {
      notifyConversationChange({
        event: "conversation_changed",
        conversationId: "conv-1",
        seq: 2,
        bindingEpoch: 1,
      });
    });

    // Inactive: no network call
    expect(getEvents).toHaveBeenCalledTimes(1);

    // Re-enable
    rerender({ enabled: true });
    await act(async () => {
      await Promise.resolve();
    });
    // Immediately performs one catch-up read
    expect(getEvents).toHaveBeenCalledTimes(2);

    // 2) When document is hidden
    act(() => {
      setVisibility("hidden");
    });

    await act(async () => {
      notifyConversationChange({
        event: "conversation_changed",
        conversationId: "conv-1",
        seq: 3,
        bindingEpoch: 1,
      });
    });

    // Hidden: no network call
    expect(getEvents).toHaveBeenCalledTimes(2);

    // Return to visible
    act(() => {
      setVisibility("visible");
    });
    await act(async () => {
      await Promise.resolve();
    });

    // Exactly one revalidation read performed
    expect(getEvents).toHaveBeenCalledTimes(3);
  });

  it("reconnect ready triggers bounded directory refresh once", async () => {
    let sseCallback: ((event: ConversationChangeEvent) => void) | null = null;
    const subscribeSpy = vi.fn().mockImplementation(async (onEvent) => {
      sseCallback = onEvent;
    });
    const listSpy = vi.fn().mockResolvedValue({ items: [], nextCursor: null });

    setupApi({
      subscribeConversationChanges: subscribeSpy,
      listConversations: listSpy,
    });

    const cleanup = startConversationChanges(useSuperstringStore.getState().apiClient);

    // First ready: initial connect (already bootstrapped, skips list)
    await act(async () => {
      sseCallback!({ event: "ready", ready: true });
    });
    expect(listSpy).toHaveBeenCalledTimes(0);

    // Second ready: reconnect signal
    await act(async () => {
      sseCallback!({ event: "ready", ready: true });
    });

    // Reconnect triggers bounded directory reconciliation
    expect(listSpy).toHaveBeenCalledTimes(1);

    cleanup();
  });

  it("hidden marks conversations dirty without directory GET; foreground return flushes each dirty id once and reconnects a dropped stream", async () => {
    let sseCallback: ((event: ConversationChangeEvent) => void) | null = null;
    let endStream: (() => void) | null = null;
    const subscribeSpy = vi.fn().mockImplementation(async (onEvent) => {
      sseCallback = onEvent;
      return new Promise<void>((resolve) => {
        endStream = resolve;
      });
    });
    const listSpy = vi.fn().mockResolvedValue({ items: [], nextCursor: null });
    const getConversationSpy = vi.fn().mockResolvedValue({
      ...summaryFixture("qq-source-1"),
      id: "conv-dirty",
      channel: "onebot11",
    });

    setupApi({
      subscribeConversationChanges: subscribeSpy,
      listConversations: listSpy,
      getConversation: getConversationSpy,
    });

    const cleanup = startConversationChanges(useSuperstringStore.getState().apiClient);
    expect(subscribeSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      sseCallback!({ event: "ready", ready: true });
    });

    act(() => {
      setVisibility("hidden");
    });

    await act(async () => {
      sseCallback!({
        event: "conversation_changed",
        conversationId: "conv-dirty",
        seq: 5,
        bindingEpoch: 1,
      });
    });

    // Hidden: no directory data reads at all
    expect(getConversationSpy).toHaveBeenCalledTimes(0);
    expect(listSpy).toHaveBeenCalledTimes(0);

    // Stream drops while hidden
    await act(async () => {
      endStream!();
    });

    // Back to foreground: one directional dirty flush + dropped stream reconnects
    act(() => {
      setVisibility("visible");
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(getConversationSpy).toHaveBeenCalledTimes(1);
    expect(getConversationSpy).toHaveBeenCalledWith("conv-dirty");
    expect(subscribeSpy).toHaveBeenCalledTimes(2);
    expect(listSpy).toHaveBeenCalledTimes(0);

    cleanup();
  });
});
