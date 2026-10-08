import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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
    expect(screen.getByText("步骤 1 · 单轮任务")).toBeTruthy();
    expect(screen.getByText("model-alpha")).toBeTruthy();
    expect(screen.getByText("target-1 · prepared")).toBeTruthy();
    expect(screen.getByText("out-run-1")).toBeTruthy();
    expect(screen.queryByText("正在读取运行记录…")).toBeNull();

    // Authoritative getRun was still dispatched in the background
    expect(client.getRun).toHaveBeenCalledWith("run-1", expect.any(AbortSignal));

    // Protected ModelEvidence is NEVER auto-inspected
    expect(client.inspectRunContext).not.toHaveBeenCalled();

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
