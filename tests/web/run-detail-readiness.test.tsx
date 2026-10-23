import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunSnapshot } from "../../src/shared/contracts/agent-run";
import { api } from "../../src/web/api";
import { selectLocale } from "../../src/web/i18n";
import { JobRunLink, RunAttempts, RunWorkspace } from "../../src/web/screens/runs/RunEntry";
import {
  notifyConversationChange,
  resetConversationChangesForTests,
} from "../../src/web/services/conversation-changes";
import { useSuperstringStore as store } from "../../src/web/store";
import { render } from "./helpers/render-with-providers";

const now = "2026-09-26T00:00:00.000Z";

function makeDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createSnapshot(
  runId = "run-one",
  specId = "memory.organize",
  status: RunSnapshot["status"] = "completed",
  ownerId = "job-one",
): RunSnapshot {
  return {
    runId,
    specId,
    specVersion: "1",
    owner: { kind: "memory_job", id: ownerId },
    status,
    lastSeq: 3,
    outputs: [{ outputId: `out-${runId}`, targetId: "target-1", status: "prepared" }],
    startedAt: now,
    endedAt: status === "completed" ? now : null,
    errorCode: null,
    steps: [
      {
        stepId: `step-${runId}-1`,
        runId,
        stepNo: 1,
        model: "model-alpha",
        phase: "leaf",
        status: "completed",
        context: { runId, stepId: `step-${runId}-1` },
        startedAt: now,
        endedAt: now,
        errorCode: null,
      },
    ],
  };
}

beforeEach(() => {
  selectLocale("zh-CN");
  resetConversationChangesForTests();
  store.getState().resetForTests();
});

afterEach(() => {
  cleanup();
  resetConversationChangesForTests();
  vi.restoreAllMocks();
});

