// SQLite connection for the 16 business tables.
//
// Responsibilities (and non-goals):
//  - Open a bun:sqlite Database for either an in-memory database (":memory:") or a
//    file path.
//  - Force `PRAGMA foreign_keys = ON` on EVERY connection. SQLite ships with
//    foreign keys OFF by default, which would silently disable every CASCADE /
//    SET NULL policy defined in the schema (see data-model.md §2.2 / risk R5).
//    Because the pragma is per-connection, it must be set each time we open.
//  - Apply a small set of well-understood, safe pragmas: a busy_timeout so
//    concurrent writers wait instead of immediately seeing "database is locked".
//  - Return a closable handle. Callers MUST call `close()` when done.
//
// This module intentionally does NOT run migrations or touch schema. That is the
// job of schema-gate.ts, which runs BEFORE any writes and refuses unknown
// structures (data-model.md risk R2 / §7). It also never writes to a database
// whose structure/version it does not recognise.

import { Database } from "bun:sqlite";
import { type BunSQLiteDatabase, drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "./schema";

export interface OpenConnectionOptions {
  /** File path for a persistent database. Omit (or ":memory:") for in-memory. */
  path?: string;
}

export interface BusinessDbHandle {
  db: Database;
  orm: BunSQLiteDatabase<typeof schema>;
  close(): void;
}

/** Open a raw connection with the required pragmas applied (no schema gating). */
export function openConnection(opts?: OpenConnectionOptions): Database {
  const path = opts?.path ?? ":memory:";
  const db = new Database(path);
  try {
    // Connection-local only; persistent journal changes belong after the gate.
    db.run("PRAGMA foreign_keys = ON");
    db.run("PRAGMA busy_timeout = 5000");
  } catch (error) {
    db.close();
    throw error;
  }
  // NOTE: WAL is intentionally NOT enabled here. Enabling it would write a -wal /
  // -shm file to a database before the schema gate has verified it, mutating an
  // unknown file we are about to reject. openBusinessDb applies WAL only after
  // its gate has succeeded (data-model.md risk R2 / §7).
  return db;
}

/** Build a Drizzle ORM handle over an already-open (and schema-gated) Database. */
export function toOrmHandle(db: Database): BusinessDbHandle {
  const orm = drizzle(db, { schema });
  return {
    db,
    orm,
    close() {
      db.close();
    },
  };
}
