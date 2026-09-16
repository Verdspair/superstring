import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const setup = path.join(root, `dist/installers/superstring-setup-${version}.exe`);
if (!fs.existsSync(setup)) throw new Error("Build the installer first");
const evidence = fs.mkdtempSync(path.join(root, "artifacts/validation/setup-ui-"));
const fixture = path.join(evidence, "setup-ui-fixture.exe");
const csc = path.join(
  process.env.WINDIR || "C:/Windows",
  "Microsoft.NET/Framework64/v4.0.30319/csc.exe",
);
function run(executable, args) {
  const result = spawnSync(executable, args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    timeout: 120000,
  });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  if (result.error || result.status !== 0) {
    throw (
      result.error ?? new Error(`UI acceptance failed (${result.status}); evidence: ${evidence}`)
    );
  }
}
run(csc, [
  "/nologo",
  "/target:exe",
  `/out:${fixture}`,
  `/win32manifest:${path.join(root, "tools/desktop/build/app.manifest")}`,
  "/reference:System.Windows.Forms.dll",
  "/reference:System.Drawing.dll",
  "/reference:System.Web.Extensions.dll",
  path.join(root, "tools/verify/setup-ui-fixture.cs"),
]);
run(fixture, [setup, evidence]);
console.log(JSON.stringify({ evidence }));
