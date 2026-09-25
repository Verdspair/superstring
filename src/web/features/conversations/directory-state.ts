import type { ConversationSummary } from "../../../shared/contracts/conversation";
import { errorText, persistBrowserState } from "../../state/helpers";
import type { StoreGet, StoreSet, SuperstringState } from "../../state/types";

export interface ConversationDirectoryState {
  summaryById: Record<string, ConversationSummary>;
  directoryIds: string[];
  directoryCursor: string | null;
  directoryLoading: boolean;
  directoryError: string | null;
  directoryRevision: number;
  selectionRevision: number;
  rememberConversation: (summary: ConversationSummary) => void;
  loadConversations: (mode?: "refresh" | "more" | "refresh-loaded") => Promise<boolean>;
  selectConversation: (id: string) => Promise<void>;
  requestConversationNavigation: (id: string) => Promise<void>;
}

export const directoryInitial = {
  summaryById: {} as Record<string, ConversationSummary>,
  directoryIds: [] as string[],
  directoryCursor: null as string | null,
  directoryLoading: false,
  directoryError: null as string | null,
  directoryRevision: 0,
  selectionRevision: 0,
};
export function selectedConversation(state: SuperstringState) {
  return state.currentConversationId
    ? (state.summaryById[state.currentConversationId] ?? null)
    : null;
}
export function currentSessionId(state: SuperstringState): string | null {
  const selected = selectedConversation(state);
  return selected?.channel === "web" ? selected.sourceId : null;
}

export function createDirectoryActions(
  set: StoreSet,
  get: StoreGet,
): Pick<
  ConversationDirectoryState,
  "rememberConversation" | "loadConversations" | "selectConversation"
> {
  let activeRead = 0;
  return {
    rememberConversation: (summary) =>
      set((state) => ({
        summaryById: { ...state.summaryById, [summary.id]: summary },
        directoryIds: state.directoryIds.includes(summary.id)
          ? state.directoryIds
          : [summary.id, ...state.directoryIds],
        sessionConversationIds:
          summary.channel === "web"
            ? { ...state.sessionConversationIds, [summary.sourceId]: summary.id }
            : state.sessionConversationIds,
        directoryRevision: state.directoryRevision + 1,
      })),
    loadConversations: async (mode = "refresh") => {
      const more = mode === "more";
      const loadedCount = get().directoryIds.length;
      const selected = get().currentConversationId;
      const keepSelectedVisible = !!selected && get().directoryIds.includes(selected);
      const readId = ++activeRead;
      const revision = get().directoryRevision + 1;
      const cursor = more ? get().directoryCursor : null;
      set({ directoryRevision: revision, directoryLoading: true, directoryError: null });
      try {
        let page = await get().apiClient.listConversations(cursor ? { cursor } : {});
        if (get().directoryRevision !== revision) return false;
        const refreshed = new Map(page.items.map((item) => [item.id, item]));
        // Background completion refreshes the already loaded range, following the server's
        // current cursors. Rebuilding that range also removes remotely deleted entries.
        while (
          mode === "refresh-loaded" &&
          page.nextCursor &&
          (refreshed.size < loadedCount || (keepSelectedVisible && !refreshed.has(selected)))
        ) {
          page = await get().apiClient.listConversations({ cursor: page.nextCursor });
          if (get().directoryRevision !== revision) return false;
          for (const item of page.items) refreshed.set(item.id, item);
        }
        const items = [...refreshed.values()];
        set((state) => ({
          summaryById: {
            ...state.summaryById,
            ...Object.fromEntries(items.map((item) => [item.id, item])),
          },
          directoryIds: [
            ...new Set([...(more ? state.directoryIds : []), ...items.map((item) => item.id)]),
          ],
          sessionConversationIds: {
            ...state.sessionConversationIds,
            ...Object.fromEntries(
              items
                .filter((item) => item.channel === "web")
                .map((item) => [item.sourceId, item.id]),
            ),
          },
          directoryCursor: page.nextCursor,
        }));
        return true;
      } catch (reason) {
        if (get().directoryRevision === revision) set({ directoryError: errorText(reason) });
        return false;
      } finally {
        // Local mutations invalidate a read without starting another one.
        if (activeRead === readId) set({ directoryLoading: false });
      }
    },
    selectConversation: async (id) => {
      const summary = get().summaryById[id];
      if (!summary) return;
      if (summary.channel === "web") await get().selectSession(summary.sourceId);
      else {
        set({
          currentConversationId: id,
          selectionRevision: get().selectionRevision + 1,
          error: null,
        });
        persistBrowserState(get().browserStateStorage, "superstring-conversation", id);
      }
    },
  };
}