describe("run detail readiness and non-blocking preview", () => {
  it("renders metadata immediately from attempt list results while authoritative getRun is still pending", async () => {
    const run1 = createSnapshot("run-1", "memory.organize");
    const deferredGet = makeDeferred<RunSnapshot>();

    const client = {
      ...api,
      listRuns: vi.fn().mockResolvedValue({ runs: [run1] }),
      getRun: vi.fn().mockImplementation(() => deferredGet.promise),
      inspectRunContext: vi.fn(),
    };
    store.getState().resetForTests(client);

    const user = userEvent.setup();
    render(<JobRunLink ownerKind="memory_job" ownerId="job-one" />);

    // Click to open dialog
    await user.click(screen.getByRole("button", { name: "运行详情" }));

    // Metadata, specId, and steps must be immediately visible without waiting for getRun
    expect(await screen.findByText("memory.organize")).toBeTruthy();
    expect(screen.getByRole("button", { name: "步骤 1 · 单轮任务" })).toBeTruthy();
    expect(
      within(screen.getByRole("group", { name: i18n.t("observability.modelSteps") })).getByText(
        "model-alpha",
      ),
    ).toBeTruthy();
    expect(screen.getByText("target-1 · prepared")).toBeTruthy();
    expect(screen.getByText("out-run-1")).toBeTruthy();
    expect(screen.queryByText("正在读取运行记录…")).toBeNull();

    // Authoritative getRun was still dispatched in the background
    expect(client.getRun).toHaveBeenCalledWith("run-1", expect.any(AbortSignal));

    // Expanded evidence starts without blocking the metadata preview.
    await waitFor(() =>
      expect(client.inspectRunContext).toHaveBeenCalledWith(
        run1.steps[0].context,
        expect.any(AbortSignal),
      ),
    );

    // Resolving background getRun keeps state authoritative and green
    await act(async () => {
      deferredGet.resolve(run1);
    });
    expect(screen.getByText("memory.organize")).toBeTruthy();
  });

  it("removes preview and displays error if background authoritative getRun fails", async () => {
    const run1 = createSnapshot("run-1", "memory.organize");
    const deferredGet = makeDeferred<RunSnapshot>();

    const client = {
      ...api,
      listRuns: vi.fn().mockResolvedValue({ runs: [run1] }),
      getRun: vi.fn().mockImplementation(() => deferredGet.promise),
    };
    store.getState().resetForTests(client);

    const user = userEvent.setup();
    render(<JobRunLink ownerKind="memory_job" ownerId="job-one" />);
    await user.click(screen.getByRole("button", { name: "运行详情" }));

    // Preview initially rendered
    expect(await screen.findByText("memory.organize")).toBeTruthy();

    // Authoritative getRun rejects (e.g. 404 or revoked access)
    await act(async () => {
      deferredGet.reject(new Error("HTTP 404: Run not found"));
    });

    // Preview must be removed so stale unauthorized content is not displayed
    expect(screen.queryByText("memory.organize")).toBeNull();
    expect(screen.queryByText("步骤 1 · 单轮任务")).toBeNull();
    // Error must be visible
    expect(screen.getByText("HTTP 404: Run not found")).toBeTruthy();
  });

  it("switches attempt preview immediately without secondary fetch wait", async () => {
    const run1 = createSnapshot("run-1", "memory.organize");
    const run2 = {
      ...createSnapshot("run-2", "memory.summarize"),
      startedAt: "2026-09-27T00:00:00.000Z",
    };
    const deferredGet2 = makeDeferred<RunSnapshot>();

    const client = {
      ...api,
      listRuns: vi.fn().mockResolvedValue({ runs: [run1, run2] }),
      getRun: vi.fn().mockImplementation((id: string) => {
        if (id === "run-1") return Promise.resolve(run1);
        return deferredGet2.promise;
      }),
    };
    store.getState().resetForTests(client);

    render(<RunAttempts ownerKind="memory_job" ownerId="job-one" />);

    // run2 is newer (startedAt 2026-09-27 vs 2026-09-26), so run2 is selected initially
    expect(await screen.findByText("memory.summarize")).toBeTruthy();

    // Switch to run1
    const select = screen.getByRole("combobox", { name: "运行尝试" });
    fireEvent.change(select, { target: { value: "run-1" } });

    // run1 metadata is visible immediately
    expect(await screen.findByText("memory.organize")).toBeTruthy();
    expect(screen.queryByText("memory.summarize")).toBeNull();
  });

  it("direct RunWorkspace mount without list seed waits for authoritative getRun without relying on unprovable store snapshots", async () => {
    const retainedRun = createSnapshot("run-direct", "unprovable.cached.spec");
    const deferredGet = makeDeferred<RunSnapshot>();

    const client = {
      ...api,
      getRun: vi.fn().mockImplementation(() => deferredGet.promise),
    };
    store.getState().resetForTests(client);
    // Retain snapshot in store (unverified RAM state)
    store.getState().receiveRunSnapshot(retainedRun);

    render(<RunWorkspace runId="run-direct" />);

    // Unprovable RAM snapshot is NOT used as preview; status indicator is shown
    expect(screen.queryByText("unprovable.cached.spec")).toBeNull();
    expect(screen.getByText("正在读取运行记录…")).toBeTruthy();

    // Background authoritative check is dispatched
    expect(client.getRun).toHaveBeenCalledWith("run-direct", expect.any(AbortSignal));

    // Resolving authoritative getRun displays the confirmed metadata
    await act(async () => {
      deferredGet.resolve(retainedRun);
    });
    expect(screen.getByText("unprovable.cached.spec")).toBeTruthy();
    expect(screen.queryByText("正在读取运行记录…")).toBeNull();
  });

  it("does not leak previous owner preview when owner changes", async () => {
    const runJob1 = createSnapshot("run-job1", "job1.spec", "completed", "job-1");
    const deferredJob2List = makeDeferred<{ runs: RunSnapshot[] }>();

    const client = {
      ...api,
      listRuns: vi.fn().mockImplementation((_kind: string, id: string) => {
        if (id === "job-1") return Promise.resolve({ runs: [runJob1] });
        return deferredJob2List.promise;
      }),
      getRun: vi.fn().mockResolvedValue(runJob1),
    };
    store.getState().resetForTests(client);

    const { rerender } = render(<RunAttempts ownerKind="memory_job" ownerId="job-1" />);

    expect(await screen.findByText("job1.spec")).toBeTruthy();

    // Switch ownerId to job-2 while its listRuns is still pending
    rerender(<RunAttempts ownerKind="memory_job" ownerId="job-2" />);

    // job1 spec must not linger while job-2 is pending
    expect(screen.queryByText("job1.spec")).toBeNull();
  });
  it("does not leak or display old-scope metadata/outputs when apiClient changes and fresh getRun is pending", async () => {
    const oldRun = {
      ...createSnapshot("shared-run-id", "old.api.spec", "failed"),
      outputs: [{ outputId: "out-old-api", targetId: "target-old", status: "failed" as const }],
    };
    // Store receives snapshot from old API session
    store.getState().receiveRunSnapshot(oldRun);
    expect(store.getState().runById["shared-run-id"]?.snapshot?.specId).toBe("old.api.spec");

    // Now apiClient changes via setState without clearing runById
    const deferredFreshGet = makeDeferred<RunSnapshot>();
    const newClient = {
      ...api,
      getRun: vi.fn().mockImplementation(() => deferredFreshGet.promise),
    };
    store.setState({ apiClient: newClient });

    // Mount RunWorkspace on the new API with the same runId (direct link without list initialSnapshot)
    render(<RunWorkspace runId="shared-run-id" />);

    // MUST NOT display old-scope metadata or outputs
    expect(screen.queryByText("old.api.spec")).toBeNull();
    expect(screen.queryByText("out-old-api")).toBeNull();
    expect(screen.queryByText("运行失败")).toBeNull();
    expect(screen.getByText("正在读取运行记录…")).toBeTruthy();

    // When fresh authoritative getRun finishes, new data displays correctly
    const freshRun = {
      ...createSnapshot("shared-run-id", "new.api.spec", "completed"),
      outputs: [{ outputId: "out-new-api", targetId: "target-new", status: "prepared" as const }],
    };
    await act(async () => {
      deferredFreshGet.resolve(freshRun);
    });
    expect(screen.getByText("new.api.spec")).toBeTruthy();
    expect(screen.getByText("out-new-api")).toBeTruthy();
    expect(screen.queryByText("old.api.spec")).toBeNull();
  });
  it("does not leak old live status/outputs when old live has higher seq and store rejected merge", async () => {
    const oldPollutedRun: RunSnapshot = {
      ...createSnapshot("run-seq-clash", "old.seq.spec", "failed"),
      lastSeq: 999,
      outputs: [{ outputId: "out-old-private", targetId: "target-old", status: "failed" }],
    };
    // Old session populated store with lastSeq: 999
    store.getState().receiveRunSnapshot(oldPollutedRun);
    expect(store.getState().runById["run-seq-clash"]?.lastSeq).toBe(999);

    // Switch apiClient without store purge
    const freshRun: RunSnapshot = {
      ...createSnapshot("run-seq-clash", "fresh.clean.spec", "completed"),
      lastSeq: 1,
      outputs: [{ outputId: "out-fresh-clean", targetId: "target-fresh", status: "prepared" }],
    };
    const client = {
      ...api,
      getRun: vi.fn().mockResolvedValue(freshRun),
    };
    store.setState({ apiClient: client });

    render(<RunWorkspace runId="run-seq-clash" />);

    // Fresh authoritative data settles
    expect(await screen.findByText("fresh.clean.spec")).toBeTruthy();
    expect(screen.getByText("out-fresh-clean")).toBeTruthy();
    expect(screen.getByText("target-fresh · prepared")).toBeTruthy();

    // MUST NOT leak old-scope polluted status or outputs from seq 999
    expect(screen.queryByText("out-old-private")).toBeNull();
    expect(screen.queryByText("运行失败")).toBeNull();
  });
  it("retains legitimate historical conversation runs with different epoch row owner ids", async () => {
    const epochRun1: RunSnapshot = {
      ...createSnapshot("run-epoch-1", "chat.epoch1"),
      owner: { kind: "conversation", id: "row-epoch-1" },
    };
    const epochRun2: RunSnapshot = {
      ...createSnapshot("run-epoch-2", "chat.epoch2"),
      owner: { kind: "conversation", id: "row-epoch-2" },
      startedAt: "2026-09-27T00:00:00.000Z",
    };
    const client = {
      ...api,
      listRuns: vi.fn().mockResolvedValue({ runs: [epochRun1, epochRun2] }),
      getRun: vi
        .fn()
        .mockImplementation((id: string) =>
          Promise.resolve(id === "run-epoch-1" ? epochRun1 : epochRun2),
        ),
    };
    store.getState().resetForTests(client);

    render(<RunAttempts ownerKind="conversation" ownerId="conversation-main" />);

    // Legitimate history rows across epochs must not be discarded
    expect(await screen.findByText("chat.epoch2")).toBeTruthy();
  });

  it("direct RunWorkspace derives owner from authoritative getRun and triggers SSE update on matching event while ignoring unrelated", async () => {
    const runSnapshot: RunSnapshot = {
      ...createSnapshot("run-direct-sse", "chat.direct.sse", "completed"),
      owner: { kind: "conversation", id: "conv-target" },
    };
    const getRunSpy = vi.fn().mockResolvedValue(runSnapshot);
    const client = {
      ...api,
      getRun: getRunSpy,
    };
    store.getState().resetForTests(client);

    const view = render(<RunWorkspace runId="run-direct-sse" />);
    expect(getRunSpy).toHaveBeenCalledTimes(1);

    await act(async () => {
      await Promise.resolve();
    });
    expect(await screen.findByText("chat.direct.sse")).toBeTruthy();

    // Unrelated conversation change event does not trigger read (extra 0)
    await act(async () => {
      notifyConversationChange({
        event: "conversation_changed",
        conversationId: "conv-unrelated",
        seq: 1,
        bindingEpoch: 1,
      });
    });
    expect(getRunSpy).toHaveBeenCalledTimes(1);

    // Matching owner conversation change event triggers instant read (extra 1, total 2)
    await act(async () => {
      notifyConversationChange({
        event: "conversation_changed",
        conversationId: "conv-target",
        seq: 2,
        bindingEpoch: 1,
      });
    });
    expect(getRunSpy).toHaveBeenCalledTimes(2);

    view.unmount();
  });
});

