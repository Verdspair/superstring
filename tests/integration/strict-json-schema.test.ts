// 外部模型 API 的严格模式适配（见 `src/server/llm/strict-json-schema.ts`）。
//
// The relay the user registered rejects an optional property outright ("'required' is required to
// be supplied and to be an array including every key in properties. Missing 'reason'."), so the
// external route rewrites the same schema into that dialect: everything required, the previously
// optional ones nullable. These cases pin the rewrite and the fact that it is a pure function —
// the local route's schema is never touched.
import { describe, expect, it } from "bun:test";
import { AGENT_DECISION_JSON_SCHEMA } from "../../src/server/agent/agent-specs";
import {
  rememberStructuredOutput,
  strictSchemaAccepted,
  structuredOutputStart,
  toStrictRequiredSchema,
} from "../../src/server/llm/strict-json-schema";
import { QQ_JUDGEMENT_RESPONSE_SCHEMA } from "../../src/server/services/qq-prompt-contract";

describe("外部 provider 的严格 JSON schema 适配", () => {
  it("把可选属性改成必填且可空，其他一字不动", () => {
    const before = JSON.parse(JSON.stringify(QQ_JUDGEMENT_RESPONSE_SCHEMA));
    const after = toStrictRequiredSchema(QQ_JUDGEMENT_RESPONSE_SCHEMA) as {
      required: string[];
      properties: Record<string, { type: unknown; maxLength?: number }>;
      additionalProperties: boolean;
    };
    expect(after.required).toEqual(["score", "reason"]);
    expect(after.properties.score.type).toBe("integer");
    expect(after.properties.reason.type).toEqual(["string", "null"]);
    expect(after.properties.reason.maxLength).toBe(200);
    expect(after.additionalProperties).toBe(false);
    // Pure: the frozen schema the local route sends is untouched.
    expect(QQ_JUDGEMENT_RESPONSE_SCHEMA).toEqual(before);
    expect(QQ_JUDGEMENT_RESPONSE_SCHEMA.required).toEqual(["score"]);
  });

  it("递归到嵌套对象与数组元素，并保留原本就必填的字段", () => {
    const source = {
      type: "object",
      additionalProperties: false,
      required: ["items"],
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["name"],
            properties: { name: { type: "string" }, note: { type: "string" } },
          },
        },
      },
    };
    const after = toStrictRequiredSchema(source) as {
      required: string[];
      properties: {
        items: { items: { required: string[]; properties: Record<string, { type: unknown }> } };
      };
    };
    expect(after.required).toEqual(["items"]);
    expect(after.properties.items.items.required).toEqual(["name", "note"]);
    expect(after.properties.items.items.properties.name.type).toBe("string");
    expect(after.properties.items.items.properties.note.type).toEqual(["string", "null"]);
  });

  it("遇到没有 type 的节点不发明类型，原样保留", () => {
    const source = {
      type: "object",
      additionalProperties: false,
      properties: { mode: { enum: ["a", "b"] } },
    };
    const after = toStrictRequiredSchema(source) as {
      required: string[];
      properties: { mode: { enum: string[] } };
    };
    expect(after.required).toEqual(["mode"]);
    expect(after.properties.mode).toEqual({ enum: ["a", "b"] });
  });
});

// 用户的云端 provider 按 OpenAI 严格模式校验：`oneOf` 一律不收，整单 400
// （"Invalid schema for response_format 'superstring_result': In context=(), 'oneOf' is not
// permitted."，2026-09-26）。这些用例钉住"哪些形状会被跳过"和"跳过时从哪一档起步"。
describe("严格模式不收的 schema 形状（云端 oneOf 400）", () => {
  it("根或嵌套的 oneOf 判为不兼容，普通对象判为兼容", () => {
    expect(
      strictSchemaAccepted({
        type: "object",
        additionalProperties: false,
        required: ["a"],
        properties: { a: { type: "string" } },
      }),
    ).toBe(true);
    expect(strictSchemaAccepted({ oneOf: [{ type: "object" }, { type: "object" }] })).toBe(false);
    expect(
      strictSchemaAccepted({
        type: "object",
        additionalProperties: false,
        required: ["out"],
        properties: { out: { type: "array", items: { oneOf: [{ type: "string" }] } } },
      }),
    ).toBe(false);
  });

  it("属性名恰好叫 oneOf 不算关键字，也不误伤 $defs 里的判别联合", () => {
    expect(
      strictSchemaAccepted({
        type: "object",
        additionalProperties: false,
        required: ["oneOf"],
        properties: { oneOf: { type: "string" } },
      }),
    ).toBe(true);
    expect(
      strictSchemaAccepted({
        type: "object",
        additionalProperties: false,
        required: ["value"],
        properties: { value: { $ref: "#/$defs/decision" } },
        $defs: { decision: { oneOf: [{ type: "object" }, { type: "object" }] } },
      }),
    ).toBe(false);
  });

  it("两个真实形状：判断 schema 兼容，Agent 决策 schema（判别联合）不兼容", () => {
    expect(strictSchemaAccepted(QQ_JUDGEMENT_RESPONSE_SCHEMA)).toBe(true);
    expect(strictSchemaAccepted(AGENT_DECISION_JSON_SCHEMA)).toBe(false);
  });

  it("起档：兼容时仍是 json_schema，不兼容时直接 json_object；已记住的档优先", () => {
    const key = "strict-start-fixture|model";
    expect(structuredOutputStart(key, true)).toBe("json_schema");
    expect(structuredOutputStart(key, false)).toBe("json_object");
    // 记住的结论来自实测，优先于形状判断（也不会因为"跳过"而被写脏）。
    rememberStructuredOutput(key, "none");
    expect(structuredOutputStart(key, true)).toBe("none");
    expect(structuredOutputStart(key, false)).toBe("none");
  });
});
