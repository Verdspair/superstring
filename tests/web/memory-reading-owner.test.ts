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

describe("memory reading owner: page-drafts single-owner regression", () => {
  it("dirties memory-tools and leaves context clean when only retrieval bytes change", () => {
    const agent = createTestAgent();
    const persona = createTestPersona();
    const editor = newPageEditor(agent, persona);

    expect(agentPageDirty(editor, "memory-tools")).toBe(false);
    expect(agentPageDirty(editor, "context")).toBe(false);
    expect(dirtyPages(editor)).toEqual([]);

    editor.draft.p5_config = structuredClone(editor.draft.p5_config);
    const initialBytes = editor.agent.p5_config.retrieval_presets.standard.max_tokens;
    editor.draft.p5_config.retrieval_presets.standard.max_tokens = initialBytes + 4096;

    expect(agentPageDirty(editor, "memory-tools")).toBe(true);
    expect(agentPageDirty(editor, "context")).toBe(false);
    expect(dirtyPages(editor)).toEqual(["memory-tools"]);
  });

  it("includes full preset in memory-tools payload with updated bytes and limits", () => {
    const agent = createTestAgent();
    const persona = createTestPersona();
    const editor = newPageEditor(agent, persona);

    editor.draft.p5_config = structuredClone(editor.draft.p5_config);
    editor.draft.p5_config.retrieval_presets.standard = {
      ...editor.draft.p5_config.retrieval_presets.standard,
      candidate_limit: 250,
      max_entries: 45,
      max_tokens: 32768,
    };

    const payload = pageAgentPayload(editor, "memory-tools");
    const p5 = payload.p5_config;
    expect(p5).toBeDefined();
    expect(p5?.retrieval_presets.standard.candidate_limit).toBe(250);
    expect(p5?.retrieval_presets.standard.max_entries).toBe(45);
    expect(p5?.retrieval_presets.standard.max_tokens).toBe(32768);
  });

  it("takes retrieval presets in context payload strictly from saved baseline", () => {
    const agent = createTestAgent();
    const persona = createTestPersona();
    const editor = newPageEditor(agent, persona);

    editor.draft.p5_config = structuredClone(editor.draft.p5_config);
    editor.draft.p5_config.retrieval_presets.standard.max_tokens = 99999;
    editor.draft.p5_config.context_window = 16384;

    const contextPayload = pageAgentPayload(editor, "context");
    const p5 = contextPayload.p5_config;
    expect(p5).toBeDefined();
    expect(p5?.context_window).toBe(16384);
    expect(p5?.retrieval_presets.standard.max_tokens).toBe(
      editor.agent.p5_config.retrieval_presets.standard.max_tokens,
    );
  });

  it("preserves context drafts on memory accept and memory drafts on context accept", () => {
    const agent = createTestAgent();
    const persona = createTestPersona();

    const editor1 = newPageEditor(agent, persona);
    editor1.draft.p5_config = structuredClone(editor1.draft.p5_config);
    editor1.draft.p5_config.retrieval_presets.standard.max_tokens = 50000;
    editor1.draft.p5_config.context_window = 32000;

    const savedAgentMemory = createTestAgent({
      config_version: 2,
      p5_config: {
        ...agent.p5_config,
        retrieval_presets: {
          ...agent.p5_config.retrieval_presets,
          standard: {
            ...agent.p5_config.retrieval_presets.standard,
            max_tokens: 50000,
          },
        },
      },
    });

    const acceptedMemory = acceptPageAgent(editor1, "memory-tools", savedAgentMemory);
    expect(agentPageDirty(acceptedMemory, "memory-tools")).toBe(false);
    expect(acceptedMemory.draft.p5_config.context_window).toBe(32000);
    expect(agentPageDirty(acceptedMemory, "context")).toBe(true);

    const editor2 = newPageEditor(agent, persona);
    editor2.draft.p5_config = structuredClone(editor2.draft.p5_config);
    editor2.draft.p5_config.retrieval_presets.standard.max_tokens = 50000;
    editor2.draft.p5_config.context_window = 32000;

    const savedAgentContext = createTestAgent({
      config_version: 2,
      p5_config: {
        ...agent.p5_config,
        context_window: 32000,
      },
    });

    const acceptedContext = acceptPageAgent(editor2, "context", savedAgentContext);
    expect(agentPageDirty(acceptedContext, "context")).toBe(false);
    expect(acceptedContext.draft.p5_config.retrieval_presets.standard.max_tokens).toBe(50000);
    expect(agentPageDirty(acceptedContext, "memory-tools")).toBe(true);
    expect(dirtyPages(acceptedContext)).toEqual(["memory-tools"]);
  });

  it("preserves unselected preset modes byte-for-byte in draft and baseline", () => {
    const agent = createTestAgent();
    const persona = createTestPersona();
    const editor = newPageEditor(agent, persona);

    editor.draft.p5_config = structuredClone(editor.draft.p5_config);
    editor.draft.p5_config.retrieval_presets.standard.max_tokens = 24000;

    const payload = pageAgentPayload(editor, "memory-tools");
    const p5 = payload.p5_config;
    expect(p5).toBeDefined();

    expect(p5?.retrieval_presets.conservative).toEqual(
      editor.agent.p5_config.retrieval_presets.conservative,
    );
    expect(p5?.retrieval_presets.broad).toEqual(editor.agent.p5_config.retrieval_presets.broad);
  });

  it.each(["full_catalog", "full_body"] as const)(
    "preserves %s stored mode without converting to broad",
    (storedMode) => {
      const legacyAgent = createTestAgent({
        p5_config: {
          ...createTestAgent().p5_config,
          retrieval_mode: storedMode,
          max_catalog_batches: 15,
          catalog_batch_size: 25,
        },
      });
      const persona = createTestPersona();
      const editor = newPageEditor(legacyAgent, persona);

      editor.draft.p5_config = structuredClone(editor.draft.p5_config);
      editor.draft.p5_config.retrieval_presets.standard.max_tokens = 28000;

      const payload = pageAgentPayload(editor, "memory-tools");
      const p5 = payload.p5_config;
      expect(p5).toBeDefined();

      expect(p5?.retrieval_mode).toBe(storedMode);
      expect(p5?.max_catalog_batches).toBe(15);
      expect(p5?.catalog_batch_size).toBe(25);
    },
  );
});
