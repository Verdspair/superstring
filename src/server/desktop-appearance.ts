// Desktop appearance persistence repository (server side).
//
// The desktop launcher reads this single JSON file to restore the last chosen
// theme + mode across launches. The path is FIXED by the server
// (cwd/artifacts/state/desktop-appearance.json); it NEVER comes from the client.
// The file is strictly { version: 1, theme, mode }.
//
// Durability model:
//   - Writes are serialized through a promise chain so concurrent appearance
//     frames collapse to the latest value (no torn/partial file).
//   - Each write lands in a same-directory temp file then is renamed atomically,
//     so a crash mid-write never leaves a half-written JSON.
//   - A write error is swallowed and the chain is kept healthy, so a later save
//     still succeeds (a failed appearance write must never break the server,
//     chat, or the liveness WebSocket).
//   - close() stops accepting new writes and awaits the in-flight queue; this is
//     called during shutdown so the final appearance is flushed before exit.

import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type AppearanceMode,
  type AppearanceSnapshot,
  isAppearanceMode,
  isThemeId,
  type ThemeId,
} from "../shared/appearance";

export const APPEARANCE_FILE_NAME = "desktop-appearance.json";
export const APPEARANCE_VERSION = 1 as const;

export interface AppearanceRepositoryOptions {
  /** Directory that owns the appearance JSON. MUST be supplied by the server,
   * never derived from client input. Defaults to cwd/artifacts/state. */
  stateDir?: string;
}

export interface LoadedAppearance {
  snapshot: AppearanceSnapshot;
  /** True when the file was missing or corrupt and a default was substituted. */
  recovered: boolean;
}

export class AppearanceRepository {
  private readonly filePath: string;
  private readonly dirPath: string;
  private chain: Promise<void> = Promise.resolve();
  private latest: AppearanceSnapshot | null = null;
  private closing = false;
  private lastWritten: string | null = null;

  constructor(options: AppearanceRepositoryOptions = {}) {
    this.dirPath = options.stateDir ?? path.resolve("artifacts", "state");
    this.filePath = path.join(this.dirPath, APPEARANCE_FILE_NAME);
  }

  /** Read the persisted appearance. Missing or corrupt files yield the default
   * (slate / system) and `recovered: true` — never throws. */
  load(): LoadedAppearance {
    try {
      if (statSync(this.filePath).size > 4096)
        return { snapshot: { theme: "slate", mode: "system" }, recovered: true };
      const parsed = this.parseFile(readFileSync(this.filePath, "utf8"));
      if (parsed) return { snapshot: parsed, recovered: false };
    } catch (error) {
      // ENOENT (no file yet) is expected; anything else is a corrupt/unreadable
      // file. In both cases we recover to a default rather than crash.
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
        console.error("[superstring] appearance file unreadable, recovering default:", error);
      }
    }
    return { snapshot: { theme: "slate", mode: "system" }, recovered: true };
  }

  private parseFile(raw: string): AppearanceSnapshot | null {
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      return null;
    }
    if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
    const obj = data as Record<string, unknown>;
    if (Object.keys(obj).length !== 3) return null;
    if (obj.version !== APPEARANCE_VERSION) return null;
    if (!isThemeId(obj.theme)) return null;
    if (!isAppearanceMode(obj.mode)) return null;
    return { theme: obj.theme as ThemeId, mode: obj.mode as AppearanceMode };
  }

  /** Enqueue persistence of the latest snapshot. Serialized; rapid changes
   * collapse to the final value. After a write error the chain stays alive so
   * subsequent saves still succeed. New writes are rejected once close() begins. */
  save(snapshot: AppearanceSnapshot): Promise<void> {
    if (this.closing || !isThemeId(snapshot.theme) || !isAppearanceMode(snapshot.mode))
      return Promise.resolve();
    this.latest = { theme: snapshot.theme, mode: snapshot.mode };
    const previous = this.chain;
    const task: () => Promise<void> = async () => {
      const value = this.latest;
      this.latest = null;
      if (!value) return;
      const key = JSON.stringify(value);
      if (key === this.lastWritten) return;
      await this.writeNow(value);
      this.lastWritten = key;
    };
    this.chain = previous.then(task).catch((error) => {
      // Swallow but keep the chain healthy; a failed write must not break the
      // server, chat, or the liveness WebSocket.
      console.error("[superstring] appearance save failed:", error);
    });
    return this.chain;
  }

  /** Begin the shutdown flush: stop accepting new writes and await the queue. */
  async close(): Promise<void> {
    this.closing = true;
    await this.chain;
  }

  /** Overridable for tests that need to simulate a write failure. */
  protected async writeNow(snapshot: AppearanceSnapshot): Promise<void> {
    await mkdir(this.dirPath, { recursive: true });
    const tmp = path.join(
      this.dirPath,
      `${APPEARANCE_FILE_NAME}.${process.pid}.${randomUUID()}.tmp`,
    );
    const payload = JSON.stringify({
      version: APPEARANCE_VERSION,
      theme: snapshot.theme,
      mode: snapshot.mode,
    });
    try {
      await writeFile(tmp, payload, { encoding: "utf8", flag: "wx" });
      await rename(tmp, this.filePath);
    } finally {
      try {
        await unlink(tmp);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT")
          console.error("[superstring] appearance temporary file retained:", error);
      }
    }
  }
}

/** Construct the appearance repository (mirrors the create* factory style used
 * by the desktop lifecycle controller). */
export function createAppearanceRepository(
  options: AppearanceRepositoryOptions = {},
): AppearanceRepository {
  return new AppearanceRepository(options);
}
