import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App, { SectionB, Sidebar } from "../../src/web/App";
import type { SuperstringApi } from "../../src/web/api";
import { useSuperstringStore } from "../../src/web/store";

function fakeClient(): SuperstringApi {
  return {} as SuperstringApi;
}

afterEach(() => cleanup());

beforeEach(() => {
  useSuperstringStore.getState().resetForTests(fakeClient());
  useSuperstringStore.setState({ status: "ready" });
});

describe("现有版面文案精简", () => {
  it("保留 A—I 分区和保存入口，移除重复副标题", async () => {
    await useSuperstringStore.getState().editAgent("__new__");
    useSuperstringStore.setState({
      page: "settings",
      settingsView: "agents",
      bootstrap: vi.fn().mockResolvedValue(undefined),
    });
    const { container } = render(<App />);
    expect(screen.getByRole("heading", { name: "助手管理" })).toBeTruthy();
    expect(container.querySelectorAll(".agent-settings .section-nav button")).toHaveLength(0);
    expect(container.querySelector(".detail-config")).toBeNull();
    expect(screen.queryByText("详细配置")).toBeNull();
    expect(screen.getByRole("button", { name: "创建助手" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "助手名称" })).toBeTruthy();
    expect(screen.queryByText("统一管理 Superstring 的功能与偏好")).toBeNull();
    expect(screen.queryByText("显示在 Agent 列表和会话选择中。")).toBeNull();
  });
});

describe("分组与提示层级", () => {
  it("助手管理先展示当前助手，再展示完整列表与批量操作", async () => {
    await useSuperstringStore.getState().editAgent("__new__");
    useSuperstringStore.setState({
      page: "settings",
      settingsView: "agents",
      bootstrap: vi.fn().mockResolvedValue(undefined),
    });
    const { container } = render(<App />);
    expect(screen.getByText("正在创建 · 未保存")).toBeTruthy();
    const selector = screen.getByRole("combobox", { name: "正在配置的助手" });
    expect((selector as HTMLSelectElement).value).toBe("__new__");
    const current = screen.getByRole("region", { name: "当前助手" });
    const list = screen.getByRole("region", { name: "所有助手" });
    expect(current.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(
      selector.compareDocumentPosition(current) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(current.querySelector(".agent-current-identity")).toBeNull();
    const createAction = screen.getByRole("button", { name: "新建助手" });
    expect(createAction.closest(".agent-editor-list")).toBeNull();
    expect(createAction.getAttribute("aria-pressed")).toBeNull();
    expect(container.querySelectorAll(".agent-settings .section-nav button")).toHaveLength(0);
    expect(screen.queryByText("模型、记忆、上下文与性格人设")).toBeNull();
    expect(screen.getByText("点击助手查看并编辑；勾选框仅用于批量删除。")).toBeTruthy();
    expect(container.querySelectorAll(".agent-settings details")).toHaveLength(0);
    expect(container.querySelector(".shared-agent-selector > svg circle")).toBeTruthy();
    expect(
      container
        .querySelector(".agent-settings")
        ?.firstElementChild?.classList.contains("shared-agent-selector"),
    ).toBe(true);
    for (const summary of container.querySelectorAll(".agent-settings > details > summary")) {
      expect(summary.querySelectorAll(":scope > svg")).toHaveLength(2);
      expect(summary.textContent).not.toMatch(/[▾▴]/);
      for (const icon of summary.querySelectorAll("svg")) {
        expect(icon.getAttribute("aria-hidden")).toBe("true");
        expect(icon.getAttribute("viewBox")).toBe("0 0 24 24");
      }
    }
    expect(screen.getByRole("button", { name: "返回设置中心" }).querySelector("svg")).toBeTruthy();
  });

  it("旧记忆区只保留管理和新页跳转，不恢复即时策略保存", () => {
    const { container } = render(<SectionB />);
    expect(screen.queryByRole("heading", { name: "记忆配置", level: 4 })).toBeNull();
    expect(screen.getByRole("heading", { name: "记忆管理", level: 3 })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "长期记忆" })).toBeNull();
    expect(screen.queryByText("按完整对话轮数自动整理；选项修改后立即保存。")).toBeNull();
    expect(container.querySelectorAll(".memory-management > section.group")).toHaveLength(2);
    expect(container.querySelectorAll(".memory-management details")).toHaveLength(0);
    expect(container.querySelectorAll(".config-section textarea:not([readonly])")).toHaveLength(0);
  });
});

describe("R5 布局无障碍合同", () => {
  it("右下设置图标按钮保留可访问名称与提示", () => {
    render(<Sidebar />);
    const settings = screen.getByRole("button", { name: "设置" });
    expect(settings.getAttribute("title")).toBe("设置");
    expect(settings.classList.contains("settings-button")).toBe(true);
    expect(settings.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  });
});
