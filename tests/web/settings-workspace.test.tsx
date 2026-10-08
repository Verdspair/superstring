import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentResponse, PersonaResponse } from "../../src/shared/contracts";
import { api, type SuperstringApi } from "../../src/web/api";
import { DesignSystemProvider } from "../../src/web/design-system/Providers";
import { selectLocale } from "../../src/web/i18n";
import { i18n } from "../../src/web/i18n/runtime";
import { activeSpace, SPACES } from "../../src/web/workspace/navigation";
import { SETTINGS_ROUTES } from "../../src/web/workspace/settings-routes";
import { WorkspaceCommand } from "../../src/web/workspace/WorkspaceCommand";
import { WorkspaceShell } from "../../src/web/workspace/WorkspaceShell";
import { fixtureStore as store } from "./helpers/chat-fixture";

const originalActions = {
  reloadMemory: store.getState().reloadMemory,
  saveCurrentSection: store.getState().saveCurrentSection,
};
const agent = (id: string) =>
  ({
    id,
    name: id,
    is_active: true,
    config_version: 1,
    model_name: "model",
    p5_config: {},
  }) as AgentResponse;
const persona = (id: string) => ({ id, agent_id: id }) as PersonaResponse;
beforeEach(() => {
  selectLocale("zh-CN");
  store.getState().resetForTests({} as SuperstringApi);
  store.setState(originalActions);
  store.setState({
    page: "settings",
    settingsView: "workspace",
    agents: [agent("A"), agent("B")],
    editorAgentId: "A",
    editorDraft: { name: "A" } as never,
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  store.setState(originalActions);
  selectLocale("zh-CN");
  vi.unstubAllGlobals();
});
describe("task-based workspace navigation", () => {
  it("product spaces are distinct from environment settings and conversation index", () => {
    render(
      <DesignSystemProvider>
        <WorkspaceShell>
          <p>Workspace content</p>
        </WorkspaceShell>
      </DesignSystemProvider>,
    );
    const primary = within(screen.getByRole("navigation", { name: "工作区" }));
    expect(primary.getAllByRole("button").map((button) => button.textContent)).toEqual(
      SPACES.map((space) => i18n.t(space.label)),
    );
    expect(screen.queryByRole("navigation", { name: "历史会话" })).toBeNull();
    // 运行一级栏目已取消：台账与任务归对话的消息/观测/任务，侧栏不再有运行入口。
    expect(primary.queryByRole("button", { name: "运行" })).toBeNull();
    expect(SPACES.some((space) => (space.id as string) === "runs")).toBe(false);
    fireEvent.click(primary.getByRole("button", { name: "对话" }));
    expect(store.getState()).toMatchObject({
      page: "chat",
      conversationView: "messages",
      conversationScope: "current",
    });
    // 接入改名为「扩展」：只留外置 MCP/技能/工具授权，默认落在 MCP 服务。
    fireEvent.click(primary.getByRole("button", { name: "扩展" }));
    expect(store.getState()).toMatchObject({
      settingsView: "workspace",
      settingsRoute: "mcp-servers",
    });
    fireEvent.click(primary.getByRole("button", { name: "系统能力" }));
    expect(store.getState()).toMatchObject({
      settingsView: "workspace",
      settingsRoute: "system-capabilities",
    });
    fireEvent.click(primary.getByRole("button", { name: "方案" }));
    expect(store.getState()).toMatchObject({
      settingsView: "workspace",
      settingsRoute: "scheme-library",
    });
    fireEvent.click(screen.getByRole("button", { name: "偏好" }));
    expect(store.getState().settingsView).toBe("general");
  });
  it("every retained capability has a searchable entry and a defined product owner", () => {
    render(
      <DesignSystemProvider>
        <WorkspaceCommand open onOpenChange={() => {}} returnTo={null} />
      </DesignSystemProvider>,
    );
    for (const route of SETTINGS_ROUTES) {
      expect(screen.getAllByRole("option", { name: new RegExp(i18n.t(route.title)) })).toBeTruthy();
      expect(
        activeSpace({ page: "settings", settingsView: "workspace", settingsRoute: route.id }),
      ).toBeTruthy();
    }
    // 原 qq-scheme-config 详情归方案一级；目录入口是 scheme-library，绑定首次发现入口 scheme-bindings。
    expect(
      activeSpace({
        page: "settings",
        settingsView: "workspace",
        settingsRoute: "qq-scheme-config",
      }),
    ).toBe("schemes");
    expect(
      activeSpace({
        page: "settings",
        settingsView: "workspace",
        settingsRoute: "scheme-bindings",
      }),
    ).toBe("schemes");
    // QQ 应用级路由与旧 operating-mode 都归方案：连接与数据保留随 QQ 应用走。
    for (const route of ["qq-app-schemes", "qq-connection", "qq-storage"] as const) {
      expect(
        activeSpace({ page: "settings", settingsView: "workspace", settingsRoute: route }),
      ).toBe("schemes");
    }
    expect(
      activeSpace({ page: "settings", settingsView: "operating-mode", settingsRoute: "basic" }),
    ).toBe("schemes");
    expect(
      activeSpace({ page: "settings", settingsView: "workspace", settingsRoute: "mcp-servers" }),
    ).toBe("connections");
    // 运行一级栏目取消后，台账/任务路由归对话。
    expect(
      activeSpace({
        page: "settings",
        settingsView: "workspace",
        settingsRoute: "execution-ledger",
      }),
    ).toBe("conversations");
    expect(
      activeSpace({ page: "settings", settingsView: "workspace", settingsRoute: "task-ledger" }),
    ).toBe("conversations");
    expect(
      activeSpace({ page: "settings", settingsView: "observability", settingsRoute: "basic" }),
    ).toBe("conversations");
  });
  it("changing the configuration target preserves the bound chat and next-chat identity", async () => {
    store.setState({
      apiClient: {
        getAgent: async (id) => agent(id),
        getPersona: async (id) => persona(id),
      } as SuperstringApi,
      currentSessionId: "chat-A",
      selectedNewSessionAgentId: "A",
      reloadMemory: vi.fn().mockResolvedValue(undefined),
    });
    await act(async () => store.getState().requestAgentNavigation("B"));
    expect(store.getState()).toMatchObject({
      editorAgentId: "B",
      currentSessionId: "chat-A",
      selectedNewSessionAgentId: "A",
    });
  });
  it("English navigation renders translated resource labels", () => {
    selectLocale("en");
    const { container } = render(
      <DesignSystemProvider>
        <WorkspaceShell>
          <p>Workspace content</p>
        </WorkspaceShell>
      </DesignSystemProvider>,
    );
    expect(container.textContent).not.toMatch(/[\u4e00-\u9fff]/);
  });
  it("旧页未保存导航被拦截，取消保持原页和目标路由", () => {
    store.setState({
      settingsView: "agents",
      dirty: true,
      settingsRoute: "basic",
    });
    store.getState().openSettingsRoute("expression");
    expect(store.getState()).toMatchObject({
      settingsView: "agents",
      settingsRoute: "basic",
      navigationConfirmOpen: true,
      pendingNavigation: {
        kind: "page",
        settingsView: "workspace",
        settingsRoute: "expression",
      },
    });
    store.getState().cancelPendingNavigation();
    expect(store.getState()).toMatchObject({
      settingsView: "agents",
      dirty: true,
      settingsRoute: "basic",
    });
  });
  it("放弃旧页草稿后到达准确的新二级页", async () => {
    store.setState({ settingsView: "agents", dirty: true });
    store.getState().openSettingsRoute("context");
    await store.getState().confirmDiscardAndContinue();
    expect(store.getState()).toMatchObject({
      settingsView: "workspace",
      settingsRoute: "context",
      dirty: false,
      editorDraft: null,
    });
  });
  it("保存失败不绕过导航守卫", async () => {
    const save = vi.fn().mockResolvedValue(false);
    store.setState({
      settingsView: "agents",
      dirty: true,
      saveCurrentSection: save,
    });
    store.getState().openSettingsRoute("context");
    await store.getState().confirmSaveAndContinue();
    expect(save).toHaveBeenCalledOnce();
    expect(store.getState()).toMatchObject({
      settingsView: "agents",
      dirty: true,
      navigationConfirmOpen: true,
    });
  });
  it("资料草稿跨设置页保留，离开设置走独立守卫", () => {
    store.setState({ settingsView: "knowledge", knowledgeDirty: true });
    store.getState().openSettingsRoute("knowledge-config");
    expect(store.getState()).toMatchObject({
      settingsView: "workspace",
      settingsRoute: "knowledge-config",
      knowledgeDirty: true,
      pendingNavigation: null,
    });
    store.getState().openSettingsRoute("management");
    expect(store.getState().knowledgeDirty).toBe(true);
    store.getState().openChat();
    expect(store.getState()).toMatchObject({
      page: "settings",
      navigationConfirmOpen: true,
      pendingNavigation: { kind: "page", page: "chat" },
    });
  });
  it("助手读取中允许页面切换，迟到读取不接管新页面", async () => {
    let resolveAgent!: (value: AgentResponse) => void;
    store.setState({
      apiClient: {
        ...api,
        getAgent: () => new Promise<AgentResponse>((resolve) => (resolveAgent = resolve)),
        getPersona: async () => persona("A"),
      } as SuperstringApi,
      reloadMemory: vi.fn().mockResolvedValue(undefined),
    });

    const loading = store.getState().editAgent("A");
    expect(store.getState().editorLoading).toBe(true);
    store.getState().openSettingsRoute("context");
    expect(store.getState()).toMatchObject({
      settingsRoute: "context",
      page: "settings",
      editorAgentId: "A",
      editorLoading: true,
    });

    store.getState().openChat();
    expect(store.getState()).toMatchObject({ page: "chat", conversationView: "messages" });

    resolveAgent(agent("A"));
    await loading;
    expect(store.getState()).toMatchObject({
      page: "chat",
      editorAgentId: "A",
      editorLoading: false,
      pendingNavigation: null,
    });

    store.setState({ dirty: true, settingsSaving: true });
    store.getState().openSettingsRoute("scheme-library");
    store.getState().requestAgentNavigation("B");
    expect(store.getState()).toMatchObject({
      page: "chat",
      settingsRoute: "context",
      editorAgentId: "A",
      dirty: true,
      settingsSaving: true,
      pendingNavigation: null,
    });
  });
  it("迟到的助手加载不能覆盖最新选择", async () => {
    let resolveA!: (value: AgentResponse) => void;
    store.setState({
      apiClient: {
        getAgent: (id: string) =>
          id === "A"
            ? new Promise<AgentResponse>((resolve) => {
                resolveA = resolve;
              })
            : Promise.resolve(agent(id)),
        getPersona: async (id) => persona(id),
      } as SuperstringApi,
      reloadMemory: vi.fn().mockResolvedValue(undefined),
    });
    const old = store.getState().editAgent("A");
    await store.getState().editAgent("B");
    resolveA(agent("A"));
    await old;
    expect(store.getState()).toMatchObject({
      editorAgentId: "B",
      editorLoading: false,
    });
  });
});
