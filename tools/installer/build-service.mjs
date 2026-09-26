import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectPackageFiles, recordProgram } from "./package-files.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// Unique staging batch: never merge an existing directory containing user data.
const parent = path.join(root, "artifacts/staging");
fs.mkdirSync(parent, { recursive: true });
const stage = fs.mkdtempSync(path.join(parent, "standalone-"));
const app = path.join(stage, "app");
const resources = path.join(app, "resources");
fs.mkdirSync(resources, { recursive: true });
function run(exe, args) {
  const result = spawnSync(exe, args, { cwd: root, encoding: "utf8", windowsHide: true });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error || result.status !== 0) throw result.error ?? new Error(`Build failed: ${exe}`);
}
run(process.execPath, [path.join(root, "node_modules/vite/bin/vite.js"), "build"]);
const bun = path.join(root, "node_modules/bun/bin/bun.exe");
run(bun, [
  "build",
  "--compile",
  "--define",
  "SUPERSTRING_RELEASE=true",
  "--minify-syntax",
  "./src/server/installed-entry.ts",
  "--outfile",
  path.join(app, "superstring-server.exe"),
]);
const manifest = collectPackageFiles(root, app);
recordProgram(app, manifest);
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version))
  throw new Error("Invalid package version");
fs.writeFileSync(
  path.join(stage, "build-manifest.json"),
  JSON.stringify(
    {
      manifestVersion: 1,
      product: "superstring",
      version,
      platform: "win32-x64",
      layoutVersion: 1,
      businessSchemaVersion: 47,
      kind: "standalone-verification-only",
      files: manifest,
    },
    null,
    2,
  ),
);
console.log(`STAGE=${stage}`);
