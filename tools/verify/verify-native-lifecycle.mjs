import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const [stage, playwrightModule] = process.argv.slice(2);
if (!stage || !path.isAbsolute(stage) || !playwrightModule || !path.isAbsolute(playwrightModule))
  throw Error("Expected absolute staging and Playwright module paths");
const { chromium } = await import(pathToFileURL(playwrightModule).href);
const parent = path.join(root, "artifacts/validation");
fs.mkdirSync(parent, { recursive: true });
const evidence = fs.mkdtempSync(path.join(parent, "native-lifecycle-"));
const install = path.join(evidence, "安装 空格路径");
fs.mkdirSync(install);
const manifest = JSON.parse(fs.readFileSync(path.join(stage, "build-manifest.json"), "utf8"));
for (const item of manifest.files) {
  if (
    !item.path.startsWith("app/") ||
    item.path.includes("..") ||
    item.path.includes("\\") ||
    item.path.includes(":")
  )
    throw Error("Unsafe fixture path");
  const dest = path.join(install, item.path);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(stage, item.path), dest, fs.constants.COPYFILE_EXCL);
}
fs.copyFileSync(path.join(stage, "build-manifest.json"), path.join(install, "build-manifest.json"));
fs.copyFileSync(
  path.join(root, "artifacts/build/desktop-validation/superstring.exe"),
  path.join(install, "superstring.exe"),
);
const unrelated = path.join(evidence, "unrelated-cwd");
fs.mkdirSync(unrelated);
const listener = net.createServer();
await new Promise((resolve, reject) => {
  listener.once("error", reject);
  listener.listen(0, "127.0.0.1", resolve);
});
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
const url = `http://127.0.0.1:${port}`;
const leaseFixture = path.join(evidence, "lease-fixture.exe");
const compiler = path.join(
  process.env.WINDIR || "C:/Windows",
  "Microsoft.NET/Framework64/v4.0.30319/csc.exe",
);
const compile = spawnSync(
  compiler,
  [
    "/nologo",
    "/target:exe",
    `/out:${leaseFixture}`,
    path.join(root, "tools/verify/maintenance-lease-fixture.cs"),
    path.join(root, "tools/desktop/src/MaintenanceLease.cs"),
  ],
  { windowsHide: true, encoding: "utf8" },
);
if (compile.status !== 0) throw Error(compile.stdout + compile.stderr);
function maintenanceAttempt() {
  return spawnSync(leaseFixture, [install, "maintenance"], { windowsHide: true, timeout: 5000 })
    .status;
}
const checks = [];
function check(name, pass) {
  checks.push({ name, pass });
  if (!pass) throw Error(name);
}
async function until(predicate, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}
function get(route = "/health") {
  return new Promise((resolve) => {
    const req = http.get(url + route, (res) => {
      let body = "";
      res.on("data", (s) => {
        body += s;
      });
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.setTimeout(1000, () => req.destroy());
    req.on("error", () => resolve({ status: 0, body: "" }));
  });
}
const env = {};
for (const [key, value] of Object.entries(process.env))
  if (["SYSTEMROOT", "WINDIR", "TEMP", "TMP", "SYSTEMDRIVE"].includes(key.toUpperCase()))
    env[key] = value;
env.SUPERSTRING_VALIDATION_PORT = String(port);
// Deliberately poisonous development overrides must never reach the installed server.
env.SUPERSTRING_DB_PATH = path.join(unrelated, "must-not-create.sqlite");
env.SUPERSTRING_APP_ROOT = unrelated;
env.SUPERSTRING_APP_MODE = "development";
env.SUPERSTRING_BUN_EXE = path.join(unrelated, "absent-bun.exe");
let child,
  browser,
  context,
  output = "",
  elapsedAfterClose = null;
try {
  browser = await chromium.launch({ channel: "msedge", headless: true });
  context = await browser.newContext();
  // The model is not part of this test. Prevent UI model-list probes reaching a real provider.
  await context.route("**/models/**", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "MODEL_SERVICE_UNAVAILABLE", message: "Isolated validation: model offline" },
      }),
    }),
  );
  child = spawn(path.join(install, "superstring.exe"), [], {
    cwd: unrelated,
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (b) => {
    output += b.toString("utf8");
  });
  child.stderr.on("data", (b) => {
    output += b.toString("utf8");
  });
  child.on("error", (error) => {
    output += String(error);
  });
  check(
    "native launcher reaches browser dispatch seam",
    await until(() => output.includes(`VALIDATION_BROWSER_READY ${url}/`), 40000),
  );
  check("native-launched installed server healthy", (await get()).status === 200);
  check("live native host refuses maintenance ownership", maintenanceAttempt() === 3);
  check(
    "desktop control rejects unauthenticated caller",
    (await get("/__desktop/status")).status === 401,
  );
  check("fresh install has no sessions", (await get("/sessions")).body.trim() === "[]");
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "设置", exact: true }).waitFor();
  check(
    "real web page receives desktop mode",
    (await page.locator('meta[name="desktop-mode"]').getAttribute("content")) === "1",
  );
  const appearanceFile = path.join(install, "userdata/state/desktop-appearance.json");
  check(
    "browser websocket persists initial appearance",
    await until(() => fs.existsSync(appearanceFile)),
  );
  const dispatchCount = () => output.split("VALIDATION_BROWSER_READY ").length - 1;
  const beforeSecond = dispatchCount();
  const duplicate = spawn(path.join(install, "superstring.exe"), [], {
    cwd: unrelated,
    env,
    windowsHide: true,
    stdio: "ignore",
  });
  duplicate.on("error", () => {});
  check(
    "second native invocation exits without duplicate host",
    (await until(() => duplicate.exitCode !== null, 10000)) && duplicate.exitCode === 0,
  );
  check(
    "second invocation notifies original browser dispatch",
    await until(() => dispatchCount() === beforeSecond + 1, 5000),
  );
  check(
    "original host remains healthy after second invocation",
    child.exitCode === null && (await get()).status === 200,
  );
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "外观", exact: true }).click();
  // Use the rendered second theme's accessible name, not a guessed color label.
  const theme = page.locator("button.theme-option").nth(1);
  await theme.click();
  check(
    "real theme click persists blue snapshot",
    await until(() => {
      try {
        return JSON.parse(fs.readFileSync(appearanceFile, "utf8")).theme === "blue";
      } catch {
        return false;
      }
    }),
  );
  await page.screenshot({ path: path.join(evidence, "appearance.png"), fullPage: true });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "设置", exact: true }).waitFor();
  check(
    "refresh survives with same native host",
    child.exitCode === null && (await get()).status === 200,
  );
  const second = await context.newPage();
  await second.goto(url, { waitUntil: "domcontentloaded" });
  await second.getByRole("button", { name: "设置", exact: true }).waitFor();
  // A completed appearance write proves a second-tab WS round trip before closing tab one.
  await second.getByRole("button", { name: "设置", exact: true }).click();
  await second.getByRole("button", { name: "外观", exact: true }).click();
  await second.locator("button.theme-option").nth(2).click();
  check(
    "second tab establishes live appearance channel",
    await until(() => {
      try {
        return JSON.parse(fs.readFileSync(appearanceFile, "utf8")).theme === "indigo";
      } catch {
        return false;
      }
    }),
  );
  await page.close();
  // Deliberately observe beyond the production eight-second last-page grace.
  const observationEnd = Date.now() + 9000;
  let alive = true;
  while (Date.now() < observationEnd) {
    if (child.exitCode !== null || (await get()).status !== 200) {
      alive = false;
      break;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  check("closing one of two tabs does not stop server after grace", alive);
  check("isolated browser has no uncaught page errors", errors.length === 0);
  const closedAt = Date.now();
  await second.close();
  check(
    "last tab closes native host gracefully",
    (await until(() => child.exitCode !== null, 20000)) && child.exitCode === 0,
  );
  elapsedAfterClose = Date.now() - closedAt;
  check(
    "last-tab exit respects eight-second grace",
    elapsedAfterClose >= 7500 && elapsedAfterClose < 20000,
  );
  check("server port released with native host", (await get()).status === 0);
  check("normal native shutdown releases maintenance ownership", maintenanceAttempt() === 0);
  check(
    "database stored under installation userdata",
    fs.existsSync(path.join(install, "userdata/data/superstring.sqlite")),
  );
  check(
    "private key stored under installation userdata",
    fs.existsSync(path.join(install, "userdata/state/browser-state.key")),
  );
  check(
    "native logs stored under installation root",
    fs.readdirSync(path.join(install, "logs")).some((name) => name.endsWith(".log")),
  );
  check(
    "poisoned overrides and unrelated cwd receive no writes",
    fs.readdirSync(unrelated).length === 0,
  );
  check(
    "isolated package needs no source or node_modules",
    !fs.existsSync(path.join(install, "src")) && !fs.existsSync(path.join(install, "node_modules")),
  );
} catch (error) {
  process.exitCode = 1;
  checks.push({ name: String(error), pass: false });
} finally {
  if (context) await context.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  // Last page close triggers normal shutdown. Never hard-kill a SQLite service.
  if (child && child.exitCode === null) {
    const exited = await until(() => child.exitCode !== null, 135000);
    checks.push({ name: "failure cleanup exits owned host without force kill", pass: exited });
    if (!exited) {
      process.exitCode = 1;
      child.unref();
      child.stdout.destroy();
      child.stderr.destroy();
    }
  }
  fs.writeFileSync(path.join(evidence, "launcher-output.txt"), output);
  fs.writeFileSync(
    path.join(evidence, "report.json"),
    JSON.stringify(
      {
        checks,
        elapsedAfterClose,
        install,
        note: "Validation-compiled native Program/Launcher, isolated real Edge. Browser dispatch seam substituted; not default-browser, installer, upgrade, or clean-machine acceptance.",
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
      elapsedAfterClose,
    }),
  );
}
