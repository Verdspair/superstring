import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentResponseSchema,
  PersonaResponseSchema,
  UpdateAgentRequestSchema,
} from "../../src/shared/contracts";
import { AgentKnowledgeReadUpdateSchema } from "../../src/shared/contracts/knowledge";
import { ApiError, type SuperstringApi } from "../../src/web/api";
import { DesignSystemProvider } from "../../src/web/design-system/Providers";
import { newPageEditor } from "../../src/web/features/agents/page-drafts";
import { selectLocale } from "../../src/web/i18n";
import { AgentMaterials } from "../../src/web/screens/assistants/AgentMaterials";
import { AssistantWorkspace } from "../../src/web/screens/assistants/AssistantWorkspace";
import { ModelPurposes } from "../../src/web/screens/environment/ModelPurposes";
import { KnowledgeLibrary } from "../../src/web/screens/library/KnowledgeLibrary";
import { useSuperstringStore as store } from "../../src/web/store";
import { document as libraryDocument } from "./helpers/library-fixture";

let saved = AgentResponseSchema.parse({
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
let client: SuperstringApi;
beforeEach(async () => {
  await selectLocale("zh-CN");
  saved = {
    ...saved,
    config_version: 1,
    p5_config: { ...saved.p5_config, memory_read: undefined, retrieval_mode: "full_catalog" },
  };
  client = {
    getAgentKnowledgeRead: vi.fn(async () => ({
      revision: 1,
      config: { enabled: true, context_budget: null, scope: "all", document_ids: [] },
    })),
    listAgentKnowledge: vi.fn(async () => []),
    getKnowledgeSettings: vi.fn(async () => ({
      revision: 3,
      context_budget: 8192,
      model_name: null,
      auto_enabled: true,
    })),
    updateAgent: vi.fn(async (_id, body) => {
      const patch = UpdateAgentRequestSchema.parse(body);
      saved = { ...saved, ...patch, config_version: saved.config_version + 1 };
      return saved;
    }),
    saveAgentKnowledgeRead: vi.fn(async (_id, body) => {
      const parsed = AgentKnowledgeReadUpdateSchema.parse(body);
      return { revision: parsed.expected_revision + 1, config: parsed.config };
    }),
  } as unknown as SuperstringApi;
  store.getState().resetForTests(client);
  store.setState({
    page: "settings",
    settingsView: "workspace",
    settingsRoute: "memory-tools",
    agents: [saved],
    editorAgentId: "A",
    pageEditor: newPageEditor(saved, persona),
    modelNames: ["model"],
  });
});
afterEach(cleanup);
describe("Agent materials complete task", () => {
  it("saves the full shared knowledge integer range while preserving inherited and unrelated drafts", async () => {
    vi.mocked(client.getKnowledgeSettings).mockResolvedValue({
      revision: 3,
      context_budget: 2097152,
      model_name: null,
      auto_enabled: true,
    });
    render(<AssistantWorkspace active />, { wrapper: DesignSystemProvider });
    await waitFor(() => expect(screen.getByText(/已保存的全局读取额度：2097152/)).toBeTruthy());
    expect(store.getState().knowledgeReadEditor?.draft.context_budget).toBeNull();
    const inherit = screen.getByRole("checkbox", { name: "跟随全局默认额度 (继承)" });
    fireEvent.click(inherit);
    expect(screen.getByTestId("reading-knowledge-agent-budget-input")).toHaveProperty(
      "value",
      "2097152",
    );
    act(() => store.getState().patchPageAgent("basic", { description: "Other task draft" }));
    for (const budget of [2097153, Number.MAX_SAFE_INTEGER]) {
      fireEvent.change(screen.getByTestId("reading-knowledge-agent-budget-input"), {
        target: { value: String(budget) },
      });
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "保存 Agent" })));
      expect(client.saveAgentKnowledgeRead).toHaveBeenLastCalledWith("A", {
        expected_revision: budget === 2097153 ? 1 : 2,
        config: { enabled: true, context_budget: budget, scope: "all", document_ids: [] },
      });
      expect(store.getState().knowledgeReadEditor?.source.config.context_budget).toBe(budget);
    }
    fireEvent.click(inherit);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "保存 Agent" })));
    expect(client.saveAgentKnowledgeRead).toHaveBeenLastCalledWith("A", {
      expected_revision: 3,
      config: { enabled: true, context_budget: null, scope: "all", document_ids: [] },
    });
    expect(client.updateAgent).not.toHaveBeenCalled();
    expect(store.getState().pageEditor?.draft.description).toBe("Other task draft");
    expect(store.getState().settingsTaskDirty("materials")).toBe(false);
    expect(store.getState().settingsTaskDirty("identity")).toBe(true);
  });
  it("retains invalid knowledge raw input and the memory cap without saving either domain", async () => {
    render(<AssistantWorkspace active />, { wrapper: DesignSystemProvider });
    await waitFor(() => expect(store.getState().knowledgeReadEditor).not.toBeNull());
    fireEvent.click(screen.getByRole("checkbox", { name: "跟随全局默认额度 (继承)" }));
    const input = screen.getByTestId("reading-knowledge-agent-budget-input");
    for (const raw of ["9007199254740992", "1.5", "0", ""]) {
      fireEvent.change(input, { target: { value: raw } });
      expect(input).toHaveProperty("value", raw);
      expect(input.getAttribute("aria-invalid")).toBe("true");
      expect(store.getState().knowledgeReadEditor?.draft.context_budget).toBe(8192);
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "保存 Agent" })));
      expect(client.saveAgentKnowledgeRead).not.toHaveBeenCalled();
      expect(client.updateAgent).not.toHaveBeenCalled();
    }
    fireEvent.change(input, { target: { value: "2097152" } });
    const memory = screen.getByLabelText("记忆工具读取额度");
    fireEvent.change(memory, { target: { value: "1048577" } });
    expect(memory).toHaveProperty("value", "1048577");
    expect(memory.getAttribute("aria-invalid")).toBe("true");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "保存 Agent" })));
    expect(client.saveAgentKnowledgeRead).not.toHaveBeenCalled();
    expect(client.updateAgent).not.toHaveBeenCalled();
    expect(store.getState().knowledgeReadEditor?.draft.context_budget).toBe(2097152);
  });
  it("binds repeated document names and inheritance labels to unique real controls without double toggle", async () => {
    const config = {
      enabled: true,
      context_budget: null,
      scope: "selected" as const,
      document_ids: [],
    };
    const docs = [
      { id: "D1", name: "Same document", summary: "First summary" },
      { id: "D2", name: "Same document", summary: "Second summary" },
    ];
    vi.mocked(client.getAgentKnowledgeRead).mockResolvedValue({ revision: 1, config });
    vi.mocked(client.listAgentKnowledge).mockResolvedValue(
      docs as Awaited<ReturnType<SuperstringApi["listAgentKnowledge"]>>,
    );
    const view = render(
      <>
        <AgentMaterials />
        <AgentMaterials />
      </>,
      { wrapper: DesignSystemProvider },
    );
    await waitFor(() => expect(store.getState().knowledgeReadEditor?.documents).toHaveLength(2));
    const controls = screen.getAllByRole("checkbox", { name: "Same document" });
    for (const panel of screen.getAllByTestId("agent-materials")) {
      const memoryControl = within(panel).getByRole("checkbox", { name: "允许按需读取长期记忆" });
      const knowledgeControl = within(panel).getByRole("checkbox", { name: "启用知识读取" });
      expect(memoryControl.closest(".settings-content-padding")).toBeTruthy();
      expect(knowledgeControl.closest(".settings-content-padding")).toBeTruthy();
    }
    expect(new Set(controls.map((control) => control.id)).size).toBe(controls.length);
    const labels = [...view.container.querySelectorAll<HTMLLabelElement>("label[for]")].filter(
      (label) => label.textContent?.includes("Same document"),
    );
    expect(labels).toHaveLength(4);
    labels.forEach((label) => {
      expect(label.control?.id).toBe(label.htmlFor);
    });
    await userEvent.click(labels[0]);
    expect(store.getState().knowledgeReadEditor?.draft.document_ids).toEqual(["D1"]);
    controls[1].focus();
    await userEvent.keyboard(" ");
    expect(store.getState().knowledgeReadEditor?.draft.document_ids).toEqual(["D1", "D2"]);
    act(() => store.setState({ settingsSaving: true }));
    await userEvent.click(labels[0]);
    expect(store.getState().knowledgeReadEditor?.draft.document_ids).toEqual(["D1", "D2"]);
    const inheritLabels = [
      ...view.container.querySelectorAll<HTMLLabelElement>("label[for]"),
    ].filter((label) => label.textContent?.includes("跟随全局"));
    expect(inheritLabels.length).toBeGreaterThan(0);
    expect(new Set(inheritLabels.map((label) => label.htmlFor)).size).toBe(inheritLabels.length);
    inheritLabels.forEach((label) => {
      expect(label.control?.getAttribute("role")).toBe("checkbox");
    });
  });
  it("global knowledge settings cancel while hidden and revalidate once without losing a dirty model draft", async () => {
    let hidden = false;
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() =>
      hidden ? "hidden" : "visible",
    );
    store.setState({
      contextAllocationTarget: { purpose: "reading", agentId: null },
      settingsRoute: "context-allocation",
    });
    render(<ModelPurposes active />, { wrapper: DesignSystemProvider });
    await waitFor(() => expect(store.getState().knowledgeModelEditor?.source.revision).toBe(3));
    store.getState().patchKnowledgeGlobal({ contextBudget: 6000 });
    hidden = true;
    fireEvent(document, new Event("visibilitychange"));
    hidden = false;
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() => expect(client.getKnowledgeSettings).toHaveBeenCalledTimes(2));
    expect(store.getState().knowledgeModelEditor?.contextBudget).toBe(6000);
    fireEvent(window, new Event("blur"));
    fireEvent(window, new Event("focus"));
    expect(client.getKnowledgeSettings).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
  });
  it("library resumes its actual editor and rebases untouched fields while preserving the dirty original text", async () => {
    let hidden = false;
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() =>
      hidden ? "hidden" : "visible",
    );
    const docFixture = {
      ...libraryDocument,
      id: "D",
      name: "Old title",
      original_text: "Old original",
      revision: 1,
    };
    const getKnowledgeDocument = vi
      .fn()
      .mockResolvedValueOnce(docFixture)
      .mockResolvedValueOnce({ ...docFixture, name: "Fresh title", revision: 2 });
    store.setState({
      settingsRoute: "knowledge-config",
      apiClient: {
        ...client,
        getKnowledgeDocument,
        listKnowledgeDocuments: vi.fn(async () => ({ items: [], total: 0, next_cursor: null })),
        listKnowledgeCategories: vi.fn(async () => []),
      },
    });
    await store.getState().openKnowledgeEditor({ kind: "document", id: "D" });
    const editor = store.getState().knowledgeEditor;
    if (editor?.kind !== "document") throw new Error("missing document editor");
    store.getState().updateKnowledgeEditor({ ...editor, original_text: "User draft" });
    render(<KnowledgeLibrary active />, { wrapper: DesignSystemProvider });
    hidden = true;
    fireEvent(window.document, new Event("visibilitychange"));
    hidden = false;
    fireEvent(window.document, new Event("visibilitychange"));
    await waitFor(() => expect(getKnowledgeDocument).toHaveBeenCalledTimes(2));
    expect(store.getState().knowledgeEditor).toMatchObject({
      kind: "document",
      name: "Fresh title",
      original_text: "User draft",
      source: { revision: 2 },
    });
    expect(store.getState().knowledgeDirty).toBe(true);
    vi.restoreAllMocks();
  });
  it("cancels document-hidden reads, preserves drafts, resumes once and ignores visible blur", async () => {
    let hidden = false;
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() =>
      hidden ? "hidden" : "visible",
    );
    let signal!: AbortSignal;
    vi.mocked(client.getAgentKnowledgeRead).mockImplementationOnce(async (_id, input) => {
      signal = input!;
      return new Promise(() => {});
    });
    render(<AssistantWorkspace active />, { wrapper: DesignSystemProvider });
    await waitFor(() => expect(signal).toBeTruthy());
    fireEvent(window, new Event("blur"));
    expect(signal.aborted).toBe(false);
    hidden = true;
    fireEvent(document, new Event("visibilitychange"));
    expect(signal.aborted).toBe(true);
    expect(store.getState().knowledgeReadEditor).toBeNull();
    hidden = false;
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() => expect(client.getAgentKnowledgeRead).toHaveBeenCalledTimes(2));
    fireEvent(window, new Event("focus"));
    expect(client.getAgentKnowledgeRead).toHaveBeenCalledTimes(2);
    vi.restoreAllMocks();
  });
  it("presents on-demand settings without old tier controls and saves with raw values retained", async () => {
    render(<AssistantWorkspace active />, { wrapper: DesignSystemProvider });
    await waitFor(() => expect(client.getKnowledgeSettings).toHaveBeenCalledTimes(1));
    expect(screen.queryByText("full_catalog")).toBeNull();
    expect(screen.queryByLabelText("每次查询候选条数上限")).toBeNull();
    fireEvent.change(screen.getByLabelText("记忆工具读取额度"), { target: { value: "2048" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "保存 Agent" })));
    expect(client.updateAgent).toHaveBeenCalledTimes(1);
    const body = UpdateAgentRequestSchema.parse(vi.mocked(client.updateAgent).mock.calls[0][1]);
    expect(body.p5_config?.memory_read).toEqual({ enabled: true, max_bytes: 2048 });
    expect(body.p5_config?.retrieval_mode).toBe("full_catalog");
    expect(store.getState().settingsTaskDirty("materials")).toBe(false);
  });
  it("inherits saved global bytes, not an unsaved global draft, and retries only failed endpoint", async () => {
    store.setState({
      knowledgeModelEditor: {
        token: {},
        source: { revision: 3, context_budget: 8192, model_name: null, auto_enabled: true },
        contextBudget: 64000,
        modelName: null,
      },
    });
    render(<AssistantWorkspace active />, { wrapper: DesignSystemProvider });
    await waitFor(() => expect(screen.getByText(/已保存的全局读取额度：8192/)).toBeTruthy());
    act(() => store.getState().patchKnowledgeRead({ enabled: false }));
    fireEvent.click(screen.getByRole("checkbox", { name: "跟随全局默认额度 (继承)" }));
    fireEvent.change(screen.getByTestId("reading-knowledge-agent-budget-input"), {
      target: { value: "2097152" },
    });
    fireEvent.change(screen.getByLabelText("记忆工具读取额度"), { target: { value: "4096" } });
    vi.mocked(client.saveAgentKnowledgeRead).mockRejectedValueOnce(
      new ApiError(409, "KNOWLEDGE_REVISION_CONFLICT", "conflict"),
    );
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "保存 Agent" })));
    expect(client.updateAgent).toHaveBeenCalledTimes(1);
    expect(store.getState().settingsTaskDirty("materials")).toBe(true);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "保存 Agent" })));
    expect(client.updateAgent).toHaveBeenCalledTimes(1);
    expect(client.saveAgentKnowledgeRead).toHaveBeenCalledTimes(2);
    expect(vi.mocked(client.saveAgentKnowledgeRead).mock.calls.map(([, body]) => body)).toEqual([
      {
        expected_revision: 1,
        config: { enabled: false, context_budget: 2097152, scope: "all", document_ids: [] },
      },
      {
        expected_revision: 1,
        config: { enabled: false, context_budget: 2097152, scope: "all", document_ids: [] },
      },
    ]);
    expect(store.getState().knowledgeReadEditor?.source.revision).toBe(2);
    expect(store.getState().settingsTaskDirty("materials")).toBe(false);
    expect(store.getState().knowledgeModelEditor?.contextBudget).toBe(64000);
  });
});

