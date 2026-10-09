import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AgentResponse,
  AgentResponseSchema,
  type PersonaResponse,
} from "../../src/shared/contracts";
import type { PermissionsResponse } from "../../src/shared/contracts/permissions";
import { api } from "../../src/web/api";
import { newPageEditor } from "../../src/web/features/agents/page-drafts";
import { selectLocale } from "../../src/web/i18n";
import { CapabilitiesWorkspace } from "../../src/web/screens/connections/CapabilitiesWorkspace";
import { navigationBusy } from "../../src/web/state/unsaved-changes";
import { useSuperstringStore as store } from "../../src/web/store";

const NOW = "2026-10-07T00:00:00.000Z";
const testAgent = (id: string): AgentResponse =>
  AgentResponseSchema.parse({
    id,
    name: `Agent ${id}`,
    config_version: 1,
    model_name: "model",
    persona_intensity: 60,
    created_at: NOW,
    updated_at: NOW,
  });

const testPersona = (id: string): PersonaResponse => ({
  id: `p-${id}`,
  agent_id: id,
  core_identity: "",
  communication_style: "",
  interaction_boundaries: "",
  example_dialogues: "",
  advanced_instructions: "",
  created_at: NOW,
  updated_at: NOW,
});

const permissions: PermissionsResponse = {
  revision: "pr-1",
  policy: {
    version: 1,
    grants: [],
    execution: {
      research: false,
      code: false,
      modules: {
        mcp: false,
        skills: false,
        web: false,
        tasks: true,
        memoryJobs: true,
        knowledgeJobs: true,
        qqMedia: true,
        qqStickers: true,
        qqMembers: true,
      },
      maintenance: { memoryTimeoutSeconds: 3600, knowledgeTimeoutSeconds: 3600 },
      telemetry: { retentionDays: 14 },
      pausedTools: [],
      tasks: { concurrency: 2, retentionHours: 24, leaseSeconds: 30, pollMs: 500 },
      researchLimits: { maxPerRun: 2, maxSteps: 6, deadlineMs: 60_000, maxConclusionChars: 4_000 },
      codeLimits: {
        timeoutMs: 20_000,
        maxCalls: 32,
        concurrency: 3,
        memoryBytes: 33_554_432,
        maxTransferBytes: 1_048_576,
        maxConclusionChars: 4_000,
      },
      loop: {
        maxSteps: 16,
        readBatch: 3,
        noProgress: 3,
        concurrency: 4,
        modelConcurrency: 1,
        providerConcurrency: 1,
      },
      qq: { retryDelayMs: 15_000, maxAttempts: 3, deliveryTtlSeconds: 120 },
    },
  },
  resources: [],
};

beforeEach(() => {
  selectLocale("zh-CN");
});

afterEach(() => {
  cleanup();
});

