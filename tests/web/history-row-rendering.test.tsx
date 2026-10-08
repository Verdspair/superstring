import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type {
  ConversationEventView,
  ConversationSummary,
} from "../../src/shared/contracts/conversation";
import { api } from "../../src/web/api";
import { selectLocale } from "../../src/web/i18n";
import { ExternalConversation } from "../../src/web/screens/conversations/ExternalConversation";
import { useSuperstringStore as store } from "../../src/web/store";

const now = "2026-10-08T00:00:00Z";
const conversation: ConversationSummary = {
  id: "history",
  sourceId: "binding",
  channel: "onebot11",
  topology: "direct",
  agentId: "agent",
  title: "History",
  bindingEpoch: 1,
  participants: [],
  updatedAt: now,
  lastSeq: 0,
  consumedSeq: 0,
};
const event = (seq: number): ConversationEventView => ({
  seq,
  eventKey: `event-${seq}`,
  conversationId: "history",
  kind: "inbound",
  source: { kind: "qq_event", id: `source-${seq}`, revision: "1" },
  sources: [{ kind: "qq_event", id: `source-${seq}`, revision: "1" }],
  occurredAt: now,
  recordedAt: now,
  participant: { id: "user", label: "User", role: "user" },
  addressing: { reasons: [], mentionIds: [] },
  runId: null,
  outputId: null,
  text: `message-${seq}`,
  contentState: "active",
  media: [],
  deliveryStatus: null,
  messageStatus: null,
  wake: null,
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it("does not render unchanged message rows when the history collection grows", async () => {
  selectLocale("en");
  const items = Array.from({ length: 100 }, (_, i) => event(i + 1));
  const read = vi
    .fn()
    .mockResolvedValueOnce({ items, nextSeq: 100, hasMore: false })
    .mockImplementation(async () =>
      structuredClone({ items: [...items, event(101)], nextSeq: 101, hasMore: false }),
    );
  store.getState().resetForTests({ ...api, getConversationEvents: read });
  render(<ExternalConversation conversation={conversation} />);
  await screen.findByText("message-100");
  const dates = vi.spyOn(Date.prototype, "toLocaleString");
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Refresh history" })));
  expect(await screen.findByText("message-101")).toBeTruthy();
  expect(dates).toHaveBeenCalledTimes(1);
});
it("updates a quoted source when that source's participant changes", async () => {
  selectLocale("en");
  const original = event(1);
  const reply = {
    ...event(2),
    addressing: {
      reasons: [],
      mentionIds: [],
      replyTo: { sourceId: "source-1", participantId: "user" },
    },
  } as ConversationEventView;
  const changed = { ...original, participant: { id: "user", label: "Changed User", role: "user" } };
  const read = vi
    .fn()
    .mockResolvedValueOnce({ items: [original, reply], nextSeq: 2, hasMore: false })
    .mockResolvedValue({ items: [changed, reply], nextSeq: 2, hasMore: false });
  store.getState().resetForTests({ ...api, getConversationEvents: read });
  render(<ExternalConversation conversation={conversation} />);
  await screen.findByText("message-2");
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Refresh history" })));
  expect(await screen.findByRole("link", { name: /Changed User/ })).toBeTruthy();
});
