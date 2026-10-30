// 记忆维护与 Agent 材料任务：草稿隔离、保存、数值和导航。
import { act, cleanup, fireEvent, render as renderView, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

import { knowledgeReadDirty } from "../../src/web/features/knowledge/types";
import { AgentMaterials } from "../../src/web/screens/assistants/AgentMaterials";
import { AssistantWorkspace } from "../../src/web/screens/assistants/AssistantWorkspace";

import { MemoryLibrary } from "../../src/web/screens/library/MemoryLibrary";
import { useSuperstringStore as store } from "../../src/web/store";
import { A, agent, B, persona, policy, setupLibrary } from "./helpers/library-fixture";

/** 显式 tooltip（保存按钮/字段帮助）必须挂在真实 DesignSystemProvider 下渲染。 */
const render = (...[ui, options]: Parameters<typeof renderView>) =>
  renderView(ui, { wrapper: DesignSystemProvider, ...options });

/** long-memory 的 Agent 载荷白名单：顺序按字母序校验，防止多写字段。 */
const LONG_MEMORY_PAYLOAD_KEYS = [
  "expected_version",
  "memory_consolidation_additional_instructions",
  "memory_consolidation_prompt",
];

/** memory-tools 的 Agent 载荷白名单：只拥有 p5 读取字段。 */
const MEMORY_TOOLS_PAYLOAD_KEYS = ["expected_version", "p5_config"];

/** 保存替身：返回 store 可接受的已存对象（真实 api 会走网络与解析）。 */
function saveMocks() {
  return {
    updatePolicy: vi.fn(async (_id: string, body: object) => ({
      ...policy,
      ...(body as object),
      version: 2,
    })),
    updateAgent: vi.fn(async (id: string, body: object) => ({ ...agent, id, ...(body as object) })),
  };
}

beforeEach(() => {
  setupLibrary();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetContextAllocationTarget();
});

describe("library web memory maintenance", () => {
  it("stays manageable without partitions and saves only the long-memory whitelist", async () => {
    const mocks = saveMocks();
    const client = setupLibrary({ listMemoryScopes: vi.fn().mockResolvedValue([]), ...mocks });
    await act(async () => render(<MemoryLibrary />));
    // 没有分区也能管理：面板在正文区，不在窄 sidebar，也没有 QQ 分区入口。
    const auto = screen.getByLabelText("自动整理网页对话记忆");
    expect(screen.getByText("记忆维护")).toBeTruthy();
    const aside = document.querySelector("aside");
    expect(aside).not.toBeNull();
    expect(aside?.contains(auto)).toBe(false);
    expect(screen.queryByRole("button", { name: /QQ/ })).toBeNull();
    // 留草稿：改轮数/提示词只进草稿，不隐式保存。
    fireEvent.change(screen.getByLabelText("每隔多少轮整理"), { target: { value: "30" } });
    fireEvent.change(screen.getByLabelText("记忆整理提示词"), { target: { value: "保留事实" } });
    expect(store.getState().pageEditor?.policyDraft?.every_turns).toBe(30);
    expect(store.getState().pageEditor?.draft.memory_consolidation_prompt).toBe("保留事实");
    expect(mocks.updatePolicy).not.toHaveBeenCalled();
    expect(mocks.updateAgent).not.toHaveBeenCalled();
    // 放弃草稿同样不写：回到已存策略。
    fireEvent.click(screen.getByRole("button", { name: "放弃修改" }));
    expect(store.getState().pageEditor?.policyDraft?.every_turns).toBe(policy.every_turns);
    expect(dirtyPages(store.getState().pageEditor)).toEqual([]);
    expect(mocks.updateAgent).not.toHaveBeenCalled();
    // 显式保存：策略与提示词各走原白名单，且不创建分区/QQ 业务记录。
    fireEvent.change(screen.getByLabelText("每隔多少轮整理"), { target: { value: "30" } });
    fireEvent.change(screen.getByLabelText("记忆整理提示词"), { target: { value: "保留事实" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "保存记忆规则" })));
    expect(mocks.updatePolicy).toHaveBeenCalledTimes(1);
    expect(mocks.updatePolicy).toHaveBeenCalledWith(A, {
      auto_enabled: policy.auto_enabled,
      every_turns: 30,
      target_chars: policy.target_chars,
      expected_version: policy.version,
    });
    expect(mocks.updateAgent).toHaveBeenCalledTimes(1);
    const [savedId, savedBody] = mocks.updateAgent.mock.calls[0];
    expect(savedId).toBe(A);
    expect(Object.keys(savedBody).sort()).toEqual(LONG_MEMORY_PAYLOAD_KEYS);
    expect(savedBody).not.toHaveProperty("p5_config");
    expect(client.updateQqBinding).not.toHaveBeenCalled();
    expect(client.organiseQqMemory).not.toHaveBeenCalled();
    expect(store.getState().qqMemoryBatchDrafts).toEqual({});
    expect(dirtyPages(store.getState().pageEditor)).toEqual([]);
  });

  it("keeps QQ partitions on binding controls and restores the web panel afterwards", async () => {
    const client = setupLibrary();
    await act(async () => render(<MemoryLibrary />));
    expect(screen.getByLabelText("自动整理网页对话记忆")).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /QQ · 私聊 20002/ })));
    // QQ 分区只对应绑定控制：维护面板整体隐藏。
    expect(screen.queryByLabelText("自动整理网页对话记忆")).toBeNull();
    expect(screen.queryByLabelText("记忆整理提示词")).toBeNull();
    expect(screen.getByLabelText("自动整理批次（留空关闭）")).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "与网页对话记忆共享" })).toBeTruthy();
    // 只是切换查看：不隐式保存绑定，也不触发整理任务。
    expect(client.updateQqBinding).not.toHaveBeenCalled();
    expect(client.organiseQqMemory).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /^网页对话记忆/ })));
    expect(screen.getByLabelText("记忆整理提示词")).toBeTruthy();
    expect(screen.queryByLabelText("自动整理批次（留空关闭）")).toBeNull();
  });

  it("shows the new agent's maintenance values after switching agents", async () => {
    setupLibrary({
      getPolicy: vi.fn(async (id: string) => ({
        ...policy,
        every_turns: id === B ? 55 : 20,
        version: id === B ? 3 : 1,
      })),
    });
    await act(async () => render(<MemoryLibrary />));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /^网页对话记忆/ })));
    expect((screen.getByLabelText("每隔多少轮整理") as HTMLInputElement).value).toBe("20");
    await act(async () => {
      store.setState({
        editorAgentId: B,
        pageEditor: newPageEditor({ ...agent, id: B, name: "Agent B" }, persona, {
          ...policy,
          every_turns: 55,
          version: 3,
        }),
      });
    });
    // 换 Agent 后不留旧值：面板按新 Agent 的已存策略重绘。
    expect((screen.getByLabelText("每隔多少轮整理") as HTMLInputElement).value).toBe("55");
    expect(screen.getByLabelText("记忆整理提示词")).toBeTruthy();
  });

  it("keeps the loading guard while the agent policy is unreadable", async () => {
    setupLibrary({ getPolicy: vi.fn().mockReturnValue(new Promise(() => {})) });
    const editor = store.getState().pageEditor;
    if (!editor) throw new Error("Missing editor");
    store.setState({ pageEditor: newPageEditor(editor.agent, editor.persona) });
    await act(async () => render(<MemoryLibrary />));
    expect(screen.getByText("正在加载…")).toBeTruthy();
    expect(screen.queryByLabelText("每隔多少轮整理")).toBeNull();
    expect(screen.queryByLabelText("自动整理网页对话记忆")).toBeNull();
  });

  it("jumps to model services through the shared draft-safe navigation", async () => {
    const mocks = saveMocks();
    setupLibrary(mocks);
    await act(async () => render(<MemoryLibrary />));
    fireEvent.change(screen.getByLabelText("记忆整理提示词"), { target: { value: "草稿" } });
    fireEvent.click(screen.getByRole("button", { name: "前往整理默认模型" }));
    expect(store.getState().settingsRoute).toBe("basic");
    expect(store.getState().pendingNavigation).toMatchObject({
      kind: "page",
      settingsRoute: "execution-settings",
    });
    // 真正离开前必须显式决定；取消不隐式保存、不丢弃草稿。
    expect(store.getState().pageEditor?.draft.memory_consolidation_prompt).toBe("草稿");
    expect(dirtyPages(store.getState().pageEditor)).toEqual(["long-memory"]);
    store.getState().cancelPendingNavigation();
    expect(store.getState().pageEditor?.draft.memory_consolidation_prompt).toBe("草稿");
    expect(mocks.updateAgent).not.toHaveBeenCalled();
    expect(mocks.updatePolicy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "前往整理默认模型" }));
    await act(async () => store.getState().confirmDiscardAndContinue());
    expect(store.getState().settingsRoute).toBe("execution-settings");
    expect(dirtyPages(store.getState().pageEditor)).toEqual([]);
    expect(mocks.updateAgent).not.toHaveBeenCalled();
    expect(mocks.updatePolicy).not.toHaveBeenCalled();
  });

  it("keeps the allowance draft independent from maintenance discard", async () => {
    const mocks = saveMocks();
    setupLibrary(mocks);
    await act(async () => render(<AgentMaterials />));
    fireEvent.change(screen.getByLabelText("记忆工具读取额度"), { target: { value: "1500" } });
    cleanup();
    await act(async () => render(<MemoryLibrary />));
    expect(screen.queryByText(/保存记忆规则会同时提交/)).toBeNull();
    fireEvent.change(screen.getByLabelText("每隔多少轮整理"), { target: { value: "30" } });
    fireEvent.change(screen.getByLabelText("记忆整理提示词"), { target: { value: "保留事实" } });
    fireEvent.click(screen.getByRole("button", { name: "放弃修改" }));
    const editor = store.getState().pageEditor;
    expect(editor?.policyDraft?.every_turns).toBe(policy.every_turns);
    expect(editor?.draft.memory_consolidation_prompt).toBe(agent.memory_consolidation_prompt);
    expect(editor?.draft.p5_config.memory_read?.max_bytes).toBe(1500);
    expect(dirtyPages(editor)).toEqual(["memory-tools"]);
    expect(mocks.updateAgent).not.toHaveBeenCalled();
    expect(mocks.updatePolicy).not.toHaveBeenCalled();
  });

  it("saving materials submits both reading drafts but not maintenance or other task drafts", async () => {
    const mocks = saveMocks();
    const save = vi.fn(
      async (
        _id: string,
        body: import("../../src/shared/contracts/knowledge").AgentKnowledgeReadUpdate,
      ) => ({ revision: 2, config: body.config }),
    );
    const client = setupLibrary({ ...mocks, saveAgentKnowledgeRead: save });
    store.setState({ settingsRoute: "memory-tools" });
    await act(async () => render(<AssistantWorkspace />));
    fireEvent.change(screen.getByLabelText("记忆工具读取额度"), { target: { value: "1500" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "启用知识读取" }));
    expect(knowledgeReadDirty(store.getState().knowledgeReadEditor)).toBe(true);
    act(() => {
      store.getState().patchPageAgent("long-memory", { memory_consolidation_prompt: "保留事实" });
      store.getState().patchPageAgent("models", { model_name: "draft-model" });
    });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "保存 Agent" })));
    expect(mocks.updateAgent).toHaveBeenCalledTimes(1);
    expect(mocks.updateAgent.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        p5_config: expect.objectContaining({ memory_read: { enabled: true, max_bytes: 1500 } }),
      }),
    );
    expect(mocks.updateAgent.mock.calls[0][1]).not.toHaveProperty("memory_consolidation_prompt");
    expect(mocks.updatePolicy).not.toHaveBeenCalled();
    expect(client.saveAgentKnowledgeRead).toHaveBeenCalledTimes(1);
    expect(store.getState().pageEditor?.draft.model_name).toBe("draft-model");
    expect(store.getState().pageEditor?.draft.memory_consolidation_prompt).toBe("保留事实");
    expect(dirtyPages(store.getState().pageEditor)).toEqual(["models", "long-memory"]);
  });
});

