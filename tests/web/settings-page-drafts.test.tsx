// Presentation-specific cases moved to fresh-product-workspaces.test.tsx.
import { act, cleanup, fireEvent, render as renderView, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AgentResponse,
  AgentResponseSchema,
  type PersonaResponse,
  PersonaResponseSchema,
  UpdateAgentRequestSchema,
} from "../../src/shared/contracts";
import type { SuperstringApi } from "../../src/web/api";
import { DesignSystemProvider } from "../../src/web/design-system/Providers";
import {
  dirtyPages,
  newPageEditor,
  pageAgentPayload,
} from "../../src/web/features/agents/page-drafts";
import { selectLocale } from "../../src/web/i18n";
import { AgentMaterials } from "../../src/web/screens/assistants/AgentMaterials";

import { useSuperstringStore as store } from "../../src/web/store";

/** 显式 tooltip（保存按钮/字段帮助）必须挂在真实 DesignSystemProvider 下渲染。 */
const render = (...[ui, options]: Parameters<typeof renderView>) =>
  renderView(ui, { wrapper: DesignSystemProvider, ...options });

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
it("资料读取与上下文白名单互不夹带并保留旧字段", () => {
  const editor = newPageEditor(agent(), persona());
  editor.draft.p5_config = {
    ...structuredClone(editor.draft.p5_config),
    memory_read: { enabled: true, max_bytes: 1234 },
    max_catalog_batches: 7,
    summary_read_max_tokens: 800,
  };
  editor.draft.memory_retrieval_prompt = "ignored prompt";
  const memory = pageAgentPayload(editor, "memory-tools").p5_config;
  const context = pageAgentPayload(editor, "context").p5_config;
  if (!memory || !context) throw new Error("Missing page config");
  expect(pageAgentPayload(editor, "long-memory")).not.toHaveProperty("p5_config");
  expect(pageAgentPayload(editor, "memory-tools")).not.toHaveProperty("memory_retrieval_prompt");
  expect(memory.memory_read).toEqual({ enabled: true, max_bytes: 1234 });
  expect(memory.max_catalog_batches).toBe(editor.agent.p5_config.max_catalog_batches);
  expect(memory.retrieval_presets).toEqual(editor.agent.p5_config.retrieval_presets);
  expect(context.memory_read).toEqual(editor.agent.p5_config.memory_read);
  expect(context.summary_read_max_tokens).toBe(800);
});
it("旧目录批次草稿不会由任一活动页面改写", () => {
  const editor = newPageEditor(agent(), persona());
  editor.draft.p5_config = { ...editor.draft.p5_config, max_catalog_batches: 55 };
  expect(pageAgentPayload(editor, "memory-tools").p5_config?.max_catalog_batches).toBe(
    editor.agent.p5_config.max_catalog_batches,
  );
  expect(pageAgentPayload(editor, "context").p5_config?.max_catalog_batches).toBe(
    editor.agent.p5_config.max_catalog_batches,
  );
});

