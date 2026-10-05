// 系统能力·资源（记忆工具/知识工具）的页面所有权专测。
// memory-tools 只拥有 retrieval_mode/retrieval_presets；long-memory 只拥有整理提示词与策略，
// 不再拥有读取。覆盖：一侧保存绝不夹带另一侧、saveAll/基线接受、页面级放弃、
// policy 部分成功、非法/冲突/切换助手的草稿安全，以及两个导出的渲染、加载、错误与跳转。
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentKnowledgeReadUpdate } from "../../src/shared/contracts/knowledge";
import {
  dirtyPages,
  newPageEditor,
  pageAgentPayload,
} from "../../src/web/features/agents/page-drafts";
import zh from "../../src/web/i18n/locales/zh-CN/translation.json";
import {
  KnowledgeToolSettings,
  MemoryToolSettings,
} from "../../src/web/screens/assistants/ResourceRules";
import { MemoryLibrary } from "../../src/web/screens/library/MemoryLibrary";
import { useSuperstringStore as store } from "../../src/web/store";
import { A, agent, B, persona, policy, setupLibrary } from "./helpers/library-fixture";

const zhText = zh as Record<string, string>;
/** 本地键可能晚于 locales 文件落地：缺失时 i18next 原样返回 key。 */
const label = (key: string) => zhText[key] ?? key;

const LONG_MEMORY_KEYS = [
  "expected_version",
  "memory_consolidation_additional_instructions",
  "memory_consolidation_prompt",
];
const MEMORY_TOOLS_KEYS = ["expected_version", "p5_config"];

/** 可累积的替身：每次 updateAgent 合并载荷并推进 config_version，模拟服务端基线。 */
function toolMocks() {
  let persisted = structuredClone(agent);
  return {
    updateAgent: vi.fn(async (id: string, body: Record<string, unknown>) => {
      const patch = { ...body };
      delete patch.expected_version;
      persisted = {
        ...persisted,
        ...patch,
        config_version: persisted.config_version + 1,
      } as typeof persisted;
      return { ...persisted, id };
    }),
    updatePolicy: vi.fn(async (_id: string, body: Record<string, unknown>) => ({
      auto_enabled: body.auto_enabled as boolean,
      every_turns: body.every_turns as number,
      target_chars: body.target_chars as number,
      version: (body.expected_version as number) + 1,
    })),
  };
}

const broadPreset = (limit: number) => ({
  ...agent.p5_config.retrieval_presets,
  broad: { ...agent.p5_config.retrieval_presets.broad, candidate_limit: limit },
});

