import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { selectLocale } from "../../src/web/i18n";
import { MemoryLibrary } from "../../src/web/screens/library/MemoryLibrary";
import { StickerLibrary } from "../../src/web/screens/library/StickerLibrary";
import { useSuperstringStore as store } from "../../src/web/store";
import { M, memory, setupLibrary, sticker } from "./helpers/library-fixture";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  selectLocale("zh-CN");
});

it("updates memory and job dates when the interface locale changes", async () => {
  setupLibrary();
  store.setState({
    memoryJobs: [
      {
        id: M,
        kind: "manual",
        session_id: null,
        status: "succeeded",
        result_id: M,
        error_code: null,
        created_at: memory.created_at,
        finished_at: memory.created_at,
      },
    ],
  });
  await act(async () => render(<MemoryLibrary />));
  const date = new Date(memory.created_at);
  const zh = date.toLocaleString("zh-CN");
  expect(
    screen.getAllByText(
      (_, element) => element?.tagName === "P" && !!element.textContent?.includes(zh),
    ),
  ).toHaveLength(1);
  expect(screen.getByText(zh)).toBeTruthy();

  await act(async () => selectLocale("en"));
  const en = date.toLocaleString("en");
  expect(
    screen.getAllByText(
      (_, element) => element?.tagName === "P" && !!element.textContent?.includes(en),
    ),
  ).toHaveLength(1);
  expect(screen.getByText(en)).toBeTruthy();
  expect(screen.queryByText(zh)).toBeNull();
});

it("formats sticker size with the active locale's number and unit rules", async () => {
  const asset = { ...sticker, byte_size: 1234567 };
  setupLibrary({ listQqStickerAssets: vi.fn().mockResolvedValue([asset]) });
  await act(async () => render(<StickerLibrary />));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "打开 Smile" })));
  for (const language of ["en", "zh-CN"] as const) {
    await act(async () => selectLocale(language));
    const size = new Intl.NumberFormat(language, {
      style: "unit",
      unit: "kilobyte",
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    }).format(asset.byte_size / 1024);
    expect(
      screen.getByText(
        (_, element) => element?.tagName === "P" && !!element.textContent?.endsWith(size),
      ),
    ).toBeTruthy();
  }
});
