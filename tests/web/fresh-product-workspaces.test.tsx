import { act, cleanup, fireEvent, render as renderView, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readMode, readTheme, SELECTABLE_THEMES } from "../../src/web/appearance";
import { DesignSystemProvider } from "../../src/web/design-system/Providers";
import { dirtyPages, newPageEditor } from "../../src/web/features/agents/page-drafts";

const resetContextAllocationTarget = () =>
  store.setState({
    contextAllocationTarget: {
      purpose: "assistant",
      agentId: null,
      schemeId: null,
      bindingId: null,
      returnRoute: null,
      returnLabel: null,
    },
  });

import { msg, selectLocale } from "../../src/web/i18n";
import en from "../../src/web/i18n/locales/en/translation.json";
import zh from "../../src/web/i18n/locales/zh-CN/translation.json";
import { AgentMaterials } from "../../src/web/screens/assistants/AgentMaterials";
import { AssistantWorkspace } from "../../src/web/screens/assistants/AssistantWorkspace";

import { CapabilityEditor, IdentityEditor } from "../../src/web/screens/assistants/StudioEditors";
import { AgentModelPurpose } from "../../src/web/screens/environment/AgentModelPurpose";
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

/** 显式 tooltip（保存按钮/字段帮助）必须挂在真实 DesignSystemProvider 下渲染。 */
const render = (...[ui, options]: Parameters<typeof renderView>) =>
  renderView(ui, { wrapper: DesignSystemProvider, ...options });

