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
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
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

  it.each(["success", "error"] as const)(
    "coalesces notices, ignores blur/focus and fences hidden reads after late %s",
    async (outcome) => {
      const hiddenDescriptor = Object.getOwnPropertyDescriptor(document, "hidden");
      const addListener = vi.spyOn(document, "addEventListener");
      const removeListener = vi.spyOn(document, "removeEventListener");
      const fetch = vi.spyOn(globalThis, "fetch");
      const first = deferred<QqManagedEventsPage>();
      const followup = deferred<QqManagedEventsPage>();
      const hiddenRead = deferred<QqManagedEventsPage>();
      const resumed = deferred<QqManagedEventsPage>();
      const sequences = Array.from({ length: 100 }, (_, index) => index + 1);
      Object.defineProperty(document, "hidden", { configurable: true, value: false });
      const { client, subscription } = installApi(
        vi
          .fn()
          .mockReturnValueOnce(first.promise)
          .mockReturnValueOnce(followup.promise)
          .mockReturnValueOnce(hiddenRead.promise)
          .mockReturnValueOnce(resumed.promise),
      );

      try {
        store.getState().setQqManagedEventsActive(true);
        await vi.waitFor(() => {
          expect(client.getQqManagedEventsPage).toHaveBeenCalledTimes(1);
          expect(subscription.subscribe).toHaveBeenCalledTimes(1);
        });
        const oldNotice = subscription.subscribe.mock.calls[0][0];
        const notice = { generation: generationA, latest_sequence: 100, revision: 1 };
        subscription.emit(notice);
        subscription.emit({ ...notice });
        subscription.emit({ ...notice, latest_sequence: 101, revision: 2 });
        subscription.emit({ ...notice, latest_sequence: 102, revision: 3 });
        expect(client.getQqManagedEventsPage).toHaveBeenCalledTimes(1);

        first.resolve(eventPage(generationA, 1, 100, sequences));
        await vi.waitFor(() => expect(client.getQqManagedEventsPage).toHaveBeenCalledTimes(2));
        expect(store.getState().qqManagedEventsPage).toBeNull();
        followup.resolve(eventPage(generationA, 3, 102, [...sequences, 101, 102]));
        await vi.waitFor(() => {
          expect(store.getState().qqManagedEventsPage?.revision).toBe(3);
          expect(store.getState().qqManagedEventsLoading).toBe(false);
        });
        subscription.emit({ ...notice, latest_sequence: 102, revision: 3 });
        window.dispatchEvent(new Event("blur"));
        window.dispatchEvent(new Event("focus"));
        await vi.waitFor(() => expect(store.getState().qqManagedEventsLoading).toBe(false));
        expect(client.getQqManagedEventsPage).toHaveBeenCalledTimes(2);
        expect(subscription.subscribe).toHaveBeenCalledTimes(1);

        const pendingRead = store.getState().loadQqManagedEvents();
        const joinedRead = store.getState().loadQqManagedEvents();
        await vi.waitFor(() => expect(client.getQqManagedEventsPage).toHaveBeenCalledTimes(3));
        const oldSubscriptionSignal = subscription.signal;
        const oldReadSignal = client.getQqManagedEventsPage.mock.calls[2][1];
        Object.defineProperty(document, "hidden", { configurable: true, value: true });
        document.dispatchEvent(new Event("visibilitychange"));
        await Promise.all([pendingRead, joinedRead]);
        expect(oldSubscriptionSignal?.aborted).toBe(true);
        expect(oldReadSignal?.aborted).toBe(true);
        expect(store.getState().qqManagedEventsPage).toBeNull();
        expect(store.getState().qqManagedEventsLoading).toBe(false);
        oldNotice({ generation: generationB, latest_sequence: 999, revision: 999 });
        if (outcome === "success") hiddenRead.resolve(eventPage(generationB, 999, 999, [999]));
        else hiddenRead.reject(new Error("hidden old read"));
        await hiddenRead.promise.catch(() => {});
        expect(store.getState().qqManagedEventsPage).toBeNull();
        expect(store.getState().qqManagedEventsError).toBeNull();
        expect(client.getQqManagedEventsPage).toHaveBeenCalledTimes(3);

        Object.defineProperty(document, "hidden", { configurable: true, value: false });
        document.dispatchEvent(new Event("visibilitychange"));
        await vi.waitFor(() => {
          expect(subscription.subscribe).toHaveBeenCalledTimes(2);
          expect(client.getQqManagedEventsPage).toHaveBeenCalledTimes(4);
        });
        expect(subscription.signal?.aborted).toBe(false);
        resumed.resolve(eventPage(generationA, 3, 102, [...sequences, 101, 102]));
        await vi.waitFor(() => expect(store.getState().qqManagedEventsLoading).toBe(false));
        expect(store.getState().qqManagedEventsPage?.generation).toBe(generationA);
        expect(store.getState().qqManagedEventsError).toBeNull();
        store.getState().clearQqManagedEventsView();
        expect(currentEventRows()).toEqual([]);
        expect(client.getQqManagedEventsPage).toHaveBeenCalledTimes(4);
        expect(subscription.subscribe).toHaveBeenCalledTimes(2);
        expect(fetch).not.toHaveBeenCalled();
        store.getState().setQqManagedEventsActive(false);
        expect(subscription.signal?.aborted).toBe(true);
        const visibilityListener = addListener.mock.calls.find(
          ([event]) => event === "visibilitychange",
        )?.[1];
        expect(visibilityListener).toBeDefined();
        expect(removeListener).toHaveBeenCalledWith("visibilitychange", visibilityListener);
        document.dispatchEvent(new Event("visibilitychange"));
        expect(client.getQqManagedEventsPage).toHaveBeenCalledTimes(4);
        expect(subscription.subscribe).toHaveBeenCalledTimes(2);
      } finally {
        store.getState().setQqManagedEventsActive(false);
        if (hiddenDescriptor) Object.defineProperty(document, "hidden", hiddenDescriptor);
        else Reflect.deleteProperty(document, "hidden");
        addListener.mockRestore();
        removeListener.mockRestore();
        fetch.mockRestore();
      }
    },
  );

  it.each(["success", "error"] as const)(
    "preserves a same-generation cutoff and fresh owner across same-API reset and late %s",
    async (outcome) => {
      const oldRead = deferred<QqManagedEventsPage>();
      const freshRead = deferred<QqManagedEventsPage>();
      const reboundFollowup = deferred<QqManagedEventsPage>();
      const sequences = Array.from({ length: 100 }, (_, index) => index + 1);
      const freshPage = eventPage(generationA, 2, 200, [
        ...sequences,
        ...sequences.map((sequence) => sequence + 100),
      ]);
      const { client, subscription } = installApi(
        vi
          .fn()
          .mockResolvedValueOnce(eventPage(generationA, 1, 100, sequences))
          .mockReturnValueOnce(oldRead.promise)
          .mockReturnValueOnce(freshRead.promise)
          .mockReturnValueOnce(reboundFollowup.promise),
      );

      store.getState().setQqManagedEventsActive(true);
      await vi.waitFor(() => {
        expect(store.getState().qqManagedEventsPage?.revision).toBe(1);
        expect(store.getState().qqManagedEventsLoading).toBe(false);
      });
      store.getState().clearQqManagedEventsView();
      expect(currentEventRows()).toEqual([]);
      const pendingRead = store.getState().loadQqManagedEvents();
      const joinedRead = store.getState().loadQqManagedEvents();
      await vi.waitFor(() => expect(client.getQqManagedEventsPage).toHaveBeenCalledTimes(2));
      const oldNotice = subscription.subscribe.mock.calls[0][0];
      const oldSubscriptionSignal = subscription.signal;
      const oldReadSignal = client.getQqManagedEventsPage.mock.calls[1][1];
      const oldLifecycle = store.getState().qqManagedLifecycleId;
      store.getState().resetForTests(client);
      const currentRead = store.getState().loadQqManagedEvents();
      await Promise.all([pendingRead, joinedRead]);
      await vi.waitFor(() => {
        expect(subscription.subscribe).toHaveBeenCalledTimes(2);
        expect(client.getQqManagedEventsPage).toHaveBeenCalledTimes(3);
      });
      expect(store.getState().apiClient).toBe(client);
      expect(store.getState().qqManagedLifecycleId).toBe(oldLifecycle + 1);
      expect(oldSubscriptionSignal?.aborted).toBe(true);
      expect(oldReadSignal?.aborted).toBe(true);
      const freshSignal = client.getQqManagedEventsPage.mock.calls[2][1];
      const resultPublications: Array<{ page: QqManagedEventsPage | null; error: string | null }> =
        [];
      const unsubscribe = store.subscribe((state, previous) => {
        if (
          state.qqManagedEventsPage !== previous.qqManagedEventsPage ||
          state.qqManagedEventsError !== previous.qqManagedEventsError
        )
          resultPublications.push({
            page: state.qqManagedEventsPage,
            error: state.qqManagedEventsError,
          });
      });

      try {
        oldNotice({ generation: generationB, latest_sequence: 999, revision: 999 });
        if (outcome === "success") oldRead.resolve(eventPage(generationB, 999, 999, [999]));
        else oldRead.reject(new Error("old reset read"));
        await oldRead.promise.catch(() => {});
        expect(store.getState().qqManagedEventsLoading).toBe(true);
        expect(store.getState().qqManagedEventsPage).toBeNull();
        expect(store.getState().qqManagedEventsError).toBeNull();
        expect(freshSignal?.aborted).toBe(false);
        expect(resultPublications).toEqual([]);
        expect(client.getQqManagedEventsPage).toHaveBeenCalledTimes(3);
        expect(subscription.subscribe).toHaveBeenCalledTimes(2);

        freshRead.resolve(freshPage);
        await currentRead;
        // The mismatch entry rebinds recursively; its outer join retains one follow-up.
        await vi.waitFor(() => expect(client.getQqManagedEventsPage).toHaveBeenCalledTimes(4));
        expect(resultPublications).toHaveLength(1);
        expect(resultPublications[0].error).toBeNull();
        expect(resultPublications[0].page?.revision).toBe(2);
        expect(currentEventRows().map((row) => row.sequence)).toEqual(
          sequences.map((sequence) => sequence + 100),
        );
        expect(store.getState().qqManagedEventsLoading).toBe(true);
        reboundFollowup.resolve(freshPage);
        await vi.waitFor(() => expect(store.getState().qqManagedEventsLoading).toBe(false));
        expect(currentEventRows().map((row) => row.sequence)).toEqual(
          sequences.map((sequence) => sequence + 100),
        );
        expect(store.getState().qqManagedEventsError).toBeNull();
        expect(resultPublications).toHaveLength(2);
        expect(client.getQqManagedEventsPage).toHaveBeenCalledTimes(4);
        expect(subscription.subscribe).toHaveBeenCalledTimes(2);
      } finally {
        unsubscribe();
        store.getState().setQqManagedEventsActive(false);
      }
      expect(subscription.signal?.aborted).toBe(true);
    },
  );
});
