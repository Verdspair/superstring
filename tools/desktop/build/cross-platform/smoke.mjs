import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { FuseState, FuseV1Options, FuseVersion, getCurrentFuseWire } from "@electron/fuses";
import { validateSmokeReport } from "./smoke-contract.mjs";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { app: { type: "string" } },
});
const directory = path.resolve(positionals[0] ?? "");
const identity = JSON.parse(fs.readFileSync(path.join(directory, "build-result.json"), "utf8"));
if (identity.platform !== process.platform || identity.arch !== process.arch)
  throw new Error("SMOKE_REQUIRES_NATIVE_RUNNER");
const app = values.app ? path.resolve(values.app) : identity.app;
const executable =
  process.platform === "darwin"
    ? path.join(app, "Contents/MacOS/superstring")
    : path.join(app, "superstring");
function run(file, args) {
  const result = spawnSync(file, args, { stdio: "inherit", timeout: 120_000 });
  if (result.error || result.status !== 0)
    throw result.error ?? new Error(`Smoke command failed: ${file} (${result.status})`);
}
const fuses = await getCurrentFuseWire(executable);
if (fuses.version !== FuseVersion.V1) throw new Error("UNEXPECTED_ELECTRON_FUSE_VERSION");
for (const [fuse, enabled] of [
  [FuseV1Options.RunAsNode, false],
  [FuseV1Options.EnableNodeOptionsEnvironmentVariable, false],
  [FuseV1Options.EnableNodeCliInspectArguments, false],
  [FuseV1Options.OnlyLoadAppFromAsar, true],
]) {
  if (fuses[fuse] !== (enabled ? FuseState.ENABLE : FuseState.DISABLE))
    throw new Error(`INCORRECT_ELECTRON_FUSE:${fuse}`);
}
if (identity.release && process.platform === "darwin") {
  run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app]);
  run("spctl", ["--assess", "--type", "execute", "--verbose=2", app]);
  run("xcrun", ["stapler", "validate", app]);
}
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "Superstring smoke 测试 "));
const report = path.join(temporary, "report.json");
let stopped = false;
try {
  run(executable, [
    `--desktop-smoke-report=${report}`,
    `--desktop-profile=${path.join(temporary, "profile")}`,
  ]);
  const result = JSON.parse(fs.readFileSync(report, "utf8"));
  fs.writeFileSync(
    path.join(directory, "smoke-report.json"),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  validateSmokeReport(result, identity);
  stopped = true;
} catch (error) {
  if (fs.existsSync(report)) fs.copyFileSync(report, path.join(directory, "smoke-report.json"));
  const logs = path.join(temporary, "profile/logs");
  if (fs.existsSync(logs)) fs.cpSync(logs, path.join(directory, "smoke-logs"), { recursive: true });
  console.error(`Smoke failed; isolated profile retained at ${temporary}`);
  throw error;
} finally {
  // Remove only the synthetic profile whose service confirmed it has stopped.
  if (stopped) fs.rmSync(temporary, { recursive: true, force: true });
}
