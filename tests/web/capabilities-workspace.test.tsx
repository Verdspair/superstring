// P8 系统能力目录：每个目录按钮打开登记路由的对应详情；失败态一次尝试与显式重试；
// 记忆/知识重复编辑器物理移除并转为规范链接，明确无真实 editor 输入框，不机械卸载其他详情。
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AgentResponse,
  P5ConfigSchema,
  type PersonaResponse,
} from "../../src/shared/contracts";
import type { PermissionsResponse } from "../../src/shared/contracts/permissions";
import { api } from "../../src/web/api";
import { toDraft } from "../../src/web/features/agents/draft";
import { newPageEditor } from "../../src/web/features/agents/page-drafts";
import { selectLocale } from "../../src/web/i18n";
import { i18n } from "../../src/web/i18n/runtime";
import { CapabilitiesWorkspace } from "../../src/web/screens/connections/CapabilitiesWorkspace";
import { MemoryLibrary } from "../../src/web/screens/library/MemoryLibrary";
import type { SuperstringState } from "../../src/web/state/types";
import { useSuperstringStore as store } from "../../src/web/store";
import { activeSpace } from "../../src/web/workspace/navigation";
import type { SettingsRoute } from "../../src/web/workspace/settings-routes";
import { setupLibrary } from "./helpers/library-fixture";
import { render } from "./helpers/render-with-providers";

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
        qqMembers: true,
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
      system: { maxAttempts: 3, retryDelayMs: 2000 },
    },
  },
  resources: [],
};

async function openRoute(
  fake: Partial<typeof api>,
  route: SettingsRoute,
  patch: Partial<SuperstringState> = {},
) {
  const metadataMocks = {
    getToolDirectory: vi.fn().mockResolvedValue({ tools: [] }),
    getSkills: vi.fn().mockResolvedValue({ skills: [] }),
    getMcpServers: vi.fn().mockResolvedValue({ servers: [] }),
  };
  store.getState().resetForTests({ ...api, ...metadataMocks, ...fake } as unknown as typeof api);
  store.setState({ page: "settings", settingsView: "workspace", settingsRoute: route, ...patch });
  render(<CapabilitiesWorkspace />);
  await act(async () => {});
}

const rows: Array<[string, SettingsRoute]> = [
  ["记忆查询", "capability-memory"],
  ["知识查询", "capability-knowledge"],
  ["联网", "web-access"],
  ["媒体与表情", "media-tools"],
  ["任务与执行限制", "execution-settings"],
  ["会话历史摘要", "session-history"],
  ["群成员名册", "qq-member-tools"],
];

