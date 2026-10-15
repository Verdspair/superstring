import { describe, expect, test } from "bun:test";
import { loadTextTokenCounter } from "../../src/server/llm/text-token-counter";

const examples = [
  { text: "", cl100k_base: 0, o200k_base: 0 },
  { text: "hello world", cl100k_base: 2, o200k_base: 2 },
  { text: "你好", cl100k_base: 2, o200k_base: 1 },
  { text: "😀", cl100k_base: 2, o200k_base: 1 },
  { text: "\0", cl100k_base: 1, o200k_base: 1 },
  { text: "<|endoftext|>", cl100k_base: 7, o200k_base: 7 },
];

for (const encoding of ["cl100k_base", "o200k_base"] as const) {
  describe(`whole plain-text tokens: ${encoding}`, () => {
    test("matches fixed ordinary-text counts", async () => {
      const counter = await loadTextTokenCounter(encoding);
      expect(counter.encoding).toBe(encoding);
      for (const example of examples) {
        expect(counter.count(example.text)).toBe(example[encoding]);
      }
    });

    test("agrees with encode for the same explicit encoding and ordinary-text options", async () => {
      const counter = await loadTextTokenCounter(encoding);
      const tokenizer =
        encoding === "cl100k_base"
          ? await import("gpt-tokenizer/encoding/cl100k_base")
          : await import("gpt-tokenizer/encoding/o200k_base");
      for (const example of examples) {
        expect(counter.count(example.text)).toBe(
          tokenizer.encode(example.text, { disallowedSpecial: new Set<string>() }).length,
        );
      }
    });

    test("counts the whole text rather than adding fragment counts", async () => {
      const counter = await loadTextTokenCounter(encoding);
      expect(counter.count("ab")).toBe(1);
      expect(counter.count("a") + counter.count("b")).toBe(2);
    });
  });
}

const variedTexts = [
  "__proto__ constructor prototype",
  "\r\n \t\n",
  "😀é中文 e\u0301",
  "\ud800",
  "\udc00",
  "<|im_start|><|endoftext|>",
  Array.from({ length: 256 }, (_, index) => String.fromCharCode(index)).join(""),
];
let seed = 1357911;
const units = [
  "中",
  "文",
  "a",
  "Z",
  "é",
  "😀",
  "\0",
  "\r",
  "\n",
  "\t",
  " ",
  "123",
  "\u0301",
  "𠮷",
  "\ud800",
  "\udc00",
];
for (let index = 0; index < 64; index++) {
  let text = "";
  for (let part = 0; part < 32; part++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    text += units[seed % units.length];
  }
  variedTexts.push(text);
}

for (const encoding of ["cl100k_base", "o200k_base"] as const) {
  test(`preserves ordinary Unicode and byte coverage for ${encoding}`, async () => {
    const counter = await loadTextTokenCounter(encoding);
    const tokenizer =
      encoding === "cl100k_base"
        ? await import("gpt-tokenizer/encoding/cl100k_base")
        : await import("gpt-tokenizer/encoding/o200k_base");
    tokenizer.setMergeCacheSize(0);
    for (const text of variedTexts)
      expect(counter.count(text)).toBe(
        tokenizer.encode(text, { disallowedSpecial: new Set<string>() }).length,
      );
  });
}
