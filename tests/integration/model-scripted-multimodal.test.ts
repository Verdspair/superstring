// T11 Step1 独立可测试设施：scripted model 的原生多模态捕获与同响应 envelope。
// 只测测试夹具本体与既有权威解析器（model-response-envelope）的契约：
// 不接宿主、不做真实模型调用、不读在制产物、不建第二套解析规则。
import { describe, expect, it } from "bun:test";
import type { ModelRequest } from "../../src/server/agent/model-port";
import {
  parseModelEnvelope,
  parseModelScoreEnvelope,
  parseModelTextEnvelope,
} from "../../src/server/agent/model-response-envelope";
import type { ModelTool } from "../../src/server/llm/model-gateway";
import type { ModelMessage } from "../../src/shared/contracts/agent-run";
import {
  decideGenerateMany,
  decideNone,
  rawText,
  say,
  scoreOf,
  scriptedModel,
} from "../harness/model";

const textPart = (text: string) => ({ kind: "text" as const, text });

const imagePart = (sourceId: string) => ({
  kind: "image" as const,
  sourceId,
  revision: "r1",
  mimeType: "image/png",
  sha256: `sha-${sourceId}`,
});

const userMsg = (text: string): ModelMessage => ({ role: "user", content: [textPart(text)] });

const tool: ModelTool = { name: "media.list", description: "列出可见媒体", parameters: {} };

const decisionRequest = (messages: readonly ModelMessage[]): ModelRequest => ({
  messages,
  tools: [tool],
});

/** 决策同响应封装 schema：确有 decision 与 media 两个键。 */
const decisionMediaSchema = {
  type: "object",
  properties: { decision: { type: "object" }, media: { type: "array" } },
} as const;

/** 生成同响应封装 schema：确有 text 与 media 两个键。 */
const textMediaSchema = {
  type: "object",
  properties: { text: { type: "string" }, media: { type: "array" } },
} as const;

/** 评分同响应封装 schema：确有 scoreResult 与 media 两个键。 */
const scoreMediaSchema = {
  type: "object",
  properties: { scoreResult: { type: "object" }, media: { type: "array" } },
} as const;

