import { describe, expect, it } from "bun:test";
import path from "node:path";
import { assertNoLegacyDevelopmentState, resolveAppPaths } from "../../src/server/app-paths";

const root = path.resolve("synthetic-path-contract-only");
describe("explicit application paths (no disk writes)", () => {
  it("keeps development private files under local", () => {
    const paths = resolveAppPaths({ mode: "development", root });
    expect(paths.database).toBe(path.join(root, "local/data/superstring.sqlite"));
    expect(paths.browserStateKey).toBe(path.join(root, "local/state/browser-state.key"));
    expect(paths.logsDir).toBe(path.join(root, "local/logs"));
    expect(paths.webDir).toBe(path.join(root, "dist/web"));
  });
  it("keeps installed data under selected root, separate from resources", () => {
    const paths = resolveAppPaths({ mode: "installed", root });
    expect(paths.database).toBe(path.join(root, "userdata/data/superstring.sqlite"));
    expect(paths.appearance).toBe(path.join(root, "userdata/state/desktop-appearance.json"));
    expect(paths.backupsDir).toBe(path.join(root, "backups"));
    expect(paths.webDir).toBe(path.join(root, "app/resources/web"));
    expect(paths.businessMigration).toBe(
      path.join(root, "app/resources/migrations/versions/0001_initial.sql"),
    );
    // The R1 probe is a development surface. The installed layout must not even
    // name a probe resource, so it cannot creep back into a release package.
    expect("probeMigration" in paths).toBe(false);
  });
  it("rejects implicit cwd and drive-root layouts", () => {
    expect(() => resolveAppPaths({ mode: "installed", root: "relative" })).toThrow("ABSOLUTE");
    expect(() => resolveAppPaths({ mode: "installed", root: path.parse(root).root })).toThrow(
      "DRIVE_ROOT",
    );
  });
  it("separates the desktop profile from immutable packaged resources", () => {
    const resources = path.resolve("synthetic-bundle/resources");
    const paths = resolveAppPaths({ mode: "desktop", root, resourceRoot: resources });
    expect(paths.database).toBe(path.join(root, "data/superstring.sqlite"));
    expect(paths.browserStateKey).toBe(path.join(root, "state/browser-state.key"));
    expect(paths.qqTransportKey).toBe(path.join(root, "state/qq-transport.key"));
    expect(paths.qqStickersDir).toBe(path.join(root, "qq/stickers"));
    expect(paths.logsDir).toBe(path.join(root, "logs"));
    expect(paths.backupsDir).toBe(path.join(root, "backups"));
    expect(paths.maintenanceDir).toBe(path.join(root, "maintenance"));
    expect(paths.webDir).toBe(path.join(resources, "web"));
    expect(paths.businessMigration).toBe(
      path.join(resources, "migrations/versions/0001_initial.sql"),
    );
    assertNoLegacyDevelopmentState(paths, () => {
      throw new Error("must not read dev data");
    });
  });
  it("rejects resource/profile overlap and overrides of legacy layouts", () => {
    expect(() => resolveAppPaths({ mode: "desktop", root })).toThrow("RESOURCE_ROOT");
    for (const resources of [root, path.dirname(root), path.join(root, "resources")]) {
      expect(() => resolveAppPaths({ mode: "desktop", root, resourceRoot: resources })).toThrow(
        "MUST_BE_SEPARATE",
      );
    }
    expect(() =>
      resolveAppPaths({ mode: "installed", root, resourceRoot: path.resolve("bundle") }),
    ).toThrow("REQUIRES_DESKTOP");
  });
  it("refuses silently replacing legacy development data with an empty profile", () => {
    const paths = resolveAppPaths({ mode: "development", root });
    for (const old of [path.join(root, "data"), path.join(root, "artifacts/state")]) {
      expect(() => assertNoLegacyDevelopmentState(paths, (p) => p === old)).toThrow(
        "REQUIRES_REVIEW",
      );
    }
    expect(() => assertNoLegacyDevelopmentState(paths, () => false)).not.toThrow();
  });
  it("never probes legacy development state in installed mode", () => {
    const paths = resolveAppPaths({ mode: "installed", root });
    assertNoLegacyDevelopmentState(paths, () => {
      throw new Error("must not inspect developer data");
    });
  });
});
