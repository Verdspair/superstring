import { type AgentResponse, newAgentDefaults } from "../../../shared/contracts";
import { msg } from "../../i18n";
import { resolvePreloadedPersona } from "../../services/agent-preload";
import { errorText, persistBrowserState } from "../../state/helpers";
import type { StoreGet, StoreSet, SuperstringState } from "../../state/types";
import { toDraft } from "./draft";
import { newPageEditor } from "./page-drafts";

export function createAgentActions(
  set: StoreSet,
  get: StoreGet,
): Pick<
  SuperstringState,
  "setNewSessionAgent" | "editAgent" | "patchNewAgentDraft" | "createAgent" | "deleteAgents"
> {
  let editorRequest = 0;
  // 助手身份切换成功后，被离开的助手不再有可达的原文输入框：只清它自己的
  // agent:<id>: 键，保留当前助手与其他所有者（global:*）的非法原文。
  const releaseInvalidInputsFor = (previousId: string, nextId: string) => {
    if (previousId === nextId) return;
    const prefix = `agent:${previousId}:`;
    const invalid = get().allocationInvalidInputs;
    if (!Object.keys(invalid).some((key) => key.startsWith(prefix))) return;
    set({
      allocationInvalidInputs: Object.fromEntries(
        Object.entries(invalid).filter(([key]) => !key.startsWith(prefix)),
      ),
    });
  };
  return {
    setNewSessionAgent: (id) => {
      set({ selectedNewSessionAgentId: id });
      persistBrowserState(get().browserStateStorage, "superstring-agent", id);
    },
    editAgent: async (id) => {
      if (get().settingsSaving) return false;
      const request = ++editorRequest;
      const previousId = get().editorAgentId;
      const { apiClient: api, page, settingsView, settingsRoute } = get();
      const isCurrent = () => request === editorRequest && get().apiClient === api;
      const ownsPage = () =>
        isCurrent() &&
        get().page === page &&
        get().settingsView === settingsView &&
        get().settingsRoute === settingsRoute;
      set({ editorLoading: true, editorBaselineRefresh: null });
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
          editorLoading: false,
          error: null,
        });
        const model = get().modelNames[0] ?? get().agents[0]?.model_name ?? "";
        const defaults = newAgentDefaults();
        set({
          editorDraft: {
            name: "",
            description: "",
            additional_instructions: "",
            model_name: model,
            temperature: defaults.temperature,
            memory_consolidation_model_name: null,
            memory_consolidation_prompt: "",
            memory_consolidation_additional_instructions: "",
            memory_retrieval_model_name: null,
            memory_retrieval_prompt: "",
            context_compression_model_name: null,
            p5_config: defaults.p5_config,
            is_active: defaults.is_active,
            config_version: 0,
            persona_intensity: defaults.persona_intensity,
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
        releaseInvalidInputsFor(previousId, id);
        return true;
      }
      try {
        const [agent, persona] = await Promise.all([
          api.getAgent(id),
          // 首屏预热人设直接消费（在途则共享同一请求）；未命中或预热失败才走前台读取。
          resolvePreloadedPersona(api, id).then((preloaded) => preloaded ?? api.getPersona(id)),
        ]);
        if (!ownsPage()) return false;
        releaseInvalidInputsFor(previousId, id);
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
          editorLoading: false,
        });
        return true;
      } catch (error) {
        if (ownsPage()) set({ error: errorText(error) });
        return false;
      } finally {
        if (isCurrent()) set({ editorLoading: false });
      }
    },
    patchNewAgentDraft: (patch) => {
      if (get().settingsSaving || get().editorAgentId !== "__new__" || !get().editorDraft) return;
      set((state) => ({
        editorDraft: state.editorDraft ? { ...state.editorDraft, ...patch } : null,
        dirty: true,
      }));
    },
    createAgent: async () => {
      const draft = get().editorDraft;
      if (!draft || get().editorAgentId !== "__new__" || get().settingsSaving) return false;
      const api = get().apiClient;
      const request = editorRequest;
      const { page, settingsView, settingsRoute } = get();
      const operation = {};
      const ownsDraft = () =>
        get().apiClient === api &&
        editorRequest === request &&
        get().page === page &&
        get().settingsView === settingsView &&
        get().settingsRoute === settingsRoute &&
        get().editorAgentId === "__new__" &&
        get().editorDraft === draft;
      let committed: AgentResponse;
      set({ settingsSaving: true, settingsSaveOwner: operation, error: null });
      try {
        committed = await api.createAgent({
          name: draft.name,
          description: draft.description,
          persona: {},
          additional_instructions: draft.additional_instructions,
          model_name: draft.model_name,
          temperature: draft.temperature,
          is_active: draft.is_active,
          persona_intensity: draft.persona_intensity,
          p5_config: draft.p5_config,
        });
      } catch (error) {
        if (ownsDraft()) set({ error: errorText(error) });
        return false;
      } finally {
        if (get().settingsSaveOwner === operation)
          set({ settingsSaving: false, settingsSaveOwner: null });
      }
      if (get().apiClient !== api) return true;
      // The POST is durable. Admit its directory identity without reviving an old editor.
      const currentDraft = ownsDraft();
      set((state) => ({
        agents: [committed, ...state.agents.filter((item) => item.id !== committed.id)],
      }));
      if (!currentDraft) return true;
      const committedDraft = toDraft(committed);
      set({
        editorAgentId: committed.id,
        editorDraft: committedDraft,
        pageEditor: null,
        dirty: false,
        error: null,
        feedback: msg("已创建助手「{0}」，可继续配置记忆、上下文与人设。", committed.name),
      });
      const ownsContinuation = () =>
        get().apiClient === api &&
        editorRequest === request &&
        get().page === page &&
        get().settingsView === settingsView &&
        get().settingsRoute === settingsRoute &&
        get().editorAgentId === committed.id &&
        get().editorDraft === committedDraft &&
        get().pageEditor === null;
      try {
        const persona = await api.getPersona(committed.id);
        if (ownsContinuation()) set({ pageEditor: newPageEditor(committed, persona), persona });
      } catch (error) {
        if (ownsContinuation()) set({ error: errorText(error) });
      }
      return true;
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
