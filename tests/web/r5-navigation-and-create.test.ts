import { beforeEach, describe, expect, it, vi } from "vitest";
import { type AgentResponse, P5ConfigSchema } from "../../src/shared/contracts";
import type { SuperstringApi } from "../../src/web/api";
import { useSuperstringStore } from "../../src/web/store";

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
        getBrowserStateConfig: vi.fn().mockRejectedValue(new Error("浏览器状态不可用")),
      }),
    });

    await useSuperstringStore.getState().bootstrap();

    const state = useSuperstringStore.getState();
    expect(state.status).toBe("ready");
    expect(state.agents).toEqual([]);
    expect(state.sessions).toEqual([]);
    expect(state.modelNames).toEqual(["qwen/test"]);
    expect(state.error).toContain("Agent 暂不可用");
    expect(state.pendingOperations).toBe(0);
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
        listMessages: vi.fn().mockResolvedValue([]),
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
        listMessages: vi.fn().mockResolvedValue([]),
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
        listMessages: vi.fn().mockResolvedValue([
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
        ]),
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
      activeSection: "A",
      dirty: true,
    });
  });

  it("切换分区时先保留当前分区并显示原版三选确认", () => {
    useSuperstringStore.getState().requestSectionNavigation("B");
    const state = useSuperstringStore.getState();
    expect(state.activeSection).toBe("A");
    expect(state.pendingNavigation).toEqual({ kind: "section", section: "B" });
    expect(state.navigationConfirmMessage).toBe("当前分区有未保存修改，是否先保存再切换？");
  });

  it("取消导航会保留草稿、dirty 与当前位置", () => {
    useSuperstringStore.getState().requestPageNavigation("chat");
    useSuperstringStore.getState().cancelPendingNavigation();
    const state = useSuperstringStore.getState();
    expect(state.page).toBe("settings");
    expect(state.settingsView).toBe("agents");
    expect(state.dirty).toBe(true);
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
    const updateAgent = vi.fn().mockRejectedValue(new Error("版本冲突"));
    useSuperstringStore.setState({ apiClient: fakeClient({ updateAgent }) });
    useSuperstringStore.getState().requestSectionNavigation("B");

    await useSuperstringStore.getState().confirmSaveAndContinue();

    const state = useSuperstringStore.getState();
    expect(state.activeSection).toBe("A");
    expect(state.pendingNavigation).toEqual({ kind: "section", section: "B" });
    expect(state.navigationConfirmOpen).toBe(true);
    expect(state.navigationConfirmMessage).toContain("保存失败：版本冲突");
    expect(state.dirty).toBe(true);
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

describe("R6 A/B/C 分区保存隔离", () => {
  const savedAgent = {
    id: AGENT_ID,
    ...draft,
    system_prompt: "",
    created_at: NOW,
    updated_at: NOW,
  };

  beforeEach(() => {
    useSuperstringStore.setState({
      status: "ready",
      editorAgentId: AGENT_ID,
      editorDraft: draft,
      agents: [savedAgent],
      dirty: true,
    });
  });

  it("A 只提交基础字段，不覆盖 B/C 草稿", async () => {
    const updateAgent = vi.fn().mockResolvedValue(savedAgent);
    useSuperstringStore.setState({ activeSection: "A", apiClient: fakeClient({ updateAgent }) });

    expect(await useSuperstringStore.getState().saveCurrentSection()).toBe(true);

    expect(updateAgent).toHaveBeenCalledWith(AGENT_ID, {
      name: draft.name,
      description: draft.description,
      additional_instructions: draft.additional_instructions,
      model_name: draft.model_name,
      temperature: draft.temperature,
      is_active: draft.is_active,
      expected_version: draft.config_version,
    });
  });

  it("B 只提交记忆字段并保留持久化的 C 配置", async () => {
    const changed = {
      ...draft,
      context_compression_model_name: "不应随 B 保存",
      p5_config: {
        ...draft.p5_config,
        retrieval_mode: "broad" as const,
        context_window: 65536,
      },
    };
    const updateAgent = vi.fn().mockResolvedValue(savedAgent);
    useSuperstringStore.setState({
      activeSection: "B",
      editorDraft: changed,
      apiClient: fakeClient({ updateAgent }),
    });

    expect(await useSuperstringStore.getState().saveCurrentSection()).toBe(true);

    const payload = updateAgent.mock.calls[0][1];
    expect(payload).not.toHaveProperty("name");
    expect(payload).not.toHaveProperty("context_compression_model_name");
    expect(payload.p5_config.context_window).toBe(savedAgent.p5_config.context_window);
    expect(payload.p5_config.retrieval_mode).toBe("broad");
    expect(useSuperstringStore.getState().editorDraft?.context_compression_model_name).toBe(
      "不应随 B 保存",
    );
    expect(useSuperstringStore.getState().editorDraft?.p5_config.context_window).toBe(65536);
  });

  it("C 只提交上下文字段并保留持久化的 B 配置", async () => {
    const changed = {
      ...draft,
      memory_retrieval_prompt: "不应随 C 保存",
      p5_config: {
        ...draft.p5_config,
        retrieval_mode: "broad" as const,
        context_window: 65536,
      },
    };
    const updateAgent = vi.fn().mockResolvedValue({
      ...savedAgent,
      context_compression_model_name: changed.context_compression_model_name,
      p5_config: {
        ...savedAgent.p5_config,
        context_window: 65536,
      },
      config_version: 2,
    });
    useSuperstringStore.setState({
      activeSection: "C",
      editorDraft: changed,
      apiClient: fakeClient({
        updateAgent,
        getModelCapacity: vi.fn().mockResolvedValue({
          model: draft.model_name,
          status: "loaded",
          context_length: 131072,
        }),
      }),
    });

    expect(await useSuperstringStore.getState().saveCurrentSection()).toBe(true);

    const payload = updateAgent.mock.calls[0][1];
    expect(payload).not.toHaveProperty("name");
    expect(payload).not.toHaveProperty("memory_retrieval_prompt");
    expect(payload.p5_config.retrieval_mode).toBe(savedAgent.p5_config.retrieval_mode);
    expect(payload.p5_config.context_window).toBe(65536);
    expect(useSuperstringStore.getState().editorDraft?.memory_retrieval_prompt).toBe(
      "不应随 C 保存",
    );
    expect(useSuperstringStore.getState().editorDraft?.p5_config.retrieval_mode).toBe("broad");
  });

  it("C 自定义预算保存前 fail closed 校验模型实际容量", async () => {
    const changed = {
      ...draft,
      p5_config: { ...draft.p5_config, context_window: 65536 },
    };
    const updateAgent = vi.fn();
    useSuperstringStore.setState({
      activeSection: "C",
      editorDraft: changed,
      apiClient: fakeClient({
        updateAgent,
        getModelCapacity: vi.fn().mockResolvedValue({
          model: draft.model_name,
          status: "loaded",
          context_length: 32768,
        }),
      }),
    });

    expect(await useSuperstringStore.getState().saveCurrentSection()).toBe(false);
    expect(updateAgent).not.toHaveBeenCalled();
    expect(useSuperstringStore.getState().feedback).toBe("自定义上下文超过模型实际容量32768");
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
    expect(state.detailOpen).toBe(true);
  });

  it("已有主动草稿重进不覆盖", () => {
    useSuperstringStore.setState({
      status: "ready",
      page: "settings",
      settingsView: "agents",
      editorAgentId: AGENT_ID,
      editorDraft: { ...draft },
      agents: [buildAgentResponse(AGENT_ID, "助手A")],
      dirty: true,
    });

    useSuperstringStore.getState().openAgentSettings();

    const state = useSuperstringStore.getState();
    expect(state.editorAgentId).toBe(AGENT_ID);
    expect(state.editorDraft?.name).toBe(draft.name);
  });
});

describe("R5 同 ID 导航", () => {
  it("同 ID 且草稿为 null 时初始化新建草稿", () => {
    useSuperstringStore.setState({ editorAgentId: "__new__", editorDraft: null });

    useSuperstringStore.getState().requestAgentNavigation("__new__");

    const state = useSuperstringStore.getState();
    expect(state.editorDraft).not.toBeNull();
    expect(state.detailOpen).toBe(true);
  });

  it("同 ID 且已有草稿时立即返回", () => {
    const getAgent = vi.fn();
    useSuperstringStore.setState({
      editorAgentId: AGENT_ID,
      editorDraft: { ...draft },
      apiClient: fakeClient({ getAgent }),
    });

    useSuperstringStore.getState().requestAgentNavigation(AGENT_ID);

    expect(getAgent).not.toHaveBeenCalled();
    expect(useSuperstringStore.getState().editorAgentId).toBe(AGENT_ID);
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
    activeSection: "A" as const,
    dirty: true,
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
    expect(state.dirty).toBe(true);
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
    const updateAgent = vi.fn().mockRejectedValue(new Error("版本冲突"));
    useSuperstringStore.setState({ ...base, apiClient: fakeClient({ updateAgent }) });
    useSuperstringStore.getState().requestAgentNavigation("__new__");

    await useSuperstringStore.getState().confirmSaveAndContinue();

    const state = useSuperstringStore.getState();
    expect(state.editorAgentId).toBe(AGENT_ID);
    expect(state.editorDraft?.name).toBe(draft.name);
    expect(state.dirty).toBe(true);
    expect(state.pendingNavigation).toEqual({ kind: "agent", id: "__new__" });
    expect(state.navigationConfirmOpen).toBe(true);
  });
});

describe("R5 创建流程真实行为", () => {
  it("创建成功获得真实 ID 且第二次保存走 update 不重复 create", async () => {
    const created = buildAgentResponse(NEW_ID, "新建助手");
    const createAgent = vi.fn().mockResolvedValue(created);
    const updateAgent = vi.fn().mockResolvedValue({ ...created, description: "改后" });
    useSuperstringStore.setState({ apiClient: fakeClient({ createAgent, updateAgent }) });

    await useSuperstringStore.getState().editAgent("__new__");
    useSuperstringStore.getState().patchDraft({ name: "新建助手" });
    expect(await useSuperstringStore.getState().saveCurrentSection()).toBe(true);
    expect(useSuperstringStore.getState().editorAgentId).toBe(NEW_ID);
    expect(useSuperstringStore.getState().feedback).toContain("新建助手");

    useSuperstringStore.getState().patchDraft({ description: "改后" });
    expect(await useSuperstringStore.getState().saveCurrentSection()).toBe(true);
    expect(createAgent).toHaveBeenCalledTimes(1);
    expect(updateAgent).toHaveBeenCalledTimes(1);
  });

  it("创建失败保留草稿与 dirty", async () => {
    const createAgent = vi.fn().mockRejectedValue(new Error("创建失败"));
    useSuperstringStore.setState({ apiClient: fakeClient({ createAgent }) });

    await useSuperstringStore.getState().editAgent("__new__");
    useSuperstringStore.getState().patchDraft({ name: "草稿名" });
    expect(await useSuperstringStore.getState().saveCurrentSection()).toBe(false);

    const state = useSuperstringStore.getState();
    expect(state.editorDraft).not.toBeNull();
    expect(state.editorDraft?.name).toBe("草稿名");
    expect(state.editorAgentId).toBe("__new__");
    expect(state.dirty).toBe(true);
    expect(state.error).toContain("创建失败");
  });
});

describe("R5 创建前分区保护", () => {
  it("新建草稿切换非 A 分区被拦截并提示先创建基础记录", async () => {
    await useSuperstringStore.getState().editAgent("__new__");
    useSuperstringStore.getState().patchDraft({ name: "草稿名" });

    useSuperstringStore.getState().requestSectionNavigation("B");

    const state = useSuperstringStore.getState();
    expect(state.activeSection).toBe("A");
    expect(state.feedback).toContain("创建");
    expect(state.editorDraft?.name).toBe("草稿名");
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
      activeSection: "A",
      dirty: true,
      apiClient: editClient(OTHER_AGENT_ID, "助手B"),
    });
    useSuperstringStore.getState().patchDraft({ name: "改动" });
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
      activeSection: "A",
      dirty: true,
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
    expect(state.pendingNavigation).toEqual({ kind: "agent", id: OTHER_AGENT_ID });
    expect(state.navigationConfirmOpen).toBe(true);

    useSuperstringStore.setState({ apiClient: editClient(OTHER_AGENT_ID, "另一助手") });
    await useSuperstringStore.getState().confirmDiscardAndContinue();
    state = useSuperstringStore.getState();
    expect(state.editorAgentId).toBe(OTHER_AGENT_ID);
    expect(state.editorDraft?.name).toBe("另一助手");
  });
});
