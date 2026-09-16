import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Development gate runner. Fixed absolute executors so it does not depend on the
// host shell PATH; never touches the old project, the real database or a model.
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
    timeout: 300000,
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
