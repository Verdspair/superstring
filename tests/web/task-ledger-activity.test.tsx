import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type {
  TaskBodyPage,
  TaskDetail,
  TaskList,
  TaskSummary,
} from "../../src/shared/contracts/agent-task";
import type { SuperstringApi } from "../../src/web/api";
import { TaskLedger } from "../../src/web/screens/runs/task-ledger";
import {
  notifyConversationChange,
  resetConversationChangesForTests,
} from "../../src/web/services/conversation-changes";
import { A, D, setupLibrary } from "./helpers/library-fixture";
import { render } from "./helpers/render-with-providers";

const row: TaskSummary = {
  id: D,
  conversationId: A,
  agentId: A,
  originRunId: null,
  status: "running",
  createdAt: "2026-10-07T00:00:00Z",
  updatedAt: "2026-10-07T00:00:00Z",
  expiresAt: "2026-10-08T00:00:00Z",
  errorCode: null,
  callCount: 1,
  completedCallCount: 0,
  waitingOrdinal: null,
  waitingReason: null,
};
const page: TaskList = { items: [row], nextCursor: null, hasMore: false };
const change = () => notifyConversationChange({ event: "ready" });

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((release, fail) => {
    resolve = release;
    reject = fail;
  });
  return { promise, resolve, reject };
};

const bodyPage = (text: string): TaskBodyPage => ({
  status: "available",
  text,
  offset: 0,
  total: [...text].length,
  nextOffset: null,
});

const waitingDetail: TaskDetail = {
  ...row,
  expiresAt: "2099-10-08T00:00:00Z",
  status: "waiting_approval",
  waitingOrdinal: 0,
  waitingReason: "approval",
  dataStatus: "available",
  calls: [
    {
      ordinal: 0,
      name: "fixture.write",
      revision: "v1",
      effect: "write",
      status: "waiting_approval",
      approvalRevision: "approval-v1",
      errorCode: null,
      argumentsPreview: bodyPage('{"note":"synthetic"}'),
      resultStatus: "pending",
    },
  ],
};
const waitingPage: TaskList = { ...page, items: [waitingDetail] };

async function openTaskDetail() {
  fireEvent.click(await screen.findByRole("button", { name: "详情" }));
  await screen.findByRole("button", { name: "核对并批准" });
}

