import { act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, type SuperstringApi } from "../../src/web/api";
import { navigationBusy } from "../../src/web/state/unsaved-changes";
import { useSuperstringStore as store } from "../../src/web/store";
import { agent, persona } from "./helpers/library-fixture";

afterEach(() => {
  vi.restoreAllMocks();
});
function setup(overrides: Partial<SuperstringApi> = {}) {
  store.getState().resetForTests({
    ...api,
    getAgent: vi.fn().mockResolvedValue(agent),
    getPersona: vi.fn().mockResolvedValue(persona),
    ...overrides,
  });
  store.setState({
    page: "settings",
    settingsView: "workspace",
    settingsRoute: "basic",
    agents: [agent],
    editorAgentId: agent.id,
  });
}
describe("Agent navigation read ownership", () => {
  it("settles the ready editor without waiting for unrelated memory maintenance reads", async () => {
    setup();
    let release!: () => void;
    const memory = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reloadMemory = vi.fn(() => memory);
    store.setState({ reloadMemory });
    const editing = store.getState().editAgent(agent.id);
    await act(async () => {});
    expect(store.getState().pageEditor?.agent.id).toBe(agent.id);
    const blocked = navigationBusy(store.getState());
    release();
    await editing;
    expect(blocked).toBe(false);
    expect(reloadMemory).toHaveBeenCalledTimes(1);
    store.getState().openSettingsRoute("scheme-library");
    expect(store.getState().settingsRoute).toBe("scheme-library");
  });
  it("leaves for the scheme library during a pending Agent read and rejects its late editor", async () => {
    let resolve!: (value: typeof agent) => void;
    setup({
      getAgent: () =>
        new Promise((done) => {
          resolve = done;
        }),
    });
    store.setState({ pageEditor: null });
    const editing = store.getState().editAgent(agent.id);
    expect(store.getState().editorLoading).toBe(true);
    expect(navigationBusy(store.getState())).toBe(false);
    store.getState().openSettingsRoute("scheme-library");
    expect(store.getState().settingsRoute).toBe("scheme-library");
    resolve(agent);
    await editing;
    expect(store.getState().settingsRoute).toBe("scheme-library");
    expect(store.getState().pageEditor).toBeNull();
    expect(store.getState().editorLoading).toBe(false);
    expect(navigationBusy(store.getState())).toBe(false);
  });
  it("releases editor loading and preserves the failure when persona reading fails", async () => {
    setup({ getPersona: vi.fn().mockRejectedValue(new Error("persona unavailable")) });
    expect(await store.getState().editAgent(agent.id)).toBe(false);
    expect(store.getState().editorLoading).toBe(false);
    expect(store.getState().error).toBe("persona unavailable");
  });
});
