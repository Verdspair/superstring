// P8 系统能力目录：每个目录按钮打开登记路由的对应详情；失败态一次尝试与显式重试。
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AgentResponse,
  P5ConfigSchema,
  type PersonaResponse,
} from "../../src/shared/contracts";
import type { PermissionsResponse } from "../../src/shared/contracts/permissions";
import { api } from "../../src/web/api";
import { toDraft } from "../../src/web/features/agents/draft";
import { selectLocale } from "../../src/web/i18n";
import { i18n } from "../../src/web/i18n/runtime";
import { CapabilitiesWorkspace } from "../../src/web/screens/connections/CapabilitiesWorkspace";
import type { SuperstringState } from "../../src/web/state/types";
import { useSuperstringStore as store } from "../../src/web/store";
import { activeSpace } from "../../src/web/workspace/navigation";
import type { SettingsRoute } from "../../src/web/workspace/settings-routes";

const agent = (id: string) =>
  ({
    id,
    name: id,
    is_active: true,
    config_version: 1,
    model_name: "model",
    p5_config: {},
  }) as AgentResponse;
const persona = (id: string) => ({ id, agent_id: id }) as PersonaResponse;
// 能力详情会渲染记忆/知识规则表单，需要完整的 p5 默认结构而不是空对象。
const configuredAgent = (id: string) =>
  ({ ...agent(id), p5_config: P5ConfigSchema.parse({}) }) as AgentResponse;

const permissions: PermissionsResponse = {
  revision: "pr-1",
  policy: {
    version: 1,
    grants: [],
    execution: {
      research: false,
      code: false,
      modules: {
        mcp: false,
        skills: false,
        web: false,
        tasks: true,
        memoryJobs: true,
        knowledgeJobs: true,
        qqMedia: true,
        qqStickers: true,
      },
      maintenance: { memoryTimeoutSeconds: 3600, knowledgeTimeoutSeconds: 3600 },
      telemetry: { retentionDays: 14 },
      pausedTools: [],
      tasks: { concurrency: 2, retentionHours: 24, leaseSeconds: 30, pollMs: 500 },
      researchLimits: { maxPerRun: 2, maxSteps: 6, deadlineMs: 60_000, maxConclusionChars: 4_000 },
      codeLimits: {
        timeoutMs: 20_000,
        maxCalls: 32,
        concurrency: 3,
        memoryBytes: 33_554_432,
        maxTransferBytes: 1_048_576,
        maxConclusionChars: 4_000,
      },
      loop: {
        maxSteps: 16,
        readBatch: 3,
        noProgress: 3,
        concurrency: 4,
        modelConcurrency: 1,
        providerConcurrency: 1,
      },
      qq: { retryDelayMs: 15_000, maxAttempts: 3, deliveryTtlSeconds: 120 },
    },
  },
  resources: [],
};

async function openRoute(
  fake: Partial<typeof api>,
  route: SettingsRoute,
  patch: Partial<SuperstringState> = {},
) {
  store.getState().resetForTests({ ...api, ...fake } as unknown as typeof api);
  store.setState({ page: "settings", settingsView: "workspace", settingsRoute: route, ...patch });
  render(<CapabilitiesWorkspace />);
  await act(async () => {});
}

const rows: Array<[string, SettingsRoute]> = [
  ["记忆查询", "memory-tools"],
  ["知识查询", "knowledge-tools"],
  ["联网", "web-access"],
  ["媒体与表情", "media-tools"],
  ["任务与执行限制", "execution-settings"],
  ["会话历史摘要", "session-history"],
];

beforeEach(() => {
  selectLocale("zh-CN");
});
afterEach(() => {
  cleanup();
});

