import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentResponse } from "../../src/shared/contracts";
import type { TaskDetail, TaskList, TaskSummary } from "../../src/shared/contracts/agent-task";
import type { ModelProviderResponse } from "../../src/shared/contracts/models";
import type { PermissionsResponse } from "../../src/shared/contracts/permissions";
import { api } from "../../src/web/api";
import { selectLocale } from "../../src/web/i18n";
import { i18n } from "../../src/web/i18n/runtime";
import { CapabilitiesWorkspace } from "../../src/web/screens/connections/CapabilitiesWorkspace";
import { ModelServices } from "../../src/web/screens/environment/ModelServices";
import { TaskLedger } from "../../src/web/screens/runs/task-ledger";
import { useSuperstringStore as store } from "../../src/web/store";
import { activeSpace, openSpace } from "../../src/web/workspace/navigation";
import { summaryFixture } from "./helpers/chat-fixture";

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_AGENT_ID = "22222222-2222-4222-8222-222222222222";
const CONVERSATION_ID = "33333333-3333-4333-8333-333333333333";
const OTHER_CONVERSATION_ID = "44444444-4444-4444-8444-444444444444";
const UNLOADED_CONVERSATION_ID = "55555555-5555-4555-8555-555555555555";
const ORIGIN_RUN_ID = "66666666-6666-4666-8666-666666666666";
const TASK_A = "77777777-7777-4777-8777-777777777777";
const TASK_B = "88888888-8888-4888-8888-888888888888";
const TASK_C = "99999999-9999-4999-8999-999999999999";
const PROVIDER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const conversation = (id: string, title: string) => ({ ...summaryFixture(id), id, title });
const loadedConversations = [
  conversation(CONVERSATION_ID, "加载会话甲"),
  conversation(OTHER_CONVERSATION_ID, "加载会话乙"),
];

function taskSummary(overrides: Partial<TaskSummary> & Pick<TaskSummary, "id">): TaskSummary {
  return {
    conversationId: CONVERSATION_ID,
    agentId: AGENT_ID,
    originRunId: null,
    status: "running",
    createdAt: "2026-09-28T00:00:00.000Z",
    updatedAt: "2026-09-28T00:00:00.000Z",
    expiresAt: "2026-09-29T00:00:00.000Z",
    errorCode: null,
    callCount: 1,
    completedCallCount: 0,
    waitingOrdinal: null,
    waitingReason: null,
    ...overrides,
  };
}

const emptyPage: TaskList = { items: [], nextCursor: null, hasMore: false };

const provider: ModelProviderResponse = {
  id: PROVIDER_ID,
  name: "DeepSeek",
  base_url: "https://api.example.invalid/v1",
  has_api_key: true,
  models: [{ name: "deepseek-chat", context_window: 65536 }],
  revision: 3,
  created_at: "2026-09-25T00:00:00.000000Z",
  updated_at: "2026-09-25T00:00:00.000000Z",
};

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
    },
  },
  resources: [],
};

async function renderLedger(fake: Partial<typeof api> = {}, conversationId?: string) {
  store.getState().resetForTests({ ...api, ...fake } as unknown as typeof api);
  store.setState({
    agents: [
      { id: AGENT_ID, name: "助手甲" } as AgentResponse,
      { id: OTHER_AGENT_ID, name: "助手乙" } as AgentResponse,
    ],
    summaryById: Object.fromEntries(loadedConversations.map((item) => [item.id, item] as const)),
    directoryIds: loadedConversations.map((item) => item.id),
  });
  render(conversationId ? <TaskLedger conversationId={conversationId} /> : <TaskLedger />);
  await act(async () => {});
}

