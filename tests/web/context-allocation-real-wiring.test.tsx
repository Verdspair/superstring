// 统一上下文分配真实接线（0068）：真实 store + 仅 mock API，不替换任何动作。
// 六个用例覆盖：全局辅助分配部分 PUT 与 409 保稿、记忆读取预算白名单保存、
// QQ 本群 headroom 稀疏保存/非法原文/恢复跟随、脏稿换对象取消守卫、
// 非法原文跨卸载持久与保存拦阻。Root 只用相对导入，无本地路径。

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AgentResponse,
  AgentResponseSchema,
  PersonaResponseSchema,
} from "../../src/shared/contracts";
import type { OrganizationSettings } from "../../src/shared/contracts/organization";
import type { QqBindingResponse, QqSchemeResponse } from "../../src/shared/contracts/qq";
import {
  mergeQqGroupScheme,
  type QqGroupConfigResponse,
  type UpdateQqGroupConfigRequest,
} from "../../src/shared/contracts/qq-group-config";
import { ApiError, type api } from "../../src/web/api";
import { DesignSystemProvider } from "../../src/web/design-system/Providers";

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
const setContextAllocationTarget = (
  target: Partial<import("../../src/web/features/context-allocation").ContextAllocationTarget>,
) =>
  store.setState((state) => ({
    contextAllocationTarget: { ...state.contextAllocationTarget, ...target },
  }));

import { qqGroupConfigEditorFrom } from "../../src/web/features/qq/group-config-state";
import { selectLocale } from "../../src/web/i18n";
import { AssistantWorkspace } from "../../src/web/screens/assistants/AssistantWorkspace";
import { QqGroupConfigPage } from "../../src/web/screens/connections/group-config";
import { ModelPurposes } from "../../src/web/screens/environment/ModelPurposes";
import { useSuperstringStore as store } from "../../src/web/store";
import { NavigationGuard } from "../../src/web/workspace/NavigationGuard";

/** 显式 tooltip（保存按钮/字段帮助）必须挂在真实 DesignSystemProvider 下渲染。 */
const renderView = (...[ui, options]: Parameters<typeof render>) =>
  render(ui, { wrapper: DesignSystemProvider, ...options });

const NOW = "2026-10-16T15:00:00.000Z";
const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_B_ID = "22222222-2222-4222-8222-222222222222";
const SCHEME_ID = "33333333-3333-4333-8333-333333333333";
const BINDING_ID = "44444444-4444-4444-8444-444444444444";

const persona = PersonaResponseSchema.parse({
  id: "55555555-5555-4555-8555-555555555555",
  agent_id: AGENT_ID,
  core_identity: "",
  communication_style: "",
  interaction_boundaries: "",
  example_dialogues: "",
  advanced_instructions: "",
  created_at: NOW,
  updated_at: NOW,
});

function agentFixture(id: string): AgentResponse {
  return AgentResponseSchema.parse({
    id,
    name: id === AGENT_ID ? "测试助手" : "助手乙",
    model_name: "gpt-4o",
    config_version: 1,
    persona_intensity: 60,
    created_at: NOW,
    updated_at: NOW,
    p5_config: {
      context_window: 32768,
      retrieval_presets: {
        conservative: {
          candidate_limit: 10,
          max_entries: 5,
          max_tokens: 1000,
          relevance_instruction: "r",
        },
        standard: {
          candidate_limit: 20,
          max_entries: 10,
          max_tokens: 2000,
          relevance_instruction: "r",
        },
        broad: {
          candidate_limit: 40,
          max_entries: 20,
          max_tokens: 4000,
          relevance_instruction: "r",
        },
      },
    },
  });
}

