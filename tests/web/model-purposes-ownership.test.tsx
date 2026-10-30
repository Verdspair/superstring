// 模型用途所有权：models 页白名单隔离、QQ 判断模型保存独立、models 页 CAS 冲突保脏稿、全局知识预算与全局辅助分配独立保存。
import {
  act,
  cleanup,
  fireEvent,
  render as renderView,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentResponseSchema, PersonaResponseSchema } from "../../src/shared/contracts";
import type { QqSettingsResponse } from "../../src/shared/contracts/qq";
import type { SuperstringApi } from "../../src/web/api";
import { DesignSystemProvider } from "../../src/web/design-system/Providers";
import { newPageEditor } from "../../src/web/features/agents/page-drafts";
import { selectLocale } from "../../src/web/i18n";
import { AllocationModelCapacity } from "../../src/web/screens/connections/AllocationModelCapacity";
import { AgentModelPurpose } from "../../src/web/screens/environment/AgentModelPurpose";
import { ModelPurposes } from "../../src/web/screens/environment/ModelPurposes";
import { ModelDefaults } from "../../src/web/screens/environment/model-defaults";
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
  vi.restoreAllMocks();
  cleanup();
  store.getState().resetForTests();
});

describe("model purposes ownership", () => {
  it("does not save a private knowledge model draft through a replacement API before loading its baseline", async () => {
    const source = {
      revision: 1,
      model_name: "old-model",
      context_budget: 4096,
      auto_enabled: true,
    };
    prepareAgent({ getKnowledgeSettings: vi.fn(async () => source) } as unknown as SuperstringApi);
    await store.getState().loadKnowledgeModel();
    store.getState().patchKnowledgeGlobal({ contextBudget: 8192 });
    const saveKnowledgeSettings = vi.fn();
    store.setState({ apiClient: { saveKnowledgeSettings } as unknown as SuperstringApi });
    expect(await store.getState().saveKnowledgeModel("budget")).toBe(false);
    expect(saveKnowledgeSettings).not.toHaveBeenCalled();
    expect(store.getState().knowledgeModelEditor?.source.revision).toBe(1);
    expect(store.getState().knowledgeModelEditor?.contextBudget).toBe(8192);
  });
  it("switching a retained defaults pane releases only its acquired scope while another organization subscriber stays live", async () => {
    let signal!: AbortSignal;
    let finish!: (value: Awaited<ReturnType<SuperstringApi["getOrganizationSettings"]>>) => void;
    const getOrganizationSettings = vi.fn((input?: AbortSignal) => {
      signal = input!;
      return new Promise<Awaited<ReturnType<SuperstringApi["getOrganizationSettings"]>>>(
        (resolve) => {
          finish = resolve;
        },
      );
    });
    const getKnowledgeSettings = vi.fn(async () => ({
      revision: 1,
      model_name: null,
      context_budget: 2048,
      auto_enabled: true,
    }));
    prepareAgent({ getOrganizationSettings, getKnowledgeSettings } as unknown as SuperstringApi);
    const view = render(
      <>
        <AgentModelPurpose active />
        <ModelDefaults scope="organization" active />
      </>,
    );
    await vi.waitFor(() => expect(getOrganizationSettings).toHaveBeenCalledTimes(1));
    view.rerender(
      <>
        <AgentModelPurpose active />
        <ModelDefaults scope="knowledge" active />
      </>,
    );
    expect(signal.aborted).toBe(false);
    await vi.waitFor(() => expect(getKnowledgeSettings).toHaveBeenCalledTimes(1));
    finish({
      revision: 1,
      model_name: "retained",
      vision_model_name: null,
      transcription_model_name: null,
    });
    await vi.waitFor(() =>
      expect(store.getState().organizationEditor?.source.model_name).toBe("retained"),
    );
    expect(store.getState().organizationLoading).toBe(false);
  });
  it("an inactive retained global quota host cannot cancel the active knowledge model read", async () => {
    let signal!: AbortSignal;
    let finish!: (value: Awaited<ReturnType<SuperstringApi["getKnowledgeSettings"]>>) => void;
    const getKnowledgeSettings = vi.fn((input?: AbortSignal) => {
      signal = input!;
      return new Promise<Awaited<ReturnType<SuperstringApi["getKnowledgeSettings"]>>>((resolve) => {
        finish = resolve;
      });
    });
    prepareAgent({ getKnowledgeSettings } as unknown as SuperstringApi);
    render(
      <>
        <ModelDefaults scope="knowledge" active />
        <ModelPurposes active={false} />
      </>,
    );
    await vi.waitFor(() => expect(signal).toBeDefined());
    expect(signal.aborted).toBe(false);
    finish({ revision: 1, model_name: "saved", context_budget: 2048, auto_enabled: true });
    await vi.waitFor(() =>
      expect(store.getState().knowledgeModelEditor?.source.model_name).toBe("saved"),
    );
    expect(getKnowledgeSettings).toHaveBeenCalledTimes(1);
  });
  it("retained inactive model hosts do not cancel the active Agent default request during API replacement", async () => {
    let signal!: AbortSignal;
    let finish!: (value: Awaited<ReturnType<SuperstringApi["getOrganizationSettings"]>>) => void;
    const getOrganizationSettings = vi.fn((input?: AbortSignal) => {
      signal = input!;
      return new Promise<Awaited<ReturnType<SuperstringApi["getOrganizationSettings"]>>>(
        (resolve) => {
          finish = resolve;
        },
      );
    });
    prepareAgent({ getOrganizationSettings } as unknown as SuperstringApi);
    const view = render(
      <>
        <AgentModelPurpose active />
        <ModelDefaults active={false} />
      </>,
    );
    await vi.waitFor(() => expect(signal).toBeDefined());
    expect(signal.aborted).toBe(false);
    view.rerender(
      <>
        <AgentModelPurpose active />
        <ModelDefaults active={false} />
      </>,
    );
    expect(signal.aborted).toBe(false);
    finish({
      revision: 1,
      model_name: "saved",
      vision_model_name: null,
      transcription_model_name: null,
    });
    await vi.waitFor(() =>
      expect(store.getState().organizationEditor?.source.model_name).toBe("saved"),
    );
    const replacement = {
      getOrganizationSettings: vi.fn(async () => ({
        revision: 2,
        model_name: "new",
        vision_model_name: null,
        transcription_model_name: null,
      })),
    } as unknown as SuperstringApi;
    act(() => store.setState({ apiClient: replacement }));
    await vi.waitFor(() =>
      expect(store.getState().organizationEditor?.source.model_name).toBe("new"),
    );
    expect(replacement.getOrganizationSettings).toHaveBeenCalledTimes(1);
    expect(store.getState().organizationLoading).toBe(false);
  });
  it("standalone capacity never displays an old API value while the same model is pending on a replacement", async () => {
    const first = {
      getModelCapacity: vi.fn(async () => ({
        model: "same",
        status: "loaded" as const,
        context_length: 128000,
      })),
    } as unknown as SuperstringApi;
    prepareAgent(first);
    render(<AllocationModelCapacity model="same" />);
    expect(await screen.findByText(/128000/)).toBeTruthy();
    let finish!: (value: Awaited<ReturnType<SuperstringApi["getModelCapacity"]>>) => void;
    const getModelCapacity = vi.fn(
      (_model: string, _signal?: AbortSignal) =>
        new Promise<Awaited<ReturnType<SuperstringApi["getModelCapacity"]>>>((resolve) => {
          finish = resolve;
        }),
    );
    act(() => store.setState({ apiClient: { getModelCapacity } as unknown as SuperstringApi }));
    expect(screen.queryByText(/128000/)).toBeNull();
    await vi.waitFor(() => expect(getModelCapacity).toHaveBeenCalledTimes(1));
    await act(async () => {
      finish({ model: "same", status: "loaded", context_length: 64000 });
    });
    expect(await screen.findByText(/64000/)).toBeTruthy();
    expect(getModelCapacity).toHaveBeenCalledTimes(1);
  });
  it("standalone capacity obeys real document visibility and leaves controlled QQ values transport-free", async () => {
    let hidden = true;
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() =>
      hidden ? "hidden" : "visible",
    );
    let signal!: AbortSignal;
    let finish!: (value: Awaited<ReturnType<SuperstringApi["getModelCapacity"]>>) => void;
    const getModelCapacity = vi
      .fn()
      .mockImplementationOnce((_model: string, input?: AbortSignal) => {
        signal = input!;
        return new Promise((resolve) => {
          finish = resolve;
        });
      })
      .mockResolvedValue({ model: "same", status: "loaded", context_length: 64000 });
    prepareAgent({ getModelCapacity } as unknown as SuperstringApi);
    const view = render(<AllocationModelCapacity model="same" />);
    await act(async () => {});
    expect(getModelCapacity).not.toHaveBeenCalled();
    hidden = false;
    fireEvent(document, new Event("visibilitychange"));
    await vi.waitFor(() => expect(signal).toBeDefined());
    hidden = true;
    fireEvent(document, new Event("visibilitychange"));
    expect(signal.aborted).toBe(true);
    finish({ model: "same", status: "loaded", context_length: 128000 });
    await act(async () => {});
    expect(screen.queryByText(/128000/)).toBeNull();
    hidden = false;
    fireEvent(document, new Event("visibilitychange"));
    expect(await screen.findByText(/64000/)).toBeTruthy();
    fireEvent(window, new Event("blur"));
    fireEvent(window, new Event("focus"));
    expect(getModelCapacity).toHaveBeenCalledTimes(2);
    view.rerender(<AllocationModelCapacity model="controlled" capacity={32000} />);
    expect(screen.getByText(/32000/)).toBeTruthy();
    expect(getModelCapacity).toHaveBeenCalledTimes(2);
  });
  it("rejects an old API organization model draft before the replacement baseline is loaded", async () => {
    const value = {
      revision: 1,
      model_name: "old-default",
      vision_model_name: null,
      transcription_model_name: null,
    };
    prepareAgent({
      getOrganizationSettings: vi.fn(async () => value),
    } as unknown as SuperstringApi);
    await store.getState().loadOrganization();
    store.getState().patchOrganization("old private draft");
    const saveOrganizationSettings = vi.fn();
    act(() =>
      store.setState({ apiClient: { saveOrganizationSettings } as unknown as SuperstringApi }),
    );
    expect(await store.getState().saveOrganization("organization-model")).toBe(false);
    expect(saveOrganizationSettings).not.toHaveBeenCalled();
  });
  it("ModelDefaults takes over a pending old API read and never saves its old private draft through the replacement", async () => {
    let finishOld!: (value: Awaited<ReturnType<SuperstringApi["getOrganizationSettings"]>>) => void;
    let oldSignal!: AbortSignal;
    const initial = {
      revision: 1,
      model_name: "old",
      vision_model_name: null,
      transcription_model_name: null,
    };
    const oldClient = {
      getOrganizationSettings: vi.fn((signal?: AbortSignal) => {
        oldSignal = signal!;
        return new Promise<Awaited<ReturnType<SuperstringApi["getOrganizationSettings"]>>>(
          (resolve) => {
            finishOld = resolve;
          },
        );
      }),
      saveOrganizationSettings: vi.fn(),
    } as unknown as SuperstringApi;
    prepareAgent(oldClient);
    render(<ModelDefaults scope="organization" active />);
    await vi.waitFor(() => expect(oldSignal).toBeDefined());
    const replacement = {
      getOrganizationSettings: vi.fn(async () => ({ ...initial, model_name: "new", revision: 2 })),
      saveOrganizationSettings: vi.fn(),
    } as unknown as SuperstringApi;
    act(() => store.setState({ apiClient: replacement }));
    await vi.waitFor(() =>
      expect(store.getState().organizationEditor?.source.model_name).toBe("new"),
    );
    expect(oldSignal.aborted).toBe(true);
    finishOld(initial);
    await act(async () => {});
    expect(store.getState().organizationEditor?.modelName).toBe("new");
    expect(replacement.saveOrganizationSettings).not.toHaveBeenCalled();
  });
  it("ModelDefaults true hidden entry does not read and becoming visible reads once without blur polling", async () => {
    let hidden = true;
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() =>
      hidden ? "hidden" : "visible",
    );
    const getOrganizationSettings = vi.fn(async () => ({
      revision: 1,
      model_name: "default",
      vision_model_name: null,
      transcription_model_name: null,
    }));
    prepareAgent({ getOrganizationSettings } as unknown as SuperstringApi);
    render(<ModelDefaults scope="organization" active />);
    await act(async () => {});
    expect(getOrganizationSettings).not.toHaveBeenCalled();
    hidden = false;
    fireEvent(document, new Event("visibilitychange"));
    await vi.waitFor(() => expect(getOrganizationSettings).toHaveBeenCalledTimes(1));
    fireEvent(window, new Event("blur"));
    fireEvent(window, new Event("focus"));
    expect(getOrganizationSettings).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
  });
  it("AgentModelPurpose uses the saved default rather than an unsaved organization model and cancels a stale API confirmation", async () => {
    const initial = {
      revision: 1,
      model_name: "saved-default",
      vision_model_name: null,
      transcription_model_name: null,
    };
    const old = {
      getOrganizationSettings: vi.fn(async () => initial),
      updateAgent: vi.fn(),
    } as unknown as SuperstringApi;
    prepareAgent(old);
    await store.getState().loadOrganization();
    store.getState().patchOrganization("private-unsaved-default");
    render(<AgentModelPurpose active />);
    await act(async () => {});
    const apply = screen.getByRole("button", { name: /saved-default/ });
    fireEvent.click(apply);
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    const replacement = {
      getOrganizationSettings: vi.fn(async () => ({
        ...initial,
        revision: 3,
        model_name: "new-default",
      })),
      updateAgent: vi.fn(),
    } as unknown as SuperstringApi;
    act(() => store.setState({ apiClient: replacement }));
    await vi.waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(old.updateAgent).not.toHaveBeenCalled();
    expect(replacement.updateAgent).not.toHaveBeenCalled();
    expect(store.getState().organizationEditor?.modelName).not.toBe("private-unsaved-default");
  });
  it("organization refresh merges each edited role and field without turning untouched QQ values dirty", async () => {
    const initial = {
      revision: 1,
      model_name: "global",
      vision_model_name: null,
      transcription_model_name: null,
      auxiliary_allocation: {
        knowledge_organize: { mode: "fixed" as const, input_limit: 100, output_reserved: 200 },
        qq_sticker_annotate: { mode: "fixed" as const, input_limit: 300 },
      },
    };
    const remote = {
      ...initial,
      revision: 2,
      auxiliary_allocation: {
        knowledge_organize: { mode: "fixed" as const, input_limit: 100, output_reserved: 250 },
        qq_sticker_annotate: { mode: "auto" as const, input_limit: 900 },
      },
    };
    const getOrganizationSettings = vi
      .fn()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(remote);
    const saveOrganizationSettings = vi.fn(
      async (body: Parameters<SuperstringApi["saveOrganizationSettings"]>[0]) => ({
        ...remote,
        revision: 3,
        auxiliary_allocation: body.auxiliary_allocation,
      }),
    );
    prepareAgent({
      getOrganizationSettings,
      saveOrganizationSettings,
    } as unknown as SuperstringApi);
    await store.getState().loadOrganization();
    store.getState().patchOrganizationAllocation({
      ...initial.auxiliary_allocation,
      knowledge_organize: {
        ...initial.auxiliary_allocation.knowledge_organize,
        input_limit: 150,
      },
    });
    await store.getState().loadOrganization(true);
    expect(store.getState().organizationEditor?.auxiliaryAllocation).toEqual({
      knowledge_organize: { mode: "fixed", input_limit: 150, output_reserved: 250 },
      qq_sticker_annotate: { mode: "auto", input_limit: 900 },
    });
    expect(await store.getState().saveOrganization("allocation", ["knowledge_organize"])).toBe(
      true,
    );
    expect(saveOrganizationSettings.mock.calls[0][0]).toEqual({
      expected_revision: 2,
      auxiliary_allocation: {
        knowledge_organize: { mode: "fixed", input_limit: 150, output_reserved: 250 },
        qq_sticker_annotate: { mode: "auto", input_limit: 900 },
      },
    });
  });
  it("organization refresh preserves an explicit local role deletion while adopting other remote roles", async () => {
    const initial = {
      revision: 1,
      model_name: null,
      vision_model_name: null,
      transcription_model_name: null,
      auxiliary_allocation: {
        knowledge_organize: { mode: "fixed" as const },
        qq_sticker_annotate: { mode: "fixed" as const, input_limit: 300 },
      },
    };
    const remote = {
      ...initial,
      revision: 2,
      auxiliary_allocation: {
        ...initial.auxiliary_allocation,
        qq_sticker_annotate: { mode: "auto" as const, input_limit: 900 },
      },
    };
    prepareAgent({
      getOrganizationSettings: vi.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce(remote),
    } as unknown as SuperstringApi);
    await store.getState().loadOrganization();
    store.getState().patchOrganizationAllocation({
      qq_sticker_annotate: initial.auxiliary_allocation.qq_sticker_annotate,
    });
    await store.getState().loadOrganization(true);
    expect(store.getState().organizationEditor?.auxiliaryAllocation).toEqual({
      qq_sticker_annotate: { mode: "auto", input_limit: 900 },
    });
  });
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
    const source = { model_name: null, context_budget: 4096, auto_enabled: false, revision: 1 };
    const saveKnowledgeSettings = vi
      .fn()
      .mockResolvedValue({ ...source, context_budget: 8192, revision: 2 });
    const updateAgent = vi.fn();
    const saveOrganizationSettings = vi.fn();
    const fake = {
      updateAgent,
      saveOrganizationSettings,
      getKnowledgeSettings: vi.fn(async () => source),
      saveKnowledgeSettings,
    } as unknown as SuperstringApi;
    prepareAgent(fake);
    await store.getState().loadKnowledgeModel();
    store.getState().patchPageAgent("models", { model_name: "dirty-chat-model" });
    store.getState().patchKnowledgeModel("dirty-knowledge-model");
    store.getState().patchKnowledgeGlobal({ contextBudget: 8192 });
    await act(async () => {
      expect(await store.getState().saveKnowledgeModel("budget")).toBe(true);
    });
    expect(saveKnowledgeSettings).toHaveBeenCalledExactlyOnceWith({
      auto_enabled: false,
      model_name: null,
      context_budget: 8192,
      expected_revision: 1,
    });
    expect(updateAgent).not.toHaveBeenCalled();
    expect(saveOrganizationSettings).not.toHaveBeenCalled();
    expect(store.getState().pageEditor?.draft.model_name).toBe("dirty-chat-model");
    expect(store.getState().knowledgeModelEditor?.modelName).toBe("dirty-knowledge-model");
    expect(store.getState().knowledgeModelEditor?.source.revision).toBe(2);
    expect(store.getState().knowledgeModelEditor?.source.context_budget).toBe(8192);
  });

  it("global auxiliary allocation save submits only organization settings and does not touch agent settings", async () => {
    const source = {
      model_name: "global-default",
      vision_model_name: "vision-model",
      transcription_model_name: null,
      auxiliary_allocation: {},
      revision: 2,
    };
    const saveOrganizationSettings = vi.fn().mockResolvedValue({
      ...source,
      auxiliary_allocation: {
        knowledge_organize: { mode: "auto", input_limit: 8000, output_reserved: 2048 },
      },
      revision: 3,
    });
    const updateAgent = vi.fn();
    const fake = {
      updateAgent,
      getOrganizationSettings: vi.fn(async () => source),
      saveOrganizationSettings,
    } as unknown as SuperstringApi;
    prepareAgent(fake);
    await store.getState().loadOrganization();
    store.getState().patchOrganizationAllocation({
      knowledge_organize: { mode: "auto", input_limit: 8000, output_reserved: 2048 },
    });
    await act(async () => {
      expect(await store.getState().saveOrganization("allocation")).toBe(true);
    });
    expect(saveOrganizationSettings).toHaveBeenCalledExactlyOnceWith({
      auxiliary_allocation: {
        knowledge_organize: { mode: "auto", input_limit: 8000, output_reserved: 2048 },
      },
      expected_revision: 2,
    });
    expect(store.getState().organizationEditor?.source.revision).toBe(3);
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

it("shows a knowledge-model conflict and exposes explicit baseline refresh in the original default host", async () => {
  let hidden = false;
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() =>
    hidden ? "hidden" : "visible",
  );
  let remote = { revision: 1, auto_enabled: true, context_budget: 2048, model_name: "M1" };
  const getKnowledgeSettings = vi.fn(async () => remote);
  prepareAgent({ getKnowledgeSettings } as unknown as SuperstringApi);
  render(<ModelDefaults active scope="knowledge" />);
  await vi.waitFor(() => expect(store.getState().knowledgeModelEditor?.source.revision).toBe(1));
  act(() => store.getState().patchKnowledgeModel("M2"));
  act(() => {
    hidden = true;
    fireEvent(document, new Event("visibilitychange"));
  });
  remote = { ...remote, revision: 2, model_name: "M3" };
  act(() => {
    hidden = false;
    fireEvent(document, new Event("visibilitychange"));
  });
  await vi.waitFor(() => expect(store.getState().knowledgeModelError.model).toBeTruthy());
  expect(screen.getByRole("alert").textContent).toContain("本地草稿保留");
  expect(store.getState().knowledgeModelEditor?.source.revision).toBe(1);
  fireEvent.click(screen.getByRole("button", { name: "刷新保存基线" }));
  await vi.waitFor(() => expect(store.getState().knowledgeModelEditor?.source.revision).toBe(2));
  expect(store.getState().knowledgeModelEditor?.modelName).toBe("M2");
  expect(store.getState().knowledgeModelEditor?.source.model_name).toBe("M3");
  expect(getKnowledgeSettings).toHaveBeenCalledTimes(3);
  expect(screen.getByRole("alert").textContent).toContain("本地草稿保留");
});

it.each(["zh-CN", "en"] as const)(
  "renders saved auxiliary mode and limits with readable labels in %s without replacing the draft",
  async (locale) => {
    selectLocale(locale);
    const source = {
      revision: 2,
      model_name: "shared",
      vision_model_name: null,
      transcription_model_name: null,
      auxiliary_allocation: {
        knowledge_organize: { mode: "fixed" as const, input_limit: null, output_reserved: 512 },
      },
    };
    prepareAgent({
      getOrganizationSettings: vi.fn(async () => source),
      getKnowledgeSettings: vi.fn(async () => ({
        revision: 1,
        model_name: null,
        auto_enabled: true,
        context_budget: 2048,
      })),
      getModelCapacity: vi.fn(async () => ({
        model: "shared",
        status: "loaded",
        context_length: 64000,
      })),
    } as unknown as SuperstringApi);
    await store.getState().loadOrganization();
    store.getState().patchOrganizationAllocation({
      knowledge_organize: { mode: "auto", input_limit: 200, output_reserved: 1024 },
    });
    store.setState((state) => ({
      contextAllocationTarget: { ...state.contextAllocationTarget, purpose: "aux" },
    }));
    render(<ModelPurposes active />);
    const baseline = screen.getByRole("region", {
      name: locale === "zh-CN" ? "已读取的保存基线" : "Loaded saved baseline",
    });
    expect(baseline.textContent).toContain(locale === "zh-CN" ? "固定" : "Fixed");
    expect(baseline.textContent).toContain(locale === "zh-CN" ? "未设硬上限" : "No hard limit");
    expect(within(baseline).getByText("512")).toBeTruthy();
    expect(baseline.textContent).not.toMatch(/input_limit|output_reserved|"mode"/);
    expect(store.getState().organizationEditor?.auxiliaryAllocation?.knowledge_organize).toEqual({
      mode: "auto",
      input_limit: 200,
      output_reserved: 1024,
    });
  },
);

it("keeps clean system auxiliary settings compact until a role field differs", async () => {
  const source = {
    revision: 1,
    model_name: "shared",
    vision_model_name: null,
    transcription_model_name: null,
    auxiliary_allocation: {
      knowledge_organize: { mode: "fixed" as const, input_limit: 100, output_reserved: 512 },
    },
  };
  prepareAgent({
    getOrganizationSettings: vi.fn(async () => source),
    getKnowledgeSettings: vi.fn(async () => ({
      revision: 1,
      model_name: null,
      auto_enabled: true,
      context_budget: 2048,
    })),
    getModelCapacity: vi.fn(async () => ({
      model: "shared",
      status: "loaded",
      context_length: 64000,
    })),
  } as unknown as SuperstringApi);
  await store.getState().loadOrganization();
  store.setState((state) => ({
    contextAllocationTarget: { ...state.contextAllocationTarget, purpose: "aux" },
  }));
  render(<ModelPurposes active />);
  expect(screen.queryByRole("region", { name: "已读取的保存基线" })).toBeNull();
  act(() =>
    store.getState().patchOrganizationAllocation({
      knowledge_organize: { mode: "fixed", input_limit: 200, output_reserved: 512 },
    }),
  );
  const baseline = screen.getByRole("region", { name: "已读取的保存基线" });
  expect(within(baseline).getByText("100")).toBeTruthy();
  expect(baseline.textContent).not.toContain("512");
  expect(baseline.textContent).not.toContain("分配模式");
});

it("keeps organization and knowledge model controls in the shared row lane", async () => {
  const api = {
    getOrganizationSettings: vi.fn(async () => ({
      revision: 1,
      model_name: null,
      vision_model_name: null,
      transcription_model_name: null,
    })),
    getKnowledgeSettings: vi.fn(async () => ({
      revision: 1,
      model_name: null,
      auto_enabled: true,
      context_budget: 2048,
    })),
  } as unknown as SuperstringApi;
  prepareAgent(api);

  const view = render(<ModelDefaults active scope="organization" />);
  await vi.waitFor(() => expect(screen.getByRole("combobox", { name: "整理模型" })).toBeTruthy());
  const organization = screen.getByRole("combobox", { name: "整理模型" });
  const organizationRow = organization.closest("[class*='settings-content-padding']");
  expect(organizationRow).toBeTruthy();
  expect(organization.className).toContain("sm:w-full");
  expect(organization.className).toContain("sm:min-w-0");
  expect(organization.closest("[class*='flex-1']")).toBeTruthy();

  view.rerender(<ModelDefaults active scope="knowledge" />);
  await vi.waitFor(() =>
    expect(screen.getByRole("combobox", { name: "知识整理模型" })).toBeTruthy(),
  );
  const knowledge = screen.getByRole("combobox", { name: "知识整理模型" });
  expect(knowledge.className).toContain("sm:w-full");
  expect(knowledge.className).toContain("sm:min-w-0");
  expect(knowledge.closest("[class*='flex-1']")).toBeTruthy();
  expect(knowledge.getAttribute("aria-expanded")).toBe("false");
});
