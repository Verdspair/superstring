// Schema / version gate for the 16 business tables.
//
// Mechanism:
//  - The SQLite `user_version` pragma marks the schema version. migrations/
//    versions/0001_initial.sql is the single authoritative DDL; this gate runs it
//    only on a verifiably fresh database, then stamps user_version.
//  - An unrecognised version or structure raises a `REJECT_` error without
//    intentionally changing the database schema or journal mode. Schema decisions
//    run in one transaction; on rejection it rolls back and openBusinessDb closes
//    the connection. This is not a read-only forensic opener: SQLite may recover
//    an existing hot journal or manage sidecars of a database already using WAL.
//  - The gate runs BEFORE any connection-altering write to unknown structures, so
//    a rejected database never leaks an open handle.

import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import path from "node:path";
import { type BunSQLiteDatabase, drizzle } from "drizzle-orm/bun-sqlite";
import { type BusinessDbHandle, openConnection } from "./connection";
import * as schema from "./schema";

/** Schema version for migrations/versions/0001_initial.sql (user_version pragma). */
export const BUSINESS_SCHEMA_VERSION = 1 as const;

const MIGRATION_PATH = path.join(import.meta.dir, "../../../migrations/versions/0001_initial.sql");

/** The 16 business table names in canonical order (data-model.md §0). */
export const BUSINESS_TABLE_NAMES: readonly string[] = [
  "users",
  "agents",
  "agent_personas",
  "sessions",
  "turns",
  "messages",
  "message_deletion_events",
  "memory_policies",
  "memory_session_states",
  "memory_entries",
  "memory_sources",
  "memory_links",
  "memory_processed_turns",
  "memory_jobs",
  "session_summaries",
  "summary_sources",
];

function loadMigrationSql(): string {
  return readFileSync(MIGRATION_PATH, "utf8");
}

/**
 * Run `fn` inside an explicit SQL transaction. Commits on success; rolls back and
 * re-throws on throw so a failed/aborted open can never leave a partial schema.
 */
export function runInTransaction<T>(db: Database, fn: (db: Database) => T): T {
  db.run("BEGIN");
  try {
    const result = fn(db);
    db.run("COMMIT");
    return result;
  } catch (err) {
    db.run("ROLLBACK");
    throw err;
  }
}

function getUserVersion(db: Database): number {
  const row = db.query("PRAGMA user_version").get() as { user_version: number };
  return row.user_version;
}

function setUserVersion(db: Database, version: number): void {
  db.run(`PRAGMA user_version = ${version}`);
}

/**
 * True when the database already contains any user-defined object (table, view,
 * trigger, or index) outside of SQLite's own `sqlite_%` bookkeeping. Used to
 * decide whether a version-0 database is genuinely fresh (and therefore safe to
 * migrate) or already holds something we did not create.
 */
function hasAnyUserObjects(db: Database): boolean {
  const row = db
    .query(
      "SELECT COUNT(*) AS c FROM sqlite_master WHERE type IN ('table','view','trigger','index') AND name NOT GLOB 'sqlite_*'",
    )
    .get() as { c: number };
  return row.c > 0;
}

interface SchemaObject {
  type: string;
  name: string;
  tblName: string;
  sql: string;
}

/**
 * Extract every user-defined sqlite_schema object as a `(type, name)` -> object
 * map. The stored `sql` is the exact DDL SQLite keeps for the object, which is
 * the precise contract we compare against.
 */
function extractSchemaObjects(db: Database): Map<string, SchemaObject> {
  const rows = db
    .query("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT GLOB 'sqlite_*'")
    .all() as Array<{ type: string; name: string; tbl_name: string; sql: string }>;
  const map = new Map<string, SchemaObject>();
  for (const r of rows) {
    map.set(`${r.type} ${r.name}`, { type: r.type, name: r.name, tblName: r.tbl_name, sql: r.sql });
  }
  return map;
}

// The single source of truth: the authoritative DDL run against an isolated
// in-memory database to obtain the canonical set of schema objects. Built once,
// lazily, and cached for the lifetime of the process.
let referenceObjects: Map<string, SchemaObject> | null = null;
let referenceSql: string | null = null;
function getReferenceObjects(migrationSql: string): Map<string, SchemaObject> {
  if (!migrationSql.trim()) throw new Error("INVALID_MIGRATION_RESOURCE: empty business SQL");
  if (referenceObjects === null || referenceSql !== migrationSql) {
    const ref = new Database(":memory:");
    try {
      ref.exec(migrationSql);
      referenceObjects = extractSchemaObjects(ref);
      referenceSql = migrationSql;
    } finally {
      ref.close();
    }
  }
  return referenceObjects;
}

