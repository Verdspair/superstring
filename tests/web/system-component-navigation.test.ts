import { beforeEach, expect, it, vi } from "vitest";
import { api } from "../../src/web/api";
import { permissionSettingsDirty } from "../../src/web/features/access/permission-state";
import { hasUnsavedDrafts } from "../../src/web/state/unsaved-changes";
import { useSuperstringStore as store } from "../../src/web/store";
import { A, B, setupLibrary } from "./helpers/library-fixture";

beforeEach(() => store.getState().resetForTests(api));

it("opens a component in its owning directory", () => {
  store.setState({
    page: "settings",
    settingsView: "workspace",
    settingsRoute: "system-capabilities",
  });
  store.getState().openSystemComponent({ kind: "tool", id: "memory.query" });
  expect(store.getState()).toMatchObject({
    settingsRoute: "tool-grants",
    componentTarget: { kind: "tool", id: "memory.query" },
  });
});

it("ordinary directory navigation clears stale component focus", () => {
  store.setState({
    page: "settings",
    settingsView: "workspace",
    settingsRoute: "tool-grants",
    componentTarget: { kind: "tool", id: "web.fetch" },
  });
  store.getState().openSettingsRoute("skill-catalog");
  expect(store.getState()).toMatchObject({ settingsRoute: "skill-catalog", componentTarget: null });
});

it("does not change component focus until guarded navigation lands", async () => {
  store.setState({
    page: "settings",
    settingsView: "workspace",
    settingsRoute: "system-capabilities",
    qqInputs: { ...store.getState().qqInputs, manualPeer: "30003" },
  });
  store.getState().openSystemComponent({ kind: "skill", id: "system-evidence-reading" });
  expect(store.getState().navigationConfirmOpen).toBe(true);
  expect(store.getState().componentTarget).toBeNull();
  store.getState().cancelPendingNavigation();
  expect(store.getState()).toMatchObject({
    settingsRoute: "system-capabilities",
    componentTarget: null,
  });
});

it("carries the component focus through discard-and-continue", async () => {
  store.setState({
    page: "settings",
    settingsView: "workspace",
    settingsRoute: "system-capabilities",
    qqInputs: { ...store.getState().qqInputs, manualPeer: "30003" },
  });
  store.getState().openSystemComponent({ kind: "tool", id: "web.fetch" });
  await store.getState().confirmDiscardAndContinue();
  expect(store.getState()).toMatchObject({
    settingsRoute: "tool-grants",
    componentTarget: { kind: "tool", id: "web.fetch" },
    navigationConfirmOpen: false,
  });
});

it("preserves the pending component when save-and-continue is rejected", async () => {
  store.setState({
    page: "settings",
    settingsView: "workspace",
    settingsRoute: "system-capabilities",
    qqInputs: {
      ...store.getState().qqInputs,
      storage: {
        source: { cleanup_mode: "manual", retention_days: 14, revision: 1 },
        days: "",
      },
    },
  });
  store.getState().openSystemComponent({ kind: "tool", id: "memory.read" });
  await store.getState().confirmSaveAndContinue();
  expect(store.getState()).toMatchObject({
    settingsRoute: "system-capabilities",
    componentTarget: null,
    pendingNavigation: {
      kind: "workspace-target",
      route: "tool-grants",
      componentTarget: { kind: "tool", id: "memory.read" },
    },
    navigationConfirmOpen: true,
  });
});

it("does not change component focus while a configuration write is active", () => {
  store.setState({
    page: "settings",
    settingsView: "workspace",
    settingsRoute: "system-capabilities",
    permissionSaving: true,
  });
  store.getState().openSystemComponent({ kind: "mcp", id: "local-service" });
  expect(store.getState()).toMatchObject({
    settingsRoute: "system-capabilities",
    componentTarget: null,
  });
});

it("does not carry a component detail into a reset API session", () => {
  store.getState().resetForTests(api);
  store.setState({ componentTarget: { kind: "skill", id: "system-evidence-reading" } });
  store.getState().resetForTests(api);
  expect(store.getState().componentTarget).toBeNull();
});

it("same component target is not a departure and does not duplicate its return context", () => {
  store.setState({
    page: "settings",
    settingsView: "workspace",
    settingsRoute: "tool-grants",
    componentTarget: { kind: "tool", id: "memory.query" },
    memoryCorrectionDirty: true,
  });
  store.getState().openSystemComponent({ kind: "tool", id: "memory.query" });
  expect(store.getState().pendingNavigation).toBeNull();
  expect(store.getState().workspaceReturns).toEqual([]);
  expect(store.getState().memoryCorrectionDirty).toBe(true);
});

