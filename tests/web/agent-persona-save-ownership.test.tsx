import { act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentResponseSchema, PersonaResponseSchema } from "../../src/shared/contracts";
import { api } from "../../src/web/api";
import { newPageEditor } from "../../src/web/features/agents/page-drafts";
import { useSuperstringStore as store } from "../../src/web/store";

const agentAId = "11111111-1111-4111-8111-111111111111";
const agentBId = "22222222-2222-4222-8222-222222222222";
const personaAId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const personaBId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const now = "2026-10-14T00:00:00.000Z";

const agentA = AgentResponseSchema.parse({
  id: agentAId,
  name: "Agent A",
  model_name: "model-a",
  config_version: 1,
  persona_intensity: 60,
  created_at: now,
  updated_at: now,
});

const agentB = AgentResponseSchema.parse({
  id: agentBId,
  name: "Agent B",
  model_name: "model-b",
  config_version: 1,
  persona_intensity: 70,
  created_at: now,
  updated_at: now,
});

const personaA = PersonaResponseSchema.parse({
  id: personaAId,
  agent_id: agentAId,
  core_identity: "Agent A Core Identity",
  communication_style: "Concise",
  interaction_boundaries: "Safe",
  example_dialogues: "Hello",
  advanced_instructions: "Follow system prompt",
  created_at: now,
  updated_at: now,
});

const personaB = PersonaResponseSchema.parse({
  id: personaBId,
  agent_id: agentBId,
  core_identity: "Agent B Core Identity",
  communication_style: "Detailed",
  interaction_boundaries: "Strict",
  example_dialogues: "Hi there",
  advanced_instructions: "Be helpful",
  created_at: now,
  updated_at: now,
});

afterEach(() => {
  vi.restoreAllMocks();
});

function setupStore(savePersonaMock: (id: string, body: unknown) => Promise<typeof personaA>) {
  const client = {
    ...api,
    getAgent: vi.fn().mockImplementation(async (id: string) => {
      if (id === agentA.id) return agentA;
      if (id === agentB.id) return agentB;
      throw new Error(`agent not found: ${id}`);
    }),
    getPersona: vi.fn().mockImplementation(async (id: string) => {
      if (id === agentA.id) return personaA;
      if (id === agentB.id) return personaB;
      throw new Error(`persona not found: ${id}`);
    }),
    savePersona: savePersonaMock,
  };
  store.getState().resetForTests(client);
  store.setState({
    page: "settings",
    settingsView: "workspace",
    settingsRoute: "basic",
    agents: [agentA, agentB],
    modelNames: ["model-a", "model-b"],
    reloadMemory: vi.fn().mockResolvedValue(undefined),
  });
}

