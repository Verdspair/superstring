import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SuperstringApi } from "../../src/web/api";
import { selectLocale } from "../../src/web/i18n";
import { LibraryWorkspace } from "../../src/web/screens/library/LibraryWorkspace";
import { useSuperstringStore as store } from "../../src/web/store";
import { memory, setupLibrary } from "./helpers/library-fixture";

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
