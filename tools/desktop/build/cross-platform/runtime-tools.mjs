import fs from "node:fs";
import path from "node:path";

export function resolveProjectBun(root) {
  const directory = path.join(root, "node_modules/bun");
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"));
  // Bun's npm distribution names its installed binary bun.exe on every OS.
  // Follow the published bin mapping instead of guessing a platform filename.
  return path.resolve(directory, manifest.bin.bun);
}

export function preserveSmokeEvidence(temporary, destination) {
  const report = path.join(temporary, "report.json");
  if (fs.existsSync(report)) fs.copyFileSync(report, path.join(destination, "smoke-report.json"));
  const logs = path.join(temporary, "profile/logs");
  if (fs.existsSync(logs)) {
    fs.cpSync(logs, path.join(destination, "smoke-logs"), { recursive: true });
  }
}
