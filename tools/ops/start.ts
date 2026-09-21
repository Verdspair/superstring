/**
 * Launcher preparation helper for superstring (called by the root start.cmd).
 *
 * This file is NOT a long-running host. It performs parameter / dependency
 * checks, reports component status, probes the external model service and
 * (optionally) builds the frontend, then exits. The server process is launched
 * separately by the root start.cmd, so there is no process-tree supervisor, Job
 * Object, or browser-idle reaper — the single Bun server shuts down on
 * SIGINT / SIGTERM, and the browser opener is a separate short-lived helper.
 *
 * The launcher resolves bun and changes directory to the project root before
 * running this helper, so `process.cwd()` is the launch directory. This helper
 * therefore builds with the Bun process already running it (`process.execPath`
 * is Bun) and writes build output into the launch cwd.
 *
 * The model service (LM Studio) is only PROBED here. This helper never starts
 * it, never loads a model and never stops anything: an unreachable model service
 * is reported with manual instructions and does NOT fail the preflight, because
 * the page still opens and only model-backed actions are unavailable.
 *
 * Modes:
 *   --check         preflight only (no build); exit 0 if ready, non-zero if not.
 *   --no-build      preflight + require an existing frontend build (dist/web).
 *   (default)       preflight + build the frontend with vite, then exit.
 *   --port <n>      dev bind port for the preflight probe (default 17861).
 *   --help          print usage.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import path from "node:path";

// This file lives two levels below the project root (tools/ops); PROJECT_ROOT is
// used only to read this launcher's own package.json (engines.bun), which is
// stable regardless of the launch cwd.
const PROJECT_ROOT = path.resolve(path.join(import.meta.dir, "..", ".."));
const DEFAULT_PORT = "17861";
// Mirrors resolveLmStudioConfig() in src/server/llm/model-gateway.ts so the
// probe checks the same address the server will actually call.
const DEFAULT_MODEL_BASE_URL = "http://127.0.0.1:1234/v1";
const DEFAULT_MODEL_NAME = "qwen/qwen3-4b-2507";
// Accepted by LM Studio while it does not require a token; override with
// LM_STUDIO_API_KEY when it does.
const DEFAULT_MODEL_API_KEY = "lm-studio";
const MODEL_PROBE_TIMEOUT_MS = 1_500;

type Mode = "check" | "prepare" | "prepare-no-build";

interface ParsedArgs {
  mode: Mode;
  port: string;
  help: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  let mode: Mode = "prepare";
  // Honour an already-exported SUPERSTRING_DEV_PORT so the launcher and the
  // server agree on the port actually used.
  let port = process.env.SUPERSTRING_DEV_PORT?.trim() || DEFAULT_PORT;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check") mode = "check";
    else if (a === "--no-build") mode = "prepare-no-build";
    else if (a === "--port") {
      const value = argv[++i]?.trim();
      if (!value || value.startsWith("--")) throw new Error("--port requires a numeric value");
      port = value;
    } else if (a === "--help" || a === "-h") help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return { mode, port, help };
}

function isValidPort(port: string): boolean {
  const n = Number(port);
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}

function resolveRequiredBun(): string | null {
  try {
    const pkg = JSON.parse(readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8"));
    return (pkg.engines?.bun as string) || null;
  } catch {
    return null;
  }
}

/**
 * Bind-exclusive probe: a real bind on 127.0.0.1:<port> is the most explicit
 * way to learn whether the port is free, matching exactly what the server does
 * (it binds the loopback address). We never connect to the target port.
 */
function probePortFree(port: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (!isValidPort(port)) {
      resolve(false);
      return;
    }
    const srv = net.createServer();
    srv.once("error", () => {
      // Any bind error, including EACCES, must fail closed.
      resolve(false);
    });
    srv.listen({ port: Number(port), host: "127.0.0.1", exclusive: true }, () => {
      srv.close((error) => resolve(!error));
    });
  });
}

function buildFrontend(): number {
  // Run the local vite CLI through the same Bun process running this helper.
  const viteBin = path.join(process.cwd(), "node_modules", "vite", "bin", "vite.js");
  if (!existsSync(viteBin)) {
    console.log(`[start] ERROR: vite not found at ${viteBin} (dependency missing).`);
    return 1;
  }
  const r = spawnSync(process.execPath, [viteBin, "build"], {
    cwd: process.cwd(),
    stdio: "inherit",
    encoding: "utf8",
    // Keep vite's cache inside the launch cwd instead of node_modules/.vite.
    env: { ...process.env, VITE_CACHE_DIR: path.join(process.cwd(), ".vite") },
  });
  return r.status ?? 1;
}

function frontendBuilt(): boolean {
  try {
    return existsSync(path.join(process.cwd(), "dist", "web", "index.html"));
  } catch {
    return false;
  }
}

function resolveModelBaseUrl(): string {
  const raw = (process.env.LM_STUDIO_BASE_URL ?? "").trim() || DEFAULT_MODEL_BASE_URL;
  return raw.replace(/\/+$/, "");
}

