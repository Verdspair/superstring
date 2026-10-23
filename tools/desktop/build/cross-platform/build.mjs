import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Arch, build, Platform } from "electron-builder";
import { collectPackageFiles, readPackageVersion } from "../../../installer/package-files.mjs";
import { renderBrandAssets } from "../brand-assets.mjs";
import { stageStartupAppearance } from "../build-electron.mjs";
import { buildBrand } from "./brand.mjs";
import { writeChecksums } from "./checksums.mjs";
import {
  createConfiguration,
  getTarget,
  HOMEPAGE,
  macSigningPlan,
  normalizeMacSigningEnvironment,
  serviceRootForApp,
} from "./config.mjs";
import { writeProductionNotices } from "./licenses.mjs";
import { resolveProjectBun } from "./runtime-tools.mjs";

const root = fileURLToPath(new URL("../../../../", import.meta.url));
const { values } = parseArgs({
  options: {
    platform: { type: "string", default: process.platform },
    arch: { type: "string", default: process.arch },
    release: { type: "boolean", default: false },
    dir: { type: "boolean", default: false },
  },
});
const { platform, arch, release } = values;
getTarget(platform, arch);
if (platform !== process.platform || arch !== process.arch) {
  throw new Error("Build and smoke each desktop target on its native CI runner");
}
if (platform === "darwin") {
  normalizeMacSigningEnvironment(process.env);
}
const macSigning =
  platform === "darwin" && release ? macSigningPlan(process.env) : { signed: false, missing: [] };
if (platform === "darwin" && release && !macSigning.signed) {
  console.warn(
    `[mac] unsigned release build: ${macSigning.missing.join(", ")} not configured; the package is ad-hoc signed and not notarized`,
  );
}
const version = readPackageVersion(root);
const stage = path.join(root, "artifacts/desktop", `${platform}-${arch}`);
const output = path.join(root, "dist/desktop-packages", `${platform}-${arch}`);
function prepareEmpty(directory, label) {
  if (
    fs.existsSync(directory) &&
    (!fs.statSync(directory).isDirectory() || fs.readdirSync(directory).length > 0)
  )
    throw new Error(`${label} is not empty: ${directory}; review or move it before rebuilding`);
  fs.mkdirSync(directory, { recursive: true });
}
// These directories contain generated build inputs only, never user profiles. A
// previous candidate is evidence, not disposable input, so only empty dirs are reused.
prepareEmpty(stage, "Desktop build stage");
prepareEmpty(output, "Desktop package output");
function run(executable, args) {
  const result = spawnSync(executable, args, { cwd: root, stdio: "inherit" });
  if (result.error || result.status !== 0) {
    throw result.error ?? new Error(`Build failed (${result.status}): ${executable}`);
  }
}
const bun = resolveProjectBun(root);
const bunVersion = spawnSync(bun, ["--version"], { encoding: "utf8" });
if (bunVersion.error) throw bunVersion.error;
if (bunVersion.status !== 0) {
  throw new Error(`Bun version check failed (${bunVersion.status}): ${bunVersion.stderr.trim()}`);
}
const requiredBun = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).engines
  .bun;
