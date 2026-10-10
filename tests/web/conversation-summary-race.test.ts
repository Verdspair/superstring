import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationSummary } from "../../src/shared/contracts/conversation";
import type { ConversationChangeEvent, SuperstringApi } from "../../src/web/api";
import {
  resetConversationChangesForTests,
  startConversationChanges,
} from "../../src/web/services/conversation-changes";
import { useSuperstringStore as store } from "../../src/web/store";

// Real store, real directory actions: refreshConversationSummary and rememberConversation
// run exactly as production (see src/web/features/conversations/directory-state.ts).
// Only the apiClient boundary is replaced with controlled deferreds; no timers, no sleeps,
// no real HTTP, fresh conversation ids per case.

const summary = (
  id: string,
  overrides: Partial<ConversationSummary> = {},
): ConversationSummary => ({
  id,
  channel: "onebot11",
  topology: "direct",
  sourceId: `src-${id}`,
  agentId: "agent-1",
  bindingEpoch: 1,
  title: `title-${id}`,
  participants: [],
  updatedAt: "2026-10-10T00:00:00Z",
  lastSeq: 1,
  consumedSeq: 0,
  ...overrides,
});

interface DeferredSummary {
  promise: Promise<ConversationSummary>;
  resolve: (value: ConversationSummary) => void;
  reject: (reason: unknown) => void;
}

