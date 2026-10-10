import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Permanent behavior regression for the native desktop launcher
// (tools/desktop/src/Launcher.cs). The product sources are copied to a fresh
// run directory and compiled with the .NET Framework csc at test time; the test
// never string-matches product source text and adds no test hooks to the product.
//
// Cases (all synthetic, no Edge, no real service, no real data):
//   1-fail       live fake parent + grandchild holding redirected stdout/stderr;
//                the real Launcher.Fail must kill the owned job, clear the busy
//                UI, and finish without any rescue
//   2-no-port    silent server; WaitReady must take the timeout branch
//   3-early-exit server exits before readiness; WaitReady early-exit branch
//
// The WaitReady timeout copy differs from the product source by exactly one
// constant (90000 -> 1000) so the timeout branch is observable in seconds.

const devRoot = fileURLToPath(new URL("../../", import.meta.url));
const fixtureDir = path.join(devRoot, "tests", "desktop", "fixtures", "launcher-failure");
const productSrc = path.join(devRoot, "tools", "desktop", "src");
const productLauncher = path.join(productSrc, "Launcher.cs");

const cscCandidates = [
  "C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe",
  "C:/Windows/Microsoft.NET/Framework/v4.0.30319/csc.exe",
];
const csc = cscCandidates.find((candidate) => fs.existsSync(candidate));
const skip =
  process.platform !== "win32"
    ? "launcher regression compiles WinForms sources with the .NET Framework csc; Windows only"
    : !csc
      ? "csc.exe (.NET Framework v4.0.30319) not found on this machine"
      : undefined;

// LAUNCHER_FAILURE_OUT is the parent directory; each run gets a unique
// mkdtemp directory under it, so reruns never overwrite earlier evidence.
const runParent = process.env.LAUNCHER_FAILURE_OUT
  ? path.join(process.env.LAUNCHER_FAILURE_OUT, "native-launcher-failure-")
  : path.join(devRoot, "artifacts", "validation", "native-launcher-failure-");

const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const writeJson = (file, value) =>
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", "utf8");

const sharedFixtures = ["Probe.cs", "FakeServer.cs", "Stubs.cs"].map((name) =>
  path.join(fixtureDir, name),
);
const realSources = ["MainForm.cs", "ProcessTree.cs", "BunResolver.cs", "Readiness.cs"].map(
  (name) => path.join(productSrc, name),
);
const probes = (derivedLauncher) => ({
  fixed: [...sharedFixtures, productLauncher, ...realSources],
  wait: [...sharedFixtures, derivedLauncher, ...realSources],
});

let runDir;
let compileDir;
const exePaths = {};

