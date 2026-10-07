// 最小闭环：
//   1. 无图直连回复保持既有形状（决策→生成，评分不出现）；
//   2. 主动路径评分走原生消息叶子（completeMessageLeaf）：许可通过后生成，calls=3；
//   3. agent-runtime buffered structured-complete hook：宿主声明 responseEnvelope 时一次
//      complete 取 envelope，剥离正文照常提交；streamText 不被调用；phase 记 generate。
import { afterEach, describe, expect, it } from "bun:test";
import { AgentRuntime, type PreparedGeneration } from "../../src/server/agent/agent-runtime";
import { textMessage } from "../../src/server/agent/context-engine";
import type { ModelPort, ModelRequest } from "../../src/server/agent/model-port";
import { AgentRunRepository } from "../../src/server/db/agent-run-repository";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import {
  batchScore,
  decideGenerate,
  decideInline,
  type ScriptedModel,
  say,
  scoreOf,
  scriptedModel,
} from "../harness/model";
import { closeHarnesses, createOneBotHarness, type OneBotHarness } from "../harness/onebot";

afterEach(() => {
  closeHarnesses();
});

it("no-image direct reply keeps the legacy two-call shape end to end", async () => {
  const h = createOneBotHarness({
    model: [decideGenerate("20002"), say("合成回复正文")],
  });
  h.receive({ id: "-101", speaker: "20002", text: "在吗？", addressed: true });
  await h.activate("direct_reply");
  await h.deliver();
  expect(h.model?.calls.map((call) => call.phase)).toEqual(["next", "generate"]);
  expect(h.sent).toHaveLength(1);
  expect(JSON.stringify(h.sent[0]?.message)).toContain("合成回复正文");
});

it("initiative scoring runs as a native-message leaf and a passing licence opens generation", async () => {
  const h = createOneBotHarness({
    accountId: "90001",
    member: "10001",
    initiativeBatchTargetCount: 1,
    initiativeBatchJitterCount: 0,
    model: [],
  });
  h.receive({ id: "-102", speaker: "10001", text: "随便聊聊", groupCard: "阿林" });
  h.advance(31);
  // 阶段一批量评分（首 call，评分叶子，phase 仍 next）→ 回复决策 → 生成：精确三轮，无 auxiliary。
  h.model?.push([
    batchScore([
      { targetId: "10001", score: 6, intent: "想主动接话", sourceSeqs: [h.lastEventSeq] },
    ]),
    decideGenerate("10001", "打算说点什么", []),
    say("主动回复正文"),
  ]);
  await h.activate("chiming_in");
  await h.deliver();
  expect(h.model?.calls.map((call) => call.phase)).toEqual(["next", "next", "generate"]);
  expect(h.model?.calls[0]?.schema).toBe(true);
  expect(h.sent).toHaveLength(1);
  expect(h.model?.receivedMessages[1]?.messages.at(-1)?.content).toEqual(
    expect.arrayContaining([expect.objectContaining({ kind: "text" })]),
  );
});

it("buffered generation with a declared response envelope completes once and submits the stripped body", async () => {
  const handles: ReturnType<typeof openBusinessDb>[] = [];
  const h = openBusinessDb();
  handles.push(h);
  try {
    const repository = new AgentRunRepository(h.db);
    const requests: ModelRequest[] = [];
    let streamed = false;
    const port: ModelPort = {
      async complete(request) {
        requests.push(request);
        if (
          request.responseSchema !== undefined &&
          JSON.stringify(request.responseSchema).includes("decision")
        ) {
          return '{"kind":"final","outputs":[{"kind":"generate","targetId":"web","instructions":"reply"}]}';
        }
        return JSON.stringify({ text: "结构化正文", media: [] });
      },
      async *streamText() {
        streamed = true;
        yield "不该走流式";
      },
      async completeMultimodal() {
        return "";
      },
    };
    const runtime = new AgentRuntime({ model: port, repository });
    const result = await runtime.run(
      {
        id: "main",
        model: "chat",
        instructions: "Persona",
        context: "conversation",
        availableActions: [],
        limits: { steps: 8 },
      },
      {
        owner: { kind: "test_job", id: "job-1", userId: "u", agentId: "a" },
        authorizedTargets: ["web"],
        outputMode: "buffered",
        context: {
          async read() {
            return { pending: [textMessage("user", "hello")] };
          },
        },
        async prepareGeneration(): Promise<PreparedGeneration> {
          return {
            responseEnvelope: {
              responseSchema: {
                type: "object",
                additionalProperties: false,
                required: ["text"],
                properties: { text: { type: "string" }, media: { type: "array" } },
              },
              parse: (raw) => {
                const parsed = JSON.parse(raw) as { text: string };
                return { text: parsed.text };
              },
            },
          };
        },
      },
    );
    expect(result.status).toBe("completed");
    expect(result.outputs[0]).toMatchObject({ status: "prepared", text: "结构化正文" });
    expect(streamed).toBe(false);
    // 两次调用都按各自 phase 记录：决策 next + 结构化生成 generate（不落 auxiliary）。
    expect(repository.getRun(result.runId)?.steps.map((step) => step.phase)).toEqual([
      "next",
      "generate",
    ]);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.responseSchema).toBeDefined();
  } finally {
    for (const handle of handles.splice(0)) handle.close();
  }
});

