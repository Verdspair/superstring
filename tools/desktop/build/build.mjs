import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildElectronDesktop } from "./build-electron.mjs";
import { promoteElectronDesktop } from "./promote-electron.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
if (process.argv.length > 2)
  throw new Error(
    "Desktop build takes no flags. Installer assembly uses build-electron.mjs explicitly.",
  );
const web = spawnSync(
  process.execPath,
  [path.join(root, "node_modules/vite/bin/vite.js"), "build"],
  { cwd: root, stdio: "inherit", windowsHide: true },
);
if (web.error || web.status !== 0) throw web.error ?? new Error(`Web build failed: ${web.status}`);
const batch = fs.mkdtempSync(path.join(root, "artifacts/validation/desktop-electron-"));
const candidate = path.join(batch, "candidate");
await buildElectronDesktop({ projectRoot: root, out: candidate });
const backupDirectory = path.join(batch, "before");
const result = promoteElectronDesktop({
  candidate,
  projectRoot: root,
  destination: path.join(root, "dist/desktop"),
  backupDirectory,
});
fs.writeFileSync(path.join(batch, "desktop-result.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(`DESKTOP_RESULT=${path.join(batch, "desktop-result.json")}`);
