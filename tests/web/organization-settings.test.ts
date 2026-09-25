import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SuperstringApi } from "../../src/web/api";
import { knowledgeModelDirty, organizationDirty } from "../../src/web/features/knowledge/types";
import { useSuperstringStore as store } from "../../src/web/store";

let client: SuperstringApi;
beforeEach(() => {
  client = {
    getOrganizationSettings: vi.fn(async () => ({
      model_name: null,
      vision_model_name: null,
      transcription_model_name: null,
      revision: 1,
    })),
    saveOrganizationSettings: vi.fn(
      async ({ model_name, vision_model_name, transcription_model_name, expected_revision }) => ({
        model_name,
        vision_model_name: vision_model_name ?? null,
        transcription_model_name: transcription_model_name ?? null,
        revision: expected_revision + 1,
      }),
    ),
    getKnowledgeSettings: vi.fn(async () => ({
      model_name: null,
      revision: 1,
      auto_enabled: true,
      context_budget: 4096,
    })),
    saveKnowledgeSettings: vi.fn(async ({ expected_revision, ...body }) => ({
      ...body,
      revision: expected_revision + 1,
    })),
  } as unknown as SuperstringApi;
  store.getState().resetForTests(client);
  store.setState({ page: "settings", settingsView: "workspace", settingsRoute: "management" });
});
describe("default organization and independent scopes", () => {
  it("keeps a dedicated load error, clears it on retry, and ignores discarded late failures", async () => {
    vi.mocked(client.getOrganizationSettings).mockRejectedValueOnce(new Error("unavailable"));
    await store.getState().loadOrganization();
    expect(store.getState().organizationError).toBe("unavailable");
    expect(store.getState().organizationLoading).toBe(false);
    expect(store.getState().organizationEditor).toBeNull();
    await store.getState().loadOrganization();
    expect(store.getState().organizationError).toBeNull();
    expect(store.getState().organizationEditor?.source.revision).toBe(1);
    let reject!: (error: Error) => void;
    vi.mocked(client.getOrganizationSettings).mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    const pending = store.getState().loadOrganization(true);
    store.getState().discardOrganization();
    reject(new Error("late failure"));
    await pending;
    expect(store.getState().organizationError).toBeNull();
    expect(store.getState().organizationEditor).toBeNull();
  });
  it("saves only the default while keeping global and document drafts", async () => {
    await store.getState().loadOrganization();
    await store.getState().loadKnowledgeModel();
    store.getState().patchOrganization("shared");
    store.getState().patchKnowledgeGlobal({ contextBudget: 9000, autoEnabled: false });
    store.setState({
      knowledgeEditor: { kind: "category-new", name: "draft" },
      knowledgeDirty: true,
    });
    expect(await store.getState().saveOrganization()).toBe(true);
    expect(client.saveOrganizationSettings).toHaveBeenCalledWith({
      model_name: "shared",
      vision_model_name: null,
      transcription_model_name: null,
      expected_revision: 1,
    });
    expect(client.saveKnowledgeSettings).not.toHaveBeenCalled();
    expect(knowledgeModelDirty(store.getState().knowledgeModelEditor)).toBe(true);
    expect(store.getState().knowledgeDirty).toBe(true);
  });
  it("retains defaults across pages and handles save failure on exit", async () => {
    await store.getState().loadOrganization();
    store.getState().patchOrganization("shared");
    store.getState().openSettingsRoute("knowledge-config");
    expect(store.getState().pendingNavigation).toBeNull();
    store.getState().openChat();
    expect(store.getState().navigationConfirmOpen).toBe(true);
    vi.mocked(client.saveOrganizationSettings).mockRejectedValueOnce(new Error("conflict"));
    await store.getState().confirmSaveAndContinue();
    expect(store.getState().page).toBe("settings");
    expect(organizationDirty(store.getState().organizationEditor)).toBe(true);
    await store.getState().confirmSaveAndContinue();
    expect(store.getState().page).toBe("chat");
  });
  it("saves the two media purposes together with the shared default", async () => {
    await store.getState().loadOrganization();
    // §7.1: the purposes live on the shared row; unset stays unset rather than falling back.
    store.getState().patchOrganization("shared");
    store.getState().patchOrganizationPurposes({ visionModelName: "vision-model" });
    expect(organizationDirty(store.getState().organizationEditor)).toBe(true);
    vi.mocked(client.saveOrganizationSettings).mockResolvedValueOnce({
      model_name: "shared",
      vision_model_name: "vision-model",
      transcription_model_name: null,
      revision: 2,
    });
    expect(await store.getState().saveOrganization()).toBe(true);
    expect(client.saveOrganizationSettings).toHaveBeenCalledWith({
      model_name: "shared",
      vision_model_name: "vision-model",
      transcription_model_name: null,
      expected_revision: 1,
    });
    expect(organizationDirty(store.getState().organizationEditor)).toBe(false);
  });
  it("refreshes conflict baselines without replacing dirty input", async () => {
    await store.getState().loadOrganization();
    store.getState().patchOrganization("draft");
    vi.mocked(client.getOrganizationSettings).mockResolvedValue({
      model_name: "remote",
      vision_model_name: null,
      transcription_model_name: null,
      revision: 8,
    });
    await store.getState().loadOrganization(true);
    expect(store.getState().organizationEditor).toMatchObject({
      modelName: "draft",
      source: { model_name: "remote", revision: 8 },
    });
    await store.getState().saveOrganization();
    expect(client.saveOrganizationSettings).toHaveBeenCalledWith({
      model_name: "draft",
      vision_model_name: null,
      transcription_model_name: null,
      expected_revision: 8,
    });
  });
  it("discards all scopes on exit without saving them", async () => {
    await store.getState().loadOrganization();
    await store.getState().loadKnowledgeModel();
    store.getState().patchOrganization("discard");
    store.getState().patchKnowledgeGlobal({ contextBudget: 9000 });
    store.setState({
      knowledgeEditor: { kind: "category-new", name: "discard" },
      knowledgeDirty: true,
    });
    store.getState().openChat();
    await store.getState().confirmDiscardAndContinue();
    expect(store.getState().organizationEditor).toBeNull();
    expect(store.getState().knowledgeModelEditor).toBeNull();
    expect(store.getState().knowledgeEditor).toBeNull();
    expect(client.saveOrganizationSettings).not.toHaveBeenCalled();
    expect(client.saveKnowledgeSettings).not.toHaveBeenCalled();
  });
  it("blocks duplicate default saves and ignores late results for another editor", async () => {
    await store.getState().loadOrganization();
    store.getState().patchOrganization("before");
    let finish!: (value: {
      model_name: string | null;
      vision_model_name: string | null;
      transcription_model_name: string | null;
      revision: number;
    }) => void;
    vi.mocked(client.saveOrganizationSettings).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const saving = store.getState().saveOrganization();
    expect(await store.getState().saveOrganization()).toBe(false);
    store.getState().openChat();
    expect(store.getState().page).toBe("settings");
    const editor = store.getState().organizationEditor;
    if (!editor) throw new Error("Missing editor");
    store.setState({ organizationEditor: { ...editor, token: {}, modelName: "new-session" } });
    finish({
      model_name: "before",
      vision_model_name: null,
      transcription_model_name: null,
      revision: 2,
    });
    expect(await saving).toBe(false);
    expect(store.getState().organizationEditor?.modelName).toBe("new-session");
  });
  it("saves global controls together without leaking default or document drafts", async () => {
    await store.getState().loadOrganization();
    await store.getState().loadKnowledgeModel();
    store.getState().patchOrganization("draft");
    store.getState().patchKnowledgeGlobal({ contextBudget: 8192, autoEnabled: false });
    store.getState().patchKnowledgeModel("override");
    store.setState({
      knowledgeEditor: { kind: "category-new", name: "draft" },
      knowledgeDirty: true,
    });
    expect(await store.getState().saveKnowledgeModel()).toBe(true);
    expect(client.saveKnowledgeSettings).toHaveBeenCalledWith({
      model_name: "override",
      context_budget: 8192,
      auto_enabled: false,
      expected_revision: 1,
    });
    expect(client.saveOrganizationSettings).not.toHaveBeenCalled();
    expect(store.getState().knowledgeDirty).toBe(true);
  });
  it.each(["model", "rules"] as const)(
    "saves %s without submitting the other scope and advances the shared revision",
    async (scope) => {
      await store.getState().loadKnowledgeModel();
      store.getState().patchKnowledgeModel("override");
      store.getState().patchKnowledgeGlobal({ autoEnabled: false, contextBudget: 8192 });
      expect(await store.getState().saveKnowledgeModel(scope)).toBe(true);
      expect(client.saveKnowledgeSettings).toHaveBeenLastCalledWith({
        expected_revision: 1,
        model_name: scope === "model" ? "override" : null,
        auto_enabled: scope === "model",
        context_budget: scope === "model" ? 4096 : 8192,
      });
      expect(knowledgeModelDirty(store.getState().knowledgeModelEditor, scope)).toBe(false);
      const other = scope === "model" ? "rules" : "model";
      expect(knowledgeModelDirty(store.getState().knowledgeModelEditor, other)).toBe(true);
      expect(await store.getState().saveKnowledgeModel(other)).toBe(true);
      expect(client.saveKnowledgeSettings).toHaveBeenLastCalledWith({
        expected_revision: 2,
        model_name: "override",
        auto_enabled: false,
        context_budget: 8192,
      });
      expect(knowledgeModelDirty(store.getState().knowledgeModelEditor)).toBe(false);
    },
  );
  it("model-only save ignores an invalid rule draft and rule failure retains both drafts", async () => {
    await store.getState().loadKnowledgeModel();
    store.getState().patchKnowledgeModel("override");
    store.getState().patchKnowledgeGlobal({ contextBudget: Number.NaN });
    expect(await store.getState().saveKnowledgeModel("rules")).toBe(false);
    expect(client.saveKnowledgeSettings).not.toHaveBeenCalled();
    expect(await store.getState().saveKnowledgeModel("model")).toBe(true);
    expect(Number.isNaN(store.getState().knowledgeModelEditor?.contextBudget)).toBe(true);
    expect(knowledgeModelDirty(store.getState().knowledgeModelEditor, "rules")).toBe(true);
    expect(await store.getState().saveKnowledgeModel("model")).toBe(true);
    expect(client.saveKnowledgeSettings).toHaveBeenCalledTimes(1);
  });
  it("refresh keeps only edited fields and adopts remote values for the other scope", async () => {
    await store.getState().loadKnowledgeModel();
    store.getState().patchKnowledgeGlobal({ contextBudget: 8192 });
    vi.mocked(client.getKnowledgeSettings).mockResolvedValue({
      model_name: "remote",
      revision: 8,
      auto_enabled: false,
      context_budget: 6000,
    });
    await store.getState().loadKnowledgeModel(true);
    expect(store.getState().knowledgeModelEditor).toMatchObject({
      modelName: "remote",
      autoEnabled: false,
      contextBudget: 8192,
      source: { revision: 8 },
    });
    expect(knowledgeModelDirty(store.getState().knowledgeModelEditor, "model")).toBe(false);
    await store.getState().saveKnowledgeModel("rules");
    expect(client.saveKnowledgeSettings).toHaveBeenLastCalledWith({
      expected_revision: 8,
      model_name: "remote",
      auto_enabled: false,
      context_budget: 8192,
    });
  });
  it("retains successful scope baselines if a later scope fails while leaving", async () => {
    await store.getState().loadOrganization();
    await store.getState().loadKnowledgeModel();
    store.getState().patchKnowledgeGlobal({ contextBudget: 8192 });
    store.getState().patchOrganization("shared");
    vi.mocked(client.saveOrganizationSettings).mockRejectedValueOnce(new Error("conflict"));
    store.getState().openChat();
    await store.getState().confirmSaveAndContinue();
    expect(knowledgeModelDirty(store.getState().knowledgeModelEditor)).toBe(false);
    expect(store.getState().page).toBe("settings");
    await store.getState().confirmSaveAndContinue();
    expect(client.saveKnowledgeSettings).toHaveBeenCalledTimes(1);
    expect(store.getState().page).toBe("chat");
  });
});
