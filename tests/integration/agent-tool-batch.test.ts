// 工具批处理（0.4.0 P2）：一次决策里的多条调用不再被丢掉。
//
// 三条规则在这里钉死：只读的可以并行、有副作用的一律串行且保持顺序、同一调用原样重复到第三次就
// 结束这一轮（`AGENT_NO_PROGRESS`）。校验先于执行：批里任何一条不可用，整批拒绝，不留半执行状态。

import { afterEach, describe, expect, it } from "bun:test";
import { AgentRuntime } from "../../src/server/agent/agent-runtime";
import type { AgentSpec } from "../../src/server/agent/agent-specs";
import type { BuiltInAction } from "../../src/server/agent/built-in-actions";
import { textMessage } from "../../src/server/agent/context-engine";
import type { ModelPort, ModelRequest } from "../../src/server/agent/model-port";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { openBusinessDb } from "../../src/server/db/schema-gate";

const handles: ReturnType<typeof openBusinessDb>[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
});
const owner = { kind: "test_job", id: "job-1", userId: "u", agentId: "a" };

function action(
  name: string,
  effect: "read" | "write",
  run: (arguments_: Record<string, unknown>) => Promise<unknown>,
): BuiltInAction {
  return {
    description: {
      name,
      description: name,
      parameters: { type: "object", properties: {} },
      capability: `${name}.cap`,
      effect,
    },
    async execute(arguments_, { signal }) {
      signal.throwIfAborted();
      return { value: await run(arguments_), sources: [] };
    },
  };
}

/** 记录并发峰值与执行顺序的探针动作。 */
function probe(
  name: string,
  effect: "read" | "write",
  state: { active: number; peak: number; order: string[] },
) {
  return action(name, effect, async () => {
    state.active += 1;
    state.peak = Math.max(state.peak, state.active);
    state.order.push(name);
    await Bun.sleep(10);
    state.active -= 1;
    return { from: name };
  });
}

function setup(options: { actions: BuiltInAction[]; decisions: readonly string[] }) {
  const h = openBusinessDb();
  handles.push(h);
  const repository = new AgentRunRepository(h.db);
  const requests: ModelRequest[] = [];
  let index = 0;
  const port: ModelPort = {
    async complete(request) {
      requests.push(request);
      const value = options.decisions[Math.min(index, options.decisions.length - 1)];
      index += 1;
      return value ?? '{"kind":"none"}';
    },
    async *streamText() {
      yield "answer";
    },
    async completeMultimodal() {
      return "vision";
    },
  };
  const spec: AgentSpec = {
    id: "main",
    model: "chat",
    instructions: "Persona",
    context: "conversation",
    availableActions: options.actions.map((entry) => entry.description),
    limits: { steps: 8 },
  };
  const runtime = new AgentRuntime({ model: port, repository });
  const run = () =>
    runtime.run(spec, {
      owner,
      conversationId: "c1",
      actions: options.actions,
      authorizedTargets: ["web"],
      outputMode: "stream",
      context: {
        async read() {
          return { pending: [textMessage("user", "hello")] };
        },
      },
      signal: new AbortController().signal,
    });
  return { h, requests, run };
}

const batch = (...calls: { name: string; arguments?: Record<string, unknown> }[]) =>
  JSON.stringify({
    kind: "invoke",
    calls: calls.map((call) => ({ ...call, arguments: call.arguments ?? {} })),
  });
const finalGenerate = JSON.stringify({
  kind: "final",
  outputs: [{ kind: "generate", targetId: "web", instructions: "respond" }],
});

