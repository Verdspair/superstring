import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SuperstringApi } from "../../src/web/api";
import { MemoryLibrary } from "../../src/web/screens/library/MemoryLibrary";
import { useSuperstringStore as store } from "../../src/web/store";
import { A, agent, B, memory, policy, setupLibrary } from "./helpers/library-fixture";
import { render } from "./helpers/render-with-providers";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// Observe real actions without replacing their cancellation or publication behavior.
function traceManagement(client: SuperstringApi) {
  const original = {
    loadMemoryManagement: store.getState().loadMemoryManagement,
    cancelMemoryManagementRead: store.getState().cancelMemoryManagementRead,
    resetMemoryManagement: store.getState().resetMemoryManagement,
  };
  const events: Record<string, unknown>[] = [];
  const reads: Promise<boolean>[] = [];
  const signals: AbortSignal[] = [];
  const removeAbortListeners: (() => void)[] = [];
  const identities = new Map<object, number>();
  const identity = (value: object | undefined) => {
    if (!value) return null;
    if (!identities.has(value)) identities.set(value, identities.size + 1);
    return identities.get(value);
  };
  let phase = "initial-A";
  // The private epoch is not exposed. Count actual passthrough reset calls instead.
  let observedResetEpoch = 0;
  let requested: Record<string, unknown> = {};
  const record = (kind: string, detail: Record<string, unknown> = {}) => {
    const state = store.getState();
    events.push({
      sequence: events.length + 1,
      phase,
      kind,
      apiIdentity: identity(state.apiClient),
      fixtureApiIdentity: identity(client),
      agent: state.editorAgentId,
      editorTokenIdentity: identity(state.pageEditor?.token),
      observedResetEpoch,
      page: state.page,
      route: state.settingsRoute,
      settingsView: state.settingsView,
      ready: state.pageEditor?.agent.id === state.editorAgentId && !state.editorLoading,
      visibility: document.visibilityState,
      ...detail,
      stack: new Error(kind).stack,
    });
  };
  const loadMemoryManagement = vi.fn<typeof original.loadMemoryManagement>(
    (page, filters, options) => {
      requested = {
        requestedPage: page,
        filters: { ...filters },
        options: { ...options },
        explicitMetadataRefresh: options?.metadata === true,
      };
      record("load", requested);
      const promise = original.loadMemoryManagement(page, filters, options);
      reads.push(promise);
      return promise;
    },
  );
  const cancelMemoryManagementRead = vi.fn(() => {
    record("cancel");
    original.cancelMemoryManagementRead();
  });
  const resetMemoryManagement = vi.fn(() => {
    observedResetEpoch++;
    record("reset");
    original.resetMemoryManagement();
  });
  const observeMetadata = (kind: string, id: string, signal?: AbortSignal) => {
    record(kind, { ...requested, requestedAgent: id, signalIdentity: identity(signal) });
    if (signal) {
      signals.push(signal);
      const initiationPhase = phase;
      const onAbort = () =>
        record("abort", {
          endpoint: kind,
          requestedAgent: id,
          initiationPhase,
          signalIdentity: identity(signal),
        });
      signal.addEventListener("abort", onAbort, { once: true });
      removeAbortListeners.push(() => signal.removeEventListener("abort", onAbort));
    }
  };
  // Capture implementations before spyOn: a fixture adapter may already be a vi.fn.
  const getPolicy = vi.isMockFunction(client.getPolicy)
    ? client.getPolicy.getMockImplementation()!
    : client.getPolicy;
  const listMemorySessions = vi.isMockFunction(client.listMemorySessions)
    ? client.listMemorySessions.getMockImplementation()!
    : client.listMemorySessions;
  const listMemoryJobs = vi.isMockFunction(client.listMemoryJobs)
    ? client.listMemoryJobs.getMockImplementation()!
    : client.listMemoryJobs;
  const policySpy = vi.spyOn(client, "getPolicy").mockImplementation((id, signal) => {
    observeMetadata("policy", id, signal);
    return getPolicy(id, signal);
  });
  const sessionsSpy = vi.spyOn(client, "listMemorySessions").mockImplementation((id, signal) => {
    observeMetadata("sessions", id, signal);
    return listMemorySessions(id, signal);
  });
  const jobsSpy = vi.spyOn(client, "listMemoryJobs").mockImplementation((id, signal) => {
    observeMetadata("jobs", id, signal);
    return listMemoryJobs(id, signal);
  });
  store.setState({ loadMemoryManagement, cancelMemoryManagementRead, resetMemoryManagement });
  return {
    events,
    reads,
    signals,
    setPhase: (value: string) => {
      phase = value;
    },
    count: (kind: string, atPhase: string) =>
      events.filter((event) => event.kind === kind && event.phase === atPhase).length,
    diagnostic: () => JSON.stringify(events, null, 2),
    restore: () => {
      for (const remove of removeAbortListeners) remove();
      store.setState(original);
      policySpy.mockRestore();
      sessionsSpy.mockRestore();
      jobsSpy.mockRestore();
    },
  };
}
describe("memory management foreground integration", () => {
  it("uses one metadata triple for a visible A-B-A return epoch, then keeps filter and explicit refresh reads", async () => {
    const returnPolicy = deferred<Awaited<ReturnType<SuperstringApi["getPolicy"]>>>();
    const returnSessions = deferred<Awaited<ReturnType<SuperstringApi["listMemorySessions"]>>>();
    const returnJobs = deferred<Awaited<ReturnType<SuperstringApi["listMemoryJobs"]>>>();
    let holdReturnA = false;
    const listMemoryEntries = vi.fn<SuperstringApi["listMemoryEntries"]>(async () => ({
      items: [],
      total: 250,
    }));
    const client = setupLibrary({
      getPolicy: async (id) => (id === A && holdReturnA ? returnPolicy.promise : policy),
      listMemorySessions: async (id) => (id === A && holdReturnA ? returnSessions.promise : []),
      listMemoryJobs: async (id) => (id === A && holdReturnA ? returnJobs.promise : []),
      listMemoryEntries,
    });
    store.setState({ settingsRoute: "long-memory" });
    const trace = traceManagement(client);
    let unmount: (() => void) | undefined;
    const metadataCounts = (phase: string) => ({
      policy: trace.count("policy", phase),
      sessions: trace.count("sessions", phase),
      jobs: trace.count("jobs", phase),
    });
    try {
      expect(document.visibilityState).not.toBe("hidden");
      ({ unmount } = render(<MemoryLibrary active />));
      await waitFor(() => expect(listMemoryEntries).toHaveBeenCalledTimes(1));
      expect(metadataCounts("initial-A"), trace.diagnostic()).toEqual({
        policy: 1,
        sessions: 1,
        jobs: 1,
      });
      const initialToken = store.getState().pageEditor?.token;
      trace.setPhase("visit-B");
      fireEvent.change(screen.getByDisplayValue("Agent A"), { target: { value: B } });
      await waitFor(() => expect(listMemoryEntries).toHaveBeenCalledTimes(2));
      expect(store.getState().editorAgentId).toBe(B);
      expect(metadataCounts("visit-B"), trace.diagnostic()).toEqual({
        policy: 1,
        sessions: 1,
        jobs: 1,
      });
      expect(client.getAgent).toHaveBeenCalledWith(B);

      holdReturnA = true;
      trace.setPhase("return-A");
      fireEvent.change(screen.getByDisplayValue("Agent B"), { target: { value: A } });
      await waitFor(() =>
        expect(trace.count("jobs", "return-A"), trace.diagnostic()).toBeGreaterThan(0),
      );
      // Hold every return metadata response until React has flushed its effects.
      await act(async () => {});
      expect(store.getState().editorAgentId).toBe(A);
      expect(client.getAgent).toHaveBeenCalledWith(A);
      expect(store.getState().pageEditor?.token).not.toBe(initialToken);
      expect(metadataCounts("return-A"), trace.diagnostic()).toEqual({
        policy: 1,
        sessions: 1,
        jobs: 1,
      });
      expect(trace.count("load", "return-A"), trace.diagnostic()).toBe(1);
      const returnLoad = trace.events.find(
        (event) => event.kind === "load" && event.phase === "return-A",
      );
      expect(returnLoad, trace.diagnostic()).toMatchObject({
        agent: A,
        requestedPage: 1,
        filters: { view: "owned" },
        options: { metadata: false, preserveDetail: true },
        explicitMetadataRefresh: false,
        ready: true,
      });
      const returnMetadata = trace.events.filter(
        (event) =>
          event.phase === "return-A" && ["policy", "sessions", "jobs"].includes(String(event.kind)),
      );
      expect(new Set(returnMetadata.map((event) => event.signalIdentity)).size).toBe(1);
      expect(new Set(returnMetadata.map((event) => event.observedResetEpoch)).size).toBe(1);
      expect(returnMetadata.every((event) => event.apiIdentity === event.fixtureApiIdentity)).toBe(
        true,
      );
      expect(
        trace.signals.slice(-3).every((signal) => !signal.aborted),
        trace.diagnostic(),
      ).toBe(true);
      expect(listMemoryEntries).toHaveBeenCalledTimes(2);
      expect(store.getState().memoryManagementLoading).toBe(true);
      holdReturnA = false;
      await act(async () => {
        returnPolicy.resolve({ ...policy, version: 7 });
        returnSessions.resolve([]);
        returnJobs.resolve([]);
        await Promise.all(trace.reads);
      });
      await waitFor(() => expect(listMemoryEntries).toHaveBeenCalledTimes(3));
      expect(listMemoryEntries.mock.calls[2]?.slice(0, 4)).toEqual([A, 0, 100, { view: "owned" }]);
      expect(store.getState().policy?.version).toBe(7);
      expect(store.getState().memoryEntryTotal).toBe(250);
      expect(store.getState().memoryManagementLoading).toBe(false);
      expect(metadataCounts("return-A"), trace.diagnostic()).toEqual({
        policy: 1,
        sessions: 1,
        jobs: 1,
      });
      expect(
        trace.events.filter(
          (event) => event.kind === "abort" && event.initiationPhase === "return-A",
        ),
        trace.diagnostic(),
      ).toEqual([]);

      trace.setPhase("filter");
      const input = screen.getByRole("textbox", { name: "搜索记忆" });
      fireEvent.change(input, { target: { value: "apple" } });
      fireEvent.submit(input.closest("form")!);
      await waitFor(() => expect(listMemoryEntries).toHaveBeenCalledTimes(4));
      fireEvent.click(screen.getByRole("button", { name: "下一页" }));
      await waitFor(() => expect(listMemoryEntries).toHaveBeenCalledTimes(5));
      expect(listMemoryEntries.mock.calls[4]?.slice(0, 4)).toEqual([
        A,
        100,
        100,
        { view: "owned", search: "apple" },
      ]);
      expect(metadataCounts("filter"), trace.diagnostic()).toEqual({
        policy: 0,
        sessions: 0,
        jobs: 0,
      });
      trace.setPhase("explicit-refresh");
      fireEvent.click(screen.getByRole("button", { name: "刷新" }));
      await waitFor(() => expect(listMemoryEntries).toHaveBeenCalledTimes(6));
      expect(metadataCounts("explicit-refresh"), trace.diagnostic()).toEqual({
        policy: 1,
        sessions: 1,
        jobs: 1,
      });
      expect(listMemoryEntries.mock.calls[5]?.slice(0, 4)).toEqual([
        A,
        100,
        100,
        { view: "owned", search: "apple" },
      ]);
      expect(
        trace.events.find((event) => event.kind === "load" && event.phase === "explicit-refresh"),
        trace.diagnostic(),
      ).toMatchObject({ explicitMetadataRefresh: true, options: { metadata: true } });
    } finally {
      try {
        unmount?.();
        store.getState().cancelMemoryManagementRead();
        await act(async () => {
          returnPolicy.resolve(policy);
          returnSessions.resolve([]);
          returnJobs.resolve([]);
          await Promise.all(trace.reads);
        });
      } finally {
        trace.restore();
      }
    }
  });

  it("coalesces identical pending management loads for the same API, owner, editor epoch and filters", async () => {
    const jobs = deferred<Awaited<ReturnType<SuperstringApi["listMemoryJobs"]>>>();
    const listMemoryEntries = vi.fn<SuperstringApi["listMemoryEntries"]>(async () => ({
      items: [],
      total: 23,
    }));
    const client = setupLibrary({ listMemoryJobs: () => jobs.promise, listMemoryEntries });
    store.setState({ settingsRoute: "long-memory" });
    const trace = traceManagement(client);
    trace.setPhase("identical-pending");
    const filters = { view: "owned" as const, scope_key: A, search: "apple" };
    const options = { metadata: false, preserveDetail: true };
    try {
      const first = store.getState().loadMemoryManagement(1, filters, options);
      await waitFor(() => expect(trace.count("jobs", "identical-pending")).toBe(1));
      const second = store.getState().loadMemoryManagement(1, { ...filters }, { ...options });
      await act(async () => {});
      // Release before assertions so either implementation can finish without a race wall.
      let results: boolean[] = [];
      await act(async () => {
        jobs.resolve([]);
        results = await Promise.all([first, second]);
      });
      expect(
        {
          policy: trace.count("policy", "identical-pending"),
          sessions: trace.count("sessions", "identical-pending"),
          jobs: trace.count("jobs", "identical-pending"),
          aborts: trace.count("abort", "identical-pending"),
          pages: listMemoryEntries.mock.calls.length,
          results,
        },
        trace.diagnostic(),
      ).toEqual({ policy: 1, sessions: 1, jobs: 1, aborts: 0, pages: 1, results: [true, true] });
      expect(listMemoryEntries.mock.calls[0]?.slice(0, 4)).toEqual([A, 0, 100, filters]);
      expect(store.getState().memoryEntryTotal).toBe(23);
      expect(store.getState().memoryManagementLoading).toBe(false);
    } finally {
      try {
        store.getState().cancelMemoryManagementRead();
        await act(async () => {
          jobs.resolve([]);
          await Promise.all(trace.reads);
        });
      } finally {
        trace.restore();
      }
    }
  });
  it.each([
    "page",
    "filter",
    "explicit metadata refresh",
    "default fresh metadata",
    "fresh metadata already pending",
    "detail clear",
    "editor token",
    "reset epoch",
    "route",
  ] as const)("replaces pending management work for a changed %s", async (change) => {
    const jobs = deferred<Awaited<ReturnType<SuperstringApi["listMemoryJobs"]>>>();
    const listMemoryEntries = vi.fn<SuperstringApi["listMemoryEntries"]>(async () => ({
      items: [],
      total: 31,
    }));
    const client = setupLibrary({ listMemoryJobs: () => jobs.promise, listMemoryEntries });
    store.setState({ settingsRoute: "long-memory" });
    if (change === "detail clear") store.setState({ memoryEntryDetail: memory });
    const trace = traceManagement(client);
    trace.setPhase(change);
    const filters = { view: "owned" as const, search: "apple" };
    const automatic = { metadata: false, preserveDetail: true };
    try {
      const firstOptions =
        change === "fresh metadata already pending" ? { preserveDetail: true } : automatic;
      const first = store.getState().loadMemoryManagement(1, filters, firstOptions);
      await waitFor(() => expect(trace.count("jobs", change)).toBe(1));
      const firstSignal = trace.signals[0]!;
      expect(firstSignal.aborted).toBe(false);
      if (change === "detail clear") expect(store.getState().memoryEntryDetail).toBe(memory);
      if (change === "editor token") {
        const editor = store.getState().pageEditor!;
        store.setState({ pageEditor: { ...editor, token: {} } });
      }
      if (change === "reset epoch") store.getState().resetMemoryManagement();
      if (change === "route") store.setState({ settingsRoute: "basic" });
      const nextPage = change === "page" ? 2 : 1;
      const nextFilters = change === "filter" ? { ...filters, search: "pear" } : { ...filters };
      const nextOptions =
        change === "explicit metadata refresh"
          ? { metadata: true, preserveDetail: true }
          : change === "default fresh metadata"
            ? { preserveDetail: true }
            : change === "detail clear"
              ? { metadata: false, preserveDetail: false }
              : { ...automatic };
      const second = store.getState().loadMemoryManagement(nextPage, nextFilters, nextOptions);
      expect(firstSignal.aborted, trace.diagnostic()).toBe(true);
      if (change === "detail clear") expect(store.getState().memoryEntryDetail).toBeNull();
      let results: boolean[] = [];
      await act(async () => {
        jobs.resolve([]);
        results = await Promise.all([first, second]);
      });
      expect(results, trace.diagnostic()).toEqual([false, true]);
      expect(
        {
          policy: trace.count("policy", change),
          sessions: trace.count("sessions", change),
          jobs: trace.count("jobs", change),
          aborts: trace.count("abort", change),
        },
        trace.diagnostic(),
      ).toEqual({ policy: 2, sessions: 2, jobs: 2, aborts: 3 });
      expect(listMemoryEntries).toHaveBeenCalledTimes(1);
      expect(listMemoryEntries.mock.calls[0]?.slice(0, 4)).toEqual([
        A,
        (nextPage - 1) * 100,
        100,
        nextFilters,
      ]);
      expect(store.getState().memoryEntryTotal).toBe(31);
      expect(store.getState().memoryManagementLoading).toBe(false);
      // A completed operation is not a cache hit: an automatic reread fetches its page.
      const third = store.getState().loadMemoryManagement(nextPage, nextFilters, nextOptions);
      await expect(third).resolves.toBe(true);
      expect(listMemoryEntries).toHaveBeenCalledTimes(2);
    } finally {
      try {
        store.getState().cancelMemoryManagementRead();
        await act(async () => {
          jobs.resolve([]);
          await Promise.all(trace.reads);
        });
      } finally {
        trace.restore();
      }
    }
  });

  it("replaces identical non-preserving management loads and cancels intervening detail and metadata reads", async () => {
    const jobs = deferred<Awaited<ReturnType<SuperstringApi["listMemoryJobs"]>>>();
    const sources = deferred<Awaited<ReturnType<SuperstringApi["listMemorySources"]>>>();
    const metadata = deferred<Awaited<ReturnType<SuperstringApi["getMemoryAccessMetadata"]>>>();
    const sourceResult: Awaited<ReturnType<SuperstringApi["listMemorySources"]>> = {
      memory_id: memory.id,
      entry_revision: "intervening-detail",
      source_validity: "valid",
      raw_preview: "available",
      checked_sources: 0,
      total: 0,
      nextOffset: null,
      items: [],
    };
    const metadataResult: Awaited<ReturnType<SuperstringApi["getMemoryAccessMetadata"]>> = {
      visibility: "session_private",
      visibility_revision: 2,
      recipient_agent_ids: [],
      origins: memory.origins,
      origin_complete: true,
      source_validity: "valid",
      runtime_eligibility: "available",
      raw_preview: "available",
    };
    let sourceSignal: AbortSignal | undefined;
    let metadataSignal: AbortSignal | undefined;
    const listMemorySources = vi.fn<SuperstringApi["listMemorySources"]>(
      (_agentId, _memoryId, _conversationId, _offset, signal) => {
        sourceSignal = signal;
        return sources.promise;
      },
    );
    const getMemoryAccessMetadata = vi.fn<SuperstringApi["getMemoryAccessMetadata"]>(
      (_agentId, _memoryId, signal) => {
        metadataSignal = signal;
        return metadata.promise;
      },
    );
    const listMemoryEntries = vi.fn<SuperstringApi["listMemoryEntries"]>(async () => ({
      items: [],
      total: 19,
    }));
    const client = setupLibrary({
      listMemoryJobs: () => jobs.promise,
      listMemoryEntries,
      listMemorySources,
      getMemoryAccessMetadata,
    });
    store.setState({ settingsRoute: "long-memory" });
    const trace = traceManagement(client);
    trace.setPhase("repeated-detail-clear");
    const filters = { view: "owned" as const };
    const options = { metadata: false, preserveDetail: false };
    let sourceRead: Promise<void> | undefined;
    let metadataRead: Promise<boolean> | undefined;
    try {
      const first = store.getState().loadMemoryManagement(1, filters, options);
      await waitFor(() => expect(trace.count("jobs", "repeated-detail-clear")).toBe(1));
      // Opening detail advances selectionRequest, invalidating the pending management
      // read. Its replacement must clear the intervening source and metadata readers.
      await store.getState().loadMemoryEntryDetail(memory.id);
      expect(store.getState().memoryEntryDetail?.id).toBe(memory.id);
      sourceRead = store.getState().loadMemorySources();
      metadataRead = store.getState().loadMemoryAccessMetadata(memory.id);
      await waitFor(() => {
        expect(listMemorySources).toHaveBeenCalledTimes(1);
        expect(getMemoryAccessMetadata).toHaveBeenCalledTimes(1);
      });
      expect(sourceSignal?.aborted).toBe(false);
      expect(metadataSignal?.aborted).toBe(false);
      const firstManagementSignal = trace.signals[0]!;
      const second = store.getState().loadMemoryManagement(1, { ...filters }, { ...options });
      expect(
        {
          managementAborted: firstManagementSignal.aborted,
          sourcesAborted: sourceSignal?.aborted,
          metadataAborted: metadataSignal?.aborted,
          detail: store.getState().memoryEntryDetail,
          selection: store.getState().memoryReadSelection,
        },
        trace.diagnostic(),
      ).toEqual({
        managementAborted: true,
        sourcesAborted: true,
        metadataAborted: true,
        detail: null,
        selection: null,
      });
      let results: boolean[] = [];
      await act(async () => {
        jobs.resolve([]);
        sources.resolve(sourceResult);
        metadata.resolve(metadataResult);
        results = await Promise.all([first, second]);
        await Promise.all([sourceRead, metadataRead]);
      });
      expect(results, trace.diagnostic()).toEqual([false, true]);
      expect(trace.count("jobs", "repeated-detail-clear"), trace.diagnostic()).toBe(2);
      expect(listMemoryEntries).toHaveBeenCalledTimes(1);
      expect(store.getState().memorySources).toBeNull();
      expect(store.getState().memoryMetadata).toBeNull();
      expect(store.getState().memoryEntryDetail).toBeNull();
    } finally {
      try {
        store.getState().cancelMemoryManagementRead();
        store.getState().cancelMemoryDetailRead();
        await act(async () => {
          jobs.resolve([]);
          sources.resolve(sourceResult);
          metadata.resolve(metadataResult);
          await Promise.all([...trace.reads, sourceRead, metadataRead]);
        });
      } finally {
        trace.restore();
      }
    }
  });

  it("starts only when visible, aborts hidden work and refreshes once when restored", async () => {
    const original = Object.getOwnPropertyDescriptor(document, "visibilityState");
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    let late!: (value: []) => void;
    let firstSignal: AbortSignal | undefined;
    let jobsCalls = 0;
    const client = setupLibrary({
      listMemoryJobs: (_id, signal) => {
        jobsCalls++;
        if (jobsCalls === 1) {
          firstSignal = signal;
          return new Promise((resolve) => {
            late = resolve;
          });
        }
        return Promise.resolve([]);
      },
    });
    try {
      render(<MemoryLibrary active />);
      await act(async () => {});
      expect(client.getPolicy).not.toHaveBeenCalled();
      expect(client.listMemorySessions).not.toHaveBeenCalled();
      expect(client.listMemoryEntries).not.toHaveBeenCalled();
      expect(jobsCalls).toBe(0);
      act(() => {
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          value: "visible",
        });
        fireEvent(document, new Event("visibilitychange"));
      });
      await waitFor(() => expect(jobsCalls).toBe(1));
      expect(client.listMemoryEntries).not.toHaveBeenCalled();
      act(() => {
        Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
        fireEvent(document, new Event("visibilitychange"));
      });
      expect(firstSignal?.aborted).toBe(true);
      await act(async () => {
        late([]);
        await Promise.resolve();
      });
      expect(client.listMemoryEntries).not.toHaveBeenCalled();
      expect(store.getState().memoryManagementLoading).toBe(false);
      act(() => {
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          value: "visible",
        });
        fireEvent(document, new Event("visibilitychange"));
      });
      await waitFor(() => expect(client.listMemoryEntries).toHaveBeenCalledTimes(1));
      expect(jobsCalls).toBe(2);
      act(() => {
        fireEvent.blur(window);
        fireEvent.focus(window);
      });
      await act(async () => {});
      expect(jobsCalls).toBe(2);
      expect(client.listMemoryEntries).toHaveBeenCalledTimes(1);
    } finally {
      if (original) Object.defineProperty(document, "visibilityState", original);
      else delete (document as { visibilityState?: string }).visibilityState;
    }
  });

  it("loads the new Agent once with default filters after a nondefault page and filter", async () => {
    let finishB!: (value: []) => void;
    const getPolicy = vi.fn(async (_id: string, _signal?: AbortSignal) => ({
      auto_enabled: true,
      every_turns: 20,
      target_chars: 1200,
      version: 1,
    }));
    const listMemorySessions = vi.fn(async (_id: string, _signal?: AbortSignal) => []);
    const listMemoryJobs = vi.fn((id: string) =>
      id === B
        ? new Promise<[]>((resolve) => {
            finishB = resolve;
          })
        : Promise.resolve([]),
    );
    const listMemoryEntries = vi.fn(
      async (
        _id: string,
        _offset?: number,
        _limit?: number,
        _filters?: { scope_key?: string; search?: string; status?: string },
        _signal?: AbortSignal,
      ) => ({ items: [], total: 250 }),
    );
    setupLibrary({ getPolicy, listMemorySessions, listMemoryJobs, listMemoryEntries });
    render(<MemoryLibrary active />);
    await waitFor(() => expect(listMemoryEntries).toHaveBeenCalledTimes(1));
    const search = screen.getByRole("textbox", { name: "搜索记忆" });
    fireEvent.change(search, { target: { value: "narrow" } });
    fireEvent.submit(search.closest("form")!);
    await waitFor(() => expect(listMemoryEntries).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    await waitFor(() => expect(listMemoryEntries).toHaveBeenCalledTimes(3));
    const selector = screen.getByDisplayValue("Agent A");
    fireEvent.change(selector, { target: { value: B } });
    await waitFor(() =>
      expect(listMemoryJobs.mock.calls.filter(([id]) => id === B)).toHaveLength(1),
    );
    expect(getPolicy.mock.calls.filter(([id]) => id === B)).toHaveLength(1);
    expect(listMemorySessions.mock.calls.filter(([id]) => id === B)).toHaveLength(1);
    expect(listMemoryEntries.mock.calls.filter(([id]) => id === B)).toHaveLength(0);
    await act(async () => {
      finishB([]);
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(listMemoryEntries.mock.calls.filter(([id]) => id === B)).toHaveLength(1),
    );
    const bCall = listMemoryEntries.mock.calls.find(([id]) => id === B)!;
    expect(bCall[1]).toBe(0);
    expect(bCall[3]).toEqual({ view: "owned" });
    expect(listMemoryJobs.mock.calls.filter(([id]) => id === B)).toHaveLength(1);
  });

  it("replaces the API through the real page owner, aborting old metadata and ignoring its late result", async () => {
    let finishOld!: (value: []) => void;
    let oldSignal: AbortSignal | undefined;
    const original = setupLibrary({
      listMemoryJobs: (_id, signal) => {
        oldSignal = signal;
        return new Promise((resolve) => {
          finishOld = resolve;
        });
      },
    });
    render(<MemoryLibrary active />);
    await waitFor(() => expect(oldSignal).toBeDefined());
    const nextJobs = vi.fn(async (_id: string, _signal?: AbortSignal) => []);
    const nextEntries = vi.fn(
      async (
        _id: string,
        _offset?: number,
        _limit?: number,
        _filters?: { scope_key?: string; search?: string; status?: string },
        _signal?: AbortSignal,
      ) => ({ items: [], total: 17 }),
    );
    const replacement = { ...original, listMemoryJobs: nextJobs, listMemoryEntries: nextEntries };
    act(() => store.setState({ apiClient: replacement }));
    expect(oldSignal?.aborted).toBe(true);
    await waitFor(() => expect(nextEntries).toHaveBeenCalledTimes(1));
    await act(async () => {
      finishOld([]);
      await Promise.resolve();
    });
    expect(store.getState().memoryEntryTotal).toBe(17);
    expect(store.getState().memoryManagementLoading).toBe(false);
    expect(nextJobs).toHaveBeenCalledTimes(1);
  });

  it("does not poll management metadata while continuously visible", async () => {
    vi.useFakeTimers();
    try {
      const client = setupLibrary();
      render(<MemoryLibrary active />);
      await act(async () => {
        for (let i = 0; i < 8; i++) await Promise.resolve();
      });
      expect(client.listMemoryJobs).toHaveBeenCalledTimes(1);
      await act(async () => {
        vi.advanceTimersByTime(15_000);
        await Promise.resolve();
      });
      expect(client.listMemoryJobs).toHaveBeenCalledTimes(1);
      expect(client.listMemorySessions).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("changes a page filter without reloading metadata or polling", async () => {
    const client = setupLibrary();
    const { unmount } = render(<MemoryLibrary active />);
    try {
      await waitFor(() => expect(client.listMemoryEntries).toHaveBeenCalledTimes(1));
      expect(client.listMemoryJobs).toHaveBeenCalledTimes(1);
      const input = screen.getByRole("textbox", { name: "搜索记忆" });
      fireEvent.change(input, { target: { value: "apple" } });
      fireEvent.submit(input.closest("form")!);
      await waitFor(() => expect(client.listMemoryEntries).toHaveBeenCalledTimes(2));
      expect(client.listMemoryJobs).toHaveBeenCalledTimes(1);
      expect(client.listMemorySessions).toHaveBeenCalledTimes(1);
      expect(client.getPolicy).toHaveBeenCalledTimes(1);
    } finally {
      unmount();
    }
  });
});

describe("memory Agent selection lifecycle", () => {
  it("loads management metadata before its page and keeps both results", async () => {
    let resolveJobs!: (value: []) => void;
    const page = vi.fn().mockResolvedValue({ items: [{ ...memory, id: "entry" }], total: 1 });
    setupLibrary({
      listMemoryJobs: () =>
        new Promise((done) => {
          resolveJobs = done;
        }),
      listMemoryEntries: page,
    });
    store.setState({ memoryEntries: [] });
    const loading = store.getState().loadMemoryManagement(2, { search: "target" });
    await act(async () => {});
    expect(page).not.toHaveBeenCalled();
    resolveJobs([]);
    await expect(loading).resolves.toBe(true);
    expect(page).toHaveBeenCalledTimes(1);
    expect(store.getState().memoryEntries).toEqual([{ ...memory, id: "entry" }]);
    expect(store.getState().memoryManagementLoading).toBe(false);
  });

  it("does not fetch management jobs or sessions when selecting an Agent for editing", async () => {
    const client = setupLibrary();
    const selected = await store.getState().editAgent(agent.id);
    expect(selected).toBe(true);
    expect(client.listMemoryJobs).not.toHaveBeenCalled();
    expect(client.listMemorySessions).not.toHaveBeenCalled();
  });

  it("cancels a replaced filter read and never lets a late adapter overwrite the new page", async () => {
    let late!: (value: { items: never[]; total: number }) => void;
    const signals: AbortSignal[] = [];
    let calls = 0;
    setupLibrary({
      listMemoryEntries: (_id, _offset, _limit, _filters, signal) => {
        if (signal) signals.push(signal);
        calls++;
        return calls === 1
          ? new Promise((resolve) => {
              late = resolve;
            })
          : Promise.resolve({ items: [], total: 7 });
      },
    });
    const first = store.getState().loadMemoryManagement(2, { search: "old" });
    await act(async () => {});
    const second = store.getState().loadMemoryManagement(2, { search: "new" }, { metadata: false });
    expect(signals[0]?.aborted).toBe(true);
    await expect(second).resolves.toBe(true);
    late({ items: [], total: 999 });
    await expect(first).resolves.toBe(false);
    await act(async () => {});
    expect(store.getState().memoryEntryTotal).toBe(7);
    expect(store.getState().memoryManagementLoading).toBe(false);
  });

  it("ignores late management metadata after Agent/API replacement and clears loading", async () => {
    let finishJobs!: (value: []) => void;
    let signal: AbortSignal | undefined;
    setupLibrary({
      listMemoryJobs: (_id, activeSignal) => {
        signal = activeSignal;
        return new Promise((resolve) => {
          finishJobs = resolve;
        });
      },
    });
    const old = store.getState().loadMemoryManagement(1);
    await act(async () => {});
    store.getState().cancelMemoryManagementRead();
    expect(signal?.aborted).toBe(true);
    const replacement = setupLibrary();
    store.setState({ error: "new editor error" });
    finishJobs([]);
    await expect(old).resolves.toBe(false);
    await act(async () => {});
    expect(store.getState().apiClient).toBe(replacement);
    expect(store.getState().error).toBe("new editor error");
    expect(store.getState().memoryManagementLoading).toBe(false);
  });

  it("reports management failure only in its own error without erasing configuration error", async () => {
    setupLibrary({
      listMemoryJobs: async () => {
        throw new Error("management failed");
      },
    });
    store.setState({ error: "configuration failed" });
    await expect(store.getState().loadMemoryManagement(1)).resolves.toBe(false);
    expect(store.getState().memoryManagementError).toContain("management failed");
    expect(store.getState().error).toBe("configuration failed");
    expect(store.getState().memoryManagementLoading).toBe(false);
  });

  it("does not automatically load hidden memory scopes, pages, or policy", async () => {
    const client = setupLibrary();
    const select = vi.fn().mockResolvedValue(false);
    store.setState({
      pageEditor: null,
      editorLoading: false,
      agents: [agent],
      requestAgentNavigation: select,
    });
    render(<MemoryLibrary active={false} />);
    await act(async () => {});
    expect(select).not.toHaveBeenCalled();
    expect(client.getPolicy).not.toHaveBeenCalled();
    expect(client.listMemoryJobs).not.toHaveBeenCalled();
    expect(client.listMemoryEntries).not.toHaveBeenCalled();
  });
  it("does not repeatedly auto-select an Agent after a failed initial read", async () => {
    setupLibrary();
    let calls = 0;
    const select = vi.fn(async () => {
      calls++;
      if (calls > 2) return false;
      store.setState({ editorLoading: true });
      queueMicrotask(() => store.setState({ editorLoading: false, error: "Agent unavailable" }));
      return false;
    });
    store.setState({ pageEditor: null, editorLoading: false, requestAgentNavigation: select });
    render(<MemoryLibrary />);
    await act(async () => {});
    expect(select).toHaveBeenCalledTimes(1);
    expect(store.getState().error).toBe("Agent unavailable");
  });
  it("retains the loaded memory state while inactive", async () => {
    const client = setupLibrary();
    const { rerender } = render(<MemoryLibrary active />);
    await act(async () => {});
    const entries = store.getState().memoryEntries;
    expect(client.listMemoryJobs).toHaveBeenCalledTimes(1);
    expect(client.listMemoryEntries).toHaveBeenCalledTimes(1);
    rerender(<MemoryLibrary active={false} />);
    await act(async () => {});
    expect(store.getState().memoryEntries).toBe(entries);
    expect(client.listMemoryEntries).toHaveBeenCalledTimes(1);
  });
});
