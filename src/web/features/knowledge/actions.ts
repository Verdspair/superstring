import {
  KnowledgeDocumentUpdateSchema,
  KnowledgeImportSchema,
  KnowledgeSettingsUpdateSchema,
} from "../../../shared/contracts/knowledge";
import { ApiError } from "../../api";
import { msg } from "../../i18n";
import { errorText } from "../../state/helpers";
import type { StoreGet, StoreSet } from "../../state/types";
import { acceptKnowledgeSettings, readKnowledgeSettings } from "./settings-read";
import {
  type KnowledgeEditor,
  type KnowledgeListFilters,
  type KnowledgeState,
  knowledgeFieldConflict,
  knowledgeGrantIdsEqual,
  knowledgeListQuery,
  knowledgeSettingsConflictScope,
  knowledgeSettingsDirty,
  latestKnowledgeSettings,
} from "./types";

export function createKnowledgeActions(
  set: StoreSet,
  get: StoreGet,
): Pick<
  KnowledgeState,
  | "resumeKnowledgeLibraryRead"
  | "cancelKnowledgeLibraryRead"
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
  let saveToken = 0;
  let editorAbort: AbortController | null = null;
  let editorTarget: import("./types").KnowledgeTarget | null = null;
  let editorApi: ReturnType<StoreGet>["apiClient"] | null = null;
  let suspended = false;
  /** 后台预热的在途记录：来源 api、过滤条件与承诺，供前台接管同一次首页读取。 */
  let warmInflight: {
    api: ReturnType<StoreGet>["apiClient"];
    filterKey: string;
    promise: Promise<boolean>;
  } | null = null;
  const listKey = (filters: KnowledgeListFilters, cursors: (string | null)[]) =>
    [filters.search, filters.category, filters.status, cursors.join(",")].join("\u0000");
  const loadList = async (
    filters: KnowledgeListFilters,
    cursors: (string | null)[],
    background = false,
    // quiet：已有可用列表时的静默权威刷新，不动 loading 与 error 显示。
    quiet = false,
  ): Promise<boolean> => {
    if (guard()) return false;
    const api = get().apiClient;
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
    // 预热在其它分区后台发起，写回不依赖当前页面身份；前台读保留页面保护。
    const viewChanged = () =>
      !background &&
      (get().page !== view.page ||
        get().settingsView !== view.settingsView ||
        get().settingsRoute !== view.settingsRoute);
    if (!quiet) set({ knowledgeLoading: true });
    try {
      const [page, categories, settings] = await Promise.all([
        api.listKnowledgeDocuments(
          knowledgeListQuery(filters, cursors[cursors.length - 1] ?? null),
          controller.signal,
        ),
        api.listKnowledgeCategories(controller.signal),
        readKnowledgeSettings(get, { signal: controller.signal }),
      ]);
      // 同源校验：切换 api 后的迟到响应不写回旧客户端的数据。
      if (id !== listRead || viewChanged() || get().apiClient !== api) return false;
      set({
        knowledgeCategories: categories,
        knowledgeSettings: settings,
        knowledgeCursors: cursors,
        knowledgeNextCursor: page.next_cursor,
        knowledgeTotal: page.total,
        knowledgeDocuments: page.items,
        knowledgeLoaded: true,
        // 后台预热与静默刷新成功不清理无关的全局 error。
        ...(background || quiet ? {} : { knowledgeLibraryError: null }),
      });
      return true;
    } catch (error) {
      if (id !== listRead || controller.signal.aborted || viewChanged() || get().apiClient !== api)
        return false;
      // 预热与静默刷新失败静默降级：不占用全局 error，前台显式读取时自然重取并提示。
      if (!background && !quiet) set({ knowledgeLibraryError: errorText(error) });
      return false;
    } finally {
      controller.abort();
      if (!quiet && id === listRead && get().apiClient === api) set({ knowledgeLoading: false });
      if (listAbort === controller) listAbort = null;
    }
  };
  return {
    resumeKnowledgeLibraryRead: async () => {
      if (get().knowledgeBusy) return false;
      const resume = suspended;
      suspended = false;
      const api = get().apiClient;
      const editor = get().knowledgeEditor;
      const target = editorApi === api ? editorTarget : null;
      if (editorApi && editorApi !== api) {
        editorTarget = null;
        set({ knowledgeEditor: null, knowledgeDirty: false });
      }
      const list = get().loadKnowledge(undefined, { quiet: true });
      if (!resume || !target || target.kind === "none") return list;
      if (!editor) {
        const reopened = await get().openKnowledgeEditor(target);
        await list;
        return reopened;
      }
      if (editor.kind !== "document" && editor.kind !== "grants" && editor.kind !== "settings")
        return list;
      const id = get().knowledgeReadId;
      const dirty = get().knowledgeDirty;
      const controller = new AbortController();
      editorAbort?.abort();
      editorAbort = controller;
      const matches = () =>
        get().apiClient === api &&
        get().knowledgeReadId === id &&
        get().knowledgeEditor === editor &&
        !controller.signal.aborted;
      try {
        if (editor.kind === "settings") {
          const source = await readKnowledgeSettings(get, { signal: controller.signal });
          if (matches()) {
            const conflict =
              dirty &&
              knowledgeFieldConflict(
                editor.source.auto_enabled,
                editor.auto_enabled,
                source.auto_enabled,
              );
            set({
              knowledgeSettings: source,
              ...(conflict
                ? {
                    knowledgeLibraryError: msg(
                      "知识库远端内容已更改；本地草稿保留，未自动推进保存版本。请刷新并核对后重试。",
                    ),
                  }
                : {
                    knowledgeEditor: {
                      ...editor,
                      source,
                      auto_enabled:
                        dirty && editor.auto_enabled !== editor.source.auto_enabled
                          ? editor.auto_enabled
                          : source.auto_enabled,
                      model_name: source.model_name ?? "",
                    },
                  }),
            });
          }
        } else {
          const source = await api.getKnowledgeDocument(editor.source.id, controller.signal);
          if (matches()) {
            if (editor.kind === "grants") {
              const idsDirty =
                dirty && !knowledgeGrantIdsEqual(editor.agent_ids, editor.source.agent_ids);
              const conflict =
                (idsDirty &&
                  !knowledgeGrantIdsEqual(source.agent_ids, editor.source.agent_ids) &&
                  !knowledgeGrantIdsEqual(source.agent_ids, editor.agent_ids)) ||
                (dirty &&
                  knowledgeFieldConflict(
                    editor.source.visibility,
                    editor.visibility,
                    source.visibility,
                  ));
              set(
                conflict
                  ? {
                      knowledgeLibraryError: msg(
                        "知识库远端内容已更改；本地草稿保留，未自动推进保存版本。请刷新并核对后重试。",
                      ),
                    }
                  : {
                      knowledgeEditor: {
                        ...editor,
                        source,
                        agent_ids: idsDirty ? editor.agent_ids : [...source.agent_ids],
                        visibility:
                          dirty && editor.visibility !== editor.source.visibility
                            ? editor.visibility
                            : source.visibility,
                      },
                    },
              );
            } else {
              const fields = ["name", "category_id", "original_text", "content_mode"] as const;
              const conflict =
                dirty &&
                fields.some((key) =>
                  knowledgeFieldConflict(editor.source[key], editor[key], source[key]),
                );
              set(
                conflict
                  ? {
                      knowledgeLibraryError: msg(
                        "知识库远端内容已更改；本地草稿保留，未自动推进保存版本。请刷新并核对后重试。",
                      ),
                    }
                  : {
                      knowledgeEditor: {
                        ...editor,
                        source,
                        name:
                          dirty && editor.name !== editor.source.name ? editor.name : source.name,
                        category_id:
                          dirty && editor.category_id !== editor.source.category_id
                            ? editor.category_id
                            : source.category_id,
                        original_text:
                          dirty && editor.original_text !== editor.source.original_text
                            ? editor.original_text
                            : source.original_text,
                        content_mode:
                          dirty && editor.content_mode !== editor.source.content_mode
                            ? editor.content_mode
                            : source.content_mode,
                      },
                    },
              );
            }
          }
        }
      } catch (error) {
        if (matches()) set({ knowledgeLibraryError: errorText(error) });
      } finally {
        controller.abort();
        if (editorAbort === controller) editorAbort = null;
      }
      return list;
    },
    cancelKnowledgeLibraryRead: () => {
      suspended = true;
      listRead++;
      listAbort?.abort();
      listAbort = null;
      warmInflight = null;
      editorAbort?.abort();
      editorAbort = null;
      set({
        ...(get().knowledgeBusy ? {} : { knowledgeReadId: get().knowledgeReadId + 1 }),
        knowledgeLoading: false,
      });
    },
    loadKnowledge: async (filters, options) => {
      const api = get().apiClient;
      if (options?.background) {
        // 启动预热：busy/脏数据时静默让位；列表已就绪则直接复用；同一时刻共享同一在途预热。
        if (guard()) return false;
        if (get().knowledgeLoaded) return true;
        if (warmInflight && warmInflight.api === api) return warmInflight.promise;
        // 预热只取当前默认过滤的第一页，不先改用户的过滤与光标状态；
        // 真实页与光标在权威响应落地时才写入。
        const warmFilters = filters
          ? { ...get().knowledgeFilters, ...filters }
          : get().knowledgeFilters;
        const task = loadList(warmFilters, [null], true);
        warmInflight = { api, filterKey: listKey(warmFilters, [null]), promise: task };
        // 只有本次预热自己能清掉在途记录：新请求不会被旧预热的 finally 清空。
        void task.finally(() => {
          if (warmInflight?.promise === task) warmInflight = null;
        });
        return task;
      }
      if (guard()) return false;
      // 刷新保过滤；指定过滤则合并（含清空）并回第一页，光标先落位再取页。
      const next = filters ? { ...get().knowledgeFilters, ...filters } : get().knowledgeFilters;
      // 默认前台读取：同源同过滤且预热在途时接管那一次读取，不重发也不作废它。
      if (
        !filters &&
        warmInflight &&
        warmInflight.api === api &&
        warmInflight.filterKey === listKey(next, [null])
      )
        return warmInflight.promise;
      set({ knowledgeFilters: next, knowledgeCursors: [null], knowledgeNextCursor: null });
      // 挂载/静默刷新不阻塞当前数据也不占用 error 提示；用户刷新与重试仍是显式 loud 语义。
      return loadList(next, [null], false, options?.quiet === true);
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
      if (
        get().knowledgeDirty ||
        (get().knowledgeEditor?.kind === "settings" && knowledgeSettingsDirty(get()))
      ) {
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
      const api = get().apiClient;
      suspended = false;
      editorTarget = target;
      editorApi = api;
      editorAbort?.abort();
      const controller = new AbortController();
      editorAbort = controller;
      const id = get().knowledgeReadId + 1;
      const matches = () =>
        get().apiClient === api && get().knowledgeReadId === id && !controller.signal.aborted;
      set({ knowledgeReadId: id, knowledgeLoading: true, knowledgeLibraryError: null });
      try {
        let editor: KnowledgeEditor | null = null;
        if (target.kind === "document" || target.kind === "grants") {
          const source = await api.getKnowledgeDocument(target.id, controller.signal);
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
              : {
                  kind: "grants",
                  source,
                  agent_ids: [...source.agent_ids],
                  visibility: source.visibility ?? null,
                };
        } else if (target.kind === "settings") {
          const source = await readKnowledgeSettings(get, { signal: controller.signal });
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
        if (!matches() || get().knowledgeDirty) return false;
        set({ knowledgeEditor: editor, knowledgeDirty: false });
        return true;
      } catch (error) {
        if (matches()) set({ knowledgeLibraryError: errorText(error) });
        return false;
      } finally {
        if (matches()) set({ knowledgeLoading: false });
        controller.abort();
        if (editorAbort === controller) editorAbort = null;
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
      editorTarget = null;
      editorAbort?.abort();
      editorAbort = null;
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
      const capturedApi = get().apiClient;
      const capturedEditor = editor;
      const capturedReadId = get().knowledgeReadId;
      const thisToken = ++saveToken;
      let expectedEditor: KnowledgeEditor = capturedEditor;

      const isCurrentTarget = () => {
        if (
          get().apiClient !== capturedApi ||
          get().knowledgeReadId !== capturedReadId ||
          saveToken !== thisToken
        ) {
          return false;
        }
        return get().knowledgeEditor === expectedEditor;
      };

      set({ knowledgeBusy: true, knowledgeLibraryError: null });
      try {
        const api = capturedApi;
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
        } else if (editor.kind === "grants") {
          const visibilityToSend =
            editor.visibility === "private" || editor.visibility === "public"
              ? editor.visibility
              : undefined;
          await api.saveKnowledgeGrants(
            editor.source.id,
            editor.source.revision,
            editor.agent_ids,
            visibilityToSend,
          );
        } else if (editor.kind === "settings") {
          const settingsEditor = editor;
          // 资料设置只提交 auto_enabled；模型与预算从共享的最新基线合并，避免用陈旧预算
          // 覆盖另一处刚保存的新值（旧编辑器副本里的值一律不提交）。基线若仍被并发推进，
          // CAS 冲突只报错并保留草稿，等用户刷新后重试。
          const baseline =
            latestKnowledgeSettings([
              get().knowledgeSettings,
              get().knowledgeModelEditor?.source,
              settingsEditor.source,
            ]) ?? settingsEditor.source;
          const autoDirty = settingsEditor.auto_enabled !== settingsEditor.source.auto_enabled;
          const conflict = knowledgeFieldConflict(
            settingsEditor.source.auto_enabled,
            settingsEditor.auto_enabled,
            baseline.auto_enabled,
          );
          const parsed = KnowledgeSettingsUpdateSchema.safeParse({
            expected_revision: conflict ? settingsEditor.source.revision : baseline.revision,
            auto_enabled: autoDirty ? settingsEditor.auto_enabled : baseline.auto_enabled,
            model_name: baseline.model_name,
            context_budget: baseline.context_budget,
          });
          if (!parsed.success) throw new Error(msg("上下文预算必须为正整数。"));
          const saved = await api.saveKnowledgeSettings(parsed.data);
          acceptKnowledgeSettings(get, api, saved);

          if (!isCurrentTarget()) {
            return false;
          }

          const modelEditor = get().knowledgeModelEditor;
          const modelConflict = modelEditor && knowledgeSettingsConflictScope(modelEditor, saved);
          const keepSettingsOpen = knowledgeSettingsDirty({ ...get(), knowledgeDirty: false });

          if (keepSettingsOpen) {
            expectedEditor = { ...settingsEditor, source: saved };
          }

          set({
            knowledgeSettings: saved,
            ...(get().knowledgeReadEditor
              ? {
                  knowledgeReadEditor: {
                    ...get().knowledgeReadEditor!,
                    globalBudget: saved.context_budget,
                  },
                }
              : {}),
            ...(keepSettingsOpen ? { knowledgeEditor: expectedEditor } : {}),
            ...(modelEditor && modelConflict
              ? {
                  knowledgeModelError: {
                    ...get().knowledgeModelError,
                    [modelConflict === "both" ? "shared" : modelConflict!]: msg(
                      "知识库远端内容已更改；本地草稿保留，未自动推进保存版本。请刷新并核对后重试。",
                    ),
                  },
                }
              : modelEditor
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
        if (!isCurrentTarget()) {
          return false;
        }

        const keepSettingsOpen =
          editor.kind === "settings" && knowledgeSettingsDirty({ ...get(), knowledgeDirty: false });
        set({
          knowledgeEditor: keepSettingsOpen && editor.kind === "settings" ? expectedEditor : null,
          knowledgeDirty: false,
          knowledgeBusy: false,
          feedback: msg("知识库修改已保存。"),
        });
        await get().loadKnowledge();
        if (get().knowledgeReadEditor) await get().loadKnowledgeRead();
        return true;
      } catch (error) {
        if (isCurrentTarget()) {
          set({
            knowledgeLibraryError:
              error instanceof ApiError && error.code === "KNOWLEDGE_REVISION_CONFLICT"
                ? msg(
                    "知识库远端内容已更改；本地草稿保留，未自动推进保存版本。请刷新并核对后重试。",
                  )
                : errorText(error),
          });
        }
        return false;
      } finally {
        if (
          get().apiClient === capturedApi &&
          get().knowledgeReadId === capturedReadId &&
          saveToken === thisToken
        ) {
          set({ knowledgeBusy: false });
        }
      }
    },
    deleteKnowledgeItem: async (kind, id, revision, moveTo) => {
      if (guard() || get().knowledgeLoading) return false;
      const api = get().apiClient;
      const readId = get().knowledgeReadId;
      const token = ++saveToken;
      const matches = () =>
        get().apiClient === api && get().knowledgeReadId === readId && saveToken === token;
      set({ knowledgeBusy: true, knowledgeLibraryError: null });
      try {
        if (kind === "document") await api.deleteKnowledgeDocument(id, revision);
        else await api.deleteKnowledgeCategory(id, revision, moveTo);
        if (!matches()) return false;
        if (kind === "category" && get().knowledgeFilters.category === id)
          set({ knowledgeFilters: { ...get().knowledgeFilters, category: "all" } });
        set({ knowledgeBusy: false, knowledgeEditor: null });
        await get().loadKnowledge();
        return matches();
      } catch (error) {
        if (matches()) set({ knowledgeLibraryError: errorText(error) });
        return false;
      } finally {
        if (matches()) set({ knowledgeBusy: false });
      }
    },
    setKnowledgeMode: async (id, mode) => {
      if (guard() || get().knowledgeLoading) return false;
      const document = get().knowledgeDocuments.find((item) => item.id === id);
      if (!document) return false;
      const api = get().apiClient;
      const readId = get().knowledgeReadId;
      const token = ++saveToken;
      const matches = () =>
        get().apiClient === api && get().knowledgeReadId === readId && saveToken === token;
      set({ knowledgeBusy: true, knowledgeLibraryError: null });
      try {
        await api.updateKnowledgeDocument(id, {
          expected_revision: document.revision,
          content_mode: mode,
        });
        if (!matches()) return false;
        set({ knowledgeBusy: false, knowledgeEditor: null });
        await get().loadKnowledge();
        return matches();
      } catch (error) {
        if (matches()) set({ knowledgeLibraryError: errorText(error) });
        return false;
      } finally {
        if (matches()) set({ knowledgeBusy: false });
      }
    },
  };
}
