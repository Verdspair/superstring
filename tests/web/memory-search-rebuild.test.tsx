import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SuperstringApi } from "../../src/web/api";
import { selectLocale } from "../../src/web/i18n";
import { i18n } from "../../src/web/i18n/runtime";
import { MemoryLibrary } from "../../src/web/screens/library/MemoryLibrary";
import { useSuperstringStore as store } from "../../src/web/store";
import { A, B, setupLibrary } from "./helpers/library-fixture";
import { render } from "./helpers/render-with-providers";

const REBUILD_KEYS = [
  "library.rebuildSearchProjection",
  "hints.library.memory.rebuildSearchProjection",
  "library.rebuild.title",
  "library.rebuild.description",
  "library.rebuild.batchSize",
  "library.rebuild.currentCursor",
  "library.rebuild.startFromBeginning",
  "library.rebuild.executeBatch",
  "library.rebuild.continueNextBatch",
  "library.rebuild.startNewPass",
  "library.rebuild.batchSuccess",
  "library.rebuild.traversalFinished",
  "library.rebuild.abortedUnknown",
  "library.rebuild.failedRetry",
  "library.rebuild.inFlight",
  "library.rebuild.cancel",
  "library.rebuild.close",
];

beforeEach(() => {
  localStorage.clear();
  selectLocale("zh-CN");
  for (const k of REBUILD_KEYS) {
    expect(i18n.exists(k, { lng: "zh-CN" })).toBe(true);
    expect(i18n.exists(k, { lng: "en" })).toBe(true);
  }
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  selectLocale("zh-CN");
});

