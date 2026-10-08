import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readMode, readTheme, THEMES } from "../../src/web/appearance";
import { dirtyPages, newPageEditor } from "../../src/web/features/agents/page-drafts";
import { msg, selectLocale } from "../../src/web/i18n";
import en from "../../src/web/i18n/locales/en/translation.json";
import zh from "../../src/web/i18n/locales/zh-CN/translation.json";
import { AssistantWorkspace } from "../../src/web/screens/assistants/AssistantWorkspace";
import {
  KnowledgeToolSettings,
  MemoryToolSettings,
} from "../../src/web/screens/assistants/ResourceRules";
import { CapabilityEditor, IdentityEditor } from "../../src/web/screens/assistants/StudioEditors";
import { Preferences } from "../../src/web/screens/environment/Preferences";
import { KnowledgeLibrary } from "../../src/web/screens/library/KnowledgeLibrary";
import { MemoryDetail, MemoryLibrary } from "../../src/web/screens/library/MemoryLibrary";
import { useSuperstringStore as store } from "../../src/web/store";
import {
  A,
  agent,
  B,
  D,
  document as doc,
  M,
  memory,
  policy,
  scopeKey,
  setupLibrary,
} from "./helpers/library-fixture";

beforeEach(() => {
  localStorage.clear();
  setupLibrary();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  selectLocale("zh-CN");
});

