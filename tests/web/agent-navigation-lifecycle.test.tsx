import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentResponseSchema } from "../../src/shared/contracts";
import { api, type SuperstringApi } from "../../src/web/api";
import { AssistantWorkspace } from "../../src/web/screens/assistants/AssistantWorkspace";
import { navigationBusy } from "../../src/web/state/unsaved-changes";
import { useSuperstringStore as store } from "../../src/web/store";
import { agent, persona } from "./helpers/library-fixture";

afterEach(() => {
  vi.restoreAllMocks();
});
function setup(overrides: Partial<SuperstringApi> = {}) {
  store.getState().resetForTests({
    ...api,
    getAgent: vi.fn().mockResolvedValue(agent),
    getPersona: vi.fn().mockResolvedValue(persona),
    ...overrides,
  });
  store.setState({
    page: "settings",
    settingsView: "workspace",
    settingsRoute: "basic",
    agents: [agent],
    editorAgentId: agent.id,
  });
}
describe("Agent navigation read ownership", () => {
  it("settles the ready editor without waiting for unrelated memory maintenance reads", async () => {
    setup();
    let release!: () => void;
    const memory = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reloadMemory = vi.fn(() => memory);
    store.setState({ reloadMemory });
    const editing = store.getState().editAgent(agent.id);
    await act(async () => {});
    expect(store.getState().pageEditor?.agent.id).toBe(agent.id);
    const blocked = navigationBusy(store.getState());
    release();
    await editing;
    expect(blocked).toBe(false);
    expect(reloadMemory).toHaveBeenCalledTimes(1);
    store.getState().openSettingsRoute("scheme-library");
    expect(store.getState().settingsRoute).toBe("scheme-library");
  });
  it("leaves for the scheme library during a pending Agent read and rejects its late editor", async () => {
    let resolve!: (value: typeof agent) => void;
    setup({
      getAgent: () =>
        new Promise((done) => {
          resolve = done;
        }),
    });
    store.setState({ pageEditor: null });
    const editing = store.getState().editAgent(agent.id);
    expect(store.getState().editorLoading).toBe(true);
    expect(navigationBusy(store.getState())).toBe(false);
    store.getState().openSettingsRoute("scheme-library");
    expect(store.getState().settingsRoute).toBe("scheme-library");
    resolve(agent);
    await editing;
    expect(store.getState().settingsRoute).toBe("scheme-library");
    expect(store.getState().pageEditor).toBeNull();
    expect(store.getState().editorLoading).toBe(false);
    expect(navigationBusy(store.getState())).toBe(false);
  });
  it("releases editor loading and preserves the failure when persona reading fails", async () => {
    setup({ getPersona: vi.fn().mockRejectedValue(new Error("persona unavailable")) });
    expect(await store.getState().editAgent(agent.id)).toBe(false);
    expect(store.getState().editorLoading).toBe(false);
    expect(store.getState().error).toBe("persona unavailable");
  });
});
describe("Assistant workspace create regression", () => {
  afterEach(() => {
    cleanup();
  });
  it("keeps a continued editor after creating an agent through the real create form", async () => {
    const createdId = "66666666-6666-4666-8666-666666666666";
    const saved = AgentResponseSchema.parse({
      ...agent,
      id: createdId,
      name: "新建助手",
      description: "来自创建表单",
      config_version: 1,
      created_at: "2026-10-14T00:00:00.000Z",
      updated_at: "2026-10-14T00:00:00.000Z",
    });
    const savedPersona = { ...persona, agent_id: createdId };
    const createAgent = vi.fn().mockResolvedValue(saved);
    const client = {
      ...api,
      getAgent: vi
        .fn()
        .mockImplementation(async (id: string) => (id === createdId ? saved : { ...agent, id })),
      getPersona: vi.fn().mockResolvedValue(savedPersona),
      createAgent,
    };
    store.getState().resetForTests(client);
    store.setState({
      page: "settings",
      settingsView: "workspace",
      settingsRoute: "basic",
      agents: [agent],
      editorAgentId: agent.id,
      pageEditor: null,
      modelNames: ["model-a"],
      reloadMemory: vi.fn().mockResolvedValue(undefined),
    });
    render(<AssistantWorkspace active={true} />);
    fireEvent.click(screen.getByRole("button", { name: "创建 Agent" }));
    await act(async () => {});
    expect(store.getState().editorAgentId).toBe("__new__");
    const nameInput = screen.getAllByDisplayValue("")[0];
    if (!(nameInput instanceof HTMLInputElement)) throw new Error("name input not found");
    fireEvent.change(nameInput, { target: { value: "新建助手" } });
    await act(async () => {});
    expect(createAgent).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "创建 Agent" }));
    await act(async () => {});
    expect(createAgent).toHaveBeenCalledTimes(1);
    expect(createAgent.mock.calls[0]?.[0]).toMatchObject({ name: "新建助手" });
    expect(store.getState().editorAgentId).toBe(createdId);
    expect(store.getState().editorDraft?.name).toBe("新建助手");
    expect(store.getState().feedback).toContain("已创建 Agent");
    expect(store.getState().pageEditor).not.toBeNull();
    expect(screen.queryByText("选择一个 Agent 以开始编辑。")).toBeNull();
    expect(screen.getByText("新建助手")).toBeTruthy();
  });
  it("does not fire extra queries on the create path", async () => {
    const createdId = "66666666-6666-4666-8666-666666666666";
    const saved = AgentResponseSchema.parse({
      ...agent,
      id: createdId,
      name: "新建助手",
      config_version: 1,
      created_at: "2026-10-14T00:00:00.000Z",
      updated_at: "2026-10-14T00:00:00.000Z",
    });
    const savedPersona = { ...persona, agent_id: createdId };
    const getAgent = vi.fn().mockImplementation(async (id: string) => ({ ...agent, id }));
    const getPersona = vi
      .fn()
      .mockImplementation(async (id: string) => (id === createdId ? savedPersona : persona));
    const reloadMemory = vi.fn().mockResolvedValue(undefined);
    store.getState().resetForTests({
      ...api,
      getAgent,
      getPersona,
      createAgent: vi.fn().mockResolvedValue(saved),
    });
    store.setState({
      page: "settings",
      settingsView: "workspace",
      settingsRoute: "basic",
      agents: [agent],
      editorAgentId: agent.id,
      pageEditor: null,
      modelNames: ["model-a"],
      reloadMemory,
    });
    await act(async () => {
      await store.getState().editAgent("__new__");
    });
    expect(store.getState().editorAgentId).toBe("__new__");
    await act(async () => {
      store.getState().patchDraft({ name: "新建助手" });
      await store.getState().saveCurrentSection();
    });
    expect(store.getState().editorAgentId).toBe(createdId);
    expect(getPersona).toHaveBeenCalledTimes(1);
    expect(getPersona).toHaveBeenCalledWith(createdId);
    expect(getAgent).toHaveBeenCalledTimes(0);
    expect(reloadMemory).toHaveBeenCalledTimes(0);
    expect(store.getState().pageEditor).not.toBeNull();
    expect(store.getState().persona?.agent_id).toBe(createdId);
  });

  it.each([
    { label: "newer navigation", kind: "navigate" as const },
    { label: "newer draft", kind: "draft" as const },
  ])("a delayed persona read after $label never clobbers the newer state", async ({ kind }) => {
    const createdId = "66666666-6666-4666-8666-666666666666";
    const saved = AgentResponseSchema.parse({
      ...agent,
      id: createdId,
      name: "新建助手",
      config_version: 1,
      created_at: "2026-10-14T00:00:00.000Z",
      updated_at: "2026-10-14T00:00:00.000Z",
    });
    const savedPersona = { ...persona, agent_id: createdId };
    let release!: () => void;
    const personaGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let personaStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      personaStarted = resolve;
    });
    const getPersona = vi.fn().mockImplementation(async (id: string) => {
      if (id !== createdId) return persona;
      personaStarted();
      await personaGate;
      return savedPersona;
    });
    const getAgent = vi.fn().mockImplementation(async (id: string) => ({ ...agent, id }));
    store.getState().resetForTests({
      ...api,
      getAgent,
      getPersona,
      createAgent: vi.fn().mockResolvedValue(saved),
    });
    store.setState({
      page: "settings",
      settingsView: "workspace",
      settingsRoute: "basic",
      agents: [agent],
      editorAgentId: agent.id,
      pageEditor: null,
      modelNames: ["model-a"],
      reloadMemory: vi.fn().mockResolvedValue(undefined),
    });
    await act(async () => {
      await store.getState().editAgent("__new__");
    });
    await act(async () => {
      store.getState().patchDraft({ name: "新建助手" });
    });
    const outcome = store
      .getState()
      .saveCurrentSection()
      .then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    await started;
    expect(store.getState().editorAgentId).toBe(createdId);
    if (kind === "navigate") {
      await act(async () => {
        await store.getState().editAgent(agent.id);
      });
      expect(store.getState().editorAgentId).toBe(agent.id);
      expect(store.getState().pageEditor?.agent.id).toBe(agent.id);
    } else {
      await act(async () => {
        store.getState().patchDraft({ description: "用户继续输入" });
      });
      expect(store.getState().editorDraft?.description).toBe("用户继续输入");
    }
    release();
    const settled = await outcome;
    expect(settled.ok).toBe(true);
    if (kind === "navigate") {
      expect(store.getState().editorAgentId).toBe(agent.id);
      expect(store.getState().pageEditor?.agent.id).toBe(agent.id);
      expect(store.getState().persona?.agent_id).toBe(agent.id);
    } else {
      expect(store.getState().editorAgentId).toBe(createdId);
      expect(store.getState().pageEditor).toBeNull();
      expect(store.getState().editorDraft?.description).toBe("用户继续输入");
      expect(store.getState().error).toBeNull();
    }
  });

  it("keeps the create committed on persona failure with an honest error and no retry", async () => {
    const createdId = "66666666-6666-4666-8666-666666666666";
    const saved = AgentResponseSchema.parse({
      ...agent,
      id: createdId,
      name: "新建助手",
      config_version: 1,
      created_at: "2026-10-14T00:00:00.000Z",
      updated_at: "2026-10-14T00:00:00.000Z",
    });
    const getAgent = vi.fn().mockImplementation(async (id: string) => ({ ...agent, id }));
    const getPersona = vi.fn().mockRejectedValue(new Error("persona unavailable"));
    const reloadMemory = vi.fn().mockResolvedValue(undefined);
    store.getState().resetForTests({
      ...api,
      getAgent,
      getPersona,
      createAgent: vi.fn().mockResolvedValue(saved),
    });
    store.setState({
      page: "settings",
      settingsView: "workspace",
      settingsRoute: "basic",
      agents: [agent],
      editorAgentId: agent.id,
      pageEditor: null,
      modelNames: ["model-a"],
      reloadMemory,
    });
    await act(async () => {
      await store.getState().editAgent("__new__");
    });
    await act(async () => {
      store.getState().patchDraft({ name: "新建助手" });
      await store.getState().saveCurrentSection();
    });
    expect(store.getState().editorAgentId).toBe(createdId);
    expect(store.getState().agents[0]?.id).toBe(createdId);
    expect(store.getState().feedback).toContain("已创建 Agent");
    expect(store.getState().error).toBe("persona unavailable");
    expect(store.getState().pageEditor).toBeNull();
    expect(getPersona).toHaveBeenCalledTimes(1);
    // 同一所有权策略：草稿在等待期间被继续编辑后，失败不得把陈旧错误写进新草稿。
    store.setState({
      agents: [agent],
      editorAgentId: agent.id,
      pageEditor: null,
      error: null,
      feedback: "",
      dirty: false,
    });
    await act(async () => {
      await store.getState().editAgent("__new__");
    });
    await act(async () => {
      store.getState().patchDraft({ name: "再次新建" });
    });
    let releaseSecond!: () => void;
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    let secondStarted!: () => void;
    const secondStartedPromise = new Promise<void>((resolve) => {
      secondStarted = resolve;
    });
    getPersona.mockImplementation(async (id: string) => {
      if (id !== createdId) return persona;
      secondStarted();
      await secondGate;
      throw new Error("persona unavailable");
    });
    const outcome = store
      .getState()
      .saveCurrentSection()
      .then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
    await secondStartedPromise;
    await act(async () => {
      store.getState().patchDraft({ description: "等待期间继续输入" });
    });
    releaseSecond();
    const settled = await outcome;
    expect(settled.ok).toBe(true);
    if (!settled.ok) throw new Error("create must stay committed");
    expect(store.getState().editorAgentId).toBe(createdId);
    expect(store.getState().editorDraft?.description).toBe("等待期间继续输入");
    expect(store.getState().error).toBeNull();
    expect(getPersona).toHaveBeenCalledTimes(2);
  });
});