describe("Memory search projection rebuild UI", () => {
  it("enforces integer batch size validation between 1 and 300 without silent fallback", async () => {
    setupLibrary();
    store.setState({ settingsRoute: "long-memory" });

    render(<MemoryLibrary active={true} />);

    fireEvent.click(screen.getByRole("button", { name: "重建搜索投影" }));

    const batchInput = await screen.findByLabelText("单批数量上限 (1-300)");
    expect(batchInput).toHaveProperty("value", "100");
    const executeBtn = screen.getByRole("button", { name: "执行本批重建" });
    expect(executeBtn).toHaveProperty("disabled", false);

    // Invalid non-integer: disabled without silent rounding
    fireEvent.change(batchInput, { target: { value: "10.5" } });
    expect(executeBtn).toHaveProperty("disabled", true);

    // Invalid < 1: disabled
    fireEvent.change(batchInput, { target: { value: "0" } });
    expect(executeBtn).toHaveProperty("disabled", true);

    // Invalid > 300: disabled without silent clamping
    fireEvent.change(batchInput, { target: { value: "301" } });
    expect(executeBtn).toHaveProperty("disabled", true);

    // Valid integer: enabled
    fireEvent.change(batchInput, { target: { value: "50" } });
    expect(executeBtn).toHaveProperty("disabled", false);
  });

  it("performs one-click one-page execution, advances cursor, and does not automatically loop in background", async () => {
    const rebuildMemorySearchProjection = vi
      .fn<SuperstringApi["rebuildMemorySearchProjection"]>()
      .mockResolvedValueOnce({ rebuilt: 100, next_after_id: "mem-100" })
      .mockResolvedValueOnce({ rebuilt: 35, next_after_id: null });

    setupLibrary({ rebuildMemorySearchProjection });
    store.setState({ settingsRoute: "long-memory" });

    render(<MemoryLibrary active={true} />);

    // Open rebuild sheet via single clear toolbar button
    const openBtn = screen.getByRole("button", { name: "重建搜索投影" });
    fireEvent.click(openBtn);

    // Verify sheet title and default batch size
    expect(await screen.findByText("重建记忆搜索投影")).toBeTruthy();
    const batchInput = screen.getByLabelText("单批数量上限 (1-300)");
    expect(batchInput).toHaveProperty("value", "100");
    expect(screen.getByText("起始（从头遍历）")).toBeTruthy();

    // First click: execute batch from beginning
    const executeBtn = screen.getByRole("button", { name: "执行本批重建" });
    fireEvent.click(executeBtn);

    await waitFor(() => {
      expect(rebuildMemorySearchProjection).toHaveBeenCalledTimes(1);
    });

    expect(rebuildMemorySearchProjection).toHaveBeenLastCalledWith(
      A,
      { limit: 100 },
      expect.any(AbortSignal),
    );

    // Verify UI reflects batch success and cursor advancement
    expect(await screen.findByText("本批已成功重建 100 条记录。")).toBeTruthy();
    expect(screen.getByText("mem-100")).toBeTruthy();

    // Verify no automatic while-loop occurred in background
    await new Promise((r) => setTimeout(r, 60));
    expect(rebuildMemorySearchProjection).toHaveBeenCalledTimes(1);

    // Second click: continue next batch with cursor mem-100
    const continueBtn = screen.getByRole("button", { name: "继续下一批" });
    fireEvent.click(continueBtn);

    await waitFor(() => {
      expect(rebuildMemorySearchProjection).toHaveBeenCalledTimes(2);
    });

    expect(rebuildMemorySearchProjection).toHaveBeenLastCalledWith(
      A,
      { after_id: "mem-100", limit: 100 },
      expect.any(AbortSignal),
    );

    // Traversal finished: next_after_id is null
    expect(
      await screen.findByText(
        "本次遍历已到达末尾（next_after_id 为空）。若存在并发写入或新增低 ID 条目，可点击“开始新一轮遍历”。",
      ),
    ).toBeTruthy();

    // Button transitions to "开始新一轮遍历"
    const newPassBtn = screen.getByRole("button", { name: "开始新一轮遍历" });
    expect(newPassBtn).toBeTruthy();

    // Click "开始新一轮遍历" resets cursor
    fireEvent.click(newPassBtn);
    expect(screen.getByText("起始（从头遍历）")).toBeTruthy();
    expect(screen.getByRole("button", { name: "执行本批重建" })).toBeTruthy();
  });

  it("preserves existing drafts, policy inputs, and unsaved changes across rebuild workflow", async () => {
    const rebuildMemorySearchProjection = vi
      .fn<SuperstringApi["rebuildMemorySearchProjection"]>()
      .mockResolvedValueOnce({ rebuilt: 10, next_after_id: null });

    setupLibrary({ rebuildMemorySearchProjection });
    store.setState({ settingsRoute: "long-memory" });

    render(<MemoryLibrary active={true} />);

    // Modify a draft field in memory rules
    const promptInput = screen.getByLabelText("记忆整理提示词");
    fireEvent.change(promptInput, { target: { value: "Custom consolidation draft prompt" } });
    expect(store.getState().pageEditor?.draft.memory_consolidation_prompt).toBe(
      "Custom consolidation draft prompt",
    );

    // Open rebuild sheet and execute
    const openBtn = screen.getByRole("button", { name: "重建搜索投影" });
    fireEvent.click(openBtn);

    const executeBtn = await screen.findByRole("button", { name: "执行本批重建" });
    fireEvent.click(executeBtn);

    await waitFor(() => {
      expect(rebuildMemorySearchProjection).toHaveBeenCalledTimes(1);
    });

    // Close sheet
    fireEvent.click(screen.getByRole("button", { name: "关闭" }));

    // Verify draft remains intact and untouched
    expect(store.getState().pageEditor?.draft.memory_consolidation_prompt).toBe(
      "Custom consolidation draft prompt",
    );
    expect(promptInput).toHaveProperty("value", "Custom consolidation draft prompt");
  });

  it("preserves cursor on server failure and supports explicit retry", async () => {
    let attempts = 0;
    const rebuildMemorySearchProjection = vi
      .fn<SuperstringApi["rebuildMemorySearchProjection"]>()
      .mockImplementation(async () => {
        attempts++;
        if (attempts === 1) {
          throw new Error("500 Search indexing failed");
        }
        return { rebuilt: 50, next_after_id: "mem-200" };
      });

    setupLibrary({ rebuildMemorySearchProjection });
    store.setState({ settingsRoute: "long-memory" });

    render(<MemoryLibrary active={true} />);

    fireEvent.click(screen.getByRole("button", { name: "重建搜索投影" }));

    const executeBtn = await screen.findByRole("button", { name: "执行本批重建" });
    fireEvent.click(executeBtn);

    // First attempt fails: shows error notice and preserves cursor for retry
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText("500 Search indexing failed")).toBeTruthy();
    expect(screen.getByText("本批重建失败，游标已保留，可重试本批。")).toBeTruthy();
    expect(screen.getByText("起始（从头遍历）")).toBeTruthy();

    // Retry execution
    fireEvent.click(screen.getByRole("button", { name: "执行本批重建" }));

    await waitFor(() => {
      expect(rebuildMemorySearchProjection).toHaveBeenCalledTimes(2);
    });

    // Second attempt succeeds and advances cursor
    expect(await screen.findByText("本批已成功重建 50 条记录。")).toBeTruthy();
    expect(screen.getByText("mem-200")).toBeTruthy();
  });

  it("aborts in-flight request on agent switch and drops late response", async () => {
    let resolveFirst: ((val: { rebuilt: number; next_after_id: string | null }) => void) | null =
      null;

    const rebuildMemorySearchProjection = vi
      .fn<SuperstringApi["rebuildMemorySearchProjection"]>()
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          }),
      );

    setupLibrary({ rebuildMemorySearchProjection });
    store.setState({ settingsRoute: "long-memory" });

    render(<MemoryLibrary active={true} />);

    fireEvent.click(screen.getByRole("button", { name: "重建搜索投影" }));

    fireEvent.click(await screen.findByRole("button", { name: "执行本批重建" }));

    expect(rebuildMemorySearchProjection).toHaveBeenCalledTimes(1);
    const signal = rebuildMemorySearchProjection.mock.calls[0]?.[2];
    if (!signal) throw new Error("Expected AbortSignal in third argument");
    expect(signal.aborted).toBe(false);

    // Switch Agent to Agent B while request is in flight
    act(() => {
      store.setState({ editorAgentId: B });
    });

    // Signal must be aborted immediately
    expect(signal.aborted).toBe(true);

    // Resolve late response for Agent A
    act(() => {
      if (resolveFirst) {
        resolveFirst({ rebuilt: 100, next_after_id: "mem-late" });
      }
    });

    // Verify late response did not update Agent B's sheet and did not create false unconfirmed alert
    expect(screen.queryByText("mem-late")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByText("起始（从头遍历）")).toBeTruthy();
  });

  it("aborts in-flight request on cancel, shows unconfirmed outcome, and does not advance cursor if cancelled promise subsequently resolves", async () => {
    let resolvePromise: ((val: { rebuilt: number; next_after_id: string | null }) => void) | null =
      null;

    const rebuildMemorySearchProjection = vi
      .fn<SuperstringApi["rebuildMemorySearchProjection"]>()
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            resolvePromise = resolve;
          }),
      );

    setupLibrary({ rebuildMemorySearchProjection });
    store.setState({ settingsRoute: "long-memory" });

    render(<MemoryLibrary active={true} />);

    fireEvent.click(screen.getByRole("button", { name: "重建搜索投影" }));

    fireEvent.click(await screen.findByRole("button", { name: "执行本批重建" }));

    expect(screen.getByText("正在重建搜索投影...")).toBeTruthy();
    const signal = rebuildMemorySearchProjection.mock.calls[0]?.[2];
    if (!signal) throw new Error("Expected AbortSignal in third argument");
    expect(signal.aborted).toBe(false);

    // User clicks cancel button
    fireEvent.click(screen.getByRole("button", { name: "取消" }));

    expect(signal.aborted).toBe(true);

    // Notice shows unconfirmed outcome rather than claiming writes never occurred
    expect(
      await screen.findByText(
        "操作已取消。已发送的批次在服务端的执行结果未确认，请检查或重新执行。",
      ),
    ).toBeTruthy();

    // Simulate the cancelled promise resolving late despite abort
    act(() => {
      if (resolvePromise) {
        resolvePromise({ rebuilt: 77, next_after_id: "mem-cancelled-late" });
      }
    });

    // Cursor must NOT advance to mem-cancelled-late, and success text must NOT appear
    expect(screen.queryByText("mem-cancelled-late")).toBeNull();
    expect(screen.queryByText("本批已成功重建 77 条记录。")).toBeNull();
    expect(screen.getByText("起始（从头遍历）")).toBeTruthy();
  });

  it("renders correctly in English locale without Chinese fallback text", async () => {
    const rebuildMemorySearchProjection = vi
      .fn<SuperstringApi["rebuildMemorySearchProjection"]>()
      .mockResolvedValueOnce({ rebuilt: 42, next_after_id: null });

    // setupLibrary resets to zh-CN, so selectLocale("en") must be called AFTER setupLibrary
    setupLibrary({ rebuildMemorySearchProjection });
    selectLocale("en");
    store.setState({ settingsRoute: "long-memory" });

    render(<MemoryLibrary active={true} />);

    const openBtn = screen.getByRole("button", { name: "Rebuild search projection" });
    fireEvent.click(openBtn);

    expect(await screen.findByText("Rebuild memory search projection")).toBeTruthy();
    expect(screen.getByText("Start (from beginning)")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Rebuild this batch" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Rebuild this batch" }));

    expect(await screen.findByText("Successfully rebuilt 42 entries in this batch.")).toBeTruthy();
    expect(screen.getByText(/This traversal has reached the end/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start new pass" })).toBeTruthy();
  });
});
