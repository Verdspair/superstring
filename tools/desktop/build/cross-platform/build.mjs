import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Arch, build, Platform } from "electron-builder";
import { collectPackageFiles, readPackageVersion } from "../../../installer/package-files.mjs";
import { buildBrand } from "./brand.mjs";
import { writeChecksums } from "./checksums.mjs";
import { checkMacReleaseCredentials, createConfiguration, getTarget, HOMEPAGE } from "./config.mjs";
import { writeProductionNotices } from "./licenses.mjs";

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
if (release && platform === "darwin") checkMacReleaseCredentials(process.env);
const version = readPackageVersion(root);
const stage = path.join(root, "artifacts/desktop", `${platform}-${arch}`);
const output = path.join(root, "dist/desktop-packages", `${platform}-${arch}`);
// These directories contain generated build inputs only, never user profiles.
fs.rmSync(stage, { recursive: true, force: true });
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
fs.mkdirSync(output, { recursive: true });
function run(executable, args) {
  const result = spawnSync(executable, args, { cwd: root, stdio: "inherit" });
  if (result.error || result.status !== 0) {
    throw result.error ?? new Error(`Build failed (${result.status}): ${executable}`);
  }
}
const bun = path.join(root, "node_modules/bun/bin/bun");
const bunVersion = spawnSync(bun, ["--version"], { encoding: "utf8" });
const requiredBun = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).engines
  .bun;
if (bunVersion.status !== 0 || bunVersion.stdout.trim() !== requiredBun) {
  throw new Error(`Desktop build requires the project-pinned Bun ${requiredBun}`);
}
run(process.execPath, [path.join(root, "node_modules/vite/bin/vite.js"), "build"]);
const host = path.join(root, "dist/desktop-host");
fs.rmSync(host, { recursive: true, force: true });
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
run(bun, [
  "build",
  "src/desktop/preload.ts",
  "--target=node",
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
const service = path.join(stage, "service");
fs.mkdirSync(service, { recursive: true });
run(bun, [
  "build",
  "--compile",
  `--target=bun-${platform}-${arch}`,
  "--define",
  "SUPERSTRING_RELEASE=true",
  "--minify-syntax",
  "src/server/desktop-entry.ts",
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
// Runtime tray assets stay outside app.asar; main can load them as native images.
fs.mkdirSync(path.join(service, "brand"), { recursive: true });
for (const size of [16, 32]) {
  fs.copyFileSync(
    path.join(stage, "brand/icons", `${size}x${size}.png`),
    path.join(service, "brand", size === 16 ? "trayTemplate.png" : "trayTemplate@2x.png"),
  );
}
fs.copyFileSync(path.join(stage, "brand/icon.png"), path.join(service, "brand/icon.png"));
const config = createConfiguration({ root, stage, output, platform, arch, release });
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
  `${JSON.stringify({ version, platform, arch, release, app, artifacts }, null, 2)}\n`,
);
writeChecksums(output);
console.log(`DESKTOP_OUTPUT=${output}`);
