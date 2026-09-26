import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AgentResponse } from "../../src/shared/contracts";
import App, { AppearanceSettings, Sidebar } from "../../src/web/App";
import {
  applyMode,
  applyTheme,
  MODE_STORAGE_KEY,
  observeSystemAppearance,
  readMode,
  readTheme,
  resolveTheme,
  selectMode,
  selectTheme,
  THEME_STORAGE_KEY,
  THEMES,
} from "../../src/web/appearance";
import { useSuperstringStore } from "../../src/web/store";

// 侧栏与新会话设置只用 id/name/is_active，其余字段与本次 UI 断言无关。
function fakeAgent(id: string, name: string, isActive = true): AgentResponse {
  return {
    id,
    name,
    is_active: isActive,
    config_version: 1,
  } as unknown as AgentResponse;
}

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.themeUnsaved;
  delete document.documentElement.dataset.modeUnsaved;
  applyTheme("slate");
  applyMode("system");
  useSuperstringStore.getState().resetForTests();
  useSuperstringStore.setState({
    status: "ready",
    bootstrap: vi.fn().mockResolvedValue(undefined),
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  applyTheme("slate");
  applyMode("system");
  localStorage.clear();
  delete document.documentElement.dataset.themeUnsaved;
  delete document.documentElement.dataset.modeUnsaved;
});

it("浏览器拒绝保存时同步读取仍保持当前完整外观", () => {
  localStorage.setItem(THEME_STORAGE_KEY, "slate");
  localStorage.setItem(MODE_STORAGE_KEY, "light");
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  expect(selectTheme("rose")).toBe(false);
  expect(selectMode("dark")).toBe(false);
  expect({ theme: readTheme(), mode: readMode() }).toEqual({
    theme: "rose",
    mode: "dark",
  });
  expect(document.documentElement.dataset.theme).toBe("rose");
  expect(document.documentElement.classList.contains("dark")).toBe(true);
});

it("16个主题圆可立即切换，持久化并显示选中状态", () => {
  render(<AppearanceSettings />);
  expect(screen.getAllByRole("button", { name: /主题/ })).toHaveLength(16);
  fireEvent.click(screen.getByRole("button", { name: "松绿主题" }));
  expect(document.documentElement.dataset.theme).toBe("forest");
  expect(screen.getByRole("button", { name: "松绿主题" }).getAttribute("aria-pressed")).toBe(
    "true",
  );
  expect(readTheme()).toBe("forest");
  expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("forest");
  expect(screen.getByRole("status").textContent).toBe("已切换为松绿");
  expect(screen.getByRole("status").querySelector(".theme-dot")).toBeTruthy();
});

it("切回默认清除覆盖，未知/损坏偏好回退", () => {
  for (const theme of THEMES) {
    applyTheme(theme.id);
    expect(document.documentElement.dataset.theme).toBe(theme.id);
  }
  applyTheme("slate");
  expect(document.documentElement.style.getPropertyValue("--superstring-tone-deep")).toBe("");
  localStorage.setItem(THEME_STORAGE_KEY, "invalid-color");
  expect(readTheme()).toBe("slate");
  expect(resolveTheme(null).id).toBe("slate");
});

it("浏览器拒绝存储时仍切换，并如实告知", () => {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  render(<AppearanceSettings />);
  fireEvent.click(screen.getByRole("button", { name: "海蓝主题" }));
  expect(document.documentElement.dataset.theme).toBe("blue");
  expect(screen.getByRole("status").textContent).toContain("未允许保存");
  expect(selectTheme("rose")).toBe(false);
});

it("设置中心可进入外观再返回，自定义不提供可操作入口", () => {
  useSuperstringStore.setState({ page: "settings", settingsView: "hub" });
  render(<App />);
  fireEvent.click(
    within(screen.getByRole("navigation", { name: "功能设置" })).getByRole("button", {
      name: "偏好",
    }),
  );
  fireEvent.click(screen.getByText("外观"));
  expect(screen.getByText("推荐外观")).toBeTruthy();
  expect(screen.getByText("自定义外观")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: /自定义外观/ }));
  expect(screen.getByText("自定义颜色与更多外观选项暂未开放。")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "返回设置中心" }));
  expect(
    within(screen.getByRole("navigation", { name: "功能设置" })).getByRole("button", {
      name: "Agent",
    }),
  ).toBeTruthy();
});

