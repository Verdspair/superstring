import { describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireServiceLease, ServiceLeaseUnavailableError } from "../../src/server/service-lease";

function scratchRoot(): string {
  return mkdtempSync(path.join(os.tmpdir(), "superstring-lease-"));
}

describe("installed service lease (maintenance/operation.lock)", () => {
  it("is disabled outside installed mode", () => {
    expect(acquireServiceLease(null)).toBeNull();
    expect(acquireServiceLease(undefined)).toBeNull();
    expect(acquireServiceLease("")).toBeNull();
  });

  it("creates the maintenance directory and a stable empty lock file", () => {
    const root = scratchRoot();
    try {
      const lease = acquireServiceLease(root);
      expect(lease).not.toBeNull();
      const lock = path.join(root, "maintenance", "operation.lock");
      expect(existsSync(lock)).toBe(true);
      expect(statSync(lock).size).toBe(0);
      // Releasing must not delete the file: the next holder has to open the same
      // path, and a delete/recreate cycle is exactly the race the lock prevents.
      lease?.release();
      expect(existsSync(lock)).toBe(true);
      expect(statSync(lock).size).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("never truncates content already inside the lock file", () => {
    const root = scratchRoot();
    try {
      const lock = path.join(root, "maintenance", "operation.lock");
      mkdirSync(path.dirname(lock), { recursive: true });
      writeFileSync(lock, "sentinel");
      acquireServiceLease(root)?.release();
      expect(readFileSync(lock, "utf8")).toBe("sentinel");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("lets several holders share the lease, as the launcher and the service do", () => {
    const root = scratchRoot();
    try {
      const launcher = acquireServiceLease(root);
      const service = acquireServiceLease(root);
      expect(launcher).not.toBeNull();
      expect(service).not.toBeNull();
      // One holder leaving must keep the installation locked for the other one.
      launcher?.release();
      expect(existsSync(path.join(root, "maintenance", "operation.lock"))).toBe(true);
      service?.release();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("tolerates a repeated release", () => {
    const root = scratchRoot();
    try {
      const lease = acquireServiceLease(root);
      expect(lease).not.toBeNull();
      lease?.release();
      expect(() => lease?.release()).not.toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports a maintenance clash in the user's language and keeps the cause", () => {
    const cause = new Error("EBUSY: resource busy or locked");
    const error = new ServiceLeaseUnavailableError(cause);
    expect(error.name).toBe("ServiceLeaseUnavailableError");
    expect(error.message).toContain("安装维护");
    expect(error.cause).toBe(cause);
  });
});
