import { KnowledgeSettingsUpdateSchema } from "../../../shared/contracts/knowledge";
import { ApiError } from "../../api";
import { msg } from "../../i18n";
import { errorText } from "../../state/helpers";
import type { StoreGet, StoreSet } from "../../state/types";
import { acceptKnowledgeSettings, readKnowledgeSettings } from "./settings-read";
import { type KnowledgeState, knowledgeModelDirty, knowledgeSettingsConflictScope } from "./types";

export function createKnowledgeModelActions(
  set: StoreSet,
  get: StoreGet,
): Pick<
  KnowledgeState,
  | "acquireKnowledgeModelRead"
  | "releaseKnowledgeModelRead"
  | "cancelKnowledgeModelRead"
  | "loadKnowledgeModel"
  | "patchKnowledgeModel"
  | "patchKnowledgeGlobal"
  | "saveKnowledgeModel"
  | "discardKnowledgeModel"
> {
  let read = 0;
  let lease: AbortController | null = null;
  let saveGeneration = 0;
  let suspended = false;
  let inFlight: Promise<void> | null = null;
  let activeApi: ReturnType<StoreGet>["apiClient"] | null = null;
  const consumers = new Map<object, ReturnType<StoreGet>["apiClient"]>();
  const cancelRead = () => {
    suspended = document.visibilityState === "hidden";
    read++;
    lease?.abort();
    lease = null;
    inFlight = null;
    set({ knowledgeModelLoading: false });
  };
  return {
    acquireKnowledgeModelRead: (owner: object) => {
      const api = get().apiClient;
      if (activeApi && activeApi !== api) {
        consumers.clear();
        cancelRead();
      }
      consumers.set(owner, api);
      return get().loadKnowledgeModel();
    },
    releaseKnowledgeModelRead: (owner: object) => {
      const api = consumers.get(owner);
      if (!api) return;
      consumers.delete(owner);
      if (api !== get().apiClient || api !== activeApi) return;
      if (![...consumers.values()].some((consumerApi) => consumerApi === api)) cancelRead();
    },
    cancelKnowledgeModelRead: () => {
      consumers.clear();
      cancelRead();
    },
    loadKnowledgeModel: async (refresh = false) => {
      const explicitRefresh = refresh;
      const api = get().apiClient;
      if (activeApi && activeApi !== api) {
        for (const [owner, ownerApi] of consumers) if (ownerApi !== api) consumers.delete(owner);
      }
      refresh = refresh || (suspended && activeApi === api && get().knowledgeModelEditor !== null);
      if (get().knowledgeModelLoading && activeApi === api && !refresh) {
        if (inFlight) return inFlight;
        return;
      }
      if (get().settingsSaving || (get().knowledgeModelEditor && activeApi === api && !refresh))
        return;
      suspended = false;
      const previous = activeApi && activeApi !== api ? null : get().knowledgeModelEditor;
      lease?.abort();
      const controller = new AbortController();
      lease = controller;
      const request = ++read;
      const apiChanged = activeApi !== null && activeApi !== api;
      activeApi = api;
      const matches = () => read === request && get().apiClient === api;
      set({
        knowledgeModelLoading: true,
        ...(apiChanged ? { knowledgeModelError: { model: null, budget: null, shared: null } } : {}),
      });
      const promise = (async () => {
        try {
          const source = await readKnowledgeSettings(get, {
            force: refresh,
            signal: controller.signal,
          });
          if (!matches()) return;
          const conflictScope = previous && knowledgeSettingsConflictScope(previous, source);
          if (!explicitRefresh && conflictScope) {
            set({
              knowledgeSettings: source,
              knowledgeModelError: {
                ...get().knowledgeModelError,
                [conflictScope === "both" ? "shared" : conflictScope]: msg(
                  "知识库远端内容已更改；本地草稿保留，未自动推进保存版本。请刷新并核对后重试。",
                ),
              },
            });
            return;
          }
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
            knowledgeModelError: { ...get().knowledgeModelError, shared: null },
          });
        } catch (error) {
          if (matches())
            set({
              knowledgeModelError: { ...get().knowledgeModelError, shared: errorText(error) },
            });
        } finally {
          controller.abort();
          if (lease === controller) lease = null;
          if (matches()) {
            inFlight = null;
            set({ knowledgeModelLoading: false });
          }
        }
      })();
      inFlight = promise;
      return promise;
    },
    patchKnowledgeModel: (modelName) => {
      if (activeApi && activeApi !== get().apiClient) return;
      const editor = get().knowledgeModelEditor;
      if (!editor || get().knowledgeModelLoading || get().settingsSaving || get().knowledgeBusy)
        return;
      set({ knowledgeModelEditor: { ...editor, modelName }, knowledgeModelNotice: "" });
    },
    patchKnowledgeGlobal: (patch) => {
      if (activeApi && activeApi !== get().apiClient) return;
      const editor = get().knowledgeModelEditor;
      if (!editor || get().knowledgeModelLoading || get().settingsSaving || get().knowledgeBusy)
        return;
      set({ knowledgeModelEditor: { ...editor, ...patch }, knowledgeModelNotice: "" });
    },
    saveKnowledgeModel: async (scope = "all") => {
      if (activeApi && activeApi !== get().apiClient) return false;
      const editor = get().knowledgeModelEditor;
      if (scope !== "model" && "global:knowledge" in get().allocationInvalidInputs) {
        set({
          knowledgeModelError: {
            ...get().knowledgeModelError,
            budget: msg("上下文预算必须为正整数。"),
          },
        });
        return false;
      }
      if (!knowledgeModelDirty(editor, scope)) return true;
      if (
        !editor ||
        get().settingsSaving ||
        get().knowledgeBusy ||
        get().knowledgeLoading ||
        get().knowledgeModelLoading
      )
        return false;
      const api = get().apiClient;
      const generation = ++saveGeneration;
      const operation = {};
      const matches = () =>
        get().apiClient === api &&
        generation === saveGeneration &&
        get().knowledgeModelEditor?.token === editor.token;
      set({
        settingsSaving: true,
        settingsSaveOwner: operation,
        knowledgeModelNotice: "",
      });
      try {
        const saved = await api.saveKnowledgeSettings(
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
        if (!matches()) return false;
        acceptKnowledgeSettings(get, api, saved);
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
          knowledgeModelError: {
            ...get().knowledgeModelError,
            ...(scope === "model"
              ? { model: null }
              : scope === "budget"
                ? { budget: null }
                : scope === "rules"
                  ? { budget: null, shared: null }
                  : { model: null, budget: null, shared: null }),
          },
          ...(reading
            ? {
                knowledgeReadEditor: {
                  ...reading,
                  globalBudget: saved.context_budget,
                },
              }
            : {}),
          knowledgeModelNotice: msg(
            scope === "model"
              ? "知识库整理模型已保存；整理规则草稿保持不变。"
              : scope === "rules"
                ? "全局整理规则已保存；模型草稿保持不变。"
                : "全局知识库设置已保存；助手读取与资料草稿保持不变。",
          ),
        });
        return true;
      } catch (error) {
        if (matches())
          set({
            knowledgeModelError: {
              ...get().knowledgeModelError,
              [scope === "model" ? "model" : scope === "budget" ? "budget" : "shared"]:
                error instanceof ApiError && error.code === "KNOWLEDGE_REVISION_CONFLICT"
                  ? msg("刷新不提交草稿；冲突后请核对最新值再保存。")
                  : errorText(error),
            },
          });
        return false;
      } finally {
        if (get().settingsSaveOwner === operation)
          set({ settingsSaving: false, settingsSaveOwner: null });
      }
    },
    discardKnowledgeModel: (scope) => {
      if (get().settingsSaving) return;
      lease?.abort();
      lease = null;
      const editor = get().knowledgeModelEditor;
      if (scope === "model") {
        if (!editor) return;
        read++;
        set({
          knowledgeModelEditor: { ...editor, modelName: editor.source.model_name },
          knowledgeModelError: { ...get().knowledgeModelError, model: null },
          knowledgeModelLoading: false,
        });
        return;
      }
      if (scope === "budget") {
        if (!editor) return;
        const { ["global:knowledge"]: _invalid, ...allocationInvalidInputs } =
          get().allocationInvalidInputs;
        set({ allocationInvalidInputs });
        read++;
        set({
          knowledgeModelEditor: { ...editor, contextBudget: editor.source.context_budget },
          knowledgeModelError: { ...get().knowledgeModelError, budget: null },
          knowledgeModelLoading: false,
        });
        return;
      }
      read++;
      set({
        knowledgeModelEditor: null,
        knowledgeModelError: { model: null, budget: null, shared: null },
        knowledgeModelLoading: false,
      });
    },
  };
}
