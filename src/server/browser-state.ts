import { randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export const DEFAULT_BROWSER_STATE_SECRET_PATH = path.resolve("artifacts/state/browser-state.key");
const SECRET_PATTERN = /^[A-Za-z0-9_-]{32,}$/;
const waitArray = new Int32Array(new SharedArrayBuffer(4));

function readSecret(secretPath: string): string | null {
  try {
    const value = readFileSync(secretPath, "ascii");
    return SECRET_PATTERN.test(value) ? value : null;
  } catch {
    return null;
  }
}

function restrictPermissions(target: string, mode: number): void {
  try {
    chmodSync(target, mode);
  } catch {
    // The Python source also treats permission tightening as best-effort.
  }
}

function acquireLock(lockDirectory: string): () => void {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      mkdirSync(lockDirectory);
      return () => rmSync(lockDirectory, { recursive: true, force: true });
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String(error.code) : "";
      if (code !== "EEXIST" || Date.now() >= deadline) throw error;
      Atomics.wait(waitArray, 0, 0, 10);
    }
  }
}

function replaceSecret(secretPath: string, value: string): void {
  const temporaryPath = path.join(
    path.dirname(secretPath),
    `.${path.basename(secretPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const descriptor = openSync(temporaryPath, "wx", 0o600);
  try {
    writeFileSync(descriptor, value, { encoding: "ascii" });
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporaryPath, secretPath);
  restrictPermissions(secretPath, 0o600);
}

export function browserStateSecret(secretPath = DEFAULT_BROWSER_STATE_SECRET_PATH): string {
  const parent = path.dirname(secretPath);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  restrictPermissions(parent, 0o700);
  const markerPath = path.join(parent, `.${path.basename(secretPath)}.lock`);
  if (!existsSync(markerPath)) writeFileSync(markerPath, "0", { encoding: "ascii", mode: 0o600 });
  const release = acquireLock(`${markerPath}.d`);
  try {
    const existing = readSecret(secretPath);
    if (existing) {
      restrictPermissions(secretPath, 0o600);
      return existing;
    }
    const value = randomBytes(32).toString("base64url");
    replaceSecret(secretPath, value);
    return value;
  } finally {
    release();
  }
}
