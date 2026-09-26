import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readMode, readTheme, THEMES } from "../../src/web/appearance";
import { selectLocale } from "../../src/web/i18n";
import en from "../../src/web/i18n/locales/en/translation.json";
import zh from "../../src/web/i18n/locales/zh-CN/translation.json";
import { AssistantWorkspace } from "../../src/web/screens/assistants/AssistantWorkspace";
import { ResourceRules } from "../../src/web/screens/assistants/ResourceRules";
import { CapabilityEditor, IdentityEditor } from "../../src/web/screens/assistants/StudioEditors";
import { Preferences } from "../../src/web/screens/environment/Preferences";
import { KnowledgeLibrary } from "../../src/web/screens/library/KnowledgeLibrary";
import { MemoryDetail, MemoryLibrary } from "../../src/web/screens/library/MemoryLibrary";
import { useSuperstringStore as store } from "../../src/web/store";
import {
  A,
  B,
  D,
  document as doc,
  M,
  memory,
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
    fireEvent.click(screen.getByRole("button", { name: "所有助手" }));
    expect(store.getState().pageEditor?.draft.name).toBe("Draft name");
    expect(store.getState().pageEditor?.agent.name).toBe("Agent A");
  });
  it("keeps all six retrieval modes and independent presets", async () => {
    await act(async () => render(<ResourceRules />));
    expect(within(screen.getByLabelText("检索模式")).getAllByRole("option")).toHaveLength(6);
    const broad = structuredClone(
      store.getState().pageEditor?.draft.p5_config.retrieval_presets.broad,
    );
    await userEvent.click(screen.getByRole("button", { name: /保守 ·/ }));
    fireEvent.change(screen.getByLabelText("候选数量"), { target: { value: "30" } });
    expect(store.getState().pageEditor?.draft.p5_config.retrieval_presets.broad).toEqual(broad);
    expect(
      store.getState().pageEditor?.draft.p5_config.retrieval_presets.conservative.candidate_limit,
    ).toBe(30);
  });
  it("selected-empty knowledge scope never broadens access and expired IDs can be removed", async () => {
    await act(async () => render(<ResourceRules />));
    fireEvent.change(screen.getByLabelText("读取范围"), { target: { value: "selected" } });
    expect(store.getState().knowledgeReadEditor?.draft.document_ids).toEqual([]);
    act(() => store.getState().patchKnowledgeRead({ document_ids: [M] }));
    expect(screen.getByText("授权已失效")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "移除" }));
    expect(store.getState().knowledgeReadEditor?.draft).toMatchObject({
      scope: "selected",
      document_ids: [],
    });
  });
  it("knowledge access has a separate CAS save from agent identity", async () => {
    const save = vi.fn().mockResolvedValue({
      revision: 2,
      config: { enabled: false, context_budget: null, scope: "all", document_ids: [] },
    });
    store.setState({ apiClient: { ...store.getState().apiClient, saveAgentKnowledgeRead: save } });
    await act(async () => render(<ResourceRules />));
    act(() => store.getState().patchPageAgent("basic", { name: "Unsaved agent" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "启用知识读取" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "保存知识规则" })));
    expect(save).toHaveBeenCalledWith(A, {
      expected_revision: 1,
      config: { enabled: false, context_budget: null, scope: "all", document_ids: [] },
    });
    expect(store.getState().pageEditor?.draft.name).toBe("Unsaved agent");
  });
  it("default-model replacement names the explicit target and waits for confirmation", async () => {
    const apply = vi.fn().mockResolvedValue(true);
    store.setState({ applyDefaultModelToAgent: apply });
    await act(async () => render(<CapabilityEditor />));
    fireEvent.click(screen.getByRole("button", { name: /四项文本任务使用默认模型/ }));
    expect(screen.getByRole("alertdialog").textContent).toContain("Agent A");
    expect(apply).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "确认" })));
    expect(apply).toHaveBeenCalledWith("default-model");
  });
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
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "1 助手" })));
    fireEvent.click(screen.getByRole("checkbox", { name: "Agent B" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "保存" })));
    expect(client.saveKnowledgeGrants).toHaveBeenCalledWith(D, 3, [A, B]);
    expect(client.updateKnowledgeDocument).not.toHaveBeenCalled();
  });
  it("memory partition/filter is passed to the server and sharing uses binding CAS", async () => {
    const client = setupLibrary();
    await act(async () => render(<MemoryLibrary />));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /QQ · 私聊 20002/ })));
    expect(client.listMemoryEntries).toHaveBeenLastCalledWith(A, 0, 100, { scope_key: scopeKey });
    await act(async () =>
      fireEvent.click(screen.getByRole("checkbox", { name: "与网页记忆共享" })),
    );
    expect(client.updateQqBinding).toHaveBeenCalledWith(B, {
      expected_revision: 2,
      share_web_memory: true,
    });
    expect(screen.getByText("关闭共享不会搬迁或删除任何已有记忆。")).toBeTruthy();
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
    await act(async () => render(<ResourceRules />));
    expect(screen.getByText("Knowledge access")).toBeTruthy();
    const copy = document.body.cloneNode(true) as HTMLElement;
    copy.querySelectorAll("input,textarea").forEach((node) => {
      node.remove();
    });
    expect(copy.textContent).not.toMatch(/[\u3400-\u9fff]/);
  });
});

describe("discard and re-enter object editors", () => {
  it("reloads knowledge settings after discard so editing remains available", async () => {
    await act(async () => render(<ResourceRules />));
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
