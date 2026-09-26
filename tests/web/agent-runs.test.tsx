import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InspectedContext, RunEvent, RunSnapshot } from "../../src/shared/contracts/agent-run";
import { api } from "../../src/web/api";
import { resolveModelUse } from "../../src/web/features/models/model-use";
import { JobRunLink, runStatusLabel } from "../../src/web/features/runs/RunInspector";
import { mergeRunSnapshot, reduceRunEvent } from "../../src/web/features/runs/run-state";
import { selectLocale } from "../../src/web/i18n";
import { useSuperstringStore as store } from "../../src/web/store";

const now = "2026-09-26T00:00:00.000Z";
function snapshot(
  runId = "run-one",
  status: RunSnapshot["status"] = "completed",
  lastSeq = 3,
): RunSnapshot {
  return {
    runId,
    specId: "memory.organize",
    specVersion: "1",
    owner: { kind: "memory_job", id: "job-one" },
    status,
    lastSeq,
    outputs: [],
    startedAt: now,
    endedAt: status === "completed" ? now : null,
    errorCode: null,
    steps: [
      {
        stepId: "step-one",
        runId,
        stepNo: 1,
        model: "model-a",
        phase: "leaf",
        status: "completed",
        context: { runId, stepId: "step-one" },
        startedAt: now,
        endedAt: now,
        errorCode: null,
      },
    ],
  };
}
function event(
  runId: string,
  seq: number,
  payload:
    | Omit<Extract<RunEvent, { type: "output_delta" }>, "runId" | "seq" | "at">
    | { type: "started" }
    | { type: "failed"; code: string }
    | { type: "no_output" },
): RunEvent {
  return { runId, seq, at: now, ...payload };
}
const exact: InspectedContext = {
  result: { status: "exact", format: "text", text: "private model output" },
  status: "exact",
  layout: [{ role: "user", units: 18, sourceIds: ["source-one"] }],
  sourceVersions: [{ id: "source-one", revision: "1" }],
  exactMessages: [{ role: "user", content: [{ kind: "text", text: "private source text" }] }],
};
beforeEach(() => {
  selectLocale("zh-CN");
  store.getState().resetForTests();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("run reducer", () => {
  it("isolates runs, reorders buffered deltas and deduplicates replay", () => {
    let runs = reduceRunEvent({}, event("a", 1, { type: "started" }));
    runs = reduceRunEvent(runs, event("b", 1, { type: "started" }));
    runs = reduceRunEvent(
      runs,
      event("a", 3, { type: "output_delta", outputId: "o", text: "world" }),
    );
    expect(runs.a.lastSeq).toBe(1);
    runs = reduceRunEvent(
      runs,
      event("a", 2, { type: "output_delta", outputId: "o", text: "hello " }),
    );
    expect(runs.a.outputTextById.o).toBe("hello world");
    expect(runs.b.status).toBe("prepared");
    expect(
      reduceRunEvent(runs, event("a", 2, { type: "output_delta", outputId: "o", text: "hello " })),
    ).toBe(runs);
  });
  it("keeps partial text after failure and does not create output for no_output", () => {
    let runs = reduceRunEvent(
      {},
      event("a", 1, { type: "output_delta", outputId: "o", text: "partial" }),
    );
    runs = reduceRunEvent(runs, event("a", 2, { type: "failed", code: "INTERRUPTED" }));
    expect(runs.a).toMatchObject({
      status: "failed",
      errorCode: "INTERRUPTED",
      outputTextById: { o: "partial" },
    });
    runs = reduceRunEvent(runs, event("b", 1, { type: "no_output" }));
    expect(runs.b).toMatchObject({ status: "no_output", outputs: [], outputTextById: {} });
  });
  it("does not let a stale HTTP snapshot overwrite later events; accepts authoritative outputs", () => {
    let runs = mergeRunSnapshot({}, snapshot("a", "prepared", 1));
    runs = reduceRunEvent(runs, event("a", 2, { type: "failed", code: "MODEL_ERROR" }));
    expect(mergeRunSnapshot(runs, snapshot("a", "prepared", 1))).toBe(runs);
    const finished = {
      ...snapshot("a", "completed", 3),
      outputs: [{ outputId: "out", targetId: "target", status: "prepared" as const }],
    };
    expect(mergeRunSnapshot(runs, finished).a.outputs).toEqual(finished.outputs);
  });
  it("purges retained output when a redacted event is replayed", () => {
    const e = event("a", 1, { type: "output_delta", outputId: "o", text: "private" });
    const runs = reduceRunEvent({}, e);
    expect(reduceRunEvent(runs, { ...e, dataStatus: "revoked" }).a.outputTextById).toEqual({});
  });
});

describe("typed run API", () => {
  it("encodes IDs, sends no client principal and bypasses browser caches", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify(exact), { status: 200 }));
    await api.inspectRunContext({ runId: "a/b", stepId: "x?y" });
    expect(fetch).toHaveBeenCalledWith("/v2/runs/a%2Fb/context/x%3Fy", {
      signal: undefined,
      cache: "no-store",
    });
  });
  it("rejects a malformed run instead of silently treating it as complete", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ runId: "a", status: "completed" }), { status: 200 }),
    );
    await expect(api.getRun("a")).rejects.toThrow();
  });
});

