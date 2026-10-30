import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AgentResponse,
  P5ConfigSchema,
  PersonaResponseSchema,
} from "../../src/shared/contracts";
import { ApiError, type SuperstringApi } from "../../src/web/api";
import { newPageEditor } from "../../src/web/features/agents/page-drafts";
import { fixtureStore as useSuperstringStore } from "./helpers/chat-fixture";

const NOW = "2026-09-12T03:00:00.000Z";
const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_AGENT_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "33333333-3333-4333-8333-333333333333";

const runtime = {
  agent_id: AGENT_ID,
  name: "测试助手",
  system_prompt: "",
  additional_instructions: "",
  model_name: "qwen/test",
  temperature: 0.7,
  memory_consolidation_model_name: "qwen/test",
  memory_consolidation_prompt: "整理",
  memory_consolidation_additional_instructions: "",
  memory_retrieval_model_name: "qwen/test",
  memory_retrieval_prompt: "检索",
  context_compression_model_name: "qwen/test",
  p5_config: P5ConfigSchema.parse({}),
  resolved_model_capacities: {},
  mode: "chat",
  config_version: 1,
  persona_intensity: 60,
};

const draft = {
  name: "测试助手",
  description: "",
  additional_instructions: "",
  model_name: "qwen/test",
  temperature: 0.7,
  memory_consolidation_model_name: null,
  memory_consolidation_prompt: "整理",
  memory_consolidation_additional_instructions: "",
  memory_retrieval_model_name: null,
  memory_retrieval_prompt: "检索",
  context_compression_model_name: null,
  p5_config: P5ConfigSchema.parse({}),
  is_active: true,
  config_version: 1,
  persona_intensity: 60,
};

function personaFixture(id = AGENT_ID) {
  return PersonaResponseSchema.parse({
    id: "persona",
    agent_id: id,
    core_identity: "",
    communication_style: "",
    interaction_boundaries: "",
    example_dialogues: "",
    advanced_instructions: "",
    created_at: NOW,
    updated_at: NOW,
  });
}
function dirtyEditor(agent = buildAgentResponse(AGENT_ID, draft.name)) {
  const editor = newPageEditor(agent, personaFixture(agent.id));
  editor.draft.description = "未保存描述";
  return editor;
}

function fakeClient(overrides: Partial<SuperstringApi> = {}): SuperstringApi {
  return overrides as SuperstringApi;
}

beforeEach(() => {
  useSuperstringStore.getState().resetForTests(fakeClient());
  localStorage.clear();
});

