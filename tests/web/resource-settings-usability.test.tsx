// 网页记忆维护面板与记忆/知识工具设置的可用性回归：维护面板在正文区、空分区也能管理、
// 草稿/保存只走 long-memory 白名单、QQ 分区仍只对应绑定控制、三预设默认展开。
// 读取额度拆到独立的 memory-tools 草稿：维护保存与工具保存互不夹带，也移除误导的共享范围提示。
// 断言只使用 i18n 文案；所有写入走替身，不触网、不建业务数据。
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dirtyPages, newPageEditor } from "../../src/web/features/agents/page-drafts";
import { knowledgeReadDirty } from "../../src/web/features/knowledge/types";
import {
  KnowledgeToolSettings,
  MemoryToolSettings,
} from "../../src/web/screens/assistants/ResourceRules";
import { MemoryLibrary } from "../../src/web/screens/library/MemoryLibrary";
import { useSuperstringStore as store } from "../../src/web/store";
import { A, agent, B, persona, policy, setupLibrary } from "./helpers/library-fixture";

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
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /网页对话记忆/ })));
    expect(screen.getByLabelText("记忆整理提示词")).toBeTruthy();
    expect(screen.queryByLabelText("自动整理批次（留空关闭）")).toBeNull();
  });

  it("shows the new agent's maintenance values after switching agents", async () => {
    await act(async () => render(<MemoryLibrary />));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: /网页对话记忆/ })));
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
    fireEvent.click(screen.getByRole("button", { name: "前往模型服务" }));
    expect(store.getState().settingsRoute).toBe("models");
    // 跳转不隐式保存、不丢弃草稿。
    expect(store.getState().pageEditor?.draft.memory_consolidation_prompt).toBe("草稿");
    expect(dirtyPages(store.getState().pageEditor)).toEqual(["long-memory"]);
    expect(mocks.updateAgent).not.toHaveBeenCalled();
    expect(mocks.updatePolicy).not.toHaveBeenCalled();
  });

  it("keeps the allowance draft independent from maintenance discard and drops the shared-scope hint", async () => {
    const mocks = saveMocks();
    setupLibrary(mocks);
    // 记忆工具设置留下额度草稿：只改广泛档扫描上限，草稿标记 memory-tools。
    await act(async () => render(<MemoryToolSettings />));
    fireEvent.change(screen.getAllByLabelText("每次查询扫描候选上限")[2], {
      target: { value: "150" },
    });
    expect(
      store.getState().pageEditor?.draft.p5_config.retrieval_presets.broad.candidate_limit,
    ).toBe(150);
    cleanup();
    // 记忆维护：误导性的共享保存范围提示已移除。
    await act(async () => render(<MemoryLibrary />));
    expect(screen.queryByText(/保存记忆规则会同时提交/)).toBeNull();
    expect(screen.queryByText(/资料规则中还有未保存的工具额度修改/)).toBeNull();
    // 改维护字段后放弃：只还原 policy 与两条提示词，memory-tools 草稿保留。
    fireEvent.change(screen.getByLabelText("每隔多少轮整理"), { target: { value: "30" } });
    fireEvent.change(screen.getByLabelText("记忆整理提示词"), { target: { value: "保留事实" } });
    fireEvent.click(screen.getByRole("button", { name: "放弃修改" }));
    const editor = store.getState().pageEditor;
    expect(editor?.policyDraft?.every_turns).toBe(policy.every_turns);
    expect(editor?.draft.memory_consolidation_prompt).toBe(agent.memory_consolidation_prompt);
    expect(editor?.draft.p5_config.retrieval_presets.broad.candidate_limit).toBe(150);
    expect(dirtyPages(editor)).toEqual(["memory-tools"]);
    expect(mocks.updateAgent).not.toHaveBeenCalled();
    expect(mocks.updatePolicy).not.toHaveBeenCalled();
  });

  it("saving memory tools never submits maintenance, policy or other page drafts", async () => {
    const mocks = saveMocks();
    const client = setupLibrary({ ...mocks, saveAgentKnowledgeRead: vi.fn() });
    // 记忆工具设置：额度草稿属于 memory-tools。
    await act(async () => render(<MemoryToolSettings />));
    fireEvent.change(screen.getByLabelText("记忆工具额度模式"), { target: { value: "broad" } });
    fireEvent.change(screen.getAllByLabelText("每次查询扫描候选上限")[2], {
      target: { value: "150" },
    });
    cleanup();
    // 知识工具设置：独立 knowledgeReadEditor 草稿。
    await act(async () => render(<KnowledgeToolSettings />));
    fireEvent.click(screen.getByRole("checkbox", { name: "启用知识读取" }));
    expect(knowledgeReadDirty(store.getState().knowledgeReadEditor)).toBe(true);
    cleanup();
    // 另留维护与模型页草稿：memory-tools 显式保存不夹带它们。
    store.getState().patchPageAgent("long-memory", { memory_consolidation_prompt: "保留事实" });
    store.getState().patchPageAgent("models", { model_name: "draft-model" });
    await act(async () => render(<MemoryToolSettings />));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "保存记忆规则" })));
    // 只提交 memory-tools 白名单：不发送维护提示词、不碰 policy，也不触发知识读取保存。
    expect(mocks.updateAgent).toHaveBeenCalledTimes(1);
    const [savedId, savedBody] = mocks.updateAgent.mock.calls[0];
    expect(savedId).toBe(A);
    expect(Object.keys(savedBody).sort()).toEqual(MEMORY_TOOLS_PAYLOAD_KEYS);
    expect(savedBody).not.toHaveProperty("memory_consolidation_prompt");
    expect(mocks.updateAgent).toHaveBeenCalledWith(
      A,
      expect.objectContaining({
        p5_config: expect.objectContaining({
          retrieval_mode: "broad",
          retrieval_presets: expect.objectContaining({
            broad: expect.objectContaining({ candidate_limit: 150 }),
          }),
        }),
      }),
    );
    expect(mocks.updatePolicy).not.toHaveBeenCalled();
    expect(client.saveAgentKnowledgeRead).not.toHaveBeenCalled();
    expect(store.getState().knowledgeReadEditor?.draft.enabled).toBe(false);
    // 维护与模型页草稿保持独立：未随本次保存提交，仍留在草稿里。
    expect(store.getState().pageEditor?.draft.model_name).toBe("draft-model");
    expect(store.getState().pageEditor?.draft.memory_consolidation_prompt).toBe("保留事实");
    expect(dirtyPages(store.getState().pageEditor)).toEqual(["models", "long-memory"]);
  });
});

