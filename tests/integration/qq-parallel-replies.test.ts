import { afterEach, describe, expect, it } from "bun:test";
import { AgentRuntime } from "../../src/server/agent/agent-runtime";
import type { AgentSpec } from "../../src/server/agent/agent-specs";
import { textMessage } from "../../src/server/agent/context-engine";
import type { ModelPort, ModelRequest } from "../../src/server/agent/model-port";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { openBusinessDb } from "../../src/server/db/schema-gate";

const handles: ReturnType<typeof openBusinessDb>[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
});
const owner = { kind: "test_job", id: "job-1", userId: "u", agentId: "a" };
const spec: AgentSpec = {
  id: "main",
  model: "chat",
  instructions: "Persona",
  context: "conversation",
  availableActions: [],
  limits: { steps: 8 },
};
const direct = {
  owner,
  authorizedTargets: ["alice", "bob", "carol"],
  outputMode: "buffered" as const,
  context: {
    async read() {
      return { pending: [textMessage("user", "hello")] };
    },
  },
};

function setup(model: Partial<ModelPort>) {
  const h = openBusinessDb();
  handles.push(h);
  const repository = new AgentRunRepository(h.db);
  const port: ModelPort = {
    async complete() {
      return '{"kind":"none"}';
    },
    async *streamText() {
      yield "answer";
    },
    async completeMultimodal() {
      return "vision";
    },
    ...model,
  };
  return { h, repository, runtime: new AgentRuntime({ model: port, repository }) };
}

describe("stage2 parallel target generation", () => {
  it("overlaps distinct targets' model-call entries instead of running them one after another", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const started: string[] = [];
    const releaseEach: (() => void)[] = [];
    const gate = () =>
      new Promise<void>((resolve) => {
        releaseEach.push(resolve);
      });
    const { runtime } = setup({
      async complete() {
        return JSON.stringify({
          kind: "final",
          outputs: [
            { kind: "generate", targetId: "alice", instructions: "a" },
            { kind: "generate", targetId: "bob", instructions: "b" },
            { kind: "generate", targetId: "carol", instructions: "c" },
          ],
        });
      },
      async *streamText(request: ModelRequest) {
        const target = request.model ?? "?";
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        started.push(target);
        // 三个目标都进到这里之前不结束：串行实现会让 inFlight 恒为 1。
        // 范围：证明 Runtime 层模型调用入口的重叠，不是真实 HTTP 并发。
        await gate();
        inFlight -= 1;
        yield `answer:${target}`;
      },
    });
    const run = runtime.run(
      { ...spec, generation: {} },
      {
        ...direct,
        async prepareGeneration(draft) {
          return { model: `${draft.targetId}-reply` };
        },
      },
    );
    // 让三个并行调用都挂在自己的 gate 上，再逐个放行。
    while (releaseEach.length < 3) await Bun.sleep(1);
    for (const release of releaseEach) release();
    const result = await run;
    expect(maxInFlight).toBe(3);
    expect(started.sort()).toEqual(["alice-reply", "bob-reply", "carol-reply"]);
    expect(result.outputs.map((o) => [o.targetId, o.status])).toEqual([
      ["alice", "prepared"],
      ["bob", "prepared"],
      ["carol", "prepared"],
    ]);
  });

  it("keeps output order by the model's ordinal even when one target finishes later", async () => {
    const { runtime } = setup({
      async complete() {
        return JSON.stringify({
          kind: "final",
          outputs: [
            { kind: "generate", targetId: "alice", instructions: "a" },
            { kind: "inline", targetId: "bob", text: "inline-b", stickerIds: [] },
            { kind: "generate", targetId: "carol", instructions: "c" },
          ],
        });
      },
      async *streamText(request: ModelRequest) {
        // alice 最慢、carol 最快：完成顺序与 ordinal 相反。
        const delay = request.model === "alice-reply" ? 15 : 0;
        await Bun.sleep(delay);
        yield `answer:${request.model}`;
      },
    });
    const result = await runtime.run(
      { ...spec, generation: {} },
      {
        ...direct,
        async prepareGeneration(draft) {
          return { model: `${draft.targetId}-reply` };
        },
      },
    );
    expect(result.outputs.map((o) => o.targetId)).toEqual(["alice", "bob", "carol"]);
    expect(result.outputs[1]).toMatchObject({ status: "prepared", text: "inline-b" });
  });

  it("isolates a per-target resolved model so a sibling's resolution does not overwrite it", async () => {
    const models: string[] = [];
    const { runtime, repository } = setup({
      async complete() {
        return JSON.stringify({
          kind: "final",
          outputs: [
            { kind: "generate", targetId: "alice", instructions: "a" },
            { kind: "generate", targetId: "bob", instructions: "b" },
          ],
        });
      },
      async *streamText(request: ModelRequest) {
        const requested = request.model ?? "";
        await Bun.sleep(requested === "alice-reply" ? 10 : 0);
        models.push(requested);
        yield "answer";
      },
    });
    const result = await runtime.run(
      { ...spec, generation: {} },
      {
        ...direct,
        async prepareGeneration(draft) {
          return { model: `${draft.targetId}-reply` };
        },
      },
    );
    expect(result.outputs.map((o) => o.status)).toEqual(["prepared", "prepared"]);
    // 每个生成步各自记自己的实际模型，互不覆盖。
    expect(repository.getRun(result.runId)?.steps.map((step) => step.model)).toEqual([
      "chat",
      "alice-reply",
      "bob-reply",
    ]);
  });

  it("keeps a fast sibling's prepared output when another target's generation fails", async () => {
    const { runtime } = setup({
      async complete() {
        return JSON.stringify({
          kind: "final",
          outputs: [
            { kind: "generate", targetId: "alice", instructions: "a" },
            { kind: "generate", targetId: "bob", instructions: "b" },
          ],
        });
      },
      async *streamText(request: ModelRequest) {
        if (request.model === "alice-reply") throw new Error("ALICE_MODEL_DOWN");
        yield "answer:bob";
      },
    });
    const result = await runtime.run(
      { ...spec, generation: {} },
      {
        ...direct,
        authorizedTargets: ["alice", "bob"],
        async prepareGeneration(draft) {
          return { model: `${draft.targetId}-reply` };
        },
      },
    );
    expect(result.outputs.map((o) => [o.targetId, o.status, o.code])).toEqual([
      ["alice", "failed", "AGENT_FAILED"],
      ["bob", "prepared", undefined],
    ]);
  });
});

