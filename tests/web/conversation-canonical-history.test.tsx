import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserStateConfig } from "../../src/shared/contracts";
import type {
  ConversationEventView,
  ConversationSummary,
} from "../../src/shared/contracts/conversation";
import { api, type SuperstringApi } from "../../src/web/api";
import { createBrowserStateStorage } from "../../src/web/browser-state";
import { useConversationEvents } from "../../src/web/features/conversations/use-conversation-events";
import {
  notifyConversationChange,
  resetConversationChangesForTests,
} from "../../src/web/services/conversation-changes";
import { loadQqEventsCache, saveQqEventsCache } from "../../src/web/services/page-snapshot-cache";
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
  try {
    sessionStorage.clear();
    localStorage.clear();
  } catch {}
  if (originalVisibilityDesc) {
    Object.defineProperty(document, "visibilityState", originalVisibilityDesc);
  }
});

const mockConfig: BrowserStateConfig = {
  secret: "test-secret-key-32-chars-long-!",
  storage_keys: {
    session: "superstring-session",
    agent: "superstring-agent",
  },
};

const convSummary = (
  id: string,
  agentId = "agent-1",
  channel: ConversationSummary["channel"] = "onebot11",
  bindingEpoch = 1,
): ConversationSummary => ({
  id,
  sourceId: id.replace("conv-", "binding-"),
  channel,
  topology: channel === "onebot11" ? "shared" : "direct",
  agentId,
  title: `Title ${id}`,
  bindingEpoch,
  participants: [],
  updatedAt: "2026-10-10T00:00:00.000Z",
  lastSeq: 1,
  consumedSeq: 1,
});

const event = (
  seq: number,
  text = `msg-${seq}`,
  physicalFact: string | null = null,
): ConversationEventView => ({
  seq,
  eventKey: `event-${seq}`,
  conversationId: "conv-qq-1",
  kind: "inbound",
  source: { kind: "qq_event", id: `event-${seq}`, revision: "1" },
  sources: [{ kind: "qq_event", id: `event-${seq}`, revision: "1" }],
  outputId: null,
  runId: null,
  wake: null,
  text: physicalFact ?? text,
  contentState: "active",
  media: [],
  qqMessageFacts: [],
  addressing: { reasons: ["private"], mentionIds: [] },
  deliveryStatus: null,
  messageStatus: null,
  participant: { id: "person", label: "User", role: "member" },
  occurredAt: "2026-10-10T00:00:00Z",
  recordedAt: "2026-10-10T00:00:00Z",
});

function setupApi(overrides: Partial<SuperstringApi>) {
  useSuperstringStore.getState().resetForTests({
    ...api,
    ...overrides,
  });
}

const settle = async (rounds = 6) => {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
};

