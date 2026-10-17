import { beforeEach, describe, expect, it } from "vitest";
import {
  type AgentResponse,
  AgentResponseSchema,
  type PersonaResponse,
  PersonaResponseSchema,
} from "../../src/shared/contracts";
import {
  acceptPageAgent,
  agentPageDirty,
  newPageEditor,
  pageAgentPayload,
} from "../../src/web/features/agents/page-drafts";
import {
  getContextAllocationTarget,
  resetContextAllocationTarget,
  returnFromContextAllocation,
  setContextAllocationTarget,
} from "../../src/web/features/context-allocation";
import { useSuperstringStore as store } from "../../src/web/store";

function createMockAgent(id = "test-agent"): AgentResponse {
  return AgentResponseSchema.parse({
    id,
    name: "Test Agent",
    description: "For ownership tests",
    model_name: "test-model",
    config_version: 1,
    persona_intensity: 60,
    created_at: "2026-10-16T00:00:00.000Z",
    updated_at: "2026-10-16T00:00:00.000Z",
  });
}

function createMockPersona(id = "test-agent"): PersonaResponse {
  return PersonaResponseSchema.parse({
    id: `persona-${id}`,
    agent_id: id,
    core_identity: "Test identity",
    communication_style: "Direct",
    interaction_boundaries: "None",
    example_dialogues: "Hello",
    advanced_instructions: "",
    created_at: "2026-10-16T00:00:00.000Z",
    updated_at: "2026-10-16T00:00:00.000Z",
  });
}

beforeEach(() => {
  store.getState().resetForTests();
  resetContextAllocationTarget();
});

