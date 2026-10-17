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
import { TraceTimeline } from "../../src/web/screens/observability/TraceTimeline";
import { RunWorkspace } from "../../src/web/screens/runs/RunEntry";
import { useSuperstringStore as store } from "../../src/web/store";

// 技术追踪单一全局选择契约（2026-10-17）：一条时间线，一个跨 trace 的全局选中 span，
// 只渲染一个共享 ModelEvidence；未匹配时间线的 own call 用既有步骤标签回退；不复制整份 span 列表。

const origin = Date.parse("2026-10-17T00:00:00Z"),
  at = (ms: number) => new Date(origin + ms).toISOString();
const parentRunId = "10000000-0000-4000-8000-0000000000a1";
const childRunId = (n: number) => `20000000-0000-4000-8000-0000000000${String(n).padStart(2, "0")}`;
const EVIDENCE = i18n.t("observability.modelEvidence");
const TIMING = i18n.t("observability.parentAndChildTiming");
const VIEW_DETAILS = i18n.t("observability.viewInputOutputAndDetails");
const VIEW_STEP = i18n.t("observability.viewStepDetails");

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

function ownStep(
  stepId: string,
  stepNo: number,
  runId = parentRunId,
  model = "own-model",
): AgentStepSnapshot {
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
  ];
  for (let k = 1; k <= modelCount; k++) {
    items.push(
      span(next(), 100 + k * 40, 130 + k * 40, {
        traceId,
        spanId: `${traceId}-m${k}`,
        parentSpanId: `${traceId}-root`,
        name: "agent.model",
        stage: "model",
        model: `model-a000-${k}`,
        runId: childRunId(k),
        details: { stepId: `step-a000-${k}`, phase: "leaf", modelResolved: true },
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
      parentSpanId: `${traceId}-root`,
      outputId: `out-${traceId.slice(0, 6)}`,
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
    settleWith(value: (key: string) => InspectedContext) {
      for (const [key, queue] of pending) {
        let next = queue.shift();
        while (next) {
          next.resolve(value(key));
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
  matched?: string[];
}) {
  const details = new Map<string, RuntimeTraceDetail>();
  const pageItems = (options.parts ?? []).map((part) => {
    details.set(part.trace.traceId, {
      now: at(1000),
      trace: part.trace,
      items: part.items,
      matchedSpanIds: options.matched ?? [],
    });
    return part.trace;
  });
  store.getState().resetForTests({
    ...api,
    getRun: vi.fn(() => Promise.resolve(options.run)),
    listRuntimeTraces: vi.fn(() =>
      Promise.resolve({
        items: pageItems,
        nextBeforeId: pageItems.at(-1)?.cursorId ?? 0,
        hasMore: false,
        summary: {
          totalTraces: pageItems.length,
          activeTraces: 0,
          failedTraces: 0,
          matchedSpans: 0,
          lastActivityAt: at(1000),
          now: at(1000),
        },
      }),
    ),
    getRuntimeWaterfall: vi.fn((traceId: string) => Promise.resolve(details.get(traceId))),
    inspectRunContext: options.inspect.impl,
  } as typeof api);
}

function timingRegions() {
  return screen.getAllByRole("region", { name: TIMING });
}

function modelRows(region: HTMLElement) {
  return within(region).getAllByRole("button", { name: VIEW_DETAILS });
}

function modelRow(region: HTMLElement, model: string) {
  const row = modelRows(region).find((button) => button.textContent?.includes(model));
  if (!row) throw new Error(`missing model row for ${model}`);
  return row;
}

function pressedRows() {
  return timingRegions().flatMap((region) =>
    within(region).queryAllByRole("button", { pressed: true }),
  );
}

function evidenceRegions() {
  return screen.queryAllByRole("region", { name: EVIDENCE });
}

const ROW_LABELS = {
  output: i18n.t("observability.modelOutput"),
  input: i18n.t("observability.modelInput"),
  sources: i18n.t("observability.sourcesAndRevisions"),
} as const;

function openInput(scope: HTMLElement) {
  const trigger = within(scope).getByRole("button", { name: ROW_LABELS.input });
  if (trigger.getAttribute("aria-expanded") !== "true") fireEvent.click(trigger);
  return trigger;
}

beforeEach(() => {
  void i18n.changeLanguage("zh-CN");
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("humanized technical single-detail selection", () => {
  it("starts with no model region and keeps one global model selection across traces with one shared reader per handle", async () => {
    const inspect = inspectGate();
    install({
      run: runSnapshot([ownStep("step-own-1", 1), ownStep("step-own-2", 2)]),
      parts: [feedbackTrace(1), ingressTrace(2, 2)],
      inspect,
    });
    render(<RunWorkspace runId={parentRunId} />);
    expect(await screen.findByText("本运行已记录 2 次模型调用（不含子运行）")).toBeTruthy();
    const ownOne = `${parentRunId}|step-own-1`;
    const childOne = `${childRunId(1)}|step-a000-1`;
    const childTwo = `${childRunId(2)}|step-a000-2`;
    const keyOf = (call: { handle: { runId: string; stepId: string } }) =>
      `${call.handle.runId}|${call.handle.stepId}`;
    await waitFor(() => expect(inspect.calls.length).toBeGreaterThanOrEqual(3));
    // 先释放非首个目标的槽位，确保首个目标在队列完成前拿到 1900 来源的正文
    for (const call of [...inspect.calls]) {
      const key = keyOf(call);
      if (key !== childOne && key !== childTwo) {
        inspect.resolveKey(key, exactFor(`own:${key}`, 1));
      }
    }
    await waitFor(() => expect(inspect.calls.some((call) => keyOf(call) === childOne)).toBe(true));
    inspect.resolveKey(childOne, exactFor("first-child", 1900));
    await waitFor(() => expect(inspect.calls.length).toBe(4));
    inspect.settleWith((key) =>
      key === childTwo
        ? exactFor("second-child", 1)
        : key === ownOne
          ? exactFor("own-one", 1)
          : exactFor("own-two", 1),
    );

    fireEvent.click(screen.getByRole("button", { name: i18n.t("observability.technicalDetails") }));
    expect(timingRegions()).toHaveLength(2);
    expect(evidenceRegions()).toHaveLength(0);
    const ingress = timingRegions()[1];
    expect(modelRows(ingress)).toHaveLength(2);

    const first = modelRow(ingress, "model-a000-1");
    fireEvent.click(first);
    expect(pressedRows()).toHaveLength(1);
    expect(evidenceRegions()).toHaveLength(1);
    const firstRegion = evidenceRegions()[0];
    await within(firstRegion).findByRole("button", { name: ROW_LABELS.output });
    expect(
      within(firstRegion)
        .getByRole("button", { name: ROW_LABELS.output })
        .getAttribute("aria-expanded"),
    ).toBe("false");
    expect(document.querySelectorAll("tbody tr")).toHaveLength(0);
    openInput(firstRegion);
    expect(await within(firstRegion).findByText("精确输入:first-child")).toBeTruthy();
    expect(
      within(firstRegion)
        .getByRole("button", { name: ROW_LABELS.sources })
        .getAttribute("aria-expanded"),
    ).toBe("false");
    fireEvent.click(within(firstRegion).getByRole("button", { name: ROW_LABELS.sources }));
    expect(document.querySelectorAll("tbody tr")).toHaveLength(1900);

    const second = modelRow(ingress, "model-a000-2");
    fireEvent.click(second);
    expect(pressedRows()).toHaveLength(1);
    expect(evidenceRegions()).toHaveLength(1);
    const secondRegion = evidenceRegions()[0];
    expect(within(secondRegion).queryByText("精确输入:first-child")).toBeNull();
    await within(secondRegion).findByRole("button", { name: ROW_LABELS.input });
    openInput(secondRegion);
    expect(await within(secondRegion).findByText("精确输入:second-child")).toBeTruthy();

    const counts = new Map<string, number>();
    for (const call of inspect.calls) {
      const key = `${call.handle.runId}|${call.handle.stepId}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    expect(counts.size).toBe(4);
    for (const count of counts.values()) expect(count).toBe(1);
  });

  it("hides the model region when a non-model span is selected and keeps only one pressed row", async () => {
    const inspect = inspectGate();
    install({
      run: runSnapshot([]),
      parts: [feedbackTrace(1), ingressTrace(2, 1)],
      inspect,
    });
    render(<RunWorkspace runId={parentRunId} />);
    await waitFor(() => expect(inspect.calls.length).toBeGreaterThan(0));
    inspect.settle();
    fireEvent.click(screen.getByRole("button", { name: i18n.t("observability.technicalDetails") }));

    const feedback = timingRegions()[0];
    const model = modelRow(timingRegions()[1], "model-a000-1");
    fireEvent.click(model);
    expect(evidenceRegions()).toHaveLength(1);
    expect(model.getAttribute("aria-pressed")).toBe("true");

    const nonModel = within(feedback).getAllByRole("button", { name: VIEW_STEP })[0];
    fireEvent.click(nonModel);
    expect(evidenceRegions()).toHaveLength(0);
    expect(nonModel.getAttribute("aria-pressed")).toBe("true");
    expect(model.getAttribute("aria-pressed")).toBe("false");
    expect(pressedRows()).toHaveLength(1);
  });

  it("locate status controls and nextMatch select the exact span and expose its selected state", async () => {
    const inspect = inspectGate();
    const traceId = `a${"0".repeat(31)}`;
    const root = span(1, 0, 900, {
      traceId,
      spanId: `${traceId}-root`,
      name: "bot.ingress",
      stage: "ingress",
      runId: parentRunId,
    });
    const statuses = ["failed", "unknown", "started"] as const;
    const items: RuntimeSpan[] = [root];
    statuses.forEach((status, index) => {
      items.push(
        span(index + 2, 100 + index * 40, 130 + index * 40, {
          traceId,
          spanId: `${traceId}-m${index + 1}`,
          parentSpanId: root.spanId,
          name: "agent.model",
          stage: "model",
          model: `model-${status}`,
          status,
          runId: childRunId(index + 1),
          details: { stepId: `step-a000-${index + 1}`, phase: "leaf" },
        }),
      );
    });
    const trace = traceGroup({
      traceId,
      root,
      runIds: [parentRunId, childRunId(1), childRunId(2), childRunId(3)],
      count: items.length,
    });
    install({
      run: runSnapshot([]),
      parts: [{ trace, items }],
      inspect,
      matched: [`${traceId}-m1`, `${traceId}-m2`],
    });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(<RunWorkspace runId={parentRunId} />);
    await waitFor(() => expect(inspect.calls.length).toBeGreaterThan(0));
    inspect.settle();
    fireEvent.click(screen.getByRole("button", { name: i18n.t("observability.technicalDetails") }));
    const timing = timingRegions()[0];
    const locate = screen.getByRole("group", { name: i18n.t("observability.locateEvidence") });
    const [failed, unknown, started, nextMatch] = within(locate).getAllByRole("button");

    fireEvent.click(failed);
    expect(modelRow(timing, "model-failed").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(unknown);
    expect(modelRow(timing, "model-unknown").getAttribute("aria-pressed")).toBe("true");
    expect(modelRow(timing, "model-failed").getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(started);
    expect(modelRow(timing, "model-started").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(nextMatch);
    expect(modelRow(timing, "model-failed").getAttribute("aria-pressed")).toBe("true");
    expect(pressedRows()).toHaveLength(1);
    expect(evidenceRegions()).toHaveLength(1);
    const focused = document.activeElement as HTMLElement | null;
    expect(focused?.closest("[role='region']")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: i18n.t("observability.copyTraceId") }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(traceId));
  });

  it("offers a step-label fallback only for own calls without a timeline span, without duplicating matched calls", async () => {
    const inspect = inspectGate();
    install({
      run: runSnapshot([ownStep("step-own-1", 1, parentRunId, "fallback-model")]),
      parts: [ingressTrace(2, 2)],
      inspect,
    });
    render(<RunWorkspace runId={parentRunId} />);
    expect(await screen.findByText("本运行已记录 1 次模型调用（不含子运行）")).toBeTruthy();
    const ownKey = `${parentRunId}|step-own-1`;
    await waitFor(() => expect(inspect.calls.length).toBe(3));
    inspect.resolveKey(ownKey, exactFor("fallback", 1));
    inspect.settleWith((key) => exactFor(`child:${key}`, 1));
    fireEvent.click(screen.getByRole("button", { name: i18n.t("observability.technicalDetails") }));

    const fallback = screen.getByRole("button", { name: /步骤 1 · 单轮任务/ });
    expect(screen.getAllByRole("button", { name: /步骤 1 · 单轮任务/ })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /步骤 2 · 单轮任务/ })).toBeNull();
    fireEvent.click(fallback);
    expect(fallback.getAttribute("aria-pressed")).toBe("true");
    expect(evidenceRegions()).toHaveLength(1);
    const region = evidenceRegions()[0];
    await within(region).findByRole("button", { name: ROW_LABELS.input });
    openInput(region);
    expect(await within(region).findByText("精确输入:fallback")).toBeTruthy();
    expect(inspect.calls).toHaveLength(3);
    expect(inspect.calls.every((call) => call.signal.aborted === false)).toBe(true);
  });

  it("keeps one delivery read per output while technical stays closed and rows are selected", async () => {
    const inspect = inspectGate();
    const traceId = "a".repeat(32);
    const base = span(1, 0, 1, {
      traceId,
      spanId: "delivery-first",
      name: "delivery.send",
      stage: "delivery",
      runId: parentRunId,
      outputId: "same-output",
    });
    const trace = traceGroup({ traceId, root: base, runIds: [parentRunId], count: 2 });
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
      ...api,
      getRun: vi.fn(() => Promise.resolve(runSnapshot([]))),
      listRuntimeTraces: vi.fn(async () => ({
        items: [trace],
        nextBeforeId: 1,
        hasMore: false,
        summary: {
          totalTraces: 1,
          activeTraces: 0,
          failedTraces: 0,
          matchedSpans: 0,
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
      inspectRunContext: inspect.impl,
    } as typeof api);
    render(<RunWorkspace runId={parentRunId} />);
    await waitFor(() => expect(getDelivery).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: i18n.t("observability.technicalDetails") }));
    expect(evidenceRegions()).toHaveLength(0);
    expect(getDelivery).toHaveBeenCalledTimes(1);
    const rows = screen.getAllByRole("button", { name: VIEW_STEP });
    fireEvent.click(rows[0]);
    expect(rows[0].getAttribute("aria-pressed")).toBe("true");
    expect(evidenceRegions()).toHaveLength(0);
    expect(getDelivery).toHaveBeenCalledTimes(1);
    fireEvent.click(rows[1]);
    expect(rows[1].getAttribute("aria-pressed")).toBe("true");
    expect(rows[0].getAttribute("aria-pressed")).toBe("false");
    expect(getDelivery).toHaveBeenCalledTimes(1);
  });

  it("rejects late evidence for a selected fallback step on hide and re-reads on show", async () => {
    const inspect = inspectGate();
    install({ run: runSnapshot([ownStep("step-own-1", 1, parentRunId, "own-model")]), inspect });
    render(<RunWorkspace runId={parentRunId} />);
    await waitFor(() => expect(inspect.calls.length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole("button", { name: i18n.t("observability.technicalDetails") }));
    const fallback = screen.getByRole("button", { name: /步骤 1 · 单轮任务/ });
    fireEvent.click(fallback);
    expect(evidenceRegions()).toHaveLength(1);

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    fireEvent(document, new Event("visibilitychange"));
    for (const call of inspect.calls) expect(call.signal.aborted).toBe(true);
    inspect.resolveKey(`${parentRunId}|step-own-1`, exactFor("hidden-late", 1));
    await Promise.resolve();
    expect(screen.queryByText("精确输入:hidden-late")).toBeNull();

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() => expect(inspect.calls.length).toBeGreaterThanOrEqual(2));
    inspect.settle(exactFor("visible-current", 1));
    await waitFor(() => expect(evidenceRegions()).toHaveLength(1));
    const visibleRegion = evidenceRegions()[0];
    await within(visibleRegion).findByRole("button", { name: ROW_LABELS.input });
    openInput(visibleRegion);
    expect(await screen.findByText("精确输入:visible-current")).toBeTruthy();
    expect(screen.queryByText("精确输入:hidden-late")).toBeNull();
  });

  it("preserves the standalone TraceTimeline row contract and its own toggles", () => {
    const part = ingressTrace(3, 2);
    const detail: RuntimeTraceDetail = {
      now: at(1000),
      trace: part.trace,
      items: part.items,
      matchedSpanIds: [],
    };
    const onSelect = vi.fn();
    const mounted = render(<TraceTimeline data={detail} selected={null} onSelect={onSelect} />);
    expect(
      screen.getByRole("button", { name: i18n.t("observability.expandAllSteps") }),
    ).toBeTruthy();
    const rows = screen.getAllByRole("button", { name: VIEW_DETAILS });
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      const described = row.getAttribute("aria-describedby");
      expect(described).toBeTruthy();
      expect(document.getElementById(described!)?.textContent).toBeTruthy();
      expect(row.getAttribute("aria-pressed")).toBe("false");
    }
    fireEvent.click(rows[0]);
    expect(onSelect).toHaveBeenCalledTimes(1);
    const selectedSpan = onSelect.mock.calls[0][0] as RuntimeSpan;
    expect(part.items.map((item) => item.spanId)).toContain(selectedSpan.spanId);
    mounted.rerender(
      <TraceTimeline data={detail} selected={selectedSpan.spanId} onSelect={onSelect} />,
    );
    expect(
      screen.getAllByRole("button", { name: VIEW_DETAILS })[0].getAttribute("aria-pressed"),
    ).toBe("true");
  });
});
