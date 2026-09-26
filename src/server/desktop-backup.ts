import {
  closeSync,
  cpSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import type { resolveAppPaths } from "./app-paths";
import { BUSINESS_SCHEMA_VERSION } from "./db/schema-gate";

type AppPaths = ReturnType<typeof resolveAppPaths>;
export interface DesktopMigrationBackup {
  directory: string;
  fromVersion: number;
  toVersion: number;
}

function syncFile(filename: string): void {
  const fd = openSync(filename, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function syncTree(directory: string): Array<{ path: string; bytes: number }> {
  const files: Array<{ path: string; bytes: number }> = [];
  function visit(current: string): void {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const filename = path.join(current, entry.name);
      if (entry.isDirectory()) visit(filename);
      else {
        syncFile(filename);
        files.push({
          path: path.relative(directory, filename).split(path.sep).join("/"),
          bytes: lstatSync(filename).size,
        });
      }
    }
    // Desktop targets are POSIX. Persist directory entries as well as file data.
    syncFile(current);
  }
  visit(directory);
  return files;
}

/**
 * Call with the desktop instance lease held, before createRuntime can migrate.
 * SQLite's native Online Backup API preserves database pages (including rowids)
 * and committed WAL content without allocating a whole-database JS buffer. A
 * raw copy of superstring.sqlite would lose WAL pages after a crash. Keys,
 * appearance, configuration and imported QQ material accompany the snapshot.
 *
 * Each backup gets an exclusive directory. backup.json is the completion marker
 * and is written only after every payload file is durable. A failed attempt is
 * removed; a process killed mid-copy may leave an incomplete directory without
 * that marker. Existing complete snapshots are never replaced or pruned here.
 */
export async function backupBeforeDesktopMigration(
  paths: AppPaths,
): Promise<DesktopMigrationBackup | null> {
  if (paths.mode !== "desktop" || !existsSync(paths.database)) return null;
  const db = new DatabaseSync(paths.database, { readOnly: true });
  let directory: string | undefined;
  try {
    const { user_version: version } = db.prepare("PRAGMA user_version").get() as {
      user_version: number;
    };
    if (version < 0 || version > BUSINESS_SCHEMA_VERSION) {
      throw new Error(`REJECT_UNKNOWN_VERSION: user_version=${version}`);
    }
    // v0 is a new database; the existing schema gate still rejects unknown v0
    // structures. An already-current database must not make another large copy.
    if (version === 0 || version === BUSINESS_SCHEMA_VERSION) return null;
    mkdirSync(paths.backupsDir, { recursive: true, mode: 0o700 });
    directory = mkdtempSync(
      path.join(paths.backupsDir, `schema-${version}-to-${BUSINESS_SCHEMA_VERSION}-`),
    );
    const dataDir = path.join(directory, "data");
    mkdirSync(dataDir, { mode: 0o700 });
    const snapshot = path.join(dataDir, "superstring.sqlite");
    await backup(db, snapshot, { rate: 100 });
    const copy = new DatabaseSync(snapshot);
    try {
      // The online backup copies the source's WAL-mode header as well. Make the
      // destination standalone before publishing it; only the copy is changed.
      copy.exec("PRAGMA journal_mode=DELETE");
      const result = copy.prepare("PRAGMA quick_check").all();
      if (result.length !== 1 || result[0]?.quick_check !== "ok") {
        throw new Error("DESKTOP_BACKUP_DATABASE_CHECK_FAILED");
      }
    } finally {
      copy.close();
    }
    for (const name of ["config", "state", "qq"]) {
      const source = path.join(paths.privateRoot, name);
      if (!existsSync(source)) continue;
      cpSync(source, path.join(directory, name), {
        recursive: true,
        errorOnExist: true,
        force: false,
        filter(filename) {
          const entry = lstatSync(filename);
          if (!entry.isDirectory() && !entry.isFile()) {
            throw new Error("DESKTOP_BACKUP_REJECTS_LINKED_OR_SPECIAL_FILE");
          }
          return true;
        },
      });
    }
    const files = syncTree(directory);
    writeFileSync(
      path.join(directory, "backup.json"),
      JSON.stringify(
        {
          formatVersion: 1,
          createdAt: new Date().toISOString(),
          fromVersion: version,
          toVersion: BUSINESS_SCHEMA_VERSION,
          files,
        },
        null,
        2,
      ),
      { flag: "wx", mode: 0o600 },
    );
    syncFile(path.join(directory, "backup.json"));
    syncFile(directory);
    syncFile(paths.backupsDir);
    return { directory, fromVersion: version, toVersion: BUSINESS_SCHEMA_VERSION };
  } catch (error) {
    if (directory) rmSync(directory, { recursive: true, force: true });
    throw error;
  } finally {
    db.close();
  }
}
