import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { resolveAppPaths } from "../../src/server/app-paths";
import { BUSINESS_MIGRATION_FILES, BUSINESS_SCHEMA_VERSION } from "../../src/server/db/schema-gate";
import { backupBeforeDesktopMigration } from "../../src/server/desktop-backup";
import { prepareDesktopEnvironment } from "../../src/server/desktop-bootstrap";
import { watchDesktopParent } from "../../src/server/desktop-parent";
import {
  acquireDesktopServiceLease,
  DesktopInstanceUnavailableError,
} from "../../src/server/desktop-service-lease";
import { loadStartupLayout } from "../../src/server/startup-layout";

function fixture() {
  const root = mkdtempSync(path.join(realpathSync(os.tmpdir()), "superstring-desktop-profile-"));
  const profile = path.join(root, "profile");
  const resources = path.join(root, "service/resources");
  mkdirSync(profile, { mode: 0o700 });
  mkdirSync(resources, { recursive: true });
  const executable = path.join(root, "service/superstring-server");
  writeFileSync(executable, "synthetic executable location");
  const paths = resolveAppPaths({ mode: "desktop", root: profile, resourceRoot: resources });
  const env: Record<string, string | undefined> = {
    SUPERSTRING_APP_MODE: "desktop",
    SUPERSTRING_APP_ROOT: profile,
    SUPERSTRING_DESKTOP_MANAGED: "1",
    SUPERSTRING_DESKTOP_TOKEN: "a".repeat(64),
  };
  return {
    root,
    profile,
    resources,
    executable,
    paths,
    env,
    dispose: () => {
      // Windows can keep a just-released SQLite file busy for a moment: retry the
      // teardown instead of failing the test on that race.
      let last: unknown;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
          return;
        } catch (error) {
          last = error;
        }
      }
      throw last;
    },
  };
}

describe("managed desktop resource/profile contract", () => {
  it("loads all packaged migrations and web assets from a read-only resource root", () => {
    const f = fixture();
    try {
      const versions = path.join(f.resources, "migrations/versions");
      mkdirSync(versions, { recursive: true });
      for (const name of BUSINESS_MIGRATION_FILES) {
        cpSync(
          path.join(import.meta.dir, "../../migrations/versions", name),
          path.join(versions, name),
        );
      }
      mkdirSync(path.join(f.resources, "web"));
      writeFileSync(path.join(f.resources, "web/index.html"), "<!doctype html>");
      chmodSync(f.resources, 0o555);
      prepareDesktopEnvironment(f.env, f.executable);
      const layout = loadStartupLayout(f.env);
      if (!layout) throw new Error("expected desktop layout");
      expect(layout.businessMigrationSql).toHaveLength(BUSINESS_SCHEMA_VERSION);
      expect(layout.paths.database).toBe(path.join(f.profile, "data/superstring.sqlite"));
      expect(layout.paths.resourceRoot).toBe(f.resources);
      expect(readdirSync(f.profile)).toEqual([]);
      expect(readdirSync(f.resources).sort()).toEqual(["migrations", "web"]);
    } finally {
      chmodSync(f.resources, 0o755);
      f.dispose();
    }
  });
  it("rejects inherited database/resource overrides before writing any profile files", () => {
    const f = fixture();
    try {
      expect(() =>
        prepareDesktopEnvironment(
          { ...f.env, SUPERSTRING_DB_PATH: "/tmp/other.sqlite" },
          f.executable,
        ),
      ).toThrow("OVERRIDE");
      expect(() =>
        prepareDesktopEnvironment({ ...f.env, SUPERSTRING_RESOURCE_ROOT: f.profile }, f.executable),
      ).toThrow("MISMATCH");
      expect(() =>
        prepareDesktopEnvironment({ ...f.env, SUPERSTRING_DESKTOP_TOKEN: "" }, f.executable),
      ).toThrow("CONTROL_TOKEN");
      expect(readdirSync(f.profile)).toEqual([]);
    } finally {
      f.dispose();
    }
  });
  it("requires canonical roots and rejects linked writable descendants", () => {
    const f = fixture();
    try {
      // Windows needs Developer Mode or elevation for real directory symlinks; a
      // junction is the same reparse-point shape node reports as a link.
      const linkType = process.platform === "win32" ? "junction" : "dir";
      const alias = path.join(f.root, "alias");
      symlinkSync(f.profile, alias, linkType);
      expect(() =>
        prepareDesktopEnvironment({ ...f.env, SUPERSTRING_APP_ROOT: alias }, f.executable),
      ).toThrow("CANONICAL");
      prepareDesktopEnvironment(f.env, f.executable);
      symlinkSync(f.resources, path.join(f.profile, "state"), linkType);
      expect(() => loadStartupLayout(f.env)).toThrow("LINKED_PATH");
    } finally {
      f.dispose();
    }
  });
});

