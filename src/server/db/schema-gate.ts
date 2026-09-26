// Strict schema/version gate. v1 is frozen; v2 adds the knowledge library.
//
// Mechanism:
//  - The SQLite `user_version` pragma marks the schema version. Only a fresh DB
//    or an exactly matching known schema may receive the ordered migrations.
//    Resource validation happens before opening any file-backed database.
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

/** Ordered resources are also supplied explicitly by installed entrypoints. */
export const BUSINESS_SCHEMA_VERSION = 43 as const;
export const BUSINESS_MIGRATION_FILES = [
  "0001_initial.sql",
  "0002_knowledge.sql",
  "0003_knowledge_read.sql",
  "0004_organization.sql",
  "0005_qq_transport.sql",
  "0006_qq_memory_sources.sql",
  "0007_qq_observation_text.sql",
  "0008_qq_memory_batch.sql",
  "0009_qq_transport_config.sql",
  "0010_qq_schemes.sql",
  "0011_qq_speech_log.sql",
  "0012_qq_media_notes.sql",
  "0013_qq_scheme_triggers.sql",
  "0014_qq_send_log.sql",
  "0015_qq_scheme_rhythm.sql",
  "0016_qq_context_budget.sql",
  "0017_qq_scheme_prompts.sql",
  "0018_qq_members.sql",
  "0019_qq_output_reserve.sql",
  "0020_qq_scheme_stickers.sql",
  "0021_qq_stickers.sql",
  "0022_qq_sticker_authorization.sql",
  "0023_qq_dispatch.sql",
  "0024_qq_media_purposes.sql",
  "0025_desktop_settings.sql",
  "0026_qq_media_supplement.sql",
  "0027_qq_event_addressed.sql",
  "0028_qq_immediate_lease.sql",
  "0029_qq_module_switches.sql",
  "0030_qq_sweep_verdicts.sql",
  "0031_qq_attention.sql",
  "0032_model_providers.sql",
  "0033_qq_idle_judgements.sql",
  "0034_qq_initiative_min_score.sql",
  "0035_qq_reply_split.sql",
  "0036_qq_judgement_reuse.sql",
  "0037_qq_judgement_per_speaker.sql",
  "0038_qq_judgement_model.sql",
  "0039_agent_runs.sql",
  "0040_conversation_wakes.sql",
  "0041_outbound_intents.sql",
  "0042_runtime_observability.sql",
  "0043_protected_model_results.sql",
] as const;
export type BusinessMigrationSql = readonly [
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  string,
];

/** Legacy tables followed by the additive knowledge and QQ transport tables. */
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
  "knowledge_settings",
  "knowledge_categories",
  "knowledge_documents",
  "knowledge_grants",
  "knowledge_chunks",
  "knowledge_drafts",
  "knowledge_jobs",
  "turn_knowledge_snapshots",
  "agent_knowledge_read_settings",
  "organization_settings",
  "qq_settings",
  "qq_schemes",
  "qq_owner_identities",
  "qq_bindings",
  "qq_events",
  "qq_memory_sources",
  "qq_observation_text",
  "qq_processed_events",
  "qq_speech_log",
  "qq_media_notes",
  "qq_send_log",
  "qq_send_part",
  "qq_speech_text",
  "qq_members",
  "qq_sticker_collections",
  "qq_sticker_assets",
  "qq_sticker_collection_items",
  "qq_scheme_sticker_collections",
  "qq_dispatch_settings",
  "qq_dispatch_candidates",
  "qq_dispatch_lease",
  "qq_sweep_verdicts",
  "desktop_settings",
  "model_providers",
  "qq_idle_judgements",
  "qq_judgement_readings",
  "conversations",
  "conversation_events",
  "wake_signals",
  "outbound_intents",
  "outbound_parts",
  "agent_runs",
  "agent_steps",
  "context_snapshots",
  "run_events",
  "runtime_spans",
];