beforeEach(() => {
  selectLocale("zh-CN");
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("system capability directory", () => {
  it("opens the detail registered for every directory row", async () => {
    await openRoute(
      { getPermissions: vi.fn().mockResolvedValue(permissions) },
      "system-capabilities",
    );
    for (const [name, route] of rows) {
      fireEvent.click(screen.getByRole("button", { name: `前往配置功能 · ${name}` }));
      expect(store.getState().settingsRoute).toBe(route);
      expect(screen.getByRole("button", { name: "返回系统能力" })).toBeTruthy();
      await act(async () => {
        store.getState().openSettingsRoute("system-capabilities");
      });
      expect(screen.getByRole("button", { name: `前往配置功能 · ${name}` })).toBeTruthy();
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

  it("never automatically loads an Agent from a global memory capability", async () => {
    const getAgent = vi.fn().mockRejectedValue(new Error("boom"));
    await openRoute({ getAgent }, "capability-memory", { agents: [configuredAgent("A")] });
    expect(getAgent).not.toHaveBeenCalled();
    expect(screen.getByRole("combobox", { name: "选择要配置的 Agent" })).toHaveProperty(
      "value",
      "",
    );
    expect(screen.getByRole("button", { name: "配置此 Agent 的资料读取" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });
  it("uses an explicitly chosen Agent when leaving global knowledge details", async () => {
    const getAgent = vi.fn(async (id: string) => configuredAgent(id));
    await openRoute(
      { getAgent, getPersona: vi.fn(async (id: string) => persona(id)) },
      "capability-knowledge",
      { agents: [configuredAgent("A"), configuredAgent("B")] },
    );
    fireEvent.change(screen.getByRole("combobox", { name: "选择要配置的 Agent" }), {
      target: { value: "B" },
    });
    fireEvent.click(screen.getByRole("button", { name: "配置此 Agent 的资料读取" }));
    await waitFor(() => expect(getAgent).toHaveBeenCalledWith("B"));
    expect(store.getState().settingsRoute).toBe("knowledge-tools");
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

it.each(["zh-CN", "en"] as const)(
  "%s model shortcuts describe their actual destination and retain the dirty guard",
  async (locale) => {
    setupLibrary({
      getPermissions: vi.fn().mockResolvedValue(permissions),
      getToolDirectory: vi.fn().mockResolvedValue({ tools: [] }),
      getSkills: vi.fn().mockResolvedValue({ skills: [], problems: [] }),
      getMcpServers: vi.fn().mockResolvedValue({ servers: [] }),
    });
    selectLocale(locale);
    store.setState({ settingsRoute: "media-tools" });
    const media = render(<CapabilitiesWorkspace />);
    await act(async () => {});
    const modelServices = screen.getByRole("button", { name: i18n.t("models.title") });
    expect(
      screen.queryByRole("button", { name: i18n.t("library.open.model.services") }),
    ).toBeNull();
    act(() => store.getState().patchPageAgent("basic", { name: "Unsaved Agent" }));
    fireEvent.click(modelServices);
    expect(store.getState().settingsRoute).toBe("media-tools");
    expect(store.getState().pendingNavigation).toMatchObject({
      kind: "page",
      settingsRoute: "models",
    });
    act(() => store.getState().cancelPendingNavigation());
    expect(store.getState().pageEditor?.draft.name).toBe("Unsaved Agent");
    act(() => store.getState().discardSettingsTask("identity"));
    fireEvent.click(modelServices);
    await waitFor(() => expect(store.getState().settingsRoute).toBe("models"));
    media.unmount();
    setupLibrary();
    selectLocale(locale);
    store.setState({ settingsRoute: "long-memory" });
    render(<MemoryLibrary />);
    const organizationDefault = await screen.findByRole("button", {
      name: i18n.t("library.open.model.services"),
    });
    fireEvent.click(organizationDefault);
    await waitFor(() => expect(store.getState().settingsRoute).toBe("execution-settings"));
  },
);

describe("explicit global capability to Agent navigation", () => {
  it.each(["capability-memory", "capability-knowledge"] as const)(
    "%s keeps system facts separate from the Agent editor",
    async (route) => {
      const getAgent = vi.fn(async (id: string) => configuredAgent(id));
      await openRoute({ getAgent }, route, {
        agents: [configuredAgent("A"), configuredAgent("B")],
        editorAgentId: "B",
        pageEditor: newPageEditor(configuredAgent("B"), persona("B")),
      });
      expect(getAgent).not.toHaveBeenCalled();
      expect(screen.queryByRole("checkbox")).toBeNull();
      expect(screen.queryByRole("textbox")).toBeNull();
      expect(screen.getByRole("combobox")).toHaveProperty("value", "");
    },
  );
  it("dirty new Agent draft is guarded before explicit global→Agent navigation, cancel keeps the original", async () => {
    const getAgent = vi.fn(async (id: string) => configuredAgent(id));
    await openRoute({ getAgent }, "capability-memory", {
      agents: [configuredAgent("A"), configuredAgent("B")],
      editorAgentId: "__new__",
      editorDraft: { ...toDraft(configuredAgent("B")), name: "new draft" },
      pageEditor: null,
      dirty: true,
    });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "B" } });
    fireEvent.click(screen.getByRole("button", { name: "配置此 Agent 的资料读取" }));
    expect(store.getState().pendingNavigation).toMatchObject({
      kind: "workspace-target",
      agentId: "B",
      route: "memory-tools",
    });
    expect(getAgent).not.toHaveBeenCalled();
    store.getState().cancelPendingNavigation();
    expect(store.getState().editorDraft?.name).toBe("new draft");
    expect(store.getState().settingsRoute).toBe("capability-memory");
    expect(store.getState().workspaceReturns).toEqual([]);
  });
  it("failed explicitly targeted Agent read preserves source and retries only on a new user action", async () => {
    const getAgent = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockImplementation(async (id: string) => configuredAgent(id));
    await openRoute(
      { getAgent, getPersona: vi.fn(async (id: string) => persona(id)) },
      "capability-memory",
      { agents: [configuredAgent("B")] },
    );
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "B" } });
    fireEvent.click(screen.getByRole("button", { name: "配置此 Agent 的资料读取" }));
    await waitFor(() => expect(store.getState().navigationConfirmOpen).toBe(true));
    expect(getAgent).toHaveBeenCalledTimes(1);
    expect(store.getState().settingsRoute).toBe("capability-memory");
    store.getState().cancelPendingNavigation();
    fireEvent.click(screen.getByRole("button", { name: "配置此 Agent 的资料读取" }));
    await waitFor(() => expect(store.getState().settingsRoute).toBe("memory-tools"));
    expect(getAgent).toHaveBeenCalledTimes(2);
  });
  it("configuration writes block canonical navigation without changing the target", async () => {
    const getAgent = vi.fn();
    await openRoute({ getAgent }, "capability-knowledge", {
      agents: [configuredAgent("B")],
      settingsSaving: true,
    });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "B" } });
    fireEvent.click(screen.getByRole("button", { name: "配置此 Agent 的资料读取" }));
    expect(getAgent).not.toHaveBeenCalled();
    expect(store.getState().settingsRoute).toBe("capability-knowledge");
    expect(store.getState().workspaceReturns).toEqual([]);
  });

  it("passes active prop to execution detail and pauses polling when active is false", async () => {
    vi.useFakeTimers();
    const summary = vi.fn().mockResolvedValue({
      now: "2026-09-30T12:00:00.000Z",
      retention: {
        traceRetentionDays: 14,
        traceRetentionDefaultDays: 14,
        traceRetentionMinDays: 1,
        traceRetentionMaxDays: 3650,
      },
      cleanupScope: {
        categories: ["traces", "contexts", "task_payloads"],
        protectedTraceStatuses: ["started", "unknown"],
        protectedTaskStatuses: ["queued", "running", "waiting_tool", "waiting_approval", "unknown"],
        protectedCallStatuses: ["running", "waiting_approval", "unknown"],
        contextClearedFields: ["protected_messages", "protected_output"],
        taskClearedFields: ["arguments", "result"],
      },
      traces: { live: 3, expired: 2, started: 1, unknown: 0 },
      spans: { live: 5, expired: 4 },
      contexts: {
        live: 1,
        expired: 2,
        revoked: 1,
        withProtectedBody: 2,
        expiredProtectedBodies: 1,
      },
      taskPayloads: { live: 2, expired: 3, protected: 1, removable: 2 },
    });
    const list = vi.fn().mockResolvedValue({
      items: [],
      hasMore: false,
      nextCursor: null,
      summary: { total: 0, live: 0, expired: 0 },
    });
    store.getState().resetForTests({
      ...api,
      getPermissions: vi.fn().mockResolvedValue(permissions),
      getToolDirectory: vi.fn().mockResolvedValue({ tools: [] }),
      getSkills: vi.fn().mockResolvedValue({ skills: [] }),
      getMcpServers: vi.fn().mockResolvedValue({ servers: [] }),
      getRuntimeStorage: summary,
      listRuntimeStorageItems: list,
    } as unknown as typeof api);

    store.setState({ settingsRoute: "execution-settings" });
    const { rerender } = render(<CapabilitiesWorkspace active={true} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(summary).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledTimes(1);

    rerender(<CapabilitiesWorkspace active={false} />);
    await act(async () => {});

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000);
    });
    expect(summary).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledTimes(1);

    rerender(<CapabilitiesWorkspace active={true} />);
    await act(async () => {});
    expect(summary).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenCalledTimes(2);
  });
});
