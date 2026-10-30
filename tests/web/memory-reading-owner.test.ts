import { describe, expect, it } from "vitest";
import { AgentResponseSchema, PersonaResponseSchema } from "../../src/shared/contracts";
import {
  acceptPageAgent,
  agentPageDirty,
  dirtyPages,
  newPageEditor,
  pageAgentPayload,
} from "../../src/web/features/agents/page-drafts";

function createTestAgent(overrides: Record<string, unknown> = {}) {
  return AgentResponseSchema.parse({
    id: "test-agent-1",
    name: "Test Agent",
    model_name: "test-model",
    config_version: 1,
    persona_intensity: 60,
    created_at: "2026-10-27T00:00:00.000Z",
    updated_at: "2026-10-27T00:00:00.000Z",
    ...overrides,
  });
}

function createTestPersona(id = "test-agent-1") {
  return PersonaResponseSchema.parse({
    id,
    agent_id: id,
    core_identity: "Core identity text",
    interaction_boundaries: "Boundaries text",
    advanced_instructions: "Instructions text",
    communication_style: "Concise",
    example_dialogues: "Dialogues text",
    created_at: "2026-10-27T00:00:00.000Z",
    updated_at: "2026-10-27T00:00:00.000Z",
  });
}

describe("single memory read draft owner", () => {
  it("changing active settings back to the legacy effective value is a no-op", () => {
    const agent = createTestAgent();
    const editor = newPageEditor(agent, createTestPersona());
    editor.draft.p5_config = {
      ...editor.draft.p5_config,
      memory_read: {
        enabled: true,
        max_bytes: agent.p5_config.retrieval_presets.standard.max_tokens,
      },
    };
    expect(agentPageDirty(editor, "memory-tools")).toBe(false);
  });
  it("edits only the active settings and preserves all legacy raw fields", () => {
    const agent = createTestAgent();
    const editor = newPageEditor(agent, createTestPersona());
    editor.draft.p5_config = {
      ...editor.draft.p5_config,
      memory_read: { enabled: true, max_bytes: 2400 },
    };
    expect(agentPageDirty(editor, "memory-tools")).toBe(true);
    expect(agentPageDirty(editor, "context")).toBe(false);
    const payload = pageAgentPayload(editor, "memory-tools");
    expect(payload.p5_config?.memory_read).toEqual({ enabled: true, max_bytes: 2400 });
    expect(payload.p5_config?.retrieval_presets).toEqual(agent.p5_config.retrieval_presets);
    expect(payload.p5_config?.retrieval_mode).toBe(agent.p5_config.retrieval_mode);
    expect(payload.expected_version).toBe(1);
  });
  it("context saves use saved memory settings, not the materials draft", () => {
    const agent = createTestAgent();
    const editor = newPageEditor(agent, createTestPersona());
    editor.draft.p5_config = {
      ...editor.draft.p5_config,
      memory_read: { enabled: false, max_bytes: 111 },
      context_window: 32768,
    };
    expect(pageAgentPayload(editor, "context").p5_config?.memory_read).toEqual(
      agent.p5_config.memory_read,
    );
    expect(pageAgentPayload(editor, "context").p5_config?.context_window).toBe(32768);
    const saved = {
      ...agent,
      p5_config: { ...agent.p5_config, context_window: 32768 },
      config_version: 2,
    };
    const accepted = acceptPageAgent(editor, "context", saved);
    expect(accepted.draft.p5_config.memory_read).toEqual({ enabled: false, max_bytes: 111 });
    expect(dirtyPages(accepted)).toEqual(["memory-tools"]);
  });
  it("memory success advances only its baseline, retaining context and prompt drafts", () => {
    const agent = createTestAgent();
    const editor = newPageEditor(agent, createTestPersona());
    editor.draft.p5_config = {
      ...editor.draft.p5_config,
      memory_read: { enabled: false, max_bytes: 321 },
      recent_turns: 25,
    };
    const saved = {
      ...agent,
      p5_config: { ...agent.p5_config, memory_read: { enabled: false, max_bytes: 321 } },
      config_version: 2,
    };
    const accepted = acceptPageAgent(editor, "memory-tools", saved);
    expect(agentPageDirty(accepted, "memory-tools")).toBe(false);
    expect(agentPageDirty(accepted, "context")).toBe(true);
    expect(accepted.draft.p5_config.recent_turns).toBe(25);
  });
  it.each(["off", "conservative", "standard", "broad", "full_catalog", "full_body"] as const)(
    "preserves stored %s and unselected presets on an unrelated save",
    (mode) => {
      const agent = createTestAgent({
        p5_config: {
          ...createTestAgent().p5_config,
          retrieval_mode: mode,
          max_catalog_batches: 7,
          catalog_batch_size: 9,
        },
      });
      const editor = newPageEditor(agent, createTestPersona());
      editor.draft.name = "renamed";
      expect(pageAgentPayload(editor, "basic")).not.toHaveProperty("p5_config");
      editor.draft.p5_config = {
        ...editor.draft.p5_config,
        memory_read: { enabled: mode !== "off", max_bytes: 100 },
      };
      const saved = pageAgentPayload(editor, "memory-tools").p5_config!;
      expect(saved.retrieval_mode).toBe(mode);
      expect(saved.retrieval_presets).toEqual(agent.p5_config.retrieval_presets);
      expect(saved.max_catalog_batches).toBe(7);
      expect(saved.catalog_batch_size).toBe(9);
    },
  );
});
