import { Database } from "bun:sqlite";
import { afterEach, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  BUSINESS_SCHEMA_VERSION,
  type BusinessMigrationSql,
  ensureBusinessSchema,
} from "../../src/server/db/schema-gate";

const directory = path.join(import.meta.dir, "../../migrations/versions");
const sqls = readdirSync(directory)
  .filter((name) => /^\d{4}_.*\.sql$/.test(name))
  .sort()
  .map((name) => readFileSync(path.join(directory, name), "utf8"));
const dbs: Database[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});
function old68() {
  const db = new Database(":memory:");
  dbs.push(db);
  db.exec(sqls.slice(0, 68).join("\n"));
  db.exec("PRAGMA user_version=68");
  return db;
}
it("upgrades exact schema68 with only four additive indexes and no table row changes", () => {
  const db = old68();
  const before = db
    .query("SELECT name,sql FROM sqlite_schema WHERE type='table' ORDER BY name")
    .all();
  const tableCounts = db.query("SELECT COUNT(*) AS n FROM users").get();
  const indexMigration = sqls[68];
  if (!indexMigration) throw new Error("Missing known index migration");
  db.exec(indexMigration);
  db.exec("PRAGMA user_version=69");
  expect(BUSINESS_SCHEMA_VERSION).toBe(75);
  expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 69 });
  expect(
    db.query("SELECT name,sql FROM sqlite_schema WHERE type='table' ORDER BY name").all(),
  ).toEqual(before);
  expect(db.query("SELECT COUNT(*) AS n FROM users").get()).toEqual(tableCounts);
  for (const name of [
    "idx_runtime_spans_wake",
    "idx_runtime_spans_output",
    "ix_wake_conversation_status",
    "ix_outbound_conversation_status",
  ]) {
    expect(
      db.query("SELECT name FROM sqlite_schema WHERE type='index' AND name=?").get(name),
    ).not.toBeNull();
  }
  for (const [column, index] of [
    ["wake_id", "idx_runtime_spans_wake"],
    ["output_id", "idx_runtime_spans_output"],
  ]) {
    const rows = db
      .query(
        `EXPLAIN QUERY PLAN SELECT trace_id,span_id FROM runtime_spans WHERE ${column}=? AND expires_at>? ORDER BY id LIMIT 1`,
      )
      .all("missing", "2026-01-01T00:00:00Z") as { detail: string }[];
    expect(rows.some((row) => row.detail.includes(index))).toBe(true);
  }
});
it("rejects an unknown index on schema68 without stamping69 or dropping the unknown object", () => {
  const db = old68();
  db.exec("CREATE INDEX stray_runtime_test ON runtime_spans(model)");
  expect(() => ensureBusinessSchema(db, sqls as unknown as BusinessMigrationSql)).toThrow(
    "REJECT_UNKNOWN_STRUCTURE",
  );
  expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 68 });
  expect(
    db.query("SELECT name FROM sqlite_schema WHERE name='stray_runtime_test'").get(),
  ).not.toBeNull();
});