describe("page persona save ownership regression", () => {
  it("locks navigation and preserves replacement Agent B when page persona save for Agent A resolves", async () => {
    let releaseSaveA!: (value: typeof personaA) => void;
    const saveGate = new Promise<typeof personaA>((resolve) => {
      releaseSaveA = resolve;
    });
    let saveStarted!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      saveStarted = resolve;
    });

    const savePersonaMock = vi.fn().mockImplementation(async (id: string) => {
      if (id === agentA.id) {
        saveStarted();
        return saveGate;
      }
      return personaB;
    });

    setupStore(savePersonaMock);

    await act(async () => {
      await store.getState().editAgent(agentA.id);
    });
    expect(store.getState().editorAgentId).toBe(agentA.id);
    expect(store.getState().persona?.agent_id).toBe(agentA.id);

    store.getState().patchPagePersona("identity", { core_identity: "Agent A updated identity" });
    const saveOutcome = store.getState().saveSettingsPage("identity");
    await startedPromise;

    await act(async () => {
      // Real navigation is locked; simulate another owner's already-replaced editor.
      expect(await store.getState().editAgent(agentB.id)).toBe(false);
      store.setState({
        editorAgentId: agentB.id,
        pageEditor: newPageEditor(agentB, personaB),
        persona: personaB,
      });
    });
    expect(store.getState().editorAgentId).toBe(agentB.id);
    expect(store.getState().persona?.agent_id).toBe(agentB.id);
    expect(store.getState().pageEditor?.agent.id).toBe(agentB.id);

    await act(async () => {
      const editor = store.getState().pageEditor!;
      store.setState({
        pageEditor: { ...editor, draft: { ...editor.draft, description: "Agent B pending draft" } },
      });
    });
    expect(store.getState().settingsTaskDirty("identity")).toBe(true);
    const editorBeforeResponse = store.getState().pageEditor;

    releaseSaveA({
      ...personaA,
      core_identity: "Agent A updated identity",
    });
    await saveOutcome;

    expect(store.getState().editorAgentId).toBe(agentB.id);
    expect(store.getState().persona?.agent_id).toBe(agentB.id);
    expect(store.getState().pageEditor).toBe(editorBeforeResponse);
    expect(store.getState().pageEditor?.draft.description).toBe("Agent B pending draft");
    expect(store.getState().settingsTaskDirty("identity")).toBe(true);
  });

  it("suppresses stale UI error when page persona save for Agent A fails after editor replacement", async () => {
    let rejectSaveA!: (reason: unknown) => void;
    const saveGate = new Promise<typeof personaA>((_, reject) => {
      rejectSaveA = reject;
    });
    let saveStarted!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      saveStarted = resolve;
    });

    const savePersonaMock = vi.fn().mockImplementation(async (id: string) => {
      if (id === agentA.id) {
        saveStarted();
        return saveGate;
      }
      return personaB;
    });

    setupStore(savePersonaMock);

    await act(async () => {
      await store.getState().editAgent(agentA.id);
    });
    expect(store.getState().editorAgentId).toBe(agentA.id);

    store.getState().patchPagePersona("identity", { core_identity: "Agent A will fail" });
    const saveOutcome = store.getState().saveSettingsPage("identity");
    await startedPromise;

    await act(async () => {
      // Real navigation is locked; simulate another owner's already-replaced editor.
      expect(await store.getState().editAgent(agentB.id)).toBe(false);
      store.setState({
        editorAgentId: agentB.id,
        pageEditor: newPageEditor(agentB, personaB),
        persona: personaB,
      });
    });
    expect(store.getState().editorAgentId).toBe(agentB.id);
    expect(store.getState().error).toBeNull();

    rejectSaveA(new Error("network failure saving agent A"));
    const success = await saveOutcome;
    expect(success).toBe(false);

    expect(store.getState().editorAgentId).toBe(agentB.id);
    expect(store.getState().error).toBeNull();
  });

  it("preserves the foreign-page dirty draft and locks edits when expression persona save resolves", async () => {
    let releaseSaveA!: (value: typeof personaA) => void;
    const saveGate = new Promise<typeof personaA>((resolve) => {
      releaseSaveA = resolve;
    });
    let saveStarted!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      saveStarted = resolve;
    });

    const savePersonaMock = vi.fn().mockImplementation(async (id: string) => {
      if (id === agentA.id) {
        saveStarted();
        return saveGate;
      }
      return personaA;
    });

    setupStore(savePersonaMock);

    await act(async () => {
      await store.getState().editAgent(agentA.id);
    });
    expect(store.getState().editorAgentId).toBe(agentA.id);

    store.getState().patchPageAgent("expression", { persona_intensity: 85 });
    store.getState().patchPageAgent("basic", { description: "Agent A newer foreign-page draft" });
    const saveOutcome = store.getState().saveSettingsPage("expression");
    await startedPromise;

    await act(async () => {
      store.getState().patchPageAgent("basic", { description: "blocked in-flight edit" });
    });
    expect(store.getState().settingsTaskDirty("identity")).toBe(true);
    expect(store.getState().pageEditor?.draft.description).toBe("Agent A newer foreign-page draft");

    releaseSaveA({
      ...personaA,
    });
    const success = await saveOutcome;
    expect(success).toBe(true);

    expect(savePersonaMock).toHaveBeenCalledWith(
      agentA.id,
      expect.objectContaining({ persona_intensity: 85 }),
    );
    expect(store.getState().pageEditor?.agent.persona_intensity).toBe(85);
    expect(store.getState().editorAgentId).toBe(agentA.id);
    expect(store.getState().pageEditor?.draft.description).toBe("Agent A newer foreign-page draft");
    expect(store.getState().settingsTaskDirty("identity")).toBe(true);
  });
  it.each(["api", "route"] as const)(
    "rejects a stale persona result after same-Agent %s replacement",
    async (kind) => {
      let release!: (value: typeof personaA) => void;
      const gate = new Promise<typeof personaA>((resolve) => {
        release = resolve;
      });
      const savePersonaMock = vi.fn(() => gate);
      setupStore(savePersonaMock);
      await store.getState().editAgent(agentA.id);
      store.getState().patchPagePersona("identity", { core_identity: "submitted identity" });
      const outcome = store.getState().saveSettingsPage("identity");
      expect(savePersonaMock).toHaveBeenCalledWith(
        agentA.id,
        expect.objectContaining({
          core_identity: "submitted identity",
          communication_style: personaA.communication_style,
        }),
      );
      expect(await store.getState().saveSettingsPage("identity")).toBe(false);
      expect(savePersonaMock).toHaveBeenCalledTimes(1);
      const editor = store.getState().pageEditor;
      store.setState(kind === "api" ? { apiClient: { ...api } } : { settingsRoute: "context" });
      store.setState({ error: "new owner notice" });
      release({ ...personaA, core_identity: "submitted identity" });
      expect(await outcome).toBe(false);
      expect(store.getState().pageEditor).toBe(editor);
      expect(store.getState().pageEditor?.persona.core_identity).toBe(personaA.core_identity);
      expect(store.getState().pageEditor?.personaDraft.core_identity).toBe("submitted identity");
      expect(store.getState().error).toBe("new owner notice");
      expect(store.getState().settingsSaving).toBe(false);
    },
  );
});