describe("fresh assistant studio", () => {
  it("translates each capacity notice in the English tool settings view", async () => {
    selectLocale("en");
    store.setState({
      refreshCapacityPreview: vi.fn().mockResolvedValue(undefined),
      capacityPreview: [
        msg(
          "{0}：实际 {1}，预算 {2}，输入可用约 {3}；回复预留 {4}{5}",
          msg("聊天"),
          32768,
          32768,
          20000,
          4096,
          "",
        ),
        msg(
          "{0}：实际 {1}，预算 {2}，输入可用约 {3}；回复预留 {4}{5}",
          msg("摘要"),
          32768,
          32768,
          20000,
          4096,
          "",
        ),
      ].join("\n"),
    });
    await act(async () => render(<CapabilityEditor />));
    expect(screen.getByText(/Chat: capacity 32768/).textContent).toContain(
      "Summary: capacity 32768",
    );
    expect(screen.getByText(/Chat: capacity 32768/).textContent).not.toContain("实际");
  });

  it("keeps editing identity, new-conversation default, and current conversation independent", async () => {
    store.setState({ settingsView: "agents", selectedNewSessionAgentId: A });
    await act(async () => render(<AssistantWorkspace />));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Agent B" })));
    expect(store.getState().editorAgentId).toBe(B);
    expect(store.getState().selectedNewSessionAgentId).toBe(A);
    expect(store.getState().currentConversationId).toBeNull();
  });
  it("editing identity never saves implicitly and compiles expression strength", () => {
    render(<IdentityEditor />);
    fireEvent.change(screen.getByLabelText("核心身份"), { target: { value: "Patient guide" } });
    fireEvent.change(screen.getByLabelText("沟通风格"), { target: { value: "abcdefghij" } });
    expect(screen.getByText(/## 核心身份/).textContent).toContain("abcdef");
    expect(store.getState().pageEditor?.personaDraft.core_identity).toBe("Patient guide");
  });
  it("preserves agent drafts when the studio returns to its directory", async () => {
    await act(async () => render(<AssistantWorkspace />));
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "Draft name" } });
    fireEvent.click(screen.getByRole("button", { name: "所有 Agent" }));
    expect(store.getState().pageEditor?.draft.name).toBe("Draft name");
    expect(store.getState().pageEditor?.agent.name).toBe("Agent A");
  });
  it("workspace discard resets every draft instead of reading the click event as a page", async () => {
    await act(async () => render(<AssistantWorkspace />));
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "Draft name" } });
    fireEvent.change(screen.getByLabelText("沟通风格"), { target: { value: "Draft style" } });
    expect(dirtyPages(store.getState().pageEditor)).toEqual(["basic", "expression"]);
    fireEvent.click(screen.getByRole("button", { name: "放弃修改" }));
    expect(store.getState().pageEditor?.draft.name).toBe("Agent A");
    expect(store.getState().pageEditor?.personaDraft.communication_style).toBe("");
    expect(dirtyPages(store.getState().pageEditor)).toEqual([]);
  });
  it("shows four tool allowance modes and independent bounded presets without retired controls", async () => {
    await act(async () =>
      render(
        <>
          <MemoryToolSettings />
          <KnowledgeToolSettings />
        </>,
      ),
    );
    expect(
      within(screen.getByLabelText("记忆工具额度模式"))
        .getAllByRole("option")
        .map((option) => (option as HTMLOptionElement).value),
    ).toEqual(["off", "conservative", "standard", "broad"]);
    const broad = structuredClone(
      store.getState().pageEditor?.draft.p5_config.retrieval_presets.broad,
    );
    // 三档预设默认展开：三个预设的额度输入初始都可见，标题只剩档名。
    for (const label of [
      "每次查询扫描候选上限",
      "每页最大返回项",
      "每轮记忆工具结果总预算（UTF-8 字节）",
    ]) {
      expect(screen.getAllByLabelText(label)).toHaveLength(3);
    }
    const conservative = screen.getByRole("button", { name: "保守" });
    const panel = document.getElementById(conservative.getAttribute("aria-controls") ?? "");
    if (!panel) throw new Error("Missing conservative preset panel");
    const candidates = within(panel).getByLabelText("每次查询扫描候选上限") as HTMLInputElement;
    const entries = within(panel).getByLabelText("每页最大返回项") as HTMLInputElement;
    const budget = within(panel).getByLabelText(
      "每轮记忆工具结果总预算（UTF-8 字节）",
    ) as HTMLInputElement;
    expect([candidates.min, candidates.max]).toEqual(["1", "300"]);
    expect([budget.min, budget.max]).toEqual(["1", "1048576"]);
    fireEvent.change(candidates, { target: { value: "200" } });
    expect(entries.max).toBe("100");
    fireEvent.change(candidates, { target: { value: "30" } });
    expect(entries.max).toBe("30");
    expect(store.getState().pageEditor?.draft.p5_config.retrieval_presets.broad).toEqual(broad);
    expect(
      store.getState().pageEditor?.draft.p5_config.retrieval_presets.conservative.candidate_limit,
    ).toBe(30);
    expect(screen.queryByLabelText("相关性判断指令")).toBeNull();
    expect(screen.queryByLabelText("记忆读取提示词")).toBeNull();
    expect(screen.queryByLabelText("最多目录批次")).toBeNull();
    expect(screen.queryByLabelText("每批目录条数")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getByText(/技能文本不能授予资料访问权限/)).toBeTruthy();
    expect(within(panel).getByText(/每次查询最多扫描 300 条候选/)).toBeTruthy();
    expect(screen.getByText(/全局每轮预算：2048 UTF-8 字节/)).toBeTruthy();
  });
  it.each(["full_catalog", "full_body"] as const)(
    "displays %s as broad without mutating drafts on visits, tab changes or reloads",
    async (mode) => {
      const editor = store.getState().pageEditor;
      if (!editor) throw new Error("Missing editor");
      const legacy = {
        ...agent,
        p5_config: { ...agent.p5_config, retrieval_mode: mode },
      };
      store.setState({ pageEditor: newPageEditor(legacy, editor.persona) });
      const before = store.getState().pageEditor;
      await act(async () => render(<MemoryToolSettings />));
      // 选择框按真实存量档显示（不再伪装成 broad），并有旧档提示说明保存语义。
      expect((screen.getByLabelText("记忆工具额度模式") as HTMLSelectElement).value).toBe(mode);
      expect(screen.getByText(/全量读取设置.*广泛额度/).textContent).toContain(mode);
      expect(store.getState().pageEditor).toBe(before);
      expect(dirtyPages(before)).toEqual([]);
      cleanup();
      act(() => store.getState().openSettingsRoute("models"));
      act(() => store.getState().openSettingsRoute("long-memory"));
      await act(async () => render(<MemoryToolSettings />));
      expect(store.getState().pageEditor?.draft.p5_config.retrieval_mode).toBe(mode);
      expect(dirtyPages(store.getState().pageEditor)).toEqual([]);
      fireEvent.click(screen.getByRole("button", { name: "改为广泛额度" }));
      expect(store.getState().pageEditor?.draft.p5_config.retrieval_mode).toBe("broad");
      expect(dirtyPages(store.getState().pageEditor)).toEqual(["memory-tools"]);
      act(() => store.getState().discardSettingsPages());
      expect(store.getState().pageEditor?.draft.p5_config.retrieval_mode).toBe(mode);
      fireEvent.change(screen.getByLabelText("记忆工具额度模式"), { target: { value: "off" } });
      expect(store.getState().pageEditor?.draft.p5_config.retrieval_mode).toBe("off");
      expect(screen.queryByText(/全量读取设置.*广泛额度/)).toBeNull();
    },
  );
  it("selected-empty knowledge scope never broadens access across CAS save and refresh", async () => {
    const config = {
      enabled: true,
      context_budget: null,
      scope: "selected" as const,
      document_ids: [],
    };
    const client = setupLibrary({
      saveAgentKnowledgeRead: vi.fn().mockResolvedValue({ revision: 2, config }),
    });
    await act(async () => render(<KnowledgeToolSettings />));
    fireEvent.change(screen.getByLabelText("读取范围"), { target: { value: "selected" } });
    expect(store.getState().knowledgeReadEditor?.draft.document_ids).toEqual([]);
    act(() => store.getState().patchKnowledgeRead({ document_ids: [M] }));
    expect(screen.getByText("授权已失效")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "移除" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "保存知识规则" })));
    expect(client.saveAgentKnowledgeRead).toHaveBeenCalledWith(A, { expected_revision: 1, config });
    vi.mocked(client.getAgentKnowledgeRead).mockResolvedValue({ revision: 2, config });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "刷新授权" })));
    expect(store.getState().knowledgeReadEditor?.draft).toEqual(config);
    expect(screen.getByRole("checkbox", { name: "Reference" }).getAttribute("data-state")).toBe(
      "unchecked",
    );
  });
  it("knowledge access has a separate CAS save from agent identity", async () => {
    const save = vi.fn().mockResolvedValue({
      revision: 2,
      config: { enabled: false, context_budget: null, scope: "all", document_ids: [] },
    });
    store.setState({ apiClient: { ...store.getState().apiClient, saveAgentKnowledgeRead: save } });
    await act(async () => render(<KnowledgeToolSettings />));
    act(() => store.getState().patchPageAgent("basic", { name: "Unsaved agent" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "启用知识读取" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "保存知识规则" })));
    expect(save).toHaveBeenCalledWith(A, {
      expected_revision: 1,
      config: { enabled: false, context_budget: null, scope: "all", document_ids: [] },
    });
    expect(store.getState().pageEditor?.draft.name).toBe("Unsaved agent");
  });
  it.each(["zh-CN", "en"] as const)(
    "%s confirms three model purposes, preserves legacy retrieval and does not probe it",
    async (locale) => {
      const apply = vi.fn().mockResolvedValue(true);
      const editor = store.getState().pageEditor;
      if (!editor) throw new Error("Missing editor");
      store.setState({
        applyDefaultModelToAgent: apply,
        pageEditor: newPageEditor(
          { ...agent, memory_retrieval_model_name: "legacy-retrieval" },
          editor.persona,
        ),
      });
      selectLocale(locale);
      await act(async () => render(<CapabilityEditor />));
      expect(screen.getByLabelText(/记忆读取模型|Memory reading model/)).toHaveProperty(
        "value",
        "legacy-retrieval",
      );
      expect(store.getState().refreshCapacityPreview).toHaveBeenCalledWith([
        "model-a",
        "model-a",
        null,
      ]);
      fireEvent.click(
        screen.getByRole("button", { name: /三项文本任务使用默认模型|all three text tasks/ }),
      );
      const message = screen.getByRole("alertdialog").textContent;
      expect(message).toContain("Agent A");
      expect(message).toMatch(
        /不修改旧独立检索模型值|legacy independent retrieval model value is unchanged/,
      );
      expect(apply).not.toHaveBeenCalled();
      await act(async () =>
        fireEvent.click(screen.getByRole("button", { name: /^(确认|Confirm)$/ })),
      );
      expect(apply).toHaveBeenCalledWith("default-model");
    },
  );
});

