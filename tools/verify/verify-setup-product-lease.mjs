// Isolated acceptance: the REAL installed product must block the REAL installer.
//
// The main suite (verify-setup.mjs) proves the maintenance-lock mechanism with a
// compiled C# fixture. This suite proves that the SHIPPED service actually joins the
// lock, including the orphan case that matters most: the native launcher is dead but
// `app/superstring-server.exe` is still running and still writing the database. If the
// service did not hold the lease, an upgrade could replace program files underneath a
// live service and copy a database that is still being written.
//
// Everything happens inside a scratch directory with a Chinese/space path, with the
// installer's environment poisoned by development overrides, and with the unrelated
// working directory asserted to stay empty.

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const setup = path.join(root, `dist/installers/superstring-setup-${version}.exe`);
if (!fs.existsSync(setup)) throw new Error(`Build the package first: ${setup}`);

const parent = path.join(root, "artifacts/validation");
fs.mkdirSync(parent, { recursive: true });
const evidence = fs.mkdtempSync(path.join(parent, "setup-lease-"));
const installRoot = path.join(evidence, "安装 空格路径", "superstring");
const shortcutRoot = path.join(evidence, "shortcuts");
const unrelated = path.join(evidence, "unrelated-cwd");
fs.mkdirSync(unrelated);

const checks = [];
function check(name, pass, detail) {
  const entry = { name, pass: Boolean(pass) };
  if (!pass && detail !== undefined) entry.detail = detail;
  checks.push(entry);
  if (!pass) throw new Error(name);
}
function hashFile(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}
function listing(directory) {
  return fs.existsSync(directory) ? fs.readdirSync(directory).sort() : null;
}

// Hostile environment for the installer: development overrides must never be honoured.
const setupEnv = {};
for (const key of [
  "SystemRoot",
  "WINDIR",
  "TEMP",
  "TMP",
  "SystemDrive",
  "PATH",
  "PATHEXT",
  "ComSpec",
  "USERPROFILE",
  "LOCALAPPDATA",
  "APPDATA",
  "ProgramData",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
]) {
  if (process.env[key]) setupEnv[key] = process.env[key];
}
setupEnv.SUPERSTRING_SETUP_TEST_HOOK = "1";
setupEnv.SUPERSTRING_SETUP_SHORTCUT_ROOT = shortcutRoot;
setupEnv.SUPERSTRING_DB_PATH = path.join(unrelated, "must-not-exist.sqlite");
setupEnv.SUPERSTRING_APP_ROOT = unrelated;
setupEnv.SUPERSTRING_APP_MODE = "development";
setupEnv.SUPERSTRING_BUN_EXE = path.join(unrelated, "absent-bun.exe");

// Clean environment for the real service, mirroring what the native launcher provides.
const serviceEnv = {};
for (const key of [
  "SystemRoot",
  "WINDIR",
  "TEMP",
  "TMP",
  "SystemDrive",
  "PATH",
  "PATHEXT",
  "ComSpec",
  "USERPROFILE",
  "LOCALAPPDATA",
  "APPDATA",
  "ProgramData",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
]) {
  if (process.env[key]) serviceEnv[key] = process.env[key];
}

function runSetup(args) {
  const result = spawnSync(setup, args, {
    cwd: unrelated,
    env: setupEnv,
    encoding: "utf8",
    windowsHide: true,
    timeout: 300000,
  });
  let json = null;
  const line = (result.stdout ?? "")
    .trim()
    .split(/\r?\n/)
    .filter((l) => l.startsWith("{"))
    .pop();
  if (line) {
    try {
      json = JSON.parse(line);
    } catch {
      json = null;
    }
  }
  return { status: result.status, json, stdout: result.stdout ?? "" };
}

