import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ExecutionPolicySchema,
  type PermissionsResponse,
} from "../../src/shared/contracts/permissions";
import { api } from "../../src/web/api";
import {
  type PermissionScope,
  permissionSettingsDirty,
} from "../../src/web/features/access/permission-state";
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

  it("saves widened concurrency drafts as strings through CAS and keeps them on refresh", async () => {
    const f = setup();
    await store.getState().loadPermissionSettings();
    // 缺省 4/2 在草稿里以字符串呈现。
    expect(store.getState().permissionEditor?.execution.loopModelConcurrency).toBe("4");
    expect(store.getState().permissionEditor?.execution.loopProviderConcurrency).toBe("2");
    store.getState().patchExecutionSettings({
      loopModelConcurrency: "256",
      loopProviderConcurrency: "256",
    });
    expect(await store.getState().savePermissionSettings("execution")).toBe(true);
    // 字符串草稿经 CAS（expectedRevision）保存为数值 256。
    expect(f.save.mock.calls[0][0].expectedRevision).toBe("r1");
    expect(f.save.mock.calls[0][0].policy.execution?.loop).toMatchObject({
      modelConcurrency: 256,
      providerConcurrency: 256,
    });
    // 已存的旧显式值 1 在刷新后仍保留为字符串草稿。
    const next = snapshot();
    next.revision = "remote";
    next.policy.execution = ExecutionPolicySchema.parse({
      loop: { modelConcurrency: 1, providerConcurrency: 1 },
    });
    f.replace(next);
    await store.getState().loadPermissionSettings(true);
    expect(store.getState().permissionEditor?.execution.loopModelConcurrency).toBe("1");
    expect(store.getState().permissionEditor?.execution.loopProviderConcurrency).toBe("1");
  });
});

