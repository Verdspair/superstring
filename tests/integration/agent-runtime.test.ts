import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { z } from "zod";
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

  it("retains invoke arguments as data and inherits parent sources after a context refresh", async () => {
    let step = 0;
    const parent = { kind: "question", id: "old-question", revision: "1" };
    const { runtime, repository } = setup({
      async complete(request) {
        if (++step === 1)
          return JSON.stringify({
            kind: "invoke",
            name: "memory.query",
            arguments: { query: "private query" },
          });
        const observation = request.messages.find(
          (message) =>
            message.role === "user" &&
            message.content.some(
              (part) => part.kind === "text" && part.text.includes("action_observation"),
            ),
        );
        const part = observation?.content[0];
        if (part?.kind !== "text") throw new Error("Missing observation");
        expect(JSON.parse(part.text).value).toMatchObject({
          arguments: { query: "private query" },
          sources: [parent],
        });
        return '{"kind":"none"}';
      },
    });
    const actions = createBuiltInActions({ memory: { query: async () => [] } });
    const result = await runtime.run(
      { ...spec, availableActions: actions.map((action) => action.description) },
      {
        ...direct,
        actions,
        outputMode: "buffered",
        context: {
          async read() {
            return {
              pending: [textMessage("user", step ? "newer question" : "original question")],
              sources: step ? [] : [parent],
            };
          },
        },
      },
    );
    const snapshot = repository.getRun(result.runId);
    const next = snapshot?.steps[1].context;
    if (!next) throw new Error("Missing second step");
    expect(repository.getContext(next)?.sources).toContainEqual(parent);
    expect(JSON.stringify(repository.listEvents(result.runId))).not.toContain("private query");
    repository.redactSource(parent.kind, parent.id, "revoked");
    expect(repository.getContext(next)?.messages).toBeNull();
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

  /**
   * issue #10 的两条边界：①已广告的动作以原生 tools 声明给模型（网关据此发送，本地路由不发送）；
   * ②原生调用映射回来的仍是同一个决策入口，所以"没被广告过的动作"照旧拒绝——引入 tools 不放松授权。
   */
  it("decides on a reply that mixes the decision JSON with native call markers", async () => {
    const actions = createBuiltInActions({
      memory: {
        async query() {
          return [];
        },
      },
    });
    const seen: ModelRequest[] = [];
    const { runtime } = setup({
      async complete(request) {
        seen.push(request);
        if (seen.length === 1)
          return [
            '{"kind":"invoke","name":"memory.query","arguments":{"query":"rule"}}',
            '<｜DSML｜｜invoke name="memory.query">',
            "</｜DSML｜｜invoke>",
          ].join("\n");
        return '{"kind":"final","outputs":[{"kind":"inline","targetId":"web","text":"answer","stickerIds":[]}]}';
      },
    });
    const result = await runtime.run(
      { ...spec, availableActions: actions.map((action) => action.description) },
      // 与 QQ 主动路径一致的缓冲模式：它允许 inline 草稿，正是这条链上出现静默失败的地方。
      { ...direct, outputMode: "buffered", actions },
    );
    // 混排标记只是传输噪音：决策读到了、动作执行了、流程走完。
    expect(result.status).toBe("completed");
    expect(seen).toHaveLength(2);
  });

  /**
   * `AGENT_FAILED` 曾经是死胡同。定下两条边界：
   * ① 记录与 span 只发布抛出点**自己设的** `.code`（如动作层的 STICKER_SEARCH_CONTEXT_LIMIT），
   *    所以无码失败要去看控制台那一行，而不是靠猜消息；
   * ② 看着像码的失败文本**不许**被当成码发布（隐私边界：`runtime-peripheral-observability` 钉着）；
   * ③ 叶子解析器读不出输出记 `AGENT_OUTPUT_INVALID`（"输出不合要求"，不是"决策不合法"）。
   */
  it("publishes only deliberate codes, and labels an unreadable leaf output", async () => {
    const coded = setup({
      async complete() {
        return "payload";
      },
    });
    await expect(
      coded.runtime.completeLeaf(
        { id: "leaf" },
        {
          messages: [{ role: "user", content: "hi" }],
          owner,
          validate: () => {
            throw Object.assign(new Error("贴纸检索超出剩余容量"), {
              code: "STICKER_SEARCH_CONTEXT_LIMIT",
            });
          },
        },
      ),
    ).rejects.toMatchObject({ code: "STICKER_SEARCH_CONTEXT_LIMIT" });
    expect(
      coded.repository.listRuns({ ownerKind: owner.kind, ownerId: owner.id })[0].errorCode,
    ).toBe("STICKER_SEARCH_CONTEXT_LIMIT");

    const lookalike = setup({
      async complete() {
        return "payload";
      },
    });
    await expect(
      lookalike.runtime.completeLeaf(
        { id: "leaf" },
        {
          messages: [{ role: "user", content: "hi" }],
          owner,
          validate: () => {
            throw new Error("NEVER_LOG_SOURCE_OR_MODEL_TEXT");
          },
        },
      ),
    ).rejects.toThrow("NEVER_LOG_SOURCE_OR_MODEL_TEXT");
    expect(
      lookalike.repository.listRuns({ ownerKind: owner.kind, ownerId: owner.id })[0].errorCode,
    ).toBe("AGENT_FAILED");

    const unreadable = setup({
      async complete() {
        return "not json at all";
      },
    });
    await expect(
      unreadable.runtime.completeLeaf(
        { id: "leaf" },
        {
          messages: [{ role: "user", content: "hi" }],
          owner,
          validate: (text) => JSON.parse(text),
        },
      ),
    ).rejects.toBeInstanceOf(SyntaxError);
    expect(
      unreadable.repository.listRuns({ ownerKind: owner.kind, ownerId: owner.id })[0].errorCode,
    ).toBe("AGENT_OUTPUT_INVALID");

    // 形状不对（JSON 读得出、schema 不认）与读不出来是同一件事：实测压缩叶子回 `{"facts":[{},{}]}`
    // 时整个运行掉进无码的 AGENT_FAILED。ZodError 也记 AGENT_OUTPUT_INVALID。
    const schemaInvalid = setup({
      async complete() {
        return '{"facts":[{}]}';
      },
    });
    await expect(
      schemaInvalid.runtime.completeLeaf(
        { id: "leaf" },
        {
          messages: [{ role: "user", content: "hi" }],
          owner,
          validate: (text) =>
            z.strictObject({ facts: z.array(z.string()) }).parse(JSON.parse(text)),
        },
      ),
    ).rejects.toBeInstanceOf(z.ZodError);
    expect(
      schemaInvalid.repository.listRuns({ ownerKind: owner.kind, ownerId: owner.id })[0].errorCode,
    ).toBe("AGENT_OUTPUT_INVALID");
  });

  it("logs what the model actually returned when a decision cannot be read", async () => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(args.map(String).join(" "));
    try {
      const { runtime } = setup({
        async complete() {
          // 抓到的形状：整段只有原生调用标记，没有决策 JSON。
          return '<｜DSML｜｜ calls>\n<｜DSML｜｜ invoke name="speech.evaluate">\n</｜DSML｜｜ invoke>\n</｜DSML｜｜ calls>';
        },
      });
      await expect(runtime.run(spec, direct)).rejects.toMatchObject({
        code: "AGENT_DECISION_INVALID",
      });
    } finally {
      console.warn = original;
    }
    const logged = warnings.join("\n");
    expect(logged).toContain("决策解析失败");
    expect(logged).toContain("speech.evaluate");
  });

  it("declares advertised actions as native tools, and still refuses an action nobody advertised", async () => {
    const seen: ModelRequest[] = [];
    const actions = createBuiltInActions({
      memory: {
        async query() {
          return [];
        },
      },
    });
    const declared = actions.map((action) => action.description);
    const declaredRun = setup({
      async complete(request) {
        seen.push(request);
        return '{"kind":"none"}';
      },
    });
    await declaredRun.runtime.run({ ...spec, availableActions: declared }, { ...direct, actions });
    expect(seen[0]?.tools).toEqual([
      {
        name: "memory.query",
        description: declared[0]?.description,
        parameters: declared[0]?.parameters,
      },
    ]);
    // 叶子任务仍然只用 responseSchema，不声明 tools。
    const leafSeen: ModelRequest[] = [];
    const leaf = setup({
      async complete(request) {
        leafSeen.push(request);
        return '{"ok":true}';
      },
    });
    await leaf.runtime.completeLeaf(
      { id: "leaf", responseSchema: { type: "object" } },
      { messages: [{ role: "user", content: "hi" }], owner },
    );
    expect(leafSeen[0]?.tools).toBeUndefined();

    // ② 网关把原生调用映射成的正是这个形状；名称没被广告过就必须拒绝，且原因落库。
    const refused = setup({
      async complete() {
        return '{"kind":"invoke","name":"shell","arguments":{}}';
      },
    });
    await expect(
      refused.runtime.run({ ...spec, availableActions: declared }, direct),
    ).rejects.toMatchObject({ code: "AGENT_ACTION_UNAVAILABLE" });
    expect(
      refused.repository.listRuns({ ownerKind: owner.kind, ownerId: owner.id })[0].errorCode,
    ).toBe("AGENT_ACTION_UNAVAILABLE");
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
        expect(request.messages[0]?.content).toEqual(
          expect.arrayContaining([
            { kind: "text", text: expect.stringContaining("configured reply persona") },
          ]),
        );
        expect(JSON.stringify(request.messages[0])).not.toContain("decision-only instructions");
        yield "reply";
      },
    });
    const configured = {
      ...spec,
      model: "judgement",
      instructions: "decision-only instructions",
      generation: {
        instructions: "configured reply persona",
        model: "reply",
        temperature: 0.8,
        maxTokens: 256,
      },
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

  it("prepares trusted target-specific generation without replacing shared context or leaking configuration between outputs", async () => {
    const requests: ModelRequest[] = [];
    const { runtime, repository } = setup({
      async complete() {
        return JSON.stringify({
          kind: "final",
          outputs: [
            { kind: "generate", targetId: "alice", instructions: "answer Alice" },
            { kind: "generate", targetId: "bob", instructions: "answer Bob" },
          ],
        });
      },
      async *streamText(request) {
        requests.push(request);
        yield "answer";
      },
    });
    const result = await runtime.run(
      { ...spec, generation: { temperature: 0.4, maxTokens: 512 } },
      {
        ...direct,
        authorizedTargets: ["alice", "bob"],
        outputMode: "buffered",
        async prepareGeneration(draft, input) {
          expect(input.context.messages.at(-1)).toEqual(textMessage("user", "hello"));
          expect(input.outputId).toBeString();
          return {
            instructions: `Trusted host target ${draft.targetId}`,
            model: `${draft.targetId}-reply`,
            ...(draft.targetId === "alice" ? { temperature: 0.7, maxTokens: 256 } : {}),
          };
        },
      },
    );
    expect(
      requests.map((request) => [request.model, request.temperature, request.maxTokens]),
    ).toEqual([
      ["alice-reply", 0.7, 256],
      ["bob-reply", 0.4, 512],
    ]);
    for (const [index, target] of ["alice", "bob"].entries()) {
      expect(JSON.stringify(requests[index].messages[0])).toContain(
        `Trusted host target ${target}`,
      );
      expect(requests[index].messages.at(-1)).toEqual(textMessage("user", "hello"));
    }
    expect(repository.getRun(result.runId)?.steps.map((step) => step.model)).toEqual([
      "chat",
      "alice-reply",
      "bob-reply",
    ]);
  });

  it("keeps other targets when one trusted generation preparation cannot fit its model", async () => {
    const { runtime, repository } = setup({
      async complete() {
        return JSON.stringify({
          kind: "final",
          outputs: [
            { kind: "generate", targetId: "alice", instructions: "answer" },
            { kind: "generate", targetId: "bob", instructions: "answer" },
          ],
        });
      },
    });
    const result = await runtime.run(spec, {
      ...direct,
      authorizedTargets: ["alice", "bob"],
      outputMode: "buffered",
      async prepareGeneration(draft) {
        return { inputUnits: draft.targetId === "alice" ? 1 : 10000 };
      },
    });
    expect(result.outputs).toMatchObject([
      { targetId: "alice", status: "failed", code: "AGENT_CONTEXT_LIMIT" },
      { targetId: "bob", status: "prepared", text: "answer" },
    ]);
    expect(repository.getRun(result.runId)?.status).toBe("completed");
  });

  it("persists the actual trusted generation phase view and charges its final envelope", async () => {
    const source = { kind: "test_source", id: "reply-history", revision: "1" };
    let generated: readonly import("../../src/shared/contracts/agent-run").ModelMessage[] = [];
    const { runtime, repository } = setup({
      async complete(request) {
        expect(JSON.stringify(request.messages)).not.toContain("longer reply history");
        return '{"kind":"final","outputs":[{"kind":"generate","targetId":"web","instructions":"answer"}]}';
      },
      async *streamText(request) {
        generated = request.messages;
        yield "answer";
      },
    });
    const phase = {
      messages: [
        textMessage("system", "unused decision rule"),
        textMessage("user", "longer reply history"),
      ],
      sources: [source],
      units: 0,
    };
    const result = await runtime.run(spec, {
      ...direct,
      async prepareGeneration() {
        return { context: phase, instructions: "trusted reply policy" };
      },
    });
    const step = repository.getRun(result.runId)?.steps.find((step) => step.phase === "generate");
    if (!step) throw new Error("Missing generation step");
    expect(repository.getContext(step.context)).toMatchObject({
      messages: generated,
      sources: [source],
    });
    expect(generated.at(-1)).toEqual(textMessage("user", "longer reply history"));
    expect(JSON.stringify(generated[0])).not.toContain("unused decision rule");
    await expect(
      runtime.run(spec, {
        ...direct,
        async prepareGeneration() {
          return { context: phase, inputUnits: inputUnits(phase.messages) };
        },
      }),
    ).rejects.toMatchObject({ code: "AGENT_CONTEXT_LIMIT" });
  });

  it("lets a buffered channel prepare a sticker-only empty body while Web retains its empty-response contract", async () => {
    const { runtime } = setup({
      async complete() {
        return '{"kind":"final","outputs":[{"kind":"generate","targetId":"web","instructions":""}]}';
      },
      async *streamText() {
        yield "";
      },
    });
    let stagedEmpty = false;
    const result = await runtime.run(
      { ...spec, generation: { allowEmpty: true } },
      {
        ...direct,
        outputMode: "buffered",
        reconsider: async (outputs) => {
          expect(outputs).toHaveLength(1);
          expect(outputs[0]).toMatchObject({ status: "prepared", text: "" });
          stagedEmpty = true;
          return false;
        },
      },
    );
    expect(stagedEmpty).toBe(true);
    expect(result.status).toBe("completed");
    await expect(runtime.run(spec, direct)).rejects.toMatchObject({ code: "MODEL_EMPTY_RESPONSE" });
  });

  it("commits a deliberately suppressed buffered plan as no_output without retry or phantom output IDs", async () => {
    let decisions = 0;
    const { h, runtime, repository } = setup({
      async complete() {
        decisions++;
        return '{"kind":"final","outputs":[{"kind":"generate","targetId":"web","instructions":""}]}';
      },
      async *streamText() {
        yield "";
      },
    });
    h.db.exec("CREATE TABLE test_ack (run_id TEXT PRIMARY KEY)");
    const events: RunEvent[] = [];
    let commits = 0;
    const result = await runtime.run(
      { ...spec, generation: { allowEmpty: true } },
      {
        ...direct,
        outputMode: "buffered",
        async reconsider(outputs) {
          expect(outputs[0]).toMatchObject({ status: "prepared", text: "" });
          return "no_output";
        },
        async commitOutputs(outputs, runId, terminal) {
          commits++;
          expect(outputs).toEqual([]);
          expect(terminal).toMatchObject({ status: "no_output", event: { type: "no_output" } });
          return h.db
            .transaction(() => {
              h.db.query("INSERT INTO test_ack VALUES (?)").run(runId);
              return repository.finishRun(runId, terminal.status, terminal.event, terminal.at);
            })
            .immediate();
        },
        onEvent(event) {
          if (event.type === "no_output") {
            expect(h.db.query("SELECT run_id FROM test_ack").get()).toEqual({
              run_id: event.runId,
            });
            expect(repository.getRun(event.runId)?.status).toBe("no_output");
          }
          events.push(event);
        },
      },
    );
    expect(decisions).toBe(1);
    expect(commits).toBe(1);
    expect(result).toMatchObject({ status: "no_output", outputs: [] });
    expect(repository.getRun(result.runId)).toMatchObject({ status: "no_output", outputs: [] });
    expect(events.filter((event) => event.type === "no_output")).toHaveLength(1);
    expect(events.some((event) => event.type === "completed" || event.type === "failed")).toBe(
      false,
    );
  });

  it("retains per-target blocked outcomes alongside deliverable outputs", async () => {
    const { runtime, repository } = setup({
      async complete() {
        return JSON.stringify({
          kind: "final",
          outputs: [
            { kind: "inline", targetId: "web", text: "", stickerIds: [] },
            { kind: "inline", targetId: "peer", text: "deliverable", stickerIds: [] },
          ],
        });
      },
    });
    const result = await runtime.run(spec, {
      ...direct,
      authorizedTargets: ["web", "peer"],
      outputMode: "buffered",
      async reconsider(outputs) {
        outputs[0].status = "blocked";
        outputs[0].code = "NO_DELIVERABLE_PARTS";
        return false;
      },
    });
    expect(result.status).toBe("completed");
    expect(repository.getRun(result.runId)?.outputs).toMatchObject([
      { targetId: "web", status: "blocked", code: "NO_DELIVERABLE_PARTS" },
      { targetId: "peer", status: "prepared" },
    ]);
  });

  it("cannot suppress an already streamed response as no_output", async () => {
    const { runtime, repository } = setup({
      async complete() {
        return '{"kind":"final","outputs":[{"kind":"generate","targetId":"web","instructions":""}]}';
      },
    });
    let committed = false;
    await expect(
      runtime.run(spec, {
        ...direct,
        async reconsider() {
          return "no_output";
        },
        async commitOutputs() {
          committed = true;
          return undefined;
        },
      }),
    ).rejects.toMatchObject({ code: "AGENT_STREAM_RECONSIDERED" });
    expect(committed).toBe(false);
    expect(repository.listRuns({ ownerKind: owner.kind, ownerId: owner.id })[0].status).toBe(
      "failed",
    );
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
