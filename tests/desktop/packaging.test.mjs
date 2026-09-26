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
  normalizeMacSigningEnvironment,
  TARGETS,
} from "../../tools/desktop/build/cross-platform/config.mjs";
import { publicLicenseInventory } from "../../tools/desktop/build/cross-platform/licenses.mjs";
import {
  preserveSmokeEvidence,
  resolveProjectBun,
} from "../../tools/desktop/build/cross-platform/runtime-tools.mjs";
import { validateSmokeReport } from "../../tools/desktop/build/cross-platform/smoke-contract.mjs";

test("all native targets keep bundled host dependencies external to builder and select one matching architecture", async () => {
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
    assert.notEqual(config.npmRebuild, false);
    assert.equal(await config.beforeBuild(), false);
    for (const target of (platform === "darwin" ? config.mac : config.linux).target)
      assert.deepEqual(target.arch, [arch]);
  }
  assert.throws(() => getTarget("linux", "ia32"), /Unsupported/);
});

test("mac release mode requires identity and complete notarization credentials", () => {
  const blank = { CSC_LINK: "  ", CSC_KEY_PASSWORD: "" };
  normalizeMacSigningEnvironment(blank);
  assert.equal(Object.hasOwn(blank, "CSC_LINK"), false);
  assert.equal(blank.CSC_KEY_PASSWORD, "");
  assert.throws(() => checkMacReleaseCredentials(blank), /SIGNING/);
  const configured = { CSC_LINK: "certificate" };
  normalizeMacSigningEnvironment(configured);
  assert.equal(configured.CSC_LINK, "certificate");
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
  assert.ok(expectedArtifacts("0.2.1").includes("superstring-0.2.1-linux-amd64.deb"));
  assert.ok(expectedArtifacts("0.2.1").includes("superstring-0.2.1-linux-x86_64.AppImage"));
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

test("Bun resolution follows the installed npm binary map on Unix as well as Windows", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-bun-path-"));
  try {
    const directory = path.join(root, "node_modules/bun");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, "package.json"),
      JSON.stringify({ bin: { bun: "bin/bun.exe" } }),
    );
    assert.equal(resolveProjectBun(root), path.join(directory, "bin/bun.exe"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("smoke diagnostics survive profile cleanup without copying profile data", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-smoke-evidence-"));
  try {
    const temporary = path.join(root, "synthetic");
    const destination = path.join(root, "artifacts");
    fs.mkdirSync(path.join(temporary, "profile/logs"), { recursive: true });
    fs.mkdirSync(destination);
    fs.writeFileSync(path.join(temporary, "report.json"), '{"ok":false}');
    fs.writeFileSync(path.join(temporary, "profile/logs/desktop.log"), "diagnostic");
    fs.writeFileSync(path.join(temporary, "profile/business.sqlite"), "not an artifact");
    preserveSmokeEvidence(temporary, destination);
    fs.rmSync(temporary, { recursive: true });
    assert.equal(
      fs.readFileSync(path.join(destination, "smoke-report.json"), "utf8"),
      '{"ok":false}',
    );
    assert.equal(
      fs.readFileSync(path.join(destination, "smoke-logs/desktop.log"), "utf8"),
      "diagnostic",
    );
    assert.deepEqual(fs.readdirSync(destination).sort(), ["smoke-logs", "smoke-report.json"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
