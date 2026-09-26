import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type {
  ConversationEventView,
  ConversationSummary,
  Delivery,
} from "../../src/shared/contracts/conversation";
import type { SuperstringApi } from "../../src/web/api";
import { ExternalConversation as ConversationTimeline } from "../../src/web/screens/conversations/ExternalConversation";
import { timelineRows } from "../../src/web/screens/conversations/timeline-projection";
import { useSuperstringStore as store } from "../../src/web/store";

const now = "2026-09-26T00:00:00Z";
const summary = (): ConversationSummary => ({
  id: "bot",
  sourceId: "binding",
  channel: "onebot11",
  topology: "direct",
  agentId: "agent",
  title: "private",
  bindingEpoch: 1,
  participants: [],
  updatedAt: now,
  lastSeq: 0,
  consumedSeq: 0,
});
function setup(client: Partial<SuperstringApi>) {
  store.getState().resetForTests({
    getConversationRuntimeStatus: async () => ({
      pendingWakes: 0,
      activeRuns: 0,
      failedWakes: 0,
      unknownDeliveries: 0,
      nextReadyAt: null,
      lastActivityAt: null,
      connectionPhase: "ready",
      now,
    }),
    ...client,
  } as SuperstringApi);
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const source = { kind: "qq_event", id: "source", revision: "1" };
const observed: ConversationEventView = {
  wake: null,
  conversationId: "bot",
  seq: 1,
  eventKey: "one",
  kind: "inbound",
  source,
  sources: [source],
  occurredAt: now,
  recordedAt: now,
  participant: { id: "person", label: "小林", role: "user" },
  addressing: { reasons: ["private"], mentionIds: [] },
  runId: null,
  outputId: null,
  text: "source text",
  contentState: "active",
  media: [],
  deliveryStatus: null,
  messageStatus: null,
};
const bot: ConversationSummary = {
  ...summary(),
  id: "bot",
  channel: "onebot11",
  title: "小林的私聊",
};
it("media revisions update their parent observation rather than creating fake messages", () => {
  const media = {
    id: "media",
    kind: "image",
    description: "cat",
    availability: "available" as const,
  };
  const revision: ConversationEventView = {
    ...observed,
    seq: 2,
    kind: "media_revision",
    source: { kind: "qq_media", id: "note", revision: "1" },
    media: [media],
  };
  expect(timelineRows([observed, revision])).toEqual([{ ...observed, media: [media] }]);
});

it("keeps only the latest orphan media revision even when it becomes unavailable", () => {
  const first: ConversationEventView = {
    ...observed,
    seq: 2,
    kind: "media_revision",
    source: { kind: "qq_media", id: "note", revision: "1" },
    media: [
      { id: "note", kind: "image", description: "previous description", availability: "available" },
    ],
  };
  const latest: ConversationEventView = {
    ...first,
    seq: 3,
    source: { ...first.source, revision: "2" },
    text: null,
    contentState: "unavailable",
    media: [],
  };
  expect(timelineRows([first, latest])).toEqual([latest]);
});
it("OneBot timeline revalidates expired bodies on refresh and clears projections on blur", async () => {
  const events = vi
    .fn()
    .mockResolvedValueOnce({ items: [observed], nextSeq: 1, hasMore: false })
    .mockResolvedValue({
      items: [{ ...observed, text: null, contentState: "expired" }],
      nextSeq: 1,
      hasMore: false,
    });
  setup({ getConversationEvents: events });
  render(<ConversationTimeline conversation={bot} />);
  expect(await screen.findByText("source text")).toBeTruthy();
  expect(screen.queryByRole("textbox")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "刷新记录" }));
  expect(await screen.findByText("原文已过保留期")).toBeTruthy();
  expect(screen.queryByText("source text")).toBeNull();
  expect(events.mock.calls[0][1]).toEqual({ direction: "latest" });
  expect(events.mock.calls[1][1]).toEqual({ direction: "after", afterSeq: 0 });
  fireEvent.blur(window);
  expect(screen.queryByText("原文已过保留期")).toBeNull();
});
it("unknown text/sticker delivery shows independent receipt facts and offers no resend", async () => {
  const delivery: Delivery = {
    target: null,
    id: "output",
    runId: "run",
    conversationId: "bot",
    ordinal: 0,
    status: "unknown",
    sourceThroughSeq: 1,
    deliverBy: now,
    createdAt: now,
    parts: [
      {
        id: "text",
        ordinal: 0,
        kind: "text",
        status: "confirmed",
        platformMessageId: "platform",
        attemptedAt: now,
        finishedAt: now,
        stickerId: null,
      },
      {
        id: "sticker",
        ordinal: 1,
        kind: "sticker",
        status: "unknown",
        platformMessageId: null,
        attemptedAt: now,
        finishedAt: null,
        stickerId: "sticker-id",
      },
    ],
  };
  setup({
    getConversationEvents: async () => ({
      items: [{ ...observed, kind: "outbound", outputId: "output", deliveryStatus: "unknown" }],
      nextSeq: 1,
      hasMore: false,
    }),
    getDelivery: async () => delivery,
  });
  render(<ConversationTimeline conversation={bot} />);
  const trigger = await screen.findByText("送达详情");
  fireEvent.click(trigger);
  expect((await screen.findByText("platform")).closest("li")?.textContent).toContain("已送达");
  expect(screen.getByText("platform")).toBeTruthy();
  expect(screen.getByText("sticker-id")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /重发|重试|Resend/ })).toBeNull();
});
it("source and output revisions update one row while retaining unrelated observations", () => {
  const revision = {
    ...observed,
    seq: 3,
    source: { ...observed.source, revision: "2" },
    text: "revised",
  };
  const other = {
    ...observed,
    seq: 2,
    eventKey: "other",
    source: { ...observed.source, id: "other" },
  };
  expect(timelineRows([observed, other, revision]).map((row) => [row.seq, row.text])).toEqual([
    [2, "source text"],
    [3, "revised"],
  ]);
  const planned = {
    ...observed,
    seq: 4,
    kind: "delivery" as const,
    outputId: "one-output",
    deliveryStatus: "planned" as const,
  };
  const confirmed = { ...planned, seq: 5, deliveryStatus: "confirmed" as const };
  expect(timelineRows([planned, confirmed])).toEqual([confirmed]);
});