beforeEach(() => {
  setupLibrary();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("memory-tools 与 long-memory 的字段所有权", () => {
  it("legacy 全量模式未改档时保留 full，显式切换才归一为 broad，并保留相关性指令", () => {
    const editor = newPageEditor(
      {
        ...agent,
        p5_config: { ...agent.p5_config, retrieval_mode: "full_body" },
      },
      persona,
      policy,
    );
    editor.draft.p5_config = {
      ...editor.draft.p5_config,
      retrieval_presets: broadPreset(150),
    };
    const payload = pageAgentPayload(editor, "memory-tools").p5_config;
    if (!payload) throw new Error("Missing memory-tools payload");
    // 未主动改档：存量 full 原样保留（此前会归一为 broad，现只随显式切换归一）。
    expect(payload.retrieval_mode).toBe("full_body");
    expect(payload.retrieval_presets.broad.candidate_limit).toBe(150);
    // 主动切到普通档：此时才按用户选择写 broad。
    const switched = newPageEditor(
      { ...agent, p5_config: { ...agent.p5_config, retrieval_mode: "full_body" } },
      persona,
      policy,
    );
    switched.draft.p5_config = { ...switched.draft.p5_config, retrieval_mode: "broad" };
    expect(pageAgentPayload(switched, "memory-tools").p5_config?.retrieval_mode).toBe("broad");
    expect(payload.retrieval_presets.broad.relevance_instruction).toBe(
      agent.p5_config.retrieval_presets.broad.relevance_instruction,
    );
    // 维护页载荷不含 p5_config：不再有机会改写读取字段。
    expect(pageAgentPayload(editor, "long-memory")).not.toHaveProperty("p5_config");
  });

  it("一侧保存绝不夹带另一侧字段，接受基线后各自只留自己的草稿", async () => {
    const mocks = toolMocks();
    setupLibrary(mocks);
    store.getState().patchPageAgent("memory-tools", {
      p5_config: {
        ...agent.p5_config,
        retrieval_mode: "broad",
        retrieval_presets: broadPreset(150),
      },
    });
    store.getState().patchPageAgent("long-memory", {
      memory_consolidation_prompt: "整理提示",
      memory_consolidation_additional_instructions: "附加",
    });
    store.getState().patchPagePolicy({ every_turns: 40 });
    store.getState().patchPageAgent("models", { model_name: "draft-model" });
    expect(dirtyPages(store.getState().pageEditor)).toEqual([
      "models",
      "long-memory",
      "memory-tools",
    ]);

    // memory-tools 保存：载荷只有 p5 读取字段；策略、整理与模型草稿一并不动。
    await act(async () => {
      expect(await store.getState().saveSettingsPage("memory-tools")).toBe(true);
    });
    expect(mocks.updateAgent).toHaveBeenCalledTimes(1);
    const [memoryId, memoryBody] = mocks.updateAgent.mock.calls[0];
    expect(memoryId).toBe(A);
    expect(Object.keys(memoryBody).sort()).toEqual(MEMORY_TOOLS_KEYS);
    expect(mocks.updatePolicy).not.toHaveBeenCalled();
    expect(store.getState().pageEditor?.draft.memory_consolidation_prompt).toBe("整理提示");
    expect(store.getState().pageEditor?.draft.model_name).toBe("draft-model");
    expect(store.getState().pageEditor?.policyDraft?.every_turns).toBe(40);
    expect(dirtyPages(store.getState().pageEditor)).toEqual(["models", "long-memory"]);

    // long-memory 保存：载荷不含 p5_config，策略独立提交；读取草稿与基线保持一致。
    await act(async () => {
      expect(await store.getState().saveSettingsPage("long-memory")).toBe(true);
    });
    expect(mocks.updateAgent).toHaveBeenCalledTimes(2);
    const [maintenanceId, maintenanceBody] = mocks.updateAgent.mock.calls[1];
    expect(maintenanceId).toBe(A);
    expect(maintenanceBody.expected_version).toBe(2);
    expect(Object.keys(maintenanceBody).sort()).toEqual(LONG_MEMORY_KEYS);
    expect(mocks.updatePolicy).toHaveBeenCalledTimes(1);
    expect(mocks.updatePolicy).toHaveBeenCalledWith(A, {
      auto_enabled: policy.auto_enabled,
      every_turns: 40,
      target_chars: policy.target_chars,
      expected_version: policy.version,
    });
    expect(dirtyPages(store.getState().pageEditor)).toEqual(["models"]);
    expect(store.getState().pageEditor?.draft.p5_config.retrieval_mode).toBe("broad");
  });

  it("saveAll 提交两页并按各自基线推进版本", async () => {
    const mocks = toolMocks();
    setupLibrary(mocks);
    store.getState().patchPageAgent("memory-tools", {
      p5_config: { ...agent.p5_config, retrieval_mode: "conservative" },
    });
    store.getState().patchPageAgent("long-memory", { memory_consolidation_prompt: "新提示" });
    store.getState().patchPagePolicy({ every_turns: 30 });
    await act(async () => {
      expect(await store.getState().saveAllSettingsPages()).toBe(true);
    });
    expect(mocks.updateAgent).toHaveBeenCalledTimes(2);
    // 顺序按白名单：long-memory 在 memory-tools 之前，后者使用推进后的版本号。
    const [first, second] = mocks.updateAgent.mock.calls;
    expect(Object.keys(first[1]).sort()).toEqual(LONG_MEMORY_KEYS);
    expect(second[1].expected_version).toBe(2);
    expect(Object.keys(second[1]).sort()).toEqual(MEMORY_TOOLS_KEYS);
    expect(mocks.updatePolicy).toHaveBeenCalledTimes(1);
    expect(dirtyPages(store.getState().pageEditor)).toEqual([]);
    expect(store.getState().pageEditor?.agent.config_version).toBe(3);
    expect(store.getState().pageEditor?.draft.p5_config.retrieval_mode).toBe("conservative");
  });

  it("页面级放弃只还原 memory-tools 字段，其他页草稿保留", async () => {
    const mocks = toolMocks();
    setupLibrary(mocks);
    store.getState().patchPageAgent("memory-tools", {
      p5_config: {
        ...agent.p5_config,
        retrieval_mode: "broad",
        retrieval_presets: broadPreset(150),
      },
    });
    store.getState().patchPageAgent("long-memory", { memory_consolidation_prompt: "保留" });
    store.getState().patchPageAgent("models", { model_name: "draft-model" });
    act(() => store.getState().discardSettingsPages("memory-tools"));
    const editor = store.getState().pageEditor;
    expect(editor?.draft.p5_config.retrieval_mode).toBe(agent.p5_config.retrieval_mode);
    expect(editor?.draft.p5_config.retrieval_presets.broad.candidate_limit).toBe(
      agent.p5_config.retrieval_presets.broad.candidate_limit,
    );
    expect(editor?.draft.memory_consolidation_prompt).toBe("保留");
    expect(editor?.draft.model_name).toBe("draft-model");
    expect(dirtyPages(editor)).toEqual(["models", "long-memory"]);
    expect(mocks.updateAgent).not.toHaveBeenCalled();
    // 无参放弃仍然整份还原。
    act(() => store.getState().discardSettingsPages());
    expect(dirtyPages(store.getState().pageEditor)).toEqual([]);
    // 传页放弃身份页只还原身份 persona 字段，表达页草稿与其他页保持。
    act(() => store.getState().patchPagePersona("identity", { core_identity: "draft-identity" }));
    act(() =>
      store.getState().patchPagePersona("expression", { communication_style: "draft-style" }),
    );
    expect(dirtyPages(store.getState().pageEditor)).toEqual(["identity", "expression"]);
    act(() => store.getState().discardSettingsPages("identity"));
    expect(store.getState().pageEditor?.personaDraft.core_identity).toBe(persona.core_identity);
    expect(store.getState().pageEditor?.personaDraft.communication_style).toBe("draft-style");
    expect(dirtyPages(store.getState().pageEditor)).toEqual(["expression"]);
    expect(mocks.updateAgent).not.toHaveBeenCalled();
  });

  it("policy 部分成功时读取草稿不受影响，重试不重复已成功的整理请求", async () => {
    const mocks = toolMocks();
    setupLibrary(mocks);
    store.getState().patchPageAgent("memory-tools", {
      p5_config: { ...agent.p5_config, retrieval_mode: "broad" },
    });
    store.getState().patchPageAgent("long-memory", { memory_consolidation_prompt: "new rule" });
    store.getState().patchPagePolicy({ every_turns: 25 });
    mocks.updatePolicy.mockRejectedValueOnce(new Error("policy failed"));
    await act(async () => {
      expect(await store.getState().saveSettingsPage("long-memory")).toBe(false);
    });
    expect(store.getState().error).toBeTruthy();
    expect(store.getState().feedback).toContain("保存未全部完成");
    expect(store.getState().pageEditor?.draft.memory_consolidation_prompt).toBe("new rule");
    expect(store.getState().pageEditor?.policyDraft?.every_turns).toBe(25);
    expect(store.getState().pageEditor?.draft.p5_config.retrieval_mode).toBe("broad");
    expect(dirtyPages(store.getState().pageEditor)).toEqual(["long-memory", "memory-tools"]);
    await act(async () => {
      expect(await store.getState().saveSettingsPage("long-memory")).toBe(true);
    });
    expect(mocks.updateAgent).toHaveBeenCalledTimes(1);
    expect(mocks.updatePolicy).toHaveBeenCalledTimes(2);
    expect(dirtyPages(store.getState().pageEditor)).toEqual(["memory-tools"]);
  });

  it("非法字段被丢弃，冲突与切换助手都不丢 memory-tools 草稿", async () => {
    const mocks = toolMocks();
    setupLibrary(mocks);
    store.getState().patchPageAgent("memory-tools", {
      model_name: "forbidden",
      memory_consolidation_prompt: "forbidden",
    });
    expect(store.getState().pageEditor?.draft.model_name).toBe(agent.model_name);
    expect(store.getState().pageEditor?.draft.memory_consolidation_prompt).toBe(
      agent.memory_consolidation_prompt,
    );
    store.getState().patchPageAgent("memory-tools", {
      p5_config: { ...agent.p5_config, retrieval_mode: "broad" },
    });
    // 冲突：保存失败保留草稿并给出错误。
    mocks.updateAgent.mockRejectedValueOnce(new Error("conflict"));
    await act(async () => {
      expect(await store.getState().saveSettingsPage("memory-tools")).toBe(false);
    });
    expect(store.getState().error).toBeTruthy();
    expect(store.getState().pageEditor?.draft.p5_config.retrieval_mode).toBe("broad");
    expect(dirtyPages(store.getState().pageEditor)).toEqual(["memory-tools"]);
    // 切换助手：守卫先按当前助手版本提交 memory-tools 载荷，再进入新会话。
    store.getState().requestAgentNavigation(B);
    expect(store.getState().editorAgentId).toBe(A);
    await act(async () => {
      await store.getState().confirmSaveAndContinue();
    });
    expect(store.getState().editorAgentId).toBe(B);
    const lastCall = mocks.updateAgent.mock.calls.at(-1);
    if (!lastCall) throw new Error("Missing save call");
    const [savedId, savedBody] = lastCall;
    expect(savedId).toBe(A);
    expect(Object.keys(savedBody).sort()).toEqual(MEMORY_TOOLS_KEYS);
    expect((savedBody.p5_config as { retrieval_mode: string }).retrieval_mode).toBe("broad");
    expect(store.getState().pageEditor?.agent.id).toBe(B);
  });
});

describe("两个导出的渲染、加载、错误与内容直达", () => {
  it("缺少页面编辑器时显示加载而不是空白", async () => {
    setupLibrary();
    store.setState({ pageEditor: null });
    await act(async () =>
      render(
        <>
          <MemoryToolSettings />
          <KnowledgeToolSettings />
        </>,
      ),
    );
    expect(screen.getAllByText("正在加载…")).toHaveLength(2);
  });

  it("记忆工具设置提供模式/额度、显式保存丢弃、错误与长期记忆直达", async () => {
    const mocks = toolMocks();
    setupLibrary(mocks);
    await act(async () => render(<MemoryToolSettings />));
    const mode = screen.getByLabelText("记忆工具额度模式") as HTMLSelectElement;
    expect(mode.value).toBe("standard");
    expect(screen.getAllByLabelText("每次查询扫描候选上限")).toHaveLength(3);
    const save = screen.getByRole("button", { name: "保存记忆规则" }) as HTMLButtonElement;
    const discard = screen.getByRole("button", { name: "放弃修改" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(discard.disabled).toBe(true);
    fireEvent.change(mode, { target: { value: "broad" } });
    expect(save.disabled).toBe(false);
    fireEvent.click(discard);
    expect(store.getState().pageEditor?.draft.p5_config.retrieval_mode).toBe("standard");
    // 保存失败：错误就地可见，草稿保留。
    fireEvent.change(mode, { target: { value: "broad" } });
    mocks.updateAgent.mockRejectedValueOnce(new Error("conflict"));
    await act(async () => fireEvent.click(save));
    expect(screen.getByRole("alert").textContent).toContain("conflict");
    expect(store.getState().pageEditor?.draft.p5_config.retrieval_mode).toBe("broad");
    // 保存成功接受基线；跳转长期记忆保留草稿、不隐式保存。
    await act(async () => fireEvent.click(save));
    expect(dirtyPages(store.getState().pageEditor)).toEqual([]);
    fireEvent.change(mode, { target: { value: "off" } });
    fireEvent.click(screen.getByRole("button", { name: "前往长期记忆" }));
    expect(store.getState().settingsRoute).toBe("long-memory");
    expect(store.getState().pageEditor?.draft.p5_config.retrieval_mode).toBe("off");
  });

  it("知识工具设置保持独立 CAS 保存并提供知识文档直达", async () => {
    const client = setupLibrary({
      // 替身回写实际提交的 config 并推进修订，让保存接受后的基线与真实服务端一致。
      saveAgentKnowledgeRead: vi.fn(async (_id: string, body: AgentKnowledgeReadUpdate) => ({
        revision: body.expected_revision + 1,
        config: structuredClone(body.config),
      })),
    });
    await act(async () => render(<KnowledgeToolSettings />));
    const checkbox = screen.getByRole("checkbox", { name: "启用知识读取" });
    expect(checkbox.getAttribute("data-state")).toBe("checked");
    const save = screen.getByRole("button", { name: "保存知识规则" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(checkbox);
    expect(save.disabled).toBe(false);
    await act(async () => fireEvent.click(save));
    expect(client.saveAgentKnowledgeRead).toHaveBeenCalledWith(A, {
      expected_revision: 1,
      config: { enabled: false, context_budget: null, scope: "all", document_ids: [] },
    });
    // 保存接受的是提交的关闭状态：基线与草稿都前进到 revision 2。
    expect(store.getState().knowledgeReadEditor?.source.config.enabled).toBe(false);
    expect(store.getState().knowledgeReadEditor?.source.revision).toBe(2);
    expect(store.getState().knowledgeReadEditor?.draft.enabled).toBe(false);
    // 内容直达：文档库跳转保留草稿，不隐式保存。
    // 保存后重新取节点：确认中间草稿态，再验证跳转不丢弃它。
    fireEvent.click(screen.getByRole("checkbox", { name: "启用知识读取" }));
    expect(store.getState().knowledgeReadEditor?.draft.enabled).toBe(true);
    fireEvent.click(
      screen.getByRole("button", { name: label("capabilities.resources.openKnowledgeDocuments") }),
    );
    expect(store.getState().settingsRoute).toBe("knowledge-config");
    expect(store.getState().knowledgeReadEditor?.draft.enabled).toBe(true);
    expect(client.saveAgentKnowledgeRead).toHaveBeenCalledTimes(1);
  });

  it("知识首次加载失败给出重试入口，重试成功后可编辑", async () => {
    const client = setupLibrary({
      getAgentKnowledgeRead: vi
        .fn()
        .mockRejectedValueOnce(new Error("知识读取加载失败"))
        .mockResolvedValue({
          revision: 1,
          config: { enabled: true, context_budget: null, scope: "all", document_ids: [] },
        }),
    });
    await act(async () => render(<KnowledgeToolSettings />));
    expect(screen.queryByRole("checkbox", { name: "启用知识读取" })).toBeNull();
    expect(screen.queryByText("正在加载…")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("知识读取加载失败");
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: label("library.refresh.grants") })),
    );
    expect(client.getAgentKnowledgeRead).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("checkbox", { name: "启用知识读取" }).getAttribute("data-state")).toBe(
      "checked",
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("资料库记忆区的直达入口跳转到 memory-tools", async () => {
    const mocks = toolMocks();
    setupLibrary(mocks);
    act(() =>
      store.getState().patchPageAgent("memory-tools", {
        p5_config: { ...agent.p5_config, retrieval_mode: "broad" },
      }),
    );
    await act(async () => render(<MemoryLibrary />));
    fireEvent.click(
      screen.getByRole("button", { name: label("capabilities.resources.openMemoryTools") }),
    );
    expect(store.getState().settingsRoute).toBe("memory-tools");
    // 内容区入口不隐式保存、不丢弃已有草稿。
    expect(store.getState().pageEditor?.draft.p5_config.retrieval_mode).toBe("broad");
    expect(dirtyPages(store.getState().pageEditor)).toEqual(["memory-tools"]);
    expect(mocks.updateAgent).not.toHaveBeenCalled();
  });
});

describe("保存基线显式刷新", () => {
  it("memory-tools 冲突后刷新基线，保稿且仅用新版本保存 memory 字段", async () => {
    let persisted = structuredClone(agent);
    const getAgent = vi.fn(async (id: string) => ({ ...structuredClone(persisted), id }));
    const updateAgent = vi.fn(async (id: string, body: Record<string, unknown>) => {
      if (body.expected_version !== persisted.config_version) {
        throw new Error("Agent config version 409");
      }
      const patch = { ...body };
      delete patch.expected_version;
      persisted = {
        ...persisted,
        ...patch,
        config_version: persisted.config_version + 1,
      } as typeof persisted;
      return { ...structuredClone(persisted), id };
    });
    setupLibrary({ getAgent, updateAgent });
    // 其他写者先推进版本：旧基线的保存必然冲突，显式刷新后才能继续。
    persisted = { ...persisted, config_version: 4, name: "Agent A remote" };
    act(() =>
      store.getState().patchPageAgent("memory-tools", {
        p5_config: { ...agent.p5_config, retrieval_mode: "broad" },
      }),
    );
    act(() =>
      store.getState().patchPageAgent("long-memory", { memory_consolidation_prompt: "保留整理" }),
    );
    act(() => store.getState().patchPageAgent("models", { model_name: "draft-model" }));
    await act(async () => {
      expect(await store.getState().saveSettingsPage("memory-tools")).toBe(false);
    });
    expect(store.getState().error).toBeTruthy();
    expect(updateAgent).toHaveBeenCalledTimes(1);
    await act(async () => {
      expect(await store.getState().refreshSettingsAgent()).toBe(true);
    });
    expect(getAgent).toHaveBeenCalledWith(A);
    // 刷新只读：不自动重试保存。
    expect(updateAgent).toHaveBeenCalledTimes(1);
    let editor = store.getState().pageEditor;
    expect(editor?.agent.config_version).toBe(4);
    expect(editor?.draft.name).toBe("Agent A remote");
    expect(editor?.draft.p5_config.retrieval_mode).toBe("broad");
    expect(editor?.draft.memory_consolidation_prompt).toBe("保留整理");
    expect(editor?.draft.model_name).toBe("draft-model");
    expect(editor?.policyDraft?.every_turns).toBe(policy.every_turns);
    expect(dirtyPages(editor)).toEqual(["models", "long-memory", "memory-tools"]);
    await act(async () => {
      expect(await store.getState().saveSettingsPage("memory-tools")).toBe(true);
    });
    const lastCall = updateAgent.mock.calls.at(-1);
    if (!lastCall) throw new Error("Missing save call");
    expect(lastCall[0]).toBe(A);
    expect(lastCall[1].expected_version).toBe(4);
    expect(Object.keys(lastCall[1]).sort()).toEqual(["expected_version", "p5_config"]);
    editor = store.getState().pageEditor;
    expect(editor?.draft.p5_config.retrieval_mode).toBe("broad");
    expect(dirtyPages(editor)).toEqual(["models", "long-memory"]);
  });

  it("刷新失败保留原基线与草稿；迟到响应不覆盖已切换的助手", async () => {
    const getAgent = vi.fn(async (id: string) => ({ ...agent, id }));
    setupLibrary({ getAgent });
    act(() =>
      store.getState().patchPageAgent("memory-tools", {
        p5_config: { ...agent.p5_config, retrieval_mode: "broad" },
      }),
    );
    getAgent.mockRejectedValueOnce(new Error("刷新失败"));
    await act(async () => {
      expect(await store.getState().refreshSettingsAgent()).toBe(false);
    });
    expect(store.getState().error).toContain("刷新失败");
    let editor = store.getState().pageEditor;
    expect(editor?.agent.config_version).toBe(agent.config_version);
    expect(editor?.draft.p5_config.retrieval_mode).toBe("broad");
    expect(editor?.draft.name).toBe(agent.name);
    // 迟到：响应返回时编辑器已换成另一个助手，不允许覆盖。
    let resolveFresh!: (value: typeof agent) => void;
    getAgent.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFresh = resolve;
        }),
    );
    const pending = store.getState().refreshSettingsAgent();
    store.setState({
      pageEditor: newPageEditor({ ...agent, id: B, name: "Agent B" }, persona, policy),
      editorAgentId: B,
      error: null,
    });
    await act(async () => {
      resolveFresh({ ...agent, config_version: 9, name: "Agent A remote" });
      expect(await pending).toBe(false);
    });
    editor = store.getState().pageEditor;
    expect(editor?.agent.id).toBe(B);
    expect(editor?.agent.config_version).toBe(agent.config_version);
    expect(editor?.agent.name).toBe("Agent B");
    expect(store.getState().error).toBeNull();
    // 被换掉的那次刷新不再触碰状态；editorLoading 归替换它的编辑器流程。
    expect(store.getState().editorLoading).toBe(true);
    store.setState({ editorLoading: false });
  });

  it("保存中拒绝刷新且不发起读取", async () => {
    const getAgent = vi.fn(async (id: string) => ({ ...agent, id }));
    setupLibrary({ getAgent });
    store.setState({ settingsSaving: true });
    await act(async () => {
      expect(await store.getState().refreshSettingsAgent()).toBe(false);
    });
    expect(getAgent).not.toHaveBeenCalled();
    store.setState({ settingsSaving: false });
  });

  it("目录批次输入生命周期：null→ready、跨 Agent、刷新基线、放弃清错、非法不拦普通档保存", async () => {
    const fullAgent = {
      ...agent,
      p5_config: {
        ...agent.p5_config,
        retrieval_mode: "full_catalog" as const,
        max_catalog_batches: 17,
        catalog_batch_size: 23,
      },
    };
    let persisted = structuredClone(fullAgent);
    const updateAgent = vi.fn(async (_id: string, body: Record<string, unknown>) => {
      const patch = { ...body };
      delete patch.expected_version;
      persisted = { ...persisted, ...patch, config_version: persisted.config_version + 1 };
      return { ...persisted, id: _id };
    });
    setupLibrary({
      getAgent: vi.fn(async (id: string) => ({ ...persisted, id })),
      listAgents: vi.fn(async () => [fullAgent, { ...fullAgent, id: B, name: "Agent B" }]),
      updateAgent,
    } as never);
    // null→ready：编辑器未就绪时只有加载态，就绪后输入按存量值出现。
    store.setState({ pageEditor: null });
    await act(async () => render(<MemoryToolSettings />));
    expect(screen.getByText("正在加载…")).toBeTruthy();
    await act(async () => store.getState().editAgent(A));
    expect((screen.getByLabelText("最多目录批次") as HTMLInputElement).value).toBe("17");
    expect((screen.getByLabelText("每批目录条数") as HTMLInputElement).value).toBe("23");

    // 非法原文：alert + 拦保存 + 不写草稿。
    const batches = screen.getByLabelText("最多目录批次") as HTMLInputElement;
    const save = () => screen.getByRole("button", { name: "保存记忆规则" }) as HTMLButtonElement;
    fireEvent.change(batches, { target: { value: "" } });
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(save().disabled).toBe(true);
    expect(store.getState().pageEditor?.draft.p5_config.max_catalog_batches).toBe(17);

    // invalid-only 也能放弃清错：放弃按钮在非 dirty 但 invalid 时可用，点击后错误消失。
    const discard = () => screen.getByRole("button", { name: "放弃修改" }) as HTMLButtonElement;
    expect(discard().disabled).toBe(false);
    await act(async () => fireEvent.click(discard()));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(save().disabled).toBe(true);

    // 跨 Agent：切到 B（同 full 配置，值不同）→ 输入按 B 的存量值显示。
    await act(async () => store.getState().editAgent(B));
    const bBatches = screen.getByLabelText("最多目录批次") as HTMLInputElement;
    expect(bBatches.value).toBe("17");

    // 刷新基线：未改字段跟随新基线、已改草稿保留（既有合并语义）。这里无草稿，刷新后原文仍是基线值。
    await act(async () => void store.getState().refreshSettingsAgent());
    const afterRefresh = screen.getByLabelText("最多目录批次") as HTMLInputElement;
    expect(afterRefresh.value).toBe("17");
    expect(store.getState().pageEditor?.draft.p5_config.max_catalog_batches).toBe(17);
    // 已改草稿（40）时刷新：草稿保留（不丢用户输入），原文与草稿一致不回跳。
    fireEvent.change(afterRefresh, { target: { value: "40" } });
    await act(async () => void store.getState().refreshSettingsAgent());
    const kept = screen.getByLabelText("最多目录批次") as HTMLInputElement;
    expect(kept.value).toBe("40");
    expect(store.getState().pageEditor?.draft.p5_config.max_catalog_batches).toBe(40);

    // full 非法 → 主动切普通档：输入消失，invalid 不拦普通档保存；批次数保留不丢。
    fireEvent.change(kept, { target: { value: "" } });
    expect(save().disabled).toBe(true);
    const mode = screen.getByLabelText("记忆工具额度模式") as HTMLSelectElement;
    fireEvent.change(mode, { target: { value: "standard" } });
    expect(screen.queryByLabelText("最多目录批次")).toBeNull();
    expect(save().disabled).toBe(false);
    expect(await store.getState().saveSettingsPage("memory-tools")).toBe(true);
    const savedCall = updateAgent.mock.calls.at(-1);
    if (!savedCall) throw new Error("Missing save call");
    expect(
      (savedCall[1] as { p5_config: { retrieval_mode: string; max_catalog_batches: number } })
        .p5_config,
    ).toMatchObject({ retrieval_mode: "standard", max_catalog_batches: 40 });
  });

  it("记忆面板提供刷新保存基线按钮；忙碌时输入、选项与保存按钮禁用", async () => {
    const getAgent = vi.fn(async (id: string) => ({ ...agent, id }));
    setupLibrary({ getAgent });
    await act(async () => render(<MemoryToolSettings />));
    const refreshName = label("capabilities.resources.refreshBaseline");
    const refresh = () => screen.getByRole("button", { name: refreshName }) as HTMLButtonElement;
    expect(refresh().disabled).toBe(false);
    await act(async () => fireEvent.click(refresh()));
    expect(getAgent).toHaveBeenCalledTimes(1);
    act(() => store.setState({ settingsSaving: true }));
    expect((screen.getByLabelText("记忆工具额度模式") as HTMLSelectElement).disabled).toBe(true);
    for (const input of screen.getAllByLabelText("每次查询扫描候选上限")) {
      expect((input as HTMLInputElement).disabled).toBe(true);
    }
    expect(refresh().disabled).toBe(true);
    expect(
      (screen.getByRole("button", { name: "保存记忆规则" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    act(() => store.setState({ settingsSaving: false }));
  });

  it("知识工具设置忙碌时禁用输入与选择", async () => {
    setupLibrary();
    await act(async () => render(<KnowledgeToolSettings />));
    const checkbox = () =>
      screen.getByRole("checkbox", { name: "启用知识读取" }) as HTMLButtonElement;
    expect(checkbox().disabled).toBe(false);
    act(() => store.setState({ editorLoading: true }));
    expect(checkbox().disabled).toBe(true);
    expect(
      (screen.getByLabelText(label("library.reading.scope")) as HTMLSelectElement).disabled,
    ).toBe(true);
    act(() => store.setState({ editorLoading: false, knowledgeReadLoading: true }));
    expect(checkbox().disabled).toBe(true);
    act(() => store.setState({ knowledgeReadLoading: false }));
  });
});