describe("scriptedModel receivedMessages 原生捕获", () => {
  it("每次调用记录深拷贝的完整消息；事后篡改原始请求不得污染记录", async () => {
    const messages: ModelMessage[] = [
      { role: "system", content: [textPart("决策协议")] },
      { role: "user", content: [textPart("看这张图"), imagePart("img-1")] },
    ];
    const m = scriptedModel([decideNone()]);
    await m.port.complete(decisionRequest(messages));
    expect(m.receivedMessages.length).toBe(1);
    expect(m.receivedMessages[0]?.phase).toBe("next");
    expect(m.receivedMessages[0]?.messages[1]?.content[1]).toEqual(imagePart("img-1"));
    // 事后篡改原始请求（含嵌套对象与替换数组元素）不得污染已捕获的记录。
    const nested = messages[1]?.content[1];
    if (nested?.kind === "image") nested.sourceId = "mutated";
    messages[1] = { role: "user", content: [textPart("被改写")] };
    expect(m.receivedMessages[0]?.messages[1]?.content[1]).toEqual(imagePart("img-1"));
    expect(m.receivedMessages[0]?.messages[1]?.content[0]).toEqual(textPart("看这张图"));
    // 记录里不允许出现字节/base64/URL 形状的图片负载：图片 part 只带来源元数据。
    expect(m.receivedMessages[0]?.messages[1]?.content[1]).not.toHaveProperty("bytes");
    expect(m.receivedMessages[0]?.messages[1]?.content[1]).not.toHaveProperty("url");
  });

  it("按序保留角色与 text/image 片段顺序，calls 记录保 schema/tools/model", async () => {
    const messages: ModelMessage[] = [
      { role: "system", content: [textPart("s")] },
      {
        role: "user",
        content: [textPart("u1"), imagePart("a"), textPart("u2"), imagePart("b")],
      },
      { role: "assistant", content: [textPart("as1")] },
      { role: "user", content: [imagePart("c"), textPart("u3")] },
    ];
    const m = scriptedModel([decideNone()]);
    await m.port.complete({
      messages,
      tools: [tool],
      model: "reply-model",
      responseSchema: { type: "object" },
    });
    const captured = m.receivedMessages[0]?.messages ?? [];
    expect(captured.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
    ]);
    expect(captured[1]?.content.map((part) => part.kind)).toEqual([
      "text",
      "image",
      "text",
      "image",
    ]);
    expect(
      captured[3]?.content.map((part) =>
        part.kind === "image" ? part.sourceId : (part.text ?? part.kind),
      ),
    ).toEqual(["c", "u3"]);
    const call = m.calls[0];
    expect(call?.model).toBe("reply-model");
    expect(call?.tools).toEqual(["media.list"]);
    expect(call?.schema).toBe(true);
    expect(call?.messages).toBe(4);
  });

  it("三类阶段各计一次调用：next（决策）、next（评分）、generate（结构化生成），无重复分类调用", async () => {
    const m = scriptedModel([decideNone(), scoreOf(6), say("正文")]);
    await m.port.complete(decisionRequest([userMsg("x")]));
    await m.port.complete({
      messages: [userMsg("x")],
      responseSchema: { type: "object", properties: { score: { type: "integer" } } },
    });
    await m.port.complete({ messages: [userMsg("x")], responseSchema: textMediaSchema });
    expect(m.calls.map((call) => call.phase)).toEqual(["next", "next", "generate"]);
    expect(m.calls.length).toBe(3);
    expect(m.remaining()).toBe(0);
    expect(m.receivedMessages.map((entry) => entry.phase)).toEqual(["next", "next", "generate"]);
  });

  it("vision 记录保持不变：phase=head=prompt，receivedMessages 记空消息数组", async () => {
    const m = scriptedModel([say("图里的内容")]);
    const out = await m.port.completeMultimodal({
      model: "vision-stub",
      prompt: "描述这张图",
      images: [],
    });
    expect(out).toBe("图里的内容");
    expect(m.calls[0]?.phase).toBe("vision");
    expect(m.calls[0]?.head).toBe("描述这张图");
    expect(m.receivedMessages).toEqual([{ phase: "vision", messages: [] }]);
  });
});

