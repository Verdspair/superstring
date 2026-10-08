import { KnowledgeSettingsUpdateSchema } from "../../../shared/contracts/knowledge";
import { ApiError } from "../../api";
import { msg } from "../../i18n";
import { errorText } from "../../state/helpers";
import type { StoreGet, StoreSet } from "../../state/types";
import { type KnowledgeState, knowledgeModelDirty } from "./types";

export function createKnowledgeModelActions(
  set: StoreSet,
  get: StoreGet,
): Pick<
  KnowledgeState,
  | "loadKnowledgeModel"
  | "patchKnowledgeModel"
  | "patchKnowledgeGlobal"
  | "saveKnowledgeModel"
  | "discardKnowledgeModel"
> {
  let read = 0;
  return {
    loadKnowledgeModel: async (refresh = false) => {
      if (
        get().knowledgeModelLoading ||
        get().settingsSaving ||
        (get().knowledgeModelEditor && !refresh)
      )
        return;
      const previous = get().knowledgeModelEditor;
      const request = ++read;
      const api = get().apiClient;
      const matches = () => read === request && get().apiClient === api;
      set({ knowledgeModelLoading: true });
      try {
        const source = await api.getKnowledgeSettings();
        if (!matches()) return;
        set({
          knowledgeModelEditor: {
            token: previous?.token ?? {},
            source,
            modelName:
              previous && knowledgeModelDirty(previous, "model")
                ? previous.modelName
                : source.model_name,
            autoEnabled:
              previous &&
              previous.autoEnabled !== undefined &&
              previous.autoEnabled !== previous.source.auto_enabled
                ? previous.autoEnabled
                : source.auto_enabled,
            contextBudget:
              previous &&
              previous.contextBudget !== undefined &&
              previous.contextBudget !== previous.source.context_budget
                ? previous.contextBudget
                : source.context_budget,
          },
          knowledgeSettings: source,
          error: null,
        });
      } catch (error) {
        if (matches()) set({ error: errorText(error) });
      } finally {
        if (matches()) set({ knowledgeModelLoading: false });
      }
    },
    patchKnowledgeModel: (modelName) => {
      const editor = get().knowledgeModelEditor;
      if (!editor || get().knowledgeModelLoading || get().settingsSaving || get().knowledgeBusy)
        return;
      set({ knowledgeModelEditor: { ...editor, modelName }, feedback: "" });
    },
    patchKnowledgeGlobal: (patch) => {
      const editor = get().knowledgeModelEditor;
      if (!editor || get().knowledgeModelLoading || get().settingsSaving || get().knowledgeBusy)
        return;
      set({ knowledgeModelEditor: { ...editor, ...patch }, feedback: "" });
    },
    saveKnowledgeModel: async (scope = "all") => {
      const editor = get().knowledgeModelEditor;
      if (!knowledgeModelDirty(editor, scope)) return true;
      if (
        !editor ||
        get().settingsSaving ||
        get().knowledgeBusy ||
        get().knowledgeLoading ||
        get().knowledgeModelLoading
      )
        return false;
      set({ settingsSaving: true, error: null, feedback: "" });
      try {
        const saved = await get().apiClient.saveKnowledgeSettings(
          KnowledgeSettingsUpdateSchema.parse({
            expected_revision: editor.source.revision,
            // 各 scope 只提交自己拥有的字段："budget"/"model" 取已存基线补齐其余字段；
            // "rules" 保留原义：整理规则连同预算草稿一起提交。
            auto_enabled:
              scope === "model" || scope === "budget"
                ? editor.source.auto_enabled
                : (editor.autoEnabled ?? editor.source.auto_enabled),
            context_budget:
              scope === "model"
                ? editor.source.context_budget
                : (editor.contextBudget ?? editor.source.context_budget),
            model_name:
              scope === "rules" || scope === "budget" ? editor.source.model_name : editor.modelName,
          }),
        );
        if (get().knowledgeModelEditor?.token !== editor.token) return false;
        const reading = get().knowledgeReadEditor;
        set({
          knowledgeModelEditor: {
            ...editor,
            source: saved,
            // 接受基线：只推进本次提交的字段，其他字段保留草稿。
            modelName:
              scope === "rules" || scope === "budget" ? editor.modelName : saved.model_name,
            autoEnabled:
              scope === "model" || scope === "budget" ? editor.autoEnabled : saved.auto_enabled,
            contextBudget: scope === "model" ? editor.contextBudget : saved.context_budget,
          },
          knowledgeSettings: saved,
          ...(reading
            ? {
                knowledgeReadEditor: {
                  ...reading,
                  globalBudget: saved.context_budget,
                },
              }
            : {}),
          feedback: msg(
            scope === "model"
              ? "知识库整理模型已保存；整理规则草稿保持不变。"
              : scope === "rules"
                ? "全局整理规则已保存；模型草稿保持不变。"
                : "全局知识库设置已保存；助手读取与资料草稿保持不变。",
          ),
        });
        return true;
      } catch (error) {
        if (get().knowledgeModelEditor?.token === editor.token)
          set({
            error:
              error instanceof ApiError && error.code === "KNOWLEDGE_REVISION_CONFLICT"
                ? msg("刷新不提交草稿；冲突后请核对最新值再保存。")
                : errorText(error),
          });
        return false;
      } finally {
        set({ settingsSaving: false });
      }
    },
    discardKnowledgeModel: (scope) => {
      if (get().settingsSaving) return;
      const editor = get().knowledgeModelEditor;
      if (scope === "budget") {
        if (!editor) return;
        read++;
        set({
          knowledgeModelEditor: { ...editor, contextBudget: editor.source.context_budget },
          knowledgeModelLoading: false,
        });
        return;
      }
      read++;
      set({ knowledgeModelEditor: null, knowledgeModelLoading: false });
    },
  };
}
