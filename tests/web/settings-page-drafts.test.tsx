import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AgentResponse,
  AgentResponseSchema,
  type PersonaResponse,
  PersonaResponseSchema,
} from "../../src/shared/contracts";
import type { SuperstringApi } from "../../src/web/api";
import { SettingsWorkspace } from "../../src/web/app/SettingsWorkspace";
import { AgentSettings } from "../../src/web/features/agents/AgentSettings";
import {
  dirtyPages,
  newPageEditor,
  pageAgentPayload,
} from "../../src/web/features/agents/page-drafts";
import { selectLocale } from "../../src/web/i18n";
import { useSuperstringStore as store } from "../../src/web/store";

function agent(id = "A") {
  return AgentResponseSchema.parse({
    id,
    name: id,
    model_name: "model",
    config_version: 1,
    persona_intensity: 60,
    created_at: "2026-09-19T00:00:00.000Z",
    updated_at: "2026-09-19T00:00:00.000Z",
  });
}
it("目录批数归长期记忆，摘要读取与共用超时归上下文且互不夹带", () => {
  const editor = newPageEditor(agent(), persona());
  editor.draft.p5_config = structuredClone(editor.draft.p5_config);
  editor.draft.p5_config.max_catalog_batches = 7;
  editor.draft.p5_config.catalog_batch_size = 9;
  editor.draft.p5_config.summary_read_max_tokens = 800;
  editor.draft.p5_config.auxiliary_timeout_seconds = 360;
  const memory = pageAgentPayload(editor, "long-memory").p5_config;
  const context = pageAgentPayload(editor, "context").p5_config;
  if (!memory || !context) throw new Error("Missing page config");
  expect(memory.max_catalog_batches).toBe(7);
  expect(memory.catalog_batch_size).toBe(9);
  expect(memory.summary_read_max_tokens).toBeUndefined();
  expect(memory.auxiliary_timeout_seconds).toBe(900);
  expect(context.max_catalog_batches).toBe(100);
  expect(context.catalog_batch_size).toBe(30);
  expect(context.summary_read_max_tokens).toBe(800);
  expect(context.auxiliary_timeout_seconds).toBe(360);
});

function persona(id = "A") {
  return PersonaResponseSchema.parse({
    id,
    agent_id: id,
    core_identity: "saved identity",
    interaction_boundaries: "",
    advanced_instructions: "",
    communication_style: "saved style",
    example_dialogues: "",
    created_at: "2026-09-19T00:00:00.000Z",
    updated_at: "2026-09-19T00:00:00.000Z",
  });
}
let persisted: AgentResponse;
let savedPersona: PersonaResponse;
let client: SuperstringApi;
beforeEach(async () => {
  selectLocale("zh-CN");
  persisted = agent();
  savedPersona = persona();
  client = {
    getAgent: vi.fn(async (id) => (id === "A" ? persisted : agent(id))),
    getPersona: vi.fn(async (id) => (id === "A" ? savedPersona : persona(id))),
    getPolicy: vi.fn(async () => ({
      auto_enabled: true,
      every_turns: 20,
      target_chars: 300,
      version: 1,
    })),
    updatePolicy: vi.fn(async (_id, body) => ({
      auto_enabled: body.auto_enabled,
      every_turns: body.every_turns,
      target_chars: body.target_chars,
      version: body.expected_version + 1,
    })),
    getModelCapacity: vi.fn(async () => ({ context_length: 32768 })),
    getOrganizationSettings: vi.fn(async () => ({
      revision: 1,
      model_name: null,
    })),
    getKnowledgeSettings: vi.fn(async () => ({
      revision: 1,
      model_name: null,
      auto_enabled: true,
      context_budget: 4096,
    })),
    saveKnowledgeSettings: vi.fn(async ({ expected_revision, ...body }) => ({
      ...body,
      revision: expected_revision + 1,
    })),
    listMemorySessions: vi.fn(async () => []),
    listMemoryJobs: vi.fn(async () => []),
    updateAgent: vi.fn(async (_id, body) => {
      const { expected_version, ...patch } = body as Record<string, unknown>;
      expect(expected_version).toBe(persisted.config_version);
      persisted = {
        ...persisted,
        ...patch,
        config_version: persisted.config_version + 1,
      } as AgentResponse;
      return persisted;
    }),
    savePersona: vi.fn(async (_id, body) => {
      const { persona_intensity, ...patch } = body as Record<string, unknown>;
      if (persona_intensity !== undefined)
        persisted = {
          ...persisted,
          persona_intensity: persona_intensity as number,
        };
      savedPersona = { ...savedPersona, ...patch } as PersonaResponse;
      return savedPersona;
    }),
  } as unknown as SuperstringApi;
  store.getState().resetForTests(client);
  store.setState({
    agents: [persisted, agent("B")],
    page: "settings",
    settingsView: "workspace",
  });
  await store.getState().editAgent("A");
});
afterEach(() => {
  cleanup();
  selectLocale("zh-CN");
});