describe("desktop migration recovery snapshot", () => {
  it("restores committed WAL data, state keys and material without modifying the source schema", async () => {
    const f = fixture();
    mkdirSync(f.paths.dataDir);
    const db = new Database(f.paths.database);
    const lease = acquireDesktopServiceLease(f.profile);
    try {
      db.exec(
        `PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE evidence(value TEXT); PRAGMA user_version=${BUSINESS_SCHEMA_VERSION - 1};`,
      );
      // Source rowids participate in conversation-history provenance, so a
      // logical export/rebuild would not be sufficient for disaster recovery.
      db.query("INSERT INTO evidence(rowid, value) VALUES (97, ?)").run("committed in WAL");
      expect(statSync(`${f.paths.database}-wal`).size).toBeGreaterThan(0);
      mkdirSync(f.paths.stateDir);
      writeFileSync(f.paths.browserStateKey, "browser-key");
      writeFileSync(f.paths.qqTransportKey, "transport-key");
      mkdirSync(f.paths.qqStickersDir, { recursive: true });
      writeFileSync(path.join(f.paths.qqStickersDir, "sticker.bin"), new Uint8Array([1, 3, 5]));
      const backup = await backupBeforeDesktopMigration(f.paths);
      if (!backup) throw new Error("expected migration backup");
      const recovered = new Database(path.join(backup.directory, "data/superstring.sqlite"), {
        readonly: true,
      });
      try {
        expect(recovered.query("SELECT rowid, value FROM evidence").get()).toEqual({
          rowid: 97,
          value: "committed in WAL",
        });
        expect(recovered.query("PRAGMA user_version").get()).toEqual({
          user_version: BUSINESS_SCHEMA_VERSION - 1,
        });
      } finally {
        recovered.close();
      }
      expect(readFileSync(path.join(backup.directory, "state/qq-transport.key"), "utf8")).toBe(
        "transport-key",
      );
      expect(readFileSync(path.join(backup.directory, "state/browser-state.key"), "utf8")).toBe(
        "browser-key",
      );
      expect([...readFileSync(path.join(backup.directory, "qq/stickers/sticker.bin"))]).toEqual([
        1, 3, 5,
      ]);
      expect(
        JSON.parse(readFileSync(path.join(backup.directory, "backup.json"), "utf8")).files.map(
          (file: { path: string }) => file.path,
        ),
      ).toContain("data/superstring.sqlite");
      expect(db.query("PRAGMA user_version").get()).toEqual({
        user_version: BUSINESS_SCHEMA_VERSION - 1,
      });
      db.exec(`PRAGMA user_version=${BUSINESS_SCHEMA_VERSION}`);
      expect(await backupBeforeDesktopMigration(f.paths)).toBeNull();
      expect(readdirSync(f.paths.backupsDir)).toEqual([path.basename(backup.directory)]);
    } finally {
      db.close();
      lease.release();
      f.dispose();
    }
  });
  it("does not copy a missing or fresh database and rejects newer schemas", async () => {
    const f = fixture();
    try {
      expect(await backupBeforeDesktopMigration(f.paths)).toBeNull();
      mkdirSync(f.paths.dataDir);
      const db = new Database(f.paths.database);
      try {
        expect(await backupBeforeDesktopMigration(f.paths)).toBeNull();
        db.exec(`PRAGMA user_version=${BUSINESS_SCHEMA_VERSION + 1}`);
        await expect(backupBeforeDesktopMigration(f.paths)).rejects.toThrow(
          "REJECT_UNKNOWN_VERSION",
        );
      } finally {
        db.close();
      }
      expect(existsSync(f.paths.backupsDir)).toBe(false);
    } finally {
      f.dispose();
    }
  });
  it("aborts an incomplete copy, leaves the old DB usable and never overwrites a complete snapshot", async () => {
    const f = fixture();
    mkdirSync(f.paths.dataDir);
    const db = new Database(f.paths.database);
    try {
      db.exec(
        "CREATE TABLE evidence(value TEXT); INSERT INTO evidence VALUES ('old'); PRAGMA user_version=1",
      );
      const complete = await backupBeforeDesktopMigration(f.paths);
      if (!complete) throw new Error("expected migration backup");
      const manifest = readFileSync(path.join(complete.directory, "backup.json"), "utf8");
      mkdirSync(f.paths.stateDir);
      // A linked key file: Windows cannot create file symlinks without Developer Mode,
      // so link a directory there — the copy filter rejects any reparse point either way.
      symlinkSync(
        f.resources,
        path.join(f.paths.stateDir, "external.key"),
        process.platform === "win32" ? "junction" : "file",
      );
      await expect(backupBeforeDesktopMigration(f.paths)).rejects.toThrow("REJECTS_LINKED");
      expect(readdirSync(f.paths.backupsDir)).toEqual([path.basename(complete.directory)]);
      expect(readFileSync(path.join(complete.directory, "backup.json"), "utf8")).toBe(manifest);
      expect(db.query("SELECT value FROM evidence").get()).toEqual({ value: "old" });
    } finally {
      db.close();
      f.dispose();
    }
  });
});

