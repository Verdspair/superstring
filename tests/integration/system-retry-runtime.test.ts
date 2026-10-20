import { afterEach, describe, expect, it } from "bun:test";
import { AgentRuntime } from "../../src/server/agent/agent-runtime";
import type { AgentSpec } from "../../src/server/agent/agent-specs";
import { ConversationHost } from "../../src/server/agent/conversation-host";
import type { ModelPort, ModelRequest, MultimodalRequest } from "../../src/server/agent/model-port";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import type { RunOwner } from "../../src/shared/contracts/agent-run";

const handles: ReturnType<typeof openBusinessDb>[] = [];
afterEach(() => {
  for (const handle of handles.splice(0)) handle.close();
});

const owner: RunOwner = { kind: "test_job", id: "retry", userId: "u", agentId: "a" };
const spec: AgentSpec = {
  id: "retry-runtime",
  model: "chat",
  instructions: "test",
  context: "conversation",
  availableActions: [],
  limits: { steps: 4 },
};
const conversation = {
  owner,
  authorizedTargets: ["web"],
  outputMode: "buffered" as const,
  context: {
    async read() {
      return { pending: [] };
    },
  },
};

function setup(
  model: Partial<ModelPort> = {},
  policy: () => { maxAttempts: number; retryDelayMs: number } = () => ({
    maxAttempts: 3,
    retryDelayMs: 2,
  }),
) {
  const handle = openBusinessDb();
  handles.push(handle);
  const repository = new AgentRunRepository(handle.db);
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
  return {
    repository,
    runtime: new AgentRuntime({ model: port, repository, systemRetryPolicy: policy }),
  };
}