describe("容量预览与集中对话模型回归", () => {
  it("M3：预算输入即时重算容量，不重复请求模型", async () => {
    store.setState({ settingsRoute: "context" });
    await act(async () => render(<SettingsWorkspace />));
    expect(store.getState().capacityPreview).toContain("32768");
    const probes = vi.mocked(client.getModelCapacity).mock.calls.length;
    await act(async () =>
      fireEvent.change(screen.getByRole("spinbutton", { name: "回复预留（token）" }), {
        target: { value: "2000" },
      }),
    );
    expect(store.getState().capacityPreview).toContain("回复预留 2000");
    await act(async () =>
      fireEvent.change(screen.getByRole("spinbutton", { name: "安全余量比例" }), {
        target: { value: "0.1" },
      }),
    );
    expect(store.getState().capacityPreview).toContain("27491");
    expect(client.getModelCapacity).toHaveBeenCalledTimes(probes);
    expect(client.updateAgent).not.toHaveBeenCalled();
  });
  it("M3：同模型切助手仍重新探测，不能复用旧助手缓存", async () => {
    store.setState({ settingsRoute: "context" });
    await act(async () => render(<SettingsWorkspace />));
    const probes = vi.mocked(client.getModelCapacity).mock.calls.length;
    await act(async () => {
      await store.getState().editAgent("B");
    });
    expect(vi.mocked(client.getModelCapacity).mock.calls.length).toBeGreaterThan(probes);
    await act(async () =>
      fireEvent.change(screen.getByRole("spinbutton", { name: "回复预留（token）" }), {
        target: { value: "2345" },
      }),
    );
    expect(store.getState().capacityPreview).toContain("回复预留 2345");
  });
  it("新建模型在默认模型页使用统一分组，往返保留且离开有守卫", async () => {
    await store.getState().editAgent("__new__");
    store.setState({ settingsView: "agents", modelNames: ["model", "other-model"] });
    store.getState().patchDraft({ name: "new assistant" });
    const overview = render(<AgentSettings />);
    expect(screen.queryByRole("combobox", { name: "对话模型" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "设置使用模型" }));
    expect(store.getState().settingsRoute).toBe("models");
    expect(store.getState().navigationConfirmOpen).toBe(false);
    overview.unmount();
    await act(async () => render(<SettingsWorkspace />));
    fireEvent.change(screen.getByRole("combobox", { name: "对话模型" }), {
      target: { value: "other-model" },
    });
    fireEvent.change(screen.getByRole("slider", { name: "回复随机度" }), {
      target: { value: "0.4" },
    });
    expect(document.querySelector("#settings-chat-model.workspace-group")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "返回助手管理继续创建" }));
    expect(store.getState()).toMatchObject({
      settingsView: "agents",
      dirty: true,
      editorDraft: { name: "new assistant", model_name: "other-model", temperature: 0.4 },
    });
    store.getState().openSettingsRoute("models");
    store.getState().openChat();
    expect(store.getState().navigationConfirmOpen).toBe(true);
    store.getState().cancelPendingNavigation();
    expect(store.getState().editorDraft?.model_name).toBe("other-model");
    store.getState().openSettingsRoute("context");
    await act(async () => {
      await store.getState().confirmDiscardAndContinue();
    });
    expect(store.getState().dirty).toBe(false);
    expect(store.getState().editorDraft?.name).not.toBe("new assistant");
  });
});