async function componentDrafts() {
  const snapshot = {
    revision: "permission-1",
    policy: { version: 1 as const, grants: [] },
    resources: [],
  };
  const savePermissions = vi.fn(async (body: Parameters<typeof api.savePermissions>[0]) => ({
    revision: "permission-2",
    policy: body.policy,
  }));
  const saveWebAccess = vi.fn(async (body: Parameters<typeof api.saveWebAccess>[0]) => ({
    revision: "web-2",
    config: body.config,
  }));
  store.getState().resetForTests({
    ...api,
    getPermissions: vi.fn().mockResolvedValue(snapshot),
    savePermissions,
    getWebAccess: vi.fn().mockResolvedValue({ revision: "web-1", config: { version: 1 } }),
    saveWebAccess,
  });
  store.setState({ page: "settings", settingsView: "workspace", settingsRoute: "web-access" });
  await store.getState().loadPermissionSettings();
  await store.getState().loadWebAccess();
  store.getState().patchExecutionSettings({ loopMaxSteps: "17" });
  store.getState().patchWebAccessDraft("https://search.example.invalid");
  return { savePermissions, saveWebAccess };
}

it("ordinary settings route save-and-continue commits permission and endpoint owners before landing", async () => {
  const { savePermissions, saveWebAccess } = await componentDrafts();
  store.getState().openSettingsRoute("mcp-servers");
  expect(store.getState().settingsRoute).toBe("web-access");
  expect(store.getState().pendingNavigation).toMatchObject({ settingsRoute: "mcp-servers" });
  await store.getState().confirmSaveAndContinue();
  expect(savePermissions).toHaveBeenCalledTimes(1);
  expect(saveWebAccess).toHaveBeenCalledTimes(1);
  expect(store.getState().permissionEditor?.snapshot.revision).toBe("permission-2");
  expect(store.getState().webAccessSnapshot?.revision).toBe("web-2");
  expect(store.getState().settingsRoute).toBe("mcp-servers");
  expect(hasUnsavedDrafts(store.getState())).toBe(false);
});

it("ordinary settings route discard restores permission and endpoint baselines without writes", async () => {
  const { savePermissions, saveWebAccess } = await componentDrafts();
  store.getState().openSettingsRoute("mcp-servers");
  store.getState().cancelPendingNavigation();
  expect(permissionSettingsDirty(store.getState().permissionEditor)).toBe(true);
  expect(store.getState().webAccessDraft).toBe("https://search.example.invalid");
  store.getState().openSettingsRoute("mcp-servers");
  await store.getState().confirmDiscardAndContinue();
  expect(store.getState().settingsRoute).toBe("mcp-servers");
  expect(hasUnsavedDrafts(store.getState())).toBe(false);
  expect(savePermissions).not.toHaveBeenCalled();
  expect(saveWebAccess).not.toHaveBeenCalled();
});

it("keeps the pending component and source return while an endpoint save fails, then retries only it", async () => {
  const { savePermissions, saveWebAccess } = await componentDrafts();
  saveWebAccess.mockRejectedValueOnce(new Error("endpoint conflict"));
  store.getState().openSystemComponent({ kind: "tool", id: "memory.query" });
  const pending = store.getState().pendingNavigation;
  await store.getState().confirmSaveAndContinue();
  expect(store.getState().pendingNavigation).toBe(pending);
  expect(store.getState().settingsRoute).toBe("web-access");
  expect(store.getState().componentTarget).toBeNull();
  expect(store.getState().workspaceReturns).toEqual([]);
  expect(savePermissions).toHaveBeenCalledTimes(1);
  await store.getState().confirmSaveAndContinue();
  expect(savePermissions).toHaveBeenCalledTimes(1);
  expect(saveWebAccess).toHaveBeenCalledTimes(2);
  expect(store.getState().componentTarget).toEqual({ kind: "tool", id: "memory.query" });
  expect(store.getState().workspaceReturns.at(-1)?.route).toBe("web-access");
  store.getState().returnWorkspaceTarget();
  expect(store.getState().settingsRoute).toBe("web-access");
  expect(store.getState().componentTarget).toBeNull();
});

