// 对话枢纽：全渠道统一三页签、消息正文状态保持、观测与任务的范围/隔离、QQ 只读说明在观测页不残留。
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  ConversationEventView,
  ConversationSummary,
} from "../../src/shared/contracts/conversation";
import type { RuntimeTracesPage } from "../../src/shared/contracts/runtime-observability";
import { api, type SuperstringApi } from "../../src/web/api";
import { emptyWebConversation } from "../../src/web/features/chat/conversation-state";
import { selectLocale } from "../../src/web/i18n";
import { i18n } from "../../src/web/i18n/runtime";
import { ConversationWorkspace } from "../../src/web/screens/conversations/ConversationWorkspace";
import { useSuperstringStore as store } from "../../src/web/store";

const now = "2026-09-30T00:00:00Z";
const key = (name: string) => i18n.t(name);
const webConversation: ConversationSummary = {
  id: "conversation:web",
  sourceId: "session-web",
  channel: "web",
  topology: "direct",
  agentId: "agent",
  title: "网页会话",
  bindingEpoch: 1,
  participants: [],
  updatedAt: now,
  lastSeq: 0,
  consumedSeq: 0,
};
const qqConversation: ConversationSummary = {
  ...webConversation,
  id: "conversation:qq",
  sourceId: "binding-qq",
  channel: "onebot11",
  title: "QQ 会话",
};
const qqEvent: ConversationEventView = {
  wake: null,
  conversationId: qqConversation.id,
  seq: 1,
  eventKey: "qq-event",
  kind: "inbound",
  source: { kind: "qq_event", id: "qq-source", revision: "1" },
  sources: [{ kind: "qq_event", id: "qq-source", revision: "1" }],
  occurredAt: now,
  recordedAt: now,
  participant: { id: "person", label: "小林", role: "user" },
  addressing: { reasons: ["private"], mentionIds: [] },
  runId: null,
  outputId: null,
  text: "来自 QQ 的消息",
  contentState: "active",
  media: [],
  deliveryStatus: null,
  messageStatus: null,
};
const tracesPage = (): RuntimeTracesPage => ({
  items: [],
  nextBeforeId: 0,
  hasMore: false,
  summary: {
    totalTraces: 0,
    activeTraces: 0,
    failedTraces: 0,
    matchedSpans: 0,
    lastActivityAt: null,
    now,
  },
});
const runtimeStatus = {
  pendingWakes: 1,
  activeRuns: 2,
  failedWakes: 0,
  unknownDeliveries: 0,
  nextReadyAt: null,
  lastActivityAt: now,
  connectionPhase: "ready" as const,
  now,
};
function setup(client: Partial<SuperstringApi> = {}) {
  store.getState().resetForTests({
    ...api,
    getConversationEvents: vi.fn(async () => ({ items: [qqEvent], nextSeq: 1, hasMore: false })),
    getConversationRuntimeStatus: vi.fn(async () => runtimeStatus),
    listRuntimeTraces: vi.fn(async () => tracesPage()),
    listTasks: vi.fn(async () => ({ items: [], nextCursor: null, hasMore: false })),
    ...client,
  } as SuperstringApi);
}
function selectConversation(conversation: ConversationSummary) {
  store.setState({
    currentConversationId: conversation.id,
    conversationById: { [conversation.id]: emptyWebConversation(conversation.sourceId) },
    summaryById: { [conversation.id]: conversation },
    directoryIds: [conversation.id],
  });
}
const hubTablist = () => screen.getByRole("tablist", { name: key("workspace.conversation_view") });
const selectedTab = () => within(hubTablist()).getByRole("tab", { selected: true }).textContent;
// jsdom 里 ResizablePanelGroup 会在捕获阶段拦下 pointerdown（命中判定退化为 0,0），
// userEvent 因此不再派发 mousedown；页签在真实浏览器由 mousedown 激活，这里直接触发它。
const switchTab = (name: string) => fireEvent.mouseDown(screen.getByRole("tab", { name }));
beforeEach(() => {
  window.history.replaceState(null, "", "/");
  selectLocale("zh-CN");
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it("renders one three-tab hub and keeps the composer draft across views", async () => {
  setup();
  selectConversation(webConversation);
  render(<ConversationWorkspace />);
  const tabs = hubTablist();
  expect(
    within(tabs)
      .getAllByRole("tab")
      .map((tab) => tab.textContent),
  ).toEqual([
    key("workspace.message_history"),
    key("workspace.runtime_observability"),
    key("connections.tasks.title"),
  ]);
  expect(selectedTab()).toBe(key("workspace.message_history"));
  expect(screen.getAllByRole("heading", { name: webConversation.title })).toHaveLength(1);
  const composer = screen.getByRole("textbox", { name: key("workspace.enter_a_message") });
  fireEvent.change(composer, { target: { value: "未发送的草稿" } });
  switchTab(key("workspace.runtime_observability"));
  expect(
    await screen.findByRole("region", { name: key("workspace.conversationHub.activityTitle") }),
  ).toBeTruthy();
  // 当前范围不渲染全局标题；全局标题只在「全部会话」范围出现。
  expect(
    screen.queryByRole("heading", { name: key("observability.integrated.globalTitle") }),
  ).toBeNull();
  // 消息页签隐藏后，身份、输入区与刷新都不在可访问树里。
  expect(screen.queryByRole("textbox", { name: key("workspace.enter_a_message") })).toBeNull();
  expect(screen.queryByRole("heading", { name: webConversation.title })).toBeNull();
  switchTab(key("workspace.message_history"));
  expect(
    (screen.getByRole("textbox", { name: key("workspace.enter_a_message") }) as HTMLTextAreaElement)
      .value,
  ).toBe("未发送的草稿");
  expect(screen.getAllByRole("heading", { name: webConversation.title })).toHaveLength(1);
});
it("refreshes the running state summary and the trace list through one view-level control", async () => {
  const status = vi.fn<SuperstringApi["getConversationRuntimeStatus"]>(async () => runtimeStatus);
  const list = vi.fn<SuperstringApi["listRuntimeTraces"]>(async () => tracesPage());
  setup({ getConversationRuntimeStatus: status, listRuntimeTraces: list });
  selectConversation(webConversation);
  render(<ConversationWorkspace />);
  switchTab(key("workspace.runtime_observability"));
  await screen.findByRole("region", { name: key("workspace.conversationHub.activityTitle") });
  await waitFor(() => expect(list).toHaveBeenCalledOnce());
  await waitFor(() => expect(status).toHaveBeenCalled());
  const reads = { status: status.mock.calls.length, traces: list.mock.calls.length };
  const refresh = screen.getByRole("button", {
    name: key("connections.common.refresh"),
  }) as HTMLButtonElement;
  await waitFor(() => expect(refresh.disabled).toBe(false));
  await userEvent.click(refresh);
  await waitFor(() => expect(list.mock.calls.length).toBe(reads.traces + 1));
  await waitFor(() => expect(status.mock.calls.length).toBe(reads.status + 1));
});
it("stops reading and clears the QQ timeline while the messages tab is hidden", async () => {
  const events = vi.fn<SuperstringApi["getConversationEvents"]>(async () => ({
    items: [qqEvent],
    nextSeq: 1,
    hasMore: false,
  }));
  setup({ getConversationEvents: events });
  selectConversation(qqConversation);
  render(<ConversationWorkspace />);
  expect(await screen.findByText("来自 QQ 的消息")).toBeTruthy();
  expect(screen.getByRole("button", { name: key("workspace.refresh_history") })).toBeTruthy();
  expect(screen.getByText(key("workspace.read_only_conversation_history"))).toBeTruthy();
  expect(
    screen.getByText(
      key("workspace.messages_arrive_through_the_connected_bot_continue_the_conversation_in_t"),
    ),
  ).toBeTruthy();
  switchTab(key("workspace.runtime_observability"));
  await screen.findByRole("region", { name: key("workspace.conversationHub.activityTitle") });
  expect(screen.queryByRole("button", { name: key("workspace.refresh_history") })).toBeNull();
  expect(screen.queryByText(key("workspace.read_only_conversation_history"))).toBeNull();
  expect(
    screen.queryByText(
      key("workspace.messages_arrive_through_the_connected_bot_continue_the_conversation_in_t"),
    ),
  ).toBeNull();
  // 隐藏即停读，但已加载正文保留可见；滚动容器真实 hidden，供时间线判断要不要记录快照。
  expect(screen.getByText("来自 QQ 的消息")).toBeTruthy();
  // 隐藏节点算不出可访问名，按角色取全部再核对 aria-label。
  const tabpanels = screen.getAllByRole("tabpanel", { hidden: true });
  expect(tabpanels.map((node) => node.getAttribute("aria-label"))).toEqual([
    key("workspace.message_history"),
  ]);
  expect(tabpanels[0].hasAttribute("hidden")).toBe(true);
  switchTab(key("workspace.message_history"));
  expect(await screen.findByText("来自 QQ 的消息")).toBeTruthy();
  expect(events.mock.calls.length).toBeGreaterThanOrEqual(2);
});
it("aborts an in-flight QQ history read when the messages tab is hidden", async () => {
  let settle!: (page: Awaited<ReturnType<SuperstringApi["getConversationEvents"]>>) => void;
  const events = vi.fn<SuperstringApi["getConversationEvents"]>(
    () =>
      new Promise((resolve) => {
        settle = resolve;
      }),
  );
  setup({ getConversationEvents: events });
  selectConversation(qqConversation);
  render(<ConversationWorkspace />);
  await waitFor(() => expect(events).toHaveBeenCalledOnce());
  switchTab(key("workspace.runtime_observability"));
  await waitFor(() => expect(events.mock.calls[0][2]?.aborted).toBe(true));
  await act(async () => {
    settle({ items: [qqEvent], nextSeq: 1, hasMore: false });
  });
  expect(screen.queryByText("来自 QQ 的消息")).toBeNull();
});
it("scopes activity to the conversation, then switches to all activity without leaking the filter", async () => {
  window.history.replaceState(null, "", "/?trace-q=all%20activity");
  const list = vi.fn<SuperstringApi["listRuntimeTraces"]>(async () => tracesPage());
  setup({ listRuntimeTraces: list });
  selectConversation(webConversation);
  render(<ConversationWorkspace />);
  switchTab(key("workspace.runtime_observability"));
  await screen.findByRole("region", { name: key("workspace.conversationHub.activityTitle") });
  await waitFor(() => expect(list).toHaveBeenCalledOnce());
  expect(list.mock.calls[0][0]).toMatchObject({ conversationId: webConversation.id });
  expect(list.mock.calls[0][0]?.q).toBeUndefined();
  expect(
    screen
      .getByRole("button", { name: key("workspace.conversationHub.scopeCurrent") })
      .getAttribute("aria-pressed"),
  ).toBe("true");
  await userEvent.click(
    screen.getByRole("button", { name: key("workspace.conversationHub.scopeGlobal") }),
  );
  await screen.findByRole("heading", { name: key("observability.integrated.globalTitle") });
  await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
  expect(list.mock.calls.at(-1)?.[0]).toMatchObject({ q: "all activity" });
  expect(list.mock.calls.at(-1)?.[0]?.conversationId).toBeUndefined();
  // 全局活动不渲染选中会话的身份，标题说明这是全部活动。
  expect(screen.queryByRole("heading", { name: webConversation.title })).toBeNull();
});
it("disables current scope without a conversation and falls back to global activity and tasks", async () => {
  const list = vi.fn<SuperstringApi["listRuntimeTraces"]>(async () => tracesPage());
  const tasks = vi.fn<SuperstringApi["listTasks"]>(async () => ({
    items: [],
    nextCursor: null,
    hasMore: false,
  }));
  setup({ listRuntimeTraces: list, listTasks: tasks });
  render(<ConversationWorkspace />);
  switchTab(key("workspace.runtime_observability"));
  await screen.findByRole("heading", { name: key("observability.integrated.globalTitle") });
  await waitFor(() => expect(list).toHaveBeenCalledOnce());
  expect(list.mock.calls[0][0]?.conversationId).toBeUndefined();
  expect(
    (
      screen.getByRole("button", {
        name: key("workspace.conversationHub.scopeCurrent"),
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  switchTab(key("connections.tasks.title"));
  await waitFor(() => expect(tasks).toHaveBeenCalledOnce());
  expect(tasks.mock.calls[0][0]).toEqual({ cursor: undefined, limit: 50 });
});
it("locks the task ledger to the conversation scope and keeps it when clearing filters", async () => {
  const tasks = vi.fn<SuperstringApi["listTasks"]>(async () => ({
    items: [],
    nextCursor: null,
    hasMore: false,
  }));
  setup({ listTasks: tasks });
  selectConversation(webConversation);
  render(<ConversationWorkspace />);
  switchTab(key("connections.tasks.title"));
  await waitFor(() => expect(tasks).toHaveBeenCalledOnce());
  expect(tasks.mock.calls[0][0]).toMatchObject({
    conversationId: webConversation.id,
    cursor: undefined,
    limit: 50,
  });
  // 当前范围不再重复提供会话选择，并说明范围。
  expect(
    screen.queryByRole("combobox", { name: key("connections.tasks.filterConversation") }),
  ).toBeNull();
  expect(screen.queryByRole("textbox", { name: key("observability.conversationId") })).toBeNull();
  expect(screen.getByText(key("connections.tasks.currentConversationScope"))).toBeTruthy();
  fireEvent.change(screen.getByLabelText(key("connections.tasks.filterStatus")), {
    target: { value: "completed" },
  });
  await userEvent.click(
    screen.getByRole("button", { name: key("connections.tasks.applyFilters") }),
  );
  await waitFor(() => expect(tasks).toHaveBeenCalledTimes(2));
  expect(tasks.mock.calls.at(-1)?.[0]).toMatchObject({
    conversationId: webConversation.id,
    status: "completed",
  });
  await userEvent.click(
    screen.getByRole("button", { name: key("connections.tasks.clearFilters") }),
  );
  await waitFor(() => expect(tasks).toHaveBeenCalledTimes(3));
  expect(tasks.mock.calls.at(-1)?.[0]).toMatchObject({ conversationId: webConversation.id });
  expect(tasks.mock.calls.at(-1)?.[0]?.status).toBeUndefined();
});
it("returns to messages and current scope once a directory selection lands", async () => {
  setup();
  selectConversation(qqConversation);
  store.setState({ conversationView: "activity", conversationScope: "global" });
  render(<ConversationWorkspace />);
  await screen.findByRole("heading", { name: key("observability.integrated.globalTitle") });
  await act(async () => {
    await store.getState().requestConversationNavigation(qqConversation.id);
  });
  expect(store.getState()).toMatchObject({
    conversationView: "messages",
    conversationScope: "current",
  });
  expect(selectedTab()).toBe(key("workspace.message_history"));
  expect(screen.getAllByRole("heading", { name: qqConversation.title })).toHaveLength(1);
});
it("collapses the directory for global activity and restores it", async () => {
  setup();
  selectConversation(webConversation);
  render(<ConversationWorkspace />);
  expect(screen.getByRole("navigation", { name: key("workspace.chat_history") })).toBeTruthy();
  switchTab(key("workspace.runtime_observability"));
  await userEvent.click(
    screen.getByRole("button", { name: key("workspace.conversationHub.scopeGlobal") }),
  );
  await userEvent.click(
    await screen.findByRole("button", {
      name: key("workspace.conversationHub.collapseDirectory"),
    }),
  );
  expect(screen.queryByRole("navigation", { name: key("workspace.chat_history") })).toBeNull();
  await userEvent.click(
    screen.getByRole("button", { name: key("workspace.conversationHub.expandDirectory") }),
  );
  expect(screen.getByRole("navigation", { name: key("workspace.chat_history") })).toBeTruthy();
});
it("keeps the message subtree, composer draft and in-flight send across collapse and view switches", async () => {
  setup();
  selectConversation(webConversation);
  render(<ConversationWorkspace />);
  const composer = screen.getByRole("textbox", { name: key("workspace.enter_a_message") });
  fireEvent.change(composer, { target: { value: "折叠前的草稿" } });
  switchTab(key("workspace.runtime_observability"));
  await screen.findByRole("region", { name: key("workspace.conversationHub.activityTitle") });
  await userEvent.click(
    screen.getByRole("button", { name: key("workspace.conversationHub.scopeGlobal") }),
  );
  await userEvent.click(
    await screen.findByRole("button", {
      name: key("workspace.conversationHub.collapseDirectory"),
    }),
  );
  expect(screen.queryByRole("navigation", { name: key("workspace.chat_history") })).toBeNull();
  await userEvent.click(
    screen.getByRole("button", { name: key("workspace.conversationHub.expandDirectory") }),
  );
  switchTab(key("workspace.message_history"));
  const restored = screen.getByRole("textbox", { name: key("workspace.enter_a_message") });
  expect(restored).toBe(composer);
  expect((restored as HTMLTextAreaElement).value).toBe("折叠前的草稿");
});
it("keeps a pending knowledge resend dialog out of other tabs without losing it", async () => {
  setup();
  selectConversation(webConversation);
  render(<ConversationWorkspace />);
  switchTab(key("connections.tasks.title"));
  await waitFor(() =>
    expect(screen.getByRole("heading", { name: key("connections.tasks.title") })).toBeTruthy(),
  );
  // 任务页签期间才到达的重新发送状态不应在任务上弹窗（弹窗挂到主文档之外，隐藏外壳挡不住）。
  store.setState((state) => ({
    conversationById: {
      ...state.conversationById,
      [webConversation.id]: {
        ...emptyWebConversation(webConversation.sourceId),
        knowledgeResend: {
          sessionId: webConversation.sourceId,
          text: "原始问题",
          requestId: "request-1",
        },
      },
    },
  }));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  switchTab(key("workspace.message_history"));
  expect(await screen.findByRole("alertdialog")).toBeTruthy();
  // 弹窗打开时离开消息页签同样卸下弹窗并保留状态。
  act(() => store.getState().requestConversationView("tasks", "current"));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  act(() => store.getState().requestConversationView("messages", "current"));
  expect(await screen.findByRole("alertdialog")).toBeTruthy();
});
it("keeps the selected scope when switching between activity and tasks", async () => {
  const list = vi.fn<SuperstringApi["listRuntimeTraces"]>(async () => tracesPage());
  const tasks = vi.fn<SuperstringApi["listTasks"]>(async () => ({
    items: [],
    nextCursor: null,
    hasMore: false,
  }));
  setup({ listRuntimeTraces: list, listTasks: tasks });
  selectConversation(webConversation);
  render(<ConversationWorkspace />);
  switchTab(key("workspace.runtime_observability"));
  await screen.findByRole("region", { name: key("workspace.conversationHub.activityTitle") });
  await userEvent.click(
    screen.getByRole("button", { name: key("workspace.conversationHub.scopeGlobal") }),
  );
  await screen.findByRole("heading", { name: key("observability.integrated.globalTitle") });
  switchTab(key("connections.tasks.title"));
  await waitFor(() => expect(tasks).toHaveBeenCalledOnce());
  expect(tasks.mock.calls[0][0]).toEqual({ cursor: undefined, limit: 50 });
  expect(
    screen
      .getByRole("button", { name: key("workspace.conversationHub.scopeGlobal") })
      .getAttribute("aria-pressed"),
  ).toBe("true");
  // 消息页签是明确回「当前会话」的例外：再进运行观测时范围也回到当前。
  switchTab(key("workspace.message_history"));
  switchTab(key("workspace.runtime_observability"));
  await screen.findByRole("region", { name: key("workspace.conversationHub.activityTitle") });
  expect(
    screen
      .getByRole("button", { name: key("workspace.conversationHub.scopeCurrent") })
      .getAttribute("aria-pressed"),
  ).toBe("true");
});
it("labels the current scope with the real conversation title and never fakes global", async () => {
  setup();
  selectConversation(webConversation);
  render(<ConversationWorkspace />);
  switchTab(key("workspace.runtime_observability"));
  await screen.findByRole("region", { name: key("workspace.conversationHub.activityTitle") });
  const label = i18n.t("workspace.conversationHub.currentScope", { "0": webConversation.title });
  expect(screen.getByText(label)).toBeTruthy();
  await userEvent.click(
    screen.getByRole("button", { name: key("workspace.conversationHub.scopeGlobal") }),
  );
  await screen.findByRole("heading", { name: key("observability.integrated.globalTitle") });
  expect(screen.queryByText(label)).toBeNull();
});
it("disables the view-level refresh while the trace read is in flight", async () => {
  let settle!: (page: RuntimeTracesPage) => void;
  const list = vi.fn<SuperstringApi["listRuntimeTraces"]>(
    () =>
      new Promise((resolve) => {
        settle = resolve;
      }),
  );
  setup({ listRuntimeTraces: list });
  selectConversation(webConversation);
  render(<ConversationWorkspace />);
  switchTab(key("workspace.runtime_observability"));
  await screen.findByRole("region", { name: key("workspace.conversationHub.activityTitle") });
  const refresh = screen.getByRole("button", {
    name: key("connections.common.refresh"),
  }) as HTMLButtonElement;
  await waitFor(() => expect(refresh.disabled).toBe(true));
  await act(async () => {
    settle(tracesPage());
  });
  await waitFor(() => expect(refresh.disabled).toBe(false));
});
it("pauses and resumes the runtime summary and trace list from one view-level control", async () => {
  vi.useFakeTimers();
  try {
    const status = vi.fn<SuperstringApi["getConversationRuntimeStatus"]>(async () => runtimeStatus);
    const list = vi.fn<SuperstringApi["listRuntimeTraces"]>(async () => tracesPage());
    setup({ getConversationRuntimeStatus: status, listRuntimeTraces: list });
    selectConversation(webConversation);
    render(<ConversationWorkspace />);
    switchTab(key("workspace.runtime_observability"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(list).toHaveBeenCalledOnce();
    expect(status).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: key("observability.pauseAutoRefresh") }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000);
    });
    expect(list).toHaveBeenCalledOnce();
    expect(status).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: key("observability.resumeAutoRefresh") }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(list).toHaveBeenCalledTimes(2);
    expect(status).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});
