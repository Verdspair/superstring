import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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
import { toDraft } from "../../src/web/features/agents/draft";
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
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("记忆管理迟到响应与离页回归", () => {
  const store = useSuperstringStore;
  const setup = (overrides: Partial<typeof api>) => {
    store.getState().resetForTests(makeClient(overrides));
    store.setState({
      editorAgentId: AGENT_ID,
      page: "settings",
      settingsView: "workspace",
      settingsRoute: "long-memory",
    });
  };
  it.each([false, true])("M1：跨助手来源轮次迟到成功/失败不改新助手状态 (%s)", async (fails) => {
    const pending = deferred<Awaited<ReturnType<typeof api.listMemoryTurns>>>();
    setup({ listMemoryTurns: vi.fn(() => pending.promise) });
    const work = store.getState().loadMemoryTurns(SESSION_ID, 20);
    store.setState({ editorAgentId: "B", feedback: "B feedback", error: "B error" });
    if (fails) pending.reject(new Error("A failed"));
    else
      pending.resolve({
        scope: "reality_user",
        turns: [{ id: TURN_ID, sequence_no: 1, user: "A", assistant: "A", processed: false }],
      });
    await work;
    expect(store.getState()).toMatchObject({
      memoryTurns: [],
      feedback: "B feedback",
      error: "B error",
    });
  });
  it("M1：同助手切来源后旧响应无效，后发请求优先", async () => {
    const old = deferred<Awaited<ReturnType<typeof api.listMemoryTurns>>>();
    const fresh = {
      scope: "reality_user" as const,
      turns: [{ id: "new", sequence_no: 2, user: "new", assistant: "new", processed: false }],
    };
    setup({
      listMemoryTurns: vi
        .fn()
        .mockImplementationOnce(() => old.promise)
        .mockResolvedValue(fresh),
    });
    const work = store.getState().loadMemoryTurns(SESSION_ID, 20);
    store.getState().clearMemoryTurns();
    await store.getState().loadMemoryTurns("new-session", 20);
    old.resolve({ scope: "reality_user", turns: [] });
    await work;
    expect(store.getState().memoryTurns).toEqual(fresh.turns);
  });
  it.each(["govern", "merge"] as const)("M2：旧%s成功不清新详情或覆盖提示", async (operation) => {
    const old = deferred<never>();
    setup({ [operation]: vi.fn(() => old.promise) });
    const work =
      operation === "govern"
        ? store.getState().governMemories(AGENT_ID, [MEMORY_ID], "suppress", false)
        : store.getState().mergeMemories(AGENT_ID, [MEMORY_ID]);
    store.setState({ editorAgentId: "B", memoryEntryDetail: detail, feedback: "B feedback" });
    old.resolve(undefined as never);
    expect(await work).toBe(false);
    expect(store.getState()).toMatchObject({ memoryEntryDetail: detail, feedback: "B feedback" });
  });
  it("M2：旧列表失败不覆盖新页反馈", async () => {
    const old = deferred<Awaited<ReturnType<typeof api.listMemoryEntries>>>();
    setup({ listMemoryEntries: vi.fn(() => old.promise) });
    const work = store.getState().loadMemoryPage(1);
    store.setState({ settingsRoute: "context", feedback: "context feedback" });
    old.reject(new Error("old list failed"));
    await work;
    expect(store.getState().feedback).toBe("context feedback");
  });
  it("M2：同助手查看新详情后旧治理不清空新详情", async () => {
    const old = deferred<void>();
    setup({ govern: vi.fn(() => old.promise) });
    const work = store.getState().governMemories(AGENT_ID, [MEMORY_ID], "suppress", false);
    await store.getState().loadMemoryEntryDetail(MEMORY_ID);
    old.resolve();
    expect(await work).toBe(false);
    expect(store.getState().memoryEntryDetail).toEqual(detail);
  });
  it("M4：卸载后列表、详情与来源一起清空，重挂载不接收旧轮次", async () => {
    const old = deferred<Awaited<ReturnType<typeof api.listMemoryTurns>>>();
    setup({ listMemoryTurns: vi.fn(() => old.promise) });
    store.setState({
      memorySessions: [{ id: SESSION_ID, title: "source" }],
      memoryEntries: [memory],
      memoryEntryTotal: 1,
      memoryEntryDetail: detail,
    });
    const mounted = render(createElement(SectionB));
    const work = store.getState().loadMemoryTurns(SESSION_ID, 20);
    mounted.unmount();
    render(createElement(SectionB));
    await act(async () => {
      old.resolve({
        scope: "reality_user",
        turns: [{ id: TURN_ID, sequence_no: 1, user: "A", assistant: "A", processed: false }],
      });
      await work;
    });
    expect(store.getState()).toMatchObject({
      memoryTurns: [],
      memoryEntries: [],
      memoryEntryTotal: 0,
      memoryEntryDetail: null,
    });
    expect((screen.getByRole("combobox", { name: "来源会话" }) as HTMLSelectElement).value).toBe(
      "",
    );
    expect(document.querySelectorAll(".memory-row,.memory-entry-row")).toHaveLength(0);
  });
  it("M4：未保存纠正仍阻止离页，重置不删除纠正草稿", () => {
    setup({});
    store.setState({ memoryCorrectionDirty: true, memoryEntryDetail: detail });
    store.getState().openSettingsRoute("context");
    expect(store.getState().navigationConfirmOpen).toBe(true);
    expect(store.getState().settingsRoute).toBe("long-memory");
    store.getState().resetMemoryManagement();
    expect(store.getState().memoryEntryDetail).toEqual(detail);
    expect(store.getState().memoryCorrectionDirty).toBe(true);
  });
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

describe("记忆管理统一交互", () => {
  it("未选来源或记忆时禁用动作，不渲染空详情框", () => {
    useSuperstringStore.setState({ editorAgentId: AGENT_ID });
    const { container } = render(createElement(SectionB));
    for (const name of [
      "加载可选择的轮次",
      "开始整理所选轮次",
      "整合为新记忆",
      "永久删除所选条目",
    ]) {
      expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
    }
    expect(container.querySelector(".memory-detail-panel")).toBeNull();
    expect(container.querySelector("textarea")).toBeNull();
  });
  it("逐条查看不依赖批量勾选，永久删除需要先选条目再确认", async () => {
    const client = makeClient();
    useSuperstringStore.getState().resetForTests(client);
    useSuperstringStore.setState({ editorAgentId: AGENT_ID, memoryEntries: [memory] });
    render(createElement(SectionB));
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: `查看记忆：${memory.name}` })),
    );
    expect(client.getMemoryEntry).toHaveBeenCalledWith(AGENT_ID, MEMORY_ID);
    expect(screen.getByRole("region", { name: "记忆详情（只读）" })).toBeTruthy();
    const remove = screen.getByRole("button", { name: "永久删除所选条目" }) as HTMLButtonElement;
    fireEvent.click(screen.getByRole("checkbox", { name: `选择记忆：${memory.name}` }));
    expect(remove.disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "我确认永久删除当前勾选的记忆条目" }));
    expect(remove.disabled).toBe(false);
    fireEvent.click(screen.getByRole("checkbox", { name: `选择记忆：${memory.name}` }));
    expect(remove.disabled).toBe(true);
    expect(
      (
        screen.getByRole("checkbox", {
          name: "我确认永久删除当前勾选的记忆条目",
        }) as HTMLInputElement
      ).checked,
    ).toBe(false);
  });
  it("纠正稿存在时保护列表、详情、批量操作", () => {
    useSuperstringStore.setState({
      editorAgentId: AGENT_ID,
      memoryEntries: [memory],
      memoryCorrectionDirty: true,
    });
    render(createElement(SectionB));
    for (const name of ["加载记忆列表", `查看记忆：${memory.name}`, "整合为新记忆"])
      expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("R5 B 区可见契约", () => {
  it("只保留手动整理与记忆列表治理，且不增加任务控制台或重试按钮", () => {
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
      memorySessions: [{ id: SESSION_ID, title: "测试会话" }],
      memoryTurns: [],
      memoryEntries: [memory],
      memoryEntryDetail: detail,
    });

    const draft = useSuperstringStore.getState().editorDraft;
    if (!draft) throw new Error("测试夹具缺少 Agent 草稿");
    const html = renderToStaticMarkup(createElement(SectionB));
    expect(html).not.toContain("自动整理</strong>");
    expect(html).not.toContain("长期记忆</button>");
    expect(html).toContain('id="settings-memory-management"');
    expect(html).toContain("手动整理</strong>");
    expect(html).toContain("记忆列表与治理</strong>");
    expect(html).toContain("开始整理所选轮次");
    expect(html).toContain("查看详情");
    expect(html).not.toContain("查看第一条已选记忆的详情");
    expect(html).not.toContain("任务控制台");
    expect(html).not.toContain("重试失败任务");
    expect(html).not.toContain("⑤ 整理任务");
  });
});
