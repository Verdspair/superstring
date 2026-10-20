// 模型用途所有权：models 页白名单隔离、QQ 判断模型保存独立、models 页 CAS 冲突保脏稿、全局知识预算与全局辅助分配独立保存。
import { act, cleanup, fireEvent, render as renderView, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentResponseSchema, PersonaResponseSchema } from "../../src/shared/contracts";
import type { QqSettingsResponse } from "../../src/shared/contracts/qq";
import type { SuperstringApi } from "../../src/web/api";
import { DesignSystemProvider } from "../../src/web/design-system/Providers";
import { newPageEditor } from "../../src/web/features/agents/page-drafts";
import { selectLocale } from "../../src/web/i18n";
import { AgentModelPurpose } from "../../src/web/screens/environment/AgentModelPurpose";
import { useSuperstringStore as store } from "../../src/web/store";

const render = (...[ui, options]: Parameters<typeof renderView>) =>
  renderView(ui, { wrapper: DesignSystemProvider, ...options });

const agent = AgentResponseSchema.parse({
  id: "agent-owner",
  name: "Owner agent",
  model_name: "chat-model",
  temperature: 0.7,
  memory_consolidation_model_name: "org-model",
  memory_retrieval_model_name: "retrieval-model",
  context_compression_model_name: "compression-model",
  config_version: 7,
  persona_intensity: 60,
  created_at: "2026-10-18T00:00:00.000Z",
  updated_at: "2026-10-18T00:00:00.000Z",
});
const persona = PersonaResponseSchema.parse({
  id: "persona-owner",
  agent_id: agent.id,
  core_identity: "",
  communication_style: "",
  interaction_boundaries: "",
  example_dialogues: "",
  advanced_instructions: "",
  created_at: "2026-10-18T00:00:00.000Z",
  updated_at: "2026-10-18T00:00:00.000Z",
});
const qqSettings = (revision: number, judgement: string | null = null): QqSettingsResponse => ({
  enabled: true,
  account_id: "10001",
  judgement_model_name: judgement,
  transport: { endpoint: "ws://127.0.0.1:3000/", has_token: true },
  revision,
});

function prepareAgent(api: SuperstringApi) {
  store.getState().resetForTests(api);
  store.setState({
    agents: [agent],
    editorAgentId: agent.id,
    pageEditor: newPageEditor(agent, persona),
  });
}

beforeEach(() => {
  selectLocale("zh-CN");
});
afterEach(() => {
  cleanup();
  store.getState().resetForTests();
});