describe("CapabilitiesWorkspace active boundary during navigation", () => {
  it("does not trigger autoLoad or set editorLoading when active is false", async () => {
    const getAgentSpy = vi.fn().mockImplementation(async (id: string) => {
      return testAgent(id);
    });

    store.getState().resetForTests({
      ...api,
      getPermissions: vi.fn().mockResolvedValue(permissions),
      getAgent: getAgentSpy,
      getPersona: vi.fn(async (id: string) => testPersona(id)),
    });

    store.setState({
      page: "settings",
      settingsView: "workspace",
      settingsRoute: "memory-tools",
      agents: [testAgent("a1")],
      editorAgentId: "a1",
      pageEditor: null,
      editorLoading: false,
      reloadMemory: vi.fn().mockResolvedValue(undefined),
    });

    render(<CapabilitiesWorkspace active={false} />);
    await act(async () => {});

    expect(getAgentSpy).toHaveBeenCalledTimes(0);
    expect(store.getState().editorLoading).toBe(false);
    expect(navigationBusy(store.getState())).toBe(false);
  });

  it("triggers autoLoad exactly once when active is true", async () => {
    const getAgentSpy = vi.fn().mockImplementation(async (id: string) => {
      return testAgent(id);
    });

    store.getState().resetForTests({
      ...api,
      getPermissions: vi.fn().mockResolvedValue(permissions),
      getAgent: getAgentSpy,
      getPersona: vi.fn(async (id: string) => testPersona(id)),
    });

    store.setState({
      page: "settings",
      settingsView: "workspace",
      settingsRoute: "memory-tools",
      agents: [testAgent("a1")],
      editorAgentId: "a1",
      pageEditor: null,
      editorLoading: false,
      reloadMemory: vi.fn().mockResolvedValue(undefined),
    });

    render(<CapabilitiesWorkspace active={true} />);
    await act(async () => {});

    expect(getAgentSpy).toHaveBeenCalledTimes(1);
    expect(store.getState().editorLoading).toBe(false);
    expect(store.getState().pageEditor?.agent.id).toBe("a1");
    expect(store.getState().error).toBeNull();
  });

  it("switching routes while inactive does not initiate spurious agent requests", async () => {
    const getAgentSpy = vi.fn().mockImplementation(async (id: string) => {
      return testAgent(id);
    });

    store.getState().resetForTests({
      ...api,
      getPermissions: vi.fn().mockResolvedValue(permissions),
      getAgent: getAgentSpy,
      getPersona: vi.fn(async (id: string) => testPersona(id)),
    });

    store.setState({
      page: "settings",
      settingsView: "workspace",
      settingsRoute: "memory-tools",
      agents: [testAgent("a1")],
      editorAgentId: "a1",
      pageEditor: null,
      editorLoading: false,
      reloadMemory: vi.fn().mockResolvedValue(undefined),
    });

    const { rerender } = render(<CapabilitiesWorkspace active={false} />);
    await act(async () => {});

    store.setState({ settingsRoute: "knowledge-tools" });
    rerender(<CapabilitiesWorkspace active={false} />);
    await act(async () => {});

    expect(getAgentSpy).toHaveBeenCalledTimes(0);
    expect(store.getState().editorLoading).toBe(false);
  });

  it("retains the loaded editor across five inactive route changes without locking navigation", async () => {
    const getAgent = vi.fn(async (id: string) => testAgent(id));
    store.getState().resetForTests({
      ...api,
      getAgent,
      getPersona: vi.fn(async (id: string) => testPersona(id)),
      getPermissions: vi.fn().mockResolvedValue(permissions),
    });
    store.setState({
      page: "settings",
      settingsView: "workspace",
      settingsRoute: "memory-tools",
      agents: [testAgent("a1")],
      editorAgentId: "a1",
      reloadMemory: vi.fn().mockResolvedValue(undefined),
    });
    const { rerender } = render(<CapabilitiesWorkspace active />);
    await act(async () => {});
    const editor = store.getState().pageEditor;
    expect(editor?.agent.id).toBe("a1");
    for (let cycle = 0; cycle < 5; cycle++) {
      rerender(<CapabilitiesWorkspace active={false} />);
      await act(async () => {
        store.getState().openSettingsRoute("scheme-library");
      });
      expect(navigationBusy(store.getState())).toBe(false);
      expect(store.getState().settingsRoute).toBe("scheme-library");
      await act(async () => {
        store.getState().openSettingsRoute("memory-tools");
      });
      rerender(<CapabilitiesWorkspace active />);
      await act(async () => {});
      expect(store.getState().pageEditor).toBe(editor);
      expect(store.getState().error).toBeNull();
    }
    expect(getAgent).toHaveBeenCalledTimes(1);
  });

  it("does not start nested knowledge or web reads when a loaded editor is inactive", async () => {
    const getPermissions = vi.fn().mockResolvedValue(permissions);
    store.getState().resetForTests({ ...api, getPermissions });
    const readKnowledge = vi.fn().mockResolvedValue(undefined);
    const readModel = vi.fn().mockResolvedValue(undefined);
    const readWeb = vi.fn().mockResolvedValue(undefined);
    const agent = testAgent("a1");
    store.setState({
      page: "settings",
      settingsView: "workspace",
      settingsRoute: "knowledge-tools",
      agents: [agent],
      editorAgentId: agent.id,
      pageEditor: newPageEditor(agent, testPersona(agent.id)),
      loadKnowledgeRead: readKnowledge,
      loadKnowledgeModel: readModel,
      loadWebAccess: readWeb,
    });
    const { rerender } = render(<CapabilitiesWorkspace active={false} />);
    await act(async () => {});
    expect(readKnowledge).not.toHaveBeenCalled();
    expect(readModel).not.toHaveBeenCalled();
    await act(async () => {
      store.setState({ settingsRoute: "web-access" });
    });
    rerender(<CapabilitiesWorkspace active={false} />);
    await act(async () => {});
    expect(readWeb).not.toHaveBeenCalled();
    expect(getPermissions).not.toHaveBeenCalled();
    rerender(<CapabilitiesWorkspace active />);
    await act(async () => {});
    expect(readWeb).toHaveBeenCalledTimes(1);
    expect(getPermissions).toHaveBeenCalledTimes(1);
    expect(navigationBusy(store.getState())).toBe(false);
  });
});
