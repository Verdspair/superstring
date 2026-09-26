import { expect, it } from "bun:test";
import {
  AGENT_DECISION_JSON_SCHEMA,
  parseAgentDecision,
  readJsonBody,
} from "../../src/server/agent/agent-specs";

type JsonSchema = {
  type?: string;
  const?: string;
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
  expect(parseAgentDecision(mixed)).toEqual({
    kind: "invoke",
    name: "speech.evaluate",
    arguments: { targetId: "t1" },
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
    name: "speech.evaluate",
    arguments: { targetId: "t1" },
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

it("requests an explicit nullable sticker intent from structured-output providers while accepting legacy omission", () => {
  const schema = AGENT_DECISION_JSON_SCHEMA as JsonSchema;
  const final = schema.oneOf?.find((variant) => variant.properties?.kind?.const === "final");
  const outputs = final?.properties?.outputs?.items?.oneOf ?? [];
  expect(outputs).toHaveLength(2);
  for (const variant of outputs) {
    expect(variant.required).toContain("stickerIds");
    expect(variant.properties?.stickerIds?.anyOf?.some((option) => option.type === "null")).toBe(
      true,
    );
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
