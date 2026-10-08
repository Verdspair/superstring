import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskDetail, TaskSummary } from "../../src/shared/contracts/agent-task";
import type {
  ConversationEventView,
  ConversationSummary,
} from "../../src/shared/contracts/conversation";
import { api, type ConversationChangeEvent, type SuperstringApi } from "../../src/web/api";
import { useConversationEvents } from "../../src/web/features/conversations/use-conversation-events";
import { useRuntimeTraces } from "../../src/web/features/observability/use-runtime-traces";
import { i18n } from "../../src/web/i18n/runtime";
import { ConversationRuntimeSummary } from "../../src/web/screens/observability/ConversationActivity";
import { RunWorkspace } from "../../src/web/screens/runs/RunEntry";
import { TaskLedger } from "../../src/web/screens/runs/task-ledger";
import {
  notifyConversationChange,
  resetConversationChangesForTests,
  startConversationChanges,
} from "../../src/web/services/conversation-changes";
import { useLiveResource } from "../../src/web/services/use-live-resource";
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

const mockTaskSummary = (
  id: string,
  conversationId = "conv-1",
  status: TaskSummary["status"] = "running",
): TaskSummary => ({
  id,
  conversationId,
  agentId: "agent-1",
  originRunId: null,
  status,
  createdAt: "2026-10-06T00:00:00.000Z",
  updatedAt: "2026-10-06T00:00:00.000Z",
  expiresAt: "2026-10-07T00:00:00.000Z",
  errorCode: null,
  callCount: 1,
  completedCallCount: 0,
  waitingOrdinal: null,
  waitingReason: null,
});

