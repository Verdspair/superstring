// Safety tests for the business schema / version gate (R2).
//
// These tests harden src/server/db/schema-gate.ts + connection.ts against the
// two known defects discovered during the perfect-replica review:
//   1. verifyBusinessTables only compared the 16 table NAMES. A database stamped
//      user_version = 1 with the same 16 names but corrupted columns / types /
//      NOT NULL / PK / indexes / foreign keys / CHECK was wrongly accepted.
//   2. openConnection enabled WAL *before* the gate ran, so an unrecognised
//      file database was mutated (a -wal / -shm file written) before it could
//      be rejected, leaving the unknown file changed on disk.
//
// The gate now uses migrations/versions/0001_initial.sql as the single DDL
// source of truth: it builds an in-memory reference DB by running that file and
// compares the *exact* sqlite_schema objects (type / name / tbl_name / sql) of
// the candidate DB against it. Manually-equivalent DDL is intentionally NOT
// accepted (the precise definition is the contract). Extra views / triggers /
// indexes are rejected, and a version-0 DB that already contains any user
// object (table / view / trigger / index) is rejected instead of being migrated.
//
// WAL is now applied only AFTER openBusinessDb's ensureBusinessSchema succeeds,
// so a rejected file DB is never written to.

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensureBusinessSchema, openBusinessDb } from "../../src/server/db/schema-gate";

const MIGRATION_PATH = path.join(import.meta.dir, "../../migrations/versions/0001_initial.sql");
const MIGRATION_SQL = readFileSync(MIGRATION_PATH, "utf8");

