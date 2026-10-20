import {
  act,
  cleanup,
  fireEvent,
  render as renderView,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AgentResponse, PersonaResponseSchema } from "../../src/shared/contracts";
import type { QqBindingResponse, QqSchemeResponse } from "../../src/shared/contracts/qq";
import type { QqGroupConfigResponse } from "../../src/shared/contracts/qq-group-config";
import { api } from "../../src/web/api";
import { DesignSystemProvider } from "../../src/web/design-system/Providers";
import { newPageEditor } from "../../src/web/features/agents/page-drafts";
import {
  getContextAllocationTarget,
  openContextAllocation,
  resetContextAllocationTarget,
  setContextAllocationTarget,
} from "../../src/web/features/context-allocation";
import { selectLocale } from "../../src/web/i18n";
import { CapabilityEditor } from "../../src/web/screens/assistants/StudioEditors";
import { SchemesWorkspace } from "../../src/web/screens/connections/SchemesWorkspace";
import { SchemeStudio } from "../../src/web/screens/connections/scheme-studio";
import { ModelPurposes } from "../../src/web/screens/environment/ModelPurposes";
import { useSuperstringStore as store } from "../../src/web/store";

const render = (...[ui, options]: Parameters<typeof renderView>) =>
  renderView(ui, { wrapper: DesignSystemProvider, ...options });

import { activeSpace } from "../../src/web/workspace/navigation";
import { SETTINGS_ROUTES } from "../../src/web/workspace/settings-routes";

const NOW = "2026-10-16T15:00:00.000Z";
const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const SCHEME_ID = "22222222-2222-4222-8222-222222222222";

const mockAgent: AgentResponse = {
  id: AGENT_ID,
  name: "测试助手",
  description: "用于测试上下文分配",
  system_prompt: "",
  additional_instructions: "",
  model_name: "gpt-4o",
  temperature: 0.7,
  memory_consolidation_model_name: null,
  memory_consolidation_prompt: "",
  memory_consolidation_additional_instructions: "",
  memory_retrieval_model_name: null,
  memory_retrieval_prompt: "",
  context_compression_model_name: null,
  p5_config: {
    context_window: 32768,
    max_output_tokens: 4096,
    safety_margin_ratio: 0.1,
    compression_enabled: true,
    compression_trigger_ratio: 0.8,
    recent_turns: 10,
    summary_target_tokens: 2048,
    summary_max_tokens: 4096,
    summary_read_max_tokens: null,
    retrieval_mode: "standard",
    retrieval_presets: {
      conservative: {
        candidate_limit: 10,
        max_entries: 5,
        max_tokens: 1000,
        relevance_instruction: "",
      },
      standard: {
        candidate_limit: 20,
        max_entries: 10,
        max_tokens: 2000,
        relevance_instruction: "",
      },
      broad: { candidate_limit: 40, max_entries: 20, max_tokens: 4000, relevance_instruction: "" },
    },
    auxiliary_timeout_seconds: 900,
    max_catalog_batches: 100,
    catalog_batch_size: 30,
    allocation: { mode: "fixed" },
  } as any,
  is_active: true,
  config_version: 1,
  persona_intensity: 1,
  created_at: NOW,
  updated_at: NOW,
};

const mockScheme: QqSchemeResponse = {
  id: SCHEME_ID,
  name: "测试QQ方案",
  description: "群聊参与分配测试",
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
  prompts: {
    scene: "",
    judge: "",
    reply: "",
    review: "",
    sticker: "",
    media: "",
    compress: "",
  },
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
  allocation: {
    judgement: { mode: "fixed" },
    reply: { mode: "fixed" },
  },
  revision: 1,
  created_at: NOW,
  updated_at: NOW,
  task_limits: { mention_task_limit: 4, ordinary_task_limit: 1 },
  input_anti_spam: { enabled: false, burst_min_messages: 3, burst_window_seconds: 3 },
};

const BINDING_ID = "44444444-4444-4444-8444-444444444444";

