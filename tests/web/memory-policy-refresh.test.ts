// 记忆策略显式刷新：409 冲突后 reload/loadMemoryPolicy 必须推进基线版本，
// 已改白名单字段保稿、未改字段跟随新值；失败与迟到响应不得丢稿或覆盖新会话。
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AgentResponse,
  AgentResponseSchema,
  type PersonaResponse,
  PersonaResponseSchema,
  type PolicyView,
} from "../../src/shared/contracts";
import type { SuperstringApi } from "../../src/web/api";
import { dirtyPages, newPageEditor } from "../../src/web/features/agents/page-drafts";
import { selectLocale } from "../../src/web/i18n";
import { useSuperstringStore as store } from "../../src/web/store";

const NOW = "2026-09-19T00:00:00.000Z";

function agent(id = "A"): AgentResponse {
  return AgentResponseSchema.parse({
    id,
    name: id,
    model_name: "model",
    config_version: 1,
    persona_intensity: 60,
    created_at: NOW,
    updated_at: NOW,
  });
}

function persona(id = "A"): PersonaResponse {
  return PersonaResponseSchema.parse({
    id,
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

let persisted: AgentResponse;
let serverPolicy: PolicyView;
let client: SuperstringApi;
const sessions = [{ id: "s1", title: "会话一" }];

beforeEach(async () => {
  selectLocale("zh-CN");
  persisted = agent();
  serverPolicy = { auto_enabled: false, every_turns: 20, target_chars: 300, version: 1 };
  client = {
    getAgent: vi.fn(async (id: string) => (id === "A" ? persisted : agent(id))),
    getPersona: vi.fn(async (id: string) => persona(id)),
    getPolicy: vi.fn(async () => structuredClone(serverPolicy)),
    updatePolicy: vi.fn(
      async (
        _id: string,
        body: {
          auto_enabled: boolean;
          every_turns: number;
          target_chars: number;
          expected_version: number;
        },
      ) => {
        if (body.expected_version !== serverPolicy.version) throw new Error("版本冲突");
        serverPolicy = {
          auto_enabled: body.auto_enabled,
          every_turns: body.every_turns,
          target_chars: body.target_chars,
          version: serverPolicy.version + 1,
        };
        return structuredClone(serverPolicy);
      },
    ),
    listMemorySessions: vi.fn(async () => structuredClone(sessions)),
    listMemoryJobs: vi.fn(async () => []),
    updateAgent: vi.fn(async (_id: string, body: Record<string, unknown>) => {
      const { expected_version, ...patch } = body;
      expect(expected_version).toBe(persisted.config_version);
      persisted = {
        ...persisted,
        ...patch,
        config_version: persisted.config_version + 1,
      } as AgentResponse;
      return persisted;
    }),
  } as unknown as SuperstringApi;
  store.getState().resetForTests(client);
  store.setState({
    agents: [persisted, agent("B")],
    page: "settings",
    settingsView: "workspace",
    settingsRoute: "long-memory",
  });
  await store.getState().editAgent("A");
});

describe("记忆策略显式刷新合并", () => {
  it("冲突后刷新推进基线：已改保稿、未改跟随新值，保存使用新版本且两域互不夹带", async () => {
    const initial = store.getState().pageEditor;
    if (!initial) throw new Error("missing page editor");
    expect(initial.policy?.version).toBe(1);
    const flipped = initial.agent.p5_config.retrieval_mode === "off" ? "broad" : "off";

    store.getState().patchPagePolicy({ every_turns: 25 });
    store.getState().patchPageAgent("memory-tools", {
      p5_config: { ...initial.agent.p5_config, retrieval_mode: flipped },
    });
    store.getState().patchPageAgent("long-memory", { memory_consolidation_prompt: "维护提示词" });

    // 其他客户端把服务器策略推进到 v2：本页保存先写提示词成功、策略部分冲突。
    serverPolicy = { auto_enabled: true, every_turns: 30, target_chars: 400, version: 2 };
    expect(await store.getState().saveSettingsPage("long-memory")).toBe(false);
    expect(vi.mocked(client.updatePolicy)).toHaveBeenLastCalledWith("A", {
      auto_enabled: false,
      every_turns: 25,
      target_chars: 300,
      expected_version: 1,
    });

    // 刷新前再补一个未保存的维护草稿，刷新不得把它丢掉。
    store.getState().patchPageAgent("long-memory", {
      memory_consolidation_additional_instructions: "附加草稿",
    });

    await store.getState().reloadMemory();

    const editor = store.getState().pageEditor;
    expect(editor?.policy?.version).toBe(2);
    expect(store.getState().policy?.version).toBe(2);
    expect(editor?.policyDraft?.every_turns).toBe(25); // 已改字段保持草稿
    expect(editor?.policyDraft?.auto_enabled).toBe(true); // 未改字段跟随新基线
    expect(editor?.policyDraft?.target_chars).toBe(400); // 未改字段跟随新基线
    expect(editor?.draft.memory_consolidation_additional_instructions).toBe("附加草稿");
    expect(editor?.draft.p5_config.retrieval_mode).toBe(flipped);
    expect(dirtyPages(editor)).toEqual(["long-memory", "memory-tools"]);

    // 刷新后保存必须使用新版本；维护保存不提交读取草稿。
    expect(await store.getState().saveSettingsPage("long-memory")).toBe(true);
    expect(vi.mocked(client.updatePolicy)).toHaveBeenLastCalledWith("A", {
      auto_enabled: true,
      every_turns: 25,
      target_chars: 400,
      expected_version: 2,
    });
    const maintenanceCall = vi.mocked(client.updateAgent).mock.lastCall;
    expect(maintenanceCall?.[0]).toBe("A");
    const maintenanceBody = maintenanceCall?.[1] as Record<string, unknown> | undefined;
    expect(maintenanceBody).toMatchObject({
      memory_consolidation_prompt: "维护提示词",
      memory_consolidation_additional_instructions: "附加草稿",
    });
    expect(maintenanceBody).not.toHaveProperty("p5_config");
    expect(store.getState().policy?.version).toBe(3);
    expect(dirtyPages(store.getState().pageEditor)).toEqual(["memory-tools"]);

    // 读取草稿保存只带走自己的字段，不再次提交策略。
    expect(await store.getState().saveSettingsPage("memory-tools")).toBe(true);
    expect(vi.mocked(client.updatePolicy)).toHaveBeenCalledTimes(2);
    expect(dirtyPages(store.getState().pageEditor)).toEqual([]);
    const readCall = vi.mocked(client.updateAgent).mock.lastCall;
    const readBody = readCall?.[1] as Record<string, unknown> | undefined;
    expect(readBody?.p5_config).toMatchObject({ retrieval_mode: flipped });
    expect(readBody).not.toHaveProperty("auto_enabled");
  });

  it("loadMemoryPolicy 合并新基线；读取失败保留草稿并给出提示", async () => {
    store.getState().patchPagePolicy({ target_chars: 999 });
    serverPolicy = { auto_enabled: true, every_turns: 30, target_chars: 400, version: 2 };
    await store.getState().loadMemoryPolicy();

    let editor = store.getState().pageEditor;
    expect(editor?.policy?.version).toBe(2);
    expect(editor?.policyDraft?.target_chars).toBe(999);
    expect(editor?.policyDraft?.every_turns).toBe(30);
    expect(editor?.policyDraft?.auto_enabled).toBe(true);

    vi.mocked(client.getPolicy).mockRejectedValueOnce(new Error("读取失败"));
    await store.getState().loadMemoryPolicy();
    editor = store.getState().pageEditor;
    expect(store.getState().error).toContain("读取失败");
    expect(editor?.policy?.version).toBe(2);
    expect(editor?.policyDraft?.target_chars).toBe(999);
  });

  it("reloadMemory 失败保留旧基线、维护草稿与已加载列表并提示失败", async () => {
    expect(store.getState().memorySessions).toEqual(sessions);
    store.getState().patchPagePolicy({ target_chars: 999 });
    const before = store.getState().pageEditor;

    vi.mocked(client.getPolicy).mockRejectedValueOnce(new Error("网络失败"));
    await store.getState().reloadMemory();

    const after = store.getState().pageEditor;
    expect(after?.token).toBe(before?.token);
    expect(after?.policy?.version).toBe(1);
    expect(after?.policyDraft?.target_chars).toBe(999);
    expect(store.getState().policy?.version).toBe(1);
    expect(store.getState().memorySessions).toEqual(sessions);
    expect(store.getState().error).toContain("网络失败");
    expect(store.getState().feedback).toContain("记忆设置未能加载");
  });

  it("迟到策略响应不覆盖切换后的编辑会话", async () => {
    let resolvePolicy!: (value: PolicyView) => void;
    vi.mocked(client.getPolicy).mockImplementationOnce(
      () =>
        new Promise<PolicyView>((resolve) => {
          resolvePolicy = resolve;
        }),
    );
    const pending = store.getState().reloadMemory();
    store.setState({
      editorAgentId: "B",
      pageEditor: newPageEditor(agent("B"), persona("B")),
    });
    resolvePolicy({ auto_enabled: true, every_turns: 30, target_chars: 400, version: 9 });
    await pending;

    expect(store.getState().editorAgentId).toBe("B");
    expect(store.getState().pageEditor?.agent.id).toBe("B");
    expect(store.getState().pageEditor?.policy).toBeNull();
    expect(store.getState().policy?.version).toBe(1);
  });

  it("读取期间的新草稿按返回时状态判定，不被请求前快照覆盖", async () => {
    let resolvePolicy!: (value: PolicyView) => void;
    vi.mocked(client.getPolicy).mockImplementationOnce(
      () =>
        new Promise<PolicyView>((resolve) => {
          resolvePolicy = resolve;
        }),
    );
    const pending = store.getState().reloadMemory();
    store.getState().patchPagePolicy({ every_turns: 99 });
    resolvePolicy({ auto_enabled: true, every_turns: 20, target_chars: 300, version: 2 });
    await pending;

    const editor = store.getState().pageEditor;
    expect(editor?.policy?.version).toBe(2);
    expect(editor?.policyDraft?.every_turns).toBe(99);
    expect(editor?.policyDraft?.auto_enabled).toBe(true);
  });
});
