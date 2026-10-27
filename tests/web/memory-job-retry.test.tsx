// 失败整理任务重试：仅 failed 行入口、确认框含任务号/模型费用/原快照、失败保留原任务、
// 迟到响应不得写当前 Agent/列表/feedback（切 Agent 或离页后）。
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryJobView } from "../../src/shared/contracts";
import { ApiError } from "../../src/web/api";
import { selectLocale } from "../../src/web/i18n";
import { i18n } from "../../src/web/i18n/runtime";
import { MemoryLibrary } from "../../src/web/screens/library/MemoryLibrary";
import { useSuperstringStore as store } from "../../src/web/store";
import { A, B, D, M, setupLibrary } from "./helpers/library-fixture";
import { render } from "./helpers/render-with-providers";

const RETRY_KEY = "library.memory.job.retry.confirm";

const failedJob: MemoryJobView = {
  id: M,
  kind: "manual",
  session_id: D,
  status: "failed",
  result_id: null,
  error_code: "MODEL_ERROR",
  created_at: "2026-09-25T00:00:00.000Z",
  finished_at: "2026-09-25T00:01:00.000Z",
};
const queuedJob: MemoryJobView = {
  ...failedJob,
  id: B,
  status: "queued",
  error_code: null,
  finished_at: null,
};
const succeededJob: MemoryJobView = {
  ...failedJob,
  id: "77777777-7777-4777-8777-777777777777",
  status: "succeeded",
  result_id: M,
  error_code: null,
};

function deferredRetry() {
  const box: { resolve?: (job: MemoryJobView) => void } = {};
  const retryMemoryJob = vi.fn(
    () =>
      new Promise<MemoryJobView>((done) => {
        box.resolve = done;
      }),
  );
  return {
    retryMemoryJob,
    resolve(job: MemoryJobView) {
      if (!box.resolve) throw new Error("retry was not requested");
      box.resolve(job);
    },
  };
}

async function openConfirm() {
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  const dialog = await screen.findByRole("alertdialog");
  expect(within(dialog).getByRole("button", { name: "重试" })).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "重试" }));
}

beforeEach(() => {
  localStorage.clear();
  selectLocale("zh-CN");
  // 官方 en/zh 资源必须包含重试确认文案，缺失即失败。
  expect(i18n.exists(RETRY_KEY, { lng: "zh-CN" })).toBe(true);
  expect(i18n.exists(RETRY_KEY, { lng: "en" })).toBe(true);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  selectLocale("zh-CN");
});

