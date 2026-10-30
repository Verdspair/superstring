import type { Database } from "bun:sqlite";
import { publishConversationChange } from "../conversation/conversation-changes";

export type ConversationRow = {
  id: string;
  channel: "web" | "onebot11";
  topology: "direct" | "shared";
  source_id: string;
  agent_id: string;
  user_id: string;
  binding_epoch: number;
  source_watermark: number;
  next_seq: number;
  consumed_seq: number;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  memory_read_mode: "current_conversation" | "agent_shared";
  memory_config_revision: number;
};

/** Identity writes share the source producer's transaction; no display or history reads. */
export function ensureConversationIdentity(
  db: Database,
  input: {
    channel: ConversationRow["channel"];
    topology: ConversationRow["topology"];
    sourceId: string;
    agentId: string;
    userId: string;
    at: string;
  },
): { row: ConversationRow; created: boolean } {
  return db.transaction(() => {
    let row = db
      .query("SELECT * FROM conversations WHERE channel=? AND source_id=? AND closed_at IS NULL")
      .get(input.channel, input.sourceId) as ConversationRow | null;
    if (row && row.agent_id !== input.agentId) {
      db.query("UPDATE conversations SET closed_at=? WHERE id=?").run(
        new Date().toISOString(),
        row.id,
      );
      publishConversationChange(db, row.id);
      row = null;
    }
    if (row) return { row, created: false };
    const previous = db
      .query("SELECT MAX(binding_epoch) AS n FROM conversations WHERE channel=? AND source_id=?")
      .get(input.channel, input.sourceId) as { n: number | null };
    const id = crypto.randomUUID();
    const at = previous.n ? new Date().toISOString() : input.at;
    const watermark = previous.n
      ? (db.query("SELECT COALESCE(MAX(rowid),0) AS n FROM qq_events").get() as { n: number }).n
      : 0;
    db.query(`INSERT INTO conversations(id,channel,topology,source_id,agent_id,user_id,binding_epoch,created_at,updated_at,source_watermark)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
      id,
      input.channel,
      input.topology,
      input.sourceId,
      input.agentId,
      input.userId,
      (previous.n ?? 0) + 1,
      at,
      at,
      watermark,
    );
    row = db.query("SELECT * FROM conversations WHERE id=?").get(id) as ConversationRow;
    publishConversationChange(db, id);
    return { row, created: true };
  })();
}

export function ensureWebConversationIdentity(
  db: Database,
  sessionId: string,
  userId?: string,
): ConversationRow | null {
  return db.transaction(() => {
    const source = db
      .query("SELECT id,user_id,agent_id,created_at,updated_at FROM sessions WHERE id=?")
      .get(sessionId) as {
      id: string;
      user_id: string;
      agent_id: string;
      created_at: string;
      updated_at: string;
    } | null;
    if (!source || (userId !== undefined && source.user_id !== userId)) return null;
    const { row } = ensureConversationIdentity(db, {
      channel: "web",
      topology: "direct",
      sourceId: source.id,
      agentId: source.agent_id,
      userId: source.user_id,
      at: source.created_at,
    });
    if (source.updated_at > row.updated_at) {
      db.query("UPDATE conversations SET updated_at=? WHERE id=?").run(source.updated_at, row.id);
      publishConversationChange(db, row.id);
      return { ...row, updated_at: source.updated_at };
    }
    return row;
  })();
}

/** Activity comes from its source write; no source rediscovery or display projection. */
export function touchWebConversation(db: Database, sessionId: string, at: string): void {
  const rows = db
    .query(`UPDATE conversations SET updated_at=MAX(updated_at,?)
    WHERE channel='web' AND source_id=? AND closed_at IS NULL RETURNING id`)
    .all(at, sessionId) as { id: string }[];
  for (const row of rows) publishConversationChange(db, row.id);
}

export function closeConversationSource(
  db: Database,
  channel: ConversationRow["channel"],
  sourceId: string,
  at: string,
): void {
  const rows = db
    .query(
      "UPDATE conversations SET closed_at=? WHERE channel=? AND source_id=? AND closed_at IS NULL RETURNING id",
    )
    .all(at, channel, sourceId) as { id: string }[];
  for (const row of rows) publishConversationChange(db, row.id);
}