describe("stage2 prepare isolation and per-target host closures", () => {
  it("keeps a legal sibling when another target's prepareGeneration throws", async () => {
    // 准备段每目标独立 catch：一个目标的 prepare 失败只作废该目标，兄弟照常生成。
    const { runtime } = setup({
      async complete() {
        return JSON.stringify({
          kind: "final",
          outputs: [
            { kind: "generate", targetId: "alice", instructions: "a" },
            { kind: "generate", targetId: "bob", instructions: "b" },
          ],
        });
      },
      async *streamText(request: ModelRequest) {
        yield `answer:${request.model}`;
      },
    });
    const result = await runtime.run(
      { ...spec, generation: {} },
      {
        ...direct,
        authorizedTargets: ["alice", "bob"],
        async prepareGeneration(draft) {
          if (draft.targetId === "alice") throw new Error("ALICE_PREPARE_FAILED");
          return { model: `${draft.targetId}-reply` };
        },
      },
    );
    expect(result.outputs.map((o) => [o.targetId, o.status])).toEqual([
      ["alice", "failed"],
      ["bob", "prepared"],
    ]);
  });

  it("routes each target's onModelResolved to its own sink (real resolved model, not the requested one)", async () => {
    // 真实回调路径：requested 是 bob-reply，但服务经路由把 alice 的实际模型回成 alice-actual，
    // bob 回成 bob-actual；两者必须各自落在自己的目标上，互不覆盖。
    const { runtime, repository } = setup({
      async complete() {
        return JSON.stringify({
          kind: "final",
          outputs: [
            { kind: "generate", targetId: "alice", instructions: "a" },
            { kind: "generate", targetId: "bob", instructions: "b" },
          ],
        });
      },
      async *streamText(request: ModelRequest) {
        // 慢目标先回实际模型名，制造 resolved 覆盖窗口。
        await Bun.sleep(request.model === "alice-reply" ? 10 : 0);
        request.onModelResolved?.(`${request.model?.split("-")[0]}-actual`);
        yield "answer";
      },
    });
    const result = await runtime.run(
      { ...spec, generation: {} },
      {
        ...direct,
        async prepareGeneration(draft) {
          return { model: `${draft.targetId}-reply` };
        },
      },
    );
    expect(result.outputs.map((o) => o.status)).toEqual(["prepared", "prepared"]);
    // 生成步记录的是各自的实际模型，不是 requested 名。
    expect(
      repository
        .getRun(result.runId)
        ?.steps.filter((s) => s.phase === "generate")
        .map((s) => s.model),
    ).toEqual(["alice-actual", "bob-actual"]);
  });

  it("uses each target's own host hooks instead of a shared input closure", async () => {
    // 宿主按目标冻结的 hooks：consumed 回调只能记到该目标自己的 owner，不串到兄弟。
    const consumed: string[] = [];
    const { runtime } = setup({
      async complete() {
        return JSON.stringify({
          kind: "final",
          outputs: [
            { kind: "generate", targetId: "alice", instructions: "a" },
            { kind: "generate", targetId: "bob", instructions: "b" },
          ],
        });
      },
      async *streamText() {
        yield "answer";
      },
    });
    const result = await runtime.run(
      { ...spec, generation: {} },
      {
        ...direct,
        async prepareGeneration(draft) {
          const tag = draft.targetId;
          return {
            model: `${tag}-reply`,
            hooks: {
              onModelCallConsumed: () => consumed.push(tag),
            },
          };
        },
      },
    );
    expect(result.outputs.map((o) => o.status)).toEqual(["prepared", "prepared"]);
    expect(consumed.sort()).toEqual(["alice", "bob"]);
  });
});

