/**
 * verify-launcher.mjs — directional integration test for the superstring
 * Windows launcher (start.cmd at the PROJECT ROOT + tools/ops/start.ts helper +
 * tools/ops/open-when-ready.ts browser opener).
 *
 * Runs ONLY this launcher path (not the full verify-all suite). Uses
 * child_process.spawnSync with an explicit cwd and utf-8 capture so logs are
 * reliable even when the interactive shell is constrained.
 *
 * Isolation policy (per review feedback):
 *   - The server is NEVER launched against the real project root. Each server
 *     run uses a synthetic cwd (a temp dir) with a junction to the real
 *     dist/web, so the cwd-relative artifacts/state browser-state key and the
 *     business DB are created inside the temp dir, NOT in the real project.
 *   - The "--no-build missing" regression uses a separate tiny fixture (fake
 *     vite marker, no dist) instead of renaming/moving the real dist/web.
 *   - The only deliberate side effect on the real project is the frontend build
 *     (scenario 3), which writes the intended build output dist/web.
 *
 * Scenarios:
 *   1. start.ts --check preflight (bun)
 *   2. start.cmd --check preflight (batch file)
 *   3. build via start.ts default (vite build) -> dist/web present
 *   4. --no-build preflight positive (dist present)
 *   5. --no-build preflight negative in an isolated fixture (dist missing -> fail)
 *   6. launch server in a synthetic cwd, GET /health (JSON) and GET / (HTML)
 *   7. stop a launched server via SIGINT (TerminateProcess on Windows, NOT a
 *      graceful shutdown) and confirm it stops serving
 *   8. port conflict: a second instance on the same port must exit without
 *      killing the first (only self-spawned processes are recycled)
 *   9. --check with port in use must return non-zero
 *  10. --port env consistency: start.cmd --check --port X must report dev port X
 *  11. invalid params rejected: start.ts --port <non-int>, start.cmd --port
 *      without value, start.cmd unknown arg
 *  12. strict helper args (unknown switch, missing value, value that is a switch)
 *  13. inherited SUPERSTRING_DEV_PORT is honored and displayed consistently
 *  14. an invalid explicit SUPERSTRING_BUN_EXE fails loudly
 *  15. --check / --no-build with the port held: non-zero and never "is serving"
 *  16. --help: exit 0, documents --open/--no-open/--db, starts nothing
 *  17. --check never opens a browser even though opening is the default
 *  18. default port reported correctly in a dry fixture (no socket bound)
 *  19. model service probe: unreachable -> guidance printed, still exit 0
 *  20. model service probe: reachable -> reported as connected
 *  21. browser opener: ready /health resolves the URL in print-only mode
 *  22. browser opener: closed port gives up within the timeout, exit 1
 *  23. browser opener: strict args (unknown switch, missing --port)
 *  24. one-click end-to-end: REAL launcher -> REAL server -> /health + page, and
 *      the background opener reports readiness (print mode: no real browser)
 *  25. one-click cleanup: after taskkill the port serves nothing
 *
 * All port-dependent scenarios pass an explicit free port; nothing depends on
 * the machine's default 17861 being free (a real server may be running there,
 * and refusing an occupied port is correct launcher behaviour).
 *
 * Output: a timestamped JSON artefact under artifacts/validation/ that keeps
 * failure evidence (captured stdout/stderr).
 *
 * NOTE on Windows signal semantics: process.kill("SIGINT") on Windows is
 * implemented as TerminateProcess — it does NOT deliver a true graceful
 * SIGINT. We therefore never claim "graceful exit"; we only verify the process
 * is gone and stops serving.
 */

import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(SCRIPT_DIR, "..", "..");
const START_TS = path.join(ROOT, "tools", "ops", "start.ts");
const START_CMD = path.join(ROOT, "start.cmd");
const OPENER = path.join(ROOT, "tools", "ops", "open-when-ready.ts");
const SERVER_ENTRY = path.join(ROOT, "src", "server", "index.ts");
const RESULTS_DIR = path.join(ROOT, "artifacts", "validation");

const TEST_PORT = 17901; // normal launch / page / exit test
const PREFLIGHT_PORT = 17941; // hermetic preflight/build (never the default port:
// a real server may already be running on 17861 on this machine, and refusing an
// occupied port is correct launcher behaviour, so the suite must not depend on it)
const CONFLICT_PORT = 17911; // conflict test (both instances)
const INUSE_PORT = 17921; // port-in-use regression (held by a dummy server)
const ENV_PORT = 17922; // env-consistency regression
const ENV_PORT2 = 17923; // env-consistency regression (start.ts direct)
const OPENER_DEAD_PORT = 17924; // browser-opener timeout regression (kept closed)
const ONECLICK_PORT = 17931; // one-click end-to-end (real launcher + real server)
// Point LM Studio at a closed port so the /health model check fails instantly
// (no real model service is contacted) instead of waiting on the check budget.
const UNREACHABLE_LM = "http://127.0.0.1:1/v1";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toISOString().replace(/[:.]/g, "-");