it.each(["full_catalog", "full_body"] as const)(
  "存量 %s 保真且只通过单一额度编辑",
  async (mode) => {
    persisted = {
      ...persisted,
      p5_config: {
        ...persisted.p5_config,
        memory_read: undefined,
        retrieval_mode: mode,
        max_catalog_batches: 17,
        catalog_batch_size: 23,
      },
    };
    await store.getState().editAgent("A");
    store.getState().openSettingsRoute("memory-tools");
    await act(async () => render(<AgentMaterials />));
    expect(screen.queryByLabelText("记忆工具额度模式")).toBeNull();
    expect(screen.queryByLabelText("最多目录批次")).toBeNull();
    expect(screen.queryByLabelText("每批目录条数")).toBeNull();
    expect(dirtyPages(store.getState().pageEditor)).toEqual([]);
    expect(persisted.p5_config.retrieval_mode).toBe(mode);
    const callsBefore = vi.mocked(client.updateAgent).mock.calls.length;
    expect(await store.getState().saveSettingsPage("memory-tools")).toBe(true);
    expect(vi.mocked(client.updateAgent).mock.calls.length).toBe(callsBefore);
    fireEvent.change(screen.getByLabelText("记忆工具读取额度"), { target: { value: "2048" } });
    expect(await store.getState().saveSettingsPage("memory-tools")).toBe(true);
    expect(persisted.p5_config.memory_read).toEqual({ enabled: true, max_bytes: 2048 });
    expect(persisted.p5_config.retrieval_mode).toBe(mode);
    expect(persisted.p5_config.max_catalog_batches).toBe(17);
    expect(persisted.p5_config.catalog_batch_size).toBe(23);
  },
);
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
    getAgentKnowledgeRead: vi.fn(async () => ({
      revision: 1,
      config: { enabled: true, context_budget: null, scope: "all", document_ids: [] },
    })),
    listAgentKnowledge: vi.fn(async () => []),
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
  it.each(["full_catalog", "full_body", "off"] as const)(
    "%s survives visits, other-page saves and reloads without implicit normalization",
    async (mode) => {
      persisted = {
        ...persisted,
        memory_retrieval_model_name: "legacy-model",
        memory_retrieval_prompt: "旧检索提示\r\n不改",
        p5_config: {
          ...persisted.p5_config,
          retrieval_mode: mode,
          max_catalog_batches: 17,
          catalog_batch_size: 23,
        },
      };
      await store.getState().editAgent("A");
      const original = structuredClone(persisted);
      store.getState().patchPageAgent("models", { memory_retrieval_model_name: "legacy-model" });
      store.getState().patchPageAgent("long-memory", {
        memory_retrieval_prompt: "ignored",
        p5_config: {
          ...persisted.p5_config,
          max_catalog_batches: 999,
          catalog_batch_size: 999,
          retrieval_presets: {
            ...persisted.p5_config.retrieval_presets,
            broad: {
              ...persisted.p5_config.retrieval_presets.broad,
              relevance_instruction: "ignored",
            },
          },
        },
      });
      expect(dirtyPages(store.getState().pageEditor)).toEqual([]);
      expect(store.getState().pageEditor?.draft.memory_retrieval_prompt).toBe(
        original.memory_retrieval_prompt,
      );
      expect(store.getState().pageEditor?.draft.memory_retrieval_model_name).toBe("legacy-model");
      expect(store.getState().pageEditor?.draft.p5_config).toEqual(original.p5_config);
      store.getState().openSettingsRoute("models");
      store.getState().patchPageAgent("models", { model_name: "new-chat" });
      store.getState().openSettingsRoute("long-memory");
      store
        .getState()
        .patchPageAgent("context", { p5_config: { ...persisted.p5_config, recent_turns: 12 } });
      expect(await store.getState().saveSettingsPage("context")).toBe(true);
      expect(persisted.p5_config.retrieval_mode).toBe(mode);
      expect(persisted.model_name).toBe("model");
      expect(dirtyPages(store.getState().pageEditor)).toEqual(["models"]);
      expect(await store.getState().saveSettingsPage("models")).toBe(true);
      await store.getState().editAgent("A");
      expect(store.getState().pageEditor?.draft.p5_config.retrieval_mode).toBe(mode);
      // 维护页保存不再碰读取字段：旧全量档原样保留。
      expect(await store.getState().saveSettingsPage("long-memory")).toBe(true);
      expect(persisted.p5_config.retrieval_mode).toBe(mode);
      // 未主动改档的存量 full 档：memory-tools 保存原样保留 full（仅显式切换才归一为 broad）。
      expect(await store.getState().saveSettingsPage("memory-tools")).toBe(true);
      expect(persisted.p5_config.retrieval_mode).toBe(mode);
      await store.getState().editAgent("A");
      expect(store.getState().pageEditor?.draft).toMatchObject({
        memory_retrieval_model_name: "legacy-model",
        memory_retrieval_prompt: original.memory_retrieval_prompt,
        p5_config: {
          max_catalog_batches: 17,
          catalog_batch_size: 23,
          retrieval_presets: original.p5_config.retrieval_presets,
        },
      });
      expect(dirtyPages(store.getState().pageEditor)).toEqual([]);
    },
  );
  it("p5三页白名单互不夹带并保留其他页草稿", async () => {
    const baseline = persisted.p5_config;
    store.getState().patchPageAgent("long-memory", {
      p5_config: { ...baseline, memory_read: { enabled: false, max_bytes: 1234 } },
      model_name: "forbidden",
    });
    expect(store.getState().pageEditor?.draft.p5_config.memory_read).toEqual(baseline.memory_read);
    expect(store.getState().pageEditor?.draft.model_name).toBe("model");
    store.getState().patchPageAgent("memory-tools", {
      p5_config: {
        ...baseline,
        memory_read: { enabled: false, max_bytes: 1234 },
        recent_turns: 99,
      },
      model_name: "forbidden",
    });
    store.getState().patchPageAgent("context", {
      p5_config: {
        ...baseline,
        recent_turns: 12,
        memory_read: { enabled: true, max_bytes: 5000 },
      },
    });
    expect(dirtyPages(store.getState().pageEditor)).toEqual(["memory-tools", "context"]);
    expect(await store.getState().saveSettingsPage("memory-tools")).toBe(true);
    expect(persisted.p5_config.recent_turns).toBe(baseline.recent_turns);
    expect(persisted.p5_config.memory_read).toEqual({ enabled: false, max_bytes: 1234 });
    expect(persisted.model_name).toBe("model");
    expect(dirtyPages(store.getState().pageEditor)).toEqual(["context"]);
    expect(await store.getState().saveSettingsPage("context")).toBe(true);
    expect(persisted.p5_config.memory_read).toEqual({ enabled: false, max_bytes: 1234 });
    expect(persisted.p5_config.recent_turns).toBe(12);
    expect(dirtyPages(store.getState().pageEditor)).toEqual([]);
  });

  it("policy只在保存时提交，部分失败重试不重复agent请求", async () => {
    const policy = { auto_enabled: true, every_turns: 20, target_chars: 1200, version: 1 };
    store.setState({
      policy,
      pageEditor: {
        ...store.getState().pageEditor!,
        policy,
        policyDraft: { ...policy },
      },
    });
    store.getState().patchPageAgent("long-memory", { memory_consolidation_prompt: "new rule" });
    store.getState().patchPagePolicy({ every_turns: 25 });
    expect(client.updatePolicy).not.toHaveBeenCalled();
    vi.mocked(client.updatePolicy).mockRejectedValueOnce(new Error("policy failed"));
    expect(await store.getState().saveSettingsPage("long-memory")).toBe(false);
    expect(persisted.memory_consolidation_prompt).toBe("new rule");
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
    store.getState().patchPageAgent("memory-tools", {
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
    // 设置保存只提交 auto_enabled：预算取共享最新基线（4096），编辑器副本里的陈旧 5000 不提交。
    expect(client.saveKnowledgeSettings).toHaveBeenLastCalledWith({
      expected_revision: 1,
      model_name: null,
      auto_enabled: false,
      context_budget: 4096,
    });
    expect(store.getState().knowledgeModelEditor?.modelName).toBe("unsaved-global");
    expect(await store.getState().saveKnowledgeModel()).toBe(true);
    expect(client.saveKnowledgeSettings).toHaveBeenLastCalledWith({
      expected_revision: 2,
      model_name: "unsaved-global",
      auto_enabled: false,
      context_budget: 4096,
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
    expect(store.getState().settingsRoute).toBe("expression");
    store.getState().requestPageNavigation("settings", "general");
    expect(store.getState().navigationConfirmOpen).toBe(true);
    expect(store.getState().settingsRoute).toBe("expression");
    store.getState().cancelPendingNavigation();
    expect(store.getState().pageEditor?.draft.name).toBe("draft");
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
    store.getState().openSettingsRoute("context");
    expect(store.getState().navigationConfirmOpen).toBe(false);
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
      expect(store.getState().pageEditor?.draft.name).toBe("retained draft");
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
    store.getState().openSettingsRoute("context");
    expect(store.getState().pendingNavigation).toMatchObject({ settingsRoute: "context" });
    await store.getState().confirmDiscardAndContinue();
    expect(store.getState().settingsRoute).toBe("context");
    expect(store.getState().pageEditor?.draft.name).toBe("assistant draft");
    expect(client.updateAgent).not.toHaveBeenCalled();
    expect(store.getState().settingsView).toBe("workspace");
    store.setState({ knowledgeDirty: true, settingsRoute: "context" });
    store.getState().openSettingsRoute("management");
    expect(store.getState().pendingNavigation).toMatchObject({ settingsRoute: "models" });
    store.getState().cancelPendingNavigation();
    expect(store.getState().settingsRoute).toBe("context");
    expect(store.getState().knowledgeDirty).toBe(true);
  });

  it.each(["save", "discard"] as const)("记忆纠正%s后切页保留其他配置草稿", async (choice) => {
    store.getState().patchPageAgent("long-memory", {
      memory_consolidation_prompt: "unsaved config",
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
      expect(store.getState().pageEditor?.draft.memory_consolidation_prompt).toBe("unsaved config");
      expect(client.updateAgent).not.toHaveBeenCalled();
      expect(save).toHaveBeenCalledTimes(choice === "save" ? 1 : 0);
    } finally {
      store.setState({ saveMemoryCorrection: originalSave });
    }
  });
});

describe("memory reading text settings", () => {
  it("saves a single allowance without touching legacy prompts or other task drafts", async () => {
    store.getState().openSettingsRoute("memory-tools");
    await act(async () => render(<AgentMaterials />));
    const originalPresets = structuredClone(persisted.p5_config.retrieval_presets);
    const originalPrompt = persisted.memory_retrieval_prompt;
    store.getState().patchPageAgent("models", { model_name: "unsaved model" });
    store
      .getState()
      .patchPageAgent("long-memory", { memory_consolidation_prompt: "unsaved maintenance" });
    fireEvent.change(screen.getByLabelText("记忆工具读取额度"), { target: { value: "2048" } });
    expect(await store.getState().saveSettingsPage("memory-tools")).toBe(true);
    expect(persisted.p5_config.memory_read).toEqual({ enabled: true, max_bytes: 2048 });
    expect(persisted.p5_config.retrieval_presets).toEqual(originalPresets);
    expect(persisted.memory_retrieval_prompt).toBe(originalPrompt);
    expect(persisted.model_name).toBe("model");
    expect(store.getState().pageEditor?.draft.model_name).toBe("unsaved model");
    expect(store.getState().pageEditor?.draft.memory_consolidation_prompt).toBe(
      "unsaved maintenance",
    );
    expect(dirtyPages(store.getState().pageEditor)).toEqual(["models", "long-memory"]);
  });
  it("keeps the allowance after a save conflict and discards only the memory page", async () => {
    store.getState().openSettingsRoute("memory-tools");
    await act(async () => render(<AgentMaterials />));
    fireEvent.change(screen.getByLabelText("记忆工具读取额度"), { target: { value: "2048" } });
    vi.mocked(client.updateAgent).mockRejectedValueOnce(new Error("conflict"));
    expect(await store.getState().saveSettingsPage("memory-tools")).toBe(false);
    expect(store.getState().pageEditor?.draft.p5_config.memory_read?.max_bytes).toBe(2048);
    expect(dirtyPages(store.getState().pageEditor)).toContain("memory-tools");
    store.getState().patchPageAgent("basic", { name: "kept basic draft" });
    store.getState().discardSettingsPages("memory-tools");
    expect(store.getState().pageEditor?.draft.p5_config.memory_read).toEqual(
      persisted.p5_config.memory_read,
    );
    expect(store.getState().pageEditor?.draft.name).toBe("kept basic draft");
  });
  it("accepts the documented upper bound and rejects values beyond it without a write", async () => {
    const persist = client.updateAgent;
    client.updateAgent = vi.fn(async (id, body) =>
      persist(id, UpdateAgentRequestSchema.parse(body)),
    );
    store.getState().openSettingsRoute("memory-tools");
    await act(async () => render(<AgentMaterials />));
    const bytes = screen.getByLabelText("记忆工具读取额度");
    fireEvent.change(bytes, { target: { value: "1048576" } });
    expect(await store.getState().saveSettingsPage("memory-tools")).toBe(true);
    fireEvent.change(bytes, { target: { value: "1048577" } });
    const calls = vi.mocked(client.updateAgent).mock.calls.length;
    expect(await store.getState().saveSettingsPage("memory-tools")).toBe(false);
    expect(vi.mocked(client.updateAgent).mock.calls.length).toBe(calls);
    expect(store.getState().pageEditor?.draft.p5_config.memory_read?.max_bytes).toBe(1048576);
  });
});
describe("memory allowance persistence and context draft isolation", () => {
  it("saves edited bytes while retaining independent context draft", async () => {
    store.getState().openSettingsRoute("memory-tools");
    await act(async () => render(<AgentMaterials />));
    store
      .getState()
      .patchPageAgent("context", { p5_config: { ...persisted.p5_config, context_window: 24576 } });
    fireEvent.change(screen.getByLabelText("记忆工具读取额度"), { target: { value: "32768" } });
    expect(dirtyPages(store.getState().pageEditor)).toEqual(["memory-tools", "context"]);
    expect(await store.getState().saveSettingsPage("memory-tools")).toBe(true);
    expect(persisted.p5_config.memory_read?.max_bytes).toBe(32768);
    expect(store.getState().pageEditor?.draft.p5_config.context_window).toBe(24576);
    expect(dirtyPages(store.getState().pageEditor)).toEqual(["context"]);
  });
  it("blocks invalid bytes and discards them without discarding context draft", async () => {
    store.getState().openSettingsRoute("memory-tools");
    await act(async () => render(<AgentMaterials />));
    store
      .getState()
      .patchPageAgent("context", { p5_config: { ...persisted.p5_config, context_window: 28000 } });
    fireEvent.change(screen.getByLabelText("记忆工具读取额度"), { target: { value: "-5" } });
    const callsBefore = vi.mocked(client.updateAgent).mock.calls.length;
    expect(await store.getState().saveSettingsPage("memory-tools")).toBe(false);
    expect(vi.mocked(client.updateAgent).mock.calls.length).toBe(callsBefore);
    await act(async () => store.getState().discardSettingsPages("memory-tools"));
    expect(store.getState().pageEditor?.draft.p5_config.memory_read).toEqual(
      persisted.p5_config.memory_read,
    );
    expect(store.getState().pageEditor?.draft.p5_config.context_window).toBe(28000);
    expect(dirtyPages(store.getState().pageEditor)).toEqual(["context"]);
  });
});
