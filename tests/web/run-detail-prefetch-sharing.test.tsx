import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentStepSnapshot,
  InspectedContext,
  RunSnapshot,
} from "../../src/shared/contracts/agent-run";
import { api } from "../../src/web/api";
import { i18n } from "../../src/web/i18n/runtime";
import { RunAttempts, RunWorkspace } from "../../src/web/screens/runs/RunEntry";
import { useSuperstringStore as store } from "../../src/web/store";

// 用户 2026-10-17 最新要求（LATEST-BOTH-VIEWS-COLLAPSIBLE-REQUEST / RUN-LOCAL-PREFETCH-AND-TWO-BOARD-SHARING）：
// 运行详情加载时，两块看板共用的同一次模型调用证据在全部行收起的状态下就自动读取真实调用体（并发上限 3）；
// 切换选中步 / 切到步骤与技术追踪 / 展开任一行都只是视觉效果，不再发 inspect 请求；
// 状态只存在于当前组件内存，运行或 API 身份变化、窗口隐藏后旧响应不得发布到新作用域。

const origin = Date.parse("2026-10-17T00:00:00Z"),
  at = (ms: number) => new Date(origin + ms).toISOString();
const parentRunId = "10000000-0000-4000-8000-0000000000a1";
const EVIDENCE = i18n.t("observability.modelEvidence");
const STEPS = i18n.t("observability.modelSteps");
const SOURCE_ROWS = 1900;
const FULL_OUTPUT = `输出原文${"字".repeat(SOURCE_ROWS - 4)}`;

type Handle = { runId: string; stepId: string };
const keyOf = (handle: Handle) => `${handle.runId}|${handle.stepId}`;

const exactFor = (label: string, sources: number): InspectedContext => ({
  status: "exact",
  layout: [],
  sourceVersions: Array.from({ length: sources }, (_, i) => ({
    id: `src-${i + 1}`,
    revision: `r${i + 1}`,
  })),
  exactMessages: [{ role: "user", content: [{ kind: "text", text: `精确输入:${label}` }] }],
  result: { status: "exact", format: "text", text: `输出原文:${label}` },
});

const fullBody = (label: string): InspectedContext => ({
  ...exactFor(label, SOURCE_ROWS),
  result: {
    status: "exact",
    format: "text",
    text: FULL_OUTPUT,
    responses: [
      { transport: "stream", httpStatus: 200, finishReasons: ["stop"], doneMarker: true },
    ],
  },
});

function stepFor(runId: string, stepId: string, stepNo: number, model: string): AgentStepSnapshot {
  return {
    stepId,
    runId,
    stepNo,
    model,
    phase: "leaf",
    status: "completed",
    context: { runId, stepId },
    startedAt: at(10),
    endedAt: at(500),
    errorCode: null,
  };
}

function runSnapshot(runId: string, steps: AgentStepSnapshot[]): RunSnapshot {
  return {
    runId,
    specId: "onebot.main",
    specVersion: "1",
    owner: { kind: "conversation", id: "conv-1" },
    status: "completed",
    startedAt: at(0),
    endedAt: at(1000),
    errorCode: null,
    steps,
    lastSeq: 1,
    outputs: [],
  };
}

const emptyTracePage = () =>
  Promise.resolve({
    items: [],
    nextBeforeId: 0,
    hasMore: false,
    summary: {
      totalTraces: 0,
      activeTraces: 0,
      failedTraces: 0,
      matchedSpans: 0,
      lastActivityAt: at(1000),
      now: at(1000),
    },
  });

function inspectGate() {
  const calls: { handle: Handle; signal: AbortSignal }[] = [];
  const pending = new Map<string, ((value: InspectedContext) => void)[]>();
  let inflight = 0;
  let maxInflight = 0;
  const impl = vi.fn((handle: Handle, signal: AbortSignal) => {
    calls.push({ handle, signal });
    inflight += 1;
    maxInflight = Math.max(maxInflight, inflight);
    return new Promise<InspectedContext>((resolve) => {
      const key = keyOf(handle);
      pending.set(key, [
        ...(pending.get(key) ?? []),
        (value: InspectedContext) => {
          inflight -= 1;
          resolve(value);
        },
      ]);
    });
  });
  return {
    impl,
    calls,
    counts() {
      const counts = new Map<string, number>();
      for (const call of calls) {
        counts.set(keyOf(call.handle), (counts.get(keyOf(call.handle)) ?? 0) + 1);
      }
      return counts;
    },
    maxInflight: () => maxInflight,
    keys: () => new Set(calls.map((call) => keyOf(call.handle))),
    resolveKey(key: string, value?: InspectedContext) {
      for (const settle of pending.get(key) ?? []) settle(value ?? exactFor(key, 3));
      pending.delete(key);
    },
    settleAll() {
      for (const [key, queue] of pending) {
        for (const settle of queue) settle(exactFor(key, 3));
      }
      pending.clear();
    },
  };
}

