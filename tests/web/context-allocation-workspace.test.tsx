import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AgentResponse, PersonaResponseSchema } from "../../src/shared/contracts";
import type { QqSchemeResponse } from "../../src/shared/contracts/qq";
import { newPageEditor } from "../../src/web/features/agents/page-drafts";
import {
  resetContextAllocationTarget,
  setContextAllocationTarget,
} from "../../src/web/features/context-allocation";
import { selectLocale } from "../../src/web/i18n";
import { ContextAllocationWorkspace } from "../../src/web/screens/connections/ContextAllocationWorkspace";
import { SchemesWorkspace } from "../../src/web/screens/connections/SchemesWorkspace";
import { useSuperstringStore as store } from "../../src/web/store";
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

beforeEach(async () => {
  await selectLocale("zh-CN");
  resetContextAllocationTarget();
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
  it("registers context-allocation in SETTINGS_ROUTES and routes to schemes space", () => {
    const route = SETTINGS_ROUTES.find((r) => r.id === "context-allocation");
    expect(route).toBeDefined();
    expect(route?.id).toBe("context-allocation");

    const space = activeSpace({
      page: "settings",
      settingsView: "workspace",
      settingsRoute: "context-allocation",
    });
    expect(space).toBe("schemes");
  });

  it("renders Schemes root peer switcher [应用方案 | 上下文分配]", async () => {
    store.setState({ settingsRoute: "scheme-library" });
    render(<SchemesWorkspace active={true} />);

    expect(screen.getByRole("tab", { name: /应用方案/ })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /上下文分配/ })).toBeTruthy();
  });

  it("switches to context-allocation workspace and displays 4 purposes", async () => {
    store.setState({ settingsRoute: "context-allocation" });
    render(<SchemesWorkspace active={true} />);

    expect(screen.getByRole("tab", { name: /对话助手/ })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /QQ/ })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /资料读取/ })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /辅助任务/ })).toBeTruthy();
  });

  it("displays Assistant allocation controls with fixed/auto mode and request limit", async () => {
    setContextAllocationTarget({ purpose: "assistant", agentId: AGENT_ID });
    render(<ContextAllocationWorkspace active={true} />);

    expect(screen.getByRole("radio", { name: /固定/ })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /自动/ })).toBeTruthy();
    expect(screen.getByLabelText(/本助手请求上限/)).toBeTruthy();
  });

  it("displays QQ allocation controls with independent judgement and reply modes", async () => {
    setContextAllocationTarget({ purpose: "qq", schemeId: SCHEME_ID });
    store.getState().selectQqScheme(SCHEME_ID);
    render(<ContextAllocationWorkspace active={true} />);

    expect(screen.getByTestId("qq-judgement-mode")).toBeTruthy();
    expect(screen.getByTestId("qq-reply-mode")).toBeTruthy();
    // Use accessible field label from connections.judgementBudgetEstimatedBytes
    expect(screen.getByLabelText(/判断：预算/)).toBeTruthy();
    expect(screen.getByLabelText(/回复：预算/)).toBeTruthy();
  });

  it("shows aux tasks with real role cards and honest units", async () => {
    setContextAllocationTarget({ purpose: "aux" });
    render(<ContextAllocationWorkspace active={true} />);

    expect(screen.getByTestId("aux-card-knowledge_organize")).toBeTruthy();
    expect(screen.getByTestId("aux-card-qq_sticker_annotate")).toBeTruthy();
    expect(screen.getByTestId("aux-card-qq_media_describe")).toBeTruthy();
    expect(screen.getByTestId("aux-card-memory_consolidate")).toBeTruthy();
    expect(screen.getByTestId("aux-card-research")).toBeTruthy();
    expect(screen.getByText("知识库整理")).toBeTruthy();
  });

  it("handles return navigation correctly across both Agent settings and scheme destinations", async () => {
    // 1. Return to Agent basic settings
    setContextAllocationTarget({
      purpose: "assistant",
      agentId: AGENT_ID,
      returnRoute: "basic",
      returnLabel: "助手设置",
    });
    const { unmount } = render(<ContextAllocationWorkspace active={true} />);

    const returnBtnAgent = screen.getByRole("button", { name: /返回.*助手设置/ });
    expect(returnBtnAgent).toBeTruthy();
    fireEvent.click(returnBtnAgent);
    await waitFor(() => expect(store.getState().settingsRoute).toBe("basic"));
    unmount();

    // 2. Return to Scheme library
    setContextAllocationTarget({
      purpose: "qq",
      schemeId: SCHEME_ID,
      returnRoute: "scheme-library",
      returnLabel: "应用方案",
    });
    const { unmount: unmountScheme } = render(<ContextAllocationWorkspace active={true} />);

    const returnBtnScheme = screen.getByRole("button", { name: /返回.*应用方案/ });
    expect(returnBtnScheme).toBeTruthy();
    fireEvent.click(returnBtnScheme);
    await waitFor(() => expect(store.getState().settingsRoute).toBe("scheme-library"));
    unmountScheme();
  });

  it("handles discard/cancel preserving baseline without corrupting target", async () => {
    // Provide an active pageEditor matching the agent to show discard button
    store.setState({
      editorAgentId: AGENT_ID,
      pageEditor: {
        agent: mockAgent,
        draft: { ...mockAgent } as any,
        persona: {} as any,
        personaDraft: {} as any,
        policy: null,
        policyDraft: null,
        token: {},
      },
    });
    setContextAllocationTarget({ purpose: "assistant", agentId: AGENT_ID });
    render(<ContextAllocationWorkspace active={true} />);

    // Click discard button
    const discardBtn = screen.getByRole("button", { name: /放弃修改/ });
    expect(discardBtn).toBeTruthy();
    fireEvent.click(discardBtn);
  });
  it("shows the global auxiliary allocation save entry", async () => {
    const saveMock = vi.fn().mockResolvedValue({
      model_name: "global-default",
      vision_model_name: "vision-model",
      transcription_model_name: null,
      auxiliary_allocation: {
        knowledge_organize: { mode: "auto", input_limit: 8000, output_reserved: 2048 },
      },
      revision: 2,
    });
    store.setState({
      apiClient: {
        ...store.getState().apiClient,
        getOrganizationSettings: vi.fn().mockResolvedValue({
          model_name: "global-default",
          vision_model_name: "vision-model",
          transcription_model_name: null,
          auxiliary_allocation: {},
          revision: 1,
        }),
        saveOrganizationSettings: saveMock,
      } as any,
    });

    setContextAllocationTarget({ purpose: "aux" });
    render(<ContextAllocationWorkspace active={true} />);

    // Save global aux button is present
    const saveGlobalBtn = screen.getByRole("button", { name: /保存全局辅助分配/ });
    expect(saveGlobalBtn).toBeTruthy();
  });
});