describe("stage2 target-level early commit (§4.1)", () => {
  it("commits inline and fast targets before a slow sibling finishes, with per-target ordinal meta", async () => {
    const events: string[] = [];
    const meta: Record<string, { ordinal: number; at: string }> = {};
    let aliceDone = false;
    let bobSawAlicePending = false;
    let releaseAlice: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseAlice = resolve;
    });
    const { runtime } = setup({
      async complete() {
        return JSON.stringify({
          kind: "final",
          outputs: [
            { kind: "generate", targetId: "alice", instructions: "a" },
            { kind: "generate", targetId: "bob", instructions: "b" },
            { kind: "inline", targetId: "carol", text: "inline-c", stickerIds: [] },
          ],
        });
      },
      async *streamText(request: ModelRequest) {
        if (request.model === "alice-reply") {
          await gate;
          aliceDone = true;
          yield "answer:alice";
          return;
        }
        yield `answer:${request.model}`;
      },
    });
    const run = runtime.run(
      { ...spec, generation: {} },
      {
        ...direct,
        async prepareGeneration(draft) {
          return { model: `${draft.targetId}-reply` };
        },
        async commitOutput(output, _runId, commitMeta) {
          meta[output.targetId] = commitMeta;
          events.push(`commit:${output.targetId}`);
          if (output.targetId === "bob") bobSawAlicePending = !aliceDone;
          return true;
        },
      },
    );
    // fast 目标 bob 完成后即提交；此时慢目标 alice 仍挂在 gate 上（整批后提交的实现会漏掉该事件）。
    while (!events.includes("commit:bob")) await Bun.sleep(1);
    releaseAlice();
    const result = await run;
    expect(result.outputs.map((o) => [o.targetId, o.status])).toEqual([
      ["alice", "prepared"],
      ["bob", "prepared"],
      ["carol", "prepared"],
    ]);
    expect(events).toContain("commit:carol");
    expect(events.indexOf("commit:carol")).toBeLessThan(events.indexOf("commit:alice"));
    expect([meta.alice.ordinal, meta.bob.ordinal, meta.carol.ordinal]).toEqual([0, 1, 2]);
    expect(bobSawAlicePending).toBe(true);
    expect(typeof meta.bob.at).toBe("string");
  });

  it("keeps an early-committed target when a sibling generation fails and never re-commits it", async () => {
    const commitCalls: string[] = [];
    let terminal: Array<{ targetId: string; status: string }> = [];
    const { runtime } = setup({
      async complete() {
        return JSON.stringify({
          kind: "final",
          outputs: [
            { kind: "generate", targetId: "alice", instructions: "a" },
            { kind: "generate", targetId: "bob", instructions: "b" },
          ],
        });
      },
      async *streamText(request: ModelRequest) {
        if (request.model === "bob-reply") throw new Error("BOB_MODEL_DOWN");
        yield "answer:alice";
      },
    });
    const result = await runtime.run(
      { ...spec, generation: {} },
      {
        ...direct,
        authorizedTargets: ["alice", "bob"],
        async prepareGeneration(draft) {
          return { model: `${draft.targetId}-reply` };
        },
        async commitOutput(output) {
          commitCalls.push(output.targetId);
          return true;
        },
        async commitOutputs(outputs) {
          terminal = outputs.map((output) => ({
            targetId: output.targetId,
            status: output.status,
          }));
          return undefined;
        },
      },
    );
    expect(result.outputs.map((o) => [o.targetId, o.status])).toEqual([
      ["alice", "prepared"],
      ["bob", "failed"],
    ]);
    // alice 只早提交一次；终态结算仍带其事实（宿主据此跳过重复 outbox），不重生成也不抹除。
    expect(commitCalls).toEqual(["alice"]);
    expect(terminal).toEqual([
      { targetId: "alice", status: "prepared" },
      { targetId: "bob", status: "failed" },
    ]);
  });

  it("records a rejected early commit as blocked and does not commit it at terminal settlement", async () => {
    const commitCalls: string[] = [];
    let terminal: Array<{ targetId: string; status: string; code?: string }> = [];
    const { runtime } = setup({
      async complete() {
        return JSON.stringify({
          kind: "final",
          outputs: [{ kind: "generate", targetId: "alice", instructions: "a" }],
        });
      },
      async *streamText() {
        yield "answer";
      },
    });
    const result = await runtime.run(
      { ...spec, generation: {} },
      {
        ...direct,
        authorizedTargets: ["alice"],
        async prepareGeneration() {
          return { model: "alice-reply" };
        },
        async commitOutput(output) {
          commitCalls.push(output.targetId);
          return false; // 宿主拒绝（如来源纪元/许可失效）：未提交。
        },
        async commitOutputs(outputs) {
          terminal = outputs.map((output) => ({
            targetId: output.targetId,
            status: output.status,
            ...(output.code ? { code: output.code } : {}),
          }));
          return undefined;
        },
        silentBlockCodes: ["AGENT_EARLY_COMMIT_REJECTED"],
      },
    );
    expect(commitCalls).toEqual(["alice"]);
    expect(result.status).toBe("no_output");
    expect(terminal).toEqual([
      { targetId: "alice", status: "blocked", code: "AGENT_EARLY_COMMIT_REJECTED" },
    ]);
  });

  it("does not double-commit on a global abort and leaves the run terminal (settled before release)", async () => {
    const controller = new AbortController();
    const commitCalls: string[] = [];
    let commitOutputsCalls = 0;
    const { runtime, repository } = setup({
      async complete() {
        return JSON.stringify({
          kind: "final",
          outputs: [
            { kind: "generate", targetId: "alice", instructions: "a" },
            { kind: "generate", targetId: "bob", instructions: "b" },
          ],
        });
      },
      async *streamText(request: ModelRequest) {
        if (request.model === "alice-reply") {
          yield "answer:alice";
          return;
        }
        await new Promise<void>((_resolve, reject) => {
          if (request.signal?.aborted) {
            reject(new Error("ABORTED"));
            return;
          }
          request.signal?.addEventListener("abort", () => reject(new Error("ABORTED")));
        });
        yield "answer:bob";
      },
    });
    let parentRunId = "";
    const run = runtime.run(
      { ...spec, generation: {} },
      {
        ...direct,
        authorizedTargets: ["alice", "bob"],
        signal: controller.signal,
        async prepareGeneration(draft) {
          return { model: `${draft.targetId}-reply` };
        },
        async commitOutput(output, runId) {
          parentRunId = runId;
          commitCalls.push(output.targetId);
          return true;
        },
        async commitOutputs() {
          commitOutputsCalls += 1;
          return undefined;
        },
      },
    );
    while (!commitCalls.includes("alice")) await Bun.sleep(1);
    controller.abort();
    await expect(run).rejects.toThrow();
    // 已提交的 alice 不再提交；整体 abort 走 fail 结算，不再走终态 commitOutputs。
    expect(commitCalls).toEqual(["alice"]);
    expect(commitOutputsCalls).toBe(0);
    expect(repository.getRun(parentRunId)?.status).toBe("cancelled");
  });

  it("keeps a generated target's explicit mention IDs through early commit and terminal metadata", async () => {
    let committedMentions: readonly string[] | undefined;
    let terminalMentions: readonly string[] | undefined;
    const { runtime } = setup({
      async complete() {
        return JSON.stringify({
          kind: "final",
          outputs: [
            { kind: "generate", targetId: "alice", instructions: "a", mentionIds: ["u-42"] },
          ],
        });
      },
      async *streamText() {
        yield "hello";
      },
    });
    const result = await runtime.run(
      { ...spec, generation: {} },
      {
        ...direct,
        authorizedTargets: ["alice"],
        async prepareGeneration() {
          return { model: "alice-reply" };
        },
        async commitOutput(output) {
          committedMentions = output.mentionIds;
          return true;
        },
        async commitOutputs(outputs) {
          terminalMentions = outputs[0]?.mentionIds;
          return undefined;
        },
      },
    );
    // generate 草稿的 mentionIds 必须透传：早提交与终态 metadata 都不能丢。
    expect(committedMentions).toEqual(["u-42"]);
    expect(result.outputs[0].mentionIds).toEqual(["u-42"]);
    expect(terminalMentions).toEqual(["u-42"]);
  });
});

