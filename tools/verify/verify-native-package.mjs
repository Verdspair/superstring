import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const stage = process.argv[2];
if (!stage || !path.isAbsolute(stage)) throw new Error("Expected absolute staging path");
const parent = path.join(root, "artifacts/validation");
fs.mkdirSync(parent, { recursive: true });
const evidence = fs.mkdtempSync(path.join(parent, "native-package-"));
const install = path.join(evidence, "安装 空格路径");
fs.mkdirSync(install);
const manifest = JSON.parse(fs.readFileSync(path.join(stage, "build-manifest.json"), "utf8"));
for (const item of manifest.files) {
  if (!item.path.startsWith("app/") || item.path.includes(".."))
    throw new Error("Unsafe fixture path");
  const dest = path.join(install, item.path);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(stage, item.path), dest, fs.constants.COPYFILE_EXCL);
}
fs.copyFileSync(path.join(stage, "build-manifest.json"), path.join(install, "build-manifest.json"));
fs.copyFileSync(
  path.join(root, "dist/desktop/installed/superstring.exe"),
  path.join(install, "superstring.exe"),
);
const checks = [];
function check(name, condition) {
  checks.push({ name, pass: condition });
  if (!condition) throw new Error(name);
}
function run() {
  return spawnSync(path.join(install, "superstring.exe"), ["--check-package"], {
    cwd: evidence,
    encoding: "utf8",
    windowsHide: true,
    timeout: 20000,
  });
}
try {
  const nativeBytes = fs.readFileSync(path.join(install, "superstring.exe"));
  for (const marker of ["VALIDATION_BROWSER_READY ", "SUPERSTRING_VALIDATION_PORT"]) {
    check(
      `production excludes validation hook: ${marker.trim()}`,
      !nativeBytes.includes(Buffer.from(marker, "utf16le")),
    );
  }
  const licenses = path.join(install, "app/resources/licenses");
  const noticeIndex = JSON.parse(
    fs.readFileSync(path.join(licenses, "notice-sources.json"), "utf8"),
  );
  check(
    "package includes project license and every indexed third-party notice",
    fs.existsSync(path.join(licenses, "superstring-MIT.txt")) &&
      noticeIndex.components.every((notice) => fs.existsSync(path.join(licenses, notice.file))),
  );
  check(
    "runtime notice preserves separate embedded-component licensing",
    fs
      .readFileSync(path.join(licenses, "bun-UPSTREAM-LICENSE.txt"), "utf8")
      .includes("JavaScriptCore"),
  );
  const serviceBytes = fs.readFileSync(path.join(install, "app/superstring-server.exe"));
  for (const marker of ["/__dev/probe", "/__dev/ready", "synthetic_records", "0001_probe.sql"]) {
    check(
      `production service excludes probe: ${marker}`,
      !serviceBytes.includes(Buffer.from(marker)),
    );
  }
  let r = run();
  check(
    "valid package accepted without source or dependencies",
    r.status === 0 && r.stdout.includes("PACKAGE_OK"),
  );
  check("state anchored to selected root", r.stdout.includes(path.join(install, "userdata/state")));
  check("logs anchored to selected root", r.stdout.includes(path.join(install, "logs")));
  check(
    "offline validation creates no user data or logs",
    !fs.existsSync(path.join(install, "userdata")) && !fs.existsSync(path.join(install, "logs")),
  );
  const web = path.join(install, "app/resources/web/index.html");
  const original = fs.readFileSync(web);
  fs.appendFileSync(web, "tampered");
  r = run();
  check("tampered resource rejected", r.status === 1 && r.stdout.includes("PACKAGE_REJECTED"));
  fs.writeFileSync(web, original);
  const manifestPath = path.join(install, "build-manifest.json");
  fs.renameSync(manifestPath, `${manifestPath}.fixture-backup`);
  r = run();
  check(
    "missing manifest rejected with no developer fallback",
    r.status === 1 && r.stdout.includes("PACKAGE_REJECTED"),
  );
  fs.renameSync(`${manifestPath}.fixture-backup`, manifestPath);
  const invalid = structuredClone(manifest);
  invalid.files.push({ path: "app/../../outside", sha256: "a".repeat(64) });
  fs.writeFileSync(manifestPath, JSON.stringify(invalid));
  check("traversal resource rejected", run().status === 1);
  function rejectManifest(name, mutate) {
    const bad = structuredClone(manifest);
    mutate(bad);
    fs.writeFileSync(manifestPath, JSON.stringify(bad));
    const result = run();
    check(name, result.status === 1 && result.stdout.includes("PACKAGE_REJECTED"));
  }
  rejectManifest("unsupported layout rejected", (m) => {
    m.layoutVersion = 2;
  });
  rejectManifest("wrong product rejected", (m) => {
    m.product = "other";
  });
  rejectManifest("missing version rejected", (m) => {
    delete m.version;
  });
  rejectManifest("mismatched version rejected", (m) => {
    m.version = "999.0.0";
  });
  rejectManifest("wrong architecture rejected", (m) => {
    m.platform = "linux-x64";
  });
  rejectManifest("unknown manifest format rejected", (m) => {
    m.manifestVersion = 2;
  });
  rejectManifest("unknown schema declaration rejected", (m) => {
    m.businessSchemaVersion = 24;
  });
  rejectManifest("missing required migration rejected", (m) => {
    m.files = m.files.filter((f) => !f.path.endsWith("0001_initial.sql"));
  });
  rejectManifest("missing knowledge migration rejected", (m) => {
    m.files = m.files.filter((f) => !f.path.endsWith("0002_knowledge.sql"));
  });
  rejectManifest("missing knowledge reading migration rejected", (m) => {
    m.files = m.files.filter((f) => !f.path.endsWith("0003_knowledge_read.sql"));
  });
  rejectManifest("missing output reserve migration rejected", (m) => {
    m.files = m.files.filter((f) => !f.path.endsWith("0023_qq_dispatch.sql"));
  });
  rejectManifest("case-insensitive duplicate rejected", (m) => {
    m.files.push({ ...m.files[0], path: m.files[0].path.toUpperCase().replace("APP/", "app/") });
  });
  rejectManifest("dot path alias rejected", (m) => {
    m.files[0].path = m.files[0].path.replace("app/", "app/./");
  });
  rejectManifest("empty path segment rejected", (m) => {
    m.files[0].path = m.files[0].path.replace("app/", "app//");
  });
  rejectManifest("malformed hash rejected", (m) => {
    m.files[0].sha256 = "invalid";
  });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  const missing = path.join(install, "app/resources/migrations/versions/0001_initial.sql");
  fs.renameSync(missing, `${missing}.fixture-backup`);
  check("missing listed file rejected", run().status === 1);
  fs.renameSync(`${missing}.fixture-backup`, missing);
  check(
    "installed build rejects development self-test",
    spawnSync(path.join(install, "superstring.exe"), ["--self-test"], {
      cwd: evidence,
      windowsHide: true,
      timeout: 20000,
    }).status === 1,
  );
  check("restored package validates", run().status === 0);
  check(
    "all rejection checks leave user state untouched",
    !fs.existsSync(path.join(install, "userdata")) && !fs.existsSync(path.join(install, "logs")),
  );
} catch (error) {
  process.exitCode = 1;
  checks.push({ name: String(error), pass: false });
}
fs.writeFileSync(
  path.join(evidence, "report.json"),
  JSON.stringify(
    {
      checks,
      note: "Native installed layout/resource validation only; no browser or server launched.",
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
