import type { StoreApi } from "zustand";
import type {
  AgentResponse,
  MemoryEntryResponse,
  MemoryJobView,
  MemorySessionOption,
  MemorySummary,
  MemoryTurnRow,
  PersonaResponse,
  PolicyView,
  RuntimeConfig,
  SessionResponse,
} from "../../shared/contracts";
import type { SuperstringApi, streamChat } from "../api";
import type { BrowserStateStorage } from "../browser-state";

export type Page = "chat" | "settings";
export type SettingsView = "hub" | "agents" | "appearance" | "general" | "operating-mode";
export type SectionKey = "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H" | "knowledge";
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
  chatContextCapacity: number | null;
  composer: string;
  sending: boolean;
  pendingOperations: number;
  browserStateStorage: BrowserStateStorage | null;
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
  renameSession: (id: string, title: string) => Promise<boolean>;
  deleteSessionById: (id: string) => Promise<boolean>;
  refreshSessionById: (id: string) => Promise<boolean>;
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
  resetForTests: (client?: SuperstringApi, effects?: Partial<RuntimeEffects>) => void;
}

export interface RuntimeEffects {
  streamChat: typeof streamChat;
  requestId: () => string;
  now: () => string;
}
export type StoreGet = StoreApi<SuperstringState>["getState"];
export type StoreSet = StoreApi<SuperstringState>["setState"];
