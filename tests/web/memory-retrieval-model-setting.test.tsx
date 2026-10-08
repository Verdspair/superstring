import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AgentResponse,
  AgentResponseSchema,
  PersonaResponseSchema,
} from "../../src/shared/contracts";
import type { SuperstringApi } from "../../src/web/api";
import { newPageEditor } from "../../src/web/features/agents/page-drafts";
import { selectLocale } from "../../src/web/i18n";
import { CapabilityEditor } from "../../src/web/screens/assistants/StudioEditors";
import { useSuperstringStore as store } from "../../src/web/store";

const selectedAgent = AgentResponseSchema.parse({
  id: "agent-selected",
  name: "Selected agent",
  model_name: "chat-model",
  memory_consolidation_model_name: "organization-model",
  memory_retrieval_model_name: "saved-retrieval-model",
  context_compression_model_name: "compression-model",
  config_version: 7,
  persona_intensity: 60,
  created_at: "2026-09-19T00:00:00.000Z",
  updated_at: "2026-09-19T00:00:00.000Z",
});
const otherAgent = AgentResponseSchema.parse({
  id: "agent-other",
  name: "Other agent",
  model_name: "other-chat-model",
  memory_retrieval_model_name: "other-retrieval-model",
  config_version: 3,
  persona_intensity: 60,
  created_at: "2026-09-19T00:00:00.000Z",
  updated_at: "2026-09-19T00:00:00.000Z",
});
const persona = PersonaResponseSchema.parse({
  id: "persona-selected",
  agent_id: selectedAgent.id,
  core_identity: "",
  communication_style: "",
  interaction_boundaries: "",
  example_dialogues: "",
  advanced_instructions: "",
  created_at: "2026-09-19T00:00:00.000Z",
  updated_at: "2026-09-19T00:00:00.000Z",
});

beforeEach(() => {
  selectLocale("zh-CN");
});
afterEach(() => {
  cleanup();
  store.getState().resetForTests();
});

describe("memory retrieval model purpose", () => {
  it("renders the selected Agent memory retrieval model in the existing model-purpose controls", async () => {
    store.getState().resetForTests();
    store.setState({
      agents: [selectedAgent, otherAgent],
      editorAgentId: selectedAgent.id,
      pageEditor: newPageEditor(selectedAgent, persona),
    });
    await act(async () => render(<CapabilityEditor active={false} />));
    const retrievalModel = screen.getByLabelText("记忆读取模型") as HTMLInputElement;
    expect(retrievalModel.value).toBe("saved-retrieval-model");
    fireEvent.change(retrievalModel, { target: { value: "edited-retrieval-model" } });
    expect(store.getState().pageEditor?.draft.memory_retrieval_model_name).toBe(
      "edited-retrieval-model",
    );
  });

  it("saves the selected Agent retrieval model through the models page CAS whitelist only", async () => {
    const updateAgent = vi.fn(async (id: string, body: unknown): Promise<AgentResponse> => {
      expect(id).toBe(selectedAgent.id);
      const patch = body as {
        expected_version: number;
        memory_retrieval_model_name?: string | null;
      };
      expect(patch.expected_version).toBe(7);
      const { expected_version: _expectedVersion, ...changes } = patch;
      return AgentResponseSchema.parse({ ...selectedAgent, ...changes, config_version: 8 });
    });
    const api = { updateAgent } as unknown as SuperstringApi;
    store.getState().resetForTests(api);
    store.setState({
      agents: [selectedAgent, otherAgent],
      editorAgentId: selectedAgent.id,
      pageEditor: newPageEditor(selectedAgent, persona),
    });

    store
      .getState()
      .patchPageAgent("models", { memory_retrieval_model_name: "new-retrieval-model" });

    expect(store.getState().pageEditor?.draft.memory_retrieval_model_name).toBe(
      "new-retrieval-model",
    );
    const saved = await store.getState().saveSettingsPage("models");
    expect(saved, store.getState().error ?? "save failed without an error").toBe(true);
    expect(updateAgent).toHaveBeenCalledExactlyOnceWith(selectedAgent.id, {
      expected_version: 7,
      model_name: "chat-model",
      temperature: 0.7,
      memory_consolidation_model_name: "organization-model",
      memory_retrieval_model_name: "new-retrieval-model",
      context_compression_model_name: "compression-model",
    });
    expect(store.getState().pageEditor?.agent.memory_retrieval_model_name).toBe(
      "new-retrieval-model",
    );
    expect(
      store.getState().agents.find(({ id }) => id === otherAgent.id)?.memory_retrieval_model_name,
    ).toBe("other-retrieval-model");
  });
});
