import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PolicyUpdateSchema } from "../../src/shared/contracts";
import type { SuperstringApi } from "../../src/web/api";
import { selectLocale } from "../../src/web/i18n";
import { i18n } from "../../src/web/i18n/runtime";
import { LibraryWorkspace } from "../../src/web/screens/library/LibraryWorkspace";
import { useSuperstringStore as store } from "../../src/web/store";
import { NavigationGuard } from "../../src/web/workspace/NavigationGuard";
import { A, memory, setupLibrary } from "./helpers/library-fixture";
import { render } from "./helpers/render-with-providers";

beforeEach(() => {
  selectLocale("zh-CN");
});
afterEach(() => {
  cleanup();
});

it("keeps the real MemoryLibrary search, status filter, and results while visiting knowledge", async () => {
  const listMemoryEntries = vi.fn<SuperstringApi["listMemoryEntries"]>(async () => ({
    items: [memory],
    total: 1,
  }));
  setupLibrary({ listMemoryEntries });
  store.setState({ settingsRoute: "long-memory" });
  render(<LibraryWorkspace />);

  const search = await screen.findByRole("textbox", { name: "搜索记忆" });
  fireEvent.change(search, { target: { value: "local query" } });
  fireEvent.change(screen.getByRole("combobox", { name: "记忆状态" }), {
    target: { value: "suppressed" },
  });
  fireEvent.click(screen.getByRole("button", { name: "搜索" }));
  await waitFor(() => expect(listMemoryEntries).toHaveBeenCalled());
  const callsBeforeVisit = listMemoryEntries.mock.calls.length;
  expect(screen.getByText("Memory one")).toBeTruthy();

  act(() => store.getState().openSettingsRoute("knowledge-config"));
  expect(screen.queryByRole("textbox", { name: "搜索记忆" })).toBeNull();
  act(() => store.getState().openSettingsRoute("long-memory"));

  expect(screen.getByRole("textbox", { name: "搜索记忆" })).toHaveProperty("value", "local query");
  expect(screen.getByRole("combobox", { name: "记忆状态" })).toHaveProperty("value", "suppressed");
  expect(screen.getByText("Memory one")).toBeTruthy();
  expect(listMemoryEntries.mock.calls.length).toBeGreaterThanOrEqual(callsBeforeVisit);
});

it("executes initial metadata and page read sequentially via loadMemoryManagement", async () => {
  const callOrder: string[] = [];
  const getPolicy = vi.fn<SuperstringApi["getPolicy"]>(async () => {
    callOrder.push("getPolicy");
    return { auto_enabled: true, every_turns: 20, target_chars: 1200, version: 1 };
  });
  const listMemorySessions = vi.fn<SuperstringApi["listMemorySessions"]>(async () => {
    callOrder.push("listMemorySessions");
    return [];
  });
  const listMemoryJobs = vi.fn<SuperstringApi["listMemoryJobs"]>(async () => {
    callOrder.push("listMemoryJobs");
    return [];
  });
  const listMemoryEntries = vi.fn<SuperstringApi["listMemoryEntries"]>(async () => {
    callOrder.push("listMemoryEntries");
    return { items: [memory], total: 1 };
  });

  setupLibrary({
    getPolicy,
    listMemorySessions,
    listMemoryJobs,
    listMemoryEntries,
  });

  store.setState({ settingsRoute: "long-memory" });
  render(<LibraryWorkspace />);

  await waitFor(() => {
    expect(callOrder).toContain("getPolicy");
    expect(callOrder).toContain("listMemoryEntries");
  });

  // Policy and entries both loaded cleanly under single owner
  expect(callOrder.indexOf("getPolicy")).toBeLessThan(callOrder.indexOf("listMemoryEntries"));
  expect(screen.getByText("Memory one")).toBeTruthy();
});

it("management read error is visible via memoryManagementError without polluting global config error", async () => {
  const listMemoryEntries = vi.fn<SuperstringApi["listMemoryEntries"]>(async () => {
    throw new Error("synthetic management read failure");
  });

  setupLibrary({ listMemoryEntries });
  store.setState({ settingsRoute: "long-memory" });
  render(<LibraryWorkspace />);

  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("synthetic management read failure");

  // Global config error is NOT corrupted
  expect(store.getState().error).toBeNull();
  expect(store.getState().memoryManagementError).toBe("synthetic management read failure");
});

it("cancels management read and resets loaded identity on unmount or route leave", async () => {
  setupLibrary();
  store.setState({ settingsRoute: "long-memory" });
  const { unmount } = render(<LibraryWorkspace />);

  await screen.findByText("Memory one");

  // Unmounting invokes cancelMemoryManagementRead
  unmount();
  expect(store.getState().memoryManagementLoading).toBe(false);
});

