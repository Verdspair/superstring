import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentResponseSchema,
  type MemoryEntryResponse,
  type MemoryJobView,
  type MemorySummary,
  PersonaResponseSchema,
} from "../../src/shared/contracts";
import { SectionB } from "../../src/web/App";
import { api } from "../../src/web/api";
import { useSuperstringStore } from "../../src/web/store";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const TURN_ID = "33333333-3333-4333-8333-333333333333";
const MEMORY_ID = "44444444-4444-4444-8444-444444444444";
const JOB_ID = "55555555-5555-4555-8555-555555555555";
const NOW = "2026-09-12T02:00:00.000Z";

const agent = AgentResponseSchema.parse({
  id: AGENT_ID,
  name: "小助",
  description: "",
  system_prompt: "",
  additional_instructions: "",
  model_name: "qwen/test",
  temperature: 0.7,
  memory_consolidation_model_name: null,
  memory_retrieval_model_name: null,
  context_compression_model_name: null,
  persona_intensity: 60,
  config_version: 1,
  created_at: NOW,
  updated_at: NOW,
});

const persona = PersonaResponseSchema.parse({
  id: "66666666-6666-4666-8666-666666666666",
  agent_id: AGENT_ID,
  core_identity: "",
  communication_style: "",
  interaction_boundaries: "",
  example_dialogues: "",
  advanced_instructions: "",
  created_at: NOW,
  updated_at: NOW,
});

const memory: MemorySummary = {
  id: MEMORY_ID,
  name: "项目约定",
  summary: "使用当前实现复刻",
  tags: ["项目"],
  kinds: ["semantic"],
  status: "active",
  created_at: NOW,
  scope: "agent",
  scope_key: AGENT_ID,
};

const detail: MemoryEntryResponse = {
  ...memory,
  body: "不恢复已经撤销的机制。",
  config_snapshot: "{}",
};

const queuedJob: MemoryJobView = {
  id: JOB_ID,
  kind: "manual",
  session_id: SESSION_ID,
  status: "queued",
  result_id: null,
  error_code: null,
  created_at: NOW,
  finished_at: null,
};

const makeClient = (overrides: Partial<typeof api> = {}): typeof api => ({
  ...api,
  listAgents: vi.fn().mockResolvedValue([agent]),
  getAgent: vi.fn().mockResolvedValue(agent),
  getPersona: vi.fn().mockResolvedValue(persona),
  listSessions: vi.fn().mockResolvedValue([]),
  listModels: vi.fn().mockResolvedValue({ models: ["qwen/test"] }),
  getPolicy: vi.fn().mockResolvedValue({
    auto_enabled: false,
    every_turns: 20,
    target_chars: 300,
    version: 1,
  }),
  listMemorySessions: vi.fn().mockResolvedValue([{ id: SESSION_ID, title: "测试会话" }]),
  listMemoryJobs: vi.fn().mockResolvedValue([]),
  listMemoryTurns: vi.fn().mockResolvedValue({
    scope: "reality_user",
    turns: [
      {
        id: TURN_ID,
        sequence_no: 7,
        user: "用户问题",
        assistant: "助手回答",
        processed: false,
      },
    ],
  }),
  listMemoryEntries: vi.fn().mockResolvedValue({ total: 1, items: [memory] }),
  getMemoryEntry: vi.fn().mockResolvedValue(detail),
  consolidate: vi.fn().mockResolvedValue(queuedJob),
  getMemoryJob: vi.fn().mockResolvedValue({
    ...queuedJob,
    status: "succeeded",
    result_id: MEMORY_ID,
    finished_at: NOW,
  }),
  ...overrides,
});