it("buffered generation without an envelope declaration keeps streaming untouched", async () => {
  const handles: ReturnType<typeof openBusinessDb>[] = [];
  const h = openBusinessDb();
  handles.push(h);
  try {
    const repository = new AgentRunRepository(h.db);
    let completed = false;
    const port: ModelPort = {
      async complete() {
        if (completed) return '{"kind":"none"}';
        completed = true;
        return '{"kind":"final","outputs":[{"kind":"generate","targetId":"web","instructions":"reply"}]}';
      },
      async *streamText() {
        yield "流式正文";
      },
      async completeMultimodal() {
        return "";
      },
    };
    const runtime = new AgentRuntime({ model: port, repository });
    const result = await runtime.run(
      {
        id: "main",
        model: "chat",
        instructions: "Persona",
        context: "conversation",
        availableActions: [],
        limits: { steps: 8 },
      },
      {
        owner: { kind: "test_job", id: "job-2", userId: "u", agentId: "a" },
        authorizedTargets: ["web"],
        outputMode: "buffered",
        context: {
          async read() {
            return { pending: [textMessage("user", "hello")] };
          },
        },
      },
    );
    expect(result.outputs[0]).toMatchObject({ status: "prepared", text: "流式正文" });
  } finally {
    for (const handle of handles.splice(0)) handle.close();
  }
});

// ---- T11 B：native 三相自动图与 Step5a 登记（factory 真实服务 + 合成 bytes 源） ----

import { encodeQqFramePng } from "../../src/server/services/qq-animation-frames";

it("native focus image flows through all three real phases (plan T11 Step2 golden)", async () => {
  const png = encodeQqFramePng(new Uint8Array(8 * 8 * 4).fill(64), 8, 8);
  const h = createOneBotHarness({
    accountId: "90001",
    member: "10001",
    mediaEnabled: true,
    vision: ["图里是一只猫"],
    mergeWindowSeconds: 0,
    mediaInput: { mode: "native" },
    imageBytes: { "synthetic-image": png },
    initiativeBatchTargetCount: 1,
    initiativeBatchJitterCount: 0,
    model: [],
  });
  h.receive({
    id: "-103",
    speaker: "10001",
    text: "这张图片里有什么？",
    groupCard: "阿林",
    personalNickname: "林某",
    image: "synthetic-image",
  });
  h.advance(31);
  // 阶段一批量评分（首 call）→ 回复决策 → 生成：三个真实 phase。
  h.model?.push([
    batchScore([
      {
        targetId: "10001",
        score: 6,
        intent: "回答当前消息的图片问题",
        sourceSeqs: [h.lastEventSeq],
      },
    ]),
    decideGenerate("10001", "回答当前消息的图片问题", []),
    say("合成回复正文"),
  ]);
  await h.activate("chiming_in");
  await h.deliver();
  expect(h.model?.calls.length).toBe(3);
  expect(h.model?.calls.map((call) => call.phase)).toEqual(["next", "next", "generate"]);
  // 三个真实 phase 的原生输入都携带同一张图的 image part（只带来源元数据，无 bytes/base64）。
  const withImage = h.model?.receivedMessages.filter((call) =>
    call.messages.some((message) => message.content.some((part) => part.kind === "image")),
  );
  expect(withImage?.length).toBe(3);
  for (const call of withImage ?? []) {
    for (const message of call.messages) {
      for (const part of message.content) {
        if (part.kind === "image") {
          expect(Object.keys(part)).not.toContain("bytes");
          expect(Object.keys(part)).not.toContain("base64");
        }
      }
    }
  }
  expect(h.sent).toHaveLength(1);
});

it("evaluation stage off keeps decision/generation images but the score leaf sees no native image", async () => {
  const png = encodeQqFramePng(new Uint8Array(8 * 8 * 4).fill(64), 8, 8);
  const h = createOneBotHarness({
    accountId: "90001",
    member: "10001",
    mediaEnabled: true,
    vision: ["图里是一只猫"],
    mergeWindowSeconds: 0,
    mediaInput: { mode: "native", stages: { evaluation: false } },
    imageBytes: { "synthetic-image": png },
    initiativeBatchTargetCount: 1,
    initiativeBatchJitterCount: 0,
    model: [],
  });
  h.receive({
    id: "-104",
    speaker: "10001",
    text: "这张图片里有什么？",
    image: "synthetic-image",
  });
  h.advance(31);
  h.model?.push([
    batchScore([
      {
        targetId: "10001",
        score: 6,
        intent: "回答当前消息的图片问题",
        sourceSeqs: [h.lastEventSeq],
      },
    ]),
    decideGenerate("10001", "回答当前消息的图片问题", []),
    say("合成回复正文"),
  ]);
  await h.activate("chiming_in");
  await h.deliver();
  expect(h.model?.calls.length).toBe(3);
  // 评分叶子（evaluation 相，首 call）关闭上图：该相原生输入无 image part。
  const scoreCall = h.model?.receivedMessages[0];
  expect(scoreCall?.phase).toBe("next");
  expect(
    scoreCall?.messages.some((message) => message.content.some((part) => part.kind === "image")),
  ).toBe(false);
  // 决策与生成的原生输入仍然带图。
  const withImage = h.model?.receivedMessages.filter((call) =>
    call.messages.some((message) => message.content.some((part) => part.kind === "image")),
  );
  expect(withImage?.length).toBe(2);
});

