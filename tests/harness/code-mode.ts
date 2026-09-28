import { AgentRuntime } from "../../src/server/agent/agent-runtime";
import type { BuiltInAction } from "../../src/server/agent/built-in-actions";
import { createQuickJsCodeRunner } from "../../src/server/agent/quickjs-runner";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { decideInline, decideInvoke, scriptedModel } from "./model";

export async function compareCodeModes() {
  const rows = Array.from({ length: 200 }, (_, index) => ({
    id: index + 1,
    enabled: index % 3 === 0,
    amount: index % 17,
    detail: `raw-record-${index}-${"irrelevant metadata ".repeat(12)}`,
  }));
  const modes = [];
  const expected = rows.filter((row) => row.enabled).reduce((sum, row) => sum + row.amount, 0);
  for (const mode of ["direct", "code"] as const) {
    const h = openBusinessDb();
    try {
      let toolCalls = 0;
      const script = `const rows = await tools["fixture.list"]({});
const enabled = await tools["fixture.select"]({ids:rows.filter(row=>row.enabled).map(row=>row.id)});
const sum = await tools["fixture.total"]({amounts:enabled.map(row=>row.amount)});
return {conclusion:"total="+sum};`;
      const step =
        mode === "code"
          ? [decideInvoke("code.run", { script })]
          : [
              decideInvoke("fixture.list"),
              decideInvoke("fixture.select", {
                ids: rows.filter((row) => row.enabled).map((row) => row.id),
              }),
              decideInvoke("fixture.total", {
                amounts: rows.filter((row) => row.enabled).map((row) => row.amount),
              }),
            ];
      const model = scriptedModel([...step, decideInline("reply", `total=${expected}`)]);
      const actions: BuiltInAction[] = ["list", "select", "total"].map((name) => ({
        description: {
          name: `fixture.${name}`,
          capability: "fixture",
          effect: "read",
          description: name,
          parameters: { type: "object" },
        },
        async execute(args) {
          toolCalls++;
          const value =
            name === "list"
              ? rows
              : name === "select"
                ? rows.filter((row) => (args.ids as number[]).includes(row.id))
                : (args.amounts as number[]).reduce((sum, amount) => sum + amount, 0);
          return { value, sources: [{ kind: "fixture", id: "records", revision: "1" }] };
        },
      }));
      const repository = new AgentRunRepository(h.db);
      const usage = { calls: 0, inputUnits: 0 };
      const runtime = new AgentRuntime({
        repository,
        model: model.port,
        codeMode: {
          runner: createQuickJsCodeRunner(),
          enabled: () => mode === "code",
          supportsModel: () => true,
        },
      });
      const started = performance.now();
      const result = await runtime.run(
        {
          id: "comparison",
          model: "fixture",
          context: "conversation",
          limits: { steps: 8 },
          availableActions: actions.map((action) => action.description),
        },
        {
          owner: { kind: "test", id: mode },
          authorizedTargets: ["reply"],
          actions,
          usage,
          outputMode: "buffered",
          context: {
            async read() {
              return {};
            },
          },
        },
      );
      const snapshot = repository.getRun(result.runId);
      const lastStep = snapshot?.steps.at(-1);
      const messages = lastStep ? repository.getContext(lastStep.context)?.messages : [];
      const rendered = (messages ?? [])
        .flatMap((message) =>
          message.content.flatMap((part) => (part.kind === "text" ? [part.text] : [])),
        )
        .join("\n");
      const conclusionSeen =
        rendered.includes(`total=${expected}`) || rendered.includes(`"value":${expected}`);
      modes.push({
        mode,
        modelCalls: usage.calls,
        inputUnits: usage.inputUnits,
        toolCalls,
        output: result.outputs[0]?.text,
        conclusionSeen,
        rawDataInFinalModelInput: rendered.includes("raw-record-"),
        elapsedMs: Math.round(performance.now() - started),
        pendingModelSteps: model.remaining(),
      });
    } finally {
      h.close();
    }
  }
  return {
    fixture: "authorized records: list -> select -> sum",
    estimator: "utf8_bytes_plus_message_overhead",
    qualityBoundary: "scripted model, actual sandbox; not a real-model quality benchmark",
    expected: `total=${expected}`,
    modes,
  };
}
