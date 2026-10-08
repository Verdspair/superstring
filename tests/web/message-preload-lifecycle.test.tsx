import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationEventView } from "../../src/shared/contracts/conversation";
import { api, type SuperstringApi } from "../../src/web/api";
import { useConversationEvents } from "../../src/web/features/conversations/use-conversation-events";
import {
  notifyConversationChange,
  resetConversationChangesForTests,
} from "../../src/web/services/conversation-changes";
import { PRELOAD_REGISTRY } from "../../src/web/state/preload-registry";
import { useSuperstringStore as store } from "../../src/web/store";
import { summaryFixture } from "./helpers/chat-fixture";

type EventPage = Awaited<ReturnType<SuperstringApi["getConversationEvents"]>>;
let originalVisibility: PropertyDescriptor | undefined;

function visibility(value: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, value });
}

function event(seq: number, text: string): ConversationEventView {
  const source = { kind: "qq_event" as const, id: `event-${seq}`, revision: "1" };
  return {
    conversationId: "conv-1",
    seq,
    eventKey: source.id,
    kind: "inbound",
    source,
    sources: [source],
    text,
    contentState: "active",
    media: [],
    qqMessageFacts: [],
    participant: { id: "user", label: "User", role: "member" },
    addressing: { reasons: [], mentionIds: [] },
    runId: null,
    outputId: null,
    wake: null,
    deliveryStatus: null,
    messageStatus: null,
    occurredAt: "2026-10-07T00:00:00Z",
    recordedAt: "2026-10-07T00:00:00Z",
  };
}

function page(seq: number, text: string): EventPage {
  return { items: [event(seq, text)], nextSeq: seq, firstSeq: seq, hasMore: false };
}

function deferredPage() {
  let resolve!: (page: EventPage) => void;
  const promise = new Promise<EventPage>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup(overrides: Partial<SuperstringApi>) {
  store.getState().resetForTests({ ...api, ...overrides });
  store.setState({
    summaryById: { "conv-1": { ...summaryFixture("source-1"), id: "conv-1", agentId: "agent-1" } },
  });
}

function changed(seq = 2) {
  notifyConversationChange({
    event: "conversation_changed",
    conversationId: "conv-1",
    seq,
    bindingEpoch: 1,
  });
}

beforeEach(() => {
  originalVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
  visibility("visible");
  resetConversationChangesForTests();
});

afterEach(() => {
  cleanup();
  resetConversationChangesForTests();
  vi.restoreAllMocks();
  if (originalVisibility) Object.defineProperty(document, "visibilityState", originalVisibility);
  else Reflect.deleteProperty(document, "visibilityState");
});

describe("message and preload lifecycle", () => {
  it("settles one trailing read with the latest content after foreground notifications", async () => {
    const old = deferredPage();
    const read = vi
      .fn<SuperstringApi["getConversationEvents"]>()
      .mockReturnValueOnce(old.promise)
      .mockResolvedValue(page(2, "latest"));
    setup({ getConversationEvents: read });
    const { result } = renderHook(() => useConversationEvents("conv-1"));
    act(() => {
      changed();
      changed(3);
    });
    expect(read).toHaveBeenCalledTimes(1);
    await act(async () => {
      old.resolve(page(1, "old"));
    });
    expect(read).toHaveBeenCalledTimes(2);
    expect(result.current.items.map(({ seq, text }) => ({ seq, text }))).toEqual([
      { seq: 2, text: "latest" },
    ]);
  });

  it("starts the first read once on visible resume after initially hidden", async () => {
    visibility("hidden");
    const read = vi
      .fn<SuperstringApi["getConversationEvents"]>()
      .mockResolvedValue(page(1, "first visible read"));
    setup({ getConversationEvents: read });
    const { result } = renderHook(() => useConversationEvents("conv-1"));

    expect(read).toHaveBeenCalledTimes(0);
    expect(result.current.items).toEqual([]);
    visibility("visible");
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await act(async () => {});

    expect(read).toHaveBeenCalledTimes(1);
    expect(result.current.items[0]?.seq).toBe(1);
    expect(result.current.items[0]?.text).toBe("first visible read");
  });

  it("preserves loaded content while inactive and reads new content once when enabled", async () => {
    const read = vi
      .fn<SuperstringApi["getConversationEvents"]>()
      .mockResolvedValueOnce(page(1, "loaded"))
      .mockResolvedValue(page(2, "new"));
    setup({ getConversationEvents: read });
    const { result, rerender } = renderHook(
      ({ enabled }) => useConversationEvents("conv-1", undefined, { enabled }),
      { initialProps: { enabled: true } },
    );
    await act(async () => {});
    rerender({ enabled: false });
    act(() => {
      changed();
    });
    expect(result.current.items[0]?.text).toBe("loaded");
    expect(read).toHaveBeenCalledTimes(1);
    rerender({ enabled: true });
    await act(async () => {});
    expect(read).toHaveBeenCalledTimes(2);
    expect(result.current.items[0]?.text).toBe("new");
  });

  it("retains content across five hidden cycles with one read on visibility resume", async () => {
    let seq = 0;
    const read = vi
      .fn<SuperstringApi["getConversationEvents"]>()
      .mockImplementation(async () => page(++seq, `message-${seq}`));
    setup({ getConversationEvents: read });
    const { result } = renderHook(() => useConversationEvents("conv-1"));
    await act(async () => {});
    for (let cycle = 1; cycle <= 5; cycle++) {
      visibility("hidden");
      act(() => {
        document.dispatchEvent(new Event("visibilitychange"));
        changed(cycle + 1);
      });
      expect(result.current.items[0]?.seq).toBe(cycle);
      expect(read).toHaveBeenCalledTimes(cycle);
      visibility("visible");
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect(read).toHaveBeenCalledTimes(cycle + 1);
      expect(result.current.items[0]?.text).toBe(`message-${cycle + 1}`);
    }
  });

  it("rejects the old API response after the current scope starts a new read", async () => {
    const old = deferredPage();
    setup({
      getConversationEvents: vi
        .fn<SuperstringApi["getConversationEvents"]>()
        .mockReturnValue(old.promise),
    });
    const { result } = renderHook(() => useConversationEvents("conv-1"));
    const fresh = vi
      .fn<SuperstringApi["getConversationEvents"]>()
      .mockResolvedValue(page(2, "current API"));
    await act(async () => {
      store.setState({ apiClient: { ...api, getConversationEvents: fresh } });
    });
    expect(result.current.items[0]?.text).toBe("current API");
    await act(async () => {
      old.resolve(page(1, "late old API"));
    });
    expect(result.current.items[0]?.text).toBe("current API");
    expect(fresh).toHaveBeenCalledTimes(1);
  });

  it("reuses an authoritative empty schemes preload without repeating reads", async () => {
    const schemes = vi.fn<SuperstringApi["listQqSchemes"]>().mockResolvedValue([]);
    const bindings = vi.fn<SuperstringApi["listQqBindings"]>().mockResolvedValue([]);
    setup({ listQqSchemes: schemes, listQqBindings: bindings });
    const preload = PRELOAD_REGISTRY.find((entry) => entry.space === "schemes");
    expect(preload?.loadData).toBeDefined();
    await act(async () => {
      await preload?.loadData?.();
    });
    expect(store.getState().qqSchemesLoaded).toBe(true);
    await act(async () => {
      await store.getState().loadQqSchemes({ background: true });
    });
    expect(schemes).toHaveBeenCalledTimes(1);
    expect(store.getState().qqSchemes).toEqual([]);
  });
});
