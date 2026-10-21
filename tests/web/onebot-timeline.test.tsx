import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type {
  ConversationEventView,
  ConversationSummary,
  Delivery,
} from "../../src/shared/contracts/conversation";
import type { SuperstringApi } from "../../src/web/api";
import { timelineKey } from "../../src/web/features/conversations/use-timeline-scroll";
import { i18n } from "../../src/web/i18n/runtime";
import { ExternalConversation as ConversationTimeline } from "../../src/web/screens/conversations/ExternalConversation";
import { timelineRows } from "../../src/web/screens/conversations/timeline-projection";
import { useSuperstringStore as store } from "../../src/web/store";
import { render } from "./helpers/render-with-providers";

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
      pendingTasks: 0,
      queuedCount: 0,
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
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
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
it("OneBot timeline revalidates expired bodies and redacts projections only when hidden", async () => {
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
  expect(events.mock.calls[1][1]).toEqual({ direction: "after", afterSeq: 0, limit: 101 });
  fireEvent.blur(window);
  expect(screen.getByText("原文已过保留期")).toBeTruthy();
  expect(events).toHaveBeenCalledTimes(2);
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  fireEvent(document, new Event("visibilitychange"));
  expect(screen.getByText("原文已过保留期")).toBeTruthy();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
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
  expect(
    within(screen.getByRole("tabpanel", { name: i18n.t("workspace.message_history") })).queryByRole(
      "button",
      { name: /重发|重试|Resend/ },
    ),
  ).toBeNull();
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
  for (const detail of details)
    expect(
      within(detail.closest("section") as HTMLElement).queryByRole("button", {
        name: /重发|重试|Resend/,
      }),
    ).toBeNull();
});

it("projects 2000 records + 2000 revisions without dropping sources", () => {
  const baseTime = "2026-10-02T10:00:00Z";
  const records: ConversationEventView[] = [];

  for (let i = 1; i <= 2000; i++) {
    const s = { kind: "qq_event", id: `src-${i}`, revision: "1" };
    records.push({
      wake: null,
      conversationId: "bot",
      seq: i * 2,
      eventKey: `event-${i}`,
      kind: "inbound",
      source: s,
      sources: [s],
      occurredAt: baseTime,
      recordedAt: baseTime,
      participant: { id: `user-${i}`, label: `User ${i}`, role: "user" },
      addressing: {
        reasons: ["private"],
        mentionIds: [],
        replyTo: i > 1 ? { sourceId: `src-${i - 1}` } : undefined,
      },
      runId: null,
      outputId: null,
      text: `message content ${i}`,
      contentState: "active",
      media: [],
      deliveryStatus: null,
      messageStatus: null,
    });
  }

  const revisions: ConversationEventView[] = [];
  for (let i = 1; i <= 2000; i++) {
    const parentId = `src-${i}`;
    revisions.push({
      wake: null,
      conversationId: "bot",
      seq: i * 2 + 1,
      eventKey: `rev-${i}`,
      kind: "media_revision",
      source: { kind: "qq_media", id: `media-src-${i}`, revision: "1" },
      sources: [{ kind: "qq_event", id: parentId, revision: "1" }],
      occurredAt: baseTime,
      recordedAt: baseTime,
      participant: null,
      addressing: { reasons: [], mentionIds: [] },
      runId: null,
      outputId: null,
      text: null,
      contentState: "active",
      media: [
        {
          id: `img-${i}`,
          kind: "image",
          description: `attachment ${i}`,
          availability: "available",
        },
      ],
      deliveryStatus: null,
      messageStatus: null,
    });
  }

  // Interleave records and revisions
  const allEvents: ConversationEventView[] = [];
  for (let i = 0; i < 2000; i++) {
    allEvents.push(records[i]);
    allEvents.push(revisions[i]);
  }

  const projected = timelineRows(allEvents);

  expect(projected.length).toBe(2000);
  // Verify strict ordering and source identity
  expect(projected[0].seq).toBe(2);
  expect(projected[0].source.id).toBe("src-1");
  expect(projected[1999].seq).toBe(4000);
  expect(projected[1999].source.id).toBe("src-2000");

  // Verify revisions decorated parent correctly
  expect(projected[0].media).toHaveLength(1);
  expect(projected[0].media[0].id).toBe("img-1");
  expect(projected[1999].media).toHaveLength(1);
  expect(projected[1999].media[0].id).toBe("img-2000");
});

