import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const stage = process.argv[2];
if (!stage || !path.isAbsolute(stage)) throw new Error("Pass absolute staged package path");
const validation = path.join(project, "artifacts/validation");
fs.mkdirSync(validation, { recursive: true });
const evidence = fs.mkdtempSync(path.join(validation, "standalone-"));
const install = path.join(evidence, "安装 空格路径");
fs.mkdirSync(install);
const manifest = JSON.parse(fs.readFileSync(path.join(stage, "build-manifest.json"), "utf8"));
for (const item of manifest.files) {
  if (!/^app\//.test(item.path) || item.path.includes(".."))
    throw new Error("Invalid manifest path");
  const dest = path.join(install, item.path);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(stage, item.path), dest, fs.constants.COPYFILE_EXCL);
}
const otherCwd = path.join(evidence, "unrelated-cwd");
fs.mkdirSync(otherCwd);
function request(port, route, token, method = "GET") {
  return new Promise((resolve, reject) => {
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
    req.setTimeout(1500, () => req.destroy(new Error("request timeout")));
    req.on("error", reject);
    req.end();
  });
}
async function portNumber() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
const checks = [];
function check(name, pass) {
  checks.push({ name, pass });
  if (!pass) throw new Error(name);
}
async function launch(round) {
  const port = await portNumber();
  const token = randomBytes(32).toString("hex");
  const env = {};
  for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP", "SystemDrive"])
    if (process.env[key]) env[key] = process.env[key];
  Object.assign(env, { SUPERSTRING_DEV_PORT: String(port), SUPERSTRING_DESKTOP_TOKEN: token });
  const child = spawn(path.join(install, "app/superstring-server.exe"), [], {
    cwd: otherCwd,
    env,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (b) => {
    output += b;
  });
  child.stderr.on("data", (b) => {
    output += b;
  });
  const exited = new Promise((resolve) => {
    child.once("exit", (code) => resolve(code));
    child.once("error", () => resolve(-1));
  });
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (child.exitCode !== null) throw new Error(`Service exited: ${output}`);
      try {
        ready = (await request(port, "/__desktop/status", token)).status === 200;
      } catch {}
      if (ready) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    check(`${round}: authenticated ready`, ready);
    check(`${round}: health`, (await request(port, "/health")).status === 200);
    const page = await request(port, "/");
    check(`${round}: static web`, page.status === 200 && page.body.includes("<html"));
    const sessions = await request(port, "/sessions");
    check(
      `${round}: fresh isolated sessions`,
      sessions.status === 200 && sessions.body.trim() === "[]",
    );
    check(
      `${round}: userdata database`,
      fs.existsSync(path.join(install, "userdata/data/superstring.sqlite")),
    );
    check(
      `${round}: private key in install root`,
      fs.existsSync(path.join(install, "userdata/state/browser-state.key")),
    );
    check(`${round}: no cwd data`, fs.readdirSync(otherCwd).length === 0);
  } finally {
    try {
      await request(port, "/__desktop/stop", token, "POST");
    } catch {}
    let timer;
    const code = await Promise.race([
      exited,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve("timeout"), 15000);
      }),
    ]);
    clearTimeout(timer);
    fs.writeFileSync(
      path.join(evidence, `round-${round}.log`),
      output.replaceAll(token, "[REDACTED]"),
    );
    check(`${round}: graceful shutdown`, code === 0);
  }
}
try {
  await launch(1);
  const key = fs.readFileSync(path.join(install, "userdata/state/browser-state.key"));
  await launch(2);
  check(
    "restart preserves state key",
    key.equals(fs.readFileSync(path.join(install, "userdata/state/browser-state.key"))),
  );
  check(
    "no source or node_modules in isolated install",
    !fs.existsSync(path.join(install, "src")) && !fs.existsSync(path.join(install, "node_modules")),
  );
} catch (error) {
  checks.push({ name: String(error), pass: false });
  process.exitCode = 1;
} finally {
  fs.writeFileSync(
    path.join(evidence, "report.json"),
    JSON.stringify(
      {
        install,
        checks,
        note: "Synthetic validation only. Not an installer or upgrade acceptance.",
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