const leaseUrl = pathToFileURL(
  path.resolve(import.meta.dir, "../../src/server/desktop-service-lease.ts"),
).href;
describe("OS-backed desktop process ownership", () => {
  it("rejects a second handle and permits reopening the stable file after release", () => {
    const f = fixture();
    try {
      const lease = acquireDesktopServiceLease(f.profile);
      try {
        expect(() => acquireDesktopServiceLease(f.profile)).toThrow(
          DesktopInstanceUnavailableError,
        );
      } finally {
        lease.release();
        lease.release();
      }
      expect(existsSync(lease.path)).toBe(true);
      acquireDesktopServiceLease(f.profile).release();
    } finally {
      f.dispose();
    }
  });
  it("excludes another real process and recovers on holder death without deleting a lock file", async () => {
    const f = fixture();
    const code = `import { acquireDesktopServiceLease } from ${JSON.stringify(leaseUrl)}; const lease = acquireDesktopServiceLease(${JSON.stringify(f.profile)}); console.log('locked'); await Bun.stdin.text(); lease.release();`;
    const holder = Bun.spawn([process.execPath, "-e", code], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const reader = holder.stdout.getReader();
      const first = await reader.read();
      expect(new TextDecoder().decode(first.value)).toContain("locked");
      reader.releaseLock();
      const contender = Bun.spawnSync([
        process.execPath,
        "-e",
        `import { acquireDesktopServiceLease } from ${JSON.stringify(leaseUrl)}; acquireDesktopServiceLease(${JSON.stringify(f.profile)}).release();`,
      ]);
      expect(contender.exitCode).not.toBe(0);
      expect(contender.stderr.toString()).toContain("DESKTOP_PROFILE_IN_USE");
      holder.kill("SIGKILL");
      await holder.exited;
      const recovered = acquireDesktopServiceLease(f.profile);
      expect(existsSync(recovered.path)).toBe(true);
      recovered.release();
    } finally {
      holder.kill();
      await holder.exited;
      f.dispose();
    }
    // Spawning a real interpreter pays a cold start on slow machines; the
    // default five seconds is not a behaviour assertion here.
  }, 30_000);
});

describe("desktop parent liveness pipe", () => {
  it("releases a real sidecar's profile ownership after the host pipe closes", async () => {
    const f = fixture();
    const parentUrl = pathToFileURL(
      path.resolve(import.meta.dir, "../../src/server/desktop-parent.ts"),
    ).href;
    const code = `import { acquireDesktopServiceLease } from ${JSON.stringify(leaseUrl)};
      import { watchDesktopParent } from ${JSON.stringify(parentUrl)};
      const lease = acquireDesktopServiceLease(${JSON.stringify(f.profile)});
      watchDesktopParent(() => { lease.release(); console.log('graceful-stop'); process.exit(0); });
      console.log('ready');`;
    const child = Bun.spawn([process.execPath, "-e", code], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      const reader = child.stdout.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain("ready");
      child.stdin.end();
      let output = "";
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        output += new TextDecoder().decode(chunk.value);
      }
      reader.releaseLock();
      expect(output).toContain("graceful-stop");
      expect(await child.exited).toBe(0);
      acquireDesktopServiceLease(f.profile).release();
    } finally {
      child.kill();
      await child.exited;
      f.dispose();
    }
  }, 30_000);
  it("invokes graceful shutdown once on EOF and cleans up listeners", async () => {
    const input = new PassThrough();
    let calls = 0;
    const done = new Promise<void>((resolve) =>
      watchDesktopParent(() => {
        calls++;
        resolve();
      }, input),
    );
    input.end();
    await done;
    expect(calls).toBe(1);
    expect(input.listenerCount("end")).toBe(0);
    expect(input.listenerCount("error")).toBe(0);
  });
  it("disposes without requesting shutdown and handles already-ended streams", async () => {
    const input = new PassThrough();
    let calls = 0;
    const dispose = watchDesktopParent(() => calls++, input);
    dispose();
    input.destroy();
    await Promise.resolve();
    expect(calls).toBe(0);
    watchDesktopParent(() => calls++, input);
    await Promise.resolve();
    expect(calls).toBe(1);
  });
});
