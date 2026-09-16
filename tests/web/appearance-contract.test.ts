import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppearanceRepository } from "../../src/server/desktop-appearance";
import {
  APPEARANCE_MESSAGE_MAX_BYTES,
  type AppearanceSnapshot,
  encodeAppearanceMessage,
  MODE_IDS,
  parseAppearanceMessage,
  THEME_IDS,
} from "../../src/shared/appearance";

const ALL_COMBOS: AppearanceSnapshot[] = [];
for (const theme of THEME_IDS) for (const mode of MODE_IDS) ALL_COMBOS.push({ theme, mode });

describe("shared appearance frame contract", () => {
  it("exposes 16 theme ids and 3 mode ids", () => {
    expect(THEME_IDS).toHaveLength(16);
    expect(MODE_IDS).toHaveLength(3);
    expect(THEME_IDS).toContain("slate");
    expect(MODE_IDS).toEqual(["system", "light", "dark"]);
  });

  it("encodes and parses all 48 theme×mode combinations within the byte cap", () => {
    let count = 0;
    for (const snap of ALL_COMBOS) {
      const frame = encodeAppearanceMessage(snap);
      expect(frame).toContain('"type":"appearance"');
      expect(parseAppearanceMessage(frame)).toEqual(snap);
      expect(new TextEncoder().encode(frame).length).toBeLessThanOrEqual(
        APPEARANCE_MESSAGE_MAX_BYTES,
      );
      count++;
    }
    expect(count).toBe(48);
  });

  it("rejects invalid / out-of-contract / oversized frames", () => {
    expect(parseAppearanceMessage(null)).toBeNull();
    expect(parseAppearanceMessage(42)).toBeNull();
    expect(parseAppearanceMessage("not json")).toBeNull();
    expect(parseAppearanceMessage(JSON.stringify({ type: "nope" }))).toBeNull();
    expect(
      parseAppearanceMessage(JSON.stringify({ type: "appearance", theme: "slate" })),
    ).toBeNull();
    expect(
      parseAppearanceMessage(
        JSON.stringify({ type: "appearance", theme: "slate", mode: "bright" }),
      ),
    ).toBeNull();
    expect(
      parseAppearanceMessage(JSON.stringify({ type: "appearance", theme: "neon", mode: "light" })),
    ).toBeNull();
    // Strict desktop protocol rejects extra keys.
    expect(
      parseAppearanceMessage(
        JSON.stringify({ type: "appearance", theme: "slate", mode: "dark", extra: 1 }),
      ),
    ).toBeNull();
    // oversized frame (pad past the byte cap) is dropped
    const big = JSON.stringify({
      type: "appearance",
      theme: "slate",
      mode: "light",
      pad: "x".repeat(500),
    });
    expect(parseAppearanceMessage(big)).toBeNull();
  });

  it("encode defensively coerces bad in-memory values to defaults", () => {
    const frame = encodeAppearanceMessage({
      theme: "neon" as never,
      mode: "bright" as never,
    });
    expect(parseAppearanceMessage(frame)).toEqual({ theme: "slate", mode: "system" });
  });
});

describe("AppearanceRepository (server persistence)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "ss-appearance-"));
  });
  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* Windows may briefly hold the dir handle */
    }
  });

  it("persists and reloads all 48 combinations with strict file shape", async () => {
    const repo = new AppearanceRepository({ stateDir: dir });
    for (const snap of ALL_COMBOS) {
      await repo.save(snap);
      const loaded = repo.load();
      expect(loaded.snapshot).toEqual(snap);
      expect(loaded.recovered).toBe(false);
      const raw = JSON.parse(readFileSync(path.join(dir, "desktop-appearance.json"), "utf8"));
      expect(raw).toEqual({ version: 1, theme: snap.theme, mode: snap.mode });
    }
  });

  it("returns default and recovers from missing or corrupt files", () => {
    const repo = new AppearanceRepository({ stateDir: dir });
    expect(repo.load().snapshot).toEqual({ theme: "slate", mode: "system" });
    expect(repo.load().recovered).toBe(true);

    writeFileSync(path.join(dir, "desktop-appearance.json"), "{not json", "utf8");
    const corrupt = repo.load();
    expect(corrupt.snapshot).toEqual({ theme: "slate", mode: "system" });
    expect(corrupt.recovered).toBe(true);

    // wrong version or bad enum -> also recovered
    writeFileSync(
      path.join(dir, "desktop-appearance.json"),
      JSON.stringify({ version: 2, theme: "slate", mode: "light" }),
      "utf8",
    );
    expect(repo.load().recovered).toBe(true);
    writeFileSync(
      path.join(dir, "desktop-appearance.json"),
      JSON.stringify({ version: 1, theme: "neon", mode: "light" }),
      "utf8",
    );
    expect(repo.load().recovered).toBe(true);
  });

  it("applies a valid save on top of a corrupt file (recovery persists)", async () => {
    writeFileSync(path.join(dir, "desktop-appearance.json"), "corrupt", "utf8");
    const repo = new AppearanceRepository({ stateDir: dir });
    await repo.save({ theme: "jade", mode: "light" });
    expect(repo.load().snapshot).toEqual({ theme: "jade", mode: "light" });
    expect(repo.load().recovered).toBe(false);
  });

  it("rapid changes collapse to the final value", async () => {
    const repo = new AppearanceRepository({ stateDir: dir });
    for (const snap of ALL_COMBOS) repo.save(snap); // synchronous burst
    await repo.close();
    expect(repo.load().snapshot).toEqual(ALL_COMBOS[ALL_COMBOS.length - 1]);
  });

  it("keeps saving after a write error (resilient chain)", async () => {
    class FailingRepo extends AppearanceRepository {
      failNext = 1;
      protected async writeNow(s: AppearanceSnapshot): Promise<void> {
        if (this.failNext > 0) {
          this.failNext--;
          throw new Error("simulated write failure");
        }
        await super.writeNow(s);
      }
    }
    const repo = new FailingRepo({ stateDir: dir });
    await repo.save({ theme: "forest", mode: "dark" }); // fails, swallowed
    await repo.save({ theme: "ocean", mode: "light" }); // succeeds
    expect(repo.load().snapshot).toEqual({ theme: "ocean", mode: "light" });
  });

  it("rejects new writes after close() but still flushes the queue", async () => {
    const repo = new AppearanceRepository({ stateDir: dir });
    const p = repo.save({ theme: "violet", mode: "dark" });
    await repo.close();
    await p;
    expect(repo.load().snapshot).toEqual({ theme: "violet", mode: "dark" });
    // a write attempted during/after shutdown is a no-op and must not clobber
    await expect(repo.save({ theme: "rose", mode: "light" })).resolves.toBeUndefined();
    expect(repo.load().snapshot).toEqual({ theme: "violet", mode: "dark" });
  });
});