it("an old API endpoint save cannot reopen the guard or continue writes in the new session", async () => {
  const { saveWebAccess } = await componentDrafts();
  const late = Promise.withResolvers<Awaited<ReturnType<typeof api.saveWebAccess>>>();
  saveWebAccess.mockReturnValueOnce(late.promise);
  store.getState().openSettingsRoute("mcp-servers");
  const saving = store.getState().confirmSaveAndContinue();
  await vi.waitFor(() => expect(saveWebAccess).toHaveBeenCalledTimes(1));
  store.getState().resetForTests(api);
  store.setState({
    page: "settings",
    settingsView: "workspace",
    settingsRoute: "system-capabilities",
  });
  late.resolve({ revision: "old-web", config: { version: 1 } });
  await saving;
  expect(store.getState()).toMatchObject({
    settingsRoute: "system-capabilities",
    pendingNavigation: null,
    navigationConfirmOpen: false,
    webAccessSnapshot: null,
  });
});

it("Agent switch guards tool overrides and discard does not clear unrelated global permission drafts", async () => {
  setupLibrary({
    getPermissions: vi.fn().mockResolvedValue({
      revision: "tools-1",
      policy: { version: 1, grants: [] },
      resources: [
        {
          name: "query",
          resource: "memory.query",
          description: "",
          effect: "read",
          revision: "r1",
          approvalRequired: false,
        },
      ],
    }),
  });
  store.setState({ settingsRoute: "agent-tools" });
  await store.getState().loadPermissionSettings();
  store.getState().patchToolGrant("memory.query", {
    agentOverrides: { [A]: { enabled: false, approved: false, revision: "r1", directories: [] } },
  });
  store.getState().patchExecutionSettings({ loopMaxSteps: "17" });
  expect(await store.getState().requestAgentNavigation(B)).toBe(false);
  expect(store.getState().editorAgentId).toBe(A);
  store.getState().cancelPendingNavigation();
  expect(
    store.getState().permissionEditor?.grants["memory.query"].agentOverrides?.[A],
  ).toBeDefined();
  await store.getState().requestAgentNavigation(B);
  await store.getState().confirmDiscardAndContinue();
  expect(store.getState().editorAgentId).toBe(B);
  expect(
    store.getState().permissionEditor?.grants["memory.query"].agentOverrides?.[A],
  ).toBeUndefined();
  expect(store.getState().permissionEditor?.execution.loopMaxSteps).toBe("17");
  expect(permissionSettingsDirty(store.getState().permissionEditor)).toBe(true);
});

it("an old API Agent switch read cannot restore its guarded draft into a replacement session", async () => {
  const late = Promise.withResolvers<Awaited<ReturnType<typeof api.getAgent>>>();
  setupLibrary({ getAgent: vi.fn().mockReturnValue(late.promise) });
  store.getState().patchPageAgent("basic", { name: "old draft" });
  await store.getState().requestAgentNavigation(B);
  const switching = store.getState().confirmDiscardAndContinue();
  await vi.waitFor(() => expect(store.getState().editorLoading).toBe(true));
  store.getState().resetForTests(api);
  store.setState({
    page: "settings",
    settingsView: "workspace",
    settingsRoute: "system-capabilities",
  });
  late.reject(new Error("old read failed"));
  await switching;
  expect(store.getState()).toMatchObject({
    settingsRoute: "system-capabilities",
    pendingNavigation: null,
    navigationConfirmOpen: false,
    pageEditor: null,
  });
});

it("Agent internal task navigation retains permission drafts without saving or discarding them", async () => {
  const { savePermissions, saveWebAccess } = await componentDrafts();
  const permissionEditor = store.getState().permissionEditor;
  setupLibrary({ savePermissions, saveWebAccess });
  store.setState({ settingsRoute: "identity", permissionEditor });
  store.getState().patchPageAgent("basic", { name: "unselected identity" });
  store.getState().openSettingsRoute("context");
  expect(store.getState().navigationConfirmOpen).toBe(false);
  expect(store.getState().settingsRoute).toBe("context");
  expect(store.getState().pageEditor?.draft.name).toBe("unselected identity");
  expect(permissionSettingsDirty(store.getState().permissionEditor)).toBe(true);
  expect(savePermissions).not.toHaveBeenCalled();
  expect(saveWebAccess).not.toHaveBeenCalled();
});
