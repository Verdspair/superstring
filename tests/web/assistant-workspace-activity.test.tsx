// 助手工作区 activity 门禁与新 Canonical 宿主功能回归：
// 1. 隐藏挂载不得发起请求；激活后空目录只刷新一次；
// 2. 200 行目录下选择计算与渲染提交在无关 store 写入前后输出一致；
// 3. memory-tools / knowledge-tools 路由着陆助手 access 标签；
// 4. 空列表冷入口安全展示创建提示（采用当前 locale 的“创建 Agent”）；
// 5. 记忆规则与每档 Bytes 上下文配额原白名单独立保存，核对 context 保持 saved baseline，不连坐提交；
// 6. 知识库读取 4 字段整份原子保存。

import { act, cleanup, fireEvent, render as renderView, screen } from "@testing-library/react";
import { Profiler } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentResponseSchema, PersonaResponseSchema } from "../../src/shared/contracts";
import { api } from "../../src/web/api";
import { DesignSystemProvider } from "../../src/web/design-system/Providers";
import { newPageEditor } from "../../src/web/features/agents/page-drafts";
import { selectLocale } from "../../src/web/i18n";
import { AssistantWorkspace } from "../../src/web/screens/assistants/AssistantWorkspace";
import { useSuperstringStore as store } from "../../src/web/store";

const render = (...[ui, options]: Parameters<typeof renderView>) =>
  renderView(ui, { wrapper: DesignSystemProvider, ...options });

const A = "11111111-1111-4111-8111-111111111111";
const now = "2026-10-07T00:00:00.000Z";
const agent = AgentResponseSchema.parse({
  id: A,
  name: "Agent A",
  model_name: "model-a",
  config_version: 1,
  persona_intensity: 60,
  created_at: now,
  updated_at: now,
});
const persona = PersonaResponseSchema.parse({
  id: "22222222-2222-4222-8222-222222222222",
  agent_id: A,
  core_identity: "",
  communication_style: "",
  interaction_boundaries: "",
  example_dialogues: "",
  advanced_instructions: "",
  created_at: now,
  updated_at: now,
});