async function submitTaskOperation(operation: "approve" | "reject" | "cancel") {
  if (operation === "cancel") {
    fireEvent.click(screen.getByRole("button", { name: "取消任务" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "确认" }));
  } else {
    fireEvent.click(screen.getByRole("button", { name: "核对并批准" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(
      within(dialog).getByRole("button", {
        name: operation === "approve" ? "批准这一次" : "拒绝",
      }),
    );
  }
  await act(async () => {});
}

const make50 = (prefix: string, callCount = 1): TaskSummary[] =>
  Array.from({ length: 50 }, (_, i) => ({
    ...row,
    id: `${prefix}-${i.toString().padStart(2, "0")}`,
    callCount,
  }));

afterEach(() => {
  cleanup();
  resetConversationChangesForTests();
  vi.restoreAllMocks();
});

it("does not read or react to SSE while inactive and reads once on activation", async () => {
  const list = vi.fn<SuperstringApi["listTasks"]>().mockResolvedValue(page);
  setupLibrary({ listTasks: list });
  const view = render(<TaskLedger active={false} />);
  await act(async () => {
    change();
  });
  expect(list).not.toHaveBeenCalled();
  view.rerender(<TaskLedger active />);
  await act(async () => {});
  expect(list).toHaveBeenCalledTimes(1);
  expect(screen.getByText("0/1")).toBeTruthy();
  view.rerender(<TaskLedger active={false} />);
  await act(async () => {
    change();
  });
  expect(list).toHaveBeenCalledTimes(1);
  expect(screen.getByText("0/1")).toBeTruthy();
  view.rerender(<TaskLedger active />);
  await act(async () => {});
  expect(list).toHaveBeenCalledTimes(2);
});

it("cancels an off-space read and refuses its late result after resume", async () => {
  const releases: ((value: TaskList) => void)[] = [];
  const signals: AbortSignal[] = [];
  const list = vi.fn<SuperstringApi["listTasks"]>((_query, signal) => {
    if (signal) signals.push(signal);
    return new Promise<TaskList>((resolve) => releases.push(resolve));
  });
  setupLibrary({ listTasks: list });
  const view = render(<TaskLedger active />);
  await act(async () => {});
  view.rerender(<TaskLedger active={false} />);
  expect(signals[0].aborted).toBe(true);
  await act(async () => {
    change();
  });
  expect(list).toHaveBeenCalledTimes(1);
  view.rerender(<TaskLedger active />);
  await act(async () => {});
  expect(list).toHaveBeenCalledTimes(2);
  await act(async () => releases[0](page));
  expect(screen.queryByText("0/1")).toBeNull();
  await act(async () => releases[1]({ ...page, items: [{ ...row, callCount: 2 }] }));
  expect(screen.getByText("0/2")).toBeTruthy();
});

it("coalesces an in-flight read on SSE ready handshake but revalidates if real conversation_changed arrives", async () => {
  let release1!: (value: TaskList) => void;
  const list = vi.fn<SuperstringApi["listTasks"]>().mockImplementation(() => {
    return new Promise<TaskList>((resolve) => {
      release1 = resolve;
    });
  });
  setupLibrary({ listTasks: list });
  render(<TaskLedger active conversationId={A} />);
  expect(list).toHaveBeenCalledTimes(1);

  // Ready handshake arrives while initial read is in-flight: should NOT queue redundant revalidation
  await act(async () => {
    notifyConversationChange({ event: "ready" });
  });

  // Initial read resolves
  await act(async () => {
    release1(page);
  });

  // Expect exactly 1 call (coalesced, ready handshake didn't cause duplicate trailing GET)
  expect(list).toHaveBeenCalledTimes(1);

  // Now an actual state change arrives during a manual refresh read:
  let release2!: (value: TaskList) => void;
  let release3!: (value: TaskList) => void;
  list
    .mockImplementationOnce(
      () =>
        new Promise((r) => {
          release2 = r;
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise((r) => {
          release3 = r;
        }),
    );

  const refreshBtn = screen.getByRole("button", { name: /刷新/ });
  await act(async () => {
    refreshBtn.click();
  });
  expect(list).toHaveBeenCalledTimes(2);

  // While in flight, real conversation change occurs:
  await act(async () => {
    notifyConversationChange({
      event: "conversation_changed",
      conversationId: A,
      seq: 1,
      bindingEpoch: 1,
    });
  });

  // First resolves
  await act(async () => {
    release2(page);
  });

  // Because a real conversation change occurred, trailing revalidation MUST fire to stay authoritative
  expect(list).toHaveBeenCalledTimes(3);
  await act(async () => {
    release3(page);
  });
});

it("renders the first 50 items immediately without withholding them until later pages resolve", async () => {
  let releasePage1!: (value: TaskList) => void;
  let releasePage2!: (value: TaskList) => void;
  const p1Items = make50("p1", 1);
  const p2Items = make50("p2", 1);

  const list = vi
    .fn<SuperstringApi["listTasks"]>()
    // First load: 50 items, hasMore true
    .mockResolvedValueOnce({ items: p1Items, nextCursor: "cursor-2", hasMore: true })
    // Load more: 50 items, hasMore false (total 100 loaded)
    .mockResolvedValueOnce({ items: p2Items, nextCursor: null, hasMore: false })
    // Refresh page 1: delayed
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releasePage1 = resolve;
        }),
    )
    // Refresh page 2: delayed
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          releasePage2 = resolve;
        }),
    );

  setupLibrary({ listTasks: list });
  render(<TaskLedger active conversationId={A} />);
  await act(async () => {});
  expect(list).toHaveBeenCalledTimes(1);

  // Click load more to get page 2 (loadedCount becomes 100)
  const loadMore = screen.getByRole("button", { name: /加载更多/ });
  await act(async () => {
    loadMore.click();
  });
  expect(list).toHaveBeenCalledTimes(2);

  // Trigger background refresh (via conversation change)
  await act(async () => {
    notifyConversationChange({
      event: "conversation_changed",
      conversationId: A,
      seq: 1,
      bindingEpoch: 1,
    });
  });
  expect(list).toHaveBeenCalledTimes(3);

  // When page 1 resolves with updated items (callCount 5), page 1 must render immediately without waiting for page 2
  const updatedP1Items = make50("p1", 5);
  await act(async () => {
    releasePage1({ items: updatedP1Items, nextCursor: "cursor-2", hasMore: true });
  });

  // In existing TaskLedger, page 1 is withheld because the while loop is waiting for page 2 before calling setList!
  // This assertion will FAIL (RED) until TaskLedger publishes page 1 immediately.
  expect(screen.getAllByText("0/5").length).toBeGreaterThan(0);

  // Page 2 resolves
  await act(async () => {
    releasePage2({ items: p2Items, nextCursor: null, hasMore: false });
  });
});

