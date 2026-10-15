import { afterEach, describe, expect, it } from "bun:test";
import type { RunUsage } from "../../src/server/agent/agent-runtime";
import { AgentRuntime } from "../../src/server/agent/agent-runtime";
import type { AgentSpec } from "../../src/server/agent/agent-specs";
import type {
  ModelContextBudget,
  ModelPort,
  ModelRequest,
} from "../../src/server/agent/model-port";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import {
  DEFAULT_AGENT_ID,
  DEFAULT_USER_ID,
  ensureDefaults,
} from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { RuntimeTelemetry } from "../../src/server/observability/runtime-telemetry";
import { RuntimeSpanRepository } from "../../src/server/observability/span-repository";

const handles: ReturnType<typeof openBusinessDb>[] = [];
afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
});

const owner = { kind: "test_job", id: "runtime-token-budget" };
const baseSpec: AgentSpec = {
  id: "token-budget-runtime",
  model: "requested-model",
  context: "conversation",
  availableActions: [],
  limits: { steps: 2, inputUnits: 10_000 },
};
const budget = (count: (text: string) => number): ModelContextBudget => ({
  model: "resolved-model",
  capacity: 4096,
  tokenizerEncoding: "cl100k_base",
  countText: count,
  assertCurrent() {},
});
function setup(model: Partial<ModelPort> = {}) {
  const handle = openBusinessDb();
  handles.push(handle);
  const repository = new AgentRunRepository(handle.db);
  const calls: ModelRequest[] = [];
  const port: ModelPort = {
    async complete(request) {
      calls.push(request);
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
  return { repository, calls, runtime: new AgentRuntime({ model: port, repository }) };
}

describe("optional runtime token-budget bridge", () => {
  it("records a budget rejection for the token capacity gate", async () => {
    const business = openBusinessDb();
    ensureDefaults(business.orm, "fixture");
    const telemetry = new RuntimeTelemetry(business.db);
    try {
      let calls = 0;
      const runtime = new AgentRuntime({
        repository: new AgentRunRepository(business.db),
        telemetry,
        model: {
          complete: async () => {
            calls++;
            return '{"kind":"none"}';
          },
          async *streamText() {
            yield "unused";
          },
          completeMultimodal: async () => "unused",
        },
      });
      await expect(
        runtime.run(
          { ...baseSpec, limits: { steps: 2, inputUnits: 10 } },
          {
            owner: { ...owner, userId: DEFAULT_USER_ID, agentId: DEFAULT_AGENT_ID },
            authorizedTargets: ["web"],
            outputMode: "buffered",
            context: {
              prepareModelContext: async () => budget(() => 99),
              read: async () => ({
                pending: [{ role: "user", content: [{ kind: "text", text: "oversize" }] }],
              }),
            },
          },
        ),
      ).rejects.toMatchObject({ code: "AGENT_CONTEXT_LIMIT" });
      const records = new RuntimeSpanRepository(business.db)
        .page({})
        .items.filter((span) => span.name === "agent.budget");
      expect(records).toHaveLength(1);
      expect(records[0]?.code).toBe("AGENT_CONTEXT_LIMIT");
      expect(records[0]?.details.inputUnits).toBe(99);
      expect(records[0]?.details.inputLimit).toBe(10);
      expect(calls).toBe(0);
    } finally {
      await telemetry.close();
      business.close();
    }
  });

  it("prepares the source-owned phase budget before read and preserves byte accounting", async () => {
    const { runtime, calls } = setup();
    const order: string[] = [];
    const usage: RunUsage = { calls: 0, inputUnits: 0 };
    const prepared = budget(() => 1);
    const result = await runtime.run(
      { ...baseSpec, limits: { steps: 2, inputUnits: 10_000 } },
      {
        owner,
        authorizedTargets: ["web"],
        outputMode: "buffered",
        usage,
        context: {
          async prepareModelContext(model, signal) {
            order.push(`prepare:${model}:${signal.aborted}`);
            return prepared;
          },
          async read() {
            order.push("read");
            return { pending: [{ role: "user", content: [{ kind: "text", text: "你好" }] }] };
          },
        },
      },
    );
    expect(result.status).toBe("no_output");
    expect(order).toEqual(["prepare:requested-model:false", "read"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.contextBudget).toBe(prepared);
    expect(calls[0]?.contextInputLimit).toBe(10_000);
    expect(usage.calls).toBe(1);
    expect(usage.inputUnits).toBeGreaterThan(0);
  });

  it("rejects measured oversize before creating a model step or sending", async () => {
    const { runtime, repository, calls } = setup();
    const prepared = budget(() => 99);
    await expect(
      runtime.run(
        { ...baseSpec, limits: { steps: 2, inputUnits: 1 } },
        {
          owner,
          authorizedTargets: ["web"],
          outputMode: "buffered",
          context: {
            prepareModelContext: async () => prepared,
            async read() {
              return { pending: [{ role: "user", content: [{ kind: "text", text: "oversize" }] }] };
            },
          },
        },
      ),
    ).rejects.toMatchObject({ code: "AGENT_CONTEXT_LIMIT" });
    expect(calls).toHaveLength(0);
    const run = repository.listRuns({ ownerKind: owner.kind, ownerId: owner.id })[0];
    expect(run).toMatchObject({ status: "failed", errorCode: "AGENT_CONTEXT_LIMIT", steps: [] });
  });

  it("keeps non-opted runtime requests on the legacy path", async () => {
    const { runtime, calls } = setup();
    let prepares = 0;
    await runtime.run(
      { ...baseSpec, limits: { steps: 2, inputUnits: 10_000 } },
      {
        owner,
        authorizedTargets: ["web"],
        outputMode: "buffered",
        context: {
          async prepareModelContext() {
            prepares++;
            return undefined;
          },
          async read() {
            return { pending: [{ role: "user", content: [{ kind: "text", text: "legacy" }] }] };
          },
        },
      },
    );
    expect(prepares).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toHaveProperty("contextBudget");
    expect(calls[0]).not.toHaveProperty("contextInputLimit");
  });
});