beforeEach(() => {
  useSuperstringStore.getState().resetForTests(makeClient());
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("R5 B 区记忆面板状态", () => {
  it("同时加载策略、来源会话和最新任务，但不加载任务控制台", async () => {
    useSuperstringStore.setState({ editorAgentId: AGENT_ID });
    await useSuperstringStore.getState().reloadMemory();

    const state = useSuperstringStore.getState();
    expect(state.policy?.every_turns).toBe(20);
    expect(state.memorySessions).toEqual([{ id: SESSION_ID, title: "测试会话" }]);
    expect(state.feedback).toContain("整理完成后可在“记忆列表与治理”中查看结果");
  });

  it("按页码换算 offset，并加载第一条已选记忆的详情", async () => {
    const client = makeClient();
    useSuperstringStore.getState().resetForTests(client);
    useSuperstringStore.setState({ editorAgentId: AGENT_ID });

    await useSuperstringStore.getState().loadMemoryPage(3);
    expect(client.listMemoryEntries).toHaveBeenCalledWith(AGENT_ID, 200, 100);
    expect(useSuperstringStore.getState().feedback).toBe("共 1 条记忆，当前第 3 页。");

    await useSuperstringStore.getState().loadMemoryEntryDetail(MEMORY_ID);
    expect(client.getMemoryEntry).toHaveBeenCalledWith(AGENT_ID, MEMORY_ID);
    expect(useSuperstringStore.getState().memoryEntryDetail?.body).toBe("不恢复已经撤销的机制。");
  });

  it("手动整理提交后轮询，并报告成功结果", async () => {
    const originalTimeout = globalThis.setTimeout;
    globalThis.setTimeout = ((callback: TimerHandler) => {
      if (typeof callback === "function") callback();
      return 0;
    }) as typeof setTimeout;
    const client = makeClient();
    useSuperstringStore.getState().resetForTests(client);
    useSuperstringStore.setState({ editorAgentId: AGENT_ID });

    try {
      await useSuperstringStore.getState().manualConsolidate(SESSION_ID, [TURN_ID]);
    } finally {
      globalThis.setTimeout = originalTimeout;
    }

    expect(client.consolidate).toHaveBeenCalledWith(
      AGENT_ID,
      expect.objectContaining({ session_id: SESSION_ID, turn_ids: [TURN_ID] }),
    );
    expect(client.getMemoryJob).toHaveBeenCalledWith(AGENT_ID, JOB_ID);
    expect(useSuperstringStore.getState().feedback).toBe(
      "整理完成，已写入长期记忆。可在“记忆列表与治理”中查看。",
    );
  });

  it("自动策略保存失败后重新读取服务器值", async () => {
    const client = makeClient({
      updatePolicy: vi.fn().mockRejectedValue(new Error("冲突")),
      getPolicy: vi.fn().mockResolvedValue({
        auto_enabled: true,
        every_turns: 30,
        target_chars: 500,
        version: 2,
      }),
    });
    useSuperstringStore.getState().resetForTests(client);
    useSuperstringStore.setState({
      editorAgentId: AGENT_ID,
      policy: {
        auto_enabled: false,
        every_turns: 20,
        target_chars: 300,
        version: 1,
      },
    });

    await useSuperstringStore.getState().updatePolicy({
      auto_enabled: true,
      every_turns: 20,
      target_chars: 300,
    });

    expect(useSuperstringStore.getState().policy?.version).toBe(2);
    expect(useSuperstringStore.getState().feedback).toBe("保存未成功，已恢复服务器值，请重试。");
  });
});

describe("R5 B 区可见契约", () => {
  it("渲染原版三个记忆子面板，且不增加任务控制台或重试按钮", () => {
    useSuperstringStore.setState({
      status: "ready",
      page: "settings",
      settingsView: "agents",
      activeSection: "B",
      detailOpen: true,
      agents: [agent],
      editorAgentId: AGENT_ID,
      editorDraft: {
        name: agent.name,
        description: agent.description,
        additional_instructions: agent.additional_instructions,
        model_name: agent.model_name,
        temperature: agent.temperature,
        memory_consolidation_model_name: agent.memory_consolidation_model_name,
        memory_consolidation_prompt: agent.memory_consolidation_prompt,
        memory_consolidation_additional_instructions:
          agent.memory_consolidation_additional_instructions,
        memory_retrieval_model_name: agent.memory_retrieval_model_name,
        memory_retrieval_prompt: agent.memory_retrieval_prompt,
        context_compression_model_name: agent.context_compression_model_name,
        p5_config: agent.p5_config,
        is_active: agent.is_active,
        config_version: agent.config_version,
        persona_intensity: agent.persona_intensity,
      },
      persona,
      policy: {
        auto_enabled: false,
        every_turns: 20,
        target_chars: 300,
        version: 1,
      },
      memorySessions: [{ id: SESSION_ID, title: "测试会话" }],
      memoryTurns: [],
      memoryEntries: [memory],
      memoryEntryDetail: detail,
    });

    const draft = useSuperstringStore.getState().editorDraft;
    if (!draft) throw new Error("测试夹具缺少 Agent 草稿");
    const html = renderToStaticMarkup(
      createElement(SectionB, {
        draft,
        patch: useSuperstringStore.getState().patchDraft,
        models: ["qwen/test"],
      }),
    );
    expect(html).toContain("自动整理</strong>");
    expect(html).toContain("手动整理</strong>");
    expect(html).toContain("记忆列表与治理</strong>");
    expect(html).toContain("第 4 步：开始整理所选轮次");
    expect(html).toContain("查看第一条已选记忆的详情");
    expect(html).not.toContain("任务控制台");
    expect(html).not.toContain("重试失败任务");
    expect(html).not.toContain("⑤ 整理任务");
  });
});
