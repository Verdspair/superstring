import { afterEach, describe, expect, it } from "bun:test";
import { AgentRuntime } from "../../src/server/agent/agent-runtime";
import type { AgentSpec } from "../../src/server/agent/agent-specs";
import type { BuiltInAction } from "../../src/server/agent/built-in-actions";
import type { ModelRequest } from "../../src/server/agent/model-port";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { openBusinessDb } from "../../src/server/db/schema-gate";

const handles: ReturnType<typeof openBusinessDb>[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
});
const invoke = (name: string, arguments_: Record<string, unknown> = {}) =>
  JSON.stringify({ kind: "invoke", calls: [{ name, arguments: arguments_ }] });
const inline = (targetId: string, text = "conclusion") =>
  JSON.stringify({ kind: "final", outputs: [{ kind: "inline", targetId, text }] });
function setup(
  decisions: string[],
  research = true,
  codeMode?: ConstructorParameters<typeof AgentRuntime>[0]["codeMode"],
) {
  const h = openBusinessDb();
  handles.push(h);
  const requests: ModelRequest[] = [];
  let index = 0,
    writes = 0,
    publications = 0;
  const actions: BuiltInAction[] = ["read", "write"].map((effect) => ({
    description: {
      name: effect,
      capability: effect,
      description: effect,
      effect: effect as "read" | "write",
      parameters: {},
    },
    async execute() {
      if (effect === "write") writes++;
      return { value: "evidence", sources: [] };
    },
  }));
  const runtime = new AgentRuntime({
    repository: new AgentRunRepository(h.db),
    researchEnabled: () => research,
    codeMode,
    model: {
      async complete(request) {
        requests.push(request);
        return decisions[index++] ?? '{"kind":"none"}';
      },
      async *streamText() {
        yield "answer";
      },
      async completeMultimodal() {
        return "";
      },
    },
  });
  const spec: AgentSpec = {
    id: "main",
    model: "chat",
    context: "conversation",
    availableActions: actions.map((a) => a.description),
    limits: { steps: 16 },
  };
  const usage = { calls: 0, inputUnits: 0 };
  const run = (maxCalls = 30) =>
    runtime.run(spec, {
      owner: { kind: "test", id: "one" },
      authorizedTargets: ["reply"],
      outputMode: "buffered",
      actions,
      usage,
      budget: { maxCalls },
      context: {
        async read() {
          return {};
        },
      },
      async commitOutputs() {
        publications++;
        return undefined;
      },
    });
  return {
    runtime,
    run,
    usage,
    requests,
    spec,
    actions,
    writes: () => writes,
    publications: () => publications,
  };
}

describe("bounded read-only research", () => {
  it("uses the same runtime and budget, returns a conclusion without publishing a child message", async () => {
    const f = setup([
      invoke("research.run", { question: "find" }),
      invoke("read"),
      inline("research"),
      inline("reply"),
    ]);
    await f.run();
    expect(f.usage.calls).toBe(4);
    expect(f.publications()).toBe(1);
    expect(f.writes()).toBe(0);
    expect(f.requests[1].tools?.map((tool) => tool.name)).toEqual(["read"]);
    expect(JSON.stringify(f.requests[3].messages)).toContain("conclusion");
  });
  it.each(["write", "research.run"])("cannot invoke %s from a child", async (name) => {
    const f = setup([
      invoke("research.run", { question: "find" }),
      invoke(name, { question: "nested" }),
    ]);
    await expect(f.run()).rejects.toMatchObject({ code: "AGENT_ACTION_UNAVAILABLE" });
    expect(f.writes()).toBe(0);
    expect(f.publications()).toBe(0);
  });
  it("refuses a third research child and charges child calls to the parent ceiling", async () => {
    const f = setup([
      invoke("research.run", { question: "a" }),
      inline("research"),
      invoke("research.run", { question: "b" }),
      inline("research"),
      invoke("research.run", { question: "c" }),
    ]);
    await expect(f.run()).rejects.toMatchObject({ code: "AGENT_SUBTASK_LIMIT" });
    const budgeted = setup([invoke("research.run", { question: "find" }), inline("research")]);
    await expect(budgeted.run(1)).rejects.toMatchObject({ code: "AGENT_BUDGET_EXCEEDED" });
    expect(budgeted.requests).toHaveLength(1);
  });
  it.each([
    [false, true, true],
    [true, false, true],
    [true, true, false],
  ])(
    "requires the code switch, runner and model capability together (%s/%s/%s)",
    async (enabled, available, supported) => {
      const f = setup(['{"kind":"none"}'], false, {
        enabled: () => enabled,
        supportsModel: () => supported,
        runner: {
          available,
          async run() {
            throw new Error("must not execute");
          },
        },
      });
      await f.run();
      expect(f.requests[0].tools?.map((tool) => tool.name)).toEqual(["read", "write"]);
    },
  );
  it("finishes the current run after a soft pause and disables code for the next run", async () => {
    let enabled = true;
    const f = setup([invoke("code.run", { script: "return conclusion" }), inline("reply")], false, {
      enabled: () => enabled,
      supportsModel: () => true,
      runner: {
        available: true,
        async run({ bindings }) {
          expect(Object.keys(bindings)).toEqual(["read"]);
          await bindings.read({});
          enabled = false;
          return { conclusion: "evidence" };
        },
      },
    });
    await f.run();
    expect(f.publications()).toBe(1);
    await f.run();
    expect(f.requests.at(-1)?.tools?.map((tool) => tool.name)).not.toContain("code.run");
  });

  it("cannot use a registered but unadvertised tool through research or code", async () => {
    const research = setup([invoke("research.run", { question: "hidden data" }), invoke("read")]);
    research.spec.availableActions = research.spec.availableActions.filter(
      (action) => action.name !== "read",
    );
    await expect(research.run()).rejects.toMatchObject({ code: "AGENT_ACTION_UNAVAILABLE" });
    const code = setup([invoke("code.run", { script: "inspect" }), inline("reply")], false, {
      enabled: () => true,
      supportsModel: () => true,
      runner: {
        available: true,
        async run({ bindings }) {
          expect(Object.keys(bindings)).toEqual([]);
          return { conclusion: "no tools" };
        },
      },
    });
    code.spec.availableActions = [];
    await code.run();
    expect(code.writes()).toBe(0);
  });

  it("isolates optional actions across concurrent runs sharing an immutable spec", async () => {
    const f = setup(['{"kind":"none"}']);
    Object.freeze(f.spec);
    await Promise.all([f.run(), f.run()]);
    expect(f.spec.availableActions.map((action) => action.name)).toEqual(["read", "write"]);
    for (const request of f.requests)
      expect(request.tools?.filter((tool) => tool.name === "research.run")).toHaveLength(1);
  });

  it("leaves the default tool surface unchanged when disabled", async () => {
    const f = setup(['{"kind":"none"}'], false);
    await f.run();
    expect(f.requests[0].tools?.map((tool) => tool.name)).toEqual(["read", "write"]);
  });
});