describe("fresh library tasks", () => {
  it("document editor preserves exact original bytes and dirty-close guard", async () => {
    const update = vi.fn().mockResolvedValue(doc);
    store.setState({
      apiClient: { ...store.getState().apiClient, updateKnowledgeDocument: update },
    });
    await act(async () => render(<KnowledgeLibrary />));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Reference" })));
    fireEvent.change(screen.getByLabelText("名称"), { target: { value: "Renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(store.getState().navigationConfirmOpen).toBe(true);
    act(() => store.getState().cancelPendingNavigation());
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "保存" })));
    expect(update).toHaveBeenCalledWith(
      D,
      expect.objectContaining({
        name: "Renamed",
        original_text: doc.original_text,
        expected_revision: 3,
      }),
    );
  });
  it("document access names selected agents and saves grants only", async () => {
    const client = setupLibrary();
    await act(async () => render(<KnowledgeLibrary />));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "1 Agent" })));
    fireEvent.click(screen.getByRole("checkbox", { name: "Agent B" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "保存" })));
    expect(client.saveKnowledgeGrants).toHaveBeenCalledWith(D, 3, [A, B]);
    expect(client.updateKnowledgeDocument).not.toHaveBeenCalled();
  });
  it("shows memory management failures with a visible retry entry", async () => {
    setupLibrary();
    await act(async () => render(<MemoryLibrary />));
    act(() => store.setState({ error: "policy revision conflict", feedback: "" }));
    expect(screen.getByRole("alert").textContent).toContain("policy revision conflict");
    expect(screen.getByRole("button", { name: "刷新" })).toBeTruthy();
  });

  it("memory partition/filter is passed to the server and sharing uses binding CAS", async () => {
    const client = setupLibrary();
    await act(async () => render(<MemoryLibrary />));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /QQ · 私聊 20002/ })));
    expect(client.listMemoryEntries).toHaveBeenLastCalledWith(A, 0, 100, { scope_key: scopeKey });
    await act(async () =>
      fireEvent.click(screen.getByRole("checkbox", { name: "与网页对话记忆共享" })),
    );
    expect(client.updateQqBinding).toHaveBeenCalledWith(B, {
      expected_revision: 2,
      share_web_memory: true,
    });
    expect(screen.getByText("关闭共享不会搬迁或删除任何已有记忆。")).toBeTruthy();
  });
  /**
   * 记忆维护（自动整理/轮数/目标字符/整理提示词）位于资料库→记忆的正文区：
   * 空 scope（所有分区）即可用，选中网页对话记忆分区仍可用；QQ 分区只显示绑定控制，不混入网页维护。
   * 保存仍走 long-memory 白名单（后端与字段归属没变）。系统能力里的记忆工具设置不再承载维护编辑器，
   * 只保留跳转入口（不是第二个编辑器），这里断言没有重复维护控件。
   */
  it("keeps memory maintenance available without a selected partition and saves its own whitelist", async () => {
    const client = setupLibrary({
      updatePolicy: vi.fn(async (_id: string, body: object) => ({
        ...policy,
        ...(body as object),
        version: 2,
      })),
      updateAgent: vi.fn(async (id: string, body: object) => ({
        ...agent,
        id,
        ...(body as object),
      })),
    });
    await act(async () => render(<MemoryLibrary />));
    // 空 scope 也能管理：不选中任何分区时维护卡已在正文区。
    expect(screen.getByLabelText("自动整理网页对话记忆")).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /网页对话记忆/ })));
    // 选中网页对话记忆分区后仍可用。
    expect(screen.getByLabelText("自动整理网页对话记忆")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("每隔多少轮整理"), { target: { value: "30" } });
    expect(store.getState().pageEditor?.policyDraft?.every_turns).toBe(30);
    fireEvent.change(screen.getByLabelText("记忆整理提示词"), { target: { value: "保留事实" } });
    expect(store.getState().pageEditor?.draft.memory_consolidation_prompt).toBe("保留事实");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "保存记忆规则" })));
    expect(client.updatePolicy).toHaveBeenCalledWith(
      A,
      expect.objectContaining({ every_turns: 30 }),
    );
    expect(client.updateAgent).toHaveBeenCalledWith(
      A,
      expect.objectContaining({ memory_consolidation_prompt: "保留事实" }),
    );
    // 切到 QQ 分区：只对应绑定控制，不混入网页维护。
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /QQ · 私聊 20002/ })));
    expect(screen.queryByLabelText("自动整理网页对话记忆")).toBeNull();
    expect(screen.queryByLabelText("记忆整理提示词")).toBeNull();
    // 记忆工具设置（系统能力）只保留「前往长期记忆」跳转入口（不是第二个编辑器），没有重复维护控件。
    cleanup();
    await act(async () => render(<MemoryToolSettings />));
    expect(screen.getByRole("button", { name: "前往长期记忆" })).toBeTruthy();
    expect(screen.queryByLabelText("自动整理网页对话记忆")).toBeNull();
    expect(screen.queryByLabelText("记忆整理提示词")).toBeNull();
  });
  it("a batch-size draft protects scope and global navigation", async () => {
    await act(async () => render(<MemoryLibrary />));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /QQ · 私聊 20002/ })));
    fireEvent.change(screen.getByLabelText("自动整理批次（留空关闭）"), {
      target: { value: "30" },
    });
    expect(screen.getByRole("button", { name: /所有分区/ }).matches(":disabled")).toBe(true);
    act(() => store.getState().openChat());
    expect(store.getState().navigationConfirmOpen).toBe(true);
  });
  it("memory correction retains edits on close and preserves user text after language change", async () => {
    store.setState({ memoryEntryDetail: memory });
    await act(async () => render(<MemoryDetail />));
    await userEvent.click(screen.getByRole("tab", { name: "纠正" }));
    fireEvent.change(screen.getByLabelText("记忆正文"), { target: { value: "保留中文原文" } });
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    act(() => selectLocale("en"));
    expect(screen.getByDisplayValue("保留中文原文")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save correction" })).toBeTruthy();
  });
  it("memory delete requires an explicit confirmation", async () => {
    const govern = vi.fn().mockResolvedValue(true);
    store.setState({ governMemories: govern });
    await act(async () => render(<MemoryLibrary />));
    fireEvent.click(screen.getByRole("checkbox", { name: "选择 Memory one" }));
    fireEvent.click(screen.getByRole("button", { name: "永久删除" }));
    expect(govern).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "确认" })));
    expect(govern).toHaveBeenCalledWith(A, [M], "purge", true);
  });
});

