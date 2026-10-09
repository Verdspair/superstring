// 能力专页的对象作用域用例：只保存所选模块/资源；未选草稿不提交、不阻断、保存后仍保留。
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ExecutionPolicySchema,
  type PermissionsResponse,
} from "../../src/shared/contracts/permissions";
import { api } from "../../src/web/api";
import { permissionSettingsDirty } from "../../src/web/features/access/permission-state";
import { selectLocale } from "../../src/web/i18n";
import { CapabilityPolicyPanel } from "../../src/web/screens/connections/capability-policy-panel";
import { ToolGrantsPanel } from "../../src/web/screens/connections/tool-grants-panel";
import { ExecutionSettings } from "../../src/web/screens/runs/execution-settings";
import { useSuperstringStore as store } from "../../src/web/store";

const snapshot = (): PermissionsResponse => ({
  revision: "pr-1",
  policy: {
    version: 1,
    grants: [
      { resource: "web", approved: false, revision: "w1", directories: [] },
      { resource: "mcp.echo.read", approved: false, revision: "r1", directories: [] },
    ],
    execution: ExecutionPolicySchema.parse({}),
  },
  resources: [
    {
      name: "web.search",
      resource: "web",
      description: "联网搜索",
      effect: "read",
      revision: "w1",
      approvalRequired: true,
    },
    {
      name: "mcp.echo.read",
      resource: "mcp.echo.read",
      description: "read notes",
      effect: "read",
      revision: "r1",
      approvalRequired: false,
    },
  ],
});

function setup() {
  let current = snapshot();
  const get = vi.fn(async () => structuredClone(current));
  const save = vi.fn(async (input: Parameters<typeof api.savePermissions>[0]) => {
    current = { ...current, policy: input.policy, revision: "pr-2" };
    return { revision: current.revision, policy: current.policy };
  });
  store.getState().resetForTests({ ...api, getPermissions: get, savePermissions: save });
  return { get, save };
}

async function renderWith(fake: Partial<typeof api>, node: React.ReactNode) {
  store.getState().resetForTests({ ...api, ...fake } as unknown as typeof api);
  render(node);
  await act(async () => {});
}

function editorOf() {
  const editor = store.getState().permissionEditor;
  if (!editor) throw new Error("permission editor not loaded");
  return editor;
}

beforeEach(() => {
  selectLocale("zh-CN");
});
afterEach(() => {
  cleanup();
});

