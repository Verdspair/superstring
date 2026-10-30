import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentResponseSchema,
  PersonaResponseSchema,
  UpdateAgentRequestSchema,
} from "../../src/shared/contracts";
import type { SuperstringApi } from "../../src/web/api";
import { newPageEditor } from "../../src/web/features/agents/page-drafts";
import { useSuperstringStore as store } from "../../src/web/store";

const agent = AgentResponseSchema.parse({
  id: "A",
  name: "A",
  model_name: "model",
  config_version: 1,
  persona_intensity: 60,
  created_at: "2026-10-27T00:00:00.000Z",
  updated_at: "2026-10-27T00:00:00.000Z",
});
const persona = PersonaResponseSchema.parse({
  id: "P",
  agent_id: "A",
  core_identity: "",
  interaction_boundaries: "",
  advanced_instructions: "",
  communication_style: "",
  example_dialogues: "",
  created_at: "2026-10-27T00:00:00.000Z",
  updated_at: "2026-10-27T00:00:00.000Z",
});
beforeEach(() => {
  store.getState().resetForTests({
    getAgent: vi.fn(async () => agent),
    getPersona: vi.fn(async () => persona),
  } as unknown as SuperstringApi);
  store.setState({
    agents: [agent],
    page: "settings",
    settingsView: "workspace",
    settingsRoute: "capability-memory",
    editorAgentId: "A",
    pageEditor: newPageEditor(agent, persona),
  });
});
describe("canonical workspace entry and return", () => {
  it("save-and-continue commits the dirty task without requiring an unrelated permission snapshot", async () => {
    const updateAgent = vi.fn(async (_id: string, value: unknown) => ({
      ...agent,
      ...UpdateAgentRequestSchema.parse(value),
      config_version: 2,
    }));
    store.setState({
      apiClient: { ...store.getState().apiClient, updateAgent },
      settingsRoute: "memory-tools",
    });
    store.getState().patchPageAgent("memory-tools", {
      p5_config: { ...agent.p5_config, memory_read: { enabled: false, max_bytes: 512 } },
    });
    store.getState().openWorkspaceTarget("long-memory", "A");
    expect(store.getState().navigationConfirmOpen).toBe(true);
    expect(store.getState().settingsRoute).toBe("memory-tools");
    await store.getState().confirmSaveAndContinue();
    expect(updateAgent).toHaveBeenCalledTimes(1);
    expect(store.getState().settingsRoute).toBe("long-memory");
    expect(store.getState().navigationConfirmOpen).toBe(false);
    store.getState().returnWorkspaceTarget();
    expect(store.getState().settingsRoute).toBe("memory-tools");
    expect(store.getState().pageEditor?.agent.p5_config.memory_read?.max_bytes).toBe(512);
  });
  it("returns component navigation to the exact Agent tools task rather than the previous identity route", () => {
    store.setState({ settingsRoute: "agent-tools" });
    store.getState().openSystemComponent({ kind: "skill", id: "system-evidence-reading" });
    expect(store.getState().settingsRoute).toBe("skill-catalog");
    store.getState().returnWorkspaceTarget();
    expect(store.getState().settingsRoute).toBe("agent-tools");
    expect(store.getState().editorAgentId).toBe("A");
  });
  it("global capability entry never resolves an implicit Agent", async () => {
    store.getState().openWorkspaceTarget("capability-knowledge");
    expect(store.getState().settingsRoute).toBe("capability-knowledge");
    expect(store.getState().apiClient.getAgent).not.toHaveBeenCalled();
    expect(store.getState().workspaceReturns.at(-1)?.route).toBe("capability-memory");
    store.getState().returnWorkspaceTarget();
    expect(store.getState().settingsRoute).toBe("capability-memory");
  });
  it("component selection and exact source return survive a clean navigation", () => {
    store.getState().openSystemComponent({ kind: "tool", id: "memory.query" });
    expect(store.getState().settingsRoute).toBe("tool-grants");
    expect(store.getState().componentTarget).toEqual({ kind: "tool", id: "memory.query" });
    store.getState().returnWorkspaceTarget();
    expect(store.getState().settingsRoute).toBe("capability-memory");
    expect(store.getState().componentTarget).toBeNull();
    expect(store.getState().workspaceReturns).toEqual([]);
  });
  it("dirty navigation cancel does not leak target or return context", () => {
    store.getState().patchPageAgent("basic", { name: "draft" });
    store.getState().openWorkspaceTarget("knowledge-config");
    expect(store.getState().navigationConfirmOpen).toBe(true);
    expect(store.getState().settingsRoute).toBe("capability-memory");
    expect(store.getState().workspaceReturns).toEqual([]);
    store.getState().cancelPendingNavigation();
    expect(store.getState().pageEditor?.draft.name).toBe("draft");
  });
  it("discard continue restores baseline before landing, then returns to the original capability", async () => {
    store.getState().patchPageAgent("memory-tools", {
      p5_config: { ...agent.p5_config, memory_read: { enabled: false, max_bytes: 1024 } },
    });
    store.getState().openWorkspaceTarget("knowledge-config");
    await store.getState().confirmDiscardAndContinue();
    expect(store.getState().settingsRoute).toBe("knowledge-config");
    expect(store.getState().pageEditor?.draft.p5_config.memory_read).toEqual(
      agent.p5_config.memory_read,
    );
    store.getState().returnWorkspaceTarget();
    expect(store.getState().settingsRoute).toBe("capability-memory");
  });
});
