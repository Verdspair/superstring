import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { AgentRuntime, createAgentRuntime } from "../../src/server/agent/agent-runtime";
import type { LeafAgentSpec } from "../../src/server/agent/agent-specs";
import { createImageByteResolver } from "../../src/server/agent/image-byte-resolver";
import type { ModelPort, ModelRequest, TextModelGateway } from "../../src/server/agent/model-port";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import type {
  ModelContent,
  ModelMessage,
  RunEvent,
  RunOwner,
} from "../../src/shared/contracts/agent-run";
import { RunSnapshotSchema } from "../../src/shared/contracts/agent-run";

const handles: ReturnType<typeof openBusinessDb>[] = [];
afterEach(() => {
  for (const h of handles.splice(0)) h.close();
});
const owner: RunOwner = { kind: "qq_group", id: "conv-9", userId: "u1", agentId: "a1" };
const otherOwner: RunOwner = { kind: "web", id: "conv-web" };

function setup(
  model: Partial<ModelPort> = {},
  options: Omit<ConstructorParameters<typeof AgentRuntime>[0], "model" | "repository"> = {},
) {
  const h = openBusinessDb();
  handles.push(h);
  const repository = new AgentRunRepository(h.db);
  const port: ModelPort = {
    async complete() {
      return "leaf-ok";
    },
    async *streamText() {
      yield "unused";
    },
    async completeMultimodal() {
      throw new Error("vision client must not be used by the message leaf");
    },
    ...model,
  };
  return { h, repository, runtime: new AgentRuntime({ ...options, model: port, repository }) };
}

const BYTES = new Uint8Array([5, 6, 7]);
const SHA = createHash("sha256").update(BYTES).digest("hex");
const imagePart: ModelContent = {
  kind: "image",
  sourceId: "asset-1",
  revision: "r7",
  mimeType: "image/png",
  sha256: SHA,
};
const spec: LeafAgentSpec = { id: "score.leaf", model: "score-model" };
const mediaSource = [{ kind: "qq_media" as const, id: "asset-1", revision: "r7" }];

