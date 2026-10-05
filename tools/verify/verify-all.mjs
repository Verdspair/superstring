import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveProjectBun } from "../desktop/build/cross-platform/runtime-tools.mjs";

// Development gate runner. Fixed absolute executors so it does not depend on the
// host shell PATH; never touches anything outside this tree, the real database
// or a model.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(resolve(root, "package.json"));
const packageBin = (name, file) => resolve(dirname(require.resolve(`${name}/package.json`)), file);
const node = process.execPath;
const bun = process.env.SUPERSTRING_BUN_EXE ?? resolveProjectBun(root);

// Bun 的测试过滤参数按子串匹配路径，目录参数会连带命中 artifacts 下的历史快照；
// 这里显式递归收集两个常规测试根下的 Bun 标准测试后缀（bun test 默认识别
// *.test.{js|jsx|ts|tsx|mjs|cjs|mts|cts}，本树实际只用其中一部分），跳过 artifacts
// 与 node_modules，加上桌面端两个既有显式文件，以绝对路径作过滤，保证只匹配真实测试文件。
function collectBunTestFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "artifacts" && entry.name !== "node_modules") {
        found.push(...collectBunTestFiles(full));
      }
    } else if (BUN_TEST_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) found.push(full);
  }
  return found;
}
const BUN_TEST_SUFFIXES = [
  ".test.js",
  ".test.jsx",
  ".test.ts",
  ".test.tsx",
  ".test.mjs",
  ".test.cjs",
  ".test.mts",
  ".test.cts",
];
const bunTestFiles = [
  ...collectBunTestFiles(resolve(root, "tests/integration")),
  ...collectBunTestFiles(resolve(root, "tests/contracts")),
  resolve(root, "tests/desktop/backend.test.ts"),
  resolve(root, "tests/desktop/security.test.ts"),
];

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
  ["bun-tests", bun, ["test", ...bunTestFiles]],
  [
    "desktop-packaging",
    node,
    ["--test", "tests/desktop/packaging.test.mjs", "tests/desktop/palette.test.mjs"],
  ],
  ["web-tests", node, [packageBin("vitest", "vitest.mjs"), "run", "--config", "vitest.config.ts"]],
  ["web-build", node, [packageBin("vite", "bin/vite.js"), "build"]],
];

/**
 * 跑一个检查并等它结束。用 spawn（异步）而不是 spawnSync：两个重套件要能同时跑。
 * 报告顺序仍按 `checks` 的声明顺序回填，历史报告可以逐项对比。
 */
function runCheck([name, command, args]) {
  return new Promise((settle) => {
    const started = performance.now();
    const child = spawn(command, args, { cwd: root, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 900000);
    child.on("close", (code) => {
      clearTimeout(timer);
      settle({
        name,
        exitCode: code,
        error: timedOut ? "ETIMEDOUT" : null,
        durationMs: Math.round(performance.now() - started),
        passed: code === 0 && !timedOut,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
      });
    });
  });
}

function announce(entry) {
  const summary = entry.stdout
    .split("\n")
    .filter((line) => /pass|fail|Test Files|Tests |error|checked/i.test(line));
  console.log(`[${entry.passed ? "PASS" : "FAIL"}] ${entry.name} (${entry.durationMs}ms)`);
  for (const line of summary.slice(-6)) console.log(`    ${line.trim()}`);
  if (!entry.passed && entry.stderr)
    console.log(`    stderr: ${entry.stderr.split("\n").slice(0, 6).join(" | ")}`);
}

// 两个重套件互不依赖（后端用自建临时库、前端跑 jsdom），同时跑把门禁从约 4 分钟压到约 2.5 分钟；
// 其余静态检查都很轻，先跑完它们再等两个套件，输出顺序与历史一致（重套件最后打印）。
const HEAVY = new Set(["bun-tests", "web-tests"]);
const heavyRuns = checks.filter(([name]) => HEAVY.has(name)).map((check) => runCheck(check));
const entries = new Map();
for (const check of checks.filter(([name]) => !HEAVY.has(name))) {
  const entry = await runCheck(check);
  entries.set(entry.name, entry);
  announce(entry);
}
for (const entry of await Promise.all(heavyRuns)) {
  entries.set(entry.name, entry);
  announce(entry);
}
const results = checks.map(([name]) => entries.get(name));

const timestamp = new Date().toISOString();
const report = {
  timestamp,
  scope:
    "Development gate: static check, types, migrations, Bun integration/contracts/desktop tests, desktop packaging, web tests and web build. Not release or visual acceptance.",
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
