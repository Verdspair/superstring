import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { P5ConfigSchema } from "../../src/shared/contracts";
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
  it("保留 A—H 分区和保存入口，移除重复副标题", async () => {
    await useSuperstringStore.getState().editAgent("__new__");
    useSuperstringStore.setState({
      page: "settings",
      settingsView: "agents",
      detailOpen: true,
      bootstrap: vi.fn().mockResolvedValue(undefined),
    });
    const { container } = render(<App />);
    expect(screen.getByRole("heading", { name: "助手设置" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "A · 名称与模型" })).toBeTruthy();
    expect(container.querySelectorAll(".section-nav button")).toHaveLength(8);
    expect(container.querySelectorAll(".section-nav button small")).toHaveLength(4);
    expect(screen.getByRole("button", { name: "创建助手" })).toBeTruthy();
    expect(
      screen.getByText("各分区独立保存。新一轮使用已保存配置，失败重试沿用原轮配置。"),
    ).toBeTruthy();
    expect(screen.getByText("模型与指令保存后从下一轮生效，不影响正在生成的回复。")).toBeTruthy();
    expect(screen.queryByText("统一管理 Superstring 的功能与偏好")).toBeNull();
    expect(screen.queryByText("显示在 Agent 列表和会话选择中。")).toBeNull();
  });
});

describe("分组与提示层级", () => {
  it("助手设置保留三个折叠入口及用途说明", async () => {
    await useSuperstringStore.getState().editAgent("__new__");
    useSuperstringStore.setState({
      page: "settings",
      settingsView: "agents",
      bootstrap: vi.fn().mockResolvedValue(undefined),
    });
    const { container } = render(<App />);
    expect(screen.getByText("正在创建 · 未保存")).toBeTruthy();
    const identity = container.querySelector(".selector-identity");
    if (!identity) throw new Error("missing selector identity");
    expect([...identity.children].map((child) => child.tagName)).toEqual(["STRONG", "SMALL"]);
    expect(identity.querySelector("strong")?.textContent).toBe("新建助手");
    const createAction = screen.getByRole("button", { name: "新建助手" });
    expect(createAction.closest(".agent-editor-list")).toBeNull();
    expect(createAction.getAttribute("aria-pressed")).toBeNull();
    expect(container.querySelectorAll(".section-nav button:disabled")).toHaveLength(7);
    expect(screen.getByText("模型、记忆、上下文与性格人设")).toBeTruthy();
    expect(screen.getByText("选择多个助手，批量删除。")).toBeTruthy();
    expect(container.querySelectorAll(".agent-settings > details")).toHaveLength(3);
    expect(container.querySelector(".agent-selector > summary > svg.chevron")).toBeTruthy();
    expect(container.querySelector(".agent-selector > summary > svg circle")).toBeTruthy();
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

  it("记忆配置与管理明确分组，保留手动保存和自动保存提示", async () => {
    await useSuperstringStore.getState().editAgent("__new__");
    const draft = useSuperstringStore.getState().editorDraft;
    if (!draft) throw new Error("missing test draft");
    const { container } = render(
      <SectionB
        draft={{ ...draft, p5_config: P5ConfigSchema.parse({}) }}
        patch={vi.fn()}
        models={[]}
      />,
    );
    expect(screen.getByRole("heading", { name: "记忆配置", level: 4 })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "记忆管理", level: 4 })).toBeTruthy();
    expect(screen.getByText("设置回答时如何查找和使用记忆。")).toBeTruthy();
    expect(screen.getByText("设置生成记忆使用的模型与规则。")).toBeTruthy();
    expect(screen.getByText("读取与整理配置修改后，点击底部“保存当前分区配置”。").className).toBe(
      "hint",
    );
    expect(screen.getByText("按完整对话轮数自动整理；选项修改后立即保存。")).toBeTruthy();
    expect(container.querySelectorAll(".config-section > details.group")).toHaveLength(5);
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