describe("Context Allocation & Memory Tools Nested Ownership", () => {
  it("case 1: memory-tools page dirty and payload only owns non-max_tokens fields, excluding nested max_tokens", () => {
    const editor = newPageEditor(createMockAgent(), createMockPersona());
    editor.draft.p5_config = structuredClone(editor.draft.p5_config);

    // Baseline: not dirty
    expect(agentPageDirty(editor, "memory-tools")).toBe(false);

    // Modifying ONLY max_tokens does NOT make memory-tools dirty
    editor.draft.p5_config.retrieval_presets.broad.max_tokens = 9999;
    expect(agentPageDirty(editor, "memory-tools")).toBe(false);

    // Modifying candidate_limit DOES make memory-tools dirty
    editor.draft.p5_config.retrieval_presets.broad.candidate_limit = 88;
    expect(agentPageDirty(editor, "memory-tools")).toBe(true);

    // Payload for memory-tools must include modified candidate_limit but baseline max_tokens
    const payload = pageAgentPayload(editor, "memory-tools");
    expect(payload.p5_config?.retrieval_presets.broad.candidate_limit).toBe(88);
    expect(payload.p5_config?.retrieval_presets.broad.max_tokens).toBe(
      editor.agent.p5_config.retrieval_presets.broad.max_tokens,
    );
  });

  it("case 2: context page dirty and payload only owns nested max_tokens, excluding candidate_limit", () => {
    const editor = newPageEditor(createMockAgent(), createMockPersona());
    editor.draft.p5_config = structuredClone(editor.draft.p5_config);

    // Baseline: not dirty
    expect(agentPageDirty(editor, "context")).toBe(false);

    // Modifying ONLY candidate_limit does NOT make context dirty
    editor.draft.p5_config.retrieval_presets.broad.candidate_limit = 77;
    expect(agentPageDirty(editor, "context")).toBe(false);

    // Modifying max_tokens DOES make context dirty
    editor.draft.p5_config.retrieval_presets.broad.max_tokens = 5432;
    expect(agentPageDirty(editor, "context")).toBe(true);

    // Payload for context must include modified max_tokens but baseline candidate_limit
    const payload = pageAgentPayload(editor, "context");
    expect(payload.p5_config?.retrieval_presets.broad.max_tokens).toBe(5432);
    expect(payload.p5_config?.retrieval_presets.broad.candidate_limit).toBe(
      editor.agent.p5_config.retrieval_presets.broad.candidate_limit,
    );
  });

  it("case 3: acceptPageAgent preserves cross-page dirty fields without leaking or clobbering", () => {
    const editor = newPageEditor(createMockAgent(), createMockPersona());
    editor.draft.p5_config = structuredClone(editor.draft.p5_config);

    // User edits both candidate_limit (memory-tools) and max_tokens (context)
    editor.draft.p5_config.retrieval_presets.broad.candidate_limit = 123;
    editor.draft.p5_config.retrieval_presets.broad.max_tokens = 7777;

    // Simulate saving memory-tools: server returns saved agent with new candidate_limit and old max_tokens
    const savedFromMemoryTools: AgentResponse = {
      ...editor.agent,
      config_version: 2,
      p5_config: {
        ...editor.agent.p5_config,
        retrieval_presets: {
          ...editor.agent.p5_config.retrieval_presets,
          broad: {
            ...editor.agent.p5_config.retrieval_presets.broad,
            candidate_limit: 123,
          },
        },
      },
    };

    // Accept memory-tools page
    const acceptedMemory = acceptPageAgent(editor, "memory-tools", savedFromMemoryTools);
    // Baseline updated for memory-tools
    expect(acceptedMemory.agent.p5_config.retrieval_presets.broad.candidate_limit).toBe(123);
    // Draft keeps unsaved max_tokens for context
    expect(acceptedMemory.draft.p5_config.retrieval_presets.broad.max_tokens).toBe(7777);
    // memory-tools is clean, context is still dirty
    expect(agentPageDirty(acceptedMemory, "memory-tools")).toBe(false);
    expect(agentPageDirty(acceptedMemory, "context")).toBe(true);

    // Now simulate saving context: server returns saved agent with new max_tokens
    const savedFromContext: AgentResponse = {
      ...acceptedMemory.agent,
      config_version: 3,
      p5_config: {
        ...acceptedMemory.agent.p5_config,
        retrieval_presets: {
          ...acceptedMemory.agent.p5_config.retrieval_presets,
          broad: {
            ...acceptedMemory.agent.p5_config.retrieval_presets.broad,
            max_tokens: 7777,
          },
        },
      },
    };

    // Accept context page
    const acceptedContext = acceptPageAgent(acceptedMemory, "context", savedFromContext);
    expect(acceptedContext.agent.p5_config.retrieval_presets.broad.max_tokens).toBe(7777);
    expect(acceptedContext.draft.p5_config.retrieval_presets.broad.max_tokens).toBe(7777);
    expect(agentPageDirty(acceptedContext, "memory-tools")).toBe(false);
    expect(agentPageDirty(acceptedContext, "context")).toBe(false);
  });

  it("case 4: returnFromContextAllocation keeps returnRoute on cancel and only resets when navigation accepted", () => {
    // Setup initial state: on context-allocation page with returnRoute set
    store.setState({
      page: "settings",
      settingsView: "workspace",
      settingsRoute: "context-allocation",
      dirty: true, // Has unsaved changes
    });

    setContextAllocationTarget({
      purpose: "assistant",
      agentId: "test-agent",
      returnRoute: "basic",
      returnLabel: "助手设置",
    });

    // Initiating return when dirty triggers confirm dialog instead of immediate reset
    returnFromContextAllocation();

    // Confirm dialog is opened, navigation is pending
    expect(store.getState().navigationConfirmOpen).toBe(true);
    // Return target MUST NOT be wiped while navigation is pending/cancelled
    expect(getContextAllocationTarget().returnRoute).toBe("basic");

    // User cancels the navigation
    store.getState().cancelPendingNavigation();
    expect(store.getState().navigationConfirmOpen).toBe(false);
    // Target still retained after cancel
    expect(getContextAllocationTarget().returnRoute).toBe("basic");
  });
});
