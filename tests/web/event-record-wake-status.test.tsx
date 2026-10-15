// EventRecord: wake 状态及错误码中性映射测试。
//
// 验证规则：
// 1. status=no_output 且 errorCode=BATCH_WAITING_FOR_COUNT 时，展示中性文案「消息条数尚未满足」，
//    不使用 text-destructive 标红，且保持「本次未发言」标题不变（不冒充 pending「等待处理」）。
// 2. 真实错误码（如 CONTEXT_INVALID_SELECTION）保持 text-destructive 标红。
// 3. 非白名单 BATCH_* 码（如 BATCH_SKIPPED_BUSY）保持 text-destructive 标红，禁止全 BATCH_* 通配中性化。
// 4. 英文语言环境下渲染对应本地化中英文案。

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ConversationEventView,
  ConversationSummary,
} from "../../src/shared/contracts/conversation";
import { api } from "../../src/web/api";
import { i18n } from "../../src/web/i18n/runtime";
import { EventRecord } from "../../src/web/screens/conversations/EventRecord";
import { useSuperstringStore } from "../../src/web/store";

const now = "2026-10-09T12:00:00Z";

afterEach(() => {
  cleanup();
});

const conversation: ConversationSummary = {
  id: "conv-1",
  sourceId: "group-100",
  channel: "onebot11",
  topology: "shared",
  agentId: "agent-1",
  title: "测试群聊",
  bindingEpoch: 1,
  participants: [],
  updatedAt: now,
  lastSeq: 10,
  consumedSeq: 10,
};

const wakeSource = { kind: "wake_signal" as const, id: "wake-1", revision: "1" };

function wakeEvent(
  wakeOverrides: Partial<NonNullable<ConversationEventView["wake"]>>,
): ConversationEventView {
  return {
    conversationId: "conv-1",
    seq: 10,
    eventKey: "onebot:wake-1",
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
      id: "wake-1",
      status: "no_output",
      cause: "chiming_in",
      readyAt: now,
      errorCode: null,
      ...wakeOverrides,
    },
  };
}

