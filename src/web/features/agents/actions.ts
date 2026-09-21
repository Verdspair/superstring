import type { AgentResponse } from "../../../shared/contracts";
import { msg } from "../../i18n";
import { errorText, persistBrowserState } from "../../state/helpers";
import type { StoreGet, StoreSet, SuperstringState } from "../../state/types";
import { toDraft } from "./draft";
import { newPageEditor } from "./page-drafts";
import { buildSectionPayload, mergeSavedSection } from "./section-rules";
import { sectionLetter } from "./sections";

export function createAgentActions(
  set: StoreSet,
  get: StoreGet,
): Pick<
  SuperstringState,
  | "setNewSessionAgent"
  | "setActiveSection"
  | "editAgent"
  | "patchDraft"
  | "patchPersona"
  | "saveCurrentSection"
  | "savePersona"
  | "deleteEditorAgent"
  | "deleteAgents"
> {
  let editorRequest = 0;
  return {
    setNewSessionAgent: (id) => {
      set({ selectedNewSessionAgentId: id });
      persistBrowserState(get().browserStateStorage, "superstring-agent", id);
    },
    setActiveSection: (activeSection) => get().requestSectionNavigation(activeSection),
    editAgent: async (id) => {
      if (get().settingsSaving) return false;
      const request = ++editorRequest;
      set({ editorLoading: true });
      get().discardMemoryCorrection();
      get().resetMemoryManagement();
      if (id === "__new__") {
        get().discardKnowledgeRead();
        // 新建使用独立草稿及创建保存键；不复用已有助手的按页草稿。
        set({
          editorAgentId: id,
          pageEditor: null,
          feedback: "",
          dirty: false,
          activeSection: "A",
          editorLoading: false,
          error: null,
        });
        const model = get().modelNames[0] ?? get().agents[0]?.model_name ?? "";
        set({
          editorDraft: {
            name: "",
            description: "",
            additional_instructions: "",
            model_name: model,
            temperature: 0.7,
            memory_consolidation_model_name: null,
            memory_consolidation_prompt: get().agents[0]?.memory_consolidation_prompt ?? "",
            memory_consolidation_additional_instructions: "",
            memory_retrieval_model_name: null,
            memory_retrieval_prompt: get().agents[0]?.memory_retrieval_prompt ?? "",
            context_compression_model_name: null,
            p5_config: get().agents[0]?.p5_config ?? ({} as AgentResponse["p5_config"]),
            is_active: true,
            config_version: 0,
            persona_intensity: 60,
          },
          persona: {
            id: "",
            agent_id: "",
            core_identity: "",
            communication_style: "",
            interaction_boundaries: "",
            example_dialogues: "",
            advanced_instructions: "",
            created_at: new Date(0).toISOString(),
            updated_at: new Date(0).toISOString(),
          },
          policy: null,
          memorySessions: [],
          memoryTurns: [],
          memoryEntries: [],
          memoryEntryTotal: 0,
          memoryEntryDetail: null,
          memoryJobs: [],
        });
        return true;
      }
      try {
        const [agent, persona] = await Promise.all([
          get().apiClient.getAgent(id),
          get().apiClient.getPersona(id),
        ]);
        if (request !== editorRequest) return false;
        get().discardKnowledgeRead();
        set({
          editorAgentId: id,
          editorDraft: toDraft(agent),
          pageEditor: newPageEditor(agent, persona),
          agents: get().agents.map((item) => (item.id === id ? agent : item)),
          persona,
          error: null,
          feedback: "",
          dirty: false,
          activeSection: "A",
        });
        await get().reloadMemory();
        return true;
      } catch (error) {
        if (request === editorRequest) set({ error: errorText(error) });
        return false;
      } finally {
        if (request === editorRequest) set({ editorLoading: false });
      }
    },
    patchDraft: (patch) =>
      set((state) => ({
        pageEditor: null,
        editorDraft: state.editorDraft ? { ...state.editorDraft, ...patch } : null,
        dirty: true,
      })),
    patchPersona: (patch) =>
      set((state) => ({
        pageEditor: null,
        persona: state.persona ? { ...state.persona, ...patch } : null,
        dirty: true,
      })),
    saveCurrentSection: async () => {
      const draft = get().editorDraft;
      if (!draft) return false;
      const section = get().activeSection;
      if (section !== "A" && section !== "B" && section !== "C" && section !== "D") {
        set({ error: null, feedback: msg("此分区尚未开放，不能保存。") });
        return false;
      }
      if (section === "D") {
        if (get().editorAgentId === "__new__" || !get().persona) {
          set({
            error: null,
            feedback: msg("请先保存 Agent 基础记录，再保存人设与性格"),
          });
          return false;
        }
        return get().savePersona({
          ...get().persona,
          persona_intensity: draft.persona_intensity,
        });
      }
      const creating = get().editorAgentId === "__new__";
      if (creating && section !== "A") {
        set({ error: null, feedback: msg("请先创建 Agent 基础记录") });
        return false;
      }
      try {
        if (!creating && section === "C" && draft.p5_config.context_window !== null) {
          const capacity = await get().apiClient.getModelCapacity(draft.model_name);
          if (capacity.context_length === null) {
            set({
              error: null,
              feedback: msg("模型未加载或容量未知，无法校验自定义预算；可改为null跟随"),
            });
            return false;
          }
          if (draft.p5_config.context_window > capacity.context_length) {
            set({
              error: null,
              feedback: msg("自定义上下文超过模型实际容量{0}", capacity.context_length),
            });
            return false;
          }
        }
        let saved: AgentResponse;
        if (creating) {
          saved = await get().apiClient.createAgent({
            name: draft.name,
            description: draft.description,
            persona: {},
            additional_instructions: draft.additional_instructions,
            model_name: draft.model_name,
            temperature: draft.temperature,
            is_active: draft.is_active,
          });
        } else {
          const persisted = get().agents.find((agent) => agent.id === get().editorAgentId);
          if (!persisted) {
            set({ error: msg("当前 Agent 不存在，请重新选择。") });
            return false;
          }
          const payload = buildSectionPayload(section as "A" | "B" | "C", draft, persisted);
          saved = await get().apiClient.updateAgent(get().editorAgentId, payload);
        }
        set((state) => {
          const editorDraft = mergeSavedSection(
            section as "A" | "B" | "C",
            state.editorDraft,
            saved,
            creating,
          );
          return {
            agents: [saved, ...state.agents.filter((item) => item.id !== saved.id)],
            editorAgentId: saved.id,
            pageEditor: null,
            editorDraft,
            dirty: false,
            error: null,
            feedback: creating
              ? msg("已创建助手「{0}」，可继续配置记忆、上下文与人设。", saved.name)
              : section === "A"
                ? msg("当前 Agent 配置已保存。")
                : msg("{0} 分区已保存", sectionLetter(section)),
          };
        });
        return true;
      } catch (error) {
        set({ error: errorText(error) });
        return false;
      }
    },
    savePersona: async (patch) => {
      const id = get().editorAgentId;
      const current = get().persona;
      if (id === "__new__" || !current) {
        set({
          error: null,
          feedback: msg("请先保存 Agent 基础记录，再保存人设与性格"),
        });
        return false;
      }
      try {
        const saved = await get().apiClient.savePersona(id, {
          core_identity: patch.core_identity ?? current.core_identity,
          communication_style: patch.communication_style ?? current.communication_style,
          interaction_boundaries: patch.interaction_boundaries ?? current.interaction_boundaries,
          example_dialogues: patch.example_dialogues ?? current.example_dialogues,
          advanced_instructions: patch.advanced_instructions ?? current.advanced_instructions,
          persona_intensity: patch.persona_intensity,
        });
        set((state) => ({
          persona: saved,
          pageEditor: null,
          agents: state.agents.map((agent) =>
            agent.id === id ? { ...agent, persona_intensity: patch.persona_intensity } : agent,
          ),
          editorDraft: state.editorDraft
            ? {
                ...state.editorDraft,
                persona_intensity: patch.persona_intensity,
              }
            : null,
          dirty: false,
          error: null,
          feedback: msg("人设与性格已保存并立即生效（无版本号）"),
        }));
        return true;
      } catch (error) {
        set({ error: errorText(error) });
        return false;
      }
    },
    deleteEditorAgent: async () => {
      const id = get().editorAgentId;
      if (id === "__new__") return;
      try {
        await get().apiClient.deleteAgent(id);
        const agents = get().agents.filter((item) => item.id !== id);
        set({
          agents,
          editorAgentId: "__new__",
          editorDraft: null,
          pageEditor: null,
          persona: null,
          policy: null,
          memorySessions: [],
          memoryTurns: [],
          memoryEntries: [],
          memoryEntryTotal: 0,
          memoryEntryDetail: null,
          memoryJobs: [],
          dirty: false,
          feedback: msg("Agent 已删除"),
        });
        await get().editAgent("__new__");
      } catch (error) {
        set({ error: errorText(error) });
      }
    },
    deleteAgents: async (ids) => {
      if (ids.length === 0) {
        set({ feedback: msg("请至少选择一个 Agent。") });
        return;
      }
      try {
        const result = await get().apiClient.deleteAgents(ids);
        const deleted = new Set(
          result.results.filter((item) => item.deleted).map((item) => item.id),
        );
        const agents = get().agents.filter((item) => !deleted.has(item.id));
        const failed = result.results.filter((item) => !item.deleted);
        let details = failed
          .slice(0, 3)
          .map((item) => item.message)
          .join("；");
        if (failed.length > 3) details = msg("{0}；另有 {1} 项失败", details, failed.length - 3);
        const status = msg(
          "批量删除完成：成功 {0} 个，失败 {1} 个。",
          result.deleted_count,
          result.failed_count,
        );
        set({
          agents,
          feedback: details ? `${status} ${details}` : status,
          error: null,
        });
        if (deleted.has(get().editorAgentId)) await get().editAgent("__new__");
      } catch (error) {
        set({ error: errorText(error) });
      }
    },
  };
}