describe("runTaskGroup parent run", () => {
  it("runs work in a real parent run whose children inherit its usage ledger", async () => {
    const { runtime, repository } = setup({});
    const usage = { calls: 0, inputUnits: 0 };
    let parentRunId = "";
    const value = await runtime.runTaskGroup(
      { id: "onebot.initiative.batch" },
      {
        owner,
        usage,
        onRunId: (runId) => {
          parentRunId = runId;
        },
      },
      async (signal) => {
        expect(signal.aborted).toBe(false);
        await runtime.completeMessageLeaf(
          { id: "initiative.score", model: "chat" },
          {
            messages: [textMessage("user", "score these")],
            owner,
            usage,
            validate: () => ({ ok: true }),
          },
        );
        return "done";
      },
    );
    expect(value).toBe("done");
    expect(parentRunId).not.toBe("");
    // 子 leaf 花的是父 run 的同一本账（children 经 taskTree 继承 usage）。
    expect(usage.calls).toBe(1);
    const snapshot = repository.getRun(parentRunId);
    expect(snapshot?.specId).toBe("onebot.initiative.batch");
    expect(snapshot?.status).toBe("completed");
  });

  it("marks the parent run failed and rethrows when work rejects", async () => {
    const { runtime, repository } = setup({});
    let parentRunId = "";
    await expect(
      runtime.runTaskGroup(
        { id: "onebot.initiative.batch" },
        {
          owner,
          onRunId: (runId) => {
            parentRunId = runId;
          },
        },
        async () => {
          throw new Error("CHILD_REJECTED");
        },
      ),
    ).rejects.toThrow("CHILD_REJECTED");
    expect(repository.getRun(parentRunId)?.status).toBe("failed");
  });

  it("settles the parent run cancelled when work resolves after the caller aborts", async () => {
    const { runtime, repository } = setup({});
    const controller = new AbortController();
    let parentRunId = "";
    const run = runtime.runTaskGroup(
      { id: "onebot.initiative.batch" },
      {
        owner,
        signal: controller.signal,
        onRunId: (runId) => {
          parentRunId = runId;
        },
      },
      async () => {
        // work 忽略 abort 仍正常返回：终态写前的运行边界必须把父按 cancelled 结算。
        controller.abort();
        return "ignored-abort";
      },
    );
    await expect(run).rejects.toThrow();
    expect(repository.getRun(parentRunId)?.status).toBe("cancelled");
  });

  it("fails and disposes the parent run when onRunId throws", async () => {
    const { runtime, repository } = setup({});
    let parentRunId = "";
    const run = runtime.runTaskGroup(
      { id: "onebot.initiative.batch" },
      {
        owner,
        onRunId: (runId) => {
          parentRunId = runId;
          throw new Error("LINK_RUN_FAILED");
        },
      },
      async () => "never-runs",
    );
    await expect(run).rejects.toThrow("LINK_RUN_FAILED");
    // run 已建立：onRunId 抛错必须按运行失败结算，不能停在无终态。
    expect(repository.getRun(parentRunId)?.status).toBe("failed");
  });

  it("keeps the host's in-group no_output settlement without a second terminal event", async () => {
    const { runtime, repository } = setup({});
    let parentRunId = "";
    const value = await runtime.runTaskGroup(
      { id: "onebot.initiative.batch" },
      {
        owner,
        onRunId: (runId) => {
          parentRunId = runId;
        },
      },
      async () => {
        // 本批零达标：host 在 work 内用同一 run repo 按原事务结算 no_output。
        repository.finishRun(
          parentRunId,
          "no_output",
          { type: "no_output" },
          new Date().toISOString(),
        );
        return "no_qualified";
      },
    );
    expect(value).toBe("no_qualified");
    expect(repository.getRun(parentRunId)?.status).toBe("no_output");
    // runtime.finish("completed") 在入口 early return：终态不追加第二个事件。
    expect(repository.listEvents(parentRunId).map((event) => event.type)).toEqual([
      "started",
      "no_output",
    ]);
  });
});
