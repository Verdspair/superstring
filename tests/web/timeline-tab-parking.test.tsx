import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type {
  ConversationEventView,
  ConversationSummary,
} from "../../src/shared/contracts/conversation";
import { api, type SuperstringApi } from "../../src/web/api";
import { timelineKey } from "../../src/web/features/conversations/use-timeline-scroll";
import { ExternalConversation as ConversationTimeline } from "../../src/web/screens/conversations/ExternalConversation";
import { useSuperstringStore as store } from "../../src/web/store";

const at = "2026-09-26T00:00:00Z";
const conversation: ConversationSummary = {
  id: "bot",
  sourceId: "binding",
  channel: "onebot11",
  topology: "direct",
  agentId: "agent",
  title: "private",
  bindingEpoch: 1,
  participants: [],
  updatedAt: at,
  lastSeq: 205,
  consumedSeq: 205,
};
function row(seq: number): ConversationEventView {
  const source = { kind: "qq_event", id: String(seq), revision: "1" };
  return {
    conversationId: "bot",
    seq,
    eventKey: String(seq),
    kind: "inbound",
    source,
    sources: [source],
    occurredAt: at,
    recordedAt: at,
    participant: { id: "member", label: "Member", role: "user" },
    addressing: { reasons: [], mentionIds: [] },
    runId: null,
    outputId: null,
    wake: null,
    text: `message-${seq}`,
    messageStatus: null,
    contentState: "active",
    media: [],
    deliveryStatus: null,
  };
}
function setup(events: SuperstringApi["getConversationEvents"]) {
  store.getState().resetForTests({
    ...api,
    getConversationEvents: events,
    getConversationRuntimeStatus: async () => ({
      pendingWakes: 0,
      activeRuns: 0,
      failedWakes: 0,
      unknownDeliveries: 0,
      nextReadyAt: null,
      lastActivityAt: null,
      connectionPhase: "ready",
      now: at,
    }),
  } as SuperstringApi);
}
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function viewportOf(scrollHeight: number, clientHeight: number) {
  const viewport = screen.getByRole("tabpanel", { name: "消息记录" });
  Object.defineProperties(viewport, {
    scrollHeight: { value: scrollHeight, configurable: true },
    clientHeight: { value: clientHeight, configurable: true },
  });
  return viewport;
}

it("revalidates every five seconds while visible and stops reading when another tab hides it", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  try {
    const events = vi
      .fn()
      .mockResolvedValueOnce({ items: [row(201)], nextSeq: 201, hasMore: false })
      .mockResolvedValue({ items: [row(201), row(202)], nextSeq: 202, hasMore: false });
    setup(events);
    const view = render(<ConversationTimeline conversation={conversation} active />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText("message-201")).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(screen.getByText("message-202")).toBeTruthy();
    expect(events).toHaveBeenCalledTimes(2);
    view.rerender(<ConversationTimeline conversation={conversation} active={false} />);
    expect(screen.queryByText("message-202")).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20000);
    });
    expect(events).toHaveBeenCalledTimes(2);
    view.rerender(<ConversationTimeline conversation={conversation} active />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText("message-202")).toBeTruthy();
    expect(events).toHaveBeenCalledTimes(3);
  } finally {
    vi.useRealTimers();
  }
});

it("restores the parked scroll position after returning to the messages tab", async () => {
  const events = vi
    .fn()
    .mockResolvedValueOnce({ items: [row(201), row(202)], nextSeq: 202, hasMore: false })
    .mockResolvedValue({ items: [row(201), row(202), row(203)], nextSeq: 203, hasMore: false });
  setup(events);
  const view = render(<ConversationTimeline conversation={conversation} active />);
  await screen.findByText("message-201");
  const viewport = viewportOf(1600, 400);
  viewport.scrollTop = 300;
  fireEvent.scroll(viewport);
  view.rerender(<ConversationTimeline conversation={conversation} active={false} />);
  expect(screen.queryByText("message-201")).toBeNull();
  // display:none 的容器读不到滚动位置，只能靠隐藏前保存的元数据恢复。
  viewport.scrollTop = 0;
  view.rerender(<ConversationTimeline conversation={conversation} active />);
  expect(await screen.findByText("message-203")).toBeTruthy();
  expect(viewport.scrollTop).toBe(300);
});

