import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DesignSystemProvider } from "../../src/web/design-system/Providers";
import { useSuperstringStore as store } from "../../src/web/store";
import { WorkspaceShell } from "../../src/web/workspace/WorkspaceShell";

beforeEach(() => {
  store.getState().resetForTests();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function setup() {
  render(
    <DesignSystemProvider>
      <WorkspaceShell>
        <p>Workspace</p>
      </WorkspaceShell>
    </DesignSystemProvider>,
  );
}
it("command search finds pages with the keyboard and restores focus on dismissal", async () => {
  setup();
  const trigger = screen.getByRole("button", { name: "搜索与跳转" });
  trigger.focus();
  await userEvent.keyboard("{Control>}k{/Control}");
  const input = screen.getByRole("combobox");
  await userEvent.type(input, "身份与行为");
  expect(screen.getByRole("option", { name: "身份与行为" })).toBeTruthy();
  await userEvent.keyboard("{Enter}");
  expect(store.getState().settingsRoute).toBe("identity");
  expect(screen.queryByRole("dialog")).toBeNull();
  await userEvent.click(trigger);
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});
it("command navigation uses draft guards rather than overwriting the current editor", async () => {
  store.setState({ page: "settings", settingsView: "agents", dirty: true });
  setup();
  await userEvent.click(screen.getByRole("button", { name: "搜索与跳转" }));
  await userEvent.type(screen.getByRole("combobox"), "接入");
  await userEvent.keyboard("{Enter}");
  expect(store.getState()).toMatchObject({
    settingsView: "agents",
    dirty: true,
    navigationConfirmOpen: true,
  });
  act(() => store.getState().cancelPendingNavigation());
  expect(store.getState().settingsView).toBe("agents");
});
it("loaded conversation search preserves the selected identity until its guarded navigation commits", async () => {
  const conversation = {
    id: "conversation",
    sourceId: "session",
    channel: "web" as const,
    topology: "direct" as const,
    title: "搜索测试会话",
    agentId: "agent",
    bindingEpoch: 1,
    participants: [],
    updatedAt: "2026-09-26T00:00:00Z",
    lastSeq: 0,
    consumedSeq: 0,
  };
  store.getState().rememberConversation(conversation);
  store.setState({ page: "settings", settingsView: "agents", dirty: true });
  setup();
  fireEvent.keyDown(document, { key: "k", metaKey: true });
  expect(screen.getByText("已加载的会话")).toBeTruthy();
  await userEvent.type(screen.getByRole("combobox"), conversation.title);
  await userEvent.keyboard("{Enter}");
  expect(store.getState().pendingNavigation).toMatchObject({
    kind: "page",
    page: "chat",
    conversationId: conversation.id,
  });
  expect(store.getState().currentConversationId).toBeNull();
  expect(store.getState().navigationConfirmOpen).toBe(true);
});