it("keeps the loaded tail while publishing a refreshed head and exposes a failed tail", async () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({
    ...row,
    id: `range-${i}`,
    callCount: i + 1,
  }));
  let head!: (page: TaskList) => void;
  let failTail!: (reason: Error) => void;
  const list = vi
    .fn<SuperstringApi["listTasks"]>()
    .mockResolvedValueOnce({ items: rows.slice(0, 50), nextCursor: "next", hasMore: true })
    .mockResolvedValueOnce({ items: rows.slice(50), nextCursor: null, hasMore: false })
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          head = resolve;
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          failTail = reject;
        }),
    );
  setupLibrary({ listTasks: list });
  render(<TaskLedger active />);
  await act(async () => {});
  await act(async () => {
    screen.getByRole("button", { name: /加载更多/ }).click();
  });
  await act(async () => {
    notifyConversationChange({
      event: "conversation_changed",
      conversationId: A,
      seq: 1,
      bindingEpoch: 1,
    });
  });
  await act(async () => {
    head({
      items: rows.slice(0, 50).map((item) => ({ ...item, callCount: 200 })),
      nextCursor: "next",
      hasMore: true,
    });
  });
  expect(screen.getAllByText("0/200")).toHaveLength(50);
  expect(screen.getByText("0/100")).toBeTruthy();
  await act(async () => {
    failTail(new Error("tail unreadable"));
  });
  expect(screen.getByRole("alert").textContent).toContain("tail unreadable");
  expect(screen.getByText("0/100")).toBeTruthy();
  expect(screen.getAllByText("0/200")).toHaveLength(50);
});

it("invalidates an explicitly read body when the same task moves to a new API client", async () => {
  const bodyA = vi
    .fn<SuperstringApi["getTaskBody"]>()
    .mockResolvedValue(bodyPage("body from API A"));
  setupLibrary({
    listTasks: vi.fn().mockResolvedValue(waitingPage),
    getTask: vi.fn().mockResolvedValue(waitingDetail),
    getTaskBody: bodyA,
  });
  render(<TaskLedger active />);
  await openTaskDetail();
  fireEvent.click(screen.getByRole("button", { name: "参数" }));
  expect(await screen.findByText("body from API A")).toBeTruthy();
  expect(bodyA).toHaveBeenCalledWith(D, 0, "arguments", 0, 2048, expect.any(AbortSignal));

  const nextDetail = deferred<TaskDetail>();
  const getTaskB = vi.fn<SuperstringApi["getTask"]>(() => nextDetail.promise);
  const bodyB = vi
    .fn<SuperstringApi["getTaskBody"]>()
    .mockResolvedValue(bodyPage("body from API B"));
  await act(async () => {
    setupLibrary({
      listTasks: vi.fn().mockResolvedValue(waitingPage),
      getTask: getTaskB,
      getTaskBody: bodyB,
    });
  });
  await waitFor(() => expect(getTaskB).toHaveBeenCalledTimes(1));
  expect(screen.queryByText("body from API A")).toBeNull();
  await act(async () => nextDetail.resolve(waitingDetail));
  expect(screen.queryByText("body from API A")).toBeNull();
  expect(bodyB).not.toHaveBeenCalled();

  // Task bodies remain explicit reads; a client change invalidates, not prefetches.
  fireEvent.click(screen.getByRole("button", { name: "参数" }));
  expect(await screen.findByText("body from API B")).toBeTruthy();
  expect(bodyB).toHaveBeenCalledTimes(1);
});

it("drops a pending body from the previous API client for the same task and ordinal", async () => {
  const oldBody = deferred<TaskBodyPage>();
  const bodyA = vi.fn<SuperstringApi["getTaskBody"]>(() => oldBody.promise);
  setupLibrary({
    listTasks: vi.fn().mockResolvedValue(waitingPage),
    getTask: vi.fn().mockResolvedValue(waitingDetail),
    getTaskBody: bodyA,
  });
  render(<TaskLedger active />);
  await openTaskDetail();
  fireEvent.click(screen.getByRole("button", { name: "参数" }));
  await waitFor(() => expect(bodyA).toHaveBeenCalledTimes(1));

  const getTaskB = vi.fn<SuperstringApi["getTask"]>().mockResolvedValue(waitingDetail);
  const bodyB = vi
    .fn<SuperstringApi["getTaskBody"]>()
    .mockResolvedValue(bodyPage("current API body"));
  await act(async () => {
    setupLibrary({
      listTasks: vi.fn().mockResolvedValue(waitingPage),
      getTask: getTaskB,
      getTaskBody: bodyB,
    });
  });
  await waitFor(() => expect(getTaskB).toHaveBeenCalledTimes(1));
  await act(async () => oldBody.resolve(bodyPage("late API A body")));
  expect(screen.queryByText("late API A body")).toBeNull();
  expect(bodyA.mock.calls[0][5]?.aborted).toBe(true);
  expect(bodyB).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "参数" }));
  expect(await screen.findByText("current API body")).toBeTruthy();
  expect(bodyB).toHaveBeenCalledWith(D, 0, "arguments", 0, 2048, expect.any(AbortSignal));
});

