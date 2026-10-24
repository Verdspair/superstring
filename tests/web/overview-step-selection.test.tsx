import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AgentStepSnapshot,
  InspectedContext,
  RunSnapshot,
} from "../../src/shared/contracts/agent-run";
import type {
  RuntimeSpan,
  RuntimeTrace,
  RuntimeTraceDetail,
} from "../../src/shared/contracts/runtime-observability";
import { api } from "../../src/web/api";
import { i18n } from "../../src/web/i18n/runtime";
import { RunAttempts, RunWorkspace } from "../../src/web/screens/runs/RunEntry";
import { useSuperstringStore as store } from "../../src/web/store";
import { render } from "./helpers/render-with-providers";

// 概览「选中的步骤」契约测试（REQUEST 2026-10-17：竖列步骤按钮，点击哪一步下面就显示该步的输入/输出详情）。
// 实现落地前本文件预期 RED（当前源码仍是全部卡片展开）；首失败保留，不因 RED 放宽断言。

const origin = Date.parse("2026-10-17T00:00:00Z"),
  at = (ms: number) => new Date(origin + ms).toISOString();
const parentRunId = "10000000-0000-4000-8000-0000000000a1";
const EVIDENCE = i18n.t("observability.modelEvidence");
const STEPS = i18n.t("observability.modelSteps");
const inspectGateLabel = i18n.t("observability.inspectActualInputAndOutput");
const hideGateLabel = i18n.t("observability.hideActualInputAndOutput");

const exactFor = (label: string, sources: number): InspectedContext => ({
  status: "exact",
  layout: [],
  sourceVersions: Array.from({ length: sources }, (_, i) => ({
    id: `src-${i + 1}`,
    revision: "r1",
  })),
  exactMessages: [{ role: "user", content: [{ kind: "text", text: `精确输入:${label}` }] }],
  result: { status: "exact", format: "json", text: `{"label":"${label}"}` },
});

function ownStep(stepId: string, stepNo: number, model = "own-model"): AgentStepSnapshot {
  return {
    stepId,
    runId: parentRunId,
    stepNo,
    model,
    phase: "leaf",
    status: "completed",
    context: { runId: parentRunId, stepId },
    startedAt: at(10),
    endedAt: at(500),
    errorCode: null,
  };
}

