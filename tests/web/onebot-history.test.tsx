import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  ConversationEventView,
  ConversationSummary,
} from "../../src/shared/contracts/conversation";
import { api, type SuperstringApi } from "../../src/web/api";
import { ConversationTimeline } from "../../src/web/features/conversations/ConversationTimeline";
import { useSuperstringStore as store } from "../../src/web/store";

const at = "2026-09-26T00:00:00Z";
const conversation: ConversationSummary = {
  id: "bot",
  sourceId: "binding",
  channel: "onebot11",
  topology: "shared",
  agentId: "agent",
  title: "group",
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
    participant: { id: "member", label: "Member", role: "member" },
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
beforeEach(() => vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] }));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
it("opens the latest page, loads older above, and revalidates every loaded page including source expiry", async () => {
  const events = vi
    .fn()
    .mockResolvedValueOnce({
      items: [row(201), row(205)],
      nextSeq: 205,
      firstSeq: 201,
      hasMore: true,
    })
    .mockResolvedValueOnce({
      items: [row(100), row(200)],
      nextSeq: 200,
      firstSeq: 100,
      hasMore: true,
    })
    .mockResolvedValueOnce({
      items: [{ ...row(100), text: null, contentState: "expired" }, row(200)],
      nextSeq: 200,
      hasMore: true,
    })
    .mockResolvedValueOnce({ items: [row(201), row(205), row(206)], nextSeq: 206, hasMore: false });
  setup(events);
  render(<ConversationTimeline conversation={conversation} />);
  await screen.findByText("message-205");
  expect(events.mock.calls[0][1]).toEqual({ direction: "latest" });
  fireEvent.click(screen.getByRole("button", { name: "加载更早记录" }));
  await screen.findByText("message-100");
  expect(events.mock.calls[1][1]).toEqual({ direction: "before", beforeSeq: 201 });
  expect(screen.getAllByText(/message-/).map((node) => node.textContent)).toEqual([
    "message-100",
    "message-200",
    "message-201",
    "message-205",
  ]);
  fireEvent.click(screen.getByRole("button", { name: "刷新记录" }));
  await screen.findByText("message-206");
  expect(events.mock.calls[2][1]).toEqual({ direction: "after", afterSeq: 99 });
  expect(events.mock.calls[3][1]).toEqual({ direction: "after", afterSeq: 200 });
  expect(screen.queryByText("message-100")).toBeNull();
  expect(screen.getByText("原文已过保留期")).toBeTruthy();
  expect(screen.getByRole("button", { name: "加载更早记录" })).toBeTruthy();
});
it("a late response from an unmounted conversation cannot populate the next one", async () => {
  let resolve!: (page: {
    items: ConversationEventView[];
    nextSeq: number;
    hasMore: boolean;
  }) => void;
  const events = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    )
    .mockResolvedValue({ items: [row(300)], nextSeq: 300, hasMore: false });
  setup(events);
  const view = render(<ConversationTimeline key="old" conversation={conversation} />);
  view.rerender(<ConversationTimeline key="new" conversation={{ ...conversation, id: "other" }} />);
  await screen.findByText("message-300");
  await act(async () => resolve({ items: [row(1)], nextSeq: 1, hasMore: false }));
  expect(screen.queryByText("message-1")).toBeNull();
  expect(events.mock.calls[0][2].aborted).toBe(true);
});
it("refresh does not steal reading position and the latest button resumes following", async () => {
  const events = vi
    .fn()
    .mockResolvedValueOnce({ items: [row(201)], nextSeq: 201, hasMore: false })
    .mockResolvedValue({ items: [row(201), row(202)], nextSeq: 202, hasMore: false });
  setup(events);
  render(<ConversationTimeline conversation={conversation} />);
  await screen.findByText("message-201");
  const viewport = screen.getByRole("tabpanel", { name: "消息记录" });
  Object.defineProperties(viewport, {
    scrollHeight: { value: 1400, configurable: true },
    clientHeight: { value: 400, configurable: true },
  });
  viewport.scrollTop = 200;
  fireEvent.scroll(viewport);
  fireEvent.click(screen.getByRole("button", { name: "刷新记录" }));
  await screen.findByText("message-202");
  expect(viewport.scrollTop).toBe(200);
  const latest = screen.getByRole("button", { name: "1 条新消息 · 回到最新" });
  fireEvent.click(latest);
  await waitFor(() => expect(viewport.scrollTop).toBe(1400));
  expect(screen.queryByRole("button", { name: /回到最新/ })).toBeNull();
});
it("prepending earlier pages preserves the first visible source offset", async () => {
  const events = vi
    .fn()
    .mockResolvedValueOnce({ items: [row(201)], nextSeq: 201, hasMore: true })
    .mockResolvedValueOnce({ items: [row(100)], nextSeq: 100, hasMore: false });
  setup(events);
  render(<ConversationTimeline conversation={conversation} />);
  await screen.findByText("message-201");
  const viewport = screen.getByRole("tabpanel", { name: "消息记录" });
  Object.defineProperties(viewport, {
    scrollHeight: { value: 1400, configurable: true },
    clientHeight: { value: 400, configurable: true },
  });
  viewport.scrollTop = 100;
  fireEvent.scroll(viewport);
  const current = screen.getByText("message-201").closest("li");
  if (!current) throw new Error("Expected a message row");
  vi.spyOn(current, "getBoundingClientRect").mockImplementation(
    () => ({ top: screen.queryByText("message-100") ? 420 : 20, bottom: 600 }) as DOMRect,
  );
  fireEvent.click(screen.getByRole("button", { name: "加载更早记录" }));
  await screen.findByText("message-100");
  expect(viewport.scrollTop).toBe(500);
});
it("restores the source anchor after clearing bodies in a blurred window", async () => {
  const events = vi
    .fn()
    .mockResolvedValue({ items: [row(201), row(202)], nextSeq: 202, hasMore: false });
  setup(events);
  render(<ConversationTimeline conversation={conversation} />);
  await screen.findByText("message-201");
  const viewport = screen.getByRole("tabpanel", { name: "消息记录" });
  Object.defineProperties(viewport, {
    scrollHeight: { value: 1400, configurable: true },
    clientHeight: { value: 400, configurable: true },
  });
  viewport.scrollTop = 200;
  fireEvent.scroll(viewport);
  fireEvent.blur(window);
  expect(screen.queryByText("message-201")).toBeNull();
  viewport.scrollTop = 0;
  fireEvent.scroll(viewport);
  fireEvent.focus(window);
  await screen.findByText("message-201");
  expect(viewport.scrollTop).toBe(200);
  expect(events.mock.calls[1][1]).toEqual({ direction: "after", afterSeq: 200 });
});