describe("retry scope and raw seconds drafts (R42)", () => {
  // 与两处页面面板的真实保存 scope 对齐：QQ 连接页 4 个执行键、系统执行页重试 2 键。
  const qqScope: PermissionScope = {
    executionKeys: [
      "qqRetryDelaySeconds",
      "qqMaxAttempts",
      "qqDeliveryTtlSeconds",
      "loopConcurrency",
    ],
  };
  const systemScope: PermissionScope = {
    executionKeys: ["systemMaxAttempts", "systemRetryDelaySeconds"],
  };

  it("round-trips a saved fractional QQ delay byte-exactly across both save directions", async () => {
    const f = setup();
    const start = snapshot();
    start.policy.execution = ExecutionPolicySchema.parse({ qq: { retryDelayMs: 1500 } });
    f.replace(start);
    await store.getState().loadPermissionSettings();
    // 已存显式 1500ms 以 1.5 秒呈现，不取整。
    expect(store.getState().permissionEditor?.execution.qqRetryDelaySeconds).toBe("1.5");
    // 系统页 scope 保存时，界外已存 QQ 毫秒值原样保留（CAS 整域提交但键值不变）。
    store.getState().patchExecutionSettings({ systemMaxAttempts: "1" });
    expect(await store.getState().savePermissionSettings(systemScope)).toBe(true);
    expect(f.save.mock.calls[0][0].policy.execution?.qq).toMatchObject({ retryDelayMs: 1500 });
    expect(f.save.mock.calls[0][0].policy.execution?.system).toMatchObject({ maxAttempts: 1 });
    // 反向：QQ 页输入 2.5 秒按精确整毫秒 2500 提交。
    store.getState().patchExecutionSettings({ qqRetryDelaySeconds: "2.5" });
    expect(await store.getState().savePermissionSettings(qqScope)).toBe(true);
    expect(f.save.mock.calls[1][0].policy.execution?.qq).toMatchObject({ retryDelayMs: 2500 });
    // 三位小数按精确整毫秒提交：1.001 秒 = 1001ms，不圆整。
    store.getState().patchExecutionSettings({ systemRetryDelaySeconds: "1.001" });
    expect(await store.getState().savePermissionSettings(systemScope)).toBe(true);
    expect(f.save.mock.calls[2][0].policy.execution?.system).toMatchObject({ retryDelayMs: 1001 });
  });

  it("saves system maxAttempts 1 (retries disabled) and keeps it as an explicit draft", async () => {
    const f = setup();
    await store.getState().loadPermissionSettings();
    store.getState().patchExecutionSettings({ systemMaxAttempts: "1" });
    expect(await store.getState().savePermissionSettings(systemScope)).toBe(true);
    expect(f.save.mock.calls[0][0].expectedRevision).toBe("r1");
    expect(f.save.mock.calls[0][0].policy.execution?.system).toMatchObject({
      maxAttempts: 1,
      retryDelayMs: 2000,
    });
    // 显式存过的 1 在刷新后仍是字符串草稿，缺省不回填覆盖。
    const next = snapshot();
    next.revision = "remote";
    next.policy.execution = ExecutionPolicySchema.parse({ system: { maxAttempts: 1 } });
    f.replace(next);
    await store.getState().loadPermissionSettings(true);
    expect(store.getState().permissionEditor?.execution.systemMaxAttempts).toBe("1");
    expect(store.getState().permissionEditor?.execution.systemRetryDelaySeconds).toBe("2");
  });

  it.each(["", "abc", "-1", "0", "0.5", "1.0005", "301"])(
    "blocks same-scope illegal system seconds %j before any request and names the field",
    async (raw) => {
      const f = setup();
      await store.getState().loadPermissionSettings();
      store.getState().patchExecutionSettings({ systemRetryDelaySeconds: raw });
      expect(await store.getState().savePermissionSettings(systemScope)).toBe(false);
      expect(f.save).not.toHaveBeenCalled();
      expect(store.getState().permissionProblem).toBe("systemRetryDelaySeconds");
    },
  );

  it("commits a QQ-scope save while out-of-scope illegal system raws stay preserved drafts", async () => {
    const f = setup();
    await store.getState().loadPermissionSettings();
    store.getState().patchExecutionSettings({
      systemMaxAttempts: "-1",
      systemRetryDelaySeconds: "",
      qqRetryDelaySeconds: "20",
    });
    expect(await store.getState().savePermissionSettings(qqScope)).toBe(true);
    expect(f.save).toHaveBeenCalledTimes(1);
    expect(f.save.mock.calls[0][0].policy.execution?.qq).toMatchObject({ retryDelayMs: 20000 });
    // 界外非法草稿既不进入提交，也不阻断本次保存，更不被回写成基线值。
    expect(f.save.mock.calls[0][0].policy.execution?.system).toMatchObject({
      maxAttempts: 3,
      retryDelayMs: 2000,
    });
    const editor = store.getState().permissionEditor!;
    expect(editor.execution.systemMaxAttempts).toBe("-1");
    expect(editor.execution.systemRetryDelaySeconds).toBe("");
    expect(permissionSettingsDirty(editor, systemScope)).toBe(true);
    expect(permissionSettingsDirty(editor, qqScope)).toBe(false);
  });

  it("keeps retry drafts on a revision conflict and commits them against the refreshed revision", async () => {
    const f = setup();
    await store.getState().loadPermissionSettings();
    store.getState().patchExecutionSettings({
      systemRetryDelaySeconds: "5",
      qqRetryDelaySeconds: "45",
    });
    f.save.mockRejectedValueOnce(new Error("revision conflict"));
    expect(await store.getState().savePermissionSettings(systemScope)).toBe(false);
    expect(store.getState().permissionEditor?.execution.systemRetryDelaySeconds).toBe("5");
    expect(store.getState().permissionEditor?.execution.qqRetryDelaySeconds).toBe("45");
    // 冲突后刷新基线到远端新修订；保留草稿不丢，再按新 expectedRevision 真实提交。
    const next = snapshot();
    next.revision = "remote";
    f.replace(next);
    await store.getState().loadPermissionSettings(true);
    expect(store.getState().permissionEditor?.execution.systemRetryDelaySeconds).toBe("5");
    expect(store.getState().permissionEditor?.execution.qqRetryDelaySeconds).toBe("45");
    expect(await store.getState().savePermissionSettings(systemScope)).toBe(true);
    expect(f.save).toHaveBeenCalledTimes(2);
    expect(f.save.mock.calls[1][0].expectedRevision).toBe("remote");
    expect(f.save.mock.calls[1][0].policy.execution?.system).toMatchObject({ retryDelayMs: 5000 });
  });
});