describe("scriptedModel 同响应 envelope（单次消费，解析权威在 parse…）", () => {
  it("schema 确有 decision+media 时包装决策 envelope；队列单次消费，无重复调用", async () => {
    const m = scriptedModel([
      {
        kind: "inline",
        targetId: "t",
        text: "你好",
        media: [{ mediaId: "img-1", category: "expression" }],
      },
    ]);
    const raw = await m.port.complete({
      messages: [userMsg("x")],
      tools: [tool],
      responseSchema: decisionMediaSchema,
    });
    const parsed = parseModelEnvelope(JSON.parse(raw), new Set(["img-1"]));
    expect(parsed.decision).toEqual({
      kind: "final",
      outputs: [{ kind: "inline", targetId: "t", text: "你好", stickerIds: [] }],
    });
    expect(parsed.media).toEqual([{ mediaId: "img-1", category: "expression" }]);
    expect(m.calls.length).toBe(1);
    expect(m.remaining()).toBe(0);
  });

  it("分类不接受伪造 mediaId：由既有 parseModelEnvelope 权威拒绝，夹具不新增规则", async () => {
    const m = scriptedModel([
      {
        kind: "none",
        media: [{ mediaId: "forged", category: "ordinary" }],
      },
    ]);
    const raw = await m.port.complete({
      messages: [userMsg("x")],
      tools: [tool],
      responseSchema: decisionMediaSchema,
    });
    expect(() => parseModelEnvelope(JSON.parse(raw), new Set())).toThrow();
  });

  it("schema 确有 scoreResult+media 时包装评分 envelope；phase 仍记 next，消费一次", async () => {
    const m = scriptedModel([
      {
        kind: "score",
        score: 6,
        reason: "相关",
        media: [{ mediaId: "img-1", category: "ordinary" }],
      },
    ]);
    const raw = await m.port.complete({
      messages: [userMsg("x")],
      responseSchema: scoreMediaSchema,
    });
    expect(m.calls[0]?.phase).toBe("next");
    const parsed = parseModelScoreEnvelope(JSON.parse(raw), new Set(["img-1"]));
    expect(parsed.scoreResult).toEqual({ score: 6, reason: "相关" });
    expect(parsed.media).toEqual([{ mediaId: "img-1", category: "ordinary" }]);
    expect(m.calls.length).toBe(1);
    expect(m.remaining()).toBe(0);
  });

  it("结构化 text+media complete 计 generate（不是 auxiliary），返回 text envelope；onYield 触发一次（无流中段：正文产生后、返回前）", async () => {
    let yields = 0;
    const m = scriptedModel([
      {
        kind: "say",
        text: "草稿正文",
        onYield: () => {
          yields += 1;
        },
        media: [{ mediaId: "img-1", category: "ordinary" }],
      },
    ]);
    const raw = await m.port.complete({
      messages: [userMsg("x")],
      responseSchema: textMediaSchema,
    });
    expect(m.calls.map((call) => call.phase)).toEqual(["generate"]);
    const parsed = parseModelTextEnvelope(JSON.parse(raw), new Set(["img-1"]));
    expect(parsed.text).toBe("草稿正文");
    expect(parsed.media).toEqual([{ mediaId: "img-1", category: "ordinary" }]);
    expect(yields).toBe(1);
    expect(m.remaining()).toBe(0);
  });

  it("schema 声明 media 但步骤未给 media 时输出 []：none/invoke/inline/generate/score/text 不改变本体", async () => {
    const m = scriptedModel([decideNone(), scoreOf(5)]);
    const decision = await m.port.complete({
      messages: [userMsg("x")],
      tools: [tool],
      responseSchema: decisionMediaSchema,
    });
    expect(JSON.parse(decision)).toEqual({ decision: { kind: "none" }, media: [] });
    const score = await m.port.complete({
      messages: [userMsg("x")],
      responseSchema: scoreMediaSchema,
    });
    expect(parseModelScoreEnvelope(JSON.parse(score), new Set()).scoreResult).toEqual({
      score: 5,
      reason: null,
    });
    expect(parseModelScoreEnvelope(JSON.parse(score), new Set()).media).toEqual([]);
    expect(m.calls.map((call) => call.phase)).toEqual(["next", "next"]);
  });

  it("伪造 forged mediaId 的实际返回必须被权威 parser 拒绝（用 parse… 检验 return）", async () => {
    const m = scriptedModel([
      {
        kind: "inline",
        targetId: "t",
        text: "hi",
        media: [{ mediaId: "never-sent", category: "ordinary" }],
      },
    ]);
    const raw = await m.port.complete({
      messages: [userMsg("x")],
      tools: [tool],
      responseSchema: decisionMediaSchema,
    });
    expect(() => parseModelEnvelope(JSON.parse(raw), new Set(["img-1"]))).toThrow();
  });

  it("invoke 步骤过 decision envelope：权威形状 calls:[{name,arguments}] 被既有 parseModelEnvelope 接受，media 精确透传，单次消费", async () => {
    const m = scriptedModel([
      {
        kind: "invoke",
        name: "media.list",
        arguments: { q: 1 },
        media: [{ mediaId: "img-1", category: "ordinary" }],
      },
    ]);
    const raw = await m.port.complete({
      messages: [userMsg("x")],
      tools: [tool],
      responseSchema: decisionMediaSchema,
    });
    const parsed = parseModelEnvelope(JSON.parse(raw), new Set(["img-1"]));
    expect(parsed.decision).toEqual({
      kind: "invoke",
      calls: [{ name: "media.list", arguments: { q: 1 } }],
    });
    expect(parsed.media).toEqual([{ mediaId: "img-1", category: "ordinary" }]);
    expect(m.calls.length).toBe(1);
    expect(m.remaining()).toBe(0);
  });

  it("旧单调用 invoke 形状不经归一直接交 parseModelEnvelope 被权威拒绝（夹具不新增兼容规则）", () => {
    expect(() =>
      parseModelEnvelope(
        {
          decision: { kind: "invoke", name: "media.list", arguments: { q: 1 } },
          media: [],
        },
        new Set(),
      ),
    ).toThrow();
  });

  it("generate_many 过 decision envelope：每目标一份 generate 输出被权威 parser 接受，单次消费", async () => {
    const m = scriptedModel([decideGenerateMany(["t1", "t2"])]);
    const raw = await m.port.complete({
      messages: [userMsg("x")],
      tools: [tool],
      responseSchema: decisionMediaSchema,
    });
    const parsed = parseModelEnvelope(JSON.parse(raw), new Set());
    expect(parsed.decision).toEqual({
      kind: "final",
      outputs: [
        { kind: "generate", targetId: "t1", instructions: "respond", stickerIds: [] },
        { kind: "generate", targetId: "t2", instructions: "respond", stickerIds: [] },
      ],
    });
    expect(parsed.media).toEqual([]);
    expect(m.calls.length).toBe(1);
    expect(m.remaining()).toBe(0);
  });

  it("raw 故障文本逐字输出：三类 envelope schema 都不得包装掩坏形状", async () => {
    const broken = '{"decision":{"kind":"none"';
    const m = scriptedModel([rawText(broken)]);
    const decision = await m.port.complete({
      messages: [userMsg("x")],
      tools: [tool],
      responseSchema: decisionMediaSchema,
    });
    expect(decision).toBe(broken);
    expect(() => parseModelEnvelope(JSON.parse(decision), new Set(["img-1"]))).toThrow();

    const m2 = scriptedModel([rawText("garbage")]);
    const score = await m2.port.complete({
      messages: [userMsg("x")],
      responseSchema: scoreMediaSchema,
    });
    expect(score).toBe("garbage");
    expect(() => parseModelScoreEnvelope(JSON.parse(score), new Set())).toThrow();

    const m3 = scriptedModel([rawText("not-json")]);
    const text = await m3.port.complete({
      messages: [userMsg("x")],
      responseSchema: textMediaSchema,
    });
    expect(text).toBe("not-json");
    expect(() => parseModelTextEnvelope(JSON.parse(text), new Set())).toThrow();
  });
});

