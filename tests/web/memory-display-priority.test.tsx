import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemoryScopeView } from "../../src/shared/contracts";
import type { SuperstringApi } from "../../src/web/api";
import { MemoryLibrary } from "../../src/web/screens/library/MemoryLibrary";
import { useSuperstringStore as store } from "../../src/web/store";
import { A, B, binding, setupLibrary } from "./helpers/library-fixture";

const groupScope = (agentId: string, peerId: string): MemoryScopeView => ({
  scope_key: JSON.stringify(["qq", "10001", "group", peerId, agentId]),
  count: 1,
  active_count: 1,
  read_scope_keys: null,
  write_scope_key: agentId,
  pending: null,
  binding: null,
  latest_job: null,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("memory display priority", () => {
  it("shows memory partitions and entries before optional QQ metadata without granting sharing", async () => {
    const bindings = deferred<Awaited<ReturnType<SuperstringApi["listQqBindings"]>>>();
    const owner = deferred<Awaited<ReturnType<SuperstringApi["getQqOwner"]>>>();
    const privateScope: MemoryScopeView = {
      ...groupScope(A, binding.peer_id),
      scope_key: JSON.stringify(["qq", binding.account_id, "private", binding.peer_id, A]),
      binding: {
        id: binding.id,
        revision: binding.revision,
        memory_batch_size: 20,
        paused: false,
        enabled: true,
      },
    };
    const client = setupLibrary({
      listMemoryScopes: vi.fn().mockResolvedValue([privateScope]),
      listQqBindings: vi.fn(() => bindings.promise),
      getQqOwner: vi.fn(() => owner.promise),
    });
    store.setState({ settingsRoute: "long-memory" });
    const view = render(<MemoryLibrary />);
    try {
      const partition = await screen.findByRole("button", { name: /20002/ });
      expect(await screen.findByText("Memory one")).toBeTruthy();
      expect(client.listQqBindings).toHaveBeenCalledTimes(1);
      expect(client.getQqOwner).toHaveBeenCalledTimes(1);
      fireEvent.click(partition);
      expect(screen.queryByRole("switch", { name: /共享/ })).toBeNull();
    } finally {
      view.unmount();
      await act(async () => {
        bindings.resolve([binding]);
        owner.resolve({
          configured: true,
          account_id: binding.account_id,
          peer_id: binding.peer_id,
          revision: 1,
        });
      });
    }
  });

  it("rejects a late old-Agent scope after selecting the other Agent through its dropdown", async () => {
    const old = deferred<MemoryScopeView[]>();
    setupLibrary({
      listMemoryScopes: vi.fn((agentId: string) =>
        agentId === A ? old.promise : Promise.resolve([groupScope(B, "40004")]),
      ),
    });
    store.setState({ settingsRoute: "long-memory" });
    render(<MemoryLibrary />);
    await act(async () => {});
    fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: B } });
    await waitFor(() => expect(store.getState().pageEditor?.agent.id).toBe(B));
    expect(await screen.findByRole("button", { name: /40004/ })).toBeTruthy();
    await act(async () => old.resolve([groupScope(A, "30003")]));
    expect(screen.getByRole("button", { name: /40004/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /30003/ })).toBeNull();
  });

  it("does not relabel settled A partitions as B while B is still being read", async () => {
    const current = deferred<MemoryScopeView[]>();
    setupLibrary({
      listMemoryScopes: vi.fn((agentId: string) =>
        agentId === A ? Promise.resolve([groupScope(A, "30003")]) : current.promise,
      ),
    });
    store.setState({ settingsRoute: "long-memory" });
    const view = render(<MemoryLibrary />);
    try {
      expect(await screen.findByRole("button", { name: /30003/ })).toBeTruthy();
      fireEvent.change(screen.getAllByRole("combobox")[0], { target: { value: B } });
      await waitFor(() => expect(store.getState().pageEditor?.agent.id).toBe(B));
      expect(screen.queryByRole("button", { name: /30003/ })).toBeNull();
      await act(async () => current.resolve([groupScope(B, "40004")]));
      expect(await screen.findByRole("button", { name: /40004/ })).toBeTruthy();
    } finally {
      view.unmount();
      current.resolve([]);
    }
  });
});