it("keeps explicit body paging at 2048, retains the readable page on failure, and retries its next offset", async () => {
  const firstBody = deferred<TaskBodyPage>();
  const firstText = "a".repeat(2048);
  const nextBody = bodyPage("tail🧪");
  nextBody.offset = 2048;
  nextBody.total = 2053;
  const body = vi
    .fn<SuperstringApi["getTaskBody"]>()
    .mockReturnValueOnce(firstBody.promise)
    .mockRejectedValueOnce(new Error("body page unavailable"))
    .mockResolvedValueOnce(nextBody);
  setupLibrary({
    listTasks: vi.fn().mockResolvedValue(waitingPage),
    getTask: vi.fn().mockResolvedValue(waitingDetail),
    getTaskBody: body,
  });
  render(<TaskLedger active />);
  await openTaskDetail();
  expect(body).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "参数" }));
  await waitFor(() => expect(body).toHaveBeenCalledTimes(1));
  fireEvent(window, new Event("blur"));
  fireEvent(window, new Event("focus"));
  expect(body.mock.calls[0][5]?.aborted).toBe(false);
  expect(body).toHaveBeenCalledTimes(1);
  expect(screen.queryByText(firstText)).toBeNull();
  await act(async () => {
    firstBody.resolve({ ...bodyPage(firstText), total: 2053, nextOffset: 2048 });
  });
  expect(screen.getByText(firstText)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "body page unavailable");
  expect(screen.getByText(firstText)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "下一页" }));
  expect(await screen.findByText("tail🧪")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("button", { name: "下一页" })).toBeNull();
  expect(body.mock.calls.map((call) => call.slice(0, 5))).toEqual([
    [D, 0, "arguments", 0, 2048],
    [D, 0, "arguments", 2048, 2048],
    [D, 0, "arguments", 2048, 2048],
  ]);
});

it.each(["approve", "reject", "cancel"] as const)(
  "settles a current %s once, preserves the ticket contract, and refreshes its task",
  async (operation) => {
    const completion = deferred<{ ok: true }>();
    const approveTask = vi.fn<SuperstringApi["approveTask"]>(() => completion.promise);
    const cancelTask = vi.fn<SuperstringApi["cancelTask"]>(() => completion.promise);
    const listTasks = vi.fn<SuperstringApi["listTasks"]>().mockResolvedValue(waitingPage);
    const getTask = vi.fn<SuperstringApi["getTask"]>().mockResolvedValue(waitingDetail);
    setupLibrary({ listTasks, getTask, approveTask, cancelTask });
    render(<TaskLedger active />);
    await openTaskDetail();
    await submitTaskOperation(operation);
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.getAttribute("aria-busy")).toBe("true");
    const submit = within(dialog).getByRole("button", {
      name: operation === "cancel" ? "确认" : operation === "approve" ? "批准这一次" : "拒绝",
    });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(submit);
    if (operation === "cancel") {
      expect(cancelTask).toHaveBeenCalledExactlyOnceWith(D);
      expect(approveTask).not.toHaveBeenCalled();
    } else {
      expect(approveTask).toHaveBeenCalledExactlyOnceWith(D, {
        ordinal: 0,
        expectedApproval: "approval-v1",
        approve: operation === "approve",
      });
      expect(cancelTask).not.toHaveBeenCalled();
    }
    await act(async () => completion.resolve({ ok: true }));
    await waitFor(() => expect(getTask).toHaveBeenCalledTimes(2));
    expect(listTasks).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "关闭面板" }));
    expect(await screen.findByRole("status")).toHaveProperty(
      "textContent",
      operation === "approve"
        ? "已批准这一次调用。"
        : operation === "reject"
          ? "已拒绝这次调用。"
          : "已取消。",
    );
  },
);

