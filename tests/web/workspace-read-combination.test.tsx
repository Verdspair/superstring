import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentResponse, PersonaResponse } from "../../src/shared/contracts";
import { MemoryLibrary } from "../../src/web/screens/library/MemoryLibrary";
import { navigationBusy } from "../../src/web/state/unsaved-changes";
import { useSuperstringStore as store } from "../../src/web/store";
import { A, agent, B, persona, setupLibrary } from "./helpers/library-fixture";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function agentValue(id: string, name: string): AgentResponse {
  return { ...agent, id, name };
}

function personaValue(id: string): PersonaResponse {
  return { ...persona, id: `persona-${id}`, agent_id: id };
}

function leaveEditorUnloaded() {
  store.setState({
    settingsRoute: "long-memory",
    agents: [agentValue(A, "Agent A"), agentValue(B, "Agent B")],
    editorAgentId: A,
    pageEditor: null,
    editorDraft: null,
    persona: null,
    editorLoading: false,
    dirty: false,
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("workspace reads with real navigation", () => {
  it("discards late A and B reads across actual A → B → A selection", async () => {
    const reads: Array<{ id: string; result: ReturnType<typeof deferred<AgentResponse>> }> = [];
    const getAgent = vi.fn((id: string) => {
      const result = deferred<AgentResponse>();
      reads.push({ id, result });
      return result.promise;
    });
    setupLibrary({
      getAgent,
      getPersona: vi.fn(async (id: string) => personaValue(id)),
    });
    leaveEditorUnloaded();
    render(<MemoryLibrary active />);
    await act(async () => {});
    expect(getAgent).toHaveBeenCalledTimes(1);
    expect(reads.map((read) => read.id)).toEqual([A]);

    const selector = screen.getAllByRole("combobox")[0];
    fireEvent.change(selector, { target: { value: B } });
    expect(getAgent).toHaveBeenCalledTimes(2);
    fireEvent.change(selector, { target: { value: A } });
    expect(getAgent).toHaveBeenCalledTimes(3);
    expect(reads.map((read) => read.id)).toEqual([A, B, A]);
    expect(navigationBusy(store.getState())).toBe(false);

    await act(async () => {
      reads[2].result.resolve(agentValue(A, "Newest Agent A"));
      await reads[2].result.promise;
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(store.getState().pageEditor?.agent.name).toBe("Newest Agent A");
    expect(store.getState().persona?.agent_id).toBe(A);
    expect(store.getState().editorDraft?.name).toBe("Newest Agent A");

    await act(async () => {
      reads[1].result.resolve(agentValue(B, "Late Agent B"));
      await reads[1].result.promise;
      await Promise.resolve();
      await Promise.resolve();
      reads[0].result.resolve(agentValue(A, "Old Agent A"));
      await reads[0].result.promise;
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(store.getState().editorAgentId).toBe(A);
    expect(store.getState().pageEditor?.agent.name).toBe("Newest Agent A");
    expect(store.getState().editorDraft?.name).toBe("Newest Agent A");
    expect(store.getState().persona?.agent_id).toBe(A);
    expect(store.getState().settingsRoute).toBe("long-memory");
    expect(navigationBusy(store.getState())).toBe(false);
  });

  it("does not read while hidden and resumes with one initial Agent read", async () => {
    const getAgent = vi.fn(async (id: string) => agentValue(id, `Agent ${id}`));
    const apiClient = setupLibrary({
      getAgent,
      getPersona: vi.fn(async (id: string) => personaValue(id)),
    });
    leaveEditorUnloaded();
    const listMemoryScopes = vi.spyOn(apiClient, "listMemoryScopes");
    const { rerender } = render(<MemoryLibrary active={false} />);
    await act(async () => {});
    expect(getAgent).not.toHaveBeenCalled();
    expect(listMemoryScopes).not.toHaveBeenCalled();

    rerender(<MemoryLibrary active />);
    await act(async () => {});
    expect(getAgent).toHaveBeenCalledTimes(1);
    expect(listMemoryScopes).toHaveBeenCalledTimes(1);
    expect(store.getState().pageEditor?.agent.id).toBe(A);
  });

  it("keeps unsaved drafts and real writes protected while ordinary reads do not lock navigation", () => {
    const client = setupLibrary();
    leaveEditorUnloaded();
    store.setState({
      pageEditor: null,
      editorLoading: true,
      knowledgeReadLoading: true,
      knowledgeModelLoading: true,
    });
    expect(navigationBusy(store.getState())).toBe(false);
    store.setState({
      editorLoading: false,
      knowledgeReadLoading: false,
      knowledgeModelLoading: false,
    });
    render(<MemoryLibrary active={false} />);
    const agentSelector = screen.getAllByRole("combobox")[0];

    store.setState({ dirty: true });
    fireEvent.change(agentSelector, { target: { value: B } });
    expect(store.getState().editorAgentId).toBe(A);
    expect(store.getState().pendingNavigation).toEqual({ kind: "agent", id: B });
    expect(store.getState().navigationConfirmOpen).toBe(true);

    store.setState({
      dirty: false,
      pendingNavigation: null,
      navigationConfirmOpen: false,
      qqSchemeSaving: true,
    });
    fireEvent.change(agentSelector, { target: { value: B } });
    expect(store.getState().editorAgentId).toBe(A);
    expect(store.getState().pendingNavigation).toBeNull();
    expect(navigationBusy(store.getState())).toBe(true);
    expect(client.getAgent).not.toHaveBeenCalled();
  });
});
