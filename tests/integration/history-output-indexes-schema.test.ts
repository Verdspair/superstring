// 0057 history output identity indexes: index-only schema step (56 -> 57).
//
// Approved shape: exactly two non-unique partial indexes, no table or data change.
// On synthetic fixtures this file pins: additive-only migration (the historical byte-56
// DDL of both touched tables preserved verbatim), exact schema-gate acceptance (missing /
// extra / differing DDL rejected), and real EXPLAIN selection for the producer-contract
// lookups plus the negative shapes. Index-availability proof only: no runtime
// read-helper behavior is asserted here.
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  BUSINESS_MIGRATION_FILES,
  BUSINESS_SCHEMA_VERSION,
  ensureBusinessSchema,
  openBusinessDb,
} from "../../src/server/db/schema-gate";

const versionsDir = path.join(import.meta.dir, "../../migrations/versions");
const migrationSql = BUSINESS_MIGRATION_FILES.map((name) =>
  readFileSync(path.join(versionsDir, name), "utf8"),
);
const V57_SQL = migrationSql[migrationSql.length - 1];
const V56_CHAIN = migrationSql.slice(0, -1);

const LEGACY_INDEX = "ix_outbound_legacy_send_conversation";
const SPEECH_INDEX = "ix_conversation_send_speech_source";
/** The approved 0057 statements, split on ';' and trimmed. */
const EXPECTED_0057_STATEMENTS = [
  "CREATE INDEX ix_outbound_legacy_send_conversation ON outbound_intents(legacy_send_id, conversation_id) WHERE legacy_send_id IS NOT NULL",
  "CREATE INDEX ix_conversation_send_speech_source ON conversation_events(conversation_id, json_extract(sources, '$[1].id')) WHERE source_kind = 'qq_send' AND json_extract(sources, '$[1].kind') = 'qq_speech'",
];

const ddl = (db: Database) =>
  db
    .query(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*' ORDER BY type, name",
    )
    .all() as Array<{ type: string; name: string; tbl_name: string; sql: string | null }>;
const statements = (sqlText: string) =>
  sqlText
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);
const eqp = (db: Database, query: string) =>
  db
    .query(`EXPLAIN QUERY PLAN ${query}`)
    .all()
    .map((row) => (row as { detail: string }).detail);

const NOW = "2026-01-01T00:00:00Z";
const ROW_TABLES = [
  "conversations",
  "conversation_events",
  "outbound_intents",
  "outbound_parts",
  "wake_signals",
] as const;
const allRows = (db: Database) =>
  ROW_TABLES.map((table) => ({
    table,
    rows: db.query(`SELECT * FROM ${table}`).all(),
  }));
const touchedTableDdl = (db: Database) =>
  db
    .query(
      "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name IN ('outbound_intents', 'conversation_events') ORDER BY name",
    )
    .all();

/** Synthetic history-output rows: seq/watermark/next_seq/consumed_seq, send+speech source
 * slots, legacy send associations and every expiry field the step must not disturb. */
