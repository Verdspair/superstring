import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InspectedContext, RunSnapshot } from "../../src/shared/contracts/agent-run";
import type { RuntimeSpan } from "../../src/shared/contracts/runtime-observability";
import { api, type SuperstringApi } from "../../src/web/api";
import { i18n } from "../../src/web/i18n/runtime";
import { EvidenceWorkbench } from "../../src/web/screens/observability/EvidenceWorkbench";
import { ModelEvidence } from "../../src/web/screens/observability/ModelEvidence";
import { RunWorkspace } from "../../src/web/screens/runs/RunEntry";
import { useSuperstringStore as store } from "../../src/web/store";
import { render } from "./helpers/render-with-providers";

const now = "2026-09-26T00:00:00.000Z";
const runId = "run-parent-1";

const makeDeferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

const emptyTracePage = () => ({
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
});

const exact: InspectedContext = {
  status: "exact",
  layout: [],
  sourceVersions: [],
  exactMessages: [{ role: "user", content: [{ kind: "text", text: "Protected input" }] }],
  result: { status: "exact", format: "text", text: "Protected output" },
};

function createSnapshot(): RunSnapshot {
  const step = (stepNo: number): RunSnapshot["steps"][number] => ({
    stepId: `step-${stepNo}`,
    runId,
    stepNo,
    model: "model-alpha",
    phase: "leaf",
    status: "completed",
    context: { runId, stepId: `step-${stepNo}` },
    startedAt: now,
    endedAt: now,
    errorCode: null,
  });
  return {
    runId,
    specId: "memory.organize",
    specVersion: "1",
    owner: { kind: "memory_job", id: "job-one" },
    status: "generating",
    lastSeq: 3,
    outputs: [],
    startedAt: now,
    endedAt: null,
    errorCode: null,
    steps: [step(1), step(2)],
  };
}

const modelSpan = (patch: Partial<RuntimeSpan> = {}): RuntimeSpan => ({
  id: 2,
  traceId: "a".repeat(32),
  spanId: "span-child",
  parentSpanId: "span-root",
  name: "agent.model",
  at: now,
  finishedAt: null,
  durationMs: null,
  channel: "onebot11",
  stage: "model",
  status: "started",
  code: "MODEL_STARTED",
  model: "local/model",
  conversationId: null,
  agentId: null,
  runId: "run-child-9",
  wakeId: null,
  outputId: null,
  sourceSeq: 100,
  details: { stepId: "step-child-9", phase: "leaf" },
  ...patch,
});

const EVIDENCE = i18n.t("observability.modelEvidence");
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

let originalVisibilityDesc: PropertyDescriptor | undefined;
const setHidden = () => {
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
  fireEvent(document, new Event("visibilitychange"));
};

beforeEach(() => {
  originalVisibilityDesc =
    Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState") ??
    Object.getOwnPropertyDescriptor(document, "visibilityState");
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  void i18n.changeLanguage("zh-CN");
  store.getState().resetForTests(api);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  if (originalVisibilityDesc) {
    Object.defineProperty(document, "visibilityState", originalVisibilityDesc);
  }
});