it.each(["approve", "cancel"] as const)(
  "does not let a late %s completion reload or announce into an inactive retained ledger",
  async (operation) => {
    const completion = deferred<{ ok: true }>();
    const approveTask = vi.fn<SuperstringApi["approveTask"]>(() => completion.promise);
    const cancelTask = vi.fn<SuperstringApi["cancelTask"]>(() => completion.promise);
    const listTasks = vi.fn<SuperstringApi["listTasks"]>().mockResolvedValue(waitingPage);
    const getTask = vi.fn<SuperstringApi["getTask"]>().mockResolvedValue(waitingDetail);
    setupLibrary({ listTasks, getTask, approveTask, cancelTask });
    const view = render(<TaskLedger active />);
    await openTaskDetail();
    await submitTaskOperation(operation);
    expect(operation === "approve" ? approveTask : cancelTask).toHaveBeenCalledTimes(1);

    // ConversationWorkspace retains this ledger when the user leaves its tasks tab.
    view.rerender(<TaskLedger active={false} />);
    await act(async () => completion.resolve({ ok: true }));
    expect(getTask).toHaveBeenCalledTimes(1);
    expect(listTasks).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("status")).toBeNull();

    view.rerender(<TaskLedger active />);
    await waitFor(() => expect(listTasks).toHaveBeenCalledTimes(2));
    expect(getTask).toHaveBeenCalledTimes(2);
    expect(operation === "approve" ? approveTask : cancelTask).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("status")).toBeNull();
  },
);

it.each(["approve", "cancel"] as const)(
  "does not publish a late %s completion through the previous API client",
  async (operation) => {
    const completion = deferred<{ ok: true }>();
    const approveTask = vi.fn<SuperstringApi["approveTask"]>(() => completion.promise);
    const cancelTask = vi.fn<SuperstringApi["cancelTask"]>(() => completion.promise);
    const listA = vi.fn<SuperstringApi["listTasks"]>().mockResolvedValue(waitingPage);
    const detailA = vi.fn<SuperstringApi["getTask"]>().mockResolvedValue(waitingDetail);
    setupLibrary({ listTasks: listA, getTask: detailA, approveTask, cancelTask });
    render(<TaskLedger active />);
    await openTaskDetail();
    await submitTaskOperation(operation);
    expect(operation === "approve" ? approveTask : cancelTask).toHaveBeenCalledTimes(1);

    const currentDetail: TaskDetail = {
      ...waitingDetail,
      calls: [{ ...waitingDetail.calls[0], name: "fixture.current-client" }],
    };
    const listB = vi.fn<SuperstringApi["listTasks"]>().mockResolvedValue(waitingPage);
    const detailB = vi.fn<SuperstringApi["getTask"]>().mockResolvedValue(currentDetail);
    await act(async () => {
      setupLibrary({ listTasks: listB, getTask: detailB });
    });
    await waitFor(() => expect(detailB).toHaveBeenCalledTimes(1));
    expect(screen.getAllByText("fixture.current-client").length).toBeGreaterThan(0);

    await act(async () => completion.resolve({ ok: true }));
    expect(detailA).toHaveBeenCalledTimes(1);
    expect(listA).toHaveBeenCalledTimes(1);
    expect(detailB).toHaveBeenCalledTimes(1);
    expect(listB).toHaveBeenCalledTimes(1);
    expect(screen.getAllByText("fixture.current-client").length).toBeGreaterThan(0);
    expect(screen.queryByRole("status")).toBeNull();
    expect(operation === "approve" ? approveTask : cancelTask).toHaveBeenCalledTimes(1);
  },
);