function resolveBun() {
  const explicit = (process.env.SUPERSTRING_BUN_EXE ?? "").trim();
  if (explicit && existsSync(explicit)) return explicit;
  const local = path.join(ROOT, "node_modules", "bun", "bin", "bun.exe");
  if (existsSync(local)) return local;
  return "bun";
}

/** Keep logs readable: on failure only the tail matters. */
function trunc(s, n = 12000) {
  return s && s.length > n ? `...[truncated ${s.length - n} chars]\n${s.slice(-n)}` : (s ?? "");
}

/** Run a command, capturing utf-8 output. Returns status + (truncated) logs. */
function runSync(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd ?? ROOT,
    env: opts.env ?? process.env,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: opts.timeout ?? 60000,
  });
  return {
    status: r.status,
    signal: r.signal,
    stdout: trunc(r.stdout ?? ""),
    stderr: trunc(r.stderr ?? ""),
    error: r.error ? String(r.error) : null,
  };
}

/**
 * Same result shape as runSync, but asynchronous. REQUIRED whenever the child
 * talks back to something THIS process hosts — the loopback stubs behind the
 * model-probe and opener scenarios. spawnSync blocks the event loop, so an
 * in-process stub cannot answer and the child is guaranteed to fail; that
 * failure says nothing about the launcher.
 */
function runAsync(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd ?? ROOT,
      env: opts.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let error = null;
    child.stdout?.on("data", (d) => (stdout += d.toString("utf8")));
    child.stderr?.on("data", (d) => (stderr += d.toString("utf8")));
    child.on("error", (e) => (error = String(e)));
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, opts.timeout ?? 60000);
    child.on("close", (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, stdout: trunc(stdout), stderr: trunc(stderr), error });
    });
  });
}

/** HTTP GET via node:http (independent of global fetch availability). */
function httpGet(url, timeoutMs = 2000) {
  return new Promise((resolve) => {
    let u;
    try {
      u = new URL(url);
    } catch {
      resolve({ ok: false, status: 0, ct: "", body: "", error: "bad url" });
      return;
    }
    const req = http.get(
      { host: u.hostname, port: u.port, path: u.pathname + u.search, timeout: timeoutMs },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 400,
            status: res.statusCode,
            ct: res.headers["content-type"] || "",
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (e) =>
      resolve({ ok: false, status: 0, ct: "", body: "", error: String(e.message || e) }),
    );
  });
}

async function waitForHealth(port, timeoutMs = 25000) {
  const start = Date.now();
  let lastErr = "";
  let attempts = 0;
  // Each /health response can take a moment (the model check has a budget), so
  // give every attempt a generous client timeout instead of flooding.
  while (Date.now() - start < timeoutMs) {
    const r = await httpGet(`http://127.0.0.1:${port}/health`, 6000);
    attempts++;
    if (r.ok) return true;
    if (r.error) lastErr = r.error;
    if (attempts <= 3) {
      console.log(
        `[verify] health attempt ${attempts}: ok=${r.ok} status=${r.status} err=${r.error}`,
      );
    }
    await sleep(800);
  }
  console.log(`[verify] health gave up after ${attempts} attempts; lastErr=${lastErr}`);
  return false;
}

async function healthOk(port) {
  const r = await httpGet(`http://127.0.0.1:${port}/health`, 6000);
  return r.ok;
}

/**
 * Make a synthetic server cwd: a temp dir with a junction to the real dist/web
 * so the server can serve the built frontend, while artifacts/state and the
 * business DB are written inside the temp dir (never the real project).
 *
 * The CALLER must push the returned path into `allFixtures`: teardown only
 * walks that array, so an unregistered fixture (and its data/*.sqlite + -shm +
 * -wal) stays behind in artifacts/validation forever.
 */
function makeServerFixture(tag) {
  const fx = mkdtempSync(path.join(RESULTS_DIR, `superstring-srv-${tag}-`));
  try {
    symlinkSync(path.join(ROOT, "dist"), path.join(fx, "dist"), "junction");
  } catch (e) {
    throw new Error(`could not junction dist into fixture ${fx}: ${e.message}`);
  }
  return fx;
}

/**
 * Synthetic launcher fixture: a temp dir shaped like the project root, holding a
 * copy of the real root start.cmd plus stub helpers and a stub server entry. It
 * exercises the batch file's own control flow (arg parsing, cd, env, banner)
 * without building the frontend, opening a business DB or starting a real
 * server. Stub programs only echo the environment they received.
 */
