import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { P5ConfigSchema } from "../../src/shared/contracts";
import App from "../../src/web/App";
import type { SuperstringApi } from "../../src/web/api";
import { StatusBar } from "../../src/web/app/StatusBar";
import { AgentSettings } from "../../src/web/features/agents/AgentSettings";
import { SectionC } from "../../src/web/features/agents/SectionC";
import { SECTION_META } from "../../src/web/features/agents/sections";
import { AppearanceSettings } from "../../src/web/features/appearance/AppearanceSettings";
import { ChatPage } from "../../src/web/features/chat/ChatPage";
import { menuPosition } from "../../src/web/features/chat/menu-position";
import { GeneralSettings } from "../../src/web/features/general/GeneralSettings";
import { OperatingModeSettings } from "../../src/web/features/general/OperatingModeSettings";
import {
  formatMessage,
  getLocale,
  LOCALE_STORAGE_KEY,
  msg,
  readLocale,
  selectLocale,
  translateNotice,
} from "../../src/web/i18n";
import { english } from "../../src/web/i18n/en";
import { registerError } from "../../src/web/i18n/errors";
import { useSuperstringStore } from "../../src/web/store";

beforeEach(() => {
  selectLocale("zh-CN");
  useSuperstringStore.getState().resetForTests({} as SuperstringApi);
  useSuperstringStore.setState({
    status: "ready",
    bootstrap: vi.fn().mockResolvedValue(undefined),
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  selectLocale("zh-CN");
});

describe("locale catalog and preferences", () => {
  it("every English entry preserves interpolation placeholders", () => {
    for (const [key, value] of Object.entries(english)) {
      expect(value.trim(), key).not.toBe("");
      expect([...value.matchAll(/\{\d+\}/g)].map((x) => x[0]).sort(), key).toEqual(
        [...key.matchAll(/\{\d+\}/g)].map((x) => x[0]).sort(),
      );
    }
  });
  it("defaults invalid persisted values to Chinese", () => {
    localStorage.setItem(LOCALE_STORAGE_KEY, "invalid");
    expect(readLocale()).toBe("zh-CN");
  });
  it("persists selection without reloading or resetting composer and drafts", async () => {
    await useSuperstringStore.getState().editAgent("__new__");
    useSuperstringStore.getState().patchDraft({ name: "用户写的中文" });
    useSuperstringStore.setState({ composer: "保留我的输入" });
    const draft = useSuperstringStore.getState().editorDraft;
    render(<GeneralSettings />);
    fireEvent.click(screen.getByRole("button", { name: "English" }));
    expect(screen.getByRole("heading", { name: "General" })).toBeTruthy();
    expect(document.documentElement.lang).toBe("en");
    expect(readLocale()).toBe("en");
    expect(useSuperstringStore.getState().editorDraft).toBe(draft);
    expect(useSuperstringStore.getState().dirty).toBe(true);
    expect(useSuperstringStore.getState().composer).toBe("保留我的输入");
  });
  it("applies language even when storage fails and reports failure", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw Error("blocked");
    });
    render(<GeneralSettings />);
    fireEvent.click(screen.getByRole("button", { name: "English" }));
    expect(getLocale()).toBe("en");
    expect(screen.getByText(/storage is blocked/)).toBeTruthy();
  });
  it("reacts to cross-tab storage changes", () => {
    render(<GeneralSettings />);
    act(() => {
      localStorage.setItem(LOCALE_STORAGE_KEY, "en");
      window.dispatchEvent(new StorageEvent("storage", { key: LOCALE_STORAGE_KEY }));
    });
    expect(screen.getByRole("heading", { name: "General" })).toBeTruthy();
  });
  it("translates stored notices after changing language but preserves user parameters", () => {
    const text = msg("已创建助手「{0}」，可继续配置记忆、上下文与人设。", "中文助手");
    selectLocale("en");
    expect(translateNotice(text)).toContain("Assistant “中文助手” created");
    expect(formatMessage("en", "消息 {0}", "{0} 中文")).toBe("Message {0} 中文");
  });
  it("maps known API errors and preserves unknown diagnostics", () => {
    const known = registerError("MODEL_NOT_LOADED", "模型未加载");
    const unknown = registerError("NEW_ERROR", "原始诊断");
    const nested = msg("保存失败：{0}", known);
    selectLocale("en");
    expect(translateNotice(nested)).toBe("Save failed: Model not loaded [MODEL_NOT_LOADED]");
    expect(translateNotice(unknown)).toBe("[NEW_ERROR] 原始诊断");
  });
  it("translates theme names and retains all 16 colors", () => {
    selectLocale("en");
    render(<AppearanceSettings />);
    expect(document.querySelectorAll(".theme-option")).toHaveLength(16);
    fireEvent.click(screen.getByRole("button", { name: "Violet theme" }));
    expect(screen.getByText("Switched to Violet")).toBeTruthy();
    act(() => {
      selectLocale("zh-CN");
    });
    expect(screen.getByText("已切换为紫罗兰")).toBeTruthy();
  });
});

