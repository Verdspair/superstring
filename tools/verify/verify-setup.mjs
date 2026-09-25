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
const evidence = fs.mkdtempSync(path.join(parent, "setup-"));
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
function hashFile(f) {
  return createHash("sha256").update(fs.readFileSync(f)).digest("hex");
}
const env = {};
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
])
  if (process.env[key]) env[key] = process.env[key];
// Test hook: keep shortcuts out of the real Desktop / Start Menu.
env.SUPERSTRING_SETUP_TEST_HOOK = "1";
env.SUPERSTRING_SETUP_SHORTCUT_ROOT = shortcutRoot;
// Poisonous development overrides must never reach the installer or the product.
env.SUPERSTRING_DB_PATH = path.join(unrelated, "must-not-exist.sqlite");
env.SUPERSTRING_APP_ROOT = unrelated;
env.SUPERSTRING_APP_MODE = "development";
env.SUPERSTRING_BUN_EXE = path.join(unrelated, "absent-bun.exe");

function runSetup(args, extraEnv) {
  const merged = { ...env, ...(extraEnv ?? {}) };
  const result = spawnSync(setup, args, {
    cwd: unrelated,
    env: merged,
    encoding: "utf8",
    windowsHide: true,
    timeout: 600000,
  });
  if (result.error) throw result.error;
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
  return {
    status: result.status,
    json,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}
const manifestPath = () => path.join(installRoot, "build-manifest.json");
const serverExe = () => path.join(installRoot, "app/superstring-server.exe");
function rewriteManifestVersion(next) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath(), "utf8"));
  manifest.version = next;
  fs.writeFileSync(manifestPath(), `${JSON.stringify(manifest, null, 2)}\n`);
}
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
// Lease fixture: proves the installer refuses to run while our service/launcher is alive.
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