function loadMigrationSql(): BusinessMigrationSql {
  const directory = path.join(import.meta.dir, "../../../migrations/versions");
  return [
    readFileSync(path.join(directory, BUSINESS_MIGRATION_FILES[0]), "utf8"),
    readFileSync(path.join(directory, BUSINESS_MIGRATION_FILES[1]), "utf8"),
    readFileSync(path.join(directory, BUSINESS_MIGRATION_FILES[2]), "utf8"),
    readFileSync(path.join(directory, BUSINESS_MIGRATION_FILES[3]), "utf8"),
    readFileSync(path.join(directory, BUSINESS_MIGRATION_FILES[4]), "utf8"),
    readFileSync(path.join(directory, BUSINESS_MIGRATION_FILES[5]), "utf8"),
    readFileSync(path.join(directory, BUSINESS_MIGRATION_FILES[6]), "utf8"),
    readFileSync(path.join(directory, BUSINESS_MIGRATION_FILES[7]), "utf8"),
    readFileSync(path.join(directory, BUSINESS_MIGRATION_FILES[8]), "utf8"),
    readFileSync(path.join(directory, BUSINESS_MIGRATION_FILES[9]), "utf8"),
    readFileSync(path.join(directory, BUSINESS_MIGRATION_FILES[10]), "utf8"),
    readFileSync(path.join(directory, BUSINESS_MIGRATION_FILES[11]), "utf8"),
    readFileSync(path.join(directory, BUSINESS_MIGRATION_FILES[12]), "utf8"),
    readFileSync(path.join(directory, BUSINESS_MIGRATION_FILES[13]), "utf8"),
    readFileSync(path.join(directory, BUSINESS_MIGRATION_FILES[14]), "utf8"),
    readFileSync(path.join(directory, BUSINESS_MIGRATION_FILES[15]), "utf8"),
    readFileSync(path.join(directory, BUSINESS_MIGRATION_FILES[16]), "utf8"),
    readFileSync(path.join(directory, BUSINESS_MIGRATION_FILES[17]), "utf8"),
    readFileSync(path.join(directory, BUSINESS_MIGRATION_FILES[18]), "utf8"),
    readFileSync(path.join(directory, BUSINESS_MIGRATION_FILES[19]), "utf8"),
    readFileSync(path.join(directory, BUSINESS_MIGRATION_FILES[20]), "utf8"),
    readFileSync(path.join(directory, BUSINESS_MIGRATION_FILES[21]), "utf8"),
    readFileSync(path.join(directory, BUSINESS_MIGRATION_FILES[22]), "utf8"),
    readFileSync(path.join(directory, BUSINESS_MIGRATION_FILES[23]), "utf8"),
    readFileSync(path.join(directory, BUSINESS_MIGRATION_FILES[24]), "utf8"),
    readFileSync(path.join(directory, BUSINESS_MIGRATION_FILES[25]), "utf8"),
    readFileSync(path.join(directory, BUSINESS_MIGRATION_FILES[26]), "utf8"),
    readFileSync(path.join(directory, BUSINESS_MIGRATION_FILES[27]), "utf8"),
    readFileSync(path.join(directory, BUSINESS_MIGRATION_FILES[28]), "utf8"),
    readFileSync(path.join(directory, BUSINESS_MIGRATION_FILES[29]), "utf8"),
    readFileSync(path.join(directory, BUSINESS_MIGRATION_FILES[30]), "utf8"),
    readFileSync(path.join(directory, BUSINESS_MIGRATION_FILES[31]), "utf8"),
    readFileSync(path.join(directory, BUSINESS_MIGRATION_FILES[32]), "utf8"),
    readFileSync(path.join(directory, BUSINESS_MIGRATION_FILES[33]), "utf8"),
    readFileSync(path.join(directory, BUSINESS_MIGRATION_FILES[34]), "utf8"),
    readFileSync(path.join(directory, BUSINESS_MIGRATION_FILES[35]), "utf8"),
    readFileSync(path.join(directory, BUSINESS_MIGRATION_FILES[36]), "utf8"),
    readFileSync(path.join(directory, BUSINESS_MIGRATION_FILES[37]), "utf8"),
    readFileSync(path.join(directory, BUSINESS_MIGRATION_FILES[38]), "utf8"),
    readFileSync(path.join(directory, BUSINESS_MIGRATION_FILES[39]), "utf8"),
    readFileSync(path.join(directory, BUSINESS_MIGRATION_FILES[40]), "utf8"),
    readFileSync(path.join(directory, BUSINESS_MIGRATION_FILES[41]), "utf8"),
    readFileSync(path.join(directory, BUSINESS_MIGRATION_FILES[42]), "utf8"),
  ];
}

