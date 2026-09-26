import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentResponseSchema,
  P5ConfigSchema,
  PersonaResponseSchema,
} from "../../src/shared/contracts";
import App from "../../src/web/App";
import type { SuperstringApi } from "../../src/web/api";
import { StatusBar } from "../../src/web/app/StatusBar";
import { AgentSettings } from "../../src/web/features/agents/AgentSettings";
import { MemoryPageFields } from "../../src/web/features/agents/MemoryPageFields";
import { newPageEditor } from "../../src/web/features/agents/page-drafts";
import { SECTION_META } from "../../src/web/features/agents/sections";
import { AppearanceSettings } from "../../src/web/features/appearance/AppearanceSettings";
import { ChatPage } from "../../src/web/features/chat/ChatPage";
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
import { fixtureStore as useSuperstringStore } from "./helpers/chat-fixture";

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
  it("keeps concise safety, scope and fallback explanations translated", () => {
    const notes = [
      "外观修改立即生效并自动保存。",
      "仅影响当前助手；切页保留草稿，按页保存，下一新轮生效。",
      "停用并保存后，新会话不可选；已有会话不受影响。",
      "默认 100 批；达到上限仍未读完会报错，不跳过剩余记忆。",
      "仅从已授权资料中选择；未选则不读取，不回退全部。",
      "目标与硬上限控制摘要生成；读取上限控制本轮用量，留空继承硬上限。超额时临时再压缩，不截断或覆盖已存摘要。",
      "按 UTF-8 字节和消息开销估算，非模型精确 token 数。",
    ] as const;
    selectLocale("en");
    for (const note of notes) {
      expect(translateNotice(msg(note))).not.toBe(note);
      expect(translateNotice(msg(note))).not.toMatch(/[\u3400-\u9fff]/);
    }
  });
  it("does not claim color mode must follow the system", () => {
    render(<AppearanceSettings />);
    expect(screen.getByText("外观修改立即生效并自动保存。")).toBeTruthy();
    expect(screen.queryByText("点击色圆立即切换并自动保存；浅色与深色跟随系统。")).toBeNull();
    expect(screen.getByText("跟随系统，或固定浅色／深色。")).toBeTruthy();
  });
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
    const language = screen.getByText("界面语言", { selector: "strong" }).closest("details");
    if (!language) throw new Error("Missing language details");
    const summary = language.querySelector("summary");
    if (!summary) throw new Error("Missing language summary");
    expect(language.open).toBe(false);
    fireEvent.click(summary);
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
    const language = screen.getByText("界面语言", { selector: "strong" }).closest("details");
    if (!language) throw new Error("Missing language details");
    const summary = language.querySelector("summary");
    if (!summary) throw new Error("Missing language summary");
    expect(language.open).toBe(false);
    fireEvent.click(summary);
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
    // 2026-09-25：模式列表里的「第三方聊天（QQ）」取代了原来未开放的「主动聊天模式」占位，它承载总开关
    // 与连接状态，配置就在同一页的「QQ」分组里（所以这一页的行数是三行，而不是旧的"三模式 + 一行"）。
    expect(container.querySelectorAll(".operating-mode-row")).toHaveLength(3);
    expect(container.querySelectorAll(".operating-mode-row > .icon")).toHaveLength(3);
    expect(container.querySelector(".mode-options")).toBeNull();
    expect(screen.getByText("使用中")).toBeTruthy();
    expect(screen.getAllByText("未开放")).toHaveLength(1);
    expect(screen.getAllByRole("heading", { name: "运行模式" })).toHaveLength(1);
    expect(container.querySelector(".settings-back svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(screen.getByRole("button", { name: "对话聊天模式" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    // QQ 那一行不再是按钮（它承载的是开关而不是跳转），QQ 的配置就在同一页的分组里。
    expect(screen.queryByRole("button", { name: /主动聊天模式/ })).toBeNull();
    const qq = container.querySelector("#settings-qq");
    expect(qq).toBeTruthy();
    // 「QQ」是这一页里的一层分组，里面的三段（连接 / 群与私聊 / 相关配置）是小标题分段，
    // 不再各自套一层分组外框（两层标题带就是两层外框）。这一段没有注入 API，读不到设置，
    // 所以「连接」那一段按设计不渲染（它只在读到设置后才有内容），另两段照常。
    expect(qq?.querySelectorAll(".qq-access-subsection")).toHaveLength(2);
    expect(qq?.querySelectorAll(".group")).toHaveLength(0);
    for (const id of ["qq-access-conversations", "qq-access-links"]) {
      expect(container.querySelector(`#${id}`)).toBeTruthy();
    }
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
  it("overview does not render the retired knowledge section or section save", async () => {
    await useSuperstringStore.getState().editAgent("__new__");
    useSuperstringStore.setState({
      apiClient: {
        listAgentKnowledge: vi.fn().mockResolvedValue([]),
      } as unknown as SuperstringApi,
      editorAgentId: "fixture",
      activeSection: "knowledge",
    });
    render(<AgentSettings />);
    expect(screen.getByRole("heading", { name: "助手管理" })).toBeTruthy();
    expect(screen.queryByText("当前助手暂无已授权资料。")).toBeNull();
    expect(screen.queryByRole("button", { name: "打开知识库详细配置" })).toBeNull();
    expect(document.querySelector(".section-nav")).toBeNull();
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
    const saved = AgentResponseSchema.parse({
      ...draft,
      name: "fixture",
      model_name: "synthetic",
      memory_consolidation_prompt: "organize",
      memory_retrieval_prompt: "retrieve",
      id: "fixture",
      created_at: "2026-09-19T00:00:00.000Z",
      updated_at: "2026-09-19T00:00:00.000Z",
      p5_config: { ...P5ConfigSchema.parse({}), context_window: 4096, max_output_tokens: 512 },
    });
    const persona = PersonaResponseSchema.parse({
      id: "persona",
      agent_id: "fixture",
      core_identity: "",
      communication_style: "",
      interaction_boundaries: "",
      example_dialogues: "",
      advanced_instructions: "",
      created_at: saved.created_at,
      updated_at: saved.updated_at,
    });
    useSuperstringStore.setState({ pageEditor: newPageEditor(saved, persona) });
    render(<MemoryPageFields page="context" />);
    expect(screen.getByText("Custom context budget (actual limit: 8192)")).toBeTruthy();
    expect(document.querySelector('input[max="8192"]')).toBeTruthy();
  });
});

describe("message menu", () => {
  it("opens with keyboard, focuses delete and restores focus on Escape", async () => {
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
    await waitFor(() => expect(document.activeElement).toBe(article));
    act(() => {
      selectLocale("en");
    });
    expect(screen.getByText("原文保持")).toBeTruthy();
  });
});
