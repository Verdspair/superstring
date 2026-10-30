import { describe, expect, it } from "bun:test";
import { CreateAgentRequestSchema, newAgentDefaults } from "../../src/shared/contracts/agent";
import { resolveMemoryReadSettings } from "../../src/shared/contracts/memory";
import { P5ConfigSchema } from "../../src/shared/contracts/models";

describe("active memory read settings", () => {
  it("writes the single fresh allowance without exposing tier identity", () => {
    const p5 = newAgentDefaults().p5_config;
    expect(p5.memory_read).toEqual({ enabled: true, max_bytes: 8192 });
    expect(resolveMemoryReadSettings(p5)).toEqual({
      enabled: true,
      maxBytes: 8192,
      candidateLimit: 120,
      maxEntries: 16,
    });
  });
  it("decodes legacy off and small allowances without rewriting unselected values", () => {
    const p5 = P5ConfigSchema.parse({
      retrieval_mode: "conservative",
      retrieval_presets: {
        conservative: {
          candidate_limit: 3,
          max_entries: 2,
          max_tokens: 71,
          relevance_instruction: "x",
        },
      },
    });
    const before = JSON.stringify(p5);
    expect(resolveMemoryReadSettings(p5)).toEqual({
      enabled: true,
      maxBytes: 71,
      candidateLimit: 3,
      maxEntries: 2,
    });
    expect(JSON.stringify(p5)).toBe(before);
    expect(resolveMemoryReadSettings({ ...p5, retrieval_mode: "off" }).enabled).toBe(false);
    expect(
      resolveMemoryReadSettings({ ...p5, memory_read: { enabled: false, max_bytes: 42 } }),
    ).toEqual({ enabled: false, maxBytes: 42, candidateLimit: 3, maxEntries: 2 });
  });
  it("folds historic full modes at the storage boundary and rejects invalid active settings", () => {
    for (const retrieval_mode of ["full_catalog", "full_body"] as const) {
      const p5 = P5ConfigSchema.parse({ retrieval_mode });
      expect(resolveMemoryReadSettings(p5)).toEqual({
        enabled: true,
        maxBytes: 8192,
        candidateLimit: 120,
        maxEntries: 16,
      });
      expect(p5.retrieval_mode).toBe(retrieval_mode);
    }
    expect(P5ConfigSchema.safeParse({ memory_read: { enabled: true, max_bytes: 0 } }).success).toBe(
      false,
    );
    expect(
      P5ConfigSchema.safeParse({ memory_read: { enabled: true, max_bytes: 8192, mode: "broad" } })
        .success,
    ).toBe(false);
  });

  it("respects every explicit legacy create shape while fresh/context-only requests use the single default", () => {
    const create = (p5_config?: Record<string, unknown>) =>
      CreateAgentRequestSchema.parse({
        name: "test",
        model_name: "synthetic",
        ...(p5_config === undefined ? {} : { p5_config }),
      }).p5_config;
    for (const input of [undefined, {}, { recent_turns: 7 }]) {
      const p5 = create(input);
      expect(p5.memory_read).toEqual({ enabled: true, max_bytes: 8192 });
    }
    const small = {
      candidate_limit: 5,
      max_entries: 2,
      max_tokens: 79,
      relevance_instruction: "x",
    };
    const presetOnly = create({ retrieval_presets: { broad: small } });
    expect(presetOnly.memory_read).toBeUndefined();
    expect(resolveMemoryReadSettings(presetOnly)).toEqual({
      enabled: true,
      maxBytes: 79,
      candidateLimit: 5,
      maxEntries: 2,
    });
    expect(resolveMemoryReadSettings(create({ retrieval_mode: "off" })).enabled).toBe(false);
    expect(
      resolveMemoryReadSettings(
        create({ retrieval_mode: "broad", retrieval_presets: { broad: small } }),
      ).maxBytes,
    ).toBe(79);
    const explicit = create({
      retrieval_mode: "off",
      retrieval_presets: { broad: small },
      memory_read: { enabled: true, max_bytes: 33 },
    });
    expect(resolveMemoryReadSettings(explicit)).toEqual({
      enabled: true,
      maxBytes: 33,
      candidateLimit: 30,
      maxEntries: 6,
    });
    expect(explicit.retrieval_presets.broad).toEqual(small);
  });
});
