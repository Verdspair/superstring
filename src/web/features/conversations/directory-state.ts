import type {
  ConversationMemoryReadMode,
  ConversationSummary,
} from "../../../shared/contracts/conversation";
import { clearAllCaches, saveDirectoryCache } from "../../services/page-snapshot-cache";
import { type ReadTask, startRead } from "../../services/read-task";
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
  resolveConversationSource: (
    channel: "web" | "onebot11",
    sourceId: string,
    agentId: string | null,
  ) => Promise<ConversationSummary | null>;
  refreshConversationSummary: (id: string) => Promise<boolean>;
  loadConversations: (mode?: "refresh" | "more" | "refresh-loaded") => Promise<boolean>;
  selectConversation: (id: string) => Promise<void>;
  requestConversationNavigation: (id: string) => Promise<void>;
  memoryReadModeBaseline: {
    id: string;
    mode: ConversationMemoryReadMode;
    revision: number;
    api: SuperstringState["apiClient"];
  } | null;
  memoryReadModeDraft: ConversationMemoryReadMode | null;
  memoryReadModeLoading: boolean;
  memoryReadModeSaving: boolean;
  memoryReadModeError: string | null;
  loadConversationMemoryReadMode: (
    id: string,
    options?: { force?: boolean; preserveDraft?: boolean },
  ) => Promise<boolean>;
  cancelConversationMemoryReadMode: () => void;
  patchConversationMemoryReadModeDraft: (mode: ConversationMemoryReadMode) => void;
  saveConversationMemoryReadMode: (id: string) => Promise<boolean>;
  discardConversationMemoryReadMode: () => void;
  refreshConversationMemoryReadMode: (id: string) => Promise<boolean>;
}