describe("R6 局部 bootstrap", () => {
  it("单个资源失败时仍进入可用壳并保留成功资源", async () => {
    useSuperstringStore.setState({
      apiClient: fakeClient({
        listAgents: vi.fn().mockRejectedValue(new Error("Agent 暂不可用")),
        listSessions: vi.fn().mockResolvedValue([]),
        listModels: vi.fn().mockResolvedValue({
          provider: "lm_studio",
          status: "available",
          models: ["qwen/test"],
          default_model: "qwen/test",
        }),
        // Registered external models join the picker list (0032); rejecting here is also fine —
        // the bootstrap treats that source like any other optional one.
        listModelProviders: vi.fn().mockResolvedValue([]),
        getBrowserStateConfig: vi.fn().mockRejectedValue(new Error("浏览器状态不可用")),
      }),
    });

    await useSuperstringStore.getState().bootstrap();

    const state = useSuperstringStore.getState();
    expect(state.status).toBe("ready");
    expect(state.agents).toEqual([]);
    expect(state.sessions).toEqual([]);
    expect(state.modelNames).toEqual(["qwen/test"]);
    expect(state.modelStatus).toContain("LM Studio 当前报告");
    expect(state.error).toContain("Agent 暂不可用");
    expect(state.pendingOperations).toBe(0);
  });

  it("本地模型目录连不上、但登记了外部模型时，只提示不报错", async () => {
    useSuperstringStore.setState({
      apiClient: fakeClient({
        listAgents: vi.fn().mockResolvedValue([]),
        listSessions: vi.fn().mockResolvedValue([]),
        // 本地模型服务不可用，但已登记的外部 API 模型仍可使用。
        listModels: vi
          .fn()
          .mockRejectedValue(
            new ApiError(503, "MODEL_SERVICE_UNAVAILABLE", "本地模型服务暂不可用"),
          ),
        listModelProviders: vi.fn().mockResolvedValue([
          {
            id: "44444444-4444-4444-8444-444444444444",
            name: "Cloud provider",
            base_url: "https://example.invalid/v1",
            has_api_key: true,
            models: [{ name: "gpt-6-luna", context_window: 32768 }],
            revision: 1,
            created_at: NOW,
            updated_at: NOW,
          },
        ]),
        getBrowserStateConfig: vi.fn().mockResolvedValue(null),
      }),
    });

    await useSuperstringStore.getState().bootstrap();

    const state = useSuperstringStore.getState();
    expect(state.status).toBe("ready");
    expect(state.error).toBeNull();
    expect(state.modelStatus).toContain("已登记的外部模型仍可选择");
    expect(state.modelNames).toEqual(["gpt-6-luna"]);
    expect(state.externalModelNames).toEqual(["gpt-6-luna"]);
    expect(state.loadedModelNames).toEqual([]);
    expect(state.modelStatus).toContain("本地模型服务连不上");
  });

  it("一个模型来源都拿不到时才报告模型列表加载失败", async () => {
    useSuperstringStore.setState({
      apiClient: fakeClient({
        listAgents: vi.fn().mockResolvedValue([]),
        listSessions: vi.fn().mockResolvedValue([]),
        listModels: vi
          .fn()
          .mockRejectedValue(
            new ApiError(503, "MODEL_SERVICE_UNAVAILABLE", "本地模型服务暂不可用"),
          ),
        listModelProviders: vi.fn().mockResolvedValue([]),
        getBrowserStateConfig: vi.fn().mockResolvedValue(null),
      }),
    });

    await useSuperstringStore.getState().bootstrap();

    const state = useSuperstringStore.getState();
    expect(state.modelNames).toEqual([]);
    expect(state.error).toBeNull();
    expect(state.modelStatus).toContain("MODEL_SERVICE_UNAVAILABLE");
    expect(state.modelStatus).toContain("模型列表加载失败");
  });
});

describe("R5 新建会话状态机", () => {
  it("空名称和无可用 Agent 都不请求创建接口", async () => {
    const createSession = vi.fn();
    useSuperstringStore.setState({ apiClient: fakeClient({ createSession }) });

    expect(await useSuperstringStore.getState().createSession("   ")).toBe(false);
    expect(useSuperstringStore.getState().feedback).toBe("名称不能为空，请填写后再确认");

    expect(await useSuperstringStore.getState().createSession("名称")).toBe(false);
    expect(useSuperstringStore.getState().feedback).toBe(
      "当前没有可用于新会话的 Agent，请先启用或创建 Agent",
    );
    expect(createSession).not.toHaveBeenCalled();
  });

  it("创建失败时返回 false 并保留后端错误文案", async () => {
    const createSession = vi.fn().mockRejectedValue(new Error("新建会话失败，请检查后端服务"));
    useSuperstringStore.setState({
      selectedNewSessionAgentId: AGENT_ID,
      apiClient: fakeClient({ createSession }),
    });

    expect(await useSuperstringStore.getState().createSession("自定义名称")).toBe(false);
    expect(useSuperstringStore.getState().feedback).toBe("新建会话失败，请检查后端服务");
    expect(useSuperstringStore.getState().currentSessionId).toBeNull();
  });

  it("创建成功时使用修剪后的名称并返回 true", async () => {
    const createSession = vi.fn().mockResolvedValue({
      id: SESSION_ID,
      title: "自定义名称",
      agent_id: AGENT_ID,
      mode: "chat",
      config_version: 1,
      created_at: NOW,
      updated_at: NOW,
    });
    const getSessionRuntime = vi.fn().mockResolvedValue(runtime);
    useSuperstringStore.setState({
      selectedNewSessionAgentId: AGENT_ID,
      apiClient: fakeClient({
        createSession,
        listMessages: vi.fn().mockResolvedValue({ items: [], has_more: false }),
        getSessionRuntime,
      }),
    });

    expect(await useSuperstringStore.getState().createSession("  自定义名称  ")).toBe(true);
    expect(createSession.mock.calls[0][0]).toMatchObject({
      title: "自定义名称",
      agent_id: AGENT_ID,
      mode: "chat",
    });
    expect(useSuperstringStore.getState().currentSessionId).toBe(SESSION_ID);
    expect(getSessionRuntime).toHaveBeenCalledWith(SESSION_ID);
    expect(useSuperstringStore.getState().runtimeConfig).toEqual(runtime);
  });

  it("浏览器状态写入失败不把已成功创建误报为失败", async () => {
    const createSession = vi.fn().mockResolvedValue({
      id: SESSION_ID,
      title: "已创建",
      agent_id: AGENT_ID,
      mode: "chat",
      config_version: 1,
      created_at: NOW,
      updated_at: NOW,
    });
    useSuperstringStore.setState({
      selectedNewSessionAgentId: AGENT_ID,
      browserStateStorage: {
        read: vi.fn().mockResolvedValue(null),
        write: vi.fn().mockRejectedValue(new Error("storage blocked")),
      },
      apiClient: fakeClient({
        createSession,
        listMessages: vi.fn().mockResolvedValue({ items: [], has_more: false }),
        getSessionRuntime: vi.fn().mockResolvedValue(runtime),
      }),
    });

    expect(await useSuperstringStore.getState().createSession("已创建")).toBe(true);
    expect(useSuperstringStore.getState().currentSessionId).toBe(SESSION_ID);
    expect(useSuperstringStore.getState().feedback).toBe("");
  });
});