it("keeps the parked key and offset when a fresh re-read revokes a body", async () => {
  const rects = new Map<string, { top: number; bottom: number }>();
  const original = Element.prototype.getBoundingClientRect;
  const geometry = vi.spyOn(Element.prototype, "getBoundingClientRect");
  geometry.mockImplementation(function (this: Element) {
    const key = (this as HTMLElement).dataset?.timelineKey;
    const rect = key ? rects.get(key) : undefined;
    return rect ? ({ ...rect } as DOMRect) : original.call(this);
  });
  const events = vi
    .fn()
    .mockResolvedValueOnce({ items: [row(201), row(202)], nextSeq: 202, hasMore: false })
    .mockResolvedValue({
      items: [row(201), { ...row(202), text: null, contentState: "revoked" }, row(203)],
      nextSeq: 203,
      hasMore: false,
    });
  setup(events);
  const view = render(<ConversationTimeline conversation={conversation} active />);
  await screen.findByText("message-202");
  const viewport = viewportOf(1600, 400);
  rects.set(timelineKey(row(201)), { top: 40, bottom: 80 });
  viewport.scrollTop = 300;
  fireEvent.scroll(viewport);
  view.rerender(<ConversationTimeline conversation={conversation} active={false} />);
  viewport.scrollTop = 0;
  rects.set(timelineKey(row(201)), { top: 140, bottom: 180 });
  view.rerender(<ConversationTimeline conversation={conversation} active />);
  expect(await screen.findByText("原文已撤权或删除")).toBeTruthy();
  expect(screen.queryByText("message-202")).toBeNull();
  expect(viewport.scrollTop).toBe(100);
});

it("shows unread instead of pulling the reader down when hidden messages arrive", async () => {
  const events = vi
    .fn()
    .mockResolvedValueOnce({ items: [row(201), row(202)], nextSeq: 202, hasMore: false })
    .mockResolvedValue({ items: [row(201), row(202), row(205)], nextSeq: 205, hasMore: false });
  setup(events);
  const view = render(<ConversationTimeline conversation={conversation} active />);
  await screen.findByText("message-202");
  const viewport = viewportOf(1600, 400);
  viewport.scrollTop = 300;
  fireEvent.scroll(viewport);
  view.rerender(<ConversationTimeline conversation={conversation} active={false} />);
  viewport.scrollTop = 0;
  view.rerender(<ConversationTimeline conversation={conversation} active />);
  expect(await screen.findByText("message-205")).toBeTruthy();
  expect(viewport.scrollTop).toBe(300);
  expect(screen.getByRole("button", { name: "1 条新消息 · 回到最新" })).toBeTruthy();
});

it("sticks to the latest when the reader was following before the switch", async () => {
  const events = vi
    .fn()
    .mockResolvedValueOnce({ items: [row(201), row(202)], nextSeq: 202, hasMore: false })
    .mockResolvedValue({ items: [row(201), row(202), row(203)], nextSeq: 203, hasMore: false });
  setup(events);
  const view = render(<ConversationTimeline conversation={conversation} active />);
  await screen.findByText("message-202");
  const viewport = viewportOf(1600, 400);
  viewport.scrollTop = 1200;
  fireEvent.scroll(viewport);
  view.rerender(<ConversationTimeline conversation={conversation} active={false} />);
  viewport.scrollTop = 0;
  view.rerender(<ConversationTimeline conversation={conversation} active />);
  expect(await screen.findByText("message-203")).toBeTruthy();
  expect(viewport.scrollTop).toBe(1600);
  expect(screen.queryByRole("button", { name: /回到最新/ })).toBeNull();
});

it("keeps the parked position and shows no protected body when the re-read fails or returns empty", async () => {
  let fail!: (reason: Error) => void;
  const events = vi
    .fn()
    .mockResolvedValueOnce({ items: [row(201), row(202)], nextSeq: 202, hasMore: false })
    .mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    )
    .mockResolvedValueOnce({ items: [], nextSeq: 0, hasMore: false });
  setup(events);
  const view = render(<ConversationTimeline conversation={conversation} active />);
  await screen.findByText("message-201");
  const viewport = viewportOf(1600, 400);
  viewport.scrollTop = 300;
  fireEvent.scroll(viewport);
  view.rerender(<ConversationTimeline conversation={conversation} active={false} />);
  viewport.scrollTop = 0;
  view.rerender(<ConversationTimeline conversation={conversation} active />);
  // 回到页签但授权正文尚未到位：旧正文不得闪现。
  expect(screen.queryByText("message-201")).toBeNull();
  await act(async () => {
    fail(new Error("Access revoked"));
  });
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.queryByText("message-201")).toBeNull();
  expect(viewport.scrollTop).toBe(300);
  fireEvent.click(screen.getByRole("button", { name: "刷新记录" }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(screen.queryByText("message-201")).toBeNull();
  expect(viewport.scrollTop).toBe(300);
});
