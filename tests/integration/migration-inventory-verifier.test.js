import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { checkUpgradeIdentity } from "../../tools/installer/upgrade-policy.mjs";
import {
  checkInstallerSchemaVersions,
  checkSetupMigrationExistence,
} from "../../tools/verify/migration-inventory-checks.mjs";

const root = resolve(import.meta.dir, "../..");
const read = (file) => readFileSync(resolve(root, file), "utf8");
const migrations = readdirSync(resolve(root, "migrations/versions"))
  .filter((name) => /^\d{4}_.+\.sql$/.test(name))
  .sort();
const current = migrations.length;

describe("migration acceptance regression", () => {
  test("current native and JS package identities match the actual migrations", () => {
    expect(checkInstallerSchemaVersions(read, current)).toEqual([]);
    expect(checkSetupMigrationExistence(read("tools/verify/verify-setup.mjs"), migrations)).toEqual(
      [],
    );
  });

  test("rejects each stale native or JS current version, even with complete resource lists", () => {
    for (const [file, before, after] of [
      [
        "tools/setup/src/Manifest.cs",
        `SupportedSchemaVersion = ${current}`,
        "SupportedSchemaVersion = 24",
      ],
      [
        "tools/desktop/src/DesktopLayout.cs",
        `"businessSchemaVersion", ${current}`,
        '"businessSchemaVersion", 23',
      ],
      [
        "tools/installer/build-service.mjs",
        `businessSchemaVersion: ${current}`,
        "businessSchemaVersion: 1",
      ],
      [
        "tools/installer/build-package.mjs",
        `businessSchemaVersion: ${current}`,
        "businessSchemaVersion: 1",
      ],
      [
        "tools/installer/upgrade-policy.mjs",
        `businessSchemaVersion !== ${current}`,
        "businessSchemaVersion !== 1",
      ],
    ]) {
      const changed = read(file).replace(before, after);
      expect(changed).not.toBe(read(file));
      expect(
        checkInstallerSchemaVersions((name) => (name === file ? changed : read(name)), current),
      ).toContain(`${file}: current schema ${after.match(/\d+/)[0]}, filesystem has ${current}`);
    }
  });

  test("rejects a gap in accepted historical schema versions", () => {
    const file = "tools/installer/upgrade-policy.mjs";
    const changed = read(file).replace("1, 2, 3,", "1, 3,");
    expect(
      checkInstallerSchemaVersions((name) => (name === file ? changed : read(name)), current),
    ).toContain(`upgrade-policy: supported schema list must include versions 1 through ${current}`);
  });

  const names = ["0001_initial.sql", "0002_knowledge.sql"];
  const path = (name) => `path.join(installRoot, "app/resources/migrations/versions/${name}")`;
  test("counts complete independent existsSync calls", () => {
    expect(
      checkSetupMigrationExistence(
        names.map((name) => `fs.existsSync(${path(name)},)`).join(" && "),
        names,
      ),
    ).toEqual([]);
  });
  test("rejects multiple paths passed as extra existsSync arguments", () => {
    expect(
      checkSetupMigrationExistence(`fs.existsSync(${names.map(path).join(",")})`, names),
    ).toHaveLength(2);
  });
  test("rejects && inside existsSync arguments and duplicated checks", () => {
    expect(
      checkSetupMigrationExistence(`fs.existsSync(${names.map(path).join(" && ")})`, names),
    ).toHaveLength(2);
    expect(
      checkSetupMigrationExistence(
        `fs.existsSync(${path(names[0])}) && fs.existsSync(${path(names[0])})`,
        names,
      ),
    ).toHaveLength(2);
  });

  test("accepts every known prior schema only when upgrading to the current package", () => {
    const incoming = {
      manifestVersion: 1,
      layoutVersion: 1,
      product: "superstring",
      platform: "win32-x64",
      businessSchemaVersion: current,
      version: "0.2.1",
    };
    for (let version = 1; version <= current; version++)
      expect(checkUpgradeIdentity({ ...incoming, businessSchemaVersion: version }, incoming)).toBe(
        "same-version-reinstall",
      );
    expect(() =>
      checkUpgradeIdentity(incoming, { ...incoming, businessSchemaVersion: current + 1 }),
    ).toThrow("UNSUPPORTED_PACKAGE_IDENTITY");
    expect(() =>
      checkUpgradeIdentity(incoming, {
        ...incoming,
        businessSchemaVersion: current - 1,
        version: "9.0.0",
      }),
    ).toThrow("DOWNGRADE_REJECTED");
  });
});
