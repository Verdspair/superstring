import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  QqManagedEventsInvalidation,
  QqManagedEventsPage,
} from "../../src/shared/contracts/qq-managed-events";
import { api, type QqManagedEventQueryInput } from "../../src/web/api";
import { useSuperstringStore as store } from "../../src/web/store";

const generationA = "00000000-0000-4000-8000-000000000001";
const generationB = "00000000-0000-4000-8000-000000000002";

function eventPage(
  generation: string,
  revision: number,
  latestSequence: number,
  sequences: number[],
): QqManagedEventsPage {
  return {
    status: "ok",
    generation,
    latest_sequence: latestSequence,
    revision,
    events: sequences.map((sequence) => ({
      sequence,
      expires_at: "2026-10-25T04:00:00.000Z",
      event: {
        kind: "notice",
        account_id: "10001",
        occurred_at_seconds: 1_790_000_000,
        observed_at: "2026-10-25T03:00:00.000Z",
        notice_type: "group_increase",
        sub_type: "approve",
        user_id: "20002",
        group_id: "30003",
        operator_id: null,
        target_id: null,
        message_id: null,
      },
      conversation_binding: "unknown",
      message_preview: null,
      preview_state: "not_message",
    })),
    next_cursor: null,
    truncated: false,
  };
}

function currentEventRows() {
  const page = store.getState().qqManagedEventsPage;
  if (!page || page.status !== "ok") throw new Error("Expected an event page");
  return page.events;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

function makeSubscription() {
  let onNotice: ((notice: QqManagedEventsInvalidation) => void) | null = null;
  let signal: AbortSignal | undefined;
  const subscribe = vi.fn(
    (callback: (notice: QqManagedEventsInvalidation) => void, requestSignal?: AbortSignal) => {
      onNotice = callback;
      signal = requestSignal;
      return new Promise<void>(() => {});
    },
  );
  return {
    subscribe,
    emit(notice: QqManagedEventsInvalidation) {
      onNotice?.(notice);
    },
    get signal() {
      return signal;
    },
  };
}

function installApi(
  getPage: (
    query: QqManagedEventQueryInput | undefined,
    signal?: AbortSignal,
  ) => Promise<QqManagedEventsPage>,
) {
  const subscription = makeSubscription();
  const client = {
    ...api,
    getQqManagedEventsPage: vi.fn(getPage),
    subscribeQqManagedEventChanges: subscription.subscribe,
  };
  store.getState().resetForTests(client);
  return { client, subscription };
}

beforeEach(() => {
  store.getState().setQqManagedEventsActive(false);
});

afterEach(() => {
  store.getState().setQqManagedEventsActive(false);
});

describe("QQ managed event store lifecycle", () => {
  it("keeps one SSE subscription and merges concurrent page reads into one follow-up", async () => {
    const first = deferred<QqManagedEventsPage>();
    const second = deferred<QqManagedEventsPage>();
    const { client, subscription } = installApi(
      vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise),
    );

    store.getState().setQqManagedEventsActive(true);
    const joinedRead = store.getState().loadQqManagedEvents();
    store.getState().setQqManagedEventsActive(true);
    void store.getState().loadQqManagedEvents();
    await vi.waitFor(() => {
      expect(client.subscribeQqManagedEventChanges).toHaveBeenCalledTimes(1);
      expect(client.getQqManagedEventsPage).toHaveBeenCalledTimes(1);
    });

    first.resolve(eventPage(generationA, 1, 0, []));
    await joinedRead;
    await vi.waitFor(() => expect(client.getQqManagedEventsPage).toHaveBeenCalledTimes(2));
    second.resolve(eventPage(generationA, 1, 0, []));
    await vi.waitFor(() => expect(store.getState().qqManagedEventsLoading).toBe(false));
    expect(subscription.subscribe).toHaveBeenCalledTimes(1);
  });

  it("re-reads when an SSE revision advances during the current GET", async () => {
    const first = deferred<QqManagedEventsPage>();
    const second = deferred<QqManagedEventsPage>();
    const { client, subscription } = installApi(
      vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise),
    );

    store.getState().setQqManagedEventsActive(true);
    await vi.waitFor(() => expect(client.getQqManagedEventsPage).toHaveBeenCalledTimes(1));
    subscription.emit({ generation: generationA, latest_sequence: 2, revision: 2 });

    first.resolve(eventPage(generationA, 1, 1, [1]));
    await vi.waitFor(() => expect(client.getQqManagedEventsPage).toHaveBeenCalledTimes(2));
    expect(store.getState().qqManagedEventsPage).toBeNull();
    second.resolve(eventPage(generationA, 2, 2, [1, 2]));
    await vi.waitFor(() => expect(store.getState().qqManagedEventsPage?.revision).toBe(2));
    expect(currentEventRows().map((row) => row.sequence)).toEqual([1, 2]);
  });

  it("aborts subscription and GET on deactivation and ignores late callbacks and results", async () => {
    const pending = deferred<QqManagedEventsPage>();
    let getSignal: AbortSignal | undefined;
    const { client, subscription } = installApi((_query, signal) => {
      getSignal = signal;
      return pending.promise;
    });

    store.getState().setQqManagedEventsActive(true);
    await vi.waitFor(() => expect(client.getQqManagedEventsPage).toHaveBeenCalledTimes(1));
    store.getState().setQqManagedEventsActive(false);
    expect(subscription.signal?.aborted).toBe(true);
    expect(getSignal?.aborted).toBe(true);

    subscription.emit({ generation: generationA, latest_sequence: 1, revision: 1 });
    pending.resolve(eventPage(generationA, 1, 1, [1]));
    await vi.waitFor(() => expect(store.getState().qqManagedEventsLoading).toBe(false));
    expect(client.getQqManagedEventsPage).toHaveBeenCalledTimes(1);
    expect(store.getState().qqManagedEventsPage).toBeNull();
  });

  it("applies local clear cutoff within a generation and resets it when generation changes", async () => {
    const getPage = vi
      .fn()
      .mockResolvedValueOnce(eventPage(generationA, 1, 2, [1, 2]))
      .mockResolvedValueOnce(eventPage(generationA, 2, 3, [1, 2, 3]))
      .mockResolvedValueOnce(eventPage(generationB, 1, 1, [1]));
    const { client, subscription } = installApi(getPage);

    store.getState().setQqManagedEventsActive(true);
    await vi.waitFor(() => expect(currentEventRows()).toHaveLength(2));
    store.getState().clearQqManagedEventsView();
    expect(currentEventRows()).toEqual([]);

    subscription.emit({ generation: generationA, latest_sequence: 3, revision: 2 });
    await vi.waitFor(() => expect(store.getState().qqManagedEventsPage?.revision).toBe(2));
    expect(currentEventRows().map((row) => row.sequence)).toEqual([3]);

    subscription.emit({ generation: generationB, latest_sequence: 1, revision: 1 });
    await vi.waitFor(() =>
      expect(store.getState().qqManagedEventsPage?.generation).toBe(generationB),
    );
    expect(currentEventRows().map((row) => row.sequence)).toEqual([1]);
    expect(client.getQqManagedEventsPage).toHaveBeenCalledTimes(3);
  });
});
