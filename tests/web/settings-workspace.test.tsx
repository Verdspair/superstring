import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentResponse, PersonaResponse } from "../../src/shared/contracts";
import { Sidebar } from "../../src/web/App";
import type { SuperstringApi } from "../../src/web/api";
import { APP_SECTIONS, routeSection } from "../../src/web/app/app-routes";
import { SettingsHeader } from "../../src/web/app/SettingsHeader";
import { SettingsHub } from "../../src/web/app/SettingsHub";
import { SettingsBody } from "../../src/web/app/SettingsSidebar";
import { SettingsWorkspace } from "../../src/web/app/SettingsWorkspace";
import { KNOWLEDGE_PLANNED_FIELDS, SETTINGS_ROUTES } from "../../src/web/app/settings-routes";
import { selectLocale } from "../../src/web/i18n";
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
});
afterEach(() => {
  cleanup();
  store.setState(originalActions);
  selectLocale("zh-CN");
});

describe("设置工作区第一阶段", () => {
  it("统一一级导航保留对话目录，每个原有设置页面均由所属二级导航可达", () => {
    const { container } = render(
      <>
        <Sidebar />
        <main>
          <SettingsHeader />
          <SettingsBody>
            <div>Settings content</div>
          </SettingsBody>
        </main>
      </>,
    );
    const aside = screen.getByRole("complementary");
    expect(within(aside).getByRole("button", { name: "新建任务" })).toBeTruthy();
    expect(within(aside).getByRole("navigation", { name: "历史会话" })).toBeTruthy();
    const primary = within(within(aside).getByRole("navigation", { name: "主导航" }));
    expect(primary.getAllByRole("button").map((el) => el.textContent)).toEqual(
      APP_SECTIONS.map((section) => section.title),
    );
    for (const route of SETTINGS_ROUTES) {
      const section = APP_SECTIONS.find((item) => item.id === routeSection(route.id));
      expect(section).toBeDefined();
      if (!section) throw new Error(`No section for ${route.id}`);
      fireEvent.click(primary.getByRole("button", { name: section.title }));
      const secondary = within(screen.getByRole("navigation", { name: "配置页面" }));
      fireEvent.click(secondary.getByRole("button", { name: new RegExp(route.title) }));
      if (route.id === "basic") expect(store.getState().settingsView).toBe("agents");
      else expect(store.getState().settingsRoute).toBe(route.id);
    }
    expect(store.getState().editorAgentId).toBe("A");
    expect(aside.querySelector(".settings-secondary-nav")).toBeNull();
    expect(
      container.querySelector(".settings-body > .settings-body-content > .settings-secondary-nav"),
    ).toBeTruthy();
    expect(container.querySelector(".settings-header nav")).toBeNull();
    expect(container.querySelector(".settings-navigation")).toBeNull();
    fireEvent.click(primary.getByRole("button", { name: "接入" }));
    expect(store.getState().settingsView).toBe("operating-mode");
    fireEvent.click(primary.getByRole("button", { name: "偏好" }));
    expect(store.getState().settingsView).toBe("general");
    fireEvent.click(screen.getByRole("button", { name: "返回对话" }));
    expect(screen.getByRole("button", { name: "新建任务" })).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "配置页面" })).toBeNull();
  });
  it("设置中心按 Agent、资料、接入与偏好提供入口，原页面继续可达", () => {
    render(<SettingsHub />);
    const hub = within(screen.getByRole("navigation", { name: "功能设置" }));
    for (const [title, view, route] of [
      ["Agent", "workspace", "models"],
      ["资料", "workspace", "long-memory"],
      ["接入", "operating-mode", null],
      ["偏好", "general", null],
    ] as const) {
      fireEvent.click(hub.getByRole("button", { name: title }));
      expect(store.getState().settingsView).toBe(view);
      if (route) expect(store.getState().settingsRoute).toBe(route);
    }
  });
  it("共用选择器不改变当前会话及新会话助手", async () => {
    store.setState({
      apiClient: {
        getAgent: async (id) => agent(id),
        getPersona: async (id) => persona(id),
      } as SuperstringApi,
      currentSessionId: "chat-A",
      selectedNewSessionAgentId: "A",
      reloadMemory: vi.fn().mockResolvedValue(undefined),
    });
    render(<SettingsWorkspace />);
    await act(async () =>
      fireEvent.change(screen.getByRole("combobox", { name: "正在配置的助手" }), {
        target: { value: "B" },
      }),
    );
    expect(store.getState()).toMatchObject({
      editorAgentId: "B",
      currentSessionId: "chat-A",
      selectedNewSessionAgentId: "A",
    });
    act(() => store.getState().openSettingsRoute("identity"));
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("B");
  });
  it("全局页面显式声明不随助手切换", () => {
    store.getState().openSettingsRoute("knowledge-model");
    expect(store.getState().settingsRoute).toBe("models");
    render(<SettingsWorkspace />);
    expect(screen.getByText("全局默认：记忆整理与知识库整理共用，不随助手切换。")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "重试读取全局配置" })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "重试读取共同默认模型" })).toBeTruthy();
  });
  it("剩余五项知识策略只展示未开放，加载失败不显示虚假控件", () => {
    store.setState({ settingsRoute: "knowledge-config" });
    const { container } = render(<SettingsWorkspace />);
    for (const label of KNOWLEDGE_PLANNED_FIELDS)
      expect(document.querySelector(".knowledge-planned")?.textContent).toContain(label);
    expect(container.querySelectorAll("input, textarea")).toHaveLength(0);
    expect(KNOWLEDGE_PLANNED_FIELDS).toHaveLength(5);
    expect(screen.getByRole("button", { name: "重试读取知识库配置" })).toBeTruthy();
  });
  it("二级导航进入助手总览，不再展开详细配置", () => {
    store.setState({ settingsRoute: "management" });
    render(<SettingsWorkspace />);
    fireEvent.click(screen.getByRole("button", { name: "助手管理" }));
    expect(store.getState()).toMatchObject({
      settingsView: "agents",
      editorAgentId: "A",
    });
    expect(screen.queryByText("详细配置")).toBeNull();
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
  it("模型页不再套助手管理区块，管理仅由二级导航进入", () => {
    store.setState({ settingsRoute: "management" });
    render(<SettingsWorkspace />);
    expect(document.querySelector('[aria-label="助手管理"]')).toBeNull();
    expect(screen.getByRole("button", { name: "助手管理" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "原资料管理" })).toBeNull();
    expect(screen.getByRole("heading", { name: "默认模型" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "共同整理默认值" })).toBeTruthy();
  });
  it("统一模型页归 Agent，原模型分类不再重复展示", async () => {
    store.setState({
      settingsRoute: "models",
      apiClient: {
        getOrganizationSettings: async () => ({
          model_name: null,
          revision: 1,
        }),
        getKnowledgeSettings: async () => ({
          model_name: null,
          revision: 1,
          auto_enabled: true,
          context_budget: 4096,
        }),
      } as SuperstringApi,
    });
    await act(async () => {
      render(
        <>
          <Sidebar />
          <SettingsWorkspace />
        </>,
      );
    });
    expect(screen.getByRole("heading", { name: "默认模型" })).toBeTruthy();
    expect(document.querySelector(".app-primary-nav [aria-current]")?.textContent).toBe("Agent");
    expect(screen.getByRole("combobox", { name: "知识库整理模型" })).toBeTruthy();
    expect(screen.queryByRole("spinbutton", { name: "知识库上下文预算" })).toBeNull();
    expect(SETTINGS_ROUTES.filter((r) => r.group === "management").map((r) => r.id)).toEqual([
      "basic",
      "models",
      "external-api",
    ]);
    expect(document.querySelector(".app-primary-nav")?.textContent).not.toContain("模型");
    expect(
      document
        .querySelector(".settings-workspace")
        ?.firstElementChild?.classList.contains("shared-agent-selector"),
    ).toBe(true);
    act(() => store.getState().openSettingsRoute("knowledge-config"));
    expect(screen.queryByRole("combobox", { name: "知识库整理模型" })).toBeNull();
    expect(screen.getByRole("spinbutton", { name: "知识库上下文预算" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "前往默认模型" })).toBeTruthy();
  });
  it("短期上下文与长期记忆各归所属页面，均保留原设置入口", () => {
    store.setState({ settingsRoute: "long-memory" });
    render(
      <>
        <Sidebar />
        <SettingsWorkspace />
      </>,
    );
    const primary = within(screen.getByRole("navigation", { name: "主导航" }));
    expect(
      Array.from(document.querySelectorAll(".settings-secondary-nav button")).map(
        (tab) => tab.textContent,
      ),
    ).toEqual(["长期记忆", "知识库配置", "用户画像未开放"]);
    fireEvent.click(primary.getByRole("button", { name: "Agent" }));
    fireEvent.click(screen.getByRole("button", { name: "短期上下文" }));
    expect(store.getState().settingsRoute).toBe("context");
    fireEvent.click(primary.getByRole("button", { name: "资料" }));
    fireEvent.click(screen.getByRole("button", { name: "长期记忆" }));
    expect(store.getState().settingsRoute).toBe("long-memory");
    expect(store.getState().editorAgentId).toBe("A");
  });
  it("英文新侧栏与知识页面没有中文界面词条", () => {
    selectLocale("en");
    store.setState({ settingsRoute: "knowledge-config" });
    const { container } = render(
      <>
        <Sidebar />
        <SettingsWorkspace />
      </>,
    );
    expect(container.textContent).not.toMatch(/[\u4e00-\u9fff]/);
  });
});