import type {
  RuntimeSpan,
  RuntimeTrace,
  RuntimeTraceDetail,
  RuntimeTracesPage,
} from "../../src/shared/contracts/runtime-observability";
import { i18n } from "../../src/web/i18n/runtime";

const wakeTraceId = "a".repeat(32);
const noModelStepLabel = () => i18n.t("observability.noModelStepHasStartedYet");
const traceDetailsLabel = () => i18n.t("observability.traceDetails");

function makeSpan(spanId: string, overrides: Partial<RuntimeSpan>): RuntimeSpan {
  return {
    id: 1,
    traceId: wakeTraceId,
    spanId,
    parentSpanId: null,
    name: spanId,
    at: now,
    finishedAt: now,
    durationMs: 10,
    channel: "system",
    stage: "run",
    status: "completed",
    code: "",
    model: null,
    conversationId: null,
    agentId: null,
    runId: null,
    wakeId: null,
    outputId: null,
    sourceSeq: null,
    details: {},
    ...overrides,
  };
}

function makeTraceDetail(runId: string, model: string | null): RuntimeTraceDetail {
  const wake = makeSpan("wake.timer", { id: 1, stage: "wake", runId, wakeId: "wake-1" });
  const call = makeSpan("model.generate", {
    id: 2,
    stage: "model",
    channel: "web",
    model,
    runId: "child-run-55e",
    parentSpanId: wake.spanId,
    durationMs: 6240,
    details: { model, stepId: "child-step-55e", phase: "leaf" },
  });
  const items = model ? [wake, call] : [wake];
  const trace: RuntimeTrace = {
    traceId: wakeTraceId,
    cursorId: 1,
    causes: [],
    specIds: ["memory.organize"],
    root: wake,
    at: now,
    lastActivityAt: now,
    finishedAt: now,
    durationMs: 6250,
    status: "completed",
    spanCount: items.length,
    matchedSpanCount: items.length,
    models: model ? [model] : [],
    channels: ["system", "web"],
    runIds: [runId],
    wakeIds: ["wake-1"],
  };
  return { now, trace, items, matchedSpanIds: items.map((item) => item.spanId) };
}

