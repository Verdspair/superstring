import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Development gate runner. Fixed absolute executors so it does not depend on the
// host shell PATH; never touches anything outside this tree, the real database
// or a model.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(resolve(root, "package.json"));
const packageBin = (name, file) => resolve(dirname(require.resolve(`${name}/package.json`)), file);
const node = process.execPath;
const bun = process.env.SUPERSTRING_BUN_EXE ?? packageBin("bun", "bin/bun.exe");

const checks = [
  ["biome-check", node, [packageBin("@biomejs/biome", "bin/biome"), "check", "."]],
  [
    "typecheck",
    node,
    [packageBin("typescript", "bin/tsc"), "-p", resolve(root, "tsconfig.json"), "--noEmit"],
  ],
  // A schema version bump has to be mirrored in ~25 hardcoded lists; the C# files and
  // verify-setup.mjs are outside this runner's own checks, so the inventory is asserted here
  // instead of relying on anyone remembering. See the script's header for what it caught.
  ["migration-inventory", bun, ["tools/verify/verify-migration-inventory.mjs"]],
  ["bun-tests", bun, ["test", "tests/integration", "tests/contracts"]],
  ["web-tests", node, [packageBin("vitest", "vitest.mjs"), "run", "--config", "vitest.config.ts"]],
  ["web-build", node, [packageBin("vite", "bin/vite.js"), "build"]],
];

const results = [];
for (const [name, command, args] of checks) {
  const started = performance.now();
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    // Per-check ceiling, not a budget for the whole run. Raised twice for the same reason:
    // 300 s was enough while the backend suite took ~270 s, then it grew past that; at 600 s it
    // grew past THAT (measured 622.6 s on 2026-09-24, when the QQ side reached schema 29 and the
    // frozen-fingerprint loop replayed 29 migrations per version). A timeout that fires before
    // the work can finish is worse than a slow check: it reports `ETIMEDOUT` with an empty result,
    // which reads exactly like a crash. The suite's growth is real (78 files, many replaying the
    // whole chain), so the ceiling moves with it; if it needs raising again, the honest fix is to
    // make the fingerprint loop incremental rather than to keep moving this number.
    timeout: 900000,
    windowsHide: true,
  });
  const entry = {
    name,
    exitCode: result.status,
    error: result.error?.message ?? null,
    durationMs: Math.round(performance.now() - started),
    passed: result.status === 0 && !result.error,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
  };
  results.push(entry);
  const summary = entry.stdout
    .split("\n")
    .filter((line) => /pass|fail|Test Files|Tests |error|checked/i.test(line));
  console.log(`[${entry.passed ? "PASS" : "FAIL"}] ${name} (${entry.durationMs}ms)`);
  for (const line of summary.slice(-6)) console.log(`    ${line.trim()}`);
  if (!entry.passed && entry.stderr)
    console.log(`    stderr: ${entry.stderr.split("\n").slice(0, 6).join(" | ")}`);
}

const timestamp = new Date().toISOString();
const report = {
  timestamp,
  scope:
    "Development gate: static check, types, Bun tests, web tests, web build. Not a release or visual acceptance.",
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  passed: results.every((r) => r.passed),
  checks: results,
};
const outputDir = resolve(root, "artifacts/validation");
mkdirSync(outputDir, { recursive: true });
const destination = resolve(outputDir, `verify-all-${timestamp.replaceAll(/[:.]/g, "-")}.json`);
writeFileSync(destination, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(`\n${report.passed ? "ALL PASSED" : "FAILURES PRESENT"} -> ${destination}`);
process.exitCode = report.passed ? 0 : 1;
