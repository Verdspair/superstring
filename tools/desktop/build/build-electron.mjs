/**
 * Windows Electron desktop candidate builder.
 *
 * It assembles a self-contained candidate tree in an isolated output directory:
 *   <out>/app/                      pinned Electron runtime (electron.exe + resources)
 *   <out>/app/resources/app.asar    main.cjs, preload.cjs, startup.html, package.json
 *   <out>/app/resources/app.asar.unpacked/  native modules excluded from the archive
 *                                   (koffi runtime chain, platform native module,
 *                                    window-proc bridge DLL)
 *   <out>/stage/desktop-host.json   explicit projectRoot for the headless host
 *   <out>/stage/superstring.exe     headless C# DesktopHost (job owner, single instance)
 *   <out>/build-result.json         versions, sizes, sha256 of every staged artifact
 *
 * Nothing here promotes a candidate: dist/desktop and the release tree are never inputs
 * or outputs, and the real development store is only named in desktop-host.json — the
 * builder never opens or copies it.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createPackageWithOptions } from "@electron/asar";
import {
  FuseState,
  FuseV1Options,
  FuseVersion,
  flipFuses,
  getCurrentFuseWire,
} from "@electron/fuses";
import postcss from "postcss";
import { renderBrandAssets } from "./brand-assets.mjs";
import { writeProductionNotices } from "./cross-platform/licenses.mjs";
import { resolveProjectBun } from "./cross-platform/runtime-tools.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const HOST_CONFIG_NAME = "desktop-host.json";
const HOST_SCHEMA_VERSION = 1;
const FORBIDDEN_OUTPUTS = ["dist", "release", "data", "local", "node_modules"];

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    timeout: options.timeout ?? 600_000,
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error || result.status !== 0) {
    throw new Error(
      `Desktop build step failed (${result.status ?? result.error?.code}): ${executable} ${args.join(" ")}`,
    );
  }
  return result;
}

function writeExclusive(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // COPYFILE_EXCL-equivalent for generated output: a reused candidate is a mistake,
  // not something to silently overwrite.
  fs.writeFileSync(file, contents, { encoding: "utf8", flag: "wx" });
}

function assertAbsolute(name, value) {
  if (typeof value !== "string" || value.length === 0 || !path.isAbsolute(value)) {
    throw new Error(`Desktop build requires an absolute --${name}; got ${JSON.stringify(value)}`);
  }
  // Trailing separators are the only accepted spelling difference: the host compares the
  // canonical path, so a padded input would otherwise claim a different single instance.
  return path.resolve(value);
}

export function stageStartupAppearance(packageDirectory) {
  const appearance = postcss.root();
  const source = postcss.parse(fs.readFileSync(path.join(root, "src/web/styles.css"), "utf8"));
  source.each((rule) => {
    if (rule.type !== "rule") return;
    if (
      rule.selectors.every(
        (selector) =>
          selector === ":root" ||
          selector === ".dark" ||
          (/^html\[data-(theme|font|text-size|interface-size)=/.test(selector) &&
            !selector.includes(" ")),
      )
    ) {
      appearance.append(rule.clone());
    }
  });
  const webAssets = path.join(root, "dist/web/assets");
  for (const filename of fs.readdirSync(webAssets).filter((file) => file.endsWith(".css"))) {
    const compiled = postcss.parse(fs.readFileSync(path.join(webAssets, filename), "utf8"));
    compiled.walkAtRules("font-face", (rule) => {
      const clone = rule.clone();
      clone.walkDecls("src", (declaration) => {
        declaration.value = declaration.value.replace(
          /url\(["']?([^)'"\s]+)["']?\)/g,
          (match, url) => {
            if (url.startsWith("data:")) return match;
            const name = path.basename(url);
            if (!name.endsWith(".woff2")) throw new Error(`Unsupported startup font: ${url}`);
            const target = path.join(packageDirectory, "fonts", name);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            if (!fs.existsSync(target)) fs.copyFileSync(path.join(webAssets, name), target);
            return `url("superstring://startup/fonts/${name}")`;
          },
        );
      });
      appearance.append(clone);
    });
  }
  fs.writeFileSync(path.join(packageDirectory, "appearance.css"), appearance.toString());
}

export async function buildElectronDesktop(options) {
  const {
    projectRoot,
    out,
    layout = "development-legacy",
    serviceRoot = "",
    runtime: stageRuntime = true,
    hostSources,
  } = options;
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new Error(
      `The Windows Electron candidate must be built on win32-x64 (${process.platform}-${process.arch})`,
    );
  }
  // The bridge DLL is compiled with the caller-supplied portable Zig. Nothing here
  // downloads, installs or searches PATH, so a missing toolchain fails before any output.
  const zig = options.zig ?? process.env.SUPERSTRING_ZIG_EXE ?? "";
  if (!path.isAbsolute(zig) || !fs.existsSync(zig) || !fs.statSync(zig).isFile()) {
    throw new Error(
      "Desktop build requires an absolute Zig executable (portable Zig 0.13, win32-x64 bridge): " +
        `pass --zig=<absolute zig.exe> or set SUPERSTRING_ZIG_EXE; got ${JSON.stringify(zig)}. ` +
        "The build never downloads, installs or searches PATH for a compiler.",
    );
  }
  if (layout !== "development-legacy" && layout !== "managed-profile") {
    throw new Error(`Unsupported desktop layout: ${layout}`);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const pinnedElectron = manifest.devDependencies?.electron ?? manifest.dependencies?.electron;
  const electronPackage = path.join(root, "node_modules", "electron");
  const electronVersion = JSON.parse(
    fs.readFileSync(path.join(electronPackage, "package.json"), "utf8"),
  ).version;
  if (electronVersion !== pinnedElectron) {
    throw new Error(
      `Electron runtime ${electronVersion} does not match the pinned ${pinnedElectron}`,
    );
  }
  const electronDist = path.join(electronPackage, "dist");
  const runtimeExecutable = path.join(electronDist, "electron.exe");
  if (stageRuntime && !fs.existsSync(runtimeExecutable)) {
    throw new Error(`Pinned Electron runtime is not installed: ${runtimeExecutable}`);
  }
  const output = assertAbsolute("out", out);
  const relative = path.relative(root, output);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`--out must stay inside the development tree: ${output}`);
  }
  const firstSegment = relative.split(/[\\/]/)[0].toLowerCase();
  if (FORBIDDEN_OUTPUTS.includes(firstSegment)) {
    throw new Error(
      `--out must not write into ${firstSegment}/; candidates stay in the batch area`,
    );
  }
  if (fs.existsSync(output) && fs.readdirSync(output).length > 0) {
    throw new Error(`Candidate output is not empty: ${output}`);
  }
  const declaredRoot = assertAbsolute("project-root", projectRoot);
  if (!fs.existsSync(path.join(declaredRoot, "package.json"))) {
    throw new Error(`--project-root is not a Superstring project tree: ${declaredRoot}`);
  }
  if (declaredRoot !== root) {
    throw new Error(
      `This candidate builder targets the development tree that contains it: ${root}`,
    );
  }
  const declaredService = serviceRoot ? assertAbsolute("service-root", serviceRoot) : "";
  if (declaredService) {
    if (!fs.existsSync(path.join(declaredService, "resource-manifest.json"))) {
      throw new Error(`--service-root has no resource-manifest.json: ${declaredService}`);
    }
  }

  const appDirectory = path.join(output, "app");
  const packageDirectory = path.join(appDirectory, "resources", "app");
  const stageDirectory = path.join(output, "stage");
  fs.mkdirSync(packageDirectory, { recursive: true });
  fs.mkdirSync(stageDirectory, { recursive: true });

  const bun = resolveProjectBun(root);
  const hostEntries = [
    // koffi is resolved lazily at runtime from the staged node_modules, never bundled.
    ["src/desktop/main.ts", "main.cjs", "--target=node", ["--external=koffi"]],
    ["src/desktop/preload.ts", "preload.cjs", "--target=browser", []],
    ["src/desktop/motion-overlay-preload.ts", "motion-overlay-preload.cjs", "--target=browser", []],
  ];
  for (const [source, target, bundleTarget, extra] of hostEntries) {
    run(bun, [
      "build",
      source,
      bundleTarget,
      "--format=cjs",
      "--external=electron",
      ...extra,
      "--outfile",
      path.join(packageDirectory, target),
    ]);
  }
  // The lazy koffi import in main stays external, so the runtime loader resolves it from
  // node_modules at require time. Only the installed 3.3.3 runtime surface is staged: the
  // package entry chain plus the platform native module, never the full dependency tree.
  const koffiSource = path.join(root, "node_modules", "koffi");
  const koffiVersion = JSON.parse(
    fs.readFileSync(path.join(koffiSource, "package.json"), "utf8"),
  ).version;
  const pinnedKoffi = manifest.dependencies?.koffi;
  if (pinnedKoffi !== koffiVersion) {
    throw new Error(`Koffi runtime ${koffiVersion} does not match the pinned ${pinnedKoffi}`);
  }
  const koffiPackageDirectory = path.join(packageDirectory, "node_modules", "koffi");
  for (const entry of [
    "package.json",
    "index.cjs",
    "src/koffi/index.cjs",
    "src/koffi/src/static.cjs",
    "LICENSE.txt",
  ]) {
    const source = path.join(koffiSource, entry);
    const target = path.join(koffiPackageDirectory, entry);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
  const platformPackage = path.join(
    packageDirectory,
    "node_modules",
    "@koromix",
    `koffi-win32-${process.arch}`,
  );
  fs.cpSync(
    path.join(root, "node_modules", "@koromix", `koffi-win32-${process.arch}`),
    platformPackage,
    { recursive: true },
  );

  const iconFrames = renderBrandAssets(root, path.join(output, "build-assets"), {
    source: "icon",
  });
  fs.copyFileSync(
    iconFrames.find((frame) => frame.size === 256).file,
    path.join(packageDirectory, "icon.png"),
  );
  const startupSource = path.join(root, "src", "desktop", "startup.html");
  fs.copyFileSync(startupSource, path.join(packageDirectory, "startup.html"));
  fs.copyFileSync(
    path.join(root, "src", "desktop", "motion-overlay.html"),
    path.join(packageDirectory, "motion-overlay.html"),
  );
  stageStartupAppearance(packageDirectory);
  writeExclusive(
    path.join(packageDirectory, "package.json"),
    `${JSON.stringify(
      {
        name: "superstring",
        productName: "Superstring",
        version: manifest.version,
        main: "main.cjs",
        description:
          "A local Agent workspace for conversations, knowledge and connected communities.",
        license: "MIT",
      },
      null,
      2,
    )}\n`,
  );

  if (stageRuntime) {
    fs.cpSync(electronDist, appDirectory, { recursive: true });
    // Electron loads resources/app when it exists; the shipped default app must not
    // shadow it, and deleting it only affects this generated copy.
    const defaultApp = path.join(appDirectory, "resources", "default_app.asar");
    if (fs.existsSync(defaultApp)) fs.rmSync(defaultApp);
  }

  const csc =
    options.csc ??
    path.join(
      process.env.WINDIR || "C:/Windows",
      "Microsoft.NET",
      "Framework64",
      "v4.0.30319",
      "csc.exe",
    );
  const intermediate = path.join(output, "build-assets");
  const iconBuilder = path.join(intermediate, "IconBuilder.exe");
  run(csc, [
    "/nologo",
    "/target:exe",
    `/out:${iconBuilder}`,
    "/reference:System.Drawing.dll",
    path.join(root, "tools/desktop/src/IconBuilder.cs"),
    path.join(root, "tools/desktop/src/GlyphRenderer.cs"),
  ]);
  const icon = path.join(stageDirectory, "superstring.ico");
  run(iconBuilder, [icon, "--png-dir", path.dirname(iconFrames[0].file)]);
  fs.copyFileSync(icon, path.join(packageDirectory, "superstring.ico"));
  // The window procedure bridge is product C, compiled into the intermediate directory so
  // Zig's generated import library stays behind: only the DLL is copied into the package,
  // and the unpack rule below ships it outside the archive for the runtime Koffi loader.
  const bridgeSource = path.join(root, "src", "desktop", "native", "window-proc-bridge.c");
  const bridgeIntermediate = path.join(intermediate, "native", "window-proc-bridge.dll");
  fs.mkdirSync(path.dirname(bridgeIntermediate), { recursive: true });
  run(zig, [
    "cc",
    "-target",
    "x86_64-windows-gnu",
    "-shared",
    "-Os",
    "-o",
    bridgeIntermediate,
    bridgeSource,
    "-luser32",
    "-lkernel32",
  ]);
  const bridgeTarget = path.join(packageDirectory, "native", "window-proc-bridge.dll");
  fs.mkdirSync(path.dirname(bridgeTarget), { recursive: true });
  fs.copyFileSync(bridgeIntermediate, bridgeTarget);
  await writeProductionNotices(root, appDirectory);
  await createPackageWithOptions(
    packageDirectory,
    path.join(appDirectory, "resources", "app.asar"),
    {
      unpack: "**/*.{node,dll}",
    },
  );
  fs.rmSync(packageDirectory, { recursive: true });
  if (stageRuntime)
    await flipFuses(path.join(appDirectory, "electron.exe"), {
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
      [FuseV1Options.GrantFileProtocolExtraPrivileges]: false,
    });
  const fuseWire = stageRuntime
    ? await getCurrentFuseWire(path.join(appDirectory, "electron.exe"))
    : null;
  if (fuseWire) {
    for (const [option, state] of [
      [FuseV1Options.RunAsNode, FuseState.DISABLE],
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable, FuseState.DISABLE],
      [FuseV1Options.EnableNodeCliInspectArguments, FuseState.DISABLE],
      [FuseV1Options.GrantFileProtocolExtraPrivileges, FuseState.DISABLE],
      [FuseV1Options.OnlyLoadAppFromAsar, FuseState.ENABLE],
    ])
      if (fuseWire[option] !== state) throw new Error(`DESKTOP_FUSE_MISMATCH:${option}`);
  }
  writeExclusive(
    path.join(stageDirectory, HOST_CONFIG_NAME),
    `${JSON.stringify(
      {
        schemaVersion: HOST_SCHEMA_VERSION,
        projectRoot: declaredRoot,
        electronExecutable: path.relative(stageDirectory, path.join(appDirectory, "electron.exe")),
      },
      null,
      2,
    )}\n`,
  );

  const hostSourceDirectory = path.join(root, "tools", "desktop", "src");
  const sources =
    hostSources ??
    [
      "DesktopHost.cs",
      "SingleInstance.cs", // existing project-root mutex/pipe identity
      "ProcessTree.cs", // existing Windows Job Object owner
      "ProcessEnvironment.cs",
      "MaintenanceLease.cs",
      "DesktopLayout.cs",
      "ProjectLocator.cs",
      "Util.cs",
    ].map((name) => path.join(hostSourceDirectory, name));
  const identitySource = path.join(output, "build-assets", "PackageIdentity.g.cs");
  fs.writeFileSync(
    identitySource,
    `namespace Superstring.Desktop { internal static class PackageIdentity { internal const string Version = "${manifest.version}"; } }`,
  );
  sources.push(identitySource);
  const hostExecutable = path.join(stageDirectory, "superstring.exe");
  run(csc, [
    "/nologo",
    "/target:winexe",
    "/main:Superstring.Desktop.DesktopHost",
    `/out:${hostExecutable}`,
    "/reference:System.Core.dll",
    "/reference:System.Web.Extensions.dll",
    `/win32icon:${icon}`,
    `/win32manifest:${path.join(root, "tools", "desktop", "build", "app.manifest")}`,
    ...sources,
  ]);

  const staged = [];
  function collect(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) collect(filename);
      else staged.push(filename);
    }
  }
  collect(output);
  const result = {
    builtAt: new Date().toISOString(),
    applicationVersion: manifest.version,
    electron: electronVersion,
    platform: process.platform,
    arch: process.arch,
    layout,
    projectRoot: declaredRoot,
    serviceRoot: declaredService || null,
    output,
    hostConfig: path.join(stageDirectory, HOST_CONFIG_NAME),
    files: staged.map((file) => ({
      path: path.relative(output, file).replaceAll("\\", "/"),
      bytes: fs.statSync(file).size,
      sha256: sha256(file),
    })),
    runtimeFiles: stageRuntime ? countFiles(appDirectory) : 0,
    security: {
      asar: true,
      fusesApplied: stageRuntime,
      fuseWire,
    },
    limits: ["No installer, publication or live profile operation. Native acceptance is separate."],
  };
  writeExclusive(path.join(output, "build-result.json"), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

function countFiles(directory) {
  let total = 0;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    total += entry.isDirectory() ? countFiles(file) : 1;
  }
  return total;
}

async function main() {
  const { values } = parseArgs({
    options: {
      "project-root": { type: "string", default: root },
      out: { type: "string" },
      layout: { type: "string", default: "development-legacy" },
      "service-root": { type: "string", default: "" },
      csc: { type: "string" },
      zig: { type: "string" },
      "no-runtime": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    process.stdout.write(
      "usage: node tools/desktop/build/build-electron.mjs --out=<abs candidate dir> [--project-root=<abs>] [--layout=development-legacy|managed-profile] [--service-root=<abs>] [--zig=<abs zig.exe>] [--no-runtime]\n",
    );
    return;
  }
  if (!values.out)
    throw new Error("--out is required: the candidate must land in an isolated batch directory");
  const result = await buildElectronDesktop({
    projectRoot: values["project-root"],
    out: values.out,
    layout: values.layout,
    serviceRoot: values["service-root"],
    runtime: !values["no-runtime"],
    csc: values.csc,
    zig: values.zig,
  });
  process.stdout.write(`DESKTOP_ELECTRON_CANDIDATE=${result.output}\n`);
  process.stdout.write(
    `DESKTOP_ELECTRON_HOST=${result.files.find((file) => file.path === "stage/superstring.exe")?.sha256}\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main();