function resolveModelName(): string {
  return (process.env.LM_STUDIO_MODEL ?? "").trim() || DEFAULT_MODEL_NAME;
}

/** Mirrors DEFAULT_LM_STUDIO_API_KEY in src/server/llm/model-gateway.ts. */
function resolveModelApiKey(): string {
  return (process.env.LM_STUDIO_API_KEY ?? "").trim() || DEFAULT_MODEL_API_KEY;
}

/**
 * Probe the OpenAI-compatible model service (`GET {base}/models`), mirroring the
 * path src/server/llm/model-gateway.ts uses. Read-only: it never loads a model.
 * A failure is only ever reported, never treated as a preflight problem.
 *
 * `unauthorized` is its own outcome because LM Studio can be told to require an
 * API token: the service is up, the request was refused, and the user needs to
 * supply `LM_STUDIO_API_KEY` rather than to start a server that is already
 * running. Sending that key is the whole point — the probe used to be
 * unauthenticated, so a token-protected instance always looked unreachable.
 *
 * Deliberately uses node:http/node:https instead of fetch: Bun's fetch honours
 * HTTP(S)_PROXY from the environment, which routes a loopback probe through a
 * corporate/system proxy and makes a perfectly healthy local LM Studio look
 * unreachable (measured on this machine: with HTTP_PROXY set, fetch to a
 * loopback stub returns ConnectionRefused through a dead proxy and HTTP 404
 * through the live one, while node:http returns 200 in both cases).
 * A loopback probe must never be proxied.
 */
function probeModelService(
  baseUrl: string,
  timeoutMs = MODEL_PROBE_TIMEOUT_MS,
): Promise<"connected" | "unauthorized" | "unreachable"> {
  return new Promise((resolve) => {
    let url: URL;
    try {
      url = new URL(`${baseUrl}/models`);
    } catch {
      resolve("unreachable");
      return;
    }
    const secure = url.protocol === "https:";
    if (!secure && url.protocol !== "http:") {
      resolve("unreachable");
      return;
    }
    const client = secure ? https : http;
    const request = client.request(
      {
        protocol: url.protocol,
        host: url.hostname,
        port: url.port === "" ? (secure ? 443 : 80) : Number(url.port),
        path: url.pathname,
        method: "GET",
        timeout: timeoutMs,
        headers: { authorization: `Bearer ${resolveModelApiKey()}` },
      },
      (response) => {
        response.resume(); // drain so the socket is released
        if (response.statusCode === 200) resolve("connected");
        else if (response.statusCode === 401 || response.statusCode === 403)
          resolve("unauthorized");
        else resolve("unreachable");
      },
    );
    request.on("timeout", () => request.destroy(new Error("model probe timed out")));
    request.on("error", () => resolve("unreachable"));
    request.end();
  });
}

/**
 * LM Studio answered, but rejected the call. Both fixes are on the user's side
 * and neither involves starting anything: copy the token into the environment,
 * or turn the requirement off.
 */
function printModelAuthGuidance(baseUrl: string): void {
  console.log("[start]   LM Studio is running but requires an API token.");
  console.log("[start]   Developer tab -> Server settings -> copy the API token, then either:");
  console.log(`[start]     1. set LM_STUDIO_API_KEY=<token> and start again, or`);
  console.log("[start]     2. turn off 'Require API token' in LM Studio");
  console.log(`[start]   Server will call: ${baseUrl}/chat/completions`);
}

/**
 * Print what the user must do themselves when LM Studio is not reachable. The
 * launcher deliberately does not start the app or load a model (approved
 * boundary: never auto-load models, never stop processes it does not own).
 */
function printModelGuidance(baseUrl: string): void {
  console.log("[start]   This does NOT block startup: the page opens normally and only");
  console.log("[start]   model-backed actions report the model service as unavailable.");
  console.log("[start]   To enable it yourself (this launcher never starts or loads a model):");
  console.log("[start]     1. Open LM Studio -> Developer tab -> press 'Start Server' (port 1234)");
  console.log("[start]     2. Load the model you want under 'My Models'");
  console.log(`[start]     3. Different address? Set LM_STUDIO_BASE_URL and start again`);
  console.log(`[start]   Server will call: ${baseUrl}/chat/completions`);
}

function printUsage(): void {
  console.log(`superstring launcher helper

Usage:
  start.ts [--check] [--no-build] [--port <n>] [--help]

  --check        Preflight only: verify Bun, vite, the dev port and the data
                 directory. Does not build or start anything.
  --no-build     Preflight + require an existing frontend build (dist/web).
  (default)      Preflight + build the frontend with vite, then exit. The
                 caller (start.cmd) launches the server afterwards.
  --port <n>     Dev bind port for the preflight probe (default 17861; also
                 SUPERSTRING_DEV_PORT).
`);
}

