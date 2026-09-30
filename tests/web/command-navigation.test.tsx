import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DesignSystemProvider } from "../../src/web/design-system/Providers";
import { useSuperstringStore as store } from "../../src/web/store";
import { activeSpace } from "../../src/web/workspace/navigation";
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
  await userEvent.type(screen.getByRole("combobox"), "扩展");
  await userEvent.keyboard("{Enter}");
  expect(store.getState()).toMatchObject({
    settingsView: "agents",
    dirty: true,
    navigationConfirmOpen: true,
    pendingNavigation: {
      kind: "page",
      page: "settings",
      settingsView: "workspace",
      settingsRoute: "mcp-servers",
    },
  });
  act(() => store.getState().cancelPendingNavigation());
  expect(store.getState().settingsView).toBe("agents");
  expect(store.getState().dirty).toBe(true);
  expect(store.getState().pendingNavigation).toBeNull();
});
it("command search opens extensions at MCP services in the workspace", async () => {
  setup();
  await userEvent.click(screen.getByRole("button", { name: "搜索与跳转" }));
  await userEvent.type(screen.getByRole("combobox"), "扩展");
  expect(screen.getByRole("option", { name: /^扩展/, selected: true })).toBeTruthy();
  await userEvent.keyboard("{Enter}");
  expect(store.getState()).toMatchObject({
    page: "settings",
    settingsView: "workspace",
    settingsRoute: "mcp-servers",
  });
  expect(activeSpace(store.getState())).toBe("connections");
  expect(screen.queryByRole("dialog")).toBeNull();
});
it.each(["qq-app-schemes", "qq-connection", "qq-storage"] as const)(
  "QQ app route %s belongs to schemes rather than extensions",
  (route) => {
    act(() => store.getState().openSettingsRoute(route));
    expect(store.getState()).toMatchObject({
      page: "settings",
      settingsView: "workspace",
      settingsRoute: route,
    });
    expect(activeSpace(store.getState())).toBe("schemes");
  },
);
it("normalizes the old operating-mode request to guarded QQ app connection navigation", async () => {
  expect(
    activeSpace({ page: "settings", settingsView: "operating-mode", settingsRoute: "basic" }),
  ).toBe("schemes");
  store.setState({ page: "settings", settingsView: "agents", dirty: true });
  act(() => store.getState().requestPageNavigation("settings", "operating-mode"));
  expect(store.getState()).toMatchObject({
    settingsView: "agents",
    dirty: true,
    navigationConfirmOpen: true,
    pendingNavigation: {
      kind: "page",
      page: "settings",
      settingsView: "workspace",
      settingsRoute: "qq-connection",
    },
  });
  act(() => store.getState().cancelPendingNavigation());
  expect(store.getState()).toMatchObject({ settingsView: "agents", dirty: true });
  act(() => store.getState().requestPageNavigation("settings", "operating-mode"));
  await act(async () => store.getState().confirmDiscardAndContinue());
  expect(store.getState()).toMatchObject({
    page: "settings",
    settingsView: "workspace",
    settingsRoute: "qq-connection",
    navigationConfirmOpen: false,
    pendingNavigation: null,
  });
  expect(activeSpace(store.getState())).toBe("schemes");
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
