import { afterEach, describe, expect, it, vi } from "vitest";
import type { OrganizationSettings } from "../../src/shared/contracts/organization";
import { api } from "../../src/web/api";
import { navigationBusy } from "../../src/web/state/unsaved-changes";
import { useSuperstringStore as store } from "../../src/web/store";

const settings: OrganizationSettings = {
  model_name: "model",
  vision_model_name: null,
  transcription_model_name: null,
  revision: 1,
};
afterEach(() => vi.restoreAllMocks());
describe("organization metadata navigation", () => {
  it("allows leaving the Agent page while optional organization metadata is pending", async () => {
    let resolve!: (value: OrganizationSettings) => void;
    store.getState().resetForTests({
      ...api,
      getOrganizationSettings: () =>
        new Promise((done) => {
          resolve = done;
        }),
    });
    store.setState({ page: "settings", settingsView: "workspace", settingsRoute: "basic" });
    const load = store.getState().loadOrganization();
    store.getState().openSettingsRoute("scheme-library");
    const landed = store.getState().settingsRoute;
    resolve(settings);
    await load;
    expect(landed).toBe("scheme-library");
  });
  it("still blocks navigation during a real organization save", async () => {
    let resolve!: (value: OrganizationSettings) => void;
    store.getState().resetForTests({
      ...api,
      getOrganizationSettings: async () => settings,
      saveOrganizationSettings: () =>
        new Promise((done) => {
          resolve = done;
        }),
    });
    store.setState({ page: "settings", settingsView: "workspace", settingsRoute: "basic" });
    await store.getState().loadOrganization();
    store.getState().patchOrganization("changed");
    const save = store.getState().saveOrganization();
    expect(navigationBusy(store.getState())).toBe(true);
    store.getState().openSettingsRoute("scheme-library");
    expect(store.getState().settingsRoute).toBe("basic");
    resolve({ ...settings, model_name: "changed", revision: 2 });
    await save;
    expect(navigationBusy(store.getState())).toBe(false);
  });
  it("rejects an old API's organization response after a new API is installed", async () => {
    let resolve!: (value: OrganizationSettings) => void;
    store.getState().resetForTests({
      ...api,
      getOrganizationSettings: () =>
        new Promise((done) => {
          resolve = done;
        }),
    });
    const load = store.getState().loadOrganization();
    store.getState().resetForTests({ ...api });
    resolve(settings);
    await load;
    expect(store.getState().organizationEditor).toBeNull();
    expect(store.getState().organizationLoading).toBe(false);
  });
});