function runSnapshot(steps: AgentStepSnapshot[]): RunSnapshot {
  return {
    runId: parentRunId,
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

const childRunId = (n: number) => `20000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;

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

function span(
  id: number,
  start: number,
  end: number,
  patch: Partial<RuntimeSpan> = {},
): RuntimeSpan {
  return {
    id,
    traceId: "a".repeat(32),
    spanId: `span-${id}`,
    parentSpanId: null,
    name: "agent.model",
    at: at(start),
    finishedAt: at(end),
    durationMs: end - start,
    channel: "onebot11",
    stage: "model",
    status: "completed",
    code: "DONE",
    model: null,
    conversationId: null,
    agentId: null,
    runId: null,
    wakeId: null,
    outputId: null,
    sourceSeq: null,
    details: {},
    ...patch,
  };
}

function traceGroup(trace: {
  traceId: string;
  root: RuntimeSpan;
  runIds: string[];
  count: number;
}): RuntimeTrace {
  return {
    traceId: trace.traceId,
    cursorId: trace.root.id,
    root: trace.root,
    at: trace.root.at,
    lastActivityAt: at(1000),
    finishedAt: at(1000),
    durationMs: 1000,
    status: "completed",
    spanCount: trace.count,
    matchedSpanCount: trace.count,
    models: [],
    channels: ["onebot11"],
    runIds: trace.runIds,
    wakeIds: [],
    causes: [],
    specIds: [],
  };
}

/** 自主接话父 run 的真实形态（Root native 样本）：feedback 单 span 在前，ingress 父+子 runId 在后。 */
function feedbackTrace(id: number): { trace: RuntimeTrace; items: RuntimeSpan[] } {
  const traceId = `f${"0".repeat(30)}${id}`;
  const items = [
    span(1, 0, 30, {
      traceId,
      spanId: `${traceId}-1`,
      name: "bot.host.feedback",
      stage: "run",
      runId: parentRunId,
      details: { cause: "chiming_in" },
    }),
  ];
  return { trace: traceGroup({ traceId, root: items[0], runIds: [parentRunId], count: 1 }), items };
}

function ingressTrace(
  id: number,
  modelCount: number,
): { trace: RuntimeTrace; items: RuntimeSpan[] } {
  const traceId = `a${"0".repeat(30)}${id}`;
  let n = 0;
  const next = () => ++n;
  const items: RuntimeSpan[] = [
    span(next(), 0, 900, {
      traceId,
      spanId: `${traceId}-root`,
      name: "bot.ingress",
      stage: "ingress",
      runId: parentRunId,
      details: { kind: "group", addressed: true },
    }),
    span(next(), 10, 20, {
      traceId,
      spanId: `${traceId}-wake`,
      name: "bot.wake.activate",
      stage: "wake",
      runId: parentRunId,
      parentSpanId: `${traceId}-root`,
    }),
    span(next(), 20, 60, {
      traceId,
      spanId: `${traceId}-ctx`,
      name: "agent.context",
      stage: "context",
      runId: parentRunId,
      parentSpanId: `${traceId}-root`,
    }),
  ];
  for (let k = 1; k <= modelCount; k++) {
    items.push(
      span(next(), 100 + k * 40, 130 + k * 40, {
        traceId,
        spanId: `${traceId}-m${k}`,
        parentSpanId: `${traceId}-root`,
        name: "agent.model",
        stage: "model",
        model: `model-${traceId.slice(0, 4)}-${k}`,
        runId: childRunId(k),
        details: { stepId: `step-${traceId.slice(0, 4)}-${k}`, phase: "leaf", modelResolved: true },
      }),
    );
  }
  while (items.length < 25) {
    const k = next();
    items.push(
      span(k, 600 + k, 700 + k, {
        traceId,
        spanId: `${traceId}-x${k}`,
        name: "agent.action",
        stage: "action",
        runId: childRunId(1),
        parentSpanId: `${traceId}-root`,
      }),
    );
  }
  items.push(
    span(next(), 860, 900, {
      traceId,
      spanId: `${traceId}-delivery`,
      name: "delivery.send",
      stage: "delivery",
      runId: parentRunId,
      outputId: `out-${traceId.slice(0, 6)}`,
      parentSpanId: `${traceId}-root`,
    }),
  );
  const runIds = [
    ...new Set([parentRunId, ...(items.map((item) => item.runId).filter(Boolean) as string[])]),
  ];
  return { trace: traceGroup({ traceId, root: items[0], runIds, count: items.length }), items };
}

function deferred() {
  let resolve!: (value: InspectedContext) => void;
  const promise = new Promise<InspectedContext>((res) => (resolve = res));
  return { promise, resolve };
}

function inspectGate() {
  const calls: { handle: { runId: string; stepId: string }; signal: AbortSignal }[] = [];
  const pending = new Map<string, ReturnType<typeof deferred>[]>();
  const impl = vi.fn((handle: { runId: string; stepId: string }, signal: AbortSignal) => {
    calls.push({ handle, signal });
    const d = deferred();
    const key = `${handle.runId}|${handle.stepId}`;
    pending.set(key, [...(pending.get(key) ?? []), d]);
    return d.promise;
  });
  return {
    impl,
    calls,
    resolveKey(key: string, value?: InspectedContext) {
      for (const d of pending.get(key) ?? []) d.resolve(value ?? exactFor(key, 3));
      pending.delete(key);
    },
    settle(value?: InspectedContext) {
      for (const [key, queue] of pending) {
        let next = queue.shift();
        while (next) {
          next.resolve(value ?? exactFor(key, 3));
          next = queue.shift();
        }
      }
      pending.clear();
    },
  };
}

function install(options: {
  run: RunSnapshot;
  parts?: { trace: RuntimeTrace; items: RuntimeSpan[] }[];
  inspect: ReturnType<typeof inspectGate>;
}) {
  const details = new Map<string, RuntimeTraceDetail>();
  const pageItems = (options.parts ?? []).map((part) => {
    details.set(part.trace.traceId, {
      now: at(1000),
      trace: part.trace,
      items: part.items,
      matchedSpanIds: [],
    });
    return part.trace;
  });
  const getRun = vi.fn(() => Promise.resolve(options.run));
  const listRuntimeTraces = vi.fn((filters: { beforeId?: number }) => {
    if (!pageItems.length) return emptyTracePage();
    const index = filters.beforeId
      ? pageItems.findIndex((item) => item.cursorId === filters.beforeId)
      : 0;
    const items = pageItems.slice(index, index + 2);
    return Promise.resolve({
      items,
      nextBeforeId: items.at(-1)?.cursorId ?? 0,
      hasMore: index + 2 < pageItems.length,
      summary: {
        totalTraces: pageItems.length,
        activeTraces: 0,
        failedTraces: 0,
        matchedSpans: 0,
        lastActivityAt: at(1000),
        now: at(1000),
      },
    });
  });
  const getRuntimeWaterfall = vi.fn((traceId: string) => Promise.resolve(details.get(traceId)));
  store.getState().resetForTests({
    ...api,
    getRun,
    listRuntimeTraces,
    getRuntimeWaterfall,
    inspectRunContext: options.inspect.impl,
  } as typeof api);
  return { getRun, listRuntimeTraces, getRuntimeWaterfall };
}

function stepButtons() {
  const group = screen.getByRole("group", { name: STEPS });
  return {
    group,
    named: (label: RegExp) => within(group).getByRole("button", { name: label }),
    all: () => within(group).getAllByRole("button"),
  };
}

const ROW_LABELS = {
  output: i18n.t("observability.modelOutput"),
  input: i18n.t("observability.modelInput"),
  sources: i18n.t("observability.sourcesAndRevisions"),
} as const;
type EvidenceSection = keyof typeof ROW_LABELS;
/** 证据列表行默认关闭：用实际本地化按钮按需展开（幂等；展开只是视觉效果，零请求）。 */
function openEvidenceSections(
  scope: HTMLElement,
  sections: readonly EvidenceSection[] = ["output", "input", "sources"],
) {
  for (const section of sections) {
    const trigger = within(scope).getByRole("button", { name: ROW_LABELS[section] });
    if (trigger.getAttribute("aria-expanded") !== "true") fireEvent.click(trigger);
  }
}
beforeEach(() => {
  void i18n.changeLanguage("zh-CN");
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("overview step selection", () => {
  it("selects the first step by default, prefetches bounded evidence and shows its input/output when expanded", async () => {
    const inspect = inspectGate();
    install({
      run: runSnapshot([
        ownStep("step-own-1", 1, "own-model-1"),
        ownStep("step-own-2", 2, "own-model-2"),
        ownStep("step-own-3", 3, "own-model-3"),
      ]),
      inspect,
    });
    render(<RunWorkspace runId={parentRunId} />);

    expect(await screen.findByText("本运行已记录 3 次模型调用（不含子运行）")).toBeTruthy();

    const selector = stepButtons();
    expect(selector.all()).toHaveLength(3);
    const first = selector.named(/步骤 1 · 单轮任务/);
    expect(first.getAttribute("aria-pressed")).toBe("true");
    expect(selector.named(/步骤 2 · 单轮任务/).getAttribute("aria-pressed")).toBe("false");
    expect(selector.named(/步骤 3 · 单轮任务/).getAttribute("aria-pressed")).toBe("false");
    expect(first.textContent).toContain("own-model-1");

    // 运行加载即预取全部真实 handle（bounded 3），列表行默认关闭
    await waitFor(() =>
      expect(new Set(inspect.calls.map((call) => call.handle.stepId))).toEqual(
        new Set(["step-own-1", "step-own-2", "step-own-3"]),
      ),
    );
    const regions = screen.getAllByRole("region", { name: EVIDENCE });
    expect(regions).toHaveLength(1);
    inspect.settle();
    const region = screen.getByRole("region", { name: EVIDENCE });
    // 关闭态不挂载证据正文
    expect(within(region).queryByText(/^精确输入:/)).toBeNull();
    await within(region).findByRole("button", { name: ROW_LABELS.input });
    openEvidenceSections(region);
    await within(region).findByText(/^精确输入:/);
    expect(within(region).getByText(/^\{"label":/)).toBeTruthy();
    expect(within(region).getAllByText(/^src-\d+$/).length).toBeGreaterThan(0);
    // 展开只是视觉效果：零新请求
    await act(async () => {
      await Promise.resolve();
    });
    expect(inspect.calls).toHaveLength(3);

    // 无人工 inspect 门槛：查看/隐藏按钮不出现在概览
    expect(screen.queryByRole("button", { name: inspectGateLabel })).toBeNull();
    expect(screen.queryByRole("button", { name: hideGateLabel })).toBeNull();
  });

  it("clicking the second step swaps the details below with zero extra requests and keeps the other step's late evidence unrendered", async () => {
    const inspect = inspectGate();
    install({
      run: runSnapshot([
        ownStep("step-own-1", 1, "own-model-1"),
        ownStep("step-own-2", 2, "own-model-2"),
      ]),
      inspect,
    });
    render(<RunWorkspace runId={parentRunId} />);
    // 两个步骤的 handle 都在运行加载时预取（closed 也拉取，bounded 3）
    await waitFor(() =>
      expect(new Set(inspect.calls.map((call) => call.handle.stepId))).toEqual(
        new Set(["step-own-1", "step-own-2"]),
      ),
    );

    const selector = stepButtons();
    fireEvent.click(selector.named(/步骤 2 · 单轮任务/));
    expect(selector.named(/步骤 1 · 单轮任务/).getAttribute("aria-pressed")).toBe("false");
    expect(selector.named(/步骤 2 · 单轮任务/).getAttribute("aria-pressed")).toBe("true");

    // 选择切换是纯视觉切换：零新请求，也不中止运行内已拥有的读取
    await act(async () => {
      await Promise.resolve();
    });
    expect(inspect.calls).toHaveLength(2);
    expect(inspect.calls.every((call) => !call.signal.aborted)).toBe(true);

    // 第一步的迟到响应不得渲染
    inspect.resolveKey(`${parentRunId}|step-own-1`, exactFor("late-old-step", 1));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByText("精确输入:late-old-step")).toBeNull();
    expect(screen.getAllByRole("region", { name: EVIDENCE })).toHaveLength(1);

    // 第二步的证据在下方同一详情区渲染；列表行默认关闭，展开后正文可见
    inspect.resolveKey(`${parentRunId}|step-own-2`, exactFor("second-step", 1));
    const region = screen.getByRole("region", { name: EVIDENCE });
    await within(region).findByRole("button", { name: ROW_LABELS.input });
    openEvidenceSections(region);
    await within(region).findByText("精确输入:second-step");
    expect(within(region).getByText(/^\{"label":"second-step"\}/)).toBeTruthy();
    expect(screen.getAllByRole("region", { name: EVIDENCE })).toHaveLength(1);
  });

  it("keeps true parent/child graph discovery in overview: only real child model calls become steps, siblings never become buttons or reads", async () => {
    const inspect = inspectGate();
    const part = ingressTrace(2, 2);
    part.items.push(
      span(90, 200, 250, {
        traceId: part.trace.traceId,
        spanId: "foreign-sibling-model",
        parentSpanId: null,
        runId: "sibling-run",
        model: "sibling-model",
        details: { stepId: "sibling-step", phase: "next" },
      }),
    );
    install({ run: runSnapshot([]), parts: [feedbackTrace(1), part], inspect });
    render(<RunWorkspace runId={parentRunId} />);

    // 0-steps 父 run 不伪造 parent 调用；只有真实子调用成为步骤按钮（native 顺序，feedback 在前）
    expect(await screen.findByText("已记录 2 次模型调用，总数未确认")).toBeTruthy();
    await waitFor(() => expect(stepButtons().all()).toHaveLength(2));
    const first = stepButtons().named(/步骤 1 · 单轮任务/);
    expect(first.getAttribute("aria-pressed")).toBe("true");
    expect(first.textContent).toContain("model-a000-1");
    expect(stepButtons().named(/步骤 2 · 单轮任务/).textContent).toContain("model-a000-2");
    // 兄弟调用不是本 run 的子步骤：概览不收编、不展示、不读取
    expect(
      within(screen.getByRole("group", { name: STEPS })).queryByText("sibling-model"),
    ).toBeNull();

    // 两个真实子调用 handle 都在关闭态预取；sibling 永不读取
    await waitFor(() =>
      expect(new Set(inspect.calls.map((call) => call.handle.stepId))).toEqual(
        new Set(["step-a000-1", "step-a000-2"]),
      ),
    );
    for (const call of inspect.calls) {
      expect(call.handle.runId).not.toBe(parentRunId);
      expect(call.handle.runId).not.toBe("sibling-run");
    }
    inspect.settle();
    const region = screen.getByRole("region", { name: EVIDENCE });
    await within(region).findByRole("button", { name: ROW_LABELS.input });
    openEvidenceSections(region, ["input"]);
    await within(region).findByText(/^精确输入:/);
    // 打开列表行只是视觉效果：零新请求
    await act(async () => {
      await Promise.resolve();
    });
    expect(inspect.calls).toHaveLength(2);
  });

  it("technical view keeps every call and all traces: bounded prefetch completes while closed, step rows open visually, siblings stay visible", async () => {
    const inspect = inspectGate();
    const part = ingressTrace(2, 2);
    part.items.push(
      span(90, 200, 250, {
        traceId: part.trace.traceId,
        spanId: "foreign-sibling-model",
        parentSpanId: null,
        runId: "sibling-run",
        model: "sibling-model",
        details: { stepId: "sibling-step", phase: "next" },
      }),
    );
    install({
      run: runSnapshot([
        stepFor(parentRunId, "step-own-1", 1, "own-model-1"),
        stepFor(parentRunId, "step-own-2", 2, "own-model-2"),
      ]),
      parts: [feedbackTrace(1), part],
      inspect,
    });
    render(<RunWorkspace runId={parentRunId} />);
    expect(await screen.findByText("本运行已记录 2 次模型调用（不含子运行）")).toBeTruthy();
    // 全部真实 handle（own 2 + 真实子调用 2）在关闭态预取（bounded 3）
    const distinct = () =>
      new Set(inspect.calls.map((call) => `${call.handle.runId}|${call.handle.stepId}`));
    for (let seen = distinct().size; seen < 4; seen = distinct().size) {
      inspect.settle();
      await waitFor(() => expect(distinct().size).toBeGreaterThan(seen));
    }
    inspect.settle();

    fireEvent.click(screen.getByRole("button", { name: i18n.t("observability.technicalDetails") }));

    // 全部 waterfall 保留
    expect(
      await screen.findAllByRole("region", { name: i18n.t("observability.parentAndChildTiming") }),
    ).toHaveLength(2);
    // 技术视图默认 null：不预选 span，不显示证据；逐个选中，每次只显示一个共享详情
    const timing = screen.getAllByRole("region", {
      name: i18n.t("observability.parentAndChildTiming"),
    });
    expect(screen.queryAllByRole("region", { name: EVIDENCE })).toHaveLength(0);
    const callsBeforeOpen = inspect.calls.length;
    const stepGroup = screen.getByRole("group", { name: STEPS });
    const timelineModelRows = within(timing[1]).getAllByRole("button", {
      name: i18n.t("observability.viewInputOutputAndDetails"),
    });
    const childModelRows = timelineModelRows.filter((button) =>
      button.textContent?.includes("model-a000"),
    );
    const siblingRow = timelineModelRows.find((button) =>
      button.textContent?.includes("sibling-model"),
    );
    expect(timelineModelRows).toHaveLength(3);
    expect(childModelRows).toHaveLength(2);
    const selectable = [
      screen.getByRole("button", { name: /步骤 1 · 单轮任务/ }),
      screen.getByRole("button", { name: /步骤 2 · 单轮任务/ }),
      ...childModelRows,
    ];
    const expected = [
      `${parentRunId}|step-own-1`,
      `${parentRunId}|step-own-2`,
      `${childRunId(1)}|step-a000-1`,
      `${childRunId(2)}|step-a000-2`,
    ];
    expect(selectable).toHaveLength(4);
    for (const [index, row] of selectable.entries()) {
      fireEvent.click(row);
      expect(row.getAttribute("aria-pressed")).toBe("true");
      const pressed = [...timing, stepGroup].flatMap((scope) =>
        within(scope).queryAllByRole("button", { pressed: true }),
      );
      expect(pressed).toHaveLength(1);
      expect(pressed[0]).toBe(row);
      const regions = screen.getAllByRole("region", { name: EVIDENCE });
      expect(regions).toHaveLength(1);
      if (index > 0) {
        expect(within(regions[0]).queryByText(`精确输入:${expected[index - 1]}`)).toBeNull();
      }
      await within(regions[0]).findByRole("button", { name: ROW_LABELS.input });
      openEvidenceSections(regions[0], ["input"]);
      expect(await within(regions[0]).findByText(`精确输入:${expected[index]}`)).toBeTruthy();
      expect(within(regions[0]).getAllByText(/^精确输入:/)).toHaveLength(1);
    }
    expect(inspect.calls).toHaveLength(callsBeforeOpen);
    const counts = new Map<string, number>();
    for (const call of inspect.calls) {
      const key = `${call.handle.runId}|${call.handle.stepId}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
      expect(call.handle.runId).not.toBe("sibling-run");
    }
    // 单一 reader 按 handle 共享：4 个调用各读一次，切视图/打开行不再重读
    expect(counts.size).toBe(4);
    expect(counts.get(`${parentRunId}|step-own-1`)).toBe(1);
    expect(counts.get(`${parentRunId}|step-own-2`)).toBe(1);
    expect(counts.get(`${childRunId(1)}|step-a000-1`)).toBe(1);
    expect(counts.get(`${childRunId(2)}|step-a000-2`)).toBe(1);
    // sibling span 仍在技术时间线：可点击但不产生模型证据，也不新增读取
    expect(screen.getAllByText("sibling-model").length).toBeGreaterThan(0);
    expect(siblingRow).toBeTruthy();
    fireEvent.click(siblingRow!);
    expect(screen.queryAllByRole("region", { name: EVIDENCE })).toHaveLength(0);
    const siblingPressed = [...timing, stepGroup].flatMap((scope) =>
      within(scope).queryAllByRole("button", { pressed: true }),
    );
    expect(siblingPressed).toHaveLength(1);
    expect(siblingPressed[0]).toBe(siblingRow);
    expect(inspect.calls).toHaveLength(callsBeforeOpen);

    // 原始 operation name 只在选中真实 action span 并展开「运行与元数据」后出现
    const actionRow = within(timing[1])
      .getAllByRole("button", { name: i18n.t("observability.viewStepDetails") })
      .find((button) => button.textContent?.includes(i18n.t("observability.agentAction")));
    expect(actionRow).toBeTruthy();
    fireEvent.click(actionRow!);
    expect(screen.queryAllByRole("region", { name: EVIDENCE })).toHaveLength(0);
    const actionMetadata = screen
      .getByText(i18n.t("observability.runAndMetadata"))
      .closest("details") as HTMLDetailsElement;
    expect(actionMetadata.open).toBe(false);
    fireEvent.click(screen.getByText(i18n.t("observability.runAndMetadata")));
    expect(actionMetadata.open).toBe(true);
    expect(screen.getAllByText("agent.action").length).toBeGreaterThan(0);
    fireEvent.click(selectable[3]);
    const modelMetadata = screen
      .getByText(i18n.t("observability.runAndMetadata"))
      .closest("details") as HTMLDetailsElement;
    expect(modelMetadata.open).toBe(false);
    expect(screen.queryByText("agent.action")).toBeNull();
    expect(screen.getAllByRole("region", { name: EVIDENCE })).toHaveLength(1);
    expect(inspect.calls).toHaveLength(callsBeforeOpen);
    // 聚合计数保留；无展开/折叠全部步骤控件
    expect(screen.getByText("本运行已记录 2 次模型调用（不含子运行）")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: i18n.t("observability.expandAllSteps") }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: i18n.t("observability.collapseAllSteps") }),
    ).toBeNull();
  });

  it("switching attempts resets the selection to the first step of the new run and rejects late evidence from the old run", async () => {
    const inspect = inspectGate();
    const oldRun: RunSnapshot = {
      ...runSnapshot([
        stepFor("run-old", "step-old-1", 1, "old-model-1"),
        stepFor("run-old", "step-old-2", 2, "old-model-2"),
      ]),
      runId: "run-old",
      owner: { kind: "memory_job", id: "job-one" },
      startedAt: at(0),
    };
    const newRun: RunSnapshot = {
      ...runSnapshot([stepFor("run-new", "step-new-1", 1, "new-model-1")]),
      runId: "run-new",
      owner: { kind: "memory_job", id: "job-one" },
      startedAt: at(60000),
    };
    store.getState().resetForTests({
      ...api,
      listRuns: vi.fn(() => Promise.resolve({ runs: [oldRun, newRun] })),
      getRun: vi.fn((id: string) => Promise.resolve(id === "run-old" ? oldRun : newRun)),
      listRuntimeTraces: vi.fn(() => emptyTracePage()),
      inspectRunContext: inspect.impl,
    } as typeof api);
    render(<RunAttempts ownerKind="memory_job" ownerId="job-one" />);

    // 新 run 加载即预取其全部真实 handle
    await waitFor(() =>
      expect(new Set(inspect.calls.map((call) => call.handle.stepId))).toEqual(
        new Set(["step-new-1"]),
      ),
    );

    const select = screen.getByRole("combobox", { name: i18n.t("observability.runAttempt") });
    fireEvent.change(select, { target: { value: "run-old" } });
    // run 身份切换仍中止旧读取，并预取新 run 全部 handle
    await waitFor(() =>
      expect(new Set(inspect.calls.map((call) => call.handle.stepId))).toEqual(
        new Set(["step-new-1", "step-old-1", "step-old-2"]),
      ),
    );
    expect(inspect.calls[0].signal.aborted).toBe(true);
    expect(inspect.calls[0].handle.stepId).toBe("step-new-1");

    // 旧 run 的迟到响应被拒绝，新 run 第一步证据正常渲染
    inspect.resolveKey("run-new|step-new-1", exactFor("late-old-run", 1));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByText("精确输入:late-old-run")).toBeNull();
    inspect.resolveKey("run-old|step-old-1", exactFor("current-run", 1));
    const region = screen.getByRole("region", { name: EVIDENCE });
    await within(region).findByRole("button", { name: ROW_LABELS.input });
    openEvidenceSections(region, ["input"]);
    await within(region).findByText("精确输入:current-run");
    // 打开列表行只是视觉效果：零新请求
    await act(async () => {
      await Promise.resolve();
    });
    expect(inspect.calls).toHaveLength(3);
  });

  it("refresh re-reads run and traces once and rechecks every prefetched run handle without duplicate regions", async () => {
    const inspect = inspectGate();
    const mocks = install({
      run: runSnapshot([
        stepFor(parentRunId, "step-own-1", 1, "own-model-1"),
        stepFor(parentRunId, "step-own-2", 2, "own-model-2"),
      ]),
      inspect,
    });
    render(<RunWorkspace runId={parentRunId} />);
    expect(await screen.findByText("本运行已记录 2 次模型调用（不含子运行）")).toBeTruthy();
    // 全部真实 handle 关闭态预取
    await waitFor(() =>
      expect(new Set(inspect.calls.map((call) => call.handle.stepId))).toEqual(
        new Set(["step-own-1", "step-own-2"]),
      ),
    );
    // 选择切换纯视觉：零新请求
    fireEvent.click(stepButtons().named(/步骤 2 · 单轮任务/));
    await act(async () => {
      await Promise.resolve();
    });
    expect(inspect.calls).toHaveLength(2);
    inspect.resolveKey(`${parentRunId}|step-own-2`, exactFor("before-refresh", 1));
    const region = screen.getByRole("region", { name: EVIDENCE });
    await within(region).findByRole("button", { name: ROW_LABELS.input });
    openEvidenceSections(region, ["input"]);
    await within(region).findByText("精确输入:before-refresh");

    const getRunCalls = mocks.getRun.mock.calls.length;
    const listCalls = mocks.listRuntimeTraces.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: i18n.t("observability.refreshRuns") }));

    await waitFor(() => expect(mocks.getRun.mock.calls.length).toBe(getRunCalls + 1));
    await waitFor(() => expect(mocks.listRuntimeTraces.mock.calls.length).toBe(listCalls + 1));
    await waitFor(() =>
      expect(inspect.calls.filter((call) => call.handle.stepId === "step-own-2")).toHaveLength(2),
    );
    // 刷新重核全部已预取的当前 handle（每个 +1）
    await waitFor(() =>
      expect(inspect.calls.filter((call) => call.handle.stepId === "step-own-1")).toHaveLength(2),
    );
    expect(screen.getAllByRole("region", { name: EVIDENCE })).toHaveLength(1);
    inspect.resolveKey(`${parentRunId}|step-own-2`, exactFor("after-refresh", 1));
    await within(screen.getByRole("region", { name: EVIDENCE })).findByRole("button", {
      name: ROW_LABELS.input,
    });
    openEvidenceSections(screen.getByRole("region", { name: EVIDENCE }), ["input"]);
    await within(screen.getByRole("region", { name: EVIDENCE })).findByText(
      "精确输入:after-refresh",
    );
    expect(screen.queryByText("精确输入:before-refresh")).toBeNull();
  });
});
