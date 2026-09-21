import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KnowledgeDocumentDetail } from "../../src/shared/contracts/knowledge";
import { api } from "../../src/web/api";
import { AgentKnowledge } from "../../src/web/features/knowledge/AgentKnowledge";
import { KnowledgeSettings } from "../../src/web/features/knowledge/KnowledgeSettings";
import { selectLocale } from "../../src/web/i18n";
import { useSuperstringStore as store } from "../../src/web/store";

const id = "22222222-2222-4222-8222-222222222222";
const agent = "11111111-1111-4111-8111-111111111111";
const original = "\uFEFF# 原文\r\n  中文𠮷\t42.5\n";
const document: KnowledgeDocumentDetail = {
  id,
  category_id: "default",
  name: "用户资料",
  import_type: "md",
  content_mode: "draft",
  content_version: 1,
  revision: 3,
  created_at: "2026-09-19T00:00:00Z",
  updated_at: "2026-09-19T00:00:00Z",
  agent_ids: [],
  summary: "",
  tags: [],
  organization_status: "queued",
  error_code: null,
  original_text: original,
  draft: null,
  content: {
    id,
    source_type: "knowledge",
    content_origin: "original",
    name: "用户资料",
    summary: "",
    tags: [],
    body: original,
    revision: "1",
    sources: [],
    validity: "valid",
  },
};
const categories = [{ id: "default", name: "资料", revision: 1, document_count: 1 }];
const settings = { revision: 1, auto_enabled: true, model_name: null, context_budget: 2048 };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function edit() {
  await store.getState().openKnowledgeEditor({ kind: "document", id });
  const editor = store.getState().knowledgeEditor;
  if (editor?.kind !== "document") throw new Error("Missing document editor");
  store.getState().updateKnowledgeEditor({ ...editor, name: "修改名称" });
}
beforeEach(() => {
  selectLocale("zh-CN");
  store.getState().resetForTests({
    ...api,
    listKnowledgeCategories: vi.fn().mockResolvedValue(categories),
    listKnowledgeDocuments: vi.fn().mockResolvedValue([document]),
    getKnowledgeSettings: vi.fn().mockResolvedValue(settings),
    getKnowledgeDocument: vi.fn().mockResolvedValue(document),
    updateKnowledgeDocument: vi.fn().mockResolvedValue(document),
    deleteKnowledgeDocument: vi.fn().mockResolvedValue(undefined),
    batchKnowledgeGrants: vi.fn().mockResolvedValue([document]),
    saveKnowledgeGrants: vi.fn().mockResolvedValue(document),
    importKnowledgeText: vi.fn().mockResolvedValue(document),
    importKnowledgeFile: vi.fn().mockResolvedValue(document),
    listAgentKnowledge: vi.fn().mockResolvedValue([document]),
  });
  store.setState({
    page: "settings",
    settingsView: "knowledge",
    knowledgeCategories: categories,
    knowledgeDocuments: [document],
    knowledgeSettings: settings,
    editorAgentId: agent,
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("knowledge editing and authorization", () => {
  it("keeps raw bytes when only the name is edited", async () => {
    await edit();
    expect(await store.getState().saveKnowledgeEditor()).toBe(true);
    expect(store.getState().apiClient.updateKnowledgeDocument).toHaveBeenCalledWith(id, {
      expected_revision: 3,
      name: "修改名称",
      category_id: "default",
      original_text: original,
      content_mode: "draft",
    });
  });
  it("preserves failed saves and pending navigation, cancellation keeps the draft", async () => {
    vi.mocked(store.getState().apiClient.updateKnowledgeDocument).mockRejectedValue(
      new Error("conflict"),
    );
    await edit();
    store.getState().openChat();
    await store.getState().confirmSaveAndContinue();
    expect(store.getState().page).toBe("settings");
    expect(store.getState().knowledgeDirty).toBe(true);
    expect(store.getState().knowledgeEditor).toMatchObject({ name: "修改名称" });
    expect(store.getState().navigationConfirmOpen).toBe(true);
    store.getState().cancelPendingNavigation();
    expect(store.getState().knowledgeDirty).toBe(true);
  });
  it("saves before navigation and discards without a write", async () => {
    await edit();
    store.getState().openChat();
    await store.getState().confirmSaveAndContinue();
    expect(store.getState().page).toBe("chat");
    expect(store.getState().knowledgeEditor).toBeNull();
    store.setState({ page: "settings", settingsView: "knowledge" });
    await edit();
    vi.mocked(store.getState().apiClient.updateKnowledgeDocument).mockClear();
    store.getState().openSettings();
    expect(store.getState().knowledgeDirty).toBe(true);
    expect(store.getState().pendingNavigation).toBeNull();
    store.getState().openChat();
    await store.getState().confirmDiscardAndContinue();
    expect(store.getState().page).toBe("chat");
    expect(store.getState().knowledgeEditor).toBeNull();
    expect(store.getState().apiClient.updateKnowledgeDocument).not.toHaveBeenCalled();
  });
  it("restores the old draft if discard-and-open cannot read its destination", async () => {
    await edit();
    vi.mocked(store.getState().apiClient.getKnowledgeDocument).mockRejectedValue(
      new Error("read failed"),
    );
    store.getState().requestKnowledgeEditor({ kind: "grants", id });
    await store.getState().confirmDiscardAndContinue();
    expect(store.getState().knowledgeEditor).toMatchObject({ kind: "document", name: "修改名称" });
    expect(store.getState().knowledgeDirty).toBe(true);
    expect(store.getState().navigationConfirmOpen).toBe(true);
  });
  it("saves or discards before switching editors", async () => {
    await edit();
    store.getState().requestKnowledgeEditor({ kind: "category-new" });
    await store.getState().confirmSaveAndContinue();
    expect(store.getState().knowledgeEditor?.kind).toBe("category-new");
    store.getState().updateKnowledgeEditor({ kind: "category-new", name: "未保存分类" });
    store.getState().requestKnowledgeEditor({ kind: "none" });
    await store.getState().confirmDiscardAndContinue();
    expect(store.getState().knowledgeEditor).toBeNull();
  });
  it("ignores a late read after leaving the knowledge page", async () => {
    const pending = deferred<KnowledgeDocumentDetail>();
    vi.mocked(store.getState().apiClient.getKnowledgeDocument).mockReturnValue(pending.promise);
    const read = store.getState().openKnowledgeEditor({ kind: "document", id });
    store.getState().openChat();
    pending.resolve(document);
    expect(await read).toBe(false);
    expect(store.getState().knowledgeEditor).toBeNull();
    expect(store.getState().knowledgeLoading).toBe(false);
  });
  it("newer editor reads win over older reads", async () => {
    const pending = deferred<KnowledgeDocumentDetail>();
    vi.mocked(store.getState().apiClient.getKnowledgeDocument).mockReturnValue(pending.promise);
    const read = store.getState().openKnowledgeEditor({ kind: "document", id });
    await store.getState().openKnowledgeEditor({ kind: "settings" });
    pending.resolve(document);
    expect(await read).toBe(false);
    expect(store.getState().knowledgeEditor?.kind).toBe("settings");
  });
  it("blocks edits, duplicate saves and navigation during a save", async () => {
    const pending = deferred<KnowledgeDocumentDetail>();
    vi.mocked(store.getState().apiClient.updateKnowledgeDocument).mockReturnValue(pending.promise);
    await edit();
    const save = store.getState().saveKnowledgeEditor();
    store.getState().openChat();
    store.getState().discardKnowledgeEditor();
    store.getState().updateKnowledgeEditor({ kind: "category-new", name: "bad" });
    expect(await store.getState().saveKnowledgeEditor()).toBe(false);
    expect(store.getState().settingsView).toBe("knowledge");
    expect(store.getState().knowledgeEditor).toMatchObject({ name: "修改名称" });
    pending.resolve(document);
    await save;
    expect(store.getState().apiClient.updateKnowledgeDocument).toHaveBeenCalledTimes(1);
  });
  it("does not reload, delete or change modes while dirty", async () => {
    await edit();
    await store.getState().loadKnowledge();
    expect(await store.getState().deleteKnowledgeItem("document", id, 3)).toBe(false);
    expect(await store.getState().setKnowledgeMode(id, "original")).toBe(false);
    expect(store.getState().apiClient.listKnowledgeDocuments).not.toHaveBeenCalled();
    expect(store.getState().apiClient.deleteKnowledgeDocument).not.toHaveBeenCalled();
    expect(store.getState().apiClient.updateKnowledgeDocument).not.toHaveBeenCalled();
  });
  it("batch authorization snapshots only the explicitly selected documents", async () => {
    await store.getState().openKnowledgeEditor({ kind: "batch", ids: [id, "missing"] });
    const editor = store.getState().knowledgeEditor;
    if (editor?.kind !== "batch") throw new Error("Missing batch editor");
    store.getState().updateKnowledgeEditor({ ...editor, agent_id: agent, granted: false });
    expect(await store.getState().saveKnowledgeEditor()).toBe(true);
    expect(store.getState().apiClient.batchKnowledgeGrants).toHaveBeenCalledWith({
      documents: [{ id, expected_revision: 3 }],
      agent_id: agent,
      granted: false,
    });
  });
  it("rejects empty import without sending and preserves the form", async () => {
    await store.getState().openKnowledgeEditor({ kind: "import" });
    expect(await store.getState().saveKnowledgeEditor()).toBe(false);
    expect(store.getState().knowledgeEditor?.kind).toBe("import");
    expect(store.getState().apiClient.importKnowledgeText).not.toHaveBeenCalled();
  });
  it("uploads files rather than silently sending the hidden text input", async () => {
    const file = new File([original], "原文.md", { type: "text/markdown" });
    await store.getState().openKnowledgeEditor({ kind: "import" });
    store.getState().updateKnowledgeEditor({
      kind: "import",
      name: "上传资料",
      category_id: "default",
      original_text: "hidden",
      file,
    });
    expect(await store.getState().saveKnowledgeEditor()).toBe(true);
    expect(store.getState().apiClient.importKnowledgeFile).toHaveBeenCalledWith(
      file,
      "default",
      "上传资料",
    );
    expect(store.getState().apiClient.importKnowledgeText).not.toHaveBeenCalled();
  });
  it("preserves the assistant settings guard on the management jump", async () => {
    store.setState({ settingsView: "agents", dirty: true, activeSection: "knowledge" });
    render(<AgentKnowledge />);
    await screen.findByText("用户资料");
    fireEvent.click(screen.getByRole("button", { name: "打开知识库详细配置" }));
    expect(store.getState().settingsView).toBe("agents");
    expect(store.getState().navigationConfirmOpen).toBe(true);
  });
  it("cannot display a previous assistant's authorized catalog after switching", async () => {
    render(<AgentKnowledge />);
    await screen.findByText("用户资料");
    const pending = deferred<[]>();
    vi.mocked(store.getState().apiClient.listAgentKnowledge).mockReturnValue(pending.promise);
    act(() => {
      store.setState({ editorAgentId: "33333333-3333-4333-8333-333333333333" });
    });
    expect(screen.queryByText("用户资料")).toBeNull();
    await act(async () => {
      pending.resolve([]);
    });
    expect(screen.getByText("当前助手暂无已授权资料。")).toBeTruthy();
  });
  it("renders English controls without translating user content and guards close", async () => {
    selectLocale("en");
    render(<KnowledgeSettings />);
    await screen.findByRole("button", { name: /^用户资料/ });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^用户资料/ }));
    });
    fireEvent.change(screen.getByLabelText("Document name"), { target: { value: "保留中文" } });
    fireEvent.click(screen.getByRole("button", { name: "Close editor" }));
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stay here" }));
    expect(screen.getByDisplayValue("保留中文")).toBeTruthy();
  });
});
