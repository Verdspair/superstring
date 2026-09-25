import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
  AgentRuntime,
  AgentRuntimeError,
  createAgentRuntime,
} from "../../src/server/agent/agent-runtime";
import type { AgentSpec } from "../../src/server/agent/agent-specs";
import { createBuiltInActions } from "../../src/server/agent/built-in-actions";
import { inputUnits, textMessage } from "../../src/server/agent/context-engine";
import type { ModelPort, ModelRequest } from "../../src/server/agent/model-port";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import type { ModelGateway } from "../../src/server/llm/model-gateway";
import { createLmStudioVisionClient } from "../../src/server/llm/vision-client";
import { estimateMessages } from "../../src/server/services/context-builder";
import {
  type RunEvent,
  RunEventSchema,
  RunSnapshotSchema,
} from "../../src/shared/contracts/agent-run";

const handles: ReturnType<typeof openBusinessDb>[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
});
const owner = { kind: "test_job", id: "job-1", userId: "u", agentId: "a" };
const spec: AgentSpec = {
  id: "main",
  model: "chat",
  instructions: "Persona",
  context: "conversation",
  availableActions: [],
  limits: { steps: 8 },
};
const direct = {
  owner,
  authorizedTargets: ["web"],
  outputMode: "stream" as const,
  context: {
    async read() {
      return { pending: [textMessage("user", "hello")] };
    },
  },
};
function setup(model: Partial<ModelPort> = {}) {
  const h = openBusinessDb();
  handles.push(h);
  const repository = new AgentRunRepository(h.db);
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
  return { h, repository, runtime: new AgentRuntime({ model: port, repository }) };
}

