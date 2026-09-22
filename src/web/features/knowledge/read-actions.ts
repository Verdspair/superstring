import { AgentKnowledgeReadUpdateSchema } from "../../../shared/contracts/knowledge";
import { ApiError } from "../../api";
import { msg } from "../../i18n";
import { errorText } from "../../state/helpers";
import type { StoreGet, StoreSet } from "../../state/types";
import { type KnowledgeState, knowledgeReadDirty } from "./types";

export function createKnowledgeReadActions(
  set: StoreSet,
  get: StoreGet,
): Pick<
  KnowledgeState,
  | "loadKnowledgeRead"
  | "refreshKnowledgeRead"
  | "patchKnowledgeRead"
  | "saveKnowledgeRead"
  | "discardKnowledgeRead"
> {
  let read = 0;
  const load = async (refresh: boolean) => {
    const agentId = get().editorAgentId;
    if (
      agentId === "__new__" ||
      get().editorLoading ||
      get().settingsSaving ||
      get().knowledgeReadLoading
    )
      return;
    const request = ++read;
    const previous = get().knowledgeReadEditor;
    const editor = previous?.agentId === agentId ? previous : null;
    set({ knowledgeReadLoading: true });
    const matches = () => request === read && get().editorAgentId === agentId;
    try {
      const api = get().apiClient;
      const [source, documents, global] = await Promise.all([
        editor && knowledgeReadDirty(editor) && !refresh
          ? Promise.resolve(editor.source)
          : api.getAgentKnowledgeRead(agentId),
        api.listAgentKnowledge(agentId),
        api.getKnowledgeSettings(),
      ]);
      if (!matches()) return;
      set({
        knowledgeReadEditor: {
          token: editor?.token ?? {},
          agentId,
          source,
          draft:
            editor && knowledgeReadDirty(editor) ? editor.draft : structuredClone(source.config),
          documents,
          globalBudget: global.context_budget,
        },
        error: null,
        ...(refresh
          ? {
              feedback: msg("已刷新保存基线与授权列表，当前草稿保留；请核对后再次保存。"),
            }
          : {}),
      });
    } catch (error) {
      if (matches()) set({ error: errorText(error) });
    } finally {
      if (matches()) set({ knowledgeReadLoading: false });
    }
  };
  return {
    loadKnowledgeRead: () => load(false),
    refreshKnowledgeRead: () => load(true),
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
      set({ knowledgeReadEditor: { ...editor, draft }, feedback: "" });
    },
    saveKnowledgeRead: async () => {
      const editor = get().knowledgeReadEditor;
      if (!knowledgeReadDirty(editor)) return true;
      if (
        !editor ||
        editor.agentId !== get().editorAgentId ||
        get().settingsSaving ||
        get().editorLoading ||
        get().knowledgeReadLoading ||
        get().knowledgeBusy
      )
        return false;
      const parsed = AgentKnowledgeReadUpdateSchema.safeParse({
        expected_revision: editor.source.revision,
        config: editor.draft,
      });
      if (!parsed.success) {
        set({ error: msg("上下文预算必须为正整数。") });
        return false;
      }
      set({ settingsSaving: true, error: null, feedback: "" });
      const matches = () =>
        get().knowledgeReadEditor?.token === editor.token && get().editorAgentId === editor.agentId;
      try {
        const saved = await get().apiClient.saveAgentKnowledgeRead(editor.agentId, parsed.data);
        if (!matches()) return false;
        set({
          knowledgeReadEditor: {
            ...editor,
            source: saved,
            draft: structuredClone(saved.config),
          },
          feedback: msg("助手知识库读取配置已保存；其他页面与全局草稿保持不变。"),
        });
        return true;
      } catch (error) {
        if (matches())
          set({
            error:
              error instanceof ApiError && error.code === "KNOWLEDGE_REVISION_CONFLICT"
                ? msg("读取配置已被其他操作修改；草稿已保留。请刷新保存基线，核对后再次保存。")
                : errorText(error),
          });
        if (error instanceof ApiError && error.code === "KNOWLEDGE_NOT_FOUND") {
          try {
            const documents = await get().apiClient.listAgentKnowledge(editor.agentId);
            if (matches())
              set({
                knowledgeReadEditor: { ...editor, documents },
                error: msg("部分指定资料已失效，请移除后保存；不会自动扩大读取范围。"),
              });
          } catch {
            /* Keep the earlier save failure and draft if the refresh also fails. */
          }
        }
        return false;
      } finally {
        set({ settingsSaving: false });
      }
    },
    discardKnowledgeRead: () => {
      if (get().settingsSaving) return;
      read++;
      set({ knowledgeReadEditor: null, knowledgeReadLoading: false });
    },
  };
}
