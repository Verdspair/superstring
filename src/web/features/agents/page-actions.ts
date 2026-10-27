import { SavePersonaRequestSchema, UpdateAgentRequestSchema } from "../../../shared/contracts";
import { msg } from "../../i18n";
import { errorText } from "../../state/helpers";
import type { AgentDraft, StoreGet, StoreSet, SuperstringState } from "../../state/types";
import type { createKnowledgeReadActions } from "../knowledge/read-actions";
import { knowledgeReadDirty } from "../knowledge/types";
import { toDraft } from "./draft";
import {
  acceptPageAgent,
  acceptPagePersona,
  agentPageDirty,
  dirtyPages,
  EDITABLE_PAGES,
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

type Presets = AgentDraft["p5_config"]["retrieval_presets"];
type Preset = Presets["conservative"];

/**
 * 逐档合并判据（写回通用，不依赖预设里「每个键都存在」的假设）：既有档保留缺席键，
 * 新增档整份带入；相对已保存基线被修改的键在刷新后继续保留。
 */
function mergePresetModes(
  baseline: Presets,
  each: (mode: keyof Presets, savedMode: Preset | undefined) => Preset | undefined,
): Presets {
  const merged: Record<string, unknown> = { ...baseline };
  for (const mode of PRESET_MODE_KEYS) merged[mode] = each(mode, baseline[mode]);
  return merged as unknown as Presets;
}
const PRESET_MODE_KEYS = ["conservative", "standard", "broad"] as const;

export function createPageActions(
  set: StoreSet,
  get: StoreGet,
  knowledgeStep: ReturnType<typeof createKnowledgeReadActions>["taskStep"],
): Pick<
  SuperstringState,
  | "patchPageAgent"
  | "patchPagePersona"
  | "patchPagePolicy"
  | "saveSettingsPage"
  | "saveAllSettingsPages"
  | "saveSettingsTask"
  | "settingsTaskDirty"
  | "discardSettingsTask"
  | "applyDefaultModelToAgent"
  | "discardSettingsPages"
  | "refreshSettingsAgent"
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
  const savePage = async (
    page: EditablePage,
    token: object,
    api: SuperstringState["apiClient"],
    capacityChecked = false,
    extraMatches: () => boolean = () => true,
  ): Promise<boolean> => {
    let editor = get().pageEditor;
    if (!editor || editor.token !== token) return false;
    const id = editor.agent.id;
    if (get().editorAgentId !== id || get().apiClient !== api || !extraMatches()) return false;
    if (
      page === "context" &&
      Object.keys(get().allocationInvalidInputs).some(
        (key) => key.startsWith(`agent:${id}:context:`) || key.startsWith(`agent:${id}:aux:`),
      )
    ) {
      throw new Error(msg("请先修正方案中的无效数字，再保存。"));
    }
    if (
      page === "memory-tools" &&
      Object.keys(get().allocationInvalidInputs).some((key) =>
        key.startsWith(`agent:${id}:reading:memory:`),
      )
    ) {
      throw new Error(msg("请先修正方案中的无效数字，再保存。"));
    }
    const matches = () =>
      get().pageEditor?.token === token &&
      get().editorAgentId === id &&
      get().apiClient === api &&
      extraMatches();
    // 只有用户本会话主动把存量 full 档改走时才由归一化触发保存；未改动的 full 档
    // 不再「进页即保存」，批量字段改动照常经 agentPageDirty 保存且 mode 保持 full。
    const normalizeMemoryMode =
      page === "memory-tools" &&
      editor.draft.p5_config.retrieval_mode !== editor.agent.p5_config.retrieval_mode &&
      (editor.draft.p5_config.retrieval_mode === "full_catalog" ||
        editor.draft.p5_config.retrieval_mode === "full_body");
    if (page !== "expression" && (agentPageDirty(editor, page) || normalizeMemoryMode)) {
      if (
        page === "context" &&
        !capacityChecked &&
        editor.draft.p5_config.context_window !== null
      ) {
        // Validate against the SAVED model, not another page's unsaved model choice.
        const capacity = await api.getModelCapacity(editor.agent.model_name);
        if (!matches()) return false;
        if (capacity.context_length === null)
          throw new Error(msg("模型未加载或容量未知，无法校验自定义预算；可改为null跟随"));
        if (editor.draft.p5_config.context_window > capacity.context_length)
          throw new Error(msg("自定义上下文超过模型实际容量{0}", capacity.context_length));
      }
      const saved = await api.updateAgent(id, pageAgentPayload(editor, page));
      if (!matches()) return false;
      editor = acceptPageAgent(editor, page, saved);
      publish(editor);
    }
    if (
      (page === "identity" || page === "expression") &&
      (personaPageDirty(editor, page) || (page === "expression" && agentPageDirty(editor, page)))
    ) {
      const saved = await api.savePersona(id, pagePersonaPayload(editor, page));
      if (!matches()) return false;
      editor = acceptPagePersona(editor, page, saved);
      publish(editor);
    }
    if (page === "long-memory" && editor.policy && editor.policyDraft && policyDirty(editor)) {
      const saved = await api.updatePolicy(id, {
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
  const taskPages = {
    identity: ["basic", "identity", "expression"],
    conversation: ["models", "context"],
    materials: ["memory-tools"],
  } as const satisfies Record<
    import("../../state/types").AgentWorkspaceTask,
    readonly EditablePage[]
  >;
  const save = async (
    pages: readonly EditablePage[],
    task?: import("../../state/types").AgentWorkspaceTask,
  ) => {
    const editor = get().pageEditor;
    if (!editor || get().settingsSaving || get().editorLoading) return false;
    const token = editor.token,
      id = editor.agent.id,
      api = get().apiClient,
      operation = {};
    const matches = () =>
      get().pageEditor?.token === token && get().editorAgentId === id && get().apiClient === api;
    knowledgeStep.acquire(operation);
    set({ settingsSaving: true, error: null, feedback: "" });
    let knowledge: ReturnType<typeof knowledgeStep.capture> = null;
    try {
      knowledge = task === "materials" ? knowledgeStep.capture() : null;
      if (knowledge && (knowledge.agentId !== id || !knowledgeStep.matches(knowledge)))
        return false;
      if (task) {
        for (const page of pages) {
          const current = get().pageEditor;
          if (!current || !matches()) return false;
          if (
            page === "context" &&
            Object.keys(get().allocationInvalidInputs).some(
              (key) => key.startsWith(`agent:${id}:context:`) || key.startsWith(`agent:${id}:aux:`),
            )
          )
            throw new Error(msg("请先修正方案中的无效数字，再保存。"));
          if (
            page === "memory-tools" &&
            Object.keys(get().allocationInvalidInputs).some((key) =>
              key.startsWith(`agent:${id}:reading:memory:`),
            )
          )
            throw new Error(msg("请先修正方案中的无效数字，再保存。"));
          if (
            page !== "expression" &&
            agentPageDirty(current, page) &&
            !UpdateAgentRequestSchema.safeParse(pageAgentPayload(current, page)).success
          )
            throw new Error(msg("保存失败，请修正后重试或取消。"));
          if (
            (page === "identity" || page === "expression") &&
            (personaPageDirty(current, page) ||
              (page === "expression" && agentPageDirty(current, page))) &&
            !SavePersonaRequestSchema.safeParse(pagePersonaPayload(current, page)).success
          )
            throw new Error(msg("保存失败，请修正后重试或取消。"));
        }
        if (
          task === "conversation" &&
          (agentPageDirty(editor, "context") || agentPageDirty(editor, "models")) &&
          editor.draft.p5_config.context_window !== null
        ) {
          const capacity = await api.getModelCapacity(editor.draft.model_name);
          if (!matches() || (knowledge && !knowledgeStep.matches(knowledge))) return false;
          if (capacity.context_length === null)
            throw new Error(msg("模型未加载或容量未知，无法校验自定义预算；可改为null跟随"));
          if (editor.draft.p5_config.context_window > capacity.context_length)
            throw new Error(msg("自定义上下文超过模型实际容量{0}", capacity.context_length));
        }
      }
      for (const page of pages) {
        if (!matches() || (knowledge && !knowledgeStep.matches(knowledge))) return false;
        if (
          !(await savePage(
            page,
            token,
            api,
            task === "conversation",
            () => !knowledge || knowledgeStep.matches(knowledge),
          ))
        )
          return false;
        if (!matches() || (knowledge && !knowledgeStep.matches(knowledge))) return false;
      }
      if (knowledge && !(await knowledgeStep.commit(knowledge))) {
        if (matches() && knowledgeStep.matches(knowledge))
          set({ feedback: msg("保存未全部完成；已成功部分保留，未保存内容仍在草稿中。") });
        return false;
      }
      if (!matches() || (knowledge && !knowledgeStep.matches(knowledge))) return false;
      set({ feedback: msg("页面配置已保存；其他页面的草稿保持不变。") });
      return true;
    } catch (error) {
      if (matches() && (!knowledge || knowledgeStep.matches(knowledge)))
        set({
          error: errorText(error),
          feedback: msg("保存未全部完成；已成功部分保留，未保存内容仍在草稿中。"),
        });
      return false;
    } finally {
      knowledgeStep.release(operation);
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
    saveSettingsTask: (task) => save(taskPages[task], task),
    settingsTaskDirty: (task) => {
      const editor = get().pageEditor;
      return (
        Boolean(
          editor &&
            taskPages[task].some(
              (page) => agentPageDirty(editor, page) || personaPageDirty(editor, page),
            ),
        ) ||
        (task === "materials" &&
          get().knowledgeReadEditor?.agentId === get().editorAgentId &&
          knowledgeReadDirty(get().knowledgeReadEditor))
      );
    },
    discardSettingsTask: (task) => {
      if (get().settingsSaving) return;
      for (const page of taskPages[task]) get().discardSettingsPages(page);
      if (task === "materials") get().discardKnowledgeRead();
    },
    // 三个文本用途共用模型页的白名单与版本校验；旧独立检索模型值保持原样。
    applyDefaultModelToAgent: async (modelName) => {
      const editor = get().pageEditor;
      if (!editor || get().settingsSaving || get().editorLoading) return false;
      if (get().editorAgentId === "__new__") return false;
      const draft = editor.draft;
      const already =
        draft.model_name === modelName &&
        draft.memory_consolidation_model_name === modelName &&
        draft.context_compression_model_name === modelName;
      if (already) {
        set({ feedback: msg("三个文本用途已经是这个模型，旧独立检索模型值不变。") });
        return true;
      }
      get().patchPageAgent("models", {
        model_name: modelName,
        memory_consolidation_model_name: modelName,
        context_compression_model_name: modelName,
      });
      const saved = await save(["models"]);
      if (saved) set({ feedback: msg("已更新当前助手的三个文本用途，旧独立检索模型值不变。") });
      return saved;
    },
    // 传页：能力页只弃本页拥有的字段，其他页草稿必须保留；无参：整份回到已存基线。
    discardSettingsPages: (page?: EditablePage) => {
      const editor = get().pageEditor;
      if (get().settingsSaving || !editor) return;
      if (page) {
        const prefix = `agent:${editor.agent.id}:`;
        const keptInvalid = Object.fromEntries(
          Object.entries(get().allocationInvalidInputs).filter(([key]) => {
            if (page === "context") {
              return !(key.startsWith(`${prefix}context:`) || key.startsWith(`${prefix}aux:`));
            }
            if (page === "memory-tools") {
              return !key.startsWith(`${prefix}reading:memory:`);
            }
            return true;
          }),
        );
        set({
          allocationInvalidInputs: keptInvalid,
          pageEditor: {
            ...editor,
            draft: {
              ...editor.draft,
              ...Object.fromEntries(PAGE_AGENT_FIELDS[page].map((key) => [key, editor.agent[key]])),
              p5_config: {
                ...editor.draft.p5_config,
                ...Object.fromEntries(
                  p5Fields(page).map((key) => [key, editor.agent.p5_config[key]]),
                ),
              },
            },
            ...(PAGE_PERSONA_FIELDS[page].length
              ? {
                  personaDraft: {
                    ...editor.personaDraft,
                    ...Object.fromEntries(
                      PAGE_PERSONA_FIELDS[page].map((key) => [key, editor.persona[key]]),
                    ),
                  },
                }
              : {}),
            ...(page === "long-memory" && editor.policy
              ? { policyDraft: { ...editor.policy } }
              : {}),
          },
        });
        return;
      }
      set({
        allocationInvalidInputs: Object.fromEntries(
          Object.entries(get().allocationInvalidInputs).filter(
            ([key]) =>
              !key.startsWith(`agent:${editor.agent.id}:context:`) &&
              !key.startsWith(`agent:${editor.agent.id}:aux:`) &&
              !key.startsWith(`agent:${editor.agent.id}:reading:memory:`),
          ),
        ),
        pageEditor: {
          ...editor,
          draft: toDraft(editor.agent),
          personaDraft: { ...editor.persona },
          policyDraft: editor.policy ? { ...editor.policy } : null,
        },
      });
    },
    // 显式刷新保存基线：只推进未修改字段与 config_version；已改草稿（含 p5）保留，不自动重试写。
    refreshSettingsAgent: async () => {
      const editor = get().pageEditor;
      if (!editor || get().settingsSaving || get().editorLoading) return false;
      const token = editor.token;
      const id = editor.agent.id;
      const api = get().apiClient;
      const matches = () =>
        get().pageEditor?.token === token && get().editorAgentId === id && get().apiClient === api;
      set({ editorLoading: true, error: null });
      try {
        const fresh = await api.getAgent(id);
        if (!matches()) return false;
        const current = get().pageEditor;
        if (!current) return false;
        const draft = { ...toDraft(fresh), p5_config: { ...fresh.p5_config } };
        // 联合字面量键无法直接收窄赋值，写入值都来自同型草稿对象；p5 值只替换引用不原地修改。
        const draftRecord = draft as unknown as Record<string, unknown>;
        const p5Record = draft.p5_config as unknown as Record<string, unknown>;
        for (const page of EDITABLE_PAGES) {
          for (const key of PAGE_AGENT_FIELDS[page]) {
            if (current.draft[key] !== current.agent[key]) draftRecord[key] = current.draft[key];
          }
          if (page === "memory-tools") {
            // 三方逐档合并：fresh=新基线、saved=刷新前基线、draft=当前草稿。
            // 只把「相对 saved 真被改过」的嵌套键保留为草稿值，其余跟随 fresh；
            // 未改档不再整组被旧对象覆盖，其他页/他端的预设更新得以并入基线。
            const savedPresets = current.agent.p5_config.retrieval_presets;
            const draftPresets = current.draft.p5_config.retrieval_presets;
            const freshPresets = fresh.p5_config.retrieval_presets;
            p5Record.retrieval_presets = mergePresetModes(freshPresets, (mode, freshMode) => {
              const savedMode = savedPresets[mode];
              const draftMode = draftPresets[mode];
              if (!freshMode) return savedMode ?? draftMode;
              if (!draftMode || !savedMode) return freshMode;
              // 逐键三方合并：相对刷新前基线被改过的键保留草稿值，其余跟随新基线。
              // 不按页分组，避免记忆页改非预算键时把上下文页未保存的预算草稿一起丢掉。
              const merged = { ...freshMode } as Record<string, unknown>;
              for (const key of Object.keys(savedMode) as (keyof Preset)[]) {
                if (JSON.stringify(draftMode[key]) !== JSON.stringify(savedMode[key])) {
                  merged[key] = draftMode[key];
                }
              }
              return merged as Preset;
            });
          }
          for (const key of p5Fields(page)) {
            if (key === "retrieval_presets") continue;
            if (
              JSON.stringify(current.draft.p5_config[key]) !==
              JSON.stringify(current.agent.p5_config[key])
            ) {
              p5Record[key] = current.draft.p5_config[key];
            }
          }
        }
        set((state) => ({
          pageEditor: { ...current, agent: fresh, draft },
          agents: state.agents.map((item) => (item.id === fresh.id ? fresh : item)),
          feedback: msg("刷新不提交草稿；冲突后请核对最新值再保存。"),
        }));
        return true;
      } catch (error) {
        if (matches()) set({ error: errorText(error) });
        return false;
      } finally {
        if (matches()) set({ editorLoading: false });
      }
    },
  };
}
