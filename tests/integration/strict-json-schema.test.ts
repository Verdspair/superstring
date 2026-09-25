// 外部模型 API 的严格模式适配（见 `src/server/llm/strict-json-schema.ts`）。
//
// The relay the user registered rejects an optional property outright ("'required' is required to
// be supplied and to be an array including every key in properties. Missing 'reason'."), so the
// external route rewrites the same schema into that dialect: everything required, the previously
// optional ones nullable. These cases pin the rewrite and the fact that it is a pure function —
// the local route's schema is never touched.
import { describe, expect, it } from "bun:test";
import { toStrictRequiredSchema } from "../../src/server/llm/strict-json-schema";
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