function validateResources(migrations: BusinessMigrationSql): void {
  if (migrations.length !== BUSINESS_SCHEMA_VERSION || migrations.some((sql) => !sql.trim())) {
    throw new Error("INVALID_MIGRATION_RESOURCE: incomplete business SQL");
  }
  // Every prefix must be buildable; the walk below builds them all in one pass.
  referenceObjects(migrations, migrations.length);
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

// The single source of truth: the authoritative DDL for every prefix of a migration chain. One
// reference database per chain is walked forward, snapshotting the schema objects after each step,
// because a single open asks for every prefix at once — `validateResources` validates them all and
// then each applied migration is verified against its own. Replaying "the first N migrations" into
// a throwaway database per prefix, with the cache dropped every 8 entries, made every open cost the
// whole chain over and over: `openBusinessDb()` measured ~1.23 s at 37 migrations (2026-09-25),
// which is what pushed the backend suite past the gate's per-check ceiling. The walk replays a chain
// once per process instead.
interface ReferenceChain {
  readonly key: string;
  readonly db: Database;
  /** `snapshots[n]` holds the objects after the first `n + 1` migrations. */
  readonly snapshots: Map<string, SchemaObject>[];
}
const referenceChains = new Map<string, ReferenceChain>();
// Bounded so the isolated resource fixtures of tests cannot grow this without limit. The bound
// counts whole chains (each a few MB at most), not prefixes.
const REFERENCE_CHAIN_LIMIT = 32;

function referenceChain(migrations: readonly string[]): ReferenceChain {
  const key = migrations.join("\n");
  const cached = referenceChains.get(key);
  if (cached) return cached;
  while (referenceChains.size >= REFERENCE_CHAIN_LIMIT) {
    const oldest = referenceChains.keys().next().value;
    if (oldest === undefined) break;
    referenceChains.get(oldest)?.db.close();
    referenceChains.delete(oldest);
  }
  const chain: ReferenceChain = { key, db: new Database(":memory:"), snapshots: [] };
  referenceChains.set(key, chain);
  return chain;
}

/** The canonical objects after the first `count` migrations of this exact chain. */
function referenceObjects(migrations: readonly string[], count: number): Map<string, SchemaObject> {
  if (count < 1 || count > migrations.length) {
    throw new Error(`INVALID_MIGRATION_RESOURCE: migration prefix ${count} is outside the chain`);
  }
  const chain = referenceChain(migrations);
  while (chain.snapshots.length < count) {
    const next = chain.snapshots.length;
    try {
      chain.db.exec(migrations[next]);
    } catch (error) {
      // A half-applied step must never become the baseline for a later caller: the previous code
      // built a throwaway database per prefix, so a failed build left nothing behind. Discarding
      // the chain keeps that property while still caching successful ones.
      chain.db.close();
      referenceChains.delete(chain.key);
      throw error;
    }
    chain.snapshots.push(extractSchemaObjects(chain.db));
  }
  return chain.snapshots[count - 1];
}

/**
 * Strictly verify that the candidate database's structure is byte-for-byte the
 * same as the one produced by the ordered resources for its declared version.
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
function verifyBusinessSchemaMatches(
  db: Database,
  migrations: readonly string[],
  count: number,
): void {
  const reference = referenceObjects(migrations, count);
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

/** Validate the old schema before any DDL; migrate and stamp in one transaction. */
export function ensureBusinessSchema(
  db: Database,
  migrationSql: BusinessMigrationSql = loadMigrationSql(),
): void {
  validateResources(migrationSql);
  runInTransaction(db, (tx) => {
    const version = getUserVersion(tx);
    if (version < 0 || version > BUSINESS_SCHEMA_VERSION) {
      throw new Error(`REJECT_UNKNOWN_VERSION: user_version=${version}`);
    }
    if (version === 0) {
      if (hasAnyUserObjects(tx)) {
        throw new Error(
          "REJECT_UNKNOWN_STRUCTURE: version-0 database already contains user objects",
        );
      }
    } else {
      verifyBusinessSchemaMatches(tx, migrationSql, version);
    }
    for (let next = version; next < BUSINESS_SCHEMA_VERSION; next++) {
      tx.exec(migrationSql[next]);
      verifyBusinessSchemaMatches(tx, migrationSql, next + 1);
      // Only v0/v1 databases create the library here. Never rewrite a persisted
      // setting on v2+ reopen; DEFAULT clauses remain frozen for exact DDL gates.
      if (next === 1) {
        tx.query("UPDATE knowledge_settings SET context_budget = ? WHERE id = 1").run(16384);
      }
      setUserVersion(tx, next + 1);
    }
  });
}

/**
 * Open (and gate) the business database. In-memory by default; pass `{ path }` for
 * a file-backed database. The gate runs first; on rejection the connection is
 * closed so no open handle leaks. Always call `close()` when done.
 */
export function openBusinessDb(opts?: {
  path?: string;
  migrationSql?: BusinessMigrationSql;
}): BusinessDbHandle {
  const migrationSql = opts?.migrationSql ?? loadMigrationSql();
  // Resolve and validate resources before touching a file-backed database.
  validateResources(migrationSql);
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
