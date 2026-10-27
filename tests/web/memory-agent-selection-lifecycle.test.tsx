import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryLibrary } from "../../src/web/screens/library/MemoryLibrary";
import { useSuperstringStore as store } from "../../src/web/store";
import { agent, B, setupLibrary } from "./helpers/library-fixture";
import { render } from "./helpers/render-with-providers";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
describe("memory management foreground integration", () => {
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
    expect(bCall[3]).toEqual({});
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
    const page = vi.fn().mockResolvedValue({ items: [{ id: "entry" }], total: 1 });
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
    expect(store.getState().memoryEntries).toEqual([{ id: "entry" }]);
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
