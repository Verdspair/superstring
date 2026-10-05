// 助手首屏预热：纯人设 + 选中记忆 100 条摘要的预热语义与消费接线（真实 store + 替身 API）。
// 契约真源：parallel-completion-20261005T093149Z/agent-gemini/INTERFACE.md（实际差异以 preload-agent-impl-gf 接口消息为准）。
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EntriesList, PersonaResponse } from "../../src/shared/contracts";
import { AgentResponseSchema, PersonaResponseSchema } from "../../src/shared/contracts/agent";
import { EntriesListSchema, PolicyViewSchema } from "../../src/shared/contracts/memory";
import { api } from "../../src/web/api";
import {
  clearAgentPreloadCache,
  consumePreloadedMemory,
  consumePreloadedPersona,
  getPreloadTargetAgentId,
  isAgentPreloadEligible,
  peekPreloadedMemory,
  peekPreloadedPersona,
  warmAgentResources,
} from "../../src/web/services/agent-preload";
import { useSuperstringStore as store } from "../../src/web/store";

const NOW = "2026-09-30T00:00:00.000Z";
const AGENT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AGENT_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const personaFixture: PersonaResponse = PersonaResponseSchema.parse({
  id: "persona-1",
  agent_id: AGENT,
  core_identity: "核心身份",
  communication_style: "沟通风格",
  interaction_boundaries: "交互边界",
  example_dialogues: "示例对话",
  advanced_instructions: "进阶指令",
  created_at: NOW,
  updated_at: NOW,
});

const entriesFixture: EntriesList = EntriesListSchema.parse({
  total: 2,
  items: [
    {
      id: "m-1",
      name: "第一条记忆",
      summary: "摘要一",
      tags: ["tag-a"],
      kinds: ["fact"],
      status: "active",
      created_at: NOW,
      scope: "web",
      scope_key: AGENT,
    },
    {
      id: "m-2",
      name: "第二条记忆",
      summary: "摘要二",
      tags: [],
      kinds: ["preference"],
      status: "active",
      created_at: NOW,
      scope: "web",
      scope_key: AGENT,
    },
  ],
});

const agentFixture = AgentResponseSchema.parse({
  id: AGENT,
  name: "默认助手",
  model_name: "test-model",
  config_version: 3,
  persona_intensity: 60,
  created_at: NOW,
  updated_at: NOW,
});

const policyFixture = PolicyViewSchema.parse({
  auto_enabled: true,
  every_turns: 20,
  target_chars: 1200,
  version: 1,
});

