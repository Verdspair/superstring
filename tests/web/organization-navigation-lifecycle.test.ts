import { afterEach, describe, expect, it, vi } from "vitest";
import type { OrganizationSettings } from "../../src/shared/contracts/organization";
import { ApiError, api } from "../../src/web/api";
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

describe("organization automatic resume CAS", () => {
  it("keeps old allocation revision on a same-field remote edit, fails CAS and allows explicit review", async () => {
    let hidden = false;
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() =>
      hidden ? "hidden" : "visible",
    );
    let remote: OrganizationSettings = {
      ...settings,
      auxiliary_allocation: {
        knowledge_organize: { mode: "fixed", input_limit: 100, output_reserved: 10 },
      },
    };
    const saveOrganizationSettings = vi.fn(
      async (body: Parameters<typeof api.saveOrganizationSettings>[0]) => {
        if (body.expected_revision !== remote.revision)
          throw new ApiError(409, "ORGANIZATION_REVISION_CONFLICT", "conflict");
        remote = { ...remote, ...body, revision: remote.revision + 1 };
        return remote;
      },
    );
    store.getState().resetForTests({
      ...api,
      getOrganizationSettings: vi.fn(async () => remote),
      saveOrganizationSettings,
    });
    const owner = {};
    await store.getState().acquireOrganizationRead(owner);
    store.getState().patchOrganizationAllocation({
      knowledge_organize: { mode: "fixed", input_limit: 200, output_reserved: 10 },
    });
    hidden = true;
    store.getState().releaseOrganizationRead(owner);
    remote = {
      ...remote,
      revision: 2,
      auxiliary_allocation: {
        knowledge_organize: { mode: "fixed", input_limit: 300, output_reserved: 10 },
      },
    };
    hidden = false;
    await store.getState().acquireOrganizationRead(owner);
    expect(store.getState().organizationEditor?.source.revision).toBe(1);
    expect(
      store.getState().organizationEditor?.auxiliaryAllocation?.knowledge_organize?.input_limit,
    ).toBe(200);
    expect(store.getState().organizationError).toBeTruthy();
    expect(await store.getState().saveOrganization("allocation", ["knowledge_organize"])).toBe(
      false,
    );
    expect(remote.auxiliary_allocation?.knowledge_organize?.input_limit).toBe(300);
    expect(saveOrganizationSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ expected_revision: 1 }),
    );
    await store.getState().loadOrganization(true);
    expect(store.getState().organizationEditor?.source.revision).toBe(2);
    expect(
      store.getState().organizationEditor?.auxiliaryAllocation?.knowledge_organize?.input_limit,
    ).toBe(200);
    expect(await store.getState().saveOrganization("allocation", ["knowledge_organize"])).toBe(
      true,
    );
    expect(saveOrganizationSettings).toHaveBeenCalledTimes(2);
    store.getState().releaseOrganizationRead(owner);
  });
  it("merges remote fields in the same role when the local field is non-overlapping", async () => {
    let hidden = false;
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() =>
      hidden ? "hidden" : "visible",
    );
    let remote: OrganizationSettings = {
      ...settings,
      auxiliary_allocation: {
        knowledge_organize: { mode: "fixed", input_limit: 100, output_reserved: 10 },
      },
    };
    store.getState().resetForTests({ ...api, getOrganizationSettings: vi.fn(async () => remote) });
    const owner = {};
    await store.getState().acquireOrganizationRead(owner);
    store.getState().patchOrganizationAllocation({
      knowledge_organize: { mode: "fixed", input_limit: 200, output_reserved: 10 },
    });
    hidden = true;
    store.getState().releaseOrganizationRead(owner);
    remote = {
      ...remote,
      revision: 2,
      auxiliary_allocation: {
        knowledge_organize: { mode: "fixed", input_limit: 100, output_reserved: 30 },
        qq_sticker_annotate: { mode: "auto" },
      },
    };
    hidden = false;
    await store.getState().acquireOrganizationRead(owner);
    expect(store.getState().organizationEditor).toMatchObject({
      source: { revision: 2 },
      auxiliaryAllocation: {
        knowledge_organize: { mode: "fixed", input_limit: 200, output_reserved: 30 },
        qq_sticker_annotate: { mode: "auto" },
      },
    });
    expect(store.getState().organizationError).toBeNull();
    store.getState().releaseOrganizationRead(owner);
  });
});