const mockBinding: QqBindingResponse = {
  id: BINDING_ID,
  account_id: "100",
  kind: "group",
  peer_id: "123456789",
  agent_id: AGENT_ID,
  scheme_id: SCHEME_ID,
  paused: false,
  triggers: { direct_reply: null, follow_up: null, chiming_in: null, idle_topic: null },
  share_web_memory: false,
  memory_batch_size: null,
  pending_observations: 0,
  revision: 1,
  authority_revision: 1,
  attention: { mode: "off", members: [] },
  task_limits: { mention_task_limit: null, ordinary_task_limit: null },
  input_anti_spam: { enabled: null, burst_min_messages: null, burst_window_seconds: null },
};

const mockGroupConfig = (): QqGroupConfigResponse => ({
  binding: mockBinding,
  base_scheme: mockScheme,
  effective_scheme: mockScheme,
  overrides: {},
  disabled_capabilities: [],
  revision: 0,
});

/** 合成 API：全部读取在本地解析，不触网。需要特殊行为的用例向 overrides 传自己的 mock。 */
function createMockApiClient(overrides: Partial<typeof api> = {}) {
  return {
    ...api,
    getKnowledgeSettings: vi.fn().mockResolvedValue({
      auto_enabled: true,
      model_name: null,
      context_budget: 32000,
      revision: 1,
    }),
    getOrganizationSettings: vi.fn().mockResolvedValue({
      model_name: "global-default",
      vision_model_name: "vision-model",
      transcription_model_name: null,
      auxiliary_allocation: {},
      revision: 1,
    }),
    getModelCapacity: vi.fn().mockResolvedValue({
      model: "gpt-4o",
      status: "loaded",
      context_length: 128000,
    }),
    listQqSchemes: vi.fn().mockResolvedValue([mockScheme]),
    getQqSchemeUsage: vi.fn().mockResolvedValue({ scheme_id: SCHEME_ID, bindings: 0 }),
    listQqStickerCollections: vi.fn().mockResolvedValue([]),
    listQqStickerAssets: vi.fn().mockResolvedValue([]),
    listQqBindings: vi.fn().mockResolvedValue([mockBinding]),
    getQqGroupConfig: vi.fn().mockResolvedValue(mockGroupConfig()),
    saveOrganizationSettings: vi
      .fn()
      .mockImplementation(
        async (body: { auxiliary_allocation?: unknown; expected_revision: number }) => ({
          model_name: "global-default",
          vision_model_name: "vision-model",
          transcription_model_name: null,
          auxiliary_allocation: body.auxiliary_allocation ?? {},
          revision: body.expected_revision + 1,
        }),
      ),
    updateQqScheme: vi.fn().mockImplementation(async (_id: string, body: unknown) => ({
      ...mockScheme,
      ...(body as object),
      revision: 2,
    })),
    ...overrides,
  } as unknown as typeof api;
}

