// 能力专页的对象作用域用例：只保存所选模块/资源；未选草稿不提交、不阻断、保存后仍保留。
// QQ 连接页的限制面板（4 个迁入数值键）走同一 permissionEditor scoped merge，覆盖在文件后半。
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ExecutionPolicySchema,
  type PermissionsResponse,
} from "../../src/shared/contracts/permissions";
import type { QqSettingsResponse } from "../../src/shared/contracts/qq";
import { ApiError, api } from "../../src/web/api";
import {
  type PermissionScope,
  permissionSettingsDirty,
} from "../../src/web/features/access/permission-state";
import { selectLocale } from "../../src/web/i18n";
import { CapabilityPolicyPanel } from "../../src/web/screens/connections/capability-policy-panel";
import { ToolGrantsPanel } from "../../src/web/screens/connections/tool-grants-panel";
import { TransportSettings } from "../../src/web/screens/connections/transport-settings";
import { ExecutionSettings } from "../../src/web/screens/runs/execution-settings";
import { useSuperstringStore as store } from "../../src/web/store";
import { render } from "./helpers/render-with-providers";

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

// QQ 连接页的限制面板只拥有这 4 个数值键；QQ 模块开关仍在各自能力专页保存。
const QQ_PANEL_SCOPE: PermissionScope = {
  executionKeys: [
    "qqRetryDelaySeconds",
    "qqMaxAttempts",
    "qqDeliveryTtlSeconds",
    "loopConcurrency",
  ],
};

const qqSettings: QqSettingsResponse = {
  enabled: true,
  account_id: "10001",
  judgement_model_name: null,
  transport: { endpoint: "ws://localhost:3000", has_token: false },
  revision: 3,
};

