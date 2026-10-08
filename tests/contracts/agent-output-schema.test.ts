import { expect, it } from "bun:test";
import { z } from "zod";
import { SPEECH_REPLY_DESCRIPTION } from "../../src/shared/contracts/agent-action-descriptions";
import {
  AGENT_DECISION_JSON_SCHEMA,
  type InlineOutputDraft,
  InlineOutputDraftSchema,
  parseAgentDecision,
  readJsonBody,
  type SpeechReplyArguments,
  SpeechReplyArgumentsSchema,
} from "../../src/shared/contracts/agent-output";

type JsonSchema = {
  type?: string;
  const?: string;
  description?: string;
  required?: string[];
  oneOf?: JsonSchema[];
  anyOf?: JsonSchema[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
};
it("strips mixed-in native call markers but never loosens the strict decision parse", () => {
  // 观测（issue #10）：正确的决策 JSON 之后跟着一段 DeepSeek 系的原生调用标记，
  // 整段不再可解析。标记是传输层噪音，不是决策内容——剥掉再解析，别的一律不放宽。
  const mixed = [
    '{"kind":"invoke","name":"speech.evaluate","arguments":{"targetId":"t1"}}',
    '<｜DSML｜｜invoke name="speech.evaluate">',
    '<｜DSML｜｜parameter name="targetId" string="true">t1</｜DSML｜｜parameter>',
    "</｜DSML｜｜invoke>",
  ].join("\n");
  // 单调用写法在解析时归一成批量写法（0.4.0 P2）：协议与执行器只见一种形状。
  expect(parseAgentDecision(mixed)).toEqual({
    kind: "invoke",
    calls: [{ name: "speech.evaluate", arguments: { targetId: "t1" } }],
  });
  // 剥离不是放宽：只剩标记、或标记之外还夹着散文，照旧失败（读不出 = 沉默）。
  expect(() => parseAgentDecision('<｜DSML｜｜invoke name="x"></｜DSML｜｜invoke>')).toThrow();
  expect(() => parseAgentDecision('好的，决策如下：{"kind":"none"}')).toThrow();

  // 实测：合法决策 JSON 之后模型自己"接着对话"，编了一串假结果。
  // 只认开头那个完整对象，尾巴截掉；但对象没闭合、或不以 `{` 开头，照旧失败（不猜内容）。
  const runaway = [
    '{"kind":"invoke","name":"speech.evaluate","arguments":{"targetId":"t1"}}',
    "",
    '<system>{"evaluations":[{"targetId":"t1","allowed":true,"score":0.62}]}</system>',
    '<system>{"evaluations":[{"targetId":"t1","allowed":true,"score":0.62}]}</system>',
  ].join("\n");
  expect(parseAgentDecision(runaway)).toEqual({
    kind: "invoke",
    calls: [{ name: "speech.evaluate", arguments: { targetId: "t1" } }],
  });
  expect(() =>
    parseAgentDecision('{"kind":"invoke","name":"speech.evaluate","arguments":{"targetId":"t1"'),
  ).toThrow();
  // 尾巴里出现别的东西（第二个对象、散文）照旧失败——只放过空白与 `<` 起的传输层标记。
  expect(() => parseAgentDecision('{"kind":"none"} 好。')).toThrow();
  expect(() => parseAgentDecision('{"kind":"none"} {"kind":"none"}')).toThrow();
});

it("reads one complete JSON fence as a transport wrapper and still refuses prose", () => {
  // 实测（gemini 系经中转）：摘要模型把 JSON 包在 ```json 围栏里，内容本身正确，压缩却整个失败
  // （先记 AGENT_OUTPUT_INVALID，形状不认时还掉进无码 AGENT_FAILED）。围栏是传输层包装，剥掉再读。
  expect(JSON.parse(readJsonBody(["```json", '{"facts":[]}', "```"].join("\n")))).toEqual({
    facts: [],
  });
  expect(parseAgentDecision(["```json", '{"kind":"none"}', "```"].join("\n"))).toEqual({
    kind: "none",
  });
  expect(JSON.parse(readJsonBody('{"facts":[]}'))).toEqual({ facts: [] });
  // 围栏之外照旧严格：前面带散文、围栏没闭合、对象后面还跟着散文，都读不出来（不猜内容）。
  expect(() => JSON.parse(readJsonBody('好的：\n```json\n{"facts":[]}\n```'))).toThrow();
  expect(() => JSON.parse(readJsonBody('```json\n{"facts":[]}'))).toThrow();
  expect(() => JSON.parse(readJsonBody('{"facts":[]} 好。'))).toThrow();
});

it("skips a leading echo envelope to reach the decision, without loosening the tail rule", () => {
  // 实测（2026-09-29，deepseek-flash 思考模式）：模型先照抄上下文里的数据信封
  // （`{"kind":"action_observation","trust":"data_only",…}`——连 note:"placeholder" 都是它编的），
  // 紧接着才写真正的决策，整段因此解析失败。开头不是决策对象时跳过这些回声，取其后第一个决策对象。
  const echo = '{"kind":"action_observation","trust":"data_only","value":{"note":"placeholder"}}';
  expect(
    parseAgentDecision(
      `${echo}\n{"kind":"invoke","calls":[{"name":"memory.read","arguments":{"offset":0}}]}`,
    ),
  ).toEqual({ kind: "invoke", calls: [{ name: "memory.read", arguments: { offset: 0 } }] });
  expect(parseAgentDecision([echo, "", '{"kind":"none"}'].join("\n"))).toEqual({ kind: "none" });
  // 严格性不变：只有信封（没有决策对象）、或信封之后夹着散文，都读不出（不猜内容）。
  expect(() => parseAgentDecision(echo)).toThrow();
  expect(() => parseAgentDecision(`${echo} 那就先不说了 {"kind":"none"}`)).toThrow();
  // 开头本来就是决策时一切照旧：尾巴出现第二个对象仍然失败（issue #10 的口径没有放松）。
  expect(() => parseAgentDecision('{"kind":"none"} {"kind":"none"}')).toThrow();
  expect(() => parseAgentDecision('{"kind":"none"} {"kind":"action_observation"}')).toThrow();
});

it("accepts an independent non-UUID reply reference on both inline and generated drafts", () => {
  const reference = "-1001234567890";
  for (const draft of [
    { kind: "inline", targetId: "t", text: "quote", replyToMessageId: reference },
    { kind: "generate", targetId: "t", instructions: "answer it", replyToMessageId: reference },
  ]) {
    const decision = parseAgentDecision(JSON.stringify({ kind: "final", outputs: [draft] }));
    expect(decision).toMatchObject({ kind: "final", outputs: [{ replyToMessageId: reference }] });
  }
  expect(() =>
    parseAgentDecision(
      JSON.stringify({
        kind: "final",
        outputs: [{ kind: "inline", targetId: "t", text: "x", replyToMessageId: "" }],
      }),
    ),
  ).toThrow();
});

it("requests an explicit sticker decision from structured providers while accepting legacy omission", () => {
  const schema = AGENT_DECISION_JSON_SCHEMA as JsonSchema;
  const final = schema.oneOf?.find((variant) => variant.properties?.kind?.const === "final");
  const outputs = final?.properties?.outputs?.items?.oneOf ?? [];
  expect(outputs).toHaveLength(2);
  for (const variant of outputs) {
    expect(variant.required).toContain("stickerIds");
    expect(variant.properties?.stickerIds?.anyOf?.some((option) => option.type === "null")).toBe(
      true,
    );
    // 退役"自动补一张"：提示词指向显式选图的工具路径，绝不再暗示宿主会自动挑。
    const description = variant.properties?.stickerIds?.description ?? "";
    expect(description).toContain("sticker.search");
    expect(description.toLowerCase()).not.toContain("auto");
  }
  for (const value of [undefined, null, [], ["disclosed-id"]]) {
    for (const draft of [
      { kind: "inline", text: "answer" },
      { kind: "generate", instructions: "answer" },
    ]) {
      const decision = parseAgentDecision(
        JSON.stringify({
          kind: "final",
          outputs: [
            {
              ...draft,
              targetId: "allowed",
              ...(value === undefined ? {} : { stickerIds: value }),
            },
          ],
        }),
      );
      expect(decision.kind).toBe("final");
    }
  }
});

it("shares one inline draft shape between final outputs and the speech.reply terminal action", () => {
  // final 输出与 speech.reply 参数共用同一个 inline 草稿 schema。
  const draft: InlineOutputDraft = {
    kind: "inline",
    targetId: "allowed",
    text: "back",
    replyToMessageId: "-10001",
    mentionIds: ["10001"],
    stickerIds: [],
  };
  expect(InlineOutputDraftSchema.parse(draft)).toEqual(draft);
  // 引用、艾特、贴图彼此独立；消息 ID 是 platform ID，不要求 UUID，可为负数。
  const quoted = {
    kind: "inline" as const,
    targetId: "t",
    text: "quoted",
    replyToMessageId: "-1001234567890",
  };
  expect(InlineOutputDraftSchema.parse(quoted)).toEqual(quoted);
  const outputVariants = (AGENT_DECISION_JSON_SCHEMA as JsonSchema).oneOf?.find(
    (variant) => variant.properties?.kind?.const === "final",
  )?.properties?.outputs?.items?.oneOf;
  const replyDescription = outputVariants?.find((variant) => variant.properties?.replyToMessageId)
    ?.properties?.replyToMessageId?.description;
  expect(replyDescription).toBe(
    "Disclosed QQ platform message ID to quote; independent of mentions. Host checks scope and availability.",
  );
  expect(InlineOutputDraftSchema.parse({ kind: "inline", targetId: "t", text: "x" })).toEqual({
    kind: "inline",
    targetId: "t",
    text: "x",
  });
  expect(() =>
    InlineOutputDraftSchema.parse({ kind: "inline", targetId: "t", text: "x", mentionIds: [""] }),
  ).toThrow();
  expect(() =>
    InlineOutputDraftSchema.parse({
      kind: "inline",
      targetId: "t",
      text: "x",
      replyToMessageId: "",
    }),
  ).toThrow();
  expect(() =>
    InlineOutputDraftSchema.parse({ kind: "inline", targetId: "t", text: "x", unknown: true }),
  ).toThrow();
  const decision = parseAgentDecision(JSON.stringify({ kind: "final", outputs: [draft] }));
  expect(decision).toEqual({ kind: "final", outputs: [draft] });
});

it("speech.reply carries one or more inline drafts through the same schema", () => {
  // 多项 outputs：每个逻辑目标一项，可覆盖多家。
  const batch: SpeechReplyArguments = {
    outputs: [
      { kind: "inline", targetId: "t1", text: "a" },
      { kind: "inline", targetId: "t2", text: "b", mentionIds: ["10001"], stickerIds: null },
    ],
  };
  expect(SpeechReplyArgumentsSchema.parse(batch)).toEqual(batch);
  // 至少一条；targetId/text 必填。
  expect(() => SpeechReplyArgumentsSchema.parse({ outputs: [] })).toThrow();
  expect(() =>
    SpeechReplyArgumentsSchema.parse({ outputs: [{ kind: "inline", text: "a" }] }),
  ).toThrow();
  // 只接受 inline（正文已就绪）。
  expect(() =>
    SpeechReplyArgumentsSchema.parse({
      outputs: [{ kind: "generate", targetId: "t", instructions: "i" }],
    }),
  ).toThrow();
  // parameters 与 schema 同源；终结动作按写处理。
  expect(SPEECH_REPLY_DESCRIPTION.name).toBe("speech.reply");
  expect(SPEECH_REPLY_DESCRIPTION.effect).toBe("write");
  expect(SPEECH_REPLY_DESCRIPTION.parameters).toEqual(z.toJSONSchema(SpeechReplyArgumentsSchema));
});