it.each(["approve", "cancel"] as const)(
  "keeps a new target's %s busy when the previous API operation rejects late",
  async (operation) => {
    const oldCompletion = deferred<{ ok: true }>();
    const oldApprove = vi.fn<SuperstringApi["approveTask"]>(() => oldCompletion.promise);
    const oldCancel = vi.fn<SuperstringApi["cancelTask"]>(() => oldCompletion.promise);
    const oldGet = vi.fn<SuperstringApi["getTask"]>().mockResolvedValue(waitingDetail);
    setupLibrary({
      listTasks: vi.fn().mockResolvedValue(waitingPage),
      getTask: oldGet,
      approveTask: oldApprove,
      cancelTask: oldCancel,
    });
    render(<TaskLedger active />);
    await openTaskDetail();
    await submitTaskOperation(operation);

    const nextCompletion = deferred<{ ok: true }>();
    const nextApprove = vi.fn<SuperstringApi["approveTask"]>(() => nextCompletion.promise);
    const nextCancel = vi.fn<SuperstringApi["cancelTask"]>(() => nextCompletion.promise);
    const nextDetail: TaskDetail = {
      ...waitingDetail,
      id: A,
      calls: [{ ...waitingDetail.calls[0], name: "fixture.new-target" }],
    };
    const nextGet = vi.fn<SuperstringApi["getTask"]>((id) =>
      Promise.resolve(id === A ? nextDetail : waitingDetail),
    );
    const nextList = vi.fn<SuperstringApi["listTasks"]>().mockResolvedValue({
      ...page,
      items: [nextDetail],
    });
    await act(async () => {
      setupLibrary({
        listTasks: nextList,
        getTask: nextGet,
        approveTask: nextApprove,
        cancelTask: nextCancel,
      });
    });
    await screen.findByRole("button", { name: "关闭面板" });
    fireEvent.click(screen.getByRole("button", { name: "关闭面板" }));
    await openTaskDetail();
    expect(screen.getByText("fixture.new-target")).toBeTruthy();
    await submitTaskOperation(operation);
    expect(operation === "approve" ? nextApprove : nextCancel).toHaveBeenCalledTimes(1);
    const readsBeforeOldFailure = nextGet.mock.calls.length;
    const listsBeforeOldFailure = nextList.mock.calls.length;

    await act(async () => oldCompletion.reject(new Error("old API operation failed")));
    const currentDialog = screen.getByRole("alertdialog");
    expect(currentDialog.getAttribute("aria-busy")).toBe("true");
    expect(screen.queryByText("old API operation failed")).toBeNull();
    const submit = within(currentDialog).getByRole("button", {
      name: operation === "approve" ? "批准这一次" : "确认",
    });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(submit);
    expect(operation === "approve" ? nextApprove : nextCancel).toHaveBeenCalledTimes(1);
    expect(oldGet).toHaveBeenCalledTimes(1);
    expect(nextGet).toHaveBeenCalledTimes(readsBeforeOldFailure);
    expect(nextList).toHaveBeenCalledTimes(listsBeforeOldFailure);

    await act(async () => nextCompletion.resolve({ ok: true }));
    await waitFor(() => expect(nextGet).toHaveBeenCalledTimes(readsBeforeOldFailure + 1));
    expect(nextList).toHaveBeenCalledTimes(listsBeforeOldFailure + 1);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "关闭面板" }));
    expect(await screen.findByRole("status")).toHaveProperty(
      "textContent",
      operation === "approve" ? "已批准这一次调用。" : "已取消。",
    );
  },
);

it("cancels the last pending body consumer on hide and revalidates metadata once on return", async () => {
  const oldBody = deferred<TaskBodyPage>();
  const body = vi
    .fn<SuperstringApi["getTaskBody"]>()
    .mockReturnValueOnce(oldBody.promise)
    .mockResolvedValue(bodyPage("body after return"));
  const list = vi.fn<SuperstringApi["listTasks"]>().mockResolvedValue(waitingPage);
  const detail = vi.fn<SuperstringApi["getTask"]>().mockResolvedValue(waitingDetail);
  setupLibrary({ listTasks: list, getTask: detail, getTaskBody: body });
  render(<TaskLedger active />);
  await openTaskDetail();
  fireEvent.click(screen.getByRole("button", { name: "参数" }));
  await waitFor(() => expect(body).toHaveBeenCalledTimes(1));
  const previous = Object.getOwnPropertyDescriptor(document, "visibilityState");
  try {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    fireEvent(document, new Event("visibilitychange"));
    expect(body.mock.calls[0][5]?.aborted).toBe(true);
    await act(async () => oldBody.resolve(bodyPage("late hidden body")));
    expect(screen.queryByText("late hidden body")).toBeNull();
    expect(list).toHaveBeenCalledTimes(1);
    expect(detail).toHaveBeenCalledTimes(1);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() => expect(detail).toHaveBeenCalledTimes(2));
    expect(list).toHaveBeenCalledTimes(2);
    expect(body).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "参数" }));
    expect(await screen.findByText("body after return")).toBeTruthy();
  } finally {
    if (previous) Object.defineProperty(document, "visibilityState", previous);
    else Reflect.deleteProperty(document, "visibilityState");
  }
});