it("correctly resolves quotes with bySourceMap and handles duplicate quotes and unknown references", () => {
  const quoteSource = { kind: "qq_event", id: "target-msg", revision: "1" };
  const targetEvent: ConversationEventView = {
    ...observed,
    seq: 10,
    source: quoteSource,
    sources: [quoteSource],
    text: "target message content",
  };

  const quotingEvent: ConversationEventView = {
    ...observed,
    seq: 11,
    source: { kind: "qq_event", id: "quoting-msg-1", revision: "1" },
    sources: [{ kind: "qq_event", id: "quoting-msg-1", revision: "1" }],
    addressing: { reasons: [], mentionIds: [], replyTo: { sourceId: "target-msg" } },
    text: "reply 1",
  };

  const duplicateQuotingEvent: ConversationEventView = {
    ...observed,
    seq: 12,
    source: { kind: "qq_event", id: "quoting-msg-2", revision: "1" },
    sources: [{ kind: "qq_event", id: "quoting-msg-2", revision: "1" }],
    addressing: { reasons: [], mentionIds: [], replyTo: { sourceId: "target-msg" } },
    text: "reply 2",
  };

  const unknownRefEvent: ConversationEventView = {
    ...observed,
    seq: 13,
    source: { kind: "qq_event", id: "quoting-msg-3", revision: "1" },
    sources: [{ kind: "qq_event", id: "quoting-msg-3", revision: "1" }],
    addressing: { reasons: [], mentionIds: [], replyTo: { sourceId: "non-existent-source" } },
    text: "reply to unknown",
  };

  const rows = timelineRows([targetEvent, quotingEvent, duplicateQuotingEvent, unknownRefEvent]);
  const bySourceMap = new Map<string, ConversationEventView>();
  for (const row of rows) {
    if (row.source.id && !bySourceMap.has(row.source.id)) {
      bySourceMap.set(row.source.id, row);
    }
    for (const ref of row.sources) {
      if (ref.id && !bySourceMap.has(ref.id)) {
        bySourceMap.set(ref.id, row);
      }
    }
  }

  // Exact resolution assertions
  expect(bySourceMap.get("target-msg")).toBe(rows[0]);
  expect(bySourceMap.get("quoting-msg-1")).toBe(rows[1]);
  expect(bySourceMap.get("quoting-msg-2")).toBe(rows[2]);
  expect(bySourceMap.get("non-existent-source")).toBeUndefined();

  // Both quoting events reference the exact same target event object
  const replyTarget1 = quotingEvent.addressing.replyTo?.sourceId;
  const replyTarget2 = duplicateQuotingEvent.addressing.replyTo?.sourceId;
  expect(replyTarget1).toBeDefined();
  expect(replyTarget2).toBeDefined();
  if (replyTarget1) expect(bySourceMap.get(replyTarget1)).toBe(targetEvent);
  if (replyTarget2) expect(bySourceMap.get(replyTarget2)).toBe(targetEvent);
});