function seedHistoryOutputRows(db: Database) {
  db.exec(`
    INSERT INTO users (id, name, created_at) VALUES ('u1', 'synthetic', '${NOW}');
    INSERT INTO agents (id, name, system_prompt, description, additional_instructions, p5_config,
      model_name, memory_consolidation_prompt, memory_consolidation_additional_instructions,
      memory_retrieval_prompt, created_at, updated_at)
      VALUES ('a1', 'synthetic', '', '', '', '{}', '', '', '', '', '${NOW}', '${NOW}');
    INSERT INTO conversations (id, channel, topology, source_id, agent_id, user_id, binding_epoch,
      source_watermark, next_seq, consumed_seq, created_at, updated_at)
      VALUES ('c1', 'onebot11', 'shared', 's1', 'a1', 'u1', 1, 3, 4, 1, '${NOW}', '${NOW}'),
             ('c2', 'onebot11', 'shared', 's2', 'a1', 'u1', 1, 1, 2, 0, '${NOW}', '${NOW}');
    INSERT INTO agent_runs (run_id, spec_id, spec_version, owner_kind, owner_id, status, started_at)
      VALUES ('r1', 'sp', '1', 'conversation', 'c1', 'completed', '${NOW}');
    INSERT INTO conversation_events (conversation_id, seq, event_key, kind, source_kind, source_id,
      source_revision, source_expires_at, sources, addressing, occurred_at, recorded_at, run_id, output_id)
      VALUES
        ('c1', 1, 'send:send-1', 'outbound', 'qq_send', 'send-1', 'r1', NULL,
         '[{"kind":"qq_send","id":"send-1"},{"kind":"qq_speech","id":"speech-1"}]', '{}',
         '2026-01-01T00:01:00Z', '2026-01-01T00:01:00Z', 'r1', 'i1'),
        ('c1', 2, 'obs:1', 'inbound', 'qq_message', 'm1', 'r1', '2026-01-02T00:00:00Z',
         '[{"kind":"qq_message","id":"m1"}]', '{}',
         '2026-01-01T00:02:00Z', '2026-01-01T00:02:00Z', NULL, NULL),
        ('c1', 3, 'send:send-3', 'outbound', 'qq_send', 'send-3', 'r1', NULL,
         '[{"kind":"qq_send","id":"send-3"},{"kind":"qq_speech","id":"speech-9"}]', '{}',
         '2026-01-01T00:03:00Z', '2026-01-01T00:03:00Z', 'r1', NULL),
        ('c2', 1, 'send:send-2', 'outbound', 'qq_send', 'send-2', 'r1', NULL,
         '[{"kind":"qq_send","id":"send-2"},{"kind":"qq_speech","id":"speech-2"}]', '{}',
         '2026-01-01T00:04:00Z', '2026-01-01T00:04:00Z', NULL, NULL);
    INSERT INTO outbound_intents (id, run_id, conversation_id, output_ordinal, target, speech_kind,
      source_through_seq, deliver_by, status, created_at, expires_at, legacy_send_id, stale_reason)
      VALUES
        ('i1', 'r1', 'c1', 0, '{}', 'direct_reply', 1, '2026-01-01T00:05:00Z', 'confirmed',
         '${NOW}', '2026-01-01T14:01:00Z', 'send-1', NULL),
        ('i2', 'r1', 'c1', 1, '{}', 'chiming_in', 2, '2026-01-01T00:06:00Z', 'planned',
         '${NOW}', '2026-01-01T14:02:00Z', NULL, NULL);
    INSERT INTO outbound_parts (id, intent_id, ordinal, kind, payload, status)
      VALUES ('p1', 'i1', 0, 'text', '{"text":"synthetic body"}', 'confirmed');
    INSERT INTO wake_signals (id, conversation_id, cause, through_seq, dedupe_key, ready_at,
      priority, status, lease_token, lease_expires_at, attempts, created_at)
      VALUES ('w1', 'c1', 'manual', 1, 'dk1', '2026-01-01T00:00:30Z', 5, 'leased', 'tok1',
       '2026-01-01T01:00:00Z', 1, '${NOW}');
  `);
}
function seededV57Db(): Database {
  const db = new Database(":memory:");
  db.exec([...V56_CHAIN, V57_SQL].join("\n"));
  db.exec(`PRAGMA user_version = ${BUSINESS_SCHEMA_VERSION};`);
  seedHistoryOutputRows(db);
  return db;
}