describe("failed memory job retry", () => {
  it("offers retry only on failed rows and disables it while an active job exists", async () => {
    let currentJobs = [failedJob, succeededJob, queuedJob];
    const listMemoryJobs = vi.fn().mockImplementation(async () => currentJobs);
    setupLibrary({ listMemoryJobs });
    store.setState({
      settingsRoute: "long-memory",
      memoryJobs: currentJobs,
    });
    await act(async () => render(<MemoryLibrary />));
    expect(screen.getAllByRole("button", { name: "重试" })).toHaveLength(1);
    expect(screen.getByText("排队中")).toBeTruthy();
    const retry = screen.getByRole("button", { name: "重试" });
    expect(retry.getAttribute("data-variant")).toBe("outline");
    expect(retry.hasAttribute("disabled")).toBe(true);

    currentJobs = [failedJob, succeededJob];
    await act(async () => {
      store.setState({ memoryJobs: currentJobs });
    });
    expect(screen.getByRole("button", { name: "重试" }).hasAttribute("disabled")).toBe(false);

    // running 中的任务同样阻止重试。
    currentJobs = [
      failedJob,
      {
        ...failedJob,
        id: "66666666-6666-4666-8666-666666666666",
        status: "running",
        error_code: null,
        finished_at: null,
      },
    ];
    await act(async () => {
      store.setState({ memoryJobs: currentJobs });
    });
    expect(screen.getByRole("button", { name: "重试" }).hasAttribute("disabled")).toBe(true);
  });

  it("states the job id, model cost and original snapshot before writing anything", async () => {
    const currentJobs = [failedJob];
    const retryMemoryJob = vi.fn().mockResolvedValue(queuedJob);
    const listMemoryJobs = vi.fn().mockImplementation(async () => currentJobs);
    setupLibrary({ retryMemoryJob, listMemoryJobs });
    store.setState({ settingsRoute: "long-memory", memoryJobs: currentJobs });
    await act(async () => render(<MemoryLibrary />));
    const baselineCalls = listMemoryJobs.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain(M);
    expect(dialog.textContent).toContain("费用");
    expect(dialog.textContent).toContain("原快照");
    expect(dialog.textContent).toContain("复验来源");
    expect(within(dialog).getByRole("button", { name: "取消" })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "重试" })).toBeTruthy();
    // 打开确认框本身零写：既不调用重试，也不额外读取列表。
    expect(retryMemoryJob).not.toHaveBeenCalled();
    expect(listMemoryJobs).toHaveBeenCalledTimes(baselineCalls);
    expect(store.getState().error).toBeNull();
  });

  it("cancel closes the dialog with zero writes", async () => {
    const currentJobs = [failedJob];
    const retryMemoryJob = vi.fn().mockResolvedValue(queuedJob);
    const listMemoryJobs = vi.fn().mockImplementation(async () => currentJobs);
    setupLibrary({ retryMemoryJob, listMemoryJobs });
    store.setState({ settingsRoute: "long-memory", memoryJobs: currentJobs });
    await act(async () => render(<MemoryLibrary />));
    const baselineCalls = listMemoryJobs.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    const feedback = store.getState().feedback;
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(retryMemoryJob).not.toHaveBeenCalled();
    expect(listMemoryJobs).toHaveBeenCalledTimes(baselineCalls);
    expect(store.getState().memoryJobs).toEqual([failedJob]);
    expect(store.getState().error).toBeNull();
    expect(store.getState().feedback).toBe(feedback);
  });

  it("confirm writes once under a double click and refreshes the job list after success", async () => {
    let currentJobs = [failedJob];
    const { retryMemoryJob, resolve } = deferredRetry();
    const listMemoryJobs = vi.fn().mockImplementation(async () => currentJobs);
    setupLibrary({
      retryMemoryJob,
      listMemoryJobs,
    });
    store.setState({ settingsRoute: "long-memory", memoryJobs: currentJobs });
    await act(async () => render(<MemoryLibrary />));
    const baselineCalls = listMemoryJobs.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    const dialog = await screen.findByRole("alertdialog");
    const confirm = within(dialog).getByRole("button", { name: "重试" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(retryMemoryJob).toHaveBeenCalledTimes(1);
    expect(retryMemoryJob).toHaveBeenCalledWith(A, M);

    currentJobs = [{ ...queuedJob }];
    await act(async () => {
      resolve({ ...queuedJob });
    });
    await waitFor(() =>
      expect(store.getState().memoryJobs.map((job) => job.status)).toEqual(["queued"]),
    );
    expect(listMemoryJobs.mock.calls.length).toBeGreaterThanOrEqual(baselineCalls + 1);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.queryByRole("button", { name: "重试" })).toBeNull();
    expect(screen.getByText("排队中")).toBeTruthy();
  });

  it("keeps an unsaved content draft across a successful retry", async () => {
    let currentJobs = [failedJob];
    const retryMemoryJob = vi.fn().mockResolvedValue({ ...queuedJob });
    const listMemoryJobs = vi.fn().mockImplementation(async () => currentJobs);
    setupLibrary({
      retryMemoryJob,
      listMemoryJobs,
    });
    store.setState({
      settingsRoute: "long-memory",
      memoryJobs: currentJobs,
      memoryCorrectionDirty: true,
      memoryCorrectionDraft: {
        expected_revision: "a".repeat(64),
        name: "Memory one",
        summary: "Apple preference",
        tags: ["food"],
        body: "Draft body",
      },
    });
    await act(async () => render(<MemoryLibrary />));
    currentJobs = [{ ...queuedJob }];
    await openConfirm();
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(retryMemoryJob).toHaveBeenCalledWith(A, M);
    await waitFor(() =>
      expect(store.getState().memoryJobs.map((job) => job.status)).toEqual(["queued"]),
    );
    expect(listMemoryJobs).toHaveBeenCalledWith(A);
    expect(store.getState().memoryCorrectionDirty).toBe(true);
    expect(store.getState().memoryCorrectionDraft?.body).toBe("Draft body");
    expect(store.getState().memoryContent).toBeNull();
  });

  it("keeps the dialog and the original job on failure, showing the 409 source change as-is", async () => {
    const retryMemoryJob = vi
      .fn()
      .mockRejectedValue(
        new ApiError(409, "MEMORY_SOURCE_CHANGED", "来源或治理已变化，请重新选择并创建新任务"),
      );
    const currentJobs = [failedJob];
    const listMemoryJobs = vi.fn().mockImplementation(async () => currentJobs);
    const client = setupLibrary({
      retryMemoryJob,
      listMemoryJobs,
      consolidate: vi.fn(),
      merge: vi.fn(),
    });
    store.setState({ settingsRoute: "long-memory", memoryJobs: currentJobs });
    await act(async () => render(<MemoryLibrary />));
    const baselineCalls = listMemoryJobs.mock.calls.length;
    await openConfirm();
    await waitFor(() =>
      expect(store.getState().error).toContain("[MEMORY_SOURCE_CHANGED] 来源或治理已变化"),
    );
    // 失败保留确认框与原始任务，409 来源变更按服务端原文提示。
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.textContent).toContain(M);
    expect(dialog.textContent).toContain("[MEMORY_SOURCE_CHANGED] 来源或治理已变化");
    expect(store.getState().memoryJobs).toEqual([failedJob]);
    expect(listMemoryJobs).toHaveBeenCalledTimes(baselineCalls);
    // 过期来源被拒绝后没有自动新任务兜底。
    expect(client.consolidate).not.toHaveBeenCalled();
    expect(client.merge).not.toHaveBeenCalled();
    expect(retryMemoryJob).toHaveBeenCalledTimes(1);
    // 模态打开期间页面提示被 aria-hidden；关闭确认框后错误提示仍在。
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(screen.getByRole("alert").textContent).toContain("MEMORY_SOURCE_CHANGED");
    expect(store.getState().memoryJobs).toEqual([failedJob]);
  });

  it("does not write anything when the response arrives after switching agents", async () => {
    const currentJobs = [failedJob];
    const { retryMemoryJob, resolve } = deferredRetry();
    const listMemoryJobs = vi.fn().mockImplementation(async () => currentJobs);
    setupLibrary({ retryMemoryJob, listMemoryJobs });
    store.setState({ settingsRoute: "long-memory", memoryJobs: currentJobs });
    await act(async () => render(<MemoryLibrary />));
    const baselineCalls = listMemoryJobs.mock.calls.length;
    await openConfirm();
    await act(async () => {
      store.setState({ editorAgentId: B });
    });
    // 切 Agent 先收起重试确认，不再让陈旧确认框可达。
    expect(screen.queryByRole("alertdialog")).toBeNull();
    const feedback = store.getState().feedback;
    await act(async () => {
      resolve({ ...queuedJob });
    });
    await act(async () => {});
    expect(store.getState().memoryJobs).toEqual([failedJob]);
    expect(store.getState().feedback).toBe(feedback);
    expect(store.getState().error).toBeNull();
    expect(listMemoryJobs).toHaveBeenCalledTimes(baselineCalls);
  });

  it("does not write anything when the response arrives after leaving the page", async () => {
    const currentJobs = [failedJob];
    const { retryMemoryJob, resolve } = deferredRetry();
    const listMemoryJobs = vi.fn().mockImplementation(async () => currentJobs);
    setupLibrary({ retryMemoryJob, listMemoryJobs });
    store.setState({ settingsRoute: "long-memory", memoryJobs: currentJobs });
    await act(async () => render(<MemoryLibrary />));
    const baselineCalls = listMemoryJobs.mock.calls.length;
    await openConfirm();
    cleanup();
    const feedback = store.getState().feedback;
    await act(async () => {
      resolve({ ...queuedJob });
    });
    await act(async () => {});
    expect(store.getState().memoryJobs).toEqual([failedJob]);
    expect(store.getState().feedback).toBe(feedback);
    expect(store.getState().error).toBeNull();
    expect(listMemoryJobs).toHaveBeenCalledTimes(baselineCalls);
  });

  it("states cost and snapshot in English too", async () => {
    setupLibrary({
      retryMemoryJob: vi.fn().mockResolvedValue(queuedJob),
      listMemoryJobs: vi.fn().mockResolvedValue([failedJob]),
    });
    selectLocale("en");
    store.setState({ settingsRoute: "long-memory", memoryJobs: [failedJob] });
    await act(async () => render(<MemoryLibrary />));
    fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain(M);
    expect(dialog.textContent).toContain("usage costs");
    expect(dialog.textContent).toContain("original snapshot");
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("filtered retry preserves page 2 and current query filters on refresh", async () => {
    let currentJobs = [failedJob];
    const listMemoryEntries = vi.fn().mockResolvedValue({ items: [], total: 150 });
    const listMemoryJobs = vi.fn().mockImplementation(async () => currentJobs);
    const retryMemoryJob = vi.fn().mockImplementation(async () => {
      currentJobs = [{ ...queuedJob }];
      return queuedJob;
    });
    setupLibrary({ listMemoryJobs, listMemoryEntries, retryMemoryJob });
    store.setState({ settingsRoute: "long-memory" });
    render(<MemoryLibrary />);
    await screen.findByRole("button", { name: "重试" });
    const search = screen.getByRole("textbox", { name: "搜索记忆" });
    fireEvent.change(search, { target: { value: "query" } });
    const form = search.closest("form");
    if (!form) throw new Error("missing search form");
    fireEvent.submit(form);
    await waitFor(() =>
      expect(listMemoryEntries.mock.calls.at(-1)?.[3]).toEqual({ search: "query" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "下一页" }));
    await waitFor(() => expect(listMemoryEntries.mock.calls.at(-1)?.[1]).toBe(100));
    listMemoryEntries.mockClear();
    await openConfirm();
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(retryMemoryJob).toHaveBeenCalledTimes(1);
    expect(listMemoryEntries).toHaveBeenCalledExactlyOnceWith(
      A,
      100,
      100,
      { search: "query" },
      expect.any(AbortSignal),
    );
  });

  it("job retry keeps an unsaved visibility draft intact without dropping draft", async () => {
    let currentJobs = [failedJob];
    const retryMemoryJob = vi.fn().mockResolvedValue({ ...queuedJob });
    const listMemoryJobs = vi.fn().mockImplementation(async () => currentJobs);
    setupLibrary({
      retryMemoryJob,
      listMemoryJobs,
    });
    store.setState({
      settingsRoute: "long-memory",
      memoryJobs: currentJobs,
      memoryVisibilityDirty: true,
      memoryVisibilityDraft: {
        visibility: "session_private",
        recipient_agent_ids: [],
      },
    });
    await act(async () => render(<MemoryLibrary />));
    currentJobs = [{ ...queuedJob }];
    await openConfirm();
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());

    // Job was retried
    expect(retryMemoryJob).toHaveBeenCalledWith(A, M);

    // Visibility draft is completely preserved!
    expect(store.getState().memoryVisibilityDirty).toBe(true);
    expect(store.getState().memoryVisibilityDraft?.visibility).toBe("session_private");
  });
});
