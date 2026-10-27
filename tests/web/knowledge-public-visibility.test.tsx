import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  KnowledgeCategory,
  KnowledgeDocumentDetail,
  KnowledgeSettings,
} from "../../src/shared/contracts/knowledge";
import { ApiError, api } from "../../src/web/api";
import { selectLocale } from "../../src/web/i18n";
import { KnowledgeLibrary } from "../../src/web/screens/library/KnowledgeLibrary";
import { useSuperstringStore as store } from "../../src/web/store";
import { A, agent, B } from "./helpers/library-fixture";
import { render } from "./helpers/render-with-providers";

const docId = "33333333-3333-4333-8333-333333333333";
const now = "2026-10-27T00:00:00.000Z";

const agentA = { ...agent, id: A, name: "Agent A" };
const agentB = { ...agent, id: B, name: "Agent B", model_name: "model-b" };

const docNull: KnowledgeDocumentDetail = {
  id: docId,
  category_id: "default",
  name: "历史未分类文档",
  import_type: "text",
  visibility: null,
  content_mode: "original",
  content_version: 1,
  revision: 3,
  created_at: now,
  updated_at: now,
  agent_ids: [A],
  summary: "未分类摘要",
  tags: [],
  organization_status: "succeeded",
  error_code: null,
  original_text: "原文",
  draft: null,
  content: {
    id: docId,
    source_type: "knowledge",
    content_origin: "original",
    name: "历史未分类文档",
    summary: "",
    tags: [],
    body: "原文",
    revision: "1",
    sources: [],
    validity: "valid",
  },
};

const docPublic: KnowledgeDocumentDetail = {
  ...docNull,
  id: "44444444-4444-4444-8444-444444444444",
  name: "公共资料文档",
  visibility: "public",
  agent_ids: [A, B],
};

const docPrivate: KnowledgeDocumentDetail = {
  ...docNull,
  id: "55555555-5555-4555-8555-555555555555",
  name: "私有资料文档",
  visibility: "private",
  agent_ids: [A],
};

const categories: KnowledgeCategory[] = [
  { id: "default", name: "默认分类", revision: 1, document_count: 3 },
];