describe("0057 history output identity indexes (index-only, 56 to 57)", () => {
  it("keeps the migration inventory and the gate version in step", () => {
    expect(BUSINESS_MIGRATION_FILES).toHaveLength(BUSINESS_SCHEMA_VERSION);
    expect(migrationSql).toHaveLength(BUSINESS_SCHEMA_VERSION);
    expect(statements(V57_SQL)).toEqual(EXPECTED_0057_STATEMENTS);
  });

  it("adds exactly the two approved partial indexes and nothing else", () => {
    const v56 = new Database(":memory:");
    const fresh = new Database(":memory:");
    try {
      v56.exec(V56_CHAIN.join("\n"));
      fresh.exec([...V56_CHAIN, V57_SQL].join("\n"));
      const before = ddl(v56);
      const after = ddl(fresh);
      const added = after.filter((obj) => !before.some((b) => b.name === obj.name));
      const kept = after.filter((obj) => !added.includes(obj));
      expect(added.map((obj) => obj.sql).sort()).toEqual([...EXPECTED_0057_STATEMENTS].sort());
      expect(kept).toEqual(before);
      for (const [table, name] of [
        ["outbound_intents", LEGACY_INDEX],
        ["conversation_events", SPEECH_INDEX],
      ] as const) {
        const listed = fresh
          .query(`PRAGMA index_list(${table})`)
          .all()
          .map((row) => row as { name: string; unique: number; partial: number });
        const entry = listed.find((row) => row.name === name);
        expect(entry).toBeDefined();
        expect(entry?.unique).toBe(0);
        expect(entry?.partial).toBe(1);
      }
      const legacyCols = fresh.query(`PRAGMA index_info(${LEGACY_INDEX})`).all() as Array<{
        seqno: number;
        cid: number;
        name: string | null;
      }>;
      expect(legacyCols.map((c) => c.name)).toEqual(["legacy_send_id", "conversation_id"]);
      const speechCols = fresh.query(`PRAGMA index_info(${SPEECH_INDEX})`).all() as Array<{
        seqno: number;
        cid: number;
        name: string | null;
      }>;
      // The keyed slot is the fixed sources[1] expression: an expression column has no name.
      expect(speechCols.map((c) => c.name)).toEqual(["conversation_id", null]);
      expect(speechCols[1].cid).toBe(-2);
    } finally {
      v56.close();
      fresh.close();
    }
  });

  it("upgrades a real historical-56 file database to 57 with every business row byte-identical", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ss-0057-"));
    const file = path.join(dir, "business.sqlite");
    try {
      const old = new Database(file);
      old.exec(V56_CHAIN.join("\n"));
      old.exec(`PRAGMA user_version = 56;`);
      seedHistoryOutputRows(old);
      const rowsBefore = allRows(old);
      const ddlBefore = ddl(old);
      const touchedBefore = touchedTableDdl(old);
      old.close();

      const reopened = openBusinessDb({ path: file });
      try {
        expect(reopened.db.query("PRAGMA user_version").get()).toEqual({
          user_version: BUSINESS_SCHEMA_VERSION,
        });
        expect(allRows(reopened.db)).toEqual(rowsBefore);
        // Additive: the only schema delta is the two pinned index rows; the historical
        // byte-56 DDL of both touched tables survives verbatim.
        const ddlAfter = ddl(reopened.db);
        const added = ddlAfter.filter((obj) => !ddlBefore.some((b) => b.name === obj.name));
        expect(added.map((obj) => obj.sql).sort()).toEqual([...EXPECTED_0057_STATEMENTS].sort());
        expect(ddlAfter.filter((obj) => !added.includes(obj))).toEqual(ddlBefore);
        expect(touchedTableDdl(reopened.db)).toEqual(touchedBefore);
        expect(reopened.db.query("PRAGMA foreign_key_check").all()).toEqual([]);
        expect(reopened.db.query("PRAGMA integrity_check").get()).toEqual({
          integrity_check: "ok",
        });
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the gate exact: missing, extra or differing new index DDL is rejected", () => {
    const missing = openBusinessDb();
    try {
      missing.db.exec(`DROP INDEX ${LEGACY_INDEX};`);
      expect(() => ensureBusinessSchema(missing.db)).toThrow("REJECT_UNKNOWN_STRUCTURE");
    } finally {
      missing.close();
    }
    const extra = openBusinessDb();
    try {
      extra.db.exec("CREATE INDEX zz_scratch ON outbound_intents(conversation_id);");
      expect(() => ensureBusinessSchema(extra.db)).toThrow("REJECT_UNKNOWN_STRUCTURE");
    } finally {
      extra.close();
    }
    const differing = openBusinessDb();
    try {
      differing.db.exec(`DROP INDEX ${SPEECH_INDEX};`);
      differing.db.exec(
        "CREATE INDEX ix_conversation_send_speech_source ON conversation_events(conversation_id, json_extract(sources, '$[0].id')) WHERE source_kind = 'qq_send' AND json_extract(sources, '$[1].kind') = 'qq_speech';",
      );
      expect(() => ensureBusinessSchema(differing.db)).toThrow("REJECT_UNKNOWN_STRUCTURE");
    } finally {
      differing.close();
    }
  });

  it("EXPLAIN: the candidate-local legacy send lookup selects both keys of the new index", () => {
    const db = seededV57Db();
    try {
      const positive =
        "SELECT id FROM outbound_intents WHERE legacy_send_id = 'send-1' AND conversation_id = 'c1'";
      expect(eqp(db, positive)).toEqual([
        `SEARCH outbound_intents USING INDEX ${LEGACY_INDEX} (legacy_send_id=? AND conversation_id=?)`,
      ]);
      expect(db.query(positive).all()).toEqual([{ id: "i1" }]);
      // Rows outside the partial index's WHERE clause keep their old plan (NULL legacy id
      // cannot enter the index) and stay reachable through the pre-existing index.
      const nullLegacy = eqp(
        db,
        "SELECT id FROM outbound_intents WHERE legacy_send_id IS NULL AND conversation_id = 'c1'",
      ).join("\n");
      expect(nullLegacy).not.toContain(LEGACY_INDEX);
      expect(nullLegacy).toContain("SEARCH outbound_intents");
      // Negative results: same legacy send under a foreign conversation, and an unmatched id.
      expect(
        db
          .query(
            "SELECT id FROM outbound_intents WHERE legacy_send_id = 'send-2' AND conversation_id = 'c1'",
          )
          .all(),
      ).toEqual([]);
      expect(
        db
          .query(
            "SELECT id FROM outbound_intents WHERE legacy_send_id = 'send-7' AND conversation_id = 'c1'",
          )
          .all(),
      ).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("EXPLAIN: the speech alias lookup selects the expression index only under the full producer contract", () => {
    const db = seededV57Db();
    try {
      const positive =
        "SELECT conversation_id, seq FROM conversation_events WHERE conversation_id = 'c1' AND source_kind = 'qq_send' AND json_extract(sources, '$[1].kind') = 'qq_speech' AND json_extract(sources, '$[1].id') = 'speech-1'";
      expect(eqp(db, positive)).toEqual([
        `SEARCH conversation_events USING INDEX ${SPEECH_INDEX} (conversation_id=? AND <expr>=?)`,
      ]);
      expect(db.query(positive).all()).toEqual([{ conversation_id: "c1", seq: 1 }]);
      // Missing either kind guard drops below the partial index's WHERE clause.
      const missingKind = eqp(
        db,
        "SELECT conversation_id, seq FROM conversation_events WHERE conversation_id = 'c1' AND json_extract(sources, '$[1].id') = 'speech-1'",
      ).join("\n");
      expect(missingKind).not.toContain(SPEECH_INDEX);
      // The primary (sources[0]) slot is not the indexed expression.
      const primarySlot = eqp(
        db,
        "SELECT conversation_id, seq FROM conversation_events WHERE conversation_id = 'c1' AND source_kind = 'qq_send' AND json_extract(sources, '$[0].id') = 'send-1'",
      ).join("\n");
      expect(primarySlot).not.toContain(SPEECH_INDEX);
      // Negative results: unmatched speech id, and a foreign conversation's alias id.
      expect(
        db
          .query(
            "SELECT conversation_id, seq FROM conversation_events WHERE conversation_id = 'c1' AND source_kind = 'qq_send' AND json_extract(sources, '$[1].kind') = 'qq_speech' AND json_extract(sources, '$[1].id') = 'speech-7'",
          )
          .all(),
      ).toEqual([]);
      expect(
        db
          .query(
            "SELECT conversation_id, seq FROM conversation_events WHERE conversation_id = 'c2' AND source_kind = 'qq_send' AND json_extract(sources, '$[1].kind') = 'qq_speech' AND json_extract(sources, '$[1].id') = 'speech-1'",
          )
          .all(),
      ).toEqual([]);
    } finally {
      db.close();
    }
  });
});