function agentClient(overrides: Partial<typeof api> = {}) {
  return {
    ...api,
    getAgent: vi.fn().mockResolvedValue(agentFixture),
    getPersona: vi.fn().mockResolvedValue(personaFixture),
    listMemoryEntries: vi.fn().mockResolvedValue(entriesFixture),
    getPolicy: vi.fn().mockResolvedValue(policyFixture),
    listMemorySessions: vi.fn().mockResolvedValue([]),
    listMemoryJobs: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as typeof api;
}

beforeEach(() => {
  clearAgentPreloadCache();
  store.getState().resetForTests();
});

describe("agent preload target & eligibility", () => {
  it("目标 ID 优先级：新会话选中 > 真实编辑目标 > 列表首位；__new__ 与空态落 null", () => {
    expect(
      getPreloadTargetAgentId({
        selectedNewSessionAgentId: AGENT,
        editorAgentId: AGENT_B,
        agents: [{ id: AGENT_B }],
      }),
    ).toBe(AGENT);
    expect(getPreloadTargetAgentId({ editorAgentId: AGENT_B, agents: [{ id: AGENT_B }] })).toBe(
      AGENT_B,
    );
    expect(getPreloadTargetAgentId({ editorAgentId: "__new__", agents: [{ id: AGENT_B }] })).toBe(
      AGENT_B,
    );
    expect(getPreloadTargetAgentId({ editorAgentId: "__new__", agents: [] })).toBeNull();
    expect(getPreloadTargetAgentId({})).toBeNull();
  });

  it("在途草稿（dirty）排除预热；其余只要有目标即合格", () => {
    expect(isAgentPreloadEligible({ selectedNewSessionAgentId: AGENT, dirty: true })).toBe(false);
    expect(isAgentPreloadEligible({ selectedNewSessionAgentId: AGENT })).toBe(true);
    expect(isAgentPreloadEligible({ agents: [] })).toBe(false);
  });
});

describe("warmAgentResources", () => {
  it("一次预热发出纯读两请求：persona + 前 100 条记忆摘要（offset 0）", async () => {
    const fake = agentClient();
    const result = await warmAgentResources(fake, AGENT);
    expect(fake.getPersona).toHaveBeenCalledTimes(1);
    expect(fake.listMemoryEntries).toHaveBeenCalledWith(AGENT, 0, 100);
    expect(result).toEqual({ persona: personaFixture, memoryEntries: entriesFixture });
    expect(peekPreloadedPersona(fake, AGENT)).toEqual(personaFixture);
    expect(peekPreloadedMemory(fake, AGENT)).toEqual(entriesFixture);
    expect(peekPreloadedPersona(fake, AGENT_B)).toBeNull();
  });

  it("同助手重复与并发预热命中同一结果，不重复发包", async () => {
    const fake = agentClient();
    const [a, b] = await Promise.all([
      warmAgentResources(fake, AGENT),
      warmAgentResources(fake, AGENT),
    ]);
    await warmAgentResources(fake, AGENT);
    expect(fake.getPersona).toHaveBeenCalledTimes(1);
    expect(fake.listMemoryEntries).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
  });

  it("单项失败落空该项（部分成功），consume 各自独立取走并清字段", async () => {
    const fake = agentClient({
      getPersona: vi.fn().mockRejectedValue(new Error("persona down")),
    });
    const result = await warmAgentResources(fake, AGENT);
    expect(result.persona).toBeNull();
    expect(result.memoryEntries).toEqual(entriesFixture);
    expect(consumePreloadedPersona(fake, AGENT)).toBeNull();
    expect(consumePreloadedMemory(fake, AGENT)).toEqual(entriesFixture);
    // 取走后单槽字段清空，同助手再次 consume 返回 null。
    expect(consumePreloadedMemory(fake, AGENT)).toBeNull();
  });

  it("双项都失败时预热按失败处理并自愈缓存：可重新预热", async () => {
    const fake = agentClient({
      getPersona: vi.fn().mockRejectedValue(new Error("persona down")),
      listMemoryEntries: vi.fn().mockRejectedValue(new Error("memory down")),
    });
    await expect(warmAgentResources(fake, AGENT)).rejects.toThrow("persona down");
    expect(peekPreloadedPersona(fake, AGENT)).toBeNull();
    expect(peekPreloadedMemory(fake, AGENT)).toBeNull();
    const recovered = agentClient();
    await expect(warmAgentResources(recovered, AGENT)).resolves.toEqual({
      persona: personaFixture,
      memoryEntries: entriesFixture,
    });
  });

  it("clearAgentPreloadCache 清单槽；带助手参数只清匹配项", async () => {
    const fake = agentClient();
    await warmAgentResources(fake, AGENT);
    clearAgentPreloadCache(AGENT_B);
    expect(peekPreloadedPersona(fake, AGENT)).toEqual(personaFixture);
    clearAgentPreloadCache(AGENT);
    expect(peekPreloadedPersona(fake, AGENT)).toBeNull();
    await warmAgentResources(fake, AGENT);
    clearAgentPreloadCache();
    expect(peekPreloadedMemory(fake, AGENT)).toBeNull();
  });

  it("换客户端同 ID 不消费旧数据；迟到旧请求不覆盖新槽位", async () => {
    const deferredOld = Promise.withResolvers<PersonaResponse>();
    const oldClient = agentClient({
      getPersona: vi.fn().mockImplementation(() => deferredOld.promise),
    });
    const warmOld = warmAgentResources(oldClient, AGENT);
    // 清除在途 owner 后旧任务迟到落值被拒绝；新客户端预热成为当前槽位。
    clearAgentPreloadCache();
    const freshClient = agentClient();
    await warmAgentResources(freshClient, AGENT);
    deferredOld.resolve(personaFixture);
    await warmOld;
    expect(peekPreloadedPersona(freshClient, AGENT)).toEqual(personaFixture);
    expect(peekPreloadedPersona(oldClient, AGENT)).toBeNull();
  });
});

describe("foreground consumption wiring", () => {
  it("editAgent 消费预热人设，不再补发 getPersona；未命中时回退真实读取", async () => {
    const fake = agentClient();
    store.getState().resetForTests(fake);
    await warmAgentResources(fake, AGENT);
    const personaCalls = () => vi.mocked(fake.getPersona).mock.calls.length;
    const callsAfterWarm = personaCalls();
    store.setState({ agents: [agentFixture], selectedNewSessionAgentId: AGENT });
    await expect(store.getState().editAgent(AGENT)).resolves.toBe(true);
    // 全程只有预热那一包，前台消费不补第二包。
    expect(personaCalls()).toBe(callsAfterWarm);
    expect(store.getState().persona).toEqual(personaFixture);
    expect(store.getState().editorAgentId).toBe(AGENT);

    // 未命中：直接 editAgent 走前台读取。
    const fallback = agentClient();
    store.getState().resetForTests(fallback);
    store.setState({ agents: [agentFixture], selectedNewSessionAgentId: AGENT });
    await expect(store.getState().editAgent(AGENT)).resolves.toBe(true);
    expect(fallback.getPersona).toHaveBeenCalledTimes(1);
  });

  it("预热在途时 editAgent 共享同一请求：全程只发一包 getPersona", async () => {
    const deferred = Promise.withResolvers<PersonaResponse>();
    const fake = agentClient({
      getPersona: vi.fn().mockImplementation(() => deferred.promise),
    });
    store.getState().resetForTests(fake);
    store.setState({ agents: [agentFixture], selectedNewSessionAgentId: AGENT });
    const warm = warmAgentResources(fake, AGENT);
    const editing = store.getState().editAgent(AGENT);
    deferred.resolve(personaFixture);
    await Promise.all([warm, editing]);
    // 预热那一包即全部发包，前台消费不补第二包。
    expect(fake.getPersona).toHaveBeenCalledTimes(1);
    expect(store.getState().persona).toEqual(personaFixture);
  });

  it("换客户端后 editAgent 不消费旧客户端预热，正常前台重读", async () => {
    const warmClient = agentClient();
    await warmAgentResources(warmClient, AGENT);
    const freshClient = agentClient();
    store.getState().resetForTests(freshClient);
    store.setState({ agents: [agentFixture], selectedNewSessionAgentId: AGENT });
    await expect(store.getState().editAgent(AGENT)).resolves.toBe(true);
    expect(freshClient.getPersona).toHaveBeenCalledTimes(1);
    expect(store.getState().persona).toEqual(personaFixture);
  });

  it("记忆预览只在第 1 页、无筛选且列表为空时消费；其余情况真实读取", async () => {
    const fake = agentClient();
    store.getState().resetForTests(fake);
    store.setState({ editorAgentId: AGENT });
    await warmAgentResources(fake, AGENT);
    const fetchCalls = () => vi.mocked(fake.listMemoryEntries).mock.calls.length;
    const callsAfterWarm = fetchCalls();

    await store.getState().loadMemoryPage(1);
    expect(fetchCalls()).toBe(callsAfterWarm);
    expect(store.getState().memoryEntries).toEqual(entriesFixture.items);
    expect(store.getState().memoryEntryTotal).toBe(entriesFixture.total);

    // 列表非空后回到第 1 页：不再消费预热，走真实读取。
    clearAgentPreloadCache();
    await warmAgentResources(fake, AGENT);
    const beforeRefetch = fetchCalls();
    await store.getState().loadMemoryPage(1);
    expect(fetchCalls()).toBe(beforeRefetch + 1);

    // 带筛选的第 1 页不消费预热。
    clearAgentPreloadCache();
    await warmAgentResources(fake, AGENT);
    const beforeFiltered = fetchCalls();
    await store.getState().loadMemoryPage(1, { status: "active" });
    expect(fetchCalls()).toBe(beforeFiltered + 1);
    expect(vi.mocked(fake.listMemoryEntries).mock.lastCall).toEqual([
      AGENT,
      0,
      100,
      { status: "active" },
    ]);

    // 第 2 页翻页走真实读取（offset 100）。
    const beforePage2 = fetchCalls();
    await store.getState().loadMemoryPage(2);
    expect(fetchCalls()).toBe(beforePage2 + 1);
    // filters 原样透传（无筛选时为 undefined，由 apiClient 参数默认值兜底）。
    expect(vi.mocked(fake.listMemoryEntries).mock.lastCall).toEqual([AGENT, 100, 100, undefined]);
  });

  it("纠正草稿在场时 loadMemoryPage 早退：不消费预热也不覆盖草稿", async () => {
    const fake = agentClient();
    store.getState().resetForTests(fake);
    store.setState({
      editorAgentId: AGENT,
      memoryCorrectionDraft: null,
      memoryCorrectionDirty: true,
    });
    await warmAgentResources(fake, AGENT);
    vi.mocked(fake.listMemoryEntries).mockClear();
    await store.getState().loadMemoryPage(1);
    expect(fake.listMemoryEntries).not.toHaveBeenCalled();
    expect(store.getState().memoryEntries).toEqual([]);
    expect(peekPreloadedMemory(fake, AGENT)).toEqual(entriesFixture);
    expect(store.getState().memoryCorrectionDirty).toBe(true);
  });
});