it.each(["zh-CN", "en"] as const)(
  "%s owns one header return across retained library tabs and lands on the original Agent",
  async (locale) => {
    const client = setupLibrary();
    selectLocale(locale);
    store.setState({ settingsRoute: "memory-tools" });
    const opener = render(
      <button id="materials-memory-origin" type="button">
        Memory management
      </button>,
    );
    const source = screen.getByRole("button", { name: "Memory management" });
    source.focus();
    await act(async () => store.getState().openWorkspaceTarget("long-memory", A));
    const origin = store.getState().workspaceReturns[0];
    expect(origin.focus).toBe('[id="materials-memory-origin"]');
    const view = render(<LibraryWorkspace />);
    await screen.findByRole("button", { name: memory.name });
    const memorySearch = screen.getByRole("textbox", { name: i18n.t("library.search.memories") });
    fireEvent.change(memorySearch, { target: { value: "retained search" } });
    const returnButton = screen.getByRole("button", { name: i18n.t("library.returnToOrigin") });
    expect(returnButton.closest(".workspace-page-header")).toBeTruthy();
    expect(returnButton.textContent).toBe("");
    expect(screen.getAllByRole("button", { name: i18n.t("library.returnToOrigin") })).toHaveLength(
      1,
    );
    const libraryScroll = screen.getByTestId("library-workspace-scroll");
    Object.defineProperties(libraryScroll, {
      scrollHeight: { configurable: true, value: 2000 },
      clientHeight: { configurable: true, value: 400 },
    });
    libraryScroll.scrollTop = 260;
    fireEvent.scroll(libraryScroll);
    await userEvent.click(screen.getByRole("tab", { name: i18n.t("library.documents") }));
    expect(screen.getAllByRole("button", { name: i18n.t("library.returnToOrigin") })).toHaveLength(
      1,
    );
    expect(store.getState().workspaceReturns).toEqual([origin]);
    await userEvent.click(screen.getByRole("tab", { name: i18n.t("library.memory") }));
    expect(screen.getByRole("textbox", { name: i18n.t("library.search.memories") })).toBe(
      memorySearch,
    );
    expect(memorySearch).toHaveProperty("value", "retained search");
    expect(libraryScroll.scrollTop).toBe(260);
    returnButton.focus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(store.getState().settingsRoute).toBe("memory-tools"));
    expect(store.getState().editorAgentId).toBe(A);
    expect(store.getState().workspaceReturns).toEqual([]);
    expect(screen.queryByRole("button", { name: i18n.t("library.returnToOrigin") })).toBeNull();
    expect(client.updateKnowledgeDocument).not.toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement).toBe(source));
    view.unmount();
    opener.unmount();
  },
);

it.each(["save", "discard"] as const)(
  "header return cancel preserves the draft, then %s continues to the stored origin",
  async (choice) => {
    const updatePolicy = vi.fn<SuperstringApi["updatePolicy"]>(async (_id, body) => {
      const parsed = PolicyUpdateSchema.parse(body);
      return {
        auto_enabled: parsed.auto_enabled,
        every_turns: parsed.every_turns,
        target_chars: parsed.target_chars,
        version: parsed.expected_version + 1,
      };
    });
    setupLibrary({ updatePolicy });
    store.setState({ settingsRoute: "memory-tools" });
    await act(async () => store.getState().openWorkspaceTarget("long-memory", A));
    render(
      <>
        <LibraryWorkspace />
        <NavigationGuard />
      </>,
    );
    await screen.findByRole("button", { name: memory.name });
    const target = screen.getByRole("spinbutton", {
      name: i18n.t("library.target.memory.characters"),
    });
    fireEvent.change(target, { target: { value: "1300" } });
    const returnButton = screen.getByRole("button", { name: i18n.t("library.returnToOrigin") });
    await userEvent.click(returnButton);
    expect(store.getState().pendingNavigation).toMatchObject({
      kind: "workspace-target",
      returning: true,
      route: "memory-tools",
    });
    await userEvent.click(screen.getByRole("button", { name: i18n.t("workspace.stay_here") }));
    expect(target).toHaveProperty("value", "1300");
    expect(store.getState().workspaceReturns).toHaveLength(1);
    expect(updatePolicy).not.toHaveBeenCalled();
    await userEvent.click(returnButton);
    await userEvent.click(
      screen.getByRole("button", {
        name: i18n.t(
          choice === "save" ? "workspace.save_and_continue" : "workspace.discard_and_continue",
        ),
      }),
    );
    await waitFor(() => expect(store.getState().settingsRoute).toBe("memory-tools"));
    expect(store.getState().editorAgentId).toBe(A);
    expect(store.getState().workspaceReturns).toEqual([]);
    expect(updatePolicy).toHaveBeenCalledTimes(choice === "save" ? 1 : 0);
    if (choice === "save")
      expect(updatePolicy).toHaveBeenCalledWith(A, {
        auto_enabled: true,
        every_turns: 20,
        target_chars: 1300,
        expected_version: 1,
      });
  },
);
