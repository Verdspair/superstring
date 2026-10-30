import type {
  AgentResponse,
  MemoryAccessMetadata,
  MemoryContentResponse,
  MemoryCorrection,
  MemoryEntryResponse,
  MemoryJobView,
  MemoryManagementEntry,
  MemorySessionOption,
  MemoryTurnRow,
  PersonaResponse,
  PolicyView,
} from "../../shared/contracts";
import type { ModelProviderResponse } from "../../shared/contracts/models";
import type { SystemComponentTarget } from "../../shared/contracts/tool-directory";
import type { SuperstringApi } from "../api";
import type { BrowserStateStorage } from "../browser-state";
import { permissionInitial } from "../features/access/permission-state";
import { webAccessInitial } from "../features/access/web-access-state";
import { initialConversationState } from "../features/chat/conversation-state";
import { directoryInitial } from "../features/conversations/directory-state";
import { desktopSettingsInitial } from "../features/general/desktop-state";
import { knowledgeInitial } from "../features/knowledge/types";
import { emptyQqInputs } from "../features/qq/draft-state";
import { qqGroupConfigInitial } from "../features/qq/group-config-state";
import { qqManagedEventsInitial } from "../features/qq/managed-events-state";
import { qqManagedInitial } from "../features/qq/managed-state";
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
  ...qqManagedEventsInitial,
  ...qqManagedInitial,
  qqManagedLifecycleId: 0,
  ...qqGroupConfigInitial,
  qqInputs: emptyQqInputs(),
  ...desktopSettingsInitial,
  pageEditor: null as import("../features/agents/page-drafts").PageEditor | null,
  contextAllocationTarget: {
    purpose: "assistant",
    agentId: null,
    schemeId: null,
    bindingId: null,
    returnRoute: null,
    returnLabel: null,
  } as import("../features/context-allocation").ContextAllocationTarget,
  modelCapacityTarget: null as string | null,
  allocationInvalidInputs: {} as Record<string, string>,
  settingsSaving: false,
  settingsSaveOwner: null as object | null,
  status: "idle" as LoadStatus,
  error: null as string | null,
  feedback: "",
  agentTaskResult: null as import("./types").SuperstringState["agentTaskResult"],
  page: "chat" as Page,
  settingsView: "hub" as SettingsView,
  settingsRoute: "basic" as SettingsRoute,
  componentTarget: null as SystemComponentTarget | null,
  workspaceReturns: [] as import("../workspace/navigation-context").WorkspaceReturnContext[],
  conversationView: "messages" as ConversationView,
  conversationScope: "current" as ConversationScope,
  qqSchemeView: "settings" as QqSchemeView,
  dirty: false,
  pendingNavigation: null as PendingNavigation | null,
  navigationConfirmOpen: false,
  navigationConfirmMessage: "",
  agents: [] as AgentResponse[],
  selectedNewSessionAgentId: null as string | null,
  editorAgentId: "__new__" as const,
  editorDraft: null as AgentDraft | null,
  editorLoading: false,
  editorBaselineRefresh: null as import("./types").SuperstringState["editorBaselineRefresh"],
  persona: null as PersonaResponse | null,
  policy: null as PolicyView | null,
  memorySessions: [] as MemorySessionOption[],
  memoryTurns: [] as MemoryTurnRow[],
  memoryEntries: [] as MemoryManagementEntry[],
  memoryEntryTotal: 0,
  memoryManagementError: null as string | null,
  memoryManagementLoading: false,
  memoryReadSelection: null as {
    entry: MemoryManagementEntry;
    conversationId: string | null;
  } | null,
  memoryReadable: null as import("../../shared/contracts/memory").MemoryReadablePage | null,
  memorySources: null as import("../../shared/contracts/memory").MemorySourcePreviewList | null,
  memorySourcePreview: null as
    | import("../../shared/contracts/memory").MemorySourcePreviewPage
    | null,
  memoryReadableOffset: 0,
  memorySourceOffset: 0,
  memorySourcePosition: null as { sourceKey: string; revision: string; offset: number } | null,
  memoryReadLoading: false,
  memoryReadError: null as string | null,
  memoryEntryDetail: null as MemoryEntryResponse | null,
  memoryContent: null as MemoryContentResponse | null,
  memoryCorrectionDraft: null as MemoryCorrection | null,
  memoryCorrectionDirty: false,
  memoryCorrectionSaving: false,
  memoryMetadata: null as MemoryAccessMetadata | null,
  memoryMetadataBaseline: null as {
    agentId: string;
    memoryId: string;
    visibility: "session_private" | "agent_shared" | "public" | null;
    revision: number;
    recipient_agent_ids: string[];
    api: SuperstringApi;
  } | null,
  memoryVisibilityDraft: null as {
    visibility: "session_private" | "agent_shared" | "public" | null;
    recipient_agent_ids: string[];
  } | null,
  memoryVisibilityDirty: false,
  memoryMetadataLoading: false,
  memoryVisibilitySaving: false,
  memoryVisibilityError: null as string | null,
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