beforeEach(() => {
  selectLocale("zh-CN");
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function prepare(overrides: Partial<typeof api> = {}) {
  const client = {
    ...api,
    listAgents: vi.fn().mockResolvedValue([agent]),
    getAgent: vi.fn().mockResolvedValue(agent),
    getPersona: vi.fn().mockResolvedValue(persona),
    getPolicy: vi
      .fn()
      .mockResolvedValue({ auto_enabled: true, every_turns: 20, target_chars: 1200, version: 1 }),
    listModels: vi.fn().mockResolvedValue({
      provider: "lm_studio",
      status: "available",
      models: ["model-a"],
      default_model: "model-a",
    }),
    listModelProviders: vi.fn().mockResolvedValue([]),
    getAgentKnowledgeRead: vi.fn().mockResolvedValue({
      revision: 1,
      config: { enabled: true, context_budget: 2048, scope: "all", document_ids: [] },
    }),
    listAgentKnowledge: vi.fn().mockResolvedValue([]),
    getKnowledgeSettings: vi.fn().mockResolvedValue({
      auto_enabled: false,
      model_name: null,
      context_budget: 16384,
      revision: 1,
    }),
    ...overrides,
  };
  store.getState().resetForTests(client);
  store.setState({
    reloadMemory: vi.fn().mockResolvedValue(undefined),
    status: "ready" as const,
    page: "settings" as const,
    settingsView: "workspace" as const,
    settingsRoute: "basic" as const,
    agents: [agent],
    editorAgentId: "__new__" as const,
    pageEditor: null,
    editorDraft: null,
    modelNames: [],
  });
  return client;
}

const commits: Array<{ actualDuration: number }> = [];
function onRender(_id: string, phase: string, actualDuration: number) {
  commits.push({ actualDuration });
  if (process.env.PERF_TRACE) console.log(`[commit] ${phase} ${actualDuration.toFixed(2)}ms`);
}

describe("assistant workspace activity gating", () => {
  it("a hidden assistant workspace keeps the empty catalog and fires no model request", async () => {
    const client = prepare();
    await act(async () => {
      render(
        <Profiler id="assistant" onRender={onRender}>
          <AssistantWorkspace active={false} />
        </Profiler>,
      );
    });
    await act(async () => {});
    expect(client.listModels).not.toHaveBeenCalled();
    expect(client.listModelProviders).not.toHaveBeenCalled();
  });

  it("a visible assistant workspace refreshes the empty catalog exactly once", async () => {
    const client = prepare();
    await act(async () => {
      render(
        <Profiler id="assistant" onRender={onRender}>
          <AssistantWorkspace />
        </Profiler>,
      );
    });
    await act(async () => {});
    await act(async () => {});
    expect(client.listModels).toHaveBeenCalledTimes(1);
    expect(client.listModelProviders).toHaveBeenCalledTimes(1);
    expect(store.getState().modelNames).toEqual(["model-a"]);
  });

  it("the new-agent datalist renders each catalog model exactly once from the store snapshot", async () => {
    prepare();
    store.setState({
      editorAgentId: "__new__" as const,
      pageEditor: newPageEditor(agent, persona),
      editorDraft: newPageEditor(agent, persona).draft,
      modelNames: ["model-a", "model-b"],
    });
    await act(async () => {
      render(
        <Profiler id="assistant" onRender={onRender}>
          <AssistantWorkspace />
        </Profiler>,
      );
    });
    const options = [
      ...(document.getElementById("new-agent-models")?.querySelectorAll("option") ?? []),
    ];
    expect(options.map((o) => o.getAttribute("value"))).toEqual(["model-a", "model-b"]);
  });

  it("a 200-row directory renders identically around an unrelated store write with O(1) selection", async () => {
    prepare();
    const many = Array.from({ length: 200 }, (_, i) => ({
      ...agent,
      id: `agent-${String(i).padStart(4, "0")}`,
      name: `Agent ${i}`,
    }));
    store.setState({ agents: many });
    await act(async () => {
      render(
        <Profiler id="assistant" onRender={onRender}>
          <AssistantWorkspace />
        </Profiler>,
      );
    });
    expect(screen.getAllByRole("checkbox")).toHaveLength(200);
    commits.length = 0;
    const t0 = performance.now();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "选择当前结果" }));
    });
    const selectAllMs = performance.now() - t0;
    expect(screen.getAllByRole("checkbox", { checked: true })).toHaveLength(200);
    commits.length = 0;
    await act(async () => {
      store.setState({ modelStatus: "unrelated store write" });
    });
    // 无关写入不改工作区选择切片：提交次数与勾选输出在写入前后一致。
    expect(screen.getAllByRole("checkbox", { checked: true })).toHaveLength(200);
    console.log(`[perf] selectAll200=${selectAllMs.toFixed(2)}ms extraCommits=${commits.length}`);
    expect(commits.length).toBe(0);
  });
});

