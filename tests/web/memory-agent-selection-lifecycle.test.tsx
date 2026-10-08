import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryLibrary } from "../../src/web/screens/library/MemoryLibrary";
import { useSuperstringStore as store } from "../../src/web/store";
import { agent, setupLibrary } from "./helpers/library-fixture";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
describe("memory Agent selection lifecycle", () => {
  it("does not erase the displayed memory page when slower maintenance metadata arrives", async () => {
    let resolveJobs!: (value: []) => void;
    setupLibrary({
      listMemoryJobs: () =>
        new Promise((done) => {
          resolveJobs = done;
        }),
    });
    const reload = store.getState().reloadMemory();
    await store.getState().loadMemoryPage(1);
    const displayed = store.getState().memoryEntries;
    expect(displayed.length).toBeGreaterThan(0);
    resolveJobs([]);
    await reload;
    expect(store.getState().memoryEntries).toEqual(displayed);
  });

  it("does not automatically load hidden memory scopes, pages, or policy", async () => {
    setupLibrary();
    const page = vi.fn().mockResolvedValue(undefined);
    const policy = vi.fn().mockResolvedValue(undefined);
    const select = vi.fn();
    store.setState({
      pageEditor: null,
      editorLoading: false,
      agents: [agent],
      loadMemoryPage: page,
      loadMemoryPolicy: policy,
      requestAgentNavigation: select,
    });
    render(<MemoryLibrary active={false} />);
    await act(async () => {});
    expect(select).not.toHaveBeenCalled();
    expect(page).not.toHaveBeenCalled();
    expect(policy).not.toHaveBeenCalled();
  });
  it("does not repeatedly auto-select an Agent after a failed initial read", async () => {
    setupLibrary();
    let calls = 0;
    const select = vi.fn(() => {
      calls++;
      if (calls > 2) return;
      store.setState({ editorLoading: true });
      queueMicrotask(() => store.setState({ editorLoading: false, error: "Agent unavailable" }));
    });
    store.setState({ pageEditor: null, editorLoading: false, requestAgentNavigation: select });
    render(<MemoryLibrary />);
    await act(async () => {});
    expect(select).toHaveBeenCalledTimes(1);
    expect(store.getState().error).toBe("Agent unavailable");
  });
  it("retains the loaded memory state while inactive", async () => {
    setupLibrary();
    const entries = store.getState().memoryEntries;
    const page = vi.fn().mockResolvedValue(undefined);
    store.setState({ loadMemoryPage: page });
    const { rerender } = render(<MemoryLibrary active />);
    await act(async () => {});
    rerender(<MemoryLibrary active={false} />);
    await act(async () => {});
    expect(store.getState().memoryEntries).toBe(entries);
    expect(page).toHaveBeenCalledTimes(1);
  });
});
