import { describe, expect, it } from "vitest";
import type { ModelProviderResponse } from "../../src/shared/contracts/models";
import {
  createProviderEditor,
  providerPayload,
} from "../../src/web/features/models/provider-draft";

const provider: ModelProviderResponse = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Example",
  base_url: "https://example.com/v1",
  has_api_key: true,
  revision: 2,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  models: [{ name: "alias", context_window: 32768 }],
};

describe("model tokenizer draft", () => {
  it("does not inject an encoding or credential into an old declaration", () => {
    const parsed = providerPayload(createProviderEditor(provider));
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error("Invalid fixture");
    expect(parsed.data.models).toEqual(provider.models);
    expect(parsed.data).not.toHaveProperty("api_key");
  });
  it("round-trips encoding independently of capabilities and other fields", () => {
    const model = {
      ...provider.models[0],
      tokenizer_encoding: "o200k_base" as const,
      capabilities: {
        toolCalling: true,
        parallelToolCalls: false,
        codeExecution: false,
        vision: false,
      },
    };
    const editor = createProviderEditor({ ...provider, models: [model] });
    const parsed = providerPayload(editor);
    expect(parsed.success).toBe(true);
    if (!parsed.success) throw new Error("Invalid fixture");
    expect(parsed.data.models).toEqual([model]);
    editor.models[0].tokenizerEncoding = undefined;
    const cleared = providerPayload(editor);
    expect(cleared.success).toBe(true);
    if (!cleared.success) throw new Error("Invalid fixture");
    const savedModels = cleared.data.models;
    if (!savedModels) throw new Error("Missing model list");
    expect(savedModels[0]).not.toHaveProperty("tokenizer_encoding");
    expect(savedModels[0].capabilities).toEqual(model.capabilities);
    expect(savedModels[0].context_window).toBe(32768);
  });
});
