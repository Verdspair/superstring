// 材料任务与记忆维护各自的草稿、CAS、错误、加载和导航契约。
// memory-tools 只编辑 memory_read，历史预设只作保真检查。
import { act, cleanup, fireEvent, render as renderView, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentKnowledgeReadUpdate } from "../../src/shared/contracts/knowledge";
import { DesignSystemProvider } from "../../src/web/design-system/Providers";
import {
  dirtyPages,
  newPageEditor,
  pageAgentPayload,
} from "../../src/web/features/agents/page-drafts";
import zh from "../../src/web/i18n/locales/zh-CN/translation.json";
import { AgentMaterials } from "../../src/web/screens/assistants/AgentMaterials";
import { AssistantWorkspace } from "../../src/web/screens/assistants/AssistantWorkspace";

import { MemoryLibrary } from "../../src/web/screens/library/MemoryLibrary";
import { useSuperstringStore as store } from "../../src/web/store";
import { A, agent, B, persona, policy, setupLibrary } from "./helpers/library-fixture";

const zhText = zh as Record<string, string>;

/** 显式 tooltip（保存按钮/字段帮助）必须挂在真实 DesignSystemProvider 下渲染。 */
const render = (...[ui, options]: Parameters<typeof renderView>) =>
  renderView(ui, { wrapper: DesignSystemProvider, ...options });
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

