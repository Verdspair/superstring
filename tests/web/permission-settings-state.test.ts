import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ExecutionPolicySchema,
  type PermissionsResponse,
} from "../../src/shared/contracts/permissions";
import { api } from "../../src/web/api";
import { permissionSettingsDirty } from "../../src/web/features/access/permission-state";
import { useSuperstringStore as store } from "../../src/web/store";

const snapshot = (): PermissionsResponse => ({
  revision: "r1",
  policy: {
    version: 1,
    execution: ExecutionPolicySchema.parse({}),
    grants: [{ resource: "mcp.demo.read", approved: false, revision: "v1", directories: [] }],
  },
  resources: [
    {
      name: "mcp.demo.read",
      resource: "mcp.demo.read",
      description: "Read",
      effect: "read",
      revision: "v1",
      approvalRequired: false,
    },
  ],
});
beforeEach(() => store.getState().resetForTests());

function setup() {
  let current = snapshot();
  const get = vi.fn(async () => structuredClone(current));
  const save = vi.fn(async (input: Parameters<typeof api.savePermissions>[0]) => {
    current = { ...current, policy: input.policy, revision: "r2" };
    return { revision: current.revision, policy: current.policy };
  });
  store.getState().resetForTests({ ...api, getPermissions: get, savePermissions: save });
  return {
    get,
    save,
    replace: (value: PermissionsResponse) => {
      current = value;
    },
  };
}

describe("permission settings shared drafts", () => {
  it("retains drafts across settings routes and applies the existing leave guard", async () => {
    setup();
    await store.getState().loadPermissionSettings();
    store.setState({
      page: "settings",
      settingsView: "workspace",
      settingsRoute: "execution-settings",
    });
    store.getState().patchExecutionSettings({ loopMaxSteps: "20" });
    store.getState().openSettingsRoute("tool-grants");
    expect(store.getState().permissionEditor?.execution.loopMaxSteps).toBe("20");
    store.getState().openChat();
    expect(store.getState().navigationConfirmOpen).toBe(true);
    store.getState().cancelPendingNavigation();
    expect(store.getState().page).toBe("settings");
    store.getState().openChat();
    await store.getState().confirmDiscardAndContinue();
    expect(store.getState().page).toBe("chat");
    expect(permissionSettingsDirty(store.getState().permissionEditor)).toBe(false);
  });

  it("saves one domain while retaining the other and uses the latest shared revision", async () => {
    const f = setup();
    await store.getState().loadPermissionSettings();
    store.getState().patchExecutionSettings({ loopMaxSteps: "20" });
    store.getState().patchToolGrant("mcp.demo.read", { enabled: false });
    expect(await store.getState().savePermissionSettings("execution")).toBe(true);
    expect(f.save.mock.calls[0][0].policy.execution?.pausedTools).toEqual([]);
    expect(store.getState().permissionEditor?.grants["mcp.demo.read"].enabled).toBe(false);
    expect(permissionSettingsDirty(store.getState().permissionEditor, "grants")).toBe(true);
    expect(await store.getState().savePermissionSettings("grants")).toBe(true);
    expect(f.save.mock.calls[1][0].expectedRevision).toBe("r2");
    expect(f.save.mock.calls[1][0].policy.execution).toMatchObject({
      loop: { maxSteps: 20 },
      pausedTools: ["mcp.demo.read"],
    });
    expect(permissionSettingsDirty(store.getState().permissionEditor)).toBe(false);
  });

  it("refreshes unchanged fields but retains changed values and module choices", async () => {
    const f = setup();
    await store.getState().loadPermissionSettings();
    const old = store.getState().permissionEditor!;
    store.getState().patchExecutionSettings({
      loopMaxSteps: "20",
      modules: { ...old.execution.modules, skills: false },
    });
    const next = snapshot();
    next.revision = "remote";
    next.policy.execution = ExecutionPolicySchema.parse({ code: true, modules: { mcp: false } });
    f.replace(next);
    await store.getState().loadPermissionSettings(true);
    const editor = store.getState().permissionEditor!;
    expect(editor.execution.loopMaxSteps).toBe("20");
    expect(editor.execution.code).toBe(true);
    expect(editor.execution.modules).toMatchObject({ mcp: false, skills: false });
    expect(editor.snapshot.revision).toBe("remote");
  });

  it("does not turn a usage edit into an approval or scope rollback on refresh", async () => {
    const f = setup();
    await store.getState().loadPermissionSettings();
    store.getState().patchToolGrant("mcp.demo.read", { enabled: false });
    const next = snapshot();
    next.revision = "remote";
    next.policy.grants[0] = { ...next.policy.grants[0], approved: true, agentIds: ["new-agent"] };
    f.replace(next);
    await store.getState().loadPermissionSettings(true);
    expect(store.getState().permissionEditor?.grants["mcp.demo.read"]).toMatchObject({
      enabled: false,
      approved: true,
      agentIds: ["new-agent"],
    });
  });

  it("requires fresh approval when a resource revision changes during refresh", async () => {
    const f = setup();
    await store.getState().loadPermissionSettings();
    store.getState().patchToolGrant("mcp.demo.read", { approved: true });
    const next = snapshot();
    next.resources[0].revision = "v2";
    f.replace(next);
    await store.getState().loadPermissionSettings(true);
    expect(store.getState().permissionEditor?.grants["mcp.demo.read"].approved).toBe(false);
  });

  it("keeps conflict drafts and prevents duplicate saves or refresh during saving", async () => {
    const f = setup();
    await store.getState().loadPermissionSettings();
    store.getState().patchExecutionSettings({ loopMaxSteps: "20" });
    const deferred = Promise.withResolvers<never>();
    f.save.mockImplementation(() => deferred.promise);
    const saving = store.getState().savePermissionSettings("execution");
    expect(await store.getState().savePermissionSettings()).toBe(false);
    await store.getState().loadPermissionSettings(true);
    expect(f.get).toHaveBeenCalledTimes(1);
    deferred.reject(new Error("revision conflict"));
    expect(await saving).toBe(false);
    expect(store.getState().permissionEditor?.execution.loopMaxSteps).toBe("20");
    expect(store.getState().permissionError).toContain("revision conflict");
  });

  it("makes retained offline grants manageable without inventing new resources", async () => {
    const f = setup();
    const offline = snapshot();
    offline.resources = [];
    f.replace(offline);
    await store.getState().loadPermissionSettings();
    store.getState().patchToolGrant("mcp.demo.read", { enabled: false });
    await store.getState().savePermissionSettings("grants");
    expect(f.save.mock.calls[0][0].policy.grants).toHaveLength(1);
    expect(f.save.mock.calls[0][0].policy.execution?.pausedTools).toEqual(["mcp.demo.read"]);
  });
});
