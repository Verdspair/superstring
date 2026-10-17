import { Database } from "bun:sqlite";
import { afterEach, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  BUSINESS_MIGRATION_FILES,
  type BusinessMigrationSql,
  ensureBusinessSchema,
} from "../../src/server/db/schema-gate";

const directory = path.join(import.meta.dir, "../../migrations/versions");
const sqls = BUSINESS_MIGRATION_FILES.map((name) =>
  readFileSync(path.join(directory, name), "utf8"),
);
const migration = readFileSync(path.join(directory, "0070_context_source_lookup.sql"), "utf8");
const dbs: Database[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});
function memory() {
  const db = new Database(":memory:");
  dbs.push(db);
  db.exec("PRAGMA foreign_keys=ON; PRAGMA recursive_triggers=ON");
  return db;
}
function old69() {
  const db = memory();
  db.exec(sqls.slice(0, 69).join("\n"));
  db.exec("PRAGMA user_version=69");
  return db;
}
function snapshot(db: Database, step: string, refs: unknown, status = "exact") {
  db.query(`INSERT INTO context_snapshots
    (step_id,source_refs,layout,protected_messages,status,protected_output,output_recorded)
    VALUES (?,?,'{}','[]',?,'{"text":"protected"}',1)`).run(step, JSON.stringify(refs), status);
}
function results(db: Database) {
  return db
    .query(`SELECT step_id,status,protected_messages,protected_output,output_recorded
    FROM context_snapshots ORDER BY step_id`)
    .all();
}
function memberships(db: Database) {
  return db
    .query(`SELECT step_id,source_kind,source_id FROM context_snapshot_source_refs
    ORDER BY step_id,source_kind,source_id`)
    .all();
}

