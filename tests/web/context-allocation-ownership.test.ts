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

const getContextAllocationTarget = () => store.getState().contextAllocationTarget;
const resetContextAllocationTarget = () =>
  store.setState({
    contextAllocationTarget: {
      purpose: "assistant",
      agentId: null,
      schemeId: null,
      bindingId: null,
      returnRoute: null,
      returnLabel: null,
    },
  });
const returnFromContextAllocation = () => store.getState().returnFromContextAllocation();
const setContextAllocationTarget = (
  target: Partial<import("../../src/web/features/context-allocation").ContextAllocationTarget>,
) =>
  store.setState((state) => ({
    contextAllocationTarget: { ...state.contextAllocationTarget, ...target },
  }));

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

describe("Context Allocation & Memory Tools Single Ownership Architecture", () => {
  it("case 1: materials owns single active settings and retains raw legacy presets", () => {
    const editor = newPageEditor(createMockAgent(), createMockPersona());
    editor.draft.p5_config = {
      ...editor.draft.p5_config,
      memory_read: { enabled: false, max_bytes: 999 },
    };
    expect(agentPageDirty(editor, "memory-tools")).toBe(true);
    expect(agentPageDirty(editor, "context")).toBe(false);
    expect(pageAgentPayload(editor, "memory-tools").p5_config?.memory_read).toEqual({
      enabled: false,
      max_bytes: 999,
    });
    expect(pageAgentPayload(editor, "memory-tools").p5_config?.retrieval_presets).toEqual(
      editor.agent.p5_config.retrieval_presets,
    );
  });
  it("case 2: context excludes unsaved memory settings and every legacy reading field", () => {
    const editor = newPageEditor(createMockAgent(), createMockPersona());
    editor.draft.p5_config = {
      ...editor.draft.p5_config,
      memory_read: { enabled: false, max_bytes: 999 },
      context_window: 32768,
    };
    const payload = pageAgentPayload(editor, "context").p5_config;
    expect(payload?.context_window).toBe(32768);
    expect(payload?.memory_read).toEqual(editor.agent.p5_config.memory_read);
    expect(payload?.retrieval_presets).toEqual(editor.agent.p5_config.retrieval_presets);
  });
  it("case 3: accepting each page advances only its saved baseline", () => {
    const editor = newPageEditor(createMockAgent(), createMockPersona());
    editor.draft.p5_config = {
      ...editor.draft.p5_config,
      memory_read: { enabled: true, max_bytes: 123 },
      context_window: 32768,
    };
    const saved: AgentResponse = {
      ...editor.agent,
      config_version: 2,
      p5_config: { ...editor.agent.p5_config, memory_read: { enabled: true, max_bytes: 123 } },
    };
    const accepted = acceptPageAgent(editor, "memory-tools", saved);
    expect(agentPageDirty(accepted, "memory-tools")).toBe(false);
    expect(agentPageDirty(accepted, "context")).toBe(true);
    expect(accepted.draft.p5_config.context_window).toBe(32768);
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
