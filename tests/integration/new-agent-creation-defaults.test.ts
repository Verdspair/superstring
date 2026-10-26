import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { DEFAULT_AGENT_ID, ensureDefaults } from "../../src/server/db/repositories";
import * as schema from "../../src/server/db/schema";
import {
  AgentConfigSchema,
  CreateAgentRequestSchema,
  DEFAULT_BROAD_PRESET,
  DEFAULT_CONSERVATIVE_PRESET,
  DEFAULT_STANDARD_PRESET,
  newAgentDefaults,
  P5ConfigSchema,
} from "../../src/shared/contracts";
import { cloneBusinessDb } from "../harness/business-db";

describe("New Agent Creation Defaults (Backend & Contracts)", () => {
  it("newAgentDefaults factory returns canonical non-prompt baseline values", () => {
    const defaults1 = newAgentDefaults();
    expect(defaults1.temperature).toBe(1);
    expect(defaults1.persona_intensity).toBe(100);
    expect(defaults1.is_active).toBe(true);

    const p5 = defaults1.p5_config;
    expect(p5.context_window).toBeNull();
    expect(p5.max_output_tokens).toBe(32768);
    expect(p5.safety_margin_ratio).toBe(0.1);
    expect(p5.compression_enabled).toBe(true);
    expect(p5.compression_trigger_ratio).toBe(0.8);
    expect(p5.recent_turns).toBe(200);
    expect(p5.summary_target_tokens).toBe(2048);
    expect(p5.summary_max_tokens).toBe(32768);
    expect(p5.summary_read_max_tokens).toBeUndefined();
    expect(p5.retrieval_mode).toBe("full_catalog");
    expect(p5.auxiliary_timeout_seconds).toBe(900);
    expect(p5.max_catalog_batches).toBe(100);
    expect(p5.catalog_batch_size).toBe(30);
    expect(p5.allocation).toEqual({ mode: "auto" });
    expect(p5.auxiliary_allocation).toBeUndefined();

    // Retrieval presets match standard constants
    expect(p5.retrieval_presets.conservative).toEqual(DEFAULT_CONSERVATIVE_PRESET);
    expect(p5.retrieval_presets.standard).toEqual(DEFAULT_STANDARD_PRESET);
    expect(p5.retrieval_presets.broad).toEqual(DEFAULT_BROAD_PRESET);
  });

  it("newAgentDefaults returns a fresh deep object on every call", () => {
    const a = newAgentDefaults();
    const b = newAgentDefaults();
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    expect(a.p5_config).not.toBe(b.p5_config);
    expect(a.p5_config.retrieval_presets).not.toBe(b.p5_config.retrieval_presets);

    // Mutating a does not touch b
    a.p5_config.recent_turns = 999;
    a.temperature = 0.2;
    expect(b.p5_config.recent_turns).toBe(200);
    expect(b.temperature).toBe(1);
  });

  it("CreateAgentRequestSchema defaults to canonical creation baseline when omitted", () => {
    const parsed = CreateAgentRequestSchema.safeParse({
      name: "新助手",
      model_name: "test-model",
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    expect(parsed.data.temperature).toBe(1);
    expect(parsed.data.persona_intensity).toBe(100);
    expect(parsed.data.is_active).toBe(true);
    expect(parsed.data.p5_config.max_output_tokens).toBe(32768);
    expect(parsed.data.p5_config.recent_turns).toBe(200);
    expect(parsed.data.p5_config.summary_max_tokens).toBe(32768);
    expect(parsed.data.p5_config.retrieval_mode).toBe("full_catalog");
    expect(parsed.data.p5_config.allocation).toEqual({ mode: "auto" });
  });

  it("CreateAgentRequestSchema merges partial p5_config over creation defaults", () => {
    const parsed = CreateAgentRequestSchema.safeParse({
      name: "自定义P5助手",
      model_name: "test-model",
      p5_config: {
        recent_turns: 42,
        allocation: { mode: "fixed" },
      },
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    expect(parsed.data.p5_config.recent_turns).toBe(42);
    expect(parsed.data.p5_config.allocation).toEqual({ mode: "fixed" });
    // Other fields stay at new baseline
    expect(parsed.data.p5_config.max_output_tokens).toBe(32768);
    expect(parsed.data.p5_config.retrieval_mode).toBe("full_catalog");
  });

  it("CreateAgentRequestSchema rejects invalid p5_config shape before merge", () => {
    expect(
      CreateAgentRequestSchema.safeParse({
        name: "非法空值",
        model_name: "test-model",
        p5_config: null,
      }).success,
    ).toBe(false);

    expect(
      CreateAgentRequestSchema.safeParse({
        name: "非法1",
        model_name: "test-model",
        p5_config: "not-an-object",
      }).success,
    ).toBe(false);

    expect(
      CreateAgentRequestSchema.safeParse({
        name: "非法2",
        model_name: "test-model",
        p5_config: 12345,
      }).success,
    ).toBe(false);

    expect(
      CreateAgentRequestSchema.safeParse({
        name: "非法3",
        model_name: "test-model",
        p5_config: [1, 2, 3],
      }).success,
    ).toBe(false);

    expect(
      CreateAgentRequestSchema.safeParse({
        name: "未知字段",
        model_name: "test-model",
        p5_config: { unknown_setting: true },
      }).success,
    ).toBe(false);
  });

  it("preserves legacy schemas and read fallbacks unchanged", () => {
    // AgentConfigSchema read/update fallback remains 0.7 and old P5 defaults
    const agentConfig = AgentConfigSchema.parse({
      name: "旧助手",
      model_name: "test-model",
    });
    expect(agentConfig.temperature).toBe(0.7);
    expect(agentConfig.p5_config.max_output_tokens).toBe(4096);
    expect(agentConfig.p5_config.recent_turns).toBe(10);
    expect(agentConfig.p5_config.retrieval_mode).toBe("standard");
    expect(agentConfig.p5_config.allocation).toBeUndefined();

    // Generic P5ConfigSchema.parse({}) remains 4096 / 10 / 4096
    const bareP5 = P5ConfigSchema.parse({});
    expect(bareP5.max_output_tokens).toBe(4096);
    expect(bareP5.recent_turns).toBe(10);
    expect(bareP5.summary_max_tokens).toBe(4096);
    expect(bareP5.retrieval_mode).toBe("standard");
    expect(bareP5.allocation).toBeUndefined();
  });

  it("ensureDefaults creates DEFAULT_AGENT_ID with new factory defaults, without updating existing rows", () => {
    const h = cloneBusinessDb();
    try {
      // 1. Initial boot: agent row is created with factory defaults
      ensureDefaults(h.orm, "synthetic-model");
      const created = h.orm
        .select()
        .from(schema.agents)
        .where(eq(schema.agents.id, DEFAULT_AGENT_ID))
        .get();
      expect(created).toBeDefined();
      expect(created?.temperature).toBe(1);
      expect(created?.personaIntensity).toBe(100);
      expect(created?.isActive).toBe(1);

      const parsedP5 = JSON.parse(created?.p5Config ?? "{}");
      expect(parsedP5.max_output_tokens).toBe(32768);
      expect(parsedP5.recent_turns).toBe(200);
      expect(parsedP5.summary_max_tokens).toBe(32768);
      expect(parsedP5.retrieval_mode).toBe("full_catalog");
      expect(parsedP5.allocation).toEqual({ mode: "auto" });

      const firstUpdatedAt = created?.updatedAt;
      const firstConfigVersion = created?.configVersion;

      // 2. Second boot: existing agent row is untouched (no update / version unchanged)
      ensureDefaults(h.orm, "synthetic-model");
      const second = h.orm
        .select()
        .from(schema.agents)
        .where(eq(schema.agents.id, DEFAULT_AGENT_ID))
        .get();
      expect(second?.updatedAt).toBe(firstUpdatedAt);
      expect(second?.configVersion).toBe(firstConfigVersion);
    } finally {
      h.close();
    }
  });
});
