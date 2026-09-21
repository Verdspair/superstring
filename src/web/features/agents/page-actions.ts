import { msg } from "../../i18n";
import { errorText } from "../../state/helpers";
import type { StoreGet, StoreSet, SuperstringState } from "../../state/types";
import { toDraft } from "./draft";
import {
  acceptPageAgent,
  acceptPagePersona,
  agentPageDirty,
  dirtyPages,
  type EditablePage,
  PAGE_AGENT_FIELDS,
  PAGE_PERSONA_FIELDS,
  type PageEditor,
  POLICY_FIELDS,
  p5Fields,
  pageAgentPayload,
  pagePersonaPayload,
  personaPageDirty,
  policyDirty,
} from "./page-drafts";

export function createPageActions(
  set: StoreSet,
  get: StoreGet,
): Pick<
  SuperstringState,
  | "patchPageAgent"
  | "patchPagePersona"
  | "patchPagePolicy"
  | "saveSettingsPage"
  | "saveAllSettingsPages"
  | "discardSettingsPages"
> {
  const publish = (editor: PageEditor) => {
    set((state) => ({
      pageEditor: editor,
      agents: state.agents.map((a) => (a.id === editor.agent.id ? editor.agent : a)),
      // The transition editor receives only saved values, never workspace drafts.
      editorDraft: toDraft(editor.agent),
      persona: editor.persona,
      policy: editor.policy,
    }));
  };
  const savePage = async (page: EditablePage, token: object): Promise<boolean> => {
    let editor = get().pageEditor;
    if (!editor || editor.token !== token) return false;
    const id = editor.agent.id;
    const matches = () => get().pageEditor?.token === token && get().editorAgentId === id;
    if (page !== "expression" && agentPageDirty(editor, page)) {
      if (page === "context" && editor.draft.p5_config.context_window !== null) {
        // Validate against the SAVED model, not another page's unsaved model choice.
        const capacity = await get().apiClient.getModelCapacity(editor.agent.model_name);
        if (!matches()) return false;
        if (capacity.context_length === null)
          throw new Error(msg("模型未加载或容量未知，无法校验自定义预算；可改为null跟随"));
        if (editor.draft.p5_config.context_window > capacity.context_length)
          throw new Error(msg("自定义上下文超过模型实际容量{0}", capacity.context_length));
      }
      const saved = await get().apiClient.updateAgent(id, pageAgentPayload(editor, page));
      if (!matches()) return false;
      editor = acceptPageAgent(editor, page, saved);
      publish(editor);
    }
    if (
      (page === "identity" || page === "expression") &&
      (personaPageDirty(editor, page) || (page === "expression" && agentPageDirty(editor, page)))
    ) {
      const saved = await get().apiClient.savePersona(id, pagePersonaPayload(editor, page));
      if (!matches()) return false;
      editor = acceptPagePersona(editor, page, saved);
      publish(editor);
    }
    if (page === "long-memory" && editor.policy && editor.policyDraft && policyDirty(editor)) {
      const saved = await get().apiClient.updatePolicy(id, {
        auto_enabled: editor.policyDraft.auto_enabled,
        every_turns: editor.policyDraft.every_turns,
        target_chars: editor.policyDraft.target_chars,
        expected_version: editor.policy.version,
      });
      if (!matches()) return false;
      editor = { ...editor, policy: saved, policyDraft: { ...saved } };
      publish(editor);
    }
    return true;
  };
  const save = async (pages: EditablePage[]) => {
    const editor = get().pageEditor;
    if (!editor || get().settingsSaving || get().editorLoading) return false;
    const token = editor.token;
    set({ settingsSaving: true, error: null, feedback: "" });
    try {
      for (const page of pages) if (!(await savePage(page, token))) return false;
      set({ feedback: msg("页面配置已保存；其他页面的草稿保持不变。") });
      return true;
    } catch (error) {
      if (get().pageEditor?.token === token)
        set({
          error: errorText(error),
          feedback: msg("保存未全部完成；已成功部分保留，未保存内容仍在草稿中。"),
        });
      return false;
    } finally {
      set({ settingsSaving: false });
    }
  };
  return {
    patchPageAgent: (page, patch) => {
      const editor = get().pageEditor;
      if (!editor || get().settingsSaving || get().editorLoading) return;
      const allowed = Object.fromEntries(
        PAGE_AGENT_FIELDS[page]
          .filter((key) => Object.hasOwn(patch, key))
          .map((key) => [key, patch[key]]),
      );
      set({
        pageEditor: {
          ...editor,
          draft: {
            ...editor.draft,
            ...allowed,
            p5_config: {
              ...editor.draft.p5_config,
              ...Object.fromEntries(
                p5Fields(page)
                  .filter((key) => patch.p5_config && Object.hasOwn(patch.p5_config, key))
                  .map((key) => [key, patch.p5_config?.[key]]),
              ),
            },
          },
        },
        feedback: "",
      });
    },
    patchPagePersona: (page, patch) => {
      const editor = get().pageEditor;
      if (!editor || get().settingsSaving || get().editorLoading) return;
      const allowed = Object.fromEntries(
        PAGE_PERSONA_FIELDS[page]
          .filter((key) => Object.hasOwn(patch, key))
          .map((key) => [key, patch[key]]),
      );
      set({
        pageEditor: {
          ...editor,
          personaDraft: { ...editor.personaDraft, ...allowed },
        },
        feedback: "",
      });
    },
    patchPagePolicy: (patch) => {
      const editor = get().pageEditor;
      if (!editor?.policyDraft || get().settingsSaving || get().editorLoading) return;
      const allowed = Object.fromEntries(
        POLICY_FIELDS.filter((key) => Object.hasOwn(patch, key)).map((key) => [key, patch[key]]),
      );
      set({
        pageEditor: {
          ...editor,
          policyDraft: { ...editor.policyDraft, ...allowed },
        },
        feedback: "",
      });
    },
    saveSettingsPage: (page) => save([page]),
    saveAllSettingsPages: () => save(dirtyPages(get().pageEditor)),
    discardSettingsPages: () => {
      const editor = get().pageEditor;
      if (get().settingsSaving || !editor) return;
      set({
        pageEditor: {
          ...editor,
          draft: toDraft(editor.agent),
          personaDraft: { ...editor.persona },
          policyDraft: editor.policy ? { ...editor.policy } : null,
        },
      });
    },
  };
}