describe("EventRecord wake status & error code presentation", () => {
  it("opens the exact active run from the processing task status without inspecting protected content", async () => {
    await i18n.changeLanguage("zh-CN");
    const getRun = vi.fn().mockResolvedValue({
      runId: "active-run-1",
      specId: "onebot.main",
      specVersion: "1",
      owner: { kind: "conversation", id: conversation.id },
      status: "generating",
      startedAt: now,
      endedAt: null,
      errorCode: null,
      steps: [],
      lastSeq: 1,
      outputs: [],
    });
    const inspect = vi.fn();
    useSuperstringStore.getState().resetForTests({
      ...api,
      getRun,
      inspectRunContext: inspect,
    });
    const event = {
      ...wakeEvent({ status: "completed", cause: "chiming_in" }),
      runId: "active-run-1",
      task: { id: "qq-task-active", status: "running" as const, errorCode: null },
    };
    try {
      render(<EventRecord event={event} conversation={conversation} />);
      expect(screen.queryByRole("button", { name: "运行详情" })).toBeNull();
      await userEvent.click(screen.getByRole("button", { name: "正在处理" }));
      expect(await screen.findByRole("dialog")).toBeTruthy();
      await waitFor(() =>
        expect(getRun).toHaveBeenCalledWith("active-run-1", expect.any(AbortSignal)),
      );
      expect(inspect).not.toHaveBeenCalled();
    } finally {
      cleanup();
      useSuperstringStore.getState().resetForTests(api);
    }
  });
  it("renders BATCH_WAITING_FOR_COUNT as neutral label without text-destructive class", async () => {
    await i18n.changeLanguage("zh-CN");
    const event = wakeEvent({
      status: "no_output",
      cause: "chiming_in",
      errorCode: "BATCH_WAITING_FOR_COUNT",
    });

    const { container } = render(<EventRecord event={event} conversation={conversation} />);

    // 标题保持「本次未发言」，绝不可写「等待处理」误导用户
    expect(screen.getByText("本次未发言")).toBeDefined();
    expect(screen.queryByText("等待处理")).toBeNull();

    // 错误码映射为中性说明「消息条数尚未满足」
    const neutralText = screen.getByText("消息条数尚未满足");
    expect(neutralText).toBeDefined();
    expect(neutralText.className).not.toContain("text-destructive");
    expect(neutralText.className).toContain("text-muted-foreground");

    // 不存在 text-destructive 标红的错误码段落
    const destructiveElements = container.querySelectorAll(".text-destructive");
    expect(destructiveElements.length).toBe(0);
  });

  it("renders non-whitelisted BATCH_SKIPPED_BUSY as text-destructive (no blanket BATCH_* wildcard)", async () => {
    await i18n.changeLanguage("zh-CN");
    const event = wakeEvent({
      status: "no_output",
      cause: "chiming_in",
      errorCode: "BATCH_SKIPPED_BUSY",
    });

    const { container } = render(<EventRecord event={event} conversation={conversation} />);

    expect(screen.getByText("本次未发言")).toBeDefined();
    const destructiveEl = container.querySelector(".text-destructive");
    expect(destructiveEl).not.toBeNull();
    expect(destructiveEl?.textContent).toContain("BATCH_SKIPPED_BUSY");
  });

  it("renders real error code (CONTEXT_INVALID_SELECTION) as text-destructive", async () => {
    await i18n.changeLanguage("zh-CN");
    const event = wakeEvent({
      status: "failed",
      cause: "direct_reply",
      errorCode: "CONTEXT_INVALID_SELECTION",
    });

    const { container } = render(<EventRecord event={event} conversation={conversation} />);

    expect(screen.getByText("处理失败")).toBeDefined();
    const destructiveEl = container.querySelector(".text-destructive");
    expect(destructiveEl).not.toBeNull();
    expect(destructiveEl?.textContent).toContain("CONTEXT_INVALID_SELECTION");
  });

  it("renders localized English neutral label for BATCH_WAITING_FOR_COUNT", async () => {
    await i18n.changeLanguage("en");
    const event = wakeEvent({
      status: "no_output",
      cause: "chiming_in",
      errorCode: "BATCH_WAITING_FOR_COUNT",
    });

    const { container } = render(<EventRecord event={event} conversation={conversation} />);

    expect(screen.getByText("No response this time")).toBeDefined();
    const neutralText = screen.getByText("Message count threshold not met");
    expect(neutralText).toBeDefined();
    expect(neutralText.className).not.toContain("text-destructive");

    const destructiveElements = container.querySelectorAll(".text-destructive");
    expect(destructiveElements.length).toBe(0);
  });
  it("renders linked task failure (QQ_TASK_FAILED) when wake completed, showing task failed and error code instead of completed", async () => {
    await i18n.changeLanguage("zh-CN");
    const event = {
      ...wakeEvent({
        status: "completed",
        cause: "chiming_in",
        errorCode: null,
      }),
      task: {
        id: "task-101",
        status: "failed" as const,
        errorCode: "QQ_TASK_FAILED",
      },
    };

    const { container } = render(<EventRecord event={event} conversation={conversation} />);

    // 应该展示任务失败，而不是处理完成
    expect(screen.getByText("任务处理失败")).toBeDefined();
    expect(screen.queryByText("处理完成")).toBeNull();

    // 错误码 QQ_TASK_FAILED 应该以 text-destructive 标红展示
    const destructiveEl = container.querySelector(".text-destructive");
    expect(destructiveEl).not.toBeNull();
    expect(destructiveEl?.textContent).toContain("QQ_TASK_FAILED");
  });
  it("renders linked task completed as neutral task processing completed label (not wake completed or delivered)", async () => {
    await i18n.changeLanguage("zh-CN");
    const event = {
      ...wakeEvent({
        status: "completed",
        cause: "chiming_in",
        errorCode: null,
      }),
      task: {
        id: "task-102",
        status: "completed" as const,
        errorCode: null,
      },
    };

    render(<EventRecord event={event} conversation={conversation} />);

    // 应该展示中性「任务处理完成」，表示模型处理完成而非送达
    expect(screen.getByText("任务处理完成")).toBeDefined();
    expect(screen.queryByText("处理完成")).toBeNull();
  });

  it("renders linked task running and pending states appropriately", async () => {
    await i18n.changeLanguage("zh-CN");
    const runningEvent = {
      ...wakeEvent({
        status: "completed",
        cause: "chiming_in",
        errorCode: null,
      }),
      task: {
        id: "task-103",
        status: "running" as const,
        errorCode: null,
      },
    };

    const { unmount } = render(<EventRecord event={runningEvent} conversation={conversation} />);
    expect(screen.getByText("正在处理")).toBeDefined();
    unmount();

    const pendingEvent = {
      ...wakeEvent({
        status: "completed",
        cause: "chiming_in",
        errorCode: null,
      }),
      task: {
        id: "task-104",
        status: "pending" as const,
        errorCode: null,
      },
    };

    render(<EventRecord event={pendingEvent} conversation={conversation} />);
    expect(screen.getByText("等待处理")).toBeDefined();
  });

  it("renders linked task cancelled, expired, and no_output states", async () => {
    await i18n.changeLanguage("zh-CN");
    const cancelledEvent = {
      ...wakeEvent({
        status: "completed",
        cause: "chiming_in",
      }),
      task: {
        id: "task-105",
        status: "cancelled" as const,
        errorCode: null,
      },
    };
    const { unmount: u1 } = render(
      <EventRecord event={cancelledEvent} conversation={conversation} />,
    );
    expect(screen.getByText("已取消")).toBeDefined();
    u1();

    const expiredEvent = {
      ...wakeEvent({
        status: "completed",
        cause: "chiming_in",
      }),
      task: {
        id: "task-106",
        status: "expired" as const,
        errorCode: null,
      },
    };
    const { unmount: u2 } = render(
      <EventRecord event={expiredEvent} conversation={conversation} />,
    );
    expect(screen.getByText("已到期")).toBeDefined();
    u2();

    const noOutputEvent = {
      ...wakeEvent({
        status: "completed",
        cause: "chiming_in",
      }),
      task: {
        id: "task-107",
        status: "no_output" as const,
        errorCode: null,
      },
    };
    render(<EventRecord event={noOutputEvent} conversation={conversation} />);
    expect(screen.getByText("本次未发言")).toBeDefined();
  });

  it("renders localized English labels for task states", async () => {
    await i18n.changeLanguage("en");
    const failedEvent = {
      ...wakeEvent({
        status: "completed",
        cause: "chiming_in",
      }),
      task: {
        id: "task-108",
        status: "failed" as const,
        errorCode: "QQ_TASK_FAILED",
      },
    };
    const { unmount: u1, container } = render(
      <EventRecord event={failedEvent} conversation={conversation} />,
    );
    expect(screen.getByText("Task processing failed")).toBeDefined();
    const destructiveEl = container.querySelector(".text-destructive");
    expect(destructiveEl?.textContent).toContain("QQ_TASK_FAILED");
    u1();

    const completedEvent = {
      ...wakeEvent({
        status: "completed",
        cause: "chiming_in",
      }),
      task: {
        id: "task-109",
        status: "completed" as const,
        errorCode: null,
      },
    };
    render(<EventRecord event={completedEvent} conversation={conversation} />);
    expect(screen.getByText("Task processing completed")).toBeDefined();
  });
  it("renders wake no_output + task completed + confirmed delivery without false '本次未发言', and does not treat pending/unknown as confirmed", async () => {
    await i18n.changeLanguage("zh-CN");
    const confirmedChainEvent = {
      ...wakeEvent({
        status: "no_output",
        cause: "direct_reply",
        errorCode: null,
      }),
      task: {
        id: "task-confirmed-1",
        status: "completed" as const,
        errorCode: null,
      },
      activityId: "act-confirmed-1",
      activityEvents: [
        {
          ...wakeEvent({ status: "no_output", cause: "direct_reply" }),
          seq: 11,
          kind: "delivery" as const,
          outputId: "out-actual",
          deliveryStatus: "confirmed" as const,
          text: "助手已送达的内容",
        },
      ],
    };

    const { unmount: u1 } = render(
      <EventRecord event={confirmedChainEvent} conversation={conversation} />,
    );

    // 应该展示任务处理完成和已送达，绝不可显示「本次未发言」
    expect(screen.getByText("任务处理完成")).toBeDefined();
    expect(screen.getByText("已送达")).toBeDefined();
    expect(screen.getByText("助手已送达的内容")).toBeDefined();
    expect(screen.queryByText("本次未发言")).toBeNull();
    u1();

    // 当 delivery 为 unknown / pending 时，不应该冒充「已送达」
    const pendingChainEvent = {
      ...wakeEvent({
        status: "no_output",
        cause: "direct_reply",
        errorCode: null,
      }),
      task: {
        id: "task-pending-1",
        status: "completed" as const,
        errorCode: null,
      },
      activityId: "act-pending-1",
      activityEvents: [
        {
          ...wakeEvent({ status: "no_output", cause: "direct_reply" }),
          seq: 12,
          kind: "delivery" as const,
          outputId: "out-pending",
          deliveryStatus: "delivering" as const,
          text: "发送中内容",
        },
      ],
    };

    render(<EventRecord event={pendingChainEvent} conversation={conversation} />);
    expect(screen.queryByText("已送达")).toBeNull();
    expect(screen.getByText(i18n.t("workspace.delivering"))).toBeDefined();
  });
});