describe("preferences and localized resources", () => {
  it("retains all 16 palettes with immediate persisted selection", () => {
    render(<Preferences />);
    for (const theme of THEMES) {
      const button = screen.getByRole("button", { name: theme.name });
      fireEvent.click(button);
      expect(readTheme()).toBe(theme.id);
      expect(button.getAttribute("aria-pressed")).toBe("true");
    }
  });
  it("supports light, dark and system modes", () => {
    render(<Preferences />);
    for (const [name, value] of [
      ["深色", "dark"],
      ["浅色", "light"],
      ["跟随系统", "system"],
    ]) {
      fireEvent.click(screen.getByRole("button", { name }));
      expect(readMode()).toBe(value);
    }
  });
  it("changes locale without losing persisted domain drafts", () => {
    act(() => store.getState().patchPageAgent("basic", { name: "Draft" }));
    render(<Preferences />);
    fireEvent.change(screen.getByLabelText("语言"), { target: { value: "en" } });
    expect(screen.getByRole("heading", { name: "Make this workspace yours" })).toBeTruthy();
    expect(store.getState().pageEditor?.draft.name).toBe("Draft");
    expect(screen.getByRole("button", { name: "Forest" })).toBeTruthy();
  });
  it("every owned stable key has both languages and matching interpolation", () => {
    for (const [key, english] of Object.entries(en)) {
      if (!key.startsWith("library.")) continue;
      const value = { en: english, zh: zh[key as keyof typeof zh] };
      expect(key).not.toMatch(/[\u3400-\u9fff]/);
      expect(value.en, key).toBeTruthy();
      expect(value.en, key).not.toMatch(/[\u3400-\u9fff]/);
      expect(value.en.match(/\{\d+\}/g)?.sort() ?? [], key).toEqual(
        value.zh.match(/\{\d+\}/g)?.sort() ?? [],
      );
    }
  });
  it("English agent/resource controls do not translate user content or leak source language", async () => {
    selectLocale("en");
    await act(async () =>
      render(
        <>
          <MemoryToolSettings />
          <KnowledgeToolSettings />
        </>,
      ),
    );
    expect(screen.getByText("Knowledge access")).toBeTruthy();
    expect(screen.getByText(/Skill text cannot grant access/)).toBeTruthy();
    expect(screen.getByText(/Global budget: 2048 UTF-8 bytes per turn/)).toBeTruthy();
    const copy = document.body.cloneNode(true) as HTMLElement;
    copy.querySelectorAll("input,textarea").forEach((node) => {
      node.remove();
    });
    expect(copy.textContent).not.toMatch(/[\u3400-\u9fff]/);
  });
});

