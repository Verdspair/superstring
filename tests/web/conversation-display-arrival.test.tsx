import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ConversationEventView,
  ConversationSummary,
} from "../../src/shared/contracts/conversation";
import { api, type ConversationChangeEvent, type SuperstringApi } from "../../src/web/api";
import { useConversationEvents } from "../../src/web/features/conversations/use-conversation-events";
import { i18n } from "../../src/web/i18n/runtime";
import { ExternalConversation } from "../../src/web/screens/conversations/ExternalConversation";
import {
  notifyConversationChange,
  resetConversationChangesForTests,
} from "../../src/web/services/conversation-changes";
import { useSuperstringStore } from "../../src/web/store";

// Same-owner QQ rebind family: the closed epoch keeps its own seq space (local rows),
// while every display read and frame is projected onto one shared history root whose
// seq counts across the whole family (global = closed-epoch offset + local).
const ROOT = "conv-root";
const CLOSED_EPOCH = "conv-epoch1";
const OFFSET = 2;

let originalVisibilityDesc: PropertyDescriptor | undefined;

type Visibility = "visible" | "hidden";

const setVisibility = (value: Visibility) => {
  Object.defineProperty(document, "visibilityState", { configurable: true, value });
  fireEvent(document, new Event("visibilitychange"));
};

type EventsPage = { items: ConversationEventView[]; nextSeq: number; hasMore: boolean };
type EventsParams = {
  direction: "latest" | "before" | "after";
  afterSeq?: number;
  beforeSeq?: number;
  limit?: number;
};

const sampleEvent = (seq: number, text = `msg-${seq}`): ConversationEventView => ({
  seq,
  eventKey: `event-${seq}`,
  conversationId: ROOT,
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
  occurredAt: "2026-10-10T00:00:00Z",
  recordedAt: "2026-10-10T00:00:00Z",
});

const conversationFixture = (
  overrides: Partial<ConversationSummary> = {},
): ConversationSummary => ({
  id: ROOT,
  channel: "onebot11",
  topology: "direct",
  sourceId: "binding-1",
  agentId: "agent-a",
  bindingEpoch: 1,
  title: "fixture group",
  participants: [],
  updatedAt: "2026-10-10T00:00:00Z",
  lastSeq: 0,
  consumedSeq: 0,
  ...overrides,
});