it("cross-leaf handle borrowing is refused while a valid scope re-registration resolves", async () => {
  // Step5a 负测：评分 resolver 只接受本叶子 run 内登记的 part——伪造的跨 run 句柄
  // （partKey 相同但未在本评分 run 登记）在发送边界解析失败，而不是静默换图。
  const png = encodeQqFramePng(new Uint8Array(8 * 8 * 4).fill(64), 8, 8);
  const h = createOneBotHarness({
    accountId: "90001",
    member: "10001",
    mediaEnabled: true,
    vision: ["图里是一只猫"],
    mergeWindowSeconds: 0,
    mediaInput: { mode: "native" },
    imageBytes: { "synthetic-image": png },
    initiativeBatchTargetCount: 1,
    initiativeBatchJitterCount: 0,
    model: [],
  });
  h.receive({
    id: "-105",
    speaker: "10001",
    text: "这张图片里有什么？",
    image: "synthetic-image",
  });
  h.advance(31);
  h.model?.push([
    batchScore([
      {
        targetId: "10001",
        score: 6,
        intent: "回答当前消息的图片问题",
        sourceSeqs: [h.lastEventSeq],
      },
    ]),
    decideGenerate("10001", "回答当前消息的图片问题", []),
    say("合成回复正文"),
  ]);
  await h.activate("chiming_in");
  await h.deliver();
  // 三相全绿本身证明"有效 scope 重登记"（评分叶子从已验证 asset 重登记并成功解析）。
  expect(h.model?.calls.length).toBe(3);
  expect(h.sent).toHaveLength(1);
  // 评分 run 的 resolver 生命周期由 agent-runtime finally 释放：run 结束后同 part 再解析必须拒。
  // （resolver 是 run 内对象；这里断言的等价负测面=评分成功只发生在其自身 run 登记后，
  // 跨 run 借用无入口——resolver 不经宿主暴露给模型或其它 run。）
});

// ---- T11 B 追加强负测：prepare 中段取消（真实 abort 源）与零 cache/publish ----

it("aborted activation writes zero media cache rows and publishes nothing", async () => {
  const png = encodeQqFramePng(new Uint8Array(8 * 8 * 4).fill(64), 8, 8);
  const controller = new AbortController();
  const h = createOneBotHarness({
    accountId: "90001",
    member: "10001",
    mediaEnabled: true,
    vision: ["图里是一只猫"],
    mergeWindowSeconds: 0,
    mediaInput: { mode: "native" },
    imageBytes: { "synthetic-image": png },
    initiativeBatchTargetCount: 1,
    initiativeBatchJitterCount: 0,
    model: {
      // 真实 abort 源：首个模型调用（阶段一批量评分，评分叶子）**返回前**用调用方 signal 中止——
      // 与生产 scheduler 同为 caller-signal 取消，不是测试自造的异常路径。
      async complete(request) {
        if (JSON.stringify(request.responseSchema ?? {}).includes("evaluations")) {
          controller.abort();
          return JSON.stringify({
            evaluations: [{ targetId: "10001", score: 6, intent: "answer", sourceSeqs: [] }],
          });
        }
        throw new Error("HARNESS_STEP_MISMATCH: aborted before reply prepare");
      },
      async *streamText() {
        yield "不该到达";
      },
      async completeMultimodal() {
        return "";
      },
    },
  });
  h.receive({
    id: "-106",
    speaker: "10001",
    text: "这张图片里有什么？",
    image: "synthetic-image",
  });
  const wake = h.wakes.claim({ at: h.now(), leaseMs: 120_000, cause: "chiming_in" });
  if (!wake) throw new Error("wake not ready");
  // 取消不是成功路径：run 以 cancelled 失败/结果结束，绝不 completed。
  let outcome: { status?: string } | null = null;
  let runError: unknown = null;
  try {
    outcome = (await h.host.activate(wake, controller.signal)) as { status?: string } | null;
  } catch (error) {
    runError = error;
  }
  if (runError === null) expect(outcome?.status ?? "cancelled").not.toBe("completed");
  else
    expect(
      ["The operation was aborted.", "HARNESS_FETCH_ABORTED"].some((message) =>
        String((runError as Error).message ?? "").includes(message),
      ),
    ).toBe(true);
  // 中段取消后的发布面：零发送、零出站提交、零分类（envelope/consume 未到达）。
  expect(h.sent).toHaveLength(0);
  expect(h.outbox.list({ conversationId: h.conversationId })).toHaveLength(0);
  expect(h.db.query("SELECT COUNT(*) AS n FROM qq_media_classifications").get()).toEqual({ n: 0 });
});

it("abort before the run reaches prepare writes zero media cache and publishes nothing", async () => {
  const png = encodeQqFramePng(new Uint8Array(8 * 8 * 4).fill(64), 8, 8);
  const controller = new AbortController();
  controller.abort(); // 真实 abort 源：调用方在激活前已取消（scheduler 侧取消）。
  const h = createOneBotHarness({
    accountId: "90001",
    member: "10001",
    mediaEnabled: true,
    vision: ["图里是一只猫"],
    mergeWindowSeconds: 0,
    mediaInput: { mode: "native" },
    imageBytes: { "synthetic-image": png },
    initiativeBatchTargetCount: 1,
    initiativeBatchJitterCount: 0,
    model: [
      batchScore([{ targetId: "10001", score: 6, intent: "answer", sourceSeqs: [] }]),
      decideGenerate("10001", "回答当前消息的图片问题", []),
      say("合成回复正文"),
    ],
  });
  h.receive({
    id: "-107",
    speaker: "10001",
    text: "这张图片里有什么？",
    image: "synthetic-image",
  });
  const wake = h.wakes.claim({ at: h.now(), leaseMs: 120_000, cause: "chiming_in" });
  if (!wake) throw new Error("wake not ready");
  await expect(h.host.activate(wake, controller.signal)).rejects.toThrow();
  // prepare 首检即拒：零 fetch/codec/cache/发布。
  expect(h.db.query("SELECT COUNT(*) AS n FROM qq_media_variants").get()).toEqual({ n: 0 });
  expect(h.db.query("SELECT COUNT(*) AS n FROM qq_media_assets").get()).toEqual({ n: 0 });
  expect(h.db.query("SELECT COUNT(*) AS n FROM qq_media_classifications").get()).toEqual({ n: 0 });
  expect(h.sent).toHaveLength(0);
  expect(h.outbox.list({ conversationId: h.conversationId })).toHaveLength(0);
});

