import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

const now = "2026-09-26T00:00:00.000Z";
const runId = "run-parent-1";

const makeDeferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

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
  it("opens a parent run showing the first step without reading any protected context", async () => {
    const inspect = vi.fn();
    store.getState().resetForTests({
      ...api,
      getRun: vi.fn().mockResolvedValue(createSnapshot()),
      inspectRunContext: inspect,
    });
    render(<RunWorkspace runId={runId} />);

    expect(await screen.findByText("memory.organize")).toBeTruthy();
    expect(screen.getByRole("button", { name: /步骤 1/ }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    // 证据区已就位，但受保护正文必须等用户显式检查
    expect(screen.getByRole("button", { name: "查看实际输入与输出" })).toBeTruthy();
    expect(inspect).not.toHaveBeenCalled();
  });

  it("auto-inspects exactly the explicitly selected step once", async () => {
    const deferred = makeDeferred<InspectedContext>();
    const inspect = vi.fn<SuperstringApi["inspectRunContext"]>(() => deferred.promise);
    store.getState().resetForTests({
      ...api,
      getRun: vi.fn().mockResolvedValue(createSnapshot()),
      inspectRunContext: inspect,
    });
    const user = userEvent.setup();
    render(<RunWorkspace runId={runId} />);
    await screen.findByText("memory.organize");

    await user.click(screen.getByRole("button", { name: /步骤 2/ }));
    await waitFor(() => expect(inspect).toHaveBeenCalledTimes(1));
    expect(inspect.mock.calls[0][0]).toEqual({ runId, stepId: "step-2" });

    await act(async () => {
      deferred.resolve(exact);
      await deferred.promise;
    });
    expect(screen.getByText("Protected input")).toBeTruthy();
    expect(inspect).toHaveBeenCalledTimes(1);
  });

  it("keeps evidence hidden after clearing and never re-auto-inspects it", async () => {
    const inspect = vi.fn<SuperstringApi["inspectRunContext"]>().mockResolvedValue(exact);
    store.getState().resetForTests({
      ...api,
      getRun: vi.fn().mockResolvedValue(createSnapshot()),
      inspectRunContext: inspect,
    });
    const user = userEvent.setup();
    render(<RunWorkspace runId={runId} />);
    await screen.findByText("memory.organize");

    await user.click(screen.getByRole("button", { name: /步骤 2/ }));
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

  it("aborts a pending inspection when the window hides and drops its late response", async () => {
    const deferred = makeDeferred<InspectedContext>();
    let capturedSignal: AbortSignal | undefined;
    const inspect = vi.fn<SuperstringApi["inspectRunContext"]>((_handle, signal) => {
      capturedSignal = signal;
      return deferred.promise;
    });
    store.getState().resetForTests({
      ...api,
      getRun: vi.fn().mockResolvedValue(createSnapshot()),
      inspectRunContext: inspect,
    });
    const user = userEvent.setup();
    render(<RunWorkspace runId={runId} />);
    await screen.findByText("memory.organize");

    await user.click(screen.getByRole("button", { name: /步骤 2/ }));
    await waitFor(() => expect(inspect).toHaveBeenCalledTimes(1));
    expect(capturedSignal?.aborted).toBe(false);

    setHidden();
    expect(capturedSignal?.aborted).toBe(true);
    expect(screen.queryByRole("button", { name: "收起实际输入与输出" })).toBeNull();

    await act(async () => {
      deferred.resolve(exact);
      await deferred.promise;
    });
    expect(screen.queryByText("Protected input")).toBeNull();
    expect(screen.queryByText("Protected output")).toBeNull();
    expect(inspect).toHaveBeenCalledTimes(1);
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
      inspectRunContext: inspectA,
    });
    const user = userEvent.setup();
    render(<RunWorkspace runId={runId} />);
    await screen.findByText("memory.organize");
    await user.click(screen.getByRole("button", { name: /步骤 2/ }));
    await waitFor(() => expect(inspectA).toHaveBeenCalledTimes(1));

    store.getState().resetForTests({
      ...api,
      getRun: vi.fn().mockResolvedValue(snapshot),
      inspectRunContext: inspectB,
    });
    await waitFor(() => expect(inspectB).toHaveBeenCalledTimes(1));
    expect(inspectB.mock.calls[0][0]).toEqual({ runId, stepId: "step-2" });

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
    render(<EvidenceWorkbench item={modelSpan()} />);

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
    render(<EvidenceWorkbench item={modelSpan()} autoInspect />);

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
    const inspect = vi.fn<SuperstringApi["inspectRunContext"]>();
    const first = { ...createSnapshot(), specId: "first-run" };
    const getRun = vi
      .fn<SuperstringApi["getRun"]>()
      .mockResolvedValueOnce(first)
      .mockReturnValueOnce(next.promise);
    store.getState().resetForTests({ ...api, getRun, inspectRunContext: inspect });
    const view = render(<RunWorkspace runId={runId} />);
    expect(await screen.findByText("first-run")).toBeTruthy();
    view.rerender(<RunWorkspace runId="run-parent-2" />);
    expect(screen.queryByText("first-run")).toBeNull();
    expect(inspect).not.toHaveBeenCalled();
    await act(async () => {
      next.resolve({ ...createSnapshot(), runId: "run-parent-2", specId: "second-run", steps: [] });
    });
    expect(await screen.findByText("second-run")).toBeTruthy();
    expect(screen.queryByText("first-run")).toBeNull();
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
    const view = render(<EvidenceWorkbench item={modelSpan()} autoInspect />);
    await waitFor(() => expect(inspect).toHaveBeenCalledTimes(1));
    view.rerender(
      <EvidenceWorkbench item={modelSpan({ status: "completed", finishedAt: now })} autoInspect />,
    );
    expect(await screen.findByText("Protected input")).toBeTruthy();
    await waitFor(() => expect(inspect).toHaveBeenCalledTimes(2));
    view.rerender(
      <EvidenceWorkbench
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
      <EvidenceWorkbench item={modelSpan({ status: "failed", finishedAt: now })} autoInspect />,
    );
    await act(async () => {});
    expect(inspect).toHaveBeenCalledTimes(2);
    expect(screen.queryByText("Protected input")).toBeNull();
  });
});
