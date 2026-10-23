import type { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { ConversationEventRepository } from "../../src/server/db/conversation-event-repository";
import { DEFAULT_AGENT_ID, ensureDefaults } from "../../src/server/db/repositories";
import { openBusinessDb } from "../../src/server/db/schema-gate";

const at = "2026-10-08T00:00:00.000Z";
const live = "2099-01-01T00:00:00.000Z";

type ObservedCall = { sql: string; rows: number };

/**
 * Counts actually-executed statements and result rows — workload counters, not plan shapes.
 * The backfill proof is identified by its production SQL text (media-ref membership), never
 * by position or by plan keywords.
 */
function observe(db: Database) {
  const query = db.query.bind(db);
  const calls: ObservedCall[] = [];
  const observed = new Proxy(db, {
    get(target, key) {
      if (key !== "query") {
        const member = Reflect.get(target, key, target) as unknown;
        return typeof member === "function"
          ? (member as (...input: unknown[]) => unknown).bind(target)
          : member;
      }
      return (sql: string) => {
        const statement = query(sql);
        return new Proxy(statement, {
          get(current, method) {
            const member = Reflect.get(current, method, current) as unknown;
            if (method === "get" || method === "all") {
              return (...args: unknown[]): unknown => {
                const bindings = args ?? [];
                const callable = member as (...input: unknown[]) => unknown;
                const rows = Reflect.apply(callable, current, bindings);
                calls.push({ sql, rows: Array.isArray(rows) ? rows.length : 1 });
                return rows;
              };
            }
            return typeof member === "function"
              ? (member as (...input: unknown[]) => unknown).bind(current)
              : member;
          },
        });
      };
    },
  });
  return { db: observed, calls };
}

const proofOf = (call: ObservedCall): boolean =>
  call.sql.includes("json_each(ce.sources)") && /'onebot:'\s*\|\|/.test(call.sql);

function fixture(bindings: Array<{ peer: string; events: number; segments: number }>) {
  const h = openBusinessDb();
  ensureDefaults(h.orm, "synthetic-model");
  h.db
    .query("INSERT INTO qq_schemes(id,name,created_at,updated_at) VALUES('scope','scope',?,?)")
    .run(at, at);
  const insertBinding = h.db.query(
    "INSERT INTO qq_bindings(id,account_id,conversation_kind,peer_id,agent_id,scheme_id,created_at,updated_at) VALUES(?,?,'group',?,?,'scope',?,?)",
  );
  const insertEvent = h.db.query(
    "INSERT INTO qq_events(event_key,account_id,conversation_kind,peer_id,agent_id,message_id,occurred_at_seconds,speaker_kind,speaker_id,recorded_at) VALUES(?,?,'group',?,?,?,?,'member','10001',?)",
  );
  const insertMedia = h.db.query(
    "INSERT INTO qq_media_notes(id,event_key,segment_index,segment_kind,source_ref,note,note_model,attempts,expires_at,recorded_at,updated_at) VALUES(?,?,?,'image','synthetic-ref',NULL,NULL,0,?,?,?)",
  );
  h.db.transaction(() => {
    let message = 0;
    for (const binding of bindings) {
      insertBinding.run(`binding-${binding.peer}`, "90001", binding.peer, DEFAULT_AGENT_ID, at, at);
      for (let event = 0; event < binding.events; event++) {
        const key = `["qq","90001","group","${binding.peer}",${message}]`;
        insertEvent.run(
          key,
          "90001",
          binding.peer,
          DEFAULT_AGENT_ID,
          `m-${message}`,
          100 + message,
          at,
        );
        for (let segment = 0; segment < binding.segments; segment++)
          insertMedia.run(`${key}#${segment}`, key, segment, live, at, at);
        message++;
      }
    }
  })();
  return h;
}

function sourcesOf(
  db: Database,
  conversationId: string,
  eventKey: string,
): { kind: string; id: string }[] | null {
  const row = db
    .query("SELECT sources FROM conversation_events WHERE conversation_id=? AND event_key=?")
    .get(conversationId, eventKey) as { sources: string } | null;
  return row ? (JSON.parse(row.sources) as { kind: string; id: string }[]) : null;
}

/** Full journal state per binding, for equivalence checks. */
function journalOf(db: Database, conversationId: string) {
  return db
    .query(
      "SELECT event_key,seq,sources FROM conversation_events WHERE conversation_id=? ORDER BY seq",
    )
    .all(conversationId);
}

describe("backfill media-parent proof workload", () => {
  it("is equivalent to the recorded journal across several bindings, including an empty one", () => {
    const h = fixture([
      { peer: "30003", events: 4, segments: 3 },
      { peer: "30004", events: 0, segments: 0 },
      { peer: "30005", events: 2, segments: 1 },
    ]);
    try {
      const journal = new ConversationEventRepository(h.db);
      journal.backfill();
      const conversations = h.db
        .query(
          "SELECT id,source_id FROM conversations WHERE channel='onebot11' AND closed_at IS NULL ORDER BY source_id",
        )
        .all() as { id: string; source_id: string }[];
      expect(conversations).toHaveLength(3);
      const before = new Map(conversations.map((c) => [c.id, journalOf(h.db, c.id)]));
      const observed = observe(h.db);
      new ConversationEventRepository(observed.db).backfill();
      for (const c of conversations) expect(journalOf(h.db, c.id)).toEqual(before.get(c.id)!);
    } finally {
      h.close();
    }
  });

  it("repairs exactly the parent whose media reference was lost and recreates an absent parent", () => {
    const h = fixture([{ peer: "30003", events: 3, segments: 3 }]);
    try {
      const journal = new ConversationEventRepository(h.db);
      const conversation = journal.ensureOneBot("binding-30003")!;
      journal.backfill();
      const target = 'onebot:["qq","90001","group","30003",1]';
      const original = sourcesOf(h.db, conversation.id, target);
      expect(original).not.toBeNull();
      const removed = original!.filter((ref) => ref.kind === "qq_media").at(-1)!;
      h.db
        .query("UPDATE conversation_events SET sources=? WHERE conversation_id=? AND event_key=?")
        .run(
          JSON.stringify(
            original!.filter((ref) => !(ref.kind === removed.kind && ref.id === removed.id)),
          ),
          conversation.id,
          target,
        );
      const absent = 'onebot:["qq","90001","group","30003",0]';
      h.db
        .query("DELETE FROM conversation_events WHERE conversation_id=? AND event_key=?")
        .run(conversation.id, absent);
      const untouched = sourcesOf(h.db, conversation.id, 'onebot:["qq","90001","group","30003",2]');
      new ConversationEventRepository(h.db).backfill();
      expect(sourcesOf(h.db, conversation.id, target)).toEqual(original);
      expect(sourcesOf(h.db, conversation.id, absent)).not.toBeNull();
      expect(
        sourcesOf(h.db, conversation.id, absent)!.filter((ref) => ref.kind === "qq_media"),
      ).toHaveLength(3);
      expect(sourcesOf(h.db, conversation.id, 'onebot:["qq","90001","group","30003",2]')).toEqual(
        untouched,
      );
    } finally {
      h.close();
    }
  });

  it("executes the proof once per restart and never falls back per binding", () => {
    const h = fixture([
      { peer: "30003", events: 12, segments: 2 },
      { peer: "30004", events: 5, segments: 1 },
      { peer: "30005", events: 0, segments: 0 },
    ]);
    try {
      const journal = new ConversationEventRepository(h.db);
      journal.backfill();
      const observed = observe(h.db);
      new ConversationEventRepository(observed.db).backfill();
      const proofs = observed.calls.filter(proofOf);
      // One membership pass per restart across ALL bindings — including the empty one.
      expect(proofs).toHaveLength(1);
      // With the shared result provided, no per-binding single-scope proof may run: the
      // per-scope helper shape would re-read qq_events scope ranges once per binding.
      const perScope = observed.calls.filter(
        (call) => call.sql.includes("json_each(ce.sources)") && call.sql.includes("e.account_id=?"),
      );
      expect(perScope).toHaveLength(0);
      expect(proofs[0]!.rows).toBe(0);
    } finally {
      h.close();
    }
  });
});
