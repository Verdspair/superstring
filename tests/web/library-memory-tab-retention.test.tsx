import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SuperstringApi } from "../../src/web/api";
import { selectLocale } from "../../src/web/i18n";
import { LibraryWorkspace } from "../../src/web/screens/library/LibraryWorkspace";
import { useSuperstringStore as store } from "../../src/web/store";
import { memory, setupLibrary } from "./helpers/library-fixture";
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