it("设置入口整行可点，返回导航位于主栏页头且仅显示图标", async () => {
  useSuperstringStore.setState({ page: "settings", settingsView: "hub" });
  const { container } = render(<App />);
  const row = within(screen.getByRole("navigation", { name: "功能设置" })).getByRole("button", {
    name: "Agent",
  });
  expect(row.classList.contains("settings-entry")).toBe(true);
  expect(row.querySelector("button")).toBeNull();
  expect(
    within(screen.getByRole("navigation", { name: "功能设置" })).getAllByRole("button"),
  ).toHaveLength(4);
  expect(screen.queryByText("打开配置")).toBeNull();
  await act(async () => fireEvent.click(row));
  const back = screen.getByRole("button", { name: "返回设置中心" });
  expect(back.textContent).toBe("");
  expect(back.getAttribute("title")).toBe("返回设置中心");
  expect(back.closest(".page-header")).toBeTruthy();
  expect(container.querySelector(".agent-settings .back-link")).toBeNull();
  expect(back.querySelector("svg")).toBeTruthy();
  await act(async () => fireEvent.click(back));
  fireEvent.click(
    within(screen.getByRole("navigation", { name: "功能设置" })).getByRole("button", {
      name: "偏好",
    }),
  );
  fireEvent.click(screen.getByText("外观"));
  expect(screen.getByRole("button", { name: "返回设置中心" }).textContent).toBe("");
});

it("外观页使用可键盘操作的折叠分区，未开放项只展示说明", () => {
  render(<AppearanceSettings />);
  const trigger = screen.getByRole("button", { name: /自定义外观/ });
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(trigger);
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  const panel = document.getElementById(trigger.getAttribute("aria-controls") ?? "");
  expect(panel?.textContent).toContain("自定义颜色与更多外观选项暂未开放。");
  expect(panel?.querySelectorAll("button")).toHaveLength(0);
  expect(screen.getByRole("button", { name: /推荐外观/ }).getAttribute("aria-expanded")).toBe(
    "true",
  );
  expect(
    screen.getByRole("button", { name: /明暗模式.*跟随系统/ }).getAttribute("aria-expanded"),
  ).toBe("true");
});

it("明暗模式可固定浅色/深色或跟随系统，持久化并即时生效", () => {
  render(<AppearanceSettings />);
  const root = document.documentElement;
  fireEvent.click(screen.getByRole("button", { name: "深色" }));
  expect(root.dataset.mode).toBe("dark");
  expect(root.classList.contains("dark")).toBe(true);
  expect(root.classList.contains("light")).toBe(false);
  expect(localStorage.getItem(MODE_STORAGE_KEY)).toBe("dark");
  expect(screen.getByRole("button", { name: "深色" }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "浅色" }));
  expect(root.classList.contains("light")).toBe(true);
  expect(root.classList.contains("dark")).toBe(false);
  expect(localStorage.getItem(MODE_STORAGE_KEY)).toBe("light");
  fireEvent.click(screen.getByRole("button", { name: "跟随系统" }));
  expect(root.dataset.mode).toBe("system");
  expect(root.classList.contains("light")).toBe(false);
  expect(root.classList.contains("dark")).toBe(false);
  expect(screen.getByText("当前：跟随系统")).toBeTruthy();
});

it("主题只投影强调色，中性表面与边框由语义令牌保持一致", () => {
  const root = document.documentElement;
  for (const theme of THEMES) {
    applyTheme(theme.id);
    for (const role of ["--primary", "--ring", "--sidebar-primary", "--sidebar-ring"])
      expect(root.style.getPropertyValue(role)).toBe(`light-dark(${theme.color}, ${theme.dark})`);
    expect(root.style.getPropertyValue("--primary-foreground")).toBe(
      "light-dark(#ffffff, #171717)",
    );
    for (const property of [
      "--superstring-tone-deep",
      "--superstring-tone-light",
      "--superstring-tone-line",
      "--superstring-tone-soft",
      "--ac-accent-soft",
      "--background",
      "--card",
      "--accent",
      "--border",
    ])
      expect(root.style.getPropertyValue(property)).toBe("");
  }
});

