import {
  act,
  cleanup,
  fireEvent,
  render as renderView,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import {
  type AgentResponse,
  AgentResponseSchema,
  type PersonaResponse,
  PersonaResponseSchema,
} from "../../src/shared/contracts";
import {
  SavePersonaRequestSchema,
  UpdateAgentRequestSchema,
} from "../../src/shared/contracts/agent";
import { AgentKnowledgeReadUpdateSchema } from "../../src/shared/contracts/knowledge";
import { ApiError, type SuperstringApi } from "../../src/web/api";
import { DesignSystemProvider } from "../../src/web/design-system/Providers";
import { newPageEditor } from "../../src/web/features/agents/page-drafts";
import { selectLocale } from "../../src/web/i18n";
import { AssistantWorkspace } from "../../src/web/screens/assistants/AssistantWorkspace";
import { useSuperstringStore as store } from "../../src/web/store";
import { A, agent, persona, policy, setupLibrary } from "./helpers/library-fixture";

const render = (...[ui, options]: Parameters<typeof renderView>) =>
  renderView(ui, { wrapper: DesignSystemProvider, ...options });

const switchTab = (name: string) => {
  const tab = screen.getByRole("tab", { name });
  fireEvent.mouseDown(tab, { button: 0, ctrlKey: false });
};

let persistedAgent: AgentResponse;
let persistedPersona: PersonaResponse;
let persistedKnowledge: {
  revision: number;
  config: {
    enabled: boolean;
    context_budget: number | null;
    scope: "all" | "selected";
    document_ids: string[];
  };
};

let updateAgentMock: Mock<SuperstringApi["updateAgent"]>;
let savePersonaMock: Mock<SuperstringApi["savePersona"]>;
let saveAgentKnowledgeReadMock: Mock<SuperstringApi["saveAgentKnowledgeRead"]>;
let getAgentKnowledgeReadMock: Mock<SuperstringApi["getAgentKnowledgeRead"]>;
let getAgentMock: Mock<SuperstringApi["getAgent"]>;
let getPersonaMock: Mock<SuperstringApi["getPersona"]>;

beforeEach(() => {
  selectLocale("zh-CN");
  persistedAgent = AgentResponseSchema.parse({ ...agent });
  persistedPersona = PersonaResponseSchema.parse({ ...persona });
  persistedKnowledge = {
    revision: 1,
    config: { enabled: true, context_budget: 2048, scope: "all", document_ids: [] },
  };

  updateAgentMock = vi.fn().mockImplementation(async (_id: string, body: unknown) => {
    const patch = UpdateAgentRequestSchema.parse(body);
    expect(patch.expected_version).toBe(persistedAgent.config_version);
    const { expected_version, p5_config, ...fields } = patch;
    persistedAgent = AgentResponseSchema.parse({
      ...persistedAgent,
      ...fields,
      p5_config: p5_config
        ? { ...persistedAgent.p5_config, ...p5_config }
        : persistedAgent.p5_config,
      config_version: persistedAgent.config_version + 1,
    });
    return persistedAgent;
  });

  savePersonaMock = vi.fn().mockImplementation(async (_id: string, body: unknown) => {
    const parsed = SavePersonaRequestSchema.parse(body);
    const { persona_intensity, ...personaFields } = parsed;
    if (typeof persona_intensity === "number") {
      persistedAgent = { ...persistedAgent, persona_intensity };
    }
    persistedPersona = PersonaResponseSchema.parse({
      ...persistedPersona,
      ...personaFields,
      updated_at: new Date().toISOString(),
    });
    return persistedPersona;
  });

  getAgentKnowledgeReadMock = vi.fn().mockImplementation(async () => persistedKnowledge);

  saveAgentKnowledgeReadMock = vi.fn().mockImplementation(async (_id: string, payload: unknown) => {
    const parsed = AgentKnowledgeReadUpdateSchema.parse(payload);
    persistedKnowledge = {
      revision: parsed.expected_revision + 1,
      config: {
        enabled: parsed.config.enabled ?? persistedKnowledge.config.enabled,
        context_budget:
          parsed.config.context_budget !== undefined
            ? parsed.config.context_budget
            : persistedKnowledge.config.context_budget,
        scope: (parsed.config.scope as "all" | "selected") ?? persistedKnowledge.config.scope,
        document_ids: parsed.config.document_ids ?? persistedKnowledge.config.document_ids,
      },
    };
    return persistedKnowledge;
  });

  getAgentMock = vi.fn().mockImplementation(async (_id: string) => persistedAgent);
  getPersonaMock = vi.fn().mockImplementation(async () => persistedPersona);

  setupLibrary({
    updateAgent: updateAgentMock,
    savePersona: savePersonaMock,
    getAgent: getAgentMock,
    getPersona: getPersonaMock,
    getAgentKnowledgeRead: getAgentKnowledgeReadMock,
    saveAgentKnowledgeRead: saveAgentKnowledgeReadMock,
    listAgentKnowledge: vi.fn().mockResolvedValue([]),
    getModelCapacity: vi.fn().mockResolvedValue({ context_length: 32768 }),
    getPolicy: vi.fn().mockResolvedValue(policy),
  });

  const editor = newPageEditor(persistedAgent, persistedPersona, policy);
  store.setState({
    status: "ready",
    page: "settings",
    settingsView: "workspace",
    settingsRoute: "identity",
    agents: [persistedAgent],
    editorAgentId: A,
    pageEditor: editor,
    editorDraft: { ...editor.draft },
    modelNames: ["model-a", "model-b"],
    loadedModelNames: ["model-a"],
    knowledgeReadEditor: {
      token: {},
      agentId: A,
      source: {
        revision: 1,
        config: { enabled: true, context_budget: 2048, scope: "all", document_ids: [] },
      },
      draft: { enabled: true, context_budget: 2048, scope: "all", document_ids: [] },
      documents: [],
      globalBudget: 16384,
    } as any,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  selectLocale("zh-CN");
});

describe("Four-Task Workspace UI Decoupled Architecture", () => {
  it("identity task: edits basic, identity, and expression, saves via toolbar, and advances baselines sequentially without touching other tasks", async () => {
    render(<AssistantWorkspace active />);
    await act(async () => {});

    // 1. Edit Name in basic
    const nameInput = screen.getByLabelText("名称");
    fireEvent.change(nameInput, { target: { value: "Updated Agent Name" } });

    // 2. Edit Additional Instructions in identity ("补充指令")
    const instructionsInput = screen.getByLabelText("补充指令");
    fireEvent.change(instructionsInput, { target: { value: "Updated Instructions" } });

    // 3. Edit Communication Style in expression ("沟通风格")
    const styleInput = screen.getByLabelText("沟通风格");
    fireEvent.change(styleInput, { target: { value: "Professional and concise" } });

    expect(store.getState().settingsTaskDirty("identity")).toBe(true);
    expect(store.getState().settingsTaskDirty("conversation")).toBe(false);
    expect(store.getState().settingsTaskDirty("materials")).toBe(false);

    // 4. Save via toolbar
    const saveBtn = screen.getByRole("button", { name: "保存 Agent" });
    await act(async () => {
      fireEvent.click(saveBtn);
    });

    // Sequential endpoint executions:
    // PATCH 1: basic page (name) with expected_version: 1
    // PATCH 2: identity page (additional_instructions) with expected_version: 2
    expect(updateAgentMock).toHaveBeenCalledTimes(2);

    const call1 = UpdateAgentRequestSchema.parse(updateAgentMock.mock.calls[0][1]);
    expect(call1.expected_version).toBe(1);
    expect(call1.name).toBe("Updated Agent Name");
    expect(call1.additional_instructions).toBeUndefined();

    const call2 = UpdateAgentRequestSchema.parse(updateAgentMock.mock.calls[1][1]);
    expect(call2.expected_version).toBe(2);
    expect(call2.additional_instructions).toBe("Updated Instructions");

    // Persona PUT: expression (communication_style)
    expect(savePersonaMock).toHaveBeenCalledTimes(1);
    const sentPersona = SavePersonaRequestSchema.parse(savePersonaMock.mock.calls[0][1]);
    expect(sentPersona.communication_style).toBe("Professional and concise");

    // Zero writes to models, context, memory, or knowledge
    expect(saveAgentKnowledgeReadMock).not.toHaveBeenCalled();

    // Identity task is clean
    expect(store.getState().settingsTaskDirty("identity")).toBe(false);
  });

  it("conversation task: edits models and context, saves via toolbar, and advances baselines without foreign draft writes", async () => {
    render(<AssistantWorkspace active />);
    await act(async () => {});

    // Switch to capabilities (conversation task) via Radix mouseDown
    switchTab("模型配置");
    await act(async () => {});

    // Edit chat model ("对话模型")
    const chatModelInput = screen.getByLabelText("对话模型");
    fireEvent.change(chatModelInput, { target: { value: "model-b" } });

    // Edit context window ("本助手请求上限")
    const contextInput = screen.getByLabelText("本助手请求上限");
    fireEvent.change(contextInput, { target: { value: "32768" } });

    expect(store.getState().settingsTaskDirty("conversation")).toBe(true);
    expect(store.getState().settingsTaskDirty("identity")).toBe(false);
    expect(store.getState().settingsTaskDirty("materials")).toBe(false);

    // Save via toolbar
    const saveBtn = screen.getByRole("button", { name: "保存 Agent" });
    await act(async () => {
      fireEvent.click(saveBtn);
    });

    // models then context sequentially committed
    expect(updateAgentMock).toHaveBeenCalledTimes(2);
    const callModels = UpdateAgentRequestSchema.parse(updateAgentMock.mock.calls[0][1]);
    expect(callModels.model_name).toBe("model-b");

    const callContext = UpdateAgentRequestSchema.parse(updateAgentMock.mock.calls[1][1]);
    expect(callContext.p5_config?.context_window).toBe(32768);

    // Zero writes to persona or knowledge
    expect(savePersonaMock).not.toHaveBeenCalled();
    expect(saveAgentKnowledgeReadMock).not.toHaveBeenCalled();

    // Conversation task is clean
    expect(store.getState().settingsTaskDirty("conversation")).toBe(false);
  });

  it("materials task: commits memory rules and knowledge read together, advancing both baselines", async () => {
    render(<AssistantWorkspace active />);
    await act(async () => {});

    // Switch to access (materials task) via Radix mouseDown
    switchTab("资料读取");
    await waitFor(() => {
      expect(screen.getByTestId("reading-knowledge-agent-budget-input")).toHaveProperty(
        "value",
        "2048",
      );
    });

    // Edit memory candidate limit
    const candidateInput = screen.getByLabelText("每次查询候选条数上限");
    fireEvent.change(candidateInput, { target: { value: "25" } });

    // Edit knowledge read budget
    const budgetInput = screen.getByTestId("reading-knowledge-agent-budget-input");
    fireEvent.change(budgetInput, { target: { value: "4096" } });

    expect(store.getState().settingsTaskDirty("materials")).toBe(true);
    expect(store.getState().settingsTaskDirty("identity")).toBe(false);
    expect(store.getState().settingsTaskDirty("conversation")).toBe(false);

    // Save via toolbar
    const saveBtn = screen.getByRole("button", { name: "保存 Agent" });
    await act(async () => {
      fireEvent.click(saveBtn);
    });

    // Both memory rules and knowledge read committed
    expect(updateAgentMock).toHaveBeenCalledTimes(1);
    const callMemory = UpdateAgentRequestSchema.parse(updateAgentMock.mock.calls[0][1]);
    expect(callMemory.p5_config?.retrieval_presets?.standard?.candidate_limit).toBe(25);

    expect(saveAgentKnowledgeReadMock).toHaveBeenCalledTimes(1);
    expect(saveAgentKnowledgeReadMock).toHaveBeenCalledWith(A, {
      expected_revision: 1,
      config: { enabled: true, context_budget: 4096, scope: "all", document_ids: [] },
    });

    // Materials task is clean
    expect(store.getState().settingsTaskDirty("materials")).toBe(false);
  });

  it("materials partial success and retry: memory succeeds while knowledge gets 409 conflict, advancing memory baseline and preserving knowledge draft for successful retry", async () => {
    // Knowledge read returns 409 conflict on first call
    saveAgentKnowledgeReadMock.mockRejectedValueOnce(
      new ApiError(409, "KNOWLEDGE_STATE_CONFLICT", "知识授权已在别处更新"),
    );

    render(<AssistantWorkspace active />);
    await act(async () => {});

    // Switch to access tab
    switchTab("资料读取");
    await waitFor(() => {
      expect(screen.getByTestId("reading-knowledge-agent-budget-input")).toHaveProperty(
        "value",
        "2048",
      );
    });

    // Edit both memory rules and knowledge read
    const candidateInput = screen.getByLabelText("每次查询候选条数上限");
    fireEvent.change(candidateInput, { target: { value: "28" } });

    const budgetInput = screen.getByTestId("reading-knowledge-agent-budget-input");
    fireEvent.change(budgetInput, { target: { value: "5120" } });

    // Click save in toolbar
    const saveBtn = screen.getByRole("button", { name: "保存 Agent" });
    await act(async () => {
      fireEvent.click(saveBtn);
    });

    // Step 1: Memory-tools updateAgent succeeded!
    expect(updateAgentMock).toHaveBeenCalledTimes(1);
    const callPartial = UpdateAgentRequestSchema.parse(updateAgentMock.mock.calls[0][1]);
    expect(callPartial.p5_config?.retrieval_presets?.standard?.candidate_limit).toBe(28);

    // Step 2: Knowledge save failed with 409!
    expect(saveAgentKnowledgeReadMock).toHaveBeenCalledTimes(1);
    expect(store.getState().settingsTaskDirty("materials")).toBe(true);

    // Memory rules draft is no longer dirty because it was accepted!
    expect(
      store.getState().pageEditor?.agent.p5_config.retrieval_presets.standard.candidate_limit,
    ).toBe(28);
    // Knowledge read remains dirty and preserved!
    expect(store.getState().knowledgeReadEditor?.draft.context_budget).toBe(5120);

    // Retry save: memory-tools is clean, so updateAgent must NOT be called again!
    saveAgentKnowledgeReadMock.mockResolvedValueOnce({
      revision: 2,
      config: { enabled: true, context_budget: 5120, scope: "all", document_ids: [] },
    });

    await act(async () => {
      fireEvent.click(saveBtn);
    });

    // updateAgent call count remains 1 (not re-submitted!)
    expect(updateAgentMock).toHaveBeenCalledTimes(1);
    // Knowledge was retried and succeeded!
    expect(saveAgentKnowledgeReadMock).toHaveBeenCalledTimes(2);

    // Materials task is now clean
    expect(store.getState().settingsTaskDirty("materials")).toBe(false);
  });

  it("tools task: toolbar omits fake save/discard buttons and relies on per-resource permission controls", async () => {
    render(<AssistantWorkspace active />);
    await act(async () => {});

    // Switch to tools tab
    switchTab("工具权限");
    await act(async () => {});

    // Toolbar must NOT render Save Agent button when on tools tab
    expect(screen.queryByRole("button", { name: "保存 Agent" })).toBeNull();
    expect(screen.queryByRole("button", { name: "放弃修改" })).toBeNull();
  });

  it("tab switching preserves drafts across tasks without foreign writes or implicit resets", async () => {
    render(<AssistantWorkspace active />);
    await act(async () => {});

    // 1. Edit identity
    const nameInput = screen.getByLabelText("名称");
    fireEvent.change(nameInput, { target: { value: "Draft Name" } });

    // 2. Switch to capabilities and edit context
    switchTab("模型配置");
    await act(async () => {});
    const contextInput = screen.getByLabelText("本助手请求上限");
    fireEvent.change(contextInput, { target: { value: "24000" } });

    // 3. Switch back to identity -> Draft Name must be preserved!
    switchTab("人设表达");
    await act(async () => {});
    expect((screen.getByLabelText("名称") as HTMLInputElement).value).toBe("Draft Name");

    // 4. Save identity only
    const saveBtn = screen.getByRole("button", { name: "保存 Agent" });
    await act(async () => {
      fireEvent.click(saveBtn);
    });

    expect(updateAgentMock).toHaveBeenCalledTimes(1);
    const callSwitch = UpdateAgentRequestSchema.parse(updateAgentMock.mock.calls[0][1]);
    expect(callSwitch.name).toBe("Draft Name");
    // Context draft was NOT submitted in identity task!
    expect(callSwitch.p5_config?.context_window).toBeUndefined();

    // 5. Switch to capabilities -> context draft 24000 is still dirty and intact!
    switchTab("模型配置");
    await act(async () => {});
    expect(store.getState().settingsTaskDirty("conversation")).toBe(true);
    expect(store.getState().pageEditor?.draft.p5_config.context_window).toBe(24000);
  });
});
