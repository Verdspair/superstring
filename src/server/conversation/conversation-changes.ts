import type { Database } from "bun:sqlite";

/** Scope metadata only; bodies and source accounts never enter change notifications. */
export type ConversationChange = {
  conversationId: string;
  seq: number;
  bindingEpoch: number;
} & ({ kind: "content" } | { kind: "activity"; activity: "span" });
export type ConversationChangeListener = (change: ConversationChange) => void;
export type ConversationDirty = { conversationId: string; kind: ConversationChange["kind"] };
type BatchListener = (changes: readonly ConversationDirty[]) => void;
interface ConversationChangeHub {
  listeners: Set<ConversationChangeListener>;
  batches: Set<BatchListener>;
  pending: Map<string, ConversationDirty>;
  scheduled: boolean;
}
const hubs = new WeakMap<Database, ConversationChangeHub>();
function hubOf(db: Database): ConversationChangeHub {
  let hub = hubs.get(db);
  if (!hub) {
    hub = { listeners: new Set(), batches: new Set(), pending: new Map(), scheduled: false };
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
    for (const listener of hub.batches) listener(pending);
    if (!hub.listeners.size || !pending.length) return;
    const rows = db
      .query(`SELECT c.id,c.next_seq,c.binding_epoch FROM json_each(?) selected
      CROSS JOIN conversations c ON c.id=selected.value`)
      .all(JSON.stringify([...new Set(pending.map((change) => change.conversationId))])) as {
      id: string;
      next_seq: number;
      binding_epoch: number;
    }[];
    const byId = new Map(rows.map((row) => [row.id, row]));
    for (const dirty of pending) {
      const row = byId.get(dirty.conversationId);
      if (!row) continue;
      const base = {
        conversationId: row.id,
        seq: row.next_seq - 1,
        bindingEpoch: row.binding_epoch,
      };
      const change: ConversationChange =
        dirty.kind === "content"
          ? { ...base, kind: "content" }
          : { ...base, kind: "activity", activity: "span" };
      for (const listener of hub.listeners) listener(change);
    }
  });
}
/** Flushed after the producer's synchronous SQLite transaction has settled. */
export function publishConversationChange(db: Database, conversationId: string): void {
  publish(db, conversationId, "content");
}
export function publishConversationActivity(db: Database, conversationId: string): void {
  publish(db, conversationId, "activity");
}
/** Raw identity hints; consumers must resolve live read authority at delivery. */
export function subscribeConversationChangeBatches(
  db: Database,
  listener: BatchListener,
): () => void {
  const hub = hubOf(db);
  hub.batches.add(listener);
  return () => {
    hub.batches.delete(listener);
  };
}
export function subscribeConversationChanges(
  db: Database,
  listener: ConversationChangeListener,
): () => void {
  const hub = hubOf(db);
  hub.listeners.add(listener);
  return () => {
    hub.listeners.delete(listener);
  };
}