if (bunVersion.stdout.trim() !== requiredBun) {
  throw new Error(`Desktop build requires Bun ${requiredBun}; found ${bunVersion.stdout.trim()}`);
}
run(process.execPath, [path.join(root, "node_modules/vite/bin/vite.js"), "build"]);
const host = path.join(stage, "host");
fs.mkdirSync(host, { recursive: true });
run(bun, [
  "build",
  "src/desktop/main.ts",
  "--target=node",
  "--format=cjs",
  "--external=electron",
  "--outfile",
  path.join(host, "main.cjs"),
]);
// The preload runs under sandbox:true, so it is bundled for the browser: a node-target
// bundle emits require/Node globals that a sandboxed preload cannot resolve.
run(bun, [
  "build",
  "src/desktop/preload.ts",
  "--target=browser",
  "--format=cjs",
  "--external=electron",
  "--outfile",
  path.join(host, "preload.cjs"),
]);
fs.writeFileSync(
  path.join(host, "package.json"),
  `${JSON.stringify(
    {
      name: "superstring",
      productName: "Superstring",
      version,
      main: "main.cjs",
      description:
        "A local Agent workspace for conversations, knowledge and connected communities.",
      license: "MIT",
      homepage: HOMEPAGE,
      author: { name: "Superstring contributors", url: HOMEPAGE },
    },
    null,
    2,
  )}\n`,
);
fs.copyFileSync(path.join(root, "src/desktop/startup.html"), path.join(host, "startup.html"));
// The startup panel's tokens and local fonts have one owner: the Windows candidate
// builder. Reusing it keeps the two Electron packages on the same source.
stageStartupAppearance(host);
const plateFrames = renderBrandAssets(root, path.join(stage, "brand-assets"), { source: "icon" });
const plate = plateFrames.find((frame) => frame.size === 256);
if (!plate) throw new Error("Missing 256px plate icon frame");
fs.copyFileSync(plate.file, path.join(host, "icon.png"));
const fonts = path.join(host, "fonts");
if (!fs.existsSync(fonts) || fs.readdirSync(fonts).length === 0)
  throw new Error("Startup appearance staged no local fonts");
const service = path.join(stage, "service");
fs.mkdirSync(service, { recursive: true });
run(bun, [
  "build",
  "--compile",
  "--root",
  ".",
  "--define",
  "SUPERSTRING_COMPILED=true",
  `--target=bun-${platform}-${arch}`,
  "--define",
  "SUPERSTRING_RELEASE=true",
  "--minify-syntax",
  "src/server/desktop-entry.ts",
  "src/server/agent/quickjs-worker.ts",
  // The QQ image worker must be its own compile entry: qq-image-worker.ts resolves the
  // entry file relative to import.meta.url, and a missing entry would break the scaling
  // and GIF-sampling paths in compiled products. These args are shared by
  // every target, so each compiled product carries the worker entry too.
  "src/server/services/qq-image-worker-entry.ts",
  "--outfile",
  path.join(service, "superstring-server"),
]);
fs.chmodSync(path.join(service, "superstring-server"), 0o755);
const resources = collectPackageFiles(root, service).map((file) => ({
  ...file,
  path: file.path.slice("app/".length),
}));
resources.push(...(await writeProductionNotices(root, service)));
fs.writeFileSync(
  path.join(service, "resource-manifest.json"),
  `${JSON.stringify({ version, platform, arch, files: resources }, null, 2)}\n`,
);
buildBrand(root, path.join(stage, "brand"), platform, run);
// The independent window has no tray; keep only the package icon beside the service.
fs.mkdirSync(path.join(service, "brand"), { recursive: true });
fs.copyFileSync(path.join(stage, "brand/icon.png"), path.join(service, "brand/icon.png"));
const config = createConfiguration({
  root,
  stage,
  output,
  platform,
  arch,
  release,
  macSigning: macSigning.signed ? "signed" : "unsigned",
});
const target = platform === "darwin" ? Platform.MAC : Platform.LINUX;
const artifacts = await build({
  config,
  targets: target.createTarget(values.dir ? ["dir"] : undefined, Arch[arch]),
  publish: "never",
  projectDir: root,
});
const app =
  platform === "darwin"
    ? path.join(output, arch === "arm64" ? "mac-arm64" : "mac", "superstring.app")
    : path.join(output, arch === "arm64" ? "linux-arm64-unpacked" : "linux-unpacked");
fs.writeFileSync(
  path.join(output, "build-result.json"),
  `${JSON.stringify(
    {
      version,
      platform,
      arch,
      release,
      ...(platform === "darwin" ? { macSigning: macSigning.signed ? "signed" : "unsigned" } : {}),
      app,
      serviceRoot: serviceRootForApp(platform, app),
      artifacts,
    },
    null,
    2,
  )}\n`,
);
writeChecksums(output);
console.log(`DESKTOP_OUTPUT=${output}`);
