// 0.4.0 P6：工具目录与程序化工具调用的运行边界。
//
// 这一层测的不是"沙箱里能跑什么"（沙箱是可注入实现），而是我们负责的三件事：
//   1. 绑定表按目录构造——只含 `sandboxCallable` 的只读工具，构造时强制；
//   2. 限额——墙钟、调用次数、结论大小；空结论与超限结论都不放行；
//   3. 复验与留痕——每次工具调用前后走宿主复验；工具读到的来源与沙箱引用都进观测来源；
//      没有沙箱时这个模式**运行时不可达**，决策面与现在完全一致。

import { afterEach, describe, expect, it } from "bun:test";
import type { BuiltInAction } from "../../src/server/agent/built-in-actions";
import { createCodeMode } from "../../src/server/agent/code-mode";
import { type CodeRunner, unavailableCodeRunner } from "../../src/server/agent/code-runner";
import { advertisedActions, createToolCatalog } from "../../src/server/agent/tool-catalog";

const executed: string[] = [];
const sources = {
  memory: [{ kind: "memory", id: "m1", revision: "r1" }] as const,
};

function tool(
  name: string,
  effect: "read" | "write" = "read",
  sandboxCallable?: boolean,
): BuiltInAction {
  return {
    ...(sandboxCallable === undefined ? {} : { sandboxCallable }),
    description: { name, description: `${name} tool`, parameters: {}, capability: name, effect },
    async execute(arguments_) {
      executed.push(name);
      return { value: { echo: name, arguments: arguments_ }, sources: [...sources.memory] };
    },
  };
}

const context = { owner: { kind: "test", id: "run" }, signal: new AbortController().signal };

afterEach(() => {
  executed.length = 0;
});

const runnerOf = (run: CodeRunner["run"], available = true): CodeRunner => ({ available, run });

describe("工具目录（0.4.0 P6）", () => {
  it("默认只读工具可被沙箱绑定，显式关闭、写操作与未声明的一律不进目录", () => {
    // 真正"没声明 effect"的动作：默认按 write（保守），因此也不可被沙箱绑定。
    const undeclared: BuiltInAction = {
      description: {
        name: "legacy.undeclared",
        description: "legacy tool",
        parameters: {},
        capability: "legacy",
      },
      async execute() {
        return { value: null, sources: [] };
      },
    };
    const catalog = createToolCatalog([
      tool("memory.query", "read"),
      tool("memory.read", "read", false),
      tool("memory.write", "write"),
      undeclared,
    ]);
    expect(catalog.sandboxable().map((entry) => entry.name)).toEqual(["memory.query"]);
    expect(catalog.get("memory.write")?.sandboxCallable).toBe(false);
    // 没声明 effect 的一律按 write（保守），也就不进沙箱。
    expect(catalog.get("legacy.undeclared")?.effect).toBe("write");
  });

  it("重名在构造时就拒绝，而不是静默覆盖", () => {
    expect(() => createToolCatalog([tool("a"), tool("a")])).toThrow(/TOOL_CATALOG_DUPLICATE/);
  });
});

