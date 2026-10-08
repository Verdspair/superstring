import { cleanup, render, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import type {
  ConversationEventView,
  ConversationSummary,
} from "../../src/shared/contracts/conversation";
import type { QqMessageFact } from "../../src/shared/contracts/qq-message";
import { i18n } from "../../src/web/i18n/runtime";
import { EventRecord } from "../../src/web/screens/conversations/EventRecord";

const now = "2026-10-08T05:00:00Z";
const conversation: ConversationSummary = {
  id: "conversation",
  sourceId: "binding",
  channel: "onebot11",
  topology: "shared",
  agentId: "agent",
  title: "Synthetic group",
  bindingEpoch: 1,
  participants: [],
  updatedAt: now,
  lastSeq: 1,
  consumedSeq: 1,
};
const source = { kind: "outbound_intent", id: "intent", revision: "confirmed" };
const fact: QqMessageFact = {
  id: "confirmed-part",
  platformMessageId: "-7001",
  seq: 1,
  occurredAtSeconds: 1791435600,
  speaker: {
    role: "assistant",
    qq: "10001",
    groupCard: "Synthetic assistant",
    personalNickname: null,
    legacyDisplayName: null,
    nameState: "known",
  },
  parts: [{ kind: "text", text: "Synthetic reply" }],
  mentions: [{ qq: "20002", identity: null }],
  replyTo: { platformMessageId: "-5001" },
  sources: [{ kind: "qq_outbound_message_fact", id: "confirmed-part", revision: "1" }],
  completeness: "full",
};
function event(
  facts: QqMessageFact[],
  text: string | null = "Synthetic reply",
): ConversationEventView {
  return {
    conversationId: conversation.id,
    seq: 1,
    eventKey: "delivery:intent",
    kind: "delivery",
    source,
    sources: [source],
    occurredAt: now,
    recordedAt: now,
    participant: null,
    addressing: { reasons: [], mentionIds: [] },
    runId: null,
    outputId: null,
    text,
    contentState: "active",
    media: [],
    wake: null,
    deliveryStatus: "confirmed",
    messageStatus: null,
    qqMessageFacts: facts,
  };
}
function details(container: HTMLElement) {
  const element = container.querySelector("details");
  if (!element) throw new Error("fixture: source details missing");
  element.open = true;
  return within(element);
}
beforeEach(async () => {
  await i18n.changeLanguage("zh-CN");
});
afterEach(cleanup);

it("shows the confirmed platform quote independently from explicit member mentions", () => {
  const view = render(<EventRecord event={event([fact])} conversation={conversation} />);
  const record = details(view.container);
  expect(record.getByText("-7001")).toBeTruthy();
  expect(record.getByText("-5001")).toBeTruthy();
  expect(record.getByText("@20002")).toBeTruthy();
  expect(view.getByText("Synthetic reply")).toBeTruthy();
  view.rerender(
    <EventRecord event={event([{ ...fact, mentions: [] }])} conversation={conversation} />,
  );
  expect(details(view.container).getByText("-5001")).toBeTruthy();
  expect(details(view.container).queryByText("@20002")).toBeNull();
});

it("keeps mention-only and quoted-sticker metadata without inventing a text body", () => {
  const mention = { ...fact, parts: [{ kind: "mention" as const, qq: "20002" }], replyTo: null };
  const view = render(<EventRecord event={event([mention], null)} conversation={conversation} />);
  expect(details(view.container).getByText("@20002")).toBeTruthy();
  expect(details(view.container).queryByText("-5001")).toBeNull();
  expect(view.queryByText("Synthetic reply")).toBeNull();
  const sticker: QqMessageFact = {
    ...fact,
    parts: [{ kind: "unavailable", type: "sticker" }],
    completeness: "unavailable",
  };
  view.rerender(<EventRecord event={event([sticker], null)} conversation={conversation} />);
  expect(details(view.container).getByText("-5001")).toBeTruthy();
  expect(details(view.container).getByText("@20002")).toBeTruthy();
  expect(view.queryByText("Synthetic reply")).toBeNull();
  expect(view.container.querySelector("img")).toBeNull();
});

it("does not guess a quote for legacy facts or retain relation metadata after revocation", () => {
  const legacy: QqMessageFact = {
    ...fact,
    replyTo: null,
    mentions: [],
    completeness: "legacy_partial",
  };
  const view = render(<EventRecord event={event([legacy])} conversation={conversation} />);
  expect(details(view.container).queryByText("-5001")).toBeNull();
  const revoked: ConversationEventView = { ...event([], null), contentState: "unavailable" };
  view.rerender(<EventRecord event={revoked} conversation={conversation} />);
  expect(view.queryByText("Synthetic reply")).toBeNull();
  expect(details(view.container).queryByText("-5001")).toBeNull();
  expect(details(view.container).queryByText("@20002")).toBeNull();
});
