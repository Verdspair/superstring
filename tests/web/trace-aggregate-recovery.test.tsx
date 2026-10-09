// Trace aggregate recovery & latest wake outcome presentation tests.
//
// 验证规则：
// 1. 不把聚合 StatusMark failed 替换成 completed，避免 filter 语义漂移；保留原聚合与失败数字。
// 2. 追加唯一 latest wake outcome 摘要「最近尝试已完成（第 N 次）」，使用真实 wake activate 尝试来源。
// 3. 多个 wake、无 wake 或部分 wakeId 为空/未知明确不覆盖聚合（返回 null），不把任一 child success 当作整个 trace 修复成功。
// 4. 最新尝试为进行中（started）时不报告已完成（返回 null）。
// 5. 自然呈现任务用途（复用 traceTask 与 traceCause 标签），不泄露私信内容。

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  RuntimeSpan,
  RuntimeTrace,
  RuntimeTraceDetail,
} from "../../src/shared/contracts/runtime-observability";
import { api } from "../../src/web/api";
import { i18n } from "../../src/web/i18n/runtime";
import { InvestigationCanvas } from "../../src/web/screens/observability/InvestigationCanvas";
import { latestWakeOutcome } from "../../src/web/screens/observability/presentation";
import { useSuperstringStore as store } from "../../src/web/store";

// 合成 32 字符十六进制标识，不使用实际会话报告 ID
const traceId = "11111111222222223333333344444444";
const now = "2026-10-09T13:00:00Z";

function makeSpan(overrides: Partial<RuntimeSpan> = {}): RuntimeSpan {
  return {
    id: 1,
    traceId,
    spanId: "span-1",
    parentSpanId: null,
    name: "bot.ingress",
    at: "2026-10-09T12:54:17.000Z",
    finishedAt: "2026-10-09T12:54:17.010Z",
    durationMs: 10,
    channel: "onebot11",
    stage: "ingress",
    status: "completed",
    code: "INGRESS_RECORDED",
    model: null,
    conversationId: "conv-1",
    agentId: "agent-1",
    runId: null,
    wakeId: null,
    outputId: null,
    sourceSeq: 1,
    details: {},
    ...overrides,
  };
}