let serviceChild = null;
try {
  // 1. fresh install
  let result = runSetup([`/dir=${installRoot}`, "/silent", "/verbose"]);
  check("fresh install exits 0", result.status === 0, result);
  check(
    "fresh install reports fresh-install",
    result.json && result.json.action === "fresh-install" && result.json.ok === true,
  );
  // The silent result JSON is a machine contract consumed as UTF-8 by the launcher and
  // by tooling: a non-ASCII install path must survive the round trip, otherwise every
  // path the installer reports back is unusable on this machine.
  check(
    "silent result JSON preserves the non-ASCII install path",
    result.json.targetRoot === installRoot,
    { reported: result.json.targetRoot, expected: installRoot },
  );
  check(
    "fresh install writes the launcher",
    fs.existsSync(path.join(installRoot, "superstring.exe")),
  );
  check("fresh install writes the service", fs.existsSync(serverExe()));
  check(
    "fresh install writes web assets",
    fs.existsSync(path.join(installRoot, "app/resources/web/index.html")),
  );
  check(
    "fresh install writes the business migration",
    fs.existsSync(path.join(installRoot, "app/resources/migrations/versions/0001_initial.sql")) &&
      fs.existsSync(
        path.join(installRoot, "app/resources/migrations/versions/0002_knowledge.sql"),
      ) &&
      fs.existsSync(
        path.join(installRoot, "app/resources/migrations/versions/0003_knowledge_read.sql"),
      ) &&
      fs.existsSync(
        path.join(installRoot, "app/resources/migrations/versions/0004_organization.sql"),
      ) &&
      fs.existsSync(
        path.join(installRoot, "app/resources/migrations/versions/0005_qq_transport.sql"),
      ) &&
      fs.existsSync(
        path.join(installRoot, "app/resources/migrations/versions/0006_qq_memory_sources.sql"),
      ) &&
      fs.existsSync(
        path.join(installRoot, "app/resources/migrations/versions/0007_qq_observation_text.sql"),
      ) &&
      fs.existsSync(
        path.join(installRoot, "app/resources/migrations/versions/0008_qq_memory_batch.sql"),
      ) &&
      fs.existsSync(
        path.join(installRoot, "app/resources/migrations/versions/0009_qq_transport_config.sql"),
      ) &&
      fs.existsSync(
        path.join(installRoot, "app/resources/migrations/versions/0010_qq_schemes.sql"),
      ) &&
      fs.existsSync(
        path.join(installRoot, "app/resources/migrations/versions/0011_qq_speech_log.sql"),
      ) &&
      fs.existsSync(
        path.join(installRoot, "app/resources/migrations/versions/0012_qq_media_notes.sql"),
      ) &&
      fs.existsSync(
        path.join(installRoot, "app/resources/migrations/versions/0013_qq_scheme_triggers.sql"),
      ) &&
      fs.existsSync(
        path.join(installRoot, "app/resources/migrations/versions/0014_qq_send_log.sql"),
      ) &&
      fs.existsSync(
        path.join(installRoot, "app/resources/migrations/versions/0015_qq_scheme_rhythm.sql"),
      ) &&
      fs.existsSync(
        path.join(installRoot, "app/resources/migrations/versions/0016_qq_context_budget.sql"),
      ) &&
      fs.existsSync(
        path.join(installRoot, "app/resources/migrations/versions/0017_qq_scheme_prompts.sql"),
      ) &&
      fs.existsSync(
        path.join(installRoot, "app/resources/migrations/versions/0018_qq_members.sql"),
      ) &&
      fs.existsSync(
        path.join(installRoot, "app/resources/migrations/versions/0019_qq_output_reserve.sql"),
      ) &&
      fs.existsSync(
        path.join(installRoot, "app/resources/migrations/versions/0020_qq_scheme_stickers.sql"),
      ) &&
      fs.existsSync(
        path.join(installRoot, "app/resources/migrations/versions/0021_qq_stickers.sql"),
      ) &&
      fs.existsSync(
        path.join(
          installRoot,
          "app/resources/migrations/versions/0022_qq_sticker_authorization.sql",
        ),
      ) &&
      fs.existsSync(
        path.join(installRoot, "app/resources/migrations/versions/0023_qq_dispatch.sql"),
      ) &&
      fs.existsSync(
        path.join(installRoot, "app/resources/migrations/versions/0024_qq_media_purposes.sql"),
      ) &&
      fs.existsSync(
        path.join(installRoot, "app/resources/migrations/versions/0025_desktop_settings.sql"),
      ) &&
      fs.existsSync(
        path.join(installRoot, "app/resources/migrations/versions/0026_qq_media_supplement.sql"),
      ) &&
      fs.existsSync(
        path.join(installRoot, "app/resources/migrations/versions/0027_qq_event_addressed.sql"),
      ) &&
      fs.existsSync(
        path.join(installRoot, "app/resources/migrations/versions/0028_qq_immediate_lease.sql"),
      ) &&
      fs.existsSync(
        path.join(installRoot, "app/resources/migrations/versions/0029_qq_module_switches.sql"),
      ) &&
      fs.existsSync(
        path.join(installRoot, "app/resources/migrations/versions/0030_qq_sweep_verdicts.sql"),
      ) &&
      fs.existsSync(
        path.join(installRoot, "app/resources/migrations/versions/0031_qq_attention.sql"),
      ) &&
      fs.existsSync(
        path.join(installRoot, "app/resources/migrations/versions/0032_model_providers.sql"),
      ) &&
      fs.existsSync(
        path.join(installRoot, "app/resources/migrations/versions/0033_qq_idle_judgements.sql"),
      ) &&
      fs.existsSync(
        path.join(
          installRoot,
          "app/resources/migrations/versions/0034_qq_initiative_min_score.sql",
        ),
      ) &&
      fs.existsSync(
        path.join(installRoot, "app/resources/migrations/versions/0035_qq_reply_split.sql"),
      ) &&
      fs.existsSync(
        path.join(installRoot, "app/resources/migrations/versions/0036_qq_judgement_reuse.sql"),
      ) &&
      fs.existsSync(
        path.join(
          installRoot,
          "app/resources/migrations/versions/0037_qq_judgement_per_speaker.sql",
        ),
      ) &&
      fs.existsSync(
        path.join(installRoot, "app/resources/migrations/versions/0038_qq_judgement_model.sql"),
      ) &&
      fs.existsSync(
        path.join(installRoot, "app/resources/migrations/versions/0039_agent_runs.sql"),
      ),
  );
  // The R1 probe is a development surface and must never reach a release package.
  check(
    "release package carries no R1 probe migration",
    !fs.existsSync(path.join(installRoot, "app/resources/migrations/probe")),
  );
  check(
    "fresh install records the package version",
    JSON.parse(fs.readFileSync(manifestPath(), "utf8")).version === version,
  );
  check("fresh install creates no chat data", !fs.existsSync(path.join(installRoot, "userdata")));
  check(
    "fresh install writes no maintenance journal",
    !fs.existsSync(path.join(installRoot, "maintenance/journal.json")),
  );
  check(
    "fresh install reports a positive space requirement",
    result.json.requiredBytes > 0 && result.json.availableBytes > result.json.requiredBytes,
  );
  const desktopLink = path.join(shortcutRoot, "Desktop/superstring.lnk");
  const startMenuLink = path.join(shortcutRoot, "Programs/superstring/superstring.lnk");
  check("fresh install creates the desktop shortcut", fs.existsSync(desktopLink));
  check("fresh install creates the start menu shortcut", fs.existsSync(startMenuLink));
  check(
    "installer never writes to the unrelated working directory",
    fs.readdirSync(unrelated).length === 0,
  );

  // 2. the installed product works
  const packaged = spawnSync(path.join(installRoot, "superstring.exe"), ["--check-package"], {
    cwd: unrelated,
    windowsHide: true,
    encoding: "utf8",
    timeout: 60000,
  });
  check(
    "installed product passes its own package check",
    packaged.status === 0 && (packaged.stdout ?? "").includes("PACKAGE_OK"),
  );

  // The packaged service must refuse developer overrides outright.
  const poisoned = spawnSync(serverExe(), [], {
    cwd: unrelated,
    env,
    windowsHide: true,
    encoding: "utf8",
    timeout: 60000,
  });
  check(
    "installed service rejects a poisoned database override",
    poisoned.status !== 0 && !fs.existsSync(path.join(unrelated, "must-not-exist.sqlite")),
  );

  // Positive run with the same clean environment the launcher provides.
  const cleanEnv = {};
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
  ])
    if (process.env[key]) cleanEnv[key] = process.env[key];
  const port = await freePort();
  const token = randomBytes(32).toString("hex");
  serviceChild = spawn(serverExe(), [], {
    cwd: unrelated,
    env: {
      ...cleanEnv,
      SUPERSTRING_DEV_PORT: String(port),
      SUPERSTRING_DESKTOP_TOKEN: token,
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Drain both pipes: the service must never block on a full buffer, but this suite
  // asserts through HTTP, so the bytes themselves are not kept.
  serviceChild.stdout.resume();
  serviceChild.stderr.resume();
  check(
    "installed service becomes ready",
    await until(async () => (await request(port, "/__desktop/status", token)).status === 200),
  );
  const health = await request(port, "/health");
  check("installed service serves health", health.status === 200);
  check(
    "installed service reports the product version",
    JSON.parse(health.body).version === version,
  );
  const page = await request(port, "/");
  check("installed service serves the web app", page.status === 200 && page.body.includes("<html"));
  // Release contract: the packaged product has no R1 probe surface at all.
  check(
    "installed service has no probe route",
    (await request(port, "/__dev/probe")).status === 404 &&
      (await request(port, "/__dev/ready")).status === 404,
  );
  check(
    "installed service stores the database under the install root",
    fs.existsSync(path.join(installRoot, "userdata/data/superstring.sqlite")),
  );
  check(
    "installed service stores its key under the install root",
    fs.existsSync(path.join(installRoot, "userdata/state/browser-state.key")),
  );
  check(
    "installed service ignores poisoned development overrides",
    fs.readdirSync(unrelated).length === 0,
  );
  const stopped = await request(port, "/__desktop/stop", token, "POST");
  check("installed service accepts a graceful stop", stopped.status === 200);
  check(
    "installed service exits cleanly",
    (await until(() => serviceChild.exitCode !== null, 30000)) && serviceChild.exitCode === 0,
  );

  // 3. synthetic chat data must survive every later operation
  const database = path.join(installRoot, "userdata/data/superstring.sqlite");
  const keyFile = path.join(installRoot, "userdata/state/browser-state.key");
  fs.writeFileSync(database, Buffer.from("SYNTHETIC-CHAT-DATA-".repeat(64)));
  fs.appendFileSync(keyFile, "SYNTHETIC-KEY-MARKER");
  const databaseHash = hashFile(database);
  const keyHash = hashFile(keyFile);

  // 4. reinstall of the same version
  result = runSetup([`/dir=${installRoot}`, "/silent"]);
  check("same-version reinstall exits 0", result.status === 0);
  check(
    "same-version reinstall is classified explicitly",
    result.json.action === "same-version-reinstall",
  );
  check("same-version reinstall preserves the database", hashFile(database) === databaseHash);
  check("same-version reinstall preserves the key file", hashFile(keyFile) === keyHash);
  const backupDatabase = result.json.backupDirectory
    ? path.join(result.json.backupDirectory, "userdata/data/superstring.sqlite")
    : null;
  check(
    "same-version reinstall creates a backup",
    Boolean(backupDatabase) && fs.existsSync(backupDatabase),
    {
      backupDirectory: result.json.backupDirectory,
      backups: fs.existsSync(path.join(installRoot, "backups"))
        ? fs.readdirSync(path.join(installRoot, "backups"))
        : null,
    },
  );
  check(
    "backup copy matches the source database",
    Boolean(backupDatabase) && hashFile(backupDatabase) === databaseHash,
  );

  // 5. real upgrade path
  rewriteManifestVersion("0.0.1");
  result = runSetup([`/dir=${installRoot}`, "/silent"]);
  check("upgrade exits 0", result.status === 0);
  check(
    "upgrade is classified as upgrade",
    result.json.action === "upgrade" && result.json.previousVersion === "0.0.1",
  );
  check(
    "upgrade preserves chat data",
    hashFile(database) === databaseHash && hashFile(keyFile) === keyHash,
  );
  check(
    "upgrade records the new version",
    JSON.parse(fs.readFileSync(manifestPath(), "utf8")).version === version,
  );
  check(
    "upgrade backs up the previous program",
    fs.existsSync(path.join(result.json.backupDirectory, "app/superstring-server.exe")),
  );
  check(
    "upgrade backs up the chat data before replacing",
    hashFile(path.join(result.json.backupDirectory, "userdata/data/superstring.sqlite")) ===
      databaseHash,
  );
  check(
    "upgrade leaves no rollback residue",
    !fs.existsSync(path.join(installRoot, "maintenance/previous-app")) &&
      !fs.existsSync(path.join(installRoot, "maintenance/journal.json")),
  );

  // 6. downgrade refusal
  rewriteManifestVersion("9.9.9");
  const programHash = hashFile(serverExe());
  result = runSetup([`/dir=${installRoot}`, "/silent"]);
  check("downgrade is refused", result.status === 11);
  check("downgrade leaves the program untouched", hashFile(serverExe()) === programHash);
  check("downgrade leaves chat data untouched", hashFile(database) === databaseHash);
  rewriteManifestVersion(version);

  // 7. failure injection and rollback
  const beforeRollback = hashFile(serverExe());
  result = runSetup([`/dir=${installRoot}`, "/silent", "/fail-after=verify"]);
  check("injected verification failure fails the install", result.status === 13, {
    status: result.status,
    tail: result.stdout.slice(-300),
  });
  check(
    "failed install rolls the program back",
    hashFile(serverExe()) === beforeRollback &&
      fs.existsSync(path.join(installRoot, "superstring.exe")),
  );
  check(
    "failed install keeps chat data intact",
    hashFile(database) === databaseHash && hashFile(keyFile) === keyHash,
  );
  check(
    "failed install leaves no half-swapped state",
    !fs.existsSync(path.join(installRoot, "maintenance/previous-app")),
  );

  // Failing right after the swap is the riskiest rollback: the previous program has
  // already been moved aside, so it can only be restored from the journal.
  result = runSetup([`/dir=${installRoot}`, "/silent", "/fail-after=swap"]);
  check("injected swap failure fails the install", result.status === 1, {
    status: result.status,
    tail: result.stdout.slice(-300),
  });
  check(
    "swap failure restores the previous program",
    hashFile(serverExe()) === beforeRollback &&
      fs.existsSync(path.join(installRoot, "superstring.exe")),
  );
  check(
    "swap failure restores the launcher",
    fs.existsSync(path.join(installRoot, "superstring.exe")) && fs.existsSync(manifestPath()),
  );
  check(
    "swap failure keeps chat data intact",
    hashFile(database) === databaseHash && hashFile(keyFile) === keyHash,
  );
  check(
    "swap failure leaves no half-swapped state",
    !fs.existsSync(path.join(installRoot, "maintenance/previous-app")),
  );

  // A FRESH install interrupted mid-swap has no previous program to restore, so the
  // swap must be unwound instead. Leaving a half-swapped app/ behind would be refused
  // as foreign content on the next attempt and force a manual cleanup.
  const freshTarget = path.join(evidence, "全新 安装路径", "superstring");
  result = runSetup([`/dir=${freshTarget}`, "/silent", "/fail-after=swap"]);
  check("interrupted fresh install fails", result.status === 1, {
    status: result.status,
    tail: result.stdout.slice(-300),
  });
  check(
    "interrupted fresh install leaves no half-installed program",
    !fs.existsSync(path.join(freshTarget, "app")) &&
      !fs.existsSync(path.join(freshTarget, "superstring.exe")) &&
      !fs.existsSync(path.join(freshTarget, "build-manifest.json")),
    {
      residue: fs.existsSync(freshTarget) ? fs.readdirSync(freshTarget) : null,
    },
  );
  result = runSetup([`/dir=${freshTarget}`, "/silent"]);
  check(
    "the interrupted fresh target installs cleanly on the next attempt",
    result.status === 0 && result.json.action === "fresh-install",
    { status: result.status, tail: result.stdout.slice(-300) },
  );
  result = runSetup([`/dir=${freshTarget}`, "/uninstall", "/silent"]);
  check("the recovery probe target uninstalls", result.status === 0);

  // Recreate a persisted pre-crash journal, not just an exception caught by the
  // same process. The next installer process must unwind the unfinished fresh swap.
  const journalTarget = path.join(evidence, "恢复 日志路径", "superstring");
  fs.mkdirSync(path.join(journalTarget, "app"), { recursive: true });
  fs.mkdirSync(path.join(journalTarget, "maintenance"));
  fs.mkdirSync(path.join(journalTarget, "userdata"));
  fs.writeFileSync(path.join(journalTarget, "app/partial.bin"), "synthetic incomplete program");
  fs.writeFileSync(path.join(journalTarget, "superstring.exe"), "synthetic incomplete launcher");
  fs.writeFileSync(path.join(journalTarget, "userdata/keep.txt"), "synthetic user data");
  fs.writeFileSync(
    path.join(journalTarget, "maintenance/journal.json"),
    JSON.stringify({
      product: "superstring",
      version,
      phase: "swapping",
      previous: "",
    }),
  );
  result = runSetup([`/dir=${journalTarget}`, "/silent"]);
  check(
    "persisted fresh-swap journal recovers in the next process",
    result.status === 0 && result.json.action === "fresh-install",
  );
  check(
    "journal recovery removes partial program residue",
    !fs.existsSync(path.join(journalTarget, "app/partial.bin")),
  );
  check(
    "journal recovery keeps user data",
    fs.readFileSync(path.join(journalTarget, "userdata/keep.txt"), "utf8") ===
      "synthetic user data",
  );
  result = runSetup([`/dir=${journalTarget}`, "/uninstall", "/silent"]);
  check("journal recovery fixture uninstalls", result.status === 0);

  // 8. running product blocks the installer
  const holder = spawn(fixtureExe, [installRoot, "maintenance", "hold"], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("lease fixture timeout")), 5000);
    holder.stdout.once("data", (b) => {
      clearTimeout(timer);
      b.toString().includes("LEASE_ACQUIRED")
        ? resolve()
        : reject(new Error("lease fixture rejected"));
    });
  });
  result = runSetup([`/dir=${installRoot}`, "/silent"]);
  check("installer refuses to run while the product is alive", result.status === 10);
  check(
    "blocked install changes nothing",
    hashFile(serverExe()) === beforeRollback && hashFile(database) === databaseHash,
  );
  await new Promise((resolve) => {
    holder.once("exit", resolve);
    holder.stdin.end("x\n");
  });

  // 9. foreign directory protection
  const foreign = path.join(evidence, "我的文档");
  fs.mkdirSync(foreign);
  fs.writeFileSync(path.join(foreign, "important.txt"), "keep me");
  result = runSetup([`/dir=${foreign}`, "/silent"]);
  check("installer refuses a foreign non-empty directory", result.status === 3);
  check(
    "foreign directory content is preserved",
    fs.readFileSync(path.join(foreign, "important.txt"), "utf8") === "keep me",
  );

  const foreignApp = path.join(evidence, "foreign-app");
  fs.mkdirSync(path.join(foreignApp, "app"), { recursive: true });
  fs.mkdirSync(path.join(foreignApp, "maintenance"));
  fs.writeFileSync(path.join(foreignApp, "app/important.txt"), "keep foreign app");
  fs.writeFileSync(
    path.join(foreignApp, "maintenance/journal.json"),
    JSON.stringify({ phase: "swapping", previous: "" }),
  );
  result = runSetup([`/dir=${foreignApp}`, "/silent"]);
  check(
    "unidentified journal cannot authorize removal of a foreign app",
    result.status === 3 &&
      fs.readFileSync(path.join(foreignApp, "app/important.txt"), "utf8") === "keep foreign app",
  );

  // 10. uninstall keeps user data
  result = runSetup([`/dir=${installRoot}`, "/uninstall", "/silent"]);
  check("uninstall exits 0", result.status === 0 && result.json.action === "uninstalled");
  check(
    "uninstall removes the program",
    !fs.existsSync(path.join(installRoot, "app")) &&
      !fs.existsSync(path.join(installRoot, "superstring.exe")) &&
      !fs.existsSync(manifestPath()),
  );
  check(
    "uninstall keeps chat data",
    hashFile(database) === databaseHash && hashFile(keyFile) === keyHash,
  );
  check("uninstall keeps backups", fs.existsSync(path.join(installRoot, "backups")));
  check("uninstall removes the desktop shortcut", !fs.existsSync(desktopLink));
  check("uninstall removes the start menu shortcut", !fs.existsSync(startMenuLink));

  // 11. desktop-only opt-out and legacy all-shortcuts opt-out
  const choiceTarget = path.join(evidence, "快捷方式 选项", "superstring");
  const choiceLinks = path.join(evidence, "choice-shortcuts");
  const choiceEnv = { SUPERSTRING_SETUP_SHORTCUT_ROOT: choiceLinks };
  const choiceDesktop = path.join(choiceLinks, "Desktop/superstring.lnk");
  const choiceStartMenu = path.join(choiceLinks, "Programs/superstring/superstring.lnk");
  result = runSetup([`/dir=${choiceTarget}`, "/silent", "/nodesktopshortcut"], choiceEnv);
  check("desktop opt-out installs successfully", result.status === 0, result);
  check("desktop opt-out creates no desktop shortcut", !fs.existsSync(choiceDesktop));
  check("desktop opt-out still creates the start menu shortcut", fs.existsSync(choiceStartMenu));
  check("desktop opt-out reports only the start menu shortcut", result.json.shortcuts.length === 1);
  result = runSetup([`/dir=${choiceTarget}`, "/silent"], choiceEnv);
  check(
    "default selection creates both shortcuts on reinstall",
    result.status === 0 && fs.existsSync(choiceDesktop) && result.json.shortcuts.length === 2,
  );
  const existingLinkHash = hashFile(choiceDesktop);
  result = runSetup([`/dir=${choiceTarget}`, "/silent", "/nodesktopshortcut"], choiceEnv);
  check(
    "opting out on reinstall preserves an existing desktop link",
    result.status === 0 &&
      hashFile(choiceDesktop) === existingLinkHash &&
      result.json.shortcuts.length === 1,
  );
  result = runSetup([`/dir=${choiceTarget}`, "/uninstall", "/silent"], choiceEnv);
  check(
    "choice fixture uninstalls with both shortcuts removed",
    result.status === 0 && !fs.existsSync(choiceDesktop) && !fs.existsSync(choiceStartMenu),
  );
  result = runSetup([`/dir=${choiceTarget}`, "/silent", "/noshortcut"], choiceEnv);
  check("legacy all-shortcuts opt-out still installs", result.status === 0);
  check(
    "legacy opt-out creates neither shortcut",
    !fs.existsSync(choiceDesktop) &&
      !fs.existsSync(choiceStartMenu) &&
      result.json.shortcuts.length === 0,
  );
  result = runSetup([`/dir=${choiceTarget}`, "/uninstall", "/silent"], choiceEnv);
  check("legacy opt-out fixture uninstalls", result.status === 0);

  // 12. payload integrity
  const truncated = path.join(evidence, "truncated-setup.exe");
  const truncatedTarget = path.join(evidence, "truncated-target");
  const bytes = fs.readFileSync(setup);
  fs.writeFileSync(truncated, bytes.subarray(0, bytes.length - 4096));
  const bad = spawnSync(truncated, [`/dir=${truncatedTarget}`, "/silent"], {
    cwd: unrelated,
    env,
    encoding: "utf8",
    windowsHide: true,
    timeout: 120000,
  });
  check("truncated package is rejected", bad.status === 4, {
    status: bad.status,
    stdout: (bad.stdout ?? "").slice(-300),
  });
  // A package that fails its own integrity check must not create the install root,
  // a maintenance folder, a lock file or a log in the directory the user picked.
  check("truncated package writes nothing", !fs.existsSync(truncatedTarget), {
    residue: fs.existsSync(truncatedTarget) ? fs.readdirSync(truncatedTarget) : null,
  });
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
        note: "Isolated synthetic acceptance of the setup package: Chinese/space path, unrelated cwd, poisoned dev overrides, synthetic chat data. Shortcuts redirected by the test hook. Not a clean-machine, signed-release or real user data test.",
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
