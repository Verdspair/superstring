import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ConversationEventView,
  ConversationSummary,
} from "../../src/shared/contracts/conversation";
import { EventRecord } from "../../src/web/screens/conversations/EventRecord";
import {
  type ConversationTimelineRow,
  timelineRows,
} from "../../src/web/screens/conversations/timeline-projection";
import { render } from "./helpers/render-with-providers";

const now = "2026-10-16T19:00:00Z";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const baseConversation: ConversationSummary = {
  id: "conv-101",
  sourceId: "group-888",
  channel: "onebot11",
  topology: "shared",
  agentId: "agent-alpha",
  title: "原始群名称",
  bindingEpoch: 1,
  participants: [
    { id: "user-1", label: "张三", role: "user" },
    { id: "user-2", label: "李四", role: "user" },
  ],
  updatedAt: now,
  lastSeq: 10,
  consumedSeq: 10,
};

function makeInboundEvent(
  seq: number,
  overrides: Partial<ConversationEventView & { activityId?: string }> = {},
): ConversationEventView & { activityId?: string } {
  const source = { kind: "qq_event" as const, id: `qq-${seq}`, revision: "1" };
  return {
    conversationId: "conv-101",
    seq,
    eventKey: `onebot:qq-${seq}`,
    kind: "inbound",
    source,
    sources: [source],
    occurredAt: now,
    recordedAt: now,
    participant: { id: "user-1", label: "张三", role: "user" },
    addressing: { reasons: ["mention"], mentionIds: ["user-2"] },
    runId: null,
    outputId: null,
    text: `消息内容 ${seq}`,
    contentState: "active",
    media: [],
    deliveryStatus: null,
    messageStatus: null,
    wake: null,
    ...overrides,
  };
}