describe("程序化工具调用（0.4.0 P6）", () => {
  it("没有沙箱就没有这个模式：决策面与现在完全一致", () => {
    const actions = [tool("memory.query"), tool("sticker.search")];
    const mode = createCodeMode({ actions, runner: unavailableCodeRunner });
    expect(mode.action).toBeNull();
    // 公开面（提示词里看到的动作声明）与不加这个功能时逐字相同。
    expect(advertisedActions(mode.catalog)).toEqual(actions.map((action) => action.description));
  });

  it("绑定表只含可沙箱化的工具，脚本只拿得到结论之外的东西", async () => {
    let seenBindings: string[] = [];
    let seenValue: unknown;
    const runner = runnerOf(async ({ bindings }) => {
      seenBindings = Object.keys(bindings);
      seenValue = await bindings["memory.query"]?.({ query: "苹果" });
      return { conclusion: "共 3 条相关记忆", refs: sources.memory };
    });
    const write = tool("memory.write", "write");
    const mode = createCodeMode({
      actions: [tool("memory.query"), write],
      runner,
    });
    if (!mode.action) throw new Error("expected an available code action");
    const observation = await mode.action.execute({ script: "return memory.query({})" }, context);
    // 写操作没有绑定：脚本里根本拿不到这个名字。
    expect(seenBindings).toEqual(["memory.query"]);
    // 绑定给脚本的是工具返回值本身。
    expect(seenValue).toEqual({ echo: "memory.query", arguments: { query: "苹果" } });
    expect(observation.value).toMatchObject({
      status: "ok",
      conclusion: "共 3 条相关记忆",
      calls: 1,
      refs: 1,
    });
    // 工具读到的来源与沙箱声明的引用都在观测来源里（去重后）。
    expect(observation.sources).toEqual([...sources.memory]);
  });

  it("结论超限、空结论与运行失败都判 unavailable，不截断也不猜", async () => {
    const cases: Array<[CodeRunner["run"], string]> = [
      // 默认上限 4000 字符：超了判失败，不截断。
      [async () => ({ conclusion: "x".repeat(4_001) }), "CODE_CONCLUSION_TOO_LARGE"],
      [async () => ({ conclusion: "   " }), "CODE_INVALID_RESULT"],
      [
        async () => {
          throw Object.assign(new Error("script blew up"), { code: "CODE_SCRIPT_ERROR" });
        },
        "CODE_SCRIPT_ERROR",
      ],
      [
        async () => {
          throw new Error("plain failure");
        },
        "CODE_RUNNER_FAILED",
      ],
    ];
    for (const [run, code] of cases) {
      const mode = createCodeMode({ actions: [tool("memory.query")], runner: runnerOf(run) });
      if (!mode.action) throw new Error("expected an available code action");
      const result = await mode.action.execute({ script: "script" }, context);
      expect(result.value).toMatchObject({ status: "unavailable", code });
    }
    // 超限用的是自定义上限，不是把结论截断后放行。
    const mode = createCodeMode({
      actions: [tool("memory.query")],
      runner: runnerOf(async () => ({ conclusion: "12345" })),
      limits: { maxConclusionChars: 4 },
    });
    if (!mode.action) throw new Error("expected an available code action");
    expect((await mode.action.execute({ script: "s" }, context)).value).toMatchObject({
      code: "CODE_CONCLUSION_TOO_LARGE",
    });
  });

  it("墙钟超时判 CODE_TIMEOUT，调用者取消则照旧抛出", async () => {
    // 已经 abort 过的信号不会再触发事件：先查 `aborted`，否则测试自己会挂住。
    const waitForAbort = (signal: AbortSignal) =>
      new Promise<never>((_, reject) => {
        const fail = () => reject(Object.assign(new Error("aborted"), { code: "CODE_ABORTED" }));
        if (signal.aborted) fail();
        else signal.addEventListener("abort", fail, { once: true });
      });
    const hanging: CodeRunner["run"] = ({ signal }) => waitForAbort(signal);
    const timed = createCodeMode({
      actions: [tool("memory.query")],
      runner: runnerOf(hanging),
      limits: { timeoutMs: 10 },
    });
    if (!timed.action) throw new Error("expected an available code action");
    expect((await timed.action.execute({ script: "s" }, context)).value).toMatchObject({
      status: "unavailable",
      code: "CODE_TIMEOUT",
    });

    const controller = new AbortController();
    const cancelled = createCodeMode({
      actions: [tool("memory.query")],
      runner: runnerOf(({ signal }) => {
        controller.abort(new Error("caller cancelled"));
        return waitForAbort(signal);
      }),
    });
    if (!cancelled.action) throw new Error("expected an available code action");
    await expect(
      cancelled.action.execute({ script: "s" }, { ...context, signal: controller.signal }),
    ).rejects.toThrow("caller cancelled");
  });

  it("rejects late bindings and forged references even when a runner ignores cancellation", async () => {
    let late: ((args: Record<string, unknown>) => Promise<unknown>) | undefined;
    const timed = createCodeMode({
      actions: [tool("memory.query")],
      limits: { timeoutMs: 10 },
      runner: runnerOf(({ bindings }) => {
        late = bindings["memory.query"];
        return new Promise(() => {});
      }),
    });
    if (!timed.action) throw new Error("missing action");
    expect((await timed.action.execute({ script: "s" }, context)).value).toMatchObject({
      code: "CODE_TIMEOUT",
    });
    if (!late) throw new Error("missing binding");
    await expect(late({})).rejects.toThrow();
    expect(executed).toHaveLength(0);
    const forged = createCodeMode({
      actions: [],
      runner: runnerOf(async () => ({ conclusion: "claim", refs: sources.memory })),
    });
    if (!forged.action) throw new Error("missing action");
    expect((await forged.action.execute({ script: "s" }, context)).value).toMatchObject({
      code: "CODE_REFERENCE_INVALID",
    });
  });

  it("限额按脚本实际调用计数：超了当场拦下，不继续花钱", async () => {
    const runner = runnerOf(async ({ bindings }) => {
      await bindings["memory.query"]?.({});
      await bindings["memory.query"]?.({});
      await bindings["memory.query"]?.({});
      return { conclusion: "unreachable" };
    });
    const mode = createCodeMode({
      actions: [tool("memory.query")],
      runner,
      limits: { maxCalls: 2 },
    });
    if (!mode.action) throw new Error("expected an available code action");
    const result = await mode.action.execute({ script: "s" }, context);
    expect(result.value).toMatchObject({
      status: "unavailable",
      code: "CODE_CALL_LIMIT",
      calls: 2,
    });
    expect(executed).toEqual(["memory.query", "memory.query"]);
  });

  it("aborts a binding still in flight when a non-cooperating runner finishes early", async () => {
    let finished: Promise<unknown> | undefined;
    let aborted = false;
    const target = tool("read");
    target.execute = async (_args, { signal }) => {
      await new Promise<void>((resolve) =>
        signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            resolve();
          },
          { once: true },
        ),
      );
      return { value: "late", sources: [] };
    };
    const mode = createCodeMode({
      actions: [target],
      runner: runnerOf(async ({ bindings }) => {
        finished = bindings.read({}).catch((error: unknown) => error);
        return { conclusion: "premature" };
      }),
    });
    if (!mode.action) throw new Error("missing action");
    await mode.action.execute({ script: "s" }, context);
    await finished;
    expect(aborted).toBe(true);
  });

  it("每次工具调用前后都走宿主复验，复验失败的错误码原样带回", async () => {
    let checks = 0;
    const revoked = createCodeMode({
      actions: [tool("memory.query")],
      runner: runnerOf(async ({ bindings }) => {
        await bindings["memory.query"]?.({});
        return { conclusion: "ok" };
      }),
      // 第 1 次（调用前）通过，第 2 次（调用后）失败：说明复验确实在两侧都发生。
      assertCurrent: () => {
        checks += 1;
        if (checks > 1)
          throw Object.assign(new Error("授权已变化"), { code: "CONTEXT_SOURCE_INVALID" });
      },
    });
    if (!revoked.action) throw new Error("expected an available code action");
    await expect(revoked.action.execute({ script: "s" }, context)).rejects.toMatchObject({
      code: "CONTEXT_SOURCE_INVALID",
    });
    expect(checks).toBe(2);
    expect(executed).toEqual(["memory.query"]);
  });
});