describe("discard and re-enter object editors", () => {
  it("reloads knowledge settings after discard so editing remains available", async () => {
    await act(async () => render(<KnowledgeToolSettings />));
    fireEvent.click(screen.getByRole("checkbox", { name: "启用知识读取" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "放弃修改" })));
    expect(screen.getByRole("checkbox", { name: "启用知识读取" }).getAttribute("data-state")).toBe(
      "checked",
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "启用知识读取" }));
    expect(store.getState().knowledgeReadEditor?.draft.enabled).toBe(false);
  });
  it("reloads correction content after discard and accepts the next correction", async () => {
    store.setState({ memoryEntryDetail: memory });
    await act(async () => render(<MemoryDetail />));
    await userEvent.click(screen.getByRole("tab", { name: "纠正" }));
    fireEvent.change(screen.getByLabelText("记忆正文"), { target: { value: "Discard me" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "放弃纠正" })));
    expect((screen.getByLabelText("记忆正文") as HTMLTextAreaElement).value).toBe(
      "Original memory",
    );
    fireEvent.change(screen.getByLabelText("记忆正文"), { target: { value: "New correction" } });
    expect(store.getState().memoryCorrectionDraft?.body).toBe("New correction");
  });
  it("accepts model IDs absent from the currently loaded catalog", async () => {
    await act(async () => render(<CapabilityEditor />));
    fireEvent.change(screen.getByLabelText("对话模型"), {
      target: { value: "unloaded/local-model" },
    });
    expect(store.getState().pageEditor?.draft.model_name).toBe("unloaded/local-model");
  });
});

it("refreshes jobs and source conversations before reloading the filtered memory page", async () => {
  const client = setupLibrary({
    listMemorySessions: vi
      .fn()
      .mockResolvedValue([{ id: D, title: "Newly completed conversation" }]),
    listMemoryJobs: vi.fn().mockResolvedValue([
      {
        id: M,
        kind: "manual",
        session_id: D,
        status: "succeeded",
        result_id: M,
        error_code: null,
        created_at: "2026-09-25T00:00:00Z",
        finished_at: "2026-09-25T00:01:00Z",
      },
    ]),
  });
  await act(async () => render(<MemoryLibrary />));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: /QQ · 私聊 20002/ })));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "刷新" })));
  expect(store.getState().memorySessions).toEqual([
    { id: D, title: "Newly completed conversation" },
  ]);
  expect(store.getState().memoryJobs[0]?.status).toBe("succeeded");
  expect(client.listMemoryEntries).toHaveBeenLastCalledWith(A, 0, 100, { scope_key: scopeKey });
});