describe("工具批处理（0.4.0 P2）", () => {
  it("一批只读调用都执行，而且真的并行", async () => {
    const state = { active: 0, peak: 0, order: [] as string[] };
    const setupResult = setup({
      actions: [probe("a.read", "read", state), probe("b.read", "read", state)],
      decisions: [batch({ name: "a.read" }, { name: "b.read" }), finalGenerate],
    });
    const result = await setupResult.run();

    expect(result.status).toBe("completed");
    expect([...state.order].sort()).toEqual(["a.read", "b.read"]);
    expect(state.peak).toBe(2);
  });

  it("有副作用的调用串行，并按模型给的顺序执行", async () => {
    const state = { active: 0, peak: 0, order: [] as string[] };
    const setupResult = setup({
      actions: [probe("b.write", "write", state), probe("a.write", "write", state)],
      decisions: [batch({ name: "b.write" }, { name: "a.write" }), finalGenerate],
    });
    const result = await setupResult.run();

    expect(result.status).toBe("completed");
    expect(state.order).toEqual(["b.write", "a.write"]);
    expect(state.peak).toBe(1);
  });

  it("只读与副作用混在一批：先并行读，再串行写", async () => {
    const state = { active: 0, peak: 0, order: [] as string[] };
    const setupResult = setup({
      actions: [
        probe("a.read", "read", state),
        probe("b.read", "read", state),
        probe("c.write", "write", state),
      ],
      decisions: [
        batch({ name: "a.read" }, { name: "b.read" }, { name: "c.write" }),
        finalGenerate,
      ],
    });
    const result = await setupResult.run();

    expect(result.status).toBe("completed");
    expect(state.order).toEqual(["a.read", "b.read", "c.write"]);
    expect(state.peak).toBe(2);
  });

  it("批里有一条不可用：整批拒绝，另一条也不会被执行", async () => {
    const state = { active: 0, peak: 0, order: [] as string[] };
    const setupResult = setup({
      actions: [probe("a.read", "read", state)],
      decisions: [batch({ name: "a.read" }, { name: "missing.read" }), finalGenerate],
    });

    await expect(setupResult.run()).rejects.toThrow(/Action is not available/);
    expect(state.order).toEqual([]);
  });

  it("复验整批可用性后才开始执行，失效动作不能留下前半批副作用", async () => {
    const state = { active: 0, peak: 0, order: [] as string[] };
    const invalid = probe("b.write", "write", state);
    invalid.assertAvailable = () => {
      throw Object.assign(new Error("changed"), { code: "PERMISSION_REVISION_CHANGED" });
    };
    const f = setup({
      actions: [probe("a.write", "write", state), invalid],
      decisions: [batch({ name: "a.write" }, { name: "b.write" })],
    });
    await expect(f.run()).rejects.toMatchObject({ code: "PERMISSION_REVISION_CHANGED" });
    expect(state.order).toEqual([]);
  });

  it("并行调用失败时取消并排空同批调用，结束后没有迟到工作", async () => {
    const pending = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    let settled = false;
    let cancelled = false;
    const slow = action("a.read", "read", async () => null);
    slow.execute = async (_args, { signal }) => {
      entered.resolve();
      signal.addEventListener(
        "abort",
        () => {
          cancelled = true;
          pending.resolve();
        },
        { once: true },
      );
      await pending.promise;
      settled = true;
      signal.throwIfAborted();
      return { value: null, sources: [] };
    };
    const failure = Object.assign(new Error("failed"), { code: "TEST_ACTION_FAILED" });
    const f = setup({
      actions: [
        slow,
        action("b.read", "read", async () => {
          await entered.promise;
          throw failure;
        }),
      ],
      decisions: [batch({ name: "a.read" }, { name: "b.read" })],
    });
    try {
      await expect(f.run()).rejects.toBe(failure);
      expect(cancelled).toBe(true);
      expect(settled).toBe(true);
    } finally {
      pending.resolve();
      await Promise.resolve();
    }
  });

  it("同一调用原样重复：第二次带提示继续，第三次结束这一轮", async () => {
    const state = { active: 0, peak: 0, order: [] as string[] };
    const setupResult = setup({
      actions: [probe("a.read", "read", state)],
      decisions: [
        batch({ name: "a.read", arguments: { query: "x" } }),
        batch({ name: "a.read", arguments: { query: "x" } }),
        batch({ name: "a.read", arguments: { query: "x" } }),
      ],
    });

    await expect(setupResult.run()).rejects.toThrow(/keeps repeating without progress/);
    // 前两次真的执行了（第二次的观测里带"换个做法"的提示），第三次没有再执行。
    expect(state.order).toEqual(["a.read", "a.read"]);
    expect(JSON.stringify(setupResult.requests[2]?.messages ?? [])).toContain("repeatWarning");
  });

  it("参数不同就不算重复", async () => {
    const state = { active: 0, peak: 0, order: [] as string[] };
    const setupResult = setup({
      actions: [probe("a.read", "read", state)],
      decisions: [
        batch({ name: "a.read", arguments: { query: "x" } }),
        batch({ name: "a.read", arguments: { query: "y" } }),
        batch({ name: "a.read", arguments: { query: "z" } }),
        finalGenerate,
      ],
    });
    const result = await setupResult.run();

    expect(result.status).toBe("completed");
    expect(state.order).toEqual(["a.read", "a.read", "a.read"]);
  });
});
