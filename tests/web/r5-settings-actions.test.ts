import { beforeEach, describe, expect, it, vi } from "vitest";
import { P5ConfigSchema } from "../../src/shared/contracts";
import type { SuperstringApi } from "../../src/web/api";
import { useSuperstringStore } from "../../src/web/store";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";

function fakeClient(overrides: Partial<SuperstringApi> = {}): SuperstringApi {
  return overrides as SuperstringApi;
}

beforeEach(() => useSuperstringStore.getState().resetForTests(fakeClient()));

describe("R5 设置页动作", () => {
  it("刷新模型列表按原版报告已加载数量", async () => {
    const listModels = vi.fn().mockResolvedValue({
      provider: "lm_studio",
      status: "available",
      models: ["qwen/a", "qwen/a", "qwen/b"],
      default_model: "qwen/a",
    });
    // The refresh also asks for declared external models (0032); none here, so the message stays
    // the local-only one.
    const listModelProviders = vi.fn().mockResolvedValue([]);
    useSuperstringStore.setState({ apiClient: fakeClient({ listModels, listModelProviders }) });

    await useSuperstringStore.getState().refreshModels();

    expect(useSuperstringStore.getState().modelNames).toEqual(["qwen/a", "qwen/b"]);
    expect(useSuperstringStore.getState().modelStatus).toBe("LM Studio 当前报告 2 个已加载模型。");
  });

  it("容量预览去重请求同一模型并计算输入可用预算", async () => {
    const getModelCapacity = vi.fn().mockResolvedValue({
      model: "qwen/a",
      status: "loaded",
      context_length: 32768,
      error_code: null,
    });
    useSuperstringStore.setState({
      editorDraft: {
        name: "助手",
        description: "",
        additional_instructions: "",
        model_name: "qwen/a",
        temperature: 0.7,
        memory_consolidation_model_name: null,
        memory_consolidation_prompt: "整理",
        memory_consolidation_additional_instructions: "",
        memory_retrieval_model_name: "legacy-retrieval",
        memory_retrieval_prompt: "检索",
        context_compression_model_name: null,
        p5_config: P5ConfigSchema.parse({}),
        is_active: true,
        config_version: 1,
        persona_intensity: 60,
      },
      apiClient: fakeClient({ getModelCapacity }),
    });

    await useSuperstringStore.getState().refreshCapacityPreview();

    expect(getModelCapacity).toHaveBeenCalledTimes(1);
    expect(getModelCapacity).toHaveBeenCalledWith("qwen/a");
    expect(useSuperstringStore.getState().capacityPreview).toContain("聊天：实际 32768");
    expect(useSuperstringStore.getState().capacityPreview).not.toContain("记忆读取");
    expect(useSuperstringStore.getState().capacityPreview).toContain("摘要：实际 32768");
    const p5 = P5ConfigSchema.parse({});
    const available = 32768 - p5.max_output_tokens - Math.ceil(32768 * p5.safety_margin_ratio);
    expect(useSuperstringStore.getState().capacityPreview).toContain(`输入可用约 ${available}`);
    getModelCapacity.mockClear();
    await useSuperstringStore
      .getState()
      .refreshCapacityPreview(["chat", "ignored-retrieval", "compress"]);
    expect(getModelCapacity.mock.calls.map(([name]) => name)).toEqual(["chat", "compress"]);
    const draft = useSuperstringStore.getState().editorDraft;
    if (!draft) throw new Error("Missing editor draft");
    useSuperstringStore.setState({
      editorDraft: { ...draft, p5_config: { ...draft.p5_config, max_output_tokens: 1000 } },
    });
    useSuperstringStore.getState().recalculateCapacityPreview();
    expect(getModelCapacity).toHaveBeenCalledTimes(2);
    expect(useSuperstringStore.getState().capacityPreview).toContain(
      `输入可用约 ${32768 - 1000 - Math.ceil(32768 * p5.safety_margin_ratio)}`,
    );
    let finish:
      | ((value: Awaited<ReturnType<SuperstringApi["getModelCapacity"]>>) => void)
      | undefined;
    getModelCapacity.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = useSuperstringStore
      .getState()
      .refreshCapacityPreview(["late-chat", "ignored", "late-compress"]);
    useSuperstringStore.setState({ editorAgentId: OTHER_ID, capacityPreview: "new editor" });
    if (!finish) throw new Error("Missing capacity request");
    finish({ model: "late-chat", status: "loaded", context_length: 32768 });
    await pending;
    expect(getModelCapacity).toHaveBeenCalledTimes(3);
    expect(useSuperstringStore.getState().capacityPreview).toBe("new editor");
    expect(useSuperstringStore.getState().chatContextCapacity).toBeNull();
  });

  it("批量删除按部分成功结果移除条目并保留前三条失败原因", async () => {
    const deleteAgents = vi.fn().mockResolvedValue({
      deleted_count: 1,
      failed_count: 1,
      results: [
        {
          id: AGENT_ID,
          deleted: true,
          error_code: null,
          message: "Agent 已删除",
        },
        {
          id: OTHER_ID,
          deleted: false,
          error_code: "AGENT_IN_USE",
          message: "Agent 已被会话使用",
        },
      ],
    });
    useSuperstringStore.setState({
      agents: [
        { id: AGENT_ID, name: "A" },
        { id: OTHER_ID, name: "B" },
      ] as never,
      editorAgentId: OTHER_ID,
      apiClient: fakeClient({ deleteAgents }),
    });

    await useSuperstringStore.getState().deleteAgents([AGENT_ID, OTHER_ID]);

    expect(useSuperstringStore.getState().agents.map((agent) => agent.id)).toEqual([OTHER_ID]);
    expect(useSuperstringStore.getState().feedback).toBe(
      "批量删除完成：成功 1 个，失败 1 个。 Agent 已被会话使用",
    );
  });
});