beforeEach(async () => {
  await selectLocale("zh-CN");
  vi.restoreAllMocks();
  resetContextAllocationTarget();
  store.getState().resetForTests(createMockApiClient());
  store.setState({
    page: "settings",
    settingsView: "workspace",
    settingsRoute: "context-allocation",
    agents: [mockAgent],
    qqSchemes: [mockScheme],
    qqSchemesLoaded: true,
    qqBindings: [],
    qqBindingsLoaded: true,
    dirty: false,
    pageEditor: newPageEditor(
      mockAgent,
      PersonaResponseSchema.parse({
        id: "33333333-3333-4333-8333-333333333333",
        agent_id: AGENT_ID,
        core_identity: "",
        communication_style: "",
        interaction_boundaries: "",
        example_dialogues: "",
        advanced_instructions: "",
        created_at: NOW,
        updated_at: NOW,
      }),
    ),
    editorAgentId: AGENT_ID,
    editorLoading: false,
    settingsSaving: false,
    navigationConfirmOpen: false,
    pendingNavigation: null,
    memoryCorrectionDirty: false,
    knowledgeDirty: false,
    organizationEditor: null,
    knowledgeReadEditor: null,
    knowledgeModelEditor: null,
    permissionEditor: null,
    qqMemoryBatchDrafts: {},
    qqSchemeEditor: null,
    qqGroupConfigEditor: null,
    qqSchemeSaving: false,
    qqSchemesLoading: false,
    qqGroupConfigSaving: false,
    qqGroupConfigLoading: false,
    modelNames: ["gpt-4o"],
    modelProviders: [
      {
        id: "11111111-2222-4333-8444-555555555555",
        name: "OpenAI",
        base_url: "https://api.openai.com/v1",
        has_api_key: true,
        models: [{ name: "gpt-4o", context_window: 128000 }],
        revision: 1,
        created_at: NOW,
        updated_at: NOW,
      },
    ],
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Context Allocation Workspace & Navigation", () => {
  it("keeps context-allocation as the target route and resolves it to the models space", () => {
    const route = SETTINGS_ROUTES.find((r) => r.id === "context-allocation");
    expect(route).toBeDefined();
    expect(route?.id).toBe("context-allocation");

    const space = activeSpace({
      page: "settings",
      settingsView: "workspace",
      settingsRoute: "context-allocation",
    });
    expect(space).toBe("models");
  });

  it("removes the peer allocation switcher from the schemes directory", async () => {
    store.setState({ settingsRoute: "scheme-library" });
    render(<SchemesWorkspace active={true} />);

    expect(screen.queryByRole("tab", { name: /应用方案/ })).toBeNull();
    expect(screen.queryByRole("tab", { name: /上下文分配/ })).toBeNull();
    expect(screen.queryByTestId("context-allocation-workspace")).toBeNull();
  });

  it("renders purpose tabs in the models-purpose host without the deleted assistant and QQ tabs", async () => {
    setContextAllocationTarget({ purpose: "reading" });
    render(<ModelPurposes active={true} />);

    await waitFor(() => expect(store.getState().organizationLoading).toBe(false));
    // 资料读取与辅助任务仍是 ModelPurposes 的全局用途页签
    expect(screen.getByRole("tab", { name: /资料读取/ })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /辅助任务/ })).toBeTruthy();
    // 助手专属 host 已批准彻底从 ModelPurposes 物理移除
    expect(screen.queryByRole("tab", { name: /对话助手/ })).toBeNull();
    // QQ 用途随 batch-2 物理迁出 ModelPurposes：旧 QQ 页签与其控件不再是本宿主的渲染面
    expect(screen.queryByRole("tab", { name: /QQ/ })).toBeNull();
    expect(screen.queryByTestId("qq-judgement-mode")).toBeNull();
    expect(screen.queryByTestId("qq-reply-mode")).toBeNull();
  });

  it("renders the QQ scheme studio with real context controls instead of a QQ purpose tab", async () => {
    setContextAllocationTarget({ purpose: "qq", schemeId: SCHEME_ID });
    store.setState({ settingsRoute: "qq-scheme-config", qqSchemesLoaded: false });
    render(<SchemeStudio active={true} />);
    await waitFor(() => expect(store.getState().qqSchemeEditor).not.toBeNull());
    await waitFor(() => expect(store.getState().qqSchemeUsage?.schemeId).toBe(SCHEME_ID));

    // 判断/回复模式与真实预算输入都在方案详情的「消息读取」任务里渲染（qq-*part*-mode 测试id保留）
    // Radix Tabs 在真实浏览器里由 mousedown/focus 激活页签；jsdom 的 click 不会派发 mousedown。
    const contextTab = screen.getByRole("tab", { name: /消息读取/ });
    fireEvent.mouseDown(contextTab, { button: 0 });
    fireEvent.click(contextTab);
    expect(await screen.findByTestId("qq-judgement-mode")).toBeTruthy();
    expect(screen.getByTestId("qq-reply-mode")).toBeTruthy();
    expect(screen.getByRole("spinbutton", { name: /判断：预算/ })).toBeTruthy();
    expect(screen.getByRole("spinbutton", { name: /回复：预算/ })).toBeTruthy();
    expect(screen.getByRole("spinbutton", { name: /判断：输出预留/ })).toBeTruthy();
    expect(screen.getByRole("spinbutton", { name: /回复：输出预留/ })).toBeTruthy();
  });

  it("renders Assistant allocation controls in its canonical host (CapabilityEditor) with honest units and mode", async () => {
    // 助手专属上下文分配在 StudioEditors -> CapabilityEditor 中作为规范真实 host 渲染
    render(<CapabilityEditor active={true} />);

    expect(screen.getByText(/测试助手 - 短期上下文/)).toBeTruthy();
    expect(screen.getByRole("radio", { name: /固定/ })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /自动/ })).toBeTruthy();
    expect(screen.getByRole("spinbutton", { name: /本助手请求上限/ })).toBeTruthy();
    expect(screen.getByRole("spinbutton", { name: /最大输出 Token/ })).toBeTruthy();
    expect(screen.getByRole("spinbutton", { name: /安全余量比例/ })).toBeTruthy();
    expect(screen.getByLabelText("保留近期轮数")).toBeTruthy();
  });

  it("switches QQ allocation modes in the scheme studio and saves the whole scheme payload", async () => {
    setContextAllocationTarget({ purpose: "qq", schemeId: SCHEME_ID });
    store.setState({ settingsRoute: "qq-scheme-config", qqSchemesLoaded: false });
    const client = store.getState().apiClient as unknown as ReturnType<typeof createMockApiClient>;
    render(<SchemeStudio active={true} />);
    await waitFor(() => expect(store.getState().qqSchemeEditor).not.toBeNull());

    const contextTab = screen.getByRole("tab", { name: /消息读取/ });
    fireEvent.mouseDown(contextTab, { button: 0 });
    fireEvent.click(contextTab);
    const judgementMode = await screen.findByTestId("qq-judgement-mode");

    // 判断与回复模式互相独立：改判断不影响回复。
    fireEvent.change(judgementMode, { target: { value: "auto" } });
    expect((screen.getByTestId("qq-judgement-mode") as HTMLSelectElement).value).toBe("auto");
    expect((screen.getByTestId("qq-reply-mode") as HTMLSelectElement).value).toBe("fixed");
    fireEvent.change(screen.getByTestId("qq-reply-mode"), { target: { value: "auto" } });
    expect((screen.getByTestId("qq-reply-mode") as HTMLSelectElement).value).toBe("auto");

    // 保存整方案：allocation 两档与全部既有组一起进 PUT，CAS 带上打开时的 revision。
    const saveButton = screen.getByRole("button", { name: "保存方案" });
    await act(async () => {
      fireEvent.click(saveButton);
    });
    expect(client.updateQqScheme).toHaveBeenCalledOnce();
    const payload = (client.updateQqScheme as ReturnType<typeof vi.fn>).mock.calls[0][1] as Record<
      string,
      unknown
    >;
    expect(payload).toMatchObject({
      allocation: {
        judgement: { mode: "auto" },
        reply: { mode: "auto" },
      },
      context: mockScheme.context,
      output_reserve: mockScheme.output_reserve,
      compression: mockScheme.compression,
      message_settings: mockScheme.message_settings,
      media_input: mockScheme.media_input,
      expected_revision: 1,
    });
    expect(store.getState().error).toBeNull();
    expect(store.getState().qqSchemeSaving).toBe(false);
  });

  it("shows global aux tasks under ModelPurposes with real role cards and honest units", async () => {
    setContextAllocationTarget({ purpose: "aux" });
    render(<ModelPurposes active={true} />);
    await waitFor(() => expect(store.getState().organizationEditor).not.toBeNull());

    // 系统级全局辅助只剩 knowledge_organize；QQ 表情/媒体辅助跟随 QQ 应用宿主，不在这里复制。
    expect(screen.getByTestId("aux-card-knowledge_organize")).toBeTruthy();
    expect(screen.getByText("知识库整理")).toBeTruthy();
    expect(screen.queryByTestId("aux-card-qq_sticker_annotate")).toBeNull();
    expect(screen.queryByTestId("aux-card-qq_media_describe")).toBeNull();
    expect(screen.queryByText("表情描述")).toBeNull();
    expect(screen.queryByText("媒体描述")).toBeNull();
  });

  it("returns global allocation to its recorded source route with the original label", async () => {
    setContextAllocationTarget({
      purpose: "reading",
      returnRoute: "scheme-library",
      returnLabel: "应用方案",
    });
    render(<ModelPurposes active={true} />);

    const returnBtnScheme = screen.getByRole("button", { name: /返回.*应用方案/ });
    expect(returnBtnScheme).toBeTruthy();
    fireEvent.click(returnBtnScheme);
    await waitFor(() => expect(store.getState().settingsRoute).toBe("scheme-library"));
    // 返回是回源，不是新目标：分配目标回到默认，不把旧 QQ/Agent 实体夹带出去。
    expect(getContextAllocationTarget()).toMatchObject({
      purpose: "assistant",
      agentId: null,
      schemeId: null,
      bindingId: null,
      returnRoute: null,
      returnLabel: null,
    });
  });

  it("lands a QQ scheme target on the scheme studio after the aggregate guard hydrates the directory", async () => {
    store.setState({ qqSchemesLoaded: true, qqBindingsLoaded: true });
    const client = store.getState().apiClient as unknown as ReturnType<typeof createMockApiClient>;

    await act(async () => {
      store.getState().requestContextAllocation({ purpose: "qq", schemeId: SCHEME_ID });
      await waitFor(() => expect(store.getState().settingsRoute).toBe("qq-scheme-config"));
    });

    expect(store.getState().qqSchemeEditor?.source.id).toBe(SCHEME_ID);
    // 目录已载入：着陆不重复读目录，只按选择打开编辑器并读一次使用量；不是保存。
    expect(client.listQqSchemes).not.toHaveBeenCalled();
    expect(client.getQqSchemeUsage).toHaveBeenCalledOnce();
    expect(store.getState().pendingNavigation).toBeNull();
    expect(client.updateQqScheme).not.toHaveBeenCalled();
  });

  it("lands a QQ binding target on the group config and does not reread the same binding target", async () => {
    store.setState({ qqSchemesLoaded: true, qqBindingsLoaded: true });
    const client = store.getState().apiClient as unknown as ReturnType<typeof createMockApiClient>;

    await act(async () => {
      store.getState().requestContextAllocation({ purpose: "qq", bindingId: BINDING_ID });
      await waitFor(() => expect(store.getState().settingsRoute).toBe("qq-group-config"));
      await waitFor(() => expect(store.getState().qqGroupConfigEditor).not.toBeNull());
    });

    expect(store.getState().qqGroupConfigEditor?.source.binding.id).toBe(BINDING_ID);
    expect(client.getQqGroupConfig).toHaveBeenCalledTimes(1);

    // 同一个绑定目标再次进入：同身份不隐式重读，草稿基线不被替换。
    const firstSource = store.getState().qqGroupConfigEditor?.source;
    await act(async () => {
      store.getState().requestContextAllocation({ purpose: "qq", bindingId: BINDING_ID });
      await waitFor(() => expect(store.getState().settingsRoute).toBe("qq-group-config"));
    });
    expect(client.getQqGroupConfig).toHaveBeenCalledTimes(1);
    expect(store.getState().qqGroupConfigEditor?.source).toBe(firstSource);
  });

  it("cancels a QQ landing when drafts are unsaved and leaves the current view untouched", async () => {
    store.setState({ allocationInvalidInputs: { "global:knowledge": "1" } });
    const client = store.getState().apiClient as unknown as ReturnType<typeof createMockApiClient>;

    store.getState().requestContextAllocation({ purpose: "qq", schemeId: SCHEME_ID });
    await waitFor(() => expect(store.getState().navigationConfirmOpen).toBe(true));
    expect(store.getState().settingsRoute).toBe("context-allocation");
    expect(store.getState().pendingNavigation).toMatchObject({ kind: "context-allocation" });
    expect(client.listQqSchemes).not.toHaveBeenCalled();

    store.getState().cancelPendingNavigation();
    expect(store.getState().pendingNavigation).toBeNull();
    expect(store.getState().navigationConfirmOpen).toBe(false);
    expect(store.getState().settingsRoute).toBe("context-allocation");
    expect(store.getState().qqSchemeEditor).toBeNull();
  });

  it("does not claim a QQ landing when the directory read fails", async () => {
    store.setState({
      qqSchemesLoaded: false,
      apiClient: createMockApiClient({
        listQqSchemes: vi.fn().mockRejectedValue(new Error("QQ 目录读取失败")),
      }),
    });

    await act(async () => {
      store.getState().requestContextAllocation({ purpose: "qq", schemeId: SCHEME_ID });
      await waitFor(() => expect(store.getState().error).toBe("QQ 目录读取失败"));
    });

    expect(store.getState().settingsRoute).toBe("context-allocation");
    expect(store.getState().qqSchemeEditor).toBeNull();
    // 目录读取失败就是失败：没有编辑器、没有着陆，可显式重试。
    expect(store.getState().qqSchemesLoaded).toBe(false);
    expect(store.getState().pendingNavigation).toBeNull();
  });

  it("shows the global auxiliary allocation save entry and saves through saveOrganization", async () => {
    setContextAllocationTarget({ purpose: "aux" });
    render(<ModelPurposes active={true} />);
    await waitFor(() => expect(store.getState().organizationEditor).not.toBeNull());
    await waitFor(() => expect(store.getState().organizationLoading).toBe(false));

    const saveGlobalBtn = screen.getByRole("button", { name: /保存全局辅助分配/ });
    expect(saveGlobalBtn).toBeTruthy();
    // 干净草稿：按钮禁用，不产生空 PUT。
    expect(saveGlobalBtn.hasAttribute("disabled")).toBe(true);

    // 给知识库整理勾上自定义并改成 auto：保存按钮解锁并提交全局分配作用域。
    fireEvent.click(screen.getByTestId("aux-custom-toggle-knowledge_organize"));
    fireEvent.change(screen.getByTestId("aux-mode-select-knowledge_organize"), {
      target: { value: "auto" },
    });
    expect(store.getState().organizationEditor?.auxiliaryAllocation).toMatchObject({
      knowledge_organize: { mode: "auto" },
    });
    const enabledSaveGlobal = screen.getByRole("button", { name: /保存全局辅助分配/ });
    expect(enabledSaveGlobal.hasAttribute("disabled")).toBe(false);

    await act(async () => {
      fireEvent.click(enabledSaveGlobal);
    });
    const client = store.getState().apiClient as unknown as ReturnType<typeof createMockApiClient>;
    expect(client.saveOrganizationSettings).toHaveBeenCalledOnce();
    expect(client.saveOrganizationSettings).toHaveBeenCalledWith({
      auxiliary_allocation: { knowledge_organize: { mode: "auto" } },
      expected_revision: 1,
    });
    expect(store.getState().organizationEditor?.source.revision).toBe(2);
    expect(store.getState().error).toBeNull();
  });

  it("switching purpose from QQ to non-QQ cleans schemeId and bindingId without corrupting returnRoute", () => {
    setContextAllocationTarget({
      purpose: "qq",
      schemeId: SCHEME_ID,
      bindingId: "binding-1",
      returnRoute: "scheme-library",
      returnLabel: "应用方案",
    });

    openContextAllocation({ purpose: "reading", agentId: AGENT_ID });

    const target = getContextAllocationTarget();
    expect(target.purpose).toBe("reading");
    expect(target.agentId).toBe(AGENT_ID);
    expect(target.schemeId).toBeNull();
    expect(target.bindingId).toBeNull();
    expect(target.returnRoute).toBe("scheme-library");
    expect(target.returnLabel).toBe("应用方案");
  });

  it("global reading and aux intents with an explicit null agentId do not inject a fallback agentId", () => {
    for (const purpose of ["reading", "aux"] as const) {
      resetContextAllocationTarget();
      openContextAllocation({ purpose, agentId: null });
      const target = getContextAllocationTarget();
      expect(target.purpose).toBe(purpose);
      expect(target.agentId).toBeNull();
      expect(target.schemeId).toBeNull();
      expect(target.bindingId).toBeNull();
    }
  });
});