describe("unified AgentRuntime", () => {
  it("preserves leaf messages/model/options and validates before recording success without conversation recursion", async () => {
    const seen: ModelRequest[] = [];
    const { runtime, repository } = setup({
      async complete(request) {
        seen.push(request);
        return '{"ok":true}';
      },
    });
    const messages = [
      { role: "system", content: "original prompt" },
      { role: "user", content: "原始输入" },
    ];
    const responseSchema = { type: "object", properties: { ok: { type: "boolean" } } };
    let validated = false;
    const result = await runtime.completeLeaf(
      { id: "leaf", model: "organize", temperature: 0.3, maxTokens: 321, responseSchema },
      {
        owner,
        messages,
        validate(raw) {
          validated = JSON.parse(raw).ok;
        },
      },
    );
    expect(validated).toBe(true);
    expect(result).toBe('{"ok":true}');
    expect(seen[0]).toMatchObject({
      model: "organize",
      temperature: 0.3,
      maxTokens: 321,
      responseSchema,
    });
    expect(seen[0].messages).toEqual(
      messages.map((m) => textMessage(m.role as "system" | "user", m.content)),
    );
    const run = repository.listRuns({ ownerKind: owner.kind, ownerId: owner.id })[0];
    expect(RunSnapshotSchema.parse(run).status).toBe("completed");
    expect(run.steps).toHaveLength(1);
    expect(run.steps[0].phase).toBe("leaf");
    expect(repository.getContext(run.steps[0].context)?.messages).toEqual([...seen[0].messages]);
    expect(run.lastSeq).toBe(3);
  });

  it("records invalid domain responses as failed and preserves the domain error", async () => {
    const { runtime, repository } = setup({
      async complete() {
        return "malformed";
      },
    });
    const failure = new Error("domain validation failed");
    await expect(
      runtime.completeLeaf(
        { id: "leaf" },
        {
          owner,
          messages: [],
          validate() {
            throw failure;
          },
        },
      ),
    ).rejects.toBe(failure);
    const run = repository.listRuns({ ownerKind: owner.kind, ownerId: owner.id })[0];
    expect(run.status).toBe("failed");
    expect(run.steps[0].status).toBe("failed");
    expect(repository.listEvents(run.runId).at(-1)?.type).toBe("failed");
  });

  it("renders explicitly configured leaf instructions as trusted system input", async () => {
    const { runtime } = setup({
      async complete(request) {
        expect(request.messages).toEqual([
          textMessage("system", "Classify sentiment."),
          textMessage("user", "Great"),
        ]);
        return "positive";
      },
    });
    await expect(
      runtime.completeLeaf(
        { id: "one-line", instructions: "Classify sentiment." },
        {
          owner,
          messages: [{ role: "user", content: "Great" }],
        },
      ),
    ).resolves.toBe("positive");
  });

  it("persists source/hash metadata for vision without persisting image bytes", async () => {
    const { h, repository } = setup();
    let callSignal: AbortSignal | undefined;
    const runtime = createAgentRuntime({
      repository,
      vision: {
        async annotate(request) {
          callSignal = (request as { signal?: AbortSignal }).signal;
          return "description";
        },
      },
    });
    const bytes = new Uint8Array([42, 99, 17]);
    await runtime.completeVisionLeaf(
      { id: "vision" },
      {
        owner,
        model: "vision-model",
        prompt: "describe",
        images: [{ mimeType: "image/png", bytes }],
        sources: [{ kind: "qq_media", id: "image", revision: "2" }],
      },
    );
    expect(callSignal).toBeInstanceOf(AbortSignal);
    const run = repository.listRuns({ ownerKind: owner.kind, ownerId: owner.id })[0];
    const snapshot = repository.getContext(run.steps[0].context);
    expect(snapshot?.messages?.[0].content[1]).toEqual({
      kind: "image",
      sourceId: "image",
      revision: "2",
      mimeType: "image/png",
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    expect(JSON.stringify(h.db.query("SELECT * FROM context_snapshots").all())).not.toContain(
      "data:image",
    );
    expect(JSON.stringify(snapshot)).not.toContain('"bytes"');
  });

  it("honors explicit vision instructions and model options while leaving legacy defaults intact", async () => {
    const { repository } = setup();
    const requests: Record<string, unknown>[] = [];
    const vision = createLmStudioVisionClient(
      { baseUrl: "http://model/v1", model: "vision", timeoutSeconds: 30 },
      (async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ choices: [{ message: { content: "description" } }] }));
      }) as typeof fetch,
    );
    const runtime = createAgentRuntime({ repository, vision });
    await runtime.completeVisionLeaf(
      { id: "vision", instructions: "Describe colors.", temperature: 0.6, maxTokens: 123 },
      {
        owner,
        model: "vision",
        prompt: "Look",
        images: [],
      },
    );
    expect(requests[0]).toMatchObject({
      temperature: 0.6,
      max_tokens: 123,
      messages: [
        { role: "system", content: "Describe colors." },
        { role: "user", content: [{ type: "text", text: "Look" }] },
      ],
    });
    const run = repository.listRuns({ ownerKind: owner.kind, ownerId: owner.id })[0];
    expect(repository.getContext(run.steps[0].context)?.messages?.[0]).toEqual(
      textMessage("system", "Describe colors."),
    );
    await runtime.completeVisionLeaf(
      { id: "legacy-vision" },
      { owner, model: "vision", prompt: "Look", images: [] },
    );
    expect(requests[1].temperature).toBe(0.2);
    expect(requests[1]).not.toHaveProperty("max_tokens");
    expect(requests[1].messages).toEqual([
      { role: "user", content: [{ type: "text", text: "Look" }] },
    ]);
  });

  it("runs invoke-observe-final with trusted per-run actions, live deltas and atomic host commit", async () => {
    const calls: ModelRequest[] = [];
    const { h, runtime, repository } = setup({
      async complete(request) {
        calls.push(request);
        return calls.length === 1
          ? '{"kind":"invoke","name":"memory.query","arguments":{"query":"rule"}}'
          : '{"kind":"final","outputs":[{"kind":"generate","targetId":"web","instructions":"Use evidence"}]}';
      },
      async *streamText(request) {
        const system = JSON.stringify(request.messages[0]);
        expect(system).not.toContain("Return exactly one JSON decision");
        expect(system).toContain("Persona");
        yield "A";
        yield "B";
      },
    });
    const actions = createBuiltInActions({
      memory: {
        async query(input, ctx) {
          expect(input.query).toBe("rule");
          expect(ctx.owner.agentId).toBe("a");
          return [
            {
              id: "m",
              text: "untrusted rule",
              sources: [{ kind: "memory", id: "m", revision: "1" }],
            },
          ];
        },
      },
    });
    const events: RunEvent[] = [];
    let committed = false;
    const result = await runtime.run(
      { ...spec, availableActions: actions.map((a) => a.description) },
      {
        ...direct,
        actions,
        onEvent(event) {
          events.push(RunEventSchema.parse(event));
          if (event.type === "completed") expect(committed).toBe(true);
        },
        async prepareOutput() {
          return { outputId: "stable-message" };
        },
        async commitOutputs(outputs, runId, terminal) {
          expect(outputs[0].text).toBe("AB");
          expect(repository.getRun(runId)?.status).toBe("generating");
          return h.db.transaction(() => {
            committed = true;
            return repository.finishRun(runId, terminal.status, terminal.event, terminal.at);
          })();
        },
      },
    );
    expect(result.status).toBe("completed");
    expect(calls).toHaveLength(2);
    expect(
      calls[1].messages.every(
        (m) => m.role !== "system" || !JSON.stringify(m).includes("untrusted rule"),
      ),
    ).toBe(true);
    expect(
      calls[1].messages.some(
        (m) => m.role === "user" && JSON.stringify(m).includes("action_observation"),
      ),
    ).toBe(true);
    expect(events.filter((e) => e.type === "output_delta").map((e) => e.text)).toEqual(["A", "B"]);
    expect(
      repository
        .listEvents(result.runId)
        .filter((e) => e.type === "output_delta")
        .map((e) => e.text),
    ).toEqual(["", ""]);
    expect(repository.listEvents(result.runId).filter((e) => e.type === "completed")).toHaveLength(
      1,
    );
  });

  it("commits an explicit none so a host can acknowledge a wake without creating an output", async () => {
    const { runtime, repository } = setup();
    let committed = false;
    const result = await runtime.run(spec, {
      ...direct,
      async commitOutputs(outputs, _id, terminal) {
        expect(outputs).toEqual([]);
        expect(terminal.status).toBe("no_output");
        committed = true;
      },
    });
    expect(committed).toBe(true);
    expect(repository.getRun(result.runId)?.status).toBe("no_output");
  });

  it("accepts complete JSON fences without extra inference or weakening the decision schema", async () => {
    for (const response of [
      '  {"kind":"none"}\n',
      '```json\n{"kind":"none"}\n```',
      '```\r\n{"kind":"none"}\r\n```',
    ]) {
      let calls = 0;
      const { runtime, repository } = setup({
        async complete() {
          calls++;
          return response;
        },
      });
      const result = await runtime.run(spec, direct);
      expect(result.status).toBe("no_output");
      expect(calls).toBe(1);
      expect(repository.getRun(result.runId)?.steps).toHaveLength(1);
    }
    for (const response of [
      'Here is the answer: {"kind":"none"}',
      '```json\n{"kind":"none","unexpected":true}\n```',
      '```json\n{"kind":"none"}\n```\n{"kind":"none"}',
      '{"kind":"none"} {"kind":"none"}',
      '```json\n{"kind":"none"}',
    ]) {
      const { runtime, repository } = setup({
        async complete() {
          return response;
        },
      });
      await expect(runtime.run(spec, direct)).rejects.toMatchObject({
        code: "AGENT_DECISION_INVALID",
      });
      expect(repository.listRuns({ ownerKind: owner.kind, ownerId: owner.id })[0].status).toBe(
        "failed",
      );
    }
  });

  it("rejects malformed decisions and unavailable actions without inventing no_output", async () => {
    for (const response of [
      '{"kind":"none","extra":true}',
      '{"kind":"invoke","name":"shell","arguments":{}}',
    ]) {
      const { runtime, repository } = setup({
        async complete() {
          return response;
        },
      });
      await expect(runtime.run(spec, direct)).rejects.toBeInstanceOf(AgentRuntimeError);
      expect(repository.listRuns({ ownerKind: owner.kind, ownerId: owner.id })[0].status).toBe(
        "failed",
      );
    }
  });

  it("keeps other targets when one target generation fails or authorization blocks one", async () => {
    const { runtime } = setup({
      async complete() {
        return JSON.stringify({
          kind: "final",
          outputs: [
            { kind: "generate", targetId: "one", instructions: "first" },
            { kind: "inline", targetId: "forbidden", text: "no", stickerIds: [] },
            { kind: "inline", targetId: "two", text: "kept", stickerIds: ["sticker"] },
          ],
        });
      },
      async *streamText() {
        yield "";
      },
    });
    const result = await runtime.run(spec, {
      ...direct,
      authorizedTargets: ["one", "two"],
      outputMode: "buffered",
    });
    expect(result.outputs.map((o) => [o.targetId, o.status, o.code])).toEqual([
      ["one", "failed", "MODEL_EMPTY_RESPONSE"],
      ["forbidden", "blocked", "AGENT_TARGET_UNAUTHORIZED"],
      ["two", "prepared", undefined],
    ]);
    expect(result.outputs[2]).toMatchObject({ text: "kept", stickerIds: ["sticker"] });
  });

  it("rechecks before streaming and permits repeated buffered reconsideration within the step budget", async () => {
    let decisions = 0;
    let before = 0;
    let after = 0;
    const { runtime } = setup({
      async complete() {
        decisions++;
        return '{"kind":"final","outputs":[{"kind":"generate","targetId":"web","instructions":"reply"}]}';
      },
    });
    const events: RunEvent[] = [];
    await runtime.run(spec, {
      ...direct,
      onEvent(e) {
        events.push(e);
      },
      async beforeFinal() {
        return before++ < 2;
      },
    });
    expect(decisions).toBe(3);
    expect(events.filter((e) => e.type === "output_delta")).toHaveLength(1);
    decisions = 0;
    await runtime.run(spec, {
      ...direct,
      outputMode: "buffered",
      async reconsider() {
        return after++ < 2;
      },
    });
    expect(decisions).toBe(3);
  });

  it("propagates cancellation and deadlines, and records budget exhaustion as failure", async () => {
    const caller = new AbortController();
    const { runtime, repository } = setup({
      async complete(request) {
        return new Promise<string>((_resolve, reject) =>
          request.signal?.addEventListener("abort", () => reject(request.signal?.reason), {
            once: true,
          }),
        );
      },
    });
    const promise = runtime.completeLeaf(
      { id: "cancel" },
      { owner, messages: [], signal: caller.signal },
    );
    await Promise.resolve();
    caller.abort(new Error("cancelled"));
    await expect(promise).rejects.toThrow("cancelled");
    expect(repository.listRuns({ ownerKind: owner.kind, ownerId: owner.id })[0].status).toBe(
      "cancelled",
    );
    await expect(
      runtime.completeLeaf({ id: "deadline", limits: { deadlineMs: 5 } }, { owner, messages: [] }),
    ).rejects.toMatchObject({ code: "AGENT_DEADLINE" });
    expect(repository.listRuns({ ownerKind: owner.kind, ownerId: owner.id })[0].status).toBe(
      "failed",
    );
    const budget = setup();
    await expect(
      budget.runtime.run({ ...spec, limits: { steps: 0 } }, direct),
    ).rejects.toMatchObject({ code: "AGENT_STEP_LIMIT" });
    expect(budget.repository.listRuns({ ownerKind: owner.kind, ownerId: owner.id })[0].status).toBe(
      "failed",
    );
  });

  it("does not reclassify a committed output when cancellation arrives at the commit boundary", async () => {
    const controller = new AbortController();
    const { runtime, repository } = setup({
      async complete() {
        return '{"kind":"final","outputs":[{"kind":"inline","targetId":"web","text":"sent intent","stickerIds":[]}]}';
      },
    });
    const result = await runtime.run(spec, {
      ...direct,
      signal: controller.signal,
      outputMode: "buffered",
      async commitOutputs() {
        controller.abort();
      },
    });
    expect(repository.getRun(result.runId)?.status).toBe("completed");
  });

  it("redacts source-bound snapshots on revocation/expiry while preserving layout and run metadata", async () => {
    const { runtime, repository, h } = setup({
      async complete() {
        return "success";
      },
    });
    await runtime.completeLeaf(
      { id: "expiry" },
      {
        owner,
        messages: [{ role: "user", content: "private text" }],
        sources: [
          { kind: "qq_observation", id: "q", revision: "1", expiresAt: "2099-01-01T00:00:00.000Z" },
          { kind: "memory", id: "m", revision: "1", expiresAt: "2098-01-01T00:00:00.000Z" },
        ],
      },
    );
    const run = repository.listRuns({ ownerKind: owner.kind, ownerId: owner.id })[0];
    expect(repository.getContext(run.steps[0].context)?.expiresAt).toBe("2098-01-01T00:00:00.000Z");
    expect(repository.redactSource("memory", "m")).toBe(1);
    expect(repository.getContext(run.steps[0].context)).toMatchObject({
      status: "revoked",
      messages: null,
    });
    expect(repository.getContext(run.steps[0].context)?.layout).toHaveLength(1);
    expect(JSON.stringify(h.db.query("SELECT * FROM context_snapshots").all())).not.toContain(
      "private text",
    );
    await runtime.completeLeaf(
      { id: "old" },
      {
        owner,
        messages: [{ role: "user", content: "expired text" }],
        sources: [
          {
            kind: "qq_observation",
            id: "old",
            revision: "1",
            expiresAt: "2000-01-01T00:00:00.000Z",
          },
        ],
      },
    );
    const old = repository.listRuns({ ownerKind: owner.kind, ownerId: owner.id })[0];
    expect(repository.getContext(old.steps[0].context)).toMatchObject({
      status: "expired",
      messages: null,
    });
  });

  it("counts context units with the existing UTF8/message-overhead estimator", () => {
    const messages = [
      { role: "system" as const, content: "中文 persona" },
      { role: "user" as const, content: "😀 hello" },
    ];
    expect(inputUnits(messages.map((m) => textMessage(m.role, m.content)))).toBe(
      estimateMessages(messages),
    );
  });

  it("retires interrupted persisted runs once without re-executing their owner jobs", async () => {
    const { runtime, repository } = setup({
      async complete() {
        return "done";
      },
    });
    await runtime.completeLeaf({ id: "finished" }, { owner, messages: [] });
    repository.createRun({
      runId: "interrupted",
      specId: "leaf",
      specVersion: "1",
      owner,
      at: "2026-01-01T00:00:00.000Z",
    });
    repository.setStatus("interrupted", "generating", "2026-01-01T00:00:00.000Z");
    repository.startStep({
      runId: "interrupted",
      stepId: "step",
      stepNo: 1,
      model: "model",
      phase: "leaf",
      at: "2026-01-01T00:00:00.000Z",
      messages: [textMessage("user", "input")],
      sources: [],
    });
    expect(repository.recoverInterrupted("2026-01-02T00:00:00.000Z")).toBe(1);
    expect(repository.getRun("interrupted")).toMatchObject({
      status: "failed",
      errorCode: "AGENT_INTERRUPTED",
      steps: [{ status: "failed", errorCode: "AGENT_INTERRUPTED" }],
    });
    expect(repository.listEvents("interrupted")).toHaveLength(1);
    expect(repository.recoverInterrupted("2026-01-03T00:00:00.000Z")).toBe(0);
    expect(repository.listEvents("interrupted")).toHaveLength(1);
    expect(
      repository
        .listRuns({ ownerKind: owner.kind, ownerId: owner.id })
        .filter((run) => run.status === "completed"),
    ).toHaveLength(1);
  });

  it("preserves separate decision/generation routes, parameters and generation capacity", async () => {
    const { runtime, repository } = setup({
      async complete(request) {
        expect(request.model).toBe("judgement");
        return '{"kind":"final","outputs":[{"kind":"generate","targetId":"web","instructions":"reply"}]}';
      },
      async *streamText(request) {
        expect(request).toMatchObject({ model: "reply", temperature: 0.8, maxTokens: 256 });
        yield "reply";
      },
    });
    const configured = {
      ...spec,
      model: "judgement",
      generation: { model: "reply", temperature: 0.8, maxTokens: 256 },
    };
    const result = await runtime.run(configured, direct);
    expect(repository.getRun(result.runId)?.steps.map((step) => step.model)).toEqual([
      "judgement",
      "reply",
    ]);
    await expect(
      runtime.run(
        { ...configured, generation: { ...configured.generation, inputUnits: 1 } },
        direct,
      ),
    ).rejects.toMatchObject({ code: "AGENT_CONTEXT_LIMIT" });
    await expect(
      runtime.run({ ...configured, limits: { steps: 1 } }, { ...direct, outputMode: "buffered" }),
    ).rejects.toMatchObject({ code: "AGENT_STEP_LIMIT" });
  });

  it("ModelPort preserves the gateway structured-output contract and default model", async () => {
    const { repository } = setup();
    let received: unknown;
    const gateway = {
      config: { model: "default" },
      async complete(request: unknown) {
        received = request;
        return "ok";
      },
    } as unknown as ModelGateway;
    const runtime = createAgentRuntime({ repository, gateway });
    const messages = [{ role: "user", content: "prompt" }];
    await runtime.completeLeaf(
      { id: "adapter", responseSchema: { type: "object" } },
      { owner, messages },
    );
    expect(received).toMatchObject({ messages, responseSchema: { type: "object" } });
    expect(
      repository.listRuns({ ownerKind: owner.kind, ownerId: owner.id })[0].steps[0].model,
    ).toBe("default");
  });
});