describe("message row render isolation & activity projection stability (PROVEN RED FIRST)", () => {
  describe("timelineRows pure projection reference stability with optional previousRows parameter", () => {
    it("retains object references of unchanged rows when new events are appended", () => {
      const event1 = makeInboundEvent(1, { activityId: "act-1" });
      const initialRows = timelineRows([event1]);
      expect(initialRows).toHaveLength(1);

      // Append event2 without mutating event1
      const event2 = makeInboundEvent(2, { activityId: "act-2" });
      const nextRows = timelineRows([event1, event2], initialRows);

      expect(nextRows).toHaveLength(2);
      // RED EXPECTATION: Pure projection must preserve unchanged row identity to avoid downstream memo churn
      expect(nextRows[0]).toBe(initialRows[0]);
      expect(nextRows[1].seq).toBe(2);
    });

    it("invalidates row reference when underlying event task status changes", () => {
      const event1 = makeInboundEvent(1, {
        activityId: "act-1",
        task: {
          id: "task-1",
          status: "running",
          cause: "user_turn",
          readyAt: now,
          errorCode: null,
          title: "处理中",
        } as any,
      });
      const initialRows = timelineRows([event1]);

      // Server-authoritative task update: task completed
      const event1Updated = makeInboundEvent(1, {
        activityId: "act-1",
        task: {
          id: "task-1",
          status: "completed",
          cause: "user_turn",
          readyAt: now,
          errorCode: null,
          title: "已完成",
        } as any,
      });
      const nextRows = timelineRows([event1Updated], initialRows);

      expect(nextRows).toHaveLength(1);
      expect(nextRows[0]).not.toBe(initialRows[0]);
      expect(nextRows[0].task?.status).toBe("completed");
    });

    it("invalidates inbound row reference when media revisions decorate it", () => {
      const inbound = makeInboundEvent(1, {
        activityId: "act-1",
        sources: [{ kind: "qq_event", id: "qq-inbound-1", revision: "1" }],
      });
      const initialRows = timelineRows([inbound]);
      expect(initialRows[0].media).toHaveLength(0);

      const mediaRev: ConversationEventView & { activityId?: string } = {
        conversationId: "conv-101",
        seq: 2,
        eventKey: "onebot:rev-1",
        kind: "media_revision",
        source: { kind: "media_item", id: "media-1", revision: "1" },
        sources: [{ kind: "qq_event", id: "qq-inbound-1", revision: "1" }],
        occurredAt: now,
        recordedAt: now,
        participant: null,
        addressing: { reasons: [], mentionIds: [] },
        runId: null,
        outputId: null,
        text: null,
        contentState: "active",
        media: [{ id: "m-1", kind: "image", mimeType: "image/png" } as any],
        deliveryStatus: null,
        messageStatus: null,
        wake: null,
      };

      const nextRows = timelineRows([inbound, mediaRev], initialRows);
      expect(nextRows).toHaveLength(1);
      expect(nextRows[0]).not.toBe(initialRows[0]);
      expect(nextRows[0].media).toHaveLength(1);
      expect(nextRows[0].media[0].id).toBe("m-1");
    });

    it("invalidates row reference when wake status or delivery outcome changes", () => {
      const eventPending = makeInboundEvent(1, {
        activityId: "act-1",
        deliveryStatus: "delivering",
        wake: {
          id: "w-1",
          status: "leased",
          cause: "chiming_in",
          readyAt: now,
          errorCode: null,
        },
      });
      const initialRows = timelineRows([eventPending]);

      const eventConfirmed = makeInboundEvent(1, {
        activityId: "act-1",
        deliveryStatus: "confirmed",
        wake: {
          id: "w-1",
          status: "completed",
          cause: "chiming_in",
          readyAt: now,
          errorCode: null,
        },
      });
      const nextRows = timelineRows([eventConfirmed], initialRows);

      expect(nextRows).toHaveLength(1);
      expect(nextRows[0]).not.toBe(initialRows[0]);
      expect(nextRows[0].deliveryStatus).toBe("confirmed");
      expect(nextRows[0].wake?.status).toBe("completed");
    });

    it("invalidates row reference when source provenance revision changes", () => {
      const orig = makeInboundEvent(1, {
        source: { kind: "qq_event", id: "qq-1", revision: "1" },
      });
      const initialRows = timelineRows([orig]);

      const updated = makeInboundEvent(1, {
        source: { kind: "qq_event", id: "qq-1", revision: "2" },
      });
      const nextRows = timelineRows([updated], initialRows);

      expect(nextRows).toHaveLength(1);
      expect(nextRows[0]).not.toBe(initialRows[0]);
      expect(nextRows[0].source.revision).toBe("2");
    });
  });

  describe("EventRecord DOM render isolation under conversation summary updates", () => {
    it("bails out re-render and preserves unchanged row DOM when conversation unread, title, or timestamps change", () => {
      const event = makeInboundEvent(1) as ConversationTimelineRow;
      const formatDateSpy = vi.spyOn(Date.prototype, "toLocaleString");

      const view = render(<EventRecord event={event} conversation={baseConversation} />);
      expect(formatDateSpy).toHaveBeenCalledTimes(1);
      const articleBefore = view.container.querySelector("article");
      expect(articleBefore).toBeTruthy();

      // ConversationSummary updates with unread change (lastSeq/consumedSeq), title change, and timestamp change
      const nextConversation: ConversationSummary = {
        ...baseConversation,
        title: "群名称已修改（不应引发单行重渲染）",
        lastSeq: 55,
        consumedSeq: 42,
        updatedAt: "2026-10-16T19:15:00Z",
        bindingEpoch: 2,
      };

      view.rerender(<EventRecord event={event} conversation={nextConversation} />);

      // RED EXPECTATION: EventRecord must bail out re-render when only unread/title/timestamps change.
      // Currently, default shallow prop comparison fails (baseConversation !== nextConversation),
      // re-running EventRecordComponent and calling formatDate a second time.
      expect(formatDateSpy).toHaveBeenCalledTimes(1);
      expect(view.container.querySelector("article")).toBe(articleBefore);
    });

    it("re-renders when conversation topology changes (shared <-> direct)", () => {
      const event = makeInboundEvent(1) as ConversationTimelineRow;
      const formatDateSpy = vi.spyOn(Date.prototype, "toLocaleString");

      const view = render(
        <EventRecord event={event} conversation={{ ...baseConversation, topology: "shared" }} />,
      );
      expect(formatDateSpy).toHaveBeenCalledTimes(1);

      // Switching topology affects participant id display and styling -> MUST re-render
      view.rerender(
        <EventRecord event={event} conversation={{ ...baseConversation, topology: "direct" }} />,
      );
      expect(formatDateSpy).toHaveBeenCalledTimes(2);
    });

    it("re-renders when conversation participant labels change", () => {
      const event = makeInboundEvent(1, {
        addressing: { reasons: ["mention"], mentionIds: ["user-2"] },
      }) as ConversationTimelineRow;
      const formatDateSpy = vi.spyOn(Date.prototype, "toLocaleString");

      const view = render(<EventRecord event={event} conversation={baseConversation} />);
      expect(formatDateSpy).toHaveBeenCalledTimes(1);

      // Changing participant label affects rendered @mention text -> MUST re-render
      const nextConversation: ConversationSummary = {
        ...baseConversation,
        participants: [
          { id: "user-1", label: "张三（改名）", role: "user" },
          { id: "user-2", label: "李四（改名）", role: "user" },
        ],
      };

      view.rerender(<EventRecord event={event} conversation={nextConversation} />);
      expect(formatDateSpy).toHaveBeenCalledTimes(2);
    });

    it("re-renders when event content or delivery status changes", () => {
      const event1 = makeInboundEvent(1) as ConversationTimelineRow;
      const formatDateSpy = vi.spyOn(Date.prototype, "toLocaleString");

      const view = render(<EventRecord event={event1} conversation={baseConversation} />);
      expect(formatDateSpy).toHaveBeenCalledTimes(1);

      const event2 = makeInboundEvent(1, { text: "新消息正文" }) as ConversationTimelineRow;
      view.rerender(<EventRecord event={event2} conversation={baseConversation} />);
      expect(formatDateSpy).toHaveBeenCalledTimes(2);
    });

    it("re-renders when quoted message reference changes", () => {
      const event = makeInboundEvent(2, {
        addressing: {
          reasons: ["mention"],
          mentionIds: [],
          replyTo: { sourceId: "qq-1" },
        },
      }) as ConversationTimelineRow;
      const quoted1 = makeInboundEvent(1, { text: "原始引用" });
      const formatDateSpy = vi.spyOn(Date.prototype, "toLocaleString");

      const view = render(
        <EventRecord event={event} quoted={quoted1} conversation={baseConversation} />,
      );
      expect(formatDateSpy).toHaveBeenCalledTimes(1);

      const quoted2 = makeInboundEvent(1, { text: "引用的原消息已更新" });
      view.rerender(<EventRecord event={event} quoted={quoted2} conversation={baseConversation} />);
      expect(formatDateSpy).toHaveBeenCalledTimes(2);
    });
  });
});
