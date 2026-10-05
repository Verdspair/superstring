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
import type { BrowserStateStorage } from "../browser-state";
import { permissionInitial } from "../features/access/permission-state";
import { webAccessInitial } from "../features/access/web-access-state";
import { initialConversationState } from "../features/chat/conversation-state";
import { directoryInitial } from "../features/conversations/directory-state";
import { desktopSettingsInitial } from "../features/general/desktop-state";
import { knowledgeInitial } from "../features/knowledge/types";
import { emptyQqInputs } from "../features/qq/draft-state";
import { qqGroupConfigInitial } from "../features/qq/group-config-state";
import {
  qqAccessInitial,
  qqSchemeInitial,
  qqStickerInitial,
  qqStorageInitial,
} from "../features/qq/types";
import { initialRunState } from "../features/runs/slice";
import type { SettingsRoute } from "../workspace/settings-routes";
import type {
  AgentDraft,
  ConversationScope,
  ConversationView,
  LoadStatus,
  Page,
  PendingNavigation,
  QqSchemeView,
  SectionKey,
  SettingsView,
} from "./types";

export const initial = {
  ...permissionInitial,
  ...webAccessInitial,
  ...initialRunState,
  ...initialConversationState,
  ...directoryInitial,
  ...knowledgeInitial,
  ...qqStickerInitial,
  ...qqSchemeInitial,
  ...qqStorageInitial,
  ...qqAccessInitial,
  ...qqGroupConfigInitial,
  qqInputs: emptyQqInputs(),
  ...desktopSettingsInitial,
  pageEditor: null as import("../features/agents/page-drafts").PageEditor | null,
  settingsSaving: false,
  status: "idle" as LoadStatus,
  error: null as string | null,
  feedback: "",
  page: "chat" as Page,
  settingsView: "hub" as SettingsView,
  settingsRoute: "basic" as SettingsRoute,
  componentTarget: null as SystemComponentTarget | null,
  conversationView: "messages" as ConversationView,
  conversationScope: "current" as ConversationScope,
  qqSchemeView: "settings" as QqSchemeView,
  activeSection: "A" as SectionKey,
  dirty: false,
  pendingNavigation: null as PendingNavigation | null,
  navigationConfirmOpen: false,
  navigationConfirmMessage: "",
  agents: [] as AgentResponse[],
  selectedNewSessionAgentId: null as string | null,
  editorAgentId: "__new__" as const,
  editorDraft: null as AgentDraft | null,
  editorLoading: false,
  persona: null as PersonaResponse | null,
  policy: null as PolicyView | null,
  memorySessions: [] as MemorySessionOption[],
  memoryTurns: [] as MemoryTurnRow[],
  memoryEntries: [] as MemorySummary[],
  memoryEntryTotal: 0,
  memoryEntryDetail: null as MemoryEntryResponse | null,
  memoryContent: null as MemoryContentResponse | null,
  memoryCorrectionDraft: null as MemoryCorrection | null,
  memoryCorrectionDirty: false,
  memoryCorrectionSaving: false,
  memoryJobs: [] as MemoryJobView[],
  qqMemoryBatchDrafts: {} as Record<string, { value: string; revision: number }>,
  qqMemoryBatchSaving: false,
  modelNames: [] as string[],
  modelProviders: [] as ModelProviderResponse[],
  loadedModelNames: [] as string[],
  externalModelNames: [] as string[],
  modelStatus: "模型列表将在打开配置时加载。",
  capacityPreview: "",
  chatContextCapacity: null as number | null,
  pendingOperations: 0,
  browserStateStorage: null as BrowserStateStorage | null,
  sessionStateStorage: null as BrowserStateStorage | null,
};
