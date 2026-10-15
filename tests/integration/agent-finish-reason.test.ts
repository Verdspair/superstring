import { afterEach, describe, expect, it } from "bun:test";
import { AgentRuntime } from "../../src/server/agent/agent-runtime";
import type { AgentSpec, LeafAgentSpec } from "../../src/server/agent/agent-specs";
import { inspectContext } from "../../src/server/agent/context-access";
import { textMessage } from "../../src/server/agent/context-engine";
import type { ModelPort, ModelRequest, MultimodalRequest } from "../../src/server/agent/model-port";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { DEFAULT_AGENT_ID, DEFAULT_USER_ID } from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import type { ModelResponseMetadata } from "../../src/shared/contracts/agent-run";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
});
const owner = { kind: "test", id: "fixture", userId: DEFAULT_USER_ID, agentId: DEFAULT_AGENT_ID };
const leafInput = { owner, messages: [{ role: "user", content: "PRIVATE_INPUT" }] };

const mainSpec: AgentSpec = {
  id: "main",
  instructions: "PRIVATE_PERSONA",
  model: "decision",
  context: "conversation",
  availableActions: [],
  limits: { steps: 8 },
  generation: { model: "writer" },
};

interface RecordedCall {
  model: string | undefined;
  request: ModelRequest | MultimodalRequest;
}

/** Synthetic port: dispatches per model, hands each send its own onModelResponse callback. */
function syntheticPort(handlers: {
  complete?: (call: RecordedCall) => string | Promise<string>;
  streamText?: (call: RecordedCall) => AsyncGenerator<string, void, unknown>;
  completeMultimodal?: (call: RecordedCall) => string | Promise<string>;
}): { port: ModelPort; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const port: ModelPort = {
    async complete(request) {
      calls.push({ model: request.model, request });
      return (await handlers.complete?.({ model: request.model, request })) ?? '{"kind":"none"}';
    },
    async *streamText(request) {
      calls.push({ model: request.model, request });
      if (!handlers.streamText) {
        yield "PRIVATE_OUTPUT";
        return;
      }
      yield* handlers.streamText({ model: request.model, request });
    },
    async completeMultimodal(request) {
      calls.push({ model: request.model, request });
      return (
        (await handlers.completeMultimodal?.({ model: request.model, request })) ?? "PRIVATE_VISION"
      );
    },
  };
  return { port, calls };
}

function setup(port: ModelPort) {
  const h = openBusinessDb();
  const runs = new AgentRunRepository(h.db);
  const runtime = new AgentRuntime({ repository: runs, model: port });
  cleanups.push(() => h.close());
  return { h, runs, runtime };
}

const report = (metadata: Partial<ModelResponseMetadata>): ModelResponseMetadata => ({
  transport: "complete",
  finishReasons: [],
  ...metadata,
});

function lastStep(runs: AgentRunRepository, runId: string) {
  const steps = runs.getRun(runId)!.steps;
  const stepId = steps[steps.length - 1].stepId;
  return { stepId, stored: runs.getContext({ runId, stepId }) };
}

