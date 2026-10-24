/**
 * Windows installer assembly for the Electron desktop.
 *
 * The package is the installation root R with exactly these pieces:
 *   R/superstring.exe             headless C# DesktopHost (job owner, single instance, no UI)
 *   R/build-manifest.json         schema 1 manifest: identity + every file under app/
 *   R/app/**                      promoted desktop candidate: pinned Electron runtime with the
 *                                 applied fuse wire, resources/app.asar, the compiled installed
 *                                 entry, the business migrations, web assets and notices
 *   R/app/desktop-host.json       installed host config (projectRoot ".." = R, electron.exe beside it)
 *   R/app/superstring.ico         plate icon: the setup EXE resource and the shortcut icon source
 *
 * The candidate itself is assembled by tools/desktop/build/build-electron.mjs and is never
 * promoted from dist/: this script only lifts its app/ tree, headless host and icon into the
 * payload. No installer is run here; producing one is a separate, explicitly authorised step.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildElectronDesktop } from "../desktop/build/build-electron.mjs";
import { resolveProjectBun } from "../desktop/build/cross-platform/runtime-tools.mjs";
import { collectPackageFiles, fileRecord, readPackageVersion } from "./package-files.mjs";
import { attachPayload, writeZip } from "./zip-writer.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const version = readPackageVersion(root);
const build = path.join(root, "artifacts/build");
const setupDir = path.join(build, "setup");
const installers = path.join(root, "dist/installers");
fs.mkdirSync(build, { recursive: true });
fs.mkdirSync(setupDir, { recursive: true });
fs.mkdirSync(installers, { recursive: true });
// An earlier package tree is evidence, not scratch: every run assembles into a fresh unique
// batch directory, so nothing that already exists under artifacts/build/package-* is deleted.
const batch = fs.mkdtempSync(path.join(build, "package-"));
const packageDir = path.join(batch, "payload");
const appDirectory = path.join(packageDir, "app");
const candidateDir = path.join(batch, "desktop-candidate");
fs.mkdirSync(appDirectory, { recursive: true });

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

// The manifest names the app/ tree exactly once, so setup verification, the launcher
// preflight and the archive all read the same list. Sorted for a reproducible payload.
function collectAppRecords(directory, prefix = "") {
  const records = [];
  for (const entry of fs
    .readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name, "en"))) {
    const filename = path.join(directory, entry.name);
    const relative = `${prefix}${entry.name}`;
    if (entry.isSymbolicLink()) throw new Error(`Release input must not be a link: ${filename}`);
    if (entry.isDirectory()) {
      records.push(...collectAppRecords(filename, `${relative}/`));
      continue;
    }
    if (!entry.isFile()) throw new Error(`Release input must be a regular file: ${filename}`);
    records.push({
      path: `app/${relative}`,
      sha256: createHash("sha256").update(fs.readFileSync(filename)).digest("hex"),
    });
  }
  return records;
}

const node = process.execPath;
const csc = path.join(
  process.env.WINDIR || "C:/Windows",
  "Microsoft.NET/Framework64/v4.0.30319/csc.exe",
);
const compressionReferences =
  "C:/Program Files (x86)/Reference Assemblies/Microsoft/Framework/.NETFramework/v4.8/";

const bun = resolveProjectBun(root);

// The desktop candidate owns the host bundle, the asar, the fuse wire and the icon; the
// package owns the served web assets, so they are built once here for both to consume.
console.log("1/9 building the web assets");
run(node, [path.join(root, "node_modules/vite/bin/vite.js"), "build"]);

console.log("2/9 assembling the Electron desktop candidate");
const desktop = await buildElectronDesktop({
  projectRoot: root,
  out: candidateDir,
  layout: "managed-profile",
});

console.log("3/9 promoting the desktop runtime");
// app/ is copied while it still holds only the candidate runtime (app.asar, the Electron
// binaries, the produced notices); the payload's own names are written afterwards, so no
// producer has to overwrite another one's file.
fs.cpSync(path.join(desktop.output, "app"), appDirectory, { recursive: true });

console.log("4/9 compiling the installed service");
run(bun, [
  "build",
  "--compile",
  "--root",
  ".",
  "--define",
  "SUPERSTRING_COMPILED=true",
  "--define",
  "SUPERSTRING_RELEASE=true",
  "--minify-syntax",
  "./src/server/installed-entry.ts",
  "./src/server/agent/quickjs-worker.ts",
  // The QQ image worker must be its own compile entry: qq-image-worker.ts resolves the
  // entry file relative to import.meta.url, and a missing entry would break the scaling
  // and GIF-sampling paths in compiled products.
  "./src/server/services/qq-image-worker-entry.ts",
  "--outfile",
  path.join(appDirectory, "superstring-server.exe"),
]);

console.log("5/9 adding the business resources, icon and host config");
collectPackageFiles(root, appDirectory);
fs.copyFileSync(
  path.join(desktop.output, "stage", "superstring.ico"),
  path.join(appDirectory, "superstring.ico"),
);
fs.copyFileSync(
  path.join(desktop.output, "stage", "superstring.exe"),
  path.join(packageDir, "superstring.exe"),
);
// The headless host reads <exe dir>/app/desktop-host.json: the config sits beside the
// Electron executable it names, and projectRoot ".." resolves back to the install root.
// One file, one location; there is no search or fallback for a missing config.
fs.writeFileSync(
  path.join(appDirectory, "desktop-host.json"),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      installed: true,
      projectRoot: "..",
      electronExecutable: "electron.exe",
    },
    null,
    2,
  )}\n`,
);
for (const required of [
  "electron.exe",
  "resources/app.asar",
  "superstring-server.exe",
  "superstring.ico",
  "desktop-host.json",
]) {
  if (!fs.existsSync(path.join(appDirectory, required)))
    throw new Error(`Payload is missing app/${required}`);
}

console.log("6/9 recording the payload manifest");
const files = collectAppRecords(appDirectory);
const manifest = {
  manifestVersion: 1,
  product: "superstring",
  version,
  platform: "win32-x64",
  layoutVersion: 1,
  businessSchemaVersion: 72,
  kind: "full-package",
  files,
  launcher: fileRecord(path.join(packageDir, "superstring.exe"), "superstring.exe"),
};
fs.writeFileSync(
  path.join(packageDir, "build-manifest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);

console.log("7/9 compressing the payload");
const payload = path.join(setupDir, "payload.zip");
// The three root entries are the launcher, its manifest and nothing else: the host config,
// the icon and the runtime all live under app/, which is also what the manifest may name.
const zipped = writeZip(
  [
    { name: "superstring.exe", source: path.join(packageDir, "superstring.exe") },
    { name: "build-manifest.json", source: path.join(packageDir, "build-manifest.json") },
    ...files.map((item) => ({
      name: item.path,
      source: path.join(packageDir, ...item.path.split("/")),
    })),
  ],
  payload,
);

console.log("8/9 compiling the setup executable");
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
  `/win32icon:${path.join(appDirectory, "superstring.ico")}`,
  `/win32manifest:${path.join(root, "tools/desktop/build/app.manifest")}`,
  "/reference:System.Windows.Forms.dll",
  "/reference:System.Drawing.dll",
  "/reference:System.Core.dll",
  "/reference:System.Web.Extensions.dll",
  `/reference:${compressionReferences}System.IO.Compression.dll`,
  `/reference:${compressionReferences}System.IO.Compression.FileSystem.dll`,
  ...setupSources,
]);

fs.writeFileSync(
  path.join(build, "latest-desktop-package.json"),
  `${JSON.stringify({ packageDir, version }, null, 2)}\n`,
);
console.log("9/9 producing the self-contained setup package");
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
      assembly: batch,
      desktopCandidate: desktop.output,
      electron: desktop.electron,
      payloadEntries: zipped.entries,
      payloadBytes: zipped.bytes,
      manifestFiles: manifest.files.length,
    },
    null,
    2,
  ),
);
