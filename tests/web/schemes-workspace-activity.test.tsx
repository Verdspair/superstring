import { act, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QqConnectionTab } from "../../src/web/screens/connections/qq-app-management";
import { SchemesWorkspace } from "../../src/web/screens/connections/SchemesWorkspace";
import { useSuperstringStore as store } from "../../src/web/store";
import { setupLibrary } from "./helpers/library-fixture";
import { render } from "./helpers/render-with-providers";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("QQ task resource lifecycle", () => {
  it("does not query accounts on the real disabled connection-to-events entry", async () => {
    setupLibrary();
    const listAccounts = vi.fn(async () => {
      throw new Error("accounts must not be queried");
    });
    store.setState({
      apiClient: {
        ...store.getState().apiClient,
        listQqManagedAccounts: listAccounts,
        getQqManagedConfig: async () => ({
          revision: "disabled",
          config: { version: 1, enabled: false },
        }),
        getQqManagedResources: async () => ({
          revision: "",
          status: "missing",
          root: null,
          diagnostic_code: "runtime_not_selected",
        }),
        getQqManagedStatus: async () => ({
          apply: "ready",
          ownership: "none",
          process: "stopped",
          phase: "stopped",
          core_ready: false,
          network_apply: "not_configured",
          transport_phase: "idle",
          diagnostic_code: null,
        }),
      },
    });
    const view = render(<QqConnectionTab active task="connection" />);
    await act(async () => {});
    expect(listAccounts).not.toHaveBeenCalled();
    expect(store.getState().qqManagedAccountsAvailability).toBe("unavailable");
    view.rerender(<QqConnectionTab active task="events" />);
    await act(async () => {});
    expect(listAccounts).not.toHaveBeenCalled();
    expect(store.getState().qqManagedAccountsError).toBeNull();
  });

  it("loads managed resources only for the active connection task", async () => {
    setupLibrary();
    const load = vi.fn().mockResolvedValue(undefined);
    store.setState({ loadQqManagedResources: load });
    const view = render(<QqConnectionTab active task="events" />);
    await act(async () => {});
    expect(load).not.toHaveBeenCalled();
    view.rerender(<QqConnectionTab active task="connection" />);
    await act(async () => {});
    expect(load).toHaveBeenCalledTimes(1);
    view.rerender(<QqConnectionTab active task="events" />);
    await act(async () => {});
    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe("QQ scheme workspace activity", () => {
  it("keeps QQ scheme catalog reads inactive until the workspace activates", async () => {
    setupLibrary();
    const loadSchemes = vi.fn().mockResolvedValue(true);
    const loadBindings = vi.fn().mockResolvedValue(undefined);
    store.setState({
      settingsRoute: "qq-app-schemes",
      loadQqSchemes: loadSchemes,
      loadQqBindings: loadBindings,
    });

    const view = render(<SchemesWorkspace active={false} />);
    await act(async () => {});
    expect(loadSchemes).toHaveBeenCalledTimes(0);
    expect(loadBindings).toHaveBeenCalledTimes(0);

    view.rerender(<SchemesWorkspace active />);
    await act(async () => {});
    expect(loadSchemes).toHaveBeenCalledTimes(1);
    expect(loadBindings).toHaveBeenCalledTimes(1);
  });

  it("keeps QQ connection reads inactive until the workspace activates", async () => {
    setupLibrary();
    const loadAccess = vi.fn().mockResolvedValue(undefined);
    store.setState({ settingsRoute: "qq-connection", loadQqAccess: loadAccess });

    const view = render(<SchemesWorkspace active={false} />);
    await act(async () => {});
    expect(loadAccess).toHaveBeenCalledTimes(0);

    view.rerender(<SchemesWorkspace active />);
    await act(async () => {});
    expect(loadAccess).toHaveBeenCalledTimes(1);
  });

  it("keeps QQ storage summary and directory reads inactive until the workspace activates", async () => {
    setupLibrary();
    const loadStorage = vi.fn().mockResolvedValue(undefined);
    const loadItems = vi.fn().mockResolvedValue(undefined);
    store.setState({
      settingsRoute: "qq-storage",
      loadQqStorage: loadStorage,
      loadQqStorageItems: loadItems,
    });

    const view = render(<SchemesWorkspace active={false} />);
    await act(async () => {});
    expect(loadStorage).toHaveBeenCalledTimes(0);
    expect(loadItems).toHaveBeenCalledTimes(0);

    view.rerender(<SchemesWorkspace active />);
    await act(async () => {});
    expect(loadStorage).toHaveBeenCalledTimes(1);
    expect(loadItems).toHaveBeenCalledTimes(1);
  });

  it("keeps standalone scheme-binding directory reads inactive until the workspace activates", async () => {
    setupLibrary();
    const loadDirectory = vi.fn().mockResolvedValue(undefined);
    store.setState({ settingsRoute: "scheme-bindings", loadQqBindingDirectory: loadDirectory });

    const view = render(<SchemesWorkspace active={false} />);
    await act(async () => {});
    expect(loadDirectory).toHaveBeenCalledTimes(0);

    view.rerender(<SchemesWorkspace active />);
    await act(async () => {});
    expect(loadDirectory).toHaveBeenCalledTimes(1);
  });
});
