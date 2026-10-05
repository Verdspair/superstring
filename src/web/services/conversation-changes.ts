import type { ConversationChangeEvent, SuperstringApi } from "../api";
import { useSuperstringStore } from "../store";

type ChangeListener = (event: ConversationChangeEvent) => void;

const listeners = new Set<ChangeListener>();

export function addConversationChangeListener(listener: ChangeListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function notifyConversationChange(event: ConversationChangeEvent): void {
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch {
      // Listener errors must not crash the notification pipeline
    }
  }
}

interface ActiveSubscription {
  abort: () => void;
}

let activeSubscription: ActiveSubscription | null = null;

export function startConversationChanges(apiClient: SuperstringApi): () => void {
  if (activeSubscription) {
    return () => {};
  }

  let closed = false;
  let hasInitialReady = false;
  let controller = new AbortController();
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  // Stream ended without a live connection (e.g. dropped while hidden): reconnect on next visibility.
  let needsConnect = false;
  // Conversation ids changed while hidden; reconciled directionally once back in the foreground.
  const dirtyIds = new Set<string>();

  const clearReconnect = () => {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const flushDirty = () => {
    if (dirtyIds.size === 0) return;
    const ids = [...dirtyIds];
    dirtyIds.clear();
    for (const id of ids) {
      void useSuperstringStore.getState().refreshConversationSummary(id);
    }
  };

  const scheduleReconnect = () => {
    if (closed) return;
    if (document.visibilityState === "hidden") {
      needsConnect = true;
      return;
    }
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (closed) return;
      if (document.visibilityState === "hidden") {
        needsConnect = true;
        return;
      }
      controller = new AbortController();
      void connect();
    }, 2500);
  };

  const connect = async () => {
    if (closed) return;
    clearReconnect();
    needsConnect = false;

    try {
      await apiClient.subscribeConversationChanges((event) => {
        if (closed) return;

        if (event.event === "ready") {
          if (hasInitialReady) {
            // Reconnect: one bounded first-page refresh; bootstrap already loaded the directory.
            void useSuperstringStore.getState().loadConversations("refresh");
          } else {
            hasInitialReady = true;
          }
          notifyConversationChange(event);
        } else if (event.event === "conversation_changed") {
          if (document.visibilityState === "hidden") {
            // Hidden: no data reads; reconcile directionally once back in the foreground.
            dirtyIds.add(event.conversationId);
          } else {
            // Directional summary update for directory; does not do full list discover
            void useSuperstringStore.getState().refreshConversationSummary(event.conversationId);
          }
          notifyConversationChange(event);
        }
      }, controller.signal);
    } catch {
      // Normal close or network drop
    }

    scheduleReconnect();
  };

  const onVisibilityChange = () => {
    if (closed) return;
    if (document.visibilityState !== "hidden") {
      flushDirty();
      if (needsConnect && reconnectTimer === null) {
        controller = new AbortController();
        void connect();
      }
    }
  };

  document.addEventListener("visibilitychange", onVisibilityChange);
  void connect();

  const cleanup = () => {
    closed = true;
    clearReconnect();
    document.removeEventListener("visibilitychange", onVisibilityChange);
    controller.abort();
    activeSubscription = null;
  };

  activeSubscription = { abort: cleanup };
  return cleanup;
}

// For unit testing / simulation
export function resetConversationChangesForTests(): void {
  if (activeSubscription) {
    activeSubscription.abort();
    activeSubscription = null;
  }
  listeners.clear();
}
