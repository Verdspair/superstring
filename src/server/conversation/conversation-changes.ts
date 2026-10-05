import type { Database } from "bun:sqlite";

/** Scope metadata for one changed conversation. Never carries bodies or accounts. */
export interface ConversationChange {
  conversationId: string;
  seq: number;
  bindingEpoch: number;
}

export type ConversationChangeListener = (change: ConversationChange) => void;

interface ConversationChangeHub {
  listeners: Set<ConversationChangeListener>;
  /** Conversation ids changed since the last flush; a burst coalesces per conversation. */
  pending: Set<string>;
  scheduled: boolean;
}

const hubs = new WeakMap<Database, ConversationChangeHub>();

function hubOf(db: Database): ConversationChangeHub {
  let hub = hubs.get(db);
  if (!hub) {
    hub = { listeners: new Set(), pending: new Set(), scheduled: false };
    hubs.set(db, hub);
  }
  return hub;
}

/**
 * Record one changed conversation. All repository instances sharing a database
 * share one hub, so a subscription survives any instance boundary — there is no
 * second cache or process protocol, only ids. Publication may happen inside a
 * transaction; the flush is deferred to a microtask, and every bun:sqlite
 * transaction here is synchronous, so listeners observe only committed state.
 */
export function publishConversationChange(db: Database, conversationId: string): void {
  const hub = hubOf(db);
  hub.pending.add(conversationId);
  if (hub.scheduled) return;
  hub.scheduled = true;
  queueMicrotask(() => {
    hub.scheduled = false;
    const pending = [...hub.pending];
    hub.pending.clear();
    if (!hub.listeners.size) return;
    for (const id of pending) {
      const row = db
        .query("SELECT id,next_seq,binding_epoch FROM conversations WHERE id=?")
        .get(id) as { id: string; next_seq: number; binding_epoch: number } | null;
      if (!row) continue;
      const change: ConversationChange = {
        conversationId: row.id,
        seq: row.next_seq - 1,
        bindingEpoch: row.binding_epoch,
      };
      for (const listener of hub.listeners) listener(change);
    }
  });
}

/** Register one listener on the database hub; the return value unsubscribes it. */
export function subscribeConversationChanges(
  db: Database,
  listener: ConversationChangeListener,
): () => void {
  const hub = hubOf(db);
  hub.listeners.add(listener);
  return () => hub.listeners.delete(listener);
}