function makeLauncherFixture(tag) {
  const fx = mkdtempSync(path.join(RESULTS_DIR, `launcher-fx-${tag}-`));
  allFixtures.push(fx);
  mkdirSync(path.join(fx, "tools", "ops"), { recursive: true });
  mkdirSync(path.join(fx, "src", "server"), { recursive: true });
  writeFileSync(path.join(fx, "start.cmd"), readFileSync(START_CMD));
  writeFileSync(path.join(fx, "tools", "ops", "start.ts"), "process.exit(0);\n");
  writeFileSync(path.join(fx, "tools", "ops", "open-when-ready.ts"), "process.exit(0);\n");
  writeFileSync(
    path.join(fx, "src", "server", "index.ts"),
    "console.log('fixture-port=' + (process.env.SUPERSTRING_DEV_PORT ?? '<unset>'));\n",
  );
  return fx;
}

function launchServer(bun, { port, dbPath, cwd }) {
  const env = {
    ...process.env,
    SUPERSTRING_SERVE_WEB: "1",
    SUPERSTRING_DEV_PORT: String(port),
    SUPERSTRING_DB_PATH: dbPath,
    LM_STUDIO_BASE_URL: UNREACHABLE_LM,
  };
  const child = spawn(bun, ["run", SERVER_ENTRY], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.log = "";
  child.on("error", (e) => {
    child.log += `\n[SPAWN ERROR] ${e}\n`;
  });
  child.stdout?.on("data", (d) => (child.log += d.toString("utf8")));
  child.stderr?.on("data", (d) => (child.log += d.toString("utf8")));
  return child;
}

function waitExit(child, timeoutMs) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ exited: true, code: child.exitCode, signal: child.signalCode });
      return;
    }
    const t = setTimeout(() => resolve({ exited: false, code: null, signal: null }), timeoutMs);
    child.on("exit", (code, signal) => {
      clearTimeout(t);
      resolve({ exited: true, code, signal });
    });
  });
}

/** Poll a streamed child log for a marker until it appears or the deadline hits. */
async function waitForLog(child, needle, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.log.includes(needle)) return true;
    await sleep(200);
  }
  return child.log.includes(needle);
}

/** Stop a server: SIGINT, then SIGTERM after 3s, then SIGKILL after 9s. */
function stopServer(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve({ how: "already-exited", code: child.exitCode, signal: child.signalCode });
      return;
    }
    let settled = false;
    const finish = (how) => {
      if (settled) return;
      settled = true;
      resolve({ how, code: child.exitCode, signal: child.signalCode });
    };
    const tHard = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // Cleanup is best-effort for processes or handles already closed.
      }
      finish("hard");
    }, 9000);
    const tTerm = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        // Cleanup is best-effort for processes or handles already closed.
      }
    }, 3000);
    child.on("exit", (code, signal) => {
      clearTimeout(tTerm);
      clearTimeout(tHard);
      finish(signal ? `signal:${signal}` : `exit:${code}`);
    });
    // On Windows SIGINT == TerminateProcess (forced), not a graceful handler.
    try {
      child.kill("SIGINT");
    } catch {
      /* fall through to timers */
    }
  });
}

/** Bind a port and hold it open so a preflight probe sees it as occupied. */
function holdPort(port) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", (e) => reject(e));
    srv.listen(Number(port), "127.0.0.1", () => resolve(srv));
  });
}

/**
 * Minimal node:http stub on an ephemeral port. This verifier runs under Node
 * (not Bun), so it must not use Bun.serve. Returns the port plus a close().
 */
async function startHttpStub(handler) {
  // Remember what actually arrived: when a probe reports "not connected", the
  // first question is whether the request ever reached the stub at all.
  const requests = [];
  const srv = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    handler(req, res);
  });
  await new Promise((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", resolve);
  });
  const address = srv.address();
  return {
    port: typeof address === "object" && address ? address.port : 0,
    requests,
    close: () => new Promise((resolve) => srv.close(resolve)),
  };
}

/** JSON responder that answers 200 on `path` and 404 elsewhere. */
function jsonOnPath(path, body) {
  return (req, res) => {
    if (req.url?.split("?")[0] !== path) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
  };
}

const bun = resolveBun();
const allChildren = [];
const allFixtures = [];
const scenarios = [];
function record(name, ok, detail, extra = {}) {
  scenarios.push({ name, ok, detail, ...extra });
  console.log(`\n=== ${name}: ${ok ? "PASS" : "FAIL"} ===\n${detail}`);
}

