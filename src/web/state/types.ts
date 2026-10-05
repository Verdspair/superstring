import type { StoreApi } from "zustand";
import type {
  AgentResponse,
  MemoryContentResponse,
  MemoryCorrection,
  MemoryEntryResponse,
  MemoryJobView,
  MemorySessionOption,
  MemorySummary,
  MemoryTurnRow,
  PersonaResponse,
  PolicyView,
} from "../../shared/contracts";
import type { ModelProviderResponse } from "../../shared/contracts/models";
import type { SystemComponentTarget } from "../../shared/contracts/tool-directory";
import type { SuperstringApi, streamChatV2 } from "../api";
import type { BrowserStateStorage } from "../browser-state";
import type { PermissionSettingsState } from "../features/access/permission-state";
import type { WebAccessState } from "../features/access/web-access-state";
import type { ConversationState } from "../features/chat/conversation-state";
import type { ConversationDirectoryState } from "../features/conversations/directory-state";
import type { DesktopSettingsState } from "../features/general/desktop-state";
import type { KnowledgeState, KnowledgeTarget } from "../features/knowledge/types";
import type { QqDraftState } from "../features/qq/draft-state";
import type {
  QqAccessState,
  QqGroupConfigState,
  QqSchemeState,
  QqStickerState,
  QqStorageState,
} from "../features/qq/types";
import type { RunState } from "../features/runs/slice";
import type { SettingsRoute } from "../workspace/settings-routes";

export type Page = "chat" | "settings";
export type SettingsView =
  | "hub"
  | "agents"
  | "appearance"
  | "general"
  | "operating-mode"
  | "knowledge"
  | "workspace"
  | "observability";
export type SectionKey = "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H" | "knowledge";
export type LoadStatus = "idle" | "loading" | "ready" | "error";
export type ConversationView = "messages" | "activity" | "tasks";
export type ConversationScope = "current" | "global";
export type QqSchemeView = "settings" | "bindings";
export type PendingNavigation =
  | {
      kind: "page";
      page: Page;
      settingsView: SettingsView;
      settingsRoute?: SettingsRoute;
      componentTarget?: SystemComponentTarget;
      conversationId?: string;
      /** 携带到落地时才生效的对话视图/范围；取消不泄漏，保存失败保留整个载荷。 */
      conversationView?: ConversationView;
      conversationScope?: ConversationScope;
    }
  | { kind: "agent"; id: string | "__new__" }
  | { kind: "section"; section: SectionKey }
  | { kind: "scheme"; id: string; view?: QqSchemeView }
  | { kind: "group-config"; bindingId: string }
  | { kind: "knowledge"; target: KnowledgeTarget };

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