/**
 * Strictly verify that the candidate database's structure is byte-for-byte the
 * same as the one produced by migrations/versions/0001_initial.sql.
 *
 * The previous check only compared the 16 table NAMES, so a database stamped
 * `user_version = 1` with the same names but corrupted columns / types / NOT NULL
 * / PK / indexes / foreign keys / CHECK would pass. Here we compare the exact
 * sqlite_schema objects:
 *   - every reference object must be present (no missing table/index),
 *   - no extra object may exist (rejects stray views / triggers / indexes),
 *   - every object's stored `sql` must match the reference exactly.
 *
 * Because both the reference and the checked database are produced by running the
 * same migration through SQLite, the stored `sql` is comparable directly; we do
 * NOT normalise (normalisation could mangle string literals inside CHECK / DEFAULT
 * clauses). Manually-equivalent DDL is intentionally rejected — the precise
 * definition is the contract.
 */
function verifyBusinessSchemaMatches(db: Database, migrationSql: string): void {
  const reference = getReferenceObjects(migrationSql);
  const actual = extractSchemaObjects(db);

  const missing: string[] = [];
  const extra: string[] = [];
  for (const key of reference.keys()) {
    if (!actual.has(key)) missing.push(key);
  }
  for (const key of actual.keys()) {
    if (!reference.has(key)) extra.push(key);
  }
  if (missing.length) {
    throw new Error(`REJECT_UNKNOWN_STRUCTURE: missing schema objects [${missing.join(", ")}]`);
  }
  if (extra.length) {
    throw new Error(`REJECT_UNKNOWN_STRUCTURE: unexpected schema objects [${extra.join(", ")}]`);
  }
  for (const [key, obj] of reference) {
    const a = actual.get(key);
    if (a && (a.sql !== obj.sql || a.tblName !== obj.tblName)) {
      throw new Error(`REJECT_UNKNOWN_STRUCTURE: schema object definition differs: ${key}`);
    }
  }
}

/**
 * Gate the business schema. Mirrors ensureProbeSchema: a fresh DB (user_version 0,
 * no tables) is migrated and stamped; a DB already at BUSINESS_SCHEMA_VERSION is
 * structure-checked; anything else is rejected with a REJECT_ error.
 */
export function ensureBusinessSchema(db: Database, migrationSql = loadMigrationSql()): void {
  getReferenceObjects(migrationSql);
  runInTransaction(db, (tx) => {
    const version = getUserVersion(tx);

    if (version === 0) {
      if (!hasAnyUserObjects(tx)) {
        tx.exec(migrationSql);
        setUserVersion(tx, BUSINESS_SCHEMA_VERSION);
        return;
      }
      // A version-0 database that already holds user objects (table, view,
      // trigger, or index) is not ours to migrate — reject it instead of
      // layering our schema on top of an unknown structure.
      throw new Error(
        `REJECT_UNKNOWN_STRUCTURE: version-0 database already contains user objects (not a fresh business DB)`,
      );
    }

    if (version === BUSINESS_SCHEMA_VERSION) {
      verifyBusinessSchemaMatches(tx, migrationSql);
      return;
    }

    throw new Error(`REJECT_UNKNOWN_VERSION: user_version=${version}`);
  });
}

/**
 * Open (and gate) the business database. In-memory by default; pass `{ path }` for
 * a file-backed database. The gate runs first; on rejection the connection is
 * closed so no open handle leaks. Always call `close()` when done.
 */
export function openBusinessDb(opts?: { path?: string; migrationSql?: string }): BusinessDbHandle {
  const migrationSql = opts?.migrationSql ?? loadMigrationSql();
  // Resolve and validate resources before touching a file-backed database.
  getReferenceObjects(migrationSql);
  const db = openConnection(opts);
  const isFile = !!opts?.path && opts.path !== ":memory:";
  try {
    ensureBusinessSchema(db, migrationSql);
    // Only switch journal mode after structural validation. Tests prove rejected
    // closed DELETE-mode fixtures retain bytes and gain no WAL/SHM sidecars;
    // existing WAL/hot-journal recovery is outside that guarantee.
    if (isFile) {
      db.run("PRAGMA journal_mode = WAL");
    }
    const orm: BunSQLiteDatabase<typeof schema> = drizzle(db, { schema });
    return { db, orm, close: () => db.close() };
  } catch (err) {
    db.close();
    throw err;
  }
}
