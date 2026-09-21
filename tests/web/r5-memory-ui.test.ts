import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentResponseSchema,
  P5ConfigSchema,
  PersonaResponseSchema,
} from "../../src/shared/contracts";
import { SectionB } from "../../src/web/App";
import type { SuperstringApi } from "../../src/web/api";
import { toDraft } from "../../src/web/features/agents/draft";
import { useSuperstringStore } from "../../src/web/store";

const NOW = "2026-09-12T00:00:00.000000Z";
const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const TURN_ID = "33333333-3333-4333-8333-333333333333";
const JOB_ID = "44444444-4444-4444-8444-444444444444";
const MEMORY_ID = "55555555-5555-4555-8555-555555555555";

const agent = AgentResponseSchema.parse({
  id: AGENT_ID,
  name: "测试助手",
  description: "",
  system_prompt: "",
  additional_instructions: "",
  model_name: "qwen/test",
  temperature: 0.7,
  memory_consolidation_model_name: null,
  memory_consolidation_prompt: "整理规则",
  memory_consolidation_additional_instructions: "",
  memory_retrieval_model_name: null,
  memory_retrieval_prompt: "相关性规则",
  context_compression_model_name: null,
  p5_config: P5ConfigSchema.parse({}),
  is_active: true,
  config_version: 1,
  persona_intensity: 60,
  created_at: NOW,
  updated_at: NOW,
});

const persona = PersonaResponseSchema.parse({
  id: "persona-1",
  agent_id: AGENT_ID,
  core_identity: "",
  communication_style: "",
  interaction_boundaries: "",
  example_dialogues: "",
  advanced_instructions: "",
  created_at: NOW,
  updated_at: NOW,
});

function fakeClient(overrides: Partial<SuperstringApi> = {}): SuperstringApi {
  return overrides as SuperstringApi;
}

beforeEach(() => {
  useSuperstringStore.getState().resetForTests(fakeClient());
  vi.restoreAllMocks();
});

describe("R5 B 区可见契约", () => {
  it("只保留手动整理与记忆列表治理，且不新增任务控制台或重试入口", () => {
    useSuperstringStore.setState({
      status: "ready",
      page: "settings",
      settingsView: "agents",
      activeSection: "B",
      agents: [agent],
      editorAgentId: AGENT_ID,
      editorDraft: toDraft(agent),
      persona,
      policy: {
        auto_enabled: false,
        every_turns: 20,
        target_chars: 300,
        version: 1,
      },
      memorySessions: [{ id: SESSION_ID, title: "来源会话" }],
      memoryTurns: [
        {
          id: TURN_ID,
          sequence_no: 7,
          user: "用户内容",
          assistant: "助手回复",
          processed: false,
        },
      ],
      memoryEntries: [
        {
          id: MEMORY_ID,
          name: "记忆名称",
          summary: "记忆简介",
          tags: [],
          kinds: [],
          status: "active",
          scope: "reality_user",
          scope_key: AGENT_ID,
          created_at: NOW,
        },
      ],
    });

    const draft = useSuperstringStore.getState().editorDraft;
    if (!draft) throw new Error("测试夹具缺少 Agent 草稿");
    const html = renderToStaticMarkup(createElement(SectionB));
    expect(html).not.toContain("自动整理</strong>");
    expect(html).not.toContain("选项修改后立即保存");
    for (const text of [
      'id="settings-memory-management"',
      "手动整理</strong>",
      "记忆列表与治理</strong>",
      "开始整理所选轮次",
      "查看详情",
      "我确认永久删除当前勾选的记忆条目",
    ]) {
      expect(html).toContain(text);
    }
    expect(html).not.toContain("⑤ 整理任务");
    expect(html).not.toContain("任务控制台");
    expect(html).not.toContain("重试失败任务");
    expect(html).not.toContain("作用域");
  });
});

describe("R5 记忆状态动作", () => {
  it("按页请求 100 条并保留未分页总数", async () => {
    const listMemoryEntries = vi.fn().mockResolvedValue({ total: 205, items: [] });
    useSuperstringStore.setState({
      editorAgentId: AGENT_ID,
      apiClient: fakeClient({ listMemoryEntries }),
    });

    await useSuperstringStore.getState().loadMemoryPage(3);

    expect(listMemoryEntries).toHaveBeenCalledWith(AGENT_ID, 200, 100);
    expect(useSuperstringStore.getState().memoryEntryTotal).toBe(205);
    expect(useSuperstringStore.getState().feedback).toBe("共 205 条记忆，当前第 3 页。");
  });

  it("手动整理终态成功时不显示任务控制台，只报告写入结果", async () => {
    const consolidate = vi.fn().mockResolvedValue({
      id: JOB_ID,
      kind: "manual",
      session_id: SESSION_ID,
      status: "succeeded",
      result_id: MEMORY_ID,
      error_code: null,
      created_at: NOW,
      finished_at: NOW,
    });
    useSuperstringStore.setState({
      editorAgentId: AGENT_ID,
      apiClient: fakeClient({ consolidate }),
    });

    await useSuperstringStore.getState().manualConsolidate(SESSION_ID, [TURN_ID]);

    expect(consolidate).toHaveBeenCalledOnce();
    expect(consolidate.mock.calls[0][0]).toBe(AGENT_ID);
    expect(consolidate.mock.calls[0][1]).toMatchObject({
      session_id: SESSION_ID,
      turn_ids: [TURN_ID],
    });
    expect(useSuperstringStore.getState().feedback).toBe(
      "整理完成，已写入长期记忆。可在“记忆列表与治理”中查看。",
    );
  });

  it("自动策略保存失败后重新读取服务器值", async () => {
    const updatePolicy = vi.fn().mockRejectedValue(new Error("冲突"));
    const getPolicy = vi.fn().mockResolvedValue({
      auto_enabled: false,
      every_turns: 20,
      target_chars: 300,
      version: 2,
    });
    useSuperstringStore.setState({
      editorAgentId: AGENT_ID,
      policy: {
        auto_enabled: true,
        every_turns: 10,
        target_chars: 500,
        version: 1,
      },
      apiClient: fakeClient({ updatePolicy, getPolicy }),
    });

    await useSuperstringStore.getState().updatePolicy({
      auto_enabled: true,
      every_turns: 10,
      target_chars: 500,
    });

    expect(getPolicy).toHaveBeenCalledWith(AGENT_ID);
    expect(useSuperstringStore.getState().policy?.version).toBe(2);
    expect(useSuperstringStore.getState().feedback).toBe("保存未成功，已恢复服务器值，请重试。");
  });
});
