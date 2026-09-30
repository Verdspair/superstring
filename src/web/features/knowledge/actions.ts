import {
  KnowledgeDocumentUpdateSchema,
  KnowledgeImportSchema,
  KnowledgeSettingsUpdateSchema,
} from "../../../shared/contracts/knowledge";
import { msg } from "../../i18n";
import { errorText } from "../../state/helpers";
import type { StoreGet, StoreSet } from "../../state/types";
import {
  type KnowledgeEditor,
  type KnowledgeListFilters,
  type KnowledgeState,
  knowledgeListQuery,
  latestKnowledgeSettings,
} from "./types";

export function createKnowledgeActions(
  set: StoreSet,
  get: StoreGet,
): Pick<
  KnowledgeState,
  | "loadKnowledge"
  | "loadKnowledgePage"
  | "requestKnowledgeEditor"
  | "openKnowledgeEditor"
  | "updateKnowledgeEditor"
  | "saveKnowledgeEditor"
  | "discardKnowledgeEditor"
  | "deleteKnowledgeItem"
  | "setKnowledgeMode"
> {
  const guard = () => get().knowledgeBusy || get().knowledgeDirty;
  // 列表读取用独立代次与 AbortController：新搜索/翻页只作废旧列表请求，
  // 不牵连并行的编辑器读取（编辑器读取仍走 knowledgeReadId）。
  let listRead = 0;
  let listAbort: AbortController | null = null;
  const loadList = async (
    filters: KnowledgeListFilters,
    cursors: (string | null)[],
  ): Promise<boolean> => {
    if (guard()) return false;
    const id = ++listRead;
    listAbort?.abort();
    const controller = new AbortController();
    listAbort = controller;
    // 页面身份：离开资料页（改分区/换路由）后，迟到的列表响应不得写回。
    const view = {
      page: get().page,
      settingsView: get().settingsView,
      settingsRoute: get().settingsRoute,
    };
    const viewChanged = () =>
      get().page !== view.page ||
      get().settingsView !== view.settingsView ||
      get().settingsRoute !== view.settingsRoute;
    set({ knowledgeLoading: true });
    try {
      const api = get().apiClient;
      const [page, categories, settings] = await Promise.all([
        api.listKnowledgeDocuments(
          knowledgeListQuery(filters, cursors[cursors.length - 1] ?? null),
          controller.signal,
        ),
        api.listKnowledgeCategories(),
        api.getKnowledgeSettings(),
      ]);
      if (id !== listRead || viewChanged()) return false;
      set({
        knowledgeCategories: categories,
        knowledgeSettings: settings,
        knowledgeCursors: cursors,
        knowledgeNextCursor: page.next_cursor,
        knowledgeTotal: page.total,
        knowledgeDocuments: page.items,
        error: null,
      });
      return true;
    } catch (error) {
      if (id !== listRead || controller.signal.aborted || viewChanged()) return false;
      set({ error: errorText(error) });
      return false;
    } finally {
      if (id === listRead) set({ knowledgeLoading: false });
      if (listAbort === controller) listAbort = null;
    }
  };
  return {
    loadKnowledge: async (filters) => {
      if (guard()) return false;
      // 刷新保过滤；指定过滤则合并（含清空）并回第一页，光标先落位再取页。
      const next = filters ? { ...get().knowledgeFilters, ...filters } : get().knowledgeFilters;
      set({ knowledgeFilters: next, knowledgeCursors: [null], knowledgeNextCursor: null });
      return loadList(next, [null]);
    },
    loadKnowledgePage: async (direction) => {
      const cursors = get().knowledgeCursors;
      const target =
        direction === "next"
          ? get().knowledgeNextCursor === null
            ? null
            : [...cursors, get().knowledgeNextCursor]
          : cursors.length > 1
            ? cursors.slice(0, -1)
            : null;
      if (!target) return false;
      return loadList(get().knowledgeFilters, target);
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
          // 资料设置只维护自动整理；预算归系统能力→知识查询的全局分组，不在此保留第二份副本。
          editor = {
            kind: "settings",
            source,
            auto_enabled: source.auto_enabled,
            model_name: source.model_name ?? "",
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
          // 资料设置只提交 auto_enabled；模型与预算从共享的最新基线合并，避免用陈旧预算
          // 覆盖另一处刚保存的新值（旧编辑器副本里的值一律不提交）。基线若仍被并发推进，
          // CAS 冲突只报错并保留草稿，等用户刷新后重试。
          const baseline =
            latestKnowledgeSettings([
              get().knowledgeSettings,
              get().knowledgeModelEditor?.source,
              editor.source,
            ]) ?? editor.source;
          const parsed = KnowledgeSettingsUpdateSchema.safeParse({
            expected_revision: baseline.revision,
            auto_enabled: editor.auto_enabled,
            model_name: baseline.model_name,
            context_budget: baseline.context_budget,
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
        // 删除的正是当前过滤的分类时，过滤回到全部，否则刷新会继续按已删分类取空页。
        if (kind === "category" && get().knowledgeFilters.category === id)
          set({ knowledgeFilters: { ...get().knowledgeFilters, category: "all" } });
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
