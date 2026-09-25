import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type {
  ConversationEventView,
  ConversationSummary,
  Delivery,
} from "../../src/shared/contracts/conversation";
import type { SuperstringApi } from "../../src/web/api";
import {
  ConversationTimeline,
  timelineRows,
} from "../../src/web/features/conversations/ConversationTimeline";
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
  store.getState().resetForTests(client as SuperstringApi);
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const source = { kind: "qq_event", id: "source", revision: "1" };
const observed: ConversationEventView = {
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
  expect(events.mock.calls[1][1]).toBe(0);
  fireEvent.blur(window);
  expect(screen.queryByText("原文已过保留期")).toBeNull();
});
it("unknown text/sticker delivery shows independent receipt facts and offers no resend", async () => {
  const delivery: Delivery = {
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
  expect(await screen.findByText(/已送达/)).toBeTruthy();
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