// Minimal source tables isolate each trigger from unrelated retention/cascade triggers.
// Both sides execute the production 0066/0070 SQL, including the 0043 output cascade.
function sourceFixture(indexed: boolean) {
  const db = memory();
  db.exec(`
    CREATE TABLE turns(id TEXT PRIMARY KEY,source_valid INTEGER,context_valid INTEGER);
    CREATE TABLE memory_entries(id TEXT PRIMARY KEY,status TEXT);
    CREATE TABLE knowledge_documents(id TEXT PRIMARY KEY,content_version INTEGER);
    CREATE TABLE knowledge_grants(document_id TEXT,agent_id TEXT);
    CREATE TABLE qq_observation_text(event_key TEXT PRIMARY KEY);
    CREATE TABLE qq_media_notes(id TEXT PRIMARY KEY);
    CREATE TABLE qq_speech_text(speech_id TEXT PRIMARY KEY);
    CREATE TABLE qq_events(event_key TEXT PRIMARY KEY);
    CREATE TABLE qq_sticker_assets(id TEXT PRIMARY KEY,updated_at TEXT);
    CREATE TABLE outbound_intents(id TEXT PRIMARY KEY);
    CREATE TABLE outbound_parts(id TEXT PRIMARY KEY,intent_id TEXT,payload TEXT,status TEXT);
    CREATE TABLE context_snapshots(step_id TEXT PRIMARY KEY,source_refs TEXT NOT NULL,
      layout TEXT,protected_messages TEXT,status TEXT);
  `);
  db.exec(sqls[42]);
  // 0066 replaces these names; only their historical replacement bodies matter here.
  for (const name of sqls[65].matchAll(/DROP TRIGGER (\w+);/g)) {
    db.exec(`CREATE TRIGGER ${name[1]} AFTER INSERT ON turns BEGIN SELECT 1; END`);
  }
  db.exec(sqls[65]);
  if (indexed) db.exec(migration);
  db.exec(`
    INSERT INTO turns VALUES ('42',1,1);
    INSERT INTO memory_entries VALUES ('42','active');
    INSERT INTO knowledge_documents VALUES ('42',1);
    INSERT INTO knowledge_grants VALUES ('42','agent');
    INSERT INTO qq_observation_text VALUES ('42');
    INSERT INTO qq_media_notes VALUES ('42');
    INSERT INTO qq_speech_text VALUES ('42');
    INSERT INTO qq_events VALUES ('42');
    INSERT INTO qq_sticker_assets VALUES ('42','before');
    INSERT INTO outbound_intents VALUES ('42');
    INSERT INTO outbound_parts VALUES ('part','42','before','planned');
  `);
  return db;
}
const events = [
  ["web_turn delete", "web_turn", "42", "DELETE FROM turns", "revoked"],
  ["web_turn invalid", "web_turn", "42", "UPDATE turns SET source_valid=0", "revoked"],
  ["memory delete", "memory", "42", "DELETE FROM memory_entries", "revoked"],
  ["memory hide", "memory", "42", "UPDATE memory_entries SET status='suppressed'", "revoked"],
  ["document delete", "knowledge_document", "42", "DELETE FROM knowledge_documents", "revoked"],
  [
    "document revision",
    "knowledge_document",
    "42",
    "UPDATE knowledge_documents SET content_version=2",
    "revoked",
  ],
  ["grant delete", "knowledge_grant", '["42","agent"]', "DELETE FROM knowledge_grants", "revoked"],
  ["observation expiry", "qq_observation", "42", "DELETE FROM qq_observation_text", "expired"],
  ["media expiry", "qq_media", "42", "DELETE FROM qq_media_notes", "expired"],
  ["speech expiry", "qq_speech", "42", "DELETE FROM qq_speech_text", "expired"],
  ["event delete", "qq_observation", "42", "DELETE FROM qq_events", "revoked"],
  ["sticker delete", "qq_sticker", "42", "DELETE FROM qq_sticker_assets", "revoked"],
  [
    "sticker revision",
    "qq_sticker",
    "42",
    "UPDATE qq_sticker_assets SET updated_at='after'",
    "revoked",
  ],
  ["intent delete", "outbound_intent", "42", "DELETE FROM outbound_intents", "expired"],
  ["part delete", "outbound_intent", "42", "DELETE FROM outbound_parts", "expired"],
  [
    "part change",
    "outbound_intent",
    "42",
    "UPDATE outbound_parts SET payload='after',status='confirmed'",
    "expired",
  ],
] as const;
for (const [name, kind, id, event, status] of events) {
  it(`0070 preserves 0069 ${name} effects and protected output redaction`, () => {
    const pair = [sourceFixture(false), sourceFixture(true)];
    for (const db of pair) {
      snapshot(db, "hit", [{ kind, id }]);
      snapshot(db, "miss", [{ kind, id: "unrelated" }]);
      snapshot(db, "other-kind", [{ kind: "not-a-source", id }]);
      snapshot(db, "already-expired", [{ kind, id }], "expired");
      db.exec(event);
      expect(
        db
          .query(
            "SELECT status,protected_messages,protected_output,output_recorded FROM context_snapshots WHERE step_id='hit'",
          )
          .get(),
      ).toEqual({ status, protected_messages: null, protected_output: null, output_recorded: 1 });
      expect(
        db
          .query("SELECT status,protected_output FROM context_snapshots WHERE step_id='miss'")
          .get(),
      ).toEqual({ status: "exact", protected_output: '{"text":"protected"}' });
    }
    expect(results(pair[1])).toEqual(results(pair[0]));
    expect(memberships(pair[1])).toEqual([
      { step_id: "miss", source_kind: kind, source_id: "unrelated" },
    ]);
  });
}
it("keeps non-invalidating updates exact on both schemas", () => {
  for (const indexed of [false, true]) {
    const db = sourceFixture(indexed);
    snapshot(
      db,
      "safe",
      events.map(([, kind, id]) => ({ kind, id })),
    );
    const before = results(db);
    db.exec(`UPDATE turns SET source_valid=1,context_valid=1;
      UPDATE memory_entries SET status='active';
      UPDATE knowledge_documents SET content_version=content_version;
      UPDATE qq_sticker_assets SET updated_at=updated_at;
      UPDATE outbound_parts SET payload=payload,status=status;`);
    expect(results(db)).toEqual(before);
  }
});
it("does not coerce numeric JSON IDs to text source IDs and rolls back invalidation", () => {
  const db = sourceFixture(true);
  snapshot(db, "numeric", [{ kind: "memory", id: 42 }]);
  snapshot(db, "text", [{ kind: "memory", id: "42" }]);
  const before = results(db);
  const indexedBefore = memberships(db);
  db.exec("BEGIN; DELETE FROM memory_entries");
  expect(db.query("SELECT status FROM context_snapshots WHERE step_id='numeric'").get()).toEqual({
    status: "exact",
  });
  expect(
    db.query("SELECT status,protected_output FROM context_snapshots WHERE step_id='text'").get(),
  ).toEqual({ status: "revoked", protected_output: null });
  db.exec("ROLLBACK");
  expect(results(db)).toEqual(before);
  expect(memberships(db)).toEqual(indexedBefore);
});
it("upgrades real schema69 through the production gate and maintains derived membership transactionally", () => {
  const db = old69();
  db.exec(`INSERT INTO agent_runs(run_id,spec_id,spec_version,owner_kind,owner_id,status,started_at)
    VALUES ('run','test','1','test','owner','completed','2026-01-01');
    INSERT INTO agent_steps(step_id,run_id,step_no,model,phase,status,started_at)
    VALUES ('step','run',1,'synthetic','leaf','completed','2026-01-01');`);
  snapshot(db, "step", [
    { kind: "memory", id: "42" },
    { kind: "memory", id: "42" },
    { kind: "memory", id: 42 },
    { kind: "unknown", id: "42" },
  ]);
  const before = results(db);
  ensureBusinessSchema(db, sqls as unknown as BusinessMigrationSql);
  expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 71 });
  expect(results(db)).toEqual(before);
  const initial = [{ step_id: "step", source_kind: "memory", source_id: "42" }];
  expect(memberships(db)).toEqual(initial);
  db.exec("BEGIN");
  db.query("UPDATE context_snapshots SET source_refs=? WHERE step_id='step'").run(
    '[{"kind":"web_turn","id":"next"}]',
  );
  expect(memberships(db)).toEqual([
    { step_id: "step", source_kind: "web_turn", source_id: "next" },
  ]);
  db.exec("ROLLBACK");
  expect(memberships(db)).toEqual(initial);
  db.exec("UPDATE context_snapshots SET status='expired' WHERE step_id='step'");
  expect(memberships(db)).toEqual([]);
  db.exec("UPDATE context_snapshots SET status='exact' WHERE step_id='step'");
  expect(memberships(db)).toEqual(initial);
  db.query("UPDATE context_snapshots SET source_refs=? WHERE step_id='step'").run(
    '[{"kind":"memory","id":42}]',
  );
  expect(memberships(db)).toEqual([]);
  db.query("UPDATE context_snapshots SET source_refs=? WHERE step_id='step'").run(
    '[{"kind":"memory","id":"42"}]',
  );
  db.exec("DELETE FROM agent_runs WHERE run_id='run'");
  expect(memberships(db)).toEqual([]);
  expect(results(db)).toEqual([]);
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
});
it("rejects unknown schema69 and a missing schema70 lookup index without stamping or repairing", () => {
  const old = old69();
  old.exec("CREATE INDEX unexpected_context_index ON context_snapshots(status)");
  expect(() => ensureBusinessSchema(old, sqls as unknown as BusinessMigrationSql)).toThrow(
    "REJECT_UNKNOWN_STRUCTURE",
  );
  expect(old.query("PRAGMA user_version").get()).toEqual({ user_version: 69 });
  expect(
    old.query("SELECT name FROM sqlite_schema WHERE name='context_snapshot_source_refs'").get(),
  ).toBeNull();
  const current = old69();
  ensureBusinessSchema(current, sqls as unknown as BusinessMigrationSql);
  current.exec("DROP INDEX ix_context_snapshot_source_lookup");
  expect(() => ensureBusinessSchema(current, sqls as unknown as BusinessMigrationSql)).toThrow(
    "REJECT_UNKNOWN_STRUCTURE",
  );
  expect(current.query("PRAGMA user_version").get()).toEqual({ user_version: 71 });
});
it("uses the covering source lookup for matched and missing IDs, with a missing-index scan control", () => {
  const db = sourceFixture(true);
  snapshot(db, "hit", [{ kind: "memory", id: "42" }]);
  const query =
    "SELECT step_id FROM context_snapshot_source_refs WHERE source_kind=? AND source_id=?";
  const explain = db.prepare(`EXPLAIN QUERY PLAN ${query}`);
  const lookup = db.prepare(query);
  try {
    for (const id of ["42", "missing"]) {
      const plan = explain.all("memory", id) as { detail: string }[];
      expect(
        plan.some(
          ({ detail }) =>
            detail.includes("ix_context_snapshot_source_lookup") &&
            detail.includes("source_kind=? AND source_id=?"),
        ),
      ).toBe(true);
      expect(lookup.all("memory", id)).toEqual(id === "42" ? [{ step_id: "hit" }] : []);
    }
  } finally {
    explain.finalize();
    lookup.finalize();
  }
  db.exec("DROP INDEX ix_context_snapshot_source_lookup");
  const fallback = db.query(`EXPLAIN QUERY PLAN ${query} `).all("memory", "missing") as {
    detail: string;
  }[];
  expect(fallback.some(({ detail }) => detail.includes("SCAN context_snapshot_source_refs"))).toBe(
    true,
  );
});

it("retains malformed-entry order and short-circuit behavior from the old invalidation trigger", () => {
  const cases = [
    [{ kind: "memory", id: "42" }, "plain-scalar"],
    ["plain-scalar", { kind: "memory", id: "42" }],
    [{ kind: "memory", id: "other" }, "plain-scalar"],
    [null, true, 12, { kind: "memory", id: "42" }],
    ['{"kind":"memory","id":"42"}'],
  ];
  for (const refs of cases) {
    const outcomes = [false, true].map((indexed) => {
      const db = sourceFixture(indexed);
      snapshot(db, "ordered", refs);
      let failure: string | null = null;
      try {
        db.exec("DELETE FROM memory_entries WHERE id='42'");
      } catch (error) {
        failure = (error as Error).message;
      }
      return {
        failure,
        snapshots: results(db),
        source: db.query("SELECT id FROM memory_entries").all(),
      };
    });
    expect(outcomes[1]).toEqual(outcomes[0]);
  }
});
