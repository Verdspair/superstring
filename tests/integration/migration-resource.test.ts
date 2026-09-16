import { describe, expect, it } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { loadStartupLayout } from "../../src/server/startup-layout";

const sql = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0001_initial.sql"),
  "utf8",
);
describe("explicit migration resources", () => {
  it("validates supplied SQL before creating a file-backed database", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ss-resource-"));
    const filename = path.join(dir, "test.sqlite");
    try {
      for (const migrationSql of ["", "this is not SQL"]) {
        expect(() => openBusinessDb({ path: filename, migrationSql })).toThrow();
        expect(existsSync(filename)).toBe(false);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("does not reuse a reference schema belonging to a different SQL resource", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ss-reference-"));
    const filename = path.join(dir, "test.sqlite");
    try {
      openBusinessDb({ path: filename, migrationSql: sql }).close();
      expect(() =>
        openBusinessDb({
          path: filename,
          migrationSql: `${sql}\nCREATE TABLE extra_resource(id INTEGER);`,
        }),
      ).toThrow("REJECT_UNKNOWN_STRUCTURE");
      const reopened = openBusinessDb({ path: filename, migrationSql: sql });
      expect(reopened.db.query("PRAGMA user_version").get()).toEqual({ user_version: 1 });
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("rejects incomplete installed resources without creating userdata", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ss-missing-resources-"));
    try {
      expect(() =>
        loadStartupLayout({ SUPERSTRING_APP_MODE: "installed", SUPERSTRING_APP_ROOT: dir }),
      ).toThrow();
      expect(existsSync(path.join(dir, "userdata"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("accepts a packaged layout that carries no R1 probe migration", () => {
    // The release package intentionally ships the business DDL only. Loading such a
    // layout must succeed, and it must not expose a probe resource of any kind.
    const dir = mkdtempSync(path.join(tmpdir(), "ss-packaged-layout-"));
    try {
      const versions = path.join(dir, "app/resources/migrations/versions");
      mkdirSync(versions, { recursive: true });
      copyFileSync(
        path.join(import.meta.dir, "../../migrations/versions/0001_initial.sql"),
        path.join(versions, "0001_initial.sql"),
      );
      const layout = loadStartupLayout({
        SUPERSTRING_APP_MODE: "installed",
        SUPERSTRING_APP_ROOT: dir,
      });
      expect(layout).not.toBeNull();
      expect(layout?.businessMigrationSql.trim().length).toBeGreaterThan(0);
      expect(layout && "probeMigrationSql" in layout).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("rejects inherited developer database overrides in installed mode", () => {
    expect(() =>
      loadStartupLayout({
        SUPERSTRING_APP_MODE: "installed",
        SUPERSTRING_APP_ROOT: path.resolve("synthetic-install"),
        SUPERSTRING_DB_PATH: "data/dev.sqlite",
      }),
    ).toThrow("OVERRIDE");
  });
  it("keeps the legacy entrypoint unchanged until explicit migration", () => {
    expect(loadStartupLayout({})).toBeNull();
    expect(() => loadStartupLayout({ SUPERSTRING_APP_ROOT: path.resolve("synthetic") })).toThrow(
      "INVALID_APP_MODE",
    );
  });
});