const schemeFixture: QqSchemeResponse = {
  id: SCHEME_ID,
  name: "测试QQ方案",
  description: null,
  triggers: { direct_reply: true, follow_up: false, chiming_in: true, idle_topic: false },
  reply: { split_by_speaker: true },
  rhythm: {
    participation_timing: "resource_window",
    merge_window_seconds: 30,
    reply_cooldown_seconds: 10,
    hourly_speech_limit: 200,
    initiative_min_score: 6,
    judgement_interval_turns: 3,
    idle_quiet_minutes: 15,
    active_hours_enabled: false,
    active_hours_start_minutes: 0,
    active_hours_end_minutes: 1439,
    max_recompute_count: 1,
    max_sticker_count: 1,
    media_frame_count: 3,
    media_max_dimension: 512,
    initiative_batch_target_count: 15,
    initiative_batch_jitter_count: 5,
    initiative_queue_on_busy: true,
    initiative_time_window_enabled: true,
    initiative_time_target_seconds: 60,
    initiative_time_jitter_seconds: 20,
  },
  context: {
    judgement_message_limit: 20,
    judgement_window_minutes: 60,
    judgement_token_budget: 2000,
    reply_message_limit: 60,
    reply_window_minutes: 360,
    reply_token_budget: 6000,
  },
  compression: { watermark_trigger: 200, package_limit: 8, headroom_ratio: 0.05 },
  output_reserve: { judgement_output_reserved: 512, reply_output_reserved: 2048 },
  stickers: { sticker_min_repeat_minutes: 10, sticker_recent_avoid_count: 5, frequency: "medium" },
  sticker_collections: { collection_ids: [] },
  prompts: { scene: "", judge: "", reply: "", review: "", sticker: "", media: "", compress: "" },
  message_settings: {
    reply_mode: "one_then_on_demand",
    reply_depth: 2,
    time_display: "hybrid",
    timezone: "Asia/Shanghai",
  },
  media_input: {
    mode: "native",
    stages: { decision: true, evaluation: true, generation: true },
    max_images: 8,
    ordinary_still_max_dimension: null,
  },
  allocation: { judgement: { mode: "fixed" }, reply: { mode: "fixed" } },
  revision: 3,
  created_at: NOW,
  updated_at: NOW,
  task_limits: { mention_task_limit: 4, ordinary_task_limit: 1 },
  input_anti_spam: { enabled: false, burst_min_messages: 3, burst_window_seconds: 3 },
};

const bindingFixture: QqBindingResponse = {
  id: BINDING_ID,
  account_id: "10001",
  kind: "group",
  peer_id: "123456789",
  agent_id: AGENT_ID,
  scheme_id: SCHEME_ID,
  paused: false,
  triggers: { direct_reply: null, follow_up: null, chiming_in: null, idle_topic: null },
  share_web_memory: false,
  memory_batch_size: null,
  pending_observations: 0,
  revision: 4,
  authority_revision: 4,
  attention: { mode: "off", members: [] },
  task_limits: { mention_task_limit: null, ordinary_task_limit: null },
  input_anti_spam: { enabled: null, burst_min_messages: null, burst_window_seconds: null },
};

const orgFixture: OrganizationSettings = {
  model_name: "global-default",
  vision_model_name: null,
  transcription_model_name: null,
  revision: 1,
};

function groupConfigFixture(): QqGroupConfigResponse {
  return {
    binding: bindingFixture,
    base_scheme: schemeFixture,
    effective_scheme: schemeFixture,
    overrides: {},
    disabled_capabilities: [],
    revision: 7,
  };
}

interface HarnessOverrides {
  updateAgent?: typeof api.updateAgent;
  saveOrganizationSettings?: typeof api.saveOrganizationSettings;
  saveQqGroupConfig?: typeof api.saveQqGroupConfig;
}