function refusal(status: number) {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

describe("system model retry runtime ownership", () => {
  it("passes the retry policy to decision and generation requests only for trusted System runs", async () => {
    const requests: ModelRequest[] = [];
    let decisionSend = 0;
    const { runtime } = setup({
      async complete(request) {
        requests.push(request);
        if (decisionSend++ === 0) {
          request.onRetry?.();
          return '{"kind":"final","outputs":[{"kind":"generate","targetId":"web","instructions":"answer"}]}';
        }
        return "ok";
      },
      async *streamText(request) {
        requests.push(request);
        yield "answer";
      },
    });
    await runtime.run(spec, { ...conversation, retryOrigin: "system" });
    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.retryPolicy)).toEqual([
      { maxAttempts: 3, retryDelayMs: 2 },
      { maxAttempts: 3, retryDelayMs: 2 },
    ]);
  });

  it("passes the snapshot through the multimodal model request", async () => {
    const requests: MultimodalRequest[] = [];
    const { runtime } = setup({
      async completeMultimodal(request) {
        requests.push(request);
        return "description";
      },
    });
    await runtime.completeVisionLeaf(
      { id: "vision" },
      {
        owner,
        retryOrigin: "system",
        model: "vision",
        prompt: "describe",
        images: [],
      },
    );
    expect(requests[0]?.retryPolicy).toEqual({ maxAttempts: 3, retryDelayMs: 2 });
  });

  it("inherits a parent QQ or unset origin without promoting a child to System", async () => {
    const requests: ModelRequest[] = [];
    const { runtime } = setup({
      async complete(request) {
        requests.push(request);
        return '{"ok":true}';
      },
    });
    await runtime.completeLeaf(
      { id: "qq" },
      {
        owner,
        messages: [{ role: "user", content: "qq" }],
        retryOrigin: "qq",
      },
    );
    await runtime.runTaskGroup({ id: "qq-parent" }, { owner, retryOrigin: "qq" }, async () => {
      await runtime.completeLeaf(
        { id: "child" },
        {
          owner,
          messages: [{ role: "user", content: "child" }],
          retryOrigin: "system",
        },
      );
    });
    await runtime.runTaskGroup({ id: "unset-parent" }, { owner }, async () => {
      await runtime.completeLeaf(
        { id: "child" },
        {
          owner,
          messages: [{ role: "user", content: "child" }],
          retryOrigin: "system",
        },
      );
    });
    await runtime.runTaskGroup(
      { id: "system-parent" },
      { owner, retryOrigin: "system" },
      async () => {
        await runtime.completeLeaf(
          { id: "child" },
          {
            owner,
            messages: [{ role: "user", content: "child" }],
            retryOrigin: "qq",
          },
        );
      },
    );
    expect(requests.map((request) => request.retryPolicy)).toEqual([
      undefined,
      undefined,
      undefined,
      { maxAttempts: 3, retryDelayMs: 2 },
    ]);
  });

  it("keeps unknown channel provenance conservative instead of guessing System", async () => {
    const requests: ModelRequest[] = [];
    const { runtime } = setup({
      async complete(request) {
        requests.push(request);
        return '{"kind":"none"}';
      },
    });
    const host = new ConversationHost({ runtime });
    await host.activate({
      ...conversation,
      conversation: { id: "unknown-channel", channel: "other", topology: "direct", agentId: "a" },
      spec,
    });
    expect(requests[0]?.retryPolicy).toBeUndefined();
  });

  it("snapshots System policy once and blocks retry send when the task-call budget is spent", async () => {
    const requests: ModelRequest[] = [];
    let policy = { maxAttempts: 3, retryDelayMs: 17 };
    let policyReads = 0;
    let physicalSends = 1;
    const { runtime } = setup(
      {
        async complete(request) {
          requests.push(request);
          try {
            throw refusal(503);
          } catch (error) {
            const status = (error as { status?: number }).status;
            if (status === 503 && request.retryPolicy) {
              request.onRetry?.();
              physicalSends += 1;
            }
            throw error;
          }
        },
      },
      () => {
        policyReads += 1;
        return policy;
      },
    );
    const run = runtime.run(spec, {
      ...conversation,
      retryOrigin: "system",
      budget: { maxCalls: 1 },
    });
    policy = { maxAttempts: 8, retryDelayMs: 9 };
    await expect(run).rejects.toMatchObject({ code: "AGENT_BUDGET_EXCEEDED" });
    expect(policyReads).toBe(1);
    expect(physicalSends).toBe(1);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.retryPolicy).toEqual({ maxAttempts: 3, retryDelayMs: 17 });
  });

  it("completes the QQ batch-evaluation message leaf once without System retry wiring", async () => {
    const requests: ModelRequest[] = [];
    const { runtime } = setup({
      async complete(request) {
        requests.push(request);
        return '{"decision":"none"}';
      },
    });
    await expect(
      runtime.completeMessageLeaf(
        { id: "onebot.initiative.evaluate_batch" },
        {
          owner,
          retryOrigin: "qq",
          messages: [{ role: "user", content: [{ kind: "text", text: "synthetic batch" }] }],
        },
      ),
    ).resolves.toBe('{"decision":"none"}');
    expect(requests).toHaveLength(1);
    expect(requests[0]?.retryPolicy).toBeUndefined();
  });

  it("rechecks leaf source authority before each extra model send", async () => {
    const requests: ModelRequest[] = [];
    let sourceChecks = 0;
    const { runtime } = setup({
      async complete(request) {
        requests.push(request);
        try {
          throw refusal(429);
        } catch (error) {
          if ((error as { status?: number }).status === 429) request.onRetry?.();
          throw error;
        }
      },
    });
    await expect(
      runtime.completeLeaf(
        { id: "source-bound" },
        {
          owner,
          retryOrigin: "system",
          messages: [{ role: "user", content: "authorized source" }],
          sources: [{ kind: "memory", id: "m", revision: "1" }],
          assertSources() {
            sourceChecks += 1;
            throw new Error("CONTEXT_SOURCE_INVALID");
          },
        },
      ),
    ).rejects.toThrow("CONTEXT_SOURCE_INVALID");
    expect(requests).toHaveLength(1);
    expect(sourceChecks).toBe(1);
  });
});