describe("R5 会话加载隔离", () => {
  it("消息读取失败不会误判 runtime heading 失败", async () => {
    useSuperstringStore.setState({
      apiClient: fakeClient({
        listMessages: vi.fn().mockRejectedValue(new Error("消息读取失败")),
        getSessionRuntime: vi.fn().mockResolvedValue(runtime),
      }),
    });

    await useSuperstringStore.getState().selectSession(SESSION_ID);

    expect(useSuperstringStore.getState().messages).toEqual([]);
    expect(useSuperstringStore.getState().runtimeConfig).toEqual(runtime);
    expect(useSuperstringStore.getState().runtimeConfigUnavailable).toBe(false);
    expect(useSuperstringStore.getState().error).toBe("消息读取失败");
  });

  it("runtime 读取失败时保留成功读取的消息并标记标题不可用", async () => {
    useSuperstringStore.setState({
      apiClient: fakeClient({
        listMessages: vi.fn().mockResolvedValue({
          items: [
            {
              id: "44444444-4444-4444-8444-444444444444",
              session_id: SESSION_ID,
              turn_id: "55555555-5555-4555-8555-555555555555",
              role: "user",
              content: "已读取消息",
              sequence_no: 1,
              status: "completed",
              error_code: null,
              created_at: NOW,
              completed_at: NOW,
            },
          ],
          has_more: false,
        }),
        getSessionRuntime: vi.fn().mockRejectedValue(new Error("runtime 失败")),
      }),
    });

    await useSuperstringStore.getState().selectSession(SESSION_ID);

    expect(useSuperstringStore.getState().messages[0]?.content).toBe("已读取消息");
    expect(useSuperstringStore.getState().runtimeConfig).toBeNull();
    expect(useSuperstringStore.getState().runtimeConfigUnavailable).toBe(true);
  });
});