describe("general settings and status bar", () => {
  it("shows only supported chat mode as enabled", () => {
    const { container } = render(<OperatingModeSettings />);
    expect(container.querySelector("details")).toBeNull();
    expect(container.querySelectorAll(".operating-mode-row")).toHaveLength(3);
    expect(container.querySelectorAll(".operating-mode-row > .icon")).toHaveLength(3);
    expect(container.querySelector(".mode-options")).toBeNull();
    expect(screen.getByText("使用中")).toBeTruthy();
    expect(screen.getAllByText("未开放")).toHaveLength(2);
    expect(screen.getAllByRole("heading", { name: "运行模式" })).toHaveLength(1);
    expect(container.querySelector(".settings-back svg path")?.getAttribute("d")).toBe(
      "m14 6-6 6 6 6",
    );
    expect(screen.getByRole("button", { name: "对话聊天模式" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(
      (
        screen.getByRole("button", {
          name: /主动聊天模式/,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect((screen.getByRole("button", { name: /任务模式/ }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
  it("shows unknown state rather than claiming chat when config is unavailable", () => {
    useSuperstringStore.setState({
      currentSessionId: "session",
      runtimeConfigUnavailable: true,
    });
    render(<StatusBar />);
    expect(screen.getByText("模式信息不可用")).toBeTruthy();
    expect(screen.queryByText("对话聊天模式")).toBeNull();
  });
  it("places workspace identity in a single footer, not the sidebar", () => {
    const { container } = render(<App />);
    expect(container.querySelector(".sidebar .mode-note")).toBeNull();
    expect(screen.getByRole("contentinfo", { name: "应用状态" }).textContent).toContain(
      "本地工作空间",
    );
  });
  it("guards navigation into general settings with unsaved assistant changes", () => {
    useSuperstringStore.setState({
      page: "settings",
      settingsView: "agents",
      dirty: true,
    });
    useSuperstringStore.getState().requestPageNavigation("settings", "general");
    expect(useSuperstringStore.getState().settingsView).toBe("agents");
    expect(useSuperstringStore.getState().pendingNavigation).toEqual({
      kind: "page",
      page: "settings",
      settingsView: "general",
    });
  });
});

describe("section identities", () => {
  it("reorders display letters without rebinding business keys", () => {
    expect(SECTION_META.map((x) => x.letter)).toEqual([
      "A",
      "B",
      "C",
      "D",
      "E",
      "F",
      "G",
      "H",
      "I",
    ]);
    expect(SECTION_META.map((x) => x.key)).toEqual([
      "A",
      "D",
      "E",
      "G",
      "B",
      "knowledge",
      "C",
      "F",
      "H",
    ]);
  });
  it("knowledge remains an unavailable view without a save action", async () => {
    await useSuperstringStore.getState().editAgent("__new__");
    useSuperstringStore.setState({
      editorAgentId: "fixture",
      activeSection: "knowledge",
      detailOpen: true,
    });
    render(<AgentSettings />);
    expect(screen.getByRole("heading", { name: "F · 知识库" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "保存当前分区配置" })).toBeNull();
    let result = true;
    await act(async () => {
      result = await useSuperstringStore.getState().saveCurrentSection();
    });
    expect(result).toBe(false);
  });
  it("new assistants cannot enter knowledge before creation", async () => {
    await useSuperstringStore.getState().editAgent("__new__");
    useSuperstringStore.getState().requestSectionNavigation("knowledge");
    expect(useSuperstringStore.getState().activeSection).toBe("A");
  });
  it("capacity validation no longer depends on a translated preview", async () => {
    await useSuperstringStore.getState().editAgent("__new__");
    const draft = useSuperstringStore.getState().editorDraft;
    if (!draft) throw new Error("Missing draft");
    useSuperstringStore.setState({
      chatContextCapacity: 8192,
      capacityPreview: "Chat: capacity 8192",
      refreshCapacityPreview: vi.fn().mockResolvedValue(undefined),
    });
    selectLocale("en");
    render(
      <SectionC
        draft={{
          ...draft,
          p5_config: { ...P5ConfigSchema.parse({}), context_window: 4096 },
        }}
        patch={vi.fn()}
        models={[]}
      />,
    );
    expect(screen.getByText("Custom context budget (actual limit: 8192)")).toBeTruthy();
    expect(document.querySelector('input[max="8192"]')).toBeTruthy();
  });
});

describe("message menu", () => {
  it.each([
    [0, 0],
    [389, 0],
    [0, 799],
    [389, 799],
  ])("clamps at viewport corner %s,%s", (x, y) => {
    const point = menuPosition({ x, y }, { width: 160, height: 44 }, { width: 390, height: 800 });
    expect(point.left).toBeGreaterThanOrEqual(8);
    expect(point.top).toBeGreaterThanOrEqual(8);
    expect(point.left + 160).toBeLessThanOrEqual(382);
    expect(point.top + 44).toBeLessThanOrEqual(792);
  });
  it("opens with keyboard, focuses delete and restores focus on Escape", () => {
    useSuperstringStore.setState({
      currentSessionId: "s",
      messages: [
        {
          id: "m",
          role: "user",
          content: "原文保持",
          status: "completed",
          errorCode: null,
          createdAt: "2026-09-18T00:00:00Z",
          completedAt: null,
        },
      ],
    });
    render(<ChatPage />);
    const article = screen.getByRole("article");
    article.focus();
    fireEvent.keyDown(article, { key: "F10", shiftKey: true });
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "删除消息" }));
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(article);
    act(() => {
      selectLocale("en");
    });
    expect(screen.getByText("原文保持")).toBeTruthy();
  });
});
