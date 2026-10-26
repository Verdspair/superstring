import { afterEach, describe, expect, it } from "bun:test";
import { AgentRuntime } from "../../src/server/agent/agent-runtime";
import type { AgentSpec } from "../../src/server/agent/agent-specs";
import type { BuiltInAction } from "../../src/server/agent/built-in-actions";
import { textMessage } from "../../src/server/agent/context-engine";
import type { ModelRequest } from "../../src/server/agent/model-port";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import type { AuxiliaryAllocationProfile } from "../../src/shared/contracts/context-allocation";

const handles: ReturnType<typeof openBusinessDb>[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
});

const invoke = (name: string, arguments_: Record<string, unknown> = {}) =>
  JSON.stringify({ kind: "invoke", calls: [{ name, arguments: arguments_ }] });
const generate = (targetId: string, instructions = "summarize facts") =>
  JSON.stringify({ kind: "final", outputs: [{ kind: "generate", targetId, instructions }] });
const inline = (targetId: string, text = "conclusion") =>
  JSON.stringify({ kind: "final", outputs: [{ kind: "inline", targetId, text }] });

function setupHarness(options: {
  parentModel?: string;
  parentMaxTokens?: number;
  allocation?: AuxiliaryAllocationProfile;
}) {
  const h = openBusinessDb();
  handles.push(h);
  const requests: ModelRequest[] = [];
  let parentRound = 0;
  let childRound = 0;
  let currentQuestion = "target inquiry";

  const actions: BuiltInAction[] = ["read"].map((effect) => ({
    description: {
      name: effect,
      capability: effect,
      description: effect,
      effect: effect as "read",
      parameters: {},
    },
    async execute() {
      return { value: "evidence", sources: [] };
    },
  }));

  const runtime = new AgentRuntime({
    repository: new AgentRunRepository(h.db),
    researchEnabled: () => true,
    model: {
      async complete(request) {
        requests.push(request);
        const isChild = JSON.stringify(request.messages[0]).includes(
          "Research only the supplied question",
        );
        if (isChild) {
          if (++childRound === 1) {
            return generate("research", "provide concise answer");
          }
          return '{"kind":"none"}';
        }
        if (++parentRound === 1) {
          return invoke("research.run", { question: currentQuestion });
        }
        return inline("reply", "finished");
      },
      async *streamText(request) {
        requests.push(request);
        yield "research conclusion text";
      },
      async completeMultimodal() {
        return "";
      },
    },
  });

  const parentModel = options.parentModel ?? "parent-chat-model";
  const parentMaxTokens = options.parentMaxTokens ?? 4096;

  const spec: AgentSpec = {
    id: "main-parent",
    model: parentModel,
    maxTokens: parentMaxTokens,
    context: "conversation",
    availableActions: actions.map((a) => a.description),
    limits: { steps: 8, outputTokens: parentMaxTokens },
  };

  const run = (question = "target inquiry") => {
    currentQuestion = question;
    return runtime.run(spec, {
      owner: { kind: "test", id: "research-budget-wire" },
      authorizedTargets: ["reply"],
      outputMode: "buffered",
      actions,
      context: {
        read: async () => ({ pending: [textMessage("user", "parent prompt")] }),
        researchAllocation: () => options.allocation,
      },
      async commitOutputs() {
        return undefined;
      },
    });
  };

  return { runtime, run, requests, actions };
}

describe("research child wire budget and allocation", () => {
  it(
    "applies saved output_reserved to both wire phases (next and generate) of the child run, " +
      "overriding parent maxTokens, and preserves parent inheritance when profile is absent",
    async () => {
      const OUTPUT_RESERVED = 300;
      const harness = setupHarness({
        parentMaxTokens: 4096,
        allocation: {
          mode: "fixed",
          output_reserved: OUTPUT_RESERVED,
          input_limit: 100_000,
        },
      });

      await harness.run();

      const childRequests = harness.requests.filter(
        (r) =>
          JSON.stringify(r.messages[0]).includes("Research only the supplied question") ||
          JSON.stringify(r.messages[0]).includes("Write a concise research conclusion"),
      );

      // Child must produce at least one decision request (next) and one generation request (generate).
      expect(childRequests.length).toBeGreaterThanOrEqual(2);

      const nextCall = childRequests.find((r) =>
        JSON.stringify(r.messages[0]).includes("Research only the supplied question"),
      );
      const generateCall = childRequests.find((r) =>
        JSON.stringify(r.messages[0]).includes("Write a concise research conclusion"),
      );

      expect(nextCall).toBeDefined();
      expect(generateCall).toBeDefined();

      // The saved output_reserved must govern BOTH phases on the wire, never leaking parent's 4096.
      expect(nextCall?.maxTokens).toBe(OUTPUT_RESERVED);
      expect(generateCall?.maxTokens).toBe(OUTPUT_RESERVED);

      // Control: absent profile preserves parent inheritance (4096) on child calls.
      const absentHarness = setupHarness({
        parentMaxTokens: 4096,
        allocation: undefined,
      });

      await absentHarness.run();
      const absentChildCalls = absentHarness.requests.filter((r) =>
        JSON.stringify(r.messages[0]).includes("Research only the supplied question"),
      );
      expect(absentChildCalls.length).toBeGreaterThan(0);
      expect(absentChildCalls[0]?.maxTokens).toBe(4096);
    },
  );
});
