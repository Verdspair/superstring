import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generatePalette } from "./palette.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const src = path.join(root, "tools/desktop/src");
const validation = process.argv.includes("--validation");
const installed = validation || process.argv.includes("--installed");
const out = path.join(
  root,
  validation
    ? "artifacts/build/desktop-validation"
    : installed
      ? "dist/desktop/installed"
      : "dist/desktop",
);
const intermediate = path.join(root, "artifacts/build/desktop");
const csc = path.join(
  process.env.WINDIR || "C:/Windows",
  "Microsoft.NET/Framework64/v4.0.30319/csc.exe",
);
fs.mkdirSync(out, { recursive: true });
fs.mkdirSync(intermediate, { recursive: true });
function run(exe, args) {
  const r = spawnSync(exe, args, {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    timeout: 60000,
  });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.error || r.status !== 0)
    throw new Error(`Build step failed (${r.status}): ${r.error || exe}`);
}
// Desktop startup never builds; prepare the web assets once at build time.
run(process.execPath, [path.join(root, "node_modules/vite/bin/vite.js"), "build"]);
const iconBuilder = path.join(intermediate, "IconBuilder.exe");
run(csc, [
  "/nologo",
  "/target:exe",
  `/out:${iconBuilder}`,
  "/reference:System.Drawing.dll",
  path.join(src, "IconBuilder.cs"),
  path.join(src, "GlyphRenderer.cs"),
]);
run(iconBuilder, [path.join(intermediate, "superstring.ico")]);
const sources = fs
  .readdirSync(src)
  .filter((x) => x.endsWith(".cs") && x !== "IconBuilder.cs")
  .map((x) => path.join(src, x));
sources.push(generatePalette(root, intermediate));
// One version source for native/resource identity; never increment during builds.
const packageVersion = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(packageVersion))
  throw new Error("Invalid package version");
const identitySource = path.join(intermediate, "PackageIdentity.g.cs");
fs.writeFileSync(
  identitySource,
  `namespace Superstring.Desktop { internal static class PackageIdentity { internal const string Version = "${packageVersion}"; } }\n`,
);
sources.push(identitySource);

import { prepareCaseSlot } from "./case-rename.mjs";

const finalExe = path.join(out, "superstring.exe");
// Move any OLD-cased prior build (e.g. Superstring.exe) out of the way BEFORE csc runs,
// so the freshly compiled file lands as a real lowercase "superstring.exe".
const slot = prepareCaseSlot(out, "superstring.exe");
try {
  run(csc, [
    "/nologo",
    "/target:winexe",
    ...(installed ? ["/define:INSTALLED"] : []),
    ...(validation ? ["/define:VALIDATION"] : []),
    "/main:Superstring.Desktop.Program",
    `/out:${finalExe}`,
    `/win32icon:${path.join(intermediate, "superstring.ico")}`,
    `/win32manifest:${path.join(root, "tools/desktop/build/app.manifest")}`,
    ...["System.Windows.Forms", "System.Drawing", "System.Core", "System.Web.Extensions"].map(
      (x) => `/reference:${x}.dll`,
    ),
    ...sources,
  ]);
  slot.commit();
} catch (e) {
  // Protect both spelling variants, including partial compiler output.
  try {
    slot.restore();
  } catch (restoreError) {
    throw new AggregateError(
      [e, restoreError],
      `Build and restore failed; preserve ${slot.backup}`,
    );
  }
  throw e;
}
console.log(`Built: ${finalExe}`);
