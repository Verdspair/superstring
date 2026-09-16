/**
 * Installed-mode service lease.
 *
 * The native launcher and this service both hold a SHARED read handle on
 * `<install root>/maintenance/operation.lock`. The installer/upgrade tool takes
 * the same file with FileShare.None (an exclusive handle), so it can only run
 * when NOTHING of ours is alive — a crashed launcher alone no longer unlocks the
 * installation while the service is still writing the database.
 *
 * Windows enforces this at the file-handle level: an exclusive open fails while
 * any shared handle exists, and a shared open fails (EBUSY) while an exclusive
 * handle exists. There is no timeout, no stale-lock guessing and no lock file
 * deletion. On POSIX the same code degrades to an advisory no-op; the product
 * target is Windows x64 only.
 *
 * The lease is acquired BEFORE the database is opened and released after the
 * runtime has fully stopped, so "no lease holder" always means "no open DB".
 */

import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import path from "node:path";

export interface ServiceLease {
  readonly path: string;
  release(): void;
}

export class ServiceLeaseUnavailableError extends Error {
  constructor(cause: unknown) {
    super(
      "安装维护正在进行，或此安装目录已被其他进程占用。请关闭正在运行的 superstring 或等待维护结束后重试。",
    );
    this.name = "ServiceLeaseUnavailableError";
    this.cause = cause;
  }
}

/**
 * Acquire the shared service lease for an installed root.
 * Returns null when disabled (development mode), so dev/start.cmd is unchanged.
 */
export function acquireServiceLease(installedRoot: string | null | undefined): ServiceLease | null {
  if (!installedRoot) return null;
  const directory = path.join(path.resolve(installedRoot), "maintenance");
  const lockPath = path.join(directory, "operation.lock");
  mkdirSync(directory, { recursive: true });
  // Stable lock file: create once, never truncate an existing one.
  if (!existsSync(lockPath)) {
    try {
      closeSync(openSync(lockPath, "a"));
    } catch (error) {
      if (!existsSync(lockPath)) throw new ServiceLeaseUnavailableError(error);
    }
  }
  let handle: number;
  try {
    handle = openSync(lockPath, "r");
  } catch (error) {
    throw new ServiceLeaseUnavailableError(error);
  }
  let released = false;
  return {
    path: lockPath,
    release() {
      if (released) return;
      released = true;
      try {
        closeSync(handle);
      } catch {
        // Process teardown also releases the handle.
      }
    },
  };
}