const mockTaskDetail = (
  id: string,
  conversationId = "conv-1",
  status: TaskSummary["status"] = "waiting_approval",
): TaskDetail => ({
  ...mockTaskSummary(id, conversationId, status),
  dataStatus: "available",
  calls: [
    {
      ordinal: 0,
      name: "test_call",
      revision: "1",
      effect: "read",
      status: "waiting_approval",
      approvalRevision: "rev-1",
      errorCode: null,
      argumentsPreview: {
        status: "available",
        text: "",
        offset: 0,
        total: 0,
        nextOffset: null,
      },
      resultStatus: "pending",
    },
  ],
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

    // Append the new message immediately without dropping the already loaded message.
    expect(getEvents).toHaveBeenCalledTimes(2);
    expect(result.current.items.map((item) => item.seq)).toEqual([1, 2]);

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

  it("triggers runtime traces read immediately on conversation_changed event well before 5s poll", async () => {
    const listTracesSpy = vi.fn().mockResolvedValue({
      items: [],
      summary: {
        total: 0,
        active: 0,
        failed: 0,
        unknown: 0,
        lastActivityAt: null,
        now: new Date().toISOString(),
      },
      hasMore: false,
      nextBeforeId: 0,
    });
    setupApi({ listRuntimeTraces: listTracesSpy });

    const { unmount } = renderHook(() => useRuntimeTraces({ conversationId: "conv-traces-1" }));
    expect(listTracesSpy).toHaveBeenCalledTimes(1);

    // Unrelated conversation notification does not trigger read
    await act(async () => {
      notifyConversationChange({
        event: "conversation_changed",
        conversationId: "conv-other",
        seq: 1,
        bindingEpoch: 1,
      });
    });
    expect(listTracesSpy).toHaveBeenCalledTimes(1);

    // Target conversation notification triggers instant read well before 5s
    await act(async () => {
      notifyConversationChange({
        event: "conversation_changed",
        conversationId: "conv-traces-1",
        seq: 2,
        bindingEpoch: 1,
      });
    });
    expect(listTracesSpy).toHaveBeenCalledTimes(2);

    unmount();
  });

  it("global runtime traces and tasks trigger immediate read on conversation_changed and respect hidden gate", async () => {
    const listTracesSpy = vi.fn().mockResolvedValue({
      items: [],
      summary: {
        total: 0,
        active: 0,
        failed: 0,
        unknown: 0,
        lastActivityAt: null,
        now: new Date().toISOString(),
      },
      hasMore: false,
      nextBeforeId: 0,
    });
    const listTasksSpy = vi.fn().mockResolvedValue({
      items: [],
      nextCursor: null,
    });
    setupApi({
      listRuntimeTraces: listTracesSpy,
      listTasks: listTasksSpy,
    });

    const tracesHook = renderHook(() => useRuntimeTraces({}));
    expect(listTracesSpy).toHaveBeenCalledTimes(1);

    const taskRender = render(<TaskLedger conversationId="conv-tasks-1" />);
    expect(listTasksSpy).toHaveBeenCalledTimes(1);

    // Event triggers both global traces and scoped tasks
    await act(async () => {
      notifyConversationChange({
        event: "conversation_changed",
        conversationId: "conv-tasks-1",
        seq: 1,
        bindingEpoch: 1,
      });
    });

    expect(listTracesSpy).toHaveBeenCalledTimes(2);
    expect(listTasksSpy).toHaveBeenCalledTimes(2);

    // While hidden: no network fetch
    act(() => {
      setVisibility("hidden");
    });

    await act(async () => {
      notifyConversationChange({
        event: "conversation_changed",
        conversationId: "conv-tasks-1",
        seq: 2,
        bindingEpoch: 1,
      });
    });

    expect(listTracesSpy).toHaveBeenCalledTimes(2);
    expect(listTasksSpy).toHaveBeenCalledTimes(2);

    // Returning to foreground triggers one consolidated read
    act(() => {
      setVisibility("visible");
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(listTracesSpy).toHaveBeenCalledTimes(3);
    expect(listTasksSpy).toHaveBeenCalledTimes(3);

    tracesHook.unmount();
    taskRender.unmount();
  });

  it("coalesces late events during in-flight traces read into exactly one follow-up revalidation", async () => {
    let resolveFirst!: (value: any) => void;
    const firstPromise = new Promise((resolve) => {
      resolveFirst = resolve;
    });

    const listTracesSpy = vi
      .fn()
      .mockImplementationOnce(() => firstPromise)
      .mockResolvedValue({
        items: [],
        summary: {
          total: 0,
          active: 0,
          failed: 0,
          unknown: 0,
          lastActivityAt: null,
          now: new Date().toISOString(),
        },
        hasMore: false,
        nextBeforeId: 0,
      });

    setupApi({ listRuntimeTraces: listTracesSpy });
    const { unmount } = renderHook(() => useRuntimeTraces({ conversationId: "conv-tail" }));
    expect(listTracesSpy).toHaveBeenCalledTimes(1);

    // Event arrives while read is in flight
    await act(async () => {
      notifyConversationChange({
        event: "conversation_changed",
        conversationId: "conv-tail",
        seq: 1,
        bindingEpoch: 1,
      });
    });
    // In-flight read has not finished yet, so still 1
    expect(listTracesSpy).toHaveBeenCalledTimes(1);

    // Settle the first read
    await act(async () => {
      resolveFirst({
        items: [],
        summary: {
          total: 0,
          active: 0,
          failed: 0,
          unknown: 0,
          lastActivityAt: null,
          now: new Date().toISOString(),
        },
        hasMore: false,
        nextBeforeId: 0,
      });
      await Promise.resolve();
    });

    // Exactly one follow-up revalidation was triggered
    expect(listTracesSpy).toHaveBeenCalledTimes(2);

    unmount();
  });

  it("does not load while paused and loads once resumed without a duplicate event read", async () => {
    let resolveRead!: (value: {
      items: never[];
      summary: {
        total: number;
        active: number;
        failed: number;
        unknown: number;
        lastActivityAt: null;
        now: string;
      };
      hasMore: false;
      nextBeforeId: number;
    }) => void;
    const page = {
      items: [],
      summary: {
        total: 0,
        active: 0,
        failed: 0,
        unknown: 0,
        lastActivityAt: null,
        now: new Date().toISOString(),
      },
      hasMore: false,
      nextBeforeId: 0,
    } as const;
    const listTracesSpy = vi
      .fn()
      .mockImplementation(() => new Promise((resolve) => (resolveRead = resolve)));
    setupApi({ listRuntimeTraces: listTracesSpy });

    const { rerender, unmount } = renderHook(
      ({ paused }: { paused: boolean }) =>
        useRuntimeTraces({ conversationId: "conv-paused" }, paused),
      { initialProps: { paused: true } },
    );
    expect(listTracesSpy).not.toHaveBeenCalled();

    await act(async () => {
      notifyConversationChange({
        event: "conversation_changed",
        conversationId: "conv-paused",
        seq: 1,
        bindingEpoch: 1,
      });
    });
    expect(listTracesSpy).not.toHaveBeenCalled();

    rerender({ paused: false });
    expect(listTracesSpy).toHaveBeenCalledTimes(1);
    await act(async () => {
      notifyConversationChange({
        event: "conversation_changed",
        conversationId: "conv-paused",
        seq: 2,
        bindingEpoch: 1,
      });
      expect(listTracesSpy).toHaveBeenCalledTimes(1);
      resolveRead({ ...page, items: [...page.items] });
      await Promise.resolve();
    });
    // The event during the read is coalesced into one trailing authoritative read.
    expect(listTracesSpy).toHaveBeenCalledTimes(2);

    unmount();
  });

  it("task ledger applied conversation scope ignores events from unrelated conversations", async () => {
    const listTasksSpy = vi.fn().mockResolvedValue({
      items: [mockTaskSummary("t1", "conv-c1")],
      nextCursor: null,
    });
    setupApi({ listTasks: listTasksSpy });

    const view = render(<TaskLedger conversationId="conv-c1" />);
    expect(listTasksSpy).toHaveBeenCalledTimes(1);

    // Event from unrelated conversation does not trigger read
    await act(async () => {
      notifyConversationChange({
        event: "conversation_changed",
        conversationId: "conv-c2",
        seq: 1,
        bindingEpoch: 1,
      });
    });
    expect(listTasksSpy).toHaveBeenCalledTimes(1);

    // Event from applied conversation triggers instant read
    await act(async () => {
      notifyConversationChange({
        event: "conversation_changed",
        conversationId: "conv-c1",
        seq: 2,
        bindingEpoch: 1,
      });
    });
    expect(listTasksSpy).toHaveBeenCalledTimes(2);

    view.unmount();
  });

  it("task ledger background event reload authoritatively re-reads the loaded range", async () => {
    // Page chain served by cursor: page1 (t1) → page2 (t2); the authoritative state
    // (t1 completed) is returned for any background refresh request.
    const pageOne = () => ({
      items: [mockTaskSummary("t1", "conv-paged", "running")],
      nextCursor: "cursor-page-2",
      hasMore: true,
    });
    const pageTwo = () => ({
      items: [mockTaskSummary("t2", "conv-paged", "running")],
      nextCursor: null,
      hasMore: false,
    });
    const authoritative = () => ({
      items: [
        mockTaskSummary("t1", "conv-paged", "completed"),
        mockTaskSummary("t2", "conv-paged", "running"),
      ],
      nextCursor: null,
      hasMore: false,
    });
    let backgroundReads = 0;
    const listTasksSpy = vi.fn((filters: { cursor?: string }) => {
      if (filters.cursor === "cursor-page-2") return Promise.resolve(pageTwo());
      if (filters.cursor === undefined) {
        // First uncursored request is the initial clear load; later ones are background
        // refreshes that re-read the loaded range and get the authoritative page.
        if (backgroundReads === 0) {
          backgroundReads += 1;
          return Promise.resolve(pageOne());
        }
        return Promise.resolve(authoritative());
      }
      return Promise.resolve(pageOne());
    });

    setupApi({ listTasks: listTasksSpy as unknown as SuperstringApi["listTasks"] });
    const view = render(<TaskLedger conversationId="conv-paged" />);
    expect(listTasksSpy).toHaveBeenCalledTimes(1);
    expect(
      await screen.findAllByRole("button", { name: i18n.t("connections.tasks.open") }),
    ).toHaveLength(1);

    // Click load more to fetch the second page
    const loadMoreButton = screen.getByRole("button", {
      name: i18n.t("connections.tasks.loadMore"),
    });
    await act(async () => {
      fireEvent.click(loadMoreButton);
    });
    expect(listTasksSpy).toHaveBeenCalledTimes(2);
    expect(
      await screen.findAllByRole("button", { name: i18n.t("connections.tasks.open") }),
    ).toHaveLength(2);

    // Event reload authoritatively re-reads the loaded range; the returned page already
    // carries the current server state (t1 completed) — no stale tail merge.
    await act(async () => {
      notifyConversationChange({
        event: "conversation_changed",
        conversationId: "conv-paged",
        seq: 3,
        bindingEpoch: 1,
      });
    });
    await vi.waitFor(() => {
      const completed = screen.getAllByRole("button", { name: i18n.t("connections.tasks.open") });
      expect(completed).toHaveLength(2);
    });
    expect(listTasksSpy.mock.calls.at(-1)![0]!.cursor).toBeUndefined();

    view.unmount();
  });

  it("task ledger background refresh pages at server limit and authoritatively replaces expired rows", async () => {
    // 300 tasks server-side; each page returns at most 50 rows so the client must page.
    const all = Array.from({ length: 300 }, (_, index) =>
      mockTaskSummary(`t-${String(index).padStart(3, "0")}`, "conv-300", "running"),
    );
    const pages = new Map<string, { from: number; to: number; next: string | null }>([
      ["", { from: 0, to: 50, next: "c1" }],
      ["c1", { from: 50, to: 100, next: "c2" }],
      ["c2", { from: 100, to: 150, next: "c3" }],
      ["c3", { from: 150, to: 200, next: "c4" }],
      ["c4", { from: 200, to: 250, next: "c5" }],
      ["c5", { from: 250, to: 300, next: null }],
    ]);
    const limits: number[] = [];
    const cursors: (string | undefined)[] = [];
    const listTasksSpy = vi.fn(
      (filters: { cursor?: string; limit?: number }, _signal?: AbortSignal) => {
        limits.push(filters.limit ?? 50);
        cursors.push(filters.cursor);
        const range = pages.get(filters.cursor ?? "")!;
        return Promise.resolve({
          items: all.slice(range.from, range.to).map((item) => ({ ...item })),
          nextCursor: range.next,
          hasMore: range.next !== null,
        });
      },
    );
    setupApi({ listTasks: listTasksSpy as unknown as SuperstringApi["listTasks"] });

    // Seed 300 loaded rows via loadMore clicks (6 pages x 50).
    const view = render(<TaskLedger conversationId="conv-300" />);
    await screen.findAllByRole("button", { name: i18n.t("connections.tasks.open") });
    const loadMoreButton = () =>
      screen.queryByRole("button", { name: i18n.t("connections.tasks.loadMore") });
    while (loadMoreButton()) {
      await act(async () => {
        fireEvent.click(loadMoreButton()!);
      });
    }
    expect(
      await screen.findAllByRole("button", { name: i18n.t("connections.tasks.open") }),
    ).toHaveLength(300);

    // Server state moves forward: the first 100 tasks no longer match the cursor window
    // (e.g. filtered/expired); the remaining 200 arrive across a new cursor chain.
    pages.clear();
    pages.set("", { from: 0, to: 50, next: "c1" });
    pages.set("c1", { from: 50, to: 100, next: "c2" });
    pages.set("c2", { from: 100, to: 150, next: "c3" });
    pages.set("c3", { from: 150, to: 200, next: null });
    all.splice(0, 100);
    limits.length = 0;
    cursors.length = 0;
    await act(async () => {
      notifyConversationChange({
        event: "conversation_changed",
        conversationId: "conv-300",
        seq: 9,
        bindingEpoch: 1,
      });
    });
    await vi.waitFor(() => {
      expect(
        screen.getAllByRole("button", { name: i18n.t("connections.tasks.open") }),
      ).toHaveLength(200);
    });
    // No single request exceeded the server page cap (server schema caps at 50 here).
    expect(limits.every((limit) => limit === 50)).toBe(true);
    // Paging followed the exact returned cursor chain: first request uncursored, then
    // each server-provided nextCursor until the final page reported hasMore=false.
    expect(cursors).toEqual([undefined, "c1", "c2", "c3"]);
    view.unmount();
  });

  it("automatically updates open task detail with waiting approval on matching event", async () => {
    const listTasksSpy = vi.fn().mockResolvedValue({
      items: [mockTaskSummary("t-appr", "conv-appr", "waiting_approval")],
      nextCursor: null,
    });
    const getTaskSpy = vi
      .fn()
      .mockResolvedValueOnce(mockTaskDetail("t-appr", "conv-appr", "waiting_approval"))
      .mockResolvedValueOnce(mockTaskDetail("t-appr", "conv-appr", "completed"));

    setupApi({
      listTasks: listTasksSpy,
      getTask: getTaskSpy,
    });

    const view = render(<TaskLedger conversationId="conv-appr" />);
    expect(listTasksSpy).toHaveBeenCalledTimes(1);

    // Click open button to open task detail sheet
    const openBtn = await screen.findByRole("button", {
      name: i18n.t("connections.tasks.open"),
    });
    await act(async () => {
      fireEvent.click(openBtn);
    });
    expect(getTaskSpy).toHaveBeenCalledTimes(1);

    // Event arrives for conv-appr: triggers detail re-read
    await act(async () => {
      notifyConversationChange({
        event: "conversation_changed",
        conversationId: "conv-appr",
        seq: 2,
        bindingEpoch: 1,
      });
    });
    expect(getTaskSpy).toHaveBeenCalledTimes(2);

    view.unmount();
  });

  it("cancels trailing revalidation when paused before in-flight read settles in useLiveResource", async () => {
    let resolveRead!: (value: any) => void;
    const inFlightPromise = new Promise((resolve) => {
      resolveRead = resolve;
    });

    const readSpy = vi
      .fn()
      .mockImplementationOnce(() => inFlightPromise)
      .mockResolvedValue({ status: "done" });

    const { result, rerender, unmount } = renderHook(
      ({ paused }) =>
        useLiveResource(readSpy, {
          paused,
          conversationScope: { conversationId: "conv-pause-live" },
        }),
      { initialProps: { paused: false } },
    );

    expect(readSpy).toHaveBeenCalledTimes(1);

    // Event arrives while read is in flight: sets pending bit
    await act(async () => {
      notifyConversationChange({
        event: "conversation_changed",
        conversationId: "conv-pause-live",
        seq: 1,
        bindingEpoch: 1,
      });
    });
    expect(readSpy).toHaveBeenCalledTimes(1);

    // User pauses before read settles
    rerender({ paused: true });

    // In-flight read completes
    await act(async () => {
      resolveRead({ status: "initial" });
      await Promise.resolve();
    });

    // Paused state prevents trailing revalidation from firing
    expect(readSpy).toHaveBeenCalledTimes(1);

    // Manual refresh is preserved even when paused
    await act(async () => {
      result.current.refresh();
    });
    expect(readSpy).toHaveBeenCalledTimes(2);

    unmount();
  });

  it("task detail background refresh failure clears invalid detail and displays error", async () => {
    const listTasksSpy = vi.fn().mockResolvedValue({
      items: [mockTaskSummary("t-fail", "conv-fail", "waiting_approval")],
      nextCursor: null,
    });
    const getTaskSpy = vi
      .fn()
      .mockResolvedValueOnce(mockTaskDetail("t-fail", "conv-fail", "waiting_approval"))
      .mockRejectedValueOnce(new Error("TASK_REVOKED"));

    setupApi({
      listTasks: listTasksSpy,
      getTask: getTaskSpy,
    });

    const view = render(<TaskLedger conversationId="conv-fail" />);
    const openBtn = await screen.findByRole("button", {
      name: i18n.t("connections.tasks.open"),
    });
    await act(async () => {
      fireEvent.click(openBtn);
    });
    expect(getTaskSpy).toHaveBeenCalledTimes(1);

    // Event arrives for conv-fail; background refresh fails (revoked/unauthorized)
    await act(async () => {
      notifyConversationChange({
        event: "conversation_changed",
        conversationId: "conv-fail",
        seq: 2,
        bindingEpoch: 1,
      });
    });
    expect(getTaskSpy).toHaveBeenCalledTimes(2);

    // Invalid detail is cleared from view and error is rendered
    expect(await screen.findByRole("alert")).toBeTruthy();

    view.unmount();
  });

  it("ConversationRuntimeSummary triggers instant status read on matching event and ignores unrelated", async () => {
    const statusSpy = vi.fn().mockResolvedValue({
      pendingWakes: 0,
      failedWakes: 0,
      nextReadyAt: null,
      activeRuns: 0,
      unknownDeliveries: 0,
      lastActivityAt: "2026-10-06T00:00:00Z",
      connectionPhase: "ready",
      now: "2026-10-06T00:00:00Z",
    });
    setupApi({ getConversationRuntimeStatus: statusSpy });

    const view = render(<ConversationRuntimeSummary conversationId="conv-summary" />);
    expect(statusSpy).toHaveBeenCalledTimes(1);

    // Unrelated conversation event does not trigger read
    await act(async () => {
      notifyConversationChange({
        event: "conversation_changed",
        conversationId: "conv-other",
        seq: 1,
        bindingEpoch: 1,
      });
    });
    expect(statusSpy).toHaveBeenCalledTimes(1);

    // Matching conversation event triggers instant read
    await act(async () => {
      notifyConversationChange({
        event: "conversation_changed",
        conversationId: "conv-summary",
        seq: 2,
        bindingEpoch: 1,
      });
    });
    expect(statusSpy).toHaveBeenCalledTimes(2);

    view.unmount();
  });

  it("RunWorkspace triggers instant getRun read on matching owner conversation event and ignores unrelated", async () => {
    const getRunSpy = vi.fn().mockResolvedValue({
      runId: "run-rw-1",
      specId: "spec-test",
      specVersion: "1.0",
      owner: { kind: "conversation", id: "conv-rw" },
      status: "running",
      startedAt: "2026-10-06T00:00:00Z",
      endedAt: null,
      errorCode: null,
      steps: [],
      lastSeq: 0,
      outputs: [],
    });
    setupApi({ getRun: getRunSpy });

    const view = render(<RunWorkspace runId="run-rw-1" />);
    expect(getRunSpy).toHaveBeenCalledTimes(1);

    // Wait for receiveRunSnapshot to populate live run in store
    await act(async () => {
      await Promise.resolve();
    });

    // Unrelated conversation event does not trigger read
    await act(async () => {
      notifyConversationChange({
        event: "conversation_changed",
        conversationId: "conv-other",
        seq: 1,
        bindingEpoch: 1,
      });
    });
    expect(getRunSpy).toHaveBeenCalledTimes(1);

    // Matching owner conversation event triggers instant read
    await act(async () => {
      notifyConversationChange({
        event: "conversation_changed",
        conversationId: "conv-rw",
        seq: 2,
        bindingEpoch: 1,
      });
    });
    expect(getRunSpy).toHaveBeenCalledTimes(2);

    view.unmount();
  });
});
