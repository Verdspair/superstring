import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Permanent behaviour regression for the headless desktop host
// (tools/desktop/src/DesktopHost.cs). The real product sources are compiled at
// test time with the .NET Framework csc; nothing is string-matched and no test
// hook is added to the product.
//
// This replaces the retired WinForms Launcher.Fail regression. There is no
// WinForms UI, no Edge and no real service here.
//
// Cases (all synthetic, no real data):
//   1-exit    fake Electron exits 17; the host is a member of its own job, so
//             TerminateJobObject sets the host exit code to 17
//   2-config  a missing host config exits 2 before any job or spawn
//   3-kill    fake Electron starts a grandchild; killing the host closes its
//             job and the owned grandchild pid disappears
//
// The test only spawns the executables it compiled itself, by absolute path.

const devRoot = fileURLToPath(new URL("../../", import.meta.url));
const fixtureDir = path.join(devRoot, "tests", "desktop", "fixtures", "headless-host");
const productSrc = path.join(devRoot, "tools", "desktop", "src");
const manifest = JSON.parse(fs.readFileSync(path.join(devRoot, "package.json"), "utf8"));

const cscCandidates = [
  "C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe",
  "C:/Windows/Microsoft.NET/Framework/v4.0.30319/csc.exe",
];
const csc = cscCandidates.find((candidate) => fs.existsSync(candidate));
const skip =
  process.platform !== "win32"
    ? "headless host regression compiles .NET Framework sources; Windows only"
    : !csc
      ? "csc.exe (.NET Framework v4.0.30319) not found on this machine"
      : undefined;

// LAUNCHER_FAILURE_OUT is the parent directory; each run gets a unique
// mkdtemp directory under it, so reruns never overwrite earlier evidence.
const runParent = process.env.LAUNCHER_FAILURE_OUT
  ? path.join(process.env.LAUNCHER_FAILURE_OUT, "headless-host-")
  : path.join(devRoot, "artifacts", "validation", "headless-host-");

const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const writeJson = (file, value) =>
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf8");

// DesktopHost.cs needs exactly these existing product owners plus the generated
// package identity the builder writes for the same compile.
const hostSourceNames = [
  "DesktopHost.cs",
  "ProcessTree.cs",
  "SingleInstance.cs",
  "ProcessEnvironment.cs",
  "DesktopLayout.cs",
  "ProjectLocator.cs",
  "Util.cs",
  "MaintenanceLease.cs",
];
const hostSources = hostSourceNames.map((name) => path.join(productSrc, name));
const fakeElectronSource = path.join(fixtureDir, "FakeElectron.cs");

let runDir;
let compileDir;
const exePaths = {};

function compile(name, sources, main) {
  const exe = path.join(compileDir, `${name}.exe`);
  const args = [
    "-nologo",
    "-target:exe",
    `-main:${main}`,
    `-out:${exe}`,
    "-r:System.Core.dll",
    "-r:System.Web.Extensions.dll",
    ...sources,
  ];
  const started = Date.now();
  const result = spawnSync(csc, args, { cwd: compileDir, encoding: "utf8" });
  writeJson(path.join(runDir, `RAW-compile-${name}.json`), {
    utc: new Date().toISOString(),
    command: csc,
    args,
    sources: Object.fromEntries(sources.map((source) => [source, sha256(source)])),
    exit: result.status,
    durationMs: Date.now() - started,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  });
  assert.equal(
    result.status,
    0,
    `csc compile failed for ${name}: ${result.stderr ?? ""}${result.stdout ?? ""}`,
  );
  exePaths[name] = exe;
  return exe;
}

let compileOnce = null;
function ensureCompiled() {
  if (compileOnce) return compileOnce;
  compileOnce = (async () => {
    fs.mkdirSync(path.dirname(runParent), { recursive: true });
    runDir = fs.mkdtempSync(runParent);
    compileDir = path.join(runDir, "compile");
    fs.mkdirSync(compileDir, { recursive: true });
    // Same identity file the builder generates for the production host.
    const identity = path.join(runDir, "PackageIdentity.g.cs");
    fs.writeFileSync(
      identity,
      `namespace Superstring.Desktop { internal static class PackageIdentity { internal const string Version = "${manifest.version}"; } }`,
      "utf8",
    );
    compile("host", [...hostSources, identity], "Superstring.Desktop.DesktopHost");
    compile("fake-electron", [fakeElectronSource], "HeadlessHostFixture.FakeElectron");
    writeJson(path.join(runDir, "SOURCE-SHA256.json"), {
      runDir,
      packageVersion: manifest.version,
      host: Object.fromEntries([...hostSources, identity].map((file) => [file, sha256(file)])),
      fakeElectron: sha256(fakeElectronSource),
      generatedIdentity: identity,
    });
  })();
  return compileOnce;
}