function tracesPage(details: RuntimeTraceDetail[]): RuntimeTracesPage {
  return {
    items: details.map((detail) => detail.trace),
    nextBeforeId: 1,
    hasMore: false,
    summary: {
      totalTraces: details.length,
      activeTraces: 0,
      failedTraces: 0,
      matchedSpans: details.length,
      lastActivityAt: now,
      now,
    },
  };
}

function zeroStepRun(runId = "run-zero", specId = "memory.organize"): RunSnapshot {
  return { ...createSnapshot(runId, specId), steps: [] };
}

describe("zero-step wake run resolves its trace through the existing canvas", () => {
  it("shows wake reason and child model calls for a zero-step parent once the trace settles", async () => {
    const deferredList = makeDeferred<RuntimeTracesPage>();
    const deferredWaterfall = makeDeferred<RuntimeTraceDetail>();
    const client = {
      ...api,
      getRun: vi.fn().mockResolvedValue(zeroStepRun()),
      listRuntimeTraces: vi.fn().mockImplementation(() => deferredList.promise),
      getRuntimeWaterfall: vi.fn().mockImplementation(() => deferredWaterfall.promise),
      inspectRunContext: vi.fn(),
    };
    store.getState().resetForTests(client);

    render(<RunWorkspace runId="run-zero" />);
    expect(await screen.findByText("memory.organize")).toBeTruthy();

    await waitFor(() => expect(client.listRuntimeTraces).toHaveBeenCalled());
    expect(client.listRuntimeTraces).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-zero" }),
      expect.any(AbortSignal),
    );

    // Tracing is still pending: no false "no model step" conclusion
    expect(screen.queryByText(noModelStepLabel())).toBeNull();
    // Protected bodies are never auto-inspected
    expect(client.inspectRunContext).not.toHaveBeenCalled();

    const detail = makeTraceDetail("run-zero", "gemini-2.5-flash");
    await act(async () => {
      deferredList.resolve(tracesPage([detail]));
    });
    await waitFor(() => expect(client.getRuntimeWaterfall).toHaveBeenCalled());
    await act(async () => {
      deferredWaterfall.resolve(detail);
    });

    expect((await screen.findAllByText("gemini-2.5-flash")).length).toBeGreaterThan(0);
    await userEvent.setup().click(screen.getByRole("button", { name: "步骤与技术追踪" }));
    expect((await screen.findAllByText("wake.timer")).length).toBeGreaterThan(0);
    expect(
      screen.getByRole("region", { name: i18n.t("observability.parentAndChildTiming") }),
    ).toBeTruthy();
    expect(screen.queryByText(noModelStepLabel())).toBeNull();
    expect(client.inspectRunContext).toHaveBeenCalledWith(
      { runId: "child-run-55e", stepId: "child-step-55e" },
      expect.any(AbortSignal),
    );
  });

  it("keeps own-step metadata immediate while discovering associated traces", async () => {
    const client = {
      ...api,
      getRun: vi.fn().mockResolvedValue(createSnapshot("run-normal", "memory.organize")),
      listRuntimeTraces: vi.fn().mockResolvedValue(tracesPage([])),
      getRuntimeWaterfall: vi.fn(),
    };
    store.getState().resetForTests(client);

    render(<RunWorkspace runId="run-normal" />);
    expect((await screen.findAllByText("model-alpha"))[0]).toBeTruthy();
    await act(async () => {
      await Promise.resolve();
    });
    expect(client.listRuntimeTraces).toHaveBeenCalledTimes(1);
    expect(client.getRuntimeWaterfall).not.toHaveBeenCalled();
  });

  it("surfaces the trace read error and clears a shown trace instead of guessing", async () => {
    const deferredList = makeDeferred<RuntimeTracesPage>();
    const client = {
      ...api,
      getRun: vi.fn().mockResolvedValue(zeroStepRun("run-error")),
      listRuntimeTraces: vi.fn().mockImplementation(() => deferredList.promise),
      getRuntimeWaterfall: vi.fn(),
    };
    store.getState().resetForTests(client);

    render(<RunWorkspace runId="run-error" />);
    await waitFor(() => expect(client.listRuntimeTraces).toHaveBeenCalled());

    await act(async () => {
      deferredList.reject(new Error("HTTP 503: trace store unavailable"));
    });

    expect(await screen.findByText("HTTP 503: trace store unavailable")).toBeTruthy();
    expect(screen.queryByText("gemini-2.5-flash")).toBeNull();
    expect(screen.queryByRole("region", { name: traceDetailsLabel() })).toBeNull();
  });

  it("rejects a late trace result that belongs to another run", async () => {
    const deferredList = makeDeferred<RuntimeTracesPage>();
    const client = {
      ...api,
      getRun: vi.fn().mockResolvedValue(zeroStepRun("run-late")),
      listRuntimeTraces: vi.fn().mockImplementation(() => deferredList.promise),
      getRuntimeWaterfall: vi.fn(),
    };
    store.getState().resetForTests(client);

    render(<RunWorkspace runId="run-late" />);
    await waitFor(() => expect(client.listRuntimeTraces).toHaveBeenCalled());

    const foreign = makeTraceDetail("run-other", "gemini-2.5-flash");
    await act(async () => {
      deferredList.resolve(tracesPage([foreign]));
    });

    expect(screen.queryByText("gemini-2.5-flash")).toBeNull();
    expect(screen.queryByRole("region", { name: traceDetailsLabel() })).toBeNull();
    expect(client.getRuntimeWaterfall).not.toHaveBeenCalled();
  });
});

