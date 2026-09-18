import { create } from "zustand";
import { api } from "./api";
import { createAgentActions } from "./features/agents/actions";
import { createModelActions } from "./features/agents/model-actions";
import { createChatActions } from "./features/chat/actions";
import { createMemoryActions } from "./features/memory/actions";
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
  ...createAgentActions(set, get),
  ...createModelActions(set, get),
  ...createMemoryActions(set, get),
  setNotice: (patch) => set(patch),
  clearMemoryDetail: () => set({ memoryEntryDetail: null }),
  clearMemoryTurns: () => set({ memoryTurns: [] }),
  resetForTests: (client = api, effects = {}) =>
    set({
      ...initial,
      apiClient: client,
      effects: { ...defaultEffects, ...effects },
    }),
}));
