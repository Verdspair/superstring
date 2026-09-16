/**
 * Short-lived "open the page when the server is ready" helper.
 *
 * Started in the background by start.cmd so the one-click flow can open the
 * browser without the launcher itself becoming a supervisor. This process:
 *   - polls GET /health every POLL_MS until it answers 200 (or the deadline),
 *   - opens the default browser on that URL,
 *   - prints one line and exits.
 *
 * It is deliberately NOT a watchdog: it never restarts, monitors or stops the
 * server. All waits share --timeout (excluding runtime/OS scheduling and process-reaping overhead).
 * It exits by itself. That keeps the
 * approved boundary intact (no process-tree supervision, no browser-idle
 * reaper) — if this helper is killed or never runs, the server is unaffected.
 *
 * A 200 response is enough to be "ready": /health reports `degraded` with HTTP
 * 200 when LM Studio is not connected, and the page is still perfectly usable
 * in that state.
 *
 * --print-only (or SUPERSTRING_OPEN_MODE=print) resolves the URL and prints it
 * without launching a browser. Used by tools/verify so verification never opens
 * a real browser on the operator's desktop.
 *
 * Usage: open-when-ready.ts --port <n> [--timeout <ms>] [--path /] [--print-only]
 */

import http from "node:http";

const DEFAULT_TIMEOUT_MS = 30_000;
const POLL_MS = 400;
// Must stay ABOVE the health handler's worst case, not above a typical one.
// `GET /health` probes the model service with its own budget before answering
// (src/server/api/health.ts), so on a machine where LM Studio is not running
// the answer legitimately arrives late: measured 2025 ms here, and the handler
// documents a 5 s worst case. With the former 1500 ms limit every single
// attempt was destroyed just before the reply arrived, so the launcher
// concluded "server not ready" against a perfectly healthy server and no
// browser ever opened. Keep this >= the health budget.
const ATTEMPT_TIMEOUT_MS = 6_000;

interface Options {
  port: number | null;
  timeoutMs: number;
  path: string;
  printOnly: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    port: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    path: "/",
    printOnly: process.env.SUPERSTRING_OPEN_MODE?.trim().toLowerCase() === "print",
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--print-only") opts.printOnly = true;
    else if (arg === "--help" || arg === "-h") opts.help = true;
    else if (arg === "--port") opts.port = Number(argv[++i] ?? Number.NaN);
    else if (arg === "--timeout") opts.timeoutMs = Number(argv[++i] ?? Number.NaN);
    else if (arg === "--path") opts.path = argv[++i] ?? "/";
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (opts.port !== null && (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535)) {
    throw new Error(`--port must be an integer in 1-65535, got ${opts.port}`);
  }
  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0) {
    throw new Error(`--timeout must be a positive number of milliseconds`);
  }
  return opts;
}

function printUsage(): void {
  console.log(`open-when-ready.ts — open the superstring page once /health answers

Usage: open-when-ready.ts --port <n> [--timeout <ms>] [--path <path>] [--print-only]

  --port <n>       Port the server binds (required).
  --timeout <ms>   Give up after this long (default ${DEFAULT_TIMEOUT_MS}).
  --path <path>    Path to open (default /).
  --print-only     Resolve and print the URL instead of opening a browser.
                   Also enabled by SUPERSTRING_OPEN_MODE=print.

All waits share --timeout, excluding runtime/OS scheduling and process-reaping overhead; never supervises the server.`);
}

/**
 * One readiness probe. Returns true only for HTTP 200 on /health.
 *
 * Uses node:http instead of fetch on purpose: Bun's fetch honours HTTP(S)_PROXY,
 * so with a proxy configured the loopback poll goes to the proxy and fails
 * (measured here: a dead proxy -> ConnectionRefused, the live one -> HTTP 404,
 * while node:http answers 200 to the same server). A loopback readiness check
 * must never be proxied. Bun 1.4.2 ignored NO_PROXY in isolated probes, so it
 * is not a reliable escape; node:http does not consult proxy environment vars.
 */
export function remainingMs(deadline: number): number {
  return Math.max(0, deadline - performance.now());
}

