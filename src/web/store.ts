import { create } from "zustand";
import type {
  AgentResponse,
  MemoryEntryResponse,
  MemoryJobView,
  MemorySessionOption,
  MemorySummary,
  MemoryTurnRow,
  MessageResponse,
  PersonaResponse,
  PolicyView,
  RuntimeConfig,
  SessionResponse,
} from "../shared/contracts";
import { ApiError, api, type SuperstringApi, streamChat } from "./api";
import { type BrowserStateStorage, loadBrowserStateStorage } from "./browser-state";

export type Page = "chat" | "settings";
export type SettingsView = "hub" | "agents" | "appearance";
export type SectionKey = "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H";
export type LoadStatus = "idle" | "loading" | "ready" | "error";
export type PendingNavigation =
  | { kind: "page"; page: Page; settingsView: SettingsView }
  | { kind: "agent"; id: string | "__new__" }
  | { kind: "section"; section: SectionKey };

export interface ChatItem {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  status: "pending" | "completed" | "failed" | "cancelled";
  errorCode: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface AgentDraft {
  name: string;
  description: string;
  additional_instructions: string;
  model_name: string;
  temperature: number;
  memory_consolidation_model_name: string | null;
  memory_consolidation_prompt: string;
  memory_consolidation_additional_instructions: string;
  memory_retrieval_model_name: string | null;
  memory_retrieval_prompt: string;
  context_compression_model_name: string | null;
  p5_config: AgentResponse["p5_config"];
  is_active: boolean;
  config_version: number;
  persona_intensity: number;
}

const toChatItem = (message: MessageResponse): ChatItem => ({
  id: message.id,
  role: message.role,
  content: message.content,
  status: message.status,
  errorCode: message.error_code,
  createdAt: message.created_at,
  completedAt: message.completed_at,
});

const toDraft = (agent: AgentResponse): AgentDraft => ({
  name: agent.name,
  description: agent.description,
  additional_instructions: agent.additional_instructions,
  model_name: agent.model_name,
  temperature: agent.temperature,
  memory_consolidation_model_name: agent.memory_consolidation_model_name,
  memory_consolidation_prompt: agent.memory_consolidation_prompt,
  memory_consolidation_additional_instructions: agent.memory_consolidation_additional_instructions,
  memory_retrieval_model_name: agent.memory_retrieval_model_name,
  memory_retrieval_prompt: agent.memory_retrieval_prompt,
  context_compression_model_name: agent.context_compression_model_name,
  p5_config: agent.p5_config,
  is_active: agent.is_active,
  config_version: agent.config_version,
  persona_intensity: agent.persona_intensity,
});

function errorText(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

function persistBrowserState(
  storage: BrowserStateStorage | null,
  storageKey: string,
  value: string | null,
): void {
  void storage?.write(storageKey, value).catch(() => undefined);
}

function beginProcessing(
  get: () => SuperstringState,
  set: (patch: Partial<SuperstringState>) => void,
): void {
  set({ pendingOperations: get().pendingOperations + 1 });
}

function endProcessing(
  get: () => SuperstringState,
  set: (patch: Partial<SuperstringState>) => void,
): void {
  set({ pendingOperations: Math.max(0, get().pendingOperations - 1) });
}

async function performNavigation(
  get: () => SuperstringState,
  set: (patch: Partial<SuperstringState>) => void,
  pending: PendingNavigation,
  discard: boolean,
): Promise<void> {
  set({
    pendingNavigation: null,
    navigationConfirmOpen: false,
    navigationConfirmMessage: "",
    dirty: false,
    error: null,
  });
  if (pending.kind === "page") {
    const patch: Partial<SuperstringState> = {
      page: pending.page,
      settingsView: pending.settingsView,
      feedback: "",
    };
    // 放弃修改并离开 agents 页时清除草稿，使再次进入按默认规则读取而非显示已放弃改动；
    // 普通导航（保存后或取消）保留草稿。
    if (discard) {
      patch.editorDraft = null;
      patch.dirty = false;
      patch.editorAgentId = "__new__";
    }
    set(patch);
    return;
  }
  if (pending.kind === "agent") {
    const previous = {
      editorAgentId: get().editorAgentId,
      editorDraft: get().editorDraft,
      persona: get().persona,
      policy: get().policy,
      memorySessions: get().memorySessions,
      memoryTurns: get().memoryTurns,
      memoryEntries: get().memoryEntries,
      memoryEntryTotal: get().memoryEntryTotal,
      memoryEntryDetail: get().memoryEntryDetail,
      memoryJobs: get().memoryJobs,
      activeSection: get().activeSection,
    };
    const changed = await get().editAgent(pending.id);
    if (!changed) {
      // 读取失败：保留原草稿/位置，并恢复 pendingNavigation 以便可重试或取消，否则弹窗无法重试。
      set({
        ...previous,
        pendingNavigation: pending,
        navigationConfirmOpen: true,
        dirty: discard,
        navigationConfirmMessage: `读取目标 Agent 失败：${get().error ?? "未知错误"}；未放弃修改，可重试或取消。`,
      });
    }
    return;
  }
  if (discard && get().editorAgentId !== "__new__") {
    try {
      const [agent, persona] = await Promise.all([
        get().apiClient.getAgent(get().editorAgentId),
        get().apiClient.getPersona(get().editorAgentId),
      ]);
      set({ editorDraft: toDraft(agent), persona });
    } catch (error) {
      // 放弃时重读目标 Agent 失败：恢复 pendingNavigation 以便可重试或取消。
      set({
        pendingNavigation: pending,
        dirty: true,
        navigationConfirmOpen: true,
        navigationConfirmMessage: `读取 Agent 失败：${errorText(error)}；未放弃修改，可重试或取消。`,
      });
      return;
    }
  }
  set({ activeSection: pending.section, feedback: "", dirty: false });
}

export interface SuperstringState {
  status: LoadStatus;
  error: string | null;
  feedback: string;
  page: Page;
  settingsView: SettingsView;
  activeSection: SectionKey;
  detailOpen: boolean;
  dirty: boolean;
  pendingNavigation: PendingNavigation | null;
  navigationConfirmOpen: boolean;
  navigationConfirmMessage: string;
  agents: AgentResponse[];
  sessions: SessionResponse[];
  messages: ChatItem[];
  runtimeConfig: RuntimeConfig | null;
  runtimeConfigUnavailable: boolean;
  selectedNewSessionAgentId: string | null;
  currentSessionId: string | null;
  editorAgentId: string | "__new__";
  editorDraft: AgentDraft | null;
  persona: PersonaResponse | null;
  policy: PolicyView | null;
  memorySessions: MemorySessionOption[];
  memoryTurns: MemoryTurnRow[];
  memoryEntries: MemorySummary[];
  memoryEntryTotal: number;
  memoryEntryDetail: MemoryEntryResponse | null;
  memoryJobs: MemoryJobView[];
  modelNames: string[];
  modelStatus: string;
  capacityPreview: string;
  composer: string;
  sending: boolean;
  pendingOperations: number;
  browserStateStorage: BrowserStateStorage | null;
  apiClient: SuperstringApi;
  bootstrap: () => Promise<void>;
  openChat: () => void;
  openSettings: () => void;
  openAgentSettings: () => void;
  closeAgentSettings: () => void;
  requestPageNavigation: (page: Page, settingsView?: SettingsView) => void;
  requestAgentNavigation: (id: string | "__new__") => void;
  requestSectionNavigation: (section: SectionKey) => void;
  confirmSaveAndContinue: () => Promise<void>;
  confirmDiscardAndContinue: () => Promise<void>;
  cancelPendingNavigation: () => void;
  setNewSessionAgent: (id: string | null) => void;
  selectSession: (id: string) => Promise<void>;
  createSession: (title: string) => Promise<boolean>;
  deleteCurrentSession: () => Promise<void>;
  refreshSession: () => Promise<void>;
  setComposer: (value: string) => void;
  send: () => Promise<void>;
  setActiveSection: (section: SectionKey) => void;
  setDetailOpen: (open: boolean) => void;
  editAgent: (id: string | "__new__") => Promise<boolean>;
  patchDraft: (patch: Partial<AgentDraft>) => void;
  patchPersona: (patch: Partial<PersonaResponse>) => void;
  saveCurrentSection: () => Promise<boolean>;
  savePersona: (
    patch: Partial<PersonaResponse> & { persona_intensity: number },
  ) => Promise<boolean>;
  deleteEditorAgent: () => Promise<void>;
  deleteAgents: (ids: string[]) => Promise<void>;
  refreshModels: () => Promise<void>;
  refreshCapacityPreview: (
    probeModels?: readonly [string, string | null, string | null],
  ) => Promise<void>;
  reloadMemory: () => Promise<void>;
  loadMemoryTurns: (sessionId: string, limit: number) => Promise<void>;
  loadMemoryPage: (page: number) => Promise<void>;
  loadMemoryEntryDetail: (memoryId: string) => Promise<void>;
  manualConsolidate: (sessionId: string, turnIds: string[]) => Promise<void>;
  updatePolicy: (patch: Omit<PolicyView, "version">) => Promise<void>;
  resetForTests: (client?: SuperstringApi) => void;
}

const initial = {
  status: "idle" as LoadStatus,
  error: null as string | null,
  feedback: "",
  page: "chat" as Page,
  settingsView: "hub" as SettingsView,
  activeSection: "A" as SectionKey,
  detailOpen: false,
  dirty: false,
  pendingNavigation: null as PendingNavigation | null,
  navigationConfirmOpen: false,
  navigationConfirmMessage: "",
  agents: [] as AgentResponse[],
  sessions: [] as SessionResponse[],
  messages: [] as ChatItem[],
  runtimeConfig: null as RuntimeConfig | null,
  runtimeConfigUnavailable: false,
  selectedNewSessionAgentId: null as string | null,
  currentSessionId: null as string | null,
  editorAgentId: "__new__" as const,
  editorDraft: null as AgentDraft | null,
  persona: null as PersonaResponse | null,
  policy: null as PolicyView | null,
  memorySessions: [] as MemorySessionOption[],
  memoryTurns: [] as MemoryTurnRow[],
  memoryEntries: [] as MemorySummary[],
  memoryEntryTotal: 0,
  memoryEntryDetail: null as MemoryEntryResponse | null,
  memoryJobs: [] as MemoryJobView[],
  modelNames: [] as string[],
  modelStatus: "模型列表将在打开配置时加载。",
  capacityPreview: "",
  composer: "",
  sending: false,
  pendingOperations: 0,
  browserStateStorage: null as BrowserStateStorage | null,
};

export const useSuperstringStore = create<SuperstringState>()((set, get) => ({
  ...initial,
  apiClient: api,
  bootstrap: async () => {
    set({ status: "loading", error: null });
    beginProcessing(get, set);
    try {
      const [agentsResult, sessionsResult, catalogResult, storageResult] = await Promise.allSettled(
        [
          get().apiClient.listAgents(),
          get().apiClient.listSessions(),
          get().apiClient.listModels(),
          loadBrowserStateStorage(() => get().apiClient.getBrowserStateConfig()),
        ],
      );
      const agents = agentsResult.status === "fulfilled" ? agentsResult.value : [];
      const sessions = sessionsResult.status === "fulfilled" ? sessionsResult.value : [];
      const catalog = catalogResult.status === "fulfilled" ? catalogResult.value : null;
      const browserStateStorage = storageResult.status === "fulfilled" ? storageResult.value : null;
      const savedAgent = await browserStateStorage?.read("superstring-agent").catch(() => null);
      const availableAgent = agents.find((item) => item.is_active && item.id === savedAgent);
      const selectedAgent = availableAgent ?? agents.find((item) => item.is_active) ?? null;
      const savedSession = await browserStateStorage?.read("superstring-session").catch(() => null);
      const selectedSession =
        sessions.find((item) => item.id === savedSession) ?? sessions[0] ?? null;
      const reported = [...new Set(catalog?.models ?? [])];
      const failures = [agentsResult, sessionsResult, catalogResult, storageResult]
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => errorText(result.reason));
      set({
        status: "ready",
        agents,
        sessions,
        modelNames: reported,
        modelStatus:
          catalogResult.status === "rejected"
            ? `模型列表加载失败：${errorText(catalogResult.reason)}；仍可保留或手动输入模型 ID。`
            : reported.length
              ? `LM Studio 当前报告 ${reported.length} 个已加载模型。`
              : "LM Studio 当前没有报告已加载模型；仍可保留或手动输入模型 ID。",
        selectedNewSessionAgentId: selectedAgent?.id ?? null,
        currentSessionId: selectedSession?.id ?? null,
        browserStateStorage,
        error: failures.length ? failures.join("；") : null,
      });
      if (selectedSession) await get().selectSession(selectedSession.id);
    } finally {
      endProcessing(get, set);
    }
  },
  openChat: () => get().requestPageNavigation("chat", "hub"),
  openSettings: () => get().requestPageNavigation("settings", "hub"),
  openAgentSettings: () => {
    get().requestPageNavigation("settings", "agents");
    const state = get();
    // 仅在真正进入 agents 页（未被 dirty 确认拦截）且尚无草稿时，按默认规则载入。
    if (
      state.page === "settings" &&
      state.settingsView === "agents" &&
      state.editorDraft === null
    ) {
      const target =
        (state.selectedNewSessionAgentId &&
          state.agents.find((item) => item.id === state.selectedNewSessionAgentId)?.id) ||
        state.agents[0]?.id ||
        "__new__";
      void get().editAgent(target);
    }
  },
  closeAgentSettings: () => get().requestPageNavigation("settings", "hub"),
  requestPageNavigation: (page, settingsView = "hub") => {
    if (get().page === page && get().settingsView === settingsView) return;
    if (get().dirty && get().page === "settings" && get().settingsView === "agents") {
      set({
        pendingNavigation: { kind: "page", page, settingsView },
        navigationConfirmOpen: true,
        navigationConfirmMessage: "当前 Agent 有未保存修改，是否先保存再离开？",
      });
      return;
    }
    set({ page, settingsView, feedback: "" });
  },
  requestAgentNavigation: (id) => {
    // 同 ID 仅当已有草稿时才直接返回；__new__ 且草稿为 null 需要（重新）初始化。
    if (id === get().editorAgentId && get().editorDraft !== null) return;
    if (get().dirty) {
      set({
        pendingNavigation: { kind: "agent", id },
        navigationConfirmOpen: true,
        navigationConfirmMessage: "当前 Agent 有未保存修改，是否先保存再切换？",
      });
      return;
    }
    void get().editAgent(id);
  },
  requestSectionNavigation: (section) => {
    if (section === get().activeSection) return;
    // 新建草稿尚未创建基础记录时，除 A 外的分区不可用（UI 会禁用）。
    if (get().editorAgentId === "__new__" && get().editorDraft !== null && section !== "A") {
      set({ feedback: "请先创建 Agent 基础记录，再切换到其它分区。" });
      return;
    }
    if (get().dirty) {
      set({
        pendingNavigation: { kind: "section", section },
        navigationConfirmOpen: true,
        navigationConfirmMessage: "当前分区有未保存修改，是否先保存再切换？",
      });
      return;
    }
    set({ activeSection: section, feedback: "" });
  },
  confirmSaveAndContinue: async () => {
    const pending = get().pendingNavigation;
    if (!pending) return;
    const saved =
      get().activeSection === "D"
        ? await get().savePersona({
            ...(get().persona ?? {}),
            persona_intensity: get().editorDraft?.persona_intensity ?? 60,
          })
        : await get().saveCurrentSection();
    if (!saved) {
      set({
        navigationConfirmOpen: true,
        navigationConfirmMessage: get().error
          ? `保存失败：${get().error}`
          : "保存失败，请修正后重试或取消。",
        dirty: true,
      });
      return;
    }
    await performNavigation(get, set, pending, false);
  },
  confirmDiscardAndContinue: async () => {
    const pending = get().pendingNavigation;
    if (!pending) return;
    await performNavigation(get, set, pending, true);
  },
  cancelPendingNavigation: () =>
    set({ pendingNavigation: null, navigationConfirmOpen: false, navigationConfirmMessage: "" }),
  setNewSessionAgent: (id) => {
    set({ selectedNewSessionAgentId: id });
    persistBrowserState(get().browserStateStorage, "superstring-agent", id);
  },
  selectSession: async (id) => {
    set({ currentSessionId: id, error: null });
    persistBrowserState(get().browserStateStorage, "superstring-session", id);
    const [messagesResult, runtimeResult] = await Promise.allSettled([
      get().apiClient.listMessages(id),
      get().apiClient.getSessionRuntime(id),
    ]);
    set({
      messages: messagesResult.status === "fulfilled" ? messagesResult.value.map(toChatItem) : [],
      runtimeConfig: runtimeResult.status === "fulfilled" ? runtimeResult.value : null,
      runtimeConfigUnavailable: runtimeResult.status === "rejected",
      error:
        messagesResult.status === "rejected"
          ? errorText(messagesResult.reason)
          : runtimeResult.status === "rejected"
            ? errorText(runtimeResult.reason)
            : null,
    });
  },
  createSession: async (title) => {
    const normalized = title.trim();
    if (!normalized) {
      set({ error: null, feedback: "名称不能为空，请填写后再确认" });
      return false;
    }
    if (!get().selectedNewSessionAgentId) {
      set({
        error: null,
        feedback: "当前没有可用于新会话的 Agent，请先启用或创建 Agent",
        messages: [],
      });
      return false;
    }
    try {
      const created = await get().apiClient.createSession({
        title: normalized,
        agent_id: get().selectedNewSessionAgentId,
        mode: "chat",
        client_request_id: crypto.randomUUID(),
      });
      set((state) => ({
        sessions: [created, ...state.sessions.filter((item) => item.id !== created.id)],
        currentSessionId: created.id,
        messages: [],
        runtimeConfig: null,
        runtimeConfigUnavailable: false,
        error: null,
        feedback: "",
      }));
      await get().selectSession(created.id);
      return true;
    } catch (error) {
      set({ error: null, feedback: errorText(error) || "新建会话失败，请检查后端服务" });
      return false;
    }
  },
  deleteCurrentSession: async () => {
    const id = get().currentSessionId;
    if (!id) return;
    try {
      await get().apiClient.deleteSession(id);
      const sessions = get().sessions.filter((item) => item.id !== id);
      const next = sessions[0] ?? null;
      set({
        sessions,
        currentSessionId: next?.id ?? null,
        messages: [],
        runtimeConfig: null,
        runtimeConfigUnavailable: false,
        error: null,
        feedback: "会话已删除",
      });
      if (next) await get().selectSession(next.id);
    } catch (error) {
      set({ error: errorText(error) });
    }
  },
  refreshSession: async () => {
    try {
      const sessions = await get().apiClient.listSessions();
      const currentId = get().currentSessionId;
      const next = sessions.find((item) => item.id === currentId) ?? sessions[0] ?? null;
      set({ sessions, error: null, currentSessionId: next?.id ?? null });
      if (next) await get().selectSession(next.id);
      else
        set({
          messages: [],
          runtimeConfig: null,
          runtimeConfigUnavailable: false,
          feedback: "请先新建或选择会话",
        });
    } catch (error) {
      set({ error: errorText(error) });
    }
  },
  setComposer: (composer) => set({ composer }),
  send: async () => {
    const text = get().composer.trim();
    const sessionId = get().currentSessionId;
    if (get().sending) return;
    if (!text) {
      set({ error: null, feedback: "消息不能为空" });
      return;
    }
    if (!sessionId) {
      set({ error: null, feedback: "请先新建或选择会话" });
      return;
    }
    const clientRequestId = crypto.randomUUID();
    const userId = `optimistic-user-${clientRequestId}`;
    const assistantId = `optimistic-assistant-${clientRequestId}`;
    const now = new Date().toISOString();
    set((state) => ({
      composer: "",
      sending: true,
      error: null,
      messages: [
        ...state.messages,
        {
          id: userId,
          role: "user",
          content: text,
          status: "completed",
          errorCode: null,
          createdAt: now,
          completedAt: now,
        },
        {
          id: assistantId,
          role: "assistant",
          content: "",
          status: "pending",
          errorCode: null,
          createdAt: now,
          completedAt: null,
        },
      ],
    }));
    try {
      await streamChat(
        {
          session_id: sessionId,
          message: text,
          client_request_id: clientRequestId,
        },
        (event) => {
          if (event.event === "delta") {
            set((state) => ({
              messages: state.messages.map((item) =>
                item.id === assistantId ? { ...item, content: item.content + event.text } : item,
              ),
            }));
          } else if (event.event === "done") {
            set((state) => ({
              messages: state.messages.map((item) =>
                item.id === assistantId
                  ? {
                      ...item,
                      id: event.message_id,
                      status: "completed",
                      completedAt: event.completed_at,
                    }
                  : item,
              ),
            }));
          } else if (event.event === "error") {
            set((state) => ({
              error: event.message,
              messages: state.messages.map((item) =>
                item.id === assistantId
                  ? { ...item, status: "failed", errorCode: event.code }
                  : item,
              ),
            }));
          }
        },
      );
      await get().refreshSession();
    } catch (error) {
      set((state) => ({
        error: errorText(error),
        messages: state.messages.map((item) =>
          item.id === assistantId ? { ...item, status: "failed" } : item,
        ),
      }));
    } finally {
      set({ sending: false });
    }
  },
  setActiveSection: (activeSection) => get().requestSectionNavigation(activeSection),
  setDetailOpen: (detailOpen) => set({ detailOpen }),
  editAgent: async (id) => {
    if (id === "__new__") {
      // 新建草稿视为展开明细、停留在基础记录分区；已有助手不强制展开。
      set({
        editorAgentId: id,
        feedback: "",
        dirty: false,
        activeSection: "A",
        detailOpen: true,
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
      set({
        editorAgentId: id,
        editorDraft: toDraft(agent),
        persona,
        error: null,
        feedback: "",
        dirty: false,
        activeSection: "A",
      });
      await get().reloadMemory();
      return true;
    } catch (error) {
      set({ error: errorText(error) });
      return false;
    }
  },
  patchDraft: (patch) =>
    set((state) => ({
      editorDraft: state.editorDraft ? { ...state.editorDraft, ...patch } : null,
      dirty: true,
    })),
  patchPersona: (patch) =>
    set((state) => ({
      persona: state.persona ? { ...state.persona, ...patch } : null,
      dirty: true,
    })),
  saveCurrentSection: async () => {
    const draft = get().editorDraft;
    if (!draft) return false;
    const section = get().activeSection;
    if (["E", "F", "G", "H"].includes(section)) {
      set({ error: null, feedback: "此分区尚未开放，不能保存。" });
      return false;
    }
    if (section === "D") {
      if (get().editorAgentId === "__new__" || !get().persona) {
        set({ error: null, feedback: "请先保存 Agent 基础记录，再保存人设与性格" });
        return false;
      }
      return get().savePersona({
        ...get().persona,
        persona_intensity: draft.persona_intensity,
      });
    }
    const creating = get().editorAgentId === "__new__";
    if (creating && section !== "A") {
      set({ error: null, feedback: "请先创建 Agent 基础记录" });
      return false;
    }
    try {
      if (!creating && section === "C" && draft.p5_config.context_window !== null) {
        const capacity = await get().apiClient.getModelCapacity(draft.model_name);
        if (capacity.context_length === null) {
          set({
            error: null,
            feedback: "模型未加载或容量未知，无法校验自定义预算；可改为null跟随",
          });
          return false;
        }
        if (draft.p5_config.context_window > capacity.context_length) {
          set({
            error: null,
            feedback: `自定义上下文超过模型实际容量${capacity.context_length}`,
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
          set({ error: "当前 Agent 不存在，请重新选择。" });
          return false;
        }
        const p5Config =
          section === "B"
            ? {
                ...persisted.p5_config,
                retrieval_mode: draft.p5_config.retrieval_mode,
                retrieval_presets: draft.p5_config.retrieval_presets,
              }
            : section === "C"
              ? {
                  ...draft.p5_config,
                  retrieval_mode: persisted.p5_config.retrieval_mode,
                  retrieval_presets: persisted.p5_config.retrieval_presets,
                }
              : undefined;
        const payload =
          section === "A"
            ? {
                name: draft.name,
                description: draft.description,
                additional_instructions: draft.additional_instructions,
                model_name: draft.model_name,
                temperature: draft.temperature,
                is_active: draft.is_active,
                expected_version: draft.config_version,
              }
            : section === "B"
              ? {
                  memory_consolidation_model_name: draft.memory_consolidation_model_name,
                  memory_consolidation_prompt: draft.memory_consolidation_prompt,
                  memory_consolidation_additional_instructions:
                    draft.memory_consolidation_additional_instructions,
                  memory_retrieval_model_name: draft.memory_retrieval_model_name,
                  memory_retrieval_prompt: draft.memory_retrieval_prompt,
                  p5_config: p5Config,
                  expected_version: draft.config_version,
                }
              : {
                  context_compression_model_name: draft.context_compression_model_name,
                  p5_config: p5Config,
                  expected_version: draft.config_version,
                };
        saved = await get().apiClient.updateAgent(get().editorAgentId, payload);
      }
      set((state) => {
        const serverDraft = toDraft(saved);
        const currentDraft = state.editorDraft;
        const editorDraft =
          creating || !currentDraft
            ? serverDraft
            : section === "A"
              ? {
                  ...currentDraft,
                  name: serverDraft.name,
                  description: serverDraft.description,
                  additional_instructions: serverDraft.additional_instructions,
                  model_name: serverDraft.model_name,
                  temperature: serverDraft.temperature,
                  is_active: serverDraft.is_active,
                  config_version: serverDraft.config_version,
                }
              : section === "B"
                ? {
                    ...currentDraft,
                    memory_consolidation_model_name: serverDraft.memory_consolidation_model_name,
                    memory_consolidation_prompt: serverDraft.memory_consolidation_prompt,
                    memory_consolidation_additional_instructions:
                      serverDraft.memory_consolidation_additional_instructions,
                    memory_retrieval_model_name: serverDraft.memory_retrieval_model_name,
                    memory_retrieval_prompt: serverDraft.memory_retrieval_prompt,
                    p5_config: {
                      ...currentDraft.p5_config,
                      retrieval_mode: serverDraft.p5_config.retrieval_mode,
                      retrieval_presets: serverDraft.p5_config.retrieval_presets,
                    },
                    config_version: serverDraft.config_version,
                  }
                : {
                    ...currentDraft,
                    context_compression_model_name: serverDraft.context_compression_model_name,
                    p5_config: {
                      ...serverDraft.p5_config,
                      retrieval_mode: currentDraft.p5_config.retrieval_mode,
                      retrieval_presets: currentDraft.p5_config.retrieval_presets,
                    },
                    config_version: serverDraft.config_version,
                  };
        return {
          agents: [saved, ...state.agents.filter((item) => item.id !== saved.id)],
          editorAgentId: saved.id,
          editorDraft,
          dirty: false,
          error: null,
          feedback: creating
            ? `已创建助手「${saved.name}」，可继续配置记忆、上下文与人设。`
            : section === "A"
              ? "当前 Agent 配置已保存。"
              : `${section} 分区已保存`,
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
      set({ error: null, feedback: "请先保存 Agent 基础记录，再保存人设与性格" });
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
        editorDraft: state.editorDraft
          ? { ...state.editorDraft, persona_intensity: patch.persona_intensity }
          : null,
        dirty: false,
        error: null,
        feedback: "人设与性格已保存并立即生效（无版本号）",
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
        persona: null,
        policy: null,
        memorySessions: [],
        memoryTurns: [],
        memoryEntries: [],
        memoryEntryTotal: 0,
        memoryEntryDetail: null,
        memoryJobs: [],
        dirty: false,
        feedback: "Agent 已删除",
      });
      await get().editAgent("__new__");
    } catch (error) {
      set({ error: errorText(error) });
    }
  },
  deleteAgents: async (ids) => {
    if (ids.length === 0) {
      set({ feedback: "请至少选择一个 Agent。" });
      return;
    }
    try {
      const result = await get().apiClient.deleteAgents(ids);
      const deleted = new Set(result.results.filter((item) => item.deleted).map((item) => item.id));
      const agents = get().agents.filter((item) => !deleted.has(item.id));
      const failed = result.results.filter((item) => !item.deleted);
      let details = failed
        .slice(0, 3)
        .map((item) => item.message)
        .join("；");
      if (failed.length > 3) details = `${details}；另有 ${failed.length - 3} 项失败`;
      const status = `批量删除完成：成功 ${result.deleted_count} 个，失败 ${result.failed_count} 个。`;
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
  refreshModels: async () => {
    try {
      const catalog = await get().apiClient.listModels();
      const modelNames = [...new Set(catalog.models)];
      set({
        modelNames,
        modelStatus: modelNames.length
          ? `LM Studio 当前报告 ${modelNames.length} 个已加载模型。`
          : "LM Studio 当前没有报告已加载模型；仍可保留或手动输入模型 ID。",
        error: null,
      });
    } catch (error) {
      set({ modelStatus: `模型列表加载失败：${errorText(error)}；仍可保留或手动输入模型 ID。` });
    }
  },
  refreshCapacityPreview: async (probeModels) => {
    const draft = get().editorDraft;
    if (!draft) return;
    const p5 = draft.p5_config;
    // The three models to probe come from the caller so that the effect which
    // re-probes on model change actually depends on them, but they must describe
    // the draft the store holds — a stale caller must not probe a different
    // model set than the one the panel is editing.
    const [chatModel, retrievalModel, compressionModel] = probeModels ?? [
      draft.model_name,
      draft.memory_retrieval_model_name,
      draft.context_compression_model_name,
    ];
    const models = [
      ["聊天", chatModel],
      ["记忆读取", retrievalModel ?? chatModel],
      ["摘要", compressionModel ?? chatModel],
    ] as const;
    const cache = new Map<string, Awaited<ReturnType<SuperstringApi["getModelCapacity"]>>>();
    const lines: string[] = [];
    try {
      for (const [label, name] of models) {
        let result = cache.get(name);
        if (!result) {
          result = await get().apiClient.getModelCapacity(name);
          cache.set(name, result);
        }
        if (result.status === "unavailable") {
          // Unavailable always carries the AppError code that caused it
          // (api/models.py:18-20); "unknown" and "loaded" never carry one.
          lines.push(`${label}：未加载／容量未知（${result.error_code}）`);
          continue;
        }
        if (result.context_length === null) {
          lines.push(`${label}：未加载／容量未知（${result.status}）`);
          continue;
        }
        const budget =
          label === "聊天" && p5.context_window !== null
            ? p5.context_window
            : result.context_length;
        if (budget > result.context_length) {
          lines.push(`${label}：实际 ${result.context_length}，自定义 ${budget} 超限，请调整`);
          continue;
        }
        const available =
          budget - p5.max_output_tokens - Math.ceil(budget * p5.safety_margin_ratio);
        lines.push(
          `${label}：实际 ${result.context_length}，预算 ${budget}，输入可用约 ${Math.max(0, available)}；回复预留 ${p5.max_output_tokens}${available <= 0 ? "（预算不足，生成将拒绝）" : ""}`,
        );
      }
      set({ capacityPreview: lines.join("\n"), error: null });
    } catch (error) {
      set({ capacityPreview: `容量预览不可用：${errorText(error)}；未修改配置或加载模型。` });
    }
  },
  reloadMemory: async () => {
    const id = get().editorAgentId;
    if (id === "__new__") {
      set({
        policy: null,
        memorySessions: [],
        memoryTurns: [],
        memoryEntries: [],
        memoryEntryTotal: 0,
        memoryEntryDetail: null,
        memoryJobs: [],
        feedback: "请先创建或选择一个 Agent，这里会显示它的记忆设置。",
      });
      return;
    }
    try {
      const [policy, memorySessions, memoryJobs] = await Promise.all([
        get().apiClient.getPolicy(id),
        get().apiClient.listMemorySessions(id),
        get().apiClient.listMemoryJobs(id),
      ]);
      let feedback = "已加载。策略字段改动即保存；整理完成后可在“记忆列表与治理”中查看结果。";
      const latest = memoryJobs[0];
      if (latest?.status === "failed") {
        feedback += ` 上次整理未成功（${latest.error_code ?? "未知原因"}）。请重新勾选相同轮次，再次点击“第 5 步：开始整理所选轮次”。`;
      } else if (latest && ["queued", "running"].includes(latest.status)) {
        feedback += " 上次提交的整理任务仍在后台处理，稍后可重新打开本分区查看结果。";
      }
      set({
        policy,
        memorySessions,
        memoryTurns: [],
        memoryEntries: [],
        memoryEntryTotal: 0,
        memoryEntryDetail: null,
        memoryJobs,
        feedback,
        error: null,
      });
    } catch (error) {
      set({
        policy: null,
        memorySessions: [],
        memoryTurns: [],
        memoryEntries: [],
        memoryEntryTotal: 0,
        memoryEntryDetail: null,
        memoryJobs: [],
        feedback: `记忆设置未能加载：${errorText(error)}`,
      });
    }
  },
  loadMemoryTurns: async (sessionId, limit) => {
    const id = get().editorAgentId;
    if (id === "__new__") return;
    try {
      const result = await get().apiClient.listMemoryTurns(id, sessionId, limit);
      set({
        memoryTurns: result.turns,
        feedback: "已加载；请勾选需要的轮次。",
        error: null,
      });
    } catch (error) {
      set({
        memoryTurns: [],
        feedback: `记忆设置未能加载：${errorText(error)}`,
      });
    }
  },
  loadMemoryPage: async (page) => {
    const id = get().editorAgentId;
    if (id === "__new__") return;
    if (!Number.isInteger(page) || page < 1) {
      set({ feedback: "页码必须为正整数" });
      return;
    }
    try {
      const result = await get().apiClient.listMemoryEntries(id, (page - 1) * 100, 100);
      set({
        memoryEntries: result.items,
        memoryEntryTotal: result.total,
        memoryEntryDetail: null,
        feedback: `共 ${result.total} 条记忆，当前第 ${page} 页。`,
        error: null,
      });
    } catch (error) {
      set({ feedback: `记忆设置未能加载：${errorText(error)}` });
    }
  },
  loadMemoryEntryDetail: async (memoryId) => {
    const id = get().editorAgentId;
    if (id === "__new__") return;
    try {
      const memoryEntryDetail = await get().apiClient.getMemoryEntry(id, memoryId);
      set({ memoryEntryDetail, error: null });
    } catch (error) {
      set({ feedback: `操作未完成：${errorText(error)}` });
    }
  },
  manualConsolidate: async (sessionId, turnIds) => {
    const id = get().editorAgentId;
    if (id === "__new__") return;
    try {
      let job = await get().apiClient.consolidate(id, {
        session_id: sessionId,
        turn_ids: turnIds,
        request_key: crypto.randomUUID().replaceAll("-", ""),
      });
      if (!["succeeded", "failed"].includes(job.status)) {
        set({ feedback: "已提交整理任务，正在后台生成长期记忆…", error: null });
      }
      for (
        let attempt = 0;
        attempt < 30 && !["succeeded", "failed"].includes(job.status);
        attempt += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        try {
          job = await get().apiClient.getMemoryJob(id, job.id);
        } catch (error) {
          set({
            feedback: `整理任务已提交，但状态查询失败：${errorText(error)}`,
          });
          return;
        }
      }
      if (job.status === "succeeded") {
        set({
          feedback: job.result_id
            ? "整理完成，已写入长期记忆。可在“记忆列表与治理”中查看。"
            : "整理完成：模型判断这些轮次没有需要长期保留的新信息。",
        });
      } else if (job.status === "failed") {
        const reason = job.error_code ?? "未知原因";
        set({
          feedback: `整理失败（${reason}）。请重新勾选相同轮次再次整理。`,
        });
      } else {
        set({
          feedback: "整理仍在后台进行。稍后重新打开本分区，或再次加载轮次查看结果。",
        });
      }
    } catch (error) {
      set({ feedback: `操作未完成：${errorText(error)}` });
    }
  },
  updatePolicy: async (patch) => {
    const id = get().editorAgentId;
    const current = get().policy;
    if (id === "__new__" || !current) return;
    try {
      const policy = await get().apiClient.updatePolicy(id, {
        ...patch,
        expected_version: current.version,
      });
      set({ policy, feedback: "整理策略已保存。", error: null });
    } catch {
      try {
        const policy = await get().apiClient.getPolicy(id);
        set({ policy, feedback: "保存未成功，已恢复服务器值，请重试。" });
      } catch (error) {
        set({ feedback: `记忆设置未能加载：${errorText(error)}` });
      }
    }
  },
  resetForTests: (client = api) => set({ ...initial, apiClient: client }),
}));
