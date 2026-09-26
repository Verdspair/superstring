import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type { ServiceLease } from "./service-lease";

export class DesktopInstanceUnavailableError extends Error {
  constructor(cause: unknown) {
    super("DESKTOP_PROFILE_IN_USE", { cause });
    this.name = "DesktopInstanceUnavailableError";
  }
}

/**
 * SQLite's OS-backed exclusive transaction is the process lock, not a heartbeat
 * row or a lease timeout. The dedicated database has no application data and is
 * never removed: every process must compete on the same inode. Keep this handle
 * until the business database and all its workers are closed. Process death
 * releases the lock automatically, including when the desktop host crashes.
 */
export function acquireDesktopServiceLease(profileRoot: string): ServiceLease {
  const directory = path.join(profileRoot, "maintenance");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lockPath = path.join(directory, "desktop-instance.sqlite");
  const db = new Database(lockPath, { create: true, strict: true });
  try {
    db.exec("PRAGMA busy_timeout = 0");
    const mode = db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get();
    if (mode?.journal_mode !== "delete") {
      throw new Error("DESKTOP_INSTANCE_LOCK_REQUIRES_DELETE_JOURNAL");
    }
    db.exec("BEGIN EXCLUSIVE");
  } catch (error) {
    db.close();
    const code = (error as { code?: string }).code;
    if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") {
      throw new DesktopInstanceUnavailableError(error);
    }
    throw error;
  }
  let released = false;
  return {
    path: lockPath,
    release() {
      if (released) return;
      released = true;
      // Closing rolls back this empty transaction and releases the kernel lock.
      db.close();
    },
  };
}
