/**
 * MANUAL CHECK — proves the launcher's browser-open step really opens a browser.
 *
 * Why this exists: `open-when-ready.ts` used to spawn `cmd /c start <url>` with
 * `Bun.spawn` and exit immediately. The child was torn down before it ran, so the
 * opener printed "opened" while nothing opened. Nothing in the automated suite can
 * catch that, because every scenario there runs in `--print-only` mode (the suite
 * deliberately never opens a real browser on the operator's desktop).
 *
 * How it decides: it hosts a sentinel that answers /health with 200 (so the opener
 * reaches its open step) and records every other request. A recorded request can
 * only come from something the OS actually launched, so "hits > 0" == "a browser
 * opened". The opener under test is the real one, with no SUPERSTRING_OPEN_MODE.
 *
 * Usage:  bun tools/verify/verify-open-browser.mjs [port]
 * Effect: opens one real browser tab (printed URL). Exit 0 = opened, 1 = not.
 */
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";

const PORT = Number(process.argv[2] ?? 17960);
const ROOT = path.resolve(import.meta.dir, "..", "..");
const OPENER = path.join(ROOT, "tools", "ops", "open-when-ready.ts");
const BUN =
  process.platform === "win32" ? path.join(ROOT, "node_modules", "bun", "bin", "bun.exe") : "bun";

const hits = [];
const sentinel = http.createServer((req, res) => {
  const pathname = (req.url ?? "/").split("?")[0];
  if (pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" }).end('{"status":"ok"}');
    return;
  }
  hits.push(req.url ?? "/");
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<h1>sentinel ok</h1>");
});

await new Promise((resolve, reject) => {
  sentinel.once("error", reject);
  sentinel.listen(PORT, "127.0.0.1", resolve);
});

// Async on purpose: a spawnSync here would block this process and the sentinel
// could never answer the opener's readiness probe.
const opener = spawn(BUN, [OPENER, "--port", String(PORT), "--timeout", "20000"], {
  cwd: ROOT,
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
opener.stdout.on("data", (d) => (log += d.toString("utf8")));
opener.stderr.on("data", (d) => (log += d.toString("utf8")));
await new Promise((resolve) => opener.on("exit", resolve));

// Let the OS-hosted browser finish fetching before judging.
await new Promise((resolve) => setTimeout(resolve, 7000));

console.log(
  `[open-check] opener: ${log.trim().split(/\r?\n/).filter(Boolean).join(" | ") || "<silence>"}`,
);
console.log(`[open-check] sentinel hits: ${hits.length} ${JSON.stringify(hits)}`);
console.log(
  hits.length > 0
    ? "[open-check] PASS: a browser opened the page"
    : "[open-check] FAIL: no browser opened",
);

await new Promise((resolve) => sentinel.close(resolve));
process.exit(hits.length > 0 ? 0 : 1);
