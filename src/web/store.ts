import { create } from "zustand";
import { api } from "./api";
import { createAgentActions } from "./features/agents/actions";
import { createModelActions } from "./features/agents/model-actions";
import { createPageActions } from "./features/agents/page-actions";
import { createChatActions } from "./features/chat/actions";
import { createDirectoryActions } from "./features/conversations/directory-state";
import { createDesktopSettingsActions } from "./features/general/desktop-state";
import { createKnowledgeActions } from "./features/knowledge/actions";
import { createKnowledgeModelActions } from "./features/knowledge/model-actions";
import { createOrganizationActions } from "./features/knowledge/organization-actions";
import { createKnowledgeReadActions } from "./features/knowledge/read-actions";
import { createMemoryActions } from "./features/memory/actions";
import {
  createQqAccessActions,
  createQqSchemeActions,
  createQqStickerActions,
  createQqStorageActions,
} from "./features/qq/actions";
import { createQqDraftActions, emptyQqInputs } from "./features/qq/draft-state";
import { createRunActions } from "./features/runs/slice";
import { createBootstrapActions } from "./state/bootstrap";
import { defaultEffects } from "./state/effects";
import { initial } from "./state/initial";
import { createNavigationActions } from "./state/navigation";
import type { SuperstringState } from "./state/types";

export type {
  AgentDraft,
  ChatItem,
  LoadStatus,
  Page,
  PendingNavigation,
  SectionKey,
  SettingsView,
  SuperstringState,
} from "./state/types";

export const useSuperstringStore = create<SuperstringState>()((set, get) => ({
  ...initial,
  apiClient: api,
  effects: defaultEffects,
  ...createBootstrapActions(set, get),
  ...createNavigationActions(set, get),
  ...createChatActions(set, get),
  ...createDirectoryActions(set, get),
  ...createAgentActions(set, get),
  ...createPageActions(set, get),
  ...createModelActions(set, get),
  ...createMemoryActions(set, get),
  ...createRunActions(set, get),
  ...createKnowledgeActions(set, get),
  ...createKnowledgeModelActions(set, get),
  ...createKnowledgeReadActions(set, get),
  ...createOrganizationActions(set, get),
  ...createQqStickerActions(set, get),
  ...createQqSchemeActions(set, get),
  ...createQqStorageActions(set, get),
  ...createQqAccessActions(set, get),
  ...createQqDraftActions(set, get),
  ...createDesktopSettingsActions(set, get),
  setNotice: (patch) => set(patch),
  clearMemoryDetail: () => {
    if (get().memoryCorrectionDirty || get().memoryCorrectionSaving) return;
    get().discardMemoryCorrection();
    set({ memoryEntryDetail: null });
  },
  resetForTests: (client = api, effects = {}) =>
    set({
      ...initial,
      qqInputs: emptyQqInputs(),
      apiClient: client,
      effects: { ...defaultEffects, ...effects },
    }),
}));