describe("readable run overview preserves technical details", () => {
  it("shows recorded calls and automatically inspects their evidence in either view", async () => {
    const snapshot = createSnapshot("overview-run", "memory.organize");
    const inspect = vi.fn();
    const client = {
      ...api,
      getRun: vi.fn().mockResolvedValue(snapshot),
      inspectRunContext: inspect,
    };
    store.getState().resetForTests(client);
    render(<RunWorkspace runId="overview-run" />);
    expect(await screen.findByText("本运行已记录 1 次模型调用（不含子运行）")).toBeTruthy();
    expect(screen.getByRole("button", { name: "易读概览" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(screen.getByRole("button", { name: "步骤 1 · 单轮任务" })).toBeTruthy();
    expect(inspect).toHaveBeenCalledWith(snapshot.steps[0].context, expect.any(AbortSignal));
    await userEvent.setup().click(screen.getByRole("button", { name: "步骤与技术追踪" }));
    expect(
      screen.getByRole("button", { name: "步骤与技术追踪" }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.getByRole("button", { name: "步骤 1 · 单轮任务" })).toBeTruthy();
    expect(inspect).toHaveBeenCalledWith(snapshot.steps[0].context, expect.any(AbortSignal));
  });
  it("shows child call records for a zero-step parent without declaring a complete total", async () => {
    const detail = makeTraceDetail("overview-parent", "child-model");
    store.getState().resetForTests({
      ...api,
      getRun: vi.fn().mockResolvedValue(zeroStepRun("overview-parent")),
      listRuntimeTraces: vi.fn().mockResolvedValue(tracesPage([detail])),
      getRuntimeWaterfall: vi.fn().mockResolvedValue(detail),
      inspectRunContext: vi.fn(),
    });
    render(<RunWorkspace runId="overview-parent" />);
    expect((await screen.findAllByText("child-model"))[0]).toBeTruthy();
    expect(store.getState().apiClient.inspectRunContext).toHaveBeenCalledWith(
      { runId: "child-run-55e", stepId: "child-step-55e" },
      expect.any(AbortSignal),
    );
    await userEvent.setup().click(screen.getByRole("button", { name: "步骤与技术追踪" }));
    expect(
      await screen.findByRole("region", { name: i18n.t("observability.parentAndChildTiming") }),
    ).toBeTruthy();
    expect(store.getState().apiClient.getRuntimeWaterfall).toHaveBeenCalledTimes(1);
    expect(store.getState().apiClient.inspectRunContext).toHaveBeenCalledWith(
      { runId: "child-run-55e", stepId: "child-step-55e" },
      expect.any(AbortSignal),
    );
  });
});

function sixTraceDetails(runId: string): RuntimeTraceDetail[] {
  return [1, 2, 3, 4, 5, 6].map((n) => {
    const detail = makeTraceDetail(runId, `model-${n}`);
    const traceId = String(n).repeat(32);
    return {
      ...detail,
      trace: { ...detail.trace, traceId },
      items: detail.items.map((item) => ({ ...item, traceId })),
    };
  });
}

describe("bounded parallel trace waterfall reads", () => {
  it("reads waterfalls in order with at most four concurrent requests and no duplicates", async () => {
    const details = sixTraceDetails("run-parallel");
    const byId = new Map(details.map((detail) => [detail.trace.traceId, detail]));
    const pending: (() => void)[] = [];
    let active = 0;
    let maxActive = 0;
    const getRuntimeWaterfall = vi.fn((traceId: string) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      return new Promise<RuntimeTraceDetail>((resolve) => {
        pending.push(() => {
          active -= 1;
          resolve(byId.get(traceId)!);
        });
      });
    });
    const client = {
      ...api,
      getRun: vi.fn().mockResolvedValue(zeroStepRun("run-parallel")),
      listRuntimeTraces: vi.fn().mockResolvedValue(tracesPage(details)),
      getRuntimeWaterfall,
      inspectRunContext: vi.fn(),
    };
    store.getState().resetForTests(client);

    render(<RunWorkspace runId="run-parallel" />);

    // First chunk starts; the remaining two wait for it to settle.
    await waitFor(() => expect(getRuntimeWaterfall).toHaveBeenCalledTimes(4));
    expect(maxActive).toBe(4);
    await act(async () => {
      for (const done of pending.splice(0)) done();
    });

    await waitFor(() => expect(getRuntimeWaterfall).toHaveBeenCalledTimes(6));
    await act(async () => {
      for (const done of pending.splice(0)) done();
    });

    expect(maxActive).toBe(4);
    expect(new Set(getRuntimeWaterfall.mock.calls.map(([traceId]) => traceId)).size).toBe(6);
  });

  it("stops launching new waterfall chunks after the first failure", async () => {
    const details = sixTraceDetails("run-waterfall-failure");
    const getRuntimeWaterfall = vi.fn((traceId: string) => {
      if (traceId === details[0].trace.traceId) {
        return Promise.reject(new Error("HTTP 503: waterfall unavailable"));
      }
      return Promise.resolve(details.find((detail) => detail.trace.traceId === traceId)!);
    });
    const client = {
      ...api,
      getRun: vi.fn().mockResolvedValue(zeroStepRun("run-waterfall-failure")),
      listRuntimeTraces: vi.fn().mockResolvedValue(tracesPage(details)),
      getRuntimeWaterfall,
      inspectRunContext: vi.fn(),
    };
    store.getState().resetForTests(client);

    render(<RunWorkspace runId="run-waterfall-failure" />);

    expect(await screen.findByText("HTTP 503: waterfall unavailable")).toBeTruthy();
    // Only the first chunk was launched; the second chunk never starts.
    expect(getRuntimeWaterfall).toHaveBeenCalledTimes(4);
  });
});