describe("conversation canonical history read contract", () => {
  it("hidden tail settles in exactly one empty tail read, never loops, and a later visible seq is still read", async () => {
    const reads = vi.fn<SuperstringApi["getConversationEvents"]>();
    let tailReads = 0;
    reads.mockImplementation(async (_id, params) => {
      if (!params || typeof params === "number" || params.direction === "latest") {
        return { items: [event(1), event(2), event(3)], nextSeq: 3, hasMore: false };
      }
      if (params.direction === "after" && params.afterSeq === 3) {
        tailReads += 1;
        if (tailReads === 1) {
          // Physical seqs 4..7 exist but are all hidden by the canonical anti-filter.
          return { items: [], nextSeq: 0, hasMore: false };
        }
        // A new visible event lands at seq 8 after the hidden run.
        return { items: [event(8)], nextSeq: 8, hasMore: false };
      }
      return { items: [], nextSeq: 0, hasMore: false };
    });
    setupApi({ getConversationEvents: reads });

    const { result } = renderHook(() =>
      useConversationEvents("conv-qq-1", undefined, { refreshMs: 60000 }),
    );
    await settle();
    expect(result.current.items.map((row) => row.seq)).toEqual([1, 2, 3]);
    expect(reads).toHaveBeenCalledTimes(1);

    // Physical lastSeq 7 > visible tail 3: hidden tail only. Cursor must be the last
    // visible seq, one empty page settles, and no further read may be issued.
    await act(async () => {
      notifyConversationChange({
        event: "conversation_changed",
        conversationId: "conv-qq-1",
        seq: 7,
        bindingEpoch: 1,
      });
    });
    await settle();
    expect(reads).toHaveBeenCalledTimes(2);
    expect(reads.mock.calls[1]?.[1]).toMatchObject({ direction: "after", afterSeq: 3 });
    expect(result.current.items.map((row) => row.seq)).toEqual([1, 2, 3]);
    await settle(10);
    expect(reads).toHaveBeenCalledTimes(2);

    // A later visible event above the hidden run must still be read and appended once.
    await act(async () => {
      notifyConversationChange({
        event: "conversation_changed",
        conversationId: "conv-qq-1",
        seq: 9,
        bindingEpoch: 1,
      });
    });
    await settle();
    expect(reads).toHaveBeenCalledTimes(3);
    expect(result.current.items.map((row) => row.seq)).toEqual([1, 2, 3, 8]);
    await settle(10);
    expect(reads).toHaveBeenCalledTimes(3);
  });

  it("initial authoritative latest replaces cached legacy send-alias rows wholesale", async () => {
    const storage = createBrowserStateStorage(mockConfig, sessionStorage);
    // seq 4/5 are legacy dup aliases of the seq-3 send: distinct seqs, same physical fact.
    await saveQqEventsCache(storage, "conv-qq-1", "agent-1", 1, [
      event(1),
      event(2),
      event(3, "send-body-A"),
      event(4, "send-body-A"),
      event(5, "send-body-A"),
    ]);

    let releaseInitial!: (value: unknown) => void;
    const deferredInitial = new Promise((resolve) => {
      releaseInitial = resolve;
    });
    let initialServed = false;
    const reads = vi.fn<SuperstringApi["getConversationEvents"]>();
    reads.mockImplementation(async () => {
      if (!initialServed) {
        initialServed = true;
        await deferredInitial;
      }
      // Server already applies the canonical anti-filter: latest page has no alias rows.
      return { items: [event(1), event(2), event(3, "send-body-A")], nextSeq: 3, hasMore: false };
    });
    setupApi({ getConversationEvents: reads });
    useSuperstringStore.setState({
      sessionStateStorage: storage,
      summaryById: { "conv-qq-1": convSummary("conv-qq-1") },
    });

    const { result } = renderHook(() =>
      useConversationEvents("conv-qq-1", undefined, { refreshMs: 60000 }),
    );
    await vi.waitFor(() => {
      expect(result.current.items).toHaveLength(5);
    });
    await act(async () => {
      releaseInitial(null);
    });
    await vi.waitFor(() => {
      expect(result.current.items.map((row) => row.seq)).toEqual([1, 2, 3]);
    });
    expect(result.current.items.filter((row) => row.text === "send-body-A")).toHaveLength(1);
    // Hook saves are fire-and-forget; the encrypted write lands after a few microtasks.
    await vi.waitFor(async () => {
      const saved = await loadQqEventsCache(storage, "conv-qq-1", "agent-1", 1);
      expect(saved?.map((row) => row.seq)).toEqual([1, 2, 3]);
    });
  });

  it("refresh with a shrunk tail (server hides legacy alias) drops cached alias rows without union retain", async () => {
    const storage = createBrowserStateStorage(mockConfig, sessionStorage);
    await saveQqEventsCache(storage, "conv-qq-1", "agent-1", 1, [
      event(1),
      event(2),
      event(3, "send-body-A"),
      event(4, "send-body-A"),
      event(5, "send-body-A"),
    ]);

    const reads = vi.fn<SuperstringApi["getConversationEvents"]>();
    reads.mockImplementation(async (_id, params) => {
      if (!params || typeof params === "number" || params.direction === "latest") {
        // First authoritative read still contains the alias rows (not yet hidden).
        return {
          items: [
            event(1),
            event(2),
            event(3, "send-body-A"),
            event(4, "send-body-A"),
            event(5, "send-body-A"),
          ],
          nextSeq: 5,
          hasMore: false,
        };
      }
      // Refresh after the server started hiding: fewer high seqs, shrunk tail.
      return { items: [event(1), event(2), event(3, "send-body-A")], nextSeq: 3, hasMore: false };
    });
    setupApi({ getConversationEvents: reads });
    useSuperstringStore.setState({
      sessionStateStorage: storage,
      summaryById: { "conv-qq-1": convSummary("conv-qq-1") },
    });

    const { result } = renderHook(() =>
      useConversationEvents("conv-qq-1", undefined, { refreshMs: 60000 }),
    );
    await vi.waitFor(() => {
      expect(result.current.items.map((row) => row.seq)).toEqual([1, 2, 3, 4, 5]);
    });

    await act(async () => {
      notifyConversationChange({
        event: "conversation_changed",
        conversationId: "conv-qq-1",
        seq: 5,
        bindingEpoch: 1,
      });
    });
    await vi.waitFor(() => {
      expect(result.current.items.map((row) => row.seq)).toEqual([1, 2, 3]);
    });
    // One physical fact, one row: no logical duplicate survives the shrunk-tail refresh.
    expect(result.current.items.filter((row) => row.text === "send-body-A")).toHaveLength(1);
    expect(reads.mock.calls[1]?.[1]).toMatchObject({ direction: "after", afterSeq: 0 });
    // Hook saves are fire-and-forget; the encrypted write lands after a few microtasks.
    await vi.waitFor(async () => {
      const saved = await loadQqEventsCache(storage, "conv-qq-1", "agent-1", 1);
      expect(saved?.map((row) => row.seq)).toEqual([1, 2, 3]);
    });
  });
});