it("renders stale delivery causes and legacy neutral, ignores reasons on non-stale, and offers no resend", async () => {
  await i18n.changeLanguage("zh-CN");
  const testDelivery: Delivery = {
    id: "out-stale",
    runId: "run-stale",
    target: { peerId: "peer", participantId: "member" },
    conversationId: "bot",
    ordinal: 0,
    status: "stale",
    staleReason: "DELIVERY_TTL_EXPIRED",
    sourceThroughSeq: 1,
    deliverBy: now,
    createdAt: now,
    parts: [
      {
        id: "p1",
        ordinal: 0,
        kind: "text",
        status: "stale",
        platformMessageId: null,
        attemptedAt: now,
        finishedAt: now,
        stickerId: null,
      },
    ],
  };

  const baseObserved: ConversationEventView = {
    ...observed,
    seq: 10,
    eventKey: "e-stale-ttl",
    outputId: "out-stale",
    text: "Stale reply",
    deliveryStatus: "stale",
    deliveryStaleReason: "DELIVERY_TTL_EXPIRED",
  };

  const convChangedEvent = {
    ...baseObserved,
    seq: 11,
    eventKey: "e-stale-conv",
    outputId: "out-conv",
    deliveryStaleReason: "CONVERSATION_CHANGED" as const,
  };

  const authChangedEvent = {
    ...baseObserved,
    seq: 12,
    eventKey: "e-stale-auth",
    outputId: "out-auth",
    deliveryStaleReason: "DELIVERY_AUTHORITY_CHANGED" as const,
  };

  const sourceExpiredEvent = {
    ...baseObserved,
    seq: 13,
    eventKey: "e-stale-src",
    outputId: "out-src",
    deliveryStaleReason: "SOURCE_EXPIRED" as const,
  };

  const legacyNullEvent = {
    ...baseObserved,
    seq: 14,
    eventKey: "e-stale-legacy",
    outputId: "out-legacy",
    deliveryStaleReason: null,
  };

  const nonStaleWithReasonEvent = {
    ...baseObserved,
    seq: 15,
    eventKey: "e-confirmed",
    outputId: "out-confirmed",
    deliveryStatus: "confirmed" as const,
    deliveryStaleReason: "DELIVERY_AUTHORITY_CHANGED" as const,
  };

  setup({
    getConversationEvents: async () => ({
      items: [
        baseObserved,
        convChangedEvent,
        authChangedEvent,
        sourceExpiredEvent,
        legacyNullEvent,
        nonStaleWithReasonEvent,
      ],
      nextSeq: 16,
      hasMore: false,
    }),
    getDelivery: async () => testDelivery,
  });

  render(<ConversationTimeline conversation={summary()} />);

  // In zh-CN
  expect(await screen.findByText("发送超时")).toBeTruthy();
  expect(screen.getByText("对话已有新进展")).toBeTruthy();
  expect(screen.getByText("发送条件变化")).toBeTruthy();
  expect(screen.getByText("原内容保留期已到")).toBeTruthy();
  expect(screen.getByText("回复已失效")).toBeTruthy();
  // Non-stale status ignores reason: confirmed remains "已送达"
  expect(screen.getByText("已送达")).toBeTruthy();
  // No resend button
  expect(
    within(screen.getByRole("tabpanel", { name: i18n.t("workspace.message_history") })).queryByRole(
      "button",
      { name: /重发|重试|Resend/ },
    ),
  ).toBeNull();

  // Test en
  await i18n.changeLanguage("en");
  expect(await screen.findByText("Delivery timeout")).toBeTruthy();
  expect(screen.getByText("New conversation updates")).toBeTruthy();
  expect(screen.getByText("Delivery conditions changed")).toBeTruthy();
  expect(screen.getByText("Content retention expiration")).toBeTruthy();
  expect(screen.getByText("Reply no longer valid")).toBeTruthy();
  expect(screen.getByText("Delivered")).toBeTruthy();
  expect(
    within(screen.getByRole("tabpanel", { name: i18n.t("workspace.message_history") })).queryByRole(
      "button",
      { name: /重发|重试|Resend/ },
    ),
  ).toBeNull();

  // Reset to zh-CN
  await i18n.changeLanguage("zh-CN");
});

it("primary input+wake+planned+confirmed project to 1 row and update same key while keeping user text", () => {
  const inputEvent: ConversationEventView & { activityId?: string } = {
    ...observed,
    seq: 10,
    eventKey: "e-input",
    kind: "inbound",
    text: "用户输入的问题",
    activityId: "canonical-task-1",
  };
  const wakeEvent: ConversationEventView & { activityId?: string } = {
    ...observed,
    seq: 11,
    eventKey: "e-wake",
    kind: "wake",
    text: null,
    participant: null,
    activityId: "canonical-task-1",
    wake: {
      id: "wake-1",
      cause: "direct_reply",
      status: "completed",
      readyAt: now,
      errorCode: null,
    },
    task: {
      id: "canonical-task-1",
      status: "running",
      errorCode: null,
    },
  };
  const plannedEvent: ConversationEventView & { activityId?: string } = {
    ...observed,
    seq: 12,
    eventKey: "e-deliv-1",
    kind: "delivery",
    outputId: "out-1",
    deliveryStatus: "planned",
    text: null,
    activityId: "canonical-task-1",
  };
  const confirmedEvent: ConversationEventView & { activityId?: string } = {
    ...observed,
    seq: 13,
    eventKey: "e-deliv-1-conf",
    kind: "delivery",
    outputId: "out-1",
    deliveryStatus: "confirmed",
    text: "助手的完整回答",
    activityId: "canonical-task-1",
    task: {
      id: "canonical-task-1",
      status: "completed",
      errorCode: null,
    },
  };

  const rows = timelineRows([inputEvent, wakeEvent, plannedEvent, confirmedEvent]);
  expect(rows).toHaveLength(1);
  const row = rows[0];
  expect(row.activityId).toBe("canonical-task-1");
  expect(timelineKey(row)).toBe("activity:canonical-task-1");
  // Representative is the inbound event: preserves user text
  expect(row.kind).toBe("inbound");
  expect(row.text).toBe("用户输入的问题");
  // Server-authoritative latest task status
  expect(row.task?.status).toBe("completed");
  // Activity events contain the wake and latest confirmed delivery, not row itself
  expect(row.activityEvents).toBeDefined();
  expect(row.activityEvents?.length).toBe(2);
  expect(row.activityEvents?.some((e) => e === row)).toBe(false);
  const replyEvent = row.activityEvents?.find((e) => e.outputId === "out-1");
  expect(replyEvent?.deliveryStatus).toBe("confirmed");
  expect(replyEvent?.text).toBe("助手的完整回答");
});

