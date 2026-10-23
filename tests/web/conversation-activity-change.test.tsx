import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ConversationEventView,
  ConversationSummary,
} from "../../src/shared/contracts/conversation";
import { api, type ConversationChangeEvent, type SuperstringApi } from "../../src/web/api";
import type { BrowserStateStorage } from "../../src/web/browser-state";
import { useConversationEvents } from "../../src/web/features/conversations/use-conversation-events";
import {
  notifyConversationChange,
  resetConversationChangesForTests,
  startConversationChanges,
} from "../../src/web/services/conversation-changes";
import { useSuperstringStore } from "../../src/web/store";

type Page = Awaited<ReturnType<SuperstringApi["getConversationEvents"]>>;

const conversationId = "activity-conv-1";

const event = (seq: number, patch: Partial<ConversationEventView> = {}): ConversationEventView => ({
  conversationId,
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
  text: `message-${seq}`,
  contentState: "active",
  media: [],
  qqMessageFacts: [],
  deliveryStatus: null,
  messageStatus: null,
  ...patch,
});

const page = (items: ConversationEventView[], hasMore = false): Page => ({
  items,
  nextSeq: items.at(-1)?.seq ?? 0,
  hasMore,
});

const notifyActivity = (seq: number) =>
  notifyConversationChange({
    event: "conversation_activity_changed",
    conversationId,
    seq,
    bindingEpoch: 1,
    activity: "span",
  });

const notifyContent = (seq: number) =>
  notifyConversationChange({
    event: "conversation_changed",
    conversationId,
    seq,
    bindingEpoch: 1,
  });

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const summary = (id: string): ConversationSummary => ({
  id,
  channel: "onebot11",
  topology: "direct",
  sourceId: "binding-1",
  agentId: "agent-1",
  bindingEpoch: 1,
  title: "activity summary",
  participants: [],
  updatedAt: "2026-10-23T00:00:00Z",
  lastSeq: 10,
  consumedSeq: 10,
});

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