function install(options: {
  run?: RunSnapshot;
  runs?: RunSnapshot[];
  inspect: ReturnType<typeof inspectGate>;
}) {
  const runs = options.runs ?? (options.run ? [options.run] : []);
  const getRun = vi.fn((runId: string) => {
    const snapshot = runs.find((item) => item.runId === runId) ?? runs[0];
    return Promise.resolve(snapshot as RunSnapshot);
  });
  store.getState().resetForTests({
    ...api,
    getRun,
    listRuns: vi.fn(() => Promise.resolve({ runs })),
    listRuntimeTraces: vi.fn(() => emptyTracePage()),
    inspectRunContext: options.inspect.impl,
  } as typeof api);
  return { getRun };
}

function sectionLabels() {
  return {
    output: i18n.t("observability.modelOutput"),
    input: i18n.t("observability.modelInput"),
    sources: i18n.t("observability.sourcesAndRevisions"),
  };
}

function stepButtons() {
  const group = screen.getByRole("group", { name: STEPS });
  return {
    group,
    named: (label: RegExp) => within(group).getByRole("button", { name: label }),
    all: () => within(group).getAllByRole("button"),
  };
}

const visibleRegions = () => screen.queryAllByRole("region", { name: EVIDENCE });

beforeEach(() => {
  void i18n.changeLanguage("zh-CN");
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("run detail prefetch and two-board sharing", () => {
  it("prefetches every own step body while all rows are closed and adds no request on step, view or row changes", async () => {
    const inspect = inspectGate();
    install({
      run: runSnapshot(parentRunId, [
        stepFor(parentRunId, "step-own-1", 1, "own-model-1"),
        stepFor(parentRunId, "step-own-2", 2, "own-model-2"),
      ]),
      inspect,
    });
    render(<RunWorkspace runId={parentRunId} />);

    expect(await screen.findByText("本运行已记录 2 次模型调用（不含子运行）")).toBeTruthy();
    // 两块看板共用的两次真实调用在加载时就发起，未选中的第二步同样预取
    await waitFor(() => expect(inspect.calls).toHaveLength(2));
    expect(inspect.keys()).toEqual(
      new Set([`${parentRunId}|step-own-1`, `${parentRunId}|step-own-2`]),
    );

    // 三行默认全部收起，输出在最前；收起时没有输出/输入/来源正文 DOM
    const labels = sectionLabels();
    inspect.resolveKey(`${parentRunId}|step-own-1`, exactFor("step-one", 3));
    inspect.resolveKey(`${parentRunId}|step-own-2`, exactFor("step-two", 3));
    await screen.findByRole("button", { name: labels.output });
    const rows = {
      output: screen.getByRole("button", { name: labels.output }),
      input: screen.getByRole("button", { name: labels.input }),
      sources: screen.getByRole("button", { name: labels.sources }),
    };
    for (const button of Object.values(rows)) {
      expect(button.getAttribute("aria-expanded")).toBe("false");
    }
    expect(
      rows.output.compareDocumentPosition(rows.input) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      rows.input.compareDocumentPosition(rows.sources) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(document.querySelectorAll("tbody tr")).toHaveLength(0);
    expect(screen.queryByText(/^精确输入:/)).toBeNull();

    // 读取结果只进入当前组件内存：概览只显示选中步且数据正确
    inspect.resolveKey(`${parentRunId}|step-own-1`, exactFor("step-one", 3));
    await waitFor(() => expect(visibleRegions()).toHaveLength(1));
    fireEvent.click(rows.input);
    expect(rows.input.getAttribute("aria-expanded")).toBe("true");
    expect(await screen.findByText("精确输入:step-one")).toBeTruthy();

    // 换选中步：纯视觉切换，不新增读取
    fireEvent.click(stepButtons().named(/步骤 2 · 单轮任务/));
    expect(
      stepButtons()
        .named(/步骤 2 · 单轮任务/)
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(visibleRegions()).toHaveLength(1);
    expect(inspect.calls).toHaveLength(2);

    // 切到步骤与技术追踪：同一份已挂载证据复用，不新增读取
    fireEvent.click(screen.getByRole("button", { name: i18n.t("observability.technicalDetails") }));
    expect(inspect.calls).toHaveLength(2);
    expect(visibleRegions()).toHaveLength(0);
    const stepOneOuter = screen.getByRole("button", { name: /步骤 1 · 单轮任务/ });
    expect(stepOneOuter.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(stepOneOuter);
    expect(stepOneOuter.getAttribute("aria-expanded")).toBe("true");
    expect(visibleRegions()).toHaveLength(1);
    expect(within(visibleRegions()[0]).getByText("精确输入:step-one")).toBeTruthy();
    expect(inspect.calls).toHaveLength(2);

    // 技术视图内层三行同样只是视觉效果，且已读内容直接可见
    const technicalRows = within(visibleRegions()[0]);
    const technicalOutput = technicalRows.getByRole("button", { name: labels.output });
    expect(technicalOutput.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(technicalOutput);
    expect(technicalOutput.getAttribute("aria-expanded")).toBe("true");
    expect(technicalRows.getByText("精确输入:step-one")).toBeTruthy();
    expect(inspect.calls).toHaveLength(2);
  });

  it("bounds actual concurrent bodies to three while completing every closed handle, and builds no source DOM until expanded", async () => {
    const inspect = inspectGate();
    const steps = [1, 2, 3, 4].map((n) =>
      stepFor(parentRunId, `step-own-${n}`, n, `own-model-${n}`),
    );
    install({ run: runSnapshot(parentRunId, steps), inspect });
    render(<RunWorkspace runId={parentRunId} />);

    expect(await screen.findByText("本运行已记录 4 次模型调用（不含子运行）")).toBeTruthy();
    // 四个调用都自动入队，但真实并发被现有作用域限制在 3
    await waitFor(() => expect(inspect.calls).toHaveLength(3));
    expect(inspect.maxInflight()).toBeLessThanOrEqual(3);

    // 第一步的正文先回来并释放槽位，被挡住的第四条才发起
    inspect.resolveKey(`${parentRunId}|step-own-1`, fullBody("rich"));
    await waitFor(() => expect(inspect.calls).toHaveLength(4));
    inspect.settleAll();
    await waitFor(() => expect(inspect.keys().size).toBe(4));
    for (const count of inspect.counts().values()) expect(count).toBe(1);
    expect(inspect.maxInflight()).toBeLessThanOrEqual(3);
    expect(inspect.calls).toHaveLength(4);

    // 全部收起：没有构建任何来源行，也没有输出正文
    expect(document.querySelectorAll("tbody tr")).toHaveLength(0);
    expect(screen.queryByText(FULL_OUTPUT)).toBeNull();
    const labels = sectionLabels();
    const sourcesRow = screen.getByRole("button", { name: labels.sources });
    expect(sourcesRow.getAttribute("aria-expanded")).toBe("false");

    // 展开展示已收到的全量 1900 行，首末都在，无截断，且不发新请求
    fireEvent.click(sourcesRow);
    expect(document.querySelectorAll("tbody tr")).toHaveLength(SOURCE_ROWS);
    expect(screen.getByText("src-1")).toBeTruthy();
    expect(screen.getByText(`src-${SOURCE_ROWS}`)).toBeTruthy();

    const outputRow = screen.getByRole("button", { name: labels.output });
    fireEvent.click(outputRow);
    expect(outputRow.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText(FULL_OUTPUT)).toBeTruthy();
    expect(screen.getByText('"stop"')).toBeTruthy();
    expect(inspect.calls).toHaveLength(4);
  });

  it("drops late bodies when the run identity changes or the window hides, and rereads only the new scope", async () => {
    const inspect = inspectGate();
    const oldRun = runSnapshot("run-old", [
      stepFor("run-old", "step-old-1", 1, "old-model-1"),
      stepFor("run-old", "step-old-2", 2, "old-model-2"),
    ]);
    const newRun: RunSnapshot = {
      ...runSnapshot("run-new", [stepFor("run-new", "step-new-1", 1, "new-model-1")]),
      startedAt: at(60000),
      owner: { kind: "memory_job", id: "job-one" },
    };
    install({ runs: [oldRun, newRun], inspect });
    render(<RunAttempts ownerKind="memory_job" ownerId="job-one" />);

    // 默认最新的新运行，其唯一一步在加载时自动读取
    await waitFor(() => expect(inspect.calls).toHaveLength(1));
    expect(inspect.calls[0].handle).toEqual({ runId: "run-new", stepId: "step-new-1" });

    // 切到旧运行：旧作用域被中断，旧响应迟到也不能发布
    const select = screen.getByRole("combobox", { name: i18n.t("observability.runAttempt") });
    fireEvent.change(select, { target: { value: "run-old" } });
    await waitFor(() => expect(inspect.calls).toHaveLength(3));
    expect(inspect.calls[0].signal.aborted).toBe(true);
    expect(new Set(inspect.calls.slice(1).map((call) => keyOf(call.handle)))).toEqual(
      new Set(["run-old|step-old-1", "run-old|step-old-2"]),
    );

    inspect.resolveKey("run-new|step-new-1", exactFor("late-old-run", 1));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByText("精确输入:late-old-run")).toBeNull();

    // 窗口隐藏：在飞的读取吊销并清空当前残留，隐藏期迟到的响应同样不发布
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    fireEvent(document, new Event("visibilitychange"));
    for (const call of inspect.calls.slice(1)) expect(call.signal.aborted).toBe(true);
    inspect.resolveKey("run-old|step-old-1", exactFor("hidden-late", 1));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByText("精确输入:hidden-late")).toBeNull();
    expect(document.querySelectorAll("tbody tr")).toHaveLength(0);

    // 回到前台只重读当前作用域，并渲染新响应
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() => expect(inspect.counts().get("run-old|step-old-1") ?? 0).toBe(2));
    inspect.resolveKey("run-old|step-old-1", exactFor("after-visible", 1));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByText("精确输入:hidden-late")).toBeNull();
    // 旧运行之外的 run-new 作用域不再被读取
    expect(inspect.counts().get("run-new|step-new-1")).toBe(1);
    expect(inspect.maxInflight()).toBeLessThanOrEqual(3);
  });

  it("prefetches one delivery for repeated output spans and does not read it again when a trace detail opens", async () => {
    const inspect = inspectGate();
    install({ run: runSnapshot(parentRunId, []), inspect });
    const traceId = "a".repeat(32);
    const base = {
      id: 1,
      traceId,
      spanId: "delivery-first",
      parentSpanId: null,
      name: "delivery.send",
      at: at(0),
      finishedAt: at(1),
      durationMs: 1,
      channel: "onebot11" as const,
      stage: "delivery" as const,
      status: "completed" as const,
      code: "DONE",
      model: null,
      conversationId: null,
      agentId: null,
      runId: parentRunId,
      wakeId: null,
      outputId: "same-output",
      sourceSeq: null,
      details: {},
    };
    const trace = {
      traceId,
      cursorId: 1,
      causes: [],
      specIds: [],
      root: base,
      at: at(0),
      lastActivityAt: at(1),
      finishedAt: at(1),
      durationMs: 1,
      status: "completed" as const,
      spanCount: 2,
      matchedSpanCount: 2,
      models: [],
      channels: ["onebot11" as const],
      runIds: [parentRunId],
      wakeIds: [],
    };
    const getDelivery = vi.fn(async () => ({
      id: "same-output",
      runId: parentRunId,
      conversationId: "conv-1",
      ordinal: 1,
      status: "confirmed" as const,
      sourceThroughSeq: 1,
      createdAt: at(0),
      deliverBy: at(1000),
      target: null,
      parts: [],
    }));
    store.getState().resetForTests({
      ...store.getState().apiClient,
      listRuntimeTraces: vi.fn(async () => ({
        items: [trace],
        nextBeforeId: 1,
        hasMore: false,
        summary: {
          totalTraces: 1,
          activeTraces: 0,
          failedTraces: 0,
          matchedSpans: 2,
          lastActivityAt: at(1),
          now: at(1),
        },
      })),
      getRuntimeWaterfall: vi.fn(async () => ({
        now: at(1),
        trace,
        items: [base, { ...base, id: 2, spanId: "delivery-second" }],
        matchedSpanIds: ["delivery-first", "delivery-second"],
      })),
      getDelivery,
    } as typeof api);
    render(<RunWorkspace runId={parentRunId} />);
    await waitFor(() => expect(getDelivery).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: i18n.t("observability.technicalDetails") }));
    const details = document.querySelectorAll("details");
    expect(details).toHaveLength(2);
    details.forEach((item) => {
      item.open = true;
    });
    expect(getDelivery).toHaveBeenCalledTimes(1);
  });
});
