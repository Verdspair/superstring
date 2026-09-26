import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DesignSystemProvider } from "../../src/web/design-system/Providers";
import { ConversationWorkspace } from "../../src/web/screens/conversations/ConversationWorkspace";
import { useSuperstringStore as store } from "../../src/web/store";
import { WorkspaceShell } from "../../src/web/workspace/WorkspaceShell";

beforeEach(() => {
  store.getState().resetForTests();
  vi.stubGlobal("innerWidth", 390);
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function setup(conversations = false) {
  render(
    <DesignSystemProvider>
      <WorkspaceShell>
        {conversations ? <ConversationWorkspace /> : <p>Workspace</p>}
      </WorkspaceShell>
    </DesignSystemProvider>,
  );
}
it("compact product navigation is a labelled modal, without duplicating the conversation directory", async () => {
  setup();
  const trigger = screen.getByRole("button", { name: "会话与导航" });
  await userEvent.click(trigger);
  expect(screen.getByRole("dialog", { name: "会话与导航" })).toBeTruthy();
  expect(screen.getAllByRole("navigation", { name: "工作区" })).toHaveLength(1);
  expect(screen.queryByRole("navigation", { name: "历史会话" })).toBeNull();
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(document.activeElement).toBe(trigger);
});
it("compact navigation stays open after cancelling a draft guard, and closes only on committed navigation", async () => {
  store.setState({ page: "settings", settingsView: "agents", dirty: true });
  setup();
  fireEvent.click(screen.getByRole("button", { name: "会话与导航" }));
  fireEvent.click(screen.getByRole("button", { name: "接入" }));
  expect(store.getState().navigationConfirmOpen).toBe(true);
  expect(store.getState().settingsView).toBe("agents");
  act(() => store.getState().cancelPendingNavigation());
  expect(screen.getByRole("dialog", { name: "会话与导航" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "偏好" }));
  await act(async () => store.getState().confirmDiscardAndContinue());
  expect(store.getState().settingsView).toBe("general");
  expect(screen.queryByRole("dialog")).toBeNull();
});
it("conversation directory is a separate modal with keyboard-reachable record actions", async () => {
  store.getState().rememberConversation({
    id: "menu-conversation",
    sourceId: "menu-session",
    channel: "web",
    topology: "direct",
    title: "菜单会话",
    agentId: "agent",
    bindingEpoch: 1,
    participants: [],
    updatedAt: "2026-09-26T00:00:00Z",
    lastSeq: 0,
    consumedSeq: 0,
  });
  setup(true);
  await userEvent.click(screen.getByRole("button", { name: "打开会话目录" }));
  expect(screen.getAllByRole("navigation", { name: "历史会话" })).toHaveLength(1);
  const conversation = screen.getByRole("button", { name: "菜单会话" });
  conversation.focus();
  fireEvent.keyDown(conversation, { key: "F10", shiftKey: true });
  expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "重命名" }));
  await userEvent.keyboard("{Enter}");
  expect(screen.getByRole("textbox", { name: "会话名称" })).toBeTruthy();
});