describe("agent runtime model-response metadata", () => {
  it("records one metadata entry per HTTP send on a leaf and keeps the old shape without a callback", async () => {
    const meta = report({ httpStatus: 200, finishReasons: ["stop"] });
    const { port, calls } = syntheticPort({
      complete: ({ request }) => {
        request.onModelResponse?.(meta);
        return "PRIVATE_LEAF_TEXT";
      },
    });
    const f = setup(port);
    await f.runtime.completeLeaf({ id: "leaf-a" } as LeafAgentSpec, leafInput);
    const runId = f.runs.listRuns({ ownerKind: owner.kind, ownerId: owner.id })[0].runId;
    const { stored } = lastStep(f.runs, runId);
    expect(stored?.output).toMatchObject({
      text: "PRIVATE_LEAF_TEXT",
      complete: true,
      format: "text",
      responses: [meta],
    });
    expect(calls).toHaveLength(1);

    const plain = setup(syntheticPort({ complete: () => "PRIVATE_PLAIN" }).port);
    await plain.runtime.completeLeaf({ id: "leaf-b" } as LeafAgentSpec, leafInput);
    const plainRun = plain.runs.listRuns({ ownerKind: owner.kind, ownerId: owner.id })[0].runId;
    const plainStored = lastStep(plain.runs, plainRun).stored;
    // 无回调＝旧形状逐字保留：不带 responses，也不带 hasText。
    expect(Object.keys(plainStored!.output!).sort()).toEqual(["complete", "format", "text"]);
  });

  it("propagates the callback through decision, structured generate, stream generate and vision", async () => {
    const decisionMeta = report({ httpStatus: 200, finishReasons: ["tool_calls"] });
    const generateMeta = report({
      transport: "stream",
      httpStatus: 200,
      finishReasons: ["stop"],
      doneMarker: true,
    });
    const structuredMeta = report({ httpStatus: 200, finishReasons: ["stop"] });
    const visionMeta = report({ transport: "vision", httpStatus: 200, finishReasons: ["stop"] });

    const { port } = syntheticPort({
      complete: ({ model, request }) => {
        if (model === "decision") {
          request.onModelResponse?.(decisionMeta);
          return '{"kind":"final","outputs":[{"kind":"generate","targetId":"web","instructions":"PRIVATE_DRAFT"}]}';
        }
        request.onModelResponse?.(structuredMeta);
        return '{"text":"PRIVATE_BODY"}';
      },
      streamText: async function* ({ request }) {
        request.onModelResponse?.(generateMeta);
        yield "PRIVATE_BODY";
      },
      completeMultimodal: ({ request }) => {
        request.onModelResponse?.(visionMeta);
        return "PRIVATE_VISION";
      },
    });
    const f = setup(port);
    const buffered = await f.runtime.run(mainSpec, {
      owner,
      authorizedTargets: ["web"],
      outputMode: "buffered",
      context: { read: async () => ({ pending: [textMessage("user", "PRIVATE_INPUT")] }) },
      prepareGeneration: async () => ({
        responseEnvelope: {
          responseSchema: { type: "object" },
          parse: (raw: string) => ({ text: JSON.parse(raw).text as string }),
        },
      }),
    });
    const bufferedSteps = f.runs.getRun(buffered.runId)!.steps;
    const decisionStored = f.runs.getContext({
      runId: buffered.runId,
      stepId: bufferedSteps.find((s) => s.phase === "next")!.stepId,
    });
    expect(decisionStored?.output).toMatchObject({ responses: [decisionMeta] });
    const structuredStored = f.runs.getContext({
      runId: buffered.runId,
      stepId: bufferedSteps.find((s) => s.phase === "generate")!.stepId,
    });
    expect(structuredStored?.output).toMatchObject({
      text: '{"text":"PRIVATE_BODY"}',
      responses: [structuredMeta],
    });

    const streamed = await f.runtime.run(mainSpec, {
      owner,
      authorizedTargets: ["web"],
      outputMode: "stream",
      context: { read: async () => ({ pending: [textMessage("user", "PRIVATE_INPUT")] }) },
    });
    const streamStep = f.runs.getRun(streamed.runId)!.steps.find((s) => s.phase === "generate")!;
    expect(
      f.runs.getContext({ runId: streamed.runId, stepId: streamStep.stepId })?.output,
    ).toMatchObject({ complete: true, responses: [generateMeta] });

    await f.runtime.completeVisionLeaf(
      { id: "vision" },
      {
        ...leafInput,
        model: "vision",
        prompt: "PRIVATE_PROMPT",
        images: [{ mimeType: "image/png", bytes: new Uint8Array([1]) }],
      },
    );
    const visionRun = f.runs
      .listRuns({ ownerKind: owner.kind, ownerId: owner.id })
      .find((run) => run.specId === "vision")!.runId;
    const { stored: visionStored } = lastStep(f.runs, visionRun);
    expect(visionStored?.output).toMatchObject({ responses: [visionMeta] });
  });

  it("records both attempts of an unsupported-media decision retry in send order", async () => {
    const first = report({ httpStatus: 400, finishReasons: [] });
    const second = report({ httpStatus: 200, finishReasons: ["stop"] });
    let decisionNo = 0;
    const { port } = syntheticPort({
      complete: ({ model, request }) => {
        if (model !== "decision") return '{"kind":"none"}';
        decisionNo += 1;
        if (decisionNo === 1) {
          request.onModelResponse?.(first);
          throw Object.assign(new Error("unsupported"), { code: "MODEL_IMAGE_UNSUPPORTED" });
        }
        request.onModelResponse?.(second);
        return '{"kind":"none"}';
      },
    });
    const f = setup(port);
    const result = await f.runtime.run(mainSpec, {
      owner,
      authorizedTargets: [],
      outputMode: "buffered",
      context: { read: async () => ({ pending: [textMessage("user", "PRIVATE_INPUT")] }) },
      onPhaseMediaUnsupported: async () => ({
        messages: [textMessage("user", "PRIVATE_RETRY")],
      }),
    });
    expect(result.status).toBe("no_output");
    const decisionStep = f.runs.getRun(result.runId)!.steps.find((s) => s.phase === "next")!;
    expect(
      f.runs.getContext({ runId: result.runId, stepId: decisionStep.stepId })?.output,
    ).toMatchObject({ responses: [first, second] });
  });

  it("records both stream attempts when the first stream send fails unsupported before any delta", async () => {
    const first = report({ transport: "stream", httpStatus: 400, finishReasons: [] });
    const second = report({ transport: "stream", httpStatus: 200, finishReasons: ["stop"] });
    let streamNo = 0;
    const { port } = syntheticPort({
      complete: ({ model, request }) => {
        if (model !== "decision") return '{"kind":"none"}';
        void request;
        return '{"kind":"final","outputs":[{"kind":"generate","targetId":"web","instructions":"PRIVATE_DRAFT"}]}';
      },
      streamText: async function* ({ request }) {
        streamNo += 1;
        if (streamNo === 1) {
          request.onModelResponse?.(first);
          throw Object.assign(new Error("unsupported"), { code: "MODEL_IMAGE_UNSUPPORTED" });
        }
        request.onModelResponse?.(second);
        yield "PRIVATE_BODY";
      },
    });
    const f = setup(port);
    const result = await f.runtime.run(mainSpec, {
      owner,
      authorizedTargets: ["web"],
      outputMode: "stream",
      context: { read: async () => ({ pending: [textMessage("user", "PRIVATE_INPUT")] }) },
      onPhaseMediaUnsupported: async () => ({
        messages: [textMessage("user", "PRIVATE_RETRY")],
      }),
    });
    expect(result.outputs[0].status).toBe("prepared");
    const generateStep = f.runs.getRun(result.runId)!.steps.find((s) => s.phase === "generate")!;
    expect(
      f.runs.getContext({ runId: result.runId, stepId: generateStep.stepId })?.output,
    ).toMatchObject({ complete: true, responses: [first, second] });
  });

  it("keeps a callback fired before a throw as a metadata-only output and inspects it as no_response", async () => {
    const meta = report({ httpStatus: 500, finishReasons: [] });
    const { port } = syntheticPort({
      complete: ({ request }) => {
        request.onModelResponse?.(meta);
        throw new Error("PRIVATE_MODEL_DOWN");
      },
    });
    const f = setup(port);
    await expect(
      f.runtime.completeLeaf({ id: "leaf-x" } as LeafAgentSpec, leafInput),
    ).rejects.toThrow("PRIVATE_MODEL_DOWN");
    const runId = f.runs.listRuns({ ownerKind: owner.kind, ownerId: owner.id })[0].runId;
    const { stepId, stored } = lastStep(f.runs, runId);
    expect(stored?.output).toEqual({
      text: "",
      format: "text",
      complete: false,
      hasText: false,
      responses: [meta],
    });
    const inspected = inspectContext(
      f.h.db,
      f.runs,
      { runId, stepId },
      { userId: DEFAULT_USER_ID },
    );
    expect(inspected?.result).toEqual({
      status: "unavailable",
      reason: "no_response",
      responses: [meta],
    });
  });

  it("stores an unknown finish reason verbatim before the port throws", async () => {
    const meta = report({ httpStatus: 200, finishReasons: ["model_did_something_new"] });
    const { port } = syntheticPort({
      complete: ({ request }) => {
        request.onModelResponse?.(meta);
        throw new Error("PRIVATE_AFTER_SEND");
      },
    });
    const f = setup(port);
    await expect(
      f.runtime.completeLeaf({ id: "leaf-y" } as LeafAgentSpec, leafInput),
    ).rejects.toThrow("PRIVATE_AFTER_SEND");
    const runId = f.runs.listRuns({ ownerKind: owner.kind, ownerId: owner.id })[0].runId;
    const { stored } = lastStep(f.runs, runId);
    expect(stored?.output).toMatchObject({ responses: [meta] });
  });

  it("isolates concurrent steps: each step sees only its own sends", async () => {
    const metaA = report({ httpStatus: 200, finishReasons: ["a"] });
    const metaB = report({ httpStatus: 200, finishReasons: ["b"] });
    let releaseA!: () => void;
    const gateA = new Promise<void>((r) => {
      releaseA = r;
    });
    const { port } = syntheticPort({
      complete: async ({ model, request }) => {
        if (model === "a") {
          await gateA;
          request.onModelResponse?.(metaA);
          return "PRIVATE_A";
        }
        request.onModelResponse?.(metaB);
        releaseA();
        await new Promise((r) => setTimeout(r, 0));
        return "PRIVATE_B";
      },
    });
    const f = setup(port);
    await Promise.all([
      f.runtime.completeLeaf({ id: "leaf-a", model: "a" } as LeafAgentSpec, leafInput),
      f.runtime.completeLeaf({ id: "leaf-b", model: "b" } as LeafAgentSpec, leafInput),
    ]);
    const concurrent = f.runs.listRuns({ ownerKind: owner.kind, ownerId: owner.id });
    const runA = concurrent.find((run) => run.specId === "leaf-a")!.runId;
    const runB = concurrent.find((run) => run.specId === "leaf-b")!.runId;
    expect(lastStep(f.runs, runA).stored?.output).toMatchObject({ responses: [metaA] });
    expect(lastStep(f.runs, runB).stored?.output).toMatchObject({ responses: [metaB] });
  });

  it("discards stored metadata when the source is revoked or the snapshot expired; no revival", async () => {
    const meta = report({ httpStatus: 200, finishReasons: ["stop"] });
    const { port } = syntheticPort({
      complete: ({ request }) => {
        request.onModelResponse?.(meta);
        return "PRIVATE_WITH_SOURCE";
      },
    });
    const f = setup(port);
    const source = {
      kind: "fixture",
      id: "src-1",
      revision: "1",
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    };
    await f.runtime.completeLeaf({ id: "leaf-s" } as LeafAgentSpec, {
      ...leafInput,
      sources: [source],
    });
    const runId = f.runs.listRuns({ ownerKind: owner.kind, ownerId: owner.id })[0].runId;
    const { stepId } = lastStep(f.runs, runId);
    const exact = inspectContext(
      f.h.db,
      f.runs,
      { runId, stepId },
      { userId: DEFAULT_USER_ID },
      new Date().toISOString(),
      () => "available" as const,
    );
    expect(exact?.status).toBe("exact");
    expect(exact?.result).toMatchObject({ status: "exact", responses: [meta] });
    // 撤销后再检查：元数据不出示，结果只有状态，也不复活快照。
    const revoked = inspectContext(
      f.h.db,
      f.runs,
      { runId, stepId },
      { userId: DEFAULT_USER_ID },
      new Date().toISOString(),
      () => "revoked" as const,
    );
    expect(revoked?.status).toBe("revoked");
    expect(revoked?.result).toEqual({ status: "revoked" });
    expect(JSON.stringify(revoked)).not.toContain("finishReasons");
    // 建立时已过期的来源快照直接落 expired：元数据同样不出示。
    await f.runtime.completeLeaf({ id: "leaf-e" } as LeafAgentSpec, {
      ...leafInput,
      sources: [
        {
          kind: "fixture",
          id: "src-2",
          revision: "1",
          expiresAt: new Date(Date.now() - 1000).toISOString(),
        },
      ],
    });
    const expiredRun = f.runs
      .listRuns({ ownerKind: owner.kind, ownerId: owner.id })
      .find((run) => run.specId === "leaf-e")!.runId;
    const expiredStep = f.runs.getRun(expiredRun)!.steps.at(-1)!.stepId;
    const expired = inspectContext(
      f.h.db,
      f.runs,
      { runId: expiredRun, stepId: expiredStep },
      { userId: DEFAULT_USER_ID },
    );
    expect(expired?.status).toBe("expired");
    expect(expired?.result).toEqual({ status: "expired" });
  });
});