const serverExe = () => path.join(installRoot, "app/superstring-server.exe");
const launcherExe = () => path.join(installRoot, "superstring.exe");
const manifestPath = () => path.join(installRoot, "build-manifest.json");
const lockPath = () => path.join(installRoot, "maintenance/operation.lock");
const database = () => path.join(installRoot, "userdata/data/superstring.sqlite");
const keyFile = () => path.join(installRoot, "userdata/state/browser-state.key");
const backupsDir = () => path.join(installRoot, "backups");

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
function request(port, route, token, method = "GET") {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: route,
        method,
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (s) => {
          body += s;
        });
        res.on("end", () => resolve({ status: res.statusCode, body }));
      },
    );
    req.setTimeout(1500, () => req.destroy());
    req.on("error", () => resolve({ status: 0, body: "" }));
    req.end();
  });
}
async function until(predicate, ms = 40000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

// Independent cross-language probe of the same lock: this fixture compiles the SHIPPED
// MaintenanceLease.cs, so it can ask "is a shared holder alive right now?" without
// trusting the installer's own attempt. Exit 3 means somebody holds the lock.
const fixtureExe = path.join(evidence, "lease-fixture.exe");
const csc = path.join(
  process.env.WINDIR || "C:/Windows",
  "Microsoft.NET/Framework64/v4.0.30319/csc.exe",
);
const compiled = spawnSync(
  csc,
  [
    "/nologo",
    "/target:exe",
    `/out:${fixtureExe}`,
    path.join(root, "tools/verify/maintenance-lease-fixture.cs"),
    path.join(root, "tools/desktop/src/MaintenanceLease.cs"),
  ],
  { windowsHide: true, encoding: "utf8" },
);
if (compiled.status !== 0) throw new Error(compiled.stdout + compiled.stderr);
function exclusiveAttempt() {
  return spawnSync(fixtureExe, [installRoot, "maintenance"], {
    windowsHide: true,
    timeout: 5000,
  }).status;
}

let serviceChild = null;
try {
  // 1. install the real package
  let result = runSetup([`/dir=${installRoot}`, "/silent", "/noshortcut"]);
  check("real package installs", result.status === 0 && result.json?.action === "fresh-install", {
    status: result.status,
    json: result.json,
  });
  check("install writes the real service", fs.existsSync(serverExe()));
  check("install writes the real launcher", fs.existsSync(launcherExe()));
  check(
    "install leaves a stable empty lock file",
    fs.existsSync(lockPath()) && fs.statSync(lockPath()).size === 0,
  );
  check("installer released the lease when it exited", exclusiveAttempt() === 0, {
    exclusiveAttempt: exclusiveAttempt(),
  });

  // 2. start the SHIPPED service, no launcher anywhere
  const port = await freePort();
  const token = randomBytes(32).toString("hex");
  serviceChild = spawn(serverExe(), [], {
    cwd: unrelated,
    env: {
      ...serviceEnv,
      SUPERSTRING_DEV_PORT: String(port),
      SUPERSTRING_DESKTOP_TOKEN: token,
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let serviceOutput = "";
  serviceChild.stdout.on("data", (b) => {
    serviceOutput += b;
  });
  serviceChild.stderr.on("data", (b) => {
    serviceOutput += b;
  });
  check(
    "shipped service becomes ready",
    await until(async () => (await request(port, "/__desktop/status", token)).status === 200),
    { output: serviceOutput.slice(-400) },
  );
  check(
    "shipped service opened the installed database",
    fs.existsSync(database()) && fs.existsSync(keyFile()),
  );
  check("shipped service serves the web app", (await request(port, "/")).status === 200);
  // Cross-language proof, independent of the installer: the shipped service holds the
  // shared lease, so an exclusive maintenance attempt must be refused.
  check("shipped service holds the maintenance lease", exclusiveAttempt() === 3, {
    exclusiveAttempt: exclusiveAttempt(),
  });

  // 3. the orphan case: launcher dead, service alive
  const before = {
    launcher: hashFile(launcherExe()),
    server: hashFile(serverExe()),
    manifest: hashFile(manifestPath()),
    backups: listing(backupsDir()),
    maintenance: listing(path.join(installRoot, "maintenance")),
  };
  result = runSetup([`/dir=${installRoot}`, "/silent", "/noshortcut"]);
  check("installer refuses while only the shipped service is alive", result.status === 10, {
    status: result.status,
    json: result.json,
    tail: result.stdout.slice(-300),
  });
  check(
    "refusal is reported as a busy installation",
    result.json?.error === "InstallBusyException",
    { json: result.json },
  );
  check(
    "refused install leaves the program untouched",
    hashFile(launcherExe()) === before.launcher &&
      hashFile(serverExe()) === before.server &&
      hashFile(manifestPath()) === before.manifest,
  );
  check(
    "refused install writes no backup",
    JSON.stringify(listing(backupsDir())) === JSON.stringify(before.backups),
    { before: before.backups, after: listing(backupsDir()) },
  );
  check(
    "refused install writes no journal and no new log",
    !fs.existsSync(path.join(installRoot, "maintenance/journal.json")) &&
      JSON.stringify(listing(path.join(installRoot, "maintenance"))) ===
        JSON.stringify(before.maintenance),
    { before: before.maintenance, after: listing(path.join(installRoot, "maintenance")) },
  );
  check(
    "refused install never writes to the unrelated working directory",
    fs.readdirSync(unrelated).length === 0,
    { residue: fs.readdirSync(unrelated) },
  );

  // 4. uninstall is maintenance too
  result = runSetup([`/dir=${installRoot}`, "/uninstall", "/silent"]);
  check(
    "uninstall is refused while the shipped service is alive",
    result.status === 10 && fs.existsSync(serverExe()) && fs.existsSync(launcherExe()),
    { status: result.status, json: result.json },
  );

  // 5. graceful stop releases the lease
  const stopped = await request(port, "/__desktop/stop", token, "POST");
  check("shipped service accepts a graceful stop", stopped.status === 200);
  check(
    "shipped service exits cleanly",
    (await until(() => serviceChild.exitCode !== null, 30000)) && serviceChild.exitCode === 0,
    { exitCode: serviceChild.exitCode, output: serviceOutput.slice(-400) },
  );
  serviceChild = null;
  check(
    "stopped service releases its port",
    await until(async () => (await request(port, "/health")).status === 0),
  );
  check("stopped service releases the lease", exclusiveAttempt() === 0, {
    exclusiveAttempt: exclusiveAttempt(),
  });

  // 6. with nothing running the installer may proceed
  const databaseHash = hashFile(database());
  const keyHash = hashFile(keyFile());
  result = runSetup([`/dir=${installRoot}`, "/silent", "/noshortcut"]);
  check(
    "installer proceeds once the product stopped",
    result.status === 0 && result.json?.action === "same-version-reinstall",
    { status: result.status, json: result.json },
  );
  check(
    "stopped-product reinstall preserves chat data",
    hashFile(database()) === databaseHash && hashFile(keyFile()) === keyHash,
  );
  check(
    "stopped-product reinstall backed up the previous chat data",
    Boolean(result.json?.backupDirectory) &&
      hashFile(path.join(result.json.backupDirectory, "userdata/data/superstring.sqlite")) ===
        databaseHash,
    { backupDirectory: result.json?.backupDirectory },
  );
  check(
    "lock file survives installation and stays empty",
    fs.existsSync(lockPath()) && fs.statSync(lockPath()).size === 0,
  );
  check(
    "installer never wrote to the unrelated working directory",
    fs.readdirSync(unrelated).length === 0,
  );
} catch (error) {
  process.exitCode = 1;
  checks.push({ name: String(error), pass: false });
} finally {
  if (serviceChild && serviceChild.exitCode === null) {
    try {
      serviceChild.kill();
    } catch {}
  }
  fs.writeFileSync(
    path.join(evidence, "report.json"),
    JSON.stringify(
      {
        checks,
        installRoot,
        version,
        note: "Isolated acceptance that the SHIPPED installed service really joins maintenance/operation.lock, including the orphan case (launcher dead, service alive). Synthetic chat data, Chinese/space path, unrelated cwd, poisoned development overrides. The native launcher's own runtime hold is proven separately (verify-native-lifecycle.mjs); this suite never opens the default browser.",
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      evidence,
      passed: checks.filter((c) => c.pass).length,
      failed: checks.filter((c) => !c.pass).length,
    }),
  );
}