describe("agent memory allowance", () => {
  it("saves the single allowance through the task whitelist while preserving legacy fields", async () => {
    const mocks = saveMocks();
    setupLibrary(mocks);
    store.setState({ settingsRoute: "memory-tools" });
    await act(async () => render(<AssistantWorkspace />));
    const original = structuredClone(
      store.getState().pageEditor?.draft.p5_config.retrieval_presets,
    );
    expect(screen.queryByLabelText("记忆工具额度模式")).toBeNull();
    expect(screen.queryByLabelText("每次查询候选条数上限")).toBeNull();
    fireEvent.change(screen.getByLabelText("记忆工具读取额度"), { target: { value: "1500" } });
    expect(dirtyPages(store.getState().pageEditor)).toEqual(["memory-tools"]);
    expect(mocks.updateAgent).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "保存 Agent" })));
    expect(mocks.updateAgent).toHaveBeenCalledTimes(1);
    const [savedId, savedBody] = mocks.updateAgent.mock.calls[0];
    expect(savedId).toBe(A);
    expect(Object.keys(savedBody).sort()).toEqual(MEMORY_TOOLS_PAYLOAD_KEYS);
    expect(savedBody).toEqual(
      expect.objectContaining({
        p5_config: expect.objectContaining({
          memory_read: { enabled: true, max_bytes: 1500 },
          retrieval_presets: original,
        }),
      }),
    );
    expect(mocks.updatePolicy).not.toHaveBeenCalled();
  });

  it("validates allowance before submitting and preserves the last valid draft", async () => {
    const mocks = saveMocks();
    setupLibrary(mocks);
    store.setState({ settingsRoute: "memory-tools" });
    await act(async () => render(<AssistantWorkspace />));
    const budget = screen.getByLabelText("记忆工具读取额度");
    fireEvent.change(budget, { target: { value: "9000" } });
    fireEvent.change(budget, { target: { value: "0" } });
    expect(budget.getAttribute("aria-invalid")).toBe("true");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "保存 Agent" })));
    expect(mocks.updateAgent).not.toHaveBeenCalled();
    expect(store.getState().pageEditor?.draft.p5_config.memory_read?.max_bytes).toBe(9000);
  });

  it("jumps to the memory library through shared draft-safe navigation", async () => {
    const mocks = saveMocks();
    setupLibrary(mocks);
    await act(async () => render(<AgentMaterials />));
    fireEvent.change(screen.getByLabelText("记忆工具读取额度"), { target: { value: "1500" } });
    fireEvent.click(screen.getByRole("button", { name: "管理记忆与来源" }));
    expect(store.getState().navigationConfirmOpen).toBe(true);
    act(() => store.getState().cancelPendingNavigation());
    expect(store.getState().pageEditor?.draft.p5_config.memory_read?.max_bytes).toBe(1500);
    expect(dirtyPages(store.getState().pageEditor)).toEqual(["memory-tools"]);
    fireEvent.click(screen.getByRole("button", { name: "管理记忆与来源" }));
    await act(async () => store.getState().confirmDiscardAndContinue());
    expect(store.getState().settingsRoute).toBe("long-memory");
    expect(mocks.updateAgent).not.toHaveBeenCalled();
    expect(mocks.updatePolicy).not.toHaveBeenCalled();
  });
});
