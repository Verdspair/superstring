import type { Database } from "bun:sqlite";

export type QqBindingLiveWork = "task" | "run" | "wake" | "outbound";

/** The caller supplies every stored conversation epoch and owns the write transaction. */
export function readQqBindingLiveWork(
  db: Database,
  conversationIds: readonly string[],
): QqBindingLiveWork | null {
  if (conversationIds.length === 0) return null;
  const inConversations = conversationIds.map(() => "?").join(",");
  const count = (sql: string): number => {
    const row = db.query(sql).get(...conversationIds) as { n: number } | null;
    return row?.n ?? 0;
  };
  if (
    count(`SELECT COUNT(*) AS n FROM qq_conversation_tasks
           WHERE status='running' AND conversation_id IN (${inConversations})`) > 0
  ) {
    return "task";
  }
  // An end stamp, rather than a terminal-looking status, settles a run.
  if (
    count(`SELECT COUNT(*) AS n FROM agent_runs
           WHERE conversation_id IN (${inConversations}) AND ended_at IS NULL`) > 0
  ) {
    return "run";
  }
  if (
    count(`SELECT COUNT(*) AS n FROM wake_signals
           WHERE status='leased' AND conversation_id IN (${inConversations})`) > 0
  ) {
    return "wake";
  }
  // Sending and unknown parts remain unsafe even when their intent looks settled.
  if (
    count(`SELECT COUNT(*) AS n FROM outbound_intents i
           WHERE i.conversation_id IN (${inConversations})
             AND (i.status='unknown' OR EXISTS(
               SELECT 1 FROM outbound_parts p
               WHERE p.intent_id=i.id AND p.status IN ('sending','unknown')
             ))`) > 0
  ) {
    return "outbound";
  }
  return null;
}