function setupHarness(overrides: HarnessOverrides = {}) {
  const persisted = agentFixture(AGENT_ID);
  const updateAgent =
    overrides.updateAgent ??
    (vi.fn(async (_id: string, body: Record<string, unknown>) => {
      const patch = { ...body };
      delete patch.expected_version;
      return {
        ...persisted,
        ...patch,
        config_version: persisted.config_version + 1,
      } as AgentResponse;
    }) as unknown as typeof api.updateAgent);
  const client = {
    getAgent: vi.fn(async (id: string) => (id === AGENT_ID ? persisted : agentFixture(id))),
    getPersona: vi.fn(async () => persona),
    getPolicy: vi.fn(async () => ({
      auto_enabled: true,
      every_turns: 20,
      target_chars: 300,
      version: 1,
    })),
    listMemorySessions: vi.fn(async () => []),
    listMemoryJobs: vi.fn(async () => []),
    getOrganizationSettings: vi.fn(async () => orgFixture),
    getKnowledgeSettings: vi.fn(async () => ({
      revision: 1,
      auto_enabled: true,
      model_name: null,
      context_budget: 2048,
    })),
    getAgentKnowledgeRead: vi.fn(async () => ({
      revision: 1,
      config: { enabled: true, context_budget: null, scope: "all", document_ids: [] },
    })),
    listAgentKnowledge: vi.fn(async () => []),
    getModelCapacity: vi.fn(async () => ({
      model: "gpt-4o",
      status: "loaded",
      context_length: 128000,
    })),
    updateAgent,
    ...overrides,
  } as unknown as typeof api;
  store.getState().resetForTests(client);
  store.setState({
    page: "settings",
    settingsView: "workspace",
    settingsRoute: "context-allocation",
    agents: [persisted, agentFixture(AGENT_B_ID)],
    modelNames: ["gpt-4o"],
  });
  return client;
}

async function renderAssistantWorkspace(route: "memory-tools" | "knowledge-tools" | "context") {
  store.setState({ settingsRoute: route });
  await act(async () => {
    await store.getState().editAgent(AGENT_ID);
  });
  await act(async () => {
    renderView(<AssistantWorkspace active={true} />);
  });
}

async function renderWorkspace(purpose: "assistant" | "qq" | "reading" | "aux") {
  await act(async () => {
    await store.getState().editAgent(AGENT_ID);
  });
  setContextAllocationTarget({ purpose });
  // 助手目的的真实宿主是助手工作区；全局读取/辅助仍归统一上下文分配页。
  if (purpose === "assistant") {
    store.setState({ settingsRoute: "context" });
    await act(async () => {
      renderView(
        <>
          <AssistantWorkspace active={true} />
          <NavigationGuard />
        </>,
      );
    });
    await act(async () => {
      await waitFor(() => expect(store.getState().organizationLoading).toBe(false));
    });
    return;
  }
  await act(async () => {
    renderView(<ModelPurposes active={true} />);
  });
  await act(async () => {
    await waitFor(() => expect(store.getState().organizationLoading).toBe(false));
  });
}

beforeEach(async () => {
  await selectLocale("zh-CN");
  resetContextAllocationTarget();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  resetContextAllocationTarget();
});

