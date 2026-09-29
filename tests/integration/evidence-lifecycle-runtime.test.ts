import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { AgentRuntime } from "../../src/server/agent/agent-runtime";
import type { ActionDescription, AgentSpec } from "../../src/server/agent/agent-specs";
import {
  type ActionContext,
  type BuiltInAction,
  createBuiltInActions,
  type EvidenceQueryModule,
} from "../../src/server/agent/built-in-actions";
import type { CodeRunner } from "../../src/server/agent/code-runner";
import { textMessage } from "../../src/server/agent/context-engine";
import type { ModelPort } from "../../src/server/agent/model-port";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import type { RunOwner } from "../../src/shared/contracts/agent-run";
import type { Evidence } from "../../src/shared/contracts/evidence";
import { decideInline, decideInvoke, rawText, scriptedModel } from "../harness/model";

const handles: ReturnType<typeof openBusinessDb>[] = [];
afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
});

const owner: RunOwner = { kind: "test_job", id: "job-lifecycle", userId: "u", agentId: "a" };

function memoryItem(id: string): Evidence {
  return {
    id,
    text: `body ${id}`,
    preview: { title: `title ${id}`, summary: `summary ${id}` },
    sources: [{ kind: "memory", id, revision: "1" }],
  };
}

/** 记录每个 runId 披露过的引用/游标，并把 release 转发给真正的动作。 */
function fixture() {
  const track = new Map<string, { refs: string[]; cursors: string[] }>();
  const releases: { owner: RunOwner; runId?: string }[] = [];
  const module: EvidenceQueryModule = {
    async query(input) {
      return input.query === "b"
        ? { status: "ok", items: [memoryItem("b")], nextCursor: "b-next" }
        : [memoryItem(input.query)];
    },
  };
  const inner = createBuiltInActions(
    { memory: module },
    { assertSources: () => {}, fit: async () => () => true },
  );
  const tracked = inner.map(
    (action): BuiltInAction => ({
      ...action,
      release(scope) {
        releases.push(scope);
        action.release?.(scope);
      },
      async execute(arguments_, context) {
        const result = await action.execute(arguments_, context);
        const value = result.value as {
          items?: { bodyRef?: string }[];
          nextCursor?: string | null;
        };
        // 只记查询页披露的引用与游标；读取观测里的 bodyRef 不进账。
        if (context.runId && !("bodyRef" in arguments_)) {
          const bucket = track.get(context.runId) ?? { refs: [], cursors: [] };
          for (const item of value.items ?? []) if (item.bodyRef) bucket.refs.push(item.bodyRef);
          if (typeof value.nextCursor === "string") bucket.cursors.push(value.nextCursor);
          track.set(context.runId, bucket);
        }
        return result;
      },
    }),
  );
  return {
    track,
    releases,
    declarations: tracked.map((action) => action.description),
    tracked,
    /** 直接调用真实动作（绕过包装），用来断言释放后的行为。 */
    execute(name: string, input: Record<string, unknown>, context: ActionContext) {
      const action = inner.find((entry) => entry.description.name === name);
      if (!action) throw new Error(`Missing action ${name}`);
      return action.execute(input, context);
    },
  };
}

