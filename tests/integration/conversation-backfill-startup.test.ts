import { describe, expect, it } from "bun:test";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { createSession } from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";

function fixture(count: number) {
  const h = openBusinessDb();
  const session = createSession(h.orm, "synthetic history", { modelName: "synthetic-model" });
  const turn = h.db.query(
    "INSERT INTO turns(id,session_id,client_request_id,runtime_config_snapshot,created_at) VALUES(?,?,?,'{}',?)",
  );
  const message = h.db.query(
    "INSERT INTO messages(id,session_id,turn_id,sequence_no,role,content,status,client_request_id,created_at) VALUES(?,?,?,?,'user',?,'completed',?,?)",
  );
  h.db.transaction(() => {
    for (let i = 0; i < count; i++) {
      const id = `message-${i}`;
      turn.run(id, session.id, id, "2026-10-08T00:00:00.000Z");
      message.run(id, session.id, id, i + 1, `body ${i}`, id, "2026-10-08T00:00:00.000Z");
    }
  })();
  return h;
}

describe("startup history backfill", () => {
  it("reuses recorded history while recovering offline content and status revisions", () => {
    const h = fixture(1000);
    try {
      const journal = new ConversationEventRepository(h.db);
      journal.backfill();
      const before = h.db.query("SELECT * FROM conversation_events ORDER BY seq").all();
      let queries = 0;
      const query = h.db.query.bind(h.db);
      h.db.query = ((...args: Parameters<typeof query>) => {
        queries++;
        return query(...args);
      }) as typeof h.db.query;
      journal.backfill();
      expect(queries).toBeLessThan(20);
      expect(query("SELECT * FROM conversation_events ORDER BY seq").all()).toEqual(before);
      query("UPDATE messages SET content='offline edit' WHERE id='message-0'").run();
      journal.backfill();
      expect(query("SELECT COUNT(*) AS n FROM conversation_events").get()).toEqual({ n: 1001 });
      query("UPDATE messages SET status='cancelled' WHERE id='message-1'").run();
      journal.backfill();
      expect(query("SELECT COUNT(*) AS n FROM conversation_events").get()).toEqual({ n: 1002 });
      query("UPDATE messages SET content='body 0' WHERE id='message-0'").run();
      journal.backfill();
      expect(query("SELECT COUNT(*) AS n FROM conversation_events").get()).toEqual({ n: 1002 });
      query("DELETE FROM conversation_events WHERE source_id='message-2'").run();
      journal.backfill();
      expect(
        query("SELECT COUNT(*) AS n FROM conversation_events WHERE source_id='message-2'").get(),
      ).toEqual({ n: 1 });
    } finally {
      h.close();
    }
  });
});