function modelServicesFake(overrides: Partial<typeof api> = {}) {
  const fake = {
    ...api,
    listModelProviders: vi.fn().mockResolvedValue([provider]),
    createModelProvider: vi.fn().mockResolvedValue(provider),
    updateModelProvider: vi.fn().mockResolvedValue(provider),
    deleteModelProvider: vi.fn().mockResolvedValue(undefined),
    testModelProvider: vi
      .fn()
      .mockResolvedValue({ ok: true, models: ["deepseek-chat"], error: null }),
    listModels: vi.fn().mockResolvedValue({
      provider: "lm_studio",
      status: "available",
      models: [],
      default_model: null,
    }),
    // The defaults tab issues organization/QQ/knowledge reads; a pending read keeps the shell up
    // without inventing payloads this case does not care about.
    getOrganizationSettings: vi.fn().mockReturnValue(new Promise(() => {})),
    getQqSettings: vi.fn().mockReturnValue(new Promise(() => {})),
    getKnowledgeSettings: vi.fn().mockReturnValue(new Promise(() => {})),
  } as unknown as typeof api;
  Object.assign(fake, overrides);
  return fake;
}

async function renderModels(route: "models" | "external-api", overrides: Partial<typeof api> = {}) {
  store.getState().resetForTests(modelServicesFake(overrides));
  store.setState({ settingsRoute: route });
  render(<ModelServices />);
  await act(async () => {});
}

beforeEach(() => {
  selectLocale("zh-CN");
});
afterEach(() => {
  cleanup();
});

describe("model entry routing", () => {
  beforeEach(() => {
    store.getState().resetForTests();
  });

  it("normalizes both quick-management entries to the models route and recognizes it as the models space", () => {
    store.setState({
      status: "ready",
      page: "settings",
      settingsView: "workspace",
      settingsRoute: "basic",
    });
    store.getState().openSettingsRoute("knowledge-model");
    expect(store.getState().settingsRoute).toBe("models");
    expect(activeSpace(store.getState())).toBe("models");

    store.setState({ settingsRoute: "basic" });
    store.getState().openSettingsRoute("management");
    expect(store.getState().settingsRoute).toBe("models");
    expect(activeSpace(store.getState())).toBe("models");
  });

  it("keeps the sidebar entry on the external API route while still landing in the models space", () => {
    store.setState({
      status: "ready",
      page: "settings",
      settingsView: "workspace",
      settingsRoute: "basic",
    });
    openSpace("models");
    expect(store.getState().settingsRoute).toBe("external-api");
    expect(activeSpace(store.getState())).toBe("models");
  });

  it("routes the models destination through the original unsaved-draft guard, never around it", () => {
    store.setState({ status: "ready", page: "settings", settingsView: "agents", dirty: true });
    store.getState().openSettingsRoute("knowledge-model");
    const state = store.getState();
    expect(state.settingsRoute).toBe("basic");
    expect(state.settingsView).toBe("agents");
    expect(state.pendingNavigation).toEqual({
      kind: "page",
      page: "settings",
      settingsView: "workspace",
      settingsRoute: "models",
    });
    expect(state.navigationConfirmOpen).toBe(true);
    expect(state.navigationConfirmMessage).toContain("未保存修改");
    expect(activeSpace(state)).toBe("assistants");
    act(() => store.getState().cancelPendingNavigation());
    expect(store.getState().settingsRoute).toBe("basic");
    expect(store.getState().dirty).toBe(true);
  });
});

