import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SchemesWorkspace } from "../../src/web/screens/connections/SchemesWorkspace";
import { useSuperstringStore as store } from "../../src/web/store";
import { setupLibrary } from "./helpers/library-fixture";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
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
