import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(resolve(root, "package.json"));
const bin = (pkg, file) => resolve(dirname(require.resolve(`${pkg}/package.json`)), file);
const node = process.execPath;
const bun = bin("bun", "bin/bun.exe");
const checks = [
  ["static", node, [bin("@biomejs/biome", "bin/biome"), "check", "."]],
  ["types", node, [bin("typescript", "bin/tsc"), "--noEmit", "-p", "tsconfig.json"]],
  ["integration-and-contracts", bun, ["test", "tests/integration", "tests/contracts"]],
];
const results = checks.map(([name, command, args]) => {
  const r = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    timeout: 180000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const result = {
    name,
    command,
    args,
    exitCode: r.status,
    error: r.error?.message ?? null,
    passed: r.status === 0 && !r.error,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
  console.log(`${result.passed ? "PASS" : "FAIL"} ${name}`);
  for (const line of `${result.stdout}\n${result.stderr}`.split("\n")) {
    if (/^\s*\d+ (pass|fail)|Ran \d+ tests|Checked \d+ files/.test(line)) console.log(line);
  }
  if (!result.passed) {
    console.log(result.stdout.slice(-4000), result.stderr.slice(-8000));
  }
  return result;
});
const timestamp = new Date().toISOString();
const output = resolve(
  root,
  "artifacts/validation",
  `startup-schema-${timestamp.replaceAll(/[:.]/g, "-")}.json`,
);
mkdirSync(dirname(output), { recursive: true });
const passed = results.every((result) => result.passed);
writeFileSync(
  output,
  `${JSON.stringify({ timestamp, scope: "Static/types and synthetic backend/contract regression only; excludes web tests, full development gate, visual/release acceptance and real data/model access.", passed, results }, null, 2)}\n`,
);
console.log(output);
process.exitCode = passed ? 0 : 1;