it("侧栏移除新会话助手设置，改由设置中心承担", () => {
  useSuperstringStore.setState({
    status: "ready",
    agents: [fakeAgent("11111111-1111-4111-8111-111111111111", "本地助手")],
  });
  render(<Sidebar />);
  expect(screen.queryByLabelText("新会话使用的 Agent")).toBeNull();
  expect(screen.queryByText("聊天模式 · 本地工作空间")).toBeNull();
});

it("新会话默认助手并入助手设置的下拉，停用助手不出现", async () => {
  const first = "11111111-1111-4111-8111-111111111111";
  const second = "22222222-2222-4222-8222-222222222222";
  const editAgent = useSuperstringStore.getState().editAgent;
  useSuperstringStore.setState({
    page: "settings",
    settingsView: "hub",
    agents: [
      fakeAgent(first, "本地助手"),
      fakeAgent(second, "备用助手"),
      fakeAgent("x", "停用助手", false),
    ],
    selectedNewSessionAgentId: first,
    editAgent: vi.fn().mockResolvedValue(true),
  });
  render(<App />);
  // 新会话不再是设置中心的一级入口，它是助手设置里助手下拉的一部分。
  expect(
    within(screen.getByRole("navigation", { name: "功能设置" }))
      .getAllByRole("button")
      .map((button) => button.getAttribute("aria-label") ?? button.textContent),
  ).toEqual(["Agent", "资料", "接入", "偏好"]);
  expect(screen.queryByRole("button", { name: "新会话" })).toBeNull();
  await act(async () =>
    fireEvent.click(
      within(screen.getByRole("navigation", { name: "功能设置" })).getByRole("button", {
        name: "Agent",
      }),
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "助手管理" }));
  const select = screen.getByLabelText("新会话使用的助手") as HTMLSelectElement;
  expect([...select.options].map((option) => option.textContent)).toEqual(["本地助手", "备用助手"]);
  fireEvent.change(select, { target: { value: second } });
  expect(useSuperstringStore.getState().selectedNewSessionAgentId).toBe(second);
  fireEvent.click(screen.getByRole("button", { name: "返回设置中心" }));
  expect(
    within(screen.getByRole("navigation", { name: "功能设置" })).getByRole("button", {
      name: "Agent",
    }),
  ).toBeTruthy();
  useSuperstringStore.setState({ editAgent });
});

it("进入外观仍遵守助手草稿的未保存保护", () => {
  useSuperstringStore.setState({
    page: "settings",
    settingsView: "agents",
    dirty: true,
  });
  useSuperstringStore.getState().requestPageNavigation("settings", "appearance");
  expect(useSuperstringStore.getState().settingsView).toBe("agents");
  expect(useSuperstringStore.getState().navigationConfirmOpen).toBe(true);
  expect(useSuperstringStore.getState().pendingNavigation).toEqual({
    kind: "page",
    page: "settings",
    settingsView: "appearance",
  });
});

it("用户画像在独立记忆页面保留未开放，不恢复旧字母分区", async () => {
  await useSuperstringStore.getState().editAgent("__new__");
  useSuperstringStore.setState({
    page: "settings",
    settingsView: "agents",
    activeSection: "G",
  });
  useSuperstringStore.setState({
    dirty: false,
    settingsView: "workspace",
    settingsRoute: "profile",
  });
  const { container } = render(<App />);
  expect(container.querySelector(".section-nav")).toBeNull();
  expect(screen.getByRole("heading", { name: "用户画像" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "保存当前分区配置" })).toBeNull();
  expect(screen.getByText("状态：暂未开放")).toBeTruthy();
});

it("跟随系统只改变实际配色，不覆盖保存的模式或手动选择", () => {
  let dark = true;
  let notify: (() => void) | undefined;
  const remove = vi.fn();
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      get matches() {
        return dark;
      },
      addEventListener: (_: string, listener: () => void) => {
        notify = listener;
      },
      removeEventListener: remove,
    })),
  );
  try {
    selectMode("system");
    const stop = observeSystemAppearance();
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.style.colorScheme).toBe("dark");
    dark = false;
    notify?.();
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(readMode()).toBe("system");
    selectMode("dark");
    notify?.();
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(readMode()).toBe("dark");
    stop();
    expect(remove).toHaveBeenCalledWith("change", notify);
  } finally {
    vi.unstubAllGlobals();
  }
});