describe("Trace aggregate recovery & latest wake presentation", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("zh-CN");
  });

  afterEach(() => {
    cleanup();
  });

  describe("latestWakeOutcome helper", () => {
    it("returns latest wake attempt completed outcome for single wake with retries", () => {
      const items: RuntimeSpan[] = [
        makeSpan({ id: 1, spanId: "s1", name: "bot.ingress", stage: "ingress" }),
        makeSpan({
          id: 2,
          spanId: "s2",
          name: "bot.wake.activate",
          stage: "wake",
          status: "failed",
          code: "CONTEXT_INVALID_SELECTION",
          wakeId: "wake-1",
          details: { attempt: 1 },
        }),
        makeSpan({
          id: 3,
          spanId: "s3",
          name: "bot.wake.activate",
          stage: "wake",
          status: "failed",
          code: "CONTEXT_INVALID_SELECTION",
          wakeId: "wake-1",
          details: { attempt: 2 },
        }),
        makeSpan({
          id: 4,
          spanId: "s4",
          name: "bot.wake.activate",
          stage: "wake",
          status: "completed",
          code: "WAKE_SETTLED",
          wakeId: "wake-1",
          details: { attempt: 3 },
        }),
      ];

      const outcome = latestWakeOutcome(items, i18n.t.bind(i18n));
      expect(outcome).toBe("最近尝试已完成（第 3 次）");
    });

    it("returns null if there are multiple distinct wakes (ambiguous, never infer whole trace success)", () => {
      const items: RuntimeSpan[] = [
        makeSpan({
          id: 2,
          spanId: "s2",
          name: "bot.wake.activate",
          stage: "wake",
          status: "failed",
          wakeId: "wake-1",
          details: { attempt: 1 },
        }),
        makeSpan({
          id: 3,
          spanId: "s3",
          name: "bot.wake.activate",
          stage: "wake",
          status: "completed",
          wakeId: "wake-2",
          details: { attempt: 1 },
        }),
      ];

      const outcome = latestWakeOutcome(items, i18n.t.bind(i18n));
      expect(outcome).toBeNull();
    });

    it("returns null if any wake activate span has null or missing wakeId", () => {
      const allNull: RuntimeSpan[] = [
        makeSpan({
          id: 2,
          spanId: "s2",
          name: "bot.wake.activate",
          stage: "wake",
          status: "completed",
          wakeId: null,
          details: { attempt: 1 },
        }),
      ];
      expect(latestWakeOutcome(allNull, i18n.t.bind(i18n))).toBeNull();

      const partiallyNull: RuntimeSpan[] = [
        makeSpan({
          id: 2,
          spanId: "s2",
          name: "bot.wake.activate",
          stage: "wake",
          status: "failed",
          wakeId: "wake-1",
          details: { attempt: 1 },
        }),
        makeSpan({
          id: 3,
          spanId: "s3",
          name: "bot.wake.activate",
          stage: "wake",
          status: "completed",
          wakeId: null,
          details: { attempt: 2 },
        }),
      ];
      expect(latestWakeOutcome(partiallyNull, i18n.t.bind(i18n))).toBeNull();
    });

    it("returns null when latest attempt is still in progress (started)", () => {
      const items: RuntimeSpan[] = [
        makeSpan({
          id: 2,
          spanId: "s2",
          name: "bot.wake.activate",
          stage: "wake",
          status: "failed",
          wakeId: "wake-1",
          details: { attempt: 1 },
        }),
        makeSpan({
          id: 3,
          spanId: "s3",
          name: "bot.wake.activate",
          stage: "wake",
          status: "started",
          wakeId: "wake-1",
          details: { attempt: 2 },
        }),
      ];

      const outcome = latestWakeOutcome(items, i18n.t.bind(i18n));
      expect(outcome).toBeNull();
    });

    it("returns latest attempt failed outcome when latest attempt failed", () => {
      const items: RuntimeSpan[] = [
        makeSpan({
          id: 2,
          spanId: "s2",
          name: "bot.wake.activate",
          stage: "wake",
          status: "failed",
          wakeId: "wake-1",
          details: { attempt: 1 },
        }),
      ];

      const outcome = latestWakeOutcome(items, i18n.t.bind(i18n));
      expect(outcome).toBe("最近尝试失败（第 1 次）");
    });

    it("returns null if there are no wake activate spans", () => {
      const items: RuntimeSpan[] = [
        makeSpan({ id: 1, spanId: "s1", name: "bot.ingress", stage: "ingress" }),
      ];

      const outcome = latestWakeOutcome(items, i18n.t.bind(i18n));
      expect(outcome).toBeNull();
    });

    it("localizes in English", async () => {
      await i18n.changeLanguage("en");
      const items: RuntimeSpan[] = [
        makeSpan({
          id: 2,
          spanId: "s2",
          name: "bot.wake.activate",
          stage: "wake",
          status: "completed",
          wakeId: "wake-1",
          details: { attempt: 3 },
        }),
      ];

      const outcome = latestWakeOutcome(items, i18n.t.bind(i18n));
      expect(outcome).toBe("Latest attempt completed (attempt 3)");
    });
  });

  describe("InvestigationCanvas header presentation", () => {
    it("preserves aggregate failed StatusMark while displaying latest wake completed outcome", async () => {
      await i18n.changeLanguage("zh-CN");

      const trace: RuntimeTrace = {
        traceId,
        cursorId: 1,
        causes: ["direct_reply"],
        specIds: ["onebot.main"],
        root: makeSpan(),
        at: "2026-10-09T12:54:17.000Z",
        lastActivityAt: "2026-10-09T13:02:54.000Z",
        finishedAt: "2026-10-09T13:02:54.000Z",
        durationMs: 517000,
        status: "failed", // 聚合状态依然是 failed，保留服务端语义
        spanCount: 4,
        matchedSpanCount: 4,
        models: ["glm-4-flash"],
        channels: ["onebot11"],
        runIds: ["run-1"],
        wakeIds: ["wake-1"],
      };

      const items: RuntimeSpan[] = [
        makeSpan({ id: 1, spanId: "s1" }),
        makeSpan({
          id: 2,
          spanId: "s2",
          name: "bot.wake.activate",
          stage: "wake",
          status: "failed",
          wakeId: "wake-1",
          details: { attempt: 1 },
        }),
        makeSpan({
          id: 3,
          spanId: "s3",
          name: "bot.wake.activate",
          stage: "wake",
          status: "failed",
          wakeId: "wake-1",
          details: { attempt: 2 },
        }),
        makeSpan({
          id: 4,
          spanId: "s4",
          name: "bot.wake.activate",
          stage: "wake",
          status: "completed",
          wakeId: "wake-1",
          details: { attempt: 3 },
        }),
      ];

      const detail: RuntimeTraceDetail = {
        now,
        trace,
        items,
        matchedSpanIds: items.map((i) => i.spanId),
      };

      store.getState().resetForTests({
        ...api,
        getRuntimeWaterfall: vi.fn().mockResolvedValue(detail),
      });

      render(<InvestigationCanvas traceId={traceId} filters={{}} onBack={vi.fn()} />);

      // 等待标题渲染
      const heading = await screen.findByRole("heading", { level: 2 });
      expect(heading.textContent).toContain("OneBot 主 Agent");

      // 1. 顶部 Header 里的聚合状态依然显示「处理失败」，不可被替换成已完成
      const header = heading.closest("header");
      expect(header).not.toBeNull();
      if (!header) throw new Error("Header not found");
      expect(within(header).getByText("处理失败")).toBeDefined();

      // 2. 独立呈现最新 wake 尝试摘要
      expect(within(header).getByText("最近尝试已完成（第 3 次）")).toBeDefined();

      // 3. 自然展现任务用途：spec 与 cause 标签
      expect(within(header).getByText("直接回应")).toBeDefined();
    });
  });
});
