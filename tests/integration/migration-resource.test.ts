import { describe, expect, it } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openBusinessDb } from "../../src/server/db/schema-gate";
import { loadStartupLayout } from "../../src/server/startup-layout";

const sql = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0001_initial.sql"),
  "utf8",
);
const knowledgeSql = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0002_knowledge.sql"),
  "utf8",
);
const readSql = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0003_knowledge_read.sql"),
  "utf8",
);
const organizationSql = readFileSync(
  path.join(import.meta.dir, "../../migrations/versions/0004_organization.sql"),
  "utf8",
);
const resources = [sql, knowledgeSql, readSql, organizationSql] as const;
const testTmpdir = realpathSync(tmpdir());
describe("explicit migration resources", () => {
  it("validates supplied SQL before creating a file-backed database", () => {
    const dir = mkdtempSync(path.join(testTmpdir, "ss-resource-"));
    const filename = path.join(dir, "test.sqlite");
    try {
      for (const migrationSql of ["", "this is not SQL"]) {
        expect(() =>
          openBusinessDb({
            path: filename,
            migrationSql: [sql, migrationSql, readSql, organizationSql],
          }),
        ).toThrow();
        expect(existsSync(filename)).toBe(false);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("does not reuse a reference schema belonging to a different SQL resource", () => {
    const dir = mkdtempSync(path.join(testTmpdir, "ss-reference-"));
    const filename = path.join(dir, "test.sqlite");
    try {
      openBusinessDb({ path: filename, migrationSql: resources }).close();
      expect(() =>
        openBusinessDb({
          path: filename,
          migrationSql: [
            sql,
            `${knowledgeSql}\nCREATE TABLE extra_resource(id INTEGER);`,
            readSql,
            organizationSql,
          ],
        }),
      ).toThrow("REJECT_UNKNOWN_STRUCTURE");
      const reopened = openBusinessDb({ path: filename, migrationSql: resources });
      expect(reopened.db.query("PRAGMA user_version").get()).toEqual({ user_version: 4 });
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("rejects incomplete installed resources without creating userdata", () => {
    const dir = mkdtempSync(path.join(testTmpdir, "ss-missing-resources-"));
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
    const dir = mkdtempSync(path.join(testTmpdir, "ss-packaged-layout-"));
    try {
      const versions = path.join(dir, "app/resources/migrations/versions");
      mkdirSync(versions, { recursive: true });
      copyFileSync(
        path.join(import.meta.dir, "../../migrations/versions/0001_initial.sql"),
        path.join(versions, "0001_initial.sql"),
      );
      expect(() =>
        loadStartupLayout({ SUPERSTRING_APP_MODE: "installed", SUPERSTRING_APP_ROOT: dir }),
      ).toThrow();
      expect(existsSync(path.join(dir, "userdata"))).toBe(false);
      copyFileSync(
        path.join(import.meta.dir, "../../migrations/versions/0002_knowledge.sql"),
        path.join(versions, "0002_knowledge.sql"),
      );
      expect(() =>
        loadStartupLayout({ SUPERSTRING_APP_MODE: "installed", SUPERSTRING_APP_ROOT: dir }),
      ).toThrow();
      expect(existsSync(path.join(dir, "userdata"))).toBe(false);
      copyFileSync(
        path.join(import.meta.dir, "../../migrations/versions/0003_knowledge_read.sql"),
        path.join(versions, "0003_knowledge_read.sql"),
      );
      expect(() =>
        loadStartupLayout({ SUPERSTRING_APP_MODE: "installed", SUPERSTRING_APP_ROOT: dir }),
      ).toThrow();
      copyFileSync(
        path.join(import.meta.dir, "../../migrations/versions/0004_organization.sql"),
        path.join(versions, "0004_organization.sql"),
      );
      const layout = loadStartupLayout({
        SUPERSTRING_APP_MODE: "installed",
        SUPERSTRING_APP_ROOT: dir,
      });
      expect(layout).not.toBeNull();
      expect(layout?.businessMigrationSql.length).toBe(4);
      expect(layout?.businessMigrationSql.every((sql) => sql.trim().length > 0)).toBe(true);
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
