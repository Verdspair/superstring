import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  collectPackageFiles,
  fileRecord,
  readPackageVersion,
  recordProgram,
} from "./package-files.mjs";
import { attachPayload, writeZip } from "./zip-writer.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const version = readPackageVersion(root);
const build = path.join(root, "artifacts/build");
const packageDir = path.join(build, "package");
const setupDir = path.join(build, "setup");
const installers = path.join(root, "dist/installers");
fs.rmSync(packageDir, { recursive: true, force: true });
fs.mkdirSync(path.join(packageDir, "app"), { recursive: true });
fs.mkdirSync(setupDir, { recursive: true });
fs.mkdirSync(installers, { recursive: true });

function run(executable, args) {
  const result = spawnSync(executable, args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "inherit", "inherit"],
  });
  if (result.error || result.status !== 0)
    throw result.error ?? new Error(`Build step failed (${result.status}): ${executable}`);
}

const node = process.execPath;
const csc = path.join(
  process.env.WINDIR || "C:/Windows",
  "Microsoft.NET/Framework64/v4.0.30319/csc.exe",
);
const compressionReferences =
  "C:/Program Files (x86)/Reference Assemblies/Microsoft/Framework/.NETFramework/v4.8/";

console.log("1/6 building web assets and the installed launcher");
run(node, [path.join(root, "tools/desktop/build/build.mjs"), "--installed"]);
if (!fs.existsSync(path.join(root, "artifacts/build/desktop/superstring.ico")))
  throw new Error("Launcher icon was not generated");

console.log("2/6 compiling the standalone service");
run(path.join(root, "node_modules/bun/bin/bun.exe"), [
  "build",
  "--compile",
  "--define",
  "SUPERSTRING_RELEASE=true",
  "--minify-syntax",
  "./src/server/installed-entry.ts",
  "--outfile",
  path.join(packageDir, "app", "superstring-server.exe"),
]);

console.log("3/6 assembling the whitelisted payload");
const files = collectPackageFiles(root, path.join(packageDir, "app"));
recordProgram(path.join(packageDir, "app"), files);
const launcherSource = path.join(root, "dist/desktop/installed/superstring.exe");
if (!fs.existsSync(launcherSource)) throw new Error("Installed launcher is missing");
fs.copyFileSync(launcherSource, path.join(packageDir, "superstring.exe"));

const manifest = {
  manifestVersion: 1,
  product: "superstring",
  version,
  platform: "win32-x64",
  layoutVersion: 1,
  businessSchemaVersion: 4,
  kind: "full-package",
  files,
  launcher: fileRecord(path.join(packageDir, "superstring.exe"), "superstring.exe"),
};
fs.writeFileSync(
  path.join(packageDir, "build-manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);

console.log("4/6 compressing the payload");
const payload = path.join(setupDir, "payload.zip");
const zipped = writeZip(
  [
    { name: "superstring.exe", source: path.join(packageDir, "superstring.exe") },
    { name: "build-manifest.json", source: path.join(packageDir, "build-manifest.json") },
    {
      name: "app/superstring-server.exe",
      source: path.join(packageDir, "app/superstring-server.exe"),
    },
    ...files
      .filter((item) => item.path !== "app/superstring-server.exe")
      .map((item) => ({ name: item.path, source: path.join(packageDir, item.path) })),
  ],
  payload,
);

console.log("5/6 compiling the setup executable");
const setupSources = fs
  .readdirSync(path.join(root, "tools/setup/src"))
  .filter((name) => name.endsWith(".cs"))
  .map((name) => path.join(root, "tools/setup/src", name));
// Shared, already-tested native helpers (single implementation across artifacts).
setupSources.push(path.join(root, "tools/desktop/src/MaintenanceLease.cs"));
setupSources.push(path.join(root, "tools/desktop/src/ProcessEnvironment.cs"));
const setupExe = path.join(setupDir, "superstring-setup.exe");
run(csc, [
  "/nologo",
  "/target:winexe",
  "/main:Superstring.Setup.Program",
  `/out:${setupExe}`,
  `/win32icon:${path.join(root, "artifacts/build/desktop/superstring.ico")}`,
  `/win32manifest:${path.join(root, "tools/desktop/build/app.manifest")}`,
  "/reference:System.Windows.Forms.dll",
  "/reference:System.Drawing.dll",
  "/reference:System.Core.dll",
  "/reference:System.Web.Extensions.dll",
  `/reference:${compressionReferences}System.IO.Compression.dll`,
  `/reference:${compressionReferences}System.IO.Compression.FileSystem.dll`,
  ...setupSources,
]);

console.log("6/6 producing the self-contained setup package");
const installer = path.join(installers, `superstring-setup-${version}.exe`);
const total = attachPayload(setupExe, payload, installer);
const digest = createHash("sha256").update(fs.readFileSync(installer)).digest("hex");
fs.writeFileSync(`${installer}.sha256`, `${digest}  ${path.basename(installer)}\n`);
console.log(
  JSON.stringify(
    {
      installer,
      bytes: total,
      sha256: digest,
      version,
      payloadEntries: zipped.entries,
      payloadBytes: zipped.bytes,
      manifestFiles: manifest.files.length,
    },
    null,
    2,
  ),
);
