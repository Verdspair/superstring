import { act, cleanup, render as renderView } from "@testing-library/react";
import { Profiler } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AgentResponse, PersonaResponseSchema } from "../../src/shared/contracts";
import type { QqSchemeResponse } from "../../src/shared/contracts/qq";
import { DesignSystemProvider } from "../../src/web/design-system/Providers";
import { newPageEditor } from "../../src/web/features/agents/page-drafts";
import {
  openContextAllocation,
  resetContextAllocationTarget,
  setContextAllocationTarget,
} from "../../src/web/features/context-allocation";
import { selectLocale } from "../../src/web/i18n";
import { CapabilityEditor } from "../../src/web/screens/assistants/StudioEditors";
import { SchemesWorkspace } from "../../src/web/screens/connections/SchemesWorkspace";
import { ModelPurposes } from "../../src/web/screens/environment/ModelPurposes";
import { useSuperstringStore as store } from "../../src/web/store";

const render = (...[ui, options]: Parameters<typeof renderView>) =>
  renderView(ui, { wrapper: DesignSystemProvider, ...options });

const NOW = "2026-10-16T15:00:00.000Z";
const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const SCHEME_ID = "22222222-2222-4222-8222-222222222222";

const mockAgent: AgentResponse = {
  id: AGENT_ID,
  name: "测试助手",
  description: "用于测试上下文分配",
  system_prompt: "",
  additional_instructions: "",
  model_name: "shared-agent-model",
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
    organizationEditor: {
      source: {
        model_name: "shared-agent-model",
        vision_model_name: "shared-vision-model",
        transcription_model_name: null,
        auxiliary_allocation: {},
        revision: 1,
      },
      model_name: "shared-agent-model",
      vision_model_name: "shared-vision-model",
      transcription_model_name: null,
      auxiliaryAllocation: {},
    } as any,
    knowledgeReadEditor: null,
    knowledgeModelEditor: {
      source: {
        model_name: "shared-agent-model",
        embedding_model_name: null,
        transcription_model_name: null,
        vision_model_name: null,
        context_budget: 4096,
        revision: 1,
      },
      model_name: "shared-agent-model",
      contextBudget: 4096,
    } as any,
    permissionEditor: null,
    qqMemoryBatchDrafts: {},
    qqSchemeEditor: null,
    qqGroupConfigEditor: null,
    modelNames: ["shared-agent-model", "shared-vision-model"],
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("allocation performance & render isolation (PROVEN RED FIRST)", () => {
  it("does not re-render ModelPurposes on unrelated store updates (e.g. qqStickerLoading, traces tick)", async () => {
    let commitCount = 0;
    render(
      <Profiler
        id="model-purposes"
        onRender={() => {
          commitCount++;
        }}
      >
        <ModelPurposes active={true} />
      </Profiler>,
    );

    await act(async () => {});
    const baselineCommits = commitCount;

    // Mutate unrelated store properties that ModelPurposes does NOT need
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        store.setState({ qqStickerLoading: i % 2 === 0 });
      });
    }

    // RED EXPECTATION: Without useShallow selector, whole-store subscription `const s = useSuperstringStore()`
    // causes ModelPurposes to re-commit on EVERY unrelated store mutation.
    expect(commitCount).toBe(baselineCommits);
  });

  it("does not re-render SchemesWorkspace SchemeDirectory on unrelated store updates", async () => {
    store.setState({ settingsRoute: "scheme-library" });
    let commitCount = 0;
    render(
      <Profiler
        id="schemes-workspace"
        onRender={() => {
          commitCount++;
        }}
      >
        <SchemesWorkspace active={true} />
      </Profiler>,
    );

    await act(async () => {});
    const baselineCommits = commitCount;

    // Mutate unrelated store state
    for (let i = 0; i < 5; i++) {
      await act(async () => {
        store.setState({ qqStickerLoading: i % 2 === 0 });
      });
    }

    // RED EXPECTATION: SchemeDirectory and SchemeDetail subscribe via whole-store `useSuperstringStore()`,
    // causing re-render on unrelated mutations.
    expect(commitCount).toBe(baselineCommits);
  });

  it("deduplicates getModelCapacity across auxiliary roles sharing the same model (at most 1 call per distinct model)", async () => {
    const getModelCapacity = vi.fn(async (model: string) => ({
      model,
      status: "loaded" as const,
      context_length: 65536,
    }));
    store.setState({
      apiClient: {
        ...store.getState().apiClient,
        getModelCapacity,
      },
    });

    setContextAllocationTarget({ purpose: "aux" });

    render(<ModelPurposes active={true} />);

    await act(async () => {});

    // The system page owns knowledge organization only; QQ media capacity is read by its app host.
    const callsForAgentModel = getModelCapacity.mock.calls.filter(
      ([m]) => m === "shared-agent-model",
    ).length;
    const callsForVisionModel = getModelCapacity.mock.calls.filter(
      ([m]) => m === "shared-vision-model",
    ).length;

    expect(callsForAgentModel).toBe(1);
    expect(callsForVisionModel).toBe(0);
    expect(getModelCapacity).toHaveBeenCalledTimes(1);

    // Agent identity guard: switching active agent revalidates even if model is identical
    const AGENT_ID_2 = "99999999-9999-4999-8999-999999999999";
    const mockAgent2: AgentResponse = {
      ...mockAgent,
      id: AGENT_ID_2,
      name: "测试助手2",
    };
    await act(async () => {
      store.setState({
        agents: [mockAgent, mockAgent2],
        editorAgentId: AGENT_ID_2,
      });
    });
    expect(getModelCapacity.mock.calls.filter(([m]) => m === "shared-agent-model").length).toBe(2);
  });

  it("visual tab switching inside ModelPurposes fires zero network requests once loaded", async () => {
    const listModels = vi.fn().mockResolvedValue({ models: ["shared-agent-model"] });
    const getOrganizationSettings = vi.fn().mockResolvedValue({
      model_name: "shared-agent-model",
      vision_model_name: "shared-vision-model",
      transcription_model_name: null,
      auxiliary_allocation: {},
      revision: 1,
    });
    store.setState({
      apiClient: {
        ...store.getState().apiClient,
        listModels,
        getOrganizationSettings,
      },
    });

    render(<ModelPurposes active={true} />);
    await act(async () => {});

    const baseCallsList = listModels.mock.calls.length;
    const baseCallsOrg = getOrganizationSettings.mock.calls.length;

    // Switch between purpose tabs visually
    await act(async () => {
      openContextAllocation({ purpose: "aux", agentId: null });
    });
    await act(async () => {
      openContextAllocation({ purpose: "reading" });
    });
    await act(async () => {
      openContextAllocation({ purpose: "assistant" });
    });

    // Zero extra network requests on visual tab switches
    expect(listModels.mock.calls.length).toBe(baseCallsList);
    expect(getOrganizationSettings.mock.calls.length).toBe(baseCallsOrg);
  });
  it("uses one capacity reader for the Agent host and revalidates the same model after identity or API changes", async () => {
    const editor = store.getState().pageEditor;
    if (!editor) throw new Error("Agent editor fixture missing");
    const getModelCapacity = vi.fn(async (model: string) => ({
      model,
      status: "loaded" as const,
      context_length: 65536,
    }));
    const getOrganizationSettings = vi.fn().mockResolvedValue({
      model_name: null,
      vision_model_name: null,
      transcription_model_name: null,
      auxiliary_allocation: {},
      revision: 1,
    });
    const getPermissions = vi.fn().mockResolvedValue({
      revision: "capacity-test",
      policy: { version: 1, grants: [], execution: {} },
      resources: [],
    });
    const originalApi = store.getState().apiClient;
    store.setState({
      settingsRoute: "context",
      editorDraft: editor.draft,
      apiClient: { ...originalApi, getModelCapacity, getOrganizationSettings, getPermissions },
    });
    const { rerender } = render(<CapabilityEditor active={false} />);
    await act(async () => {});
    expect(getModelCapacity).not.toHaveBeenCalled();
    rerender(<CapabilityEditor active />);
    await act(async () => {});
    expect(getModelCapacity).toHaveBeenCalledExactlyOnceWith("shared-agent-model");
    expect(store.getState().chatContextCapacity).toBe(65536);
    const second = { ...mockAgent, id: "99999999-9999-4999-8999-999999999999" };
    await act(async () => {
      store.setState({
        agents: [mockAgent, second],
        editorAgentId: second.id,
        pageEditor: newPageEditor(second, editor.persona),
        editorDraft: editor.draft,
      });
    });
    expect(getModelCapacity).toHaveBeenCalledTimes(2);
    const nextCapacity = vi.fn(async (model: string) => ({
      model,
      status: "loaded" as const,
      context_length: 131072,
    }));
    await act(async () => {
      store.setState({
        apiClient: { ...store.getState().apiClient, getModelCapacity: nextCapacity },
      });
    });
    expect(nextCapacity).toHaveBeenCalledExactlyOnceWith("shared-agent-model");
    expect(store.getState().chatContextCapacity).toBe(131072);
    rerender(<CapabilityEditor active={false} />);
    await act(async () => {});
    expect(nextCapacity).toHaveBeenCalledTimes(1);
  });
});