async function main() {
  console.log(`[verify] root=${ROOT}`);
  console.log(`[verify] bun=${bun}`);
  console.log(`[verify] start.ts=${existsSync(START_TS)} start.cmd=${existsSync(START_CMD)}`);

  mkdirSync(RESULTS_DIR, { recursive: true });
  const iso = ts();
  const outPath = path.join(RESULTS_DIR, `launcher-verify-${iso}.json`);

  // 1. start.ts --check (bun). Explicit port: see PREFLIGHT_PORT.
  {
    const r = runSync(bun, [START_TS, "--check", "--port", String(PREFLIGHT_PORT)]);
    const ok = r.status === 0;
    record(
      "preflight-start.ts",
      ok,
      `exit=${r.status}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`,
      r,
    );
  }

  // 2. start.cmd --check (batch)
  {
    const r = runSync("cmd.exe", ["/c", START_CMD, "--check", "--port", String(PREFLIGHT_PORT)], {
      cwd: ROOT,
    });
    const ok = r.status === 0;
    record(
      "preflight-start.cmd",
      ok,
      `exit=${r.status}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`,
      r,
    );
  }

  // 3. build via start.ts default (vite build) -> dist/web present (real build)
  {
    const r = runSync(bun, [START_TS, "--port", String(PREFLIGHT_PORT)]);
    const built = existsSync(path.join(ROOT, "dist", "web", "index.html"));
    const ok = r.status === 0 && built;
    record(
      "build",
      ok,
      `exit=${r.status} dist/web/index.html=${built}\n--- stdout(tail) ---\n${r.stdout}\n--- stderr(tail) ---\n${r.stderr}`,
      { ...r, built },
    );
  }

  // 4. --no-build positive (dist present)
  {
    const r = runSync(bun, [START_TS, "--no-build", "--port", String(PREFLIGHT_PORT)]);
    const ok = r.status === 0;
    record("no-build-positive", ok, `exit=${r.status}\n--- stdout ---\n${r.stdout}`, r);
  }

  // 5. --no-build negative in an ISOLATED fixture (no dist/web -> must fail).
  //    Uses a tiny synthetic cwd with a fake vite marker; the real dist/web is
  //    never moved or renamed.
  {
    const fx = mkdtempSync(path.join(RESULTS_DIR, "superstring-nobuild-"));
    allFixtures.push(fx);
    mkdirSync(path.join(fx, "node_modules", ".bin"), { recursive: true });
    mkdirSync(path.join(fx, "node_modules", "vite", "bin"), { recursive: true });
    writeFileSync(path.join(fx, "node_modules", ".bin", "vite"), "");
    writeFileSync(path.join(fx, "node_modules", "vite", "bin", "vite.js"), "");
    // NO dist/web -> frontendBuilt() must be false.
    const r = runSync(bun, [START_TS, "--no-build"], { cwd: fx });
    const ok = r.status !== 0; // expected to FAIL (no build present)
    record(
      "no-build-negative-fixture",
      ok,
      `exit=${r.status} (expected non-zero)\n--- stdout ---\n${r.stdout}`,
      r,
    );
  }

  // 6. launch server in a synthetic cwd + health + page
  let srvFixture = null;
  {
    srvFixture = makeServerFixture("main");
    allFixtures.push(srvFixture);
    const dbPath = path.join(srvFixture, "data", "superstring.sqlite");
    const child = launchServer(bun, { port: TEST_PORT, dbPath, cwd: srvFixture });
    allChildren.push(child);
    const ready = await waitForHealth(TEST_PORT);
    let health = null;
    let page = null;
    if (ready) {
      health = await httpGet(`http://127.0.0.1:${TEST_PORT}/health`, 6000);
      page = await httpGet(`http://127.0.0.1:${TEST_PORT}/`, 2000);
    }
    const pageOk = page?.ok && /text\/html/i.test(page.ct) && /<!doctype html>/i.test(page.body);
    const ok = ready && health?.ok && pageOk;
    record(
      "launch-health-page",
      ok,
      `ready=${ready}\nhealth: ${health ? `status=${health.status} json=${health.body.slice(0, 200)}` : "n/a"}\n` +
        `page: ${page ? `status=${page.status} ct=${page.ct} htmlStart=${page.body.slice(0, 60).replace(/\n/g, " ")}` : "n/a"}\n` +
        `--- server stdout ---\n${child.log.slice(-4000)}`,
      { ready, healthStatus: health?.status, pageStatus: page?.status, pageCt: page?.ct },
    );
    scenarios[scenarios.length - 1]._child = child;
  }

  // 7. stop the same server via SIGINT (TerminateProcess on Windows; NOT a
  //    graceful shutdown). We only verify it is gone and stops serving.
  {
    const child = scenarios.find((s) => s.name === "launch-health-page")?._child;
    if (!child) {
      record("stop-via-sigint", false, "no server from launch scenario to stop");
    } else {
      const stop = await stopServer(child);
      await sleep(500);
      const stillRunning = await healthOk(TEST_PORT);
      // On Windows SIGINT forces termination, so we accept any exit/signal that
      // removed the process and left nothing serving.
      const exited = child.exitCode !== null || child.signalCode !== null;
      const ok = !stillRunning && exited;
      record(
        "stop-via-sigint",
        ok,
        `stopped via=${stop.how} code=${stop.code} signal=${stop.signal} stillServing=${stillRunning}\n` +
          `(note: on Windows SIGINT == TerminateProcess; this is a forced stop, not graceful shutdown)\n` +
          `--- server stdout ---\n${child.log.slice(-3000)}`,
        { how: stop.how, code: stop.code, signal: stop.signal, stillServing: stillRunning },
      );
    }
  }

  // 8. port conflict: a second instance on the same port must exit without
  //    killing the first. Launch A, confirm it is serving, THEN launch B so A is
  //    guaranteed to be the first binder (avoids a bun-startup race).
  {
    const fxA = makeServerFixture("conflict-a");
    const fxB = makeServerFixture("conflict-b");
    allFixtures.push(fxA, fxB);
    const dbA = path.join(fxA, "data", "superstring-a.sqlite");
    const dbB = path.join(fxB, "data", "superstring-b.sqlite");
    const a = launchServer(bun, { port: CONFLICT_PORT, dbPath: dbA, cwd: fxA });
    allChildren.push(a);
    const aReady = await waitForHealth(CONFLICT_PORT, 25000);
    // Only spawn B after A is confirmed up; B must hit EADDRINUSE.
    const b = aReady ? launchServer(bun, { port: CONFLICT_PORT, dbPath: dbB, cwd: fxB }) : null;
    if (b) allChildren.push(b);
    const bExit = b ? await waitExit(b, 12000) : { exited: false, code: null, signal: null };
    await sleep(500);
    const aStillUp = await healthOk(CONFLICT_PORT);
    const ok = aReady && bExit.exited && bExit.code !== 0 && aStillUp;
    record(
      "port-conflict",
      ok,
      `aReady=${aReady} bExited=${bExit.exited} bCode=${bExit.code} bSignal=${bExit.signal} aStillServing=${aStillUp}\n` +
        `--- A stdout ---\n${a.log.slice(-2500)}\n--- B stdout ---\n${(b?.log || "").slice(-2500)}`,
      { aReady, bExited: bExit.exited, bCode: bExit.code, aStillUp },
    );
    // only recycle our own processes
    if (a.exitCode === null && a.signalCode === null) await stopServer(a);
  }

  // 9. --check with port in use must return non-zero
  {
    let held = null;
    let ok = false;
    let detail = "";
    try {
      held = await holdPort(INUSE_PORT);
      const r = runSync(bun, [START_TS, "--check", "--port", String(INUSE_PORT)]);
      ok = r.status !== 0;
      detail = `exit=${r.status} (expected non-zero because port ${INUSE_PORT} is held)\n--- stdout ---\n${r.stdout}`;
    } catch (e) {
      detail = `could not hold port ${INUSE_PORT}: ${e.message}`;
    } finally {
      try {
        held?.close();
      } catch {
        // Cleanup is best-effort for processes or handles already closed.
      }
    }
    record("check-port-inuse", ok, detail);
  }

  // 10. --port env consistency: start.cmd --check --port X must report dev port X
  {
    const r = runSync("cmd.exe", ["/c", START_CMD, "--check", "--port", String(ENV_PORT)], {
      cwd: ROOT,
    });
    const printed = r.stdout.includes(`dev port    : ${ENV_PORT}`);
    const ok = r.status === 0 && printed;
    record(
      "port-env-consistency",
      ok,
      `start.cmd --check --port ${ENV_PORT}\nexit=${r.status} reportedDevPort=${ENV_PORT}=${printed}\n--- stdout ---\n${r.stdout}`,
      { exit: r.status, reportedDevPort: printed },
    );
    // Also confirm the helper honours --port directly (argument path).
    const r2 = runSync(bun, [START_TS, "--check", "--port", String(ENV_PORT2)]);
    const printed2 = r2.stdout.includes(`dev port    : ${ENV_PORT2}`);
    record(
      "port-env-consistency-arg",
      r2.status === 0 && printed2,
      `start.ts --check --port ${ENV_PORT2}\nexit=${r2.status} reportedDevPort=${ENV_PORT2}=${printed2}\n--- stdout ---\n${r2.stdout}`,
      { exit: r2.status, reportedDevPort: printed2 },
    );
  }

  // 11. invalid params rejected
  {
    // 11a. start.ts --port <non-integer> -> non-zero
    const a = runSync(bun, [START_TS, "--port", "notanumber", "--check"]);
    const aOk = a.status !== 0;
    record(
      "invalid-param-start.ts",
      aOk,
      `start.ts --port notanumber -> exit=${a.status}\n--- stdout ---\n${a.stdout}`,
      { exit: a.status },
    );

    // 11b. start.cmd --port without a value -> non-zero (rejected)
    const b = runSync("cmd.exe", ["/c", START_CMD, "--port"], { cwd: ROOT });
    const bOk = b.status !== 0;
    record(
      "invalid-param-start.cmd-missing",
      bOk,
      `start.cmd --port (no value) -> exit=${b.status}\n--- stdout ---\n${b.stdout}\n--- stderr ---\n${b.stderr}`,
      { exit: b.status },
    );

    // 11c. start.cmd unknown arg -> non-zero (rejected)
    const c = runSync("cmd.exe", ["/c", START_CMD, "--bogus"], { cwd: ROOT });
    const cOk = c.status !== 0;
    record(
      "invalid-param-start.cmd-unknown",
      cOk,
      `start.cmd --bogus (unknown) -> exit=${c.status}\n--- stdout ---\n${c.stdout}\n--- stderr ---\n${c.stderr}`,
      { exit: c.status },
    );
  }

  // Additional regressions: helper parsing, batch exit propagation and inherited env.
  for (const args of [
    ["--check", "--bogus"],
    ["--check", "--port"],
    ["--check", "--port", "--no-build"],
  ]) {
    const r = runSync(bun, [START_TS, ...args]);
    record(`strict-helper-${args.join("-")}`, r.status === 2, `exit=${r.status}`, r);
  }
  {
    const env = { ...process.env, SUPERSTRING_DEV_PORT: String(ENV_PORT2) };
    const r = runSync("cmd.exe", ["/c", START_CMD, "--check"], { env });
    record(
      "inherited-port-check",
      r.status === 0 && r.stdout.includes(`dev port    : ${ENV_PORT2}`),
      `exit=${r.status}`,
      r,
    );
    const bad = runSync("cmd.exe", ["/c", START_CMD, "--check"], {
      env: { ...process.env, SUPERSTRING_BUN_EXE: path.join(RESULTS_DIR, "nonexistent-bun.exe") },
    });
    record("invalid-explicit-bun", bad.status === 2, `exit=${bad.status}`, bad);
  }
  {
    const held = await holdPort(INUSE_PORT);
    try {
      for (const mode of ["--check", "--no-build"]) {
        const r = runSync("cmd.exe", ["/c", START_CMD, mode, "--port", String(INUSE_PORT)]);
        record(
          `batch-port-blocked-${mode}`,
          r.status !== null && r.status !== 0 && !r.stdout.includes("is serving at"),
          `exit=${r.status}`,
          r,
        );
      }
    } finally {
      await new Promise((resolve) => held.close(resolve));
    }
  }
  // Execute the batch's normal launch path with synthetic helper/server files.
  // This tests the displayed URL without starting a real server or opening a DB.
  {
    const fx = makeLauncherFixture("env");
    const r = runSync("cmd.exe", ["/c", path.join(fx, "start.cmd"), "--no-build"], {
      env: { ...process.env, SUPERSTRING_BUN_EXE: bun, SUPERSTRING_DEV_PORT: String(ENV_PORT2) },
    });
    record(
      "inherited-port-display",
      r.status === 0 &&
        r.stdout.includes(`http://127.0.0.1:${ENV_PORT2}/`) &&
        r.stdout.includes(`fixture-port=${ENV_PORT2}`),
      `exit=${r.status}`,
      r,
    );
  }

  // --help must be a pure usage dump: exit 0, document both open switches, and
  // never build, serve or open anything.
  {
    const r = runSync("cmd.exe", ["/c", START_CMD, "--help"], { cwd: ROOT });
    const ok =
      r.status === 0 &&
      r.stdout.includes("--no-open") &&
      r.stdout.includes("--open") &&
      r.stdout.includes("--db") &&
      !r.stdout.includes("is serving at");
    record("help-exit0", ok, `exit=${r.status}\n--- stdout ---\n${r.stdout}`, r);
  }

  // --check must never open a browser even when the default says "open".
  {
    const r = runSync("cmd.exe", ["/c", START_CMD, "--check", "--port", String(PREFLIGHT_PORT)], {
      cwd: ROOT,
    });
    const ok = r.status === 0 && !r.stdout.includes("[open]");
    record(
      "check-never-opens",
      ok,
      `exit=${r.status} containsOpenLine=${r.stdout.includes("[open]")}\n--- stdout ---\n${r.stdout}`,
      r,
    );
  }

  // The default port must be reported correctly when nothing overrides it. Run in
  // a fixture with stub programs and SUPERSTRING_DEV_PORT removed, so this is
  // hermetic: no socket is bound and the machine's real 17861 is irrelevant.
  {
    const fx = makeLauncherFixture("defaultport");
    const env = { ...process.env, SUPERSTRING_BUN_EXE: bun };
    delete env.SUPERSTRING_DEV_PORT;
    delete env.SUPERSTRING_DB_PATH;
    const r = runSync("cmd.exe", ["/c", path.join(fx, "start.cmd"), "--no-build"], { env });
    record(
      "default-port-display",
      r.status === 0 &&
        r.stdout.includes("fixture-port=<unset>") &&
        r.stdout.includes("http://127.0.0.1:17861/"),
      `exit=${r.status} (expects the banner to resolve the default port and the launcher to\n` +
        `leave SUPERSTRING_DEV_PORT unset, so the server falls back to its own default)\n` +
        `--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`,
      r,
    );
  }

  // Component status reporting: the helper must probe the model service at the
  // configured address and print manual guidance when it is unreachable.
  {
    const unreachable = runSync(bun, [START_TS, "--check", "--port", String(PREFLIGHT_PORT)], {
      cwd: ROOT,
      env: { ...process.env, LM_STUDIO_BASE_URL: UNREACHABLE_LM },
    });
    const guides =
      unreachable.stdout.includes("model svc   : NOT connected") &&
      unreachable.stdout.includes("Start Server") &&
      unreachable.stdout.includes("LM_STUDIO_BASE_URL");
    record(
      "model-probe-down-guidance",
      unreachable.status === 0 && guides,
      `exit=${unreachable.status}\n--- stdout ---\n${unreachable.stdout}`,
      unreachable,
    );

    // And report "connected" when an OpenAI-compatible /models endpoint answers.
    const stub = await startHttpStub(jsonOnPath("/v1/models", { data: [] }));
    try {
      const up = await runAsync(bun, [START_TS, "--check", "--port", String(PREFLIGHT_PORT)], {
        cwd: ROOT,
        env: { ...process.env, LM_STUDIO_BASE_URL: `http://127.0.0.1:${stub.port}/v1` },
      });
      record(
        "model-probe-up",
        up.status === 0 && up.stdout.includes("model svc   : connected"),
        `exit=${up.status} port=${stub.port} stubSaw=${JSON.stringify(stub.requests)}\n--- stdout ---\n${up.stdout}`,
        up,
      );
    } finally {
      await stub.close();
    }

    // LM Studio can be told to require an API token. A 401 must be reported as
    // "the service is up but refused the call" (with the fix), not as an
    // unreachable service — and the probe must actually send the configured
    // token instead of always being anonymous.
    const requiredToken = "synthetic-required-token";
    const protectedStub = await startHttpStub((req, res) => {
      if (req.url?.split("?")[0] !== "/v1/models") {
        res.writeHead(404).end("not found");
        return;
      }
      if ((req.headers.authorization ?? "") === `Bearer ${requiredToken}`) {
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ data: [] }));
        return;
      }
      res
        .writeHead(401, { "content-type": "application/json" })
        .end('{"error":{"code":"invalid_api_key"}}');
    });
    try {
      const base = `http://127.0.0.1:${protectedStub.port}/v1`;
      const anonymous = await runAsync(
        bun,
        [START_TS, "--check", "--port", String(PREFLIGHT_PORT)],
        {
          cwd: ROOT,
          env: { ...process.env, LM_STUDIO_BASE_URL: base, LM_STUDIO_API_KEY: "" },
        },
      );
      record(
        "model-probe-auth-required",
        anonymous.status === 0 &&
          anonymous.stdout.includes("model svc   : AUTH REQUIRED") &&
          anonymous.stdout.includes("LM_STUDIO_API_KEY"),
        `exit=${anonymous.status} port=${protectedStub.port} stubSaw=${JSON.stringify(protectedStub.requests)}\n--- stdout ---\n${anonymous.stdout}`,
        anonymous,
      );

      const withKey = await runAsync(bun, [START_TS, "--check", "--port", String(PREFLIGHT_PORT)], {
        cwd: ROOT,
        env: { ...process.env, LM_STUDIO_BASE_URL: base, LM_STUDIO_API_KEY: requiredToken },
      });
      record(
        "model-probe-token-accepted",
        withKey.status === 0 && withKey.stdout.includes("model svc   : connected"),
        `exit=${withKey.status} port=${protectedStub.port}\n--- stdout ---\n${withKey.stdout}`,
        withKey,
      );
    } finally {
      await protectedStub.close();
    }
  }

  // Browser opener, direct: must resolve the URL from a real /health probe and
  // (in print-only mode) must NOT launch a browser.
  {
    const stub = await startHttpStub(jsonOnPath("/health", { status: "ok" }));
    try {
      const r = await runAsync(bun, [OPENER, "--port", String(stub.port), "--print-only"], {
        cwd: ROOT,
      });
      record(
        "opener-ready-print-only",
        r.status === 0 && r.stdout.includes(`http://127.0.0.1:${stub.port}/`),
        `exit=${r.status} port=${stub.port}\n--- stdout ---\n${r.stdout}`,
        r,
      );
    } finally {
      await stub.close();
    }
  }
  {
    // Closed port + short timeout: must give up fast, exit non-zero, never hang.
    const started = Date.now();
    const r = runSync(
      bun,
      [OPENER, "--port", String(OPENER_DEAD_PORT), "--timeout", "900", "--print-only"],
      { cwd: ROOT, timeout: 20000 },
    );
    const elapsed = Date.now() - started;
    record(
      "opener-timeout-bounded",
      r.status === 1 && elapsed < 15000 && r.stdout.includes("not ready within"),
      `exit=${r.status} elapsedMs=${elapsed}\n--- stdout ---\n${r.stdout}`,
      { ...r, elapsed },
    );
  }
  {
    const bad = runSync(bun, [OPENER, "--bogus"], { cwd: ROOT });
    const missing = runSync(bun, [OPENER, "--print-only"], { cwd: ROOT });
    record(
      "opener-strict-args",
      bad.status === 2 && missing.status === 2,
      `unknownArg=${bad.status} missingPort=${missing.status}`,
      { bad, missing },
    );
  }

  // End-to-end one-click: run the REAL root launcher against the REAL server.
  // The launcher cds to the real project root, so only the business DB path is
  // redirected (into a temp dir) and LM Studio is pointed at a closed port.
  // SUPERSTRING_OPEN_MODE=print keeps the opener from launching a real browser on
  // the operator's desktop while still exercising the ready-then-open wiring.
  {
    const fx = makeServerFixture("oneclick");
    allFixtures.push(fx); // without this the fixture (and its oneclick.sqlite) leaks
    const dbPath = path.join(fx, "data", "oneclick.sqlite");
    const env = {
      ...process.env,
      SUPERSTRING_BUN_EXE: bun,
      SUPERSTRING_DEV_PORT: String(ONECLICK_PORT),
      SUPERSTRING_DB_PATH: dbPath,
      LM_STUDIO_BASE_URL: UNREACHABLE_LM,
      SUPERSTRING_OPEN_MODE: "print",
    };
    const child = spawn("cmd.exe", ["/c", START_CMD, "--no-build"], {
      cwd: ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    allChildren.push(child);
    child.log = "";
    child.stdout?.on("data", (d) => (child.log += d.toString("utf8")));
    child.stderr?.on("data", (d) => (child.log += d.toString("utf8")));
    const ready = await waitForHealth(ONECLICK_PORT);
    const health = ready ? await httpGet(`http://127.0.0.1:${ONECLICK_PORT}/health`, 6000) : null;
    const page = ready ? await httpGet(`http://127.0.0.1:${ONECLICK_PORT}/`, 3000) : null;
    // The opener polls /health every 400 ms and a single attempt can legitimately
    // take ~2 s (the health handler probes the model service before answering),
    // so wait for the line instead of guessing a fixed sleep.
    const openedLine = await waitForLog(child, "[open] ready (print-only", 9000);
    const pageOk = page?.ok && /text\/html/i.test(page.ct);
    const ok = ready && health?.ok && pageOk && openedLine;
    record(
      "oneclick-e2e",
      ok,
      `ready=${ready} health=${health?.status} page=${page?.status} ct=${page?.ct} openerLine=${openedLine}\n` +
        `--- launcher stdout ---\n${child.log.slice(-4000)}`,
      { ready, healthStatus: health?.status, pageStatus: page?.status, openedLine },
    );
    // cmd.exe -> bun server: kill the whole tree so no server survives the test.
    if (child.pid) runSync("taskkill", ["/PID", String(child.pid), "/T", "/F"]);
    await sleep(700);
    const stillServing = await healthOk(ONECLICK_PORT);
    record(
      "oneclick-cleanup",
      !stillServing,
      `taskkill /T /F issued; stillServing=${stillServing}`,
      { stillServing },
    );
  }

  // cleanup any stray children and fixtures
  for (const c of allChildren) {
    if (c.exitCode === null && c.signalCode === null) {
      try {
        c.kill("SIGKILL");
      } catch {
        // Cleanup is best-effort for processes or handles already closed.
      }
    }
  }
  // Give killed children a moment to release file handles before we remove
  // their fixture directories (rmSync on a dir still holding an open handle can
  // fail on Windows).
  await sleep(800);
  for (const fx of allFixtures) {
    // Remove the dist junction first (if present), then the directory, with a
    // short retry so a transiently-held handle does not leave the fixture behind.
    try {
      rmSync(path.join(fx, "dist"), { force: true });
    } catch {
      // Cleanup is best-effort for processes or handles already closed.
    }
    let removed = false;
    for (let attempt = 0; attempt < 5 && !removed; attempt++) {
      try {
        rmSync(fx, { recursive: true, force: true });
        removed = !existsSync(fx);
      } catch {
        await sleep(300);
      }
    }
  }

  const passed = scenarios.filter((s) => s.ok).length;
  const summary = {
    tool: "verify-launcher.mjs",
    generatedAt: new Date().toISOString(),
    root: ROOT,
    bun,
    testPort: TEST_PORT,
    conflictPort: CONFLICT_PORT,
    unreachableLm: UNREACHABLE_LM,
    pass: passed,
    total: scenarios.length,
    success: passed === scenarios.length,
    scenarios: scenarios.map(({ _child, ...s }) => s),
  };
  writeFileSync(outPath, JSON.stringify(summary, null, 2), "utf8");
  console.log(`\n[verify] ${passed}/${scenarios.length} scenarios passed.`);
  console.log(`[verify] artefact: ${outPath}`);
  process.exit(summary.success ? 0 : 1);
}

main().catch((e) => {
  console.error("[verify] fatal:", e);
  process.exit(1);
});
