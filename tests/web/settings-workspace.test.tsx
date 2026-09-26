import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentResponse, PersonaResponse } from "../../src/shared/contracts";
import type { SuperstringApi } from "../../src/web/api";
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
  it("five product spaces are distinct from environment settings and conversation index", () => {
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
    fireEvent.click(primary.getByRole("button", { name: "接入" }));
    expect(store.getState().settingsView).toBe("operating-mode");
    fireEvent.click(primary.getByRole("button", { name: "运行" }));
    expect(store.getState().settingsView).toBe("observability");
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
  it("助手读取中禁止页面或助手切换", () => {
    store.setState({ editorLoading: true });
    store.getState().openSettingsRoute("context");
    store.getState().openChat();
    store.getState().requestAgentNavigation("B");
    expect(store.getState()).toMatchObject({
      settingsRoute: "basic",
      page: "settings",
      editorAgentId: "A",
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
