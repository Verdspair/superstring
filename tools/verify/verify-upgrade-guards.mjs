import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkUpgradeIdentity,
  compareVersions,
  requireAvailableSpace,
  upgradeSpaceBudget,
} from "../installer/upgrade-policy.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const evidence = fs.mkdtempSync(path.join(root, "artifacts/validation/upgrade-guards-"));
const fixtureRoot = path.join(evidence, "安装 空格");
fs.mkdirSync(fixtureRoot);
const exe = path.join(evidence, "lease-fixture.exe");
const csc = path.join(
  process.env.WINDIR || "C:/Windows",
  "Microsoft.NET/Framework64/v4.0.30319/csc.exe",
);
const compiled = spawnSync(
  csc,
  [
    "/nologo",
    "/target:exe",
    `/out:${exe}`,
    path.join(root, "tools/verify/maintenance-lease-fixture.cs"),
    path.join(root, "tools/desktop/src/MaintenanceLease.cs"),
  ],
  { encoding: "utf8", windowsHide: true },
);
if (compiled.status !== 0) throw Error(compiled.stdout + compiled.stderr);
const checks = [];
function test(name, fn) {
  fn();
  checks.push({ name, pass: true });
}
const base = {
  manifestVersion: 1,
  product: "superstring",
  platform: "win32-x64",
  layoutVersion: 1,
  businessSchemaVersion: 1,
  version: "0.1.0-dev",
};
const holders = [];
async function hold(mode) {
  const child = spawn(exe, [fixtureRoot, mode, "hold"], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  holders.push(child);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error("Lease fixture timeout")), 5000);
    child.stdout.once("data", (b) => {
      clearTimeout(timer);
      b.toString().includes("LEASE_ACQUIRED") ? resolve() : reject(Error("Lease fixture rejected"));
    });
    child.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
  return child;
}
function attempt(mode) {
  const r = spawnSync(exe, [fixtureRoot, mode], { windowsHide: true, timeout: 5000 });
  if (r.error) throw r.error;
  return r.status;
}
async function release(child, crash = false) {
  await new Promise((resolve, reject) => {
    if (child.exitCode !== null) return resolve();
    const timer = setTimeout(() => reject(Error("Fixture exit timeout")), 5000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    if (crash) child.kill();
    else child.stdin.end("release\n");
  });
}
try {
  test("numeric versions are not lexical", () =>
    assert.equal(compareVersions("0.10.0", "0.9.0"), 1));
  test("release follows prerelease", () => assert.equal(compareVersions("0.1.0", "0.1.0-dev"), 1));
  test("numeric prerelease uses numeric comparison", () =>
    assert.equal(compareVersions("1.0.0-rc.10", "1.0.0-rc.2"), 1));
  test("build metadata does not affect order", () =>
    assert.equal(compareVersions("1.0.0+abc", "1.0.0+xyz"), 0));
  test("leading zero prerelease rejected", () =>
    assert.throws(() => compareVersions("1.0.0-01", "1.0.0")));
  test("downgrade refused", () =>
    assert.throws(() => checkUpgradeIdentity({ ...base, version: "0.2.0" }, base), /DOWNGRADE/));
  test("same version explicitly classified", () =>
    assert.equal(checkUpgradeIdentity(base, base), "same-version-reinstall"));
  test("forward version classified", () =>
    assert.equal(checkUpgradeIdentity(base, { ...base, version: "0.1.0" }), "upgrade"));
  test("unknown schema refuses automatic upgrade", () =>
    assert.throws(() => checkUpgradeIdentity(base, { ...base, businessSchemaVersion: 2 })));
  test("wrong product rejected", () =>
    assert.throws(() => checkUpgradeIdentity(base, { ...base, product: "other" })));
  test("space budget accounts for copies and backup", () =>
    assert.equal(
      upgradeSpaceBudget({
        incomingBytes: 100n,
        currentProgramBytes: 80n,
        userDataBytes: 50n,
        reserveBytes: 20n,
      }),
      400n,
    ));
  test("large byte counts retain precision", () =>
    assert.equal(
      upgradeSpaceBudget({
        incomingBytes: 9007199254740993n,
        currentProgramBytes: 0n,
        userDataBytes: 0n,
        reserveBytes: 0n,
      }),
      18014398509481986n,
    ));
  test("negative bytes rejected", () =>
    assert.throws(() =>
      upgradeSpaceBudget({ incomingBytes: -1n, currentProgramBytes: 0n, userDataBytes: 0n }),
    ));
  test("insufficient space rejected", () => assert.throws(() => requireAvailableSpace(399n, 400n)));
  test("exact space accepted", () => requireAvailableSpace(400n, 400n));
  const runtime = await hold("runtime");
  test("runtime allows second runtime reader", () => assert.equal(attempt("runtime"), 0));
  test("runtime blocks maintenance process", () => assert.equal(attempt("maintenance"), 3));
  await release(runtime);
  const maintenance = await hold("maintenance");
  test("maintenance blocks new runtime", () => assert.equal(attempt("runtime"), 3));
  test("maintenance blocks second maintenance", () => assert.equal(attempt("maintenance"), 3));
  await release(maintenance, true); // This is a lock-only fixture, never a real server/database.
  test("OS releases lease after fixture crash", () => assert.equal(attempt("maintenance"), 0));
  test("stable lock file retained rather than deleted", () =>
    assert.equal(fs.statSync(path.join(fixtureRoot, "maintenance/operation.lock")).size, 0));
} catch (error) {
  process.exitCode = 1;
  checks.push({ name: String(error), pass: false });
} finally {
  for (const child of holders)
    if (child.exitCode === null) await release(child).catch(() => child.kill());
  fs.writeFileSync(
    path.join(evidence, "report.json"),
    JSON.stringify(
      {
        checks,
        note: "Native launcher lease and pure upgrade policy only. Service lifetime, installer transactions, actual space measurement and recovery not yet integrated.",
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      evidence,
      passed: checks.filter((x) => x.pass).length,
      failed: checks.filter((x) => !x.pass).length,
    }),
  );
}
