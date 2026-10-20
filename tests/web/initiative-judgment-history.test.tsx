import { cleanup, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ConversationEventView,
  ConversationSummary,
} from "../../src/shared/contracts/conversation";
import { api, type SuperstringApi } from "../../src/web/api";
import { i18n } from "../../src/web/i18n/runtime";
import { ExternalConversation } from "../../src/web/screens/conversations/ExternalConversation";
import { useSuperstringStore as store } from "../../src/web/store";
import { render } from "./helpers/render-with-providers";

const now = "2026-10-17T03:30:00Z";

const conversation: ConversationSummary = {
  id: "conv-initiative-test",
  sourceId: "group-100",
  channel: "onebot11",
  topology: "shared",
  agentId: "agent-1",
  title: "Initiative Test Group",
  bindingEpoch: 1,
  participants: [],
  updatedAt: now,
  lastSeq: 10,
  consumedSeq: 10,
};

function makeWakeEvent(
  seq: number,
  wakeOverrides: Partial<NonNullable<ConversationEventView["wake"]>> = {},
  extra: Partial<ConversationEventView> = {},
): ConversationEventView {
  const wakeSource = { kind: "wake_signal" as const, id: `wake-${seq}`, revision: "1" };
  return {
    conversationId: conversation.id,
    seq,
    eventKey: `wake-event-${seq}`,
    kind: "wake",
    source: wakeSource,
    sources: [wakeSource],
    occurredAt: now,
    recordedAt: now,
    participant: null,
    addressing: { reasons: [], mentionIds: [] },
    runId: null,
    outputId: null,
    text: null,
    contentState: "active",
    media: [],
    deliveryStatus: null,
    messageStatus: null,
    wake: {
      id: `wake-${seq}`,
      cause: "chiming_in",
      status: "no_output",
      readyAt: now,
      errorCode: null,
      ...wakeOverrides,
    },
    ...extra,
  };
}

function makeInboundEvent(seq: number, text: string): ConversationEventView {
  const source = { kind: "qq_event" as const, id: `event-${seq}`, revision: "1" };
  return {
    conversationId: conversation.id,
    seq,
    eventKey: `inbound-${seq}`,
    kind: "inbound",
    source,
    sources: [source],
    occurredAt: now,
    recordedAt: now,
    participant: { id: "user-1", label: "测试成员", role: "member" },
    addressing: { reasons: ["mention"], mentionIds: ["agent-1"] },
    runId: null,
    outputId: null,
    text,
    contentState: "active",
    media: [],
    deliveryStatus: null,
    messageStatus: null,
    wake: null,
  };
}

function setupStore(overrides: Partial<SuperstringApi>) {
  store.getState().resetForTests({
    ...api,
    getConversationRuntimeStatus: vi.fn(async () => ({
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
    })),
    listRuntimeTraces: vi.fn(async () => ({
      items: [],
      nextBeforeId: 0,
      hasMore: false,
      summary: {
        totalTraces: 0,
        activeTraces: 0,
        failedTraces: 0,
        matchedSpans: 0,
        lastActivityAt: null,
        now,
      },
    })),
    ...overrides,
  });
}