it("shared conversations distinguish same-name members and preserve mention and unavailable reply references", async () => {
  const people = [
    { id: "member-a", label: "小林", role: "member" as const },
    { id: "member-b", label: "小林", role: "member" as const },
  ];
  const item = {
    ...observed,
    participant: people[0],
    addressing: {
      reasons: ["mention" as const, "legacy_addressed" as const],
      mentionIds: ["member-b"],
      replyTo: { sourceId: "expired-platform-message" },
    },
  };
  setup({ getConversationEvents: async () => ({ items: [item], nextSeq: 1, hasMore: false }) });
  render(
    <ConversationTimeline conversation={{ ...bot, topology: "shared", participants: people }} />,
  );
  expect(await screen.findByText("历史记录标记为面向 Agent")).toBeTruthy();
  expect(screen.getAllByText("member-a").length).toBeGreaterThan(0);
  expect(screen.getAllByText("member-b").length).toBeGreaterThan(0);
  expect(screen.getByText("expired-platform-message")).toBeTruthy();
  expect(screen.getByText(/OneBot · 群聊/)).toBeTruthy();
});
it("a wake no-output revision updates one activity and creates no empty message bubble", async () => {
  const pending: ConversationEventView = {
    ...observed,
    seq: 2,
    kind: "wake",
    participant: null,
    text: null,
    contentState: "unavailable",
    wake: { id: "wake", cause: "idle_topic", status: "pending", readyAt: now, errorCode: null },
  };
  const silent: ConversationEventView = {
    ...pending,
    seq: 3,
    wake: { id: "wake", cause: "idle_topic", status: "no_output", readyAt: now, errorCode: null },
  };
  setup({
    getConversationEvents: async () => ({ items: [pending, silent], nextSeq: 3, hasMore: false }),
  });
  const { container } = render(
    <ConversationTimeline conversation={{ ...bot, topology: "shared" }} />,
  );
  expect(await screen.findByText("本次未发言")).toBeTruthy();
  expect(container.querySelectorAll('[data-timeline-key^="wake:"]')).toHaveLength(1);
  expect(container.querySelectorAll('[data-timeline-key^="source:"]')).toHaveLength(0);
  expect(screen.queryByText("原文暂不可用")).toBeNull();
  expect(screen.getByText(/冷场发起/)).toBeTruthy();
});
it("separate group output targets show their own partial and unknown outcomes", async () => {
  const first: Delivery = {
    id: "one",
    runId: "run",
    conversationId: "bot",
    ordinal: 0,
    target: { peerId: "group-peer", participantId: "member-a" },
    status: "failed",
    sourceThroughSeq: 1,
    deliverBy: now,
    createdAt: now,
    parts: [
      {
        id: "text",
        ordinal: 0,
        kind: "text",
        status: "confirmed",
        platformMessageId: "sent-text",
        attemptedAt: now,
        finishedAt: now,
        stickerId: null,
      },
      {
        id: "sticker",
        ordinal: 1,
        kind: "sticker",
        status: "failed",
        platformMessageId: null,
        attemptedAt: now,
        finishedAt: now,
        stickerId: "asset",
      },
    ],
  };
  const second: Delivery = {
    ...first,
    id: "two",
    ordinal: 1,
    target: { peerId: "group-peer", participantId: "member-b" },
    status: "unknown",
    parts: [{ ...first.parts[0], id: "other-text", status: "unknown", platformMessageId: null }],
  };
  setup({
    getConversationEvents: async () => ({
      items: [
        { ...observed, seq: 2, kind: "delivery", outputId: "one", deliveryStatus: "failed" },
        { ...observed, seq: 3, kind: "delivery", outputId: "two", deliveryStatus: "unknown" },
      ],
      nextSeq: 3,
      hasMore: false,
    }),
    getDelivery: async (id) => (id === "one" ? first : second),
  });
  render(<ConversationTimeline conversation={{ ...bot, topology: "shared" }} />);
  const details = await screen.findAllByText("送达详情");
  for (const detail of details) fireEvent.click(detail);
  expect(await screen.findByText("member-a")).toBeTruthy();
  expect(await screen.findByText("member-b")).toBeTruthy();
  expect(screen.getByText("部分内容已送达，请查看各部分结果。")).toBeTruthy();
  expect(screen.getByText("sent-text")).toBeTruthy();
  expect(screen.getAllByText("发送结果待确认").length).toBeGreaterThan(0);
  expect(screen.queryByRole("button", { name: /重发|重试|Resend/ })).toBeNull();
});