describe("R5 未保存导航保护", () => {
  beforeEach(() => {
    useSuperstringStore.setState({
      status: "ready",
      page: "settings",
      settingsView: "agents",
      editorAgentId: AGENT_ID,
      editorDraft: draft,
      agents: [
        {
          id: AGENT_ID,
          ...draft,
          system_prompt: "",
          created_at: NOW,
          updated_at: NOW,
        },
      ],
      dirty: false,
      pageEditor: dirtyEditor(),
    });
  });

  it("切换页面前先保留当前位置并显示原版三选确认", () => {
    useSuperstringStore.getState().requestPageNavigation("chat");
    const state = useSuperstringStore.getState();
    expect(state.page).toBe("settings");
    expect(state.settingsView).toBe("agents");
    expect(state.pendingNavigation).toEqual({ kind: "page", page: "chat", settingsView: "hub" });
    expect(state.navigationConfirmMessage).toBe("设置中有未保存页面，是否全部保存再继续？");
  });

  it("取消导航会保留草稿、dirty 与当前位置", () => {
    useSuperstringStore.getState().requestPageNavigation("chat");
    useSuperstringStore.getState().cancelPendingNavigation();
    const state = useSuperstringStore.getState();
    expect(state.page).toBe("settings");
    expect(state.settingsView).toBe("agents");
    expect(useSuperstringStore.getState().settingsTaskDirty("identity")).toBe(true);
    expect(state.pendingNavigation).toBeNull();
  });

  it("保存并继续只在保存成功后执行目标导航", async () => {
    const saved = {
      id: AGENT_ID,
      ...draft,
      system_prompt: "",
      created_at: NOW,
      updated_at: NOW,
    };
    const updateAgent = vi.fn().mockResolvedValue(saved);
    useSuperstringStore.setState({ apiClient: fakeClient({ updateAgent }) });
    useSuperstringStore.getState().requestPageNavigation("chat");

    await useSuperstringStore.getState().confirmSaveAndContinue();

    expect(updateAgent).toHaveBeenCalledOnce();
    expect(useSuperstringStore.getState().page).toBe("chat");
    expect(useSuperstringStore.getState().dirty).toBe(false);
  });

  it("保存失败时保持目标排队、保持 dirty，并继续显示确认区", async () => {
    const updateAgent = vi
      .fn()
      .mockRejectedValue(new ApiError(409, "VERSION_CONFLICT", "版本冲突"));
    useSuperstringStore.setState({ apiClient: fakeClient({ updateAgent }) });
    useSuperstringStore.getState().requestPageNavigation("chat");

    await useSuperstringStore.getState().confirmSaveAndContinue();

    const state = useSuperstringStore.getState();
    expect(state.page).toBe("settings");
    expect(state.pendingNavigation).toEqual({ kind: "page", page: "chat", settingsView: "hub" });
    expect(state.navigationConfirmOpen).toBe(true);
    expect(state.navigationConfirmMessage).toContain("保存未全部完成");
    expect(useSuperstringStore.getState().settingsTaskDirty("identity")).toBe(true);
  });

  it("切换 Agent 时 dirty 会阻止立即读取目标 Agent", () => {
    const getAgent = vi.fn();
    useSuperstringStore.setState({ apiClient: fakeClient({ getAgent }) });
    useSuperstringStore.getState().requestAgentNavigation(OTHER_AGENT_ID);
    expect(getAgent).not.toHaveBeenCalled();
    expect(useSuperstringStore.getState().editorAgentId).toBe(AGENT_ID);
    expect(useSuperstringStore.getState().navigationConfirmMessage).toBe(
      "当前 Agent 有未保存修改，是否先保存再切换？",
    );
  });
});