describe("model services route-driven tab", () => {
  it("follows the route in both directions between providers and defaults", async () => {
    await renderModels("external-api");
    expect(screen.getByRole("tab", { selected: true }).textContent).toBe(
      i18n.t("models.providers"),
    );
    await act(async () => {
      store.setState({ settingsRoute: "models" });
    });
    expect(screen.getByRole("tab", { selected: true }).textContent).toBe(i18n.t("models.defaults"));
    await act(async () => {
      store.setState({ settingsRoute: "external-api" });
    });
    expect(screen.getByRole("tab", { selected: true }).textContent).toBe(
      i18n.t("models.providers"),
    );
  });

  it("keeps an unsaved provider draft open when a route change retargets the tab", async () => {
    const update = vi.fn().mockResolvedValue(provider);
    await renderModels("external-api", { updateModelProvider: update });
    fireEvent.click(screen.getByRole("button", { name: i18n.t("models.configure") }));
    fireEvent.change(screen.getByLabelText(i18n.t("models.name")), {
      target: { value: "草稿服务" },
    });
    await act(async () => {
      store.setState({ settingsRoute: "models" });
    });
    // The modal editor marks the workspace behind it aria-hidden; the tab still moved underneath.
    expect(screen.getByRole("tab", { selected: true, hidden: true }).textContent).toBe(
      i18n.t("models.defaults"),
    );
    // The editor Sheet lives outside the tab panels: the draft is still there, unsaved and unsent.
    expect((screen.getByLabelText(i18n.t("models.name")) as HTMLInputElement).value).toBe(
      "草稿服务",
    );
    expect(
      (screen.getByRole("button", { name: i18n.t("models.save") }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });
});

describe("task ledger filters", () => {
  it("applies all four filters at once, resets the cursor and drops the late page", async () => {
    const late = Promise.withResolvers<TaskList>();
    const listTasks = vi
      .fn()
      .mockResolvedValueOnce({
        items: [taskSummary({ id: TASK_A })],
        nextCursor: "cursor-1",
        hasMore: true,
      })
      .mockReturnValueOnce(late.promise)
      .mockResolvedValueOnce({
        items: [
          taskSummary({
            id: TASK_C,
            conversationId: UNLOADED_CONVERSATION_ID,
            status: "waiting_approval",
          }),
        ],
        nextCursor: null,
        hasMore: false,
      })
      .mockResolvedValueOnce(emptyPage);
    await renderLedger({ listTasks });

    expect(within(screen.getByRole("table")).getByText("加载会话甲")).toBeTruthy();
    expect(listTasks.mock.calls[0][0]).toEqual({ cursor: undefined, limit: 50 });
    // The loaded-conversation dropdown is scoped and said so instead of claiming every conversation.
    expect(screen.getByRole("option", { name: "加载会话甲" })).toBeTruthy();
    expect(screen.getByText(i18n.t("workspace.loaded_conversations"))).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: i18n.t("connections.tasks.loadMore") }));
    await act(async () => {});
    expect(listTasks.mock.calls[1][0]).toEqual({ cursor: "cursor-1", limit: 50 });
    const lateSignal = listTasks.mock.calls[1][1] as AbortSignal;
    expect(lateSignal.aborted).toBe(false);

    fireEvent.change(screen.getByLabelText(i18n.t("connections.tasks.filterStatus")), {
      target: { value: "waiting_approval" },
    });
    fireEvent.change(screen.getByLabelText(i18n.t("connections.tasks.filterAgent")), {
      target: { value: OTHER_AGENT_ID },
    });
    fireEvent.change(screen.getByPlaceholderText(i18n.t("observability.conversationId")), {
      target: { value: UNLOADED_CONVERSATION_ID },
    });
    fireEvent.change(screen.getByLabelText(i18n.t("connections.tasks.filterOriginRun")), {
      target: { value: ORIGIN_RUN_ID },
    });
    expect(listTasks).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("button", { name: i18n.t("connections.tasks.applyFilters") }));
    await act(async () => {});
    expect(lateSignal.aborted).toBe(true);
    const applied = listTasks.mock.calls[2][0];
    expect(applied).toMatchObject({
      status: "waiting_approval",
      agentId: OTHER_AGENT_ID,
      conversationId: UNLOADED_CONVERSATION_ID,
      originRunId: ORIGIN_RUN_ID,
      limit: 50,
    });
    expect(applied.cursor).toBeUndefined();
    expect(within(screen.getByRole("table")).queryByText("加载会话甲")).toBeNull();
    await act(async () =>
      late.resolve({
        items: [taskSummary({ id: TASK_B, conversationId: OTHER_CONVERSATION_ID })],
        nextCursor: null,
        hasMore: false,
      }),
    );
    const table = screen.getByRole("table");
    expect(within(table).queryByText("加载会话乙")).toBeNull();
    expect(within(table).getByText(i18n.t("connections.tasks.unknownConversation"))).toBeTruthy();
    // Applied filters stay visible in the controls.
    expect(
      (screen.getByLabelText(i18n.t("connections.tasks.filterStatus")) as HTMLSelectElement).value,
    ).toBe("waiting_approval");
    expect(
      (screen.getByLabelText(i18n.t("connections.tasks.filterAgent")) as HTMLSelectElement).value,
    ).toBe(OTHER_AGENT_ID);
    expect(
      (screen.getByPlaceholderText(i18n.t("observability.conversationId")) as HTMLInputElement)
        .value,
    ).toBe(UNLOADED_CONVERSATION_ID);
    expect(
      (screen.getByLabelText(i18n.t("connections.tasks.filterOriginRun")) as HTMLInputElement)
        .value,
    ).toBe(ORIGIN_RUN_ID);

    fireEvent.click(screen.getByRole("button", { name: i18n.t("connections.tasks.clearFilters") }));
    await act(async () => {});
    expect(listTasks.mock.calls[3][0]).toEqual({ cursor: undefined, limit: 50 });
    expect(
      (screen.getByLabelText(i18n.t("connections.tasks.filterAgent")) as HTMLSelectElement).value,
    ).toBe("");
  });

  it("keeps a ticketless waiting call undecidable without an empty dialog or a request", async () => {
    const approveTask = vi.fn();
    const summary = taskSummary({
      id: TASK_C,
      status: "waiting_approval",
      waitingOrdinal: 0,
      waitingReason: "approval",
    });
    const detail: TaskDetail = {
      ...summary,
      dataStatus: "available",
      calls: [
        {
          ordinal: 0,
          name: "fixture.write",
          revision: "v1",
          effect: "write",
          status: "waiting_approval",
          approvalRevision: null,
          errorCode: null,
          argumentsPreview: {
            status: "available",
            text: '{"note":"synthetic"}',
            offset: 0,
            total: 20,
            nextOffset: null,
          },
          resultStatus: "pending",
        },
      ],
    };
    await renderLedger({
      listTasks: vi.fn().mockResolvedValue({ items: [summary], nextCursor: null, hasMore: false }),
      getTask: vi.fn().mockResolvedValue(detail),
      approveTask,
    });
    fireEvent.click(screen.getByRole("button", { name: i18n.t("connections.tasks.open") }));
    await act(async () => {});
    const review = screen.getByRole("button", {
      name: i18n.t("connections.tasks.reviewApproval"),
    }) as HTMLButtonElement;
    expect(review.disabled).toBe(true);
    expect(screen.getByText(i18n.t("connections.tasks.approvalUnavailable"))).toBeTruthy();
    fireEvent.click(review);
    await act(async () => {});
    expect(approveTask).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(
      screen.queryByRole("button", { name: i18n.t("connections.tasks.approveOnce") }),
    ).toBeNull();
  });

  it("opens the existing run details entry for the origin run", async () => {
    const getRun = vi.fn().mockReturnValue(new Promise(() => {}));
    const summary = taskSummary({ id: TASK_A, status: "completed", originRunId: ORIGIN_RUN_ID });
    const detail: TaskDetail = { ...summary, dataStatus: "available", calls: [] };
    await renderLedger({
      listTasks: vi.fn().mockResolvedValue({ items: [summary], nextCursor: null, hasMore: false }),
      getTask: vi.fn().mockResolvedValue(detail),
      getRun,
    });
    fireEvent.click(screen.getByRole("button", { name: i18n.t("connections.tasks.open") }));
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: i18n.t("observability.runDetails") }));
    await act(async () => {});
    expect(getRun).toHaveBeenCalledWith(ORIGIN_RUN_ID, expect.any(AbortSignal));
  });
});

describe("execution capability task direct link", () => {
  // 运行一级入口已取消；能力页的直达按钮保留，但结果必须落对话「任务与审批」的全局范围，
  // 不重建 legacy runs 页面（store 级规范化在 unified-navigation.test.ts，此处钉屏幕入口本身）。
  it("lands on the conversation tasks view in global scope", async () => {
    store.getState().resetForTests({
      ...api,
      getPermissions: vi.fn().mockResolvedValue(permissions),
    } as unknown as typeof api);
    store.setState({
      page: "settings",
      settingsView: "workspace",
      settingsRoute: "execution-settings",
    });
    render(<CapabilitiesWorkspace />);
    await act(async () => {});
    fireEvent.click(
      screen.getByRole("button", { name: i18n.t("capabilities.execution.openTasks") }),
    );
    expect(store.getState()).toMatchObject({
      page: "chat",
      settingsView: "hub",
      conversationView: "tasks",
      conversationScope: "global",
      pendingNavigation: null,
    });
  });
});
