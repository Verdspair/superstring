import type {
  QqManagedEventsInvalidation,
  QqManagedEventsPage,
} from "../../../shared/contracts/qq-managed-events";
import type { QqManagedEventQueryInput, SuperstringApi } from "../../api";
import { type ReadTask, startRead } from "../../services/read-task";
import { errorText } from "../../state/helpers";
import type { StoreGet, StoreSet } from "../../state/types";

export interface QqManagedEventsState {
  qqManagedEventsPage: QqManagedEventsPage | null;
  qqManagedEventsLoading: boolean;
  qqManagedEventsError: string | null;
  loadQqManagedEvents: (query?: QqManagedEventQueryInput) => Promise<void>;
  setQqManagedEventsActive: (active: boolean) => void;
  clearQqManagedEventsView: () => void;
}

export const qqManagedEventsInitial = {
  qqManagedEventsPage: null as QqManagedEventsPage | null,
  qqManagedEventsLoading: false,
  qqManagedEventsError: null as string | null,
};

export function createQqManagedEventsActions(
  set: StoreSet,
  get: StoreGet,
): Pick<
  QqManagedEventsState,
  "loadQqManagedEvents" | "setQqManagedEventsActive" | "clearQqManagedEventsView"
> {
  let managedEventsTask: ReadTask | null = null;
  let managedEventsReadTask: ReadTask | null = null;
  let managedEventsRequestedActive = false;
  let managedEventsApi: SuperstringApi | null = null;
  let managedEventsOwner = 0;
  let managedEventsStoreLifecycle = 0;
  let managedEventsInvalidation: QqManagedEventsInvalidation | null = null;
  let managedEventsQuery: QqManagedEventQueryInput = {};
  let managedEventsPending = false;
  let managedEventsReadPromise: Promise<void> | null = null;
  let finishManagedEventsRead: (() => void) | null = null;
  let managedEventsVisibilityListener: (() => void) | null = null;
  let managedEventsClearedAt = 0;
  let managedEventsGeneration: string | null = null;
  const clearManagedEventPreviews = () => {
    set((state) => ({
      qqManagedEventsPage:
        state.qqManagedEventsPage?.status === "ok"
          ? {
              ...state.qqManagedEventsPage,
              events: state.qqManagedEventsPage.events.map((row) =>
                row.preview_state === "available"
                  ? { ...row, message_preview: null, preview_state: "unavailable" as const }
                  : row,
              ),
            }
          : state.qqManagedEventsPage,
    }));
  };
  const cancelManagedEventsTasks = () => {
    managedEventsOwner += 1;
    managedEventsTask?.cancel();
    managedEventsReadTask?.cancel();
    managedEventsTask = null;
    managedEventsReadTask = null;
    managedEventsReadPromise = null;
    finishManagedEventsRead?.();
    finishManagedEventsRead = null;
    managedEventsPending = false;
    set({ qqManagedEventsLoading: false });
  };
  const managedEventsCurrent = (owner: number, api: SuperstringApi, lifecycle: number) =>
    owner === managedEventsOwner &&
    managedEventsRequestedActive &&
    !document.hidden &&
    get().apiClient === api &&
    get().qqManagedLifecycleId === lifecycle;
  const connectManagedEvents = () => {
    if (!managedEventsRequestedActive || document.hidden || managedEventsTask) return;
    const owner = managedEventsOwner;
    const api = get().apiClient;
    const lifecycle = get().qqManagedLifecycleId;
    managedEventsTask = startRead(
      (signal) =>
        api.subscribeQqManagedEventChanges((notice) => {
          if (!managedEventsCurrent(owner, api, lifecycle)) return;
          const previous = managedEventsInvalidation;
          if (
            previous &&
            previous.generation === notice.generation &&
            previous.latest_sequence === notice.latest_sequence &&
            previous.revision === notice.revision
          )
            return;
          managedEventsInvalidation = notice;
          if (managedEventsGeneration !== null && managedEventsGeneration !== notice.generation) {
            managedEventsClearedAt = 0;
            set({ qqManagedEventsPage: null });
          } else clearManagedEventPreviews();
          managedEventsPending = true;
          void get().loadQqManagedEvents(managedEventsQuery);
        }, signal),
      {
        success: () => {},
        failure: (cause) => {
          if (managedEventsCurrent(owner, api, lifecycle))
            set({ qqManagedEventsError: errorText(cause) });
        },
        settled: () => {
          if (owner === managedEventsOwner) managedEventsTask = null;
        },
      },
    );
  };

  return {
    setQqManagedEventsActive: (active) => {
      const api = get().apiClient;
      const lifecycle = get().qqManagedLifecycleId;
      const sameOwner =
        managedEventsRequestedActive === active &&
        managedEventsApi === api &&
        managedEventsStoreLifecycle === lifecycle;
      if (sameOwner) {
        if (active && !document.hidden) connectManagedEvents();
        return;
      }
      cancelManagedEventsTasks();
      if (managedEventsVisibilityListener)
        document.removeEventListener("visibilitychange", managedEventsVisibilityListener);
      managedEventsVisibilityListener = null;
      managedEventsRequestedActive = active;
      managedEventsApi = api;
      managedEventsStoreLifecycle = lifecycle;
      managedEventsInvalidation = null;
      if (!active) {
        set({ qqManagedEventsPage: null });
        return;
      }
      managedEventsVisibilityListener = () => {
        cancelManagedEventsTasks();
        set({ qqManagedEventsPage: null });
        if (!document.hidden && managedEventsRequestedActive) {
          connectManagedEvents();
          void get().loadQqManagedEvents(managedEventsQuery);
        }
      };
      document.addEventListener("visibilitychange", managedEventsVisibilityListener);
      connectManagedEvents();
      void get().loadQqManagedEvents(managedEventsQuery);
    },
    clearQqManagedEventsView: () => {
      const page = get().qqManagedEventsPage;
      if (page?.status === "ok") {
        managedEventsGeneration = page.generation;
        managedEventsClearedAt = page.latest_sequence;
        set({ qqManagedEventsPage: { ...page, events: [], next_cursor: null } });
      }
    },
    loadQqManagedEvents: async (query = {}) => {
      if (
        managedEventsApi !== get().apiClient ||
        managedEventsStoreLifecycle !== get().qqManagedLifecycleId
      ) {
        get().setQqManagedEventsActive(managedEventsRequestedActive);
      }
      if (!managedEventsRequestedActive || document.hidden) return;
      managedEventsQuery = { ...query };
      if (managedEventsReadPromise) {
        managedEventsPending = true;
        return managedEventsReadPromise;
      }
      connectManagedEvents();
      const api = get().apiClient;
      const owner = managedEventsOwner;
      const lifecycle = get().qqManagedLifecycleId;
      const readQuery = { ...managedEventsQuery };
      const observed = managedEventsInvalidation;
      managedEventsPending = false;
      set({ qqManagedEventsLoading: true, qqManagedEventsError: null });
      const promise = new Promise<void>((resolve) => {
        finishManagedEventsRead = resolve;
      });
      managedEventsReadPromise = promise;
      managedEventsReadTask = startRead((signal) => api.getQqManagedEventsPage(readQuery, signal), {
        success: (page) => {
          if (!managedEventsCurrent(owner, api, lifecycle)) return;
          if (managedEventsGeneration !== page.generation) managedEventsClearedAt = 0;
          managedEventsGeneration = page.generation;
          if (page.status === "reset_required") {
            managedEventsQuery = { ...managedEventsQuery, cursor: undefined };
            set({ qqManagedEventsPage: null });
            managedEventsPending = true;
            return;
          }
          const latest = managedEventsInvalidation;
          if (
            latest &&
            latest !== observed &&
            (latest.generation !== page.generation || latest.revision > page.revision)
          ) {
            managedEventsPending = true;
            return;
          }
          managedEventsInvalidation = {
            generation: page.generation,
            latest_sequence: page.latest_sequence,
            revision: page.revision,
          };
          set({
            qqManagedEventsPage: {
              ...page,
              events: page.events.filter((row) => row.sequence > managedEventsClearedAt),
            },
            qqManagedEventsError: null,
          });
        },
        failure: (cause) => {
          if (managedEventsCurrent(owner, api, lifecycle))
            set({ qqManagedEventsError: errorText(cause) });
        },
        settled: () => {
          if (owner !== managedEventsOwner) return;
          managedEventsReadTask = null;
          managedEventsReadPromise = null;
          finishManagedEventsRead?.();
          finishManagedEventsRead = null;
          set({ qqManagedEventsLoading: false });
          if (managedEventsPending && managedEventsCurrent(owner, api, lifecycle)) {
            managedEventsPending = false;
            void get().loadQqManagedEvents(managedEventsQuery);
          }
        },
      });
      return promise;
    },
  };
}
