import { describe, expect, test } from "bun:test";
import { measureContextTokens } from "../../src/server/llm/request-format";
import type { TextTokenCounter } from "../../src/server/llm/text-token-counter";
import { loadTextTokenCounter } from "../../src/server/llm/text-token-counter";
import type { ModelMessage } from "../../src/shared/contracts/agent-run";

/** Records the exact texts counted, so a test can inspect one serialization instead of a total. */
function recordingCounter(base: TextTokenCounter): {
  counter: TextTokenCounter;
  texts: string[];
} {
  const texts: string[] = [];
  return {
    texts,
    counter: {
      encoding: base.encoding,
      count: (text) => {
        texts.push(text);
        return base.count(text);
      },
    },
  };
}

const responseSchema = {
  type: "object",
  properties: { body: { type: "string" } },
  required: ["body"],
  additionalProperties: false,
};

const tools = [
  {
    name: "search_docs",
    description: "Search the document catalog.",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
] as const;

const conversation: ModelMessage[] = [
  { role: "system", content: [{ kind: "text", text: "You are Superstring." }] },
  {
    role: "user",
    content: [
      { kind: "text", text: "first" },
      { kind: "text", text: "second" },
    ],
  },
];

describe("measureContextTokens: serialized chat token estimate", () => {
  test("counts the whole serialized request exactly once, not per fragment", async () => {
    const base = await loadTextTokenCounter("cl100k_base");
    const { counter, texts } = recordingCounter(base);
    const measured = measureContextTokens(conversation, counter);

    expect(texts).toHaveLength(1);
    expect(measured.method).toBe("serialized_chat_token_estimate");
    expect(measured.encoding).toBe("cl100k_base");
    expect(measured.textTokens).toBe(base.count(texts[0]!));

    const fragmentSum = conversation.reduce(
      (sum, message) =>
        sum +
        message.content.reduce(
          (inner, part) => inner + (part.kind === "text" ? base.count(part.text) : 0),
          0,
        ),
      0,
    );
    expect(measured.textTokens).not.toBe(fragmentSum);
  });

  test("serializes response schema and tools once each in their own request fields", async () => {
    const base = await loadTextTokenCounter("o200k_base");
    const { counter, texts } = recordingCounter(base);
    const measured = measureContextTokens(conversation, counter, { responseSchema, tools });

    expect(texts).toHaveLength(1);
    const request = JSON.parse(texts[0]!) as Record<string, any>;
    expect(request.messages).toEqual([
      { role: "system", content: "You are Superstring." },
      { role: "user", content: "firstsecond" },
    ]);
    expect(request.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "superstring_result", strict: true, schema: responseSchema },
    });
    expect(request.tools).toEqual([
      {
        type: "function",
        function: {
          name: "search_docs",
          description: "Search the document catalog.",
          parameters: tools[0]!.parameters,
        },
      },
    ]);
    expect(texts[0]!.split("superstring_result").length - 1).toBe(1);
    expect(texts[0]!.split("search_docs").length - 1).toBe(1);
    expect(measured.textTokens).toBe(base.count(texts[0]!));
  });

  test("reports images as unknown media and keeps source metadata out of the count", async () => {
    const base = await loadTextTokenCounter("cl100k_base");
    const { counter, texts } = recordingCounter(base);
    const measured = measureContextTokens(
      [
        {
          role: "user",
          content: [
            { kind: "text", text: "look at this" },
            {
              kind: "image",
              sourceId: "src-42",
              revision: "r7",
              mimeType: "image/png",
              sha256: "abcdef0123456789",
              width: 800,
              height: 600,
            },
          ],
        },
      ],
      counter,
    );

    expect(measured.mediaState).toBe("unknown");
    expect(texts[0]).not.toContain("src-42");
    expect(texts[0]).not.toContain("abcdef0123456789");
    expect(texts[0]).not.toContain("image/png");
    expect(texts[0]!.includes("base64")).toBe(false);
    expect(measured.textTokens).not.toBe(0);
  });

  test("plain request without options injects no schema or tools", async () => {
    const base = await loadTextTokenCounter("o200k_base");
    const { counter, texts } = recordingCounter(base);
    const measured = measureContextTokens(conversation, counter);

    const request = JSON.parse(texts[0]!) as Record<string, unknown>;
    expect(Object.keys(request)).toEqual(["messages"]);
    expect(measured.mediaState).toBe("none");
  });
});