beforeEach(() => {
  setupLibrary();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("memory-tools 与 long-memory 的字段所有权", () => {
  it("legacy full mode and preset values remain unchanged when single allowance is saved", () => {
    const editor = newPageEditor(
      {
        ...agent,
        p5_config: { ...agent.p5_config, memory_read: undefined, retrieval_mode: "full_body" },
      },
      persona,
      policy,
    );
    editor.draft.p5_config = {
      ...editor.draft.p5_config,
      memory_read: { enabled: true, max_bytes: 1500 },
    };
    const payload = pageAgentPayload(editor, "memory-tools").p5_config;
    expect(payload?.retrieval_mode).toBe("full_body");
    expect(payload?.retrieval_presets).toEqual(agent.p5_config.retrieval_presets);
    expect(payload?.memory_read).toEqual({ enabled: true, max_bytes: 1500 });
    expect(pageAgentPayload(editor, "long-memory")).not.toHaveProperty("p5_config");
  });

  it("一侧保存绝不夹带另一侧字段，接受基线后各自只留自己的草稿", async () => {
    const mocks = toolMocks();
    setupLibrary(mocks);
    store.getState().patchPageAgent("memory-tools", {
      p5_config: {
        ...agent.p5_config,
        memory_read: { enabled: true, max_bytes: 1500 },
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
    expect(store.getState().pageEditor?.draft.p5_config.memory_read?.max_bytes).toBe(1500);
  });

  it("saveAll 提交两页并按各自基线推进版本", async () => {
    const mocks = toolMocks();
    setupLibrary(mocks);
    store.getState().patchPageAgent("memory-tools", {
      p5_config: { ...agent.p5_config, memory_read: { enabled: true, max_bytes: 1000 } },
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
    expect(store.getState().pageEditor?.draft.p5_config.memory_read?.max_bytes).toBe(1000);
  });

  it("页面级放弃只还原 memory-tools 字段，其他页草稿保留", async () => {
    const mocks = toolMocks();
    setupLibrary(mocks);
    store.getState().patchPageAgent("memory-tools", {
      p5_config: {
        ...agent.p5_config,
        memory_read: { enabled: true, max_bytes: 1500 },
      },
    });
    store.getState().patchPageAgent("long-memory", { memory_consolidation_prompt: "保留" });
    store.getState().patchPageAgent("models", { model_name: "draft-model" });
    act(() => store.getState().discardSettingsPages("memory-tools"));
    const editor = store.getState().pageEditor;
    expect(editor?.draft.p5_config.memory_read).toEqual(agent.p5_config.memory_read);

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
      p5_config: { ...agent.p5_config, memory_read: { enabled: true, max_bytes: 1500 } },
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
    expect(store.getState().pageEditor?.draft.p5_config.memory_read?.max_bytes).toBe(1500);
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
      p5_config: { ...agent.p5_config, memory_read: { enabled: true, max_bytes: 1500 } },
    });
    // 冲突：保存失败保留草稿并给出错误。
    mocks.updateAgent.mockRejectedValueOnce(new Error("conflict"));
    await act(async () => {
      expect(await store.getState().saveSettingsPage("memory-tools")).toBe(false);
    });
    expect(store.getState().error).toBeTruthy();
    expect(store.getState().pageEditor?.draft.p5_config.memory_read?.max_bytes).toBe(1500);
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
    expect(
      (savedBody.p5_config as { memory_read: { max_bytes: number } }).memory_read.max_bytes,
    ).toBe(1500);
    expect(store.getState().pageEditor?.agent.id).toBe(B);
  });
});

describe("材料读取规则的渲染、加载、错误与内容直达", () => {
  it("缺少页面编辑器时不暴露资料控制", async () => {
    setupLibrary();
    store.setState({ pageEditor: null });
    store.setState({ editorLoading: true, settingsRoute: "memory-tools" });
    await act(async () => render(<AssistantWorkspace />));
    expect(screen.getByRole("status").textContent).toContain("正在加载");
    expect(screen.queryByLabelText("记忆工具读取额度")).toBeNull();
    expect(screen.queryByLabelText("启用知识读取")).toBeNull();
  });
  it("同一材料任务提供记忆额度及已保存全局知识预算入口", async () => {
    const client = setupLibrary({ updateAgent: vi.fn() });
    await act(async () => render(<AgentMaterials />));
    expect(screen.queryByLabelText("记忆工具额度模式")).toBeNull();
    expect(screen.getByText(/已保存的全局读取额度：2048 Bytes/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("记忆工具读取额度"), { target: { value: "5000" } });
    expect(store.getState().pageEditor?.draft.p5_config.memory_read?.max_bytes).toBe(5000);
    expect(dirtyPages(store.getState().pageEditor)).toEqual(["memory-tools"]);
    fireEvent.click(screen.getByRole("button", { name: label("library.knowledge.global.budget") }));
    expect(store.getState().navigationConfirmOpen).toBe(true);
    act(() => store.getState().cancelPendingNavigation());
    expect(store.getState().pageEditor?.draft.p5_config.memory_read?.max_bytes).toBe(5000);
    fireEvent.click(screen.getByRole("button", { name: label("library.knowledge.global.budget") }));
    await act(async () => store.getState().confirmDiscardAndContinue());
    expect(store.getState().settingsRoute).toBe("context-allocation");
    expect(store.getState().contextAllocationTarget).toMatchObject({
      purpose: "reading",
      agentId: null,
      returnRoute: "knowledge-tools",
    });
    expect(client.updateAgent).not.toHaveBeenCalled();
  });
  it("材料任务保存、放弃、冲突及记忆直达保留草稿", async () => {
    const mocks = toolMocks();
    setupLibrary(mocks);
    store.setState({ settingsRoute: "memory-tools" });
    await act(async () => render(<AssistantWorkspace />));
    const bytes = () => screen.getByLabelText("记忆工具读取额度");
    const save = () => screen.getByRole("button", { name: "保存 Agent" }) as HTMLButtonElement;
    const discard = () => screen.getByRole("button", { name: "放弃修改" }) as HTMLButtonElement;
    expect(save().disabled).toBe(true);
    expect(discard().disabled).toBe(true);
    fireEvent.change(bytes(), { target: { value: "5000" } });
    expect(save().disabled).toBe(false);
    fireEvent.click(discard());
    expect(dirtyPages(store.getState().pageEditor)).toEqual([]);
    fireEvent.change(bytes(), { target: { value: "5000" } });
    mocks.updateAgent.mockRejectedValueOnce(new Error("conflict"));
    await act(async () => fireEvent.click(save()));
    expect(screen.getByRole("alert").textContent).toContain("conflict");
    expect(store.getState().pageEditor?.draft.p5_config.memory_read?.max_bytes).toBe(5000);
    await act(async () => fireEvent.click(save()));
    expect(dirtyPages(store.getState().pageEditor)).toEqual([]);
    fireEvent.change(bytes(), { target: { value: "4000" } });
    fireEvent.click(screen.getByRole("button", { name: "管理记忆与来源" }));
    expect(store.getState().navigationConfirmOpen).toBe(true);
    act(() => store.getState().cancelPendingNavigation());
    expect(store.getState().pageEditor?.draft.p5_config.memory_read?.max_bytes).toBe(4000);
    fireEvent.click(screen.getByRole("button", { name: "管理记忆与来源" }));
    await act(async () => store.getState().confirmSaveAndContinue());
    expect(store.getState().settingsRoute).toBe("long-memory");
    expect(store.getState().pageEditor?.draft.p5_config.memory_read?.max_bytes).toBe(4000);
  });
  it("知识读取经任务工具栏保存 CAS 并提供文档直达", async () => {
    const client = setupLibrary({
      saveAgentKnowledgeRead: vi.fn(async (_id: string, body: AgentKnowledgeReadUpdate) => ({
        revision: body.expected_revision + 1,
        config: structuredClone(body.config),
      })),
    });
    store.setState({ settingsRoute: "memory-tools" });
    await act(async () => render(<AssistantWorkspace />));
    fireEvent.click(screen.getByRole("checkbox", { name: "启用知识读取" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "保存 Agent" })));
    expect(client.saveAgentKnowledgeRead).toHaveBeenCalledWith(A, {
      expected_revision: 1,
      config: { enabled: false, context_budget: null, scope: "all", document_ids: [] },
    });
    expect(store.getState().knowledgeReadEditor?.source.revision).toBe(2);
    fireEvent.click(screen.getByRole("checkbox", { name: "启用知识读取" }));
    fireEvent.click(
      screen.getByRole("button", { name: label("capabilities.resources.openKnowledgeDocuments") }),
    );
    expect(store.getState().navigationConfirmOpen).toBe(true);
    expect(store.getState().knowledgeReadEditor?.draft.enabled).toBe(true);
    await act(async () => store.getState().confirmDiscardAndContinue());
    expect(store.getState().settingsRoute).toBe("knowledge-config");
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
    await act(async () => render(<AgentMaterials />));
    expect(screen.queryByRole("checkbox", { name: "启用知识读取" })).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("知识读取加载失败");
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: label("capabilities.retry") })),
    );
    expect(client.getAgentKnowledgeRead).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("checkbox", { name: "启用知识读取" }).getAttribute("data-state")).toBe(
      "checked",
    );
  });
  it("资料库记忆区直达入口保留材料草稿", async () => {
    const mocks = toolMocks();
    setupLibrary(mocks);
    act(() =>
      store.getState().patchPageAgent("memory-tools", {
        p5_config: { ...agent.p5_config, memory_read: { enabled: true, max_bytes: 1500 } },
      }),
    );
    await act(async () => render(<MemoryLibrary />));
    fireEvent.click(
      screen.getByRole("button", { name: label("capabilities.resources.openMemoryTools") }),
    );
    expect(store.getState().navigationConfirmOpen).toBe(true);
    act(() => store.getState().cancelPendingNavigation());
    expect(store.getState().pageEditor?.draft.p5_config.memory_read?.max_bytes).toBe(1500);
    expect(dirtyPages(store.getState().pageEditor)).toEqual(["memory-tools"]);
    fireEvent.click(
      screen.getByRole("button", { name: label("capabilities.resources.openMemoryTools") }),
    );
    await act(async () => store.getState().confirmSaveAndContinue());
    expect(store.getState().settingsRoute).toBe("memory-tools");
    expect(mocks.updateAgent).toHaveBeenCalledTimes(1);
  });
});

