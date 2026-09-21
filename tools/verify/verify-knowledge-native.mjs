import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const evidence = fs.mkdtempSync(path.join(root, "artifacts/validation/knowledge-native-"));
const csc = path.join(
  process.env.WINDIR || "C:/Windows",
  "Microsoft.NET/Framework64/v4.0.30319/csc.exe",
);
const checks = [];
function run(name, exe, args) {
  const result = spawnSync(exe, args, { cwd: root, encoding: "utf8", windowsHide: true });
  checks.push({
    name,
    passed: result.status === 0 && !result.error,
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error?.message,
  });
  fs.writeFileSync(path.join(evidence, "report.json"), JSON.stringify({ checks }, null, 2));
  assert.equal(
    result.status,
    0,
    `${name}: ${result.stdout} ${result.stderr} ${result.error ?? ""}`,
  );
  return result.stdout;
}
const fixture = path.join(evidence, "manifest-fixture.exe");
run("compile manifest fixture", csc, [
  "/nologo",
  "/target:exe",
  `/out:${fixture}`,
  "/reference:System.Web.Extensions.dll",
  path.join(root, "tools/verify/knowledge-manifest-fixture.cs"),
  path.join(root, "tools/setup/src/Manifest.cs"),
  path.join(root, "tools/setup/src/SemVer.cs"),
]);
const assertions = JSON.parse(run("manifest schema assertions", fixture, []));
const sources = fs
  .readdirSync(path.join(root, "tools/setup/src"))
  .filter((name) => name.endsWith(".cs"))
  .map((name) => path.join(root, "tools/setup/src", name));
const references =
  "C:/Program Files (x86)/Reference Assemblies/Microsoft/Framework/.NETFramework/v4.8/";
run("compile complete setup without creating a package", csc, [
  "/nologo",
  "/target:winexe",
  "/main:Superstring.Setup.Program",
  `/out:${path.join(evidence, "setup-validation.exe")}`,
  "/reference:System.Windows.Forms.dll",
  "/reference:System.Drawing.dll",
  "/reference:System.Core.dll",
  "/reference:System.Web.Extensions.dll",
  `/reference:${references}System.IO.Compression.dll`,
  `/reference:${references}System.IO.Compression.FileSystem.dll`,
  ...sources,
  path.join(root, "tools/desktop/src/MaintenanceLease.cs"),
  path.join(root, "tools/desktop/src/ProcessEnvironment.cs"),
]);
fs.writeFileSync(
  path.join(evidence, "report.json"),
  JSON.stringify(
    {
      passed: checks.every((check) => check.passed),
      assertions,
      checks,
      scope:
        "Synthetic manifest assertions and native compilation only; no install, user data or application launch.",
    },
    null,
    2,
  ),
);
console.log(JSON.stringify({ evidence, assertions, compileChecks: 2 }));