beforeEach(() => {
  localStorage.clear();
  setupLibrary();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  selectLocale("zh-CN");
  resetContextAllocationTarget();
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
  it("shows one bounded memory allowance and keeps changes in the materials draft", async () => {
    const client = setupLibrary({ updateAgent: vi.fn() });
    await act(async () => render(<AgentMaterials />));
    expect(screen.queryByLabelText("记忆工具额度模式")).toBeNull();
    expect(screen.queryByLabelText("每次查询候选条数上限")).toBeNull();
    expect(screen.queryByLabelText("每页最大返回项")).toBeNull();
    expect(screen.queryByLabelText("记忆检索提示词")).toBeNull();
    const bytes = screen.getByLabelText("记忆工具读取额度") as HTMLInputElement;
    expect(bytes.inputMode).toBe("numeric");
    fireEvent.change(bytes, { target: { value: "5000" } });
    expect(store.getState().pageEditor?.draft.p5_config.memory_read).toEqual({
      enabled: true,
      max_bytes: 5000,
    });
    expect(dirtyPages(store.getState().pageEditor)).toEqual(["memory-tools"]);
    expect(client.updateAgent).not.toHaveBeenCalled();
    fireEvent.change(bytes, { target: { value: "0" } });
    expect(bytes.getAttribute("aria-invalid")).toBe("true");
    expect(store.getState().pageEditor?.draft.p5_config.memory_read?.max_bytes).toBe(5000);
  });
  it("shows the saved global knowledge budget alongside the memory allowance", async () => {
    await act(async () => render(<AgentMaterials />));
    expect(screen.getByLabelText("记忆工具读取额度")).toBeTruthy();
    expect(screen.getByText(/已保存的全局读取额度：2048 Bytes/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "保存全局预算" })).toBeNull();
    expect(screen.queryByLabelText("自动整理网页对话记忆")).toBeNull();
    expect(screen.queryByLabelText("记忆整理提示词")).toBeNull();
  });
  it.each(["full_catalog", "full_body"] as const)(
    "preserves stored %s on visits while exposing only the effective allowance",
    async (mode) => {
      const editor = store.getState().pageEditor;
      if (!editor) throw new Error("Missing editor");
      const legacy = {
        ...agent,
        p5_config: { ...agent.p5_config, memory_read: undefined, retrieval_mode: mode },
      };
      store.setState({ pageEditor: newPageEditor(legacy, editor.persona) });
      await act(async () => render(<AgentMaterials />));
      expect(screen.queryByLabelText("记忆工具额度模式")).toBeNull();
      expect(screen.queryByRole("button", { name: "改为广泛额度" })).toBeNull();
      expect(store.getState().pageEditor?.draft.p5_config.retrieval_mode).toBe(mode);
      expect(dirtyPages(store.getState().pageEditor)).toEqual([]);
      fireEvent.change(screen.getByLabelText("记忆工具读取额度"), { target: { value: "2048" } });
      expect(store.getState().pageEditor?.draft.p5_config.retrieval_mode).toBe(mode);
      act(() => store.getState().discardSettingsPages());
      expect(store.getState().pageEditor?.draft.p5_config.retrieval_mode).toBe(mode);
      expect(dirtyPages(store.getState().pageEditor)).toEqual([]);
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
    store.setState({ settingsRoute: "memory-tools" });
    await act(async () => render(<AssistantWorkspace />));
    fireEvent.change(screen.getByLabelText("读取范围"), { target: { value: "selected" } });
    expect(store.getState().knowledgeReadEditor?.draft.document_ids).toEqual([]);
    act(() => store.getState().patchKnowledgeRead({ document_ids: [M] }));
    expect(screen.getByText("授权已失效")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "移除" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "保存 Agent" })));
    expect(client.saveAgentKnowledgeRead).toHaveBeenCalledWith(A, { expected_revision: 1, config });
    vi.mocked(client.getAgentKnowledgeRead).mockResolvedValue({ revision: 2, config });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "刷新保存基线" })));
    expect(store.getState().knowledgeReadEditor?.draft).toEqual(config);
    expect(screen.getByRole("checkbox", { name: "Reference" }).getAttribute("data-state")).toBe(
      "unchecked",
    );
  });
  it("knowledge access retains its CAS and does not save the identity draft", async () => {
    const save = vi.fn().mockResolvedValue({
      revision: 2,
      config: { enabled: false, context_budget: null, scope: "all", document_ids: [] },
    });
    const client = setupLibrary({ saveAgentKnowledgeRead: save, updateAgent: vi.fn() });
    store.setState({ settingsRoute: "memory-tools" });
    await act(async () => render(<AssistantWorkspace />));
    act(() => store.getState().patchPageAgent("basic", { name: "Unsaved agent" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "启用知识读取" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "保存 Agent" })));
    expect(save).toHaveBeenCalledWith(A, {
      expected_revision: 1,
      config: { enabled: false, context_budget: null, scope: "all", document_ids: [] },
    });
    expect(client.updateAgent).not.toHaveBeenCalled();
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
      await act(async () => render(<AgentModelPurpose />));
      expect(
        screen.queryByRole("combobox", { name: /^(记忆读取模型|Memory reading model)$/ }),
      ).toBeNull();
      expect(store.getState().pageEditor?.draft.memory_retrieval_model_name).toBe(
        "legacy-retrieval",
      );
      // 新模型分工宿主不做容量预览：零容量请求（真实动作未被调用）。
      // 既有探测覆盖仍归 allocation-performance-isolation 与 ModelPurposes 既有断言，不假改为 none。
      expect(store.getState().refreshCapacityPreview).not.toHaveBeenCalled();
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
    expect(client.saveKnowledgeGrants).toHaveBeenCalledWith(D, 3, [A, B], undefined);
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
    expect(client.listMemoryEntries).toHaveBeenLastCalledWith(
      A,
      0,
      100,
      { view: "owned", scope_key: scopeKey },
      expect.anything(),
    );
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
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /^网页对话记忆/ })));
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
    cleanup();
    await act(async () => render(<AgentMaterials />));
    expect(screen.getByLabelText("记忆工具读取额度")).toBeTruthy();
    expect(screen.queryByLabelText("自动整理网页对话记忆")).toBeNull();
    expect(screen.queryByLabelText("记忆整理提示词")).toBeNull();
    expect(screen.getByRole("button", { name: "管理记忆与来源" })).toBeTruthy();
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
  it("offers the curated palettes with immediate persisted selection", () => {
    render(<Preferences />);
    expect(screen.queryByRole("button", { name: "深蓝灰" })).toBeNull();
    expect(screen.queryByRole("button", { name: "海蓝" })).toBeNull();
    for (const theme of SELECTABLE_THEMES) {
      // Every offered theme must persist and expose its selected state.
      const name = zh[`preferences.theme.${theme.id}` as keyof typeof zh];
      if (!name) throw new Error(`Missing zh name for theme ${theme.id}`);
      const button = screen.getByRole("button", { name });
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
    expect(screen.getByRole("button", { name: "Sage" })).toBeTruthy();
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
    await act(async () => render(<AgentMaterials />));
    expect(screen.getByText("External materials")).toBeTruthy();
    expect(screen.getByText(/Saved global read allowance: 2048 Bytes/)).toBeTruthy();
    const copy = document.body.cloneNode(true) as HTMLElement;
    copy.querySelectorAll("input,textarea").forEach((node) => {
      node.remove();
    });
    expect(copy.textContent).not.toMatch(/[\u3400-\u9fff]/);
  });
});

describe("discard and re-enter object editors", () => {
  it("reloads knowledge settings after discard so editing remains available", async () => {
    store.setState({ settingsRoute: "memory-tools" });
    await act(async () => render(<AssistantWorkspace />));
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
    await act(async () => render(<AgentModelPurpose />));
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
  fireEvent.change(screen.getByLabelText("搜索记忆"), { target: { value: "apple" } });
  fireEvent.change(screen.getByLabelText("记忆状态"), { target: { value: "active" } });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "搜索" })));
  vi.mocked(client.listMemoryEntries).mockClear();
  vi.mocked(client.listMemorySessions).mockClear();
  vi.mocked(client.listMemoryJobs).mockClear();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "刷新" })));
  expect(store.getState().memorySessions).toEqual([
    { id: D, title: "Newly completed conversation" },
  ]);
  expect(store.getState().memoryJobs[0]?.status).toBe("succeeded");
  expect(vi.mocked(client.listMemorySessions).mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(client.listMemoryEntries).mock.invocationCallOrder[0],
  );
  expect(vi.mocked(client.listMemoryJobs).mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(client.listMemoryEntries).mock.invocationCallOrder[0],
  );
  expect(client.listMemoryEntries).toHaveBeenLastCalledWith(
    A,
    0,
    100,
    { view: "owned", scope_key: scopeKey, search: "apple", status: "active" },
    expect.anything(),
  );
});