async function main(): Promise<number> {
  const { mode, port, help } = parseArgs(process.argv.slice(2));
  if (help) {
    printUsage();
    return 0;
  }

  const cwd = process.cwd();
  const dbPathRaw = (process.env.SUPERSTRING_DB_PATH ?? "").trim();
  // The :memory: special value is preserved untouched (handled by the server's
  // runtime); here we only resolve a file path for the preflight directory check.
  const dbPath =
    dbPathRaw === ":memory:" || dbPathRaw === ""
      ? path.join(cwd, "data", "superstring.sqlite")
      : path.resolve(dbPathRaw);
  const dbDir = path.dirname(dbPath);
  const viteLocal = existsSync(path.join(cwd, "node_modules", ".bin", "vite"));
  const bunVersion = (process.versions as Record<string, string | undefined>).bun;
  const requiredBun = resolveRequiredBun();
  const built = frontendBuilt();
  const modelBaseUrl = resolveModelBaseUrl();

  console.log("[start] === superstring launcher preflight ===");
  console.log(`[start] cwd         : ${cwd}`);
  console.log(`[start] bun         : ${process.execPath} (running Bun)`);
  console.log(
    `[start] vite        : ${viteLocal ? "node_modules/.bin/vite" : "(not found locally)"}`,
  );
  console.log(`[start] dev port    : ${port}`);
  console.log(
    `[start] db path     : ${dbPath} ${
      dbPathRaw === ":memory:"
        ? "(in-memory; nothing is written to disk)"
        : existsSync(dbPath)
          ? "(existing file; structure is gate-checked on startup)"
          : "(new file; will be created and migrated)"
    }`,
  );
  console.log(
    `[start] web build   : ${
      built ? "dist/web present" : mode === "check" ? "missing" : "will be built now"
    }`,
  );

  const problems: string[] = [];
  if (!isValidPort(port)) problems.push(`dev port "${port}" is not an integer in 1-65535`);
  if (!viteLocal) problems.push("vite not found locally (node_modules/.bin/vite missing)");
  if (bunVersion && requiredBun && bunVersion !== requiredBun) {
    problems.push(`bun version ${bunVersion} does not match required ${requiredBun}`);
  }

  // Validate the data directory is creatable; existing data is never relocated.
  try {
    if (!existsSync(dbDir)) {
      console.log(`[start] note        : data directory will be created at ${dbDir}`);
    } else if (!statSync(dbDir).isDirectory()) {
      problems.push(`DB parent path exists but is not a directory: ${dbDir}`);
    }
  } catch (e) {
    problems.push(`cannot access DB directory ${dbDir}: ${(e as Error).message}`);
  }

  // External component (never started or loaded by this launcher). A failure is
  // reported with manual steps and never added to `problems`.
  const modelState = await probeModelService(modelBaseUrl);
  const modelLabel =
    modelState === "connected"
      ? "connected"
      : modelState === "unauthorized"
        ? "AUTH REQUIRED (401)"
        : "NOT connected";
  console.log(`[start] model svc   : ${modelLabel} (${modelBaseUrl})`);
  console.log(`[start] model name  : ${resolveModelName()} (LM_STUDIO_MODEL)`);
  if (modelState === "unauthorized") printModelAuthGuidance(modelBaseUrl);
  else if (modelState === "unreachable") printModelGuidance(modelBaseUrl);

  const free = await probePortFree(port);
  const desktopAutoPort =
    process.env.SUPERSTRING_DESKTOP_AUTO_PORT === "1" &&
    /^[0-9a-fA-F]{64}$/.test(process.env.SUPERSTRING_DESKTOP_TOKEN ?? "");
  if (!free && desktopAutoPort && mode !== "check") {
    console.log(
      `[start] preferred port ${port} is unavailable; desktop service will select an available port.`,
    );
  } else if (!free) {
    console.log(
      `[start] ERROR: cannot bind port ${port} (occupied or unavailable). ` +
        `This script will NOT kill the occupying process.`,
    );
    problems.push(`port ${port} is unavailable`);
  }

  if (problems.length > 0) {
    console.log("[start] preflight FAILED:");
    for (const p of problems) console.log(`[start]   - ${p}`);
    return 1;
  }
  console.log("[start] preflight OK.");

  if (mode === "check") {
    if (!free) return 1;
    console.log("[start] --check passed.");
    return 0;
  }

  if (mode === "prepare-no-build") {
    if (!frontendBuilt()) {
      console.log(
        "[start] --no-build requires an existing frontend build but dist/web/index.html is " +
          "missing. Run without --no-build once to build it.",
      );
      return 1;
    }
    console.log("[start] existing frontend build present; skipping build.");
    return 0;
  }

  const buildStatus = buildFrontend();
  if (buildStatus !== 0) {
    console.log(`[start] frontend build failed (exit ${buildStatus}); server will not be started.`);
    return buildStatus;
  }
  if (!frontendBuilt()) {
    console.log("[start] build reported success but dist/web/index.html is missing.");
    return 1;
  }
  console.log("[start] frontend build complete.");
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`[start] ERROR: ${(error as Error).message}`);
    process.exit(2);
  });