describe("run inspector", () => {
  function setup(inspect = vi.fn().mockResolvedValue(exact)) {
    const current = snapshot();
    const previous = {
      ...snapshot("run-previous", "failed"),
      errorCode: "MODEL_ERROR",
      startedAt: "2026-09-25T00:00:00.000Z",
    };
    const client = {
      ...api,
      listRuns: vi.fn().mockResolvedValue({ runs: [previous, current] }),
      getRun: vi.fn().mockImplementation(async (id) => (id === current.runId ? current : previous)),
      inspectRunContext: inspect,
    };
    store.getState().resetForTests(client);
    render(<JobRunLink ownerKind="memory_job" ownerId="job-one" />);
    return client;
  }
  it("loads owner attempts on open, only inspects on request, and restores focus on Escape", async () => {
    const client = setup();
    const user = userEvent.setup();
    const trigger = screen.getByRole("button", { name: "运行详情" });
    expect(client.listRuns).not.toHaveBeenCalled();
    await user.click(trigger);
    await screen.findByText("步骤 1 · 单轮任务");
    expect(client.listRuns).toHaveBeenCalledWith("memory_job", "job-one", expect.any(AbortSignal));
    expect(client.inspectRunContext).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "关闭运行详情" }));
    expect((screen.getByRole("combobox", { name: "运行尝试" }) as HTMLSelectElement).value).toBe(
      "run-one",
    );
    await user.click(screen.getByRole("button", { name: "查看实际输入与输出" }));
    await screen.findByText("private source text");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });
  it("replaces inspected text after revocation and clears it when the window blurs", async () => {
    const inspect = vi
      .fn()
      .mockResolvedValueOnce(exact)
      .mockResolvedValueOnce({ ...exact, status: "revoked", exactMessages: undefined });
    setup(inspect);
    fireEvent.click(screen.getByRole("button", { name: "运行详情" }));
    fireEvent.click(await screen.findByRole("button", { name: "查看实际输入与输出" }));
    await screen.findByText("private source text");
    fireEvent.click(screen.getByRole("button", { name: "重新核对实际输入与输出" }));
    await screen.findByText("来源已撤权或删除，实际输入不可查看；仅保留允许的元数据。");
    expect(screen.queryByText("private source text")).toBeNull();
    act(() => window.dispatchEvent(new Event("blur")));
    expect(
      screen.queryByText("来源已撤权或删除，实际输入不可查看；仅保留允许的元数据。"),
    ).toBeNull();
  });
  it("aborts a late context request when another attempt is selected", async () => {
    let finish: (value: InspectedContext) => void = () => {};
    const inspect = vi.fn().mockImplementation(
      () =>
        new Promise<InspectedContext>((resolve) => {
          finish = resolve;
        }),
    );
    setup(inspect);
    fireEvent.click(screen.getByRole("button", { name: "运行详情" }));
    fireEvent.click(await screen.findByRole("button", { name: "查看实际输入与输出" }));
    fireEvent.change(screen.getByRole("combobox", { name: "运行尝试" }), {
      target: { value: "run-previous" },
    });
    expect(inspect.mock.calls[0][1].aborted).toBe(true);
    await act(async () => finish(exact));
    expect(screen.queryByText("private source text")).toBeNull();
  });
});

describe("run phase language", () => {
  it("distinguishes maintenance and image tasks from conversation reply generation", () => {
    expect(runStatusLabel("generating", "leaf")).toBe("正在处理");
    expect(runStatusLabel("generating", "vision")).toBe("正在理解图片");
    expect(runStatusLabel("generating", "generate")).toBe("正在回复");
  });
});

describe("model scope and precedence", () => {
  it("preserves every fallback and distinguishes unloaded defaults from unset", () => {
    expect(resolveModelUse("memory_organization", null, "chat", "shared")).toEqual({
      model: "shared",
      source: "shared_default",
    });
    expect(resolveModelUse("memory_organization", null, "chat", null)).toEqual({
      model: "chat",
      source: "chat",
    });
    expect(resolveModelUse("memory_organization", null, "chat")).toEqual({
      model: null,
      source: "unloaded",
    });
    expect(resolveModelUse("knowledge_organization", null, "unused", null)).toEqual({
      model: null,
      source: "gateway",
    });
    expect(resolveModelUse("qq_judgement", null, "editor-agent")).toEqual({
      model: null,
      source: "bound_chat",
    });
    expect(resolveModelUse("vision", null, "chat", "shared")).toEqual({
      model: null,
      source: "unconfigured",
    });
    expect(resolveModelUse("retrieval", "explicit", "chat")).toEqual({
      model: "explicit",
      source: "agent",
    });
  });
});
