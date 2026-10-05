import { afterEach, describe, expect, it } from "bun:test";
import { AgentRuntime, type ConversationInput } from "../../src/server/agent/agent-runtime";
import type { AgentSpec } from "../../src/server/agent/agent-specs";
import { textMessage } from "../../src/server/agent/context-engine";
import type { ModelPort, ModelRequest } from "../../src/server/agent/model-port";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import type { RunOwner } from "../../src/shared/contracts/agent-run";

const handles: ReturnType<typeof openBusinessDb>[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
});
const owner = {
  kind: "test_job",
  id: "job-1",
  userId: "u",
  agentId: "a",
} satisfies RunOwner;
const spec: AgentSpec = {
  id: "main",
  model: "chat",
  instructions: "Persona",
  context: "conversation",
  availableActions: [],
  limits: { steps: 8 },
};
type Consumed = { readonly phase: "next" | "generate" | "leaf" };
function setup(model: Partial<ModelPort>) {
  const h = openBusinessDb();
  handles.push(h);
  const repository = new AgentRunRepository(h.db);
  const port: ModelPort = {
    async complete() {
      return JSON.stringify({
        kind: "final",
        outputs: [{ kind: "generate", targetId: "web", instructions: "answer" }],
      });
    },
    async *streamText() {
      yield "answer";
    },
    async completeMultimodal() {
      return "vision";
    },
    ...model,
  };
  const runtime = new AgentRuntime({ model: port, repository });
  const consumed: Array<Consumed["phase"]> = [];
  const base: ConversationInput = {
    owner,
    authorizedTargets: ["web"],
    outputMode: "buffered",
    context: {
      async read() {
        return { pending: [textMessage("user", "hello")] };
      },
    },
    onModelCallConsumed: (input: Consumed) => {
      consumed.push(input.phase);
    },
  };
  return { h, repository, runtime, consumed, base };
}

describe("AgentRuntime stream generation consumed accounting (§8.1 G1)", () => {
  it("notifies onModelCallConsumed exactly once for a completed stream generation", async () => {
    const requests: ModelRequest[] = [];
    const { repository, runtime, consumed, base } = setup({
      async *streamText(request: ModelRequest) {
        requests.push(request);
        yield "answer";
      },
    });
    const result = await runtime.run(spec, base);
    expect(result.status).toBe("completed");
    expect(result.outputs).toMatchObject([{ targetId: "web", status: "prepared", text: "answer" }]);
    expect(repository.getRun(result.runId)?.status).toBe("completed");
    expect(requests).toHaveLength(1);
    expect(requests[0].messages.at(-1)).toEqual(textMessage("user", "hello"));
    expect(consumed).toEqual(["next", "generate"]);
  });

  it("does not notify when the stream fails after partial deltas", async () => {
    const { repository, runtime, consumed, base } = setup({
      async *streamText() {
        yield "par";
        throw new Error("stream boom");
      },
    });
    await expect(runtime.run(spec, base)).rejects.toMatchObject({
      code: "AGENT_OUTPUT_FAILED",
    });
    expect(repository.listRuns({ ownerKind: owner.kind, ownerId: owner.id })[0].status).toBe(
      "failed",
    );
    expect(consumed).toEqual(["next"]);
  });

  it("does not notify on an empty stream response", async () => {
    const { runtime, consumed, base } = setup({
      async *streamText() {},
    });
    await expect(runtime.run(spec, base)).rejects.toMatchObject({
      code: "AGENT_OUTPUT_FAILED",
    });
    expect(consumed).toEqual(["next"]);
  });

  it("does not notify when the stream is aborted mid-flight", async () => {
    const controller = new AbortController();
    const { repository, runtime, consumed, base } = setup({
      async *streamText() {
        yield "par";
        controller.abort();
        yield "tial";
      },
    });
    await expect(runtime.run(spec, { ...base, signal: controller.signal })).rejects.toThrow();
    expect(repository.listRuns({ ownerKind: owner.kind, ownerId: owner.id })[0].status).toBe(
      "cancelled",
    );
    expect(consumed).toEqual(["next"]);
  });

  it("notifies exactly once after a zero-delta unsupported fallback retry succeeds", async () => {
    const attempts: Array<readonly unknown[]> = [];
    const { repository, runtime, consumed, base } = setup({
      async *streamText(request: ModelRequest) {
        attempts.push(request.messages);
        if (attempts.length === 1) {
          const error = new Error("model cannot read images");
          (error as { code?: string }).code = "MODEL_IMAGE_UNSUPPORTED";
          throw error;
        }
        yield "description";
      },
    });
    const result = await runtime.run(spec, {
      ...base,
      onPhaseMediaUnsupported: async () => ({
        messages: [textMessage("user", "describe the picture")],
      }),
    });
    expect(result.status).toBe("completed");
    expect(result.outputs).toMatchObject([
      { targetId: "web", status: "prepared", text: "description" },
    ]);
    expect(attempts).toHaveLength(2);
    expect(attempts[1].at(-1)).toEqual(textMessage("user", "describe the picture"));
    expect(repository.getRun(result.runId)?.status).toBe("completed");
    expect(consumed).toEqual(["next", "generate"]);
  });
});

describe("AgentRuntime generate consumed late-cancel strong negatives (§8.1)", () => {
  it("does not notify when abort lands during the final stream generator completion (no next delta)", async () => {
    const controller = new AbortController();
    const { repository, runtime, consumed, base } = setup({
      async *streamText() {
        yield "par";
        controller.abort();
      },
    });
    await expect(runtime.run(spec, { ...base, signal: controller.signal })).rejects.toThrow();
    expect(repository.listRuns({ ownerKind: owner.kind, ownerId: owner.id })[0].status).toBe(
      "cancelled",
    );
    expect(consumed).toEqual(["next"]);
  });

  it("does not notify when abort lands before the structured generation complete returns", async () => {
    const controller = new AbortController();
    let generationCall = 0;
    const { repository, runtime, consumed, base } = setup({
      async complete() {
        generationCall += 1;
        if (generationCall === 1) {
          return JSON.stringify({
            kind: "final",
            outputs: [{ kind: "generate", targetId: "web", instructions: "answer" }],
          });
        }
        controller.abort();
        return JSON.stringify({ text: "envelope body" });
      },
    });
    await expect(
      runtime.run(spec, {
        ...base,
        signal: controller.signal,
        async prepareGeneration() {
          return {
            responseEnvelope: {
              responseSchema: {},
              parse: (raw: string) => JSON.parse(raw) as { text: string },
            },
          };
        },
      }),
    ).rejects.toThrow();
    expect(repository.listRuns({ ownerKind: owner.kind, ownerId: owner.id })[0].status).toBe(
      "cancelled",
    );
    expect(consumed).toEqual(["next"]);
  });
});