// ---- T11 新小单元：同次分类消费（decision/score/generation envelope）与 Step5a 跨 leaf 伪句柄 ----

it("initiative reply decision envelope classification is consumed into the classification cache", async () => {
  const png = encodeQqFramePng(new Uint8Array(8 * 8 * 4).fill(64), 8, 8);
  const h = createOneBotHarness({
    accountId: "90001",
    member: "10001",
    mediaEnabled: true,
    vision: ["图里是一只猫"],
    mergeWindowSeconds: 0,
    mediaInput: { mode: "native" },
    imageBytes: { "synthetic-image": png },
    initiativeBatchTargetCount: 1,
    initiativeBatchJitterCount: 0,
    model: [],
  });
  h.receive({
    id: "-108",
    speaker: "10001",
    text: "这张图片里有什么？",
    image: "synthetic-image",
  });
  h.advance(31);
  // 首 call 是阶段一批量评分（无 media 面）；unknown 图在回复决策相仍未知 → 决策换 envelope
  // schema，模型分类指向真实发送 mediaId，同次消费落缓存。
  const mediaId = (h.db.query("SELECT id FROM qq_media_notes LIMIT 1").get() as { id: string }).id;
  h.model?.push([
    batchScore([
      {
        targetId: "10001",
        score: 6,
        intent: "回答当前消息的图片问题",
        sourceSeqs: [h.lastEventSeq],
      },
    ]),
    decideGenerate("10001", "回答当前消息的图片问题", [], [{ mediaId, category: "expression" }]),
    say("合成回复正文"),
  ]);
  await h.activate("chiming_in");
  await h.deliver();
  expect(h.model?.calls.length).toBe(3);
  // 分类消费：平台证据为空、模型补判 expression 落缓存（同 (asset,policy) 槽）。
  const rows = h.db.query("SELECT category, evidence FROM qq_media_classifications").all() as {
    category: string;
    evidence: string;
  }[];
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ category: "expression", evidence: "model" });
  expect(h.sent).toHaveLength(1);
});

it("generation envelope classification is consumed in the same call without extra calls", async () => {
  const png = encodeQqFramePng(new Uint8Array(8 * 8 * 4).fill(64), 8, 8);
  const h = createOneBotHarness({
    accountId: "90001",
    member: "10001",
    mediaEnabled: true,
    vision: ["图里是一只猫"],
    mergeWindowSeconds: 0,
    mediaInput: { mode: "native" },
    imageBytes: { "synthetic-image": png },
    initiativeBatchTargetCount: 1,
    initiativeBatchJitterCount: 0,
    model: [],
  });
  h.receive({
    id: "-109",
    speaker: "10001",
    text: "这张图片里有什么？",
    image: "synthetic-image",
  });
  h.advance(31);
  const mediaId = (h.db.query("SELECT id FROM qq_media_notes LIMIT 1").get() as { id: string }).id;
  // 决策相不分类（空 media）→ 生成相 unknown 仍在 → 生成走 envelope，say 步带分类。
  h.model?.push([
    batchScore([
      {
        targetId: "10001",
        score: 6,
        intent: "回答当前消息的图片问题",
        sourceSeqs: [h.lastEventSeq],
      },
    ]),
    decideGenerate("10001", "回答当前消息的图片问题", []),
    say("合成回复正文", undefined, [{ mediaId, category: "ordinary" }]),
  ]);
  await h.activate("chiming_in");
  await h.deliver();
  // 评分/决策/生成精确三次：同次分类不新增第 4 次调用。
  expect(h.model?.calls.length).toBe(3);
  const rows = h.db.query("SELECT category, evidence FROM qq_media_classifications").all() as {
    category: string;
    evidence: string;
  }[];
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ category: "ordinary", evidence: "model" });
  expect(h.sent).toHaveLength(1);
});

it("a handle registered under another run cannot be resolved by the score leaf resolver", async () => {
  // Step5a 负测（与 variant mismatch 不可互换）：跨 leaf/run 伪句柄在 resolver 层拒绝。
  const { createImageByteResolver } = await import("../../src/server/agent/image-byte-resolver");
  const resolver = createImageByteResolver();
  const owner = { kind: "qq_binding", id: "b1", userId: "u", agentId: "a" };
  const part = {
    kind: "image" as const,
    sourceId: "m1",
    revision: "r1",
    mimeType: "image/png",
    sha256: "sha",
  };
  resolver.register({
    runId: "run-A",
    owner,
    part,
    bytes: new Uint8Array([1, 2, 3]),
    sources: [],
    assertCurrent: () => {},
  });
  // 本 run/owner 正常解析。
  await expect(
    resolver.resolve({ runId: "run-A", owner, part, signal: new AbortController().signal }),
  ).resolves.toBeTruthy();
  // 跨 run 伪句柄：同 part 元数据、不同 runId —— 拒绝，不静默换图。
  await expect(
    resolver.resolve({ runId: "run-B", owner, part, signal: new AbortController().signal }),
  ).rejects.toThrow();
});

// ---- T11-D：resolved 真源消费 / classificationPolicy 透传 / 真中段 abort / digest paired ----