describe("页面草稿与白名单保存", () => {
  it("p5两页白名单双向隔离并保留其他页草稿", async () => {
    const baseline = persisted.p5_config;
    store.getState().patchPageAgent("long-memory", {
      p5_config: { ...baseline, retrieval_mode: "off", recent_turns: 99 },
      model_name: "forbidden",
    });
    store.getState().patchPageAgent("context", {
      p5_config: { ...baseline, recent_turns: 12, retrieval_mode: "broad" },
    });
    expect(await store.getState().saveSettingsPage("long-memory")).toBe(true);
    expect(persisted.p5_config.recent_turns).toBe(baseline.recent_turns);
    expect(persisted.p5_config.retrieval_mode).toBe("off");
    expect(persisted.model_name).toBe("model");
    expect(dirtyPages(store.getState().pageEditor)).toEqual(["context"]);
    expect(await store.getState().saveSettingsPage("context")).toBe(true);
    expect(persisted.p5_config.retrieval_mode).toBe("off");
    expect(persisted.p5_config.recent_turns).toBe(12);
    expect(dirtyPages(store.getState().pageEditor)).toEqual([]);
  });
  it("policy只在保存时提交，部分失败重试不重复agent请求", async () => {
    store.getState().patchPageAgent("long-memory", { memory_retrieval_prompt: "new rule" });
    store.getState().patchPagePolicy({ every_turns: 25 });
    expect(client.updatePolicy).not.toHaveBeenCalled();
    vi.mocked(client.updatePolicy).mockRejectedValueOnce(new Error("policy failed"));
    expect(await store.getState().saveSettingsPage("long-memory")).toBe(false);
    expect(persisted.memory_retrieval_prompt).toBe("new rule");
    expect(store.getState().pageEditor?.policyDraft?.every_turns).toBe(25);
    expect(await store.getState().saveSettingsPage("long-memory")).toBe(true);
    expect(client.updateAgent).toHaveBeenCalledTimes(1);
    expect(client.updatePolicy).toHaveBeenCalledTimes(2);
    expect(store.getState().policy?.version).toBe(2);
    expect(dirtyPages(store.getState().pageEditor)).toEqual([]);
  });
  it("policy改回及预设深拷贝同值不会误报dirty", () => {
    store.getState().patchPagePolicy({ every_turns: 25 });
    store.getState().patchPagePolicy({ every_turns: 20 });
    store.getState().patchPageAgent("long-memory", {
      p5_config: JSON.parse(JSON.stringify(persisted.p5_config)),
    });
    expect(dirtyPages(store.getState().pageEditor)).toEqual([]);
  });
  it("自定义容量按已保存模型校验，拒绝超量而不丢稿", async () => {
    store.getState().patchPageAgent("models", { model_name: "unsaved" });
    store.getState().patchPageAgent("context", {
      p5_config: { ...persisted.p5_config, context_window: 65536 },
    });
    expect(await store.getState().saveSettingsPage("context")).toBe(false);
    expect(client.getModelCapacity).toHaveBeenCalledWith("model");
    expect(client.updateAgent).not.toHaveBeenCalled();
    expect(dirtyPages(store.getState().pageEditor)).toEqual(["models", "context"]);
  });
  it("全局模型跨助手保稿，单页保存不夹带助手或全局功能草稿", async () => {
    await store.getState().loadKnowledgeModel();
    store.getState().patchKnowledgeModel("global-helper");
    await store.getState().editAgent("B");
    expect(store.getState().knowledgeModelEditor?.modelName).toBe("global-helper");
    store.getState().patchPageAgent("basic", { name: "B draft" });
    expect(await store.getState().saveKnowledgeModel()).toBe(true);
    expect(client.saveKnowledgeSettings).toHaveBeenLastCalledWith({
      expected_revision: 1,
      model_name: "global-helper",
      auto_enabled: true,
      context_budget: 4096,
    });
    expect(client.updateAgent).not.toHaveBeenCalled();
    expect(dirtyPages(store.getState().pageEditor)).toEqual(["basic"]);
  });
  it("全局模型退出守卫失败留稿并阻止导航", async () => {
    await store.getState().loadKnowledgeModel();
    store.getState().patchKnowledgeModel("global-helper");
    store.getState().openChat();
    expect(store.getState().navigationConfirmOpen).toBe(true);
    vi.mocked(client.saveKnowledgeSettings).mockRejectedValueOnce(new Error("conflict"));
    await store.getState().confirmSaveAndContinue();
    expect(store.getState().page).toBe("settings");
    expect(store.getState().knowledgeModelEditor?.modelName).toBe("global-helper");
    await store.getState().confirmSaveAndContinue();
    expect(store.getState().page).toBe("chat");
  });
  it("全局模型放弃不复活", async () => {
    await store.getState().loadKnowledgeModel();
    store.getState().patchKnowledgeModel("discard");
    store.getState().openChat();
    await store.getState().confirmDiscardAndContinue();
    expect(store.getState().knowledgeModelEditor).toBeNull();
    await store.getState().loadKnowledgeModel();
    expect(store.getState().knowledgeModelEditor?.modelName).toBeNull();
  });
  it("全局功能保存推进模型基线，但不提交模型草稿", async () => {
    await store.getState().loadKnowledgeModel();
    store.getState().patchKnowledgeModel("unsaved-global");
    store.setState({
      knowledgeEditor: {
        kind: "settings",
        source: {
          revision: 1,
          model_name: null,
          auto_enabled: true,
          context_budget: 4096,
        },
        model_name: "forbidden",
        auto_enabled: false,
        context_budget: 5000,
      },
      knowledgeDirty: true,
    });
    expect(await store.getState().saveKnowledgeEditor()).toBe(true);
    expect(client.saveKnowledgeSettings).toHaveBeenLastCalledWith({
      expected_revision: 1,
      model_name: null,
      auto_enabled: false,
      context_budget: 5000,
    });
    expect(store.getState().knowledgeModelEditor?.modelName).toBe("unsaved-global");
    expect(await store.getState().saveKnowledgeModel()).toBe(true);
    expect(client.saveKnowledgeSettings).toHaveBeenLastCalledWith({
      expected_revision: 2,
      model_name: "unsaved-global",
      auto_enabled: false,
      context_budget: 5000,
    });
  });
  it("全局模型保存锁阻止重复提交与导航", async () => {
    await store.getState().loadKnowledgeModel();
    store.getState().patchKnowledgeModel("helper");
    let finish!: (value: Awaited<ReturnType<SuperstringApi["saveKnowledgeSettings"]>>) => void;
    vi.mocked(client.saveKnowledgeSettings).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const saving = store.getState().saveKnowledgeModel();
    expect(await store.getState().saveKnowledgeModel()).toBe(false);
    store.getState().openChat();
    store.getState().patchKnowledgeModel("ignored");
    expect(store.getState().page).toBe("settings");
    expect(store.getState().knowledgeModelEditor?.modelName).toBe("helper");
    finish({
      revision: 2,
      model_name: "helper",
      auto_enabled: true,
      context_budget: 4096,
    });
    expect(await saving).toBe(true);
  });
  it("全局模型迟到响应不覆盖新编辑会话", async () => {
    await store.getState().loadKnowledgeModel();
    store.getState().patchKnowledgeModel("helper");
    let finish!: (value: Awaited<ReturnType<SuperstringApi["saveKnowledgeSettings"]>>) => void;
    vi.mocked(client.saveKnowledgeSettings).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const saving = store.getState().saveKnowledgeModel();
    const old = store.getState().knowledgeModelEditor;
    if (!old) throw new Error("Missing global editor fixture");
    store.setState({
      knowledgeModelEditor: { ...old, token: {}, modelName: "new-session" },
    });
    finish({
      revision: 2,
      model_name: "helper",
      auto_enabled: true,
      context_budget: 4096,
    });
    expect(await saving).toBe(false);
    expect(store.getState().knowledgeModelEditor?.modelName).toBe("new-session");
  });
  it("新增三页英文内容完整且不依赖助手加载全局模型", async () => {
    selectLocale("en");
    // User-authored/default prompt contents are intentionally NOT translated.
    store.getState().patchPageAgent("long-memory", {
      memory_retrieval_prompt: "fixture retrieval",
      memory_consolidation_prompt: "fixture consolidation",
    });
    store.setState({ settingsRoute: "long-memory" });
    const { container } = render(<SettingsWorkspace />);
    expect(container.textContent).not.toMatch(/[\u4e00-\u9fff]/);
    await act(async () => store.getState().openSettingsRoute("context"));
    expect(container.textContent).not.toMatch(/[\u4e00-\u9fff]/);
    await act(async () => {
      store.setState({
        agents: [],
        editorAgentId: "__new__",
        editorDraft: null,
        pageEditor: null,
        persona: null,
      });
      store.getState().openSettingsRoute("knowledge-model");
    });
    expect(
      screen.getByRole("combobox", {
        name: "Shared default organization model",
      }),
    ).toBeTruthy();
    expect(container.textContent).not.toMatch(/[\u4e00-\u9fff]/);
  });
  it("新记忆与全局页面不显示旧策略即时保存提示", async () => {
    await store.getState().reloadMemory();
    expect(store.getState().feedback).toBe("");
  });
  it("长期记忆页平铺且自动整理不再即时保存", () => {
    store.setState({ settingsRoute: "long-memory" });
    const { container } = render(<SettingsWorkspace />);
    expect(container.querySelector("details")).toBeNull();
    expect(container.querySelectorAll(".workspace-anchors a")).toHaveLength(4);
    expect(container.querySelector("#settings-memory-management")).toBeTruthy();
    fireEvent.change(screen.getByRole("spinbutton", { name: "触发间隔（完整轮数）" }), {
      target: { value: "30" },
    });
    expect(client.updatePolicy).not.toHaveBeenCalled();
    expect(store.getState().pageEditor?.policyDraft?.every_turns).toBe(30);
  });
  it("全量读取细节置底、说明清楚且保留独立保存", async () => {
    store.setState({ settingsRoute: "long-memory" });
    const { container } = render(<SettingsWorkspace />);
    const details = container.querySelector("#settings-catalog-limits");
    const automatic = container.querySelector("#settings-policy");
    if (!details || !automatic) throw new Error("Missing sections");
    expect(
      automatic.compareDocumentPosition(details) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(details.querySelector("details")).toBeNull();
    expect(details.textContent).toContain("通常无需调整");
    expect(details.textContent).toContain("不是最终使用条数");
    fireEvent.change(screen.getByRole("spinbutton", { name: "最多检查多少批记忆" }), {
      target: { value: "77" },
    });
    fireEvent.change(screen.getByRole("spinbutton", { name: "每批检查多少条" }), {
      target: { value: "22" },
    });
    act(() => store.getState().openSettingsRoute("context"));
    expect(screen.queryByRole("spinbutton", { name: "最多检查多少批记忆" })).toBeNull();
    act(() => store.getState().openSettingsRoute("long-memory"));
    expect(
      (screen.getByRole("spinbutton", { name: "每批检查多少条" }) as HTMLInputElement).value,
    ).toBe("22");
    await act(async () => {
      expect(await store.getState().saveSettingsPage("long-memory")).toBe(true);
    });
    expect(persisted.p5_config?.max_catalog_batches).toBe(77);
    expect(persisted.p5_config?.catalog_batch_size).toBe(22);
  });
  it("基础页不提交模型或人设草稿，并推进公共版本", async () => {
    store.getState().patchPageAgent("basic", { name: "new name", model_name: "forbidden" });
    store.getState().patchPageAgent("models", { model_name: "next model" });
    store.getState().patchPagePersona("identity", { core_identity: "new identity" });
    expect(await store.getState().saveSettingsPage("basic")).toBe(true);
    expect(client.updateAgent).toHaveBeenLastCalledWith("A", {
      name: "new name",
      description: "",
      is_active: true,
      expected_version: 1,
    });
    expect(dirtyPages(store.getState().pageEditor)).toEqual(["models", "identity"]);
    expect(persisted.model_name).toBe("model");
    expect(store.getState().pageEditor?.draft.model_name).toBe("next model");
    expect(await store.getState().saveSettingsPage("models")).toBe(true);
    expect(persisted.config_version).toBe(3);
  });
  it("加载详情刷新目录基线，过渡保存后不会恢复过时字段", async () => {
    persisted = {
      ...persisted,
      model_name: "latest server model",
      config_version: 8,
    };
    await store.getState().editAgent("A");
    expect(store.getState().agents.find((a) => a.id === "A")?.config_version).toBe(8);
    store.getState().openAgentSettings();
    await store.getState().savePersona({ persona_intensity: 80 });
    act(() => store.getState().openSettingsRoute("models"));
    render(<SettingsWorkspace />);
    expect(store.getState().pageEditor?.draft.model_name).toBe("latest server model");
  });
  it("改回保存值立即消除当前页dirty", () => {
    store.getState().patchPageAgent("basic", { name: "changed" });
    store.getState().patchPageAgent("basic", { name: "A" });
    expect(dirtyPages(store.getState().pageEditor)).toEqual([]);
  });
  it("身份保存使用表达页已保存基线，而非表达草稿", async () => {
    store.getState().patchPagePersona("identity", { core_identity: "new identity" });
    store.getState().patchPagePersona("expression", { communication_style: "unsaved style" });
    store.getState().patchPageAgent("expression", { persona_intensity: 95 });
    expect(await store.getState().saveSettingsPage("identity")).toBe(true);
    expect(savedPersona.communication_style).toBe("saved style");
    expect(persisted.persona_intensity).toBe(60);
    expect(dirtyPages(store.getState().pageEditor)).toEqual(["expression"]);
    expect(await store.getState().saveSettingsPage("expression")).toBe(true);
    expect(savedPersona.core_identity).toBe("new identity");
    expect(persisted.persona_intensity).toBe(95);
    expect(dirtyPages(store.getState().pageEditor)).toEqual([]);
  });
  it("身份跨端点部分成功后保留失败草稿，重试不重复已成功请求", async () => {
    store.getState().patchPageAgent("identity", { additional_instructions: "new extra" });
    store.getState().patchPagePersona("identity", { core_identity: "new identity" });
    vi.mocked(client.savePersona).mockRejectedValueOnce(new Error("persona failed"));
    expect(await store.getState().saveSettingsPage("identity")).toBe(false);
    expect(persisted.additional_instructions).toBe("new extra");
    expect(store.getState().pageEditor?.agent.config_version).toBe(2);
    expect(dirtyPages(store.getState().pageEditor)).toEqual(["identity"]);
    expect(await store.getState().saveSettingsPage("identity")).toBe(true);
    expect(client.updateAgent).toHaveBeenCalledTimes(1);
    expect(client.savePersona).toHaveBeenCalledTimes(2);
  });
  it("页面切换及通用设置保稿，返回聊天统一拦截", () => {
    store.getState().patchPageAgent("basic", { name: "draft" });
    store.getState().openSettingsRoute("expression");
    expect(store.getState().navigationConfirmOpen).toBe(false);
    store.getState().requestPageNavigation("settings", "general");
    expect(store.getState().navigationConfirmOpen).toBe(false);
    store.getState().openChat();
    expect(store.getState().navigationConfirmOpen).toBe(true);
    store.getState().cancelPendingNavigation();
    expect(store.getState().pageEditor?.draft.name).toBe("draft");
  });
  it("换助手统一保存所有脏页", async () => {
    store.getState().patchPageAgent("basic", { name: "new" });
    store.getState().patchPagePersona("expression", { communication_style: "new style" });
    store.getState().requestAgentNavigation("B");
    expect(store.getState().editorAgentId).toBe("A");
    await store.getState().confirmSaveAndContinue();
    expect(store.getState().editorAgentId).toBe("B");
    expect(persisted.name).toBe("new");
    expect(savedPersona.communication_style).toBe("new style");
  });
  it("全部保存部分失败阻止导航，已成功页不再dirty", async () => {
    store.getState().patchPageAgent("basic", { name: "new" });
    store.getState().patchPagePersona("identity", { core_identity: "new" });
    vi.mocked(client.savePersona).mockRejectedValueOnce(new Error("conflict"));
    store.getState().openChat();
    await store.getState().confirmSaveAndContinue();
    expect(store.getState().page).toBe("settings");
    expect(store.getState().navigationConfirmOpen).toBe(true);
    expect(dirtyPages(store.getState().pageEditor)).toEqual(["identity"]);
    await store.getState().confirmSaveAndContinue();
    expect(store.getState().page).toBe("chat");
  });
  it("放弃后返回新页不复活旧稿", async () => {
    store.getState().patchPageAgent("basic", { name: "unsaved" });
    store.getState().openChat();
    await store.getState().confirmDiscardAndContinue();
    expect(store.getState().pageEditor).toBeNull();
    expect(persisted.name).toBe("A");
  });
  it("目标读取失败保留所有页面草稿", async () => {
    store.getState().patchPageAgent("basic", { name: "unsaved" });
    vi.mocked(client.getAgent).mockRejectedValueOnce(new Error("load failed"));
    store.getState().requestAgentNavigation("B");
    await store.getState().confirmDiscardAndContinue();
    expect(store.getState().editorAgentId).toBe("A");
    expect(store.getState().pageEditor?.draft.name).toBe("unsaved");
    expect(store.getState().navigationConfirmOpen).toBe(true);
  });
  it("保存锁阻止编辑、重复保存、切页、切助手及放弃", async () => {
    let finish!: (value: AgentResponse) => void;
    vi.mocked(client.updateAgent).mockImplementationOnce(
      () =>
        new Promise((r) => {
          finish = r;
        }),
    );
    store.getState().patchPageAgent("basic", { name: "submitted" });
    const operation = store.getState().saveSettingsPage("basic");
    store.getState().patchPageAgent("basic", { name: "late edit" });
    store.getState().openSettingsRoute("models");
    expect(await store.getState().editAgent("B")).toBe(false);
    store.getState().discardSettingsPages();
    expect(await store.getState().saveSettingsPage("basic")).toBe(false);
    expect(store.getState().pageEditor?.draft.name).toBe("submitted");
    expect(store.getState().settingsRoute).toBe("basic");
    finish({ ...persisted, name: "submitted", config_version: 2 });
    expect(await operation).toBe(true);
    expect(store.getState().settingsSaving).toBe(false);
  });
  it("迟到保存响应不覆盖另一个编辑会话", async () => {
    let finish!: (value: AgentResponse) => void;
    vi.mocked(client.updateAgent).mockImplementationOnce(
      () =>
        new Promise((r) => {
          finish = r;
        }),
    );
    store.getState().patchPageAgent("basic", { name: "submitted" });
    const operation = store.getState().saveSettingsPage("basic");
    store.setState({
      editorAgentId: "B",
      pageEditor: newPageEditor(agent("B"), persona("B")),
    });
    finish({ ...persisted, name: "submitted" });
    expect(await operation).toBe(false);
    expect(store.getState().pageEditor?.agent.id).toBe("B");
  });
  it("合并管理页与其他设置页往返保稿，不提前保存模型", () => {
    store.getState().patchPageAgent("models", { model_name: "unsaved" });
    store.getState().openAgentSettings();
    expect(store.getState().settingsView).toBe("agents");
    expect(store.getState().navigationConfirmOpen).toBe(false);
    expect(store.getState().editorDraft?.model_name).toBe("model");
    expect(store.getState().pageEditor?.draft.model_name).toBe("unsaved");
    store.getState().patchPageAgent("basic", { name: "draft name" });
    store.getState().openSettingsRoute("models");
    store.getState().openSettingsRoute("basic");
    expect(store.getState().settingsView).toBe("agents");
    expect(store.getState().pageEditor?.draft.name).toBe("draft name");
    expect(client.updateAgent).not.toHaveBeenCalled();
    store.getState().openChat();
    expect(store.getState().navigationConfirmOpen).toBe(true);
  });
  it.each(["save", "discard"] as const)("记忆纠正%s后进入合并页，不丢其他草稿", async (choice) => {
    store.getState().patchPageAgent("basic", { name: "retained draft" });
    store.setState({ memoryCorrectionDirty: true });
    const original = store.getState().saveMemoryCorrection;
    store.setState({
      saveMemoryCorrection: vi.fn(async () => {
        store.setState({ memoryCorrectionDirty: false });
        return true;
      }),
    });
    try {
      store.getState().openSettingsRoute("basic");
      expect(store.getState().navigationConfirmOpen).toBe(true);
      if (choice === "save") await store.getState().confirmSaveAndContinue();
      else await store.getState().confirmDiscardAndContinue();
      expect(store.getState().settingsView).toBe("agents");
      expect(store.getState().pageEditor?.draft.name).toBe("retained draft");
      expect(client.updateAgent).not.toHaveBeenCalled();
    } finally {
      store.setState({ saveMemoryCorrection: original });
    }
  });
  it("合并页保留全局和资料稿，基础信息保存只提交白名单", async () => {
    await store.getState().loadKnowledgeModel();
    store.getState().patchKnowledgeModel("global draft");
    store.setState({ knowledgeDirty: true });
    store.getState().patchPageAgent("models", { model_name: "model draft" });
    store.getState().openSettingsRoute("basic");
    render(<AgentSettings />);
    fireEvent.change(screen.getByRole("textbox", { name: "助手名称" }), {
      target: { value: "edited" },
    });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "保存当前页" })));
    expect(client.updateAgent).toHaveBeenLastCalledWith("A", {
      name: "edited",
      description: "",
      is_active: true,
      expected_version: 1,
    });
    expect(store.getState().pageEditor?.draft.model_name).toBe("model draft");
    expect(store.getState().knowledgeModelEditor?.modelName).toBe("global draft");
    expect(store.getState().knowledgeDirty).toBe(true);
    expect(store.getState().navigationConfirmOpen).toBe(false);
  });
  it("四页平铺、字段隔离、锚点与保存按钮可用", async () => {
    const { container } = render(<SettingsWorkspace />);
    expect(container.querySelector("details")).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "助手名称" }), {
      target: { value: "new name" },
    });
    act(() => store.getState().openSettingsRoute("identity"));
    expect(screen.queryByRole("textbox", { name: "助手名称" })).toBeNull();
    expect(screen.getByRole("textbox", { name: "补充指令" })).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "沟通风格" })).toBeNull();
    act(() => store.getState().openSettingsRoute("expression"));
    expect(screen.getByRole("textbox", { name: "沟通风格" })).toBeTruthy();
    await act(async () => store.getState().openSettingsRoute("models"));
    expect(screen.getAllByRole("combobox")).toHaveLength(7);
    expect(screen.getAllByRole("link")).toHaveLength(3);
    act(() => store.getState().openSettingsRoute("basic"));
    cleanup();
    render(<AgentSettings />);
    expect((screen.getByRole("textbox", { name: "助手名称" }) as HTMLInputElement).value).toBe(
      "new name",
    );
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "保存当前页" })));
    expect(persisted.name).toBe("new name");
  });
  it("资料内部保存或放弃不连带处理助手页草稿", async () => {
    store.getState().patchPageAgent("basic", { name: "assistant draft" });
    store.setState({ settingsView: "knowledge", knowledgeDirty: true });
    store.getState().openSettingsRoute("models");
    await store.getState().confirmDiscardAndContinue();
    expect(store.getState().pageEditor?.draft.name).toBe("assistant draft");
    expect(client.updateAgent).not.toHaveBeenCalled();
    expect(store.getState().settingsView).toBe("workspace");
  });
  it("过渡人设保存后重新进入工作区使用新的强度与人设", async () => {
    store.getState().openAgentSettings();
    store.getState().patchPersona({ communication_style: "legacy saved" });
    await store.getState().savePersona({ persona_intensity: 85 });
    act(() => store.getState().openSettingsRoute("expression"));
    render(<SettingsWorkspace />);
    expect(store.getState().pageEditor?.draft.persona_intensity).toBe(85);
    expect(store.getState().pageEditor?.personaDraft.communication_style).toBe("legacy saved");
  });
  it.each(["A", "B", "C", "D"] as const)("旧%s区退役编辑控件，保留跳转与管理", (section) => {
    store.setState({
      settingsView: "agents",
      activeSection: section,
    });
    const { container } = render(<AgentSettings />);
    expect(screen.queryByRole("button", { name: "保存当前分区配置" })).toBeNull();
    expect(container.querySelectorAll(".section-content textarea:not([readonly])")).toHaveLength(0);
    expect(container.querySelectorAll(".section-content input[type=range]")).toHaveLength(0);
    expect(screen.queryByText("按完整对话轮数自动整理；选项修改后立即保存。")).toBeNull();
    expect(screen.getByRole("heading", { name: "助手管理" })).toBeTruthy();
    expect(container.querySelector(".section-nav")).toBeNull();
    expect(screen.queryByText("详细配置")).toBeNull();
    expect(container.querySelector(".memory-management")).toBeNull();
    expect(store.getState().settingsView).toBe("agents");
    expect(store.getState().editorAgentId).toBe("A");
    expect(client.updateAgent).not.toHaveBeenCalled();
    expect(client.updatePolicy).not.toHaveBeenCalled();
    expect(client.savePersona).not.toHaveBeenCalled();
  });
  it("长期记忆页切页拦截未保存纠正，取消不丢稿", () => {
    store.setState({
      settingsView: "workspace",
      settingsRoute: "long-memory",
      memoryCorrectionDirty: true,
    });
    render(<SettingsWorkspace />);
    act(() => store.getState().openSettingsRoute("context"));
    expect(store.getState().settingsRoute).toBe("long-memory");
    expect(store.getState().pendingNavigation).toMatchObject({
      settingsView: "workspace",
      settingsRoute: "context",
    });
    act(() => store.getState().cancelPendingNavigation());
    expect(store.getState().memoryCorrectionDirty).toBe(true);
  });
  it.each(["save", "discard"] as const)("记忆纠正%s后切页保留其他配置草稿", async (choice) => {
    store.getState().patchPageAgent("long-memory", {
      memory_retrieval_prompt: "unsaved config",
    });
    const originalSave = store.getState().saveMemoryCorrection;
    const save = vi.fn(async () => {
      store.setState({ memoryCorrectionDirty: false });
      return true;
    });
    try {
      store.setState({
        settingsRoute: "long-memory",
        memoryCorrectionDirty: true,
        saveMemoryCorrection: save,
      });
      store.getState().openSettingsRoute("context");
      expect(store.getState().settingsRoute).toBe("long-memory");
      if (choice === "save") await store.getState().confirmSaveAndContinue();
      else await store.getState().confirmDiscardAndContinue();
      expect(store.getState().settingsRoute).toBe("context");
      expect(store.getState().memoryCorrectionDirty).toBe(false);
      expect(store.getState().pageEditor?.draft.memory_retrieval_prompt).toBe("unsaved config");
      expect(client.updateAgent).not.toHaveBeenCalled();
      expect(save).toHaveBeenCalledTimes(choice === "save" ? 1 : 0);
    } finally {
      store.setState({ saveMemoryCorrection: originalSave });
    }
  });
  it("当前助手详情先于完整列表，行选择不改变会话与批量勾选", async () => {
    store.setState({ settingsView: "agents", selectedNewSessionAgentId: "A" });
    render(<AgentSettings />);
    const current = screen.getByRole("region", { name: "当前助手" });
    const list = screen.getByRole("region", { name: "所有助手" });
    expect(current.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(current.querySelectorAll(".workspace-group,.workspace-anchors")).toHaveLength(0);
    const selector = screen.getByRole("combobox", { name: "正在配置的助手" });
    expect((selector as HTMLSelectElement).value).toBe("A");
    expect(
      selector.compareDocumentPosition(current) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(within(list).getAllByRole("button", { name: /^编辑助手：/ })).toHaveLength(2);
    fireEvent.click(screen.getByRole("checkbox", { name: "选择助手：A" }));
    expect(store.getState().editorAgentId).toBe("A");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "编辑助手：B" })));
    expect(store.getState().editorAgentId).toBe("B");
    expect(store.getState().selectedNewSessionAgentId).toBe("A");
    expect((screen.getByRole("textbox", { name: "助手名称" }) as HTMLInputElement).value).toBe("B");
    expect(screen.getByRole("button", { name: "编辑助手：B" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(
      (
        screen.getByRole("checkbox", {
          name: "选择助手：A",
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
    expect(screen.getByText("已选 1 / 2 个助手")).toBeTruthy();
  });
  it("顶部下拉切换详情与列表选中态，保留批量勾选和新会话候选", async () => {
    store.setState({ settingsView: "agents", selectedNewSessionAgentId: "A" });
    render(<AgentSettings />);
    fireEvent.click(screen.getByRole("checkbox", { name: "选择助手：A" }));
    const selector = screen.getByRole("combobox", { name: "正在配置的助手" });
    await act(async () => fireEvent.change(selector, { target: { value: "B" } }));
    expect(store.getState().editorAgentId).toBe("B");
    expect(store.getState().selectedNewSessionAgentId).toBe("A");
    expect((screen.getByRole("textbox", { name: "助手名称" }) as HTMLInputElement).value).toBe("B");
    expect(screen.getByRole("button", { name: "编辑助手：B" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(
      (
        screen.getByRole("checkbox", {
          name: "选择助手：A",
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "编辑助手：A" })));
    expect((selector as HTMLSelectElement).value).toBe("A");
  });
  it("下拉切换走未保存守卫，取消保留选择和草稿，放弃才切换", async () => {
    store.setState({ settingsView: "agents" });
    render(<AgentSettings />);
    fireEvent.change(screen.getByRole("textbox", { name: "描述" }), {
      target: { value: "dropdown draft" },
    });
    const selector = screen.getByRole("combobox", { name: "正在配置的助手" });
    fireEvent.change(selector, { target: { value: "B" } });
    expect(store.getState().navigationConfirmOpen).toBe(true);
    expect((selector as HTMLSelectElement).value).toBe("A");
    fireEvent.click(screen.getByRole("button", { name: "取消离开" }));
    expect(store.getState().pageEditor?.draft.description).toBe("dropdown draft");
    fireEvent.change(selector, { target: { value: "B" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "放弃修改并继续" })));
    expect((selector as HTMLSelectElement).value).toBe("B");
    expect(client.updateAgent).not.toHaveBeenCalled();
  });
  it("列表切换仍走未保存守卫，取消保稿、放弃后切换", async () => {
    store.setState({ settingsView: "agents" });
    render(<AgentSettings />);
    fireEvent.change(screen.getByRole("textbox", { name: "描述" }), {
      target: { value: "keep this" },
    });
    fireEvent.click(screen.getByRole("button", { name: "编辑助手：B" }));
    expect(store.getState().navigationConfirmOpen).toBe(true);
    expect(store.getState().editorAgentId).toBe("A");
    fireEvent.click(screen.getByRole("button", { name: "取消离开" }));
    expect((screen.getByRole("textbox", { name: "描述" }) as HTMLTextAreaElement).value).toBe(
      "keep this",
    );
    fireEvent.click(screen.getByRole("button", { name: "编辑助手：B" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "放弃修改并继续" })));
    expect(store.getState().editorAgentId).toBe("B");
    expect(client.updateAgent).not.toHaveBeenCalled();
  });
  it("模型入口保留基础信息草稿，管理页不重复显示对话模型", () => {
    store.setState({ settingsView: "agents" });
    store.getState().patchPageAgent("models", { model_name: "unsaved-model" });
    render(<AgentSettings />);
    fireEvent.change(screen.getByRole("textbox", { name: "描述" }), {
      target: { value: "draft" },
    });
    expect(document.querySelector(".agent-model-summary strong")).toBeNull();
    expect(screen.queryByRole("combobox", { name: "对话模型" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "设置使用模型" }));
    expect(store.getState().settingsRoute).toBe("models");
    expect(store.getState().pageEditor?.draft.description).toBe("draft");
    expect(store.getState().pageEditor?.draft.model_name).toBe("unsaved-model");
    expect(client.updateAgent).not.toHaveBeenCalled();
  });
  it("批量选择和清空独立，删除确认列出目标，受保护项保留", async () => {
    const deleteMany = vi.fn(async () => ({
      deleted_count: 1,
      failed_count: 1,
      results: [
        { id: "A", deleted: false, message: "protected" },
        { id: "B", deleted: true },
      ],
    }));
    store.setState({
      settingsView: "agents",
      apiClient: {
        ...client,
        deleteAgents: deleteMany,
      } as unknown as SuperstringApi,
    });
    render(<AgentSettings />);
    expect((screen.getByRole("button", { name: "删除所选" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.click(screen.getByRole("button", { name: "全选" }));
    expect(screen.getByText("已选 2 / 2 个助手")).toBeTruthy();
    expect(store.getState().editorAgentId).toBe("A");
    fireEvent.click(screen.getByRole("button", { name: "取消全选" }));
    expect(screen.getByText("已选 0 / 2 个助手")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "全选" }));
    fireEvent.click(screen.getByRole("button", { name: "删除所选" }));
    expect(screen.getByRole("alertdialog").textContent).toContain("删除对象：A / B");
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "取消",
      }),
    );
    expect(deleteMany).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "删除所选" }));
    await act(async () =>
      fireEvent.click(
        within(screen.getByRole("alertdialog")).getByRole("button", {
          name: "删除所选",
        }),
      ),
    );
    expect(deleteMany).toHaveBeenCalledExactlyOnceWith(["A", "B"]);
    expect(screen.queryByRole("button", { name: "编辑助手：B" })).toBeNull();
    expect(screen.getByRole("button", { name: "编辑助手：A" })).toBeTruthy();
    expect(screen.getByText("已选 0 / 1 个助手")).toBeTruthy();
    expect(store.getState().feedback).toContain("成功 1 个，失败 1 个");
  });
  it("保存或读取期间禁止列表切换、勾选和删除，停用助手仍可管理", () => {
    store.setState({
      settingsView: "agents",
      agents: [persisted, { ...agent("B"), is_active: false }],
      selectedNewSessionAgentId: "A",
      settingsSaving: true,
    });
    render(<AgentSettings />);
    expect(screen.getByRole("combobox", { name: "正在配置的助手" }).matches(":disabled")).toBe(
      true,
    );
    expect(
      within(screen.getByRole("combobox", { name: "正在配置的助手" })).getByRole("option", {
        name: "B（停用）",
      }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "编辑助手：B" }).matches(":disabled")).toBe(true);
    expect(screen.getByRole("checkbox", { name: "选择助手：B" }).matches(":disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "删除当前 Agent" }).matches(":disabled")).toBe(true);
    expect(screen.getByRole("combobox", { name: "新会话使用的助手" }).matches(":disabled")).toBe(
      true,
    );
    expect(
      within(screen.getByRole("combobox", { name: "新会话使用的助手" })).queryByRole("option", {
        name: "B",
      }),
    ).toBeNull();
    act(() => store.setState({ settingsSaving: false }));
    expect(screen.getByRole("button", { name: "编辑助手：B" }).matches(":disabled")).toBe(false);
    expect(screen.getByRole("button", { name: "编辑助手：B" }).textContent).toContain("停用");
  });
  it("单个删除确认显示当前助手名称且取消不发请求", () => {
    store.setState({ settingsView: "agents" });
    render(<AgentSettings />);
    fireEvent.click(screen.getByRole("button", { name: "删除当前 Agent" }));
    expect(screen.getByRole("alertdialog").textContent).toContain("确认删除助手「A」");
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(store.getState().agents).toHaveLength(2);
  });
  it("原新建入口仍显示创建表单，已有助手不再显示", async () => {
    await store.getState().editAgent("__new__");
    store.setState({ settingsView: "agents" });
    render(<AgentSettings />);
    expect(screen.getByRole("textbox", { name: "助手名称" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "创建助手" })).toBeTruthy();
    expect(document.querySelector(".section-nav")).toBeNull();
    await act(async () => {
      await store.getState().editAgent("A");
    });
    expect(screen.getByRole("textbox", { name: "助手名称" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "保存当前页" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "创建助手" })).toBeNull();
    expect(screen.getByRole("region", { name: "当前助手" })).toBeTruthy();
  });
  it("旧配置跳转及记忆管理英文完整", () => {
    selectLocale("en");
    store.setState({ settingsView: "agents" });
    const { container } = render(<AgentSettings />);
    for (const activeSection of ["A", "B", "C", "D"] as const) {
      act(() => store.setState({ activeSection }));
      expect(container.textContent).not.toMatch(/[\u4e00-\u9fff]/);
    }
  });
  it("新页面英文词条完整", () => {
    selectLocale("en");
    const { container } = render(<SettingsWorkspace />);
    for (const page of ["basic", "models", "identity", "expression"] as const) {
      act(() => store.getState().openSettingsRoute(page));
      expect(container.textContent).not.toMatch(/[\u4e00-\u9fff]/);
    }
  });
});