function contextFor(runId: string): ActionContext {
  return { owner, runId, signal: new AbortController().signal };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function runtimeInput(
  tool: ReturnType<typeof fixture>,
  signal: AbortSignal,
  configurations: (readonly ActionDescription[])[],
  greeting: string,
) {
  return {
    owner,
    authorizedTargets: ["web"],
    outputMode: "buffered" as const,
    signal,
    actions: tool.tracked,
    context: {
      configureActions(actions: readonly ActionDescription[]) {
        configurations.push(actions);
      },
      async read() {
        return { pending: [textMessage("user", greeting)] };
      },
    },
  };
}

describe("evidence action lifecycle through AgentRuntime", () => {
  it("releases the finished run's action contexts, including code-mode inner calls, without touching a concurrent run", async () => {
    const handle = openBusinessDb();
    handles.push(handle);
    const repository = new AgentRunRepository(handle.db);
    const tool = fixture();

    let codeRuns = 0;
    const runner: CodeRunner = {
      available: true,
      async run({ bindings }) {
        codeRuns++;
        await bindings["memory.query"]?.({ query: "inner" });
        return { conclusion: "inner read" };
      },
    };
    const decisions = scriptedModel([
      decideInvoke("code.run", { script: "return await tools['memory.query']({query:'inner'});" }),
      decideInline("web", "done-a"),
    ]);
    const runtimeA = new AgentRuntime({
      repository,
      model: decisions.port,
      codeMode: { runner, enabled: () => true, allowsModel: () => true },
    });

    const gate = deferred<void>();
    const entered = deferred<void>();
    let bDecisions = 0;
    const portB: ModelPort = {
      async complete() {
        bDecisions++;
        if (bDecisions === 1)
          return JSON.stringify({
            kind: "invoke",
            name: "memory.query",
            arguments: { query: "b" },
          });
        entered.resolve();
        await gate.promise;
        return JSON.stringify({
          kind: "final",
          outputs: [{ kind: "inline", targetId: "web", text: "done-b" }],
        });
      },
      async *streamText() {
        yield "unused";
      },
      async completeMultimodal() {
        return "unused";
      },
    };
    const runtimeB = new AgentRuntime({ repository, model: portB });

    const spec: AgentSpec = {
      id: "lifecycle",
      model: "chat",
      instructions: "Persona",
      context: "conversation",
      availableActions: tool.declarations,
      limits: { steps: 8 },
    };
    const signalA = new AbortController();
    const signalB = new AbortController();
    const configurationsA: (readonly ActionDescription[])[] = [];
    const configurationsB: (readonly ActionDescription[])[] = [];
    const setSpy = spyOn(globalThis, "setTimeout");
    const clearSpy = spyOn(globalThis, "clearTimeout");
    try {
      const pendingA = runtimeA.run(
        { ...spec, id: "lifecycle-a", limits: { steps: 8, deadlineMs: 60_000 } },
        runtimeInput(tool, signalA.signal, configurationsA, "hello-a"),
      );
      const pendingB = runtimeB.run(
        { ...spec, id: "lifecycle-b" },
        runtimeInput(tool, signalB.signal, configurationsB, "hello-b"),
      );
      await entered.promise;

      // A 正常结束：dispose 仍执行（给这一轮建的 deadline timer 被清掉）。
      const finishedA = await pendingA;
      expect(finishedA.status).toBe("completed");
      const timers = setSpy.mock.calls
        .map((call, index) => ({ delay: call[1], value: setSpy.mock.results[index]?.value }))
        .filter((entry) => entry.delay === 60_000);
      expect(timers).toHaveLength(1);
      expect(clearSpy.mock.calls.some((call) => call[0] === timers[0]?.value)).toBe(true);

      const runs = repository.listRuns({ ownerKind: owner.kind, ownerId: owner.id });
      expect(runs).toHaveLength(2);
      const concurrent = runs.find((run) => run.runId !== finishedA.runId);
      if (!concurrent) throw new Error("Missing concurrent run");
      const bucketA = tool.track.get(finishedA.runId);
      const bucketB = tool.track.get(concurrent.runId);
      // A 的引用只来自 code-mode 沙箱内的调用，仍然被本次 run 的释放覆盖。
      expect(codeRuns).toBe(1);
      expect(bucketA?.refs).toHaveLength(1);
      expect(bucketB?.refs).toHaveLength(1);
      expect(bucketB?.cursors).toHaveLength(1);
      await expect(
        tool.execute("memory.read", { bodyRef: bucketA?.refs[0] }, contextFor(finishedA.runId)),
      ).rejects.toMatchObject({ code: "CONTEXT_INVALID_SELECTION" });
      // B 仍在并发进行：同一 factory 的共享状态按 (owner, runId) 隔离，B 的引用照常可用。
      const alive = await tool.execute(
        "memory.read",
        { bodyRef: bucketB?.refs[0] },
        contextFor(concurrent.runId),
      );
      expect(alive.value).toMatchObject({ status: "ok" });
      expect(signalA.signal.aborted).toBe(false);
      expect(signalB.signal.aborted).toBe(false);

      // 放行 B：正常结束后同样释放，引用与游标一并失效，调用方 signal 不被打断。
      gate.resolve();
      const finishedB = await pendingB;
      expect(finishedB.status).toBe("completed");
      expect(signalB.signal.aborted).toBe(false);
      await expect(
        tool.execute("memory.read", { bodyRef: bucketB?.refs[0] }, contextFor(concurrent.runId)),
      ).rejects.toMatchObject({ code: "CONTEXT_INVALID_SELECTION" });
      await expect(
        tool.execute(
          "memory.query",
          { query: "b", cursor: bucketB?.cursors[0] },
          contextFor(concurrent.runId),
        ),
      ).rejects.toMatchObject({ code: "CONTEXT_INVALID_SELECTION" });
      // spec 恢复照旧：最后一次 configureActions 传回宿主声明的数组本体。
      expect(configurationsA.at(-1)).toBe(tool.declarations);
      expect(configurationsB.at(-1)).toBe(tool.declarations);
      // 释放按各自的 runId 发生，不重叠。
      expect(new Set(tool.releases.map((entry) => entry.runId))).toEqual(
        new Set([finishedA.runId, finishedB.runId]),
      );
    } finally {
      setSpy.mockRestore();
      clearSpy.mockRestore();
    }
  });

  it("releases the failed run's action contexts and still restores the host spec", async () => {
    const handle = openBusinessDb();
    handles.push(handle);
    const repository = new AgentRunRepository(handle.db);
    const tool = fixture();
    const decisions = scriptedModel([
      decideInvoke("memory.query", { query: "x" }),
      rawText("not a decision"),
    ]);
    const runtime = new AgentRuntime({ repository, model: decisions.port });
    const signal = new AbortController();
    const configurations: (readonly ActionDescription[])[] = [];
    await expect(
      runtime.run(
        {
          id: "lifecycle-failed",
          model: "chat",
          instructions: "Persona",
          context: "conversation",
          availableActions: tool.declarations,
          limits: { steps: 8 },
        },
        runtimeInput(tool, signal.signal, configurations, "hello"),
      ),
    ).rejects.toMatchObject({ code: "AGENT_DECISION_INVALID" });

    const runs = repository.listRuns({ ownerKind: owner.kind, ownerId: owner.id });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "failed", errorCode: "AGENT_DECISION_INVALID" });
    const bucket = tool.track.get(runs[0].runId);
    expect(bucket?.refs).toHaveLength(1);
    await expect(
      tool.execute("memory.read", { bodyRef: bucket?.refs[0] }, contextFor(runs[0].runId)),
    ).rejects.toMatchObject({ code: "CONTEXT_INVALID_SELECTION" });
    expect(signal.signal.aborted).toBe(false);
    expect(configurations.at(-1)).toBe(tool.declarations);
  });
});
