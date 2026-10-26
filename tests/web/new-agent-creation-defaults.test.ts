import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AgentResponse,
  AgentResponseSchema,
  CreateAgentRequestSchema,
  DEFAULT_BROAD_PRESET,
  DEFAULT_CONSERVATIVE_PRESET,
  DEFAULT_STANDARD_PRESET,
  newAgentDefaults,
  P5ConfigSchema,
  type PersonaResponse,
  PersonaResponseSchema,
} from "../../src/shared/contracts";
import { api, type SuperstringApi } from "../../src/web/api";
import { selectLocale } from "../../src/web/i18n";
import { useSuperstringStore as store } from "../../src/web/store";

function agentFixture(id = "agent-1", overrides: Partial<AgentResponse> = {}): AgentResponse {
  return AgentResponseSchema.parse({
    id,
    name: `Agent ${id}`,
    description: "",
    model_name: "test-model",
    config_version: 1,
    persona_intensity: 60,
    created_at: "2026-10-16T00:00:00.000Z",
    updated_at: "2026-10-16T00:00:00.000Z",
    ...overrides,
  });
}

function personaFixture(
  agentId = "agent-1",
  overrides: Partial<PersonaResponse> = {},
): PersonaResponse {
  return PersonaResponseSchema.parse({
    id: `persona-${agentId}`,
    agent_id: agentId,
    core_identity: "",
    communication_style: "",
    interaction_boundaries: "",
    example_dialogues: "",
    advanced_instructions: "",
    created_at: "2026-10-16T00:00:00.000Z",
    updated_at: "2026-10-16T00:00:00.000Z",
    ...overrides,
  });
}

function toAgentResponseFixture(id: string, body: unknown): AgentResponse {
  const data = (body ?? {}) as Record<string, unknown>;
  const { persona: _ignoredPersona, ...rest } = data;
  return AgentResponseSchema.parse({
    id,
    name: typeof rest.name === "string" ? rest.name : `Agent ${id}`,
    description: typeof rest.description === "string" ? rest.description : "",
    additional_instructions:
      typeof rest.additional_instructions === "string" ? rest.additional_instructions : "",
    model_name: typeof rest.model_name === "string" ? rest.model_name : "test-model",
    temperature: typeof rest.temperature === "number" ? rest.temperature : 1,
    persona_intensity: typeof rest.persona_intensity === "number" ? rest.persona_intensity : 100,
    p5_config: rest.p5_config ?? newAgentDefaults().p5_config,
    is_active: typeof rest.is_active === "boolean" ? rest.is_active : true,
    config_version: 1,
    created_at: "2026-10-16T00:00:00.000Z",
    updated_at: "2026-10-16T00:00:00.000Z",
  });
}

function makeMockClient(overrides: Partial<SuperstringApi> = {}): SuperstringApi {
  return {
    ...api,
    getAgent: vi.fn(async (id: string) => agentFixture(id)),
    getPersona: vi.fn(async (id: string) => personaFixture(id)),
    savePersona: vi.fn(async (id: string, body: unknown) =>
      personaFixture(id, body as Partial<PersonaResponse>),
    ),
    createAgent: vi.fn(async (body: unknown) => toAgentResponseFixture("created-agent-id", body)),
    updateAgent: vi.fn(async (id: string, body: unknown) => {
      const { expected_version, ...patch } = body as Record<string, unknown>;
      return agentFixture(id, {
        ...(patch as any),
        config_version: Number(expected_version ?? 1) + 1,
      });
    }),
    getModelCapacity: vi.fn(async (model: string) => ({
      model,
      status: "loaded" as const,
      context_length: 131072,
    })),
    getPolicy: vi.fn(async () => ({
      auto_enabled: false,
      every_turns: 20,
      target_chars: 300,
      version: 1,
    })),
    listMemorySessions: vi.fn(async () => []),
    listMemoryJobs: vi.fn(async () => []),
    listMemoryEntries: vi.fn(async () => ({ total: 0, items: [] })),
    ...overrides,
  };
}