describe("R6 当前任务保存隔离", () => {
  const savedAgent = buildAgentResponse(AGENT_ID, draft.name);
  beforeEach(() =>
    useSuperstringStore.setState({
      editorAgentId: AGENT_ID,
      editorDraft: draft,
      agents: [savedAgent],
      pageEditor: newPageEditor(savedAgent, personaFixture()),
    }),
  );
  it("基础页只提交基础字段，不覆盖模型与上下文草稿", async () => {
    const updateAgent = vi
      .fn()
      .mockResolvedValue({ ...savedAgent, name: "改名", config_version: 2 });
    useSuperstringStore.setState({ apiClient: fakeClient({ updateAgent }) });
    useSuperstringStore.getState().patchPageAgent("basic", { name: "改名" });
    useSuperstringStore.getState().patchPageAgent("models", { model_name: "未保存模型" });
    expect(await useSuperstringStore.getState().saveSettingsPage("basic")).toBe(true);
    expect(updateAgent).toHaveBeenCalledWith(AGENT_ID, {
      name: "改名",
      description: draft.description,
      is_active: draft.is_active,
      expected_version: draft.config_version,
    });
    expect(useSuperstringStore.getState().pageEditor?.draft.model_name).toBe("未保存模型");
  });
  it("资料任务只提交记忆读取字段并保留持久化的上下文及私有历史值", async () => {
    const updateAgent = vi.fn().mockResolvedValue({
      ...savedAgent,
      config_version: 2,
      p5_config: { ...savedAgent.p5_config, memory_read: { enabled: false, max_bytes: 2048 } },
    });
    useSuperstringStore.setState({ apiClient: fakeClient({ updateAgent }) });
    useSuperstringStore.getState().patchPageAgent("memory-tools", {
      p5_config: { ...draft.p5_config, memory_read: { enabled: false, max_bytes: 2048 } },
    });
    useSuperstringStore
      .getState()
      .patchPageAgent("context", { p5_config: { ...draft.p5_config, context_window: 65536 } });
    useSuperstringStore
      .getState()
      .patchPageAgent("models", { context_compression_model_name: "不应随资料保存" });
    expect(await useSuperstringStore.getState().saveSettingsTask("materials")).toBe(true);
    const payload = updateAgent.mock.calls[0][1];
    expect(payload).not.toHaveProperty("name");
    expect(payload).not.toHaveProperty("context_compression_model_name");
    expect(payload.p5_config.context_window).toBe(savedAgent.p5_config.context_window);
    expect(payload.p5_config.memory_read).toEqual({ enabled: false, max_bytes: 2048 });
    expect(payload.p5_config.retrieval_mode).toBe(savedAgent.p5_config.retrieval_mode);
    expect(useSuperstringStore.getState().pageEditor?.draft.context_compression_model_name).toBe(
      "不应随资料保存",
    );
    expect(useSuperstringStore.getState().pageEditor?.draft.p5_config.context_window).toBe(65536);
  });
  it("上下文只提交当前上下文字段并保留记忆读取草稿", async () => {
    const updateAgent = vi.fn().mockResolvedValue({
      ...savedAgent,
      config_version: 2,
      p5_config: { ...savedAgent.p5_config, context_window: 65536 },
    });
    useSuperstringStore.setState({
      apiClient: fakeClient({
        updateAgent,
        getModelCapacity: vi
          .fn()
          .mockResolvedValue({ model: draft.model_name, status: "loaded", context_length: 131072 }),
      }),
    });
    useSuperstringStore
      .getState()
      .patchPageAgent("context", { p5_config: { ...draft.p5_config, context_window: 65536 } });
    useSuperstringStore.getState().patchPageAgent("memory-tools", {
      p5_config: { ...draft.p5_config, memory_read: { enabled: false, max_bytes: 2048 } },
    });
    expect(await useSuperstringStore.getState().saveSettingsPage("context")).toBe(true);
    const payload = updateAgent.mock.calls[0][1];
    expect(payload).not.toHaveProperty("name");
    expect(payload).not.toHaveProperty("memory_retrieval_prompt");
    expect(payload.p5_config.retrieval_mode).toBe(savedAgent.p5_config.retrieval_mode);
    expect(payload.p5_config.context_window).toBe(65536);
    expect(useSuperstringStore.getState().pageEditor?.draft.p5_config.memory_read).toEqual({
      enabled: false,
      max_bytes: 2048,
    });
  });
  it("上下文自定义预算保存前 fail closed 校验模型实际容量", async () => {
    const updateAgent = vi.fn();
    const getModelCapacity = vi
      .fn()
      .mockResolvedValue({ model: draft.model_name, status: "loaded", context_length: 32768 });
    useSuperstringStore.setState({ apiClient: fakeClient({ updateAgent, getModelCapacity }) });
    useSuperstringStore
      .getState()
      .patchPageAgent("context", { p5_config: { ...draft.p5_config, context_window: 65536 } });
    expect(await useSuperstringStore.getState().saveSettingsPage("context")).toBe(false);
    expect(getModelCapacity).toHaveBeenCalledWith(draft.model_name);
    expect(updateAgent).not.toHaveBeenCalled();
    expect(useSuperstringStore.getState().error).toBe("自定义上下文超过模型实际容量32768");
    expect(useSuperstringStore.getState().settingsTaskDirty("conversation")).toBe(true);
  });
});

const NEW_ID = "99999999-9999-4999-8999-999999999999";

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function buildAgentResponse(id: string, name: string): AgentResponse {
  return {
    id,
    ...draft,
    name,
    system_prompt: "",
    created_at: NOW,
    updated_at: NOW,
  };
}

function editClient(id: string, name: string): SuperstringApi {
  return fakeClient({
    getAgent: vi.fn().mockResolvedValue(buildAgentResponse(id, name)),
    getPersona: vi.fn().mockResolvedValue({
      id: "",
      agent_id: id,
      core_identity: "",
      communication_style: "",
      interaction_boundaries: "",
      example_dialogues: "",
      advanced_instructions: "",
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
    }),
    getPolicy: vi.fn().mockResolvedValue({
      auto_enabled: true,
      every_turns: 10,
      target_chars: 500,
      version: 1,
    }),
    listMemorySessions: vi.fn().mockResolvedValue([]),
    listMemoryJobs: vi.fn().mockResolvedValue([]),
  });
}