/** Unique file path under the OS temp dir. */
function tmpFile(name: string): string {
  return path.join(
    tmpdir(),
    `superstring-safety-${name}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
}

/** Build a file DB by running `sql`, stamping `version`, then closing. */
function buildFileDb(filePath: string, sql: string, version: number): void {
  const db = new Database(filePath);
  db.exec(sql);
  db.run(`PRAGMA user_version = ${version}`);
  db.close();
}

function sha256File(filePath: string): string {
  const buf = readFileSync(filePath);
  return createHash("sha256").update(buf).digest("hex");
}

/** Remove the db file and any -wal / -shm siblings produced by WAL mode. */
function cleanupFile(filePath: string): void {
  rmSync(filePath, { force: true });
  rmSync(`${filePath}-wal`, { force: true });
  rmSync(`${filePath}-shm`, { force: true });
}

const created: string[] = [];
afterEach(() => {
  while (created.length) cleanupFile(created.pop() as string);
});

function track(filePath: string): string {
  created.push(filePath);
  return filePath;
}

describe("schema-gate: rejects corrupted-but-version-1 structures", () => {
  it("rejects when a column type is changed (temperature REAL -> TEXT)", () => {
    const p = track(tmpFile("coltype"));
    const corrupted = MIGRATION_SQL.replace(
      "temperature REAL NOT NULL DEFAULT 0.7",
      "temperature TEXT NOT NULL DEFAULT 0.7",
    );
    expect(corrupted).not.toBe(MIGRATION_SQL);
    buildFileDb(p, corrupted, 1);
    expect(() => {
      openBusinessDb({ path: p }).close();
    }).toThrow(/REJECT_UNKNOWN_STRUCTURE/);
  });

  it("rejects when a CHECK constraint is rewritten", () => {
    const p = track(tmpFile("check"));
    const corrupted = MIGRATION_SQL.replace(
      "CHECK (is_active IN (0, 1))",
      "CHECK (is_active IN (0, 1, 2))",
    );
    expect(corrupted).not.toBe(MIGRATION_SQL);
    buildFileDb(p, corrupted, 1);
    expect(() => {
      openBusinessDb({ path: p }).close();
    }).toThrow(/REJECT_UNKNOWN_STRUCTURE/);
  });

  it("rejects when a required index is missing", () => {
    const p = track(tmpFile("idx"));
    const corrupted = MIGRATION_SQL.replace(
      "CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_persona_agent ON agent_personas (agent_id);\n",
      "",
    );
    expect(corrupted).not.toBe(MIGRATION_SQL);
    buildFileDb(p, corrupted, 1);
    expect(() => {
      openBusinessDb({ path: p }).close();
    }).toThrow(/REJECT_UNKNOWN_STRUCTURE/);
  });

  it("rejects when a foreign key ON DELETE policy is rewritten", () => {
    const p = track(tmpFile("fk"));
    const corrupted = MIGRATION_SQL.replace(
      "FOREIGN KEY (agent_id) REFERENCES agents (id) ON DELETE CASCADE",
      "FOREIGN KEY (agent_id) REFERENCES agents (id) ON DELETE NO ACTION",
    );
    expect(corrupted).not.toBe(MIGRATION_SQL);
    buildFileDb(p, corrupted, 1);
    expect(() => {
      openBusinessDb({ path: p }).close();
    }).toThrow(/REJECT_UNKNOWN_STRUCTURE/);
  });

  it("rejects an extra view on top of an otherwise-valid structure", () => {
    const p = track(tmpFile("view"));
    buildFileDb(p, MIGRATION_SQL, 1);
    const db = new Database(p);
    db.exec("CREATE VIEW evil_view AS SELECT 1 AS one");
    db.close();
    expect(() => {
      openBusinessDb({ path: p }).close();
    }).toThrow(/REJECT_UNKNOWN_STRUCTURE/);
  });

  it("rejects an extra trigger on top of an otherwise-valid structure", () => {
    const p = track(tmpFile("trigger"));
    buildFileDb(p, MIGRATION_SQL, 1);
    const db = new Database(p);
    db.exec("CREATE TRIGGER evil_trigger AFTER INSERT ON users BEGIN SELECT 1; END");
    db.close();
    expect(() => {
      openBusinessDb({ path: p }).close();
    }).toThrow(/REJECT_UNKNOWN_STRUCTURE/);
  });
});

describe("schema-gate: additional structural boundaries", () => {
  const mutations = [
    ["missing-column", "  description TEXT NOT NULL,\n", ""],
    ["nullable", "  name TEXT NOT NULL,", "  name TEXT,"],
    ["primary-key", "id TEXT NOT NULL PRIMARY KEY", "id TEXT NOT NULL"],
    ["default", "DEFAULT 0.7", "DEFAULT 0.8"],
    ["literal-case", "DEFAULT ''", "DEFAULT 'A'"],
  ];
  for (const [name, from, to] of mutations) {
    it(`rejects ${name} and preserves file bytes and journal mode`, () => {
      const p = track(tmpFile(name));
      const changed = MIGRATION_SQL.replace(from, to);
      expect(changed).not.toBe(MIGRATION_SQL);
      buildFileDb(p, changed, 1);
      const before = sha256File(p);
      expect(() => {
        openBusinessDb({ path: p }).close();
      }).toThrow(/REJECT_UNKNOWN_STRUCTURE/);
      expect(sha256File(p)).toBe(before);
      expect(existsSync(`${p}-wal`)).toBe(false);
      expect(existsSync(`${p}-shm`)).toBe(false);
      const check = new Database(p, { readonly: true });
      try {
        expect(check.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });
      } finally {
        check.close();
      }
    });
  }
  for (const version of [0, 1]) {
    it(`does not mistake sqliteX_extra for a reserved name at version ${version}`, () => {
      const p = track(tmpFile(`prefix-${version}`));
      buildFileDb(
        p,
        `${version === 1 ? MIGRATION_SQL : ""}\nCREATE VIEW sqliteX_extra AS SELECT 1;`,
        version,
      );
      const before = sha256File(p);
      expect(() => {
        openBusinessDb({ path: p }).close();
      }).toThrow(/REJECT_UNKNOWN_STRUCTURE/);
      expect(sha256File(p)).toBe(before);
    });
  }
  it("rejects an unapproved extra index", () => {
    const p = track(tmpFile("extra-index"));
    buildFileDb(p, `${MIGRATION_SQL}\nCREATE INDEX extra_user_name ON users(name);`, 1);
    expect(() => {
      openBusinessDb({ path: p }).close();
    }).toThrow(/REJECT_UNKNOWN_STRUCTURE/);
  });
});

describe("schema-gate: accepts known-good structures", () => {
  it("opens a fresh (empty) file DB, migrates, and stamps the version", () => {
    const p = track(tmpFile("fresh"));
    const h = openBusinessDb({ path: p });
    try {
      const v = (h.db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
      expect(v).toBe(1);
    } finally {
      h.close();
    }
  });

  it("re-opens an already-valid version-1 file DB without throwing", () => {
    const p = track(tmpFile("reopen"));
    buildFileDb(p, MIGRATION_SQL, 1);
    const h = openBusinessDb({ path: p });
    expect(() => ensureBusinessSchema(h.db)).not.toThrow();
    h.close();
  });

  it("opens an in-memory business DB (no WAL concerns)", () => {
    const h = openBusinessDb();
    h.close();
  });
});

describe("schema-gate: version-0 with pre-existing objects is rejected", () => {
  it("rejects a version-0 DB that only contains a view (the original bug)", () => {
    const p = track(tmpFile("v0view"));
    const db = new Database(p);
    db.exec("CREATE VIEW v0_only_view AS SELECT 1 AS one");
    // user_version stays 0
    db.close();
    expect(() => {
      openBusinessDb({ path: p }).close();
    }).toThrow(/REJECT_UNKNOWN_STRUCTURE/);
  });
});

describe("connection: WAL is only applied after a successful gate (no file mutation on reject)", () => {
  it("does NOT write -wal/-shm or change bytes for a rejected unknown file DB", () => {
    const p = track(tmpFile("walreject"));
    // A non-empty, unrecognised database.
    const seed = new Database(p);
    seed.run("CREATE TABLE unexpected (id INTEGER PRIMARY KEY)");
    seed.run("PRAGMA user_version = 99");
    seed.close();

    const shaBefore = sha256File(p);
    const walBefore = existsSync(`${p}-wal`);
    const shmBefore = existsSync(`${p}-shm`);

    expect(() => {
      openBusinessDb({ path: p }).close();
    }).toThrow(/REJECT_UNKNOWN_VERSION|REJECT_UNKNOWN_STRUCTURE/);

    const shaAfter = sha256File(p);
    expect(shaAfter).toBe(shaBefore);
    expect(existsSync(`${p}-wal`)).toBe(false);
    expect(existsSync(`${p}-shm`)).toBe(false);
    // The seed state must be intact (still our unexpected table + version 99).
    expect(walBefore).toBe(false);
    expect(shmBefore).toBe(false);
  });

  it("enables WAL on a valid file DB and creates -wal/-shm while open", () => {
    const p = track(tmpFile("walok"));
    const h = openBusinessDb({ path: p });
    try {
      const mode = (h.db.query("PRAGMA journal_mode").get() as { journal_mode: string })
        .journal_mode;
      expect(mode.toLowerCase()).toBe("wal");
      // A -wal file only materialises once a write happens under WAL; perform one
      // so we can assert the file actually appears on disk.
      h.db.run(
        "INSERT INTO users (id, name, created_at) VALUES ('__probe__', 'p', '2026-01-01T00:00:00.000000Z')",
      );
      expect(existsSync(`${p}-wal`)).toBe(true);
    } finally {
      h.close();
    }
  });
});
