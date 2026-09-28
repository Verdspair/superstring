// 按任务树计预算（0.4.0 P3）：一本账 ＋ 一个上限。
//
// 规则只有两条：每一次模型调用（决策、生成、叶子）都经过 `step()`，所以账只可能记在那里；
// `usage` 由调用方传进来共享，于是"父 run ＋ 它的所有子调用"是一笔总账，超限抛 `AGENT_BUDGET_EXCEEDED`。

import { afterEach, describe, expect, it } from "bun:test";
import { AgentRuntime } from "../../src/server/agent/agent-runtime";
import type { AgentSpec } from "../../src/server/agent/agent-specs";
import { textMessage } from "../../src/server/agent/context-engine";
import type { ModelPort } from "../../src/server/agent/model-port";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { openBusinessDb } from "../../src/server/db/schema-gate";

const handles: ReturnType<typeof openBusinessDb>[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
});
const owner = { kind: "test_job", id: "job-1", userId: "u", agentId: "a" };

function setup() {
  const h = openBusinessDb();
  handles.push(h);
  let calls = 0;
  const port: ModelPort = {
    async complete() {
      calls += 1;
      return '{"kind":"none"}';
    },
    async *streamText() {
      calls += 1;
      yield "answer";
    },
    async completeMultimodal() {
      calls += 1;
      return "vision";
    },
  };
  const spec: AgentSpec = {
    id: "main",
    model: "chat",
    instructions: "Persona",
    context: "conversation",
    availableActions: [],
    limits: { steps: 16 },
  };
  return {
    runtime: new AgentRuntime({ model: port, repository: new AgentRunRepository(h.db) }),
    spec,
    actualCalls: () => calls,
  };
}

const runOnce = (
  runtime: AgentRuntime,
  spec: AgentSpec,
  extra: { usage?: { calls: number; inputUnits: number }; budget?: { maxCalls?: number } } = {},
) =>
  runtime.run(spec, {
    owner,
    conversationId: "c1",
    authorizedTargets: ["web"],
    outputMode: "stream",
    context: {
      async read() {
        return { pending: [textMessage("user", "hello")] };
      },
    },
    signal: new AbortController().signal,
    ...extra,
  });

describe("按任务树计预算（0.4.0 P3）", () => {
  it("超限就抛 AGENT_BUDGET_EXCEEDED，且账记在这次调用之前", async () => {
    const f = setup();
    const usage = { calls: 0, inputUnits: 0 };
    await expect(runOnce(f.runtime, f.spec, { usage, budget: { maxCalls: 0 } })).rejects.toThrow(
      /whole model budget/,
    );
    // 拦在调用**之后**记账之前？不：先记账再判——所以这一次调用没有真的发出去。
    expect(f.actualCalls()).toBe(0);
    expect(usage.calls).toBe(1);
  });

  it("不给预算就只记账，不拦", async () => {
    const f = setup();
    const usage = { calls: 0, inputUnits: 0 };
    const result = await runOnce(f.runtime, f.spec, { usage });
    expect(result.status).toBe("no_output");
    expect(usage.calls).toBe(1);
    expect(usage.inputUnits).toBeGreaterThan(0);
  });

  it("inherits the task budget through asynchronous context preparation without manual forwarding", async () => {
    const f = setup();
    const usage = { calls: 0, inputUnits: 0 };
    await expect(
      f.runtime.run(f.spec, {
        owner,
        authorizedTargets: ["web"],
        outputMode: "buffered",
        usage,
        budget: { maxCalls: 1 },
        context: {
          async read() {
            await Promise.resolve();
            await f.runtime.completeLeaf(
              { id: "selector" },
              { owner, messages: [{ role: "user", content: "select" }] },
            );
            return {};
          },
        },
      }),
    ).rejects.toMatchObject({ code: "AGENT_BUDGET_EXCEEDED" });
    expect(f.actualCalls()).toBe(1);
    expect(usage.calls).toBe(2);
    await runOnce(f.runtime, f.spec);
    expect(f.actualCalls()).toBe(2);
  });

  it("keeps concurrent task trees isolated and refuses a child budget override", async () => {
    const f = setup();
    const usage = [
      { calls: 0, inputUnits: 0 },
      { calls: 0, inputUnits: 0 },
    ];
    const results = await Promise.allSettled(
      usage.map((ledger, index) =>
        f.runtime.run(f.spec, {
          owner,
          authorizedTargets: ["web"],
          outputMode: "buffered",
          usage: ledger,
          budget: { maxCalls: index + 1 },
          context: {
            async read() {
              await Promise.resolve();
              await f.runtime.completeVisionLeaf(
                { id: "vision" },
                {
                  owner,
                  model: "vision",
                  prompt: "describe",
                  images: [],
                  usage: { calls: 0, inputUnits: 0 },
                  budget: { maxCalls: 100 },
                },
              );
              return {};
            },
          },
        }),
      ),
    );
    expect(results.map((result) => result.status)).toEqual(["rejected", "fulfilled"]);
    expect(usage.map((ledger) => ledger.calls)).toEqual([2, 2]);
    expect(f.actualCalls()).toBe(3);
  });

  it("inherits cancellation even when a nested leaf omits its signal", async () => {
    const f = setup();
    const controller = new AbortController();
    const reason = new Error("cancelled parent");
    const result = f.runtime.run(f.spec, {
      owner,
      authorizedTargets: [],
      outputMode: "buffered",
      signal: controller.signal,
      context: {
        async read() {
          controller.abort(reason);
          await f.runtime.completeLeaf(
            { id: "nested" },
            { owner, messages: [{ role: "user", content: "must not call" }] },
          );
          return {};
        },
      },
    });
    await expect(result).rejects.toBe(reason);
    expect(f.actualCalls()).toBe(0);
    const leaves = f.runtime.repository.listRuns({ ownerKind: owner.kind, ownerId: owner.id });
    expect(leaves.find((run) => run.specId === "nested")?.status).toBe("cancelled");
  });

  it("叶子与父共用一本账：子调用花掉的额度算进整棵树", async () => {
    const f = setup();
    const usage = { calls: 0, inputUnits: 0 };
    // 父 run：一次决策（1 次调用）→ none。
    await runOnce(f.runtime, f.spec, { usage });
    expect(usage.calls).toBe(1);
    // 叶子用同一个 usage：这一次记进同一本账。
    await f.runtime.completeLeaf(
      { id: "leaf" },
      {
        messages: [{ role: "user", content: "hello" }],
        owner,
        usage,
      },
    );
    expect(usage.calls).toBe(2);
    // 带着同一本账再跑父 run：额度已被叶子吃掉，立刻超限。
    await expect(runOnce(f.runtime, f.spec, { usage, budget: { maxCalls: 2 } })).rejects.toThrow(
      /whole model budget/,
    );
  });
});