describe("R5 首次打开入口默认规则", () => {
  it("有助手时首次打开按默认规则载入选中助手", async () => {
    useSuperstringStore.setState({
      status: "ready",
      page: "chat",
      settingsView: "hub",
      agents: [buildAgentResponse(AGENT_ID, "助手A"), buildAgentResponse(OTHER_AGENT_ID, "助手B")],
      selectedNewSessionAgentId: OTHER_AGENT_ID,
      apiClient: editClient(OTHER_AGENT_ID, "助手B"),
    });

    useSuperstringStore.getState().openAgentSettings();
    await flush();

    const state = useSuperstringStore.getState();
    expect(state.page).toBe("settings");
    expect(state.settingsView).toBe("agents");
    expect(state.editorAgentId).toBe(OTHER_AGENT_ID);
    expect(state.editorDraft?.name).toBe("助手B");
  });

  it("无助手时首次打开载入空白新建草稿", () => {
    useSuperstringStore.setState({
      status: "ready",
      page: "chat",
      settingsView: "hub",
      agents: [],
    });

    useSuperstringStore.getState().openAgentSettings();

    const state = useSuperstringStore.getState();
    expect(state.page).toBe("settings");
    expect(state.settingsView).toBe("agents");
    expect(state.editorAgentId).toBe("__new__");
    expect(state.editorDraft).not.toBeNull();
    expect(state.editorDraft?.name).toBe("");
  });

  it("已有主动草稿重进不覆盖", () => {
    useSuperstringStore.setState({
      status: "ready",
      page: "settings",
      settingsView: "agents",
      editorAgentId: AGENT_ID,
      editorDraft: { ...draft },
      agents: [buildAgentResponse(AGENT_ID, "助手A")],
      dirty: false,
      pageEditor: dirtyEditor(),
    });

    useSuperstringStore.getState().openAgentSettings();

    const state = useSuperstringStore.getState();
    expect(state.editorAgentId).toBe(AGENT_ID);
    expect(state.editorDraft?.name).toBe(draft.name);
  });
});

describe("R5 同 ID 导航", () => {
  it("同 ID 且草稿为 null 时初始化新建草稿", () => {
    useSuperstringStore.setState({
      editorAgentId: "__new__",
      editorDraft: null,
    });

    useSuperstringStore.getState().requestAgentNavigation("__new__");

    const state = useSuperstringStore.getState();
    expect(state.editorDraft).not.toBeNull();
  });

  it("同 ID 且编辑会话存在时立即返回", () => {
    const getAgent = vi.fn();
    useSuperstringStore.setState({
      editorAgentId: AGENT_ID,
      editorDraft: { ...draft },
      pageEditor: { token: {} } as never,
      apiClient: fakeClient({ getAgent }),
    });

    useSuperstringStore.getState().requestAgentNavigation(AGENT_ID);

    expect(getAgent).not.toHaveBeenCalled();
    expect(useSuperstringStore.getState().editorAgentId).toBe(AGENT_ID);
  });

  it("同 ID 但保存后 pageEditor=null 时重新读取，不早退", async () => {
    const getAgent = vi
      .fn()
      .mockResolvedValue({ ...draft, id: AGENT_ID } as unknown as AgentResponse);
    useSuperstringStore.setState({
      editorAgentId: AGENT_ID,
      editorDraft: { ...draft },
      pageEditor: null,
      dirty: false,
      apiClient: fakeClient({
        getAgent,
        getPersona: vi.fn().mockResolvedValue({ id: AGENT_ID } as never),
      }),
      reloadMemory: vi.fn().mockResolvedValue(undefined),
    });

    useSuperstringStore.getState().requestAgentNavigation(AGENT_ID);
    expect(getAgent).toHaveBeenCalledWith(AGENT_ID);

    await new Promise((resolve) => setTimeout(resolve, 0));
    const state = useSuperstringStore.getState();
    expect(state.editorAgentId).toBe(AGENT_ID);
    expect(state.pageEditor).not.toBeNull();
    expect(state.error).toBeNull();
  });
});

