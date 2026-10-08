import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { TaskList, TaskSummary } from "../../src/shared/contracts/agent-task";
import type { SuperstringApi } from "../../src/web/api";
import { TaskLedger } from "../../src/web/screens/runs/task-ledger";
import {
  notifyConversationChange,
  resetConversationChangesForTests,
} from "../../src/web/services/conversation-changes";
import { A, D, setupLibrary } from "./helpers/library-fixture";

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