describe("scriptedModel 旧行为保留", () => {
  it("决策 schema 无 media 键时不包装：决策仍原样返回", async () => {
    const m = scriptedModel([decideNone()]);
    const raw = await m.port.complete({
      messages: [userMsg("x")],
      tools: [tool],
      responseSchema: { type: "object", properties: { decision: { type: "object" } } },
    });
    expect(JSON.parse(raw)).toEqual({ kind: "none" });
    expect(m.calls[0]?.phase).toBe("next");
  });

  it("辅助调用原义：ids 空答复记 auxiliary，无 say 步骤不打死整轮", async () => {
    const m = scriptedModel([]);
    const raw = await m.port.complete({
      messages: [userMsg("x")],
      responseSchema: { type: "object", properties: { ids: { type: "array" } } },
    });
    expect(raw).toBe('{"ids":[]}');
    expect(m.calls[0]?.phase).toBe("auxiliary");
  });

  it("流式生成保持两段输出、onYield 恰一次（两段之间）", async () => {
    let yields = 0;
    const chunks: string[] = [];
    const m = scriptedModel([
      {
        kind: "say",
        text: "abcdef",
        onYield: () => {
          yields += 1;
        },
      },
    ]);
    for await (const chunk of m.port.streamText({ messages: [userMsg("x")] })) chunks.push(chunk);
    expect(chunks.join("")).toBe("abcdef");
    expect(chunks.length).toBe(2);
    expect(yields).toBe(1);
    expect(m.calls.map((call) => call.phase)).toEqual(["generate"]);
  });

  it("队列原义：push 追加、耗尽与错步保持带码错误", async () => {
    const m = scriptedModel([decideNone()]);
    await m.port.complete(decisionRequest([userMsg("x")]));
    expect(m.remaining()).toBe(0);
    await expect(m.port.complete(decisionRequest([userMsg("x")]))).rejects.toMatchObject({
      code: "HARNESS_SCRIPT_EXHAUSTED",
    });
    m.push([decideNone()]);
    await expect(
      (async () => {
        for await (const _ of m.port.streamText({ messages: [userMsg("x")] })) {
          void _;
        }
      })(),
    ).rejects.toMatchObject({ code: "HARNESS_STEP_MISMATCH" });
  });
});
