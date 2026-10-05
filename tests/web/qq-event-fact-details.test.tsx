// EventRecord 的 QQ 消息详情组前端渲染。
//
// fixture：合法 `ConversationEventView` 合成形状（与 shared 契约同步的字面量；非真实
// HTTP fixture——HTTP 侧正/负语义由 tests/integration/qq-event-fact-details.test.ts
// 经真实 conversationRoutes 验收，本文件只验组件行为：双名/当前映射分组、legacy 显式
// 未知、@/reply/平台 ID 可见、中英转义与长名、强负泄漏断言）。

import { cleanup, render, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type {
  ConversationEventView,
  ConversationSummary,
} from "../../src/shared/contracts/conversation";
import type { QqMessageFact } from "../../src/shared/contracts/qq-message";
import { i18n } from "../../src/web/i18n/runtime";
import { EventRecord } from "../../src/web/screens/conversations/EventRecord";

const now = "2026-10-02T08:00:00Z";
afterEach(() => {
  cleanup();
});

const conversation: ConversationSummary = {
  id: "bot",
  sourceId: "binding",
  channel: "onebot11",
  topology: "shared",
  agentId: "agent",
  title: "群聊 30003",
  bindingEpoch: 1,
  participants: [],
  updatedAt: now,
  lastSeq: 1,
  consumedSeq: 1,
};

const source = { kind: "qq_event" as const, id: "event-key", revision: "1" };

function eventView(overrides: Partial<ConversationEventView> = {}): ConversationEventView {
  return {
    wake: null,
    conversationId: "bot",
    seq: 1,
    eventKey: "onebot:event-key",
    kind: "inbound",
    source,
    sources: [source],
    occurredAt: now,
    recordedAt: now,
    participant: { id: "10001", label: "阿林", role: "member" },
    addressing: { reasons: [], mentionIds: [] },
    runId: null,
    outputId: null,
    text: "正文",
    contentState: "active",
    media: [],
    deliveryStatus: null,
    messageStatus: null,
    ...overrides,
  };
}

function renderRecord(event: ConversationEventView, language: "zh-CN" | "en") {
  void i18n.changeLanguage(language);
  return render(<EventRecord event={event} rows={[event]} conversation={conversation} />);
}

function openSourceRecord(container: HTMLElement) {
  const details = container.querySelector("details");
  if (!details) throw new Error("source_record details missing");
  details.open = true;
  return within(details);
}

const snapshotFact: QqMessageFact = {
  id: "fact-id",
  platformMessageId: "-201",
  seq: 1,
  occurredAtSeconds: 0,
  speaker: {
    role: "member" as const,
    qq: "10001",
    groupCard: "阿林卡",
    personalNickname: "阿林",
    legacyDisplayName: null,
    nameState: "known" as const,
    currentName: { groupCard: "新卡", personalNickname: "新昵" },
  },
  parts: [{ kind: "text" as const, text: "正文" }],
  mentions: [{ qq: "10002", identity: null }],
  replyTo: { platformMessageId: "-101" },
  sources: [],
  completeness: "full" as const,
};

it("renders snapshot dual names and current mapping as separate labelled groups (zh-CN)", () => {
  const view = renderRecord(eventView({ qqMessageFacts: [snapshotFact] }), "zh-CN");
  const record = openSourceRecord(view.container);
  expect(record.getByText("QQ 消息详情")).toBeDefined();
  expect(record.getByText(/发送时名称/)).toBeDefined();
  expect(record.getByText(/当前名称/)).toBeDefined();
  expect(record.getByText("阿林卡")).toBeDefined();
  expect(record.getByText("阿林")).toBeDefined();
  expect(record.getByText("新卡")).toBeDefined();
  expect(record.getByText("新昵")).toBeDefined();
  // legacy 显示明确未知：不出现把 legacy 名字伪装成当前名字的标签。
  expect(record.queryByText(/历史单名（旧记录）/)).toBeNull();
});

it("labels legacy snapshots as unknown-history without promoting them to current names", () => {
  const legacy: QqMessageFact = {
    ...snapshotFact,
    speaker: {
      role: "member",
      qq: "10001",
      groupCard: null,
      personalNickname: null,
      legacyDisplayName: "旧显示名",
      nameState: "legacy",
      currentName: undefined,
    },
  };
  const view = renderRecord(eventView({ qqMessageFacts: [legacy] }), "zh-CN");
  const record = openSourceRecord(view.container);
  expect(record.getByText(/历史单名（旧记录）/)).toBeDefined();
  expect(record.getByText("旧显示名")).toBeDefined();
  expect(record.getByText(/当前名称不可用/)).toBeDefined();
});

it("shows ordered mentions (including all), reply target and platform message id", () => {
  const withAll: QqMessageFact = {
    ...snapshotFact,
    mentions: [
      { qq: "all", identity: null },
      { qq: "10002", identity: null },
    ],
  };
  const view = renderRecord(eventView({ qqMessageFacts: [withAll] }), "zh-CN");
  const record = openSourceRecord(view.container);
  expect(record.getByText(/全体成员/)).toBeDefined();
  expect(record.getByText(/10002/)).toBeDefined();
  expect(record.getByText(/引用消息 ID/)).toBeDefined();
  expect(record.getByText("-101")).toBeDefined();
  expect(record.getByText(/平台消息 ID/)).toBeDefined();
  expect(record.getByText("-201")).toBeDefined();
});

it("renders English labels and escapes long user names as text (no HTML injection)", () => {
  const injected: QqMessageFact = {
    ...snapshotFact,
    speaker: {
      ...snapshotFact.speaker,
      groupCard: "<img src=x onerror=alert(1)>超长群名片".repeat(6),
    },
  };
  const view = renderRecord(eventView({ qqMessageFacts: [injected] }), "en");
  const record = openSourceRecord(view.container);
  expect(record.getByText("QQ message details")).toBeDefined();
  expect(record.getByText(/Names at send time/)).toBeDefined();
  expect(record.getByText(/Current names/)).toBeDefined();
  // React 文本转义：没有真实 img 元素，原文本按字面渲染。
  expect(view.container.querySelector("img")).toBeNull();
  expect(record.getByText(/<img src=x onerror/)).toBeDefined();
});

it("keeps legacy completeness labelled and omits the details group without facts", () => {
  const legacy: QqMessageFact = { ...snapshotFact, completeness: "legacy_partial" };
  const view = renderRecord(eventView({ qqMessageFacts: [legacy] }), "zh-CN");
  const record = openSourceRecord(view.container);
  expect(record.getByText(/旧记录（仅单名证据）/)).toBeDefined();
  const noFacts = renderRecord(eventView(), "zh-CN");
  expect(noFacts.container.querySelector("details")?.textContent).not.toContain("QQ 消息详情");
});

it("renders duplicate @ mentions in order without React duplicate-key console errors", () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const duplicated: QqMessageFact = {
    ...snapshotFact,
    mentions: [
      { qq: "10002", identity: null },
      { qq: "10002", identity: null },
      { qq: "all", identity: null },
    ],
  };
  const view = renderRecord(eventView({ qqMessageFacts: [duplicated] }), "zh-CN");
  const record = openSourceRecord(view.container);
  expect(record.getAllByText(/10002/)).toHaveLength(2);
  expect(error).not.toHaveBeenCalled();
});