it("mid-fetch abort writes zero cache rows while the paired un-aborted run publishes", async () => {
  const png = encodeQqFramePng(new Uint8Array(8 * 8 * 4).fill(64), 8, 8);
  // 对照侧：同一流程不取消 → 正常发布（paired 的"允许发布"侧）。
  const ok = createOneBotHarness({
    accountId: "90001",
    member: "10001",
    mediaEnabled: true,
    vision: ["图里是一只猫"],
    mergeWindowSeconds: 0,
    mediaInput: { mode: "native" },
    imageBytes: { "synthetic-image": png },
    initiativeBatchTargetCount: 1,
    initiativeBatchJitterCount: 0,
    model: [
      batchScore([{ targetId: "10001", score: 6, intent: "answer", sourceSeqs: [] }]),
      decideGenerate("10001", "回答当前消息的图片问题", []),
      say("合成回复正文"),
    ],
  });
  ok.receive({
    id: "-110",
    speaker: "10001",
    text: "这张图片里有什么？",
    image: "synthetic-image",
  });
  ok.advance(31);
  await ok.activate("chiming_in");
  await ok.deliver();
  expect(ok.sent).toHaveLength(1);
  ok.close();

  // 取消侧：真实 AbortController + 受控 fetch 门（fetch pending 中段取消，非 sleep 假中段）。
  const controller = new AbortController();
  const h = createOneBotHarness({
    accountId: "90001",
    member: "10001",
    mediaEnabled: true,
    vision: ["图里是一只猫"],
    mergeWindowSeconds: 0,
    mediaInput: { mode: "native" },
    imageBytes: { "synthetic-image": png },
    fetchHook: async () => {
      // 受控 Promise：fetch pending 中，从事件循环下一拍用调用方 AbortController 中止
      // （真实取消源），service 的 throwIfAborted 在 fetch 返回边界触发 → 写事务前退出。
      await new Promise<void>((resolve) => {
        setTimeout(() => {
          controller.abort();
          resolve();
        }, 0);
      });
      if (controller.signal.aborted) throw new Error("HARNESS_FETCH_ABORTED");
    },
    initiativeBatchTargetCount: 1,
    initiativeBatchJitterCount: 0,
    model: [
      batchScore([{ targetId: "10001", score: 6, intent: "answer", sourceSeqs: [] }]),
      decideGenerate("10001", "回答当前消息的图片问题", []),
      say("合成回复正文"),
    ],
  });
  h.receive({ id: "-111", speaker: "10001", text: "这张图片里有什么？", image: "synthetic-image" });
  h.advance(31);
  const wake = h.wakes.claim({ at: h.now(), leaseMs: 120_000, cause: "chiming_in" });
  if (!wake) throw new Error("wake not ready");
  let midRunError: unknown = null;
  try {
    // 阶段一批量评分相 prepare 的 fetch 门已触发并挂起 → 首 call 边界即中段取消。
    await h.host.activate(wake, controller.signal);
  } catch (error) {
    midRunError = error;
  }
  expect(midRunError !== null || h.sent.length === 0).toBe(true);
  // 中段取消：零缓存行、零发布。
  expect(h.db.query("SELECT COUNT(*) AS n FROM qq_media_assets").get()).toEqual({ n: 0 });
  expect(h.db.query("SELECT COUNT(*) AS n FROM qq_media_variants").get()).toEqual({ n: 0 });
  expect(h.db.query("SELECT COUNT(*) AS n FROM qq_media_classifications").get()).toEqual({ n: 0 });
  expect(h.sent).toHaveLength(0);
  expect(h.outbox.list({ conversationId: h.conversationId })).toHaveLength(0);
  h.close();
});

