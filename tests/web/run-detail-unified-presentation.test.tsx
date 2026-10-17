import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
import {
  InspectedEvidence,
  ModelEvidence,
} from "../../src/web/screens/observability/ModelEvidence";
import { RunWorkspace } from "../../src/web/screens/runs/RunEntry";
import { useSuperstringStore as store } from "../../src/web/store";

const origin = Date.parse("2026-10-17T00:00:00Z"),
  at = (ms: number) => new Date(origin + ms).toISOString();
const parentRunId = "10000000-0000-4000-8000-0000000000a1";
const childRunId = (n: number) => `20000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;
const EVIDENCE = i18n.t("observability.modelEvidence");
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
/** 自主接话父 run 的真实形态（Root native 样本）：feedback 单 span 在前，ingress 26 span（父+子 runId）在后。 */
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
function ownStep(stepId: string, stepNo: number): AgentStepSnapshot {
  return {
    stepId,
    runId: parentRunId,
    stepNo,
    model: "own-model",
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
function install(options: {
  run: RunSnapshot;
  parts: { trace: RuntimeTrace; items: RuntimeSpan[] }[];
  inspect: ReturnType<typeof inspectGate>;
}) {
  const details = new Map<string, RuntimeTraceDetail>();
  const pageItems = options.parts.map((part) => {
    details.set(part.trace.traceId, {
      now: at(1000),
      trace: part.trace,
      items: part.items,
      matchedSpanIds: [],
    });
    return part.trace;
  });
  const read = vi.fn((filters: { beforeId?: number }) => {
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
  store.getState().resetForTests({
    ...api,
    getRun: vi.fn(() => Promise.resolve(options.run)),
    listRuntimeTraces: read,
    getRuntimeWaterfall: vi.fn((traceId: string) => Promise.resolve(details.get(traceId))),
    inspectRunContext: options.inspect.impl,
  } as typeof api);
}
beforeEach(() => {
  void i18n.changeLanguage("zh-CN");
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
describe("run detail unified presentation", () => {
  it("attributes every associated trace to the parent run in native order: feedback first, child model calls with their true owner second", async () => {
    const inspect = inspectGate();
    const feedback = feedbackTrace(1);
    const ingress = ingressTrace(2, 8);
    install({ run: runSnapshot([]), parts: [feedback, ingress], inspect });
    render(<RunWorkspace runId={parentRunId} />);
    fireEvent.click(
      await screen.findByRole("button", { name: i18n.t("observability.technicalDetails") }),
    );
    expect((await screen.findAllByText("model-a000-1")).length).toBeGreaterThan(0);
    await waitFor(() => expect(inspect.calls.length).toBeGreaterThan(0));
    expect(inspect.calls.length).toBeLessThanOrEqual(3);
    for (let completed = 0; completed < 8; completed = inspect.calls.length) {
      inspect.settle();
      if (completed < 8) {
        await waitFor(() => expect(inspect.calls.length).toBeGreaterThan(completed));
      }
    }
    inspect.settle();
    // 技术视图默认 null：不预选 span，也不显示模型证据；8 个真实 handle 仍各读一次
    expect(screen.queryAllByRole("region", { name: EVIDENCE })).toHaveLength(0);
    const modelRows = screen
      .getAllByRole("region", { name: i18n.t("observability.parentAndChildTiming") })
      .flatMap((region) =>
        within(region).queryAllByRole("button", {
          name: i18n.t("observability.viewInputOutputAndDetails"),
        }),
      );
    expect(modelRows).toHaveLength(8);
    const callsBeforeSelect = inspect.calls.length;
    fireEvent.click(modelRows[0]);
    expect(screen.getAllByRole("region", { name: EVIDENCE })).toHaveLength(1);
    expect(modelRows[0].getAttribute("aria-pressed")).toBe("true");
    expect(inspect.calls).toHaveLength(callsBeforeSelect);
    for (const call of inspect.calls) {
      expect(call.handle.runId).not.toBe(parentRunId);
      expect(call.handle.runId).toMatch(/^20000000/);
      expect(call.handle.stepId).toMatch(/^step-a000/);
    }
    expect(
      new Set(inspect.calls.map((call) => `${call.handle.runId}|${call.handle.stepId}`)).size,
    ).toBe(8);
  });
  it("selects the first recorded step by default in the overview, prefetches every call while closed, and moves selection without extra requests", async () => {
    const inspect = inspectGate();
    install({
      run: runSnapshot([ownStep("step-own-1", 1), ownStep("step-own-2", 2)]),
      parts: [],
      inspect,
    });
    render(<RunWorkspace runId={parentRunId} />);
    const evidence = await screen.findAllByRole("region", { name: EVIDENCE });
    expect(evidence).toHaveLength(1);
    // 全部真实 handle 关闭态预取（bounded 3）
    await waitFor(() =>
      expect(new Set(inspect.calls.map((call) => call.handle.stepId))).toEqual(
        new Set(["step-own-1", "step-own-2"]),
      ),
    );
    const stepName = (no: number) =>
      i18n.t("observability.stepValueValue", {
        "0": no,
        "1": i18n.t("observability.singleTurnTask"),
      });
    const first = screen.getByRole("button", { name: stepName(1) });
    const second = screen.getByRole("button", { name: stepName(2) });
    expect(first.getAttribute("aria-pressed")).toBe("true");
    expect(second.getAttribute("aria-pressed")).toBe("false");
    expect(second.getAttribute("data-step-id")).toBe("step-own-2");
    fireEvent.click(second);
    expect(second.getAttribute("aria-pressed")).toBe("true");
    expect(first.getAttribute("aria-pressed")).toBe("false");
    // 选择切换是纯视觉切换：零新请求、不中止运行内已拥有的读取
    expect(inspect.calls.every((call) => !call.signal.aborted)).toBe(true);
    inspect.settle(exactFor("own", 1900));
    const selected = await screen.findAllByRole("region", { name: EVIDENCE });
    expect(selected).toHaveLength(1);
    // 列表行默认关闭：关闭态无正文、1900 行 sources 不建 DOM
    expect(within(selected[0]).queryByText(/^精确输入:/)).toBeNull();
    expect(within(selected[0]).queryByText("src-1900")).toBeNull();
    await within(selected[0]).findByRole("button", { name: ROW_LABELS.output });
    openEvidenceSections(selected[0]);
    await within(selected[0]).findByText(/^精确输入:/);
    expect(within(selected[0]).getByText(/^\{"label":/)).toBeTruthy();
    expect(within(selected[0]).getAllByText(/^src-\d+$/)).toHaveLength(1900);
    expect(within(selected[0]).getByText("src-1")).toBeTruthy();
    expect(within(selected[0]).getByText("src-1900")).toBeTruthy();
    // 展开只是视觉效果：零新请求
    expect(inspect.calls).toHaveLength(2);
    expect(
      within(selected[0]).queryByRole("button", { name: i18n.t("observability.expandReader") }),
    ).toBeNull();
    expect(
      within(selected[0]).queryByRole("button", {
        name: i18n.t("observability.inspectActualInputAndOutput"),
      }),
    ).toBeNull();
  });

  it("keeps all three sections as independent default-closed rows in full evidence mode without changing lazy standalone tabs", () => {
    const value = exactFor("full", 1900);
    render(<InspectedEvidence value={value} fullEvidence />);
    // 默认关闭：正文不挂载，1900 行 sources 不建 DOM
    expect(screen.queryByText(/^精确输入:/)).toBeNull();
    expect(screen.queryByText('{"label":"full"}')).toBeNull();
    expect(screen.queryByText("src-1900")).toBeNull();
    expect(
      screen
        .getByRole("button", { name: i18n.t("observability.modelOutput") })
        .getAttribute("aria-expanded"),
    ).toBe("false");
    expect(
      screen
        .getByRole("button", { name: i18n.t("observability.modelInput") })
        .getAttribute("aria-expanded"),
    ).toBe("false");
    expect(
      screen
        .getByRole("button", { name: i18n.t("observability.sourcesAndRevisions") })
        .getAttribute("aria-expanded"),
    ).toBe("false");
    openEvidenceSections(document.body);
    expect(screen.getByText("精确输入:full")).toBeTruthy();
    expect(screen.getByText('{"label":"full"}')).toBeTruthy();
    expect(screen.getByText("src-1")).toBeTruthy();
    expect(screen.getByText("src-1900")).toBeTruthy();
    expect(screen.queryByRole("tab")).toBeNull();
  });

  it("clears an automatic inspection on hide, rejects its late result and resumes without another click", async () => {
    const inspect = inspectGate();
    install({ run: runSnapshot([]), parts: [], inspect });
    const mounted = render(
      <ModelEvidence
        handle={{ runId: parentRunId, stepId: "step-visibility" }}
        embedded
        fullEvidence
      />,
    );
    await waitFor(() => expect(inspect.calls).toHaveLength(1));
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    fireEvent(document, new Event("visibilitychange"));
    expect(inspect.calls[0].signal.aborted).toBe(true);
    inspect.settle(exactFor("hidden-late", 1));
    await Promise.resolve();
    expect(screen.queryByText("精确输入:hidden-late")).toBeNull();
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() => expect(inspect.calls).toHaveLength(2));
    inspect.settle(exactFor("visible-current", 1));
    // 列表行默认关闭：打开输入行后正文可见
    await screen.findByRole("button", { name: i18n.t("observability.modelInput") });
    openEvidenceSections(document.body, ["input"]);
    expect(await screen.findByText("精确输入:visible-current")).toBeTruthy();
    mounted.unmount();
  });

  it("opens the technical waterfall and every step's evidence without inspect or expand controls", async () => {
    const inspect = inspectGate();
    const part = ingressTrace(2, 2);
    part.items = part.items.map((item) => ({ ...item, outputId: null }));
    install({ run: runSnapshot([]), parts: [feedbackTrace(1), part], inspect });
    render(<RunWorkspace runId={parentRunId} />);
    fireEvent.click(
      await screen.findByRole("button", { name: i18n.t("observability.technicalDetails") }),
    );
    expect(
      await screen.findAllByRole("region", { name: i18n.t("observability.parentAndChildTiming") }),
    ).toHaveLength(2);
    await waitFor(() => expect(inspect.calls.length).toBeGreaterThanOrEqual(2));
    inspect.settle(exactFor("technical", 2));
    // 技术视图默认 null；选中一个时间线模型行后只显示一个共享详情
    expect(screen.queryAllByRole("region", { name: EVIDENCE })).toHaveLength(0);
    const timing = screen.getAllByRole("region", {
      name: i18n.t("observability.parentAndChildTiming"),
    });
    expect(timing).toHaveLength(2);
    const firstModelRow = within(timing[1])
      .getAllByRole("button", { name: i18n.t("observability.viewInputOutputAndDetails") })
      .find((button) => button.textContent?.includes("model-a000-1"));
    expect(firstModelRow).toBeTruthy();
    fireEvent.click(firstModelRow!);
    const regions = screen.getAllByRole("region", { name: EVIDENCE });
    expect(regions).toHaveLength(1);
    await within(regions[0]).findByRole("button", { name: ROW_LABELS.input });
    openEvidenceSections(regions[0], ["input"]);
    await waitFor(() => expect(screen.getAllByText("精确输入:technical")).toHaveLength(1));
    expect(
      screen.queryByRole("button", { name: i18n.t("observability.inspectActualInputAndOutput") }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: i18n.t("observability.expandAllSteps") }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: i18n.t("observability.collapseAllSteps") }),
    ).toBeNull();
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
    fireEvent.click(firstModelRow!);
    const modelMetadata = screen
      .getByText(i18n.t("observability.runAndMetadata"))
      .closest("details") as HTMLDetailsElement;
    expect(modelMetadata.open).toBe(false);
    expect(screen.queryByText("agent.action")).toBeNull();
    expect(screen.getAllByRole("region", { name: EVIDENCE })).toHaveLength(1);
    expect(inspect.calls.every(({ handle }) => handle.runId !== parentRunId)).toBe(true);
  });

  it("refreshes protected evidence explicitly and rechecks every prefetched run handle", async () => {
    const inspect = inspectGate();
    install({ run: runSnapshot([ownStep("refresh-step", 1)]), parts: [], inspect });
    render(<RunWorkspace runId={parentRunId} />);
    // 关闭态预取
    await waitFor(() => expect(inspect.calls).toHaveLength(1));
    inspect.settle(exactFor("before-refresh", 1));
    await screen.findByRole("button", { name: i18n.t("observability.modelInput") });
    openEvidenceSections(document.body, ["input"]);
    await screen.findByText("精确输入:before-refresh");
    // 视图切换纯视觉：单一 reader 按 handle 共享，零新请求
    fireEvent.click(screen.getByRole("button", { name: i18n.t("observability.technicalDetails") }));
    expect(inspect.calls).toHaveLength(1);
    // 无时间线 span 的 own call 用既有步骤标签回退，选中后只显示一个共享详情
    const fallback = screen.getByRole("button", { name: /步骤 1 · 单轮任务/ });
    fireEvent.click(fallback);
    expect(fallback.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getAllByRole("region", { name: EVIDENCE })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: i18n.t("observability.refreshRuns") }));
    // 刷新重核全部已预取的当前 handle
    await waitFor(() => expect(inspect.calls).toHaveLength(2));
    inspect.settle(exactFor("after-refresh", 1));
    await screen.findByRole("button", { name: i18n.t("observability.modelInput") });
    openEvidenceSections(document.body, ["input"]);
    expect(await screen.findByText("精确输入:after-refresh")).toBeTruthy();
    expect(screen.queryByText("精确输入:before-refresh")).toBeNull();
  });

  it("does not attribute a shared trace's sibling model call to the selected run", async () => {
    const inspect = inspectGate();
    const part = ingressTrace(2, 1);
    const sibling = span(90, 200, 250, {
      traceId: part.trace.traceId,
      spanId: "foreign-sibling-model",
      parentSpanId: null,
      runId: "sibling-run",
      model: "sibling-model",
      details: { stepId: "sibling-step", phase: "next" },
    });
    part.items.push(sibling);
    part.items = part.items.map((item) => ({ ...item, outputId: null }));
    install({ run: runSnapshot([]), parts: [part], inspect });
    render(<RunWorkspace runId={parentRunId} />);
    await screen.findByRole("button", { name: "步骤 1 · 单轮任务" });
    expect(
      within(screen.getByRole("group", { name: i18n.t("observability.modelSteps") })).queryByText(
        "sibling-model",
      ),
    ).toBeNull();
    await waitFor(() => expect(inspect.calls).toHaveLength(1));
    expect(inspect.calls[0].handle.runId).toBe(childRunId(1));
    fireEvent.click(screen.getByRole("button", { name: i18n.t("observability.technicalDetails") }));
    expect((await screen.findAllByText("sibling-model")).length).toBeGreaterThan(0);
    // 视图切换纯视觉：共享 reader 零新请求，兄弟调用永不读取
    expect(inspect.calls).toHaveLength(1);
    expect(inspect.calls.every(({ handle }) => handle.runId === childRunId(1))).toBe(true);
  });
});