beforeEach(() => {
  selectLocale("zh-CN");
  store.getState().resetForTests(makeMockClient());
  store.setState({
    page: "settings",
    settingsView: "workspace",
    settingsRoute: "basic",
    modelNames: ["default-provider-model"],
  });
});

describe("New Agent Creation Defaults (Web Store & Actions)", () => {
  it("initializes __new__ draft with factory non-prompt defaults rather than agents[0] private state", async () => {
    // Seed store with an existing agent having custom legacy parameters and private prompt content
    const existingLegacyAgent = agentFixture("legacy-agent-0", {
      name: "既有私有人设助手",
      description: "既有助手的私有描述文本",
      additional_instructions: "既有助手的私有系统提示词指令",
      model_name: "legacy-private-model",
      temperature: 0.35,
      persona_intensity: 45,
      p5_config: P5ConfigSchema.parse({
        max_output_tokens: 4096,
        recent_turns: 10,
        summary_max_tokens: 4096,
        retrieval_mode: "standard",
        allocation: { mode: "fixed" },
      }),
    });

    store.setState({
      agents: [existingLegacyAgent],
      modelNames: ["default-provider-model"],
    });

    const opened = await store.getState().editAgent("__new__");
    expect(opened).toBe(true);

    const draft = store.getState().editorDraft;
    expect(draft).not.toBeNull();
    if (!draft) return;

    // Canonical creation baseline parameters
    expect(draft.temperature).toBe(1);
    expect(draft.persona_intensity).toBe(100);
    expect(draft.is_active).toBe(true);

    // Private prompts and descriptions are NOT copied from agents[0]
    expect(draft.name).toBe("");
    expect(draft.description).toBe("");
    expect(draft.additional_instructions).toBe("");
    expect(draft.description).not.toBe(existingLegacyAgent.description);
    expect(draft.additional_instructions).not.toBe(existingLegacyAgent.additional_instructions);

    // Canonical P5 creation defaults match newAgentDefaults factory
    const factoryDefaults = newAgentDefaults();
    expect(draft.p5_config).toEqual(factoryDefaults.p5_config);
    expect(draft.p5_config.max_output_tokens).toBe(32768);
    expect(draft.p5_config.recent_turns).toBe(200);
    expect(draft.p5_config.summary_target_tokens).toBe(2048);
    expect(draft.p5_config.summary_max_tokens).toBe(32768);
    expect(draft.p5_config.retrieval_mode).toBe("full_catalog");
    expect(draft.p5_config.allocation).toEqual({ mode: "auto" });
    expect(draft.p5_config.auxiliary_timeout_seconds).toBe(900);
    expect(draft.p5_config.max_catalog_batches).toBe(100);
    expect(draft.p5_config.catalog_batch_size).toBe(30);
    expect(draft.p5_config.retrieval_presets.conservative).toEqual(DEFAULT_CONSERVATIVE_PRESET);
    expect(draft.p5_config.retrieval_presets.standard).toEqual(DEFAULT_STANDARD_PRESET);
    expect(draft.p5_config.retrieval_presets.broad).toEqual(DEFAULT_BROAD_PRESET);

    // Contrasting with agents[0] proves no bleed-through of private values
    expect(draft.temperature).not.toBe(existingLegacyAgent.temperature);
    expect(draft.persona_intensity).not.toBe(existingLegacyAgent.persona_intensity);
    expect(draft.p5_config.max_output_tokens).not.toBe(
      existingLegacyAgent.p5_config.max_output_tokens,
    );
    expect(draft.p5_config.recent_turns).not.toBe(existingLegacyAgent.p5_config.recent_turns);
    expect(draft.p5_config.retrieval_mode).not.toBe(existingLegacyAgent.p5_config.retrieval_mode);
    expect(draft.p5_config.allocation?.mode).not.toBe(
      existingLegacyAgent.p5_config.allocation?.mode,
    );
  });

  it("persists canonical non-prompt defaults in createAgent payload when user leaves them untouched", async () => {
    let capturedPayload: unknown = null;
    const client = makeMockClient({
      createAgent: vi.fn(async (body: unknown) => {
        capturedPayload = body;
        return toAgentResponseFixture("new-agent-uuid", body);
      }),
    });
    store.getState().resetForTests(client);
    store.setState({
      page: "settings",
      settingsView: "workspace",
      settingsRoute: "basic",
      modelNames: ["default-provider-model"],
    });

    await store.getState().editAgent("__new__");
    store.getState().patchDraft({ name: "新建未修改参数助手" });

    const saved = await store.getState().saveCurrentSection();
    expect(saved).toBe(true);
    expect(client.createAgent).toHaveBeenCalledTimes(1);

    // Verify raw payload matches CreateAgentRequestSchema
    const parseResult = CreateAgentRequestSchema.safeParse(capturedPayload);
    expect(parseResult.success).toBe(true);
    if (!parseResult.success) return;

    const payload = parseResult.data;
    expect(payload.name).toBe("新建未修改参数助手");
    expect(payload.temperature).toBe(1);
    expect(payload.persona_intensity).toBe(100);
    expect(payload.is_active).toBe(true);
    expect(payload.p5_config.max_output_tokens).toBe(32768);
    expect(payload.p5_config.recent_turns).toBe(200);
    expect(payload.p5_config.summary_max_tokens).toBe(32768);
    expect(payload.p5_config.retrieval_mode).toBe("full_catalog");
    expect(payload.p5_config.allocation).toEqual({ mode: "auto" });
  });

  it("allows explicit user draft modifications to override defaults in createAgent payload", async () => {
    let capturedPayload: unknown = null;
    const client = makeMockClient({
      createAgent: vi.fn(async (body: unknown) => {
        capturedPayload = body;
        return toAgentResponseFixture("custom-agent-uuid", body);
      }),
    });
    store.getState().resetForTests(client);
    store.setState({
      page: "settings",
      settingsView: "workspace",
      settingsRoute: "basic",
      modelNames: ["default-provider-model"],
    });

    await store.getState().editAgent("__new__");
    const currentDraft = store.getState().editorDraft;
    expect(currentDraft).not.toBeNull();
    if (!currentDraft) return;

    // User explicitly adjusts temperature, persona_intensity, and partial P5 settings
    store.getState().patchDraft({
      name: "显式定制助手",
      temperature: 0.25,
      persona_intensity: 75,
      p5_config: {
        ...currentDraft.p5_config,
        recent_turns: 50,
        max_output_tokens: 16384,
        allocation: { mode: "fixed" },
      },
    });

    const saved = await store.getState().saveCurrentSection();
    expect(saved).toBe(true);
    expect(client.createAgent).toHaveBeenCalledTimes(1);

    const parseResult = CreateAgentRequestSchema.safeParse(capturedPayload);
    expect(parseResult.success).toBe(true);
    if (!parseResult.success) return;

    const payload = parseResult.data;
    // Explicit user modifications win
    expect(payload.name).toBe("显式定制助手");
    expect(payload.temperature).toBe(0.25);
    expect(payload.persona_intensity).toBe(75);
    expect(payload.p5_config.recent_turns).toBe(50);
    expect(payload.p5_config.max_output_tokens).toBe(16384);
    expect(payload.p5_config.allocation).toEqual({ mode: "fixed" });

    // Untouched non-prompt baseline fields remain intact at creation defaults
    expect(payload.p5_config.summary_max_tokens).toBe(32768);
    expect(payload.p5_config.retrieval_mode).toBe("full_catalog");
    expect(payload.p5_config.auxiliary_timeout_seconds).toBe(900);
  });

  it("leaves existing selected agent, edit session, and persisted draft values unchanged", async () => {
    const existingAgent = agentFixture("persisted-legacy-agent", {
      name: "既有历史助手",
      temperature: 0.7,
      persona_intensity: 60,
      config_version: 5,
      p5_config: P5ConfigSchema.parse({
        max_output_tokens: 4096,
        recent_turns: 10,
        summary_max_tokens: 4096,
        retrieval_mode: "standard",
        allocation: { mode: "fixed" },
      }),
    });

    const client = makeMockClient({
      getAgent: vi.fn(async (id: string) =>
        id === existingAgent.id ? existingAgent : agentFixture(id),
      ),
    });
    store.getState().resetForTests(client);
    store.setState({
      page: "settings",
      settingsView: "workspace",
      settingsRoute: "basic",
      agents: [existingAgent],
    });

    // 1. Open the existing agent
    const opened = await store.getState().editAgent(existingAgent.id);
    expect(opened).toBe(true);
    expect(store.getState().editorAgentId).toBe(existingAgent.id);

    const legacyDraft = store.getState().editorDraft;
    expect(legacyDraft).not.toBeNull();
    // Legacy values are preserved, NOT replaced with creation defaults
    expect(legacyDraft?.temperature).toBe(0.7);
    expect(legacyDraft?.persona_intensity).toBe(60);
    expect(legacyDraft?.p5_config.max_output_tokens).toBe(4096);
    expect(legacyDraft?.p5_config.recent_turns).toBe(10);
    expect(legacyDraft?.p5_config.retrieval_mode).toBe("standard");
    expect(legacyDraft?.p5_config.allocation?.mode).toBe("fixed");

    // 2. Save section A for the existing agent: updateAgent is called, NOT createAgent
    store.getState().patchDraft({ description: "更新既有描述" });
    const savedExisting = await store.getState().saveCurrentSection();
    expect(savedExisting).toBe(true);
    expect(client.createAgent).not.toHaveBeenCalled();
    expect(client.updateAgent).toHaveBeenCalledWith(
      existingAgent.id,
      expect.objectContaining({
        description: "更新既有描述",
        expected_version: 5,
        temperature: 0.7,
      }),
    );

    // 3. Switch to __new__ then back to existingAgent
    await store.getState().editAgent("__new__");
    expect(store.getState().editorAgentId).toBe("__new__");
    expect(store.getState().editorDraft?.temperature).toBe(1);

    await store.getState().editAgent(existingAgent.id);
    expect(store.getState().editorAgentId).toBe(existingAgent.id);
    expect(store.getState().editorDraft?.temperature).toBe(0.7);
    expect(store.getState().editorDraft?.p5_config.recent_turns).toBe(10);
  });

  it("ensures new drafts and factory outputs are fresh independent nested objects", async () => {
    // 1. Factory returns distinct instances on every call
    const factoryA = newAgentDefaults();
    const factoryB = newAgentDefaults();
    expect(factoryA).toEqual(factoryB);
    expect(factoryA).not.toBe(factoryB);
    expect(factoryA.p5_config).not.toBe(factoryB.p5_config);
    expect(factoryA.p5_config.retrieval_presets).not.toBe(factoryB.p5_config.retrieval_presets);
    expect(factoryA.p5_config.allocation).not.toBe(factoryB.p5_config.allocation);

    // 2. Draft p5_config mutation in store does not pollute factory or subsequent drafts
    await store.getState().editAgent("__new__");
    const draft1 = store.getState().editorDraft;
    expect(draft1).not.toBeNull();
    if (!draft1) return;

    // Mutate nested properties in draft1
    store.getState().patchDraft({
      p5_config: {
        ...draft1.p5_config,
        recent_turns: 888,
        retrieval_presets: {
          ...draft1.p5_config.retrieval_presets,
          standard: {
            ...draft1.p5_config.retrieval_presets.standard,
            candidate_limit: 999,
            max_entries: 99,
            max_tokens: 99999,
          },
        },
      },
    });

    // Factory remains unaffected
    const freshFactory = newAgentDefaults();
    expect(freshFactory.p5_config.recent_turns).toBe(200);
    expect(freshFactory.p5_config.retrieval_presets.standard.max_tokens).toBe(4096);

    // Subsequent __new__ draft receives clean canonical defaults
    await store.getState().editAgent("__new__");
    const draft2 = store.getState().editorDraft;
    expect(draft2).not.toBeNull();
    if (!draft2) return;

    expect(draft2.p5_config.recent_turns).toBe(200);
    expect(draft2.p5_config.retrieval_presets.standard.max_tokens).toBe(4096);
    expect(draft2.p5_config).not.toBe(draft1.p5_config);
    expect(draft2.p5_config.retrieval_presets).not.toBe(draft1.p5_config.retrieval_presets);
  });
});
