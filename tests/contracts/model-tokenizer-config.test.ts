import { describe, expect, test } from "bun:test";
import { ModelProviderModelSchema } from "../../src/shared/contracts/models";

describe("explicit model text token encoding", () => {
  const model = { name: "declared-alias", context_window: 32768 };
  test("keeps old declarations unchanged", () => {
    expect(ModelProviderModelSchema.parse(model)).toEqual(model);
  });
  test("accepts only implemented encodings", () => {
    for (const encoding of ["cl100k_base", "o200k_base"] as const)
      expect(
        ModelProviderModelSchema.parse({ ...model, tokenizer_encoding: encoding })
          .tokenizer_encoding,
      ).toBe(encoding);
    expect(
      ModelProviderModelSchema.safeParse({ ...model, tokenizer_encoding: "llama3" }).success,
    ).toBe(false);
  });
});