describe("materials saved baseline review", () => {
  it.each(["zh-CN", "en"] as const)(
    "separates saved document names and allowance from the local draft in %s",
    async (locale) => {
      selectLocale(locale);
      const first = {
        enabled: true,
        context_budget: null,
        scope: "selected" as const,
        document_ids: [] as string[],
      };
      const latest = {
        enabled: true,
        context_budget: null,
        scope: "selected" as const,
        document_ids: ["D2", "unknown-saved-id"],
      };
      vi.mocked(client.getAgentKnowledgeRead)
        .mockResolvedValueOnce({ revision: 1, config: first })
        .mockResolvedValue({ revision: 2, config: latest });
      vi.mocked(client.listAgentKnowledge).mockResolvedValue([
        { ...libraryDocument, id: "D1", name: "Local handbook" },
        { ...libraryDocument, id: "D2", name: "Remote handbook" },
      ]);
      client.getAgent = vi.fn(async () => saved);
      client.getPersona = vi.fn(async () => persona);
      render(<AssistantWorkspace active />, { wrapper: DesignSystemProvider });
      await waitFor(() => expect(store.getState().knowledgeReadEditor?.source.revision).toBe(1));
      act(() =>
        store
          .getState()
          .patchKnowledgeRead({ enabled: false, context_budget: 1234, document_ids: ["D1"] }),
      );
      const refresh = screen.getByRole("button", {
        name: locale === "zh-CN" ? "刷新保存基线" : "Refresh saved baseline",
      });
      await act(async () => fireEvent.click(refresh));
      await waitFor(() => expect(store.getState().knowledgeReadEditor?.source.revision).toBe(2));
      const baseline = screen.getByRole("region", {
        name: locale === "zh-CN" ? "已读取的保存基线" : "Loaded saved baseline",
      });
      expect(within(baseline).getByText("Remote handbook")).toBeTruthy();
      expect(baseline.textContent).toContain(
        locale === "zh-CN" ? "未在当前授权列表中找到名称" : "Name unavailable",
      );
      expect(baseline.textContent).toContain("unknown-saved-id");
      expect(baseline.textContent).toContain("8192 Bytes");
      expect(baseline.textContent).toContain(locale === "zh-CN" ? "已启用" : "Enabled");
      expect(baseline.textContent).not.toMatch(/context_budget|document_ids|"scope"/);
      expect(baseline.textContent).not.toContain("1234");
      expect(store.getState().knowledgeReadEditor?.draft.context_budget).toBe(1234);
      expect(store.getState().knowledgeReadEditor?.draft.document_ids).toEqual(["D1"]);
      expect(
        screen.getByRole("heading", { name: locale === "zh-CN" ? "本地编辑草稿" : "Local draft" }),
      ).toBeTruthy();
      expect(store.getState().feedback).not.toContain("document_ids");
      expect(client.saveAgentKnowledgeRead).not.toHaveBeenCalled();
      expect(client.updateAgent).not.toHaveBeenCalled();
    },
  );
});

it("does not duplicate clean knowledge settings and compares only a changed allowance", async () => {
  render(<AgentMaterials active />, { wrapper: DesignSystemProvider });
  await waitFor(() => expect(store.getState().knowledgeReadEditor).not.toBeNull());
  expect(screen.queryByRole("region", { name: "已读取的保存基线" })).toBeNull();
  expect(screen.queryByRole("heading", { name: "本地编辑草稿" })).toBeNull();
  act(() => store.getState().patchKnowledgeRead({ context_budget: 1234 }));
  const baseline = screen.getByRole("region", { name: "已读取的保存基线" });
  expect(baseline.textContent).toContain("8192 Bytes");
  expect(baseline.textContent).not.toContain("启用知识读取");
  expect(baseline.textContent).not.toContain("读取范围");
  act(() => store.getState().discardKnowledgeRead({ preserveBaseline: true }));
  expect(screen.queryByRole("region", { name: "已读取的保存基线" })).toBeNull();
  expect(client.saveAgentKnowledgeRead).not.toHaveBeenCalled();
});