export interface SuperstringState
  extends ConversationState,
    PermissionSettingsState,
    WebAccessState,
    ConversationDirectoryState,
    RunState,
    KnowledgeState,
    QqStickerState,
    QqSchemeState,
    QqStorageState,
    QqAccessState,
    QqGroupConfigState,
    QqDraftState,
    DesktopSettingsState {
  pageEditor: import("../features/agents/page-drafts").PageEditor | null;
  settingsSaving: boolean;
  patchPagePolicy: (patch: Partial<Omit<PolicyView, "version">>) => void;
  patchPageAgent: (
    page: import("../features/agents/page-drafts").EditablePage,
    patch: Partial<AgentDraft>,
  ) => void;
  patchPagePersona: (
    page: import("../features/agents/page-drafts").EditablePage,
    patch: Partial<PersonaResponse>,
  ) => void;
  saveSettingsPage: (
    page: import("../features/agents/page-drafts").EditablePage,
  ) => Promise<boolean>;
  saveAllSettingsPages: () => Promise<boolean>;
  /** 显式刷新保存基线：GET 当前 Agent，只推进未修改字段与 config_version，保留已改草稿且不自动重试保存。 */
  refreshSettingsAgent: () => Promise<boolean>;
  /**
   * 一键覆盖：把当前助手的四个**文本用途**模型（对话、记忆读取、记忆整理、
   * 上下文压缩）都设成给定的默认模型，并立即保存该助手的模型页。图片理解与语音转写不是助手的字段，
   * 因此不在覆盖范围内。没有可覆盖的助手（正在新建）时返回 false。
   */
  applyDefaultModelToAgent: (modelName: string) => Promise<boolean>;
  /**
   * 放弃设置页草稿：不传页时整份回到已存基线；传页时只还原该页拥有的字段，
   * 其他页面的草稿保持不变。
   */
  discardSettingsPages: (page?: import("../features/agents/page-drafts").EditablePage) => void;
  status: LoadStatus;
  error: string | null;
  feedback: string;
  page: Page;
  settingsView: SettingsView;
  settingsRoute: SettingsRoute;
  componentTarget: SystemComponentTarget | null;
  conversationView: ConversationView;
  conversationScope: ConversationScope;
  qqSchemeView: QqSchemeView;
  openSettingsRoute: (route: SettingsRoute) => void;
  openSystemComponent: (target: SystemComponentTarget) => void;
  activeSection: SectionKey;
  dirty: boolean;
  pendingNavigation: PendingNavigation | null;
  navigationConfirmOpen: boolean;
  navigationConfirmMessage: string;
  agents: AgentResponse[];
  selectedNewSessionAgentId: string | null;
  editorAgentId: string | "__new__";
  editorDraft: AgentDraft | null;
  editorLoading: boolean;
  persona: PersonaResponse | null;
  policy: PolicyView | null;
  memorySessions: MemorySessionOption[];
  memoryTurns: MemoryTurnRow[];
  memoryEntries: MemorySummary[];
  memoryEntryTotal: number;
  memoryEntryDetail: MemoryEntryResponse | null;
  memoryContent: MemoryContentResponse | null;
  memoryCorrectionDraft: MemoryCorrection | null;
  memoryCorrectionDirty: boolean;
  memoryCorrectionSaving: boolean;
  loadMemoryContent: () => Promise<void>;
  patchMemoryCorrection: (patch: Partial<MemoryCorrection>) => void;
  saveMemoryCorrection: () => Promise<boolean>;
  discardMemoryCorrection: () => void;
  memoryJobs: MemoryJobView[];
  qqMemoryBatchDrafts: Record<string, { value: string; revision: number }>;
  qqMemoryBatchSaving: boolean;
  patchQqMemoryBatchDraft: (id: string, draft: { value: string; revision: number } | null) => void;
  saveQqMemoryBatchDrafts: (ids?: string[]) => Promise<boolean>;
  discardQqMemoryBatchDrafts: () => void;
  /** 所有可选项（本地已加载 + 外部声明的），选择器用它渲染选项。 */
  modelNames: string[];
  /** Bootstrap 时登记过的外部模型服务（编辑器消费的真实对象，仅启动快照）。 */
  modelProviders: ModelProviderResponse[];
  /** 本地服务**当前已加载**的模型。 */
  loadedModelNames: string[];
  /** 外部模型 API 里声明过的模型名。 */
  externalModelNames: string[];
  modelStatus: string;
  recalculateCapacityPreview: () => void;
  capacityPreview: string;
  chatContextCapacity: number | null;
  pendingOperations: number;
  browserStateStorage: BrowserStateStorage | null;
  sessionStateStorage: BrowserStateStorage | null;
  apiClient: SuperstringApi;
  effects: RuntimeEffects;
  deleteMessage: (sessionId: string | null, messageId: string) => Promise<void>;
  governMemories: (
    agentId: string,
    ids: string[],
    action: "suppress" | "enable" | "purge",
    confirmed: boolean,
  ) => Promise<boolean>;
  mergeMemories: (agentId: string, ids: string[]) => Promise<boolean>;
  setNotice: (patch: Partial<Pick<SuperstringState, "error" | "feedback">>) => void;
  clearMemoryDetail: () => void;
  clearMemoryTurns: () => void;
  resetMemoryManagement: () => void;
  bootstrap: () => Promise<void>;
  openChat: () => void;
  openSettings: () => void;
  openAgentSettings: () => void;
  closeAgentSettings: () => void;
  requestPageNavigation: (page: Page, settingsView?: SettingsView) => void;
  requestConversationView: (view: ConversationView, scope?: ConversationScope) => void;
  requestAgentNavigation: (id: string | "__new__") => void;
  requestQqSchemeNavigation: (id: string, view?: QqSchemeView) => void;
  /** 本群配置入口：打开某间群的完整设置页，一律走统一草稿守卫。 */
  openQqGroupConfig: (bindingId: string) => void;
  confirmSaveAndContinue: () => Promise<void>;
  confirmDiscardAndContinue: () => Promise<void>;
  cancelPendingNavigation: () => void;
  setNewSessionAgent: (id: string | null) => void;
  selectSession: (id: string) => Promise<void>;
  createSession: (title: string) => Promise<boolean>;
  renameSession: (id: string, title: string) => Promise<boolean>;
  deleteSessionById: (id: string) => Promise<boolean>;
  refreshSessionById: (id: string) => Promise<boolean>;
  deleteCurrentSession: () => Promise<void>;
  refreshSession: () => Promise<void>;
  setComposer: (value: string) => void;
  send: () => Promise<void>;
  retryChat: () => Promise<void>;
  resendKnowledgeChat: () => Promise<void>;
  cancelKnowledgeResend: () => void;
  editAgent: (id: string | "__new__") => Promise<boolean>;
  patchDraft: (patch: Partial<AgentDraft>) => void;
  saveCurrentSection: () => Promise<boolean>;
  savePersona: (
    patch: Partial<PersonaResponse> & { persona_intensity: number },
  ) => Promise<boolean>;
  deleteAgents: (ids: string[]) => Promise<void>;
  refreshModels: () => Promise<void>;
  refreshCapacityPreview: (
    probeModels?: readonly [string, string | null, string | null],
  ) => Promise<void>;
  reloadMemory: () => Promise<void>;
  loadMemoryPolicy: () => Promise<void>;
  loadMemoryTurns: (sessionId: string, limit: number) => Promise<void>;
  loadMemoryPage: (
    page: number,
    filters?: { scope_key?: string; search?: string; status?: string },
  ) => Promise<void>;
  loadMemoryEntryDetail: (memoryId: string) => Promise<void>;
  manualConsolidate: (sessionId: string, turnIds: string[]) => Promise<void>;
  updatePolicy: (patch: Omit<PolicyView, "version">) => Promise<void>;
  resetForTests: (client?: SuperstringApi, effects?: Partial<RuntimeEffects>) => void;
}

export interface RuntimeEffects {
  streamChatV2: typeof streamChatV2;
  requestId: () => string;
  now: () => string;
}
export type StoreGet = StoreApi<SuperstringState>["getState"];
export type StoreSet = StoreApi<SuperstringState>["setState"];
