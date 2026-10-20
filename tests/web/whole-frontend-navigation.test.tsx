import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DesignSystemProvider } from "../../src/web/design-system/Providers";
import { selectLocale } from "../../src/web/i18n";
import { PRELOAD_REGISTRY } from "../../src/web/state/preload-registry";
import { useSuperstringStore as store } from "../../src/web/store";
import { WorkspaceShell } from "../../src/web/workspace/WorkspaceShell";

beforeEach(() => {
  selectLocale("zh-CN");
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
function modelsButton() {
  return screen.getByRole("button", { name: "模型服务" });
}

it("模型服务 is a primary product space rendered once in the sidebar and never a footer duplicate", () => {
  setup();
  const primary = within(screen.getByRole("navigation", { name: "工作区" }));
  const primaryModels = primary.getByRole("button", { name: "模型服务" });
  // 整个侧栏（主导航 + 底部区）只此一处，不在底部环境区重复。
  expect(
    within(screen.getByRole("complementary", { name: "主导航" })).getAllByRole("button", {
      name: "模型服务",
    }),
  ).toHaveLength(1);
  // 默认在对话，模型服务不持有 aria-current；进入模型路由后标记跟随 activeSpace。
  expect(primaryModels.getAttribute("aria-current")).toBeNull();
  act(() =>
    store.setState({
      page: "settings",
      settingsView: "workspace",
      settingsRoute: "external-api",
    }),
  );
  expect(primaryModels.getAttribute("aria-current")).toBe("page");
});

it("the models space keeps exactly one preload registry entry with its chunk loader", () => {
  const entries = PRELOAD_REGISTRY.filter((entry) => entry.space === "models");
  expect(entries).toHaveLength(1);
  expect(typeof entries[0].loadChunk).toBe("function");
});

it("opening 模型服务 goes through the unsaved-draft guard: cancel keeps the editor, confirm lands on the models route", async () => {
  store.setState({ page: "settings", settingsView: "agents", dirty: true });
  setup();
  fireEvent.click(modelsButton());
  expect(store.getState()).toMatchObject({
    page: "settings",
    settingsView: "agents",
    dirty: true,
    navigationConfirmOpen: true,
    pendingNavigation: {
      kind: "page",
      page: "settings",
      settingsView: "workspace",
      settingsRoute: "external-api",
    },
  });
  act(() => store.getState().cancelPendingNavigation());
  expect(store.getState()).toMatchObject({
    settingsView: "agents",
    dirty: true,
    pendingNavigation: null,
    navigationConfirmOpen: false,
  });
  fireEvent.click(modelsButton());
  await act(async () => store.getState().confirmDiscardAndContinue());
  expect(store.getState()).toMatchObject({
    page: "settings",
    settingsView: "workspace",
    settingsRoute: "external-api",
    dirty: false,
    pendingNavigation: null,
    navigationConfirmOpen: false,
  });
});

it("search does not auto-navigate while typing, IME-composed Ctrl+K is ignored, and dismissal returns focus", async () => {
  store.getState().rememberConversation({
    id: "nav-search-conversation",
    sourceId: "nav-search-session",
    channel: "web",
    topology: "direct",
    title: "全站导航搜索会话",
    agentId: "agent",
    bindingEpoch: 1,
    participants: [],
    updatedAt: "2026-10-18T00:00:00Z",
    lastSeq: 0,
    consumedSeq: 0,
  });
  setup();
  const trigger = screen.getByRole("button", { name: "搜索与跳转" });
  trigger.focus();
  // 输入法组合中的 Ctrl+K 不得翻转搜索浮层。
  fireEvent.keyDown(document, { key: "k", ctrlKey: true, isComposing: true });
  expect(screen.queryByRole("dialog")).toBeNull();
  // 真实打开后：输入只过滤候选，不自动导航、不触碰会话选择。
  fireEvent.keyDown(document, { key: "k", ctrlKey: true });
  const input = screen.getByRole("combobox");
  await userEvent.type(input, "全站导航搜索会话");
  // 候选项 accessible name 含尾随 CommandShortcut 渠道字（如 Web），与既有命令面板用例同样按子串匹配。
  expect(screen.getByRole("option", { name: /全站导航搜索会话/ })).toBeTruthy();
  expect(store.getState()).toMatchObject({
    currentConversationId: null,
    pendingNavigation: null,
    navigationConfirmOpen: false,
  });
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});
