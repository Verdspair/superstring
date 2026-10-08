import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MemoryDetail } from "../../src/web/screens/library/MemoryLibrary";
import { useSuperstringStore as store } from "../../src/web/store";
import { memory, memoryContent, setupLibrary } from "./helpers/library-fixture";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it("retains a memory detail but does not display or read it while its panel is inactive", async () => {
  setupLibrary();
  const load = vi.fn().mockResolvedValue(undefined);
  store.setState({ memoryEntryDetail: memory, memoryContent, loadMemoryContent: load });
  const view = render(<MemoryDetail active={false} />);
  await act(async () => {});
  expect(load).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).toBeNull();
  view.rerender(<MemoryDetail active />);
  await act(async () => {});
  expect(load).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("dialog")).toBeTruthy();
  view.rerender(<MemoryDetail active={false} />);
  await act(async () => {});
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(store.getState().memoryEntryDetail).toEqual(memory);
  expect(load).toHaveBeenCalledTimes(1);
});
