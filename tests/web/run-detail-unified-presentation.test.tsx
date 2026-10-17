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
    await screen.findByText("model-a000-1");
    const evidence = screen.getAllByRole("region", { name: EVIDENCE });
    expect(evidence).toHaveLength(8);
    await waitFor(() => expect(inspect.calls.length).toBeGreaterThan(0));
    expect(inspect.calls.length).toBeLessThanOrEqual(3);
    for (let completed = 0; completed < 8; completed = inspect.calls.length) {
      inspect.settle();
      if (completed < 8) {
        await waitFor(() => expect(inspect.calls.length).toBeGreaterThan(completed));
      }
    }
    inspect.settle();
    for (const call of inspect.calls) {
      expect(call.handle.runId).not.toBe(parentRunId);
      expect(call.handle.runId).toMatch(/^20000000/);
      expect(call.handle.stepId).toMatch(/^step-a000/);
    }
    expect(
      new Set(inspect.calls.map((call) => `${call.handle.runId}|${call.handle.stepId}`)).size,
    ).toBe(8);
  });
  it("shows every own model call fully expanded by default: input, output and sources visible together", async () => {
    const inspect = inspectGate();
    install({
      run: runSnapshot([ownStep("step-own-1", 1), ownStep("step-own-2", 2)]),
      parts: [],
      inspect,
    });
    render(<RunWorkspace runId={parentRunId} />);
    const evidence = await screen.findAllByRole("region", { name: EVIDENCE });
    expect(evidence).toHaveLength(2);
    inspect.settle(exactFor("own", 1900));
    for (const region of evidence) {
      await within(region).findByText(/^精确输入:/);
      expect(within(region).getByText(/^\{"label":/)).toBeTruthy();
      await waitFor(() =>
        expect(within(region).getAllByText(/^src-\d+$/).length).toBeGreaterThan(0),
      );
      expect(
        within(region).queryByRole("button", { name: i18n.t("observability.expandReader") }),
      ).toBeNull();
      expect(
        within(region).queryByRole("button", {
          name: i18n.t("observability.inspectActualInputAndOutput"),
        }),
      ).toBeNull();
    }
    const first = evidence[0];
    expect(within(first).getAllByText(/^src-\d+$/)).toHaveLength(1900);
    expect(within(first).getByText("src-1")).toBeTruthy();
    expect(within(first).getByText("src-1900")).toBeTruthy();
  });

  it("keeps all three sections visible in full evidence mode without changing lazy standalone tabs", () => {
    const value = exactFor("full", 1900);
    render(<InspectedEvidence value={value} fullEvidence />);
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
    await waitFor(() => expect(inspect.calls).toHaveLength(2));
    inspect.settle(exactFor("technical", 2));
    await waitFor(() => expect(screen.getAllByText("精确输入:technical")).toHaveLength(2));
    expect(
      screen.queryByRole("button", { name: i18n.t("observability.inspectActualInputAndOutput") }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: i18n.t("observability.expandAllSteps") }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: i18n.t("observability.collapseAllSteps") }),
    ).toBeNull();
    expect(screen.getAllByText("agent.action").length).toBeGreaterThan(0);
    expect(inspect.calls.every(({ handle }) => handle.runId !== parentRunId)).toBe(true);
  });

  it("refreshes protected evidence explicitly without duplicating reads when switching views", async () => {
    const inspect = inspectGate();
    install({ run: runSnapshot([ownStep("refresh-step", 1)]), parts: [], inspect });
    render(<RunWorkspace runId={parentRunId} />);
    await waitFor(() => expect(inspect.calls).toHaveLength(1));
    inspect.settle(exactFor("before-refresh", 1));
    await screen.findByText("精确输入:before-refresh");
    fireEvent.click(screen.getByRole("button", { name: i18n.t("observability.technicalDetails") }));
    expect(inspect.calls).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: i18n.t("observability.refreshRuns") }));
    await waitFor(() => expect(inspect.calls).toHaveLength(2));
    inspect.settle(exactFor("after-refresh", 1));
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
    await screen.findByText("model-a000-1");
    expect(screen.queryByText("sibling-model")).toBeNull();
    await waitFor(() => expect(inspect.calls).toHaveLength(1));
    expect(inspect.calls[0].handle.runId).toBe(childRunId(1));
    fireEvent.click(screen.getByRole("button", { name: i18n.t("observability.technicalDetails") }));
    expect((await screen.findAllByText("sibling-model")).length).toBeGreaterThan(0);
    expect(inspect.calls).toHaveLength(1);
  });
});