describe("completeMessageLeaf", () => {
  it("persists real run/step and forwards ModelMessage[] with spec fields to ModelPort.complete", async () => {
    const seen: ModelRequest[] = [];
    const { runtime, repository } = setup({
      async complete(request) {
        seen.push(request);
        return "leaf-ok";
      },
    });
    const responseSchema = { type: "object", properties: { score: { type: "number" } } };
    const messages: ModelMessage[] = [
      { role: "system", content: [{ kind: "text", text: "score this" }] },
      { role: "user", content: [{ kind: "text", text: "原始输入" }] },
    ];
    const events: RunEvent[] = [];
    let validated = false;
    await runtime
      .completeMessageLeaf(
        { ...spec, temperature: 0.2, maxTokens: 321, responseSchema },
        {
          owner,
          messages,
          usage: { calls: 0, inputUnits: 0 },
          budget: { maxCalls: 5 },
          validate() {
            validated = true;
          },
          onEvent: (event) => void events.push(event),
        },
      )
      .then((result) => expect(result).toBe("leaf-ok"));
    expect(validated).toBe(true);
    const leafRunId = events[0].runId;
    expect(seen[0]).toMatchObject({
      model: "score-model",
      temperature: 0.2,
      maxTokens: 321,
      responseSchema,
      runId: leafRunId,
      owner,
    });
    expect(seen[0].messages).toEqual(messages);
    expect(seen[0].tools).toBeUndefined();
    const run = repository.listRuns({ ownerKind: owner.kind, ownerId: owner.id })[0];
    expect(RunSnapshotSchema.parse(run)).toMatchObject({
      runId: leafRunId,
      status: "completed",
      specId: "score.leaf",
      owner,
      errorCode: null,
    });
    expect(run.steps).toHaveLength(1);
    expect(run.steps[0]).toMatchObject({
      phase: "leaf",
      status: "completed",
      model: "score-model",
    });
    const stored = repository.getContext(run.steps[0].context);
    expect(stored?.messages).toEqual(messages);
    expect(events.map((event) => event.type)).toEqual(["started", "step", "completed"]);
  });

  it("keeps spec.instructions as the trusted system prefix and preserves caller message order", async () => {
    const { runtime } = setup({
      async complete(request) {
        expect(request.messages).toEqual([
          { role: "system", content: [{ kind: "text", text: "Score strictly." }] },
          { role: "user", content: [{ kind: "text", text: "first" }] },
          { role: "assistant", content: [{ kind: "text", text: "second" }] },
          { role: "user", content: [{ kind: "text", text: "third" }] },
        ]);
        return "ok";
      },
    });
    await expect(
      runtime.completeMessageLeaf(
        { id: "score.leaf", instructions: "Score strictly." },
        {
          owner,
          messages: [
            { role: "user", content: [{ kind: "text", text: "first" }] },
            { role: "assistant", content: [{ kind: "text", text: "second" }] },
            { role: "user", content: [{ kind: "text", text: "third" }] },
          ],
        },
      ),
    ).resolves.toBe("ok");
  });

  it("文字叶子保真实 run/owner 且不需要图片 resolver，从不触 vision client", async () => {
    let multimodalCalls = 0;
    const seen: ModelRequest[] = [];
    const { runtime, repository } = setup({
      async complete(request) {
        seen.push(request);
        return "leaf-ok";
      },
      async completeMultimodal() {
        multimodalCalls += 1;
        return "vision";
      },
    });
    const messages: ModelMessage[] = [
      { role: "user", content: [{ kind: "text", text: "text only" }] },
    ];
    const events: RunEvent[] = [];
    await expect(
      runtime.completeMessageLeaf(spec, {
        owner,
        messages,
        onEvent: (event) => void events.push(event),
      }),
    ).resolves.toBe("leaf-ok");
    expect(multimodalCalls).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0].imageResolver).toBeUndefined();
    expect(seen[0].messages).toEqual(messages);
    const run = repository.listRuns({ ownerKind: owner.kind, ownerId: owner.id })[0];
    expect(RunSnapshotSchema.parse(run)).toMatchObject({
      runId: events[0].runId,
      status: "completed",
      specId: "score.leaf",
      owner,
    });
    expect(events.map((event) => event.type)).toEqual(["started", "step", "completed"]);
  });

  it("image input without a trusted resolver fails closed as CONTEXT_SOURCE_INVALID, not as text", async () => {
    const h = openBusinessDb();
    handles.push(h);
    const repository = new AgentRunRepository(h.db);
    let gatewayCalls = 0;
    const gateway: TextModelGateway = {
      async complete() {
        gatewayCalls += 1;
        return "must not reach the model";
      },
    };
    const runtime = createAgentRuntime({ repository, gateway });
    await expect(
      runtime.completeMessageLeaf(spec, {
        owner,
        messages: [
          {
            role: "user",
            content: [{ kind: "text", text: "look" }, imagePart],
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "CONTEXT_SOURCE_INVALID" });
    expect(gatewayCalls).toBe(0);
    const run = repository.listRuns({ ownerKind: owner.kind, ownerId: owner.id })[0];
    expect(RunSnapshotSchema.parse(run)).toMatchObject({
      status: "failed",
      errorCode: "CONTEXT_SOURCE_INVALID",
    });
    expect(run.steps[0]).toMatchObject({ status: "failed", errorCode: "CONTEXT_SOURCE_INVALID" });
    expect(repository.listEvents(run.runId).at(-1)?.type).toBe("failed");
  });

  it("bindRun re-registers the image under the real leaf runId/owner; the parent-run bare handle stays unresolvable", async () => {
    const resolver = createImageByteResolver();
    // 父 run 的裸句柄：登记在父 runId 下，leaf 不能沿它解析。
    resolver.register({
      runId: "parent-run",
      owner,
      part: imagePart,
      bytes: BYTES,
      sources: mediaSource,
      assertCurrent: () => {},
    });
    const h = openBusinessDb();
    handles.push(h);
    const repository = new AgentRunRepository(h.db);
    const gateway: TextModelGateway = {
      async complete() {
        return "leaf-ok";
      },
    };
    const runtime = createAgentRuntime({ repository, gateway });
    let leafRunId = "";
    await runtime.completeMessageLeaf(spec, {
      owner,
      messages: [
        {
          role: "user",
          content: [{ kind: "text", text: "look" }, imagePart],
        },
      ],
      sources: mediaSource,
      imageResolver: resolver,
      bindRun: (context) => {
        leafRunId = context.runId ?? "";
        resolver.register({
          runId: context.runId ?? "",
          owner: context.owner,
          part: imagePart,
          bytes: BYTES,
          sources: mediaSource,
          assertCurrent: () => {},
        });
      },
    });
    expect(leafRunId).not.toBe("parent-run");
    const signal = new AbortController().signal;
    // leaf 登记在运行中有效，结束后被 finally 释放。
    await expect(
      resolver.resolve({ runId: leafRunId, owner, part: imagePart, signal }),
    ).rejects.toThrow();
    // 父 run 的裸句柄从未被 leaf 解析使用，也未被释放。
    await expect(
      resolver.resolve({ runId: "parent-run", owner, part: imagePart, signal }),
    ).resolves.toMatchObject({ bytes: BYTES });
    const run = repository.listRuns({ ownerKind: owner.kind, ownerId: owner.id })[0];
    expect(run.status).toBe("completed");
  });

  it("leaf called with a resolver but no bindRun cannot resolve via a parent-run bare handle", async () => {
    const resolver = createImageByteResolver();
    // 只登记父 run 的裸句柄；不给 bindRun，leaf 没有任何途径沿它解析。
    resolver.register({
      runId: "parent-run",
      owner,
      part: imagePart,
      bytes: BYTES,
      sources: mediaSource,
      assertCurrent: () => {},
    });
    const h = openBusinessDb();
    handles.push(h);
    const repository = new AgentRunRepository(h.db);
    let gatewayCalls = 0;
    const gateway: TextModelGateway = {
      async complete() {
        gatewayCalls += 1;
        return "must not reach the model";
      },
    };
    // 真实 createModelPort + fake gateway：负例走真实 chat-content 转换路径，不是 fake port。
    const runtime = createAgentRuntime({ repository, gateway });
    await expect(
      runtime.completeMessageLeaf(spec, {
        owner,
        messages: [{ role: "user", content: [{ kind: "text", text: "look" }, imagePart] }],
        sources: mediaSource,
        imageResolver: resolver,
      }),
    ).rejects.toMatchObject({ code: "CONTEXT_SOURCE_INVALID" });
    expect(gatewayCalls).toBe(0);
    const run = repository.listRuns({ ownerKind: owner.kind, ownerId: owner.id })[0];
    expect(RunSnapshotSchema.parse(run)).toMatchObject({
      status: "failed",
      errorCode: "CONTEXT_SOURCE_INVALID",
    });
    // 父 run 的裸句柄不被 leaf 运行消费、也不被 leaf 的 release 触碰，仍可由父侧解析。
    await expect(
      resolver.resolve({
        runId: "parent-run",
        owner,
        part: imagePart,
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ bytes: BYTES });
  });

  it("release after the run touches only the leaf owner record; other owners and the parent run stay resolvable", async () => {
    const resolver = createImageByteResolver();
    resolver.register({
      runId: "parent-run",
      owner,
      part: imagePart,
      bytes: BYTES,
      sources: mediaSource,
      assertCurrent: () => {},
    });
    let leafRunId = "";
    const { runtime } = setup({
      async complete() {
        return "leaf-ok";
      },
    });
    await runtime.completeMessageLeaf(spec, {
      owner,
      messages: [{ role: "user", content: [{ kind: "text", text: "text" }] }],
      imageResolver: resolver,
      bindRun: (context) => {
        leafRunId = context.runId ?? "";
        resolver.register({
          runId: context.runId ?? "",
          owner,
          part: imagePart,
          bytes: BYTES,
          sources: mediaSource,
          assertCurrent: () => {},
        });
        resolver.register({
          runId: context.runId ?? "",
          owner: otherOwner,
          part: imagePart,
          bytes: BYTES,
          sources: mediaSource,
          assertCurrent: () => {},
        });
      },
    });
    const signal = new AbortController().signal;
    // 本 leaf run/owner 的登记已随运行结束释放。
    await expect(
      resolver.resolve({ runId: leafRunId, owner, part: imagePart, signal }),
    ).rejects.toThrow();
    // 同 run 其它 owner 的记录不受释放影响。
    await expect(
      resolver.resolve({ runId: leafRunId, owner: otherOwner, part: imagePart, signal }),
    ).resolves.toMatchObject({ bytes: BYTES });
    // 父 run 句柄完全不受影响。
    await expect(
      resolver.resolve({ runId: "parent-run", owner, part: imagePart, signal }),
    ).resolves.toMatchObject({ bytes: BYTES });
  });

  it("cancellation records a cancelled run/step, emits no completed event, and the finally still releases the leaf registration", async () => {
    const resolver = createImageByteResolver();
    const caller = new AbortController();
    let leafRunId = "";
    // 显式握手：fake complete 报告"已进入"并挂起等待 abort，不用轮询/sleep。
    const entered = Promise.withResolvers<ModelRequest>();
    const cancelReason = Object.assign(new Error("cancelled"), { code: "HOST_CANCELLED" });
    const { runtime, repository } = setup({
      async complete(request) {
        entered.resolve(request);
        return new Promise<string>((_resolve, reject) =>
          request.signal?.addEventListener("abort", () => reject(request.signal?.reason), {
            once: true,
          }),
        );
      },
    });
    const promise = runtime.completeMessageLeaf(
      { ...spec, limits: { deadlineMs: 5000 } },
      {
        owner,
        messages: [{ role: "user", content: [{ kind: "text", text: "slow" }] }],
        signal: caller.signal,
        imageResolver: resolver,
        bindRun: (context) => {
          leafRunId = context.runId ?? "";
          resolver.register({
            runId: context.runId ?? "",
            owner,
            part: imagePart,
            bytes: BYTES,
            sources: mediaSource,
            assertCurrent: () => {},
          });
        },
      },
    );
    await entered.promise;
    caller.abort(cancelReason);
    await expect(promise).rejects.toBe(cancelReason);
    const run = repository.listRuns({ ownerKind: owner.kind, ownerId: owner.id })[0];
    // 取消语义：运行/步骤都是 cancelled，最后事件是 cancelled，无 completed。
    const eventTypes = repository.listEvents(run.runId).map((event) => event.type);
    expect(RunSnapshotSchema.parse(run)).toMatchObject({ status: "cancelled" });
    expect(run.steps[0]).toMatchObject({ status: "cancelled" });
    expect(eventTypes.at(-1)).toBe("cancelled");
    expect(eventTypes).not.toContain("completed");
    await expect(
      resolver.resolve({
        runId: leafRunId,
        owner,
        part: imagePart,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow();
  });

  it("bindRun failing marks failed with zero model steps; validate failure records the domain error code", async () => {
    const bindFailure = setup({
      async complete() {
        return "must not run";
      },
    });
    await expect(
      bindFailure.runtime.completeMessageLeaf(spec, {
        owner,
        messages: [{ role: "user", content: [{ kind: "text", text: "x" }] }],
        bindRun: () => {
          throw new Error("bind exploded");
        },
      }),
    ).rejects.toThrow("bind exploded");
    const bindRun = bindFailure.repository.listRuns({
      ownerKind: owner.kind,
      ownerId: owner.id,
    })[0];
    expect(bindRun.status).toBe("failed");
    expect(bindRun.steps).toHaveLength(0);
    expect(bindFailure.repository.listEvents(bindRun.runId).map((event) => event.type)).toEqual([
      "started",
      "failed",
    ]);

    const validateFailure = setup({
      async complete() {
        return "payload";
      },
    });
    const domainError = Object.assign(new Error("domain validation failed"), {
      code: "DOMAIN_CODE",
    });
    await expect(
      validateFailure.runtime.completeMessageLeaf(spec, {
        owner,
        messages: [{ role: "user", content: [{ kind: "text", text: "x" }] }],
        validate: () => {
          throw domainError;
        },
      }),
    ).rejects.toBe(domainError);
    const validateRun = validateFailure.repository.listRuns({
      ownerKind: owner.kind,
      ownerId: owner.id,
    })[0];
    expect(validateRun.status).toBe("failed");
    expect(validateRun.errorCode).toBe("DOMAIN_CODE");
    expect(validateRun.steps[0]).toMatchObject({ status: "failed", errorCode: "DOMAIN_CODE" });
  });

  it("assertLeaf checkpoint rejections are honored before the model call, after it, and at the late checkpoint", async () => {
    let phase = "before";
    const { runtime, repository } = setup(
      {
        async complete() {
          return "leaf-ok";
        },
      },
      {
        assertLeaf: (_leafOwner, specId) => {
          expect(specId).toBe("score.leaf");
          if (phase === "before")
            throw Object.assign(new Error("capability off"), { code: "CAP_OFF" });
          return () => {
            if (phase === "revoked-later")
              throw Object.assign(new Error("revoked"), { code: "CAP_OFF_LATE" });
          };
        },
      },
    );
    await expect(
      runtime.completeMessageLeaf(spec, {
        owner,
        messages: [{ role: "user", content: [{ kind: "text", text: "x" }] }],
      }),
    ).rejects.toMatchObject({ code: "CAP_OFF" });
    const beforeRun = repository.listRuns({ ownerKind: owner.kind, ownerId: owner.id })[0];
    expect(beforeRun.status).toBe("failed");
    expect(beforeRun.steps).toHaveLength(0);

    phase = "after";
    await expect(
      runtime.completeMessageLeaf(spec, {
        owner,
        messages: [{ role: "user", content: [{ kind: "text", text: "x" }] }],
      }),
    ).resolves.toBe("leaf-ok");
    phase = "revoked-later";
    await expect(
      runtime.completeMessageLeaf(spec, {
        owner,
        messages: [{ role: "user", content: [{ kind: "text", text: "x" }] }],
      }),
    ).rejects.toMatchObject({ code: "CAP_OFF_LATE" });
    const lateRun = repository.listRuns({ ownerKind: owner.kind, ownerId: owner.id })[0];
    expect(lateRun.status).toBe("failed");
    expect(lateRun.errorCode).toBe("CAP_OFF_LATE");
  });

  it("a capability revision advanced off→on mid-model still fails the step via the frozen checkpoint, with no completed event and the resolver released", async () => {
    const resolver = createImageByteResolver();
    let leafRunId = "";
    // 能力纪元在模型飞行中被推进（停用又恢复）：恢复成 on 不等于冻结纪元仍然有效。
    const capability = { on: true, revision: 1 };
    const entered = Promise.withResolvers<void>();
    const { runtime, repository } = setup(
      {
        async complete() {
          entered.resolve();
          await Promise.resolve();
          capability.on = false;
          capability.revision += 1;
          capability.on = true;
          return "leaf-ok";
        },
      },
      {
        assertLeaf: (leafOwner, specId) => {
          expect(leafOwner).toEqual(owner);
          expect(specId).toBe("score.leaf");
          if (!capability.on) throw Object.assign(new Error("capability off"), { code: "CAP_OFF" });
          const captured = capability.revision;
          return () => {
            if (capability.revision !== captured)
              throw Object.assign(new Error("stale epoch"), { code: "CAP_OFF_LATE" });
          };
        },
      },
    );
    const promise = runtime.completeMessageLeaf(spec, {
      owner,
      messages: [{ role: "user", content: [{ kind: "text", text: "x" }] }],
      imageResolver: resolver,
      bindRun: (context) => {
        leafRunId = context.runId ?? "";
        resolver.register({
          runId: context.runId ?? "",
          owner,
          part: imagePart,
          bytes: BYTES,
          sources: mediaSource,
          assertCurrent: () => {},
        });
      },
    });
    await entered.promise;
    await expect(promise).rejects.toMatchObject({ code: "CAP_OFF_LATE" });
    const run = repository.listRuns({ ownerKind: owner.kind, ownerId: owner.id })[0];
    const eventTypes = repository.listEvents(run.runId).map((event) => event.type);
    expect(run.status).toBe("failed");
    expect(run.errorCode).toBe("CAP_OFF_LATE");
    expect(run.steps[0]).toMatchObject({ status: "failed", errorCode: "CAP_OFF_LATE" });
    expect(eventTypes).not.toContain("completed");
    // finally 释放了本 leaf run/owner 的登记。
    await expect(
      resolver.resolve({
        runId: leafRunId,
        owner,
        part: imagePart,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow();
  });

  it("usage accrues on the shared ledger and exceeding the tree budget fails without a model step", async () => {
    const { runtime, repository } = setup({
      async complete() {
        return "leaf-ok";
      },
    });
    const usage = { calls: 0, inputUnits: 0 };
    await runtime.completeMessageLeaf(spec, {
      owner,
      messages: [{ role: "user", content: [{ kind: "text", text: "12345678" }] }],
      usage,
      budget: { maxCalls: 2 },
    });
    expect(usage.calls).toBe(1);
    expect(usage.inputUnits).toBeGreaterThan(0);
    await expect(
      runtime.completeMessageLeaf(spec, {
        owner,
        messages: [{ role: "user", content: [{ kind: "text", text: "12345678" }] }],
        usage,
        budget: { maxCalls: 1 },
      }),
    ).rejects.toMatchObject({ code: "AGENT_BUDGET_EXCEEDED" });
    const budgetRun = repository
      .listRuns({ ownerKind: owner.kind, ownerId: owner.id })
      .filter((run) => run.errorCode === "AGENT_BUDGET_EXCEEDED")[0];
    expect(budgetRun.steps).toHaveLength(0);
  });

  it("records the requested model at step start and rewrites the resolved model when onModelResolved fires", async () => {
    const { runtime } = setup({
      async complete(request) {
        request.onModelResolved?.("resolved-score-model");
        return "leaf-ok";
      },
    });
    const h = handles.at(-1);
    let leafRunId = "";
    const output = await runtime.completeMessageLeaf(
      { ...spec, model: "requested-score-model" },
      {
        owner,
        messages: [{ role: "user", content: [{ kind: "text", text: "x" }] }],
        bindRun: (context) => {
          leafRunId = context.runId ?? "";
        },
      },
    );
    expect(output).toBe("leaf-ok");
    const stepRow = h?.db
      .query("SELECT model, phase, status FROM agent_steps WHERE run_id=?")
      .get(leafRunId) as { model: string; phase: string; status: string } | null;
    expect(stepRow).toMatchObject({
      model: "resolved-score-model",
      phase: "leaf",
      status: "completed",
    });
  });

  it("wire conversion through the real model port turns the registered image into a data URL and keeps text messages intact", async () => {
    const h = openBusinessDb();
    handles.push(h);
    const repository = new AgentRunRepository(h.db);
    const seen: { content: unknown }[] = [];
    const gateway: TextModelGateway = {
      async complete(options) {
        for (const message of options.messages) seen.push({ content: message.content });
        return "wire-ok";
      },
    };
    const runtime = createAgentRuntime({ repository, gateway });
    const resolver = createImageByteResolver();
    let leafRunId = "";
    await runtime.completeMessageLeaf(spec, {
      owner,
      messages: [
        {
          role: "user",
          content: [{ kind: "text", text: "look" }, imagePart],
        },
        { role: "assistant", content: [{ kind: "text", text: "prior" }] },
      ],
      sources: mediaSource,
      imageResolver: resolver,
      bindRun: (context) => {
        leafRunId = context.runId ?? "";
        resolver.register({
          runId: context.runId ?? "",
          owner: context.owner,
          part: imagePart,
          bytes: BYTES,
          sources: mediaSource,
          assertCurrent: () => {},
        });
      },
    });
    expect(seen).toHaveLength(2);
    expect(seen[0].content).toEqual([
      { type: "text", text: "look" },
      {
        type: "image_url",
        image_url: { url: `data:image/png;base64,${Buffer.from(BYTES).toString("base64")}` },
      },
    ]);
    // 无图消息保持字符串内容（既有 text-only 行为）。
    expect(seen[1].content).toBe("prior");
    const run = repository.listRuns({ ownerKind: owner.kind, ownerId: owner.id })[0];
    expect(run).toMatchObject({ runId: leafRunId, status: "completed" });
    expect(run.steps[0]).toMatchObject({ phase: "leaf", status: "completed" });
    const stored = repository.getContext(run.steps[0].context);
    expect(stored?.messages).toEqual([
      {
        role: "user",
        content: [{ kind: "text", text: "look" }, imagePart],
      },
      { role: "assistant", content: [{ kind: "text", text: "prior" }] },
    ]);
    // 受保护快照落的是元数据 JSON：sha256 元数据允许存在，但任何字节形态（bytes/dataURL/base64）
    // 都不得持久化——用真实 protected DB 的 JSON 全文证明，不是对自家常量的空证明。
    const storedJson = h.db
      .query("SELECT protected_messages FROM context_snapshots WHERE step_id=?")
      .get(run.steps[0].context.stepId) as { protected_messages: string | null };
    expect(storedJson.protected_messages).not.toBeNull();
    expect(JSON.parse(storedJson.protected_messages as string)).toEqual(stored?.messages);
    expect(storedJson.protected_messages).toContain(SHA);
    expect(storedJson.protected_messages).not.toContain('"bytes"');
    expect(storedJson.protected_messages).not.toContain("data:image");
    expect(storedJson.protected_messages).not.toContain(Buffer.from(BYTES).toString("base64"));
  });
});