const deferredSummary = (): DeferredSummary => {
  let resolve!: DeferredSummary["resolve"];
  let reject!: DeferredSummary["reject"];
  const promise = new Promise<ConversationSummary>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

beforeEach(() => {
  localStorage.clear();
  resetConversationChangesForTests();
});

afterEach(() => {
  resetConversationChangesForTests();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("conversation summary refresh races", () => {
  it("a same-conversation older read resolving last must not roll back the newer summary", async () => {
    const id = "sum-race-older-last";
    const older = deferredSummary();
    const newer = deferredSummary();
    const gate = [older.promise, newer.promise];
    let call = 0;
    store.getState().resetForTests({
      getConversation: () => gate[call++],
    } as unknown as SuperstringApi);

    // Two in-flight reads for the same conversation: the request order is older first,
    // but the server answers the newer read before the older one settles.
    const first = store.getState().refreshConversationSummary(id);
    const second = store.getState().refreshConversationSummary(id);

    newer.resolve(
      summary(id, { lastSeq: 2, updatedAt: "2026-10-10T02:00:00Z", title: "newer-state" }),
    );
    expect(await second).toBe(true);
    expect(store.getState().summaryById[id]?.lastSeq).toBe(2);

    older.resolve(
      summary(id, { lastSeq: 1, updatedAt: "2026-10-10T01:00:00Z", title: "older-state" }),
    );
    expect(await first).toBe(true);

    // The late older response must not roll back summary/updatedAt to stale values.
    expect(store.getState().summaryById[id]?.lastSeq).toBe(2);
    expect(store.getState().summaryById[id]?.updatedAt).toBe("2026-10-10T02:00:00Z");
    expect(store.getState().summaryById[id]?.title).toBe("newer-state");
  });

  it("a captured older API response resolving after a remembered newer summary must not overwrite it", async () => {
    const id = "sum-race-captured-stale";
    const stale = deferredSummary();
    store.getState().resetForTests({
      getConversation: () => stale.promise,
    } as unknown as SuperstringApi);

    // The read is captured in flight; a live path (list reload or remembered snapshot)
    // installs the newer summary before the stale response arrives.
    const pending = store.getState().refreshConversationSummary(id);
    const fresh = summary(id, {
      lastSeq: 7,
      updatedAt: "2026-10-10T03:00:00Z",
      title: "fresh-remembered",
    });
    store.getState().rememberConversation(fresh);
    expect(store.getState().summaryById[id]?.lastSeq).toBe(7);

    stale.resolve(
      summary(id, { lastSeq: 3, updatedAt: "2026-10-10T01:00:00Z", title: "stale-response" }),
    );
    expect(await pending).toBe(true);

    expect(store.getState().summaryById[id]?.lastSeq).toBe(7);
    expect(store.getState().summaryById[id]?.updatedAt).toBe("2026-10-10T03:00:00Z");
    expect(store.getState().summaryById[id]?.title).toBe("fresh-remembered");
  });

  it("parallel refreshes of different conversations keep both summaries", async () => {
    const idA = "sum-race-conv-a";
    const idB = "sum-race-conv-b";
    const gateA = deferredSummary();
    const gateB = deferredSummary();
    const gates = new Map<string, Promise<ConversationSummary>>([
      [idA, gateA.promise],
      [idB, gateB.promise],
    ]);
    store.getState().resetForTests({
      getConversation: (id: string) => gates.get(id)!,
    } as unknown as SuperstringApi);

    const readingA = store.getState().refreshConversationSummary(idA);
    const readingB = store.getState().refreshConversationSummary(idB);

    // B settles before A; neither conversation may lose its summary.
    gateB.resolve(summary(idB, { lastSeq: 4, updatedAt: "2026-10-10T04:00:00Z", title: "conv-b" }));
    gateA.resolve(summary(idA, { lastSeq: 9, updatedAt: "2026-10-10T09:00:00Z", title: "conv-a" }));
    expect(await readingB).toBe(true);
    expect(await readingA).toBe(true);

    expect(store.getState().summaryById[idA]?.lastSeq).toBe(9);
    expect(store.getState().summaryById[idB]?.lastSeq).toBe(4);
    expect(store.getState().summaryById[idA]?.title).toBe("conv-a");
    expect(store.getState().summaryById[idB]?.title).toBe("conv-b");
    expect(store.getState().directoryIds).toEqual(expect.arrayContaining([idA, idB]));
  });

  it("a visible notification burst issues exactly one bounded summary read per change (documented baseline)", async () => {
    const id = "sum-race-burst";
    let seq = 0;
    const getConversation = vi.fn((cid: string) => {
      seq += 1;
      return Promise.resolve(summary(cid, { lastSeq: seq }));
    });
    let sseCallback: ((event: ConversationChangeEvent) => void) | null = null;
    const subscribe = vi.fn(async (onEvent: (event: ConversationChangeEvent) => void) => {
      sseCallback = onEvent;
      await new Promise<void>(() => {}); // stream stays open for the whole test
    });
    store.getState().resetForTests({
      getConversation,
      subscribeConversationChanges: subscribe,
    } as unknown as SuperstringApi);

    const cleanup = startConversationChanges(store.getState().apiClient);
    try {
      await vi.waitFor(() => expect(sseCallback).toBeTruthy());
      await sseCallback!({ event: "ready", ready: true });

      // Baseline (current source, no coalescing): every visible conversation_changed
      // notification triggers exactly one bounded getConversation read for that id.
      for (let i = 1; i <= 5; i += 1) {
        await sseCallback!({
          event: "conversation_changed",
          conversationId: id,
          seq: i,
          bindingEpoch: 1,
        });
      }
      await vi.waitFor(() => expect(getConversation).toHaveBeenCalledTimes(5));
      expect(getConversation.mock.calls.every((callArgs) => callArgs[0] === id)).toBe(true);

      // Each read applies its own server answer; the final state carries the highest seq.
      await vi.waitFor(() => expect(store.getState().summaryById[id]?.lastSeq).toBe(5));
    } finally {
      cleanup();
    }
  });

  it("an in-flight read must not write to store after resetForTests or API client switch", async () => {
    const id = "sum-race-api-switch";
    const pending = deferredSummary();
    store.getState().resetForTests({
      getConversation: () => pending.promise,
    } as unknown as SuperstringApi);

    const callPromise = store.getState().refreshConversationSummary(id);

    // Client switch / reset occurs while read is still in flight
    store.getState().resetForTests({
      getConversation: () => Promise.resolve(summary(id, { title: "new-client" })),
    } as unknown as SuperstringApi);

    // Old in-flight read resolves
    pending.resolve(summary(id, { lastSeq: 5, title: "stale-client-response" }));
    expect(await callPromise).toBe(true);

    // The stale response from the previous client must not pollute the new store state
    expect(store.getState().summaryById[id]).toBeUndefined();
  });

  it("same-seq updates with fresh title or status apply when no newer read or remember intervened", async () => {
    const id = "sum-race-same-seq";
    store.getState().rememberConversation(summary(id, { lastSeq: 3, title: "initial-title" }));

    const refresh = deferredSummary();
    store.getState().resetForTests({
      getConversation: () => refresh.promise,
    } as unknown as SuperstringApi);

    // Re-install the baseline under the new test client
    store.getState().rememberConversation(summary(id, { lastSeq: 3, title: "initial-title" }));

    const callPromise = store.getState().refreshConversationSummary(id);
    refresh.resolve(summary(id, { lastSeq: 3, title: "updated-title-same-seq" }));
    expect(await callPromise).toBe(true);

    expect(store.getState().summaryById[id]?.lastSeq).toBe(3);
    expect(store.getState().summaryById[id]?.title).toBe("updated-title-same-seq");
  });
});
