import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TaskList, TaskSummary } from "../../src/shared/contracts/agent-task";
import type { ConversationSummary } from "../../src/shared/contracts/conversation";
import type { SuperstringApi } from "../../src/web/api";
import { emptyWebConversation } from "../../src/web/features/chat/conversation-state";
import { selectLocale } from "../../src/web/i18n";
import { i18n } from "../../src/web/i18n/runtime";
import { ConversationWorkspace } from "../../src/web/screens/conversations/ConversationWorkspace";
import {
  notifyConversationChange,
  resetConversationChangesForTests,
} from "../../src/web/services/conversation-changes";
import { useSuperstringStore as store } from "../../src/web/store";
import { setupLibrary } from "./helpers/library-fixture";

const now = "2026-10-07T00:00:00Z";
const key = (name: string) => i18n.t(name);
const webConversation: ConversationSummary = {
  id: "conversation:web-task-retention",
  sourceId: "session-web-task-retention",
  channel: "web",
  topology: "direct",
  agentId: "agent-1",
  title: "网页测试会话",
  bindingEpoch: 1,
  participants: [],
  updatedAt: now,
  lastSeq: 0,
  consumedSeq: 0,
};

const taskRow: TaskSummary = {
  id: "task-1",
  conversationId: webConversation.id,
  agentId: "agent-1",
  originRunId: null,
  status: "running",
  createdAt: now,
  updatedAt: now,
  expiresAt: "2026-10-08T00:00:00Z",
  errorCode: null,
  callCount: 1,
  completedCallCount: 0,
  waitingOrdinal: null,
  waitingReason: null,
};

const page: TaskList = {
  items: [taskRow],
  nextCursor: null,
  hasMore: false,
};

const switchTab = (name: string) => fireEvent.mouseDown(screen.getByRole("tab", { name }));

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  selectLocale("zh-CN");
});

afterEach(() => {
  cleanup();
  resetConversationChangesForTests();
  vi.restoreAllMocks();
});

it("retains uncommitted draft filters, scroll, and skips hidden SSE events across tab switches", async () => {
  const listTasksMock = vi.fn<SuperstringApi["listTasks"]>().mockResolvedValue(page);
  setupLibrary({ listTasks: listTasksMock });

  store.setState({
    currentConversationId: webConversation.id,
    conversationById: { [webConversation.id]: emptyWebConversation(webConversation.sourceId) },
    summaryById: { [webConversation.id]: webConversation },
    directoryIds: [webConversation.id],
  });

  render(<ConversationWorkspace />);

  // Switch to tasks tab
  switchTab(key("connections.tasks.title"));
  await waitFor(() => expect(listTasksMock).toHaveBeenCalledOnce());

  // Verify task ledger is visible
  const statusSelect = screen.getByLabelText(
    key("connections.tasks.filterStatus"),
  ) as HTMLSelectElement;
  expect(statusSelect).toBeTruthy();

  // Modify uncommitted draft status
  fireEvent.change(statusSelect, { target: { value: "waiting_approval" } });
  expect(statusSelect.value).toBe("waiting_approval");

  // Mock container scroll via closest [data-workspace-scroll]
  const scrollContainer = statusSelect.closest("[data-workspace-scroll]") as HTMLElement;
  expect(scrollContainer).toBeTruthy();
  scrollContainer.scrollTop = 120;

  // Switch to messages tab
  switchTab(key("workspace.message_history"));

  // While in messages tab, notify SSE changes (both ready and matching conversation_changed);
  // task ledger should NOT react because active is false
  await act(async () => {
    notifyConversationChange({ event: "ready" });
    notifyConversationChange({
      event: "conversation_changed",
      conversationId: webConversation.id,
      seq: 1,
      bindingEpoch: 1,
    });
  });
  expect(listTasksMock).toHaveBeenCalledOnce();

  // Switch back to tasks tab
  switchTab(key("connections.tasks.title"));

  // Verify uncommitted draft status is retained (on unmounted component this will be reset to "", failing test!)
  const retainedStatusSelect = screen.getByLabelText(
    key("connections.tasks.filterStatus"),
  ) as HTMLSelectElement;
  expect(retainedStatusSelect.value).toBe("waiting_approval");

  // Verify scroll position is retained
  const restoredScrollContainer = retainedStatusSelect.closest(
    "[data-workspace-scroll]",
  ) as HTMLElement;
  expect(restoredScrollContainer).toBe(scrollContainer);
  expect(restoredScrollContainer.scrollTop).toBe(120);
});