it("Home and End scroll the reading region without intercepting nested controls", async () => {
  setup(vi.fn().mockResolvedValue({ items: [row(201)], nextSeq: 201, hasMore: false }));
  render(<ConversationTimeline conversation={conversation} />);
  await screen.findByText("message-201");
  const viewport = screen.getByRole("tabpanel", { name: "消息记录" });
  Object.defineProperties(viewport, {
    scrollHeight: { value: 1400 },
    clientHeight: { value: 400 },
  });
  viewport.scrollTop = 200;
  fireEvent.keyDown(viewport, { key: "End" });
  expect(viewport.scrollTop).toBe(1400);
  fireEvent.keyDown(viewport, { key: "Home" });
  expect(viewport.scrollTop).toBe(0);
  fireEvent.keyDown(screen.getByText("会话来源与参与者"), { key: "End" });
  expect(viewport.scrollTop).toBe(0);
});

it("shows an orphan media revision on the latest page, merges its older parent, and revalidates expiry", async () => {
  const revision: ConversationEventView = {
    ...row(205),
    kind: "media_revision",
    source: { kind: "qq_media", id: "image-note", revision: "2" },
    sources: [{ kind: "qq_event", id: "100", revision: "1" }],
    participant: null,
    text: "Authorized image description",
    media: [
      {
        id: "image-note",
        kind: "image",
        description: "Authorized image description",
        availability: "available",
      },
    ],
  };
  const events = vi
    .fn()
    .mockResolvedValueOnce({ items: [revision], nextSeq: 205, hasMore: true })
    .mockResolvedValueOnce({ items: [row(100)], nextSeq: 100, hasMore: false })
    .mockResolvedValueOnce({
      items: [
        { ...row(100), text: null, contentState: "expired" },
        { ...revision, text: null, media: [], contentState: "expired" },
      ],
      nextSeq: 205,
      hasMore: false,
    });
  setup(events);
  render(<ConversationTimeline conversation={conversation} />);
  await screen.findByText("媒体理解更新");
  expect(screen.getAllByText("Authorized image description")).toHaveLength(1);
  expect(screen.getByText("关联消息尚未加载；此记录为媒体理解更新。")).toBeTruthy();
  expect(screen.queryByText("此会话暂无消息记录。")).toBeNull();
  const viewport = screen.getByRole("tabpanel", { name: "消息记录" });
  Object.defineProperties(viewport, {
    scrollHeight: { get: () => (screen.queryByText("message-100") ? 1700 : 1400) },
    clientHeight: { value: 400 },
  });
  viewport.scrollTop = 200;
  fireEvent.scroll(viewport);
  const orphan = screen.getByText("媒体理解更新").closest("li");
  if (!orphan) throw new Error("Expected standalone media revision");
  vi.spyOn(orphan, "getBoundingClientRect").mockReturnValue({ top: 20, bottom: 120 } as DOMRect);
  fireEvent.click(screen.getByRole("button", { name: "加载更早记录" }));
  await screen.findByText("message-100");
  expect(orphan.isConnected).toBe(false);
  expect(viewport.scrollTop).toBe(500);
  expect(screen.queryByText("媒体理解更新")).toBeNull();
  expect(screen.getAllByText("Authorized image description")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "刷新记录" }));
  await screen.findByText("原文已过保留期");
  expect(screen.queryByText("Authorized image description")).toBeNull();
});
