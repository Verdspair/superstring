import { act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentResponseSchema, PersonaResponseSchema } from "../../src/shared/contracts";
import { api } from "../../src/web/api";
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

describe("savePersona ownership regression", () => {
  it("preserves agent B state when a deferred savePersona for agent A resolves after switching", async () => {
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

    const saveOutcome = store.getState().savePersona({
      core_identity: "Agent A updated identity",
      persona_intensity: 90,
    });
    await startedPromise;

    await act(async () => {
      await store.getState().editAgent(agentB.id);
    });
    expect(store.getState().editorAgentId).toBe(agentB.id);
    expect(store.getState().persona?.agent_id).toBe(agentB.id);
    expect(store.getState().pageEditor?.agent.id).toBe(agentB.id);

    await act(async () => {
      store.getState().patchDraft({ description: "Agent B pending draft" });
    });
    expect(store.getState().dirty).toBe(true);
    const editorBeforeResponse = store.getState().pageEditor;

    releaseSaveA({
      ...personaA,
      core_identity: "Agent A updated identity",
    });
    await saveOutcome;

    expect(store.getState().editorAgentId).toBe(agentB.id);
    expect(store.getState().persona?.agent_id).toBe(agentB.id);
    expect(store.getState().pageEditor).toBe(editorBeforeResponse);
    expect(store.getState().editorDraft?.description).toBe("Agent B pending draft");
    expect(store.getState().dirty).toBe(true);
  });

  it("suppresses stale UI error when a deferred savePersona for agent A fails after switching", async () => {
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

    const saveOutcome = store.getState().savePersona({
      core_identity: "Agent A will fail",
      persona_intensity: 60,
    });
    await startedPromise;

    await act(async () => {
      await store.getState().editAgent(agentB.id);
    });
    expect(store.getState().editorAgentId).toBe(agentB.id);
    expect(store.getState().error).toBeNull();

    rejectSaveA(new Error("network failure saving agent A"));
    const success = await saveOutcome;
    expect(success).toBe(false);

    expect(store.getState().editorAgentId).toBe(agentB.id);
    expect(store.getState().error).toBeNull();
  });

  it("preserves newer dirty draft when savePersona resolves for the same agent", async () => {
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

    const saveOutcome = store.getState().savePersona({
      persona_intensity: 85,
    });
    await startedPromise;

    await act(async () => {
      store.getState().patchDraft({ description: "Agent A newer draft edited during save" });
    });
    expect(store.getState().dirty).toBe(true);
    expect(store.getState().editorDraft?.description).toBe(
      "Agent A newer draft edited during save",
    );

    releaseSaveA({
      ...personaA,
    });
    const success = await saveOutcome;
    expect(success).toBe(true);

    expect(store.getState().editorAgentId).toBe(agentA.id);
    expect(store.getState().editorDraft?.description).toBe(
      "Agent A newer draft edited during save",
    );
    expect(store.getState().dirty).toBe(true);
  });
});