describe("conversation activity change", () => {
  it("twenty span-activity frames cause no history read and no cache write", async () => {
    const read = vi
      .fn<SuperstringApi["getConversationEvents"]>()
      .mockResolvedValue(page([event(10)]));
    const storage: BrowserStateStorage = {
      read: vi.fn(async () => null),
      write: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
    };
    useSuperstringStore.getState().resetForTests({ ...api, getConversationEvents: read });
    useSuperstringStore.setState({ sessionStateStorage: storage });
    const beforeChange = vi.fn();
    const { result } = renderHook(() => useConversationEvents(conversationId, beforeChange));
    await act(async () => {});

    expect(result.current.items.map((row) => row.seq)).toEqual([10]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(storage.write).toHaveBeenCalledTimes(1);
    beforeChange.mockClear();

    await act(async () => {
      for (let index = 0; index < 20; index += 1) notifyActivity(10);
      await tick();
    });

    // Pure runtime activity refreshes no history projection and persists nothing.
    expect(read).toHaveBeenCalledTimes(1);
    expect(storage.write).toHaveBeenCalledTimes(1);
    expect(beforeChange).not.toHaveBeenCalled();
    expect(result.current.items.map((row) => row.seq)).toEqual([10]);
  });

  it("broadcasts span activity without reading the unchanged directory summary", async () => {
    const id = "activity-summary-1";
    const getConversation = vi.fn().mockResolvedValue(summary(id));
    const received = vi.fn();
    const { addConversationChangeListener } = await import(
      "../../src/web/services/conversation-changes"
    );
    const unsubscribe = addConversationChangeListener(received);
    let sseCallback!: (event: ConversationChangeEvent) => void;
    useSuperstringStore.getState().resetForTests({
      getConversation,
      subscribeConversationChanges: async (onEvent: (event: ConversationChangeEvent) => void) => {
        sseCallback = onEvent;
        await new Promise<void>(() => {});
      },
    } as unknown as SuperstringApi);
    useSuperstringStore.getState().rememberConversation(summary(id));
    const initial = useSuperstringStore.getState().summaryById[id];
    const cleanupChanges = startConversationChanges(useSuperstringStore.getState().apiClient);
    try {
      sseCallback({ event: "ready", ready: true });
      received.mockClear();
      for (let index = 0; index < 1000; index += 1) {
        sseCallback({
          event: "conversation_activity_changed",
          conversationId: id,
          seq: 10,
          bindingEpoch: 1,
          activity: "span",
        });
      }
      await tick();
      // Separate settled flushes must not create summary reads either.
      for (let index = 0; index < 3; index += 1) {
        sseCallback({
          event: "conversation_activity_changed",
          conversationId: id,
          seq: 10,
          bindingEpoch: 1,
          activity: "span",
        });
        await tick();
      }
      expect(getConversation).not.toHaveBeenCalled();
      expect(received).toHaveBeenCalledTimes(1003);
      expect(useSuperstringStore.getState().summaryById[id]).toBe(initial);
      sseCallback({ event: "conversation_changed", conversationId: id, seq: 10, bindingEpoch: 1 });
      await tick();
      expect(getConversation).toHaveBeenCalledTimes(1);
    } finally {
      cleanupChanges();
      unsubscribe();
    }
  });

  it("does not queue hidden span activity for summary reads, but reconciles hidden content", async () => {
    const id = "activity-hidden-summary";
    const getConversation = vi.fn().mockResolvedValue(summary(id));
    let receive!: (event: ConversationChangeEvent) => void;
    useSuperstringStore.getState().resetForTests({
      getConversation,
      subscribeConversationChanges: async (callback: (event: ConversationChangeEvent) => void) => {
        receive = callback;
        await new Promise<void>(() => {});
      },
    } as unknown as SuperstringApi);
    const stop = startConversationChanges(useSuperstringStore.getState().apiClient);
    const visible = (value: "hidden" | "visible") => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value });
      document.dispatchEvent(new Event("visibilitychange"));
    };
    try {
      receive({ event: "ready", ready: true });
      visible("hidden");
      for (let index = 0; index < 1000; index++)
        receive({
          event: "conversation_activity_changed",
          conversationId: id,
          seq: 10,
          bindingEpoch: 1,
          activity: "span",
        });
      visible("visible");
      await tick();
      expect(getConversation).not.toHaveBeenCalled();
      visible("hidden");
      receive({ event: "conversation_changed", conversationId: id, seq: 10, bindingEpoch: 1 });
      expect(getConversation).not.toHaveBeenCalled();
      visible("visible");
      await tick();
      expect(getConversation).toHaveBeenCalledTimes(1);
      expect(useSuperstringStore.getState().summaryById[id]).toEqual(summary(id));
    } finally {
      stop();
    }
  });

  it("same-seq content still recomputes task, wake, judgment and run state", async () => {
    const pending = event(19, {
      task: { id: "task-19", status: "pending", errorCode: null },
      runId: null,
    });
    const waiting = event(20, {
      kind: "wake",
      source: { kind: "wake", id: "wake-20", revision: "1" },
      sources: [{ kind: "wake", id: "wake-20", revision: "1" }],
      wake: {
        id: "wake-20",
        cause: "chiming_in",
        status: "pending",
        readyAt: "2026-10-23T00:00:00Z",
        errorCode: null,
        judgmentStarted: false,
      },
    });
    const running: ConversationEventView = {
      ...pending,
      task: { id: "task-19", status: "running", errorCode: null },
      runId: "run-19",
    };
    const judged: ConversationEventView = {
      ...waiting,
      wake: {
        id: "wake-20",
        cause: "chiming_in",
        status: "completed",
        readyAt: "2026-10-23T00:00:00Z",
        errorCode: null,
        judgmentStarted: true,
      },
    };
    const read = vi.fn<SuperstringApi["getConversationEvents"]>(async (_id, params) =>
      typeof params === "object" && params.direction === "after"
        ? page([running, judged])
        : page([pending, waiting]),
    );
    useSuperstringStore.getState().resetForTests({ ...api, getConversationEvents: read });
    const { result } = renderHook(() => useConversationEvents(conversationId));
    await act(async () => {});

    expect(result.current.items[0]?.task?.status).toBe("pending");
    expect(result.current.items[1]?.wake?.status).toBe("pending");

    await act(async () => {
      notifyContent(20);
      await tick();
    });

    // A content change with an unchanged seq must still revalidate the projected state.
    expect(read).toHaveBeenCalledTimes(2);
    expect(read.mock.calls[1]?.[1]).toMatchObject({ direction: "after", afterSeq: 18 });
    expect(result.current.items[0]?.task).toEqual({
      id: "task-19",
      status: "running",
      errorCode: null,
    });
    expect(result.current.items[0]?.runId).toBe("run-19");
    expect(result.current.items[1]?.wake).toMatchObject({
      status: "completed",
      judgmentStarted: true,
    });
  });

  it("a new content seq tails immediately instead of waiting for a range refresh", async () => {
    const read = vi
      .fn<SuperstringApi["getConversationEvents"]>()
      .mockResolvedValueOnce(page([event(10)], true))
      .mockResolvedValueOnce(page([event(11)]));
    useSuperstringStore.getState().resetForTests({ ...api, getConversationEvents: read });
    const { result } = renderHook(() => useConversationEvents(conversationId));
    await act(async () => {});

    await act(async () => {
      notifyContent(11);
      await tick();
    });

    expect(read).toHaveBeenCalledTimes(2);
    expect(read.mock.calls[1]?.[1]).toEqual({
      direction: "after",
      afterSeq: 10,
      limit: 100,
    });
    expect(result.current.items.map((row) => row.seq)).toEqual([10, 11]);
  });
});