describe("system capability directory", () => {
  it("opens the detail registered for every directory row", async () => {
    await openRoute(
      { getPermissions: vi.fn().mockResolvedValue(permissions) },
      "system-capabilities",
    );
    for (const [name, route] of rows) {
      fireEvent.click(screen.getByRole("button", { name: new RegExp(`^${name}`) }));
      expect(store.getState().settingsRoute).toBe(route);
      expect(screen.getByRole("button", { name: "返回系统能力" })).toBeTruthy();
      await act(async () => {
        store.getState().openSettingsRoute("system-capabilities");
      });
      expect(screen.getByRole("button", { name: new RegExp(`^${name}`) })).toBeTruthy();
    }
  });

  it("labels execution as configured per function instead of a single on state", async () => {
    await openRoute(
      { getPermissions: vi.fn().mockResolvedValue(permissions) },
      "system-capabilities",
    );
    const row = screen.getByRole("button", { name: /^任务与执行限制/ });
    expect(within(row).getByText("按功能配置")).toBeTruthy();
    expect(within(row).queryByText("已开启，仍受授权与会话范围约束")).toBeNull();
  });

  it("offers a retry when the permission snapshot cannot be read", async () => {
    const getPermissions = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue(permissions);
    await openRoute({ getPermissions }, "system-capabilities");
    expect(screen.getByRole("alert")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await act(async () => {});
    expect(getPermissions).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("attempts the automatic agent load once and retries only on demand", async () => {
    const getAgent = vi.fn().mockRejectedValue(new Error("boom"));
    await openRoute(
      {
        getAgent,
        getPersona: vi.fn().mockResolvedValue(persona("A")),
      },
      "memory-tools",
      { agents: [agent("A")], reloadMemory: vi.fn().mockResolvedValue(undefined) },
    );
    expect(getAgent).toHaveBeenCalledTimes(1);
    await act(async () => {});
    await act(async () => {});
    expect(getAgent).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert").textContent).toContain("boom");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await act(async () => {});
    expect(getAgent).toHaveBeenCalledTimes(2);
  });

  it("loads the chosen assistant before jumping to its short-term context", async () => {
    await openRoute(
      {
        getAgent: vi.fn(async (id: string) => agent(id)),
        getPersona: vi.fn(async (id: string) => persona(id)),
      },
      "session-history",
      { agents: [agent("A")], reloadMemory: vi.fn().mockResolvedValue(undefined) },
    );
    const jump = screen.getByRole("button", { name: "打开短期上下文" });
    await waitFor(() => expect(store.getState().pageEditor).not.toBeNull());
    expect(store.getState().error).toBeNull();
    await waitFor(() => expect(jump.hasAttribute("disabled")).toBe(false));
    expect(store.getState().error).toBeNull();
    await waitFor(() => expect(jump.hasAttribute("disabled")).toBe(false));
    fireEvent.click(jump);
    expect(store.getState().settingsRoute).toBe("context");
    expect(activeSpace(store.getState())).toBe("assistants");
  });

  it("keeps the session history copy separate from the compression switch", () => {
    expect(i18n.t("capabilities.session.description")).toContain("自动");
    expect(i18n.t("capabilities.session.description")).toContain("没有独立总开关");
    expect(i18n.t("capabilities.session.description")).not.toContain("压缩");
    expect(i18n.t("capabilities.session.note")).toContain("压缩");
    expect(i18n.t("capabilities.session.note")).toContain("短期上下文");
  });
});

describe("save 后（pageEditor=null / editorDraft 非空）进入能力详情", () => {
  // 保存成功后的状态：pageEditor 已清空，editorDraft 保留；当前助手 B 不在列表首位。
  const postSave = () => ({
    agents: [configuredAgent("A"), configuredAgent("B")],
    editorAgentId: "B",
    editorDraft: toDraft(configuredAgent("B")),
    pageEditor: null,
    dirty: false,
  });

  it("memory-tools：重新读取当前（非首位）助手并渲染记忆读取，而不是永久加载", async () => {
    const getAgent = vi.fn(async (id: string) => configuredAgent(id));
    await openRoute(
      { getAgent, getPersona: vi.fn(async (id: string) => persona(id)) },
      "memory-tools",
      { ...postSave(), reloadMemory: vi.fn().mockResolvedValue(undefined) },
    );
    await waitFor(() => expect(screen.getByText("记忆读取")).toBeTruthy());
    expect(getAgent).toHaveBeenCalledTimes(1);
    expect(getAgent).toHaveBeenCalledWith("B");
    expect(store.getState().editorAgentId).toBe("B");
    expect(store.getState().error).toBeNull();
    expect(screen.queryByText("正在加载…")).toBeNull();
  });

  it("knowledge-tools：重新读取后渲染知识读取规则", async () => {
    const getAgent = vi.fn(async (id: string) => configuredAgent(id));
    await openRoute(
      {
        getAgent,
        getPersona: vi.fn(async (id: string) => persona(id)),
        getAgentKnowledgeRead: vi.fn().mockResolvedValue({
          revision: 1,
          config: {
            enabled: true,
            context_budget: 2048,
            scope: "all" as const,
            document_ids: [] as string[],
          },
        }),
        listAgentKnowledge: vi.fn().mockResolvedValue([]),
        getKnowledgeSettings: vi.fn().mockResolvedValue({
          auto_enabled: false,
          model_name: null,
          context_budget: 16_384,
          revision: 1,
        }),
      },
      "knowledge-tools",
      { ...postSave(), reloadMemory: vi.fn().mockResolvedValue(undefined) },
    );
    await waitFor(() => expect(store.getState().knowledgeReadEditor?.agentId).toBe("B"));
    expect(getAgent).toHaveBeenCalledWith("B");
    expect(store.getState().editorAgentId).toBe("B");
    expect(store.getState().error).toBeNull();
    await waitFor(() => expect(screen.getByRole("checkbox")).toBeTruthy());
  });

  it("session-history：沿同一守卫恢复并保持当前非首位选择", async () => {
    const getAgent = vi.fn(async (id: string) => configuredAgent(id));
    await openRoute(
      { getAgent, getPersona: vi.fn(async (id: string) => persona(id)) },
      "session-history",
      { ...postSave(), reloadMemory: vi.fn().mockResolvedValue(undefined) },
    );
    await waitFor(() => expect(store.getState().pageEditor).not.toBeNull());
    expect(getAgent).toHaveBeenCalledWith("B");
    expect(store.getState().editorAgentId).toBe("B");
    const jump = screen.getByRole("button", { name: "打开短期上下文" });
    await waitFor(() => expect(jump.hasAttribute("disabled")).toBe(false));
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("B");
  });

  it("脏 __new__ 草稿经同一守卫弹显式确认，取消不丢稿", async () => {
    const getAgent = vi.fn(async (id: string) => configuredAgent(id));
    await openRoute(
      { getAgent, getPersona: vi.fn(async (id: string) => persona(id)) },
      "memory-tools",
      {
        agents: [configuredAgent("A"), configuredAgent("B")],
        selectedNewSessionAgentId: "B",
        editorAgentId: "__new__",
        editorDraft: { ...toDraft(configuredAgent("B")), name: "新助手草稿" },
        pageEditor: null,
        dirty: true,
        reloadMemory: vi.fn().mockResolvedValue(undefined),
      },
    );
    await waitFor(() => expect(store.getState().navigationConfirmOpen).toBe(true));
    expect(store.getState().pendingNavigation).toEqual({ kind: "agent", id: "B" });
    expect(store.getState().editorDraft?.name).toBe("新助手草稿");
    expect(store.getState().dirty).toBe(true);
    expect(getAgent).not.toHaveBeenCalled();
    expect(screen.getByText("有未保存的修改；切换 Agent 前请先保存或放弃。")).toBeTruthy();

    act(() => store.getState().cancelPendingNavigation());
    const state = store.getState();
    expect(state.pendingNavigation).toBeNull();
    expect(state.navigationConfirmOpen).toBe(false);
    expect(state.editorAgentId).toBe("__new__");
    expect(state.editorDraft?.name).toBe("新助手草稿");
    expect(state.dirty).toBe(true);
  });

  it("保存后首次读取失败只尝试一次，点重试才再次请求", async () => {
    const getAgent = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockImplementation(async (id: string) => configuredAgent(id));
    await openRoute(
      { getAgent, getPersona: vi.fn(async (id: string) => persona(id)) },
      "memory-tools",
      { ...postSave(), reloadMemory: vi.fn().mockResolvedValue(undefined) },
    );
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("boom"));
    await act(async () => {});
    expect(getAgent).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await act(async () => {});
    await waitFor(() => expect(store.getState().pageEditor).not.toBeNull());
    expect(getAgent).toHaveBeenCalledTimes(2);
    expect(store.getState().error).toBeNull();
    expect(screen.getByText("记忆读取")).toBeTruthy();
  });

  it("未就绪且无错误无脏稿时提供显式重试兜底（忙时禁用）", async () => {
    const getAgent = vi.fn(async (id: string) => configuredAgent(id));
    await openRoute(
      { getAgent, getPersona: vi.fn(async (id: string) => persona(id)) },
      "memory-tools",
      { ...postSave(), knowledgeBusy: true, reloadMemory: vi.fn().mockResolvedValue(undefined) },
    );
    // 忙时的自动请求被守卫静默拦下：不能停在永久裸加载。
    expect(getAgent).not.toHaveBeenCalled();
    expect(store.getState().pageEditor).toBeNull();
    const retry = screen.getByRole("button", { name: "重试" });
    expect(retry.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("正在加载…")).toBeTruthy();

    await act(async () => {
      store.setState({ knowledgeBusy: false });
    });
    expect(retry.hasAttribute("disabled")).toBe(false);
    fireEvent.click(retry);
    await act(async () => {});
    expect(getAgent).toHaveBeenCalledWith("B");
    await waitFor(() => expect(store.getState().pageEditor).not.toBeNull());
    expect(screen.getByText("记忆读取")).toBeTruthy();
  });
});