const settings: KnowledgeSettings = {
  revision: 1,
  auto_enabled: true,
  model_name: null,
  context_budget: 2048,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  selectLocale("zh-CN");
  store.getState().resetForTests({
    ...api,
    listKnowledgeCategories: vi.fn().mockResolvedValue(categories),
    listKnowledgeDocuments: vi.fn().mockResolvedValue({
      items: [docNull, docPublic, docPrivate],
      next_cursor: null,
      total: 3,
    }),
    getKnowledgeDocument: vi.fn().mockImplementation(async (id: string) => {
      if (id === docPublic.id) return docPublic;
      if (id === docPrivate.id) return docPrivate;
      return docNull;
    }),
    saveKnowledgeGrants: vi
      .fn()
      .mockImplementation(async (id, revision, agent_ids, visibility) => ({
        ...docNull,
        id,
        revision: revision + 1,
        agent_ids,
        visibility: visibility ?? docNull.visibility,
      })),
    getKnowledgeSettings: vi.fn().mockResolvedValue(settings),
    saveKnowledgeSettings: vi.fn().mockResolvedValue(settings),
  });

  store.setState({
    page: "settings",
    settingsView: "knowledge",
    agents: [agentA, agentB],
    knowledgeCategories: categories,
    knowledgeDocuments: [docNull, docPublic, docPrivate],
    knowledgeSettings: settings,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  selectLocale("zh-CN");
});

describe("knowledge public visibility and grants management", () => {
  it("displays historical unclassified document as 历史未分类 and omits visibility if unchanged", async () => {
    render(<KnowledgeLibrary active={true} />);

    await store.getState().openKnowledgeEditor({ kind: "grants", id: docNull.id });

    // Classification select shows "历史未分类"
    const select = await screen.findByRole("combobox", { name: "资料管理分类" });
    expect(select).toHaveProperty("value", "unclassified");

    // Toggle Agent B checkbox in the recipient list
    const agentBCheckbox = screen.getByRole("checkbox", { name: "Agent B" });
    fireEvent.click(agentBCheckbox);

    // Save editor
    expect(await store.getState().saveKnowledgeEditor()).toBe(true);

    // Verified: visibility argument is omitted (undefined)
    expect(store.getState().apiClient.saveKnowledgeGrants).toHaveBeenCalledWith(
      docNull.id,
      3,
      [A, B],
      undefined,
    );
  });

  it("transitions null unclassified to explicit public with selected receivers and shows limitation notice", async () => {
    render(<KnowledgeLibrary active={true} />);

    await store.getState().openKnowledgeEditor({ kind: "grants", id: docNull.id });

    const select = await screen.findByRole("combobox", { name: "资料管理分类" });
    fireEvent.change(select, { target: { value: "public" } });

    // Limitation notice must be directly visible
    expect(
      screen.getByText(
        "公开分类仅作为资料库管理标记，仍需显式勾选授权接收助手；不自动通配新助手，公开不会授予原始私聊正文访问。",
      ),
    ).toBeTruthy();

    // Select Agent B
    const agentBCheckbox = screen.getByRole("checkbox", { name: "Agent B" });
    fireEvent.click(agentBCheckbox);

    expect(await store.getState().saveKnowledgeEditor()).toBe(true);

    expect(store.getState().apiClient.saveKnowledgeGrants).toHaveBeenCalledWith(
      docNull.id,
      3,
      [A, B],
      "public",
    );
  });

  it("transitions to private without secretly revoking existing grants", async () => {
    render(<KnowledgeLibrary active={true} />);

    await store.getState().openKnowledgeEditor({ kind: "grants", id: docPublic.id });

    const select = await screen.findByRole("combobox", { name: "资料管理分类" });
    expect(select).toHaveProperty("value", "public");

    // Switch classification to private
    fireEvent.change(select, { target: { value: "private" } });

    // Save without touching agent checkboxes
    expect(await store.getState().saveKnowledgeEditor()).toBe(true);

    // Verified: existing grants [A, B] are strictly retained in payload
    expect(store.getState().apiClient.saveKnowledgeGrants).toHaveBeenCalledWith(
      docPublic.id,
      3,
      [A, B],
      "private",
    );
  });

  it("preserves dirty draft and does not clear editor on 409 conflict", async () => {
    const conflictError = new ApiError(409, "KNOWLEDGE_REVISION_CONFLICT", "文档版本冲突");
    vi.mocked(store.getState().apiClient.saveKnowledgeGrants).mockRejectedValueOnce(conflictError);

    render(<KnowledgeLibrary active={true} />);

    await store.getState().openKnowledgeEditor({ kind: "grants", id: docNull.id });

    const select = await screen.findByRole("combobox", { name: "资料管理分类" });
    fireEvent.change(select, { target: { value: "public" } });

    const agentBCheckbox = screen.getByRole("checkbox", { name: "Agent B" });
    fireEvent.click(agentBCheckbox);

    expect(await store.getState().saveKnowledgeEditor()).toBe(false);

    // Dirty state and draft are strictly preserved
    expect(store.getState().knowledgeDirty).toBe(true);
    expect(store.getState().knowledgeEditor).toMatchObject({
      kind: "grants",
      visibility: "public",
      agent_ids: [A, B],
    });
  });

  it("discards late openKnowledgeEditor GET read response after leaving knowledge workspace", async () => {
    const pending = deferred<KnowledgeDocumentDetail>();
    vi.mocked(store.getState().apiClient.getKnowledgeDocument).mockReturnValue(pending.promise);

    const readPromise = store.getState().openKnowledgeEditor({ kind: "grants", id: docNull.id });

    // User navigates away before read resolves
    act(() => {
      store.setState({ page: "chat" });
      store.getState().discardKnowledgeEditor();
    });

    pending.resolve(docNull);
    await readPromise;

    expect(store.getState().knowledgeEditor).toBeNull();
  });

  it("discards late saveKnowledgeEditor resolve response when apiClient/editor changes, preserving new draft and not calling new api", async () => {
    const pendingSave = deferred<KnowledgeDocumentDetail>();
    vi.mocked(store.getState().apiClient.saveKnowledgeGrants).mockReturnValue(pendingSave.promise);

    await store.getState().openKnowledgeEditor({ kind: "grants", id: docNull.id });
    store.getState().updateKnowledgeEditor({
      kind: "grants",
      source: docNull,
      agent_ids: [A, B],
      visibility: "public",
    });

    // Start saving docNull (in-flight pending)
    const savePromise = store.getState().saveKnowledgeEditor();
    expect(store.getState().knowledgeBusy).toBe(true);

    // While save is in-flight: new editor is opened with a new dirty draft, and new API client is set
    const newApiClient = {
      ...api,
      listKnowledgeDocuments: vi.fn().mockResolvedValue({ items: [], next_cursor: null, total: 0 }),
    };
    const newDraftEditor = {
      kind: "document" as const,
      source: docPublic,
      name: "新草稿名称",
      category_id: "default",
      original_text: "新原文",
      content_mode: "draft" as const,
    };
    act(() => {
      store.setState({
        apiClient: newApiClient,
        knowledgeEditor: newDraftEditor,
        knowledgeDirty: true,
        knowledgeReadId: store.getState().knowledgeReadId + 1,
      });
    });

    // Old deferred save resolves late
    act(() => {
      pendingSave.resolve({ ...docNull, revision: 4, agent_ids: [A, B] });
    });
    const result = await savePromise;
    expect(result).toBe(false);

    // Assert: new draft is NOT cleared, new dirty is NOT reset, no feedback set, and newApiClient.listKnowledgeDocuments is NOT called
    expect(store.getState().knowledgeEditor).toEqual(newDraftEditor);
    expect(store.getState().knowledgeDirty).toBe(true);
    expect(store.getState().feedback).toBe("");
    expect(newApiClient.listKnowledgeDocuments).not.toHaveBeenCalled();
  });

  it("discards late saveKnowledgeEditor resolve for same document id after editor is reopened in new generation", async () => {
    const pendingSave1 = deferred<KnowledgeDocumentDetail>();
    vi.mocked(store.getState().apiClient.saveKnowledgeGrants).mockReturnValue(pendingSave1.promise);

    // Generation 1: open docNull and start save
    await store.getState().openKnowledgeEditor({ kind: "grants", id: docNull.id });
    const savePromise1 = store.getState().saveKnowledgeEditor();
    expect(store.getState().knowledgeBusy).toBe(true);

    // Re-open same document id in Generation 2 with new draft edits
    const gen2Draft = {
      kind: "grants" as const,
      source: docNull,
      agent_ids: [A, B],
      visibility: "public" as const,
    };
    act(() => {
      store.setState({
        knowledgeEditor: gen2Draft,
        knowledgeDirty: true,
        knowledgeBusy: false,
        knowledgeReadId: store.getState().knowledgeReadId + 1,
      });
    });

    // Generation 1 save resolves late
    act(() => {
      pendingSave1.resolve({ ...docNull, revision: 4, agent_ids: [A] });
    });
    const result1 = await savePromise1;
    expect(result1).toBe(false);

    // Generation 2 draft must NOT be cleared or overwritten
    expect(store.getState().knowledgeEditor).toEqual(gen2Draft);
    expect(store.getState().knowledgeDirty).toBe(true);
    expect(store.getState().feedback).toBe("");
  });

  it("discards late saveKnowledgeSettings resolve without polluting settings and without clearing new busy state", async () => {
    const pendingSettingsSave = deferred<KnowledgeSettings>();
    vi.mocked(store.getState().apiClient.saveKnowledgeSettings).mockReturnValue(
      pendingSettingsSave.promise,
    );

    // Open settings editor and trigger save
    await store.getState().openKnowledgeEditor({ kind: "settings" });
    const savePromise = store.getState().saveKnowledgeEditor();
    expect(store.getState().knowledgeBusy).toBe(true);

    // While settings save is in-flight, a new operation starts (new generation and new busy)
    act(() => {
      store.setState({
        knowledgeReadId: store.getState().knowledgeReadId + 1,
        knowledgeBusy: true,
        knowledgeEditor: null,
        knowledgeDirty: false,
      });
    });

    // Old settings save resolves late with updated settings
    const staleSavedSettings: KnowledgeSettings = {
      revision: 2,
      auto_enabled: false,
      model_name: "stale-model",
      context_budget: 4096,
    };
    act(() => {
      pendingSettingsSave.resolve(staleSavedSettings);
    });
    const result = await savePromise;
    expect(result).toBe(false);

    // Old save must NOT pollute knowledgeSettings, and must NOT clear the new busy state
    expect(store.getState().knowledgeSettings).toEqual(settings);
    expect(store.getState().knowledgeBusy).toBe(true);
  });

  it("discards late saveKnowledgeEditor reject error when apiClient/editor changes, not showing stale error", async () => {
    const pendingSave = deferred<KnowledgeDocumentDetail>();
    vi.mocked(store.getState().apiClient.saveKnowledgeGrants).mockReturnValue(pendingSave.promise);

    await store.getState().openKnowledgeEditor({ kind: "grants", id: docNull.id });
    const savePromise = store.getState().saveKnowledgeEditor();

    // Lifecycle reset / navigating away while save is in flight
    act(() => {
      store.setState({
        knowledgeEditor: null,
        knowledgeDirty: false,
        knowledgeBusy: false,
        knowledgeReadId: store.getState().knowledgeReadId + 1,
      });
    });

    // Old save rejects late with 500 error
    act(() => {
      pendingSave.reject(new Error("500 Stale Save Network Error"));
    });
    const result = await savePromise;
    expect(result).toBe(false);

    // Stale error must NOT be surfaced into store.error
    expect(store.getState().error).toBeNull();
    expect(store.getState().knowledgeEditor).toBeNull();
  });

  it("renders concise classification badges in the document list", () => {
    render(<KnowledgeLibrary active={true} />);

    expect(screen.getByText("历史未分类")).toBeTruthy();
    expect(screen.getByText("公共资料")).toBeTruthy();
    expect(screen.getByText("私有资料")).toBeTruthy();
  });

  it("renders English localization cleanly without fallback text", async () => {
    selectLocale("en");

    render(<KnowledgeLibrary active={true} />);

    // In the table list, verify concise classification badges
    const table = screen.getByRole("table");
    expect(within(table).getByText("Historical unclassified")).toBeTruthy();
    expect(within(table).getByText("Public document")).toBeTruthy();
    expect(within(table).getByText("Private document")).toBeTruthy();

    await store.getState().openKnowledgeEditor({ kind: "grants", id: docNull.id });

    // In the grants sheet editor, verify classification combobox and its unclassified option
    const select = await screen.findByRole("combobox", { name: "Knowledge classification" });
    expect(select).toHaveProperty("value", "unclassified");
    expect(within(select).getByRole("option", { name: "Historical unclassified" })).toBeTruthy();
  });

  it("verifies api.saveKnowledgeGrants serializes payload omitting visibility when undefined and sending visibility when defined", async () => {
    let capturedInit: RequestInit | undefined;
    const fetchMock = vi.fn().mockImplementation(async (_url, init) => {
      capturedInit = init;
      return new Response(JSON.stringify(docNull), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      // 1. When visibility is undefined: key is omitted from wire JSON body
      await api.saveKnowledgeGrants(docNull.id, 3, [A, B], undefined);
      if (typeof capturedInit?.body !== "string") {
        throw new Error("Expected string body in RequestInit");
      }
      const bodyWithoutVis = JSON.parse(capturedInit.body);
      expect(bodyWithoutVis).toEqual({ expected_revision: 3, agent_ids: [A, B] });
      expect(Object.hasOwn(bodyWithoutVis, "visibility")).toBe(false);

      // 2. When visibility is 'public': key is present in wire JSON body
      await api.saveKnowledgeGrants(docNull.id, 3, [A, B], "public");
      if (typeof capturedInit?.body !== "string") {
        throw new Error("Expected string body in RequestInit");
      }
      const bodyWithPublic = JSON.parse(capturedInit.body);
      expect(bodyWithPublic).toEqual({
        expected_revision: 3,
        agent_ids: [A, B],
        visibility: "public",
      });
      expect(bodyWithPublic.visibility).toBe("public");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