it("same material keeps identical scoring input; mode change changes it (paired digest proxy)", async () => {
  const png = encodeQqFramePng(new Uint8Array(8 * 8 * 4).fill(64), 8, 8);
  // digest 输入的宿主可观测代理：阶段一批量评分（首 call）消息剥去 per-run 身份
  // （mediaId/sourceId/revision）后比较——同材料同模式结构逐字段一致；模式变化改变结构
  // （native 图 part ↔ description notes）。评分本身是首个模型调用，不再有"先写意图再评分"。
  // （stateDigest 本体含每消息身份修订，跨夹具不可逐字节相等；同轮内命中由宿主 licenses 语义保证。）
  // 端口**刻意不含 completeMultimodal**：脚本端口自带该方法会顶掉夹具的默认视觉桩
  // （tests/harness/onebot.ts），description 侧的视觉叶子就会去消费一个不存在的 vision
  // 步骤而失败——描述模式于是一条 baseline 读取真实失败，主动媒体闸按 §7.1 挡住发言，
  // 夹具在到达"两侧材料不同"的断言前就炸了。文字调用照常走脚本，视觉由真实叶子＋
  // 默认桩服务（同一 seed 材料，故同模式两次必须逐字节相等）。
  const build = (mediaInput: { mode: "native" } | { mode: "description" }) => {
    const scripted = scriptedModel([
      batchScore([{ targetId: "10001", score: 6, intent: "看图说话", sourceSeqs: [] }]),
      decideGenerate("10001", "打算说点什么", []),
      say("合成回复正文"),
    ]);
    const harness = createOneBotHarness({
      accountId: "90001",
      member: "10001",
      mediaEnabled: true,
      vision: ["图里是一只猫"],
      mergeWindowSeconds: 0,
      mediaInput,
      imageBytes: { "synthetic-image": png },
      initiativeBatchTargetCount: 1,
      initiativeBatchJitterCount: 0,
      model: {
        complete: (request) => scripted.port.complete(request),
        streamText: (request) => scripted.port.streamText(request),
      },
    });
    return { harness, scripted };
  };
  const scoreInputSnapshot = (scripted: ReturnType<typeof scriptedModel>) =>
    JSON.stringify(scripted.receivedMessages[0]?.messages ?? [], (key, value) =>
      key === "sourceId" || key === "revision" ? "<id>" : value,
    ).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<id>");
  // 同材料同模式（两次独立夹具、同一输入）：评分材料（digest 输入的宿主可观测代理）逐字节一致。
  const a = build({ mode: "native" });
  a.harness.receive({
    id: "-112",
    speaker: "10001",
    text: "这张图片里有什么？",
    image: "synthetic-image",
  });
  a.harness.advance(31);
  await a.harness.activate("chiming_in");
  const snapshotA = scoreInputSnapshot(a.scripted);
  a.harness.close();
  const b = build({ mode: "native" });
  b.harness.receive({
    id: "-112",
    speaker: "10001",
    text: "这张图片里有什么？",
    image: "synthetic-image",
  });
  b.harness.advance(31);
  await b.harness.activate("chiming_in");
  const snapshotA2 = scoreInputSnapshot(b.scripted);
  expect(snapshotA2).toBe(snapshotA);
  b.harness.close();
  // 模式变化（native→description）：actualMode/notes 路径不同 → 评分材料不同（配对不等侧）。
  const c = build({ mode: "description" });
  c.harness.receive({
    id: "-112",
    speaker: "10001",
    text: "这张图片里有什么？",
    image: "synthetic-image",
  });
  c.harness.advance(31);
  await c.harness.activate("chiming_in");
  const snapshotB = scoreInputSnapshot(c.scripted);
  // 强负：不等侧必须真的读过图（视觉叶子一次、baseline 任务 succeeded）——否则
  // "材料不同"可能只是"什么都没读到"，那种差异证明不了模式真的换了路径。
  expect(c.harness.visionCalls).toHaveLength(1);
  expect(c.harness.db.query("SELECT status, note FROM qq_media_read_tasks").all()).toEqual([
    { status: "succeeded", note: "图里是一只猫" },
  ]);
  expect(snapshotB).not.toBe(snapshotA);
  c.harness.close();
});
it("decision envelope classification is consumed with the resolved model name", async () => {
  const png = encodeQqFramePng(new Uint8Array(8 * 8 * 4).fill(64), 8, 8);
  const h = createOneBotHarness({
    accountId: "90001",
    member: "10001",
    mediaEnabled: true,
    vision: ["图里是一只猫"],
    mergeWindowSeconds: 0,
    mediaInput: { mode: "native" },
    imageBytes: { "synthetic-image": png },
    model: [],
  });
  h.receive({
    id: "-113",
    speaker: "10001",
    addressed: true,
    text: "这张图片里有什么？",
    image: "synthetic-image",
  });
  h.advance(31);
  const mediaId = (h.db.query("SELECT id FROM qq_media_notes LIMIT 1").get() as { id: string }).id;
  // 决策步（首个 next）带分类（envelope schema 命中）→ consume 用 decision 相 resolved
  // （direct 路径无评分）；生成相因分类回读得 ordinary → 无 unknown → 正常流式。
  h.model?.push([
    decideGenerate("10001", "回答当前消息的图片问题", [], [{ mediaId, category: "ordinary" }]),
    say("图片里是猫"),
  ]);
  await h.activate("direct_reply");
  await h.deliver();
  const rows = h.db
    .query("SELECT model_name, category, evidence FROM qq_media_classifications")
    .all() as { model_name: string; category: string; evidence: string }[];
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ category: "ordinary", evidence: "model" });
  // 槽键 = 决策相 resolved（harness 回写 request.model=决策模型名），不是其它 requested 串。
  expect(rows[0]?.model_name).toBe("reply-model");
  expect(h.model?.calls.length).toBe(2);
  expect(h.sent).toHaveLength(1);
});

it("requested model different from resolved is not used for classification (no resolved, no write)", async () => {
  const png = encodeQqFramePng(new Uint8Array(8 * 8 * 4).fill(64), 8, 8);
  const h = createOneBotHarness({
    accountId: "90001",
    member: "10001",
    mediaEnabled: true,
    vision: ["图里是一只猫"],
    mergeWindowSeconds: 0,
    mediaInput: { mode: "native" },
    imageBytes: { "synthetic-image": png },
    // 判定模型与运行模型不同名的负测面：槽键必须记 resolved（judge-model），
    // requested 侧任何其它字符串不得命中/写入。
    judgementModelName: "judge-model",
    model: [decideGenerate("10001", "回答当前消息的图片问题", [])],
  });
  h.receive({ id: "-114", speaker: "10001", text: "这张图片里有什么？", image: "synthetic-image" });
  h.advance(31);
  const mediaId = (h.db.query("SELECT id FROM qq_media_notes LIMIT 1").get() as { id: string }).id;
  h.model?.push([scoreOf(6, undefined, [{ mediaId, category: "ordinary" }]), say("正文")]);
  await h.activate("chiming_in");
  const rows = h.db.query("SELECT model_name FROM qq_media_classifications").all() as {
    model_name: string;
  }[];
  for (const row of rows) expect(row.model_name).toBe("judge-model");
});