describe("model purposes ownership", () => {
  it("models page UI input and save submits exactly the models whitelist and leaves other pages' drafts intact", async () => {
    const updateAgent = vi.fn(async (_id: string, body: unknown) => {
      const { expected_version: _expectedVersion, ...changes } = body as Record<string, unknown>;
      return AgentResponseSchema.parse({ ...agent, ...changes, config_version: 8 });
    });
    prepareAgent({
      updateAgent,
      getOrganizationSettings: vi.fn().mockResolvedValue({
        model_name: "global-default",
        vision_model_name: null,
        transcription_model_name: null,
        auxiliary_allocation: {},
        revision: 1,
      }),
      listModels: vi.fn().mockResolvedValue({ models: ["chat-model", "ui-edited-chat-model"] }),
    } as unknown as SuperstringApi);

    // context 页草稿改动在 models 保存时不得连坐提交，也不得被回滚
    const draft = store.getState().pageEditor?.draft;
    expect(draft).not.toBeNull();
    store.getState().patchPageAgent("context", {
      p5_config: { ...draft!.p5_config, context_window: 32768 },
    });

    render(<AgentModelPurpose active={true} />);
    await act(async () => {});

    // 真实 UI 输入：修改对话模型与温度
    const chatModelInput = screen.getByDisplayValue("chat-model");
    fireEvent.change(chatModelInput, { target: { value: "ui-edited-chat-model" } });

    const tempInput = screen.getByDisplayValue("0.7");
    fireEvent.change(tempInput, { target: { value: "0.45" } });

    // 点击真实 UI 保存按钮
    const saveButton = screen.getByRole("button", { name: "保存修改" });
    await act(async () => {
      fireEvent.click(saveButton);
    });

    expect(updateAgent).toHaveBeenCalledExactlyOnceWith(agent.id, {
      expected_version: 7,
      model_name: "ui-edited-chat-model",
      temperature: 0.45,
      memory_consolidation_model_name: "org-model",
      memory_retrieval_model_name: "retrieval-model",
      context_compression_model_name: "compression-model",
    });

    const payload = vi.mocked(updateAgent).mock.calls[0][1] as Record<string, unknown>;
    expect(payload).not.toHaveProperty("p5_config");
    expect(payload).not.toHaveProperty("memory_retrieval_prompt");
    // 未保存的 context 页草稿在 models 保存后仍然保留
    expect(store.getState().pageEditor?.draft.p5_config.context_window).toBe(32768);
    expect(store.getState().pageEditor?.agent.model_name).toBe("ui-edited-chat-model");
  });

  it("QQ judgement model instant save touches only QQ settings and null returns to bound-agent follow", async () => {
    const updateQqSettings = vi.fn(async (body: { judgement_model_name?: string | null }) =>
      qqSettings(6, body.judgement_model_name ?? null),
    );
    const fake = {
      updateAgent: vi.fn(),
      saveOrganizationSettings: vi.fn(),
      saveKnowledgeSettings: vi.fn(),
      updateQqSettings,
    } as unknown as SuperstringApi;
    store.getState().resetForTests(fake);
    store.setState({ qqSettings: qqSettings(5) });

    await act(async () => {
      expect(await store.getState().saveQqJudgementModel("judge-model")).toBe(true);
    });
    expect(updateQqSettings).toHaveBeenCalledExactlyOnceWith({
      judgement_model_name: "judge-model",
      expected_revision: 5,
    });
    await act(async () => {
      expect(await store.getState().saveQqJudgementModel(null)).toBe(true);
    });
    expect(updateQqSettings).toHaveBeenLastCalledWith({
      judgement_model_name: null,
      expected_revision: 6,
    });
    expect(store.getState().qqSettings?.judgement_model_name).toBeNull();
    expect(store.getState().qqSettings?.revision).toBe(6);
    // 判断模型保存不写 Agent、组织或知识设置（各自 owner 独立）
    expect(fake.updateAgent).not.toHaveBeenCalled();
    expect(fake.saveOrganizationSettings).not.toHaveBeenCalled();
    expect(fake.saveKnowledgeSettings).not.toHaveBeenCalled();
  });

  it("keeps the models page dirty draft and reports the error when the CAS save conflicts", async () => {
    const updateAgent = vi
      .fn()
      .mockRejectedValue(new Error("expected config_version 7, got 8 (conflict)"));
    prepareAgent({ updateAgent } as unknown as SuperstringApi);
    store.getState().patchPageAgent("models", { model_name: "new-chat-model" });

    const saved = await store.getState().saveSettingsPage("models");
    expect(saved).toBe(false);
    // 脏稿保留：草稿仍是编辑值，已存基线未推进，错误与保留提示落 state
    expect(store.getState().pageEditor?.draft.model_name).toBe("new-chat-model");
    expect(store.getState().pageEditor?.agent.config_version).toBe(7);
    expect(store.getState().error).toContain("conflict");
    expect(store.getState().feedback).toContain("未保存内容仍在草稿中");
  });

  it("global knowledge budget save touches only knowledge settings and leaves models draft and agent drafts intact", async () => {
    const saveKnowledgeSettings = vi.fn().mockResolvedValue({
      model_name: null,
      context_budget: 8192,
      auto_enabled: false,
      revision: 2,
    });
    const updateAgent = vi.fn();
    const saveOrganizationSettings = vi.fn();
    const fake = {
      updateAgent,
      saveOrganizationSettings,
      saveKnowledgeSettings,
    } as unknown as SuperstringApi;
    prepareAgent(fake);

    store.getState().patchPageAgent("models", { model_name: "dirty-chat-model" });

    store.setState({
      knowledgeModelEditor: {
        source: {
          model_name: null,
          context_budget: 4096,
          auto_enabled: false,
          revision: 1,
        },
        model_name: null,
        context_budget: 8192,
        contextBudget: 8192,
        auto_enabled: false,
      } as any,
    });

    await act(async () => {
      const ok = await store.getState().saveKnowledgeModel("budget");
      expect(ok).toBe(true);
    });

    expect(saveKnowledgeSettings).toHaveBeenCalledExactlyOnceWith({
      auto_enabled: false,
      model_name: null,
      context_budget: 8192,
      expected_revision: 1,
    });
    // 不越权保存 Agent 或组织草稿
    expect(updateAgent).not.toHaveBeenCalled();
    expect(saveOrganizationSettings).not.toHaveBeenCalled();
    // models 页草稿安全保留
    expect(store.getState().pageEditor?.draft.model_name).toBe("dirty-chat-model");
  });

  it("global auxiliary allocation save submits only organization settings and does not touch agent settings", async () => {
    const saveOrganizationSettings = vi.fn().mockResolvedValue({
      model_name: "global-default",
      vision_model_name: "vision-model",
      transcription_model_name: null,
      auxiliary_allocation: {
        knowledge_organize: { mode: "auto", input_limit: 8000, output_reserved: 2048 },
      },
      revision: 3,
    });
    const updateAgent = vi.fn();
    const fake = {
      updateAgent,
      saveOrganizationSettings,
    } as unknown as SuperstringApi;
    prepareAgent(fake);

    store.setState({
      organizationEditor: {
        source: {
          model_name: "global-default",
          vision_model_name: "vision-model",
          transcription_model_name: null,
          auxiliary_allocation: {},
          revision: 2,
        },
        model_name: "global-default",
        vision_model_name: "vision-model",
        transcription_model_name: null,
        auxiliaryAllocation: {
          knowledge_organize: { mode: "auto", input_limit: 8000, output_reserved: 2048 },
        },
      } as any,
    });

    await act(async () => {
      // 真实 store action: saveOrganization("allocation")
      const ok = await store.getState().saveOrganization("allocation");
      expect(ok).toBe(true);
    });

    expect(saveOrganizationSettings).toHaveBeenCalledExactlyOnceWith({
      auxiliary_allocation: {
        knowledge_organize: { mode: "auto", input_limit: 8000, output_reserved: 2048 },
      },
      expected_revision: 2,
    });
    expect(updateAgent).not.toHaveBeenCalled();
  });

  it("AgentModelPurpose consumes loadOrganization on mount without redundant duplicate requests", async () => {
    const getOrganizationSettings = vi.fn().mockResolvedValue({
      model_name: "global-default",
      vision_model_name: "vision-model",
      transcription_model_name: null,
      auxiliary_allocation: {},
      revision: 1,
    });
    const fake = {
      getOrganizationSettings,
      listModels: vi.fn().mockResolvedValue({ models: ["chat-model", "global-default"] }),
    } as unknown as SuperstringApi;
    prepareAgent(fake);

    render(<AgentModelPurpose active={true} />);

    await act(async () => {});
    expect(getOrganizationSettings).toHaveBeenCalledTimes(1);
  });
});