function compileProbe(name, sources) {
  const exe = path.join(compileDir, `probe-${name}.exe`);
  const args = [
    "-nologo",
    "-target:exe",
    "-define:VALIDATION",
    "-main:Superstring.Desktop.Program",
    `-out:${exe}`,
    "-r:System.Windows.Forms.dll",
    "-r:System.Drawing.dll",
    "-r:System.Core.dll",
    "-r:System.Web.Extensions.dll",
    ...sources,
  ];
  const started = Date.now();
  const result = spawnSync(csc, args, { cwd: compileDir, encoding: "utf8" });
  const capture = {
    utc: new Date().toISOString(),
    command: csc,
    args,
    probe: name,
    sources: Object.fromEntries(sources.map((s) => [s, sha256(s)])),
    exit: result.status,
    durationMs: Date.now() - started,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
  writeJson(path.join(runDir, `RAW-compile-${name}.json`), capture);
  assert.equal(
    result.status,
    0,
    `csc compile failed for probe-${name}: ${result.stderr ?? ""}${result.stdout ?? ""}`,
  );
  exePaths[name] = exe;
  return exe;
}

let compileOnce = null;
function ensureCompiled() {
  if (!compileOnce) {
    compileOnce = (async () => {
      runDir = fs.mkdtempSync(runParent);
      compileDir = path.join(runDir, "compile");
      fs.mkdirSync(compileDir, { recursive: true });
      // Derived wait copy: the ONLY diff from the product source is the timeout constant.
      const launcherText = fs.readFileSync(productLauncher, "utf8");
      const waitConstant = launcherText.match(/private const int ReadyTimeoutMs = \d+;/g) ?? [];
      assert.equal(
        waitConstant.length,
        1,
        "product Launcher.cs must declare exactly one ReadyTimeoutMs constant",
      );
      const derivedLauncher = path.join(runDir, "Launcher.waitderived.cs");
      fs.writeFileSync(
        derivedLauncher,
        launcherText.replace(waitConstant[0], "private const int ReadyTimeoutMs = 1000;"),
        "utf8",
      );
      for (const [name, sources] of Object.entries(probes(derivedLauncher)))
        compileProbe(name, sources);
      writeJson(path.join(runDir, "SOURCE-SHA256.json"), {
        productLauncher: sha256(productLauncher),
        derivedLauncher: sha256(derivedLauncher),
        fixtures: Object.fromEntries(sharedFixtures.map((f) => [path.basename(f), sha256(f)])),
        product: Object.fromEntries(realSources.map((f) => [path.basename(f), sha256(f)])),
        derivedDiff: "ReadyTimeoutMs 90000 -> 1000 only",
        runDir,
      });
    })();
  }
  return compileOnce;
}

function runProbe(exe, caseName) {
  const caseDir = path.join(runDir, `case-${caseName}`);
  fs.mkdirSync(caseDir, { recursive: true });
  return new Promise((resolve, reject) => {
    const child = spawn(exe, ["--run"], {
      cwd: caseDir,
      env: { ...process.env, PROBE_DIR: caseDir, PROBE_CASE: caseName, GOMAXPROCS: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    const started = Date.now();
    const watchdog = setTimeout(() => {
      // Kill only the probe pid we spawned; the probe's own job reaps its children.
      child.kill();
      reject(new Error(`probe-${caseName} timed out after 90s`));
    }, 90000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(watchdog);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(watchdog);
      const capture = {
        utc: new Date().toISOString(),
        command: exe,
        exeSha256: sha256(exe),
        args: ["--run"],
        env: { PROBE_DIR: caseDir, PROBE_CASE: caseName, GOMAXPROCS: "1" },
        pid: child.pid,
        exit: code,
        durationMs: Date.now() - started,
        stdout: stdout.join(""),
        stderr: stderr.join(""),
      };
      writeJson(path.join(runDir, `RAW-run-${caseName}.json`), capture);
      resolve({ capture, caseDir });
    });
  });
}

async function readResult(caseName) {
  const caseDir = path.join(runDir, `case-${caseName}`);
  const resultPath = path.join(caseDir, "RESULT.json");
  const raw = fs.readFileSync(resultPath, "utf8");
  return JSON.parse(raw);
}

test("native launcher: real Fail stops owned children and clears busy UI without a rescue", {
  skip,
}, async () => {
  await ensureCompiled();
  const { capture } = await runProbe(exePaths.fixed, "1-fail");
  assert.equal(capture.exit, 0, `probe exited ${capture.exit}: ${capture.stderr}`);
  const result = await readResult("1-fail");
  assert.equal(result.status, "complete");
  assert.equal(result.error, "");
  assert.ok(result.grandchildPid > 0, "grandchild fixture pid must be recorded");
  assert.equal(result.rescueRequired, false, "fixed Fail must finish without the watchdog rescue");
  assert.equal(result.failWorkerCompleted, true);
  assert.ok(result.failDoneMs >= 0 && result.failDoneMs < 5000, `Fail took ${result.failDoneMs}ms`);
  assert.equal(result.launcherPhase, "Failed");
  assert.match(result.uiSnapshot, /spinnerVisible=False/);
  assert.match(result.uiSnapshot, /spinnerAnimating=False/);
  assert.match(result.uiSnapshot, /label="[^"]+"/, "failure status text must be non-empty");
  assert.match(result.uiSnapshot, /retryVisible=True/, "failure panel must offer retry");
  assert.equal(result.jobLeftovers, "", "owned job must have no leftover children");
  assert.equal(result.grandchildAliveAtExit, false, "owned grandchild pid must be gone");
  assert.equal(
    fs.existsSync(path.join(runDir, "case-1-fail", "release-grandchild")),
    false,
    "no release file may be written on the fixed path",
  );
});

test("native launcher: WaitReady takes the timeout branch on a silent server (derived 1000ms)", {
  skip,
}, async () => {
  await ensureCompiled();
  const { capture } = await runProbe(exePaths.wait, "2-no-port");
  assert.equal(capture.exit, 0, `probe exited ${capture.exit}: ${capture.stderr}`);
  const result = await readResult("2-no-port");
  assert.equal(result.status, "complete");
  assert.equal(result.error, "");
  assert.equal(result.waitReadyResult, false, "WaitReady must return false on timeout");
  assert.ok(
    result.waitReadyMs >= 500 && result.waitReadyMs < 6000,
    `WaitReady took ${result.waitReadyMs}ms`,
  );
  assert.equal(result.launcherPhase, "Failed");
  assert.match(result.uiSnapshot, /spinnerVisible=False/);
  assert.match(result.uiSnapshot, /spinnerAnimating=False/);
  assert.match(result.uiSnapshot, /label="[^"]+"/, "failure status text must be non-empty");
  assert.match(result.uiSnapshot, /retryVisible=True/, "failure panel must offer retry");
  assert.equal(result.jobLeftovers, "");
});

test("native launcher: WaitReady reports failure immediately when the server exits early", {
  skip,
}, async () => {
  await ensureCompiled();
  const { capture } = await runProbe(exePaths.wait, "3-early-exit");
  assert.equal(capture.exit, 0, `probe exited ${capture.exit}: ${capture.stderr}`);
  const result = await readResult("3-early-exit");
  assert.equal(result.status, "complete");
  assert.equal(result.error, "");
  assert.equal(result.waitReadyResult, false, "WaitReady must return false on early exit");
  assert.ok(
    result.waitReadyMs >= 0 && result.waitReadyMs < 3000,
    `WaitReady took ${result.waitReadyMs}ms`,
  );
  assert.equal(result.launcherPhase, "Failed");
  assert.match(result.uiSnapshot, /spinnerVisible=False/);
  assert.match(result.uiSnapshot, /spinnerAnimating=False/);
  assert.match(result.uiSnapshot, /label="[^"]+"/, "failure status text must be non-empty");
  assert.match(result.uiSnapshot, /retryVisible=True/, "failure panel must offer retry");
  assert.equal(result.jobLeftovers, "");
});