function writeHostConfig(caseDir, electronExecutable, projectRoot) {
  fs.mkdirSync(projectRoot, { recursive: true });
  const file = path.join(caseDir, "desktop-host.json");
  fs.writeFileSync(
    file,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        projectRoot,
        electronExecutable: path.relative(caseDir, electronExecutable),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return file;
}

// Bounded native run. The watchdog only aborts the pid this test spawned.
function startHost(exe, args, caseName, timeoutMs = 30000) {
  const caseDir = path.join(runDir, `case-${caseName}`);
  fs.mkdirSync(caseDir, { recursive: true });
  const logPath = path.join(path.dirname(exe), "logs", "desktop-host.log");
  const logOffset = fs.existsSync(logPath) ? fs.statSync(logPath).size : 0;
  const started = Date.now();
  const child = spawn(exe, args, {
    cwd: caseDir,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const stdout = [];
  const stderr = [];
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const done = new Promise((resolveFlow, rejectFlow) => {
    const watchdog = setTimeout(() => {
      writeJson(path.join(runDir, `RAW-timeout-${caseName}.json`), {
        utc: new Date().toISOString(),
        command: exe,
        args,
        pid: child.pid,
        timeoutMs,
        stdout: stdout.join(""),
        stderr: stderr.join(""),
      });
      child.kill();
      rejectFlow(new Error(`headless host case ${caseName} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(watchdog);
      rejectFlow(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(watchdog);
      const capture = {
        utc: new Date().toISOString(),
        command: exe,
        exeSha256: sha256(exe),
        args,
        pid: child.pid,
        exit: code,
        signal,
        durationMs: Date.now() - started,
        stdout: stdout.join(""),
        stderr: stderr.join(""),
      };
      writeJson(path.join(runDir, `RAW-run-${caseName}.json`), capture);
      const log = fs.existsSync(logPath) ? fs.readFileSync(logPath) : Buffer.alloc(0);
      fs.writeFileSync(
        path.join(caseDir, "desktop-host.log"),
        log.subarray(Math.min(logOffset, log.length)),
      );
      resolveFlow(capture);
    });
  });
  return { child, caseDir, logPath, logOffset, done };
}

async function waitForFile(file, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${file}`);
}

// GetProcessById inside the compiled fixture, scoped to the recorded pid.
function alive(exe, pid) {
  const result = spawnSync(exe, ["--alive", String(pid)], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10000,
  });
  if (result.error) throw result.error;
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  throw new Error(`alive probe exited ${result.status}: ${result.stderr ?? ""}`);
}

async function waitGone(exe, pid, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive(exe, pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

test("headless host propagates the Electron exit code through its own job (17)", {
  skip,
}, async () => {
  await ensureCompiled();
  const caseDir = path.join(runDir, "case-1-exit");
  fs.mkdirSync(caseDir, { recursive: true });
  const projectRoot = path.join(caseDir, "project-root");
  const marker = path.join(caseDir, "electron-exit.json");
  const config = writeHostConfig(caseDir, exePaths["fake-electron"], projectRoot);

  const { done } = startHost(
    exePaths.host,
    [`--desktop-host-config=${config}`, "--exit", "17", marker],
    "1-exit",
  );
  const capture = await done;

  assert.equal(capture.exit, 17, `host exited ${capture.exit}: ${capture.stderr}`);
  const observed = JSON.parse(fs.readFileSync(marker, "utf8"));
  assert.equal(observed.exitCode, 17);
  assert.equal(observed.projectRoot.toLowerCase(), projectRoot.toLowerCase());
  assert.match(observed.arguments, /--exit 17/);

  const log = fs.readFileSync(path.join(caseDir, "desktop-host.log"), "utf8");
  assert.match(log, /electron exit=17/);
  assert.match(log, new RegExp(`start hostPid=${capture.pid}\\b`));
  assert.ok(log.includes(`root=${projectRoot}`), "host log must record the unique project root");
  assert.doesNotMatch(log, /SPAWN_FAILED|CONFIG_INVALID|INSTALLED_PREFLIGHT_FAILED/);

  writeJson(path.join(caseDir, "EVIDENCE.json"), {
    case: "1-exit",
    config,
    projectRoot,
    hostPid: capture.pid,
    hostExit: capture.exit,
    electronPid: observed.pid,
    log: path.join(caseDir, "desktop-host.log"),
  });
});

test("headless host rejects a missing config with exit 2 before any spawn", { skip }, async () => {
  await ensureCompiled();
  const caseDir = path.join(runDir, "case-2-config");
  fs.mkdirSync(caseDir, { recursive: true });
  const marker = path.join(caseDir, "electron-start.json");
  const missing = path.join(caseDir, "missing-desktop-host.json");

  const { done } = startHost(
    exePaths.host,
    [`--desktop-host-config=${missing}`, "--exit", "17", marker],
    "2-config",
  );
  const capture = await done;

  assert.equal(capture.exit, 2, `host exited ${capture.exit}: ${capture.stderr}`);
  assert.match(capture.stderr, /DESKTOP_HOST_CONFIG_INVALID/);
  assert.equal(fs.existsSync(marker), false, "no Electron may be started without a config");
  assert.equal(
    fs.existsSync(path.join(compileDir, "app", "desktop-host.json")),
    false,
    "the missing config must not be replaced with a default",
  );

  const log = fs.readFileSync(path.join(caseDir, "desktop-host.log"), "utf8");
  assert.match(log, /CONFIG_INVALID/);
  assert.doesNotMatch(log, /launch electron|electron pid=/);
});

test("killing the headless host closes its job and removes the owned grandchild", {
  skip,
}, async () => {
  await ensureCompiled();
  const caseDir = path.join(runDir, "case-3-kill");
  fs.mkdirSync(caseDir, { recursive: true });
  const projectRoot = path.join(caseDir, "project-root");
  const pidFile = path.join(caseDir, "owned-pids.json");
  const marker = path.join(caseDir, "electron-holding");
  const ready = path.join(caseDir, "grandchild-ready.json");
  const config = writeHostConfig(caseDir, exePaths["fake-electron"], projectRoot);

  const { child, done } = startHost(
    exePaths.host,
    [`--desktop-host-config=${config}`, "--hold", pidFile, marker],
    "3-kill",
    60000,
  );
  let owned = null;
  try {
    await waitForFile(marker, 20000);
    await waitForFile(ready, 20000);
    owned = JSON.parse(fs.readFileSync(pidFile, "utf8"));
    const readyData = JSON.parse(fs.readFileSync(ready, "utf8"));
    assert.ok(owned.electronPid > 0, "the synthetic Electron pid must be recorded");
    assert.ok(owned.grandchildPid > 0, "the synthetic grandchild pid must be recorded");
    assert.equal(readyData.pid, owned.grandchildPid);
    assert.equal(owned.projectRoot.toLowerCase(), projectRoot.toLowerCase());
    assert.equal(alive(exePaths["fake-electron"], owned.electronPid), true);
    assert.equal(alive(exePaths["fake-electron"], owned.grandchildPid), true);

    child.kill();
    const capture = await done;
    assert.equal(capture.pid, child.pid);

    assert.equal(
      await waitGone(exePaths["fake-electron"], owned.grandchildPid),
      true,
      `grandchild ${owned.grandchildPid} survived host ${capture.pid}`,
    );
    assert.equal(
      await waitGone(exePaths["fake-electron"], owned.electronPid),
      true,
      `synthetic Electron ${owned.electronPid} survived host ${capture.pid}`,
    );

    writeJson(path.join(caseDir, "EVIDENCE.json"), {
      case: "3-kill",
      config,
      projectRoot,
      hostPid: capture.pid,
      electronPid: owned.electronPid,
      grandchildPid: owned.grandchildPid,
      log: path.join(caseDir, "desktop-host.log"),
    });
  } finally {
    if (child.exitCode === null) {
      try {
        child.kill();
      } catch {}
    }
    try {
      await done;
    } catch {}
    if (!owned && fs.existsSync(pidFile)) {
      try {
        owned = JSON.parse(fs.readFileSync(pidFile, "utf8"));
      } catch {}
    }
    if (owned) {
      const leaked = [owned.electronPid, owned.grandchildPid].filter((pid) => {
        try {
          return alive(exePaths["fake-electron"], pid);
        } catch {
          return false;
        }
      });
      if (leaked.length > 0) {
        writeJson(path.join(runDir, "RAW-leak-3-kill.json"), {
          utc: new Date().toISOString(),
          leaked,
          note: "synthetic pids still alive after the case; recorded before cleanup",
        });
        for (const pid of leaked) {
          try {
            process.kill(pid);
          } catch {}
        }
      }
    }
  }
});