describe("agent retrieval presets", () => {
  it("expands all three presets by default and saves edits only through the whitelist", async () => {
    const mocks = saveMocks();
    setupLibrary(mocks);
    await act(async () => render(<MemoryToolSettings />));
    // 三项默认展开：三个额度字段直接可见，标题只剩档名，不再内嵌裸数字。
    expect(screen.getAllByLabelText("每次查询扫描候选上限")).toHaveLength(3);
    expect(screen.getByRole("button", { name: "保守" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "标准" })).toBeTruthy();
    const broadItem = screen
      .getByRole("button", { name: "广泛" })
      .closest("[data-slot=accordion-item]");
    expect(broadItem).not.toBeNull();
    expect(screen.queryByRole("button", { name: /·/ })).toBeNull();
    const scan = screen.getAllByLabelText("每次查询扫描候选上限") as HTMLInputElement[];
    const entries = screen.getAllByLabelText("每页最大返回项") as HTMLInputElement[];
    const budget = screen.getAllByLabelText(
      "每轮记忆工具结果总预算（UTF-8 字节）",
    ) as HTMLInputElement[];
    expect(scan.map((el) => el.value)).toEqual(["30", "60", "120"]);
    expect(entries.map((el) => el.value)).toEqual(["6", "10", "16"]);
    expect(budget.map((el) => el.value)).toEqual(["2048", "4096", "8192"]);
    // 只改广泛档：其他两档不受影响，草稿只标记 long-memory。
    const broadScan = within(broadItem as HTMLElement).getByLabelText(
      "每次查询扫描候选上限",
    ) as HTMLInputElement;
    expect([broadScan.min, broadScan.max]).toEqual(["1", "300"]);
    fireEvent.change(broadScan, { target: { value: "150" } });
    const presets = store.getState().pageEditor?.draft.p5_config.retrieval_presets;
    expect(presets?.broad.candidate_limit).toBe(150);
    expect(presets?.conservative.candidate_limit).toBe(30);
    expect(presets?.standard.candidate_limit).toBe(60);
    expect(dirtyPages(store.getState().pageEditor)).toEqual(["memory-tools"]);
    expect(mocks.updateAgent).not.toHaveBeenCalled();
    expect(mocks.updatePolicy).not.toHaveBeenCalled();
    // 保存只写 memory-tools 的白名单，不触碰策略。
    await act(async () => {
      expect(await store.getState().saveSettingsPage("memory-tools")).toBe(true);
    });
    expect(mocks.updateAgent).toHaveBeenCalledTimes(1);
    const [savedId, savedBody] = mocks.updateAgent.mock.calls[0];
    expect(savedId).toBe(A);
    expect(Object.keys(savedBody).sort()).toEqual(MEMORY_TOOLS_PAYLOAD_KEYS);
    expect(mocks.updateAgent).toHaveBeenCalledWith(
      A,
      expect.objectContaining({
        p5_config: expect.objectContaining({
          retrieval_presets: expect.objectContaining({
            broad: expect.objectContaining({ candidate_limit: 150 }),
            conservative: expect.objectContaining({ candidate_limit: 30, max_entries: 6 }),
            standard: expect.objectContaining({ candidate_limit: 60 }),
          }),
        }),
      }),
    );
    expect(mocks.updatePolicy).not.toHaveBeenCalled();
  });

  it("jumps to the memory library through the shared draft-safe navigation", async () => {
    const mocks = saveMocks();
    setupLibrary(mocks);
    await act(async () => render(<MemoryToolSettings />));
    fireEvent.change(screen.getAllByLabelText("每次查询扫描候选上限")[2], {
      target: { value: "150" },
    });
    fireEvent.click(screen.getByRole("button", { name: "前往长期记忆" }));
    expect(store.getState().settingsRoute).toBe("long-memory");
    // 跳转保留草稿，不隐式保存。
    expect(
      store.getState().pageEditor?.draft.p5_config.retrieval_presets.broad.candidate_limit,
    ).toBe(150);
    expect(dirtyPages(store.getState().pageEditor)).toEqual(["memory-tools"]);
    expect(mocks.updateAgent).not.toHaveBeenCalled();
    expect(mocks.updatePolicy).not.toHaveBeenCalled();
  });
});
