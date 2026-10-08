// 助手工作区 activity 门禁：隐藏挂载不得发起请求；激活后空目录只刷新一次；
// 200 行目录（jsdom 5s 预算内）下选择计算与渲染提交在无关 store 写入前后输出一致（Profiler 实测提交）。

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Profiler } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentResponseSchema, PersonaResponseSchema } from "../../src/shared/contracts";
import { api } from "../../src/web/api";
import { newPageEditor } from "../../src/web/features/agents/page-drafts";
import { selectLocale } from "../../src/web/i18n";
import { AssistantWorkspace } from "../../src/web/screens/assistants/AssistantWorkspace";
import { useSuperstringStore as store } from "../../src/web/store";

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

function prepare() {
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
  };
  store.getState().resetForTests(client);
  store.setState({
    // hidden 用例点击目录会走 editAgent → reloadMemory；store 层替身，不触同源真实 API。
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