async function renderTransport(fake: Partial<typeof api> = {}) {
  store.getState().resetForTests({
    ...api,
    getQqOwner: async () => ({
      configured: false,
      account_id: null,
      peer_id: null,
      revision: null,
    }),
    ...fake,
  } as unknown as typeof api);
  store.setState({
    qqSettings,
    page: "settings",
    settingsView: "workspace",
    settingsRoute: "qq-connection",
  });
  render(<TransportSettings active />);
  await act(async () => {});
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

describe("QQ delivery limits panel on the connection page", () => {
  it("renders the four moved fields with saved values and saves them via the scoped permission CAS", async () => {
    const f = setup();
    await renderTransport({ getPermissions: f.get, savePermissions: f.save });
    const retry = screen.getByLabelText("失败重试间隔（秒）") as HTMLInputElement;
    const attempts = screen.getByLabelText("最多尝试次数（含首次）") as HTMLInputElement;
    const ttl = screen.getByLabelText("投递意图有效期（秒）") as HTMLInputElement;
    const wakes = screen.getByLabelText("跨会话唤醒并发") as HTMLInputElement;
    expect(retry.value).toBe("15");
    expect(attempts.value).toBe("3");
    expect(ttl.value).toBe("600");
    expect(wakes.value).toBe("4");
    expect(screen.getByText("QQ 唤醒失败重试")).toBeTruthy();
    expect(screen.getByText("投递与并发")).toBeTruthy();
    const retryGroup = screen.getByText("QQ 唤醒失败重试").closest("section");
    expect(retryGroup?.className).toContain("[&>div:first-child]:flex-col");
    expect(retryGroup?.className).toContain("sm:[&>div:first-child]:flex-row");
    const actionRow = screen.getByRole("button", { name: "保存设置" }).closest(".flex.flex-wrap");
    expect(actionRow?.className).toContain("max-w-full");
    expect(actionRow?.className).toContain("w-full");
    // 面板在连接页末尾：接入设置仍在前，保存按钮按原 i18n 键复用。
    expect(screen.getByRole("button", { name: "保存接入设置" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "保存设置" })).toHaveLength(1);
    fireEvent.change(attempts, { target: { value: "5" } });
    fireEvent.change(wakes, { target: { value: "8" } });
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
    await act(async () => {});
    const [payload] = f.save.mock.calls[0];
    expect(payload.expectedRevision).toBe("pr-1");
    expect(payload.policy.execution?.qq).toEqual({
      retryDelayMs: 15000,
      maxAttempts: 5,
      deliveryTtlSeconds: 600,
    });
    expect(payload.policy.execution?.loop.concurrency).toBe(8);
    // 基线合并：scope 外字段按快照原样回传，授权不动。
    expect(payload.policy.execution?.loop.maxSteps).toBe(16);
    expect(payload.policy.execution?.loop.readBatch).toBe(3);
    expect(payload.policy.execution?.modules.web).toBe(false);
    expect(payload.policy.grants).toEqual(snapshot().policy.grants);
    expect(screen.getByRole("status").textContent).toContain("执行设置已保存");
  });

  it("summarises the QQ modules with links to their capability pages without a duplicate editor", async () => {
    const f = setup();
    await renderTransport({ getPermissions: f.get, savePermissions: f.save });
    // 三个 QQ 模块是总览行加真实跳转：媒体/表情进 media-tools，成员进 qq-member-tools。
    expect(screen.getByText("按需理解 QQ 图片")).toBeTruthy();
    expect(screen.getByText("QQ 表情发送")).toBeTruthy();
    expect(screen.getByText("QQ 群成员名册")).toBeTruthy();
    const links = screen.getAllByRole("button", { name: "前往功能配置" });
    expect(links).toHaveLength(3);
    // 总览状态来自已保存策略：三个模块缺省均开启，只读可辨。
    expect(screen.getAllByText("已开启，仍受授权与会话范围约束")).toHaveLength(3);
    expect(screen.queryByRole("checkbox", { name: "按需理解 QQ 图片" })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "QQ 表情发送" })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: "QQ 群成员名册" })).toBeNull();
    // 模块草稿属能力专页：面板保存不得夹带，也不因它可保存。
    await act(async () => {
      store.getState().patchExecutionSettings({
        modules: { ...editorOf().execution.modules, qqMedia: false, web: true },
      });
    });
    expect((screen.getByRole("button", { name: "保存设置" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.change(screen.getByLabelText("最多尝试次数（含首次）"), { target: { value: "6" } });
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
    await act(async () => {});
    const [payload] = f.save.mock.calls[0];
    expect(payload.policy.execution?.qq.maxAttempts).toBe(6);
    expect(payload.policy.execution?.modules.qqMedia).toBe(true);
    expect(payload.policy.execution?.modules.web).toBe(false);
    const editor = editorOf();
    expect(editor.execution.modules.web).toBe(true);
    expect(editor.execution.modules.qqMedia).toBe(false);
    expect(permissionSettingsDirty(editor, { modules: ["web"] })).toBe(true);
    expect(permissionSettingsDirty(editor, QQ_PANEL_SCOPE)).toBe(false);
  });

  it("saves only the declared keys: another page's invalid or edited draft is neither submitted nor blocking", async () => {
    const f = setup();
    await renderTransport({ getPermissions: f.get, savePermissions: f.save });
    await act(async () => {
      store.getState().patchExecutionSettings({
        loopMaxSteps: "not-a-number",
        loopReadBatch: "2",
      });
    });
    fireEvent.change(screen.getByLabelText("最多尝试次数（含首次）"), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
    await act(async () => {});
    const [payload] = f.save.mock.calls[0];
    expect(payload.expectedRevision).toBe("pr-1");
    expect(payload.policy.execution?.loop.readBatch).toBe(3);
    expect(payload.policy.execution?.loop.maxSteps).toBe(16);
    expect(payload.policy.execution?.modules.web).toBe(false);
    // 成功只推进面板 scope：非法数值草稿仍在，仍属于执行设置页的脏区。
    const after = editorOf();
    expect(after.execution.loopMaxSteps).toBe("not-a-number");
    expect(permissionSettingsDirty(after, { executionKeys: ["loopMaxSteps"] })).toBe(true);
    expect(permissionSettingsDirty(after, QQ_PANEL_SCOPE)).toBe(false);
    expect(after.execution.loopReadBatch).toBe("2");
    expect(permissionSettingsDirty(after, { executionKeys: ["loopReadBatch"] })).toBe(true);
  });

  it("refuses out-of-range QQ values without a PUT and focuses the invalid field", async () => {
    const save = vi.fn();
    await renderTransport({
      getPermissions: vi.fn().mockResolvedValue(snapshot()),
      savePermissions: save,
    });
    const ttl = screen.getByLabelText("投递意图有效期（秒）") as HTMLInputElement;
    fireEvent.change(ttl, { target: { value: "4000" } });
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("超出允许范围"));
    expect(save).not.toHaveBeenCalled();
    expect(ttl.getAttribute("aria-invalid")).toBe("true");
    expect(ttl.value).toBe("4000");
    expect(
      (screen.getByLabelText("最多尝试次数（含首次）") as HTMLInputElement).getAttribute(
        "aria-invalid",
      ),
    ).toBe("false");
  });

  it("keeps the draft and reports a 409 conflict without a second PUT", async () => {
    const save = vi
      .fn()
      .mockRejectedValue(
        new ApiError(409, "PERMISSION_POLICY_CONFLICT", "权限配置已变化，请重新读取后保存"),
      );
    await renderTransport({
      getPermissions: vi.fn().mockResolvedValue(snapshot()),
      savePermissions: save,
    });
    fireEvent.change(screen.getByLabelText("最多尝试次数（含首次）"), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
    const alert = await screen.findByRole("alert");
    await waitFor(() => expect(alert.textContent).toContain("权限配置已变化"));
    expect((screen.getByLabelText("最多尝试次数（含首次）") as HTMLInputElement).value).toBe("5");
    expect(save).toHaveBeenCalledTimes(1);
    // 显式刷新后草稿按原字段保留，revision 推进，保存重试才可能通过 CAS。
    await act(async () => {
      await store.getState().loadPermissionSettings(true);
    });
    expect((screen.getByLabelText("最多尝试次数（含首次）") as HTMLInputElement).value).toBe("5");
  });

  it("routes the module summary buttons to their capability pages", async () => {
    const f = setup();
    await renderTransport({ getPermissions: f.get, savePermissions: f.save });
    const buttons = screen.getAllByRole("button", { name: "前往功能配置" });
    fireEvent.click(buttons[0]);
    expect(store.getState().settingsRoute).toBe("media-tools");
    fireEvent.click(buttons[2]);
    expect(store.getState().settingsRoute).toBe("qq-member-tools");
  });

  it("discard reverts only the QQ panel keys and keeps neighbouring drafts", async () => {
    const f = setup();
    await renderTransport({ getPermissions: f.get, savePermissions: f.save });
    await act(async () => {
      store.getState().patchExecutionSettings({ qqMaxAttempts: "7", loopMaxSteps: "20" });
    });
    fireEvent.click(screen.getByRole("button", { name: "放弃修改" }));
    await act(async () => {});
    const editor = editorOf();
    expect(editor.execution.qqMaxAttempts).toBe("3");
    expect(editor.execution.loopMaxSteps).toBe("20");
  });

  it("shows one real load error with retry and marks module state unread instead of off", async () => {
    const get = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(500, "X", "权限读取失败"))
      .mockResolvedValue(snapshot());
    await renderTransport({ getPermissions: get });
    const alerts = screen.getAllByRole("alert");
    expect(alerts).toHaveLength(1);
    expect(alerts[0].textContent).toContain("权限读取失败");
    expect(screen.queryByLabelText("失败重试间隔（秒）")).toBeNull();
    expect(screen.getAllByText("未读取")).toHaveLength(3);
    expect(screen.queryByText("未开启")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await act(async () => {});
    expect(get).toHaveBeenCalledTimes(2);
    expect((screen.getByLabelText("失败重试间隔（秒）") as HTMLInputElement).value).toBe("15");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getAllByText("已开启，仍受授权与会话范围约束")).toHaveLength(3);
  });

  it("does not repeat an out-of-scope numeric error the panel cannot fix", async () => {
    const f = setup();
    await renderTransport({ getPermissions: f.get, savePermissions: f.save });
    await act(async () => {
      store.getState().patchExecutionSettings({ loopMaxSteps: "x" });
    });
    await act(async () => {
      expect(
        await store.getState().savePermissionSettings({ executionKeys: ["loopMaxSteps"] }),
      ).toBe(false);
    });
    expect(store.getState().permissionProblem).toBe("loopMaxSteps");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does not load the permission snapshot when the connection page is inactive", async () => {
    const get = vi.fn(async () => structuredClone(snapshot()));
    store.getState().resetForTests({ ...api, getPermissions: get } as unknown as typeof api);
    store.setState({
      qqSettings,
      page: "settings",
      settingsView: "workspace",
      settingsRoute: "qq-connection",
    });
    const view = render(<TransportSettings active={false} />);
    await act(async () => {});
    expect(get).not.toHaveBeenCalled();
    expect(store.getState().permissionEditor).toBeNull();
    // 激活后恰好转一次；已读过的页面不重复全量刷新。
    view.rerender(<TransportSettings active />);
    await act(async () => {});
    view.rerender(<TransportSettings active />);
    await act(async () => {});
    expect(get).toHaveBeenCalledTimes(1);
    expect(store.getState().permissionEditor).not.toBeNull();
  });

  it("converts decimal seconds to integer milliseconds on save and rejects sub-millisecond precision without submitting", async () => {
    const f = setup();
    await renderTransport({ getPermissions: f.get, savePermissions: f.save });
    const retry = screen.getByLabelText("失败重试间隔（秒）") as HTMLInputElement;
    expect(retry.value).toBe("15");

    // 合法小数秒 2.5s -> 2500ms
    fireEvent.change(retry, { target: { value: "2.5" } });
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
    await act(async () => {});
    expect(f.save).toHaveBeenCalledTimes(1);
    expect(f.save.mock.calls[0][0].policy.execution?.qq.retryDelayMs).toBe(2500);

    // 亚毫秒超精度 1.0005s 拒绝提交，设置 aria-invalid
    fireEvent.change(retry, { target: { value: "1.0005" } });
    fireEvent.click(screen.getByRole("button", { name: "保存设置" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("超出允许范围"));
    expect(f.save).toHaveBeenCalledTimes(1);
    expect(retry.getAttribute("aria-invalid")).toBe("true");
  });
});
