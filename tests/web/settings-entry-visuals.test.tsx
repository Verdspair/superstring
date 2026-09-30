// 大设置入口同一视觉权重：outline 默认尺寸（h-8=32px）、可换行、带对应功能图标；
// 同页其余保存/刷新按钮保持原级；草稿安全跳转行为不变。
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { selectLocale } from "../../src/web/i18n";
import {
  KnowledgeToolSettings,
  MemoryToolSettings,
} from "../../src/web/screens/assistants/ResourceRules";
import { CapabilitiesWorkspace } from "../../src/web/screens/connections/CapabilitiesWorkspace";
import { MemoryLibrary } from "../../src/web/screens/library/MemoryLibrary";
import { useSuperstringStore as store } from "../../src/web/store";
import { setupLibrary } from "./helpers/library-fixture";

// sm 是 h-7=28px，默认尺寸才是 h-8=32px；大页入口用默认尺寸并允许高度自适应换行。
function expectLargeEntry(button: HTMLElement, icon: string) {
  expect(button.getAttribute("data-variant")).toBe("outline");
  expect(button.getAttribute("data-size")).toBe("default");
  expect(button.className).toContain("h-auto");
  expect(button.className).toContain("min-h-8");
  expect(button.className).toContain("max-w-full");
  expect(button.className).toContain("whitespace-normal");
  expect(button.className).not.toContain("h-7");
  expect(button.querySelector(`svg.lucide-${icon}`)).toBeTruthy();
}

function expectOriginalLevel(button: HTMLElement, size: string) {
  expect(button.getAttribute("data-size")).toBe(size);
  expect(button.className).not.toContain("h-auto");
  expect(button.className).not.toContain("min-h-8");
}

beforeEach(() => {
  localStorage.clear();
  setupLibrary();
  selectLocale("zh-CN");
});
afterEach(() => {
  cleanup();
  selectLocale("zh-CN");
});

describe("large settings entries share one visual weight", () => {
  it("memory library entries are 32px outline buttons with their settings icon", async () => {
    store.setState({ settingsRoute: "long-memory" });
    await act(async () => render(<MemoryLibrary />));
    expectLargeEntry(screen.getByRole("button", { name: "前往记忆查询" }), "sliders-horizontal");
    expectLargeEntry(screen.getByRole("button", { name: "前往模型服务" }), "cpu");
  });

  it("keeps refresh and save at their original levels in the memory library", async () => {
    store.setState({ settingsRoute: "long-memory" });
    await act(async () => render(<MemoryLibrary />));
    const refresh = screen.getByRole("button", { name: "刷新" });
    expect(refresh.getAttribute("data-variant")).toBe("outline");
    expectOriginalLevel(refresh, "default");
    expectOriginalLevel(screen.getByRole("button", { name: "保存记忆规则" }), "sm");
  });

  it("keeps the draft-safe jump of the upgraded memory entry", async () => {
    store.setState({ settingsRoute: "long-memory" });
    act(() => store.getState().patchPageAgent("basic", { name: "Kept draft" }));
    await act(async () => render(<MemoryLibrary />));
    fireEvent.click(screen.getByRole("button", { name: "前往模型服务" }));
    expect(store.getState().settingsRoute).toBe("models");
    expect(store.getState().pageEditor?.draft.name).toBe("Kept draft");
  });

  it("resource rule entries match the same weight while their save/refresh stay put", async () => {
    await act(async () => render(<MemoryToolSettings />));
    expectLargeEntry(screen.getByRole("button", { name: "前往长期记忆" }), "book-open");
    expectOriginalLevel(screen.getByRole("button", { name: "刷新保存基线" }), "default");
    expectOriginalLevel(screen.getByRole("button", { name: "保存记忆规则" }), "default");
    cleanup();
    await act(async () => render(<KnowledgeToolSettings />));
    expectLargeEntry(screen.getByRole("button", { name: "前往知识文档" }), "file-text");
    expectOriginalLevel(screen.getByRole("button", { name: "刷新授权" }), "default");
    expectOriginalLevel(screen.getByRole("button", { name: "保存知识规则" }), "default");
  });

  it("capabilities short-term context entry matches the same weight and still jumps", async () => {
    store.setState({ settingsRoute: "session-history" });
    await act(async () => render(<CapabilitiesWorkspace />));
    const jump = screen.getByRole("button", { name: "打开短期上下文" });
    expectLargeEntry(jump, "messages-square");
    expect(jump.hasAttribute("disabled")).toBe(false);
    fireEvent.click(jump);
    expect(store.getState().settingsRoute).toBe("context");
  });
});
