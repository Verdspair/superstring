import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const result = spawnSync(
  resolve(root, "node_modules/bun/bin/bun.exe"),
  ["test", "tests/integration/api-open-facts.test.ts"],
  { cwd: root, encoding: "utf8", timeout: 30000, windowsHide: true },
);
const output = resolve(
  root,
  `artifacts/validation/api-facts-targeted-${new Date().toISOString().replaceAll(/[:.]/g, "-")}.json`,
);
mkdirSync(resolve(root, "artifacts/validation"), { recursive: true });
writeFileSync(
  output,
  JSON.stringify(
    {
      passed: result.status === 0,
      status: result.status,
      error: result.error?.message,
      stdout: result.stdout,
      stderr: result.stderr,
    },
    null,
    2,
  ),
);
console.log(output);
process.exitCode = result.status === 0 ? 0 : 1;