describe("mounted materials refresh lifecycle", () => {
  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    return { promise, resolve, reject };
  }

  async function mountedRefresh() {
    const fixture = setupLibrary();
    const client = {
      ...fixture,
      getAgent: vi.mocked(fixture.getAgent),
      getAgentKnowledgeRead: vi.mocked(fixture.getAgentKnowledgeRead),
      listAgentKnowledge: vi.mocked(fixture.listAgentKnowledge),
      getKnowledgeSettings: vi.mocked(fixture.getKnowledgeSettings),
    };
    store.setState({ settingsRoute: "memory-tools" });
    const view = render(<AssistantWorkspace />);
    await act(async () => {});
    const materials = screen.getByTestId("agent-materials");
    const input = screen.getByLabelText("记忆工具读取额度");
    fireEvent.change(input, { target: { value: "5000" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "启用知识读取" }));
    const editorToken = store.getState().pageEditor?.token;
    const knowledgeToken = store.getState().knowledgeReadEditor?.token;
    const baseline = store.getState().knowledgeReadEditor?.source;
    if (!baseline) throw new Error("Missing initial knowledge baseline");
    const agentRead = deferred<typeof agent>();
    const knowledgeRead = deferred<typeof baseline>();
    const documentsRead = deferred<Awaited<ReturnType<typeof client.listAgentKnowledge>>>();
    const settingsRead = deferred<Awaited<ReturnType<typeof client.getKnowledgeSettings>>>();
    const signals = {
      knowledge: [] as AbortSignal[],
      documents: [] as AbortSignal[],
      settings: [] as AbortSignal[],
    };
    client.getAgent.mockClear();
    client.getAgent.mockImplementation(() => agentRead.promise);
    client.getAgentKnowledgeRead.mockClear();
    client.getAgentKnowledgeRead.mockImplementation((_id: string, signal?: AbortSignal) => {
      if (signal) signals.knowledge.push(signal);
      return knowledgeRead.promise;
    });
    client.listAgentKnowledge.mockClear();
    client.listAgentKnowledge.mockImplementation((_id: string, signal?: AbortSignal) => {
      if (signal) signals.documents.push(signal);
      return documentsRead.promise;
    });
    client.getKnowledgeSettings.mockClear();
    client.getKnowledgeSettings.mockImplementation((signal?: AbortSignal) => {
      if (signal) signals.settings.push(signal);
      return settingsRead.promise;
    });
    await act(async () =>
      fireEvent.click(
        screen.getByRole("button", {
          name: label("capabilities.resources.refreshBaseline"),
        }),
      ),
    );
    return {
      client,
      view,
      materials,
      input,
      editorToken,
      knowledgeToken,
      baseline,
      agentRead,
      knowledgeRead,
      documentsRead,
      settingsRead,
      signals,
    };
  }

  it("keeps the mounted editor and drafts while the toolbar Agent GET is pending", async () => {
    const pending = await mountedRefresh();
    expect(pending.client.getAgent).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("agent-materials")).toBe(pending.materials);
    expect(screen.getByLabelText("记忆工具读取额度")).toBe(pending.input);
    expect((pending.input as HTMLInputElement).value).toBe("5000");
    expect((pending.input as HTMLInputElement).disabled).toBe(true);
    expect(store.getState().pageEditor?.token).toBe(pending.editorToken);
    expect(store.getState().knowledgeReadEditor?.draft.enabled).toBe(false);
    expect(pending.client.listAgentKnowledge).not.toHaveBeenCalled();
    await act(async () => pending.agentRead.resolve({ ...agent, config_version: 4 }));
    await act(async () => {
      pending.knowledgeRead.resolve({ ...pending.baseline, revision: 2 });
      pending.documentsRead.resolve([]);
      pending.settingsRead.resolve({
        revision: 2,
        auto_enabled: true,
        model_name: null,
        context_budget: 3000,
      });
    });
    expect(store.getState().knowledgeReadEditor?.token).toBe(pending.knowledgeToken);
  });

  it("starts one knowledge dependency set after the toolbar Agent GET resolves, without self-abort", async () => {
    const pending = await mountedRefresh();
    await act(async () => pending.agentRead.resolve({ ...agent, config_version: 4 }));
    expect(pending.client.getAgentKnowledgeRead).toHaveBeenCalledTimes(1);
    expect(pending.client.listAgentKnowledge).toHaveBeenCalledTimes(1);
    expect(pending.client.getKnowledgeSettings).toHaveBeenCalledTimes(1);
    expect(pending.signals.knowledge).toHaveLength(1);
    expect(pending.signals.documents).toHaveLength(1);
    expect(pending.signals.settings).toHaveLength(1);
    for (const signal of Object.values(pending.signals).flat()) expect(signal.aborted).toBe(false);
    expect(screen.getByTestId("agent-materials")).toBe(pending.materials);
    await act(async () => {
      pending.knowledgeRead.resolve({
        revision: 3,
        config: { ...pending.baseline.config, context_budget: 4096 },
      });
      pending.documentsRead.resolve([]);
      pending.settingsRead.resolve({
        revision: 2,
        auto_enabled: true,
        model_name: null,
        context_budget: 3000,
      });
    });
    expect(store.getState().knowledgeReadEditor).toMatchObject({
      token: pending.knowledgeToken,
      source: { revision: 3 },
      draft: { enabled: false, context_budget: 4096 },
    });
    expect(store.getState().pageEditor?.draft.p5_config.memory_read?.max_bytes).toBe(5000);
    expect(store.getState().knowledgeReadLoading).toBe(false);
  });

  it.each([A, B])(
    "a real editAgent(%s) pending replaces the refresh identity without releasing its busy lock",
    async (nextId) => {
      const pending = await mountedRefresh();
      const nextAgentRead = deferred<typeof agent>();
      pending.client.getAgent.mockImplementationOnce(() => nextAgentRead.promise);
      let editing!: Promise<boolean>;
      await act(async () => {
        editing = store.getState().editAgent(nextId);
      });
      expect(store.getState().editorBaselineRefresh).toBeNull();
      expect(store.getState().editorLoading).toBe(true);
      expect(screen.queryByTestId("agent-materials")).toBeNull();
      await act(async () => pending.agentRead.resolve({ ...agent, config_version: 9 }));
      expect(store.getState().editorLoading).toBe(true);
      expect(pending.client.listAgentKnowledge).not.toHaveBeenCalled();
      pending.client.getAgentKnowledgeRead.mockResolvedValue({
        revision: 4,
        config: pending.baseline.config,
      });
      pending.client.listAgentKnowledge.mockResolvedValue([]);
      pending.client.getKnowledgeSettings.mockResolvedValue({
        revision: 4,
        auto_enabled: true,
        model_name: null,
        context_budget: 3000,
      });
      await act(async () => {
        nextAgentRead.resolve({ ...agent, id: nextId, config_version: 4 });
        expect(await editing).toBe(true);
      });
      expect(store.getState().editorLoading).toBe(false);
      expect(store.getState().pageEditor?.agent).toMatchObject({ id: nextId, config_version: 4 });
      expect(store.getState().knowledgeReadEditor).toMatchObject({
        agentId: nextId,
        source: { revision: 4 },
      });
      expect(pending.client.listAgentKnowledge).toHaveBeenCalledTimes(1);
    },
  );

  it("hiding during the toolbar Agent GET invalidates its knowledge continuation without clearing drafts", async () => {
    let hidden = false;
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() =>
      hidden ? "hidden" : "visible",
    );
    const pending = await mountedRefresh();
    await act(async () => {
      hidden = true;
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await act(async () => pending.agentRead.resolve({ ...agent, config_version: 4 }));
    expect(pending.client.listAgentKnowledge).not.toHaveBeenCalled();
    expect(pending.client.getAgentKnowledgeRead).not.toHaveBeenCalled();
    expect(store.getState().editorLoading).toBe(false);
    expect(store.getState().pageEditor?.draft.p5_config.memory_read?.max_bytes).toBe(5000);
    expect(store.getState().knowledgeReadEditor?.draft.enabled).toBe(false);
    pending.client.getAgentKnowledgeRead.mockResolvedValue({
      revision: 2,
      config: pending.baseline.config,
    });
    pending.client.listAgentKnowledge.mockResolvedValue([]);
    pending.client.getKnowledgeSettings.mockResolvedValue({
      revision: 2,
      auto_enabled: true,
      model_name: null,
      context_budget: 3000,
    });
    await act(async () => {
      hidden = false;
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(pending.client.listAgentKnowledge).toHaveBeenCalledTimes(1);
    expect(store.getState().knowledgeReadEditor?.draft.enabled).toBe(false);
  });

  it("a hidden final materials consumer aborts all three pending knowledge dependencies", async () => {
    let hidden = false;
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() =>
      hidden ? "hidden" : "visible",
    );
    const pending = await mountedRefresh();
    await act(async () => pending.agentRead.resolve({ ...agent, config_version: 4 }));
    await vi.waitFor(() => expect(pending.signals.settings).toHaveLength(1));
    await act(async () => {
      hidden = true;
      document.dispatchEvent(new Event("visibilitychange"));
    });
    for (const signal of Object.values(pending.signals).flat()) expect(signal.aborted).toBe(true);
    await act(async () => {
      pending.knowledgeRead.resolve({ revision: 9, config: pending.baseline.config });
      pending.documentsRead.resolve([]);
      pending.settingsRead.resolve({
        revision: 9,
        auto_enabled: true,
        model_name: null,
        context_budget: 3000,
      });
    });
    expect(store.getState().knowledgeReadEditor?.source.revision).toBe(pending.baseline.revision);
    expect(store.getState().knowledgeReadEditor?.draft.enabled).toBe(false);
  });

  it("keeps the mounted materials task on Agent refresh failure and retries only after an explicit retry", async () => {
    const fixture = setupLibrary();
    const client = { ...fixture, getAgent: vi.mocked(fixture.getAgent) };
    store.setState({ settingsRoute: "memory-tools" });
    render(<AssistantWorkspace />);
    await act(async () => {});
    const materials = screen.getByTestId("agent-materials");
    const refresh = screen.getByRole("button", {
      name: label("capabilities.resources.refreshBaseline"),
    });
    const failed = deferred<typeof agent>();
    const recovered = deferred<typeof agent>();
    client.getAgent.mockClear();
    client.getAgent
      .mockImplementationOnce(() => failed.promise)
      .mockImplementationOnce(() => recovered.promise);
    await act(async () => fireEvent.click(refresh));
    await vi.waitFor(() => expect(client.getAgent).toHaveBeenCalledTimes(1));
    await act(async () => failed.reject(new Error("刷新失败")));
    await vi.waitFor(() => expect(store.getState().editorLoading).toBe(false));
    expect(screen.getByTestId("agent-materials")).toBe(materials);
    expect(screen.getByRole("alert").textContent).toContain("刷新失败");
    expect(client.getAgentKnowledgeRead).toHaveBeenCalledTimes(1);
    await act(async () => fireEvent.click(refresh));
    await vi.waitFor(() => expect(client.getAgent).toHaveBeenCalledTimes(2));
    expect(client.getAgentKnowledgeRead).toHaveBeenCalledTimes(1);
    await act(async () => recovered.resolve({ ...agent, config_version: 5 }));
    await vi.waitFor(() => expect(client.getAgentKnowledgeRead).toHaveBeenCalledTimes(2));
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
        p5_config: { ...agent.p5_config, memory_read: { enabled: true, max_bytes: 1500 } },
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
    expect(editor?.draft.p5_config.memory_read?.max_bytes).toBe(1500);
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
    expect(editor?.draft.p5_config.memory_read?.max_bytes).toBe(1500);
    expect(dirtyPages(editor)).toEqual(["models", "long-memory"]);
  });

  it("刷新失败保留原基线与草稿；迟到响应不覆盖已切换的助手", async () => {
    const getAgent = vi.fn(async (id: string) => ({ ...agent, id }));
    setupLibrary({ getAgent });
    act(() =>
      store.getState().patchPageAgent("memory-tools", {
        p5_config: { ...agent.p5_config, memory_read: { enabled: true, max_bytes: 1500 } },
      }),
    );
    getAgent.mockRejectedValueOnce(new Error("刷新失败"));
    await act(async () => {
      expect(await store.getState().refreshSettingsAgent()).toBe(false);
    });
    expect(store.getState().error).toContain("刷新失败");
    let editor = store.getState().pageEditor;
    expect(editor?.agent.config_version).toBe(agent.config_version);
    expect(editor?.draft.p5_config.memory_read?.max_bytes).toBe(1500);
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

  it("legacy full 配置不暴露旧控件，单一额度保存保留原字段", async () => {
    const legacy = {
      ...agent,
      p5_config: {
        ...agent.p5_config,
        memory_read: undefined,
        retrieval_mode: "full_catalog" as const,
        max_catalog_batches: 17,
        catalog_batch_size: 23,
      },
    };
    const updateAgent = vi.fn(async (id: string, body: Record<string, unknown>) => ({
      ...legacy,
      ...body,
      id,
      config_version: 2,
    }));
    setupLibrary({ updateAgent });
    store.setState({ pageEditor: newPageEditor(legacy, persona, policy) });
    await act(async () => render(<AgentMaterials />));
    for (const name of [
      "最多目录批次",
      "每批目录条数",
      "记忆工具额度模式",
      "每次查询候选条数上限",
      "每页最大返回项",
      label("library.memory.tools.retrieval.prompt"),
      label("library.memory.tools.relevance.instruction"),
    ])
      expect(screen.queryByLabelText(name)).toBeNull();
    expect(await store.getState().saveSettingsPage("memory-tools")).toBe(true);
    expect(updateAgent).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("记忆工具读取额度"), { target: { value: "3500" } });
    expect(await store.getState().saveSettingsPage("memory-tools")).toBe(true);
    expect(updateAgent).toHaveBeenCalledWith(
      A,
      expect.objectContaining({
        p5_config: expect.objectContaining({
          retrieval_mode: "full_catalog",
          max_catalog_batches: 17,
          catalog_batch_size: 23,
          memory_read: { enabled: true, max_bytes: 3500 },
        }),
      }),
    );
  });
  it("任务工具栏刷新基线，忙碌时读取字段与保存禁用", async () => {
    const getAgent = vi.fn(async (id: string) => ({ ...agent, id }));
    setupLibrary({ getAgent });
    store.setState({ settingsRoute: "memory-tools" });
    await act(async () => render(<AssistantWorkspace />));
    const refresh = () =>
      screen.getByRole("button", {
        name: label("capabilities.resources.refreshBaseline"),
      }) as HTMLButtonElement;
    expect(refresh().disabled).toBe(false);
    await act(async () => fireEvent.click(refresh()));
    expect(getAgent).toHaveBeenCalledTimes(1);
    act(() => store.setState({ settingsSaving: true }));
    expect((screen.getByLabelText("记忆工具读取额度") as HTMLInputElement).disabled).toBe(true);
    expect(refresh().disabled).toBe(true);
    expect((screen.getByRole("button", { name: "保存 Agent" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    act(() => store.setState({ settingsSaving: false }));
  });

  it("知识工具设置忙碌时禁用输入与选择", async () => {
    setupLibrary();
    await act(async () => render(<AgentMaterials />));
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
