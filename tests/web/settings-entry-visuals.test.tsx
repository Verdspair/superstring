// 大设置入口使用同级 outline 与功能图标；普通保存和刷新保留各自 size。
// 共用按钮允许长文字换行，草稿安全跳转行为不变。
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DesignSystemProvider } from "../../src/web/design-system/Providers";
import { selectLocale } from "../../src/web/i18n";
import { AssistantWorkspace } from "../../src/web/screens/assistants/AssistantWorkspace";

import { CapabilitiesWorkspace } from "../../src/web/screens/connections/CapabilitiesWorkspace";
import { MemoryLibrary } from "../../src/web/screens/library/MemoryLibrary";
import { useSuperstringStore as store } from "../../src/web/store";
import { setupLibrary } from "./helpers/library-fixture";

// 大页入口与常规任务操作分别验证，换行由共用按钮负责。
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
  expect(button.className).toContain(size === "sm" ? "min-h-[32px]" : "min-h-[38px]");
  expect(button.className).toContain("whitespace-normal");
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
    await act(async () =>
      render(
        <DesignSystemProvider>
          <MemoryLibrary />
        </DesignSystemProvider>,
      ),
    );
    expectLargeEntry(screen.getByRole("button", { name: "前往记忆查询" }), "sliders-horizontal");
    expectLargeEntry(screen.getByRole("button", { name: "前往整理默认模型" }), "cpu");
  });

  it("keeps refresh and save at their original levels in the memory library", async () => {
    store.setState({ settingsRoute: "long-memory" });
    await act(async () =>
      render(
        <DesignSystemProvider>
          <MemoryLibrary />
        </DesignSystemProvider>,
      ),
    );
    const refresh = screen.getByRole("button", { name: "刷新" });
    expect(refresh.getAttribute("data-variant")).toBe("outline");
    expectOriginalLevel(refresh, "default");
    expectOriginalLevel(screen.getByRole("button", { name: "保存记忆规则" }), "sm");
  });

  it("keeps the draft-safe jump of the upgraded memory entry", async () => {
    store.setState({ settingsRoute: "long-memory" });
    act(() => store.getState().patchPageAgent("basic", { name: "Kept draft" }));
    await act(async () =>
      render(
        <DesignSystemProvider>
          <MemoryLibrary />
        </DesignSystemProvider>,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "前往整理默认模型" }));
    expect(store.getState().settingsRoute).toBe("long-memory");
    expect(store.getState().pendingNavigation).toMatchObject({
      kind: "page",
      settingsRoute: "execution-settings",
    });
    expect(store.getState().pageEditor?.draft.name).toBe("Kept draft");
    store.getState().cancelPendingNavigation();
    expect(store.getState().pageEditor?.draft.name).toBe("Kept draft");
    expect(store.getState().settingsRoute).toBe("long-memory");
    fireEvent.click(screen.getByRole("button", { name: "前往整理默认模型" }));
    await act(async () => store.getState().confirmDiscardAndContinue());
    expect(store.getState().settingsRoute).toBe("execution-settings");
    expect(store.getState().pendingNavigation).toBeNull();
  });

  it("materials links and task toolbar retain their respective visual weights", async () => {
    store.setState({ settingsView: "workspace", settingsRoute: "memory-tools" });
    await act(async () =>
      render(
        <DesignSystemProvider>
          <AssistantWorkspace />
        </DesignSystemProvider>,
      ),
    );
    const memoryEntry = screen.getByRole("button", { name: "管理记忆与来源" });
    expectLargeEntry(memoryEntry, "book-open");
    const knowledgeEntry = screen.getByRole("button", { name: "前往知识文档" });
    expectLargeEntry(knowledgeEntry, "file-text");
    expectOriginalLevel(screen.getByRole("button", { name: "刷新保存基线" }), "sm");
    expectOriginalLevel(screen.getByRole("button", { name: "保存 Agent" }), "sm");
  });

  it("capabilities short-term context entry matches the same weight and still jumps", async () => {
    store.setState({ settingsRoute: "session-history" });
    await act(async () =>
      render(
        <DesignSystemProvider>
          <CapabilitiesWorkspace />
        </DesignSystemProvider>,
      ),
    );
    const jump = screen.getByRole("button", { name: "打开短期上下文" });
    expectLargeEntry(jump, "messages-square");
    expect(jump.hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByLabelText("选择要配置的 Agent"), {
      target: { value: store.getState().agents[0].id },
    });
    expect(jump.hasAttribute("disabled")).toBe(false);
    fireEvent.click(jump);
    expect(store.getState().settingsRoute).toBe("context");
  });
});
