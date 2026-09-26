import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { writeChecksums } from "../../tools/desktop/build/cross-platform/checksums.mjs";
import {
  checkMacReleaseCredentials,
  createConfiguration,
  expectedArtifacts,
  getTarget,
  TARGETS,
} from "../../tools/desktop/build/cross-platform/config.mjs";
import { publicLicenseInventory } from "../../tools/desktop/build/cross-platform/licenses.mjs";
import { validateSmokeReport } from "../../tools/desktop/build/cross-platform/smoke-contract.mjs";

test("all native targets keep service binaries outside ASAR and select one matching architecture", () => {
  for (const { platform, arch } of TARGETS) {
    const config = createConfiguration({
      root: "/project",
      stage: "/stage",
      output: "/out",
      platform,
      arch,
    });
    assert.deepEqual(config.files, ["package.json", "main.cjs", "preload.cjs"]);
    assert.equal(config.extraResources[0].to, "service");
    assert.equal(config.extraResources[0].from, "/stage/service");
    assert.equal(config.electronFuses.runAsNode, false);
    for (const target of (platform === "darwin" ? config.mac : config.linux).target)
      assert.deepEqual(target.arch, [arch]);
  }
  assert.throws(() => getTarget("linux", "ia32"), /Unsupported/);
});

test("mac release mode requires identity and complete notarization credentials", () => {
  assert.throws(() => checkMacReleaseCredentials({}), /SIGNING/);
  assert.throws(() => checkMacReleaseCredentials({ CSC_LINK: "certificate" }), /NOTARIZATION/);
  assert.throws(
    () => checkMacReleaseCredentials({ CSC_LINK: "certificate", APPLE_API_KEY: "key" }),
    /NOTARIZATION/,
  );
  checkMacReleaseCredentials({
    CSC_LINK: "certificate",
    APPLE_API_KEY: "key",
    APPLE_API_KEY_ID: "id",
    APPLE_API_ISSUER: "issuer",
  });
  const config = createConfiguration({
    root: "/p",
    stage: "/s",
    output: "/o",
    platform: "darwin",
    arch: "arm64",
    release: true,
  });
  assert.equal(config.mac.forceCodeSigning, true);
  assert.equal(config.mac.hardenedRuntime, true);
  assert.equal(config.mac.notarize, true);
  assert.equal(config.mac.identity, undefined);
  assert.equal(config.publish, null);
});

test("release checksum assembly rejects partial, extra and wrong-version distributions", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-checksums-"));
  try {
    assert.throws(() => writeChecksums(directory, "0.2.1"), /asset set mismatch/);
    for (const file of expectedArtifacts("0.2.1"))
      fs.writeFileSync(path.join(directory, file), file);
    assert.equal(writeChecksums(directory, "0.2.1").length, 9);
    assert.match(
      fs.readFileSync(path.join(directory, "SHA256SUMS"), "utf8"),
      /^[a-f0-9]{64} {2}superstring-/,
    );
    fs.writeFileSync(path.join(directory, "unexpected.zip"), "extra");
    assert.throws(() => writeChecksums(directory, "0.2.1"), /asset set mismatch/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("smoke requires every real readiness check and the exact target identity", () => {
  const identity = { platform: "darwin", arch: "arm64", version: "0.2.1" };
  const report = {
    ...identity,
    ok: true,
    checks: { backend: true, renderer: true, authentication: true, gracefulStop: true },
  };
  validateSmokeReport(report, identity);
  assert.throws(() => validateSmokeReport({ ...report, arch: "x64" }, identity), /IDENTITY/);
  assert.throws(
    () =>
      validateSmokeReport(
        { ...report, checks: { ...report.checks, gracefulStop: false } },
        identity,
      ),
    /gracefulStop/,
  );
  assert.throws(() => validateSmokeReport({ ...report, ok: false }, identity), /FAILED/);
});

test("production notices retain complete original text and omit machine paths", () => {
  const manifest = { name: "superstring", version: "1.0.0", dependencies: { react: "19" } };
  const packages = {
    "superstring@1.0.0": { private: true },
    "react@19.0.0": {
      licenses: "MIT",
      licenseText: "Copyright React contributors\nPermission is hereby granted...",
      path: "/runner/private/project/node_modules/react",
      licenseFile: "/runner/private/project/node_modules/react/LICENSE",
      noticeFile: "/runner/private/project/node_modules/react/NOTICE",
    },
  };
  const inventory = publicLicenseInventory(packages, manifest, () => "Original NOTICE");
  assert.equal(inventory["react@19.0.0"].licenseText, packages["react@19.0.0"].licenseText);
  assert.equal(inventory["react@19.0.0"].noticeText, "Original NOTICE");
  assert.doesNotMatch(JSON.stringify(inventory), /\/runner\/|superstring@/);
  assert.throws(() => publicLicenseInventory({}, manifest), /omitted a direct dependency/);
  assert.throws(
    () => publicLicenseInventory({ "react@19.0.0": { licenses: "MIT" } }, manifest),
    /complete license notice/,
  );
});