describe("统一上下文分配真实接线", () => {
  it("全局辅助分配：勾选自定义+模式+输出预留，保存只发 allocation 部分载荷并推进修订，不夹带模型草稿", async () => {
    const saveOrganizationSettings = vi.fn(
      async (body: { expected_revision: number; auxiliary_allocation?: unknown }) => ({
        model_name: "global-default",
        vision_model_name: null,
        transcription_model_name: null,
        auxiliary_allocation: body.auxiliary_allocation,
        revision: body.expected_revision + 1,
      }),
    ) as unknown as typeof api.saveOrganizationSettings;
    setupHarness({ saveOrganizationSettings });
    await renderWorkspace("aux");
    await act(async () => {
      store.getState().patchOrganization("leaked-model");
    });

    fireEvent.click(screen.getByTestId("aux-custom-toggle-knowledge_organize"));
    fireEvent.change(screen.getByTestId("aux-mode-select-knowledge_organize"), {
      target: { value: "auto" },
    });
    fireEvent.change(screen.getByTestId("aux-output-reserved-knowledge_organize"), {
      target: { value: "2048" },
    });

    const saveBtn = screen.getByTestId("aux-save-global-btn") as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(saveBtn);
    });

    expect(saveOrganizationSettings).toHaveBeenCalledTimes(1);
    const payload = vi.mocked(saveOrganizationSettings).mock.calls[0][0] as Record<string, unknown>;
    expect(payload).toEqual({
      expected_revision: 1,
      auxiliary_allocation: {
        knowledge_organize: { mode: "auto", output_reserved: 2048 },
      },
    });
    expect(store.getState().organizationEditor?.source.revision).toBe(2);
    expect(store.getState().organizationEditor?.modelName).toBe("leaked-model");
  });

  it("全局辅助分配 409：草稿与输入原样保留，无隐式自动重存", async () => {
    const saveOrganizationSettings = vi
      .fn()
      .mockRejectedValue(new ApiError(409, "CONFIG_VERSION_CONFLICT", "revision conflict"));
    setupHarness({
      saveOrganizationSettings:
        saveOrganizationSettings as unknown as typeof api.saveOrganizationSettings,
    });
    await renderWorkspace("aux");

    fireEvent.click(screen.getByTestId("aux-custom-toggle-knowledge_organize"));
    fireEvent.change(screen.getByTestId("aux-output-reserved-knowledge_organize"), {
      target: { value: "2048" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("aux-save-global-btn"));
    });

    expect(saveOrganizationSettings).toHaveBeenCalledTimes(1);
    expect(store.getState().organizationEditor?.auxiliaryAllocation).toEqual({
      knowledge_organize: { mode: "fixed", output_reserved: 2048 },
    });
    expect(store.getState().organizationEditor?.source.revision).toBe(1);
    expect(store.getState().settingsSaving).toBe(false);
    expect(screen.getByRole("alert").textContent).toContain("CONFIG_VERSION_CONFLICT");
  });

  it("记忆工具读取额度：single memory_read进材料草稿，保存保持旧raw与context基线，外来模型/context草稿不发送", async () => {
    const updateAgent = vi.fn(async (_id: string, body: Record<string, unknown>) => {
      const patch = { ...body };
      delete patch.expected_version;
      return { ...agentFixture(AGENT_ID), ...patch, config_version: 2 } as AgentResponse;
    }) as unknown as typeof api.updateAgent;
    const client = setupHarness({ updateAgent });
    await renderAssistantWorkspace("memory-tools");

    fireEvent.change(screen.getByLabelText("记忆工具读取额度"), {
      target: { value: "10000" },
    });
    // 外来脏稿：models 页的模型草稿与 context 页的轮数草稿——materials 任务保存不得夹带。
    await act(async () => {
      store.getState().patchPageAgent("models", {
        model_name: "draft-model",
      });
      store.getState().patchPageAgent("context", {
        p5_config: {
          ...store.getState().pageEditor!.draft.p5_config,
          recent_turns: 88,
        },
      });
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "保存 Agent" }));
    });

    expect(client.updateAgent).toHaveBeenCalledTimes(1);
    const payload = vi.mocked(client.updateAgent).mock.calls[0][1] as Record<string, unknown>;
    const p5 = payload.p5_config as Record<string, unknown>;
    expect(p5.memory_read).toEqual({ enabled: true, max_bytes: 10000 });
    expect(p5.retrieval_presets).toMatchObject({
      broad: expect.objectContaining({ max_tokens: 4000, candidate_limit: 40 }),
      standard: expect.objectContaining({ max_tokens: 2000, max_entries: 10 }),
      conservative: expect.objectContaining({ max_tokens: 1000, max_entries: 5 }),
    });
    expect(payload).not.toHaveProperty("model_name");
    expect(payload).toHaveProperty("expected_version", 1);
    expect(store.getState().pageEditor?.draft.model_name).toBe("draft-model");
  });

  it("QQ 本群：headroom 输入 7 存比例 0.07 稀疏保存且基线不动；空原文拦保存；恢复跟随删除覆盖", async () => {
    const response = groupConfigFixture();
    const saveQqGroupConfig = vi.fn(async (_id: string, body: UpdateQqGroupConfigRequest) => ({
      ...response,
      overrides: body.overrides,
      effective_scheme: mergeQqGroupScheme(schemeFixture, body.overrides),
      revision: body.expected_revision + 1,
    })) as unknown as typeof api.saveQqGroupConfig;
    setupHarness({ saveQqGroupConfig });
    await act(async () => {
      store.setState({
        qqSchemes: [schemeFixture],
        qqSchemesLoaded: true,
        qqBindings: [bindingFixture],
        qqBindingsLoaded: true,
        qqGroupConfigEditor: qqGroupConfigEditorFrom(response),
        qqGroupConfigBindingId: BINDING_ID,
      });
    });
    setContextAllocationTarget({ purpose: "qq", bindingId: BINDING_ID });
    // QQ 本群预算的真实宿主是本群配置页：渲染真实页面并切到历史压缩任务。
    await act(async () => {
      renderView(<QqGroupConfigPage active={true} />);
    });
    // Radix Tabs 由 mousedown 激活；jsdom 的 click 不派发 mousedown（与 QQREV2 62pass 同口径）。
    const compressionTab = screen.getByRole("tab", { name: "历史压缩" });
    fireEvent.mouseDown(compressionTab, { button: 0 });
    fireEvent.click(compressionTab);

    const headroom = () =>
      document.querySelector<HTMLInputElement>('input[data-field="compression.headroom_ratio"]')!;
    // 跟随方案：显示基线 5（0.05 → 5%）。
    expect(headroom().value).toBe("5");
    fireEvent.change(headroom(), { target: { value: "7" } });
    expect(headroom().value).toBe("7");
    expect(store.getState().qqGroupConfigEditor?.overrides.compression).toEqual({
      headroom_ratio: 0.07,
    });

    const saveBtn = screen.getByRole<HTMLButtonElement>("button", {
      name: "保存本群配置",
    });
    expect(saveBtn.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(saveBtn);
    });
    expect(saveQqGroupConfig).toHaveBeenCalledTimes(1);
    const body = vi.mocked(saveQqGroupConfig).mock.calls[0][1];
    expect(body.overrides).toEqual({ compression: { headroom_ratio: 0.07 } });
    expect(body.expected_binding_revision).toBe(4);
    expect(body.expected_scheme_revision).toBe(3);
    expect(body.expected_revision).toBe(7);
    expect(store.getState().qqSchemes[0]).toEqual(schemeFixture);

    // 保存后基线推进为已存差异；再输入空原文：非法原文入 rawTexts，显示回空原文且拦住保存。
    fireEvent.change(headroom(), { target: { value: "" } });
    expect(headroom().value).toBe("");
    expect(store.getState().qqGroupConfigEditor?.rawTexts["compression.headroom_ratio"]).toBe("");
    expect(store.getState().qqGroupConfigEditor?.overrides.compression).toBeUndefined();
    const blockedBtn = screen.getByRole("button", {
      name: "保存本群配置",
    }) as HTMLButtonElement;
    expect(blockedBtn.disabled).toBe(true);
    fireEvent.click(blockedBtn);
    expect(saveQqGroupConfig).toHaveBeenCalledTimes(1);

    // 重新钉住后恢复跟随：覆盖被删除，字段回到基线显示。
    fireEvent.change(headroom(), { target: { value: "7" } });
    const fieldState = document.querySelector<HTMLSelectElement>(
      'select[data-field-state][aria-label*="装配冗余百分比"]',
    )!;
    fireEvent.change(fieldState, { target: { value: "follow" } });
    expect(store.getState().qqGroupConfigEditor?.overrides.compression).toBeUndefined();
    expect(headroom().value).toBe("5");
    // 本群保存被拦时不发请求：放弃改动后基线差异清空。
    expect(saveQqGroupConfig).toHaveBeenCalledTimes(1);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "放弃改动" }));
    });
    expect(store.getState().qqGroupConfigEditor?.rawTexts).toEqual({});
  });

  it("脏稿换对象：确认弹窗取消留在助手目录页，放弃后通过真实目录选择落到目标助手", async () => {
    setupHarness();
    await renderWorkspace("assistant");

    await act(async () => {
      store.getState().patchPageAgent("context", {
        p5_config: { ...store.getState().pageEditor!.draft.p5_config, recent_turns: 12 },
      });
    });
    // 进入真实 Agent 目录，再选择目标助手；脏稿触发统一确认弹窗。
    fireEvent.click(screen.getByRole("button", { name: "所有 Agent" }));
    fireEvent.click(screen.getByRole("button", { name: "助手乙" }));
    await waitFor(() => expect(store.getState().navigationConfirmOpen).toBe(true));
    expect(store.getState().settingsRoute).toBe("context");
    expect(store.getState().editorAgentId).toBe(AGENT_ID);
    fireEvent.click(screen.getByRole("button", { name: "取消离开" }));
    await waitFor(() => expect(store.getState().navigationConfirmOpen).toBe(false));
    expect(store.getState().settingsRoute).toBe("context");
    expect(store.getState().editorAgentId).toBe(AGENT_ID);

    // 取消不进入工作室：仍停在目录，无需再次点「所有 Agent」。
    expect(screen.getByRole("heading", { name: "你的 Agent" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "所有 Agent" })).toBeNull();

    // 目录内再次选择目标：走真实 NavigationGuard 弹窗的放弃分支（workspace.discard_and_continue）。
    fireEvent.click(screen.getByRole("button", { name: "助手乙" }));
    await waitFor(() => expect(store.getState().navigationConfirmOpen).toBe(true));
    fireEvent.click(await screen.findByRole("button", { name: "放弃修改并继续" }));
    await waitFor(() => expect(store.getState().editorAgentId).toBe(AGENT_B_ID));
    await waitFor(() => {
      expect(screen.getByRole("heading", { level: 1, name: "Agent 配置 · 助手乙" })).toBeTruthy();
      expect(screen.getAllByText(/助手乙/).length).toBeGreaterThan(0);
    });
  });

  it("非法原文跨卸载持久： 助手辅助与读取原文由主 store 受控保存，其他保存入口被拦、完整映射可见", async () => {
    const updateAgent = vi.fn() as unknown as typeof api.updateAgent;
    const client = setupHarness({ updateAgent });
    // 助手专有辅助任务分配的真实宿主：助手工作区能力标签页（CapabilityEditor）。
    await renderAssistantWorkspace("context");

    fireEvent.click(screen.getByTestId("aux-custom-toggle-memory_consolidate"));
    fireEvent.change(screen.getByTestId("aux-input-limit-memory_consolidate"), {
      target: { value: "-50" },
    });
    expect(
      store.getState().allocationInvalidInputs[
        "agent:" + AGENT_ID + ":aux:memory_consolidate_input_limit"
      ],
    ).toBe("-50");

    cleanup();
    await act(async () => {
      renderView(<AssistantWorkspace active={true} />);
    });
    expect(
      (screen.getByTestId("aux-input-limit-memory_consolidate") as HTMLInputElement).value,
    ).toBe("-50");
    // 非法输入阻止工具栏保存：点击不发起请求
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "保存 Agent" }));
    });
    expect(client.updateAgent).not.toHaveBeenCalled();

    // 读取域的非法原文同样持久：主 store 映射保存原文，跨卸载渲染一致，保存被拦不旁路。
    await act(async () => {
      store.setState({
        allocationInvalidInputs: {
          ...store.getState().allocationInvalidInputs,
          [`agent:${AGENT_ID}:reading:memory:bytes`]: "-1",
        },
      });
    });
    cleanup();
    // 读取原文的真实宿主导航到助手 access 标签：路由真实切换，不靠直接改组件内部 tab。
    store.setState({ settingsRoute: "memory-tools" });
    await act(async () => {
      renderView(<AssistantWorkspace active={true} />);
    });
    expect((screen.getByLabelText("记忆工具读取额度") as HTMLInputElement).value).toBe("-1");
    // 工作区内嵌模式下只留工具栏保存：点击被非法原文拦截，不发请求
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "保存 Agent" }));
    });
    expect(client.updateAgent).not.toHaveBeenCalled();

    // 完整映射在主 store：两个域的原文同时可见；保存入口不再发请求。
    const invalid = store.getState().allocationInvalidInputs;
    expect(invalid[`agent:${AGENT_ID}:aux:memory_consolidate_input_limit`]).toBe("-50");
    expect(invalid[`agent:${AGENT_ID}:reading:memory:bytes`]).toBe("-1");
    expect(client.updateAgent).not.toHaveBeenCalled();
  });
});
