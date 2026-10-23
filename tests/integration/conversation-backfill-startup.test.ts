import { describe, expect, it } from "bun:test";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { createSession, DEFAULT_AGENT_ID, ensureDefaults } from "../../src/server/db/repositories";
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

  it("startup backfill does not emit media_revision rows for initial undescribed media", () => {
    const h = openBusinessDb();
    try {
      ensureDefaults(h.orm, "synthetic-model");
      h.db
        .query(
          "INSERT OR IGNORE INTO qq_schemes(id,name,created_at,updated_at) VALUES('scheme','scheme',?,?)",
        )
        .run("2026-10-08T00:00:00.000Z", "2026-10-08T00:00:00.000Z");
      h.db
        .query(
          "INSERT INTO qq_bindings(id,account_id,conversation_kind,peer_id,agent_id,scheme_id,created_at,updated_at) VALUES('binding','90001','group','30003',?,'scheme',?,?)",
        )
        .run(DEFAULT_AGENT_ID, "2026-10-08T00:00:00.000Z", "2026-10-08T00:00:00.000Z");
      const journal = new ConversationEventRepository(h.db);
      const at = "2026-10-08T00:00:00.000Z";
      // Media-only member message: event + initial undescribed media row (attempts=0,
      // note=NULL), exactly the state intake leaves before any reading happens.
      h.db
        .query(
          "INSERT INTO qq_events(event_key,account_id,conversation_kind,peer_id,agent_id,message_id,occurred_at_seconds,speaker_kind,speaker_id,recorded_at) VALUES('evt-m1','90001','group','30003',?,'msg-1',100,'member','10001',?)",
        )
        .run(DEFAULT_AGENT_ID, at);
      h.db
        .query(
          "INSERT INTO qq_media_notes(id,event_key,segment_index,segment_kind,source_ref,note,note_model,attempts,expires_at,recorded_at,updated_at) VALUES('note-1','evt-m1',0,'image','ref-1',NULL,NULL,0,'2099-01-01T00:00:00.000Z',?,?)",
        )
        .run(at, at);
      const conversation = journal.ensureOneBot("binding")!;
      journal.backfill();
      // The media-only message keeps its raw inbound row with precise refs; the
      // initial undescribed state emits no media_revision and no extra SSE change.
      const rows = h.db
        .query(
          "SELECT event_key,kind FROM conversation_events WHERE conversation_id=? ORDER BY seq",
        )
        .all(conversation.id) as { event_key: string; kind: string }[];
      expect(rows.map((r) => r.event_key)).toEqual(["onebot:evt-m1"]);
      expect(rows[0]!.kind).toBe("inbound");
      expect(
        JSON.parse(
          (
            h.db
              .query("SELECT sources FROM conversation_events WHERE conversation_id=? AND seq=1")
              .get(conversation.id) as { sources: string }
          ).sources,
        ),
      ).toEqual([
        { kind: "qq_event", id: "evt-m1", revision: at },
        { kind: "qq_media", id: "note-1", revision: "0", expiresAt: "2099-01-01T00:00:00.000Z" },
      ]);
      // Backfill idempotence: rerunning startup over the same stored state changes nothing.
      journal.backfill();
      expect(
        (
          h.db
            .query("SELECT COUNT(*) AS n FROM conversation_events WHERE conversation_id=?")
            .get(conversation.id) as { n: number }
        ).n,
      ).toBe(1);
      // A legacy 0-attempt row WITH a real description still revises (eligibility is
      // judged by note content, not by a blanket rev-0 filter).
      h.db
        .query(
          "INSERT INTO qq_events(event_key,account_id,conversation_kind,peer_id,agent_id,message_id,occurred_at_seconds,speaker_kind,speaker_id,recorded_at) VALUES('evt-m2','90001','group','30003',?,'msg-2',110,'member','10001',?)",
        )
        .run(DEFAULT_AGENT_ID, at);
      h.db
        .query(
          "INSERT INTO qq_media_notes(id,event_key,segment_index,segment_kind,source_ref,note,note_model,attempts,expires_at,recorded_at,updated_at) VALUES('note-2','evt-m2',0,'image','ref-2','看清了','fixture',0,'2099-01-01T00:00:00.000Z',?,?)",
        )
        .run(at, at);
      const revised = journal.ingestMedia("note-2", "binding")!;
      expect(revised.kind).toBe("media_revision");
      expect(revised.eventKey).toBe("media:note-2:0");
      // A meaningful failure (attempts>0, no note) still revises.
      h.db
        .query(
          "INSERT INTO qq_media_notes(id,event_key,segment_index,segment_kind,source_ref,note,note_model,attempts,expires_at,recorded_at,updated_at) VALUES('note-3','evt-m1',1,'image','ref-3',NULL,NULL,1,'2099-01-01T00:00:00.000Z',?,?)",
        )
        .run(at, at);
      const failed = journal.ingestMedia("note-3", "binding")!;
      expect(failed.kind).toBe("media_revision");
      expect(failed.eventKey).toBe("media:note-3:1");
      // A stale superseded revision row stays hidden only while it is not current:
      // note-1 stays at attempts=0 with no note, so its revision row would not show even
      // if one existed from an older build; once attempts advance the same note id
      // re-admits its current revision row to display (no permanent suppression).
    } finally {
      h.close();
    }
  });
  it("loads only missing OneBot candidates and repairs parent media references on restart", () => {
    const h = openBusinessDb();
    try {
      ensureDefaults(h.orm, "synthetic-model");
      const at = "2026-10-08T00:00:00.000Z";
      h.db
        .query("INSERT INTO qq_schemes(id,name,created_at,updated_at) VALUES('scope','scope',?,?)")
        .run(at, at);
      h.db
        .query(
          "INSERT INTO qq_bindings(id,account_id,conversation_kind,peer_id,agent_id,scheme_id,created_at,updated_at) VALUES('binding','90001','group','30003',?,'scope',?,?)",
        )
        .run(DEFAULT_AGENT_ID, at, at);
      const insertEvent = h.db.query(
        "INSERT INTO qq_events(event_key,account_id,conversation_kind,peer_id,agent_id,message_id,occurred_at_seconds,speaker_kind,speaker_id,recorded_at) VALUES(?,'90001','group','30003',?,?,?,'member','10001',?)",
      );
      const insertMedia = h.db.query(
        "INSERT INTO qq_media_notes(id,event_key,segment_index,segment_kind,source_ref,note,note_model,attempts,expires_at,recorded_at,updated_at) VALUES(?,?,0,'image','synthetic-ref',NULL,NULL,?,'2099-01-01T00:00:00.000Z',?,?)",
      );
      h.db.transaction(() => {
        for (let i = 0; i < 1000; i++) {
          insertEvent.run(`event-${i}`, DEFAULT_AGENT_ID, `message-${i}`, 100 + i, at);
          insertMedia.run(`media-${i}`, `event-${i}`, i % 2, at, at);
        }
      })();
      const journal = new ConversationEventRepository(h.db);
      const conversation = journal.ensureOneBot("binding")!;
      journal.backfill();
      const query = h.db.query.bind(h.db);
      const before = query(
        "SELECT * FROM conversation_events WHERE conversation_id=? ORDER BY seq",
      ).all(conversation.id);
      const boundary = query("SELECT next_seq,consumed_seq FROM conversations WHERE id=?").get(
        conversation.id,
      );
      let queries = 0,
        eventCandidates = 0,
        mediaCandidates = 0;
      h.db.query = ((...args: Parameters<typeof query>) => {
        queries++;
        const statement = query(...args);
        const sql = String(args[0]);
        const eventCandidate =
          sql.includes("SELECT e.event_key AS id") && sql.includes("FROM qq_events e");
        const mediaCandidate = sql.includes(
          "SELECT n.id,n.event_key,n.attempts,n.updated_at AS recorded_at",
        );
        return new Proxy(statement, {
          get(target, property) {
            if (property === "all")
              return (...values: unknown[]) => {
                const rows = Reflect.apply(target.all, target, values);
                if (eventCandidate) eventCandidates += rows.length;
                if (mediaCandidate) mediaCandidates += rows.length;
                return rows;
              };
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      }) as typeof h.db.query;
      journal.backfill();
      const repeatedQueries = queries;
      expect(eventCandidates).toBe(0);
      expect(mediaCandidates).toBe(0);
      expect(repeatedQueries).toBeLessThan(30);
      expect(
        query("SELECT * FROM conversation_events WHERE conversation_id=? ORDER BY seq").all(
          conversation.id,
        ),
      ).toEqual(before);
      expect(
        query("SELECT next_seq,consumed_seq FROM conversations WHERE id=?").get(conversation.id),
      ).toEqual(boundary);

      const parent = query(
        "SELECT sources FROM conversation_events WHERE conversation_id=? AND event_key='onebot:event-1'",
      ).get(conversation.id) as { sources: string };
      const refs = JSON.parse(parent.sources) as { kind: string; id: string }[];
      query(
        "UPDATE conversation_events SET sources=? WHERE conversation_id=? AND event_key='onebot:event-1'",
      ).run(JSON.stringify(refs.filter((ref) => ref.kind !== "qq_media")), conversation.id);
      queries = 0;
      eventCandidates = 0;
      mediaCandidates = 0;
      // New repository instance models restart; there is no in-memory completion marker.
      new ConversationEventRepository(h.db).backfill();
      expect(eventCandidates).toBe(1);
      expect(mediaCandidates).toBe(1);
      expect(
        query(
          "SELECT sources FROM conversation_events WHERE conversation_id=? AND event_key='onebot:event-1'",
        ).get(conversation.id),
      ).toEqual(parent);
      expect(
        query("SELECT next_seq,consumed_seq FROM conversations WHERE id=?").get(conversation.id),
      ).toEqual(boundary);
      expect(
        query("SELECT COUNT(*) AS n FROM conversation_events WHERE conversation_id=?").get(
          conversation.id,
        ),
      ).toEqual({ n: 1500 });
      queries = 0;
      eventCandidates = 0;
      mediaCandidates = 0;
      new ConversationEventRepository(h.db).backfill();
      expect(eventCandidates).toBe(0);
      expect(mediaCandidates).toBe(0);
      expect(queries).toBe(repeatedQueries);
    } finally {
      h.close();
    }
  });
});
