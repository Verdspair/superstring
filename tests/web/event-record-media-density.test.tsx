// EventRecord 媒体密度：无描述/不可用媒体合并为一行，可用描述保留完整卡片。
//
// 只验渲染行为：合并计数、状态文案、旧描述不泄漏、来源记录 id、未知送达无重试。
// 不断言类名或像素；实际缩放与几何由 Root 在合成 Electron 中实测。

import { cleanup, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type {
  ConversationEventView,
  ConversationSummary,
} from "../../src/shared/contracts/conversation";
import { i18n } from "../../src/web/i18n/runtime";
import { EventRecord } from "../../src/web/screens/conversations/EventRecord";
import { render } from "./helpers/render-with-providers";

const now = "2026-10-22T01:00:00Z";
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

function renderRecord(event: ConversationEventView) {
  void i18n.changeLanguage("zh-CN");
  return render(<EventRecord event={event} conversation={conversation} />);
}

function openSourceRecord(container: HTMLElement) {
  const details = container.querySelector("details");
  if (!details) throw new Error("source record details missing");
  details.open = true;
  return within(details);
}

it("merges media without readable descriptions into one count line per kind and state", () => {
  const view = renderRecord(
    eventView({
      text: null,
      media: [
        { id: "m1", kind: "image", description: null, availability: "available" },
        { id: "m2", kind: "image", description: null, availability: "available" },
        { id: "m3", kind: "image", description: null, availability: "available" },
        { id: "s1", kind: "sticker", description: null, availability: "available" },
      ],
    }),
  );
  expect(view.getByText("图片 ×3 · 暂无可用媒体描述")).toBeDefined();
  expect(view.getByText("表情 · 暂无可用媒体描述")).toBeDefined();
  expect(view.queryByText("暂无可用媒体描述")).toBeNull();
});

it("keeps a full card only for available media with a description", () => {
  const view = renderRecord(
    eventView({
      text: "正文",
      media: [
        { id: "m1", kind: "image", description: "一只橘猫", availability: "available" },
        { id: "m2", kind: "image", description: null, availability: "available" },
      ],
    }),
  );
  expect(view.getByText("一只橘猫")).toBeDefined();
  expect(view.getByText("图片 · 暂无可用媒体描述")).toBeDefined();
});

it("does not expose a stale description when the media is expired or unavailable", () => {
  const view = renderRecord(
    eventView({
      text: null,
      media: [
        { id: "m1", kind: "image", description: "过期前的旧描述", availability: "expired" },
        { id: "m2", kind: "image", description: "撤权前的旧描述", availability: "unavailable" },
      ],
    }),
  );
  expect(view.queryByText("过期前的旧描述")).toBeNull();
  expect(view.queryByText("撤权前的旧描述")).toBeNull();
  expect(view.getByText("图片 · 媒体已过保留期")).toBeDefined();
  expect(view.getByText("图片 · 媒体不可用")).toBeDefined();
});

it("keeps every media id in the source record after compaction", () => {
  const view = renderRecord(
    eventView({
      text: null,
      media: [
        { id: "media-1", kind: "image", description: null, availability: "available" },
        { id: "media-2", kind: "image", description: null, availability: "expired" },
        { id: "media-3", kind: "sticker", description: "可读表情说明", availability: "available" },
      ],
    }),
  );
  const record = openSourceRecord(view.container);
  expect(record.getByText("media-1")).toBeDefined();
  expect(record.getByText("media-2")).toBeDefined();
  expect(record.getByText("media-3")).toBeDefined();
});

it("keeps the unknown delivery receipt contract without adding retry actions", () => {
  const view = renderRecord(
    eventView({
      kind: "outbound",
      text: null,
      deliveryStatus: "unknown",
      media: [{ id: "s1", kind: "sticker", description: null, availability: "unavailable" }],
    }),
  );
  expect(view.getByText("发送结果待确认")).toBeDefined();
  expect(view.getByText("表情 · 媒体不可用")).toBeDefined();
  expect(view.queryByRole("button", { name: /重试|retry/i })).toBeNull();
});

const revisionSource = { kind: "qq_event" as const, id: "orphan-event-key", revision: "2" };

const orphanRevision = eventView({
  kind: "media_revision",
  seq: 2,
  eventKey: "onebot:orphan-event-key",
  source: revisionSource,
  sources: [revisionSource],
  text: null,
  media: [{ id: "rev-m1", kind: "sticker", description: null, availability: "available" }],
});

/** details 关闭时内容仍在 DOM 里；“默认不可见”以 details 外无该直接文案为准。 */
function textOutsideDetails(container: HTMLElement, pattern: string | RegExp) {
  const details = container.querySelector("details");
  if (!details) throw new Error("source record details missing");
  return Array.from(container.querySelectorAll("p, span, li, code")).filter((node) => {
    if (details.contains(node)) return false;
    const text = Array.from(node.childNodes)
      .filter((child) => child.nodeType === 3)
      .map((child) => child.textContent ?? "")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    return typeof pattern === "string" ? text === pattern : pattern.test(text);
  });
}

it("renders an orphan media revision as a compact row without duplicated placeholder prose", () => {
  const view = renderRecord(orphanRevision);
  expect(textOutsideDetails(view.container, "表情 · 暂无可用媒体描述")).toHaveLength(1);
  // 占位说明与原始来源 id 默认只在来源记录 details 内，不重复占满整卡。
  expect(textOutsideDetails(view.container, /关联消息尚未加载/)).toHaveLength(0);
  expect(textOutsideDetails(view.container, "qq_event:orphan-event-key")).toHaveLength(0);
  // 头部参与者/时间仍可直接访问。
  expect(view.getByText("阿林")).toBeDefined();
  expect(view.container.querySelector("time")).not.toBeNull();
});

it("keeps source ids, related-not-loaded note and descriptions reachable in the details on open", () => {
  const view = renderRecord(
    eventView({
      ...orphanRevision,
      media: [
        { id: "rev-m2", kind: "image", description: "一张可用图片", availability: "available" },
      ],
    }),
  );
  const record = openSourceRecord(view.container);
  expect(record.getByText(/关联消息尚未加载/)).toBeDefined();
  expect(record.getByText("qq_event:orphan-event-key")).toBeDefined();
  expect(record.getByText("一张可用图片")).toBeDefined();
  expect(record.getByText("rev-m2")).toBeDefined();
  expect(record.getByText("orphan-event-key")).toBeDefined();
});

it("does not leak old text or descriptions for expired standalone revisions", () => {
  const view = renderRecord(
    eventView({
      ...orphanRevision,
      contentState: "expired" as const,
      text: "过期前的旧文本",
      media: [
        { id: "rev-m3", kind: "image", description: "过期前的旧描述", availability: "expired" },
      ],
    }),
  );
  expect(view.queryByText("过期前的旧文本")).toBeNull();
  expect(view.queryByText("过期前的旧描述")).toBeNull();
  expect(view.getAllByText("图片 · 媒体已过保留期").length).toBeGreaterThan(0);
  const record = openSourceRecord(view.container);
  expect(record.getByText("原文已过保留期")).toBeDefined();
  expect(record.getByText("rev-m3")).toBeDefined();
});

it("keeps a non-compact media revision with task context in the expanded layout", () => {
  const view = renderRecord(
    eventView({
      ...orphanRevision,
      task: { id: "task-1", status: "completed" as const, errorCode: null },
    }),
  );
  expect(view.getByText(/关联消息尚未加载/)).toBeDefined();
  expect(view.getByText("任务处理完成")).toBeDefined();
});

it("keeps normal inbound rows compact per kind without media_revision treatment", () => {
  const view = renderRecord(
    eventView({
      text: null,
      media: [
        { id: "n1", kind: "image", description: null, availability: "available" },
        { id: "n2", kind: "image", description: null, availability: "unavailable" },
      ],
    }),
  );
  expect(view.getByText("图片 · 暂无可用媒体描述")).toBeDefined();
  expect(view.getByText("图片 · 媒体不可用")).toBeDefined();
});

it("counts readable and unavailable media together in the compact update summary", () => {
  const view = renderRecord(
    eventView({
      ...orphanRevision,
      media: [
        {
          id: "readable-sticker",
          kind: "sticker",
          description: "可读说明",
          availability: "available",
        },
        { id: "unavailable-image", kind: "image", description: null, availability: "unavailable" },
      ],
    }),
  );
  expect(textOutsideDetails(view.container, "表情 · 图片 · 媒体不可用")).toHaveLength(1);
  expect(openSourceRecord(view.container).getByText("可读说明")).toBeDefined();
});

it("keeps a standalone run link on compact media revisions that carry a runId", () => {
  const view = renderRecord(
    eventView({
      ...orphanRevision,
      runId: "run-media-1",
      media: [{ id: "rev-m4", kind: "sticker", description: null, availability: "available" }],
    }),
  );
  // 紧凑行保留单行摘要；独立 runId 的运行详情入口不被紧凑布局吞掉。
  expect(textOutsideDetails(view.container, "表情 · 暂无可用媒体描述")).toHaveLength(1);
  expect(view.getByRole("button", { name: "运行详情" })).toBeDefined();
});

it("summarizes readable and unavailable counts together while keeping descriptions details-only", () => {
  const view = renderRecord(
    eventView({
      ...orphanRevision,
      media: [
        { id: "r1", kind: "image", description: "第一张描述", availability: "available" },
        { id: "r2", kind: "image", description: "第二张描述", availability: "available" },
        { id: "u1", kind: "sticker", description: null, availability: "unavailable" },
        { id: "e1", kind: "image", description: "过期前的旧描述", availability: "expired" },
      ],
    }),
  );
  expect(
    textOutsideDetails(view.container, "图片 ×2 · 表情 · 媒体不可用 · 图片 · 媒体已过保留期"),
  ).toHaveLength(1);
  const record = openSourceRecord(view.container);
  expect(record.getByText("第一张描述")).toBeDefined();
  expect(record.getByText("第二张描述")).toBeDefined();
  expect(view.queryByText("过期前的旧描述")).toBeNull();
  expect(record.getByText("r1")).toBeDefined();
  expect(record.getByText("e1")).toBeDefined();
});
