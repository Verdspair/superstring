import type { Database } from "bun:sqlite";

/** Scope metadata for one changed conversation. Never carries bodies or accounts. */
export type ConversationChange = {
  conversationId: string;
  seq: number;
  bindingEpoch: number;
} & ({ kind: "content" } | { kind: "activity"; activity: "span" });

export type ConversationChangeListener = (change: ConversationChange) => void;

interface PendingChange {
  conversationId: string;
  kind: ConversationChange["kind"];
}

interface ConversationChangeHub {
  listeners: Set<ConversationChangeListener>;
  /**
   * Conversation ids changed since the last flush, keyed by id+kind so a burst
   * keeps at most one content and one activity entry per conversation.
   */
  pending: Map<string, PendingChange>;
  scheduled: boolean;
}

const hubs = new WeakMap<Database, ConversationChangeHub>();

function hubOf(db: Database): ConversationChangeHub {
  let hub = hubs.get(db);
  if (!hub) {
    hub = { listeners: new Set(), pending: new Map(), scheduled: false };
    hubs.set(db, hub);
  }
  return hub;
}

function publish(db: Database, conversationId: string, kind: ConversationChange["kind"]): void {
  const hub = hubOf(db);
  hub.pending.set(`${conversationId}\u0000${kind}`, { conversationId, kind });
  if (hub.scheduled) return;
  hub.scheduled = true;
  queueMicrotask(() => {
    hub.scheduled = false;
    const pending = [...hub.pending.values()];
    hub.pending.clear();
    if (!hub.listeners.size) return;
    for (const { conversationId: id, kind: pendingKind } of pending) {
      const row = db
        .query("SELECT id,next_seq,binding_epoch FROM conversations WHERE id=?")
        .get(id) as { id: string; next_seq: number; binding_epoch: number } | null;
      if (!row) continue;
      const base = {
        conversationId: row.id,
        seq: row.next_seq - 1,
        bindingEpoch: row.binding_epoch,
      };
      const change: ConversationChange =
        pendingKind === "content"
          ? { ...base, kind: "content" }
          : { ...base, kind: "activity", activity: "span" };
      for (const listener of hub.listeners) listener(change);
    }
  });
}

/**
 * Record one content change (journal row, same-seq body/media invalidation, identity or
 * display name). Publication may happen inside a transaction; the flush is deferred to a
 * microtask, and every bun:sqlite transaction here is synchronous, so listeners observe
 * only committed state.
 */
export function publishConversationChange(db: Database, conversationId: string): void {
  publish(db, conversationId, "content");
}

/**
 * Record one execution-only activity change (span start/finish). It shares the same hub
 * and coalescing boundary with content, so one burst keeps both entries.
 */
export function publishConversationActivity(db: Database, conversationId: string): void {
  publish(db, conversationId, "activity");
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