it.each(["approve", "cancel"] as const)(
  "keeps a current %s failure actionable and retries with the same target",
  async (operation) => {
    const retry = deferred<{ ok: true }>();
    const approve = vi
      .fn<SuperstringApi["approveTask"]>()
      .mockRejectedValueOnce(new Error("current operation conflict"))
      .mockReturnValueOnce(retry.promise);
    const cancel = vi
      .fn<SuperstringApi["cancelTask"]>()
      .mockRejectedValueOnce(new Error("current operation conflict"))
      .mockReturnValueOnce(retry.promise);
    const getTask = vi.fn<SuperstringApi["getTask"]>().mockResolvedValue(waitingDetail);
    const list = vi.fn<SuperstringApi["listTasks"]>().mockResolvedValue(waitingPage);
    setupLibrary({ listTasks: list, getTask, approveTask: approve, cancelTask: cancel });
    render(<TaskLedger active />);
    await openTaskDetail();
    await submitTaskOperation(operation);
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.getAttribute("aria-busy")).toBe("false");
    expect(screen.getAllByText("current operation conflict").length).toBeGreaterThan(0);
    expect(getTask).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledTimes(1);
    const submit = within(dialog).getByRole("button", {
      name: operation === "approve" ? "批准这一次" : "确认",
    });
    expect((submit as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() =>
      expect(operation === "approve" ? approve : cancel).toHaveBeenCalledTimes(2),
    );
    await act(async () => retry.resolve({ ok: true }));
    await waitFor(() => expect(getTask).toHaveBeenCalledTimes(2));
    expect(list).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("current operation conflict")).toBeNull();
  },
);

it("replaces an already read body with the backend's revoked detail projection", async () => {
  const revoked: TaskDetail = {
    ...waitingDetail,
    dataStatus: "revoked",
    calls: [
      {
        ...waitingDetail.calls[0],
        approvalRevision: null,
        argumentsPreview: { ...bodyPage(""), status: "revoked", text: null, total: null },
        resultStatus: "revoked",
      },
    ],
  };
  const getTask = vi
    .fn<SuperstringApi["getTask"]>()
    .mockResolvedValueOnce(waitingDetail)
    .mockResolvedValue(revoked);
  const body = vi
    .fn<SuperstringApi["getTaskBody"]>()
    .mockResolvedValue(bodyPage("read before revoke"));
  setupLibrary({
    listTasks: vi.fn().mockResolvedValue(waitingPage),
    getTask,
    getTaskBody: body,
  });
  render(<TaskLedger active />);
  await openTaskDetail();
  fireEvent.click(screen.getByRole("button", { name: "参数" }));
  expect(await screen.findByText("read before revoke")).toBeTruthy();
  await act(async () => {
    notifyConversationChange({
      event: "conversation_changed",
      conversationId: A,
      seq: 1,
      bindingEpoch: 1,
    });
  });
  expect(await screen.findByText("来源已失效，正文不再显示。")).toBeTruthy();
  expect(screen.queryByText("read before revoke")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "参数" }));
  expect(body).toHaveBeenCalledTimes(1);
});

it("does not revive an approval completion after leaving and returning to the same tasks tab", async () => {
  const old = deferred<{ ok: true }>();
  const current = deferred<{ ok: true }>();
  const approve = vi
    .fn<SuperstringApi["approveTask"]>()
    .mockReturnValueOnce(old.promise)
    .mockReturnValueOnce(current.promise);
  const list = vi.fn<SuperstringApi["listTasks"]>().mockResolvedValue(waitingPage);
  const getTask = vi.fn<SuperstringApi["getTask"]>().mockResolvedValue(waitingDetail);
  setupLibrary({ listTasks: list, getTask, approveTask: approve });
  const view = render(<TaskLedger active />);
  await openTaskDetail();
  await submitTaskOperation("approve");
  view.rerender(<TaskLedger active={false} />);
  view.rerender(<TaskLedger active />);
  await waitFor(() => expect(getTask).toHaveBeenCalledTimes(2));
  await submitTaskOperation("approve");
  expect(approve).toHaveBeenCalledTimes(2);
  await act(async () => old.resolve({ ok: true }));
  expect(screen.getByRole("alertdialog").getAttribute("aria-busy")).toBe("true");
  expect(getTask).toHaveBeenCalledTimes(2);
  expect(list).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("status", { hidden: true })).toBeNull();
  await act(async () => current.resolve({ ok: true }));
  await waitFor(() => expect(getTask).toHaveBeenCalledTimes(3));
  expect(list).toHaveBeenCalledTimes(3);
});