describe("conversation live task details", () => {
  it("opens a parent run with both step selectors as buttons and prefetches every recorded step while rows are closed", async () => {
    const inspect = vi.fn();
    store.getState().resetForTests({
      ...api,
      getRun: vi.fn().mockResolvedValue(createSnapshot()),
      listRuntimeTraces: vi.fn().mockResolvedValue(emptyTracePage()),
      inspectRunContext: inspect,
    });
    render(<RunWorkspace runId={runId} />);

    expect(await screen.findByText("memory.organize")).toBeTruthy();
    const first = screen.getByRole("button", { name: "步骤 1 · 单轮任务" });
    const second = screen.getByRole("button", { name: "步骤 2 · 单轮任务" });
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(first.getAttribute("aria-pressed")).toBe("true");
    expect(second.getAttribute("aria-pressed")).toBe("false");
    // 运行加载即预取全部真实 handle（closed 也拉取，bounded 3）
    await waitFor(() => expect(inspect).toHaveBeenCalledTimes(2));
    expect(new Set(inspect.mock.calls.map((call) => call[0].stepId))).toEqual(
      new Set(["step-1", "step-2"]),
    );
  });

  it("prefetches both steps while closed, switches selection with zero extra requests and keeps the unselected step's evidence hidden", async () => {
    const deferred = makeDeferred<InspectedContext>();
    const signals: AbortSignal[] = [];
    const inspect = vi.fn<SuperstringApi["inspectRunContext"]>((_handle, signal) => {
      if (signal) signals.push(signal);
      return deferred.promise;
    });
    store.getState().resetForTests({
      ...api,
      getRun: vi.fn().mockResolvedValue(createSnapshot()),
      listRuntimeTraces: vi.fn().mockResolvedValue(emptyTracePage()),
      inspectRunContext: inspect,
    });
    render(<RunWorkspace runId={runId} />);
    await screen.findByText("memory.organize");

    // 两个步骤的 handle 都在关闭态预取
    await waitFor(() => expect(inspect).toHaveBeenCalledTimes(2));
    expect(signals.every((signal) => !signal.aborted)).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "步骤 2 · 单轮任务" }));
    // 选择切换是纯视觉切换：零新请求，也不中止运行内已拥有的读取
    await act(async () => {
      await Promise.resolve();
    });
    expect(inspect).toHaveBeenCalledTimes(2);
    expect(signals.every((signal) => !signal.aborted)).toBe(true);

    await act(async () => {
      deferred.resolve(exact);
      await deferred.promise;
    });
    // 列表行默认关闭：打开选中步的输入行后正文可见；未选步行正文保持关闭
    const region = screen.getByRole("region", { name: EVIDENCE });
    await within(region).findByRole("button", { name: ROW_LABELS.input });
    openEvidenceSections(region, ["input"]);
    expect(screen.getAllByText("Protected input")).toHaveLength(1);
    expect(inspect).toHaveBeenCalledTimes(2);
  });

  it("standalone manual evidence: clearing keeps it hidden and never re-inspects until asked again", async () => {
    const inspect = vi.fn<SuperstringApi["inspectRunContext"]>().mockResolvedValue(exact);
    store.getState().resetForTests({
      ...api,
      inspectRunContext: inspect,
    });
    const user = userEvent.setup();
    render(<ModelEvidence handle={{ runId, stepId: "step-1" }} />);

    expect(await screen.findByRole("button", { name: "查看实际输入与输出" })).toBeTruthy();
    expect(inspect).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "查看实际输入与输出" }));
    await screen.findByText("Protected input");
    expect(inspect).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "收起实际输入与输出" }));
    expect(screen.queryByText("Protected input")).toBeNull();
    expect(screen.getByRole("button", { name: "查看实际输入与输出" })).toBeTruthy();

    await act(async () => {});
    expect(screen.queryByText("Protected input")).toBeNull();
    expect(inspect).toHaveBeenCalledTimes(1);

    // 显式重新检查仍然可用
    await user.click(screen.getByRole("button", { name: "查看实际输入与输出" }));
    await screen.findByText("Protected input");
    expect(inspect).toHaveBeenCalledTimes(2);
  });

  it("aborts pending auto-inspections when the window hides and drops their late response", async () => {
    const deferred = makeDeferred<InspectedContext>();
    const signals: AbortSignal[] = [];
    const inspect = vi.fn<SuperstringApi["inspectRunContext"]>((_handle, signal) => {
      if (signal) signals.push(signal);
      return deferred.promise;
    });
    store.getState().resetForTests({
      ...api,
      getRun: vi.fn().mockResolvedValue(createSnapshot()),
      listRuntimeTraces: vi.fn().mockResolvedValue(emptyTracePage()),
      inspectRunContext: inspect,
    });
    render(<RunWorkspace runId={runId} />);
    await screen.findByText("memory.organize");

    // 两个步骤的 handle 都在关闭态预取
    await waitFor(() => expect(inspect).toHaveBeenCalledTimes(2));
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => !signal.aborted)).toBe(true);

    setHidden();
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(screen.queryByRole("button", { name: "收起实际输入与输出" })).toBeNull();

    await act(async () => {
      deferred.resolve(exact);
      await deferred.promise;
    });
    expect(screen.queryByText("Protected input")).toBeNull();
    expect(screen.queryByText("Protected output")).toBeNull();
    expect(inspect).toHaveBeenCalledTimes(2);
  });

  it("does not leak a late response from the previous API client for the same handle", async () => {
    const deferredA = makeDeferred<InspectedContext>();
    const inspectA = vi.fn<SuperstringApi["inspectRunContext"]>(() => deferredA.promise);
    const deferredB = makeDeferred<InspectedContext>();
    const inspectB = vi.fn<SuperstringApi["inspectRunContext"]>(() => deferredB.promise);
    const snapshot = createSnapshot();

    store.getState().resetForTests({
      ...api,
      getRun: vi.fn().mockResolvedValue(snapshot),
      listRuntimeTraces: vi.fn().mockResolvedValue(emptyTracePage()),
      inspectRunContext: inspectA,
    });
    render(<RunWorkspace runId={runId} />);
    await screen.findByText("memory.organize");
    await waitFor(() => expect(inspectA).toHaveBeenCalledTimes(2));
    expect(new Set(inspectA.mock.calls.map((call) => call[0].stepId))).toEqual(
      new Set(["step-1", "step-2"]),
    );

    store.getState().resetForTests({
      ...api,
      getRun: vi.fn().mockResolvedValue(snapshot),
      listRuntimeTraces: vi.fn().mockResolvedValue(emptyTracePage()),
      inspectRunContext: inspectB,
    });
    // API 身份变化：全部 handle 用新 client 重核
    await waitFor(() => expect(inspectB).toHaveBeenCalledTimes(2));

    await act(async () => {
      deferredA.resolve(exact);
      await deferredA.promise;
    });
    expect(screen.queryByText("Protected input")).toBeNull();
    expect(screen.queryByText("Protected output")).toBeNull();
  });

  it("renders ModelEvidence without inspecting until explicitly asked (autoInspect defaults false)", async () => {
    const inspect = vi.fn<SuperstringApi["inspectRunContext"]>().mockResolvedValue(exact);
    store.getState().resetForTests({ ...api, inspectRunContext: inspect });
    render(<ModelEvidence handle={{ runId, stepId: "step-1" }} />);

    expect(await screen.findByRole("button", { name: "查看实际输入与输出" })).toBeTruthy();
    expect(inspect).not.toHaveBeenCalled();
  });

  it("EvidenceWorkbench does not auto-inspect a model child by default", async () => {
    const inspect = vi.fn<SuperstringApi["inspectRunContext"]>().mockResolvedValue(exact);
    store.getState().resetForTests({ ...api, inspectRunContext: inspect });
    render(
      <EvidenceWorkbench
        renderRun={(runId) => <RunWorkspace runId={runId} />}
        item={modelSpan()}
      />,
    );

    const workbench = await screen.findByRole("region", { name: "步骤检查器" });
    expect(
      await within(workbench).findByRole("button", { name: "查看实际输入与输出" }),
    ).toBeTruthy();
    expect(inspect).not.toHaveBeenCalled();
  });

  it("EvidenceWorkbench auto-inspects the selected model child exactly once on mount", async () => {
    const deferred = makeDeferred<InspectedContext>();
    const inspect = vi.fn<SuperstringApi["inspectRunContext"]>(() => deferred.promise);
    store.getState().resetForTests({ ...api, inspectRunContext: inspect });
    render(
      <EvidenceWorkbench
        renderRun={(runId) => <RunWorkspace runId={runId} />}
        item={modelSpan()}
        autoInspect
      />,
    );

    await waitFor(() => expect(inspect).toHaveBeenCalledTimes(1));
    expect(inspect.mock.calls[0][0]).toEqual({ runId: "run-child-9", stepId: "step-child-9" });

    await act(async () => {
      deferred.resolve(exact);
      await deferred.promise;
    });
    expect(screen.getByText("Protected input")).toBeTruthy();
    expect(inspect).toHaveBeenCalledTimes(1);
  });

  it("never shows the previous run while switching run identity on the same API", async () => {
    const next = makeDeferred<RunSnapshot>();
    const inspect = vi
      .fn<SuperstringApi["inspectRunContext"]>()
      .mockImplementation(() => new Promise<InspectedContext>(() => {}));
    const first = { ...createSnapshot(), specId: "first-run" };
    const getRun = vi
      .fn<SuperstringApi["getRun"]>()
      .mockResolvedValueOnce(first)
      .mockReturnValueOnce(next.promise);
    store.getState().resetForTests({
      ...api,
      getRun,
      listRuntimeTraces: vi.fn().mockResolvedValue(emptyTracePage()),
      inspectRunContext: inspect,
    });
    const view = render(<RunWorkspace runId={runId} />);
    expect(await screen.findByText("first-run")).toBeTruthy();
    // 运行加载即预取全部真实 handle
    await waitFor(() => expect(inspect).toHaveBeenCalledTimes(2));
    view.rerender(<RunWorkspace runId="run-parent-2" />);
    expect(screen.queryByText("first-run")).toBeNull();
    expect(screen.queryByText("Protected input")).toBeNull();
    expect(inspect).toHaveBeenCalledTimes(2);
    await act(async () => {
      next.resolve({ ...createSnapshot(), runId: "run-parent-2", specId: "second-run", steps: [] });
    });
    expect(await screen.findByText("second-run")).toBeTruthy();
    expect(screen.queryByText("first-run")).toBeNull();
    expect(inspect).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Protected input")).toBeNull();
  });

  it("rechecks only the selected model lifecycle transition and keeps a user-hidden detail hidden", async () => {
    const pending: InspectedContext = {
      ...exact,
      result: { status: "unavailable", reason: "pending" },
    };
    const inspect = vi
      .fn<SuperstringApi["inspectRunContext"]>()
      .mockResolvedValueOnce(pending)
      .mockResolvedValue(exact);
    store.getState().resetForTests({ ...api, inspectRunContext: inspect });
    const view = render(
      <EvidenceWorkbench
        renderRun={(runId) => <RunWorkspace runId={runId} />}
        item={modelSpan()}
        autoInspect
      />,
    );
    await waitFor(() => expect(inspect).toHaveBeenCalledTimes(1));
    view.rerender(
      <EvidenceWorkbench
        renderRun={(runId) => <RunWorkspace runId={runId} />}
        item={modelSpan({ status: "completed", finishedAt: now })}
        autoInspect
      />,
    );
    expect(await screen.findByText("Protected input")).toBeTruthy();
    await waitFor(() => expect(inspect).toHaveBeenCalledTimes(2));
    view.rerender(
      <EvidenceWorkbench
        renderRun={(runId) => <RunWorkspace runId={runId} />}
        item={modelSpan({ status: "completed", finishedAt: now, code: "UPDATED_METADATA" })}
        autoInspect
      />,
    );
    expect(inspect).toHaveBeenCalledTimes(2);
    const user = userEvent.setup();
    await user.click(
      screen.getByRole("button", { name: i18n.t("observability.hideActualInputAndOutput") }),
    );
    view.rerender(
      <EvidenceWorkbench
        renderRun={(runId) => <RunWorkspace runId={runId} />}
        item={modelSpan({ status: "failed", finishedAt: now })}
        autoInspect
      />,
    );
    await act(async () => {});
    expect(inspect).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Protected input")).toBeNull();
  });
});