// ---- T11 final exit coverage（gf 收口：原 Exit 只缺覆盖，不新增阶段/产品功能） ----
//
// 私聊整链最小补盖：private native direct／private initiative（私聊主动＝真实 idle_topic
// 扫描路径）／private description direct／private media disabled direct／群聊评分门槛
// score 5 与 6 参数对照。既有 helper 公开接口照用（native focus golden 同款）：
// 不用 TextEncoder 冒图、不手写 SQL task/proof/wake、不加 harness 开关、
// 不改 capacity/steps/方案默认（门槛沿用默认 initiative_min_score=6）。
describe("T11 final exit coverage", () => {
  /** 规格 §7.2 唯一可靠的平台表情证据形态：三键同现且均为非空 string（不往 DB 塞 category）。 */
  const MARKET_FACE_HINT = {
    emoji_id: "00abc123",
    emoji_package_id: "8",
    summary: "[萌宠]",
  } as const;

  interface WireImage {
    readonly mediaId: string;
    readonly revision: string;
    readonly sha256: string;
  }

  /** 局部文字 port 夹具的 h.model 是 null：消息快照按来源取（scripted 自带 receivedMessages）。 */
  type WireSource = OneBotHarness | ScriptedModel;

  const receivedOf = (source: WireSource) =>
    "receivedMessages" in source ? source.receivedMessages : (source.model?.receivedMessages ?? []);

  /** 某次调用输入里的全部 image part（模型可见面：只有来源元数据，无 bytes/base64）。 */
  const wireImages = (source: WireSource, index: number): WireImage[] =>
    (receivedOf(source)[index]?.messages ?? []).flatMap((message) =>
      message.content.flatMap((part) =>
        part.kind === "image"
          ? [
              {
                mediaId: String(part.sourceId),
                revision: String(part.revision),
                sha256: String(part.sha256),
              },
            ]
          : [],
      ),
    );

  /** 某次调用输入的全文拼接（request 正文保留面的断言）。 */
  const callText = (source: WireSource, index: number): string =>
    (receivedOf(source)[index]?.messages ?? [])
      .flatMap((message) =>
        message.content.flatMap((part) => (part.kind === "text" ? [part.text] : [])),
      )
      .join("\n");

  it("private native direct keeps two phases without a scoring leaf and the same image media identity", async () => {
    const png = encodeQqFramePng(new Uint8Array(8 * 8 * 4).fill(64), 8, 8);
    const h = createOneBotHarness({
      kind: "private",
      accountId: "90001",
      peerId: "20002",
      mediaEnabled: true,
      mergeWindowSeconds: 0,
      mediaInput: { mode: "native" },
      imageBytes: { "synthetic-image": png },
      model: [decideGenerate("20002", "回答当前消息的图片问题", []), say("合成回复正文")],
    });
    h.receive({
      id: "-201",
      text: "这张图片里有什么？",
      image: "synthetic-image",
      imageHint: { ...MARKET_FACE_HINT },
    });
    await h.activate("direct_reply");
    await h.deliver();
    // direct 不评分：精确两相（决策→生成），没有第二个 next（评分叶子）。
    expect(h.model?.calls.map((call) => call.phase)).toEqual(["next", "generate"]);
    // 两相原生输入都带同一张图的同一 media 身份（mediaId/revision/sha 逐字段相等）。
    const decisionImages = wireImages(h, 0);
    expect(decisionImages).toHaveLength(1);
    expect(wireImages(h, 1)).toEqual(decisionImages);
    expect(h.sent).toHaveLength(1);
    expect(JSON.stringify(h.sent[0]?.message)).toContain("合成回复正文");
  });

  it("private initiative runs the real idle_topic scan and scoring without an automatic focus image", async () => {
    const png = encodeQqFramePng(new Uint8Array(8 * 8 * 4).fill(64), 8, 8);
    const h = createOneBotHarness({
      kind: "private",
      accountId: "90001",
      peerId: "20002",
      mediaEnabled: true,
      mergeWindowSeconds: 0,
      mediaInput: { mode: "native" },
      imageBytes: { "synthetic-image": png },
      // 私聊入站恒映射 direct_reply（真实产品语义）；关掉该方案的 direct_reply 触发后，
      // 主动机会走真实 idle_topic 扫描（15 分钟静默门槛，advance 16 分钟后 sweep 排程）。
      // 不把私聊三相强塞 direct。
      triggers: { direct_reply: false },
      model: [],
    });
    h.receive({
      id: "-202",
      text: "这张图片里有什么？",
      image: "synthetic-image",
      imageHint: { ...MARKET_FACE_HINT },
    });
    h.advance(16 * 60);
    const sweep = h.sweep();
    expect(sweep.scheduled).toHaveLength(1);
    // 阶段一批量评分（首 call，评分叶子；idle_topic 面向整间会话，targetId 取 peerId）→
    // 回复首 call 直接出正文：精确两相（§2.5 精简，非固定三次）。
    h.model?.push([
      batchScore([
        { targetId: "20002", score: 6, intent: "冷场想开个话题", sourceSeqs: [h.lastEventSeq] },
      ]),
      decideInline("20002", "主动回复正文"),
    ]);
    await h.activate("idle_topic");
    await h.deliver();
    expect(h.model?.calls.map((call) => call.phase)).toEqual(["next", "next"]);
    expect(h.model?.calls[0]?.schema).toBe(true);
    // idle_topic 没有"应回应消息"（§7.1）：图材料真实在同一 scope（media note 已登记），
    // 但不自动上图——两相 wire 零 image part，不是把 direct 的焦点图强搬过来。
    expect((h.db.query("SELECT COUNT(*) AS n FROM qq_media_notes").get() as { n: number }).n).toBe(
      1,
    );
    expect(wireImages(h, 0)).toHaveLength(0);
    expect(wireImages(h, 1)).toHaveLength(0);
    expect(h.sent).toHaveLength(1);
  });

  it("private description direct reads the real vision leaf once and keeps note and text in the request body", async () => {
    const png = encodeQqFramePng(new Uint8Array(8 * 8 * 4).fill(64), 8, 8);
    const scripted = scriptedModel([
      decideGenerate("20002", "回答当前消息的图片问题", []),
      say("合成回复正文"),
    ]);
    const h = createOneBotHarness({
      kind: "private",
      accountId: "90001",
      peerId: "20002",
      mediaEnabled: true,
      vision: ["图里是一只猫"],
      mergeWindowSeconds: 0,
      mediaInput: { mode: "description" },
      imageBytes: { "synthetic-image": png },
      // 局部文字 port（刻意不含 completeMultimodal）：视觉答复留给 harness 真实视觉桩，
      // 数组完整 port 会顶掉默认桩吞掉视觉答复（既有坑）。
      model: {
        complete: (request) => scripted.port.complete(request),
        streamText: (request) => scripted.port.streamText(request),
      },
    });
    h.receive({ id: "-203", text: "这张图片里有什么？", image: "synthetic-image" });
    await h.activate("direct_reply");
    await h.deliver();
    // 图真实存在且被真实视觉叶子成功读过恰一次（描述成功）。
    expect(h.visionCalls).toHaveLength(1);
    expect(h.db.query("SELECT status, note FROM qq_media_read_tasks").all()).toEqual([
      { status: "succeeded", note: "图里是一只猫" },
    ]);
    // description 模式不上画面：模型输入零 image part；描述文本与消息正文都进生成请求。
    expect(wireImages(scripted, 0)).toHaveLength(0);
    expect(wireImages(scripted, 1)).toHaveLength(0);
    expect(callText(scripted, 1)).toContain("图里是一只猫");
    expect(callText(scripted, 1)).toContain("这张图片里有什么？");
    expect(h.sent).toHaveLength(1);
    expect(JSON.stringify(h.sent[0]?.message)).toContain("合成回复正文");
  });

  it("private media disabled direct sees zero vision and zero image parts while text body and reply stay real", async () => {
    const h = createOneBotHarness({
      kind: "private",
      accountId: "90001",
      peerId: "20002",
      mergeWindowSeconds: 0,
      // 显式关闭媒体能力；即使已配置视觉答复与字节，也不得读取或发送图像。
      mediaEnabled: false,
      vision: ["不应读取的合成描述"],
      mediaInput: { mode: "native" },
      imageBytes: { "synthetic-image": encodeQqFramePng(new Uint8Array(8 * 8 * 4).fill(64), 8, 8) },
      model: [decideGenerate("20002", "回答当前消息", []), say("合成回复正文")],
    });
    h.receive({ id: "-204", text: "这张图片里有什么？", image: "synthetic-image" });
    await h.activate("direct_reply");
    await h.deliver();
    // 零视觉调用、模型输入零 image part（入站 wire 带图也不准备）。
    expect(h.visionCalls).toHaveLength(0);
    expect(wireImages(h, 0)).toHaveLength(0);
    expect(wireImages(h, 1)).toHaveLength(0);
    // request 正文保留：消息文本仍在决策与生成输入里。
    expect(callText(h, 0)).toContain("这张图片里有什么？");
    expect(callText(h, 1)).toContain("这张图片里有什么？");
    expect(h.sent).toHaveLength(1);
    expect(JSON.stringify(h.sent[0]?.message)).toContain("合成回复正文");
  });

  it("group initiative scoring at the default threshold: score 5 stays truly silent while score 6 sends once", async () => {
    const png = encodeQqFramePng(new Uint8Array(8 * 8 * 4).fill(64), 8, 8);
    // 参数对照：图／关系材料相同 scope，两个夹具脚本仅评分一步不同；
    // 门槛沿用方案默认 initiative_min_score=6（不改 default）；计数门槛局部置 1/0 让单条消息成批。
    const build = () =>
      createOneBotHarness({
        accountId: "90001",
        member: "10001",
        mediaEnabled: true,
        mergeWindowSeconds: 0,
        mediaInput: { mode: "native" },
        imageBytes: { "synthetic-image": png },
        initiativeBatchTargetCount: 1,
        initiativeBatchJitterCount: 0,
        model: [],
      });
    const receiveFocus = (harness: OneBotHarness, id: string, score: number) => {
      harness.receive({
        id,
        speaker: "10001",
        text: "这张图片里有什么？",
        image: "synthetic-image",
        imageHint: { ...MARKET_FACE_HINT },
      });
      harness.advance(31);
      harness.model?.push([
        batchScore([
          {
            targetId: "10001",
            score,
            intent: "回答当前消息的图片问题",
            sourceSeqs: [harness.lastEventSeq],
          },
        ]),
        decideGenerate("10001", "回答当前消息的图片问题", []),
        say("合成回复正文"),
      ]);
    };
    // score 5 < 默认门槛 6：真实无输出——评分叶子已真实跑过（不是 none 伪静默），但零回复、
    // 零发送；脚本里的决策/生成步原样剩下（remaining=2 证明没被消耗）。
    const quiet = build();
    receiveFocus(quiet, "-205", 5);
    const blocked = await quiet.activate("chiming_in");
    expect((blocked as { status?: string } | null)?.status).toBe("no_output");
    expect(quiet.model?.calls.map((call) => call.phase)).toEqual(["next"]);
    // 评分叶子（evaluation 相，首 call）带图；低于门槛不派发回复。
    expect(wireImages(quiet, 0)).toHaveLength(1);
    expect(quiet.model?.calls.every((call) => call.phase !== "generate")).toBe(true);
    expect(quiet.model?.remaining()).toBe(2);
    expect(quiet.sent).toHaveLength(0);
    quiet.close();
    // score 6 达默认门槛：真生成、恰一发送，三相计数源＝calls。
    const loud = build();
    receiveFocus(loud, "-206", 6);
    await loud.activate("chiming_in");
    await loud.deliver();
    expect(loud.model?.calls.length).toBe(3);
    expect(loud.model?.calls.map((call) => call.phase)).toEqual(["next", "next", "generate"]);
    const loudEvaluationImages = wireImages(loud, 0);
    expect(loudEvaluationImages).toHaveLength(1);
    expect(wireImages(loud, 1)).toEqual(loudEvaluationImages);
    expect(wireImages(loud, 2)).toEqual(loudEvaluationImages);
    expect(loud.sent).toHaveLength(1);
  });
});