beforeEach(async () => {
  localStorage.clear();
  await i18n.changeLanguage("zh-CN");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("initiative judgment history filtering and auto-paging", () => {
  it("case 1: meaningful grouped message or delivery with wake.judgmentStarted===false is NOT filtered", async () => {
    const inboundWithWake = {
      ...makeInboundEvent(1, "真实群聊消息"),
      wake: {
        id: "wake-grouped-1",
        cause: "chiming_in",
        status: "no_output" as const,
        readyAt: now,
        errorCode: null,
        judgmentStarted: false,
      },
    };

    const wakeWithDelivery = makeWakeEvent(
      2,
      { judgmentStarted: false },
      { activityId: "activity-delivery" },
    );
    const delivery: ConversationEventView = {
      ...makeInboundEvent(3, "关联递送记录"),
      kind: "delivery",
      activityId: "activity-delivery",
      outputId: "out-2",
      deliveryStatus: "confirmed",
    };

    const read = vi.fn().mockResolvedValue({
      items: [inboundWithWake, wakeWithDelivery, delivery],
      nextSeq: 3,
      hasMore: false,
    });

    setupStore({ getConversationEvents: read });
    render(<ExternalConversation conversation={conversation} />);

    expect(await screen.findByText("真实群聊消息")).toBeTruthy();
    expect(screen.queryByText("暂无会话记录")).toBeNull();
  });

  it("case 2: standalone ordinary wake with task metadata and wake.judgmentStarted===false is HIDDEN", async () => {
    const standalonePendingWake = makeWakeEvent(
      1,
      {
        cause: "chiming_in",
        status: "pending",
        readyAt: now,
        judgmentStarted: false,
      },
      {
        task: {
          id: "task-pending-1",
          status: "pending",
          errorCode: null,
        },
      },
    );

    const read = vi.fn().mockResolvedValue({
      items: [standalonePendingWake],
      nextSeq: 1,
      hasMore: false,
    });

    setupStore({ getConversationEvents: read });
    render(<ExternalConversation conversation={conversation} />);

    expect(await screen.findByText(i18n.t("workspace.no_conversation_events_yet"))).toBeTruthy();
    expect(screen.queryByText("等待处理")).toBeNull();
    expect(screen.queryByText("唤醒记录")).toBeNull();
  });

  it("case 3: genuine model-none judgment (wakeStatus=no_output, judgmentStarted=true) is VISIBLE", async () => {
    const judgedNoneWake = makeWakeEvent(1, {
      cause: "chiming_in",
      status: "no_output",
      readyAt: now,
      errorCode: null,
      judgmentStarted: true,
    });

    const read = vi.fn().mockResolvedValue({
      items: [judgedNoneWake],
      nextSeq: 1,
      hasMore: false,
    });

    setupStore({ getConversationEvents: read });
    render(<ExternalConversation conversation={conversation} />);

    expect(await screen.findByText("本次未发言")).toBeTruthy();
    expect(screen.getByText("唤醒记录")).toBeTruthy();
    expect(screen.queryByText("暂无会话记录")).toBeNull();
  });

  it("case 4: missing marker (judgmentStarted=undefined) is KEPT (fail-open historical/cache rows preserved)", async () => {
    const historicalWake = makeWakeEvent(1, {
      cause: "chiming_in",
      status: "no_output",
      readyAt: now,
      errorCode: null,
      judgmentStarted: undefined,
    });

    const read = vi.fn().mockResolvedValue({
      items: [historicalWake],
      nextSeq: 1,
      hasMore: false,
    });

    setupStore({ getConversationEvents: read });
    render(<ExternalConversation conversation={conversation} />);

    expect(await screen.findByText("本次未发言")).toBeTruthy();
    expect(screen.getByText("唤醒记录")).toBeTruthy();
  });

  it("case 5: direct_reply or follow_up wake with malformed false marker is KEPT and VISIBLE (negative guard)", async () => {
    const directReplyWake = makeWakeEvent(1, {
      cause: "direct_reply",
      status: "no_output",
      readyAt: now,
      errorCode: null,
      judgmentStarted: false,
    });

    const followUpWake = makeWakeEvent(2, {
      cause: "follow_up",
      status: "no_output",
      readyAt: now,
      errorCode: null,
      judgmentStarted: false,
    });

    const read = vi.fn().mockResolvedValue({
      items: [directReplyWake, followUpWake],
      nextSeq: 2,
      hasMore: false,
    });

    setupStore({ getConversationEvents: read });
    render(<ExternalConversation conversation={conversation} />);

    const noOutputs = await screen.findAllByText("本次未发言");
    expect(noOutputs.length).toBe(2);
    expect(screen.queryByText("暂无会话记录")).toBeNull();
  });

  it("case 6: noise-only page auto-loads earlier pages via loadMore until genuine rows appear, and manual button reflects cursor", async () => {
    const noiseWake = makeWakeEvent(10, {
      cause: "chiming_in",
      status: "pending",
      readyAt: now,
      judgmentStarted: false,
    });

    const olderGenuineInbound = makeInboundEvent(5, "更早真实消息");

    const read = vi.fn<SuperstringApi["getConversationEvents"]>(async (_id, params) => {
      if (!params || typeof params === "number" || params.direction === "latest") {
        return {
          items: [noiseWake],
          nextSeq: 10,
          hasMore: true,
        };
      }
      if (params.direction === "before") {
        return {
          items: [olderGenuineInbound],
          nextSeq: 5,
          hasMore: true,
        };
      }
      return { items: [], nextSeq: 0, hasMore: false };
    });

    setupStore({ getConversationEvents: read });
    render(<ExternalConversation conversation={conversation} />);

    // Since the latest page only has noise, it should auto-trigger loadMore,
    // leading to the older page being loaded and displayed.
    expect(await screen.findByText("更早真实消息")).toBeTruthy();
    expect(read).toHaveBeenCalledWith(
      conversation.id,
      expect.objectContaining({ direction: "before", beforeSeq: 10 }),
      expect.any(AbortSignal),
    );

    // Because hasMore is still true, the manual loadMore button is present and clickable
    const loadEarlierButton = screen.getByRole("button", { name: "加载更早记录" });
    expect(loadEarlierButton).toBeTruthy();
    expect((loadEarlierButton as HTMLButtonElement).disabled).toBe(false);
  });
});