describe("R5 dirty 切换新建取消/放弃/保存失败", () => {
  const base = {
    status: "ready" as const,
    page: "settings" as const,
    settingsView: "agents" as const,
    editorAgentId: AGENT_ID,
    editorDraft: { ...draft },
    agents: [buildAgentResponse(AGENT_ID, "助手A")],
    dirty: false,
    pageEditor: dirtyEditor(),
  };

  it("取消保留草稿", () => {
    useSuperstringStore.setState(base);
    useSuperstringStore.getState().requestAgentNavigation("__new__");
    expect(useSuperstringStore.getState().pendingNavigation).toEqual({
      kind: "agent",
      id: "__new__",
    });

    useSuperstringStore.getState().cancelPendingNavigation();

    const state = useSuperstringStore.getState();
    expect(state.editorAgentId).toBe(AGENT_ID);
    expect(state.editorDraft?.name).toBe(draft.name);
    expect(useSuperstringStore.getState().settingsTaskDirty("identity")).toBe(true);
    expect(state.pendingNavigation).toBeNull();
  });

  it("放弃后进入空白新建草稿", async () => {
    useSuperstringStore.setState(base);
    useSuperstringStore.getState().requestAgentNavigation("__new__");

    await useSuperstringStore.getState().confirmDiscardAndContinue();

    const state = useSuperstringStore.getState();
    expect(state.editorAgentId).toBe("__new__");
    expect(state.editorDraft?.name).toBe("");
    expect(state.dirty).toBe(false);
  });

  it("保存失败保留草稿不重置", async () => {
    const updateAgent = vi
      .fn()
      .mockRejectedValue(new ApiError(409, "VERSION_CONFLICT", "版本冲突"));
    useSuperstringStore.setState({
      ...base,
      apiClient: fakeClient({ updateAgent }),
    });
    useSuperstringStore.getState().requestAgentNavigation("__new__");

    await useSuperstringStore.getState().confirmSaveAndContinue();

    const state = useSuperstringStore.getState();
    expect(state.editorAgentId).toBe(AGENT_ID);
    expect(state.editorDraft?.name).toBe(draft.name);
    expect(useSuperstringStore.getState().settingsTaskDirty("identity")).toBe(true);
    expect(state.pendingNavigation).toEqual({ kind: "agent", id: "__new__" });
    expect(state.navigationConfirmOpen).toBe(true);
  });
});

describe("R5 创建流程真实行为", () => {
  it("创建成功获得真实 ID 且第二次保存走 update 不重复 create", async () => {
    const created = buildAgentResponse(NEW_ID, "新建助手");
    const createAgent = vi.fn().mockResolvedValue(created);
    const updateAgent = vi.fn().mockResolvedValue({ ...created, description: "改后" });
    useSuperstringStore.setState({
      apiClient: fakeClient({
        createAgent,
        updateAgent,
        getPersona: vi.fn().mockResolvedValue(personaFixture(NEW_ID)),
      }),
    });

    await useSuperstringStore.getState().editAgent("__new__");
    useSuperstringStore.getState().patchNewAgentDraft({ name: "新建助手" });
    expect(await useSuperstringStore.getState().createAgent()).toBe(true);
    expect(useSuperstringStore.getState().editorAgentId).toBe(NEW_ID);
    expect(useSuperstringStore.getState().feedback).toContain("新建助手");

    useSuperstringStore.getState().patchPageAgent("basic", { description: "改后" });
    expect(await useSuperstringStore.getState().saveSettingsTask("identity")).toBe(true);
    expect(createAgent).toHaveBeenCalledTimes(1);
    expect(updateAgent).toHaveBeenCalledTimes(1);
  });

  it("创建失败保留草稿与 dirty", async () => {
    const createAgent = vi.fn().mockRejectedValue(new Error("创建失败"));
    useSuperstringStore.setState({ apiClient: fakeClient({ createAgent }) });

    await useSuperstringStore.getState().editAgent("__new__");
    useSuperstringStore.getState().patchNewAgentDraft({ name: "草稿名" });
    expect(await useSuperstringStore.getState().createAgent()).toBe(false);

    const state = useSuperstringStore.getState();
    expect(state.editorDraft).not.toBeNull();
    expect(state.editorDraft?.name).toBe("草稿名");
    expect(state.editorAgentId).toBe("__new__");
    expect(state.dirty).toBe(true);
    expect(state.error).toContain("创建失败");
  });
});