it("reopens cancellation after document hide without inheriting the previous invocation's pending state", async () => {
  const previousCancel = deferred<{ ok: true }>();
  const currentCancel = deferred<{ ok: true }>();
  const cancelTask = vi
    .fn<SuperstringApi["cancelTask"]>()
    .mockReturnValueOnce(previousCancel.promise)
    .mockReturnValueOnce(currentCancel.promise);
  const list = vi.fn<SuperstringApi["listTasks"]>().mockResolvedValue(waitingPage);
  const getTask = vi.fn<SuperstringApi["getTask"]>().mockResolvedValue(waitingDetail);
  setupLibrary({ listTasks: list, getTask, cancelTask });
  render(<TaskLedger active />);
  await openTaskDetail();
  await submitTaskOperation("cancel");
  const firstDialog = screen.getByRole("alertdialog");
  const firstConfirm = within(firstDialog).getByRole("button", { name: "确认" });
  expect((firstConfirm as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(firstConfirm);
  fireEvent(window, new Event("blur"));
  fireEvent(window, new Event("focus"));
  expect(firstDialog.getAttribute("aria-busy")).toBe("true");
  expect(cancelTask).toHaveBeenCalledExactlyOnceWith(D);
  expect(list).toHaveBeenCalledTimes(1);
  expect(getTask).toHaveBeenCalledTimes(1);

  const previousVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
  try {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    fireEvent(document, new Event("visibilitychange"));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() => expect(getTask).toHaveBeenCalledTimes(2));
    expect(list).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "取消任务" }));
    const reopened = await screen.findByRole("alertdialog");
    const confirm = within(reopened).getByRole("button", { name: "确认" });
    const dismiss = within(reopened).getByRole("button", { name: "取消" });
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
    expect((dismiss as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(cancelTask).toHaveBeenCalledTimes(2));
    expect(cancelTask.mock.calls.map((call) => call[0])).toEqual([D, D]);
    expect(reopened.getAttribute("aria-busy")).toBe("true");

    await act(async () => previousCancel.resolve({ ok: true }));
    const currentDialog = screen.getByRole("alertdialog");
    expect(currentDialog.getAttribute("aria-busy")).toBe("true");
    const currentConfirm = within(currentDialog).getByRole("button", { name: "确认" });
    expect((currentConfirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(currentConfirm);
    expect(cancelTask).toHaveBeenCalledTimes(2);
    expect(getTask).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("status", { hidden: true })).toBeNull();

    await act(async () => currentCancel.resolve({ ok: true }));
    await waitFor(() => expect(getTask).toHaveBeenCalledTimes(3));
    expect(list).toHaveBeenCalledTimes(3);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "关闭面板" }));
    expect(await screen.findByRole("status")).toHaveProperty("textContent", "已取消。");
  } finally {
    if (previousVisibility) Object.defineProperty(document, "visibilityState", previousVisibility);
    else Reflect.deleteProperty(document, "visibilityState");
  }
});

it("clears a read body at its natural cap and adopts expired metadata without authorizing the old ticket", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(new Date("2026-10-07T12:00:00.000Z"));
  const live: TaskDetail = {
    ...waitingDetail,
    expiresAt: "2026-10-07T12:00:01.000Z",
  };
  const expired: TaskDetail = {
    ...live,
    status: "failed",
    dataStatus: "expired",
    waitingOrdinal: null,
    waitingReason: null,
    errorCode: "TASK_EXPIRED",
    calls: [
      {
        ...live.calls[0],
        status: "failed",
        approvalRevision: null,
        errorCode: "TASK_EXPIRED",
        argumentsPreview: {
          status: "expired",
          text: null,
          offset: 0,
          total: null,
          nextOffset: null,
        },
        resultStatus: "expired",
      },
    ],
  };
  const getTask = vi
    .fn<SuperstringApi["getTask"]>()
    .mockResolvedValueOnce(live)
    .mockResolvedValue(expired);
  const body = vi
    .fn<SuperstringApi["getTaskBody"]>()
    .mockResolvedValue(bodyPage("body before natural expiry"));
  const approve = vi.fn<SuperstringApi["approveTask"]>();
  const list = vi.fn<SuperstringApi["listTasks"]>().mockResolvedValue({ ...page, items: [live] });
  try {
    setupLibrary({ listTasks: list, getTask, getTaskBody: body, approveTask: approve });
    render(<TaskLedger active />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "详情" }));
    await act(async () => {});
    expect(getTask).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "参数" }));
    await act(async () => {});
    expect(screen.getByText("body before natural expiry")).toBeTruthy();
    expect(body).toHaveBeenCalledExactlyOnceWith(
      D,
      0,
      "arguments",
      0,
      2048,
      expect.any(AbortSignal),
    );
    fireEvent.click(screen.getByRole("button", { name: "核对并批准" }));
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(approve).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1001);
    });
    expect(screen.queryByText("body before natural expiry")).toBeNull();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.queryByRole("button", { name: "批准这一次" })).toBeNull();
    expect(screen.queryByRole("button", { name: "核对并批准" })).toBeNull();
    expect(getTask).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "参数" }));
    expect(body).toHaveBeenCalledTimes(1);
    expect(approve).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(getTask).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenCalledTimes(1);
  } finally {
    cleanup();
    vi.useRealTimers();
  }
});
