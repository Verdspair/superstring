import { AgentKnowledgeReadUpdateSchema } from "../../../shared/contracts/knowledge";
import { ApiError } from "../../api";
import { msg } from "../../i18n";
import { errorText } from "../../state/helpers";
import type { StoreGet, StoreSet } from "../../state/types";
import { readKnowledgeSettings } from "./settings-read";
import {
  type KnowledgeState,
  knowledgeFieldConflict,
  knowledgeGrantIdsEqual,
  knowledgeReadDirty,
} from "./types";

type KnowledgeActions = Pick<
  KnowledgeState,
  | "cancelKnowledgeRead"
  | "loadKnowledgeRead"
  | "refreshKnowledgeRead"
  | "patchKnowledgeRead"
  | "saveKnowledgeRead"
  | "discardKnowledgeRead"
>;

type KnowledgeCapture = { api: ReturnType<StoreGet>["apiClient"]; agentId: string; token: object };

export function createKnowledgeReadActions(set: StoreSet, get: StoreGet) {
  let read = 0;
  let suspended = false;
  let lease: AbortController | null = null;
  let active: { api: ReturnType<StoreGet>["apiClient"]; agentId: string } | null = null;
  const load = async (
    refresh: boolean,
    baselineRefresh?: NonNullable<ReturnType<StoreGet>["editorBaselineRefresh"]>,
  ): Promise<boolean> => {
    const explicitRefresh = refresh;
    const agentId = get().editorAgentId;
    const api = get().apiClient;
    refresh =
      refresh ||
      (suspended &&
        active?.api === api &&
        active.agentId === agentId &&
        get().knowledgeReadEditor?.agentId === agentId);
    const isBaselineRefresh =
      !!baselineRefresh &&
      get().editorBaselineRefresh === baselineRefresh &&
      baselineRefresh.api === api &&
      baselineRefresh.agentId === agentId &&
      baselineRefresh.token === get().pageEditor?.token;
    if (
      agentId === "__new__" ||
      (get().editorLoading && !isBaselineRefresh) ||
      get().settingsSaving ||
      (get().knowledgeReadLoading && active?.api === api && active.agentId === agentId && !refresh)
    )
      return false;
    suspended = false;
    const previous = active && active.api !== api ? null : get().knowledgeReadEditor;
    lease?.abort();
    const controller = new AbortController();
    lease = controller;
    const request = ++read;
    active = { api, agentId };
    const editor = previous?.agentId === agentId ? previous : null;
    set({ knowledgeReadLoading: true, knowledgeReadError: null });
    const matches = () =>
      request === read && get().editorAgentId === agentId && get().apiClient === api;
    try {
      const [source, documents, global] = await Promise.all([
        editor && knowledgeReadDirty(editor) && !refresh
          ? Promise.resolve(editor.source)
          : api.getAgentKnowledgeRead(agentId, controller.signal),
        api.listAgentKnowledge(agentId, controller.signal),
        readKnowledgeSettings(get, { force: refresh, signal: controller.signal }),
      ]);
      if (!matches()) return false;
      if (!explicitRefresh && editor && knowledgeReadDirty(editor)) {
        const baseline = editor.source.config,
          draft = editor.draft,
          remote = source.config;
        const selectionDirty =
          draft.scope !== baseline.scope ||
          !knowledgeGrantIdsEqual(draft.document_ids, baseline.document_ids);
        const selectionRemoteChanged =
          remote.scope !== baseline.scope ||
          !knowledgeGrantIdsEqual(remote.document_ids, baseline.document_ids);
        const selectionEqual =
          draft.scope === remote.scope &&
          knowledgeGrantIdsEqual(draft.document_ids, remote.document_ids);
        if (
          knowledgeFieldConflict(baseline.enabled, draft.enabled, remote.enabled) ||
          knowledgeFieldConflict(
            baseline.context_budget,
            draft.context_budget,
            remote.context_budget,
          ) ||
          (selectionDirty && selectionRemoteChanged && !selectionEqual)
        ) {
          set({
            knowledgeReadEditor: { ...editor, documents, globalBudget: global.context_budget },
            knowledgeSettings: global,
            knowledgeReadError: msg(
              "读取配置已被其他操作修改；草稿已保留。请刷新保存基线，核对后再次保存。",
            ),
          });
          return false;
        }
      }
      set({
        knowledgeReadEditor: {
          token: editor?.token ?? {},
          agentId,
          source,
          draft:
            editor && knowledgeReadDirty(editor)
              ? {
                  enabled:
                    editor.draft.enabled !== editor.source.config.enabled
                      ? editor.draft.enabled
                      : source.config.enabled,
                  context_budget:
                    editor.draft.context_budget !== editor.source.config.context_budget
                      ? editor.draft.context_budget
                      : source.config.context_budget,
                  scope:
                    editor.draft.scope !== editor.source.config.scope ||
                    !knowledgeGrantIdsEqual(
                      editor.draft.document_ids,
                      editor.source.config.document_ids,
                    )
                      ? editor.draft.scope
                      : source.config.scope,
                  document_ids:
                    editor.draft.scope !== editor.source.config.scope ||
                    !knowledgeGrantIdsEqual(
                      editor.draft.document_ids,
                      editor.source.config.document_ids,
                    )
                      ? editor.draft.document_ids
                      : source.config.document_ids,
                }
              : structuredClone(source.config),
          documents,
          globalBudget: global.context_budget,
        },
        knowledgeSettings: global,
        knowledgeReadError: null,
        ...(refresh
          ? {
              feedback: msg("已刷新保存基线与授权列表，当前草稿保留；请核对后再次保存。"),
            }
          : {}),
      });
      return true;
    } catch (error) {
      if (matches()) set({ knowledgeReadError: errorText(error) });
      return false;
    } finally {
      controller.abort();
      if (lease === controller) lease = null;
      if (matches()) set({ knowledgeReadLoading: false });
    }
  };
  let saveOwner: object | null = null;
  const taskStep = {
    prepareRefresh() {
      const generation = read;
      const api = get().apiClient;
      const agentId = get().editorAgentId;
      const token = get().pageEditor?.token;
      return async (operation: NonNullable<ReturnType<StoreGet>["editorBaselineRefresh"]>) => {
        if (
          generation !== read ||
          get().apiClient !== api ||
          get().editorAgentId !== agentId ||
          get().pageEditor?.token !== token ||
          get().editorBaselineRefresh !== operation ||
          document.visibilityState === "hidden"
        )
          return false;
        return load(true, operation);
      };
    },
    acquire(owner: object) {
      saveOwner = owner;
      set({ settingsSaveOwner: owner });
    },
    release(owner: object) {
      if (saveOwner === owner) {
        saveOwner = null;
        if (get().settingsSaveOwner === owner)
          set({ settingsSaving: false, settingsSaveOwner: null });
      }
    },
    capture(): KnowledgeCapture | null {
      const editor = get().knowledgeReadEditor;
      if (editor && editor.agentId !== get().editorAgentId) return null;
      if (
        editor &&
        `agent:${editor.agentId}:reading:knowledgeAgent` in get().allocationInvalidInputs
      )
        throw new Error(msg("上下文预算必须为正整数。"));
      if (!knowledgeReadDirty(editor)) return null;
      if (
        !editor ||
        editor.agentId !== get().editorAgentId ||
        get().knowledgeReadLoading ||
        get().knowledgeBusy
      )
        throw new Error(msg("保存失败，请修正后重试或取消。"));
      if (
        !AgentKnowledgeReadUpdateSchema.safeParse({
          expected_revision: editor.source.revision,
          config: editor.draft,
        }).success
      )
        throw new Error(msg("上下文预算必须为正整数。"));
      return { api: get().apiClient, agentId: editor.agentId, token: editor.token };
    },
    matches(capture: KnowledgeCapture): boolean {
      return (
        get().apiClient === capture.api &&
        get().editorAgentId === capture.agentId &&
        get().knowledgeReadEditor?.token === capture.token
      );
    },
    async commit(capture: KnowledgeCapture): Promise<boolean> {
      if (!taskStep.matches(capture)) return false;
      const editor = get().knowledgeReadEditor;
      if (!editor) return false;
      const parsed = AgentKnowledgeReadUpdateSchema.parse({
        expected_revision: editor.source.revision,
        config: editor.draft,
      });
      try {
        const saved = await capture.api.saveAgentKnowledgeRead(capture.agentId, parsed);
        if (!taskStep.matches(capture)) return false;
        set({
          knowledgeReadEditor: { ...editor, source: saved, draft: structuredClone(saved.config) },
          knowledgeReadError: null,
        });
        return true;
      } catch (error) {
        if (!taskStep.matches(capture)) return false;
        set({
          error:
            error instanceof ApiError && error.code === "KNOWLEDGE_REVISION_CONFLICT"
              ? msg("读取配置已被其他操作修改；草稿已保留。请刷新保存基线，核对后再次保存。")
              : errorText(error),
        });
        if (error instanceof ApiError && error.code === "KNOWLEDGE_NOT_FOUND") {
          try {
            const documents = await capture.api.listAgentKnowledge(capture.agentId);
            if (taskStep.matches(capture)) {
              const current = get().knowledgeReadEditor;
              if (current)
                set({
                  knowledgeReadEditor: { ...current, documents },
                  error: msg("部分指定资料已失效，请移除后保存；不会自动扩大读取范围。"),
                });
            }
          } catch {
            /* Preserve the original save failure. */
          }
        }
        return false;
      }
    },
  };
  const actions: KnowledgeActions = {
    cancelKnowledgeRead: () => {
      suspended = document.visibilityState === "hidden";
      read++;
      lease?.abort();
      lease = null;
      set({ knowledgeReadLoading: false });
    },
    loadKnowledgeRead: async () => {
      await load(false);
    },
    refreshKnowledgeRead: async () => {
      await load(true);
    },
    patchKnowledgeRead: (patch) => {
      const editor = get().knowledgeReadEditor;
      if (
        !editor ||
        editor.agentId !== get().editorAgentId ||
        get().settingsSaving ||
        get().editorLoading ||
        get().knowledgeReadLoading
      )
        return;
      const draft = { ...editor.draft, ...patch };
      if (draft.scope === "all") draft.document_ids = [];
      set({ knowledgeReadEditor: { ...editor, draft }, feedback: "", agentTaskResult: null });
    },
    saveKnowledgeRead: async () => {
      if (get().settingsSaving || get().editorLoading) return false;
      let capture: KnowledgeCapture | null;
      try {
        capture = taskStep.capture();
      } catch (error) {
        set({ error: errorText(error) });
        return false;
      }
      if (!capture) return true;
      const operation = {};
      taskStep.acquire(operation);
      set({ settingsSaving: true, error: null, feedback: "" });
      try {
        if (!(await taskStep.commit(capture))) return false;
        set({ feedback: msg("助手知识库读取配置已保存；其他页面与全局草稿保持不变。") });
        return true;
      } catch (error) {
        if (taskStep.matches(capture)) set({ error: errorText(error) });
        return false;
      } finally {
        taskStep.release(operation);
      }
    },
    discardKnowledgeRead: (options) => {
      if (get().settingsSaving) return;
      const id = get().knowledgeReadEditor?.agentId;
      if (id) {
        const { [`agent:${id}:reading:knowledgeAgent`]: _invalid, ...allocationInvalidInputs } =
          get().allocationInvalidInputs;
        set({ allocationInvalidInputs });
      }
      read++;
      lease?.abort();
      lease = null;
      const editor = get().knowledgeReadEditor;
      set({
        knowledgeReadEditor:
          options?.preserveBaseline && editor
            ? { ...editor, draft: structuredClone(editor.source.config) }
            : null,
        knowledgeReadLoading: false,
        knowledgeReadError: null,
      });
    },
  };
  return { actions, taskStep };
}