describe("R5 创建前任务保护", () => {
  it("未创建草稿不能走已有记录任务保存，并保留草稿与dirty", async () => {
    const createAgent = vi.fn();
    useSuperstringStore.setState({ apiClient: fakeClient({ createAgent }) });
    await useSuperstringStore.getState().editAgent("__new__");
    useSuperstringStore.getState().patchNewAgentDraft({ name: "草稿名" });
    for (const task of ["identity", "conversation", "materials", "tools"] as const)
      expect(await useSuperstringStore.getState().saveSettingsTask(task)).toBe(false);
    expect(useSuperstringStore.getState().editorDraft?.name).toBe("草稿名");
    expect(useSuperstringStore.getState().dirty).toBe(true);
    expect(createAgent).not.toHaveBeenCalled();
  });
});

describe("R5 放弃修改并离开页面", () => {
  it("放弃并离开页面后重进按默认规则载入且不恢复改动", async () => {
    useSuperstringStore.setState({
      status: "ready",
      page: "settings",
      settingsView: "agents",
      editorAgentId: AGENT_ID,
      editorDraft: { ...draft },
      agents: [buildAgentResponse(AGENT_ID, "助手A"), buildAgentResponse(OTHER_AGENT_ID, "助手B")],
      selectedNewSessionAgentId: OTHER_AGENT_ID,
      dirty: false,
      pageEditor: dirtyEditor(),
      apiClient: editClient(OTHER_AGENT_ID, "助手B"),
    });
    useSuperstringStore.getState().patchPageAgent("basic", { name: "改动" });
    useSuperstringStore.getState().requestPageNavigation("chat");

    await useSuperstringStore.getState().confirmDiscardAndContinue();
    let state = useSuperstringStore.getState();
    expect(state.editorDraft).toBeNull();
    expect(state.dirty).toBe(false);
    expect(state.editorAgentId).toBe("__new__");
    expect(state.page).toBe("chat");

    useSuperstringStore.getState().openAgentSettings();
    await flush();
    state = useSuperstringStore.getState();
    expect(state.page).toBe("settings");
    expect(state.settingsView).toBe("agents");
    expect(state.editorAgentId).toBe(OTHER_AGENT_ID);
    expect(state.editorDraft?.name).toBe("助手B");
    expect(state.editorDraft?.name).not.toBe("改动");
  });
});

describe("R5 放弃时目标读取失败可重试", () => {
  it("目标读取失败恢复 pendingNavigation 并在修复后可重试", async () => {
    const getAgent = vi.fn().mockRejectedValue(new Error("读取失败"));
    useSuperstringStore.setState({
      status: "ready",
      page: "settings",
      settingsView: "agents",
      editorAgentId: AGENT_ID,
      editorDraft: { ...draft },
      agents: [buildAgentResponse(AGENT_ID, "助手A")],
      dirty: false,
      pageEditor: dirtyEditor(),
      apiClient: fakeClient({
        getAgent,
        getPersona: vi.fn(),
        getPolicy: vi.fn().mockResolvedValue({
          auto_enabled: true,
          every_turns: 10,
          target_chars: 500,
          version: 1,
        }),
        listMemorySessions: vi.fn().mockResolvedValue([]),
        listMemoryJobs: vi.fn().mockResolvedValue([]),
      }),
    });

    useSuperstringStore.getState().requestAgentNavigation(OTHER_AGENT_ID);
    await useSuperstringStore.getState().confirmDiscardAndContinue();
    let state = useSuperstringStore.getState();
    expect(state.editorAgentId).toBe(AGENT_ID);
    expect(state.editorDraft?.name).toBe(draft.name);
    expect(state.pendingNavigation).toEqual({
      kind: "agent",
      id: OTHER_AGENT_ID,
    });
    expect(state.navigationConfirmOpen).toBe(true);

    useSuperstringStore.setState({
      apiClient: editClient(OTHER_AGENT_ID, "另一助手"),
    });
    await useSuperstringStore.getState().confirmDiscardAndContinue();
    state = useSuperstringStore.getState();
    expect(state.editorAgentId).toBe(OTHER_AGENT_ID);
    expect(state.editorDraft?.name).toBe("另一助手");
  });
});