export const directoryInitial = {
  summaryById: {} as Record<string, ConversationSummary>,
  directoryIds: [] as string[],
  directoryCursor: null as string | null,
  directoryLoading: false,
  directoryError: null as string | null,
  directoryRevision: 0,
  selectionRevision: 0,
  memoryReadModeBaseline: null as {
    id: string;
    mode: ConversationMemoryReadMode;
    revision: number;
    api: SuperstringState["apiClient"];
  } | null,
  memoryReadModeDraft: null as ConversationMemoryReadMode | null,
  memoryReadModeLoading: false,
  memoryReadModeSaving: false,
  memoryReadModeError: null as string | null,
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

export function conversationModeDirty(state: {
  memoryReadModeBaseline: {
    id: string;
    mode: ConversationMemoryReadMode;
    revision: number;
    api: SuperstringState["apiClient"];
  } | null;
  memoryReadModeDraft: ConversationMemoryReadMode | null;
  currentConversationId: string | null;
  apiClient: SuperstringState["apiClient"];
}): boolean {
  if (!state.currentConversationId || !state.memoryReadModeBaseline) return false;
  if (state.memoryReadModeBaseline.id !== state.currentConversationId) return false;
  if (state.memoryReadModeBaseline.api !== state.apiClient) return false;
  if (state.memoryReadModeDraft === null) return false;
  return state.memoryReadModeDraft !== state.memoryReadModeBaseline.mode;
}

export function createDirectoryActions(
  set: StoreSet,
  get: StoreGet,
): Pick<
  ConversationDirectoryState,
  | "rememberConversation"
  | "resolveConversationSource"
  | "refreshConversationSummary"
  | "loadConversations"
  | "selectConversation"
  | "loadConversationMemoryReadMode"
  | "cancelConversationMemoryReadMode"
  | "patchConversationMemoryReadModeDraft"
  | "saveConversationMemoryReadMode"
  | "discardConversationMemoryReadMode"
  | "refreshConversationMemoryReadMode"
> {
  let activeRead = 0;
  let nextSummaryToken = 0;
  let nextModeReadToken = 0;
  let nextModeSaveToken = 0;
  let activeModeReadTask: ReadTask | null = null;
  let activeModeResolve: ((success: boolean) => void) | null = null;
  const activeSummaryReads = new Map<
    string,
    { api: SuperstringState["apiClient"]; token: number; dirty: boolean; promise: Promise<boolean> }
  >();
  const activeResolveTokens = new Map<string, number>();

  return {
    rememberConversation: (summary) =>
      set((state) => ({
        summaryById: { ...state.summaryById, [summary.id]: summary },
        directoryIds: [summary.id, ...state.directoryIds.filter((item) => item !== summary.id)],
        sessionConversationIds:
          summary.channel === "web"
            ? { ...state.sessionConversationIds, [summary.sourceId]: summary.id }
            : state.sessionConversationIds,
        directoryRevision: state.directoryRevision + 1,
      })),
    // 单一规范来源读取：exact channel/source(/agent) 命中即由既有 rememberConversation 落地目录；
    // 迟到的旧 API/旧读取不回写；读取失败只记 directoryError，属非致命，调用方自行决定重试。
    resolveConversationSource: async (channel, sourceId, agentId) => {
      const capturedApi = get().apiClient;
      const key = `${channel}/${sourceId}`;
      const token = ++nextSummaryToken;
      activeResolveTokens.set(key, token);
      try {
        const { items } = await capturedApi.listConversations({ channel, sourceId });
        const summary = items.find(
          (item) =>
            item.channel === channel &&
            item.sourceId === sourceId &&
            (agentId === null || item.agentId === agentId),
        );
        if (get().apiClient !== capturedApi || activeResolveTokens.get(key) !== token) return null;
        if (!summary) return null;
        if (channel === "onebot11") {
          const binding = get().qqBindings.find((row) => row.id === sourceId);
          if (!binding || binding.agent_id !== agentId) return null;
        }
        set({ directoryError: null });
        get().rememberConversation(summary);
        return summary;
      } catch (reason) {
        if (get().apiClient === capturedApi && activeResolveTokens.get(key) === token) {
          set({ directoryError: errorText(reason) });
        }
        return null;
      } finally {
        if (activeResolveTokens.get(key) === token) activeResolveTokens.delete(key);
      }
    },
    refreshConversationSummary: (id: string) => {
      const capturedApi = get().apiClient;
      const active = activeSummaryReads.get(id);
      if (active?.api === capturedApi) {
        active.dirty = true;
        return active.promise;
      }
      let resolve!: (success: boolean) => void;
      const read = {
        api: capturedApi,
        token: ++nextSummaryToken,
        dirty: false,
        promise: new Promise<boolean>((done) => {
          resolve = done;
        }),
      };
      activeSummaryReads.set(id, read);
      void (async () => {
        let success = false;
        try {
          do {
            read.dirty = false;
            const initialSummary = get().summaryById[id];
            try {
              const summary = await capturedApi.getConversation(id);
              success = true;
              if (
                get().apiClient === capturedApi &&
                activeSummaryReads.get(id)?.token === read.token &&
                get().summaryById[id] === initialSummary
              ) {
                get().rememberConversation(summary);
              }
            } catch {
              success = false;
            }
          } while (
            read.dirty &&
            get().apiClient === capturedApi &&
            activeSummaryReads.get(id)?.token === read.token
          );
        } finally {
          if (activeSummaryReads.get(id)?.token === read.token) activeSummaryReads.delete(id);
          resolve(success);
        }
      })();
      return read.promise;
    },
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
        void saveDirectoryCache(get().sessionStateStorage, items, revision);
        return true;
      } catch (reason) {
        if (get().directoryRevision === revision) {
          const err = errorText(reason);
          set({ directoryError: err });
          if (err.includes("403") || err.includes("revoked") || err.includes("Forbidden")) {
            void clearAllCaches(get().sessionStateStorage);
          }
        }
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
    cancelConversationMemoryReadMode: () => {
      if (activeModeResolve) {
        activeModeResolve(false);
        activeModeResolve = null;
      }
      if (activeModeReadTask) {
        activeModeReadTask.cancel();
        activeModeReadTask = null;
      }
    },
    loadConversationMemoryReadMode: (id, options) => {
      const capturedApi = get().apiClient;
      if (
        !options?.force &&
        get().memoryReadModeBaseline?.id === id &&
        get().memoryReadModeBaseline?.api === capturedApi
      ) {
        return Promise.resolve(true);
      }
      if (activeModeResolve) {
        activeModeResolve(false);
        activeModeResolve = null;
      }
      activeModeReadTask?.cancel();
      const token = ++nextModeReadToken;
      set({ memoryReadModeLoading: true, memoryReadModeError: null });

      return new Promise<boolean>((resolve) => {
        activeModeResolve = resolve;
        const task = startRead((signal) => capturedApi.getConversationMemoryReadMode(id, signal), {
          success: (res) => {
            activeModeResolve = null;
            activeModeReadTask = null;
            if (
              get().apiClient !== capturedApi ||
              nextModeReadToken !== token ||
              get().currentConversationId !== id
            ) {
              resolve(false);
              return;
            }
            set((state) => {
              const prevBaseline = state.memoryReadModeBaseline;
              const isSameEntry =
                prevBaseline !== null && prevBaseline.id === id && prevBaseline.api === capturedApi;
              const isActuallyDirty =
                isSameEntry &&
                state.memoryReadModeDraft !== null &&
                state.memoryReadModeDraft !== prevBaseline.mode;
              return {
                memoryReadModeBaseline: {
                  id,
                  mode: res.mode,
                  revision: res.revision,
                  api: capturedApi,
                },
                memoryReadModeDraft: isActuallyDirty ? state.memoryReadModeDraft : res.mode,
                memoryReadModeLoading: false,
                memoryReadModeError: null,
              };
            });
            resolve(true);
          },
          failure: (reason) => {
            activeModeResolve = null;
            activeModeReadTask = null;
            if (
              get().apiClient === capturedApi &&
              nextModeReadToken === token &&
              get().currentConversationId === id
            ) {
              set({
                memoryReadModeLoading: false,
                memoryReadModeError: errorText(reason),
              });
            }
            resolve(false);
          },
        });
        activeModeReadTask = task;
      });
    },
    patchConversationMemoryReadModeDraft: (mode) => {
      set({ memoryReadModeDraft: mode });
    },
    discardConversationMemoryReadMode: () => {
      set((state) => ({
        memoryReadModeDraft: state.memoryReadModeBaseline
          ? state.memoryReadModeBaseline.mode
          : null,
        memoryReadModeError: null,
      }));
    },
    saveConversationMemoryReadMode: async (id) => {
      const baseline = get().memoryReadModeBaseline;
      const draft = get().memoryReadModeDraft;
      const capturedApi = get().apiClient;
      if (!baseline || baseline.id !== id || baseline.api !== capturedApi || !draft) return false;
      if (draft === baseline.mode) return true;
      if (get().memoryReadModeSaving) return false;

      const thisSaveToken = ++nextModeSaveToken;
      set({ memoryReadModeSaving: true, memoryReadModeError: null });

      try {
        const res = await capturedApi.saveConversationMemoryReadMode(id, {
          mode: draft,
          expected_revision: baseline.revision,
        });
        if (
          get().apiClient !== capturedApi ||
          nextModeSaveToken !== thisSaveToken ||
          get().currentConversationId !== id
        ) {
          return false;
        }

        set({
          memoryReadModeBaseline: {
            id,
            mode: res.mode,
            revision: res.revision,
            api: capturedApi,
          },
          memoryReadModeDraft: res.mode,
          memoryReadModeSaving: false,
          memoryReadModeError: null,
        });
        return true;
      } catch (reason: unknown) {
        if (
          get().apiClient === capturedApi &&
          nextModeSaveToken === thisSaveToken &&
          get().currentConversationId === id
        ) {
          set({
            memoryReadModeSaving: false,
            memoryReadModeError: errorText(reason),
          });
        }
        return false;
      } finally {
        if (get().apiClient === capturedApi && nextModeSaveToken === thisSaveToken) {
          set({ memoryReadModeSaving: false });
        }
      }
    },
    refreshConversationMemoryReadMode: (id) => {
      return get().loadConversationMemoryReadMode(id, { force: true });
    },
  };
}