it("preserves separate delivery recipients under the same activity without collapsing into fake confirmation", () => {
  const inputEvent: ConversationEventView & { activityId?: string } = {
    ...observed,
    seq: 20,
    kind: "inbound",
    text: "群发通知",
    activityId: "task-broadcast",
  };
  const delivA: ConversationEventView & { activityId?: string } = {
    ...observed,
    seq: 21,
    kind: "delivery",
    outputId: "out-user-a",
    deliveryStatus: "confirmed",
    participant: { id: "user-a", label: "用户A", role: "member" },
    activityId: "task-broadcast",
  };
  const delivB: ConversationEventView & { activityId?: string } = {
    ...observed,
    seq: 22,
    kind: "delivery",
    outputId: "out-user-b",
    deliveryStatus: "failed",
    participant: { id: "user-b", label: "用户B", role: "member" },
    activityId: "task-broadcast",
  };

  const rows = timelineRows([inputEvent, delivA, delivB]);
  expect(rows).toHaveLength(1);
  const row = rows[0];
  expect(row.activityEvents).toHaveLength(2);
  const a = row.activityEvents?.find((e) => e.outputId === "out-user-a");
  const b = row.activityEvents?.find((e) => e.outputId === "out-user-b");
  expect(a?.deliveryStatus).toBe("confirmed");
  expect(b?.deliveryStatus).toBe("failed");
});

it("keeps different activities and same-sender independent tasks as separate rows", () => {
  const task1Event: ConversationEventView & { activityId?: string } = {
    ...observed,
    seq: 30,
    kind: "inbound",
    text: "@bot 任务一",
    activityId: "task-alpha",
  };
  const task2Event: ConversationEventView & { activityId?: string } = {
    ...observed,
    seq: 31,
    kind: "inbound",
    text: "@bot 任务二",
    activityId: "task-beta",
  };

  const rows = timelineRows([task1Event, task2Event]);
  expect(rows).toHaveLength(2);
  expect(rows[0].activityId).toBe("task-alpha");
  expect(rows[1].activityId).toBe("task-beta");
});

it("maintains stable key when older history loads parent inbound to join orphan delivery", () => {
  const orphanDelivery: ConversationEventView & { activityId?: string } = {
    ...observed,
    seq: 100,
    kind: "delivery",
    outputId: "orphan-out",
    deliveryStatus: "confirmed",
    activityId: "chain-history",
  };

  // Page 1: only delivery loaded
  const initialRows = timelineRows([orphanDelivery]);
  expect(initialRows).toHaveLength(1);
  expect(timelineKey(initialRows[0])).toBe("activity:chain-history");

  // Page 2: earlier inbound loaded
  const loadedInbound: ConversationEventView & { activityId?: string } = {
    ...observed,
    seq: 50,
    kind: "inbound",
    text: "历史原始输入",
    activityId: "chain-history",
  };

  const mergedRows = timelineRows([loadedInbound, orphanDelivery]);
  expect(mergedRows).toHaveLength(1);
  // Key remains stable for anchor matching
  expect(timelineKey(mergedRows[0])).toBe("activity:chain-history");
  // Representative now smoothly promotes to inbound
  expect(mergedRows[0].seq).toBe(50);
  expect(mergedRows[0].text).toBe("历史原始输入");
});