describe("capability policy scope", () => {
  it("saves the member module alone while retaining web and execution drafts", async () => {
    const f = setup();
    await renderWith(
      { getPermissions: f.get, savePermissions: f.save },
      <CapabilityPolicyPanel modules={["qqMembers"]} />,
    );
    const modules = editorOf().execution.modules;
    await act(async () => {
      store.getState().patchExecutionSettings({
        modules: { ...modules, qqMembers: false, web: true },
        loopMaxSteps: "not-a-number",
      });
    });
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
    await act(async () => {});
    const [payload] = f.save.mock.calls[0];
    expect(payload.policy.execution?.modules.qqMembers).toBe(false);
    expect(payload.policy.execution?.modules.web).toBe(false);
    expect(payload.policy.execution?.loop.maxSteps).toBe(16);
    expect(payload.policy.grants).toEqual(snapshot().policy.grants);
    expect(editorOf().execution.modules.web).toBe(true);
    expect(editorOf().execution.loopMaxSteps).toBe("not-a-number");
    expect(permissionSettingsDirty(editorOf(), { modules: ["qqMembers"] })).toBe(false);
  });

  it("shows approval-free web resources without an ineffective approval checkbox", async () => {
    const value = snapshot();
    value.resources[0].approvalRequired = false;
    await renderWith(
      { getPermissions: vi.fn().mockResolvedValue(value) },
      <ToolGrantsPanel scope={["web"]} />,
    );
    expect(screen.getByText("无需持续批准")).toBeTruthy();
    expect(screen.queryByLabelText("持续批准 web")).toBeNull();
    expect(screen.getByLabelText("启用调用 web")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "管理" }));
    expect(screen.getByRole("radio", { name: "全部助手" })).toBeTruthy();
  });

  it("saves only the declared module and never carries another page's invalid numeric draft", async () => {
    const f = setup();
    await renderWith(
      { getPermissions: f.get, savePermissions: f.save },
      <CapabilityPolicyPanel modules={["web"]} />,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "使用联网工具" }));
    store.getState().patchExecutionSettings({ loopMaxSteps: "not-a-number" });
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
    await act(async () => {});
    expect(f.save).toHaveBeenCalledTimes(1);
    const [payload] = f.save.mock.calls[0];
    expect(payload.expectedRevision).toBe("pr-1");
    expect(payload.policy.execution?.modules.web).toBe(true);
    expect(payload.policy.execution?.loop.maxSteps).toBe(16);
    expect(payload.policy.execution?.research).toBe(false);
    expect(payload.policy.grants).toEqual(snapshot().policy.grants);
    // 成功只推进所选基线：非法数值草稿还在，仍属于执行设置页的脏区。
    const editor = editorOf();
    expect(editor.execution.loopMaxSteps).toBe("not-a-number");
    expect(permissionSettingsDirty(editor, { modules: ["web"] })).toBe(false);
    expect(permissionSettingsDirty(editor, { executionKeys: ["loopMaxSteps"] })).toBe(true);
  });

  it("renders the web module pause reason from the saved policy, not from unsaved drafts", async () => {
    const f = setup();
    await renderWith(
      { getPermissions: f.get, savePermissions: f.save },
      <ToolGrantsPanel scope={["web"]} />,
    );
    expect(screen.getByText("web")).toBeTruthy();
    expect(screen.getByText("联网搜索")).toBeTruthy();
    expect(screen.queryByText("mcp.echo.read")).toBeNull();
    expect(screen.getByText("所属模块已暂停；重新启用后仍需满足此资源的授权。")).toBeTruthy();
    // 别的面板改了模块草稿但没保存：暂停原因仍按已保存策略显示。
    const modules = editorOf().execution.modules;
    store.getState().patchExecutionSettings({ modules: { ...modules, web: true } });
    expect(screen.getByText("所属模块已暂停；重新启用后仍需满足此资源的授权。")).toBeTruthy();
  });

  it("saves the web grant without submitting or dropping an unsaved module draft", async () => {
    const f = setup();
    await renderWith(
      { getPermissions: f.get, savePermissions: f.save },
      <ToolGrantsPanel scope={["web"]} />,
    );
    const modules = editorOf().execution.modules;
    store.getState().patchExecutionSettings({ modules: { ...modules, web: true } });
    fireEvent.click(screen.getByLabelText("持续批准 web"));
    fireEvent.click(screen.getByRole("button", { name: "保存授权" }));
    await act(async () => {});
    const [payload] = f.save.mock.calls[0];
    expect(payload.policy.execution?.modules.web).toBe(false);
    expect(payload.policy.grants).toHaveLength(2);
    expect(payload.policy.grants.find((grant) => grant.resource === "web")?.approved).toBe(true);
    expect(
      payload.policy.grants.find((grant) => grant.resource === "mcp.echo.read")?.approved,
    ).toBe(false);
    // 授权只推进 web 基线：未选的模块草稿仍在，且仍是脏的。
    const editor = editorOf();
    expect(editor.execution.modules.web).toBe(true);
    expect(permissionSettingsDirty(editor, { modules: ["web"] })).toBe(true);
  });

  it("keeps a web module draft out of the execution page payload and dirty state", async () => {
    const f = setup();
    await renderWith({ getPermissions: f.get, savePermissions: f.save }, <ExecutionSettings />);
    const modules = editorOf().execution.modules;
    await act(async () => {
      store.getState().patchExecutionSettings({ modules: { ...modules, web: true } });
    });
    expect((screen.getByRole("button", { name: "保存设置" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    await act(async () => {
      store.getState().patchExecutionSettings({ loopMaxSteps: "20" });
    });
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
    await act(async () => {});
    const [payload] = f.save.mock.calls[0];
    expect(payload.policy.execution?.modules.web).toBe(false);
    expect(payload.policy.execution?.loop.maxSteps).toBe(20);
    const editor = editorOf();
    expect(editor.execution.modules.web).toBe(true);
    expect(permissionSettingsDirty(editor, { modules: ["web"] })).toBe(true);
  });

  it("filters resources by external/builtin scope and keeps the table scrollable", async () => {
    const f = setup();
    await renderWith({ getPermissions: f.get }, <ToolGrantsPanel scope="external" />);
    expect(screen.getByText("mcp.echo.read")).toBeTruthy();
    expect(screen.queryByText("web")).toBeNull();
    expect(screen.getByRole("table").parentElement?.className).toContain("overflow-x-auto");
    cleanup();
    await renderWith({ getPermissions: f.get }, <ToolGrantsPanel scope="builtin" />);
    expect(screen.getByText("web")).toBeTruthy();
    expect(screen.queryByText("mcp.echo.read")).toBeNull();
  });

  it("discard reverts only the declared scope and keeps neighbouring drafts", async () => {
    const f = setup();
    store.getState().resetForTests({ ...api, getPermissions: f.get, savePermissions: f.save });
    await store.getState().loadPermissionSettings();
    const editor = editorOf;
    store.getState().patchExecutionSettings({
      modules: { ...editor().execution.modules, web: true },
      loopMaxSteps: "20",
    });
    store.getState().patchToolGrant("web", { approved: true });
    store.getState().discardPermissionSettings({ modules: ["web"] });
    expect(editor().execution.modules.web).toBe(false);
    expect(editor().execution.loopMaxSteps).toBe("20");
    expect(editor().grants.web.approved).toBe(true);
  });

  it("hides numeric validation errors in the capability and grants panels", async () => {
    const f = setup();
    await renderWith(
      { getPermissions: f.get, savePermissions: f.save },
      <>
        <CapabilityPolicyPanel modules={["web"]} />
        <ToolGrantsPanel scope={["web"]} />
      </>,
    );
    store.getState().patchExecutionSettings({ loopMaxSteps: "x" });
    expect(await store.getState().savePermissionSettings({ executionKeys: ["loopMaxSteps"] })).toBe(
      false,
    );
    expect(store.getState().permissionProblem).toBe("loopMaxSteps");
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