export function healthReady(port: number, deadline: number): Promise<boolean> {
  const budget = Math.min(ATTEMPT_TIMEOUT_MS, remainingMs(deadline));
  if (budget <= 0) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ready: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.destroy();
      resolve(ready);
    };
    const request = http.request(
      { host: "127.0.0.1", port, path: "/health", method: "GET" },
      (response) => {
        // Only the status is needed; never wait for an unbounded health body.
        response.on("error", () => finish(false));
        finish(response.statusCode === 200 && remainingMs(deadline) > 0);
        response.destroy();
      },
    );
    const timer = setTimeout(() => finish(false), budget);
    request.on("error", () => finish(false));
    request.end();
  });
}

/**
 * Launch the OS default browser for `url` and report whether the shell really
 * took it.
 *
 * The dispatch command is AWAITED until close (not fire-and-forget). The old version used
 * `Bun.spawn(...)` and returned immediately, while `main()` exits right after —
 * on Windows the child was torn down before it ran, `start` was never executed,
 * and the opener printed "opened" while no browser appeared at all. Reproduced
 * on this machine with a sentinel server: 0 hits with the fire-and-forget form,
 * a hit every time once the process is awaited (`tools/verify/verify-open-browser.mjs`).
 * Waiting also yields a real exit code, so a failure can be reported instead of
 * being claimed as success.
 *
 * Windows gets a second mechanism: `cmd /c start` is the normal route, and
 * `rundll32 url.dll,FileProtocolHandler` covers a stripped-down PATH where
 * `start` is unavailable. Verified working on this machine.
 */
export async function runOpenMechanisms(
  mechanisms: string[][],
  deadline: number,
): Promise<boolean> {
  for (const argv of mechanisms) {
    const budget = remainingMs(deadline);
    if (budget <= 0) return false;
    try {
      const child = Bun.spawn(argv, { stdout: "ignore", stderr: "ignore" });
      let expired = false;
      const timer = setTimeout(() => {
        expired = true;
        child.kill("SIGKILL");
      }, remainingMs(deadline));
      try {
        const code = await child.exited;
        if (!expired && code === 0) return true;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      // Dispatch failure; try the fallback if the budget permits.
    }
  }
  return false;
}

async function openBrowser(url: string, deadline: number): Promise<boolean> {
  const mechanisms: string[][] =
    process.platform === "win32"
      ? [
          ["cmd.exe", "/c", "start", "", url], // the empty title arg is required
          ["rundll32.exe", "url.dll,FileProtocolHandler", url],
        ]
      : [[process.platform === "darwin" ? "open" : "xdg-open", url]];

  return runOpenMechanisms(mechanisms, deadline);
}

async function main(): Promise<number> {
  let opts: Options;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`[open] ERROR: ${(error as Error).message}`);
    return 2;
  }
  if (opts.help) {
    printUsage();
    return 0;
  }
  if (opts.port === null) {
    console.error("[open] ERROR: --port is required.");
    return 2;
  }

  const port = opts.port;
  const url = `http://127.0.0.1:${port}${opts.path}`;
  const deadline = performance.now() + opts.timeoutMs;

  while (remainingMs(deadline) > 0) {
    if (await healthReady(port, deadline)) {
      if (opts.printOnly) {
        console.log(`[open] ready (print-only, browser not launched): ${url}`);
      } else if (await openBrowser(url, deadline)) {
        console.log(`[open] opened ${url}`);
      } else {
        // The server IS up: report the failure honestly instead of silently
        // exiting 0 with nothing opened (the launcher only warns, never fails).
        console.log(`[open] no browser could be launched; visit ${url} yourself.`);
      }
      return 0;
    }
    const remaining = remainingMs(deadline);
    if (remaining > 0) await Bun.sleep(Math.min(POLL_MS, remaining));
  }

  console.log(
    `[open] server not ready within ${opts.timeoutMs} ms; no browser opened. ` +
      `Check the server window for an error, then visit ${url} yourself.`,
  );
  return 1;
}

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(`[open] ERROR: ${(error as Error).message}`);
      process.exit(2);
    });
}