const emptyTracesPage = () => ({
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

function setupApi(overrides: Partial<SuperstringApi>) {
  useSuperstringStore.getState().resetForTests({
    ...api,
    ...overrides,
  });
}

const trackedGetEvents = (
  calls: EventsParams[],
  serve: (page: EventsParams) => Promise<EventsPage>,
) =>
  vi.fn<SuperstringApi["getConversationEvents"]>((_id, params) => {
    const page =
      typeof params === "number"
        ? { direction: "after" as const, afterSeq: params }
        : (params ?? { direction: "latest" as const });
    calls.push({ ...page });
    return serve(page);
  });

beforeEach(() => {
  localStorage.clear();
  resetConversationChangesForTests();
  originalVisibilityDesc =
    Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState") ??
    Object.getOwnPropertyDescriptor(document, "visibilityState");
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
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

describe("conversation display arrival coordinates", () => {
  it("frames on the closed physical epoch id stay out of the timeline scope while root/global-seq frames tail immediately without waiting for the 5s poll", async () => {
    vi.useFakeTimers();
    const calls: EventsParams[] = [];
    const getEvents = trackedGetEvents(calls, (page) => {
      if (page.direction === "latest") {
        // History root already loaded past the closed epoch offset: global seqs 3..4.
        return Promise.resolve({
          items: [sampleEvent(3), sampleEvent(4)],
          nextSeq: 4,
          hasMore: false,
        });
      }
      if (page.afterSeq === OFFSET) {
        // Periodic re-read while only the closed epoch existed: no new rows.
        return Promise.resolve({
          items: [sampleEvent(3), sampleEvent(4)],
          nextSeq: 4,
          hasMore: false,
        });
      }
      if (page.limit === 100) {
        // One new family append projected onto the root: global seq 5.
        return Promise.resolve({ items: [sampleEvent(5)], nextSeq: 5, hasMore: false });
      }
      // Periodic re-read after the tail grew: the family replay covers 3..5.
      return Promise.resolve({
        items: [sampleEvent(3), sampleEvent(4), sampleEvent(5)],
        nextSeq: 5,
        hasMore: false,
      });
    });
    setupApi({ getConversationEvents: getEvents });

    const { result } = renderHook(() =>
      useConversationEvents(ROOT, undefined, { refreshMs: 5000 }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(calls).toEqual([{ direction: "latest" }]);
    expect(result.current.items.map((item) => item.seq)).toEqual([3, 4]);

    // Server frames the append on the closed physical epoch row: global 4 is local 2 at
    // offset 2. The timeline is scoped to the history root, so the notification is out of
    // scope and nothing may be fetched; the 5s periodic read is the only fallback.
    await act(async () => {
      notifyConversationChange({
        event: "conversation_changed",
        conversationId: CLOSED_EPOCH,
        seq: 2,
        bindingEpoch: 1,
      } satisfies ConversationChangeEvent);
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(calls).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(calls).toEqual([
      { direction: "latest" },
      // Periodic fallback re-reads the loaded range from its first loaded seq minus one,
      // which is not the tail shape (tail = last loaded seq, limit 100).
      { direction: "after", afterSeq: OFFSET, limit: 102 },
    ]);

    // The same append projected onto the shared history root with the global seq: one
    // incremental tail read fires immediately, without advancing the 5s poll.
    await act(async () => {
      notifyConversationChange({
        event: "conversation_changed",
        conversationId: ROOT,
        seq: 5,
        bindingEpoch: 3,
      } satisfies ConversationChangeEvent);
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(calls).toEqual([
      { direction: "latest" },
      { direction: "after", afterSeq: OFFSET, limit: 102 },
      { direction: "after", afterSeq: 4, limit: 100 },
    ]);
    expect(result.current.items.map((item) => item.seq)).toEqual([3, 4, 5]);

    // The 5s periodic read keeps its original contract after the tail grew.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(calls).toEqual([
      { direction: "latest" },
      { direction: "after", afterSeq: OFFSET, limit: 102 },
      { direction: "after", afterSeq: 4, limit: 100 },
      { direction: "after", afterSeq: OFFSET, limit: 103 },
    ]);
  });

  it("a summary epoch change clears and authoritatively reloads the family view; same-owner post-rebind frames tail the reloaded root scope", async () => {
    const calls: EventsParams[] = [];
    let latestReads = 0;
    const getEvents = trackedGetEvents(calls, (page) => {
      if (page.direction === "latest") {
        latestReads += 1;
        // Reload replays the whole same-owner family history from the root.
        return Promise.resolve(
          latestReads === 1
            ? { items: [sampleEvent(1), sampleEvent(2)], nextSeq: 2, hasMore: false }
            : {
                items: [sampleEvent(1), sampleEvent(2), sampleEvent(3)],
                nextSeq: 3,
                hasMore: false,
              },
        );
      }
      if (page.afterSeq === 2) {
        return Promise.resolve({ items: [sampleEvent(3)], nextSeq: 3, hasMore: false });
      }
      return Promise.resolve({ items: [sampleEvent(4)], nextSeq: 4, hasMore: false });
    });
    setupApi({ getConversationEvents: getEvents });
    act(() => {
      useSuperstringStore.setState((state) => ({
        summaryById: {
          ...state.summaryById,
          [ROOT]: conversationFixture({ bindingEpoch: 1 }),
        },
      }));
    });

    const { result } = renderHook(() => useConversationEvents(ROOT));
    await act(async () => {
      await Promise.resolve();
    });
    expect(calls).toEqual([{ direction: "latest" }]);
    expect(result.current.items.map((item) => item.seq)).toEqual([1, 2]);

    await act(async () => {
      notifyConversationChange({
        event: "conversation_changed",
        conversationId: ROOT,
        seq: 3,
        bindingEpoch: 1,
      } satisfies ConversationChangeEvent);
    });
    expect(calls).toEqual([
      { direction: "latest" },
      { direction: "after", afterSeq: 2, limit: 100 },
    ]);
    expect(result.current.items.map((item) => item.seq)).toEqual([1, 2, 3]);

    // Same-owner rebinding moves the summary to a new epoch: the timeline must clear and
    // re-read the family authoritatively, never tail on the pre-rebind cursor.
    act(() => {
      useSuperstringStore.setState((state) => ({
        summaryById: {
          ...state.summaryById,
          [ROOT]: conversationFixture({ bindingEpoch: 3 }),
        },
      }));
    });
    expect(result.current.items).toEqual([]);

    await act(async () => {
      await Promise.resolve();
    });
    expect(calls).toEqual([
      { direction: "latest" },
      { direction: "after", afterSeq: 2, limit: 100 },
      { direction: "latest" },
    ]);
    expect(result.current.items.map((item) => item.seq)).toEqual([1, 2, 3]);

    // A frame on the current epoch tails the reloaded root scope by global seq.
    await act(async () => {
      notifyConversationChange({
        event: "conversation_changed",
        conversationId: ROOT,
        seq: 4,
        bindingEpoch: 3,
      } satisfies ConversationChangeEvent);
    });
    expect(calls).toEqual([
      { direction: "latest" },
      { direction: "after", afterSeq: 2, limit: 100 },
      { direction: "latest" },
      { direction: "after", afterSeq: 3, limit: 100 },
    ]);
    expect(result.current.items.map((item) => item.seq)).toEqual([1, 2, 3, 4]);
  });

  it("scope guards: unrelated conversations never fetch, visible blur keeps reading, paused and hidden gate reads, recovery reads once", async () => {
    const calls: EventsParams[] = [];
    const getEvents = trackedGetEvents(calls, () =>
      Promise.resolve({
        items: [sampleEvent(1), sampleEvent(2)],
        nextSeq: 2,
        hasMore: false,
      }),
    );
    setupApi({ getConversationEvents: getEvents });

    const { rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) => useConversationEvents(ROOT, undefined, { enabled }),
      { initialProps: { enabled: true } },
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(calls).toHaveLength(1);

    // A different conversation id is out of scope: zero reads.
    await act(async () => {
      notifyConversationChange({
        event: "conversation_changed",
        conversationId: "conv-other",
        seq: 9,
        bindingEpoch: 1,
      } satisfies ConversationChangeEvent);
    });
    expect(calls).toHaveLength(1);

    // Window blur keeps the timeline live: the frame still tails immediately.
    act(() => {
      fireEvent.blur(window);
    });
    await act(async () => {
      notifyConversationChange({
        event: "conversation_changed",
        conversationId: ROOT,
        seq: 3,
        bindingEpoch: 1,
      } satisfies ConversationChangeEvent);
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual({ direction: "after", afterSeq: 2, limit: 100 });

    // A paused page reads nothing while inactive, then exactly one catch-up read.
    rerender({ enabled: false });
    await act(async () => {
      notifyConversationChange({
        event: "conversation_changed",
        conversationId: ROOT,
        seq: 4,
        bindingEpoch: 1,
      } satisfies ConversationChangeEvent);
    });
    expect(calls).toHaveLength(2);

    rerender({ enabled: true });
    await act(async () => {
      await Promise.resolve();
    });
    expect(calls).toHaveLength(3);

    // Hidden tab reads nothing; returning to the foreground reads exactly once.
    act(() => {
      setVisibility("hidden");
    });
    await act(async () => {
      notifyConversationChange({
        event: "conversation_changed",
        conversationId: ROOT,
        seq: 5,
        bindingEpoch: 1,
      } satisfies ConversationChangeEvent);
    });
    expect(calls).toHaveLength(3);

    act(() => {
      setVisibility("visible");
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(calls).toHaveLength(4);
  });

  it("load-older and tail reads run concurrently while away from the bottom, which keeps the scroll anchored with an exact unread count", async () => {
    const calls: EventsParams[] = [];
    let resolveOlder!: (value: EventsPage) => void;
    const olderPage = new Promise<EventsPage>((resolve) => {
      resolveOlder = resolve;
    });
    const getEvents = trackedGetEvents(calls, (page) => {
      if (page.direction === "latest") {
        return Promise.resolve({
          items: [sampleEvent(2), sampleEvent(3)],
          nextSeq: 3,
          hasMore: true,
        });
      }
      if (page.direction === "before") {
        return olderPage;
      }
      return Promise.resolve({ items: [sampleEvent(4)], nextSeq: 4, hasMore: false });
    });
    setupApi({
      getConversationEvents: getEvents,
      listRuntimeTraces: vi.fn().mockResolvedValue(emptyTracesPage()),
    });

    const view = render(
      <ExternalConversation conversation={conversationFixture({ lastSeq: 3 })} />,
    );
    const viewport = view.container.querySelector('[role="tabpanel"]') as HTMLElement;
    // jsdom has no layout: pin the geometry the scroll anchor reads.
    Object.defineProperty(viewport, "scrollHeight", { configurable: true, value: 1000 });
    Object.defineProperty(viewport, "clientHeight", { configurable: true, value: 200 });

    await screen.findByText("msg-2");
    expect(calls).toEqual([{ direction: "latest" }]);

    // The user scrolls away from the bottom.
    act(() => {
      viewport.scrollTop = 100;
      fireEvent.scroll(viewport);
    });
    expect(screen.getByRole("button", { name: i18n.t("workspace.jump_to_latest") })).toBeTruthy();

    // Loading older history starts a before-read and keeps it in flight.
    fireEvent.click(screen.getByRole("button", { name: i18n.t("workspace.load_earlier_history") }));
    expect(calls).toEqual([{ direction: "latest" }, { direction: "before", beforeSeq: 2 }]);

    // A new tail message arrives while the before-read is in flight: the tail read runs
    // concurrently instead of queueing behind it.
    await act(async () => {
      notifyConversationChange({
        event: "conversation_changed",
        conversationId: ROOT,
        seq: 4,
        bindingEpoch: 1,
      } satisfies ConversationChangeEvent);
    });
    expect(calls).toEqual([
      { direction: "latest" },
      { direction: "before", beforeSeq: 2 },
      { direction: "after", afterSeq: 3, limit: 100 },
    ]);

    // The older page settles: both reads merge without dropping rows or interrupting
    // either side, and no extra read is issued.
    await act(async () => {
      resolveOlder({ items: [sampleEvent(1)], nextSeq: 1, hasMore: false });
      await olderPage;
    });
    expect(calls).toHaveLength(3);
    expect(view.container.textContent).toContain("msg-1");
    expect(view.container.textContent).toContain("msg-4");

    // Away from the bottom: no forced jump to the newest row, and the unread count is
    // exactly the one new message.
    expect(viewport.scrollTop).toBe(100);
    expect(screen.getByText(i18n.t("workspace.new_messages", { "0": 1 }))).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: i18n.t("workspace.new_messages_latest", { "0": 1 }),
      }),
    ).toBeTruthy();

    view.unmount();
  });
});
