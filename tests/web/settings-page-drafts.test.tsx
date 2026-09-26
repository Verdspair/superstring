// Presentation-specific cases moved to fresh-product-workspaces.test.tsx.
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AgentResponse,
  AgentResponseSchema,
  type PersonaResponse,
  PersonaResponseSchema,
} from "../../src/shared/contracts";
import type { SuperstringApi } from "../../src/web/api";

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

  it("新记忆与全局页面不显示旧策略即时保存提示", async () => {
    await store.getState().reloadMemory();
    expect(store.getState().feedback).toBe("");
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

  it("资料内部保存或放弃不连带处理助手页草稿", async () => {
    store.getState().patchPageAgent("basic", { name: "assistant draft" });
    store.setState({ settingsView: "knowledge", knowledgeDirty: true });
    store.getState().openSettingsRoute("models");
    await store.getState().confirmDiscardAndContinue();
    expect(store.getState().pageEditor?.draft.name).toBe("assistant draft");
    expect(client.updateAgent).not.toHaveBeenCalled();
    expect(store.getState().settingsView).toBe("workspace");
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
});