describe("assistant workspace canonical host & resource rules regressions", () => {
  it("navigating to memory-tools activates studio access tab for the current agent", async () => {
    prepare();
    store.setState({
      editorAgentId: agent.id,
      pageEditor: newPageEditor(agent, persona),
      settingsRoute: "memory-tools",
    });

    render(<AssistantWorkspace active={true} />);
    await act(async () => {});

    // Access tab is selected and active in studio mode
    const accessTab = screen.getByRole("tab", { name: /资料读取/ });
    expect(accessTab).toBeTruthy();
    expect(accessTab.getAttribute("data-state")).toBe("active");
  });

  it("empty agents list renders create prompt cleanly on memory-tools cold entry with __new__ sentinel", async () => {
    prepare();
    store.setState({
      agents: [],
      editorAgentId: "__new__" as const,
      pageEditor: null,
      settingsRoute: "memory-tools",
    });

    render(<AssistantWorkspace active={true} />);
    await act(async () => {});

    // Button accessible name in translation is "创建 Agent"
    const createBtn = screen.getByRole("button", { name: "创建 Agent" });
    expect(createBtn).toBeTruthy();
  });

  it("access tab saves memory-tools whitelist with baseline context preserved without corrupting context Bytes", async () => {
    const updateAgent = vi.fn(async (_id: string, body: unknown) => {
      const { expected_version: _ev, ...changes } = body as Record<string, unknown>;
      return AgentResponseSchema.parse({ ...agent, ...changes, config_version: 2 });
    });
    prepare({ updateAgent });
    store.setState({
      editorAgentId: agent.id,
      pageEditor: newPageEditor(agent, persona),
      settingsRoute: "memory-tools",
    });

    // Patch memory-tools whitelist field
    store.getState().patchPageAgent("memory-tools", {
      memory_retrieval_prompt: "Focus on task facts and user decisions",
    });

    // Also draft a context field that should NOT be saved with memory-tools
    store.getState().patchPageAgent("context", {
      p5_config: { ...agent.p5_config, context_window: 65536 },
    });

    await act(async () => {
      const ok = await store.getState().saveSettingsPage("memory-tools");
      expect(ok).toBe(true);
    });

    expect(updateAgent).toHaveBeenCalledTimes(1);
    const sent = updateAgent.mock.calls[0][1] as Record<string, unknown>;
    expect(sent.memory_retrieval_prompt).toBe("Focus on task facts and user decisions");
    // p5_config 提交的是基线上下文值，context_window 保持已存基线值（未连坐提交草稿的 65536）
    const p5Sent = sent.p5_config as Record<string, unknown>;
    expect(p5Sent).toBeDefined();
    expect(p5Sent.context_window).toBe(agent.p5_config.context_window);
    // 未保存的 context 草稿 65536 在本地草稿中安全保留
    expect(store.getState().pageEditor?.draft.p5_config.context_window).toBe(65536);
  });

  it("submits all 4 fields atomically when saving agent knowledge read", async () => {
    const saveAgentKnowledgeRead = vi.fn().mockResolvedValue({
      revision: 2,
      config: {
        enabled: true,
        context_budget: 4096,
        scope: "all",
        document_ids: [],
      },
    });
    prepare({ saveAgentKnowledgeRead });
    store.setState({
      editorAgentId: agent.id,
      pageEditor: newPageEditor(agent, persona),
      settingsRoute: "knowledge-tools",
      knowledgeReadEditor: {
        token: {},
        agentId: agent.id,
        source: {
          revision: 1,
          config: {
            enabled: false,
            context_budget: 2048,
            scope: "all",
            document_ids: [],
          },
        },
        draft: {
          enabled: true,
          context_budget: 4096,
          scope: "all",
          document_ids: [],
        },
        documents: [],
        globalBudget: 16384,
      } as any,
    });

    await act(async () => {
      const ok = await store.getState().saveKnowledgeRead();
      expect(ok).toBe(true);
    });

    expect(saveAgentKnowledgeRead).toHaveBeenCalledTimes(1);
    expect(saveAgentKnowledgeRead).toHaveBeenCalledWith(agent.id, {
      expected_revision: 1,
      config: {
        enabled: true,
        context_budget: 4096,
        scope: "all",
        document_ids: [],
      },
    });
  });

  it("edits rules and Bytes in the rendered tier and saves each original owner without losing the other draft", async () => {
    let saved = agent;
    const updateAgent = vi.fn(async (_id: string, body: Record<string, unknown>) => {
      const { expected_version, ...patch } = body;
      expect(expected_version).toBe(saved.config_version);
      saved = AgentResponseSchema.parse({
        ...saved,
        ...patch,
        config_version: saved.config_version + 1,
      });
      return saved;
    });
    prepare({ updateAgent });
    const editor = newPageEditor(agent, persona);
    store.setState({
      editorAgentId: agent.id,
      editorDraft: editor.draft,
      pageEditor: editor,
      settingsRoute: "memory-tools",
      modelNames: [agent.model_name],
    });
    render(<AssistantWorkspace active />);
    await act(async () => {});
    const candidates = screen.getAllByLabelText("每次查询扫描候选上限");
    const originalCandidate = agent.p5_config.retrieval_presets.standard.candidate_limit;
    fireEvent.change(candidates[1], { target: { value: String(originalCandidate + 1) } });
    const bytes = screen.getByTestId("reading-preset-max-tokens-standard");
    const originalBytes = agent.p5_config.retrieval_presets.standard.max_tokens;
    fireEvent.change(bytes, { target: { value: String(originalBytes + 512) } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "保存记忆规则" }));
    });
    expect(updateAgent).toHaveBeenCalledTimes(1);
    const rulesPayload = updateAgent.mock.calls[0][1];
    const rulesP5 = rulesPayload.p5_config as typeof agent.p5_config;
    expect(rulesP5.retrieval_presets.standard.candidate_limit).toBe(originalCandidate + 1);
    expect(rulesP5.retrieval_presets.standard.max_tokens).toBe(originalBytes);
    expect((bytes as HTMLInputElement).value).toBe(String(originalBytes + 512));
    fireEvent.change(candidates[1], { target: { value: String(originalCandidate + 2) } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "保存上下文预算" }));
    });
    expect(updateAgent).toHaveBeenCalledTimes(2);
    const contextP5 = updateAgent.mock.calls[1][1].p5_config as typeof agent.p5_config;
    expect(contextP5.retrieval_presets.standard.max_tokens).toBe(originalBytes + 512);
    expect(contextP5.retrieval_presets.standard.candidate_limit).toBe(originalCandidate + 1);
    expect(
      store.getState().pageEditor?.draft.p5_config.retrieval_presets.standard.candidate_limit,
    ).toBe(originalCandidate + 2);
    fireEvent.change(bytes, { target: { value: "-1" } });
    expect((bytes as HTMLInputElement).value).toBe("-1");
    const saveBytes = screen.getByRole("button", { name: "保存上下文预算" });
    expect(saveBytes.hasAttribute("disabled")).toBe(true);
    fireEvent.click(saveBytes);
    expect(updateAgent).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByTestId("reading-discard-memory-btn"));
    expect((bytes as HTMLInputElement).value).toBe(String(originalBytes + 512));
    expect(
      store.getState().pageEditor?.draft.p5_config.retrieval_presets.standard.candidate_limit,
    ).toBe(originalCandidate + 2);
  });
  it("edits the rendered knowledge budget and commits all four fields without saving other drafts", async () => {
    const saveAgentKnowledgeRead = vi.fn().mockResolvedValue({
      revision: 2,
      config: {
        enabled: false,
        context_budget: 6144,
        scope: "all",
        document_ids: [],
      },
    });
    prepare({ saveAgentKnowledgeRead });
    const editor = newPageEditor(agent, persona);
    store.setState({
      editorAgentId: agent.id,
      editorDraft: editor.draft,
      pageEditor: editor,
      settingsRoute: "knowledge-tools",
      modelNames: [agent.model_name],
    });
    render(<AssistantWorkspace active />);
    await act(async () => {});
    fireEvent.change(screen.getByTestId("reading-knowledge-agent-budget-input"), {
      target: { value: "6144" },
    });
    const enabled = screen.getByLabelText("启用知识读取");
    fireEvent.click(enabled);
    await act(async () => {
      fireEvent.click(screen.getByTestId("reading-save-knowledge-agent-btn"));
    });
    expect(saveAgentKnowledgeRead).toHaveBeenCalledExactlyOnceWith(agent.id, {
      expected_revision: 1,
      config: { enabled: false, context_budget: 6144, scope: "all", document_ids: [] },
    });
    expect(store.getState().pageEditor?.agent.config_version).toBe(1);
  });

  it("hydrates a direct reading entry once and allows an explicit retry after loading fails", async () => {
    const getAgent = vi
      .fn()
      .mockRejectedValueOnce(new Error("synthetic read failure"))
      .mockResolvedValue(agent);
    const client = prepare({ getAgent });
    store.setState({
      settingsRoute: "memory-tools",
      editorAgentId: agent.id,
      modelNames: [agent.model_name],
    });
    render(<AssistantWorkspace active />);
    await act(async () => {});
    expect(getAgent).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert").textContent).toContain("synthetic read failure");
    await act(async () => {});
    expect(getAgent).toHaveBeenCalledTimes(1);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "重试" }));
    });
    expect(getAgent).toHaveBeenCalledTimes(2);
    expect(store.getState().pageEditor?.agent.id).toBe(agent.id);
    expect(screen.getByTestId("reading-section-memory")).toBeTruthy();
    expect(client.listModels).not.toHaveBeenCalled();
  });
});
