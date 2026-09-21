import {
  KnowledgeDocumentUpdateSchema,
  KnowledgeImportSchema,
  KnowledgeSettingsUpdateSchema,
} from "../../../shared/contracts/knowledge";
import { msg } from "../../i18n";
import { errorText } from "../../state/helpers";
import type { StoreGet, StoreSet } from "../../state/types";
import type { KnowledgeEditor, KnowledgeState } from "./types";

export function createKnowledgeActions(
  set: StoreSet,
  get: StoreGet,
): Pick<
  KnowledgeState,
  | "loadKnowledge"
  | "requestKnowledgeEditor"
  | "openKnowledgeEditor"
  | "updateKnowledgeEditor"
  | "saveKnowledgeEditor"
  | "discardKnowledgeEditor"
  | "deleteKnowledgeItem"
  | "setKnowledgeMode"
> {
  const guard = () => get().knowledgeBusy || get().knowledgeDirty;
  return {
    loadKnowledge: async () => {
      if (get().knowledgeBusy || get().knowledgeDirty) return;
      const id = get().knowledgeReadId + 1;
      set({ knowledgeReadId: id, knowledgeLoading: true });
      try {
        const api = get().apiClient;
        const [categories, documents, settings] = await Promise.all([
          api.listKnowledgeCategories(),
          api.listKnowledgeDocuments(),
          api.getKnowledgeSettings(),
        ]);
        if (get().knowledgeReadId !== id) return;
        set({
          knowledgeCategories: categories,
          knowledgeDocuments: documents,
          knowledgeSettings: settings,
          error: null,
        });
      } catch (error) {
        if (get().knowledgeReadId === id) set({ error: errorText(error) });
      } finally {
        if (get().knowledgeReadId === id) set({ knowledgeLoading: false });
      }
    },
    requestKnowledgeEditor: (target) => {
      if (get().knowledgeBusy) return;
      if (get().knowledgeDirty) {
        set({
          pendingNavigation: { kind: "knowledge", target },
          navigationConfirmOpen: true,
          navigationConfirmMessage: msg("知识库有未保存修改，是否先保存再继续？"),
        });
        return;
      }
      void get().openKnowledgeEditor(target);
    },
    openKnowledgeEditor: async (target) => {
      if (guard()) return false;
      const id = get().knowledgeReadId + 1;
      set({ knowledgeReadId: id, knowledgeLoading: true, error: null });
      try {
        let editor: KnowledgeEditor | null = null;
        if (target.kind === "document" || target.kind === "grants") {
          const source = await get().apiClient.getKnowledgeDocument(target.id);
          editor =
            target.kind === "document"
              ? {
                  kind: "document",
                  source,
                  name: source.name,
                  category_id: source.category_id,
                  original_text: source.original_text,
                  content_mode: source.content_mode,
                }
              : { kind: "grants", source, agent_ids: [...source.agent_ids] };
        } else if (target.kind === "settings") {
          const source = await get().apiClient.getKnowledgeSettings();
          editor = {
            kind: "settings",
            source,
            auto_enabled: source.auto_enabled,
            model_name: source.model_name ?? "",
            context_budget: source.context_budget,
          };
        } else if (target.kind === "category") {
          const source = get().knowledgeCategories.find((c) => c.id === target.id);
          if (!source) return false;
          editor = { kind: "category", source, name: source.name };
        } else if (target.kind === "category-new") editor = { kind: "category-new", name: "" };
        else if (target.kind === "import")
          editor = {
            kind: "import",
            name: "",
            category_id: get().knowledgeCategories[0]?.id ?? "default",
            original_text: "",
            file: null,
          };
        else if (target.kind === "batch")
          editor = {
            kind: "batch",
            documents: get().knowledgeDocuments.filter((d) => target.ids.includes(d.id)),
            agent_id: get().agents[0]?.id ?? "",
            granted: true,
          };
        if (get().knowledgeReadId !== id || get().knowledgeDirty) return false;
        set({ knowledgeEditor: editor, knowledgeDirty: false });
        return true;
      } catch (error) {
        if (get().knowledgeReadId === id) set({ error: errorText(error) });
        return false;
      } finally {
        if (get().knowledgeReadId === id) set({ knowledgeLoading: false });
      }
    },
    updateKnowledgeEditor: (editor) => {
      if (
        get().knowledgeBusy ||
        get().knowledgeLoading ||
        !get().knowledgeEditor ||
        editor.kind !== get().knowledgeEditor?.kind
      )
        return;
      set({ knowledgeEditor: editor, knowledgeDirty: true });
    },
    discardKnowledgeEditor: () => {
      if (get().knowledgeBusy) return;
      set({
        knowledgeEditor: null,
        knowledgeDirty: false,
        knowledgeReadId: get().knowledgeReadId + 1,
        knowledgeLoading: false,
      });
    },
    saveKnowledgeEditor: async () => {
      const editor = get().knowledgeEditor;
      if (!editor || get().knowledgeBusy || get().knowledgeLoading || get().settingsSaving)
        return false;
      set({ knowledgeBusy: true, error: null });
      try {
        const api = get().apiClient;
        if (editor.kind === "import") {
          if (editor.file) {
            if (!editor.name.trim() || !/\.(txt|md)$/i.test(editor.file.name))
              throw new Error(msg("请选择 txt/md 文件并填写资料名称。"));
            await api.importKnowledgeFile(editor.file, editor.category_id, editor.name);
          } else {
            const parsed = KnowledgeImportSchema.safeParse({
              name: editor.name,
              category_id: editor.category_id,
              original_text: editor.original_text,
            });
            if (!parsed.success) throw new Error(msg("请填写有效的名称和完整原文。"));
            await api.importKnowledgeText(parsed.data);
          }
        } else if (editor.kind === "document") {
          const parsed = KnowledgeDocumentUpdateSchema.safeParse({
            expected_revision: editor.source.revision,
            name: editor.name,
            category_id: editor.category_id,
            original_text: editor.original_text,
            content_mode: editor.content_mode,
          });
          if (!parsed.success) throw new Error(msg("请填写有效的名称和完整原文。"));
          await api.updateKnowledgeDocument(editor.source.id, parsed.data);
        } else if (editor.kind === "grants")
          await api.saveKnowledgeGrants(editor.source.id, editor.source.revision, editor.agent_ids);
        else if (editor.kind === "settings") {
          const parsed = KnowledgeSettingsUpdateSchema.safeParse({
            expected_revision: editor.source.revision,
            auto_enabled: editor.auto_enabled,
            model_name: editor.source.model_name,
            context_budget: editor.context_budget,
          });
          if (!parsed.success) throw new Error(msg("上下文预算必须为正整数。"));
          const saved = await api.saveKnowledgeSettings(parsed.data);
          const modelEditor = get().knowledgeModelEditor;
          set({
            knowledgeSettings: saved,
            ...(modelEditor
              ? {
                  knowledgeModelEditor: {
                    ...modelEditor,
                    source: saved,
                    modelName:
                      modelEditor.modelName !== modelEditor.source.model_name
                        ? modelEditor.modelName
                        : saved.model_name,
                    autoEnabled:
                      modelEditor.autoEnabled !== undefined &&
                      modelEditor.autoEnabled !== modelEditor.source.auto_enabled
                        ? modelEditor.autoEnabled
                        : saved.auto_enabled,
                    contextBudget:
                      modelEditor.contextBudget !== undefined &&
                      modelEditor.contextBudget !== modelEditor.source.context_budget
                        ? modelEditor.contextBudget
                        : saved.context_budget,
                  },
                }
              : {}),
          });
        } else if (editor.kind === "batch") {
          if (!editor.agent_id || !editor.documents.length)
            throw new Error(msg("请选择资料和助手。"));
          await api.batchKnowledgeGrants({
            agent_id: editor.agent_id,
            granted: editor.granted,
            documents: editor.documents.map((d) => ({
              id: d.id,
              expected_revision: d.revision,
            })),
          });
        } else {
          if (!editor.name.trim() || editor.name.length > 200)
            throw new Error(msg("名称须为 1–200 个字符。"));
          if (editor.kind === "category-new") await api.createKnowledgeCategory(editor.name);
          else
            await api.renameKnowledgeCategory(
              editor.source.id,
              editor.name,
              editor.source.revision,
            );
        }
        set({
          knowledgeEditor: null,
          knowledgeDirty: false,
          knowledgeBusy: false,
          feedback: msg("知识库修改已保存。"),
        });
        await get().loadKnowledge();
        if (get().knowledgeReadEditor) await get().loadKnowledgeRead();
        return true;
      } catch (error) {
        set({ error: errorText(error) });
        return false;
      } finally {
        set({ knowledgeBusy: false });
      }
    },
    deleteKnowledgeItem: async (kind, id, revision, moveTo) => {
      if (guard() || get().knowledgeLoading) return false;
      set({ knowledgeBusy: true, error: null });
      try {
        if (kind === "document") await get().apiClient.deleteKnowledgeDocument(id, revision);
        else await get().apiClient.deleteKnowledgeCategory(id, revision, moveTo);
        set({ knowledgeBusy: false, knowledgeEditor: null });
        await get().loadKnowledge();
        return true;
      } catch (error) {
        set({ error: errorText(error) });
        return false;
      } finally {
        set({ knowledgeBusy: false });
      }
    },
    setKnowledgeMode: async (id, mode) => {
      if (guard() || get().knowledgeLoading) return false;
      const document = get().knowledgeDocuments.find((d) => d.id === id);
      if (!document) return false;
      set({ knowledgeBusy: true, error: null });
      try {
        await get().apiClient.updateKnowledgeDocument(id, {
          expected_revision: document.revision,
          content_mode: mode,
        });
        set({ knowledgeBusy: false, knowledgeEditor: null });
        await get().loadKnowledge();
        return true;
      } catch (error) {
        set({ error: errorText(error) });
        return false;
      } finally {
        set({ knowledgeBusy: false });
      }
    },
  };
}
